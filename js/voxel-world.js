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
    [BLOCK.GRASS]: 0x3d6b2e,
    [BLOCK.DIRT]: 0x6b4a2e,
    [BLOCK.STONE]: 0x6e7278,
    [BLOCK.CONCRETE]: 0x9a968e,
    [BLOCK.RUST]: 0x8b4518,
    [BLOCK.METAL]: 0x4a5560,
    [BLOCK.ROAD]: 0x2a2c30,
    [BLOCK.WATER]: 0x2a5a7a,
    [BLOCK.RUBBLE]: 0x5a5048,
    [BLOCK.BRICK]: 0x8a3a2a,
    [BLOCK.PLASTER]: 0xd8d2c4,
    [BLOCK.ROOF]: 0x5a4030,
    [BLOCK.GLASS]: 0x6a9aaa,
    [BLOCK.ASPHALT]: 0x222428,
    [BLOCK.BEDROCK]: 0x1a1c22,
    [BLOCK.SMOKE]: 0x8a8882,
    [BLOCK.SMOKE_LIGHT]: 0xa8a6a0,
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
  const WORLD_CHUNKS = 64; // 1024×1024 — 1:1 meters with 荒盆 (1×0.5km playable basin)
  /** Extra solid layers under the playable surface */
  const SUB_LAYERS = 5;
  const WORLD_HEIGHT = 96 + SUB_LAYERS;

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
    /** Float walk-on-top height (m) at each 1m cell; 10cm cubes interpolate this. */
    this.terrainH = new Float32Array(this.worldSize * this.worldSize);
    this._lodCamX = null;
    this._lodCamZ = null;
    /** Extra hits required before breakBlock succeeds — engineer build passive */
    this._blockDurability = new Map();
    this.chunkMeshes = new Map();
    this.props = []; // doors + half-block stairs (mesh collision)
    this.rooftops = []; // {x,y,z} for bridge links
    this.buildings = []; // {ox,oz,w,d,cx,cz,side} for AI spawn / no-enter
    this.skyBridges = []; // elevated deck segments
    this.ziplines = [];
    /** Voxel cells placed as climbable stairs — auto step-up only on these */
    this.stairVoxels = new Set();
    this.mapSeed = 0; // 0 = preview/default; match seed set via regenerate()
    this._noiseSeed = 0; // layered into _noise during building phase
    this._dirtyChunks = new Set();
    this._lodDirtyChunks = new Set();
    this._meshStats = {
      lastFlushMs: 0,
      lastFlushCount: 0,
      fine: 0,
      mid: 0,
      far: 0,
    };
    this._lastVisibilityX = null;
    this._lastVisibilityZ = null;
    this._lastVisibilityAt = 0;
    this._deathStains = [];
    this._chunkMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this._colorCache = {};
    this._propPt = new THREE.Vector3();
    this.group = new THREE.Group();
    this.group.name = 'VoxelWorld';
    scene.add(this.group);

    this._generate();
    // Mesh near bases + map center first; far chunks stream in by player distance
    this._rebuildAllChunks({ progressive: true, syncRadius: 2 });
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
    if (type === BLOCK.AIR && this._blockDurability) {
      this._blockDurability.delete(x + ',' + y + ',' + z);
    }
    return true;
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

  /** Mark a solid voxel as a stair tread (walk-up without jump) */
  VoxelWorld.prototype.markStair = function (x, y, z) {
    if (!this.stairVoxels) this.stairVoxels = new Set();
    this.stairVoxels.add(this._stairKey(x, y, z));
  };

  VoxelWorld.prototype.clearStair = function (x, y, z) {
    if (!this.stairVoxels) return;
    this.stairVoxels.delete(this._stairKey(x, y, z));
  };

  VoxelWorld.prototype.isStairVoxel = function (x, y, z) {
    return !!(this.stairVoxels && this.stairVoxels.has(this._stairKey(x, y, z)));
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
   * Wipe and rebuild base terrain for a match (no procedural city).
   * Bases are re-stamped by Bases.rebuildAfterMapGen afterward.
   */
  VoxelWorld.prototype.regenerate = function (seed) {
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
    this.clearPropClaims();
    this.rooftops = [];
    this.buildings = [];
    this.skyBridges = [];
    if (this.stairVoxels) this.stairVoxels.clear();
    else this.stairVoxels = new Set();

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
    this._clearShallowWater && this._clearShallowWater();

    // Remove non-chunk meshes (zipline posts, leftover props)
    const chunkSet = new Set();
    this.chunkMeshes.forEach((m) => chunkSet.add(m));
    const keepWater = new Set(this._shallowWater || []);
    const drop = [];
    for (let i = 0; i < this.group.children.length; i++) {
      const c = this.group.children[i];
      if (chunkSet.has(c) || keepWater.has(c)) continue;
      drop.push(c);
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
    this._dirtyChunks.clear();
    if (this._lodDirtyChunks) this._lodDirtyChunks.clear();

    this._generate();
    this._rebuildAllChunks({ progressive: true, syncRadius: 2 });
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
    if (this._mapLayout === 'island' || this._mapLayout === 'ridge') {
      const layout = global.VF && global.VF.IslandConquestMap;
      const land = layout && layout.isLand ? layout.isLand(x, z, size) : true;
      const bank = !!(layout && layout.isBank && layout.isBank(x, z, size));
      const wet = !!(layout && layout.isWater && layout.isWater(x, z, size));
      return {
        dist: wet ? 0 : land ? 99 : 8,
        width: 8,
        centerX: size * 0.5,
        inWater: wet,
        bank: bank || wet,
      };
    }
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
    this._noiseSeed = 0;
    this._mapLayout = 'ridge';
    this._plannedLandmarks = [];

    const island = global.VF && global.VF.IslandConquestMap;
    if (island && island.applyLayout) {
      island.applyLayout(this);
    } else {
      this._plannedBases = [
        { x: size * 0.1, z: size * 0.5, gate: '+x' },
        { x: size * 0.9, z: size * 0.5, gate: '-x' },
      ];
    }

    this._buildTerrain();
    if (island && island.stamp) {
      island.stamp(this);
    } else {
      this._buildRoadGrid();
    }
    if (this._mapLayout !== 'island' && this._mapLayout !== 'ridge') {
      this._buildBedrockShell();
    }
    if (this._mapLayout !== 'ridge' && global.VF.refreshWorldOutskirts) {
      global.VF.refreshWorldOutskirts(this);
    }
  };

  /** True if (x,z) is inside a base footprint, gate corridor, or landmark yard */
  VoxelWorld.prototype._isBaseKeepClear = function (x, z, footprint) {
    const pad = footprint != null ? footprint : 27;
    const cx = x + pad / 2;
    const cz = z + pad / 2;

    const bases = this._plannedBases;
    if (bases) {
      const compoundR = 12;
      const corridorHalf = 27;
      const corridorLen = 75;
      for (let i = 0; i < bases.length; i++) {
        const b = bases[i];
        const gx = b.x;
        const gz = b.z;
        if (Math.abs(cx - gx) < compoundR && Math.abs(cz - gz) < compoundR) return true;
        if (b.gate === '+z') {
          if (Math.abs(cx - gx) <= corridorHalf && cz >= gz && cz <= gz + corridorLen) return true;
        } else if (b.gate === '-z') {
          if (Math.abs(cx - gx) <= corridorHalf && cz <= gz && cz >= gz - corridorLen) return true;
        } else if (b.gate === '+x') {
          if (Math.abs(cz - gz) <= corridorHalf && cx >= gx && cx <= gx + corridorLen) return true;
        } else if (b.gate === '-x') {
          if (Math.abs(cz - gz) <= corridorHalf && cx <= gx && cx >= gx - corridorLen) return true;
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

  /**
   * Prop footprint claims — "the artist placed it here, so it stays here".
   *
   * Baked .vox props (VF.Props.stamp) are written during island.stamp(), but
   * several later stages reshape terrain and used to erase them:
   * Bases.rebuildAfterMapGen (_setWalkColumn clears 24 blocks of air above the
   * walk surface), _clearFlagPlaza, and runtime setTerrainTop. Those stages ask
   * isPropClaimed() before writing so a placed prop is never silently gutted.
   */
  VoxelWorld.prototype.claimPropArea = function (ox, oz, w, d, gy, topY) {
    const size = this.worldSize;
    if (!this._propClaims) this._propClaims = [];
    if (!this._propClaimMask) this._propClaimMask = new Uint8Array(size * size);
    this._propClaims.push({
      ox: ox, oz: oz, w: w, d: d, gy: gy, topY: topY,
    });
    for (let dz = 0; dz < d; dz++) {
      for (let dx = 0; dx < w; dx++) {
        const x = ox + dx;
        const z = oz + dz;
        if (x < 0 || z < 0 || x >= size || z >= size) continue;
        this._propClaimMask[z * size + x] = 1;
      }
    }
  };

  /** True if (x,z) sits under a placed prop. Cheap mask lookup, safe pre-gen. */
  VoxelWorld.prototype.isPropClaimed = function (x, z) {
    const mask = this._propClaimMask;
    if (!mask) return false;
    const size = this.worldSize;
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    if (ix < 0 || iz < 0 || ix >= size || iz >= size) return false;
    return mask[iz * size + ix] === 1;
  };

  VoxelWorld.prototype.clearPropClaims = function () {
    this._propClaims = [];
    this._propClaimMask = null;
  };

  VoxelWorld.prototype._buildHeightTerrain = function (layout) {
    const size = this.worldSize;
    const blocks = this.blocks;
    const groundY = this.groundY;
    const H = this.height;
    const idx = function (x, y, z) {
      return (y * size + z) * size + x;
    };
    // 关卡编辑器的表面材质覆盖层。高度偏移不在这里读 —— 它已经烘进
    // layout.heightAtMeters() 里了（js/maps/island-conquest.js），这样生成路径和
    // 编辑器增量路径共用同一个采样函数。
    const MT = global.VF && global.VF.MapTerrain;
    const mapKey = layout && layout.mapKey;
    let matOverlay = null;
    if (MT && mapKey) {
      const data = MT.get(mapKey);
      if (data && !MT.isBlank(data)) matOverlay = data;
    }
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const wet = !!(layout.isWater && layout.isWater(x, z, size));
        const playable = layout.isLand ? layout.isLand(x, z, size) : true;
        let surfH = layout.heightAtMeters
          ? layout.heightAtMeters(x, z, size)
          : (layout.heightAt(x, z, size) | 0) + 1;
        let gy = Math.round(surfH) - 1;
        gy = gy | 0;
        if (gy < 6) gy = 6;
        if (gy > H - 8) gy = H - 8;
        blocks[idx(x, 0, z)] = BLOCK.BEDROCK;
        for (let y = 1; y < gy; y++) {
          blocks[idx(x, y, z)] = y < gy - 2 ? BLOCK.STONE : BLOCK.DIRT;
        }
        let top = BLOCK.STONE;
        const desert = layout.biome === 'desert';
        if (playable) {
          const n = this._noise(x * 0.11, z * 0.11);
          if (wet) top = BLOCK.DIRT;
          else if (desert) {
            if (gy < 14) top = n > 0.72 ? BLOCK.GRASS : BLOCK.DIRT;
            else if (gy < 22) top = n > 0.55 ? BLOCK.RUBBLE : BLOCK.DIRT;
            else top = n > 0.6 ? BLOCK.STONE : BLOCK.RUBBLE;
          } else if (gy < 15) top = n > 0.58 ? BLOCK.DIRT : BLOCK.GRASS;
          else if (gy < 22) top = n > 0.5 ? BLOCK.GRASS : BLOCK.DIRT;
          else top = n > 0.62 ? BLOCK.RUBBLE : BLOCK.STONE;
        } else {
          top = gy > 38 ? BLOCK.STONE : BLOCK.RUBBLE;
        }
        // 编辑器材质覆盖（js/maps/*-terrain.js 的 mat 层）。只改**恰好在 gy 那
        // 一层**的块 —— 下面的填充仍是 STONE/DIRT。10cm 高度场网格化器读的正是
        // this.get(ix, gy, iz)（terrain-fine.js:460），所以改这一格就够上色。
        if (matOverlay) {
          const ov = MT.matAt(matOverlay, x, z);
          if (ov) top = ov;
        }
        blocks[idx(x, gy, z)] = top;
        groundY[z * size + x] = gy;
        if (this.terrainH) this.terrainH[z * size + x] = surfH;
      }
    }
    this._stampShallowWater(layout);
  };

  VoxelWorld.prototype._clearShallowWater = function () {
    const list = this._shallowWater;
    if (!list || !list.length) {
      this._shallowWater = [];
      return;
    }
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.parent) m.parent.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material && m.material.dispose && !m.userData.sharedMat) m.material.dispose();
    }
    if (this._shallowWaterMat && this._shallowWaterMat.dispose) {
      this._shallowWaterMat.dispose();
      this._shallowWaterMat = null;
    }
    this._shallowWater = [];
  };

  /** Decorative 30cm water cubes. No collision — feet use the lowered river bed. */
  VoxelWorld.prototype._stampShallowWater = function (layout) {
    this._clearShallowWater();
    if (!layout || !layout.isWater || typeof THREE === 'undefined') return;
    const size = this.worldSize;
    const hmap = this.terrainH;
    if (!hmap) return;
    const cells = [];
    for (let z = 1; z < size - 1; z++) {
      for (let x = 1; x < size - 1; x++) {
        if (!layout.isWater(x, z, size)) continue;
        cells.push(x, z);
      }
    }
    if (!cells.length) return;
    const count = cells.length / 2;
    const geo = new THREE.BoxGeometry(1, 0.3, 1);
    const mat = new THREE.MeshLambertMaterial({
      color: 0x8ed4f0,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    this._shallowWaterMat = mat;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.raycast = function () {};
    mesh.userData.noCollision = true;
    mesh.userData.sharedMat = true;
    const dummy = this._shallowWaterDummy || (this._shallowWaterDummy = new THREE.Object3D());
    for (let i = 0; i < count; i++) {
      const x = cells[i * 2];
      const z = cells[i * 2 + 1];
      const bed = hmap[z * size + x] || 9;
      dummy.position.set(x + 0.5, bed + 0.15, z + 0.5);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this._shallowWater = [mesh];
  };

  /** Flat street + canal — playable surface sits above SUB_LAYERS foundation */
  VoxelWorld.prototype._buildTerrain = function () {
    const layout = global.VF && global.VF.IslandConquestMap;
    if ((this._mapLayout === 'ridge' || (layout && layout.heightAt)) && layout && layout.heightAt) {
      this._buildHeightTerrain(layout);
      return;
    }
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

        this.groundY[z * size + x] = gy;
        if (this.terrainH) this.terrainH[z * size + x] = gy + 1;

        if (river.inWater) {
          for (let y = SUB_LAYERS; y < WATER_Y; y++) {
            this.set(x, y, z, BLOCK.STONE);
          }
          this.set(x, WATER_Y, z, BLOCK.WATER);
          if (this._mapLayout !== 'island' && this._mapLayout !== 'ridge' && river.dist > river.width - 0.9) {
            this.set(x, WATER_Y + 1, z, BLOCK.CONCRETE);
            this.set(x, WATER_Y + 2, z, BLOCK.CONCRETE);
          }
          continue;
        }

        for (let y = SUB_LAYERS; y <= gy; y++) {
          let t = BLOCK.STONE;
          if (y === gy) {
            if (this._mapLayout === 'island' || this._mapLayout === 'ridge') {
              if (river.bank) t = n > 0.45 ? BLOCK.DIRT : BLOCK.RUBBLE;
              else if (n2 > 0.62) t = BLOCK.CONCRETE;
              else if (n > 0.5) t = BLOCK.ASPHALT;
              else t = BLOCK.STONE;
            } else if (river.bank) t = n > 0.5 ? BLOCK.GRASS : BLOCK.DIRT;
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
    let side = cz < this.worldSize * 0.5 ? 'ally' : 'enemy';
    const bases = this._plannedBases;
    if (bases && bases.length >= 2) {
      const a = bases[0];
      const e = bases[1];
      const da = (cx - a.x) * (cx - a.x) + (cz - a.z) * (cz - a.z);
      const de = (cx - e.x) * (cx - e.x) + (cz - e.z) * (cz - e.z);
      side = da <= de ? 'ally' : 'enemy';
    }
    if (this._mapLayout !== 'island' && this._mapLayout !== 'ridge' && info.dist < info.width + 6) return null;
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

  VoxelWorld.prototype._paintRoadLine = function (x0, z0, x1, z1, halfW) {
    halfW = halfW != null ? halfW : 3;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz) || 1;
    const steps = Math.ceil(len);
    const ux = dx / len;
    const uz = dz / len;
    const px = -uz;
    const pz = ux;
    for (let i = 0; i <= steps; i++) {
      const x = x0 + ux * i;
      const z = z0 + uz * i;
      for (let s = -halfW; s <= halfW; s++) {
        const wx = Math.floor(x + px * s);
        const wz = Math.floor(z + pz * s);
        if (wx < 1 || wz < 1 || wx >= this.worldSize - 1 || wz >= this.worldSize - 1) continue;
        if (this._riverInfo(wx, wz).inWater) continue;
        const gy = this._surface(wx, wz);
        this.set(wx, gy, wz, Math.abs(s) <= 1 ? BLOCK.ASPHALT : BLOCK.ROAD);
        const up = this.get(wx, gy + 1, wz);
        if (up === BLOCK.GRASS || up === BLOCK.RUBBLE) this.set(wx, gy + 1, wz, BLOCK.AIR);
      }
    }
  };

  VoxelWorld.prototype._placeWarehouse = function (ox, oz, w, d, h) {
    w = w != null ? w : 14;
    d = d != null ? d : 10;
    h = h != null ? h : 5;
    ox = Math.floor(ox);
    oz = Math.floor(oz);
    const mx = ox + (w >> 1);
    const mz = oz + (d >> 1);
    if (this._riverInfo(mx, mz).inWater) return;
    this._registerBuilding(ox, oz, w, d);
    const gy = this._surface(mx, mz);
    const top = gy + h;
    this.fill(ox, gy, oz, ox + w - 1, gy + 1, oz + d - 1, BLOCK.CONCRETE);
    for (let y = gy + 2; y <= top; y++) {
      for (let x = ox; x < ox + w; x++) {
        for (let z = oz; z < oz + d; z++) {
          const wall = x === ox || x === ox + w - 1 || z === oz || z === oz + d - 1;
          if (!wall) continue;
          const door =
            z === oz && Math.abs(x - mx) <= 1 && y <= gy + 4;
          if (door) continue;
          this.set(x, y, z, y === top ? BLOCK.METAL : BLOCK.CONCRETE);
        }
      }
    }
    this.fill(ox, top, oz, ox + w - 1, top, oz + d - 1, BLOCK.METAL);
    this._addDoor(ox, oz, w, gy + 2);
  };

  VoxelWorld.prototype._placeContainer = function (ox, oz, w, d, h) {
    w = w != null ? w : 8;
    d = d != null ? d : 3;
    h = h != null ? h : 3;
    ox = Math.floor(ox);
    oz = Math.floor(oz);
    const mx = ox + (w >> 1);
    const mz = oz + (d >> 1);
    if (this._riverInfo(mx, mz).inWater) return;
    const gy = this._surface(mx, mz);
    this.fill(ox, gy + 1, oz, ox + w - 1, gy + h, oz + d - 1, BLOCK.METAL);
  };

  VoxelWorld.prototype._placeTank = function (cx, cz, r, h) {
    r = Math.max(4, Math.floor(r || 8));
    h = h != null ? h : 12;
    const gx = Math.floor(cx);
    const gz = Math.floor(cz);
    if (this._riverInfo(gx, gz).inWater) return;
    const gy = this._surface(gx, gz);
    const r2 = r * r;
    const inner = (r - 2) * (r - 2);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const x = gx + dx;
        const z = gz + dz;
        const wall = d2 >= inner;
        this.set(x, gy, z, BLOCK.CONCRETE);
        for (let y = gy + 1; y <= gy + h; y++) {
          if (wall || y === gy + h) this.set(x, y, z, y === gy + h ? BLOCK.RUST : BLOCK.METAL);
        }
      }
    }
  };

  VoxelWorld.prototype._placeStadium = function (cx, cz, rx, rz) {
    rx = Math.max(10, Math.floor(rx || 22));
    rz = Math.max(12, Math.floor(rz || 30));
    const gx = Math.floor(cx);
    const gz = Math.floor(cz);
    if (this._riverInfo(gx, gz).inWater) return;
    const gy = this._surface(gx, gz);
    for (let dz = -rz; dz <= rz; dz++) {
      for (let dx = -rx; dx <= rx; dx++) {
        const u = (dx / rx) * (dx / rx) + (dz / rz) * (dz / rz);
        if (u > 1) continue;
        const x = gx + dx;
        const z = gz + dz;
        // An artist-placed prop outranks a procedural landmark.
        if (this.isPropClaimed && this.isPropClaimed(x, z)) continue;
        const ring = u > 0.72;
        this.set(x, gy, z, ring ? BLOCK.CONCRETE : BLOCK.DIRT);
        if (ring) {
          for (let y = gy + 1; y <= gy + 5; y++) this.set(x, y, z, BLOCK.CONCRETE);
        } else {
          for (let y = gy + 1; y <= gy + 6; y++) this.set(x, y, z, BLOCK.AIR);
        }
      }
    }
  };

  VoxelWorld.prototype._placeBridge = function (x0, z0, x1, z1, halfW) {
    halfW = halfW != null ? halfW : 4;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz) || 1;
    const steps = Math.ceil(len);
    const ux = dx / len;
    const uz = dz / len;
    const px = -uz;
    const pz = ux;
    const gy0 = this._surface(Math.floor(x0), Math.floor(z0));
    const deck = gy0 + 6;
    for (let i = 0; i <= steps; i++) {
      const x = x0 + ux * i;
      const z = z0 + uz * i;
      if (i % 10 === 0) {
        const wx = Math.floor(x);
        const wz = Math.floor(z);
        const gy = this._surface(wx, wz);
        this.fill(wx - 1, gy + 1, wz - 1, wx + 1, deck - 1, wz + 1, BLOCK.CONCRETE);
      }
      for (let s = -halfW; s <= halfW; s++) {
        const wx = Math.floor(x + px * s);
        const wz = Math.floor(z + pz * s);
        if (wx < 2 || wz < 2 || wx >= this.worldSize - 2 || wz >= this.worldSize - 2) continue;
        this.set(wx, deck, wz, Math.abs(s) >= halfW - 1 ? BLOCK.CONCRETE : BLOCK.ASPHALT);
        this.set(wx, deck + 1, wz, BLOCK.AIR);
      }
    }
  };

  VoxelWorld.prototype._placeShrub = function (x, z) {
    const gx = Math.floor(x);
    const gz = Math.floor(z);
    if (this._riverInfo(gx, gz).inWater) return;
    const gy = this._surface(gx, gz);
    this.set(gx, gy + 1, gz, BLOCK.DIRT);
    this.set(gx, gy + 2, gz, BLOCK.DIRT);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        this.set(gx + dx, gy + 3, gz + dz, BLOCK.GRASS);
      }
    }
    this.set(gx, gy + 4, gz, BLOCK.GRASS);
  };

  /** Low stone ring around a capture yard (openings on +x / -x). */
  VoxelWorld.prototype._placeBunkerYard = function (cx, cz, innerR, wallH) {
    innerR = Math.max(10, Math.floor(innerR || 16));
    wallH = wallH != null ? wallH : 4;
    const gx = Math.floor(cx);
    const gz = Math.floor(cz);
    const gy = this._surface(gx, gz);
    const outer = innerR + 3;
    const inner2 = innerR * innerR;
    const outer2 = outer * outer;
    for (let dz = -outer; dz <= outer; dz++) {
      for (let dx = -outer; dx <= outer; dx++) {
        const r2 = dx * dx + dz * dz;
        if (r2 > outer2 || r2 < inner2) continue;
        const gap = Math.abs(dz) <= 2 && Math.abs(dx) >= innerR - 1;
        if (gap) continue;
        const x = gx + dx;
        const z = gz + dz;
        if (x < 2 || z < 2 || x >= this.worldSize - 2 || z >= this.worldSize - 2) continue;
        if (this._riverInfo(x, z).inWater) continue;
        for (let y = gy + 1; y <= gy + wallH; y++) {
          this.set(x, y, z, y === gy + wallH ? BLOCK.CONCRETE : BLOCK.STONE);
        }
      }
    }
    if (this.dirtyRect) this.dirtyRect(gx - outer - 1, gz - outer - 1, gx + outer + 1, gz + outer + 1);
  };

  /** Small asphalt pad and headroom for the resupply kiosk only. */
  VoxelWorld.prototype._placeArmorRepairCenter = function (cx, cz, team) {
    const gx = Math.floor(cx);
    const gz = Math.floor(cz);
    const size = this.worldSize;
    if (gx < 16 || gz < 16 || gx >= size - 16 || gz >= size - 16) {
      return { x: gx, z: gz, y: 9 };
    }
    const half = 2;
    const gy = this._surface(gx, gz) || 9;
    const clearH = 5;
    for (let dz = -half; dz <= half; dz++) {
      for (let dx = -half; dx <= half; dx++) {
        const x = gx + dx;
        const z = gz + dz;
        if (x < 2 || z < 2 || x >= size - 2 || z >= size - 2) continue;
        const edge = Math.abs(dx) === half || Math.abs(dz) === half;
        this.set(x, gy, z, edge ? BLOCK.CONCRETE : BLOCK.ASPHALT);
        for (let y = gy + 1; y <= gy + clearH && y < this.height; y++) {
          this.set(x, y, z, BLOCK.AIR);
        }
      }
    }
    if (this.dirtyRect) {
      this.dirtyRect(gx - half - 1, gz - half - 1, gx + half + 1, gz + half + 1);
    }
    return { x: gx + 0.5, z: gz + 0.5, y: gy + 1 };
  };

  /** Clear headroom for a vehicle pad without flattening or raising terrain. */
  VoxelWorld.prototype._clearVehiclePad = function (cx, cz, radius) {
    const r = Math.max(4, Math.floor(radius || 6));
    const gx = Math.floor(cx);
    const gz = Math.floor(cz);
    const size = this.worldSize;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r * r) continue;
        const x = gx + dx;
        const z = gz + dz;
        if (x < 2 || z < 2 || x >= size - 2 || z >= size - 2) continue;
        // Don't hollow out an artist-placed prop to make room for a vehicle.
        if (this.isPropClaimed && this.isPropClaimed(x, z)) continue;
        const ground = this.groundY
          ? this.groundY[z * size + x]
          : Math.floor(this.getTerrainTop(x, z));
        for (
          let y = Math.max(1, ground + 1);
          y <= ground + 7 && y < this.height;
          y++
        ) {
          const block = this.get(x, y, z);
          if (
            block !== BLOCK.AIR &&
            block !== BLOCK.WATER &&
            block !== BLOCK.BEDROCK
          ) {
            this.set(x, y, z, BLOCK.AIR);
          }
        }
      }
    }
    if (this.dirtyRect) {
      this.dirtyRect(gx - r - 1, gz - r - 1, gx + r + 1, gz + r + 1);
    }
  };

  /** Flatten a capture plaza so flags are never buried in buildings. */
  VoxelWorld.prototype._clearFlagPlaza = function (cx, cz, radius) {
    const r = Math.max(8, Math.floor(radius || 18));
    const gx = Math.floor(cx);
    const gz = Math.floor(cz);
    const size = this.worldSize;
    let gy = this._surface(gx, gz) || 9;
    if (!(gy > 3)) gy = 9;
    const r2 = r * r;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r2) continue;
        const x = gx + dx;
        const z = gz + dz;
        if (x < 2 || z < 2 || x >= size - 2 || z >= size - 2) continue;
        if (this._riverInfo(x, z).inWater) continue;
        // An artist-placed prop outranks the plaza sweep; carving here would
        // gut the building (see claimPropArea).
        if (this.isPropClaimed && this.isPropClaimed(x, z)) continue;
        for (let y = 1; y < gy; y++) {
          const cur = this.get(x, y, z);
          if (cur === BLOCK.AIR || cur === BLOCK.WATER) this.set(x, y, z, BLOCK.STONE);
        }
        for (let y = gy + 1; y <= gy + 18 && y < this.height; y++) {
          this.set(x, y, z, BLOCK.AIR);
        }
        const edge = dx * dx + dz * dz > (r - 2) * (r - 2);
        this.set(x, gy, z, edge ? BLOCK.ASPHALT : BLOCK.CONCRETE);
        if (this.groundY) this.groundY[z * size + x] = gy;
        if (this.terrainH) this.terrainH[z * size + x] = gy + 1;
      }
    }
    if (this.buildings && this.buildings.length) {
      const keep = [];
      for (let i = 0; i < this.buildings.length; i++) {
        const b = this.buildings[i];
        const bx = b.cx != null ? b.cx : b.ox + (b.w || 0) * 0.5;
        const bz = b.cz != null ? b.cz : b.oz + (b.d || 0) * 0.5;
        const dx = bx - cx;
        const dz = bz - cz;
        if (dx * dx + dz * dz < (r + 6) * (r + 6)) continue;
        keep.push(b);
      }
      this.buildings = keep;
    }
    if (this.dirtyRect) this.dirtyRect(gx - r - 2, gz - r - 2, gx + r + 2, gz + r + 2);
    return gy;
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
      color: 0x6b4a2e,
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
      if (this.getTerrainTop) {
        const terrainY = this.getTerrainTop(sx, sz);
        if (sy < terrainY + 0.05) sy = terrainY + 0.05;
      }
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
          let y;
          if (this.getWalkHeight) {
            y = this.getWalkHeight(x, z);
          } else {
            y = this.height - 1;
            while (y > 0 && !this._isSolid(Math.floor(x), y, Math.floor(z))) y--;
            y = y + 1.05;
          }
          return new THREE.Vector3(x, y, z);
        }
      }
      return new THREE.Vector3(sx, sy, sz);
    };

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
    const id = this._selectedSpawnId;
    if (!id) return null;
    if (this._deployList && this._deployList.length) {
      for (let i = 0; i < this._deployList.length; i++) {
        const s = this._deployList[i];
        if (s.id === id) {
          if (this._playerTeam && s.team !== this._playerTeam) return null;
          return s;
        }
      }
    }
    if (!this._spawnPoints || !this._spawnPoints.all) return null;
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
    const changed = this._playerTeam !== team;
    this._playerTeam = team;
    if (this._deployList && this._deployList.length) {
      const cur = this.getSelectedSpawn();
      if (!cur || cur.team !== team) {
        let pick = null;
        for (let i = 0; i < this._deployList.length; i++) {
          if (this._deployList[i].team === team) {
            pick = this._deployList[i];
            if (pick.kind === 'hq' || pick.fixed) break;
          }
        }
        this._selectedSpawnId = pick ? pick.id : null;
      }
    } else {
      const list = this._spawnPoints && this._spawnPoints[team];
      if (list && list.length) {
        const cur = this.getSelectedSpawn();
        if (!cur || cur.team !== team) {
          this._selectedSpawnId = list[Math.min(1, list.length - 1)].id;
        }
      } else {
        this._selectedSpawnId = null;
      }
    }
    if (changed && global.VF.TeamLook && global.VF.TeamLook.refresh) {
      global.VF.TeamLook.refresh();
    }
    return team;
  };

  VoxelWorld.prototype.setSelectedSpawn = function (id) {
    if (this._deployList && this._deployList.length) {
      for (let i = 0; i < this._deployList.length; i++) {
        const s = this._deployList[i];
        if (s.id === id) {
          if (this._playerTeam && s.team !== this._playerTeam) return null;
          this._selectedSpawnId = id;
          return s;
        }
      }
    }
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
   */
  VoxelWorld.prototype._isTerrainFill = function (x, y, z) {
    if (y < 0) return false;
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
    const syncRadius = opts.syncRadius != null ? opts.syncRadius : 2;

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
    this._dirtyChunks.clear();
    if (this._lodDirtyChunks) this._lodDirtyChunks.clear();

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

  /** Prioritize chunks around a world position without synchronously rebuilding the ring. */
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
              const shade = 0.72 + 0.28 * Math.max(0, face.n[1]);
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
    if (reason === 'lod') {
      if (!this._dirtyChunks.has(key)) this._lodDirtyChunks.add(key);
      return;
    }
    this._lodDirtyChunks.delete(key);
    this._dirtyChunks.add(key);
  };

  /** Time-budgeted rebuild queue. Content mutations always outrank LOD swaps. */
  VoxelWorld.prototype.flushRebuilds = function (budgetMs, preferX, preferZ) {
    budgetMs = budgetMs != null ? Math.max(1, Math.min(8, +budgetMs || 0)) : 4;
    if (!this._dirtyChunks.size && !this._lodDirtyChunks.size) return 0;
    const started = performance.now();
    const self = this;
    let count = 0;
    let fineCount = 0;

    const popNearest = function (set) {
      if (!set || !set.size) return null;
      if (preferX == null || preferZ == null || set.size < 2) {
        const first = set.values().next();
        return first.done ? null : first.value;
      }
      let best = null;
      let bestD = Infinity;
      set.forEach(function (key) {
        const parts = key.split(',');
        const mx = (+parts[0] + 0.5) * self.chunkSize;
        const mz = (+parts[1] + 0.5) * self.chunkSize;
        const dx = mx - preferX;
        const dz = mz - preferZ;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = key;
        }
      });
      return best;
    };

    while (performance.now() - started < budgetMs) {
      const set = this._dirtyChunks.size ? this._dirtyChunks : this._lodDirtyChunks;
      const key = popNearest(set);
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
      count++;
    }
    this._meshStats.lastFlushMs = performance.now() - started;
    this._meshStats.lastFlushCount = count;
    return count;
  };

  VoxelWorld.prototype.breakBlock = function (x, y, z, opts) {
    opts = opts || {};
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
    if (!opts.force) {
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
    const vehicles = box.ignoreVehicleColliders
      ? []
      : this._vehicleAABBs || [];
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (
        !v ||
        v.alive === false ||
        v.vehicleId === box.excludeVehicleId
      ) {
        continue;
      }
      if (
        box.min.x <= v.max.x &&
        box.max.x >= v.min.x &&
        box.min.y <= v.max.y &&
        box.max.y >= v.min.y &&
        box.min.z <= v.max.z &&
        box.max.z >= v.min.z
      ) {
        return true;
      }
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
    const vehicles = box.ignoreVehicleColliders
      ? []
      : this._vehicleAABBs || [];
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (
        !v ||
        v.alive === false ||
        v.vehicleId === box.excludeVehicleId ||
        box.min.x > v.max.x ||
        box.max.x < v.min.x ||
        box.min.y > v.max.y ||
        box.max.y < v.min.y ||
        box.min.z > v.max.z ||
        box.max.z < v.min.z
      ) {
        continue;
      }
      let h = pool[n];
      if (!h) {
        h = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
        pool[n] = h;
      }
      h.min.set(v.min.x, v.min.y, v.min.z);
      h.max.set(v.max.x, v.max.y, v.max.z);
      h.userData = h.userData || {};
      h.userData.vehicleId = v.vehicleId;
      n++;
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
    let fine = 0;
    let mid = 0;
    let far = 0;
    this.chunkMeshes.forEach(function (mesh) {
      const c = mesh.userData.chunk;
      if (!c) return;
      const mx = (c.cx + 0.5) * cs;
      const mz = (c.cz + 0.5) * cs;
      const dx = mx - camX;
      const dz = mz - camZ;
      mesh.visible = dx * dx + dz * dz < rangeSq;
      if (c.lod === 0.1) fine++;
      else if (c.lod === 0.4) mid++;
      else far++;
      if (!self._chunkTerrainLod) return;
      // Invisible chunks are also downgraded after deploy/teleport, preventing
      // old fine meshes from accumulating across the map.
      const lod = self._chunkTerrainLod(c.cx, c.cz, c.lod);
      if (c.lod !== lod) self._markChunkDirty(c.cx, c.cz, 'lod');
    });
    this._meshStats.fine = fine;
    this._meshStats.mid = mid;
    this._meshStats.far = far;
  };

  VoxelWorld.prototype.setLodFocus = function (x, z) {
    this._lodCamX = x;
    this._lodCamZ = z;
    this._lastVisibilityX = null;
    this._lastVisibilityZ = null;
    const self = this;
    this.chunkMeshes.forEach(function (mesh) {
      const c = mesh.userData && mesh.userData.chunk;
      if (!c) return;
      const lod = self._chunkTerrainLod ? self._chunkTerrainLod(c.cx, c.cz, c.lod) : 1;
      if (lod !== c.lod) self._markChunkDirty(c.cx, c.cz, 'lod');
    });
  };

  VoxelWorld.prototype.getTerrainStats = function () {
    let fine = 0;
    let mid = 0;
    let far = 0;
    let vertices = 0;
    this.chunkMeshes.forEach(function (mesh) {
      const c = mesh.userData && mesh.userData.chunk;
      if (c) {
        if (c.lod === 0.1) fine++;
        else if (c.lod === 0.4) mid++;
        else far++;
      }
      mesh.traverse(function (node) {
        const pos = node.geometry && node.geometry.getAttribute('position');
        if (pos) vertices += pos.count;
      });
    });
    return {
      contentDirty: this._dirtyChunks.size,
      lodDirty: this._lodDirtyChunks.size,
      flushMs: this._meshStats.lastFlushMs,
      flushCount: this._meshStats.lastFlushCount,
      fine: fine,
      mid: mid,
      far: far,
      vertices: vertices,
    };
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
    const Look = global.VF && global.VF.TeamLook;
    const friend =
      Look && Look.kind
        ? Look.kind(team) === 'friend'
        : team === 'ally' || team === 'blue';
    const paint = friend ? BLOCK.PAINT_BLUE : BLOCK.PAINT_RED;
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

            this.groundY[z * size + x] = gy;
            if (this.terrainH) this.terrainH[z * size + x] = gy + 1;

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
      this._rebuildAllChunks({ progressive: true, syncRadius: 1 });
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
    this._clearShallowWater && this._clearShallowWater();
    this.buildings = [];
    this.rooftops = [];
    this.skyBridges = [];
    this._plannedLandmarks = [];
    if (this.stairVoxels) this.stairVoxels.clear();
    else this.stairVoxels = new Set();
    while (this.props && this.props.length) {
      this.destroyProp(this.props[0]);
    }

    this.blocks.fill(0);
    if (this._blockDurability) this._blockDurability.clear();
    else this._blockDurability = new Map();
    this.groundY.fill(0);
    if (this.terrainH) this.terrainH.fill(0);
    this.clearPropClaims();
    this._noiseSeed = 0;
    this._terrainMask = null;
    this._terrainMaskCells = 0;

    if (opts.terrain && opts.terrain.data && opts.terrain.data.length) {
      this.applyTerrainMask(opts.terrain, { remesh: false });
    } else {
      this._mapLayout = 'ridge';
      const island = global.VF && global.VF.IslandConquestMap;
      if (island && island.applyLayout) island.applyLayout(this);
      this._buildTerrain();
      if (island && island.stamp) island.stamp(this);
      else this._buildRoadGrid();
      if (this._mapLayout !== 'island' && this._mapLayout !== 'ridge') this._buildBedrockShell();
    }

    // Drop leftover non-chunk meshes (zipline posts, bridge props, etc.)
    const chunkSet = new Set();
    this.chunkMeshes.forEach(function (m) {
      chunkSet.add(m);
    });
    const keepWater = new Set(this._shallowWater || []);
    const drop = [];
    for (let i = 0; i < this.group.children.length; i++) {
      const c = this.group.children[i];
      if (chunkSet.has(c) || keepWater.has(c)) continue;
      drop.push(c);
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

    // Mesh the nearby editor area first; the rest streams through the budgeted queue.
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
    this._rebuildAllChunks({ progressive: true, syncRadius: 1 });

    if (this._mapLayout !== 'ridge' && global.VF.refreshWorldOutskirts) {
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

  /**
   * Battlefield display colors are always relative to the local player:
   * friend = blue, foe = red. Faction ids (`ally` / `enemy`) stay unchanged.
   */
  global.VF.TeamLook = {
    FRIEND: 0x33aaff,
    FOE: 0xff3344,
    NEUTRAL: 0xc8c4b8,
    CONTEST: 0xffe08a,
    FRIEND_CSS: '#4aa3ff',
    FOE_CSS: '#ff5a4a',
    NEUTRAL_CSS: '#f2f0ea',
    CONTEST_CSS: '#ffe08a',
    playerTeam: function () {
      const g = global.VF && global.VF.game;
      const w = g && g.world;
      if (w && (w._playerTeam === 'ally' || w._playerTeam === 'enemy')) return w._playerTeam;
      if (g && g.player && (g.player.team === 'ally' || g.player.team === 'enemy')) {
        return g.player.team;
      }
      return 'ally';
    },
    kind: function (owner) {
      if (owner !== 'ally' && owner !== 'enemy') return 'neutral';
      return owner === this.playerTeam() ? 'friend' : 'foe';
    },
    hex: function (owner, contested) {
      if (contested) return this.CONTEST;
      const k = this.kind(owner);
      if (k === 'friend') return this.FRIEND;
      if (k === 'foe') return this.FOE;
      return this.NEUTRAL;
    },
    css: function (owner, contested) {
      if (contested) return this.CONTEST_CSS;
      const k = this.kind(owner);
      if (k === 'friend') return this.FRIEND_CSS;
      if (k === 'foe') return this.FOE_CSS;
      return this.NEUTRAL_CSS;
    },
    sideName: function (owner) {
      const k = this.kind(owner);
      if (k === 'foe') return '红方';
      if (k === 'friend') return '蓝方';
      return '中立';
    },
    refresh: function () {
      const g = global.VF && global.VF.game;
      if (global.VF.Conquest && global.VF.Conquest.refreshDisplay) {
        global.VF.Conquest.refreshDisplay();
      }
      if (g && g.bases && g.bases.refreshDisplayColors) {
        g.bases.refreshDisplayColors();
      }
      if (g && g.ai && g.ai.refreshDisplayColors) {
        g.ai.refreshDisplayColors();
      }
      if (global.VF.Gadgets && global.VF.Gadgets.refreshDisplayColors) {
        global.VF.Gadgets.refreshDisplayColors();
      }
      if (global.VF.Vehicles && global.VF.Vehicles.refreshDisplayColors) {
        global.VF.Vehicles.refreshDisplayColors();
      }
    },
  };
})(window);
