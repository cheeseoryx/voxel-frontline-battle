/**
 * island-conquest.js — Official 32v32 conquest map (裂脊谷)
 * Linear mountain pass inspired by alpine-valley conquest layouts:
 * west blue HQ, east red HQ, A–E along a winding grassy corridor,
 * high rock walls north/south. Original voxel geometry (no imported assets).
 */
(function (global) {
  'use strict';

  const NAME = '裂脊谷';
  const NAME_EN = 'Rift Ridge';
  const LAYOUT = 'ridge';

  const HQ = {
    ally: { nx: 0.06, nz: 0.5, gate: '+x' },
    enemy: { nx: 0.94, nz: 0.5, gate: '-x' },
  };

  // 640 世界上相邻旗约 210–280m（C–D ≈ 281m）。南北摆动拉开直线距。
  const FLAGS = [
    { letter: 'A', nx: 0.18, nz: 0.42, owner: 'ally' },
    { letter: 'B', nx: 0.36, nz: 0.7, owner: 'ally' },
    { letter: 'C', nx: 0.52, nz: 0.3, owner: 'neutral' },
    { letter: 'D', nx: 0.7, nz: 0.7, owner: 'enemy' },
    { letter: 'E', nx: 0.86, nz: 0.4, owner: 'enemy' },
  ];

  const VALLEY = [
    [0.0, 0.5],
    [0.06, 0.5],
    [0.18, 0.42],
    [0.36, 0.7],
    [0.52, 0.3],
    [0.7, 0.7],
    [0.86, 0.4],
    [0.94, 0.5],
    [1.0, 0.5],
  ];

  /** [nx, nz, w, d, h, kind] — kept off HQ pads and flag plazas */
  const BUILDINGS = [
    [0.14, 0.36, 15, 12, 8, 'house'],
    [0.14, 0.48, 14, 12, 8, 'house'],
    [0.22, 0.36, 12, 11, 6, 'house'],
    [0.12, 0.42, 18, 12, 8, 'warehouse'],
    [0.32, 0.62, 12, 5, 3, 'container'],
    [0.32, 0.78, 15, 12, 6, 'warehouse'],
    [0.4, 0.78, 5, 12, 3, 'container'],
    [0.48, 0.22, 18, 14, 8, 'warehouse'],
    [0.56, 0.22, 17, 12, 6, 'warehouse'],
    [0.58, 0.36, 12, 5, 5, 'container'],
    [0.66, 0.78, 15, 12, 8, 'warehouse'],
    [0.74, 0.78, 18, 14, 8, 'warehouse'],
    [0.74, 0.62, 12, 5, 5, 'container'],
    [0.9, 0.34, 15, 12, 8, 'house'],
    [0.9, 0.48, 14, 12, 8, 'house'],
    [0.82, 0.48, 17, 12, 6, 'warehouse'],
    [0.9, 0.36, 18, 12, 8, 'warehouse'],
    [0.28, 0.44, 5, 12, 3, 'container'],
    [0.62, 0.5, 12, 5, 3, 'container'],
  ];

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function smoothstep(t) {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return t * t * (3 - 2 * t);
  }

  function valleyNz(nx) {
    if (nx <= VALLEY[0][0]) return VALLEY[0][1];
    for (let i = 1; i < VALLEY.length; i++) {
      if (nx <= VALLEY[i][0]) {
        const a = VALLEY[i - 1];
        const b = VALLEY[i];
        const t = smoothstep((nx - a[0]) / (b[0] - a[0] || 1));
        return lerp(a[1], b[1], t);
      }
    }
    return VALLEY[VALLEY.length - 1][1];
  }

  function valleyHalf(nx) {
    let h = 0.155;
    const base =
      Math.exp(-Math.pow((nx - 0.06) / 0.07, 2)) + Math.exp(-Math.pow((nx - 0.94) / 0.07, 2));
    h += base * 0.05;
    h += 0.03 * Math.exp(-Math.pow((nx - 0.36) / 0.07, 2));
    h += 0.028 * Math.exp(-Math.pow((nx - 0.52) / 0.07, 2));
    h += 0.03 * Math.exp(-Math.pow((nx - 0.7) / 0.07, 2));
    h += 0.01 * Math.sin(nx * 17.0);
    return h;
  }

  function edgeNoise(x, z) {
    return Math.sin(x * 0.071 + z * 0.063) * 0.018 + Math.sin(x * 0.13 - z * 0.09) * 0.01;
  }

  function landDist(x, z, size) {
    const nx = x / size;
    const nz = z / size;
    const cz = valleyNz(nx);
    const hw = valleyHalf(nx) + edgeNoise(x, z);
    return Math.abs(nz - cz) / (hw + 0.001);
  }

  function isLand(x, z, size) {
    return landDist(x, z, size) < 1;
  }

  function isBank(x, z, size) {
    if (!isLand(x, z, size)) return false;
    const d = landDist(x, z, size);
    return d > 0.72;
  }

  /**
   * Walk-on-top height in meters, quantized to 10cm.
   * Matches old integer heightAt walk height (surface voxel Y + 1) plus 10cm steps.
   */
  function heightAtMeters(x, z, size) {
    const nx = x / size;
    const nz = z / size;
    const d = landDist(x, z, size);
    let h = 11 + nx * 1.8;
    h += 3.2 * Math.exp(-Math.pow((nx - 0.18) / 0.08, 2) - Math.pow((nz - 0.42) / 0.1, 2));
    h -= 4.8 * Math.exp(-Math.pow((nx - 0.36) / 0.09, 2) - Math.pow((nz - 0.7) / 0.1, 2));
    h += 13.5 * Math.exp(-Math.pow((nx - 0.52) / 0.075, 2) - Math.pow((nz - 0.3) / 0.085, 2));
    h += 8.2 * Math.exp(-Math.pow((nx - 0.7) / 0.075, 2) - Math.pow((nz - 0.7) / 0.09, 2));
    h += 2.4 * Math.exp(-Math.pow((nx - 0.86) / 0.08, 2) - Math.pow((nz - 0.4) / 0.1, 2));
    h += Math.sin(x * 0.12) * 0.55 + Math.sin(z * 0.1 + x * 0.04) * 0.45;
    if (d > 1) {
      const over = Math.min(1.6, d - 1);
      h = Math.max(h, 24) + over * 18 + Math.abs(Math.sin(x * 0.048 + z * 0.041)) * 7;
    } else if (d > 0.58) {
      const t = (d - 0.58) / 0.42;
      h += t * t * 12;
    }
    if (h < 8) h = 8;
    if (h > 54) h = 54;
    return Math.round((h * 1.5 + 1) * 10) / 10;
  }

  /** 1m voxel surface index (top solid cell), derived from 10cm walk height. */
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
    if (isLand(x, z, size)) return { x: x, z: z };
    for (let s = 4; s <= 60; s += 4) {
      const cands = [
        [x + s, z],
        [x - s, z],
        [x, z + s],
        [x, z - s],
        [x + s, z + s],
        [x - s, z - s],
      ];
      for (let i = 0; i < cands.length; i++) {
        const cx = cands[i][0];
        const cz = cands[i][1];
        if (cx < 12 || cz < 12 || cx >= size - 12 || cz >= size - 12) continue;
        if (isLand(cx, cz, size)) return { x: cx, z: cz };
      }
    }
    return { x: x, z: z };
  }

  function applyLayout(world) {
    const size = world.worldSize;
    world._mapLayout = LAYOUT;
    world._mapName = NAME;
    world._mapNameEn = NAME_EN;
    const a = worldOf(size, HQ.ally.nx, HQ.ally.nz);
    const e = worldOf(size, HQ.enemy.nx, HQ.enemy.nz);
    world._plannedBases = [
      { x: a.x, z: a.z, gate: HQ.ally.gate },
      { x: e.x, z: e.z, gate: HQ.enemy.gate },
    ];
    world._plannedLandmarks = [];
  }

  function paintValleyRoad(world, flags) {
    if (!world._paintRoadLine) return;
    const size = world.worldSize;
    const sample = function (n0, n1, steps) {
      const pts = [];
      for (let i = 0; i <= steps; i++) {
        const nx = n0 + ((n1 - n0) * i) / steps;
        pts.push({ x: nx * size, z: valleyNz(nx) * size });
      }
      return pts;
    };
    const segs = [
      [HQ.ally.nx, FLAGS[0].nx, 10],
      [FLAGS[0].nx, FLAGS[1].nx, 12],
      [FLAGS[1].nx, FLAGS[2].nx, 14],
      [FLAGS[2].nx, FLAGS[3].nx, 12],
      [FLAGS[3].nx, FLAGS[4].nx, 12],
      [FLAGS[4].nx, HQ.enemy.nx, 10],
    ];
    for (let s = 0; s < segs.length; s++) {
      const pts = sample(segs[s][0], segs[s][1], segs[s][2]);
      for (let i = 0; i < pts.length - 1; i++) {
        world._paintRoadLine(pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z, i % 3 === 0 ? 4 : 3);
      }
    }
    world._paintRoadLine(flags[0].x, flags[0].z, size * FLAGS[0].nx, size * valleyNz(FLAGS[0].nx), 4);
    world._paintRoadLine(flags[1].x, flags[1].z, size * FLAGS[1].nx, size * valleyNz(FLAGS[1].nx), 4);
    world._paintRoadLine(flags[2].x, flags[2].z, size * FLAGS[2].nx, size * valleyNz(FLAGS[2].nx), 4);
    world._paintRoadLine(flags[3].x, flags[3].z, size * FLAGS[3].nx, size * valleyNz(FLAGS[3].nx), 4);
    world._paintRoadLine(flags[4].x, flags[4].z, size * FLAGS[4].nx, size * valleyNz(FLAGS[4].nx), 4);
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

    paintValleyRoad(world, flags);

    if (world._placeWarehouse) {
      for (let i = 0; i < BUILDINGS.length; i++) {
        const b = BUILDINGS[i];
        const p = nudgeLand(world, size * b[0], size * b[1]);
        if (world._isBaseKeepClear && world._isBaseKeepClear(p.x, p.z, b[2])) continue;
        let nearFlag = false;
        for (let fi = 0; fi < flags.length; fi++) {
          const dx = p.x - flags[fi].x;
          const dz = p.z - flags[fi].z;
          if (dx * dx + dz * dz < 39 * 39) {
            nearFlag = true;
            break;
          }
        }
        if (nearFlag) continue;
        const ox = Math.floor(p.x - b[2] / 2);
        const oz = Math.floor(p.z - b[3] / 2);
        if (b[5] === 'house' && world._placeHouse) {
          world._placeHouse(ox, oz, b[2], b[3]);
        } else if (b[5] === 'container' && world._placeContainer) {
          world._placeContainer(ox, oz, b[2], b[3], b[4]);
        } else {
          world._placeWarehouse(ox, oz, b[2], b[3], b[4]);
        }
      }
    }

    if (world._clearFlagPlaza) {
      for (let i = 0; i < flags.length; i++) {
        const gy = world._clearFlagPlaza(flags[i].x, flags[i].z, 27);
        flags[i].y = (gy || world._surface(Math.floor(flags[i].x), Math.floor(flags[i].z))) + 1;
      }
    }

    if (world._placeBunkerYard) {
      world._placeBunkerYard(flags[2].x, flags[2].z, 26, 5);
      world._placeBunkerYard(flags[3].x, flags[3].z, 24, 4);
    }

    const aiAlly = [];
    const aiEnemy = [];
    const pushRing = function (list, cx, cz, n, r0, r1) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const r = r0 + ((i % 3) / 2) * (r1 - r0);
        const x = cx + Math.cos(a) * r;
        const z = cz + Math.sin(a) * r;
        if (!isLand(x, z, size)) continue;
        list.push({ x: x, z: z, cx: x, cz: z });
      }
    };
    pushRing(aiAlly, world._plannedBases[0].x + 21, world._plannedBases[0].z, 8, 15, 27);
    pushRing(aiEnemy, world._plannedBases[1].x - 21, world._plannedBases[1].z, 8, 15, 27);
    pushRing(aiAlly, flags[0].x, flags[0].z, 4, 12, 21);
    pushRing(aiAlly, flags[1].x, flags[1].z, 4, 12, 21);
    pushRing(aiEnemy, flags[3].x, flags[3].z, 4, 12, 21);
    pushRing(aiEnemy, flags[4].x, flags[4].z, 4, 12, 21);
    world._aiSpawns = { ally: aiAlly, enemy: aiEnemy };
    if (g) g._mapKitAiSpawns = { ally: aiAlly.slice(), enemy: aiEnemy.slice() };
  }

  const api = {
    name: NAME,
    nameEn: NAME_EN,
    layout: LAYOUT,
    HQ: HQ,
    FLAGS: FLAGS,
    isLand: isLand,
    isBank: isBank,
    heightAt: heightAt,
    heightAtMeters: heightAtMeters,
    valleyNz: valleyNz,
    landDist: landDist,
    applyLayout: applyLayout,
    stamp: stamp,
  };

  global.VF = global.VF || {};
  global.VF.IslandConquestMap = api;
  global.VF.MatchConquestMap = api;
})(typeof window !== 'undefined' ? window : this);
