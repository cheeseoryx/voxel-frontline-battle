/**
 * Small-mode arena generators patched onto the shared VoxelWorld.
 * Copied from the former modes/small-battle voxel-world fork.
 */
(function (global) {
  'use strict';
  const VoxelWorld = global.VF && global.VF.VoxelWorld;
  const BLOCK = global.VF && global.VF.BLOCK;
  if (!VoxelWorld || !BLOCK) return;
  const SUB_LAYERS = 5;
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

VoxelWorld.prototype._setColumnGround = function (x, z, gy) {
    const i = z * this.worldSize + x;
    this.groundY[i] = gy;
    if (this.terrainH) this.terrainH[i] = (gy || 0) + 1;
  };

VoxelWorld.prototype._finalizeTerrainHeight = function () {
    const n = this.worldSize * this.worldSize;
    if (!this.terrainH || this.terrainH.length !== n) this.terrainH = new Float32Array(n);
    if (!this.terrainH0 || this.terrainH0.length !== n) this.terrainH0 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.terrainH[i] = (this.groundY[i] || 0) + 1;
    }
    this.terrainH0.set(this.terrainH);
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

VoxelWorld.prototype.isStairColumn = function (x, z) {
    return !!(this.stairColumns && this.stairColumns.has(this._stairColKey(x, z)));
  };

VoxelWorld.prototype.stairTreadYs = function (x, z) {
    const ck = this._stairColKey(x, z);
    const arr = this.stairColTreads && this.stairColTreads.get(ck);
    if (arr && arr.length) return arr;
    const ty = this.stairColY && this.stairColY.get(ck);
    return ty != null ? [ty] : [];
  };

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

VoxelWorld.prototype.generateTdmMap = function (seed, opts) {
    opts = opts || {};
    this._arenaMargin = TDM_ARENA_MARGIN;
    this._resetForGenerate(seed);
    this._generateTdm(opts.heightCap != null ? opts.heightCap : 26);
    this._finalizeTerrainHeight();
    this._rebuildAllChunks({ progressive: true, syncRadius: 6 });
    this._mapName = '死斗街区';
    return this.mapSeed;
  };

VoxelWorld.prototype.generateSdMap = function (seed, opts) {
    opts = opts || {};
    this._arenaMargin = SD_ARENA_MARGIN;
    this._resetForGenerate(seed);
    this._generateTdm(opts.heightCap != null ? opts.heightCap : 26);
    this._sdPlantSites = null; // recompute against the fresh arena bounds
    this._finalizeTerrainHeight();
    this._rebuildAllChunks({ progressive: true, syncRadius: 6 });
    this._mapName = '爆破街区';
    return this.mapSeed;
  };

VoxelWorld.prototype.generateFfaMap = function (seed) {
    this._arenaMargin = SD_ARENA_MARGIN; // 复用爆破(SD)的竞技场尺寸与随机城市
    this._resetForGenerate(seed);
    this._generateFfa();
    this._finalizeTerrainHeight();
    this._rebuildAllChunks({ progressive: true, syncRadius: 6 });
    this._mapName = '混战街区';
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

VoxelWorld.prototype.setTdmSpawnOverride = function (zone) {
    this._tdmSpawnOverride = zone || null;
    return this._tdmSpawnOverride;
  };

VoxelWorld.prototype.getTdmSpawnZones = function () {
    return this._tdmSpawnZones || [];
  };

VoxelWorld.prototype.getTdmHotzones = function () {
    return this._tdmHotzones || [];
  };

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
})(window);
