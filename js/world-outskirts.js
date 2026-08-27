/**
 * world-outskirts.js — Continuous smooth volcanic hills outside the rim
 * + amber boundary veil. Visual only; air walls unchanged.
 */
(function (global) {
  'use strict';

  const DEPTH = 72;
  const STREET_Y = 9;
  const GEO = new THREE.BoxGeometry(1, 1, 1);
  const VEIL_H = 28;
  const VEIL_FADE_START = 14;
  const VEIL_FADE_END = 2;
  const VEIL_OPACITY_MAX = 0.42;
  const VEIL_COLOR = 0xc9a04a;

  const COL_EARTH = 0x6a3a28;
  const COL_OCHRE = 0x8a5a32;
  const COL_UMBER = 0x4a3028;
  const COL_ROCK = 0x3a3838;
  const COL_BASALT = 0x2a2420;
  const COL_DUST = 0x5a4840;
  const LAVA_DIM = 0xe87820;
  const LAVA_HOT = 0xffaa40;

  const PEAK_COUNT = 36;

  let _veilState = null;

  function hash01(x, z, seed) {
    const n = Math.sin(x * 12.9898 + z * 78.233 + (seed || 0) * 0.0007) * 43758.5453;
    return n - Math.floor(n);
  }

  /** Smooth value noise (bilinear) for continuous hills */
  function smoothNoise(x, z, seed) {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const fx = x - x0;
    const fz = z - z0;
    const sx = fx * fx * (3 - 2 * fx);
    const sz = fz * fz * (3 - 2 * fz);
    const n00 = hash01(x0, z0, seed);
    const n10 = hash01(x0 + 1, z0, seed);
    const n01 = hash01(x0, z0 + 1, seed);
    const n11 = hash01(x0 + 1, z0 + 1, seed);
    const a = n00 + (n10 - n00) * sx;
    const b = n01 + (n11 - n01) * sx;
    return a + (b - a) * sz;
  }

  function fbm(x, z, seed) {
    return (
      smoothNoise(x * 0.045, z * 0.045, seed) * 0.5 +
      smoothNoise(x * 0.09, z * 0.09, seed + 11) * 0.28 +
      smoothNoise(x * 0.18, z * 0.18, seed + 23) * 0.14 +
      smoothNoise(x * 0.36, z * 0.36, seed + 37) * 0.08
    );
  }

  function ringDist(x, z, size) {
    let dx = 0;
    let dz = 0;
    if (x < 0) dx = -x;
    else if (x >= size) dx = x - (size - 1);
    if (z < 0) dz = -z;
    else if (z >= size) dz = z - (size - 1);
    return Math.max(dx, dz);
  }

  /** Soft outer falloff — continuous skirt, gently ragged edge */
  function skirtMask(x, z, size, seed) {
    const d = ringDist(x, z, size);
    if (d < 1) return 0;
    const edge =
      DEPTH +
      (fbm(x * 0.8, z * 0.8, seed + 50) - 0.5) * 10 +
      Math.sin(x * 0.04) * 3 +
      Math.cos(z * 0.038) * 3;
    if (d > edge) return 0;
    // Soft fade near outer rim instead of hard cut holes
    const t = d / Math.max(1, edge);
    if (t > 0.88) return Math.max(0, 1 - (t - 0.88) / 0.12);
    return 1;
  }

  function colorForHeight(h, x, z, seed) {
    const r = fbm(x, z, seed + 4);
    if (h >= 14 && r > 0.72) return r > 0.9 ? LAVA_HOT : r > 0.8 ? LAVA_DIM : COL_BASALT;
    if (h <= 3) return r > 0.5 ? COL_OCHRE : COL_EARTH;
    if (h <= 6) return r > 0.55 ? COL_EARTH : COL_UMBER;
    if (h <= 10) return r > 0.5 ? COL_DUST : COL_UMBER;
    if (h <= 14) return r > 0.45 ? COL_ROCK : COL_DUST;
    return r > 0.4 ? COL_BASALT : COL_ROCK;
  }

  function disposeOutskirts(world) {
    if (_veilState && _veilState.root) {
      const vr = _veilState.root;
      if (vr.parent) vr.parent.remove(vr);
      vr.traverse(function (c) {
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
      });
    }
    _veilState = null;
    if (world) world._boundaryVeil = null;

    if (!world || !world._outskirts) return;
    const root = world._outskirts;
    if (root.parent) root.parent.remove(root);
    root.traverse(function (c) {
      if (c.isInstancedMesh) {
        if (c.geometry && c.geometry !== GEO) c.geometry.dispose();
        if (c.material) c.material.dispose();
      }
    });
    world._outskirts = null;
  }

  function buildBoundaryVeil(world, size) {
    const root = new THREE.Group();
    root.name = 'BoundaryVeil';
    const mats = [];
    const inset = 0.55;
    const yCenter = STREET_Y + VEIL_H * 0.35;

    function makeWall(w, h, px, py, pz, rotY) {
      const geo = new THREE.PlaneGeometry(w, h);
      const mat = new THREE.MeshBasicMaterial({
        color: VEIL_COLOR,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: true,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(px, py, pz);
      mesh.rotation.y = rotY;
      mesh.renderOrder = 2;
      root.add(mesh);
      mats.push(mat);
    }

    makeWall(size, VEIL_H, size * 0.5, yCenter, inset, 0);
    makeWall(size, VEIL_H, size * 0.5, yCenter, size - inset, 0);
    makeWall(size, VEIL_H, inset, yCenter, size * 0.5, Math.PI / 2);
    makeWall(size, VEIL_H, size - inset, yCenter, size * 0.5, Math.PI / 2);

    world.scene.add(root);
    _veilState = { mats: mats, size: size, root: root };
    world._boundaryVeil = root;
  }

  /** Soft peak contribution — wide falloff so hills blend into one range */
  function buildPeakField(size, seed) {
    const peaks = [];
    for (let i = 0; i < PEAK_COUNT; i++) {
      const side = i % 4;
      const along = hash01(i * 17, seed, seed + i);
      const depth = 8 + hash01(seed, i * 9, i) * (DEPTH - 14);
      let cx;
      let cz;
      if (side === 0) {
        cx = along * size;
        cz = -depth;
      } else if (side === 1) {
        cx = -depth;
        cz = along * size;
      } else if (side === 2) {
        cx = along * size;
        cz = size - 1 + depth;
      } else {
        cx = size - 1 + depth;
        cz = along * size;
      }
      cx += (hash01(cx, i, seed) - 0.5) * 28;
      cz += (hash01(i, cz, seed) - 0.5) * 28;
      peaks.push({
        x: cx,
        z: cz,
        h: 5 + hash01(i, seed, i + 3) * 11,
        r: 14 + hash01(seed, i, 7) * 18,
        tall: hash01(i * 3, seed + 1, i) > 0.82,
      });
    }
    // Corner blobs for continuity
    const corners = [
      [-20, -20],
      [size + 20, -18],
      [-22, size + 20],
      [size + 22, size + 22],
    ];
    for (let c = 0; c < corners.length; c++) {
      peaks.push({
        x: corners[c][0],
        z: corners[c][1],
        h: 8 + hash01(c, seed, 9) * 8,
        r: 22 + hash01(seed, c, 2) * 12,
        tall: c % 2 === 0,
      });
    }
    // Boost a few peaks a bit higher
    for (let i = 0; i < peaks.length; i++) {
      if (peaks[i].tall) {
        peaks[i].h *= 1.45;
        peaks[i].r *= 1.12;
      }
    }
    return peaks;
  }

  function peakBoost(x, z, peaks) {
    let sum = 0;
    for (let i = 0; i < peaks.length; i++) {
      const p = peaks[i];
      const dx = x - p.x;
      const dz = z - p.z;
      const d2 = dx * dx + dz * dz;
      const r2 = p.r * p.r;
      if (d2 >= r2) continue;
      const t = 1 - d2 / r2;
      const s = t * t * (3 - 2 * t);
      sum += p.h * s;
    }
    return sum;
  }

  function refreshWorldOutskirts(world) {
    if (!world || !world.scene) return null;
    disposeOutskirts(world);

    const size = world.worldSize | 0;
    const seed = (world.mapSeed || 1) >>> 0;
    const peaks = buildPeakField(size, seed);
    const byColor = {};

    // Continuous columns: [x, baseY, z, h]
    function addColumn(x, baseY, z, h, hex) {
      if (h < 1) return;
      if (!byColor[hex]) byColor[hex] = [];
      byColor[hex].push(x, baseY, z, h);
    }

    // Dense continuous heightfield (step 1) — no gaps between hills
    for (let x = -DEPTH - 8; x < size + DEPTH + 8; x++) {
      for (let z = -DEPTH - 8; z < size + DEPTH + 8; z++) {
        if (x >= 0 && x < size && z >= 0 && z < size) continue;
        const mask = skirtMask(x, z, size, seed);
        if (mask <= 0.02) continue;

        const d = ringDist(x, z, size);
        // Smooth base ramp with distance
        const ramp = 1.5 + Math.pow(Math.min(1, d / DEPTH), 0.85) * 9;
        const rolling = fbm(x, z, seed) * 5.5;
        const boost = peakBoost(x, z, peaks);
        // Blend peaks softly into the continuous ramp
        let h = (ramp + rolling + boost * 0.85) * mask;
        h = Math.max(1, Math.min(28, Math.round(h)));

        const hex = colorForHeight(h, x, z, seed);
        addColumn(x, STREET_Y - 1, z, h, hex);
      }
    }

    const root = new THREE.Group();
    root.name = 'WorldOutskirts';
    root.matrixAutoUpdate = false;
    const dummy = new THREE.Object3D();

    function addColumnInstances(arr, mat) {
      const count = (arr.length / 4) | 0;
      if (count <= 0) return;
      const mesh = new THREE.InstancedMesh(GEO, mat, count);
      mesh.frustumCulled = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      for (let i = 0; i < count; i++) {
        const x = arr[i * 4];
        const y = arr[i * 4 + 1];
        const z = arr[i * 4 + 2];
        const h = arr[i * 4 + 3];
        dummy.position.set(x + 0.5, y + h * 0.5, z + 0.5);
        dummy.scale.set(1.04, h, 1.04);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      root.add(mesh);
    }

    Object.keys(byColor).forEach(function (hexKey) {
      const hex = parseInt(hexKey, 10);
      const isLava = hex === LAVA_DIM || hex === LAVA_HOT;
      addColumnInstances(
        byColor[hexKey],
        new THREE.MeshLambertMaterial({
          color: hex,
          emissive: isLava ? hex : 0x000000,
          emissiveIntensity: isLava ? (hex === LAVA_HOT ? 0.85 : 0.5) : 0,
        })
      );
    });

    world.scene.add(root);
    world._outskirts = root;
    buildBoundaryVeil(world, size);
    return root;
  }

  function updateWorldBoundary(dt, playerPos) {
    if (!_veilState || !playerPos || !_veilState.mats) return;
    const size = _veilState.size;
    const x = playerPos.x;
    const z = playerPos.z;
    const dist = Math.min(x, z, size - x, size - z);
    let op = 0;
    if (dist < VEIL_FADE_START) {
      const t = 1 - (dist - VEIL_FADE_END) / (VEIL_FADE_START - VEIL_FADE_END);
      op = THREE.MathUtils.clamp(t, 0, 1) * VEIL_OPACITY_MAX;
    }
    if (op > 0.2) {
      op *= 0.92 + 0.08 * Math.sin(performance.now() * 0.003);
    }
    for (let i = 0; i < _veilState.mats.length; i++) {
      _veilState.mats[i].opacity = op;
      _veilState.mats[i].visible = op > 0.01;
    }
  }

  global.VF = global.VF || {};
  global.VF.refreshWorldOutskirts = refreshWorldOutskirts;
  global.VF.disposeWorldOutskirts = disposeOutskirts;
  global.VF.updateWorldBoundary = updateWorldBoundary;
})(typeof window !== 'undefined' ? window : globalThis);
