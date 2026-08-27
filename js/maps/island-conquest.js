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
    const nx = x / size;
    const nz = z / size;
    if (!isLand(x, z, size)) return false;
    const river = Math.abs(nx - riverNx(nz)) < 0.011 && nz > 0.11 && nz < 0.88;
    const ravine = Math.abs(nx - 0.325) < 0.028 && nz > 0.29 && nz < 0.43;
    const northPool = (nx - 0.5) * (nx - 0.5) / 0.018 / 0.018 + (nz - 0.9) * (nz - 0.9) / 0.012 / 0.012 < 1;
    const southPool = (nx - 0.36) * (nx - 0.36) / 0.018 / 0.018 + (nz - 0.12) * (nz - 0.12) / 0.01 / 0.01 < 1;
    return river || ravine || northPool || southPool;
  }

  /**
   * Walk-on-top height in meters, quantized to 10cm.
   */
  function heightAtMeters(x, z, size) {
    const nx = x / size;
    const nz = z / size;
    const d = landDist(x, z, size);
    let h = 12.4 + nz * 1.6 + nx * 0.4;
    h += 2.2 * Math.exp(-Math.pow((nx - 0.52) / 0.1, 2) - Math.pow((nz - 0.21) / 0.08, 2));
    h -= 1.6 * Math.exp(-Math.pow((nx - 0.7) / 0.09, 2) - Math.pow((nz - 0.36) / 0.08, 2));
    h += 1.1 * Math.exp(-Math.pow((nx - 0.62) / 0.1, 2) - Math.pow((nz - 0.55) / 0.09, 2));
    h += 2.8 * Math.exp(-Math.pow((nx - 0.32) / 0.08, 2) - Math.pow((nz - 0.55) / 0.1, 2));
    h += 2.4 * Math.exp(-Math.pow((nx - 0.55) / 0.1, 2) - Math.pow((nz - 0.78) / 0.08, 2));
    h += Math.sin(x * 0.07) * 0.35 + Math.sin(z * 0.055 + x * 0.03) * 0.3;

    if (d > 1) {
      const over = Math.min(1.8, d - 1);
      h = Math.max(h, 26) + over * 22 + Math.abs(Math.sin(x * 0.033 + z * 0.029)) * 9;
    } else if (d > 0.62) {
      const t = (d - 0.62) / 0.38;
      h += t * t * 16;
    }
    if (isWater(x, z, size)) h -= 0.3;
    if (h < 8.4) h = 8.4;
    if (h > 62) h = 62;
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
    stampTown(world, flags, flags.concat(world._plannedBases || []));
    stampLandmarks(world, flags);

    if (world._clearFlagPlaza) {
      for (let i = 0; i < flags.length; i++) {
        const gy = world._clearFlagPlaza(flags[i].x, flags[i].z, 24);
        flags[i].y = (gy || world._surface(Math.floor(flags[i].x), Math.floor(flags[i].z))) + 1;
      }
    }

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
    pushRing(aiAlly, world._plannedBases[0].x, world._plannedBases[0].z + 22, 8, 15, 28);
    pushRing(aiEnemy, world._plannedBases[1].x, world._plannedBases[1].z - 22, 8, 15, 28);
    pushRing(aiAlly, flags[0].x, flags[0].z, 5, 14, 24);
    pushRing(aiAlly, flags[1].x, flags[1].z, 4, 14, 24);
    pushRing(aiEnemy, flags[4].x, flags[4].z, 5, 14, 24);
    pushRing(aiEnemy, flags[5].x, flags[5].z, 4, 14, 24);
    world._aiSpawns = { ally: aiAlly, enemy: aiEnemy };
    if (g) g._mapKitAiSpawns = { ally: aiAlly.slice(), enemy: aiEnemy.slice() };
  }

  const api = {
    name: NAME,
    nameEn: NAME_EN,
    layout: LAYOUT,
    biome: 'desert',
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
  };

  global.VF = global.VF || {};
  global.VF.IslandConquestMap = api;
  global.VF.MatchConquestMap = api;
})(typeof window !== 'undefined' ? window : this);
