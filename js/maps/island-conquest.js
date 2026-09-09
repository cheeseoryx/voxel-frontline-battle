/**
 * island-conquest.js — Official 32v32 conquest map (荒盆)
 *
 * 1:1 scale lock from deploy screenshot:
 *   world 1024m, 1 voxel = 1m on XZ
 *   south deploy pad → flag A = 170m northeast
 * Playable basin ~500m E–W × ~1000m N–S, mountain bowl around it.
 * Layout from aerial refs: south grass, east town grid, north tanks,
 * west ravine/bridge, oval yard, winding wash. Original voxel geometry.
 */
(function (global) {
  'use strict';

  const NAME = '荒盆';
  const NAME_EN = 'Scorch Basin';
  const LAYOUT = 'ridge';
  const MAP_KEY = 'island-conquest';

  /* ------------------------------------------------------------------ *
   * 编辑器地形覆盖层
   *
   * 地形本体是下面那些闭式函数；覆盖层（js/maps/island-conquest-terrain.js，由
   * F8 关卡编辑器写入）叠在它之上。三个入口：heightAtMeters 加高度偏移、
   * isWater/isLand 查轮廓覆盖。
   *
   * 覆盖层为空（未编辑过）时 overlay() 返回 null，全部走原路径 —— 行为和加这层
   * 之前逐字节相同。scripts/check-map-terrain.js 会验这一点。
   * ------------------------------------------------------------------ */
  /**
   * 当前生效的覆盖层，未编辑过则返回 null。
   *
   * **这个函数在最热的路径上** —— worldgen 要采样 1024² 个格子，每格会经过
   * heightAtMeters / isLand / isWater 共三到四次覆盖层查询，也就是四百万次调用。
   * 所以结果按 raw 对象的身份缓存：命中时只是两次属性读 + 一次引用比较。
   *
   * 缓存在两种情况下失效：VF.MAP_TERRAIN[MAP_KEY] 换了对象（数据文件重新加载、
   * 编辑器保存后 commit），或者 MapTerrain 的 blank 状态变了（编辑器第一笔刷下去
   * 时，笔刷会调 MT.touch）。后者靠比对 isBlank 的当前值兜住 —— isBlank 自己也
   * 有缓存，所以这仍然是 O(1)。
   */
  function overlay() {
    const MT = global.VF && global.VF.MapTerrain;
    if (!MT) return null;
    // 必须每次都问 MT.get() —— reset() 会换成一个新的 live 对象，缓存住引用就会
    // 读到已经撤销的地形。get() 自己是 O(1) 的（内部按 raw 引用命中）。
    const live = MT.get(MAP_KEY);
    if (!live) return null;
    // 快路径：只读一个属性。_blankCache 是 MapTerrain 有意公开的契约 ——
    // true=已知空、false=已知非空、null=刚被 touch() 过，要重新判定。
    const cached = live._blankCache;
    if (cached === true) return null;
    if (cached === false) return live;
    return MT.isBlank(live) ? null : live;
  }

  /** 轮廓覆盖：0 继承 / 1 强制水 / 2 强制陆地。 */
  function contourAt(x, z) {
    const data = overlay();
    if (!data) return 0;
    return global.VF.MapTerrain.waterAt(data, x, z);
  }

  const HQ = {
    ally: { nx: 0.4, nz: 0.08, gate: '+z' },
    enemy: { nx: 0.52, nz: 0.92, gate: '-z' },
  };

  // All flags start neutral. Letters follow the deploy map, not east-west sort.
  const FLAGS = [
    { letter: 'A', nx: 0.518, nz: 0.212, owner: 'neutral' },
    { letter: 'B', nx: 0.699, nz: 0.359, owner: 'neutral' },
    { letter: 'C', nx: 0.625, nz: 0.547, owner: 'neutral' },
    { letter: 'D', nx: 0.32, nz: 0.547, owner: 'neutral' },
    { letter: 'E', nx: 0.55, nz: 0.781, owner: 'neutral' },
    { letter: 'F', nx: 0.34, nz: 0.74, owner: 'neutral' },
  ];

  function basinU(nx, nz) {
    const rx = 0.29 + 0.016 * Math.sin(nx * 17 + nz * 9);
    const rz = 0.49 + 0.018 * Math.sin(nz * 11 - nx * 8);
    const ux = (nx - 0.5) / rx;
    const uz = (nz - 0.5) / rz;
    return Math.sqrt(ux * ux + uz * uz);
  }

  function edgeNoise(x, z) {
    return Math.sin(x * 0.041 + z * 0.037) * 0.035 + Math.sin(x * 0.09 - z * 0.07) * 0.02;
  }

  function landDist(x, z, size) {
    return basinU(x / size, z / size) + edgeNoise(x, z);
  }

  function isLand(x, z, size) {
    // 强制水也算陆地（可游玩范围内），和闭式解一致：isWater ⊂ isLand。
    if (contourAt(x, z)) return true;
    return landDist(x, z, size) < 1;
  }

  function isBank(x, z, size) {
    if (!isLand(x, z, size)) return false;
    const d = landDist(x, z, size);
    return d > 0.78;
  }

  function riverNx(nz) {
    return 0.455 + 0.055 * Math.sin(nz * 11.2) + 0.02 * Math.sin(nz * 23.5);
  }

  function isWater(x, z, size) {
    return isWaterWith(x, z, size, contourAt(x, z));
  }

  /**
   * isWater 的内部形式，轮廓值由调用方传入。
   *
   * heightAtMeters 本来要 contourAt 一次、再经 isWater 又查一次 —— 在 worldgen
   * 的 1024² 循环里那是两百万次多余查询。这里把它省掉。
   */
  function isWaterWith(x, z, size, contour) {
    if (contour === 1) return true;
    if (contour === 2) return false;
    const nx = x / size;
    const nz = z / size;
    if (landDist(x, z, size) >= 1) return false; // = !isLand，contour 已知为 0
    const river = Math.abs(nx - riverNx(nz)) < 0.011 && nz > 0.11 && nz < 0.88;
    const ravine = Math.abs(nx - 0.325) < 0.028 && nz > 0.29 && nz < 0.43;
    const northPool = (nx - 0.5) * (nx - 0.5) / 0.018 / 0.018 + (nz - 0.9) * (nz - 0.9) / 0.012 / 0.012 < 1;
    const southPool = (nx - 0.36) * (nx - 0.36) / 0.018 / 0.018 + (nz - 0.12) * (nz - 0.12) / 0.01 / 0.01 < 1;
    return river || ravine || northPool || southPool;
  }

  /**
   * Walk-on-top height in meters, quantized to 10cm.
   *
   * 结构：程序高度（闭式解，钳在 [8.4, 62]）+ 编辑器高度偏移，最后统一钳在
   * TOP_MIN..TOP_MAX 并重新量化到 10cm。
   *
   * 这里是**唯一的高度钳位点** —— 边界刻意取在另外两处钳位的内侧，让它们永远
   * 不触发，生成路径和编辑器增量路径因此永远产出同一个值：
   *
   *   _buildHeightTerrain (voxel-world.js) gy 钳 [6, height-8] = [6, 93]，
   *     但 terrainH 写的是**未钳位**的 surfH。所以 surfH 必须让
   *     round(surfH)-1 自然落在 [6,93] 内，否则两份数组当场不一致
   *     （assertTerrainColumn 会抛 'Terrain column desynchronized'）。
   *     → surfH ∈ [6.5, 94.49]
   *   setTerrainTop (terrain-fine.js) 钳 [1.1, height-2] = [1.1, 99]
   *
   * 取 [7, 90]：下界比 6.5 留了余量，上界给摆件（上限 96 = height-5）和结构体
   * 留了 6m。
   */
  const TOP_MIN = 7;
  const TOP_MAX = 90;
  function heightAtMeters(x, z, size) {
    const nx = x / size;
    const nz = z / size;
    const d = landDist(x, z, size);
    // 覆盖层解析一次，下面的轮廓判断和高度偏移共用（各自再查一遍就是双倍开销）。
    const ovData = overlay();
    const contour = ovData ? global.VF.MapTerrain.waterAt(ovData, x, z) : 0;
    let h = 12.4 + nz * 1.6 + nx * 0.4;
    h += 2.2 * Math.exp(-Math.pow((nx - 0.52) / 0.1, 2) - Math.pow((nz - 0.21) / 0.08, 2));
    h -= 1.6 * Math.exp(-Math.pow((nx - 0.7) / 0.09, 2) - Math.pow((nz - 0.36) / 0.08, 2));
    h += 1.1 * Math.exp(-Math.pow((nx - 0.62) / 0.1, 2) - Math.pow((nz - 0.55) / 0.09, 2));
    h += 2.8 * Math.exp(-Math.pow((nx - 0.32) / 0.08, 2) - Math.pow((nz - 0.55) / 0.1, 2));
    h += 2.4 * Math.exp(-Math.pow((nx - 0.55) / 0.1, 2) - Math.pow((nz - 0.78) / 0.08, 2));
    h += Math.sin(x * 0.07) * 0.35 + Math.sin(z * 0.055 + x * 0.03) * 0.3;

    // 山脊斜坡。刷成「强制陆地」的格子跳过它 —— 这一行就是轮廓编辑真正生效的
    // 地方：不跳过的话，盆地外每格都被 +22m 抬到山上去，高度笔刷在那儿刷不出
    // 平地（笔刷的偏移量会被这个斜坡吃掉）。
    if (d > 1 && contour !== 2) {
      const over = Math.min(1.8, d - 1);
      h = Math.max(h, 26) + over * 22 + Math.abs(Math.sin(x * 0.033 + z * 0.029)) * 9;
    } else if (d > 0.62 && contour !== 2) {
      const t = (d - 0.62) / 0.38;
      h += t * t * 16;
    }
    if (isWaterWith(x, z, size, contour)) h -= 0.3;
    if (h < 8.4) h = 8.4;
    if (h > 62) h = 62;

    if (ovData) {
      const off = global.VF.MapTerrain.heightOffsetAt(ovData, x, z);
      if (off) h += off;
    }
    if (h < TOP_MIN) h = TOP_MIN;
    if (h > TOP_MAX) h = TOP_MAX;
    return Math.round(h * 10) / 10;
  }

  function heightAt(x, z, size) {
    const top = heightAtMeters(x, z, size);
    let gy = Math.round(top) - 1;
    if (gy < 6) gy = 6;
    if (gy > 90) gy = 90;
    return gy;
  }

  function worldOf(size, nx, nz) {
    return { x: size * nx, z: size * nz };
  }

  function nudgeLand(world, x, z) {
    const size = world.worldSize;
    if (isLand(x, z, size) && !isWater(x, z, size)) return { x: x, z: z };
    for (let s = 4; s <= 80; s += 4) {
      const cands = [
        [x + s, z],
        [x - s, z],
        [x, z + s],
        [x, z - s],
        [x + s, z + s],
        [x - s, z - s],
        [x + s, z - s],
        [x - s, z + s],
      ];
      for (let i = 0; i < cands.length; i++) {
        const cx = cands[i][0];
        const cz = cands[i][1];
        if (cx < 16 || cz < 16 || cx >= size - 16 || cz >= size - 16) continue;
        if (isLand(cx, cz, size) && !isWater(cx, cz, size)) return { x: cx, z: cz };
      }
    }
    return { x: x, z: z };
  }

  // Must match Bases._buildBaseStructure: half=30, pad extends half+1.
  const VEHICLE_POOL = {
    baseHalf: 30,
    padOuter: 31,
    armorAlong: 42,
    jeepAlong: 54,
  };
  VEHICLE_POOL.slots = [
    { type: 'tank', along: VEHICLE_POOL.armorAlong, lateral: 0 },
    { type: 'ifv', along: VEHICLE_POOL.armorAlong, lateral: -14 },
    { type: 'ifv', along: VEHICLE_POOL.armorAlong, lateral: 14 },
    { type: 'jeep', along: VEHICLE_POOL.jeepAlong, lateral: -20 },
    { type: 'jeep', along: VEHICLE_POOL.jeepAlong, lateral: -8 },
    { type: 'jeep', along: VEHICLE_POOL.jeepAlong, lateral: 8 },
    { type: 'jeep', along: VEHICLE_POOL.jeepAlong, lateral: 20 },
  ];

  function yawForGate(gate) {
    if (gate === '+z') return Math.PI;
    if (gate === '-z') return 0;
    if (gate === '+x') return -Math.PI / 2;
    return Math.PI / 2;
  }

  function gatePoint(base, along, lateral) {
    const gate = (base && base.gate) || '+z';
    const x = base && base.x != null ? base.x : 0;
    const z = base && base.z != null ? base.z : 0;
    if (gate === '+z') return { x: x + lateral, z: z + along };
    if (gate === '-z') return { x: x + lateral, z: z - along };
    if (gate === '+x') return { x: x + along, z: z + lateral };
    return { x: x - along, z: z + lateral };
  }

  function nudgeOutsideGate(world, base, along, lateral) {
    const size = world && world.worldSize ? world.worldSize : 1024;
    const minAlong = VEHICLE_POOL.padOuter + 6;
    const tryAt = function (nextAlong, nextLateral) {
      const p = gatePoint(base, nextAlong, nextLateral);
      if (p.x < 16 || p.z < 16 || p.x >= size - 16 || p.z >= size - 16) return null;
      if (!isLand(p.x, p.z, size) || isWater(p.x, p.z, size)) return null;
      return p;
    };
    let found = tryAt(along, lateral);
    if (found) return found;
    for (let ds = 2; ds <= 24; ds += 2) {
      const cands = [
        [along, lateral + ds],
        [along, lateral - ds],
        [along + ds, lateral],
        [along + ds, lateral + ds],
        [along + ds, lateral - ds],
      ];
      for (let i = 0; i < cands.length; i++) {
        if (cands[i][0] < minAlong) continue;
        found = tryAt(cands[i][0], cands[i][1]);
        if (found) return found;
      }
    }
    return gatePoint(base, along, lateral);
  }

  function buildVehicleSpawns(world) {
    const size = world && world.worldSize ? world.worldSize : 1024;
    const planned = world && world._plannedBases;
    const bases =
      planned && planned.length >= 2
        ? planned
        : [
            { x: size * HQ.ally.nx, z: size * HQ.ally.nz, gate: HQ.ally.gate },
            { x: size * HQ.enemy.nx, z: size * HQ.enemy.nz, gate: HQ.enemy.gate },
          ];
    const teams = ['ally', 'enemy'];
    const spawns = [];
    for (let side = 0; side < teams.length; side++) {
      const team = teams[side];
      const base = {
        x: bases[side].x,
        z: bases[side].z,
        gate: bases[side].gate || (team === 'ally' ? HQ.ally.gate : HQ.enemy.gate),
      };
      const yaw = yawForGate(base.gate);
      const counts = { jeep: 0, ifv: 0, tank: 0 };
      for (let i = 0; i < VEHICLE_POOL.slots.length; i++) {
        const slot = VEHICLE_POOL.slots[i];
        const p = nudgeOutsideGate(world, base, slot.along, slot.lateral);
        const padR = slot.type === 'jeep' ? 6 : 8;
        if (world && world._clearVehiclePad) world._clearVehiclePad(p.x, p.z, padR);
        counts[slot.type] += 1;
        spawns.push({
          id: team + '-' + slot.type + '-' + counts[slot.type],
          type: slot.type,
          team: team,
          x: p.x,
          z: p.z,
          yaw: yaw,
          gate: base.gate,
        });
      }
    }
    return spawns;
  }

  function buildAiSpawns(world) {
    const size = world && world.worldSize ? world.worldSize : 1024;
    const planned = world && world._plannedBases;
    const bases =
      planned && planned.length >= 2
        ? planned
        : [
            { x: size * HQ.ally.nx, z: size * HQ.ally.nz, gate: HQ.ally.gate },
            { x: size * HQ.enemy.nx, z: size * HQ.enemy.nz, gate: HQ.enemy.gate },
          ];
    const aiAlly = [];
    const aiEnemy = [];
    const pushRing = function (list, cx, cz, n, r0, r1) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const r = r0 + ((i % 3) / 2) * (r1 - r0);
        const x = cx + Math.cos(a) * r;
        const z = cz + Math.sin(a) * r;
        if (!isLand(x, z, size) || isWater(x, z, size)) continue;
        list.push({ x: x, z: z, cx: x, cz: z });
      }
    };
    const pushYard = function (list, base) {
      const gate = (base && base.gate) || '+z';
      let ox = 0;
      let oz = 0;
      if (gate === '+z') oz = 1;
      else if (gate === '-z') oz = -1;
      else if (gate === '+x') ox = 1;
      else ox = -1;
      pushRing(list, base.x + ox * 8, base.z + oz * 8, 14, 5, 13);
      pushRing(list, base.x + ox * 16, base.z + oz * 16, 12, 5, 11);
    };
    pushYard(aiAlly, {
      x: bases[0].x,
      z: bases[0].z,
      gate: bases[0].gate || HQ.ally.gate,
    });
    pushYard(aiEnemy, {
      x: bases[1].x,
      z: bases[1].z,
      gate: bases[1].gate || HQ.enemy.gate,
    });
    return { ally: aiAlly, enemy: aiEnemy };
  }

  function applyLayout(world) {
    const size = world.worldSize;
    world._mapLayout = LAYOUT;
    world._mapName = NAME;
    world._mapNameEn = NAME_EN;
    world._mapBiome = 'desert';
    const a = worldOf(size, HQ.ally.nx, HQ.ally.nz);
    const e = worldOf(size, HQ.enemy.nx, HQ.enemy.nz);
    world._plannedBases = [
      { x: a.x, z: a.z, gate: HQ.ally.gate },
      { x: e.x, z: e.z, gate: HQ.enemy.gate },
    ];
    world._plannedLandmarks = [];
  }

  function nearAny(px, pz, pts, r) {
    const r2 = r * r;
    for (let i = 0; i < pts.length; i++) {
      const dx = px - pts[i].x;
      const dz = pz - pts[i].z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }

  function paintRoads(world, flags) {
    if (!world._paintRoadLine) return;
    const size = world.worldSize;
    const hqA = world._plannedBases[0];
    const hqE = world._plannedBases[1];
    world._paintRoadLine(hqA.x, hqA.z + 18, flags[0].x, flags[0].z, 4);
    world._paintRoadLine(flags[0].x, flags[0].z, flags[1].x, flags[1].z, 4);
    world._paintRoadLine(flags[1].x, flags[1].z, flags[2].x, flags[2].z, 4);
    world._paintRoadLine(flags[2].x, flags[2].z, flags[4].x, flags[4].z, 4);
    world._paintRoadLine(flags[4].x, flags[4].z, hqE.x, hqE.z - 18, 4);
    world._paintRoadLine(flags[2].x, flags[2].z, flags[3].x, flags[3].z, 4);
    world._paintRoadLine(flags[3].x, flags[3].z, flags[5].x, flags[5].z, 4);
    world._paintRoadLine(flags[5].x, flags[5].z, flags[4].x, flags[4].z, 3);

    const x0 = size * 0.5;
    const x1 = size * 0.73;
    const z0 = size * 0.34;
    const z1 = size * 0.6;
    const cell = 28;
    for (let x = x0; x <= x1 + 1; x += cell) {
      world._paintRoadLine(x, z0, x, z1, 3);
    }
    for (let z = z0; z <= z1 + 1; z += cell) {
      world._paintRoadLine(x0, z, x1, z, 3);
    }
    const loopX = size * 0.74;
    const loopZ = size * 0.47;
    const steps = 24;
    let px = loopX + 22;
    let pz = loopZ;
    for (let i = 1; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const nx = loopX + Math.cos(a) * 22;
      const nz = loopZ + Math.sin(a) * 16;
      world._paintRoadLine(px, pz, nx, nz, 3);
      px = nx;
      pz = nz;
    }
  }

  function stampTown(world, flags, keepers) {
    if (!world._placeWarehouse) return;
    const size = world.worldSize;
    const x0 = size * 0.5;
    const z0 = size * 0.34;
    const cell = 28;
    const kinds = ['warehouse', 'house', 'warehouse', 'house', 'container'];
    for (let gx = 0; gx < 8; gx++) {
      for (let gz = 0; gz < 9; gz++) {
        const cx = x0 + gx * cell + 14;
        const cz = z0 + gz * cell + 14;
        if (!isLand(cx, cz, size) || isWater(cx, cz, size)) continue;
        if (world._isBaseKeepClear && world._isBaseKeepClear(cx, cz, 18)) continue;
        if (nearAny(cx, cz, keepers, 36)) continue;
        const kind = kinds[(gx * 3 + gz) % kinds.length];
        const w = kind === 'house' ? 12 : kind === 'container' ? 10 : 16;
        const d = kind === 'container' ? 4 : 12;
        const h = kind === 'house' ? 8 : kind === 'container' ? 3 : 7;
        const ox = Math.floor(cx - w / 2);
        const oz = Math.floor(cz - d / 2);
        if (kind === 'house' && world._placeHouse) world._placeHouse(ox, oz, w, d);
        else if (kind === 'container' && world._placeContainer) world._placeContainer(ox, oz, w, d, h);
        else world._placeWarehouse(ox, oz, w, d, h);
      }
    }

    const west = [
      [0.22, 0.38, 14, 12, 7, 'warehouse'],
      [0.24, 0.48, 12, 11, 6, 'house'],
      [0.27, 0.52, 10, 4, 3, 'container'],
      [0.23, 0.62, 15, 12, 7, 'warehouse'],
      [0.26, 0.68, 12, 11, 6, 'house'],
      [0.36, 0.64, 10, 4, 3, 'container'],
      [0.38, 0.22, 12, 11, 6, 'house'],
      [0.44, 0.18, 14, 12, 7, 'warehouse'],
      [0.48, 0.26, 10, 4, 3, 'container'],
      [0.6, 0.7, 16, 12, 8, 'warehouse'],
      [0.66, 0.74, 12, 11, 6, 'house'],
      [0.58, 0.84, 14, 12, 7, 'warehouse'],
      [0.64, 0.86, 12, 11, 6, 'house'],
    ];
    for (let i = 0; i < west.length; i++) {
      const b = west[i];
      const p = nudgeLand(world, size * b[0], size * b[1]);
      if (world._isBaseKeepClear && world._isBaseKeepClear(p.x, p.z, b[2])) continue;
      if (nearAny(p.x, p.z, keepers, 36)) continue;
      const ox = Math.floor(p.x - b[2] / 2);
      const oz = Math.floor(p.z - b[3] / 2);
      if (b[5] === 'house' && world._placeHouse) world._placeHouse(ox, oz, b[2], b[3]);
      else if (b[5] === 'container' && world._placeContainer) world._placeContainer(ox, oz, b[2], b[3], b[4]);
      else world._placeWarehouse(ox, oz, b[2], b[3], b[4]);
    }
  }

  function stampLandmarks(world, flags) {
    const size = world.worldSize;
    if (world._placeTank) {
      const tanks = [
        [0.545, 0.695],
        [0.585, 0.695],
        [0.545, 0.735],
        [0.585, 0.735],
      ];
      for (let i = 0; i < tanks.length; i++) {
        const p = nudgeLand(world, size * tanks[i][0], size * tanks[i][1]);
        world._placeTank(p.x, p.z, 9, 13);
      }
    }
    if (world._placeStadium) {
      const p = nudgeLand(world, size * 0.73, size * 0.3);
      world._placeStadium(p.x, p.z, 26, 38);
    }
    if (world._placeBridge) {
      world._placeBridge(size * 0.29, size * 0.36, size * 0.37, size * 0.36, 5);
    }
    if (world._placeShrub) {
      for (let i = 0; i < 140; i++) {
        const nx = 0.28 + ((i * 17) % 47) / 90;
        const nz = 0.12 + ((i * 29) % 71) / 90;
        const x = size * nx;
        const z = size * nz;
        if (!isLand(x, z, size) || isWater(x, z, size)) continue;
        if (nearAny(x, z, flags, 22)) continue;
        if (landDist(x, z, size) > 0.82) continue;
        world._placeShrub(x, z);
      }
    }
  }

  /**
   * Place baked .vox props (VF.Props).
   *
   * Deliberately UNGUARDED: whatever the artist placed in the prop editor gets
   * stamped. The old base-keepclear / near-flag guards silently dropped ~4% of
   * the map (every flag had a 36m dead zone), which was impossible to diagnose
   * from the editor — the editor calls Props.stamp directly, so the prop showed
   * up there and then vanished in a real match. Props now claim their footprint
   * (world.claimPropArea) and the later terrain stages respect the claim.
   */
  function stampVoxProps(world) {
    if (!global.VF.Props || !global.VF.Props.stamp) return;
    const size = world.worldSize;
    const placed = resolveVoxProps();
    for (let i = 0; i < placed.length; i++) {
      const item = placed[i];
      const prop = global.VF.PROPS && global.VF.PROPS[item.id];
      if (!prop) continue;
      const p = nudgeLand(world, size * item.nx, size * item.nz);
      global.VF.Props.stamp(world, item.id, { cx: p.x, cz: p.z, yaw: item.yaw });
    }
  }

  /**
   * 摆件布局的唯一来源：VF.MAP_PROPS['island-conquest']，由游戏内关卡编辑器
   * （js/level-editor.js，F8）写入 js/maps/island-conquest-props.js。
   * 位置不要写死在这里 —— 用编辑器摆完 Ctrl+S 保存。
   */
  function resolveVoxProps() {
    const mapProps = global.VF.MAP_PROPS && global.VF.MAP_PROPS[MAP_KEY];
    if (!Array.isArray(mapProps)) return [];
    return mapProps.map(function (m) {
      return { id: m.id, nx: m.nx, nz: m.nz, yaw: m.yaw || 0 };
    });
  }

  /**
   * 程序化预制体（民房/多层楼/摩天楼/废墟/工厂/高架桥），同样由关卡编辑器写入
   * js/maps/island-conquest-props.js（和 .vox 摆件同一个文件，两个键）。
   *
   * 在 stampVoxProps **之前**执行：.vox 摆件是美术手工资产，重叠时应该压过程序
   * 预制体。而且预制体不 claimPropArea，摆件会 claim —— 顺序反了的话摆件的
   * claim 保不住它自己的地基。
   */
  function stampPrefabs(world) {
    if (!world.stampEditorPrefab) return;
    const size = world.worldSize;
    const list = global.VF.MAP_PREFABS && global.VF.MAP_PREFABS[MAP_KEY];
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item || !item.kind) continue;
      const p = nudgeLand(world, size * item.nx, size * item.nz);
      world.stampEditorPrefab(item.kind, p.x, p.z, item.yaw || 0);
    }
  }

  function buildRepairStations(world) {
    const size = world && world.worldSize ? world.worldSize : 1024;
    const planned = world && world._plannedBases;
    const bases =
      planned && planned.length >= 2
        ? planned
        : [
            { x: size * HQ.ally.nx, z: size * HQ.ally.nz, gate: HQ.ally.gate },
            { x: size * HQ.enemy.nx, z: size * HQ.enemy.nz, gate: HQ.enemy.gate },
          ];
    const radius = 18;
    const center = nudgeLand(world, size * 0.4, size * 0.5);
    const stations = [
      {
        id: 'repair-center',
        team: 'neutral',
        x: center.x,
        z: center.z,
        radius: radius,
      },
    ];
    const teams = ['ally', 'enemy'];
    for (let side = 0; side < teams.length; side++) {
      const team = teams[side];
      const base = {
        x: bases[side].x,
        z: bases[side].z,
        gate: bases[side].gate || (team === 'ally' ? HQ.ally.gate : HQ.enemy.gate),
      };
      const p = nudgeOutsideGate(world, base, 78, 0);
      stations.push({
        id: 'repair-' + team,
        team: team,
        x: p.x,
        z: p.z,
        radius: radius,
      });
    }
    return stations;
  }

  function stampRepairStations(world, stations) {
    if (!world || !stations) return;
    for (let i = 0; i < stations.length; i++) {
      const s = stations[i];
      if (world._placeArmorRepairCenter) {
        const placed = world._placeArmorRepairCenter(s.x, s.z, s.team);
        if (placed) {
          s.x = placed.x;
          s.z = placed.z;
          s.y = placed.y;
        }
      } else if (world._clearVehiclePad) {
        world._clearVehiclePad(s.x, s.z, 3);
      }
    }
  }

  function stamp(world) {
    if (!world) return;
    const size = world.worldSize;
    applyLayout(world);

    const flags = [];
    for (let i = 0; i < FLAGS.length; i++) {
      const f = FLAGS[i];
      const p = nudgeLand(world, size * f.nx, size * f.nz);
      const gy = world._surface ? world._surface(Math.floor(p.x), Math.floor(p.z)) : 9;
      flags.push({
        kind: 'flag',
        letter: f.letter,
        owner: f.owner,
        x: p.x,
        z: p.z,
        cx: p.x,
        cz: p.z,
        y: gy + 1,
      });
    }
    world._kitFlags = flags;
    const g = global.VF && global.VF.game;
    if (g) g._mapKitFlags = flags.slice();

    paintRoads(world, flags);
    const repairStations = buildRepairStations(world);
    stampTown(
      world,
      flags,
      flags.concat(world._plannedBases || []).concat(repairStations)
    );
    stampLandmarks(world, flags);
    // Props LAST among the terrain stages: procedural decor (tanks, stadium,
    // bridge, shrubs) would otherwise carve into an authored building. Later
    // stages that still run (flag plazas, vehicle pads, base rebuild) all
    // consult world.isPropClaimed().
    stampPrefabs(world);
    stampVoxProps(world);

    if (world._clearFlagPlaza) {
      for (let i = 0; i < flags.length; i++) {
        const gy = world._clearFlagPlaza(flags[i].x, flags[i].z, 24);
        flags[i].y = (gy || world._surface(Math.floor(flags[i].x), Math.floor(flags[i].z))) + 1;
      }
    }

    const aiSpawns = buildAiSpawns(world);
    world._aiSpawns = aiSpawns;
    if (g) g._mapKitAiSpawns = { ally: aiSpawns.ally.slice(), enemy: aiSpawns.enemy.slice() };

    const vehicleSpawns = buildVehicleSpawns(world);
    world._vehicleSpawns = vehicleSpawns;
    if (g) g._mapKitVehicleSpawns = vehicleSpawns.slice();

    stampRepairStations(world, repairStations);
    world._armorRepairStations = repairStations;
    if (g) g._mapKitRepairStations = repairStations.slice();
  }

  const api = {
    name: NAME,
    nameEn: NAME_EN,
    layout: LAYOUT,
    mapKey: MAP_KEY,
    biome: 'desert',
    TOP_MIN: TOP_MIN,
    TOP_MAX: TOP_MAX,
    HQ: HQ,
    FLAGS: FLAGS,
    isLand: isLand,
    isBank: isBank,
    isWater: isWater,
    heightAt: heightAt,
    heightAtMeters: heightAtMeters,
    landDist: landDist,
    applyLayout: applyLayout,
    stamp: stamp,
    VEHICLE_POOL: VEHICLE_POOL,
    buildVehicleSpawns: buildVehicleSpawns,
    buildAiSpawns: buildAiSpawns,
    buildRepairStations: buildRepairStations,
  };

  global.VF = global.VF || {};
  global.VF.IslandConquestMap = api;
  global.VF.MatchConquestMap = api;
})(typeof window !== 'undefined' ? window : this);
