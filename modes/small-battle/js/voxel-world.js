/**
 * voxel-world.js — Chunk-based ruined city (performance-focused)
 * Flat ground, canal, skyscrapers, houses, bridges — single mesh per chunk
 */
(function (global) {
  'use strict';

  const BLOCK = {
    AIR: 0,
    GRASS: 1,
    DIRT: 2,
    STONE: 3,
    CONCRETE: 4,
    RUST: 5,
    METAL: 6,
    ROAD: 7,
    WATER: 8,
    RUBBLE: 9,
    BRICK: 10,
    PLASTER: 11,
    ROOF: 12,
    GLASS: 13,
    ASPHALT: 14,
    /** Unbreakable floor / world border */
    BEDROCK: 15,
    /** Solid voxel smoke puffs (cauliflower plumes on some roofs) */
    SMOKE: 16,
    /** Lighter smoke for lobe edges */
    SMOKE_LIGHT: 17,
    /** Death paint / blood stains */
    PAINT_RED: 18,
    PAINT_BLUE: 19,
  };

  const COLORS = {
    [BLOCK.GRASS]: 0x5a8a42,
    [BLOCK.DIRT]: 0x8a7354,
    [BLOCK.STONE]: 0x8e8f8c,
    [BLOCK.CONCRETE]: 0xb8b3a8,
    [BLOCK.RUST]: 0xa85a2e,
    [BLOCK.METAL]: 0x66758a,
    [BLOCK.ROAD]: 0x535860,
    [BLOCK.WATER]: 0x4a88a8,
    [BLOCK.RUBBLE]: 0x7a7266,
    [BLOCK.BRICK]: 0xb45a44,
    [BLOCK.PLASTER]: 0xe6e0d4,
    [BLOCK.ROOF]: 0x7a5844,
    [BLOCK.GLASS]: 0x8ec4d8,
    [BLOCK.ASPHALT]: 0x4a4e56,
    [BLOCK.BEDROCK]: 0x3a3c42,
    [BLOCK.SMOKE]: 0x9a9892,
    [BLOCK.SMOKE_LIGHT]: 0xb8b6b0,
    [BLOCK.PAINT_RED]: 0x8a1a1a,
    [BLOCK.PAINT_BLUE]: 0x1a3a8a,
  };

  /** Successful hits to destroy. Missing types = 1. Bedrock is world floor only. */
  const BLOCK_HITS = {
    [BLOCK.GRASS]: 1,
    [BLOCK.DIRT]: 1,
    [BLOCK.RUBBLE]: 1,
    [BLOCK.STONE]: 2,
    [BLOCK.ROAD]: 2,
    [BLOCK.ASPHALT]: 2,
    [BLOCK.ROOF]: 1,
    [BLOCK.PLASTER]: 1,
    [BLOCK.BRICK]: 2,
    [BLOCK.RUST]: 2,
    [BLOCK.GLASS]: 1,
    [BLOCK.CONCRETE]: 3,
    [BLOCK.METAL]: 5,
  };

  const CHUNK_SIZE = 16;
  const WORLD_CHUNKS = 20; // 320×320
  /** Extra solid layers under the playable surface */
  const SUB_LAYERS = 5;
  const WORLD_HEIGHT = 80 + SUB_LAYERS;

  const DOOR_LEN = 2;
  const DOOR_H = 4;
  const DOOR_THICK = 0.5;
  const STEP_H = 0.4; // unused by voxel stairs; kept for compat

  function VoxelWorld(scene) {
    this.scene = scene;
    this.chunkSize = CHUNK_SIZE;
    this.worldChunks = WORLD_CHUNKS;
    this.worldSize = CHUNK_SIZE * WORLD_CHUNKS;
    this.height = WORLD_HEIGHT;
    this.blocks = new Uint8Array(this.worldSize * this.height * this.worldSize);
    this.groundY = new Int8Array(this.worldSize * this.worldSize);
    /** Walk-on-top height in meters (10cm quantized). Synced from groundY at gen. */
    this.terrainH = new Float32Array(this.worldSize * this.worldSize);
    /** Snapshot of terrainH after generation — crater floor cannot drop more than 1m below this. */
    this.terrainH0 = new Float32Array(this.worldSize * this.worldSize);
    /** Player-placed / built cells — exempt from terrain-fill lock. */
    this._manmade = new Set();
    /** Extra hits required before breakBlock succeeds — engineer build passive */
    this._blockDurability = new Map();
    this._lodDirtyChunks = new Set();
    this.chunkMeshes = new Map();
    this.props = []; // doors + half-block stairs (mesh collision)
    this.rooftops = []; // {x,y,z} for bridge links
    this.buildings = []; // {ox,oz,w,d,cx,cz,side} for AI spawn / no-enter
    this.skyBridges = []; // elevated deck segments
    this.ziplines = [];
    /** Voxel cells placed as climbable stairs — auto step-up only on these */
    this.stairVoxels = new Set();
    this.stairColumns = new Set();
    this.stairColY = new Map();
    this.stairColTreads = new Map();
    this._stairColList = [];
    this.mapSeed = 0; // 0 = preview/default; match seed set via regenerate()
    this._noiseSeed = 0; // layered into _noise during building phase
    this._dirtyChunks = new Set();
    this._deathStains = [];
    this._chunkMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this._colorCache = {};
    this._propPt = new THREE.Vector3();
    this.group = new THREE.Group();
    this.group.name = 'VoxelWorld';
    scene.add(this.group);

    this._generate();
    this._finalizeTerrainHeight();
    // Mesh near bases + map center first; far chunks stream in by player distance
    this._rebuildAllChunks({ progressive: true, syncRadius: 6 });
  }

  VoxelWorld.prototype.index = function (x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= this.worldSize || y >= this.height || z >= this.worldSize) {
      return -1;
    }
    return (y * this.worldSize + z) * this.worldSize + x;
  };

  VoxelWorld.prototype.get = function (x, y, z) {
    const i = this.index(x, y, z);
    return i < 0 ? BLOCK.AIR : this.blocks[i];
  };

  VoxelWorld.prototype.set = function (x, y, z, type) {
    const i = this.index(x, y, z);
    if (i < 0) return false;
    // Bedrock cannot be overwritten (floor / border)
    if (this.blocks[i] === BLOCK.BEDROCK && type !== BLOCK.BEDROCK) return false;
    this.blocks[i] = type;
    if (type === BLOCK.AIR || type === BLOCK.WATER) this.clearStair(x, y, z);
    if (type === BLOCK.AIR) {
      if (this._blockDurability) this._blockDurability.delete(x + ',' + y + ',' + z);
      this.clearManmade(x, y, z);
    }
    return true;
  };

  VoxelWorld.prototype._cellKey = function (x, y, z) {
    return (x | 0) + ',' + (y | 0) + ',' + (z | 0);
  };

  VoxelWorld.prototype.markManmade = function (x, y, z) {
    if (!this._manmade) this._manmade = new Set();
    this._manmade.add(this._cellKey(x, y, z));
  };

  VoxelWorld.prototype.clearManmade = function (x, y, z) {
    if (!this._manmade) return;
    this._manmade.delete(this._cellKey(x, y, z));
  };

  VoxelWorld.prototype.isManmade = function (x, y, z) {
    return !!(this._manmade && this._manmade.has(this._cellKey(x, y, z)));
  };

  /** Write per-column surface + heightfield sample together. */
  VoxelWorld.prototype._setColumnGround = function (x, z, gy) {
    const i = z * this.worldSize + x;
    this.groundY[i] = gy;
    if (this.terrainH) this.terrainH[i] = (gy || 0) + 1;
  };

  /** After generation, copy groundY → terrainH and snapshot terrainH0 (crater floor). */
  VoxelWorld.prototype._finalizeTerrainHeight = function () {
    const n = this.worldSize * this.worldSize;
    if (!this.terrainH || this.terrainH.length !== n) this.terrainH = new Float32Array(n);
    if (!this.terrainH0 || this.terrainH0.length !== n) this.terrainH0 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.terrainH[i] = (this.groundY[i] || 0) + 1;
    }
    this.terrainH0.set(this.terrainH);
  };

  /** hits = total successful breaks needed (1 = normal, 2 = engineer +50%). */
  VoxelWorld.prototype.setBlockDurability = function (x, y, z, hits) {
    if (!this._blockDurability) this._blockDurability = new Map();
    x = Math.floor(x);
    y = Math.floor(y);
    z = Math.floor(z);
    const key = x + ',' + y + ',' + z;
    if (hits <= 1) {
      this._blockDurability.delete(key);
      return;
    }
    this._blockDurability.set(key, hits);
  };

  VoxelWorld.prototype._stairKey = function (x, y, z) {
    return (x | 0) + ',' + (y | 0) + ',' + (z | 0);
  };

  VoxelWorld.prototype._clearStairIndex = function () {
    if (this.stairVoxels) this.stairVoxels.clear();
    else this.stairVoxels = new Set();
    if (this.stairColumns) this.stairColumns.clear();
    else this.stairColumns = new Set();
    if (this.stairColY) this.stairColY.clear();
    else this.stairColY = new Map();
    if (this.stairColTreads) this.stairColTreads.clear();
    else this.stairColTreads = new Map();
    this._stairColList = [];
  };

  VoxelWorld.prototype._stairColKey = function (x, z) {
    return (x | 0) + ',' + (z | 0);
  };

  /** Mark a solid voxel as a stair tread (walk-up without jump) */
  VoxelWorld.prototype.markStair = function (x, y, z) {
    x = x | 0;
    y = y | 0;
    z = z | 0;
    if (!this.stairVoxels) this.stairVoxels = new Set();
    this.stairVoxels.add(this._stairKey(x, y, z));
    if (!this.stairColumns) this.stairColumns = new Set();
    if (!this.stairColY) this.stairColY = new Map();
    if (!this.stairColTreads) this.stairColTreads = new Map();
    if (!this._stairColList) this._stairColList = [];
    const ck = this._stairColKey(x, z);
    let treads = this.stairColTreads.get(ck);
    if (!treads) {
      treads = [];
      this.stairColTreads.set(ck, treads);
    }
    if (treads.indexOf(y) < 0) treads.push(y);
    const prev = this.stairColY.get(ck);
    if (!this.stairColumns.has(ck)) {
      this.stairColumns.add(ck);
      this._stairColList.push({ x: x, z: z, y: y });
    } else if (prev == null || y > prev) {
      const list = this._stairColList;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].x === x && list[i].z === z) {
          list[i].y = y;
          break;
        }
      }
    }
    if (prev == null || y > prev) this.stairColY.set(ck, y);
  };

  VoxelWorld.prototype.clearStair = function (x, y, z) {
    if (this.stairVoxels) this.stairVoxels.delete(this._stairKey(x, y, z));
  };

  VoxelWorld.prototype.isStairVoxel = function (x, y, z) {
    return !!(this.stairVoxels && this.stairVoxels.has(this._stairKey(x, y, z)));
  };

  VoxelWorld.prototype.isStairColumn = function (x, z) {
    return !!(this.stairColumns && this.stairColumns.has(this._stairColKey(x, z)));
  };

  /** All marked tread Y values in a column (stacked switchbacks keep every flight). */
  VoxelWorld.prototype.stairTreadYs = function (x, z) {
    const ck = this._stairColKey(x, z);
    const arr = this.stairColTreads && this.stairColTreads.get(ck);
    if (arr && arr.length) return arr;
    const ty = this.stairColY && this.stairColY.get(ck);
    return ty != null ? [ty] : [];
  };

  VoxelWorld.prototype.fill = function (x0, y0, z0, x1, y1, z1, type, onlyAir) {
    const xa = Math.min(x0, x1);
    const xb = Math.max(x0, x1);
    const ya = Math.min(y0, y1);
    const yb = Math.max(y0, y1);
    const za = Math.min(z0, z1);
    const zb = Math.max(z0, z1);
    for (let x = xa; x <= xb; x++) {
      for (let y = ya; y <= yb; y++) {
        for (let z = za; z <= zb; z++) {
          if (onlyAir && this.get(x, y, z) !== BLOCK.AIR) continue;
          this.set(x, y, z, type);
        }
      }
    }
  };

  VoxelWorld.prototype._noise = function (x, z) {
    const s = this._noiseSeed || 0;
    const n = Math.sin(x * 12.9898 + z * 78.233 + s * 0.01713) * 43758.5453;
    return n - Math.floor(n);
  };

  VoxelWorld.prototype._noise2 = function (x, z) {
    return this._noise(x * 1.7 + 19.1, z * 1.3 + 7.3);
  };

  /** Seeded [0,1) RNG for layout decisions */
  VoxelWorld.prototype._rand = function () {
    let t = (this._rngState = (this._rngState + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  VoxelWorld.prototype._randInt = function (min, max) {
    return min + Math.floor(this._rand() * (max - min + 1));
  };

  /**
   * Wipe every voxel, prop, zipline and mesh so a generator can start clean.
   * Shared by regenerate() (core objective) and generateTdmMap() (死斗).
   */
  VoxelWorld.prototype._resetForGenerate = function (seed) {
    if (global.VF.disposeWorldOutskirts) {
      global.VF.disposeWorldOutskirts(this);
    }
    this.mapSeed = seed != null ? seed >>> 0 : ((Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0);
    this._rngState = this.mapSeed || 1;
    this._editorCanvas = true;

    this.blocks.fill(0);
    if (this._blockDurability) this._blockDurability.clear();
    else this._blockDurability = new Map();
    this.groundY.fill(0);
    if (this.terrainH) this.terrainH.fill(0);
    else this.terrainH = new Float32Array(this.worldSize * this.worldSize);
    if (this.terrainH0) this.terrainH0.fill(0);
    else this.terrainH0 = new Float32Array(this.worldSize * this.worldSize);
    if (this._manmade) this._manmade.clear();
    else this._manmade = new Set();
    if (this._lodDirtyChunks) this._lodDirtyChunks.clear();
    else this._lodDirtyChunks = new Set();
    this.rooftops = [];
    this.buildings = [];
    this.skyBridges = [];
    this._clearStairIndex();

    while (this.props && this.props.length) {
      this.destroyProp(this.props[0]);
    }

    if (this.ziplines && this.ziplines.length) {
      for (let i = 0; i < this.ziplines.length; i++) {
        const z = this.ziplines[i];
        if (z && z.cable) {
          if (z.cable.parent) z.cable.parent.remove(z.cable);
          if (z.cable.geometry) z.cable.geometry.dispose();
        }
      }
    }
    this.ziplines = [];
    this._pveDistrict = false;
    this._ffaDistrict = false;
    this._districtSpawns = null;

    // Remove non-chunk meshes (zipline posts, leftover props)
    const chunkSet = new Set();
    this.chunkMeshes.forEach((m) => chunkSet.add(m));
    const drop = [];
    for (let i = 0; i < this.group.children.length; i++) {
      const c = this.group.children[i];
      if (!chunkSet.has(c)) drop.push(c);
    }
    for (let i = 0; i < drop.length; i++) {
      const c = drop[i];
      this.group.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material && c.material !== this._chunkMat) {
        if (Array.isArray(c.material)) c.material.forEach((m) => m && m.dispose && m.dispose());
        else if (c.material.dispose) c.material.dispose();
      }
    }

    this.chunkMeshes.forEach((mesh) => {
      this.group.remove(mesh);
      mesh.traverse(function (node) {
        if (node.geometry) node.geometry.dispose();
      });
    });
    this.chunkMeshes.clear();
    this._dirtyChunks.clear();
    if (this._lodDirtyChunks) this._lodDirtyChunks.clear();
    return this.mapSeed;
  };

  /**
   * Wipe and rebuild base terrain for a match (no procedural city).
   * Bases are re-stamped by Bases.rebuildAfterMapGen afterward.
   */
  VoxelWorld.prototype.regenerate = function (seed) {
    this._resetForGenerate(seed);
    this._generate();
    this._finalizeTerrainHeight();
    this._rebuildAllChunks({ progressive: true, syncRadius: 6 });
    return this.mapSeed;
  };

  /** Terrain mask cell classes (image→map): 0 open, 1 water, 2 road, 3 park, 4 built */
  const TERRAIN_OPEN = 0;
  const TERRAIN_WATER = 1;
  const TERRAIN_ROAD = 2;
  const TERRAIN_PARK = 3;
  const TERRAIN_BUILT = 4;

  VoxelWorld.prototype._maskClassAt = function (x, z) {
    if (!this._terrainMask || !this._terrainMaskCells) return -1;
    const cells = this._terrainMaskCells;
    const cell = this.worldSize / cells;
    const gx = Math.floor(x / cell);
    const gz = Math.floor(z / cell);
    if (gx < 0 || gz < 0 || gx >= cells || gz >= cells) return -1;
    return this._terrainMask[gz * cells + gx] | 0;
  };

  VoxelWorld.prototype._riverInfo = function (x, z) {
    // 死斗: compact 3-lane arena has no water hazard splitting the lanes.
    // centerX still resolves to the map's own center so any caller that
    // reads it (minimap, _teamSide) gets a stable, harmless answer.
    if (this._tdmArena) {
      return { dist: 999, width: 0, centerX: this.worldSize * 0.5, inWater: false, bank: false };
    }
    // Custom image terrain: water / bank from mask instead of fixed canal
    if (this._terrainMask && this._terrainMaskCells) {
      const cells = this._terrainMaskCells;
      const cell = this.worldSize / cells;
      const gx = Math.max(0, Math.min(cells - 1, Math.floor(x / cell)));
      const gz = Math.max(0, Math.min(cells - 1, Math.floor(z / cell)));
      const cls = this._terrainMask[gz * cells + gx] | 0;
      if (cls === TERRAIN_WATER) {
        return { dist: 0, width: cell, centerX: x, inWater: true, bank: false };
      }
      let nearWater = false;
      for (let dz = -1; dz <= 1 && !nearWater; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const nx = gx + dx;
          const nz = gz + dz;
          if (nx < 0 || nz < 0 || nx >= cells || nz >= cells) continue;
          if ((this._terrainMask[nz * cells + nx] | 0) === TERRAIN_WATER) {
            nearWater = true;
            break;
          }
        }
      }
      return {
        dist: nearWater ? cell : 99,
        width: cell,
        centerX: x,
        inWater: false,
        bank: nearWater,
      };
    }
    const size = this.worldSize;
    // Fixed river path (independent of match seed)
    const centerX = size * 0.5 + Math.sin(z * 0.045) * 24 + Math.sin(z * 0.11) * 8;
    const dist = Math.abs(x - centerX);
    const width = 9 + this._fixedNoise(z * 0.2, 3) * 4;
    return { dist, width, centerX, inWater: dist < width, bank: dist < width + 5 };
  };

  /** Unseeded hash — river / roads stay identical every match */
  VoxelWorld.prototype._fixedNoise = function (x, z) {
    const n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
    return n - Math.floor(n);
  };

  VoxelWorld.prototype._generate = function () {
    const size = this.worldSize;
    this._rngState = (this.mapSeed || 1) >>> 0;
    this._tdmArena = false; // restore the fixed river when leaving 死斗
    this._ffaDistrict = false;
    this._pveDistrict = false;
    this._districtSpawns = null;

    // Planned bases — diagonal ends (fixed). No procedural city/buildings.
    this._plannedBases = [
      { x: size * 0.18, z: size * 0.22, gate: '+z' },
      { x: size * 0.82, z: size * 0.78, gate: '-z' },
    ];
    this._plannedLandmarks = [];
    this._tdmHotzones = [];

    this._noiseSeed = 0;
    this._buildTerrain();
    this._buildRoadGrid();
    this._buildBedrockShell();
    if (global.VF.refreshWorldOutskirts) {
      global.VF.refreshWorldOutskirts(this);
    }
  };

  /* ───────────────────── 团队死斗：独立随机地图 ───────────────────── */

  /** Radius of flat ground kept around every TDM spawn zone. */
  const TDM_PAD_R = 7;
  /** Extra radius where buildings are suppressed, so spawns are not walled in. */
  const TDM_CLEAR_R = 13;
  const TDM_HOME_R = 22;
  /** Fraction of worldSize trimmed off each edge — keeps the fight in a
   *  compact "中小" arena instead of the full core-mode board. */
  const TDM_ARENA_MARGIN = 0.28;
  /** 爆破 uses the same generator but a slightly wider arena: area ≈ 1.25× the
   *  死斗 arena (halved from the old 2.5×, per「再缩小一半」). 死斗 side = (1-2*0.28);
   *  this side = that × sqrt(1.25) → margin ≈ 0.254. */
  const SD_ARENA_MARGIN = 0.254;
  /** Left / mid / right — MOBA-style lanes so every respawn is on a live line. */
  const TDM_LANE_COUNT = 3;
  const TDM_LANE_WAYPOINTS = 4;
  /** Distance from the arena's north/south edge to each team's home cluster. */
  const TDM_HOME_INSET = 16;

  /* ─────────── 自由混战：图骨架 PCG + 自动评估/修复闭环 常量 ─────────── */
  /* 规范流程: Generate(图) → Validate(H1–H8) → Evaluate(8软指标) → Decide.   */

  const FFA_PC = 8; // 玩家总数(含玩家本人): 1 蓝(ally) + 7 红(enemy)
  const FFA_DENSITY_MIN = 450; // H5 尺寸下限 m²/人
  const FFA_DENSITY_MAX = 650; // H5 尺寸上限 m²/人 (size=wide72 取上限)
  const FFA_NODE_RATIO = 1.3; // 节点数 / 玩家数 (环数≈pc/2 的关键)
  const FFA_PLATFORM_RATIO = 0.2; // 理想高层(platform)节点占比
  const FFA_MIN_DEGREE = 2; // H2 最小入度
  const FFA_MIN_CYCLES = FFA_PC >> 1; // H3 最小环数 = pc/2
  const FFA_MAX_HOPS = 4; // H8 到中心跳数上限
  const FFA_SPAWN_PER = 5; // 复活点密度: 玩家×5 (H6 需 ≥×4)
  const FFA_GROUP_MIN = FFA_PC >> 1; // 最小组团数 = pc/2
  const FFA_ACCEPT = 0.75; // 接受分数线
  const FFA_REPAIR = 0.6; // 修复分数线
  const FFA_MAX_REPAIR = 3; // 单候选最大修复次数
  const FFA_MAX_RESEED = 48; // 换种子搜索预算
  const FFA_WALK_AGENTS = FFA_PC; // 随机游走 agent 数
  const FFA_WALK_STEPS = 600; // 随机游走步数 (规范1000, 取600保帧)
  const FFA_DECK_H = 5; // platform 甲板高度 (markStair 坡道到达)
  const FFA_ARENA_MARGIN = 0.5 - 36 / 320; // _arenaMargin 记账用; 规划器直接算 bounds

  /**
   * Deterministic city for 团队死斗.
   *
   * Differs from regenerate() in three ways: the district pass runs across the
   * whole board (there are no base compounds or capture crystals to route
   * around), building height is capped so the mode keeps its close-quarters
   * pace, and spawn zones are planned before the city so they can be kept open.
   */
  VoxelWorld.prototype.generateTdmMap = function (seed, opts) {
    opts = opts || {};
    this._arenaMargin = TDM_ARENA_MARGIN;
    this._resetForGenerate(seed);
    this._generateTdm(opts.heightCap != null ? opts.heightCap : 26);
    this._finalizeTerrainHeight();
    this._rebuildAllChunks({ progressive: true, syncRadius: 6 });
    return this.mapSeed;
  };

  /**
   * 爆破 map: the same procedural arena generator as 死斗, only wider so the
   * playfield lands at ≈2.5× the 死斗 arena. Generating it small up front (rather
   * than post-scaling the full hand-built kit board) keeps spawns, cover and the
   * A/B sites all inside one compact arena. Plant sites are placed by
   * planSdPlantSites() against the arena bounds this leaves in _tdmArenaBounds.
   */
  VoxelWorld.prototype.generateSdMap = function (seed, opts) {
    opts = opts || {};
    this._arenaMargin = SD_ARENA_MARGIN;
    this._resetForGenerate(seed);
    this._generateTdm(opts.heightCap != null ? opts.heightCap : 26);
    this._sdPlantSites = null; // recompute against the fresh arena bounds
    this._finalizeTerrainHeight();
    this._rebuildAllChunks({ progressive: true, syncRadius: 6 });
    return this.mapSeed;
  };

  /**
   * 自由混战地图 — 图骨架 PCG + 自动评估/修复闭环（规范实现）。
   *
   * 不再切一块围墙竞技场：像死斗那样在地图中心集中生成结构、四周留平坦空街直到
   * 地图边缘、完全无墙。流程 Generate(图) → Validate(H1–H8 硬约束) →
   * Evaluate(8 项软指标, 含随机游走交火模拟) → Decide(接受/修复/换种子)：从给定
   * 种子起自增搜索直到评分达标，再把抽象图实体化——ROOM 节点用死斗/爆破的城市
   * 套件摆小楼，JUNCTION 摆轻掩体，PLATFORM 用 markStair 坡道上的开放甲板（可被
   * 下方反击、AI 能走），边线铺成可读街网。复用死斗的 spawn/flow 管线
   * (_tdmSpawnZones / _tdmArenaBounds / hotzones)，ffa-spawn.js 与小地图无需特殊处理。
   */
  VoxelWorld.prototype.generateFfaMap = function (seed) {
    this._arenaMargin = SD_ARENA_MARGIN; // 复用爆破(SD)的竞技场尺寸与随机城市
    this._resetForGenerate(seed);
    this._generateFfa();
    this._finalizeTerrainHeight();
    this._rebuildAllChunks({ progressive: true, syncRadius: 6 });
    return this.mapSeed;
  };

  VoxelWorld.prototype._generateFfa = function () {
    this._rngState = (this.mapSeed || 1) >>> 0;
    this._noiseSeed = 0;
    this._tdmArena = true; // 平坦地面, 无固定河道 / 领地栅栏
    this._pveDistrict = false;
    this._ffaDistrict = false;
    this._districtSpawns = null;

    // 复用死斗城市管线 (路网 + 街区 + 地标 + 天桥 + 碎石), 出生点换成 8 人环形。
    // 街区比死斗更密, 中立航点周围保留掩体, 再撒一层低矮多向掩体 —— 高频交火、
    // 可绕行, 而不是空场或迷宫。
    this._plannedBases = [];
    this._tdmSpawnZones = this._planFfaSpawnZones();
    this._plannedLandmarks = this._planTdmLandmarks();
    this._tdmHotzones = this._planTdmHotzones();

    this._buildTerrain();
    this._buildRoadGrid();
    // FFA-only density: tighter lots, almost no empty plazas, buildings hug
    // the 8 home pads only (neutral respawns keep surrounding cover). 死斗 /
    // 爆破 keep the default 24–28 spacing via _generateTdm.
    this._buildTdmDistricts(26, {
      spacing: 20 + this._randInt(0, 2),
      emptyChance: 0.05,
      jitter: 2,
      clearHomesOnly: true,
      avoidOverlap: true,
      houseW: 11,
      houseD: 10,
    });
    this._placeFactoryLandmarks();
    this._scatterFfaCover();
    this._buildSkyBridges();
    this._scatterDebris();
    this._clearTdmSpawnPads();
    this._buildBedrockShell();

    if (global.VF.refreshWorldOutskirts) {
      global.VF.refreshWorldOutskirts(this);
    }
  };

  /**
   * Personal 自由混战 only: Doodle District voxel layout (not 枪械模式 / PVP FFA).
   */
  VoxelWorld.prototype.generateFfaDistrictMap = function (seed) {
    this._arenaMargin = FFA_ARENA_MARGIN;
    this._resetForGenerate(seed);
    this._generateFfaDistrict();
    this._finalizeTerrainHeight();
    this._rebuildAllChunks({ progressive: true, syncRadius: 6 });
    return this.mapSeed;
  };

  VoxelWorld.prototype._generateFfaDistrict = function () {
    this._rngState = (this.mapSeed || 1) >>> 0;
    this._noiseSeed = 0;
    this._tdmArena = true;
    this._ffaDistrict = true;
    this._pveDistrict = false;
    this._plannedBases = [];
    this._plannedLandmarks = [];
    this._tdmHotzones = [];

    this._buildTerrain();
    if (this._buildPveDistrict) this._buildPveDistrict();
    this._tdmSpawnZones = this._planDistrictFfaSpawnZones();
    this._tdmHotzones = this._planTdmHotzones();
    this._clearDistrictFfaPads();
    this._buildBedrockShell();

    if (global.VF.refreshWorldOutskirts) {
      global.VF.refreshWorldOutskirts(this);
    }
  };

  /** FFA homes + neutrals from the district spawn pads (rooftops keep their floor Y). */
  VoxelWorld.prototype._planDistrictFfaSpawnZones = function () {
    const size = this.worldSize;
    const s = this._dS || 1.45;
    const ox = this._dOx != null ? this._dOx : size * 0.5;
    const oz = this._dOz != null ? this._dOz : size * 0.5;
    const half = Math.ceil(55 * s) + 6;
    this._tdmArenaBounds = {
      x0: ox - half,
      x1: ox + half,
      z0: oz - half,
      z1: oz + half,
    };
    this._tdmArenaCenter = { x: ox, z: oz };
    this._tdmArenaRadius = half * 0.92;

    const zones = [];
    let n = 0;
    const map = (dx, dy, dz) => {
      if (this._dMapSpawn) return this._dMapSpawn(dx, dy, dz);
      return {
        x: Math.round(ox + dx * s),
        y: (this._dGy || 9) + Math.round(dy),
        z: Math.round(oz + dz * s),
      };
    };
    const push = (dx, dy, dz, team, home) => {
      const p = map(dx, dy, dz);
      zones.push({
        id: 'ffa-' + n++,
        x: p.x,
        z: p.z,
        y: 0,
        floorY: p.y,
        team: team || null,
        home: !!home,
      });
    };

    // 8 homes: player on west street, AI around the rest of the district
    push(-40, 0, 18, 'ally', true);
    push(40, 0, 8, 'enemy', true);
    push(-52, 0, 30, 'enemy', true);
    push(52, 0, 30, 'enemy', true);
    push(-48, 7, -30, 'enemy', true);
    push(48, 7, -30, 'enemy', true);
    push(-30, 7, -48, 'enemy', true);
    push(16, 7, -45, 'enemy', true);

    const extras = [
      [0, 0, 0],
      [0, 8, 0],
      [0, 16, -3],
      [-34, 12, 12],
      [34, 12, 18],
      [0, 7, -30],
      [0, 0, 42],
    ];
    for (let i = 0; i < extras.length; i++) {
      const e = extras[i];
      push(e[0], e[1], e[2], null, false);
    }
    return zones;
  };

  /** Small headroom only — do not flatten a 7m disk through buildings. */
  VoxelWorld.prototype._clearDistrictFfaPads = function () {
    const zones = this._tdmSpawnZones;
    if (!zones) return;
    const size = this.worldSize;
    for (let i = 0; i < zones.length; i++) {
      const s = zones[i];
      const gy = s.floorY != null ? s.floorY : this._surface(s.x, s.z) || 9;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const x = s.x + dx;
          const z = s.z + dz;
          if (x < 1 || z < 1 || x >= size - 1 || z >= size - 1) continue;
          for (let y = gy + 1; y <= gy + 4 && y < this.height; y++) {
            this.set(x, y, z, BLOCK.AIR);
          }
        }
      }
      s.y = gy + 1;
    }
  };

  /**
   * FFA 出生点: 8 个 home 均匀分布在竞技场外圈的一个圆环上 (index 0 = 玩家 蓝/ally,
   * 1..7 = AI 红/enemy), 让 8 人从四面向中心汇聚; 另加中心 + 内圈中立航点供 respawn
   * 选点与热区流动。写入 _tdmArenaBounds/Center/Radius, 让城市/地标/热区/小地图全部
   * 复用死斗逻辑。区块结构与死斗 _planTdmSpawnZones 完全一致 (ffa-spawn.js 无需改动)。
   */
  VoxelWorld.prototype._planFfaSpawnZones = function () {
    const size = this.worldSize;
    const margin = this._arenaMargin || TDM_ARENA_MARGIN;
    const x0 = size * margin;
    const x1 = size * (1 - margin);
    const z0 = size * margin;
    const z1 = size * (1 - margin);
    this._tdmArenaBounds = { x0: x0, x1: x1, z0: z0, z1: z1 };
    this._tdmArenaCenter = { x: size * 0.5, z: size * 0.5 };
    this._tdmArenaRadius = Math.max(x1 - x0, z1 - z0) * 0.55;

    const cx = size * 0.5;
    const cz = size * 0.5;
    const zones = [];
    let n = 0;
    const push = (fx, fz, team, home) => {
      const x = Math.max(TDM_PAD_R + 3, Math.min(size - TDM_PAD_R - 3, Math.round(fx)));
      const z = Math.max(TDM_PAD_R + 3, Math.min(size - TDM_PAD_R - 3, Math.round(fz)));
      zones.push({ id: 'ffa-' + n++, x: x, z: z, y: 0, team: team || null, home: !!home });
    };

    const homeR = Math.min(x1 - cx, z1 - cz) - TDM_HOME_INSET;
    const a0 = this._rand() * Math.PI * 2;
    for (let i = 0; i < FFA_PC; i++) {
      const ang = a0 + (i / FFA_PC) * Math.PI * 2;
      push(cx + Math.cos(ang) * homeR, cz + Math.sin(ang) * homeR, i === 0 ? 'ally' : 'enemy', true);
    }

    push(cx, cz, null, false);
    const inR = homeR * 0.5;
    const inN = 6;
    for (let i = 0; i < inN; i++) {
      const ang = a0 + (i / inN) * Math.PI * 2 + 0.4;
      push(cx + Math.cos(ang) * inR, cz + Math.sin(ang) * inR, null, false);
    }
    return zones;
  };

  /* ───────────────────── 图论工具（生成与评估共用） ─────────────────────
   * 节点 id 恒等于其在 nodes 数组中的下标，边用 {a,b} 引用 id，所以邻接/度数/
   * 连通/跳数都能在小图上直接算——这是规范「先图后形」让评估变简单的关键。 */
  function ffaDeg(edges, id) {
    let d = 0;
    for (let i = 0; i < edges.length; i++) {
      if (edges[i].a === id || edges[i].b === id) d++;
    }
    return d;
  }
  function ffaHasEdge(edges, a, b) {
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return true;
    }
    return false;
  }
  function ffaAdj(nodes, edges) {
    const m = {};
    for (let i = 0; i < nodes.length; i++) m[nodes[i].id] = [];
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (m[e.a]) m[e.a].push(e.b);
      if (m[e.b]) m[e.b].push(e.a);
    }
    return m;
  }
  function ffaConnected(nodes, edges) {
    if (!nodes.length) return true;
    const adj = ffaAdj(nodes, edges);
    const seen = {};
    const st = [nodes[0].id];
    seen[nodes[0].id] = 1;
    let c = 1;
    while (st.length) {
      const u = st.pop();
      const ns = adj[u] || [];
      for (let i = 0; i < ns.length; i++) {
        if (!seen[ns[i]]) {
          seen[ns[i]] = 1;
          c++;
          st.push(ns[i]);
        }
      }
    }
    return c === nodes.length;
  }
  function ffaHops(nodes, edges, srcId) {
    const adj = ffaAdj(nodes, edges);
    const dist = {};
    dist[srcId] = 0;
    const q = [srcId];
    let h = 0;
    while (h < q.length) {
      const u = q[h++];
      const ns = adj[u] || [];
      for (let i = 0; i < ns.length; i++) {
        if (dist[ns[i]] == null) {
          dist[ns[i]] = dist[u] + 1;
          q.push(ns[i]);
        }
      }
    }
    return dist;
  }
  function ffaClamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function ffaEdgeMeta(A, B) {
    const dx = A.x - B.x;
    const dz = A.z - B.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    const vert = A.floor !== B.floor || A.type === 'PLATFORM' || B.type === 'PLATFORM';
    const w =
      A.type === 'OPEN' || B.type === 'OPEN'
        ? 5
        : A.type === 'JUNCTION' || B.type === 'JUNCTION'
        ? 4
        : 3;
    return { w: w, len: len, vert: vert };
  }

  /* ═══════════════════ 自由混战 PCG：Generate-Evaluate-Repair 闭环 ═══════════════════
   *
   * 规范第零部分的四步闭环，无固定形状、无围墙竞技场：
   *   1.Generate  — 图骨架（泊松节点 + 生成树 + 强制加环 + degree≥2 + 垂直连接）
   *   2.Validate  — H1–H8 硬约束（不满足→修复或判废）
   *   3.Evaluate  — 8 项软指标（含随机游走交火模拟）加权总分
   *   4.Decide    — ≥0.75 接受 / 0.60–0.75 修复 / <0.60 换种子
   * _ffaSearch 从给定种子自增搜索直到评分达标，输出图 + 控制台评分报告。 */

  VoxelWorld.prototype._ffaSearch = function (seed0) {
    let best = null;
    let bestScore = -1;
    let bestRep = null;
    for (let attempt = 0; attempt < FFA_MAX_RESEED; attempt++) {
      const seed = (seed0 + attempt) >>> 0;
      const g = this._ffaGenerate(seed);
      g.seed = seed;
      const rep = this._ffaValidateAndScore(g);
      const sc = rep.score ? rep.score.total : -1;
      if ((rep.verdict === 'ACCEPTED' || rep.verdict === 'REPAIRED') && sc >= FFA_REPAIR) {
        g.report = this._ffaBuildReport(g, rep, attempt);
        this._ffaReport(g.report);
        return g;
      }
      if (sc > bestScore) {
        bestScore = sc;
        best = g;
        bestRep = rep;
      }
    }
    if (!best) {
      best = this._ffaGenerate(seed0 >>> 0);
      best.seed = seed0 >>> 0;
      bestRep = this._ffaValidateAndScore(best);
    }
    best.report = this._ffaBuildReport(best, bestRep, FFA_MAX_RESEED);
    best.report.verdict = 'FALLBACK(' + best.report.verdict + ')';
    this._ffaReport(best.report);
    return best;
  };

  /* ── 1.Generate ────────────────────────────────────────────────────────── */

  VoxelWorld.prototype._ffaGenerate = function (seed) {
    this._rngState = seed >>> 0;
    const size = this.worldSize;
    const B = { size: size, cx: Math.round(size * 0.5), cz: Math.round(size * 0.5) };

    // Phase 1 尺寸: area = pc × density(≈650, size=wide72), 保持 density ∈[450,650].
    const sideMax = Math.floor(Math.sqrt(FFA_DENSITY_MAX * FFA_PC)); // 72
    const sideMin = Math.ceil(Math.sqrt(FFA_DENSITY_MIN * FFA_PC)); // 60
    let side = sideMax - this._randInt(0, 4);
    side = Math.max(sideMin, Math.min(sideMax, side));
    B.side = side;
    B.half = Math.floor(side / 2);
    B.gy = this._surface(B.cx, B.cz);

    const nodes = this._ffaNodes(B);
    const edges = this._ffaEdges(nodes);
    const spawns = this._ffaSpawns(nodes, B);
    const resources = this._ffaResources(nodes, edges);
    return {
      seed: seed >>> 0,
      size: size,
      cx: B.cx,
      cz: B.cz,
      side: side,
      half: B.half,
      gy: B.gy,
      grid: B.grid,
      nodes: nodes,
      edges: edges,
      spawns: spawns,
      resources: resources,
    };
  };

  /**
   * Phase 2 节点: 城市路网的交叉点 (G×G 抖动格点)。无中心枢纽——每个交叉点平权,
   * 楼房填在格点之间的街区 (见 _ffaBuildBlocks)。这样图天然循环、四向连通,
   * 实体化后就是「街区 + 路网」而非环形斗兽场。
   */
  VoxelWorld.prototype._ffaNodes = function (B) {
    const nodes = [];
    const G = 4; // 固定 4×4 交叉点 → 9 个街区, 成片城区而非空场
    B.grid = G;
    const pad = 6;
    const span = (B.half - pad) * 2;
    const cell = span / (G - 1);
    const jit = cell * 0.1;
    for (let gz = 0; gz < G; gz++) {
      for (let gx = 0; gx < G; gx++) {
        const x = Math.round(B.cx - B.half + pad + gx * cell + (this._rand() - 0.5) * 2 * jit);
        const z = Math.round(B.cz - B.half + pad + gz * cell + (this._rand() - 0.5) * 2 * jit);
        nodes.push({ id: nodes.length, gx: gx, gz: gz, x: x, z: z });
      }
    }
    this._ffaAssignTypes(nodes);
    return nodes;
  };

  VoxelWorld.prototype._ffaAssignTypes = function (nodes) {
    const others = [];
    for (let i = 0; i < nodes.length; i++) if (!nodes[i].isCenter) others.push(nodes[i].id);
    for (let i = others.length - 1; i > 0; i--) {
      const j = this._randInt(0, i);
      const t = others[i];
      others[i] = others[j];
      others[j] = t;
    }
    let platWant = Math.round(nodes.length * FFA_PLATFORM_RATIO);
    platWant = Math.max(1, Math.min(platWant, others.length));
    const plat = {};
    for (let i = 0; i < platWant; i++) plat[others[i]] = 1;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.isCenter) continue;
      if (plat[n.id]) {
        n.type = 'PLATFORM';
        n.floor = 1;
        n.r = 5 + this._randInt(0, 1);
        n.cover = 0.35 + this._rand() * 0.15;
      } else {
        const roll = this._rand();
        n.floor = 0;
        if (roll < 0.25) {
          n.type = 'OPEN'; // 广场路口
          n.r = 6 + this._randInt(0, 2);
          n.cover = 0.12 + this._rand() * 0.15;
        } else {
          n.type = 'JUNCTION'; // 普通街口 (楼房在四周街区)
          n.r = 4 + this._randInt(0, 2);
          n.cover = 0.2 + this._rand() * 0.15;
        }
      }
    }
  };

  /**
   * Phase 3 边: 连接格点四邻 (右/下) 成街道网格 → 天然循环 + degree≥2 + 多向暴露。
   * 再按 ideal 环数删去少量弦 (保连通/无死角) 制造 T 型路口的自然变化; platform
   * 保证 ≥2 条 (含坡道) 边, 使高台总能绕后。
   */
  VoxelWorld.prototype._ffaEdges = function (nodes) {
    const edges = [];
    const add = (a, b) => {
      if (a === b || ffaHasEdge(edges, a, b)) return;
      const m = ffaEdgeMeta(nodes[a], nodes[b]);
      edges.push({ id: edges.length, a: a, b: b, w: m.w, len: m.len, vert: m.vert });
    };
    const nearest = (a) => {
      let bb = -1;
      let bd = Infinity;
      for (let b = 0; b < nodes.length; b++) {
        if (b === a || ffaHasEdge(edges, a, b)) continue;
        const dx = nodes[a].x - nodes[b].x;
        const dz = nodes[a].z - nodes[b].z;
        const d = dx * dx + dz * dz;
        if (d < bd) {
          bd = d;
          bb = b;
        }
      }
      return bb;
    };

    // 街道网格: 每个交叉点连右邻与下邻
    const at = {};
    for (let i = 0; i < nodes.length; i++) at[nodes[i].gx + ',' + nodes[i].gz] = nodes[i].id;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const right = at[n.gx + 1 + ',' + n.gz];
      const down = at[n.gx + ',' + (n.gz + 1)];
      if (right != null) add(n.id, right);
      if (down != null) add(n.id, down);
    }

    // 环数调优: 删去两端 degree≥3 的弦, 使 cycle_count 靠近 ideal (且保连通)
    const cyc = () => edges.length - nodes.length + 1;
    const idealCyc = Math.max(FFA_MIN_CYCLES, Math.round(cyc() * 0.6));
    let guard = 0;
    while (cyc() > idealCyc && guard++ < edges.length * 2) {
      let pick = -1;
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        if (ffaDeg(edges, e.a) >= 3 && ffaDeg(edges, e.b) >= 3) {
          pick = i;
          break;
        }
      }
      if (pick < 0) break;
      const saved = edges.splice(pick, 1)[0];
      if (!ffaConnected(nodes, edges)) {
        edges.push(saved);
        break;
      }
    }

    // degree≥2 保无死角 (删弦后兜底)
    for (let a = 0; a < nodes.length; a++) {
      let g2 = 0;
      while (ffaDeg(edges, a) < FFA_MIN_DEGREE && g2++ < nodes.length) {
        const b = nearest(a);
        if (b < 0) break;
        add(a, b);
      }
    }

    // Phase 4 垂直: platform ≥2 条边 (皆含坡道), 保证高台可绕后
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].type !== 'PLATFORM') continue;
      let g3 = 0;
      while (ffaDeg(edges, nodes[i].id) < 2 && g3++ < nodes.length) {
        const b = nearest(nodes[i].id);
        if (b < 0) break;
        add(nodes[i].id, b);
      }
    }
    return edges;
  };

  /** Phase 5 复活点: 泊松撒点, 中心降密度, 按最近节点聚成组团。 */
  VoxelWorld.prototype._ffaSpawns = function (nodes, B) {
    const spawns = [];
    const want = FFA_PC * FFA_SPAWN_PER;
    const pad = 4;
    const lo = -B.half + pad;
    const hi = B.half - pad;
    const centerAvoid = B.half * 0.32;
    let minGap = 6;
    let guard = 0;
    while (spawns.length < want && guard++ < 8000) {
      const x = Math.round(B.cx + lo + this._rand() * (hi - lo));
      const z = Math.round(B.cz + lo + this._rand() * (hi - lo));
      const cdx = x - B.cx;
      const cdz = z - B.cz;
      if (cdx * cdx + cdz * cdz < centerAvoid * centerAvoid && this._rand() < 0.8) continue;
      let ok = true;
      for (let i = 0; i < spawns.length; i++) {
        const dx = x - spawns[i].x;
        const dz = z - spawns[i].z;
        if (dx * dx + dz * dz < minGap * minGap) {
          ok = false;
          break;
        }
      }
      if (!ok) {
        if (guard % 400 === 0 && minGap > 3) minGap -= 1;
        continue;
      }
      let bn = 0;
      let bd = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const dx = x - nodes[i].x;
        const dz = z - nodes[i].z;
        const d = dx * dx + dz * dz;
        if (d < bd) {
          bd = d;
          bn = nodes[i].id;
        }
      }
      spawns.push({ x: x, z: z, node: bn, group: bn });
    }
    return spawns;
  };

  /** Phase 6 资源热点: 强资源→中心/最高危节点; 弱资源→散点。仅供评估/流动导向。 */
  VoxelWorld.prototype._ffaResources = function (nodes, edges) {
    const res = [{ x: nodes[0].x, z: nodes[0].z, node: 0, strong: true }];
    let hn = -1;
    let hd = -1;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].isCenter) continue;
      const d = ffaDeg(edges, nodes[i].id);
      if (d > hd) {
        hd = d;
        hn = nodes[i].id;
      }
    }
    if (hn >= 0) res.push({ x: nodes[hn].x, z: nodes[hn].z, node: hn, strong: true });
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.isCenter || n.id === hn) continue;
      if (this._rand() < 0.4) res.push({ x: n.x, z: n.z, node: n.id, strong: false });
    }
    return res;
  };

  /* ── 2.Validate — H1–H8 硬约束 ─────────────────────────────────────────── */

  VoxelWorld.prototype._ffaValidate = function (g) {
    const nodes = g.nodes;
    const edges = g.edges;
    const defects = [];
    const rejectCodes = [];

    if (!ffaConnected(nodes, edges)) rejectCodes.push('ISOLATED_NODE'); // H1
    const dens = (g.side * g.side) / FFA_PC; // H5
    if (dens < FFA_DENSITY_MIN || dens > FFA_DENSITY_MAX) rejectCodes.push('BAD_SIZE');

    for (let i = 0; i < nodes.length; i++) {
      if (ffaDeg(edges, nodes[i].id) < FFA_MIN_DEGREE) defects.push({ type: 'DEADEND', node: nodes[i].id }); // H2
    }
    if (edges.length - nodes.length + 1 < FFA_MIN_CYCLES) defects.push({ type: 'NO_CYCLE' }); // H3
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]; // H4 神仙位: platform 需 degree≥2 且能被下层射击(开放甲板)
      if (n.type !== 'PLATFORM') continue;
      if (ffaDeg(edges, n.id) < 2 || n.cover >= 0.7) defects.push({ type: 'GODSPOT', node: n.id });
    }
    if (g.spawns.length < FFA_PC * 4) defects.push({ type: 'FEW_SPAWNS' }); // H6
    for (let i = 0; i < g.spawns.length; i++) {
      if (ffaDeg(edges, g.spawns[i].node) < FFA_MIN_DEGREE) {
        defects.push({ type: 'ISOLATED_SPAWN', node: g.spawns[i].node }); // H7
        break;
      }
    }
    const hops = ffaHops(nodes, edges, 0); // H8 中心可达
    for (let i = 0; i < nodes.length; i++) {
      if (hops[nodes[i].id] == null || hops[nodes[i].id] > FFA_MAX_HOPS) {
        defects.push({ type: 'FAR_CENTER', node: nodes[i].id });
        break;
      }
    }

    const reject = rejectCodes.length > 0;
    return { pass: !reject && defects.length === 0, reject: reject, rejectCodes: rejectCodes, defects: defects };
  };

  /* ── 3.Evaluate — 8 项软指标加权总分 ───────────────────────────────────── */

  VoxelWorld.prototype._ffaEvaluate = function (g) {
    const nodes = g.nodes;
    const edges = g.edges;
    const n = nodes.length;
    const adj = ffaAdj(nodes, edges);
    const deg = (id) => adj[id].length;

    // 指标1 循环度
    const cyc = edges.length - nodes.length + 1;
    const idealC = FFA_PC / 2;
    const circulation = ffaClamp(1 - Math.abs(cyc - idealC) / idealC, 0, 1);

    // 指标2 连通均衡
    let degMean = 0;
    for (let i = 0; i < n; i++) degMean += deg(nodes[i].id);
    degMean /= n;
    let degVar = 0;
    let deg3 = 0;
    for (let i = 0; i < n; i++) {
      const d = deg(nodes[i].id);
      degVar += (d - degMean) * (d - degMean);
      if (d >= 3) deg3++;
    }
    degVar /= n;
    const connectivity = 0.6 * (1 / (1 + degVar)) + 0.4 * (deg3 / n);

    // 几何辅助
    const bearings = (id) =>
      adj[id].map((v) => Math.atan2(nodes[v].z - nodes[id].z, nodes[v].x - nodes[id].x));
    const maxGap = (bs) => {
      if (bs.length < 2) return Math.PI * 2;
      const a = bs.slice().sort((p, q) => p - q);
      let mg = 0;
      for (let i = 0; i < a.length; i++) {
        const nx = i + 1 < a.length ? a[i + 1] : a[0] + Math.PI * 2;
        if (nx - a[i] > mg) mg = nx - a[i];
      }
      return mg;
    };
    const backedByWall = (nd) => {
      const dx = nd.x - g.cx;
      const dz = nd.z - g.cz;
      return Math.sqrt(dx * dx + dz * dz) > g.half - 8;
    };
    const coverage = (nd) =>
      nd.type === 'OPEN' ? 0.7 : nd.type === 'PLATFORM' ? 0.6 : nd.type === 'JUNCTION' ? 0.4 : 0.2;

    // 指标3 反蹲点 ★
    let riskSum = 0;
    const campNodes = [];
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      const d = deg(nd.id);
      let r = 0;
      if (d === 2) r += 0.3;
      if (backedByWall(nd)) r += 0.4;
      if (coverage(nd) > 0.5) r += 0.3;
      const flankable = d >= 2 && maxGap(bearings(nd.id)) <= Math.PI * 1.25;
      if (!flankable) r += 0.5;
      r = ffaClamp(r, 0, 1);
      riskSum += r;
      if (r >= 0.6) campNodes.push(nd.id);
    }
    const antiCamp = 1 - ffaClamp(riskSum / n, 0, 1);

    // 指标4 多向暴露 (邻接方向落在 8 个扇区的去重计数)
    let expSum = 0;
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      const set = {};
      for (let k = 0; k < adj[nd.id].length; k++) {
        const v = adj[nd.id][k];
        const a = Math.atan2(nodes[v].z - nd.z, nodes[v].x - nd.x);
        set[Math.floor((((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * 8)] = 1;
      }
      expSum += Object.keys(set).length;
    }
    const exposure = ffaClamp(expSum / n / 3, 0, 1);

    // 指标5 复活分布 ★ / 指标6 交火密度 ★ / 指标7 路径多样性
    const spawnDist = this._ffaSpawnScore(g);
    const engagement = this._ffaWalkSim(g, adj);
    const pathDiv = this._ffaPathDiversity(g, adj);

    // 指标8 垂直性
    let platCount = 0;
    let badPlat = false;
    for (let i = 0; i < n; i++) {
      if (nodes[i].type === 'PLATFORM') {
        platCount++;
        if (nodes[i].cover >= 0.7) badPlat = true;
      }
    }
    const platRatio = platCount / n;
    let verticality = ffaClamp(1 - Math.abs(platRatio - FFA_PLATFORM_RATIO) / FFA_PLATFORM_RATIO, 0, 1);
    if (badPlat) verticality = 0;

    const ind = {
      circulation: circulation,
      connectivity: connectivity,
      anti_camp: antiCamp,
      exposure: exposure,
      spawn_dist: spawnDist,
      engagement: engagement,
      path_diversity: pathDiv,
      verticality: verticality,
    };
    const W = {
      circulation: 0.12,
      connectivity: 0.1,
      anti_camp: 0.2,
      exposure: 0.13,
      spawn_dist: 0.15,
      engagement: 0.15,
      path_diversity: 0.08,
      verticality: 0.07,
    };
    let total = 0;
    let weakest = null;
    let wv = Infinity;
    for (const k in W) {
      total += ind[k] * W[k];
      if (ind[k] < wv) {
        wv = ind[k];
        weakest = k;
      }
    }
    return { total: total, indicators: ind, weakest: weakest, campNodes: campNodes };
  };

  /** 指标5 复活分布: 0.4 分散度 + 0.3 避中心度 + 0.3 组团合理。 */
  VoxelWorld.prototype._ffaSpawnScore = function (g) {
    const sp = g.spawns;
    const m = sp.length;
    if (m < 2) return 0;
    const nn = [];
    for (let i = 0; i < m; i++) {
      let bd = Infinity;
      for (let j = 0; j < m; j++) {
        if (i === j) continue;
        const dx = sp[i].x - sp[j].x;
        const dz = sp[i].z - sp[j].z;
        const d = dx * dx + dz * dz;
        if (d < bd) bd = d;
      }
      nn.push(Math.sqrt(bd));
    }
    let nmean = 0;
    for (let i = 0; i < m; i++) nmean += nn[i];
    nmean /= m;
    let nstd = 0;
    for (let i = 0; i < m; i++) nstd += (nn[i] - nmean) * (nn[i] - nmean);
    nstd = Math.sqrt(nstd / m);
    const spread = ffaClamp(1 - nstd / (nmean || 1), 0, 1);

    const cr = g.half * 0.32;
    let cc = 0;
    for (let i = 0; i < m; i++) {
      const dx = sp[i].x - g.cx;
      const dz = sp[i].z - g.cz;
      if (dx * dx + dz * dz < cr * cr) cc++;
    }
    const centerDensity = cc / (Math.PI * cr * cr);
    const avgDensity = m / (g.side * g.side);
    const centerPenalty = ffaClamp(centerDensity / (avgDensity || 1) / 2, 0, 1);

    const groups = {};
    for (let i = 0; i < m; i++) groups[sp[i].group] = 1;
    const groupScore = ffaClamp(Object.keys(groups).length / FFA_GROUP_MIN, 0, 1);

    return 0.4 * spread + 0.3 * (1 - centerPenalty) + 0.3 * groupScore;
  };

  /**
   * 指标6 交火密度: 在图上放 walk_agents 个 agent 随机游走 walk_steps 步 (偏好
   * 中心/资源/开阔), 统计节点被经过频次得遭遇热力图。理想: 有若干热点、无冷死角。
   */
  VoxelWorld.prototype._ffaWalkSim = function (g, adj) {
    const nodes = g.nodes;
    const n = nodes.length;
    const visit = new Array(n).fill(0);
    const resSet = {};
    for (let i = 0; i < (g.resources || []).length; i++) resSet[g.resources[i].node] = 1;
    const attract = (id) => {
      const nd = nodes[id];
      let w = 1;
      if (nd.isCenter) w += 1;
      if (resSet[id]) w += 0.6;
      if (nd.type === 'OPEN') w += 0.3;
      return w;
    };
    for (let a = 0; a < FFA_WALK_AGENTS; a++) {
      let cur = this._randInt(0, n - 1);
      for (let s = 0; s < FFA_WALK_STEPS; s++) {
        visit[cur]++;
        const ns = adj[cur];
        if (!ns.length) break;
        let tot = 0;
        for (let k = 0; k < ns.length; k++) tot += attract(ns[k]);
        let r = this._rand() * tot;
        let pick = ns[0];
        for (let k = 0; k < ns.length; k++) {
          r -= attract(ns[k]);
          if (r <= 0) {
            pick = ns[k];
            break;
          }
        }
        cur = pick;
      }
    }
    let totVisit = 0;
    for (let i = 0; i < n; i++) totVisit += visit[i];
    totVisit = totVisit || 1;
    const avg = 1 / n;
    let hot = 0;
    let cold = 0;
    for (let i = 0; i < n; i++) {
      const f = visit[i] / totVisit;
      if (f > avg * 1.5) hot++;
      if (f < avg * 0.25) cold++;
    }
    const hotTerm = ffaClamp(1 - Math.abs(hot / n - 0.3) / 0.3, 0, 1);
    return ffaClamp(hotTerm * (1 - cold / n), 0, 1);
  };

  /** 指标7 路径多样性: 采样节点对, 数其最短路首步分叉数 (多平行路→高分)。 */
  VoxelWorld.prototype._ffaPathDiversity = function (g, adj) {
    const nodes = g.nodes;
    const n = nodes.length;
    const dist = [];
    for (let s = 0; s < n; s++) {
      const d = new Array(n).fill(-1);
      d[s] = 0;
      const q = [s];
      let h = 0;
      while (h < q.length) {
        const u = q[h++];
        for (let k = 0; k < adj[u].length; k++) {
          const v = adj[u][k];
          if (d[v] < 0) {
            d[v] = d[u] + 1;
            q.push(v);
          }
        }
      }
      dist.push(d);
    }
    let sum = 0;
    let cnt = 0;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const D = dist[a][b];
        if (D <= 0) continue;
        let first = 0;
        for (let k = 0; k < adj[a].length; k++) {
          if (dist[adj[a][k]][b] === D - 1) first++;
        }
        sum += ffaClamp((first - 1) / 2, 0, 1);
        cnt++;
      }
    }
    return cnt ? sum / cnt : 0;
  };

  /* ── 4.Decide + 5.Repair ───────────────────────────────────────────────── */

  VoxelWorld.prototype._ffaValidateAndScore = function (g) {
    const history = [];
    for (let it = 0; it <= FFA_MAX_REPAIR; it++) {
      const val = this._ffaValidate(g);
      if (!val.pass) {
        if (val.reject)
          return { verdict: 'REJECTED', score: null, hard: val, history: history, reason: val.rejectCodes.join(',') };
        this._ffaRepair(g, val.defects);
        history.push('HARD:' + val.defects.map((d) => d.type).join('+'));
        continue;
      }
      const ev = this._ffaEvaluate(g);
      if (ev.total >= FFA_ACCEPT)
        return { verdict: history.length ? 'REPAIRED' : 'ACCEPTED', score: ev, hard: val, history: history };
      if (ev.total >= FFA_REPAIR) {
        if (it < FFA_MAX_REPAIR) {
          this._ffaRepairWorst(g, ev);
          history.push('METRIC:' + ev.weakest);
          continue;
        }
        return { verdict: 'REPAIRED', score: ev, hard: val, history: history };
      }
      return { verdict: 'REJECTED', score: ev, hard: val, history: history, reason: 'LOW_SCORE' };
    }
    const val = this._ffaValidate(g);
    const ev = this._ffaEvaluate(g);
    if (val.pass && ev.total >= FFA_REPAIR)
      return { verdict: 'REPAIRED', score: ev, hard: val, history: history };
    return { verdict: 'REJECTED', score: ev, hard: val, history: history, reason: 'MAX_REPAIR' };
  };

  VoxelWorld.prototype._ffaAddEdge = function (g, a, b) {
    const edges = g.edges;
    if (a === b || ffaHasEdge(edges, a, b)) return;
    const m = ffaEdgeMeta(g.nodes[a], g.nodes[b]);
    edges.push({ id: edges.length, a: a, b: b, w: m.w, len: m.len, vert: m.vert });
  };

  VoxelWorld.prototype._ffaRepair = function (g, defects) {
    const nodes = g.nodes;
    const edges = g.edges;
    const nearest = (a) => {
      let bb = -1;
      let bd = Infinity;
      for (let b = 0; b < nodes.length; b++) {
        if (b === a || ffaHasEdge(edges, a, b)) continue;
        const dx = nodes[a].x - nodes[b].x;
        const dz = nodes[a].z - nodes[b].z;
        const d = dx * dx + dz * dz;
        if (d < bd) {
          bd = d;
          bb = b;
        }
      }
      return bb;
    };
    const shortestNonEdge = () => {
      let ba = -1;
      let bb = -1;
      let bd = Infinity;
      for (let a = 0; a < nodes.length; a++) {
        for (let b = a + 1; b < nodes.length; b++) {
          if (ffaHasEdge(edges, a, b)) continue;
          const dx = nodes[a].x - nodes[b].x;
          const dz = nodes[a].z - nodes[b].z;
          const d = dx * dx + dz * dz;
          if (d < bd) {
            bd = d;
            ba = a;
            bb = b;
          }
        }
      }
      if (ba >= 0) this._ffaAddEdge(g, ba, bb);
    };
    for (let i = 0; i < defects.length; i++) {
      const d = defects[i];
      if (d.type === 'DEADEND' || d.type === 'GODSPOT' || d.type === 'ISOLATED_SPAWN') {
        const b = nearest(d.node);
        if (b >= 0) this._ffaAddEdge(g, d.node, b);
      } else if (d.type === 'NO_CYCLE') {
        shortestNonEdge();
      } else if (d.type === 'FAR_CENTER') {
        this._ffaAddEdge(g, 0, d.node);
      }
    }
  };

  VoxelWorld.prototype._ffaRepairWorst = function (g, ev) {
    const w = ev.weakest;
    if (w === 'anti_camp' || w === 'exposure') {
      const node = ev.campNodes && ev.campNodes.length ? ev.campNodes[0] : 0;
      this._ffaRepair(g, [{ type: 'DEADEND', node: node }]);
    } else if (w === 'verticality') {
      this._ffaTunePlatforms(g);
    } else {
      this._ffaRepair(g, [{ type: 'NO_CYCLE' }]);
    }
  };

  VoxelWorld.prototype._ffaTunePlatforms = function (g) {
    const nodes = g.nodes;
    const want = Math.round(nodes.length * FFA_PLATFORM_RATIO);
    const plat = nodes.filter((nd) => nd.type === 'PLATFORM');
    if (plat.length > want) {
      const nd = plat[0];
      nd.type = 'JUNCTION';
      nd.floor = 0;
      nd.cover = 0.3;
    } else if (plat.length < want) {
      const room = nodes.filter((nd) => nd.type === 'ROOM')[0];
      if (room) {
        room.type = 'PLATFORM';
        room.floor = 1;
        room.cover = 0.4;
        room.r = Math.min(room.r, 6);
      }
    }
  };

  /* ── 输出评分报告 (控制台 JSON) ────────────────────────────────────────── */

  VoxelWorld.prototype._ffaBuildReport = function (g, rep, attempts) {
    const round = (v) => Math.round(v * 100) / 100;
    const rind = {};
    if (rep.score) for (const k in rep.score.indicators) rind[k] = round(rep.score.indicators[k]);
    return {
      map_id: 'ffa_seed_' + (g.seed >>> 0),
      player_count: FFA_PC,
      bounds: [g.side, g.side, 12],
      verdict: rep.verdict,
      total_score: rep.score ? round(rep.score.total) : 0,
      reseed_attempts: attempts | 0,
      hard_constraints: {
        all_pass: rep.hard ? rep.hard.pass : false,
        defects: rep.hard
          ? rep.hard.defects.map((d) => d.type + (d.node != null ? '@' + d.node : ''))
          : rep.reason
          ? [rep.reason]
          : [],
      },
      indicators: rind,
      weakest_indicator: rep.score ? rep.score.weakest : null,
      repair_history: rep.history || [],
      camp_risk_nodes: rep.score ? rep.score.campNodes : [],
      graph: {
        nodes: g.nodes.length,
        edges: g.edges.length,
        cycles: g.edges.length - g.nodes.length + 1,
        platforms: g.nodes.filter((nd) => nd.type === 'PLATFORM').length,
      },
      spawn_points: g.spawns.length,
    };
  };

  VoxelWorld.prototype._ffaReport = function (report) {
    if (typeof console === 'undefined') return;
    try {
      console.log(
        '%c[FFA PCG]%c ' + report.verdict + '  score=' + report.total_score + '  ' + report.map_id,
        'color:#38bdf8;font-weight:bold',
        'color:inherit'
      );
      console.log(JSON.stringify(report, null, 2));
    } catch (e) {
      /* console 不可用时静默 */
    }
  };

  /**
   * 把抽象图的复活点实体化为死斗风格的 spawn 管线契约:
   *   - 8 个 home (index 0 = 玩家 蓝/ally, 1..7 = AI 红/enemy), 用最远点采样在图的
   *     复活点里取一组最分散、且避开中心与 ROOM/PLATFORM 楼体的点。
   *   - 少量 neutral 航点 (中心 + OPEN/JUNCTION 节点中心) 供 respawn 选点与热区流动。
   * 同时写入 _tdmArenaBounds/Center/Radius, 让小地图与 hotzone 规划器复用死斗逻辑。
   */
  VoxelWorld.prototype._ffaDeriveSpawnZones = function (g) {
    const cx = g.cx;
    const cz = g.cz;
    const half = g.half;
    this._tdmArenaBounds = { x0: cx - half, x1: cx + half, z0: cz - half, z1: cz + half };
    this._tdmArenaCenter = { x: cx, z: cz };
    this._tdmArenaRadius = half * 0.92;

    const zones = [];
    let n = 0;
    const push = (x, z, team, home) => {
      const px = Math.max(cx - half + 3, Math.min(cx + half - 3, Math.round(x)));
      const pz = Math.max(cz - half + 3, Math.min(cz + half - 3, Math.round(z)));
      zones.push({ id: 'ffa-' + n++, x: px, z: pz, y: 0, team: team || null, home: !!home });
    };

    const struct = g.nodes.filter((nd) => nd.type === 'ROOM' || nd.type === 'PLATFORM');
    const insideStruct = (x, z) => {
      for (let i = 0; i < struct.length; i++) {
        const dx = x - struct[i].x;
        const dz = z - struct[i].z;
        const rr = struct[i].r + 3;
        if (dx * dx + dz * dz < rr * rr) return true;
      }
      return false;
    };
    const avoid = half * 0.3;
    let cands = g.spawns.filter((s) => {
      const dx = s.x - cx;
      const dz = s.z - cz;
      return dx * dx + dz * dz > avoid * avoid && !insideStruct(s.x, s.z);
    });
    if (cands.length < 8) cands = g.spawns.slice();

    const homes = [];
    if (cands.length) homes.push(cands[0]);
    while (homes.length < 8 && homes.length < cands.length) {
      let bi = -1;
      let bd = -1;
      for (let i = 0; i < cands.length; i++) {
        let nd = Infinity;
        for (let h = 0; h < homes.length; h++) {
          const dx = cands[i].x - homes[h].x;
          const dz = cands[i].z - homes[h].z;
          const d = dx * dx + dz * dz;
          if (d < nd) nd = d;
        }
        if (nd > bd) {
          bd = nd;
          bi = i;
        }
      }
      if (bi < 0 || homes.indexOf(cands[bi]) >= 0) break;
      homes.push(cands[bi]);
    }
    for (let i = 0; i < 8; i++) {
      const h = homes[i % homes.length];
      push(h.x, h.z, i === 0 ? 'ally' : 'enemy', true);
    }

    push(cx, cz, null, false);
    for (let i = 0; i < g.nodes.length; i++) {
      const nd = g.nodes[i];
      if (nd.isCenter) continue;
      if (nd.type === 'OPEN' || nd.type === 'JUNCTION') push(nd.x, nd.z, null, false);
    }
    return zones;
  };

  /* ── 实体化: 把接受的图变成体素 (中心集中、四周空街到边缘、无墙、垂直只靠坡道) ── */

  VoxelWorld.prototype._ffaVoxelize = function (g) {
    this._rngState = (g.seed >>> 0) || 1;
    const gy = g.gy;
    for (let i = 0; i < g.edges.length; i++) this._ffaStreet(g, g.edges[i], gy); // 路网
    this._ffaBuildBlocks(g, gy); // 街区楼房
    for (let i = 0; i < g.nodes.length; i++) {
      const nd = g.nodes[i];
      if (nd.type === 'PLATFORM') this._ffaBuildPlatform(g, nd, gy);
      else if (nd.type === 'OPEN') this._ffaBuildCover(g, nd, gy, 'open');
      else this._ffaBuildCover(g, nd, gy, 'junction');
    }
  };

  VoxelWorld.prototype._ffaInRegion = function (g, x, z) {
    return x >= g.cx - g.half && x <= g.cx + g.half && z >= g.cz - g.half && z <= g.cz + g.half;
  };

  /**
   * Build-time keep-clear test against the 8 initial HOME spawns only (not the
   * neutral respawn waypoints). Cover around a neutral point is fine — the final
   * _clearTdmSpawnPads pass flattens every zone's pad last, leaving a clean
   * respawn clearing ringed by that cover.
   */
  VoxelWorld.prototype._ffaNearHome = function (x, z, r) {
    const zones = this._tdmSpawnZones;
    if (!zones) return false;
    const r2 = r * r;
    for (let i = 0; i < zones.length; i++) {
      if (!zones[i].home) continue;
      const dx = x - zones[i].x;
      const dz = z - zones[i].z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  };

  /** One flat readable street along an edge (top layer → asphalt on flat ground). */
  VoxelWorld.prototype._ffaStreet = function (g, e, gy) {
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    const dx = B.x - A.x;
    const dz = B.z - A.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const px = -dz / len;
    const pz = dx / len;
    const hw = Math.max(1, Math.floor(e.w / 2));
    const steps = Math.ceil(len);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const bx = A.x + dx * t;
      const bz = A.z + dz * t;
      for (let k = -hw; k <= hw; k++) {
        const x = Math.round(bx + px * k);
        const z = Math.round(bz + pz * k);
        if (!this._ffaInRegion(g, x, z)) continue;
        this.set(x, gy, z, BLOCK.ASPHALT);
      }
    }
  };

  /**
   * 街区: 在每个网格单元 (四个交叉点围成的方块) 内, 复用死斗/爆破城市套件摆一栋
   * 楼 (自带门/内部楼梯), 街道留在楼与楼之间。部分单元留空做广场增加变化;
   * 与 platform 相邻的单元让位给坡道。
   */
  VoxelWorld.prototype._ffaBuildBlocks = function (g, gy) {
    const G = g.grid || 3;
    const at = {};
    for (let i = 0; i < g.nodes.length; i++) at[g.nodes[i].gx + ',' + g.nodes[i].gz] = g.nodes[i];
    for (let gz = 0; gz < G - 1; gz++) {
      for (let gx = 0; gx < G - 1; gx++) {
        const a = at[gx + ',' + gz];
        const b = at[gx + 1 + ',' + gz];
        const c = at[gx + ',' + (gz + 1)];
        const d = at[gx + 1 + ',' + (gz + 1)];
        if (!a || !b || !c || !d) continue;
        const inset = 2;
        const x0 = Math.max(a.x, c.x) + inset;
        const x1 = Math.min(b.x, d.x) - inset;
        const z0 = Math.max(a.z, b.z) + inset;
        const z1 = Math.min(c.z, d.z) - inset;
        const bw = x1 - x0;
        const bd = z1 - z0;
        if (bw < 7 || bd < 7) continue;
        const roll = this._rand();
        if (roll < 0.08) continue; // 少量空地 / 广场
        if (roll < 0.5 && bw >= 12 && bd >= 12) {
          this._placeMidrise(x0, z0, Math.min(bw, bd, 14), 5 + this._randInt(0, 3));
        } else if (roll < 0.85) {
          this._placeHouse(x0, z0, Math.min(bw, 14), Math.min(bd, 12));
        } else {
          this._placeRuinStub(x0, z0);
        }
      }
    }
  };

  /** JUNCTION/OPEN 节点: 散布低矮掩体柱, 保持中心可穿行、视线可读。 */
  VoxelWorld.prototype._ffaBuildCover = function (g, nd, gy, kind) {
    if (this._ffaNearHome(nd.x, nd.z, TDM_CLEAR_R)) return;
    const count = kind === 'open' ? 2 + this._randInt(0, 2) : 3 + this._randInt(0, 3);
    for (let i = 0; i < count; i++) {
      const a = this._rand() * Math.PI * 2;
      const rr = 2 + this._rand() * (nd.r - 1);
      const x = Math.round(nd.x + Math.cos(a) * rr);
      const z = Math.round(nd.z + Math.sin(a) * rr);
      if (!this._ffaInRegion(g, x, z)) continue;
      if (this._ffaNearHome(x, z, TDM_PAD_R)) continue;
      const h = kind === 'open' ? 3 + this._randInt(0, 1) : 2 + this._randInt(0, 1);
      const mat = i & 1 ? BLOCK.RUST : BLOCK.CONCRETE;
      const wide = kind === 'junction' && this._rand() > 0.5;
      for (let ddx = 0; ddx <= (wide ? 1 : 0); ddx++) {
        for (let ddz = 0; ddz <= (wide ? 1 : 0); ddz++) {
          for (let y = gy + 1; y <= gy + h; y++) this.set(x + ddx, y, z + ddz, mat);
        }
      }
    }
  };

  /**
   * PLATFORM 节点: 一块开放甲板 (无满圈护栏→可被下方射击, 满足 H4) + 沿其垂直边
   * 长出的 markStair 坡道 (每级升一格, AI 可走)。高台只能靠坡道到达, 且总能绕后。
   */
  VoxelWorld.prototype._ffaBuildPlatform = function (g, nd, gy) {
    if (this._ffaNearHome(nd.x, nd.z, TDM_CLEAR_R)) return;
    const deckY = gy + FFA_DECK_H;
    const rDeck = Math.max(4, Math.min(6, nd.r | 0));
    for (let ddx = -rDeck; ddx <= rDeck; ddx++) {
      for (let ddz = -rDeck; ddz <= rDeck; ddz++) {
        if (Math.max(Math.abs(ddx), Math.abs(ddz)) > rDeck) continue;
        this.set(nd.x + ddx, deckY, nd.z + ddz, BLOCK.METAL);
      }
    }
    const corners = [
      [-rDeck, -rDeck],
      [rDeck, -rDeck],
      [-rDeck, rDeck],
      [rDeck, rDeck],
    ];
    for (let c = 0; c < corners.length; c++) {
      for (let y = gy + 1; y < deckY; y++) this.set(nd.x + corners[c][0], y, nd.z + corners[c][1], BLOCK.CONCRETE);
    }
    const adj = ffaAdj(g.nodes, g.edges);
    const ns = adj[nd.id] || [];
    let built = 0;
    for (let i = 0; i < ns.length && built < 2; i++) {
      const nb = g.nodes[ns[i]];
      this._ffaRamp(g, nd.x, nd.z, gy, deckY, Math.atan2(nb.z - nd.z, nb.x - nd.x), rDeck);
      built++;
    }
    if (built === 0) this._ffaRamp(g, nd.x, nd.z, gy, deckY, Math.atan2(g.cz - nd.z, g.cx - nd.x), rDeck);
  };

  /** One 3-wide climbable ramp from ground to a platform deck edge (markStair). */
  VoxelWorld.prototype._ffaRamp = function (g, cx, cz, gy, deckY, ang, inner) {
    const ux = Math.cos(ang);
    const uz = Math.sin(ang);
    const px = -uz;
    const pz = ux;
    const climb = deckY - gy;
    for (let i = 0; i <= climb; i++) {
      const y = gy + 1 + i;
      if (y > deckY) break;
      const rad = inner + (climb - i);
      for (let k = -1; k <= 1; k++) {
        const x = Math.round(cx + ux * rad + px * k);
        const z = Math.round(cz + uz * rad + pz * k);
        if (!this._ffaInRegion(g, x, z)) continue;
        for (let yy = gy + 1; yy <= y; yy++) this.set(x, yy, z, BLOCK.CONCRETE);
        this.markStair(x, y, z);
      }
    }
  };

  VoxelWorld.prototype._generateTdm = function (heightCap) {
    this._rngState = (this.mapSeed || 1) >>> 0;
    this._noiseSeed = 0;
    this._tdmArena = true; // no fixed river / territory fence on this map
    this._pveDistrict = false;
    this._ffaDistrict = false;
    this._districtSpawns = null;

    // No bases in 死斗 — the keep-clear reservations they own do not apply
    this._plannedBases = [];
    this._tdmSpawnZones = this._planTdmSpawnZones();
    this._plannedLandmarks = this._planTdmLandmarks();
    this._tdmHotzones = this._planTdmHotzones();

    this._buildTerrain();
    this._buildRoadGrid();
    this._buildTdmDistricts(heightCap);
    this._placeFactoryLandmarks();
    this._buildSkyBridges(); // also builds ziplines off the bridge rails
    this._scatterDebris();
    this._clearTdmSpawnPads();
    this._buildBedrockShell();

    if (global.VF.refreshWorldOutskirts) {
      global.VF.refreshWorldOutskirts(this);
    }
  };

  /**
   * Three lanes running south (ally) → north (enemy) inside a compact arena
   * carved out of the middle of the board, plus a couple of flanking points
   * per home. Every neutral zone sits on a lane, so the safest-spawn picker
   * in tdm-spawn.js always has a live line to put a fresh soldier back on —
   * that is what keeps time-to-contact short and kills the old empty corners.
   */
  VoxelWorld.prototype._planTdmSpawnZones = function () {
    const size = this.worldSize;
    const zones = [];
    let n = 0;

    const push = (fx, fz, team, home) => {
      const x = Math.max(TDM_PAD_R + 3, Math.min(size - TDM_PAD_R - 3, Math.round(fx)));
      const z = Math.max(TDM_PAD_R + 3, Math.min(size - TDM_PAD_R - 3, Math.round(fz)));
      zones.push({
        id: 'tdm-' + n++,
        x: x,
        z: z,
        y: 0, // resolved after terrain is built
        team: team || null,
        home: !!home,
      });
    };

    const margin = this._arenaMargin || TDM_ARENA_MARGIN;
    const x0 = size * margin;
    const x1 = size * (1 - margin);
    const z0 = size * margin;
    const z1 = size * (1 - margin);
    this._tdmArenaBounds = { x0: x0, x1: x1, z0: z0, z1: z1 };
    this._tdmArenaCenter = { x: size * 0.5, z: size * 0.5 };
    this._tdmArenaRadius = Math.max(x1 - x0, z1 - z0) * 0.55;

    const laneX = [];
    for (let l = 0; l < TDM_LANE_COUNT; l++) {
      laneX.push(x0 + ((x1 - x0) * (l + 0.5)) / TDM_LANE_COUNT);
    }
    const midLane = laneX[(TDM_LANE_COUNT / 2) | 0];

    // Home clusters face off on the middle lane, close enough that a fresh
    // spawn is a short run from whichever lane is hot.
    const homes = [
      { x: midLane, z: z0 + TDM_HOME_INSET, team: 'ally' },
      { x: midLane, z: z1 - TDM_HOME_INSET, team: 'enemy' },
    ];
    for (let i = 0; i < homes.length; i++) {
      const h = homes[i];
      push(h.x, h.z, h.team, true);
      for (let k = 0; k < 2; k++) {
        const ang = (k / 2) * Math.PI * 2 + (i ? 0.6 : 0.2);
        push(h.x + Math.cos(ang) * TDM_HOME_R, h.z + Math.sin(ang) * TDM_HOME_R, h.team, true);
      }
    }

    // Neutral waypoints down every lane, evenly spaced between the homes —
    // this is the contest pool both teams' respawns and roaming AI gravitate
    // toward, so no lane ever sits empty for long.
    const laneDepth = z1 - z0 - TDM_HOME_INSET * 3.2;
    for (let l = 0; l < TDM_LANE_COUNT; l++) {
      for (let w = 0; w < TDM_LANE_WAYPOINTS; w++) {
        const t = (w + 1) / (TDM_LANE_WAYPOINTS + 1);
        const z = z0 + TDM_HOME_INSET * 1.6 + laneDepth * t;
        push(laneX[l], z, null, false);
      }
    }

    return zones;
  };

  VoxelWorld.prototype._planTdmLandmarks = function () {
    const bounds =
      this._tdmArenaBounds ||
      { x0: 30, x1: this.worldSize - 30, z0: 30, z1: this.worldSize - 30 };
    const marks = [];
    const want = 2 + this._randInt(0, 1);
    let attempts = 0;
    while (marks.length < want && attempts < 40) {
      attempts++;
      const w = 22 + this._randInt(0, 8);
      const d = 18 + this._randInt(0, 8);
      const xMin = Math.floor(bounds.x0) + 6;
      const xMax = Math.floor(bounds.x1) - 6 - w;
      const zMin = Math.floor(bounds.z0) + 6;
      const zMax = Math.floor(bounds.z1) - 6 - d;
      if (xMax <= xMin || zMax <= zMin) continue;
      const x = this._randInt(xMin, xMax);
      const z = this._randInt(zMin, zMax);
      if (this._tdmNearSpawn(x + w * 0.5, z + d * 0.5, TDM_CLEAR_R + 14)) continue;
      if (this._riverInfo(x + (w >> 1), z + (d >> 1)).inWater) continue;
      marks.push({ x: x, z: z, w: w, d: d });
    }
    return marks;
  };

  VoxelWorld.prototype._tdmNearSpawn = function (x, z, radius, homeOnly) {
    const zones = this._tdmSpawnZones;
    if (!zones) return false;
    const r2 = radius * radius;
    for (let i = 0; i < zones.length; i++) {
      if (homeOnly && !zones[i].home) continue;
      const dx = x - zones[i].x;
      const dz = z - zones[i].z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  };

  /** Axis-aligned footprint vs registered buildings (pad = extra keep-clear). */
  VoxelWorld.prototype._tdmRectHitsBuilding = function (ox, oz, w, d, pad) {
    const list = this.buildings;
    if (!list || !list.length) return false;
    pad = pad || 0;
    const x0 = ox - pad;
    const z0 = oz - pad;
    const x1 = ox + w + pad;
    const z1 = oz + d + pad;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (x0 < b.ox + b.w && x1 > b.ox && z0 < b.oz + b.d && z1 > b.oz) return true;
    }
    return false;
  };

  /**
   * 热区导航 — pre-marks 3–5 weighted hotspots the roaming AI flows toward
   * whenever no enemy is in local reach. Candidates are the arena centre, each
   * landmark centre, and the neutral lane waypoints; a greedy farthest-point
   * pass then chooses a spatially SPREAD subset so the zones blanket the arena
   * instead of piling up in the middle. That spread — paired with the
   * weight-proportional unit assignment in ai.js — is what breaks the old
   * single-blob melee into several skirmishes the player can always find.
   * Each zone is { x, z, weight, r }: weight biases how many soldiers pick it,
   * r is the arrive radius that lets a unit settle and mill there.
   */
  VoxelWorld.prototype._planTdmHotzones = function () {
    const center =
      this._tdmArenaCenter || { x: this.worldSize * 0.5, z: this.worldSize * 0.5 };

    // Candidate pool. Centre first so the farthest-point pass anchors on it.
    const cand = [{ x: center.x, z: center.z, weight: 1.0, r: 16 }];
    const marks = this._plannedLandmarks || [];
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      cand.push({ x: m.x + m.w * 0.5, z: m.z + m.d * 0.5, weight: 0.85, r: 14 });
    }
    const neutrals = (this._tdmSpawnZones || []).filter((z) => !z.home && !z.team);
    for (let i = 0; i < neutrals.length; i++) {
      cand.push({ x: neutrals[i].x, z: neutrals[i].z, weight: 0.7, r: 13 });
    }

    // Greedy farthest-point selection: always keep the centre, then repeatedly
    // add whichever remaining candidate is farthest from everything chosen so
    // far. Yields a well-separated set that covers the whole compact arena.
    const want = Math.min(5, Math.max(3, cand.length));
    const chosen = [cand.shift()];
    while (chosen.length < want && cand.length) {
      let bestI = 0;
      let bestD = -1;
      for (let i = 0; i < cand.length; i++) {
        let nearest = Infinity;
        for (let j = 0; j < chosen.length; j++) {
          const dx = cand[i].x - chosen[j].x;
          const dz = cand[i].z - chosen[j].z;
          const d = dx * dx + dz * dz;
          if (d < nearest) nearest = d;
        }
        if (nearest > bestD) {
          bestD = nearest;
          bestI = i;
        }
      }
      chosen.push(cand.splice(bestI, 1)[0]);
    }

    return chosen.map((z) => ({
      x: Math.round(z.x),
      z: Math.round(z.z),
      weight: z.weight,
      r: z.r,
    }));
  };

  /**
   * Denser and shorter than _buildDistricts: 死斗 needs frequent contact, so
   * blocks sit closer together, nothing towers over the fight, and the whole
   * pass is confined to the compact arena instead of the full board.
   *
   * opts (FFA only — 死斗/爆破 omit this and keep the original 24–28 cadence):
   *   spacing, emptyChance, jitter, clearHomesOnly, avoidOverlap, houseW, houseD
   */
  VoxelWorld.prototype._buildTdmDistricts = function (heightCap, opts) {
    opts = opts || {};
    const cap = Math.max(8, heightCap | 0);
    const spacing = opts.spacing != null ? opts.spacing | 0 : 24 + this._randInt(0, 4);
    const emptyChance = opts.emptyChance != null ? opts.emptyChance : 0.1;
    const jitter = opts.jitter != null ? opts.jitter | 0 : 0;
    const homesOnly = !!opts.clearHomesOnly;
    const avoidOverlap = !!opts.avoidOverlap;
    const hw = opts.houseW != null ? opts.houseW | 0 : 14;
    const hd = opts.houseD != null ? opts.houseD | 0 : 12;
    const bounds =
      this._tdmArenaBounds ||
      { x0: 8, x1: this.worldSize - 24, z0: 8, z1: this.worldSize - 24 };
    const bx0 = Math.floor(bounds.x0);
    const bx1 = Math.floor(bounds.x1);
    const bz0 = Math.floor(bounds.z0);
    const bz1 = Math.floor(bounds.z1);

    for (let bx = bx0; bx < bx1 - 16; bx += spacing) {
      for (let bz = bz0; bz < bz1 - 16; bz += spacing) {
        const px = bx + 8 + (jitter ? this._randInt(-jitter, jitter) : this._randInt(-4, 5));
        const pz = bz + 8 + (jitter ? this._randInt(-jitter, jitter) : this._randInt(-4, 5));
        if (px < bx0 - 2 || pz < bz0 - 2 || px >= bx1 - 2 || pz >= bz1 - 2) continue;

        const footprint = avoidOverlap
          ? 8 + this._randInt(0, Math.max(0, Math.min(14, spacing - 6) - 8))
          : 9 + this._randInt(0, 7);
        const cx = px + footprint * 0.5;
        const cz = pz + footprint * 0.5;
        if (this._tdmNearSpawn(cx, cz, TDM_CLEAR_R, homesOnly)) continue;
        if (this._riverInfo(cx, cz).inWater) continue;
        if (this._riverInfo(cx, cz).bank && this._noise(px, pz) > 0.5) continue;

        const roll = this._noise(px * 0.31, pz * 0.29);
        if (this._noise(pz * 0.17, px * 0.19) < emptyChance) continue; // occasional empty lot

        const blocked = function (w, d) {
          return avoidOverlap && this._tdmRectHitsBuilding(px, pz, w, d, 1);
        }.bind(this);

        // Prefer the rolled type; if it wouldn't fit, step down so the lot
        // still gets cover instead of becoming another empty plaza.
        if (roll > 0.66 && !blocked(footprint, footprint)) {
          this._placeMidrise(px, pz, footprint, Math.min(cap, 16 + this._randInt(0, 10)));
        } else if (roll > 0.3 && !blocked(hw, hd)) {
          this._placeHouse(px, pz, hw, hd);
        } else if (!blocked(8, 8)) {
          this._placeRuinStub(px, pz);
        }
      }
    }
  };

  /**
   * FFA street furniture: low L / wall / pillar clusters between buildings.
   * High-frequency, multi-angle cover without sealing alleys or spawn pads.
   * Unregistered (not in this.buildings) so AI can still path around them.
   */
  VoxelWorld.prototype._scatterFfaCover = function () {
    const bounds = this._tdmArenaBounds;
    if (!bounds) return;
    const spacing = 11;
    const bx0 = Math.floor(bounds.x0) + 3;
    const bx1 = Math.floor(bounds.x1) - 3;
    const bz0 = Math.floor(bounds.z0) + 3;
    const bz1 = Math.floor(bounds.z1) - 3;

    for (let bx = bx0; bx < bx1; bx += spacing) {
      for (let bz = bz0; bz < bz1; bz += spacing) {
        const x = bx + this._randInt(1, spacing - 2);
        const z = bz + this._randInt(1, spacing - 2);
        if (x < bx0 || z < bz0 || x >= bx1 || z >= bz1) continue;
        if (this._tdmNearSpawn(x, z, TDM_PAD_R + 5, true)) continue;
        if (this._tdmNearSpawn(x, z, TDM_PAD_R + 1, false)) continue;
        if (this._tdmRectHitsBuilding(x, z, 1, 1, 2)) continue;
        if (this._riverInfo(x, z).inWater) continue;
        const gy = this._surface(x, z);
        if (this.get(x, gy + 1, z) !== BLOCK.AIR) continue;
        const roll = this._rand();
        if (roll < 0.36) continue; // keep some long sightlines — 可控
        this._placeFfaCoverPiece(x, z, gy, roll);
      }
    }
  };

  VoxelWorld.prototype._placeFfaCoverPiece = function (x, z, gy, roll) {
    const h = 2 + this._randInt(0, 1);
    const mat = this._rand() > 0.45 ? BLOCK.CONCRETE : BLOCK.RUST;
    if (roll < 0.62) {
      this._ffaCoverRun(x, z, gy, h, 3 + this._randInt(0, 2), this._rand() > 0.5 ? 0 : 1, mat);
    } else if (roll < 0.86) {
      const len = 3 + this._randInt(0, 1);
      this._ffaCoverRun(x, z, gy, h, len, 0, mat);
      this._ffaCoverRun(x, z, gy, h, len, 1, mat);
    } else {
      const n = 1 + this._randInt(0, 1);
      for (let i = 0; i < n; i++) {
        const px = x + this._randInt(-1, 1);
        const pz = z + this._randInt(-1, 1);
        this._ffaCoverColumn(px, pz, gy, h + (i ? 0 : 1), mat);
      }
    }
  };

  VoxelWorld.prototype._ffaCoverRun = function (x, z, gy, h, len, axis, mat) {
    for (let i = 0; i < len; i++) {
      this._ffaCoverColumn(axis === 0 ? x + i : x, axis === 1 ? z + i : z, gy, h, mat);
    }
  };

  VoxelWorld.prototype._ffaCoverColumn = function (x, z, gy, h, mat) {
    if (this._tdmRectHitsBuilding(x, z, 1, 1, 1)) return;
    if (this._tdmNearSpawn(x, z, TDM_PAD_R, false)) return;
    if (!this._ffaInArena(x, z)) return;
    if (this._riverInfo(x, z).inWater) return;
    for (let y = gy + 1; y <= gy + h; y++) this.set(x, y, z, mat);
  };

  VoxelWorld.prototype._ffaInArena = function (x, z) {
    const b = this._tdmArenaBounds;
    if (!b) return true;
    return x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1;
  };

  /**
   * Flatten and clear each spawn zone last, so districts / debris / bridges
   * cannot leave a spawn buried or sealed in.
   */
  VoxelWorld.prototype._clearTdmSpawnPads = function () {
    const zones = this._tdmSpawnZones;
    if (!zones) return;
    const size = this.worldSize;

    for (let i = 0; i < zones.length; i++) {
      const s = zones[i];
      let gy = this._surface(s.x, s.z);
      if (gy < SUB_LAYERS) gy = 4 + SUB_LAYERS;

      for (let dx = -TDM_PAD_R; dx <= TDM_PAD_R; dx++) {
        for (let dz = -TDM_PAD_R; dz <= TDM_PAD_R; dz++) {
          if (dx * dx + dz * dz > TDM_PAD_R * TDM_PAD_R) continue;
          const x = s.x + dx;
          const z = s.z + dz;
          if (x < 1 || z < 1 || x >= size - 1 || z >= size - 1) continue;

          for (let y = SUB_LAYERS; y < gy; y++) this.set(x, y, z, BLOCK.STONE);
          this.set(x, gy, z, BLOCK.CONCRETE);
          // Headroom so nothing spawns inside geometry
          for (let y = gy + 1; y <= gy + 6 && y < this.height; y++) {
            this.set(x, y, z, BLOCK.AIR);
          }
          this._setColumnGround(x, z, gy);
        }
      }
      s.y = gy + 1;
    }
  };

  /**
   * Publish TDM zones through the shared _spawnPoints structure so minimap,
   * getSpawnPosition and team locking keep working. Marked fixed/non-capturable
   * because 死斗 has no capture mechanic and Bases never runs in this mode.
   */
  VoxelWorld.prototype.applyTdmSpawnPoints = function () {
    const zones = this._tdmSpawnZones || [];
    const ally = [];
    const enemy = [];

    for (let i = 0; i < zones.length; i++) {
      const s = zones[i];
      if (!s.team) continue;
      const point = {
        id: s.id,
        x: s.x,
        y: s.y,
        z: s.z,
        team: s.team,
        fixed: true,
        capturable: false,
        mesh: null,
        zone: s,
      };
      if (s.team === 'enemy') enemy.push(point);
      else ally.push(point);
    }

    for (let i = 0; i < ally.length; i++) {
      ally[i].index = i;
      ally[i].label = '蓝' + (i + 1);
    }
    for (let i = 0; i < enemy.length; i++) {
      enemy[i].index = i;
      enemy[i].label = '红' + (i + 1);
    }

    this._spawnPoints = { ally: ally, enemy: enemy, all: ally.concat(enemy) };
    this._selectedSpawnId = null;
    this._tdmSpawnOverride = null;

    // AI spawn/patrol homes, the compass and the minimap all read these; point
    // them at the home clusters so nothing has to special-case the missing bases
    const homeOf = (list) => {
      for (let i = 0; i < list.length; i++) {
        if (list[i].zone && list[i].zone.home) return list[i];
      }
      return list[0] || null;
    };
    const a = homeOf(ally);
    const e = homeOf(enemy);
    if (a) this._allyBasePos = new THREE.Vector3(a.x, a.y, a.z);
    if (e) this._enemyBasePos = new THREE.Vector3(e.x, e.y, e.z);
    this._objective = null; // 死斗 has no objective marker

    return this._spawnPoints;
  };

  /** Neutral zones are not in _spawnPoints — the respawn picker sets them here. */
  VoxelWorld.prototype.setTdmSpawnOverride = function (zone) {
    this._tdmSpawnOverride = zone || null;
    return this._tdmSpawnOverride;
  };

  VoxelWorld.prototype.getTdmSpawnZones = function () {
    return this._tdmSpawnZones || [];
  };

  /** Weighted flow-field targets for 死斗 AI — see _planTdmHotzones. */
  VoxelWorld.prototype.getTdmHotzones = function () {
    return this._tdmHotzones || [];
  };

  /**
   * 爆破 A/B plant sites. Two fixed anchors on opposite quadrants of the kit
   * arena, each snapped to open ground so a site never lands inside a building.
   * Cached per map; call planSdPlantSites() to recompute after a map change.
   * Site shape: { id:'A'|'B', x, z, y, r } — r is the plant/defuse radius.
   */
  VoxelWorld.prototype.getSdPlantSites = function () {
    if (this._sdPlantSites) return this._sdPlantSites;
    return this.planSdPlantSites();
  };

  VoxelWorld.prototype.planSdPlantSites = function () {
    const size = this.worldSize;
    const b = this._tdmArenaBounds;
    let anchors;
    if (b) {
      // Opposite flanks of the compact 爆破 arena. Spawns sit on the centre lane
      // at the top/bottom edges, so we keep the sites wide on x (far from the
      // centre-line spawns) but pull their z well toward mid-map — otherwise a
      // site hugs whichever home shares its edge and is a few steps from spawn.
      const ex = b.x1 - b.x0;
      const ez = b.z1 - b.z0;
      anchors = [
        { id: 'A', x: b.x0 + ex * 0.78, z: b.z0 + ez * 0.37 },
        { id: 'B', x: b.x0 + ex * 0.22, z: b.z0 + ez * 0.63 },
      ];
    } else {
      anchors = [
        { id: 'A', x: size * 0.72, z: size * 0.4 },
        { id: 'B', x: size * 0.3, z: size * 0.6 },
      ];
    }
    const out = [];
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const spot = this._findGroundColumn(a.x, a.z, 30) || this._findOpenColumn(a.x, a.z, 30) || a;
      out.push({
        id: a.id,
        x: spot.x,
        z: spot.z,
        y: spot.y != null ? spot.y : this.getWalkHeight(Math.floor(spot.x), Math.floor(spot.z)),
        r: 6,
      });
    }
    this._sdPlantSites = out;
    return out;
  };

  /**
   * Street-level standable column near (cx,cz) — used for 爆破 plant sites so a
   * site never lands on a rooftop. Unlike _findOpenColumn (which returns the
   * FIRST standable surface, and a building roof counts as standable), this
   * scans the disc, learns the lowest standable surface = the street level, then
   * returns the column closest to the anchor whose surface sits at that level.
   * Returns { x, z, y } (y is the standing surface) or null if none found.
   */
  VoxelWorld.prototype._findGroundColumn = function (cx, cz, maxR) {
    const size = this.worldSize;
    const clamp = (v) => Math.max(6, Math.min(size - 6, v));
    const self = this;
    const surfaceAt = function (fx, fz) {
      if (self._riverInfo) {
        const r = self._riverInfo(fx, fz);
        if (r && (r.inWater || r.bank)) return null;
      }
      const gy = self.getWalkHeight(fx, fz);
      if (self._isSolid(fx, gy, fz)) return null; // must be able to stand
      if (self._isSolid(fx, gy + 1, fz)) return null; // headroom
      return gy;
    };
    const bx = clamp(cx);
    const bz = clamp(cz);
    const cands = [];
    let minY = Infinity;
    for (let r = 0; r <= (maxR || 30); r += 2) {
      const steps = r === 0 ? 1 : 12;
      for (let a = 0; a < steps; a++) {
        const ang = (a / steps) * Math.PI * 2;
        const fx = Math.floor(clamp(bx + Math.cos(ang) * r));
        const fz = Math.floor(clamp(bz + Math.sin(ang) * r));
        const gy = surfaceAt(fx, fz);
        if (gy == null) continue;
        const dx = fx - bx;
        const dz = fz - bz;
        cands.push({ x: fx, z: fz, y: gy, d: dx * dx + dz * dz });
        if (gy < minY) minY = gy;
      }
    }
    if (!cands.length) return null;
    let best = null;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      if (c.y > minY + 2) continue; // skip rooftops / raised surfaces
      if (!best || c.d < best.d) best = c;
    }
    return best || cands[0];
  };

  /** Nearest standable, unobstructed column to (cx,cz); null if none in range. */
  VoxelWorld.prototype._findOpenColumn = function (cx, cz, maxR) {
    const size = this.worldSize;
    const clamp = (v) => Math.max(6, Math.min(size - 6, v));
    const self = this;
    const ok = function (x, z) {
      const fx = Math.floor(x);
      const fz = Math.floor(z);
      if (self._riverInfo) {
        const r = self._riverInfo(fx, fz);
        if (r && (r.inWater || r.bank)) return false;
      }
      const gy = self.getWalkHeight(fx, fz);
      if (self._isSolid(fx, gy, fz)) return false; // must be able to stand
      if (self._isSolid(fx, gy + 1, fz)) return false; // headroom
      return true;
    };
    const bx = clamp(cx);
    const bz = clamp(cz);
    if (ok(bx, bz)) return { x: bx, z: bz };
    for (let r = 2; r <= (maxR || 24); r += 2) {
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        const x = clamp(bx + Math.cos(ang) * r);
        const z = clamp(bz + Math.sin(ang) * r);
        if (ok(x, z)) return { x: x, z: z };
      }
    }
    return null;
  };

  /** True if (x,z) is inside a base footprint, gate corridor, or landmark yard */
  VoxelWorld.prototype._isBaseKeepClear = function (x, z, footprint) {
    const pad = footprint != null ? footprint : 18;
    const cx = x + pad / 2;
    const cz = z + pad / 2;

    const bases = this._plannedBases;
    if (bases) {
      const compoundR = 8;
      const corridorHalf = 18;
      const corridorLen = 50;
      for (let i = 0; i < bases.length; i++) {
        const b = bases[i];
        const gx = b.x;
        const gz = b.z;
        if (Math.abs(cx - gx) < compoundR && Math.abs(cz - gz) < compoundR) return true;
        if (b.gate === '+z') {
          if (Math.abs(cx - gx) <= corridorHalf && cz >= gz && cz <= gz + corridorLen) return true;
        } else if (b.gate === '-z') {
          if (Math.abs(cx - gx) <= corridorHalf && cz <= gz && cz >= gz - corridorLen) return true;
        }
      }
    }

    const marks = this._plannedLandmarks;
    if (marks) {
      for (let i = 0; i < marks.length; i++) {
        const m = marks[i];
        if (cx >= m.x - 6 && cx <= m.x + m.w + 6 && cz >= m.z - 6 && cz <= m.z + m.d + 6) {
          return true;
        }
      }
    }
    return false;
  };

  /** Flat street + canal — playable surface sits above SUB_LAYERS foundation */
  VoxelWorld.prototype._buildTerrain = function () {
    const size = this.worldSize;
    const STREET = 4 + SUB_LAYERS;
    const BANK = 3 + SUB_LAYERS;
    const WATER_Y = 1 + SUB_LAYERS;

    for (let x = 0; x < size; x++) {
      for (let z = 0; z < size; z++) {
        const n = this._noise(x * 0.12, z * 0.12);
        const n2 = this._noise2(x * 0.07, z * 0.07);
        const river = this._riverInfo(x, z);

        // 5 layers under the map: y=0 bedrock, y=1..4 stone
        this.set(x, 0, z, BLOCK.BEDROCK);
        for (let y = 1; y < SUB_LAYERS; y++) {
          this.set(x, y, z, BLOCK.STONE);
        }

        let gy = STREET;
        if (river.inWater) gy = WATER_Y;
        else if (river.bank) gy = BANK;

        this._setColumnGround(x, z, gy);

        if (river.inWater) {
          for (let y = SUB_LAYERS; y < WATER_Y; y++) {
            this.set(x, y, z, BLOCK.STONE);
          }
          this.set(x, WATER_Y, z, BLOCK.WATER);
          if (river.dist > river.width - 0.9) {
            this.set(x, WATER_Y + 1, z, BLOCK.CONCRETE);
            this.set(x, WATER_Y + 2, z, BLOCK.CONCRETE);
          }
          continue;
        }

        for (let y = SUB_LAYERS; y <= gy; y++) {
          let t = BLOCK.STONE;
          if (y === gy) {
            if (river.bank) t = n > 0.5 ? BLOCK.GRASS : BLOCK.DIRT;
            else if (n2 > 0.72) t = BLOCK.RUBBLE;
            else if (n2 > 0.45) t = BLOCK.CONCRETE;
            else if (n > 0.55) t = BLOCK.ASPHALT;
            else t = BLOCK.STONE;
          } else if (y === gy - 1) t = BLOCK.DIRT;
          this.set(x, y, z, t);
        }

        if (river.bank && n > 0.84) this.set(x, gy + 1, z, BLOCK.GRASS);
      }
    }
  };

  /**
   * Unbreakable bottom slab + rim: 10 blocks tall from world bottom (y=0..9).
   * Called last so later builds cannot remove the shell.
   */
  VoxelWorld.prototype._buildBedrockShell = function () {
    const size = this.worldSize;
    const rimTop = 9; // y=0..9 → 10 blocks from the bottom layer

    for (let x = 0; x < size; x++) {
      for (let z = 0; z < size; z++) {
        // Force bottom layer
        this.blocks[this.index(x, 0, z)] = BLOCK.BEDROCK;

        const onRim = x === 0 || z === 0 || x === size - 1 || z === size - 1;
        if (!onRim) continue;
        const top = Math.min(this.height - 1, rimTop);
        for (let y = 0; y <= top; y++) {
          this.blocks[this.index(x, y, z)] = BLOCK.BEDROCK;
        }
      }
    }
  };

  VoxelWorld.prototype._surface = function (x, z) {
    x = Math.floor(x);
    z = Math.floor(z);
    if (x < 0 || z < 0 || x >= this.worldSize || z >= this.worldSize) return 4 + SUB_LAYERS;
    return this.groundY[z * this.worldSize + x] || 4 + SUB_LAYERS;
  };

  VoxelWorld.prototype._buildRoadGrid = function () {
    const size = this.worldSize;
    const spacing = 40;
    for (let x = 0; x < size; x++) {
      for (let z = 0; z < size; z++) {
        if (this._riverInfo(x, z).inWater) continue;
        const onX = x % spacing < 8;
        const onZ = z % spacing < 8;
        if (!onX && !onZ) continue;
        const gy = this._surface(x, z);
        const center = (onX && x % spacing === 3) || (onZ && z % spacing === 3);
        this.set(x, gy, z, center ? BLOCK.ASPHALT : BLOCK.ROAD);
        for (let y = gy + 1; y <= gy + 2; y++) {
          const t = this.get(x, y, z);
          if (t === BLOCK.GRASS || t === BLOCK.RUBBLE) this.set(x, y, z, BLOCK.AIR);
        }
      }
    }
  };

  VoxelWorld.prototype._isRoad = function (x, z) {
    const cls = this._maskClassAt(x, z);
    if (cls === TERRAIN_ROAD) return true;
    if (cls === TERRAIN_WATER) return false;
    if (cls >= 0) return false;
    return x % 40 < 8 || z % 40 < 8;
  };

  VoxelWorld.prototype._buildDistricts = function () {
    const size = this.worldSize;
    const spacing = 36 + this._randInt(0, 6);

    for (let bx = 8; bx < size - 24; bx += spacing) {
      for (let bz = 8; bz < size - 24; bz += spacing) {
        const jx = this._randInt(-5, 6);
        const jz = this._randInt(-5, 6);
        const px = bx + 10 + jx;
        const pz = bz + 10 + jz;
        if (px < 6 || pz < 6 || px >= size - 28 || pz >= size - 28) continue;
        if (this._isBaseKeepClear(px, pz, 16)) continue;
        if (this._riverInfo(px + 8, pz + 8).inWater) continue;
        if (this._riverInfo(px + 8, pz + 8).bank && this._noise(px, pz) > 0.45) continue;

        const roll = this._noise(px * 0.31, pz * 0.29);
        const edge = Math.min(px, pz, size - px, size - pz) < 60;
        const skip = this._noise(pz * 0.17, px * 0.19) < 0.12; // occasional empty lot
        if (skip) continue;

        if (roll > 0.72 && edge) {
          this._placeSkyscraper(
            px,
            pz,
            12 + this._randInt(0, 10),
            32 + this._randInt(0, 36)
          );
        } else if (roll > 0.48) {
          this._placeMidrise(px, pz, 9 + this._randInt(0, 8), 14 + this._randInt(0, 18));
        } else if (roll > 0.24) {
          this._placeHouse(px, pz);
        } else if (roll > 0.1) {
          this._placeRuinStub(px, pz);
        }
      }
    }

    // Extra landmark towers — random corners each match (avoid bases / river / factories)
    const landmarkCount = 3 + this._randInt(0, 2);
    let placed = 0;
    let attempts = 0;
    while (placed < landmarkCount && attempts < 80) {
      attempts++;
      const lx = this._randInt(24, size - 56);
      const lz = this._randInt(24, size - 56);
      const lw = 14 + this._randInt(0, 6);
      if (this._isBaseKeepClear(lx, lz, lw)) continue;
      if (this._riverInfo(lx + 8, lz + 8).inWater) continue;
      if (this._riverInfo(lx + 8, lz + 8).bank) continue;
      this._placeSkyscraper(lx, lz, lw, 44 + this._randInt(0, 28));
      placed++;
    }
  };

  /**
   * Door opening + collidable panel on the front wall (z = oz).
   * Spec: 宽(厚度) 0.5 · 高 4 · 长 2 — one bullet destroys
   */
  VoxelWorld.prototype._isDoorCell = function (x, y, z, ox, oz, footprintW, wallY0) {
    const x0 = ox + Math.floor(footprintW / 2) - Math.floor(DOOR_LEN / 2);
    return z === oz && x >= x0 && x < x0 + DOOR_LEN && y >= wallY0 && y < wallY0 + DOOR_H;
  };

  VoxelWorld.prototype._doorX0 = function (ox, footprintW) {
    return ox + Math.floor(footprintW / 2) - Math.floor(DOOR_LEN / 2);
  };

  /** Register a collidable mesh prop (door / stair) */
  VoxelWorld.prototype.registerProp = function (prop) {
    this.props.push(prop);
    if (prop.mesh && !prop.mesh.parent) this.group.add(prop.mesh);
    return prop;
  };

  VoxelWorld.prototype.destroyProp = function (prop) {
    const i = this.props.indexOf(prop);
    if (i < 0) return false;
    this.props.splice(i, 1);
    if (prop.mesh) {
      if (prop.mesh.parent) prop.mesh.parent.remove(prop.mesh);
      if (prop.mesh.geometry) prop.mesh.geometry.dispose();
      if (prop.mesh.material) {
        if (Array.isArray(prop.mesh.material)) prop.mesh.material.forEach((m) => m.dispose());
        else prop.mesh.material.dispose();
      }
    }
    return true;
  };

  /** Destroy breakable door nearest to a world point (for PVP sync) */
  VoxelWorld.prototype.destroyDoorNear = function (x, y, z) {
    const px = Number(x);
    const py = Number(y);
    const pz = Number(z);
    let best = null;
    let bestD = 3.2;
    for (let i = 0; i < this.props.length; i++) {
      const p = this.props[i];
      if (!p || p.kind !== 'door' || !p.breakable) continue;
      let cx;
      let cy;
      let cz;
      if (p.box) {
        cx = (p.box.min.x + p.box.max.x) * 0.5;
        cy = (p.box.min.y + p.box.max.y) * 0.5;
        cz = (p.box.min.z + p.box.max.z) * 0.5;
      } else if (p.mesh) {
        cx = p.mesh.position.x;
        cy = p.mesh.position.y;
        cz = p.mesh.position.z;
      } else {
        continue;
      }
      const d = Math.sqrt((cx - px) * (cx - px) + (cy - py) * (cy - py) + (cz - pz) * (cz - pz));
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best) return false;
    return this.destroyProp(best);
  };

  VoxelWorld.prototype._addDoor = function (ox, oz, footprintW, wallY0) {
    const x0 = this._doorX0(ox, footprintW);

    for (let dx = 0; dx < DOOR_LEN; dx++) {
      for (let dy = 0; dy < DOOR_H; dy++) {
        this.set(x0 + dx, wallY0 + dy, oz, BLOCK.AIR);
      }
    }

    // Closed flush door — blocks passage until shot
    const mat = new THREE.MeshLambertMaterial({ color: 0x5a3a22 });
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(DOOR_LEN * 0.96, DOOR_H * 0.96, DOOR_THICK),
      mat
    );
    panel.position.set(x0 + DOOR_LEN / 2, wallY0 + DOOR_H / 2, oz + DOOR_THICK / 2);
    panel.name = 'Door';

    const box = new THREE.Box3(
      new THREE.Vector3(x0 + 0.02, wallY0, oz),
      new THREE.Vector3(x0 + DOOR_LEN - 0.02, wallY0 + DOOR_H, oz + DOOR_THICK)
    );

    this.registerProp({
      kind: 'door',
      mesh: panel,
      box: box,
      breakable: true,
    });
  };

  /** Solid platform so stairs never end in empty air */
  VoxelWorld.prototype._addStairLanding = function (cx, cz, y, radius) {
    const r = radius || 2;
    const ix = Math.floor(cx);
    const iz = Math.floor(cz);
    const iy = Math.floor(y);
    for (let x = ix - r; x <= ix + r; x++) {
      for (let z = iz - r; z <= iz + r; z++) {
        this.set(x, iy, z, BLOCK.METAL);
        // thin rim railing
        if (Math.abs(x - ix) === r || Math.abs(z - iz) === r) {
          this.set(x, iy + 1, z, BLOCK.METAL);
        }
      }
    }
  };

  /**
   * Climbable voxel switchback stairs (1-block rise).
   * Breakable by bullets via normal voxel break. Always ends on a landing.
   */
  VoxelWorld.prototype._addVoxelSwitchbackStairs = function (opts) {
    const w = opts.w || 2;
    const runLen = Math.max(3, opts.runLen || 4);
    let x = Math.floor(opts.x);
    let z = Math.floor(opts.z);
    let y = Math.floor(opts.yStart);
    const yEnd = Math.floor(opts.yEnd);
    let dz = 1;
    let stepsInRun = 0;
    let guard = 0;
    const mat = opts.block != null ? opts.block : BLOCK.CONCRETE;

    const zA = z - 1;
    const zB = z + runLen + 2;
    this._clearShaft(x - 1, Math.min(zA, zB), w + 2, Math.abs(zB - zA) + 3, y, yEnd + 1);

    while (y < yEnd && guard++ < 400) {
      for (let dx = 0; dx < w; dx++) {
        this.set(x + dx, y, z, mat);
        this.markStair(x + dx, y, z);
      }
      y += 1;
      z += dz;
      stepsInRun++;
      if (stepsInRun >= runLen) {
        for (let dx = -1; dx < w + 1; dx++) {
          for (let dz2 = -1; dz2 <= 1; dz2++) {
            this.set(x + dx, y - 1, z + dz2, mat);
            this.markStair(x + dx, y - 1, z + dz2);
          }
        }
        stepsInRun = 0;
        dz *= -1;
      }
    }
    this._addStairLanding(x + w / 2, z, yEnd, Math.max(2, Math.floor(w / 2) + 1));
  };

  /** Interior stairs — voxel switchback (replaces spiral mesh) */
  VoxelWorld.prototype._addSpiralStairs = function (opts) {
    const x = Math.floor((opts.cx != null ? opts.cx : 0) - 1);
    const z = Math.floor((opts.cz != null ? opts.cz : 0) - 2);
    this._addVoxelSwitchbackStairs({
      x: x,
      z: z,
      yStart: opts.yStart,
      yEnd: opts.yEnd,
      w: 2,
      runLen: 4,
      block: BLOCK.CONCRETE,
    });
  };

  VoxelWorld.prototype._addClimbStairs = function (opts) {
    const cx = opts.cx != null ? opts.cx : (opts.x || 0) + (opts.w || 2) / 2;
    const cz = opts.cz != null ? opts.cz : (opts.z || 0) + 2;
    this._addSpiralStairs({ cx: cx, cz: cz, yStart: opts.yStart, yEnd: opts.yEnd });
  };

  /** Exterior voxel stairs ending on a roof/bridge landing */
  VoxelWorld.prototype._addExteriorStairs = function (x, z, yStart, yEnd, stepW) {
    this._addVoxelSwitchbackStairs({
      x: Math.floor(x),
      z: Math.floor(z),
      yStart: yStart,
      yEnd: yEnd,
      w: stepW || 2,
      runLen: 5,
      block: BLOCK.STONE,
    });
  };

  VoxelWorld.prototype._clearShaft = function (sx, sz, sw, sd, y0, y1) {
    this.fill(sx, y0, sz, sx + sw - 1, y1, sz + sd - 1, BLOCK.AIR);
  };

  VoxelWorld.prototype._inShaft = function (x, z, shaft) {
    return (
      shaft &&
      x >= shaft.x &&
      x < shaft.x + shaft.w &&
      z >= shaft.z &&
      z < shaft.z + shaft.d
    );
  };

  /** Register a building footprint for AI (exterior spawn / no-enter) */
  VoxelWorld.prototype._registerBuilding = function (ox, oz, w, d) {
    const cx = ox + w * 0.5;
    const cz = oz + d * 0.5;
    const info = this._riverInfo(cx, cz);
    if (info.inWater) return null;
    // Left of river = ally (blue), right = enemy (red)
    const side = cx < info.centerX ? 'ally' : 'enemy';
    // Keep a dry margin from the canal
    if (info.dist < info.width + 6) return null;
    const b = {
      ox: ox,
      oz: oz,
      w: w,
      d: d,
      cx: cx,
      cz: cz,
      side: side,
    };
    this.buildings.push(b);
    return b;
  };

  VoxelWorld.prototype._placeHouse = function (ox, oz, wOpt, dOpt) {
    const w = wOpt != null ? wOpt : 14;
    const d = dOpt != null ? dOpt : 12;
    const gy = this._surface(ox + (w >> 1), oz + (d >> 1));
    if (this._riverInfo(ox + (w >> 1), oz + (d >> 1)).inWater) return;
    this._registerBuilding(ox, oz, w, d);
    const wallY0 = gy + 2;
    const wallTop = gy + 9;
    const shaft = { x: ox + w - 7, z: oz + 3, w: 5, d: 5 };

    this.fill(ox, gy, oz, ox + w - 1, gy + 1, oz + d - 1, BLOCK.BRICK);

    for (let y = wallY0; y <= wallTop; y++) {
      for (let x = ox; x < ox + w; x++) {
        for (let z = oz; z < oz + d; z++) {
          const wall = x === ox || x === ox + w - 1 || z === oz || z === oz + d - 1;
          if (!wall) continue;
          if (this._isDoorCell(x, y, z, ox, oz, w, wallY0)) continue;
          if (
            (x === ox || x === ox + w - 1) &&
            (z === oz + 4 || z === oz + 5) &&
            (y === gy + 5 || y === gy + 6)
          ) {
            if (this._noise(x, z + y) > 0.35) this.set(x, y, z, BLOCK.GLASS);
            continue;
          }
          if (y >= gy + 7 && this._noise(x + y, z) > 0.72) continue;
          this.set(x, y, z, this._noise(x, z) > 0.85 ? BLOCK.BRICK : BLOCK.PLASTER);
        }
      }
    }

    this.fill(ox + 1, gy + 2, oz + 1, ox + w - 2, gy + 2, oz + d - 2, BLOCK.ROOF);
    const roofY = gy + 10;
    this._clearShaft(shaft.x, shaft.z, shaft.w, shaft.d, wallY0, roofY + 2);
    this._addDoor(ox, oz, w, wallY0);

    for (let layer = 0; layer < 5; layer++) {
      const y = gy + 10 + layer;
      for (let x = ox + layer; x < ox + w - layer; x++) {
        for (let z = oz; z < oz + d; z++) {
          if (this._inShaft(x, z, shaft)) continue;
          if (this._noise(x, z + layer) > 0.88 && layer > 2) continue;
          this.set(x, y, z, BLOCK.ROOF);
        }
      }
    }

    this._addSpiralStairs({
      cx: shaft.x + shaft.w / 2,
      cz: shaft.z + shaft.d / 2,
      yStart: gy + 2,
      yEnd: roofY,
      color: 0x8a7354,
      radius: 2.2,
      landingR: 2,
    });
    this.rooftops.push({
      x: ox + w / 2,
      z: oz + d / 2,
      y: roofY + 1,
    });

    // Cauliflower smoke (~45% of houses) — readable skyline accents
    if (this._noise(ox * 1.7, oz * 1.3) > 0.55) {
      const sx = ox + 3 + Math.floor(this._noise(ox + 2, oz) * (w - 6));
      const sz = oz + 2 + Math.floor(this._noise(oz + 2, ox) * (d - 4));
      this._placeSmokeCloud(sx, roofY + 1, sz, ox + oz);
    }

    // Some houses get exterior stairs to the roof
    if (this._noise(ox, oz) > 0.55) {
      this._addExteriorStairs(ox + w, oz + 2, gy + 2, roofY, 2);
    }
  };

  /**
   * Solid voxel "cauliflower" smoke: narrow stem + overlapping blob lobes on top.
   * Compact silhouette for skyline atmosphere — not a chimney column.
   */
  VoxelWorld.prototype._placeSmokeCloud = function (cx, baseY, cz, seed) {
    cx = Math.floor(cx);
    cz = Math.floor(cz);
    baseY = Math.floor(baseY);
    seed = seed != null ? seed : cx + cz * 17;
    const n0 = this._noise(seed * 0.11, seed * 0.07);

    // Narrow stem (1–2 wide, 3–4 tall)
    const stemH = 3 + (n0 > 0.55 ? 1 : 0);
    const stemWide = n0 > 0.65;
    for (let y = 0; y < stemH; y++) {
      for (let dx = 0; dx <= (stemWide ? 1 : 0); dx++) {
        for (let dz = 0; dz <= (stemWide ? 1 : 0); dz++) {
          this._setSmoke(cx + dx, baseY + y, cz + dz, false);
        }
      }
    }

    const topY = baseY + stemH;
    // 5–8 overlapping spherical lobes (asymmetric cauliflower head)
    const lobeCount = 5 + Math.floor(this._noise(cx, cz + 3) * 4);
    for (let i = 0; i < lobeCount; i++) {
      const ni = this._noise(cx + i * 3.1, cz - i * 2.7);
      const nj = this._noise(cz + i * 1.9, cx - i * 2.3);
      const r = 1.8 + ni * 1.6; // ~1.8–3.4
      const ox = Math.floor((ni - 0.5) * 5.5);
      const oz = Math.floor((nj - 0.5) * 5.5);
      const oy = Math.floor(nj * 2.5 + (i < 2 ? 0 : 0.6));
      this._fillSmokeSphere(cx + ox, topY + oy, cz + oz, r, cx + cz + i);
    }
  };

  VoxelWorld.prototype._setSmoke = function (x, y, z, light) {
    if (x < 1 || z < 1 || x >= this.worldSize - 1 || z >= this.worldSize - 1) return;
    if (y < 1 || y >= this.height - 1) return;
    const cur = this.get(x, y, z);
    if (cur === BLOCK.BEDROCK || cur === BLOCK.WATER) return;
    if (cur !== BLOCK.AIR && cur !== BLOCK.SMOKE && cur !== BLOCK.SMOKE_LIGHT) {
      if (cur !== BLOCK.ROOF && cur !== BLOCK.RUBBLE) return;
    }
    this.set(x, y, z, light ? BLOCK.SMOKE_LIGHT : BLOCK.SMOKE);
  };

  VoxelWorld.prototype._fillSmokeSphere = function (cx, cy, cz, radius, seed) {
    const r = Math.max(1.5, radius);
    const r2 = r * r;
    const ri = Math.ceil(r);
    for (let dy = -ri; dy <= ri; dy++) {
      for (let dx = -ri; dx <= ri; dx++) {
        for (let dz = -ri; dz <= ri; dz++) {
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2) continue;
          // Carve gaps near the surface for a puffier silhouette
          if (d2 > r2 * 0.55) {
            const edge = this._noise(cx + dx * 0.7 + seed, cz + dz * 0.7 - seed);
            if (edge > 0.62) continue;
          }
          // Outer shell uses lighter smoke for sky contrast
          const light = d2 > r2 * 0.42;
          this._setSmoke(cx + dx, cy + dy, cz + dz, light);
        }
      }
    }
  };

  VoxelWorld.prototype._placeMidrise = function (ox, oz, footprint, floors) {
    const gy = this._surface(ox + 4, oz + 4);
    if (this._riverInfo(ox + 4, oz + 4).inWater) return;
    this._registerBuilding(ox, oz, footprint, footprint);
    const h = Math.min(this.height - 2, gy + floors);
    const mat = this._noise(ox, oz) > 0.5 ? BLOCK.CONCRETE : BLOCK.BRICK;
    const wallY0 = gy + 1;
    const shaft = { x: ox + footprint - 7, z: oz + 2, w: 5, d: 5 };
    const floorMod = 6;

    for (let y = gy + 1; y <= h; y++) {
      for (let x = ox; x < ox + footprint; x++) {
        for (let z = oz; z < oz + footprint; z++) {
          const wall =
            x === ox || x === ox + footprint - 1 || z === oz || z === oz + footprint - 1;
          const floor = (y - gy) % floorMod === 0;
          if (!wall && !floor) continue;
          if (this._isDoorCell(x, y, z, ox, oz, footprint, wallY0)) continue;
          if (this._inShaft(x, z, shaft) && floor) continue;
          if (y > h - 3 && this._noise(x * 0.4 + y, z * 0.4) > 0.5) continue;
          if (wall && !floor && (y - gy) % floorMod === 3 && this._noise(x, z + y) > 0.45) {
            this.set(x, y, z, BLOCK.GLASS);
            continue;
          }
          this.set(x, y, z, this._noise(x + y, z) > 0.82 ? BLOCK.RUST : mat);
        }
      }
    }

    this._clearShaft(shaft.x, shaft.z, shaft.w, shaft.d, wallY0, h);
    this._addDoor(ox, oz, footprint, wallY0);
    this._addSpiralStairs({
      cx: shaft.x + shaft.w / 2,
      cz: shaft.z + shaft.d / 2,
      yStart: gy + 1,
      yEnd: h,
      radius: 2.25,
      landingR: 2,
    });
    this.rooftops.push({
      x: ox + footprint / 2,
      z: oz + footprint / 2,
      y: h + 1,
    });

    if (this._noise(ox * 1.9, oz * 1.4) > 0.62) {
      this._placeSmokeCloud(
        ox + 2 + Math.floor(this._noise(ox, oz + 1) * (footprint - 4)),
        h + 1,
        oz + 2 + Math.floor(this._noise(oz, ox + 1) * (footprint - 4)),
        ox * 3 + oz
      );
    }

    if (this._noise(ox * 0.7, oz * 0.7) > 0.5) {
      this._addExteriorStairs(ox + footprint, oz + 3, gy + 1, h, 2);
    }
  };

  VoxelWorld.prototype._placeSkyscraper = function (ox, oz, footprint, floors) {
    const gy = this._surface(Math.floor(ox + footprint / 2), Math.floor(oz + footprint / 2));
    const cx = ox + Math.floor(footprint / 2);
    const cz = oz + Math.floor(footprint / 2);
    if (this._riverInfo(cx, cz).inWater) return;
    this._registerBuilding(ox, oz, footprint, footprint);

    const top = Math.min(this.height - 2, gy + floors);
    const dmgCorner = this._noise(ox, oz) > 0.5;
    const wallY0 = gy + 1;
    const shaft = { x: ox + footprint - 8, z: oz + 2, w: 6, d: 6 };
    const floorMod = 8;

    for (let y = gy + 1; y <= top; y++) {
      for (let x = ox; x < ox + footprint; x++) {
        for (let z = oz; z < oz + footprint; z++) {
          const wall =
            x === ox || x === ox + footprint - 1 || z === oz || z === oz + footprint - 1;
          const floorSlab = (y - gy) % floorMod === 0;
          const core = x >= cx - 2 && x <= cx + 2 && z >= cz - 2 && z <= cz + 2;
          if (!wall && !floorSlab && !core) continue;
          if (this._isDoorCell(x, y, z, ox, oz, footprint, wallY0)) continue;
          if (this._inShaft(x, z, shaft) && (floorSlab || core)) continue;

          const heightFrac = (y - gy) / Math.max(1, top - gy);
          if (heightFrac > 0.55 && this._noise(x * 0.25 + y * 0.1, z * 0.25) > 0.42) continue;
          if (dmgCorner && x > ox + footprint * 0.55 && y > gy + floors * 0.35 && this._noise(x, z + y) > 0.35) {
            continue;
          }

          let type = BLOCK.CONCRETE;
          if (core) type = BLOCK.METAL;
          else if (wall && (y - gy) % floorMod === 4) type = BLOCK.GLASS;
          else if (this._noise(x, z + y * 3) > 0.88) type = BLOCK.RUST;
          this.set(x, y, z, type);
        }
      }
    }

    this._clearShaft(shaft.x, shaft.z, shaft.w, shaft.d, wallY0, top);
    this._addDoor(ox, oz, footprint, wallY0);
    this._addSpiralStairs({
      cx: shaft.x + shaft.w / 2,
      cz: shaft.z + shaft.d / 2,
      yStart: gy + 1,
      yEnd: top,
      color: 0x5a6068,
      radius: 2.6,
      landingR: 3,
    });
    this.rooftops.push({
      x: ox + footprint / 2,
      z: oz + footprint / 2,
      y: top + 1,
    });

    if (this._noise(ox, oz + 3) > 0.48) {
      this._addExteriorStairs(ox + footprint, oz + 4, gy + 1, top, 2);
    }

    if (top < this.height - 4) this.fill(cx, top + 1, cz, cx, top + 3, cz, BLOCK.METAL);
  };

  VoxelWorld.prototype._placeRuinStub = function (ox, oz) {
    const gy = this._surface(ox + 4, oz + 4);
    if (this._riverInfo(ox + 4, oz + 4).inWater) return;
    const w = 8 + Math.floor(this._noise(ox, oz) * 6);
    this._registerBuilding(ox, oz, w, w);
    for (let x = ox; x < ox + w; x++) {
      for (let z = oz; z < oz + w; z++) {
        const h = 2 + Math.floor(this._noise(x, z) * 6);
        for (let y = gy + 1; y <= gy + h; y++) {
          if (this._noise(x + y, z) > 0.4) this.set(x, y, z, BLOCK.RUBBLE);
        }
      }
    }
  };

  VoxelWorld.prototype._buildElevatedHighways = function () {
    const size = this.worldSize;
    const deckY = 16;
    const halfW = 4;

    for (let x = 12; x < size - 12; x++) {
      const zc = Math.floor(size * 0.42 + Math.sin(x * 0.04) * 22 + Math.sin(x * 0.09) * 8);
      for (let dz = -halfW; dz <= halfW; dz++) {
        const z = zc + dz;
        if (z < 2 || z >= size - 2) continue;
        if (this._isBaseKeepClear(x, z, 0)) continue;
        this.set(x, deckY, z, Math.abs(dz) === halfW ? BLOCK.METAL : BLOCK.ASPHALT);
        if (Math.abs(dz) === halfW) this.set(x, deckY + 1, z, BLOCK.METAL);
      }
      // Side pillars (not center) — half density
      if (x % 28 === 0) {
        this._placeBridgePillar(x, zc - halfW, deckY);
        this._placeBridgePillar(x, zc + halfW, deckY);
      }
    }
  };

  /**
   * Support column under a bridge deck. Avoids planting in street lanes / water / bases.
   */
  VoxelWorld.prototype._placeBridgePillar = function (x, z, topY) {
    x = Math.floor(x);
    z = Math.floor(z);
    if (x < 2 || z < 2 || x >= this.worldSize - 2 || z >= this.worldSize - 2) return false;
    if (this._isBaseKeepClear(x, z, 0)) return false;

    let px = x;
    let pz = z;
    if (this._isRoad(px, pz) || this._riverInfo(px, pz).inWater) {
      const offsets = [
        [2, 0],
        [-2, 0],
        [0, 2],
        [0, -2],
        [3, 1],
        [-3, 1],
        [1, 3],
        [1, -3],
      ];
      let found = false;
      for (let i = 0; i < offsets.length; i++) {
        const ox = x + offsets[i][0];
        const oz = z + offsets[i][1];
        if (ox < 2 || oz < 2 || ox >= this.worldSize - 2 || oz >= this.worldSize - 2) continue;
        if (this._isBaseKeepClear(ox, oz, 0)) continue;
        if (this._isRoad(ox, oz) || this._riverInfo(ox, oz).inWater) continue;
        px = ox;
        pz = oz;
        found = true;
        break;
      }
      if (!found) return false;
    }

    const gy = this._surface(px, pz);
    for (let y = gy + 1; y < topY; y++) this.set(px, y, pz, BLOCK.CONCRETE);
    // Small footing (not on road)
    const foot = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (let i = 0; i < foot.length; i++) {
      const fx = px + foot[i][0];
      const fz = pz + foot[i][1];
      if (this._isRoad(fx, fz) || this._isBaseKeepClear(fx, fz, 0)) continue;
      if (this._riverInfo(fx, fz).inWater) continue;
      const fy = this._surface(fx, fz);
      this.set(fx, fy + 1, fz, BLOCK.CONCRETE);
    }
    return true;
  };

  /**
   * Curved high sky bridges — sine-bent decks with side pillars.
   * Also builds fixed base-link bridges (deterministic) for cross-map travel.
   */
  VoxelWorld.prototype._buildSkyBridges = function () {
    const size = this.worldSize;
    this.skyBridges = [];
    this.ziplines = this.ziplines || [];

    this._buildBaseLinkBridges();

    const spanCount = 2 + this._randInt(0, 1);
    const spans = [];
    for (let s = 0; s < spanCount; s++) {
      const axis = this._rand() > 0.5 ? 'x' : 'z';
      const margin = 28 + this._randInt(0, 24);
      spans.push({
        axis: axis,
        a0: margin,
        a1: size - margin,
        b: Math.floor(size * (0.22 + this._rand() * 0.56)),
        amp: 12 + this._rand() * 14,
        freq: 0.016 + this._rand() * 0.02,
        y: 24 + this._randInt(0, 12),
        halfW: this._rand() > 0.7 ? 3 : 2,
      });
    }

    for (let s = 0; s < spans.length; s++) {
      const br = spans[s];
      br.samples = [];
      this.skyBridges.push(br);

      for (let a = br.a0; a <= br.a1; a++) {
        const bend =
          Math.sin((a - br.a0) * br.freq) * br.amp +
          Math.sin((a - br.a0) * br.freq * 2.1 + 1.2) * (br.amp * 0.35);
        const bCenter = Math.floor(br.b + bend);

        for (let db = -br.halfW; db <= br.halfW; db++) {
          const x = br.axis === 'x' ? a : bCenter + db;
          const z = br.axis === 'z' ? a : bCenter + db;
          if (x < 2 || z < 2 || x >= size - 2 || z >= size - 2) continue;
          if (this._isBaseKeepClear(x, z, 0)) continue;

          this.set(x, br.y, z, Math.abs(db) === br.halfW ? BLOCK.METAL : BLOCK.ASPHALT);
          if (Math.abs(db) === br.halfW) this.set(x, br.y + 1, z, BLOCK.METAL);
        }

        // Side pillars under rail edges (half density)
        if (a % 32 === 0) {
          const xL = br.axis === 'x' ? a : bCenter - br.halfW;
          const zL = br.axis === 'z' ? a : bCenter - br.halfW;
          const xR = br.axis === 'x' ? a : bCenter + br.halfW;
          const zR = br.axis === 'z' ? a : bCenter + br.halfW;
          this._placeBridgePillar(xL, zL, br.y);
          this._placeBridgePillar(xR, zR, br.y);
        }

        if (a % 8 === 0) {
          const pt = this._bridgePointAt(br, a);
          if (pt) br.samples.push(pt);
        }
      }
    }

    this._buildZiplines();
  };

  /**
   * Fixed diagonal sky bridge linking both planned bases (shared by both teams).
   * Uses distance-to-segment fill so the deck is solid (no diamond gaps from diagonal flooring).
   */
  VoxelWorld.prototype._buildBaseLinkBridges = function () {
    const size = this.worldSize;
    const bases = this._plannedBases;
    if (!bases || bases.length < 2) return;

    const a = bases[0];
    const b = bases[1];
    const ax = a.x + (b.x - a.x) * 0.14;
    const az = a.z + (b.z - a.z) * 0.14;
    const bx = b.x + (a.x - b.x) * 0.14;
    const bz = b.z + (a.z - b.z) * 0.14;
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 8) return;
    const ux = dx / len;
    const uz = dz / len;
    const px = -uz;
    const pz = ux;
    const y = 28;
    const halfW = 2;

    const br = this._stampSolidDiagBridge(ax, az, bx, bz, y, halfW, px, pz);
    if (br) this.skyBridges.push(br);

    // Second parallel span
    const offset = 18;
    const br2 = this._stampSolidDiagBridge(
      ax + px * offset,
      az + pz * offset,
      bx + px * offset,
      bz + pz * offset,
      y,
      halfW,
      px,
      pz
    );
    if (br2) this.skyBridges.push(br2);
  };

  /**
   * Solid voxel deck along a diagonal segment (fills every cell within halfW of the line).
   */
  VoxelWorld.prototype._stampSolidDiagBridge = function (ax, az, bx, bz, y, halfW, px, pz) {
    const size = this.worldSize;
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 8) return null;
    const ux = dx / len;
    const uz = dz / len;
    // Prefer caller-supplied perpendicular; else derive
    if (px == null || pz == null) {
      px = -uz;
      pz = ux;
    }
    const steps = Math.ceil(len);
    const br = {
      fixed: true,
      axis: 'diag',
      a0: 0,
      a1: steps,
      y: y,
      halfW: halfW,
      amp: 0,
      freq: 0,
      b: 0,
      startX: ax,
      startZ: az,
      ux: ux,
      uz: uz,
      px: px,
      pz: pz,
      samples: [],
    };

    const pad = halfW + 3;
    const minX = Math.max(2, Math.floor(Math.min(ax, bx) - pad));
    const maxX = Math.min(size - 3, Math.ceil(Math.max(ax, bx) + pad));
    const minZ = Math.max(2, Math.floor(Math.min(az, bz) - pad));
    const maxZ = Math.min(size - 3, Math.ceil(Math.max(az, bz) + pad));
    const deckR = halfW + 0.55;
    const railInner = halfW - 0.4;

    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const wx = x + 0.5 - ax;
        const wz = z + 0.5 - az;
        const t = Math.max(0, Math.min(len, wx * ux + wz * uz));
        const cx = ax + ux * t;
        const cz = az + uz * t;
        const dist = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
        if (dist > deckR) continue;
        const isRail = dist >= railInner;
        this.set(x, y, z, isRail ? BLOCK.METAL : BLOCK.ASPHALT);
        if (isRail) this.set(x, y + 1, z, BLOCK.METAL);
      }
    }

    for (let i = 0; i <= steps; i += 28) {
      const cx = ax + ux * i;
      const cz = az + uz * i;
      this._placeBridgePillar(Math.floor(cx + px * halfW), Math.floor(cz + pz * halfW), y);
      this._placeBridgePillar(Math.floor(cx - px * halfW), Math.floor(cz - pz * halfW), y);
    }
    for (let i = 0; i <= steps; i += 8) {
      br.samples.push({ x: ax + ux * i, y: y + 1, z: az + uz * i, a: i });
    }
    return br;
  };

  VoxelWorld.prototype._bridgeBend = function (br, a) {
    if (br.axis === 'diag' || !br.amp) return 0;
    return (
      Math.sin((a - br.a0) * br.freq) * br.amp +
      Math.sin((a - br.a0) * br.freq * 2.1 + 1.2) * (br.amp * 0.35)
    );
  };

  VoxelWorld.prototype._bridgePointAt = function (br, a) {
    if (br.axis === 'diag') {
      return {
        x: br.startX + br.ux * a,
        y: br.y + 1,
        z: br.startZ + br.uz * a,
        a: a,
      };
    }
    const bend = this._bridgeBend(br, a);
    const bCenter = br.b + bend;
    if (br.axis === 'x') {
      return { x: a, y: br.y + 1, z: bCenter, a: a };
    }
    return { x: bCenter, y: br.y + 1, z: a, a: a };
  };

  /**
   * Point on the sky-bridge metal railing (edge), not deck center.
   * @param {number} side +1 / -1 — which rail
   */
  VoxelWorld.prototype._bridgeRailPointAt = function (br, a, side) {
    side = side >= 0 ? 1 : -1;
    const halfW = br.halfW != null ? br.halfW : 2;
    const y = br.y + 2;
    if (br.axis === 'diag') {
      return {
        x: br.startX + br.ux * a + br.px * side * halfW,
        y: y,
        z: br.startZ + br.uz * a + br.pz * side * halfW,
        a: a,
        side: side,
      };
    }
    const bend = this._bridgeBend(br, a);
    const bCenter = br.b + bend;
    if (br.axis === 'x') {
      return { x: a, y: y, z: bCenter + side * halfW, a: a, side: side };
    }
    return { x: bCenter + side * halfW, y: y, z: a, a: a, side: side };
  };

  /** Nearest point on any curved sky bridge to (x,z) */
  VoxelWorld.prototype._nearestBridgePoint = function (rx, rz, roofY) {
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < this.skyBridges.length; i++) {
      const br = this.skyBridges[i];
      for (let a = br.a0; a <= br.a1; a += 4) {
        const pt = this._bridgePointAt(br, a);
        const dist = Math.hypot(pt.x - rx, pt.z - rz) + Math.abs(pt.y - (roofY || pt.y)) * 0.4;
        if (dist < bestDist) {
          bestDist = dist;
          best = { br: br, point: pt, dist: dist };
        }
      }
    }
    return best;
  };

  /** Ground → bridge zip lines; upper end mounts on railing (not deck center) */
  VoxelWorld.prototype._buildZiplines = function () {
    this.ziplines = [];
    if (!this.skyBridges || !this.skyBridges.length) return;

    const matCable = new THREE.MeshLambertMaterial({ color: 0xc8c2b4 });
    const matPost = new THREE.MeshLambertMaterial({ color: 0x4a5560 });

    for (let i = 0; i < this.skyBridges.length; i++) {
      const br = this.skyBridges[i];
      const span = br.a1 - br.a0;
      const count = br.fixed ? 4 : 3 + (i % 2);
      for (let k = 0; k < count; k++) {
        const a = Math.floor(br.a0 + span * ((k + 1) / (count + 1)));
        const side = k % 2 === 0 ? 1 : -1;
        const top = this._bridgeRailPointAt(br, a, side);
        if (!top) continue;
        // Fixed bridges may mount near bases; skip keep-clear only for random bridges
        if (!br.fixed && this._isBaseKeepClear(top.x, top.z, 0)) continue;

        let gx;
        let gz;
        if (br.axis === 'diag') {
          gx = top.x + br.px * side * (10 + (k % 3) * 2);
          gz = top.z + br.pz * side * (10 + (k % 3) * 2);
        } else if (br.axis === 'x') {
          gx = top.x;
          gz = top.z + side * (8 + (k % 3) * 3);
        } else {
          gx = top.x + side * (8 + (k % 3) * 3);
          gz = top.z;
        }
        if (gx < 4 || gz < 4 || gx >= this.worldSize - 4 || gz >= this.worldSize - 4) continue;
        if (!br.fixed && this._isBaseKeepClear(gx, gz, 0)) continue;
        if (this._riverInfo(gx, gz).inWater) continue;
        if (this._isRoad(Math.floor(gx), Math.floor(gz))) continue;

        this._addZiplineStation(gx, gz, top, matCable, matPost, !!br.fixed);
      }
    }

    this._buildBaseApproachZiplines(matCable, matPost);
  };

  /** Walk along xz looking for a solid top near preferY (bridge deck). */
  VoxelWorld.prototype._findDeckLand = function (fromX, fromZ, dirX, dirZ, preferY) {
    const len = Math.hypot(dirX, dirZ) || 1;
    const ux = dirX / len;
    const uz = dirZ / len;
    for (let s = 0.4; s <= 5.6; s += 0.35) {
      const x = fromX + ux * s;
      const z = fromZ + uz * s;
      const ix = Math.floor(x);
      const iz = Math.floor(z);
      const yHi = Math.min(this.height - 1, Math.ceil(preferY) + 3);
      const yLo = Math.max(1, Math.floor(preferY) - 4);
      for (let y = yHi; y >= yLo; y--) {
        if (!this._isSolid(ix, y, iz)) continue;
        const top = y + 1;
        if (Math.abs(top - preferY) > 3.8) continue;
        return new THREE.Vector3(ix + 0.5, top, iz + 0.5);
      }
    }
    return null;
  };

  /** Place a rideable ground→rail zipline (shared by both teams).
   *  Mounts sit just OUTSIDE voxel faces so cable/posts never dig into solids. */
  VoxelWorld.prototype._addZiplineStation = function (gx, gz, top, matCable, matPost, keep) {
    const fx = Math.floor(gx);
    const fz = Math.floor(gz);
    const gy = this._surface(fx, fz) + 1;
    const inBldg = this.isInBuilding && this.isInBuilding(fx, fz, 1);

    // Floor plate only (no stacked metal pillars that swallow the mesh post)
    if (!inBldg) {
      this.set(fx, gy - 1, fz, BLOCK.METAL);
      this.set(fx, gy, fz, BLOCK.AIR);
      this.set(fx, gy + 1, fz, BLOCK.AIR);
      this.set(fx, gy + 2, fz, BLOCK.AIR);
    }

    // Cell centers (voxel midpoints)
    const startC = new THREE.Vector3(fx + 0.5, gy + 1.5, fz + 0.5);
    const endCx = top.x != null ? Number(top.x) : 0;
    const endCy = top.y != null ? Number(top.y) : 0;
    const endCz = top.z != null ? Number(top.z) : 0;
    const endC = new THREE.Vector3(endCx, endCy + 0.5, endCz);
    // Prefer explicit world mounts when caller already placed them on an outer edge
    let start;
    let end;
    if (top.mountOutside) {
      start = new THREE.Vector3(
        top.startX != null ? top.startX : fx + 0.5,
        top.startY != null ? top.startY : gy + 2.35,
        top.startZ != null ? top.startZ : fz + 0.5
      );
      end = new THREE.Vector3(top.x, top.y, top.z);
    } else {
      const along = endC.clone().sub(startC);
      const dist = along.length();
      if (dist < 0.2) {
        start = startC.clone();
        start.y = gy + 2.35;
        end = endC.clone();
        end.y += 0.55;
      } else {
        along.multiplyScalar(1 / dist);
        // Exit unit cube + clearance past the face
        const clear = 0.55;
        const exitT = function (d) {
          let t = Infinity;
          if (Math.abs(d.x) > 1e-6) t = Math.min(t, 0.5 / Math.abs(d.x));
          if (Math.abs(d.y) > 1e-6) t = Math.min(t, 0.5 / Math.abs(d.y));
          if (Math.abs(d.z) > 1e-6) t = Math.min(t, 0.5 / Math.abs(d.z));
          return (t === Infinity ? 0.5 : t) + clear;
        };
        const ta = Math.min(exitT(along), dist * 0.35);
        const tb = Math.min(exitT(along), dist * 0.35);
        start = new THREE.Vector3(
          startC.x + along.x * ta,
          gy + 2.35,
          startC.z + along.z * ta
        );
        end = new THREE.Vector3(
          endC.x - along.x * tb,
          endC.y + 0.55,
          endC.z - along.z * tb
        );
      }
    }

    const mid = start.clone().lerp(end, 0.5);
    const span = start.distanceTo(end);
    const cableLen = Math.max(0.2, span - 0.08);
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, cableLen, 6), matCable);
    cable.position.copy(mid);
    cable.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      end.clone().sub(start).normalize()
    );
    cable.name = 'ZiplineCable';
    this.group.add(cable);

    const alongN = end.clone().sub(start).normalize();
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.32, 2.2, 0.32), matPost);
    post.position.set(start.x - alongN.x * 0.12, gy + 1.1, start.z - alongN.z * 0.12);
    this.group.add(post);

    const topPost = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.28, 0.26), matPost);
    topPost.position.copy(end).addScaledVector(alongN, 0.12);
    this.group.add(topPost);

    // Ride/land points: cable may sit outside solids, but feet must land ON the deck.
    const alongXZ = new THREE.Vector3(end.x - start.x, 0, end.z - start.z);
    const spanXZ = alongXZ.length() || 1;
    alongXZ.multiplyScalar(1 / spanXZ);
    const preferDeckY = Math.max(start.y, end.y) - 0.55;
    let landHigh = this._findDeckLand(end.x, end.z, alongXZ.x, alongXZ.z, preferDeckY);
    if (!landHigh) {
      landHigh = new THREE.Vector3(
        end.x + alongXZ.x * 2.4,
        preferDeckY,
        end.z + alongXZ.z * 2.4
      );
      const lhx = Math.floor(landHigh.x);
      const lhz = Math.floor(landHigh.z);
      let deckTop = null;
      for (let y = Math.min(this.height - 1, Math.ceil(end.y) + 2); y >= 1; y--) {
        if (this._isSolid(lhx, y, lhz)) {
          deckTop = y + 1;
          break;
        }
      }
      if (deckTop != null && Math.abs(deckTop - preferDeckY) < 5) landHigh.y = deckTop;
      else landHigh.y = preferDeckY;
    }

    const landLow = new THREE.Vector3(
      start.x - alongXZ.x * 2.6,
      gy,
      start.z - alongXZ.z * 2.6
    );
    const lowSurf = this._surface(Math.floor(landLow.x), Math.floor(landLow.z));
    if (lowSurf != null) landLow.y = lowSurf + 1;

    this.ziplines.push({
      start: start,
      end: end,
      rideStart: start.clone(),
      rideEnd: new THREE.Vector3(landHigh.x, landHigh.y + 1.15, landHigh.z),
      landHigh: landHigh,
      landLow: landLow,
      cable: cable,
      keep: !!keep,
      fixed: !!keep,
    });
  };

  /** If ride data was wiped but cables remain, rebuild mount points from meshes. */
  VoxelWorld.prototype.ensureRideableZiplines = function () {
    this.ziplines = this.ziplines || [];
    if (this.ziplines.length) return this.ziplines;
    const found = [];
    const visit = (obj) => {
      if (!obj) return;
      const name = obj.name || '';
      if (name === 'ZiplineCable' || name === 'CustomZiplineCable') {
        obj.updateMatrixWorld(true);
        const mid = new THREE.Vector3();
        obj.getWorldPosition(mid);
        const q = new THREE.Quaternion();
        obj.getWorldQuaternion(q);
        const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
        const h =
          (obj.geometry && obj.geometry.parameters && obj.geometry.parameters.height) || 8;
        const half = Math.max(0.4, h * 0.5);
        const a = mid.clone().addScaledVector(dir, -half);
        const b = mid.clone().addScaledVector(dir, half);
        const low = a.y <= b.y ? a : b;
        const high = a.y <= b.y ? b : a;
        found.push({
          start: a,
          end: b,
          landLow: new THREE.Vector3(low.x, low.y - 1.2, low.z),
          landHigh: new THREE.Vector3(high.x, high.y - 0.55, high.z),
          cable: obj,
          recovered: true,
          keep: true,
        });
      }
      const kids = obj.children;
      if (!kids) return;
      for (let i = 0; i < kids.length; i++) visit(kids[i]);
    };
    if (this.group) visit(this.group);
    this.ziplines = found;
    return found;
  };

  /**
   * Extra ground stations near each base pointing at the nearest fixed-bridge rail,
   * so both teams can zip up without walking far from the compound.
   */
  VoxelWorld.prototype._buildBaseApproachZiplines = function (matCable, matPost) {
    const bases = this._plannedBases;
    if (!bases || !bases.length || !this.skyBridges) return;

    const fixed = this.skyBridges.filter((b) => b.fixed);
    if (!fixed.length) return;

    for (let bi = 0; bi < bases.length; bi++) {
      const base = bases[bi];
      const other = bases[1 - bi] || bases[0];
      const toOx = other.x - base.x;
      const toOz = other.z - base.z;
      const toLen = Math.hypot(toOx, toOz) || 1;
      const fx = toOx / toLen;
      const fz = toOz / toLen;

      for (let n = 0; n < 2; n++) {
        // Station just outside keep-clear, toward the bridge / enemy
        const dist = 34 + n * 6;
        const side = n === 0 ? 1 : -1;
        const gx = base.x + fx * dist + (-fz) * side * 8;
        const gz = base.z + fz * dist + fx * side * 8;
        if (gx < 4 || gz < 4 || gx >= this.worldSize - 4 || gz >= this.worldSize - 4) continue;
        if (this._riverInfo(gx, gz).inWater) continue;

        // Nearest rail point on any fixed bridge
        let bestTop = null;
        let bestD = Infinity;
        for (let fi = 0; fi < fixed.length; fi++) {
          const br = fixed[fi];
          for (let a = br.a0; a <= br.a1; a += 4) {
            for (let s = -1; s <= 1; s += 2) {
              const top = this._bridgeRailPointAt(br, a, s);
              const d = Math.hypot(top.x - gx, top.z - gz);
              if (d < bestD) {
                bestD = d;
                bestTop = top;
              }
            }
          }
        }
        if (!bestTop || bestD > 55) continue;
        this._addZiplineStation(gx, gz, bestTop, matCable, matPost, true);
      }
    }
  };

  /** Short spur from a rooftop onto the nearest curved sky bridge deck */
  VoxelWorld.prototype._linkToSkyBridge = function (rx, rz, roofY) {
    const hit = this._nearestBridgePoint(rx, rz, roofY);
    if (!hit || hit.dist > 42) return;

    const target = hit.point;
    const steps = Math.max(6, Math.ceil(Math.hypot(target.x - rx, target.z - rz)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = Math.floor(rx + (target.x - rx) * t);
      const z = Math.floor(rz + (target.z - rz) * t);
      const y = Math.floor(roofY + (target.y - 1 - roofY) * t);
      for (let d = -1; d <= 1; d++) {
        if (hit.br.axis === 'x') this.set(x + d, y, z, BLOCK.METAL);
        else if (hit.br.axis === 'diag') {
          this.set(x + d, y, z, BLOCK.METAL);
          this.set(x, y, z + d, BLOCK.METAL);
        } else this.set(x, y, z + d, BLOCK.METAL);
      }
    }
    if (Math.abs(target.y - 1 - roofY) > 1) {
      this._addExteriorStairs(
        Math.floor(rx) + 2,
        Math.floor(rz),
        Math.min(roofY, target.y - 1),
        Math.max(roofY, target.y - 1),
        2
      );
    }
  };

  /** Link nearby curved sky bridges with connector decks so they form a network */
  VoxelWorld.prototype._connectSkyBridges = function () {
    if (!this.skyBridges || this.skyBridges.length < 2) return;
    const size = this.worldSize;

    for (let i = 0; i < this.skyBridges.length; i++) {
      for (let j = i + 1; j < this.skyBridges.length; j++) {
        const a = this.skyBridges[i];
        const b = this.skyBridges[j];
        let best = null;
        let bestDist = Infinity;

        for (let aa = a.a0; aa <= a.a1; aa += 6) {
          const pa = this._bridgePointAt(a, aa);
          for (let bb = b.a0; bb <= b.a1; bb += 6) {
            const pb = this._bridgePointAt(b, bb);
            const d = Math.hypot(pa.x - pb.x, pa.z - pb.z);
            if (d < bestDist) {
              bestDist = d;
              best = { pa: pa, pb: pb };
            }
          }
        }

        if (!best || bestDist < 8 || bestDist > 70) continue;

        const steps = Math.max(8, Math.ceil(bestDist));
        const y0 = best.pa.y - 1;
        const y1 = best.pb.y - 1;
        for (let t = 0; t <= steps; t++) {
          const u = t / steps;
          const x = Math.floor(best.pa.x + (best.pb.x - best.pa.x) * u);
          const z = Math.floor(best.pa.z + (best.pb.z - best.pa.z) * u);
          // gentle horizontal arc
          const mid = Math.sin(u * Math.PI) * Math.min(6, bestDist * 0.12);
          const nx = -(best.pb.z - best.pa.z) / Math.max(1, bestDist);
          const nz = (best.pb.x - best.pa.x) / Math.max(1, bestDist);
          const xx = Math.floor(x + nx * mid);
          const zz = Math.floor(z + nz * mid);
          const y = Math.floor(y0 + (y1 - y0) * u);
          if (xx < 2 || zz < 2 || xx >= size - 2 || zz >= size - 2) continue;
          if (this._isBaseKeepClear(xx, zz, 0)) continue;
          for (let d = -2; d <= 2; d++) {
            this.set(xx + d, y, zz, Math.abs(d) === 2 ? BLOCK.METAL : BLOCK.ASPHALT);
            this.set(xx, y, zz + d, Math.abs(d) === 2 ? BLOCK.METAL : BLOCK.ASPHALT);
          }
          if (t % 10 === 0) {
            const gy = this._surface(xx, zz);
            for (let py = gy + 1; py < y; py++) this.set(xx, py, zz, BLOCK.CONCRETE);
          }
        }
      }
    }
  };

  /**
   * Large ruined factory landmarks (~4–6 house footprints).
   * Gray concrete, metal frame, blast holes, bay doors, yard clutter.
   */
  VoxelWorld.prototype._placeFactoryLandmarks = function () {
    const marks = this._plannedLandmarks;
    if (!marks) return;
    for (let i = 0; i < marks.length; i++) {
      this._placeFactory(marks[i].x, marks[i].z, marks[i].w, marks[i].d);
    }
  };

  VoxelWorld.prototype._placeFactory = function (ox, oz, w, d) {
    ox = Math.floor(ox);
    oz = Math.floor(oz);
    const gy = this._surface(ox + (w >> 1), oz + (d >> 1));
    if (this._riverInfo(ox + (w >> 1), oz + (d >> 1)).inWater) return;

    // Single-story warehouse shell (tall walls, no intermediate floors)
    const wallH = 10;
    const top = gy + wallH;

    // Plaza pad
    for (let x = ox - 4; x < ox + w + 4; x++) {
      for (let z = oz - 4; z < oz + d + 4; z++) {
        if (x < 0 || z < 0 || x >= this.worldSize || z >= this.worldSize) continue;
        this.set(x, gy, z, this._noise(x, z) > 0.55 ? BLOCK.ASPHALT : BLOCK.CONCRETE);
      }
    }

    // Clear interior volume (one open floor)
    this.fill(ox, gy + 1, oz, ox + w - 1, top + 2, oz + d - 1, BLOCK.AIR);

    // Outer walls only (no interior floor slabs)
    for (let y = gy + 1; y <= top; y++) {
      for (let x = ox; x < ox + w; x++) {
        for (let z = oz; z < oz + d; z++) {
          const wall =
            x === ox || x === ox + w - 1 || z === oz || z === oz + d - 1;
          if (!wall) continue;

          const rib = (x - ox) % 8 === 0 || (z - oz) % 8 === 0;

          // Large bay openings on long walls
          const bayZ = z === oz || z === oz + d - 1;
          const bay =
            bayZ &&
            x > ox + 8 &&
            x < ox + w - 8 &&
            (x - ox) % 16 > 3 &&
            (x - ox) % 16 < 12 &&
            y <= gy + 5;

          // Blast / ruin holes
          const hole =
            !rib &&
            this._noise(x * 0.2 + y * 0.15, z * 0.2) > 0.78 &&
            y > gy + 4 &&
            y < top - 2;

          if (bay || hole) continue;

          let type = BLOCK.CONCRETE;
          if (rib) type = BLOCK.METAL;
          else if ((y - gy) % 4 === 2) type = BLOCK.GLASS;
          else if (this._noise(x, z + y) > 0.9) type = BLOCK.RUST;
          this.set(x, y, z, type);
        }
      }
    }

    // Sparse interior pillars (not floors)
    for (let px = ox + 10; px < ox + w - 10; px += 14) {
      for (let pz = oz + 10; pz < oz + d - 10; pz += 12) {
        for (let y = gy + 1; y <= top; y++) {
          this.set(px, y, pz, BLOCK.METAL);
        }
      }
    }

    // Flat roof + railing
    for (let x = ox; x < ox + w; x++) {
      for (let z = oz; z < oz + d; z++) {
        this.set(x, top, z, BLOCK.METAL);
        const edge = x === ox || x === ox + w - 1 || z === oz || z === oz + d - 1;
        if (edge) this.set(x, top + 1, z, BLOCK.METAL);
      }
    }
    this.fill(ox + 6, top + 1, oz + 6, ox + 14, top + 3, oz + 12, BLOCK.METAL);
    this.fill(ox + w - 16, top + 1, oz + d - 14, ox + w - 8, top + 4, oz + d - 8, BLOCK.RUST);

    // One exterior stair to roof only (no multi-floor interior)
    this._addExteriorStairs(ox + w, oz + 8, gy + 1, top, 2);

    // Dense interior cover: crates, containers, walls, pipe stacks
    for (let i = 0; i < 55; i++) {
      const cx = ox + 3 + Math.floor(this._noise(ox + i * 4.3, oz + 1) * (w - 8));
      const cz = oz + 3 + Math.floor(this._noise(oz + i * 3.7, ox + 2) * (d - 8));
      const h = 1 + Math.floor(this._noise(cx + i, cz) * 3);
      const kind =
        this._noise(cx, cz + i) > 0.62
          ? BLOCK.METAL
          : this._noise(cx + 2, cz) > 0.45
            ? BLOCK.CONCRETE
            : BLOCK.ROOF;
      const bw = 1 + Math.floor(this._noise(cx, i * 1.1) * 3);
      const bd = 1 + Math.floor(this._noise(i * 1.3, cz) * 2);
      for (let dx = 0; dx < bw; dx++) {
        for (let dz = 0; dz < bd; dz++) {
          for (let dy = 0; dy < h; dy++) {
            const tx = cx + dx;
            const tz = cz + dz;
            if (tx <= ox || tx >= ox + w - 1 || tz <= oz || tz >= oz + d - 1) continue;
            this.set(tx, gy + 1 + dy, tz, kind);
          }
        }
      }
    }

    // Longer barricade rows (L / T cover shapes)
    for (let i = 0; i < 10; i++) {
      const bx = ox + 5 + Math.floor(this._noise(i * 7.1, oz) * (w - 14));
      const bz = oz + 5 + Math.floor(this._noise(ox, i * 5.3) * (d - 14));
      const len = 4 + Math.floor(this._noise(bx, bz) * 5);
      const horiz = this._noise(bx + i, bz) > 0.5;
      for (let k = 0; k < len; k++) {
        const x = horiz ? bx + k : bx;
        const z = horiz ? bz : bz + k;
        this.set(x, gy + 1, z, BLOCK.CONCRETE);
        this.set(x, gy + 2, z, BLOCK.CONCRETE);
        if (k === Math.floor(len / 2)) {
          // T-junction stub
          if (horiz) {
            this.set(x, gy + 1, z + 1, BLOCK.CONCRETE);
            this.set(x, gy + 2, z + 1, BLOCK.CONCRETE);
          } else {
            this.set(x + 1, gy + 1, z, BLOCK.CONCRETE);
            this.set(x + 1, gy + 2, z, BLOCK.CONCRETE);
          }
        }
      }
    }

    // Shipping containers inside as heavy cover
    for (let i = 0; i < 6; i++) {
      const cx = ox + 6 + (i % 3) * 16;
      const cz = oz + 6 + Math.floor(i / 3) * 14;
      this.fill(cx, gy + 1, cz, cx + 6, gy + 3, cz + 2, BLOCK.METAL);
    }

    // Yard clutter outside
    for (let i = 0; i < 22; i++) {
      const cx = ox - 3 + Math.floor(this._noise(ox + i * 3.1, oz) * (w + 6));
      const cz = oz - 3 + Math.floor(this._noise(oz + i * 2.7, ox) * (d + 6));
      if (cx > ox + 2 && cx < ox + w - 3 && cz > oz + 2 && cz < oz + d - 3) continue;
      const h = 1 + Math.floor(this._noise(cx, cz) * 3);
      const kind = this._noise(cx + i, cz) > 0.55 ? BLOCK.RUST : BLOCK.ROOF;
      const bw = 1 + Math.floor(this._noise(cx, i) * 2);
      const bd = 1 + Math.floor(this._noise(i, cz) * 3);
      for (let dx = 0; dx < bw; dx++) {
        for (let dz = 0; dz < bd; dz++) {
          for (let dy = 0; dy < h; dy++) {
            this.set(cx + dx, gy + 1 + dy, cz + dz, kind);
          }
        }
      }
    }
    for (let i = 0; i < 4; i++) {
      const cx = ox + 4 + i * 12;
      const cz = oz - 3;
      this.fill(cx, gy + 1, cz, cx + 5, gy + 3, cz + 2, BLOCK.METAL);
    }

    this.rooftops.push({ x: ox + w / 2, z: oz + d / 2, y: top + 2 });
    // Cauliflower smoke on factory roof (more often)
    if (this._noise(ox * 0.9, oz * 1.1) > 0.35) {
      this._placeSmokeCloud(ox + Math.floor(w * 0.35), top + 2, oz + Math.floor(d * 0.4), ox + oz);
    }
    // No bridge link — bridges stay separate from buildings
  };

  VoxelWorld.prototype._buildCanalBridges = function () {
    const size = this.worldSize;
    const spans = [48, 96, 144, 192];
    for (let i = 0; i < spans.length; i++) {
      const z = spans[i];
      if (z >= size - 8) continue;
      const info = this._riverInfo(size / 2, z);
      const x0 = Math.floor(info.centerX - info.width - 6);
      const x1 = Math.floor(info.centerX + info.width + 6);
      const by = 4;
      for (let x = x0; x <= x1; x++) {
        for (let dz = -2; dz <= 2; dz++) {
          this.set(x, by, z + dz, BLOCK.ASPHALT);
          if (Math.abs(dz) === 2) this.set(x, by + 1, z + dz, BLOCK.METAL);
        }
      }
      const mid = Math.floor(info.centerX);
      this.fill(mid, 2, z, mid, by - 1, z, BLOCK.CONCRETE);
      this.fill(mid - 6, 2, z, mid - 6, by - 1, z, BLOCK.CONCRETE);
      this.fill(mid + 6, 2, z, mid + 6, by - 1, z, BLOCK.CONCRETE);
    }
  };

  VoxelWorld.prototype._buildObjective = function () {
    // Legacy no-op — bases.js places ally/enemy cores
  };

  VoxelWorld.prototype.isInBuilding = function (x, z, margin) {
    margin = margin != null ? margin : 0;
    const list = this.buildings || [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (
        x >= b.ox - margin &&
        x < b.ox + b.w + margin &&
        z >= b.oz - margin &&
        z < b.oz + b.d + margin
      ) {
        return true;
      }
    }
    return false;
  };

  VoxelWorld.prototype.getSpawnPosition = function () {
    const resolve = (sx, sy, sz) => {
      if (!this.isInBuilding || !this.isInBuilding(sx, sz, 2)) {
        return new THREE.Vector3(sx, sy, sz);
      }
      // Nudge out of building footprint
      for (let r = 2; r <= 24; r += 2) {
        for (let a = 0; a < 12; a++) {
          const ang = (a / 12) * Math.PI * 2;
          const x = sx + Math.cos(ang) * r;
          const z = sz + Math.sin(ang) * r;
          if (this.isInBuilding(x, z, 2)) continue;
          if (this._riverInfo && this._riverInfo(x, z).inWater) continue;
          let y = this.height - 1;
          while (y > 0 && !this._isSolid(Math.floor(x), y, Math.floor(z))) y--;
          return new THREE.Vector3(x, y + 1.05, z);
        }
      }
      return new THREE.Vector3(sx, sy, sz);
    };

    // TDM picks the spawn programmatically, including neutral zones that are
    // not part of either team's _spawnPoints list
    const forced = this._tdmSpawnOverride;
    if (forced) return resolve(forced.x, forced.y, forced.z);

    const sel = this.getSelectedSpawn && this.getSelectedSpawn();
    if (sel) return resolve(sel.x, sel.y, sel.z);

    const team = this._playerTeam || 'ally';
    if (this._spawnPoints && this._spawnPoints[team] && this._spawnPoints[team].length) {
      const s = this._spawnPoints[team][0];
      return resolve(s.x, s.y, s.z);
    }
    if (this._spawnPoints && this._spawnPoints.ally && this._spawnPoints.ally.length) {
      const s = this._spawnPoints.ally[0];
      return resolve(s.x, s.y, s.z);
    }
    // No kit spawn crystals yet — stand next to own core crystal
    if (this._allyBasePos && team === 'ally') {
      const p = this._allyBasePos;
      return resolve(p.x + 2.5, p.y + 1.05, p.z + 2.5);
    }
    if (this._enemyBasePos && team === 'enemy') {
      const p = this._enemyBasePos;
      return resolve(p.x - 2.5, p.y + 1.05, p.z - 2.5);
    }
    if (this._allyBasePos) {
      const p = this._allyBasePos;
      return resolve(p.x + 2.5, p.y + 1.05, p.z + 2.5);
    }
    const obj = this.getCenter();
    const x = obj.x - 10;
    const z = obj.z + 8;
    let y = this.height - 1;
    while (y > 0 && !this._isSolid(Math.floor(x), y, Math.floor(z))) y--;
    return resolve(x + 0.5, y + 1.05, z + 0.5);
  };

  VoxelWorld.prototype.getSelectedSpawn = function () {
    if (!this._spawnPoints || !this._spawnPoints.all) return null;
    const id = this._selectedSpawnId;
    if (!id) return null;
    for (let i = 0; i < this._spawnPoints.all.length; i++) {
      const s = this._spawnPoints.all[i];
      if (s.id === id) {
        if (this._playerTeam && s.team !== this._playerTeam) return null;
        return s;
      }
    }
    return null;
  };

  VoxelWorld.prototype.setPlayerTeam = function (team) {
    if (team !== 'ally' && team !== 'enemy') return null;
    this._playerTeam = team;
    const list = this._spawnPoints && this._spawnPoints[team];
    if (list && list.length) {
      const cur = this.getSelectedSpawn();
      if (!cur || cur.team !== team) {
        this._selectedSpawnId = list[Math.min(1, list.length - 1)].id;
      }
    } else {
      this._selectedSpawnId = null;
    }
    return team;
  };

  VoxelWorld.prototype.setSelectedSpawn = function (id) {
    if (!this._spawnPoints || !this._spawnPoints.all) return null;
    for (let i = 0; i < this._spawnPoints.all.length; i++) {
      const s = this._spawnPoints.all[i];
      if (s.id === id) {
        if (this._playerTeam && s.team !== this._playerTeam) return null;
        this._selectedSpawnId = id;
        return s;
      }
    }
    return null;
  };

  VoxelWorld.prototype.getCenter = function () {
    // Compass / objective toward the opposing crystal
    const team = this._playerTeam || 'ally';
    const targetPos =
      team === 'enemy' ? this._allyBasePos : this._enemyBasePos;
    if (targetPos) {
      return targetPos.clone().add(new THREE.Vector3(0, 7, 0));
    }
    if (this._objective) return this._objective.clone();
    return new THREE.Vector3(this.worldSize / 2 + 12, 8, this.worldSize / 2);
  };

  VoxelWorld.prototype._scatterDebris = function () {
    const size = this.worldSize;
    const count = 280 + this._randInt(0, 160);
    for (let i = 0; i < count; i++) {
      const x = 2 + Math.floor(this._noise(i * 3.1, 9 + i * 0.01) * (size - 4));
      const z = 2 + Math.floor(this._noise(i * 5.7, 2 + i * 0.02) * (size - 4));
      if (this._riverInfo(x, z).inWater) continue;
      if (this._isBaseKeepClear(x, z, 0)) continue;
      if (this._isRoad(x, z) && this._noise(x, z) > 0.25) continue;
      const gy = this._surface(x, z);
      if (this._noise(x + i, z) > 0.45) {
        this.set(x, gy, z, this._noise(x, z) > 0.5 ? BLOCK.RUBBLE : BLOCK.ASPHALT);
      }
    }
  };

  VoxelWorld.prototype._isSolid = function (x, y, z) {
    const t = this.get(x, y, z);
    return (
      t !== BLOCK.AIR &&
      t !== BLOCK.WATER &&
      t !== BLOCK.GLASS &&
      t !== BLOCK.SMOKE &&
      t !== BLOCK.SMOKE_LIGHT
    );
  };

  /**
   * Natural 1m terrain fill (and flattened pads) at/below groundY.
   * These cubes are rendered far away; collision uses the 10cm heightfield.
   * Copied from voxel-frontline-battle.
   */
  VoxelWorld.prototype._isTerrainFill = function (x, y, z) {
    if (y < 0) return false;
    // PORT: player-placed cells stay breakable even at/below groundY.
    if (this.isManmade && this.isManmade(x, y, z)) return false;
    const size = this.worldSize;
    if (x <= 0 || z <= 0 || x >= size - 1 || z >= size - 1) {
      if (this.get(x, y, z) === BLOCK.BEDROCK) return false;
    }
    const gy = this.groundY ? this.groundY[z * size + x] : 0;
    if (y > gy) return false;
    const t = this.get(x, y, z);
    if (t === BLOCK.AIR || t === BLOCK.WATER) return false;
    return this._isSolid(x, y, z);
  };

  VoxelWorld.prototype._isStructureSolid = function (x, y, z) {
    return this._isSolid(x, y, z) && !this._isTerrainFill(x, y, z);
  };

  /**
   * Rebuild chunk meshes.
   * progressive: mesh near bases/center/highway first; queue the rest for flushRebuilds.
   */
  VoxelWorld.prototype._rebuildAllChunks = function (opts) {
    opts = opts || {};
    const progressive = !!opts.progressive;
    const syncRadius = opts.syncRadius != null ? opts.syncRadius : 6;

    const centers = [];
    if (this._plannedBases) {
      for (let i = 0; i < this._plannedBases.length; i++) {
        const b = this._plannedBases[i];
        centers.push({
          cx: Math.floor(b.x / this.chunkSize),
          cz: Math.floor(b.z / this.chunkSize),
        });
      }
    }
    centers.push({
      cx: Math.floor(this.worldChunks * 0.5),
      cz: Math.floor(this.worldChunks * 0.5),
    });
    // Elevated highway corridor (~z = worldSize * 0.42)
    const hwyZ = Math.floor((this.worldSize * 0.42) / this.chunkSize);
    for (let cx = 0; cx < this.worldChunks; cx += 2) {
      centers.push({ cx: cx, cz: hwyZ });
    }

    this._dirtyChunks.clear();
    if (this._lodDirtyChunks) this._lodDirtyChunks.clear();
    else this._lodDirtyChunks = new Set();

    for (let cx = 0; cx < this.worldChunks; cx++) {
      for (let cz = 0; cz < this.worldChunks; cz++) {
        let near = !progressive;
        if (progressive) {
          for (let i = 0; i < centers.length; i++) {
            const dx = cx - centers[i].cx;
            const dz = cz - centers[i].cz;
            if (dx * dx + dz * dz <= syncRadius * syncRadius) {
              near = true;
              break;
            }
          }
        }
        if (near) this._rebuildChunk(cx, cz);
        else this._dirtyChunks.add(cx + ',' + cz);
      }
    }
  };

  /** Immediately mesh chunks around a world position (spawn / teleport). */
  VoxelWorld.prototype.ensureMeshedAround = function (wx, wz, radiusChunks) {
    radiusChunks = radiusChunks != null ? radiusChunks : 7;
    const cx0 = Math.floor(wx / this.chunkSize);
    const cz0 = Math.floor(wz / this.chunkSize);
    const r2 = radiusChunks * radiusChunks;
    for (let cx = cx0 - radiusChunks; cx <= cx0 + radiusChunks; cx++) {
      for (let cz = cz0 - radiusChunks; cz <= cz0 + radiusChunks; cz++) {
        if (cx < 0 || cz < 0 || cx >= this.worldChunks || cz >= this.worldChunks) continue;
        const dx = cx - cx0;
        const dz = cz - cz0;
        if (dx * dx + dz * dz > r2) continue;
        const key = this._chunkKey(cx, cz);
        const mesh = this.chunkMeshes.get(key);
        if (!mesh) {
          this._markChunkDirty(cx, cz, 'content');
          continue;
        }
        const c = mesh.userData && mesh.userData.chunk;
        const lod = this._chunkTerrainLod ? this._chunkTerrainLod(cx, cz, c && c.lod) : 1;
        if (c && c.lod !== lod) this._markChunkDirty(cx, cz, 'lod');
        this._dirtyChunks.delete(key);
        if (this._lodDirtyChunks) this._lodDirtyChunks.delete(key);
        this._rebuildChunk(cx, cz);
      }
    }
  };

  VoxelWorld.prototype._chunkKey = function (cx, cz) {
    return cx + ',' + cz;
  };

  /** Single opaque mesh per chunk — much cheaper than glass/water split passes */
  VoxelWorld.prototype._disposeChunkMesh = function (old) {
    if (!old) return;
    this.group.remove(old);
    old.traverse(function (node) {
      if (node.geometry) node.geometry.dispose();
    });
  };

  VoxelWorld.prototype._rebuildChunk = function (cx, cz) {
    const key = this._chunkKey(cx, cz);
    const old = this.chunkMeshes.get(key);
    const oldChunk = old && old.userData && old.userData.chunk;
    const oldLod = oldChunk ? oldChunk.lod : null;
    this._disposeChunkMesh(old);
    this.chunkMeshes.delete(key);

    const lod = this._chunkTerrainLod ? this._chunkTerrainLod(cx, cz, oldLod) : 1;
    let terrainMesh = null;
    if (this._buildTerrainChunkMesh) {
      try {
        const candidate = this._buildTerrainChunkMesh(cx, cz, lod);
        let terrainVertices = 0;
        if (candidate && candidate.traverse) {
          candidate.traverse(function (node) {
            const pos =
              node.geometry &&
              node.geometry.getAttribute &&
              node.geometry.getAttribute('position');
            if (pos) terrainVertices += pos.count;
          });
        }
        if (candidate && terrainVertices > 0) {
          terrainMesh = candidate;
        } else if (candidate && candidate.traverse) {
          candidate.traverse(function (node) {
            if (node.geometry) node.geometry.dispose();
          });
        }
      } catch (err) {
        if (!this._terrainMeshErrorLogged) {
          this._terrainMeshErrorLogged = true;
          console.error('[Terrain] heightfield mesh failed; using 1m voxel fallback', err);
        }
      }
    }
    // Never hide natural fill until a valid replacement mesh actually exists.
    const skipFill = !!terrainMesh;

    const positions = [];
    const normals = [];
    const colors = [];
    const indices = [];
    let vi = 0;

    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;

    const faces = [
      { n: [0, 1, 0], d: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], ox: 0, oy: 1, oz: 0 },
      { n: [0, -1, 0], d: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], ox: 0, oy: -1, oz: 0 },
      { n: [1, 0, 0], d: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], ox: 1, oy: 0, oz: 0 },
      { n: [-1, 0, 0], d: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], ox: -1, oy: 0, oz: 0 },
      { n: [0, 0, 1], d: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], ox: 0, oy: 0, oz: 1 },
      { n: [0, 0, -1], d: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], ox: 0, oy: 0, oz: -1 },
    ];

    if (!this._colorScratch) this._colorScratch = new THREE.Color();

    const blocks = this.blocks;
    const size = this.worldSize;
    const h = this.height;
    const air = BLOCK.AIR;
    const water = BLOCK.WATER;

    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const x = x0 + lx;
        const z = z0 + lz;
        // Skip empty sky: find top solid once (from top)
        let yMax = -1;
        for (let y = h - 1; y >= 0; y--) {
          if (blocks[(y * size + z) * size + x] !== air) {
            yMax = y;
            break;
          }
        }
        if (yMax < 0) continue;

        for (let y = 0; y <= yMax; y++) {
          const type = blocks[(y * size + z) * size + x];
          if (type === air) continue;
          if (skipFill && this._isTerrainFill(x, y, z)) continue;

          const hex = COLORS[type] || 0xffffff;
          let base = this._colorCache[hex];
          if (!base) {
            base = new THREE.Color(hex);
            this._colorCache[hex] = base;
          }
          const tint = 0.88 + this._noise(x, z + y) * 0.2;
          const col = this._colorScratch.copy(base).multiplyScalar(tint);

          for (let f = 0; f < faces.length; f++) {
            const face = faces[f];
            const nx = x + face.ox;
            const ny = y + face.oy;
            const nz = z + face.oz;
            let neighbor = air;
            if (nx >= 0 && ny >= 0 && nz >= 0 && nx < size && ny < h && nz < size) {
              neighbor = blocks[(ny * size + nz) * size + nx];
            }
            if (skipFill && neighbor !== air && neighbor !== water && this._isTerrainFill(nx, ny, nz)) {
              neighbor = air;
            }
            if (neighbor !== air && neighbor !== water) continue;
            if (type === water && neighbor === water) continue;
            if (type === water && neighbor === air && face.oy !== 1) continue;

            for (let v = 0; v < 4; v++) {
              const d = face.d[v];
              positions.push(x + d[0], y + d[1], z + d[2]);
              normals.push(face.n[0], face.n[1], face.n[2]);
              const shade = 0.86 + 0.14 * Math.max(0, face.n[1]);
              colors.push(col.r * shade, col.g * shade, col.b * shade);
            }
            indices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
            vi += 4;
          }
        }
      }
    }

    let voxelMesh = null;
    if (positions.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geo.setIndex(indices);
      geo.computeBoundingSphere();
      voxelMesh = new THREE.Mesh(geo, this._chunkMat);
      voxelMesh.castShadow = false;
      voxelMesh.receiveShadow = false;
    }

    if (!voxelMesh && !terrainMesh) return;

    let root = voxelMesh || terrainMesh;
    if (voxelMesh && terrainMesh) {
      root = new THREE.Group();
      root.add(voxelMesh);
      root.add(terrainMesh);
    }
    root.userData.chunk = { cx: cx, cz: cz, lod: lod };
    this.group.add(root);
    this.chunkMeshes.set(key, root);
  };

  VoxelWorld.prototype._markChunkDirty = function (cx, cz, reason) {
    if (cx < 0 || cz < 0 || cx >= this.worldChunks || cz >= this.worldChunks) return;
    const key = cx + ',' + cz;
    if (!this._lodDirtyChunks) this._lodDirtyChunks = new Set();
    if (reason === 'lod') {
      if (!this._dirtyChunks.has(key)) this._lodDirtyChunks.add(key);
      return;
    }
    this._lodDirtyChunks.delete(key);
    this._dirtyChunks.add(key);
  };

  /** Rebuild dirty chunks; prefer those nearest to (preferX, preferZ) when given */
  VoxelWorld.prototype.flushRebuilds = function (maxPerFrame, preferX, preferZ) {
    maxPerFrame = maxPerFrame != null ? maxPerFrame : 2;
    const lodSize = this._lodDirtyChunks ? this._lodDirtyChunks.size : 0;
    if (!this._dirtyChunks.size && !lodSize) return;
    if (this._dirtyChunks.size > 80) maxPerFrame = Math.max(maxPerFrame, 12);
    else if (this._dirtyChunks.size > 30) maxPerFrame = Math.max(maxPerFrame, 8);

    if (preferX != null && preferZ != null) {
      const cs = this.chunkSize;
      const list = [];
      this._dirtyChunks.forEach(function (key) {
        const parts = key.split(',');
        const cx = +parts[0];
        const cz = +parts[1];
        const mx = (cx + 0.5) * cs;
        const mz = (cz + 0.5) * cs;
        const dx = mx - preferX;
        const dz = mz - preferZ;
        list.push({ key: key, d: dx * dx + dz * dz, cx: cx, cz: cz });
      });
      list.sort(function (a, b) {
        return a.d - b.d;
      });
      const n = Math.min(maxPerFrame, list.length);
      for (let i = 0; i < n; i++) {
        this._dirtyChunks.delete(list[i].key);
        this._rebuildChunk(list[i].cx, list[i].cz);
      }
      this._flushLodRebuilds(maxPerFrame - n, preferX, preferZ);
      return;
    }

    let n = 0;
    const it = this._dirtyChunks.values();
    while (n < maxPerFrame) {
      const next = it.next();
      if (next.done) break;
      this._dirtyChunks.delete(next.value);
      const parts = next.value.split(',');
      this._rebuildChunk(+parts[0], +parts[1]);
      n++;
    }
    this._flushLodRebuilds(maxPerFrame - n, preferX, preferZ);
  };

  VoxelWorld.prototype._flushLodRebuilds = function (budget, preferX, preferZ) {
    if (!(budget > 0) || !this._lodDirtyChunks || !this._lodDirtyChunks.size) return;
    const set = this._lodDirtyChunks;
    let n = 0;
    let fineCount = 0;
    while (n < budget && set.size) {
      let key = null;
      if (preferX == null || preferZ == null || set.size < 2) {
        key = set.values().next().value;
      } else {
        let best = null;
        let bestD = Infinity;
        const cs = this.chunkSize;
        set.forEach(function (k) {
          const parts = k.split(',');
          const mx = (+parts[0] + 0.5) * cs;
          const mz = (+parts[1] + 0.5) * cs;
          const dx = mx - preferX;
          const dz = mz - preferZ;
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        });
        key = best;
      }
      if (!key) break;
      const parts = key.split(',');
      const cx = +parts[0];
      const cz = +parts[1];
      const currentMesh = this.chunkMeshes.get(key);
      const currentChunk = currentMesh && currentMesh.userData && currentMesh.userData.chunk;
      const nextLod = this._chunkTerrainLod
        ? this._chunkTerrainLod(cx, cz, currentChunk && currentChunk.lod)
        : 1;
      if (nextLod === 0.1 && fineCount >= 1) break;
      set.delete(key);
      this._rebuildChunk(cx, cz);
      if (nextLod === 0.1) fineCount++;
      n++;
    }
  };

  VoxelWorld.prototype.breakBlock = function (x, y, z) {
    x = Math.floor(x);
    y = Math.floor(y);
    z = Math.floor(z);
    const t = this.get(x, y, z);
    if (t === BLOCK.AIR || t === BLOCK.WATER || t === BLOCK.BEDROCK) {
      return false;
    }
    // Natural terrain is a 10cm heightfield. It may only change through
    // deformTerrainCircle/setTerrainTop so blocks, collision and LOD stay in sync.
    if (this._isTerrainFill && this._isTerrainFill(x, y, z)) return false;
    const key = x + ',' + y + ',' + z;
    if (!this._blockDurability) this._blockDurability = new Map();
    let left;
    if (this._blockDurability.has(key)) {
      left = this._blockDurability.get(key) - 1;
    } else {
      const base = BLOCK_HITS[t] != null ? BLOCK_HITS[t] : 1;
      left = base - 1;
    }
    if (left > 0) {
      this._blockDurability.set(key, left);
      return false;
    }
    this._blockDurability.delete(key);
    this.set(x, y, z, BLOCK.AIR);
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    this._markChunkDirty(cx, cz);
    if (x % CHUNK_SIZE === 0) this._markChunkDirty(cx - 1, cz);
    if (x % CHUNK_SIZE === CHUNK_SIZE - 1) this._markChunkDirty(cx + 1, cz);
    if (z % CHUNK_SIZE === 0) this._markChunkDirty(cx, cz - 1);
    if (z % CHUNK_SIZE === CHUNK_SIZE - 1) this._markChunkDirty(cx, cz + 1);
    return true;
  };

  /** Boolean overlap — no allocations (hot path for player / AI) */
  VoxelWorld.prototype.overlapsSolid = function (box) {
    const minX = Math.floor(box.min.x);
    const maxX = Math.floor(box.max.x);
    const minY = Math.floor(box.min.y);
    const maxY = Math.floor(box.max.y);
    const minZ = Math.floor(box.min.z);
    const maxZ = Math.floor(box.max.z);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          if (this._isStructureSolid(x, y, z)) return true;
        }
      }
    }
    const props = this.props;
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      if (p.box && box.intersectsBox(p.box)) return true;
    }
    if (
      !box.ignoreTerrain &&
      this._terrainOverlapsBox &&
      this._terrainOverlapsBox(box)
    ) {
      return true;
    }
    return false;
  };

  /**
   * Collect solid voxel/prop AABBs overlapping box.
   * Hits are pooled — valid only until the next collideAABB call.
   */
  VoxelWorld.prototype.collideAABB = function (box) {
    if (!this._hitPool) this._hitPool = [];
    const pool = this._hitPool;
    let n = 0;
    const minX = Math.floor(box.min.x);
    const maxX = Math.floor(box.max.x);
    const minY = Math.floor(box.min.y);
    const maxY = Math.floor(box.max.y);
    const minZ = Math.floor(box.min.z);
    const maxZ = Math.floor(box.max.z);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          if (this._isStructureSolid(x, y, z)) {
            let h = pool[n];
            if (!h) {
              h = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
              pool[n] = h;
            }
            h.min.set(x, y, z);
            h.max.set(x + 1, y + 1, z + 1);
            n++;
          }
        }
      }
    }
    const props = this.props;
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      if (p.box && box.intersectsBox(p.box)) {
        let h = pool[n];
        if (!h) {
          h = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
          pool[n] = h;
        }
        h.min.copy(p.box.min);
        h.max.copy(p.box.max);
        n++;
      }
    }
    if (this._appendTerrainHits) n = this._appendTerrainHits(box, pool, n);
    pool.length = n;
    return pool;
  };

  /** Hide chunks far from the camera to cut draw calls */
  VoxelWorld.prototype.updateChunkVisibility = function (camX, camZ, range) {
    range = range != null ? range : 96;
    this._lodCamX = camX;
    this._lodCamZ = camZ;
    const now = performance.now();
    const moved =
      this._lastVisibilityX == null ||
      Math.hypot(camX - this._lastVisibilityX, camZ - this._lastVisibilityZ) >= 2;
    if (!moved && now - this._lastVisibilityAt < 100) return;
    this._lastVisibilityX = camX;
    this._lastVisibilityZ = camZ;
    this._lastVisibilityAt = now;
    const rangeSq = range * range;
    const cs = this.chunkSize;
    const self = this;
    this.chunkMeshes.forEach(function (mesh) {
      const c = mesh.userData.chunk;
      if (!c) return;
      const mx = (c.cx + 0.5) * cs;
      const mz = (c.cz + 0.5) * cs;
      const dx = mx - camX;
      const dz = mz - camZ;
      mesh.visible = dx * dx + dz * dz < rangeSq;
      if (!self._chunkTerrainLod) return;
      const lod = self._chunkTerrainLod(c.cx, c.cz, c.lod);
      if (c.lod !== lod) self._markChunkDirty(c.cx, c.cz, 'lod');
    });
  };

  /** Ray vs AABB (slab). Returns distance or null. */
  VoxelWorld.prototype._rayBoxDist = function (origin, dir, box, maxDist) {
    let tmin = 0;
    let tmax = maxDist;
    for (let i = 0; i < 3; i++) {
      const axis = i === 0 ? 'x' : i === 1 ? 'y' : 'z';
      const o = origin[axis];
      const d = dir[axis];
      const min = box.min[axis];
      const max = box.max[axis];
      if (Math.abs(d) < 1e-8) {
        if (o < min || o > max) return null;
        continue;
      }
      let t1 = (min - o) / d;
      let t2 = (max - o) / d;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
    return tmin >= 0 ? tmin : null;
  };

  /** Closest breakable door along ray */
  VoxelWorld.prototype.raycastDoors = function (origin, dir, range) {
    let best = null;
    for (let i = 0; i < this.props.length; i++) {
      const p = this.props[i];
      if (!p.breakable || p.kind !== 'door' || !p.box) continue;
      const dist = this._rayBoxDist(origin, dir, p.box, range);
      if (dist == null) continue;
      if (!best || dist < best.dist) {
        best = {
          prop: p,
          dist: dist,
          point: origin.clone().addScaledVector(dir, dist),
        };
      }
    }
    return best;
  };

  /** Block LOS if a closed door sits on the sample point */
  VoxelWorld.prototype.propBlocksPoint = function (x, y, z) {
    const pt = this._propPt.set(x, y, z);
    for (let i = 0; i < this.props.length; i++) {
      const p = this.props[i];
      if (p.kind === 'door' && p.box && p.box.containsPoint(pt)) return true;
    }
    return false;
  };

  /** Highest walkable surface (structures + 10cm terrain + stair tops) at xz */
  VoxelWorld.prototype.getWalkHeight = function (x, z) {
    const fx = Math.floor(x);
    const fz = Math.floor(z);
    let best = this.getTerrainTop ? this.getTerrainTop(x, z) : 0;
    let y = this.height - 1;
    while (y > 4 && !this._isStructureSolid(fx, y, fz)) y -= 4;
    y = Math.min(this.height - 1, y + 4);
    while (y > 0 && !this._isStructureSolid(fx, y, fz)) y--;
    if (y > 0 && this._isStructureSolid(fx, y, fz)) {
      if (y + 1 > best) best = y + 1;
    }
    const props = this.props;
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      if (!p.box || (p.kind !== 'stair' && p.kind !== 'door')) continue;
      if (x >= p.box.min.x && x <= p.box.max.x && z >= p.box.min.z && z <= p.box.max.z) {
        if (p.box.max.y > best) best = p.box.max.y;
      }
    }
    return best;
  };

  const DEATH_STAIN_MAX = 1200;

  VoxelWorld.prototype._dirtyAroundBlock = function (x, z) {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    this._markChunkDirty(cx, cz);
    if (x % CHUNK_SIZE === 0) this._markChunkDirty(cx - 1, cz);
    if (x % CHUNK_SIZE === CHUNK_SIZE - 1) this._markChunkDirty(cx + 1, cz);
    if (z % CHUNK_SIZE === 0) this._markChunkDirty(cx, cz - 1);
    if (z % CHUNK_SIZE === CHUNK_SIZE - 1) this._markChunkDirty(cx, cz + 1);
  };

  /**
   * Paint / blood splat in a sphere — floors, walls, ceilings within range.
   * @param {number} wx
   * @param {number} wy torso / impact height
   * @param {number} wz
   * @param {string} team 'ally'|'blue'|'enemy'|'red'
   * @param {{x:number,y?:number,z:number}|null} [hitDir] mild stretch along impact
   */
  VoxelWorld.prototype.stampDeathStain = function (wx, wy, wz, team, hitDir) {
    const paint =
      team === 'ally' || team === 'blue' ? BLOCK.PAINT_BLUE : BLOCK.PAINT_RED;
    const cx = Math.floor(wx);
    const cy = Math.floor(wy);
    const cz = Math.floor(wz);

    let dx = hitDir && hitDir.x != null ? hitDir.x : 0;
    let dy = hitDir && hitDir.y != null ? hitDir.y : 0;
    let dz = hitDir && hitDir.z != null ? hitDir.z : 0;
    const len = Math.hypot(dx, dy, dz);
    if (len > 0.05) {
      dx /= len;
      dy /= len;
      dz /= len;
    } else {
      dx = 0;
      dy = 0;
      dz = 0;
    }

    const radius = 8.0 + Math.random() * 2.0; // ~16–20 diameter (+3 blocks vs prior)
    const r2 = radius * radius;
    const ri = Math.ceil(radius + 1);
    const hMax = this.height - 1;

    for (let oy = -ri; oy <= ri; oy++) {
      for (let oz = -ri; oz <= ri; oz++) {
        for (let ox = -ri; ox <= ri; ox++) {
          // Sphere with mild stretch along hit direction
          const along = ox * dx + oy * dy + oz * dz;
          const px = ox - dx * along * 0.35;
          const py = oy - dy * along * 0.35;
          const pz = oz - dz * along * 0.35;
          const d2 = px * px + py * py + pz * pz;
          if (d2 > r2) continue;
          if (d2 > r2 * 0.28 && Math.random() > 0.58) continue;
          if (d2 > r2 * 0.65 && Math.random() > 0.38) continue;

          const x = cx + ox;
          const y = cy + oy;
          const z = cz + oz;
          if (x < 1 || z < 1 || x >= this.worldSize - 1 || z >= this.worldSize - 1) continue;
          if (y < 1 || y > hMax) continue;

          const cur = this.get(x, y, z);
          if (
            cur === BLOCK.AIR ||
            cur === BLOCK.WATER ||
            cur === BLOCK.BEDROCK ||
            cur === BLOCK.METAL ||
            cur === BLOCK.GLASS ||
            cur === BLOCK.SMOKE ||
            cur === BLOCK.SMOKE_LIGHT
          ) {
            continue;
          }
          if (cur === paint) continue;

          // Surface only — walls / floors / ceilings facing air
          const exposed =
            this.get(x + 1, y, z) === BLOCK.AIR ||
            this.get(x - 1, y, z) === BLOCK.AIR ||
            this.get(x, y + 1, z) === BLOCK.AIR ||
            this.get(x, y - 1, z) === BLOCK.AIR ||
            this.get(x, y, z + 1) === BLOCK.AIR ||
            this.get(x, y, z - 1) === BLOCK.AIR;
          if (!exposed) continue;

          this._pushDeathStain(x, y, z, cur);
          this.set(x, y, z, paint);
          this._dirtyAroundBlock(x, z);
        }
      }
    }
  };

  VoxelWorld.prototype._pushDeathStain = function (x, y, z, prev) {
    if (!this._deathStains) this._deathStains = [];
    this._deathStains.push({ x: x, y: y, z: z, prev: prev });
    while (this._deathStains.length > DEATH_STAIN_MAX) {
      const old = this._deathStains.shift();
      if (!old) break;
      const t = this.get(old.x, old.y, old.z);
      if (t === BLOCK.PAINT_RED || t === BLOCK.PAINT_BLUE) {
        this.set(old.x, old.y, old.z, old.prev != null ? old.prev : BLOCK.RUBBLE);
        this._dirtyAroundBlock(old.x, old.z);
      }
    }
  };

  /**
   * Apply 40×40 (or NxN) semantic terrain mask: water / road / park / built / open.
   * Rewrites surface columns; sets this._terrainMask for _riverInfo / _isRoad.
   */
  VoxelWorld.prototype.applyTerrainMask = function (mask, opts) {
    opts = opts || {};
    if (!mask || !mask.data) {
      this._terrainMask = null;
      this._terrainMaskCells = 0;
      return false;
    }
    const CELLS = mask.cells || 40;
    const data = mask.data;
    if (!data.length || data.length < CELLS * CELLS) return false;

    this._terrainMaskCells = CELLS;
    this._terrainMask = new Uint8Array(CELLS * CELLS);
    for (let i = 0; i < CELLS * CELLS; i++) this._terrainMask[i] = data[i] | 0;

    const size = this.worldSize;
    const cellW = Math.floor(size / CELLS) || 8;
    const STREET = 4 + SUB_LAYERS;
    const BANK = 3 + SUB_LAYERS;
    const WATER_Y = 1 + SUB_LAYERS;
    const clearTop = Math.min(this.height - 1, 22);

    for (let gz = 0; gz < CELLS; gz++) {
      for (let gx = 0; gx < CELLS; gx++) {
        const cls = this._terrainMask[gz * CELLS + gx] | 0;
        for (let lz = 0; lz < cellW; lz++) {
          for (let lx = 0; lx < cellW; lx++) {
            const x = gx * cellW + lx;
            const z = gz * cellW + lz;
            if (x >= size || z >= size) continue;

            for (let y = SUB_LAYERS; y <= clearTop; y++) {
              const cur = this.get(x, y, z);
              if (cur !== BLOCK.BEDROCK) this.blocks[this.index(x, y, z)] = BLOCK.AIR;
            }
            this.blocks[this.index(x, 0, z)] = BLOCK.BEDROCK;
            for (let y = 1; y < SUB_LAYERS; y++) {
              this.blocks[this.index(x, y, z)] = BLOCK.STONE;
            }

            const n = this._noise(x * 0.12, z * 0.12);
            let gy = STREET;
            if (cls === TERRAIN_WATER) gy = WATER_Y;
            else if (cls === TERRAIN_PARK) gy = STREET + (n > 0.72 ? 1 : 0);

            // Soft bank next to water
            if (cls !== TERRAIN_WATER) {
              let nearW = false;
              for (let dz = -1; dz <= 1 && !nearW; dz++) {
                for (let dx = -1; dx <= 1; dx++) {
                  const nx = gx + dx;
                  const nz = gz + dz;
                  if (nx < 0 || nz < 0 || nx >= CELLS || nz >= CELLS) continue;
                  if ((this._terrainMask[nz * CELLS + nx] | 0) === TERRAIN_WATER) {
                    nearW = true;
                    break;
                  }
                }
              }
              if (nearW && cls !== TERRAIN_ROAD) gy = BANK;
            }

            this._setColumnGround(x, z, gy);

            if (cls === TERRAIN_WATER) {
              for (let y = SUB_LAYERS; y < WATER_Y; y++) {
                this.blocks[this.index(x, y, z)] = BLOCK.STONE;
              }
              this.blocks[this.index(x, WATER_Y, z)] = BLOCK.WATER;
              continue;
            }

            for (let y = SUB_LAYERS; y <= gy; y++) {
              let t = BLOCK.STONE;
              if (y === gy) {
                if (cls === TERRAIN_ROAD) {
                  t = lx === cellW >> 1 || lz === cellW >> 1 ? BLOCK.ASPHALT : BLOCK.ROAD;
                } else if (cls === TERRAIN_PARK) t = BLOCK.GRASS;
                else if (cls === TERRAIN_BUILT) t = BLOCK.CONCRETE;
                else t = n > 0.55 ? BLOCK.ASPHALT : BLOCK.DIRT;
              } else if (y === gy - 1) t = BLOCK.DIRT;
              this.blocks[this.index(x, y, z)] = t;
            }
            if (cls === TERRAIN_PARK && n > 0.88 && gy + 1 < this.height) {
              this.blocks[this.index(x, gy + 1, z)] = BLOCK.GRASS;
            }
          }
        }
      }
    }

    this._buildBedrockShell();
    if (opts.remesh !== false) {
      this.chunkMeshes.forEach((mesh) => {
        this.group.remove(mesh);
        if (mesh.isGroup) {
          const kids = mesh.children.slice();
          for (let i = 0; i < kids.length; i++) {
            if (kids[i].geometry) kids[i].geometry.dispose();
          }
        } else if (mesh.geometry) {
          mesh.geometry.dispose();
        }
      });
      this.chunkMeshes.clear();
      if (this._dirtyChunks) this._dirtyChunks.clear();
      if (this._lodDirtyChunks) this._lodDirtyChunks.clear();
      this._finalizeTerrainHeight();
      this._rebuildAllChunks({ progressive: false });
    }
    return true;
  };

  /**
   * Editor: wipe city architecture, keep flat terrain + river + roads + bedrock.
   * opts.terrain — optional image semantic mask { cells, data }.
   * Bases must be re-stamped by Bases.rebuildAfterMapGen afterward.
   */
  VoxelWorld.prototype.prepareEditorCanvas = function (opts) {
    opts = opts || {};
    if (global.VF.disposeWorldOutskirts) {
      global.VF.disposeWorldOutskirts(this);
    }
    if (this.ziplines && this.ziplines.length) {
      for (let i = 0; i < this.ziplines.length; i++) {
        const z = this.ziplines[i];
        if (z && z.cable) {
          if (z.cable.parent) z.cable.parent.remove(z.cable);
          if (z.cable.geometry) z.cable.geometry.dispose();
        }
      }
    }
    this.ziplines = [];
    this.buildings = [];
    this.rooftops = [];
    this.skyBridges = [];
    this._plannedLandmarks = [];
    this._tdmHotzones = [];
    this._pveDistrict = false;
    this._ffaDistrict = false;
    this._districtSpawns = null;
    this._clearStairIndex();
    while (this.props && this.props.length) {
      this.destroyProp(this.props[0]);
    }

    this.blocks.fill(0);
    if (this._blockDurability) this._blockDurability.clear();
    else this._blockDurability = new Map();
    this.groundY.fill(0);
    if (this.terrainH) this.terrainH.fill(0);
    else this.terrainH = new Float32Array(this.worldSize * this.worldSize);
    if (this.terrainH0) this.terrainH0.fill(0);
    else this.terrainH0 = new Float32Array(this.worldSize * this.worldSize);
    if (this._manmade) this._manmade.clear();
    else this._manmade = new Set();
    this._noiseSeed = 0;
    this._terrainMask = null;
    this._terrainMaskCells = 0;

    if (opts.terrain && opts.terrain.data && opts.terrain.data.length) {
      this.applyTerrainMask(opts.terrain, { remesh: false });
    } else {
      this._buildTerrain();
      this._buildRoadGrid();
      this._buildBedrockShell();
    }

    // Drop leftover non-chunk meshes (zipline posts, bridge props, etc.)
    const chunkSet = new Set();
    this.chunkMeshes.forEach(function (m) {
      chunkSet.add(m);
    });
    const drop = [];
    for (let i = 0; i < this.group.children.length; i++) {
      const c = this.group.children[i];
      if (!chunkSet.has(c)) drop.push(c);
    }
    for (let i = 0; i < drop.length; i++) {
      const c = drop[i];
      this.group.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material && c.material !== this._chunkMat) {
        if (Array.isArray(c.material)) c.material.forEach(function (m) {
          if (m && m.dispose) m.dispose();
        });
        else if (c.material.dispose) c.material.dispose();
      }
    }

    // Full remesh so 3D world matches the cleared canvas immediately
    this.chunkMeshes.forEach((mesh) => {
      this.group.remove(mesh);
      if (mesh.isGroup) {
        const kids = mesh.children.slice();
        for (let i = 0; i < kids.length; i++) {
          if (kids[i].geometry) kids[i].geometry.dispose();
        }
      } else if (mesh.geometry) {
        mesh.geometry.dispose();
      }
    });
    this.chunkMeshes.clear();
    if (this._dirtyChunks) this._dirtyChunks.clear();
    if (this._lodDirtyChunks) this._lodDirtyChunks.clear();
    this._finalizeTerrainHeight();
    this._rebuildAllChunks({ progressive: false });

    if (global.VF.refreshWorldOutskirts) {
      global.VF.refreshWorldOutskirts(this);
    }
    this._editorCanvas = true;
    return this;
  };

  /** Mark chunks dirty for a world-space AABB on XZ. */
  VoxelWorld.prototype.dirtyRect = function (x0, z0, x1, z1, reason) {
    const cs = this.chunkSize;
    const minCx = Math.floor(Math.min(x0, x1) / cs) - 1;
    const maxCx = Math.floor(Math.max(x0, x1) / cs) + 1;
    const minCz = Math.floor(Math.min(z0, z1) / cs) - 1;
    const maxCz = Math.floor(Math.max(z0, z1) / cs) + 1;
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        this._markChunkDirty(cx, cz, reason || 'content');
      }
    }
  };

  /**
   * Stamp a whole prefab at center (cx,cz). yawDeg: 0/90/180/270 — all kinds honor yaw.
   * kinds: house | midrise | skyscraper | ruin | bridge | factory | bridgeNet
   */
  VoxelWorld.prototype.stampEditorPrefab = function (kind, cx, cz, yawDeg) {
    cx = Math.floor(cx);
    cz = Math.floor(cz);
    yawDeg = ((yawDeg % 360) + 360) % 360;
    const rot90 = yawDeg === 90 || yawDeg === 270;
    let ox;
    let oz;
    let w;
    let d;

    if (kind === 'house') {
      w = rot90 ? 12 : 14;
      d = rot90 ? 14 : 12;
      ox = cx - (w >> 1);
      oz = cz - (d >> 1);
      this._placeHouse(ox, oz, w, d);
    } else if (kind === 'midrise') {
      w = 13;
      d = 13;
      ox = cx - (w >> 1);
      oz = cz - (d >> 1);
      this._placeMidrise(ox, oz, w, 18);
    } else if (kind === 'skyscraper') {
      w = 16;
      d = 16;
      ox = cx - (w >> 1);
      oz = cz - (d >> 1);
      this._placeSkyscraper(ox, oz, w, 48);
    } else if (kind === 'ruin') {
      w = 10;
      d = 10;
      ox = cx - (w >> 1);
      oz = cz - (d >> 1);
      this._placeRuinStub(ox, oz);
    } else if (kind === 'factory') {
      w = rot90 ? 28 : 40;
      d = rot90 ? 40 : 28;
      ox = cx - (w >> 1);
      oz = cz - (d >> 1);
      this._placeFactory(ox, oz, w, d);
    } else if (kind === 'bridge') {
      const span = this._stampBridgePrefab(cx, cz, yawDeg);
      if (!span) return null;
      w = span.w;
      d = span.d;
      ox = span.ox;
      oz = span.oz;
    } else {
      return null;
    }

    this.dirtyRect(ox - 2, oz - 2, ox + w + 2, oz + d + 2);
    this.flushRebuilds(64, cx, cz);
    return { kind: kind, ox: ox, oz: oz, w: w, d: d, cx: cx, cz: cz, yaw: yawDeg };
  };

  /** Map-kit bridge deck heights (low = current default). */
  VoxelWorld.BRIDGE_HEIGHTS = {
    low: 18,
    mid: 28,
    high: 40,
  };

  VoxelWorld.prototype.bridgeDeckY = function (height) {
    const map = VoxelWorld.BRIDGE_HEIGHTS;
    if (typeof height === 'number' && isFinite(height)) return Math.floor(height);
    return map[height] != null ? map[height] : map.low;
  };

  /**
   * Paint-connected elevated bridge from grid cells (map kit).
   * cells: [{gx,gz}, ...] — each cell is cellSize×cellSize world blocks.
   * Adjacent cells share open edges so the deck reads as one continuous bridge.
   * Spans water (no inWater skip). Does NOT auto-place ziplines.
   * @param {number|string} [deckYOrHeight] deck Y or 'low'|'mid'|'high'
   */
  VoxelWorld.prototype.stampBridgeNetwork = function (cells, cellSize, yawDeg, deckYOrHeight) {
    if (!cells || !cells.length) return null;
    cellSize = Math.max(2, cellSize | 0);
    yawDeg = ((yawDeg % 360) + 360) % 360;
    const heightKey =
      deckYOrHeight === 'mid' || deckYOrHeight === 'high' || deckYOrHeight === 'low'
        ? deckYOrHeight
        : typeof deckYOrHeight === 'number'
          ? null
          : 'low';
    const deckY = this.bridgeDeckY(deckYOrHeight != null ? deckYOrHeight : 'low');
    const size = this.worldSize;
    const keySet = {};
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c) continue;
      keySet[c.gx + ',' + c.gz] = { gx: c.gx | 0, gz: c.gz | 0 };
    }
    const list = Object.keys(keySet).map(function (k) {
      return keySet[k];
    });
    if (!list.length) return null;

    const has = function (gx, gz) {
      return !!keySet[gx + ',' + gz];
    };

    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < list.length; i++) {
      const gx = list[i].gx;
      const gz = list[i].gz;
      const ox = gx * cellSize;
      const oz = gz * cellSize;
      if (ox < minX) minX = ox;
      if (oz < minZ) minZ = oz;
      if (ox + cellSize > maxX) maxX = ox + cellSize;
      if (oz + cellSize > maxZ) maxZ = oz + cellSize;

      const openN = has(gx, gz - 1);
      const openS = has(gx, gz + 1);
      const openW = has(gx - 1, gz);
      const openE = has(gx + 1, gz);

      for (let x = ox; x < ox + cellSize; x++) {
        for (let z = oz; z < oz + cellSize; z++) {
          if (x < 2 || z < 2 || x >= size - 2 || z >= size - 2) continue;
          if (this._isBaseKeepClear(x, z, 0)) continue;
          // Elevated deck spans river — do not skip inWater

          const edgeN = z === oz;
          const edgeS = z === oz + cellSize - 1;
          const edgeW = x === ox;
          const edgeE = x === ox + cellSize - 1;
          const rail =
            (edgeN && !openN) || (edgeS && !openS) || (edgeW && !openW) || (edgeE && !openE);

          this.set(x, deckY, z, rail ? BLOCK.METAL : BLOCK.ASPHALT);
          if (rail) this.set(x, deckY + 1, z, BLOCK.METAL);
          else if (this.get(x, deckY + 1, z) === BLOCK.METAL) this.set(x, deckY + 1, z, BLOCK.AIR);
        }
      }

      // Pillars: every other cell, diagonal pair only (~half of prior density)
      if ((gx + gz) % 2 === 0) {
        this._placeBridgePillar(ox + 1, oz + 1, deckY);
        this._placeBridgePillar(ox + cellSize - 2, oz + cellSize - 2, deckY);
      }
    }

    this.skyBridges = this.skyBridges || [];
    const br = {
      fixed: true,
      axis: 'diag',
      a0: 0,
      a1: Math.max(1, Math.hypot(maxX - minX, maxZ - minZ)),
      y: deckY,
      halfW: Math.max(2, (cellSize >> 1) - 1),
      amp: 0,
      freq: 0,
      b: 0,
      startX: minX,
      startZ: minZ,
      ux: maxX > minX ? 1 : 0,
      uz: maxZ > minZ ? 1 : 0,
      px: 0,
      pz: 1,
      samples: [],
      kitNet: true,
      height: heightKey || 'low',
      deckY: deckY,
    };
    for (let i = 0; i < list.length; i++) {
      const cx = list[i].gx * cellSize + cellSize * 0.5;
      const cz = list[i].gz * cellSize + cellSize * 0.5;
      br.samples.push({ x: cx, y: deckY + 1, z: cz, a: i });
    }
    this.skyBridges.push(br);

    const pad = 4;
    const ox = Math.floor(minX - pad);
    const oz = Math.floor(minZ - pad);
    const w = Math.ceil(maxX - minX + pad * 2);
    const d = Math.ceil(maxZ - minZ + pad * 2);
    this.dirtyRect(ox, oz, ox + w, oz + d);
    this.flushRebuilds(96, (minX + maxX) * 0.5, (minZ + maxZ) * 0.5);

    return {
      kind: 'bridgeNet',
      cells: list,
      cellSize: cellSize,
      height: heightKey || 'low',
      deckY: deckY,
      ox: ox,
      oz: oz,
      w: w,
      d: d,
      cx: Math.floor((minX + maxX) * 0.5),
      cz: Math.floor((minZ + maxZ) * 0.5),
      yaw: yawDeg,
    };
  };

  /**
   * Find dry ground for a kit zipline station (never on buildings / water / bases).
   * Prefers same-shore land within cable length 12–48 from bridge cell center.
   * Returns {gx,gz} or null.
   */
  VoxelWorld.prototype.findKitZiplineGround = function (bridgeGx, bridgeGz, cellSize, preferGx, preferGz) {
    cellSize = Math.max(2, (cellSize | 0) || 8);
    const cellCx = bridgeGx * cellSize + cellSize * 0.5;
    const cellCz = bridgeGz * cellSize + cellSize * 0.5;
    const size = this.worldSize;
    const MIN_CABLE = 12;
    const MAX_CABLE = 48;

    const badGround = (tx, tz) => {
      if (tx < 4 || tz < 4 || tx >= size - 4 || tz >= size - 4) return true;
      if (this._isBaseKeepClear(tx, tz, 0)) return true;
      if (this._riverInfo(tx, tz).inWater) return true;
      if (this.isInBuilding && this.isInBuilding(tx, tz, 2)) return true;
      return false;
    };

    const cableLen = (tx, tz) => Math.hypot(tx + 0.5 - cellCx, tz + 0.5 - cellCz);

    /** True if segment from bridge center to ground crosses open water (not bridge deck). */
    const crossesOpenWater = (tx, tz) => {
      const steps = 10;
      let waterHits = 0;
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const x = cellCx + (tx + 0.5 - cellCx) * t;
        const z = cellCz + (tz + 0.5 - cellCz) * t;
        const info = this._riverInfo(x, z);
        if (info && info.inWater) {
          const deck = this.getWalkHeight ? this.getWalkHeight(x, z) : null;
          if (deck == null || deck < 6) waterHits++;
        }
      }
      return waterHits >= 3;
    };

    const tryPoint = (tx, tz) => {
      if (badGround(tx, tz)) return null;
      const len = cableLen(tx, tz);
      if (len < MIN_CABLE || len > MAX_CABLE) return null;
      if (crossesOpenWater(tx, tz)) return null;
      return { gx: tx, gz: tz };
    };

    if (preferGx != null && preferGz != null) {
      const pref = tryPoint(Math.floor(preferGx), Math.floor(preferGz));
      if (pref) return pref;
    }

    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ];
    // Prefer mid rings that yield valid cable length
    for (let ring = 2; ring <= 7; ring++) {
      for (let d = 0; d < dirs.length; d++) {
        const tx = Math.floor(cellCx + dirs[d][0] * (cellSize * ring * 0.55 + 4));
        const tz = Math.floor(cellCz + dirs[d][1] * (cellSize * ring * 0.55 + 4));
        const hit = tryPoint(tx, tz);
        if (hit) return hit;
      }
    }
    return null;
  };

  /**
   * Kit zipline: ground station (never on a building) → bridge cell OUTER edge.
   * Top mount sits past the deck face so cable does not dig into bridge blocks.
   */
  VoxelWorld.prototype.stampKitZipline = function (opts) {
    opts = opts || {};
    const cellSize = Math.max(2, (opts.cellSize | 0) || 8);
    const bridgeGx = opts.bridgeGx | 0;
    const bridgeGz = opts.bridgeGz | 0;
    const height = opts.height || 'low';
    const deckY = this.bridgeDeckY(height);
    const cellCx = bridgeGx * cellSize + cellSize * 0.5;
    const cellCz = bridgeGz * cellSize + cellSize * 0.5;
    const half = cellSize * 0.5;

    let gx = opts.gx;
    let gz = opts.gz;
    const groundOk = (tx, tz) => {
      if (tx == null || tz == null) return false;
      if (this._riverInfo(tx, tz).inWater) return false;
      if (this.isInBuilding && this.isInBuilding(tx, tz, 2)) return false;
      if (this._isBaseKeepClear(tx, tz, 0)) return false;
      const len = Math.hypot(tx + 0.5 - cellCx, tz + 0.5 - cellCz);
      if (len < 10 || len > 52) return false;
      return true;
    };
    if (!groundOk(gx, gz)) {
      const found = this.findKitZiplineGround(bridgeGx, bridgeGz, cellSize, gx, gz);
      if (!found) return null;
      gx = found.gx;
      gz = found.gz;
    }

    // Outer face of the bridge cell facing the ground station (+ clearance)
    const dx = gx + 0.5 - cellCx;
    const dz = gz + 0.5 - cellCz;
    const lenXZ = Math.hypot(dx, dz) || 1;
    const ux = dx / lenXZ;
    const uz = dz / lenXZ;
    let tEdge = Infinity;
    if (Math.abs(ux) > 1e-6) tEdge = Math.min(tEdge, half / Math.abs(ux));
    if (Math.abs(uz) > 1e-6) tEdge = Math.min(tEdge, half / Math.abs(uz));
    if (tEdge === Infinity) tEdge = half;
    const edgeClear = 0.62;
    const topX = cellCx + ux * (tEdge + edgeClear);
    const topZ = cellCz + uz * (tEdge + edgeClear);
    // Sit above rail (deckY deck, deckY+1 rail) — outside the solid
    const topY = deckY + 1.55;

    const gSurf = this._surface(Math.floor(gx), Math.floor(gz)) + 1;
    const startX = Math.floor(gx) + 0.5 + ux * 0.45;
    const startZ = Math.floor(gz) + 0.5 + uz * 0.45;
    const startY = gSurf + 2.35;

    const matCable = new THREE.MeshBasicMaterial({
      color: 0x9ab8d0,
      transparent: true,
      opacity: 0.85,
    });
    const matPost = new THREE.MeshLambertMaterial({ color: 0x4a5560 });
    this._addZiplineStation(
      gx,
      gz,
      {
        x: topX,
        y: topY,
        z: topZ,
        mountOutside: true,
        startX: startX,
        startY: startY,
        startZ: startZ,
      },
      matCable,
      matPost,
      true
    );
    const zip = this.ziplines[this.ziplines.length - 1];
    if (zip) {
      zip.kit = true;
      zip.bridgeGx = bridgeGx;
      zip.bridgeGz = bridgeGz;
      zip.height = height;
      // Guaranteed on-deck landing (inset from outer face toward cell center)
      const inset = Math.min(2.8, Math.max(1.4, half - 1.2));
      const landX = cellCx + ux * (tEdge - inset);
      const landZ = cellCz + uz * (tEdge - inset);
      const deckLand =
        this._findDeckLand(topX, topZ, -ux, -uz, deckY + 1.02) ||
        new THREE.Vector3(landX, deckY + 1.02, landZ);
      zip.landHigh = deckLand;
      zip.rideEnd = new THREE.Vector3(deckLand.x, deckLand.y + 1.15, deckLand.z);
      zip.rideStart = zip.start.clone();
      const lowX = Math.floor(gx) + 0.5 - ux * 2.8;
      const lowZ = Math.floor(gz) + 0.5 - uz * 2.8;
      zip.landLow = new THREE.Vector3(lowX, gSurf, lowZ);
    }

    this.dirtyRect(gx - 3, gz - 3, gx + 3, gz + 3);
    this.flushRebuilds(32, gx, gz);

    return {
      kind: 'zipline',
      bridgeGx: bridgeGx,
      bridgeGz: bridgeGz,
      height: height,
      gx: Math.floor(gx),
      gz: Math.floor(gz),
      cx: Math.floor(gx),
      cz: Math.floor(gz),
      w: 4,
      d: 4,
      ox: Math.floor(gx) - 2,
      oz: Math.floor(gz) - 2,
      yaw: 0,
    };
  };

  /** Compact elevated bridge + ground→deck zipline as one kit piece (legacy). */
  VoxelWorld.prototype._stampBridgePrefab = function (cx, cz, yawDeg) {
    const len = 36;
    const half = len / 2;
    const halfW = 2;
    const deckY = 18;
    const rad = (yawDeg * Math.PI) / 180;
    const ux = Math.cos(rad);
    const uz = Math.sin(rad);
    const ax = cx - ux * half;
    const az = cz - uz * half;
    const bx = cx + ux * half;
    const bz = cz + uz * half;
    const px = -uz;
    const pz = ux;
    const br = this._stampSolidDiagBridge(ax, az, bx, bz, deckY, halfW, px, pz);
    if (!br) return null;
    this.skyBridges = this.skyBridges || [];
    this.skyBridges.push(br);

    // Pillars along span (half density)
    for (let t = 0; t <= len; t += 24) {
      const x = Math.floor(ax + ux * t);
      const z = Math.floor(az + uz * t);
      this._placeBridgePillar(x + Math.round(px * halfW), z + Math.round(pz * halfW), deckY);
      this._placeBridgePillar(x - Math.round(px * halfW), z - Math.round(pz * halfW), deckY);
    }

    // Ground station beside mid-span → deck (whole piece includes zip)
    const matCable = new THREE.MeshBasicMaterial({
      color: 0x9ab8d0,
      transparent: true,
      opacity: 0.85,
    });
    const matPost = new THREE.MeshLambertMaterial({ color: 0x4a5560 });
    const side = 10;
    const gx = cx + px * side;
    const gz = cz + pz * side;
    const top = { x: cx, y: deckY, z: cz };
    this._addZiplineStation(gx, gz, top, matCable, matPost, true);

    const pad = halfW + side + 4;
    return {
      ox: Math.floor(Math.min(ax, bx, gx) - pad),
      oz: Math.floor(Math.min(az, bz, gz) - pad),
      w: Math.ceil(Math.abs(bx - ax) + pad * 2),
      d: Math.ceil(Math.abs(bz - az) + pad * 2),
    };
  };

  /**
   * Clear a footprint back to ground (keep surface / roads / water).
   * Used by map kit right-click delete.
   */
  VoxelWorld.prototype.clearFootprintAboveGround = function (ox, oz, w, d) {
    ox = Math.floor(ox);
    oz = Math.floor(oz);
    w = Math.max(1, Math.floor(w));
    d = Math.max(1, Math.floor(d));
    const size = this.worldSize;
    for (let x = ox; x < ox + w; x++) {
      for (let z = oz; z < oz + d; z++) {
        if (x < 1 || z < 1 || x >= size - 1 || z >= size - 1) continue;
        if (this._isBaseKeepClear(x, z, 0)) continue;
        let gy = this.groundY ? this.groundY[z * size + x] : this._surface(x, z);
        if (gy < 1) gy = this._surface(x, z) || 4;
        for (let y = gy + 1; y < this.height; y++) {
          const t = this.get(x, y, z);
          if (t === BLOCK.BEDROCK) continue;
          this.set(x, y, z, BLOCK.AIR);
        }
        // Keep ground cell; if air at surface, restore grass/dirt from below
        if (this.get(x, gy, z) === BLOCK.AIR) {
          const below = this.get(x, Math.max(0, gy - 1), z);
          this.set(x, gy, z, below !== BLOCK.AIR && below !== BLOCK.BEDROCK ? below : BLOCK.GRASS);
        }
      }
    }

    // Drop buildings whose center is inside footprint
    if (this.buildings && this.buildings.length) {
      this.buildings = this.buildings.filter(function (b) {
        if (!b) return false;
        const cx = b.cx != null ? b.cx : b.ox + b.w * 0.5;
        const cz = b.cz != null ? b.cz : b.oz + b.d * 0.5;
        return !(cx >= ox && cx < ox + w && cz >= oz && cz < oz + d);
      });
    }
    if (this.rooftops && this.rooftops.length) {
      this.rooftops = this.rooftops.filter(function (r) {
        return !(r.x >= ox && r.x < ox + w && r.z >= oz && r.z < oz + d);
      });
    }
    // Remove ziplines touching footprint
    if (this.ziplines && this.ziplines.length) {
      const keep = [];
      for (let i = 0; i < this.ziplines.length; i++) {
        const zip = this.ziplines[i];
        if (!zip || !zip.start) {
          keep.push(zip);
          continue;
        }
        const sx = zip.start.x;
        const sz = zip.start.z;
        const ex = zip.end ? zip.end.x : sx;
        const ez = zip.end ? zip.end.z : sz;
        const hit =
          (sx >= ox && sx < ox + w && sz >= oz && sz < oz + d) ||
          (ex >= ox && ex < ox + w && ez >= oz && ez < oz + d);
        if (hit) {
          if (zip.cable && zip.cable.parent) zip.cable.parent.remove(zip.cable);
          if (zip.cable && zip.cable.geometry) zip.cable.geometry.dispose();
        } else {
          keep.push(zip);
        }
      }
      this.ziplines = keep;
    }

    this.dirtyRect(ox - 2, oz - 2, ox + w + 2, oz + d + 2);
    this.flushRebuilds(64, ox + w * 0.5, oz + d * 0.5);
  };

  global.VF = global.VF || {};
  global.VF.BLOCK = BLOCK;
  global.VF.BLOCK_COLORS = COLORS;
  global.VF.BLOCK_HITS = BLOCK_HITS;
  global.VF.VoxelWorld = VoxelWorld;
})(window);
