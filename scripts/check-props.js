/*
 * check-props.js — Deterministic checks for baked .vox props and the exact
 * colour palette they register (js/props/prop-palette.js).
 *
 *   node scripts/check-props.js
 *
 * Loads the real browser IIFEs under vm with a minimal THREE stub, so the
 * ACTUAL mesher runs and we can prove each registered colour reaches it.
 * The colour a voxel ends up with is invisible to every other check: an id
 * with no BLOCK_COLORS entry meshes as white (voxel-world.js `COLORS[type] ||
 * 0xffffff`) without throwing, which is exactly the silent failure this
 * script exists to catch.
 *
 * Sections D–F run for EVERY prop in a fresh world, so adding an asset is
 * actually verified rather than merely not breaking the existing one.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const vox = require('./lib/vox.js');

const root = path.resolve(__dirname, '..');

function ok(condition, message) {
  if (!condition) throw new Error(message);
}

/* ------------------------------------------------------------------ *
 * Minimal THREE stub — just enough surface for _rebuildChunk and the
 * terrain heightfield mesher to run headlessly.
 * ------------------------------------------------------------------ */
function makeThree() {
  class Color {
    constructor(hex) { this.r = this.g = this.b = 0; if (hex != null) this.setHex(hex); }
    setHex(h) { this.r = ((h >> 16) & 255) / 255; this.g = ((h >> 8) & 255) / 255; this.b = (h & 255) / 255; return this; }
    set(h) { return this.setHex(h); }
    copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
    clone() { const c = new Color(); return c.copy(this); }
    multiplyScalar(s) { this.r *= s; this.g *= s; this.b *= s; return this; }
    getHex() {
      const q = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
      return (q(this.r) << 16) | (q(this.g) << 8) | q(this.b);
    }
  }
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { return this.set(v.x, v.y, v.z); }
    clone() { return new Vector3(this.x, this.y, this.z); }
    add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    addScalar() { return this; }
    sub() { return this; }
    multiplyScalar() { return this; }
    normalize() { return this; }
    length() { return 0; }
    distanceTo() { return 0; }
    setScalar() { return this; }
  }
  class Box3 {
    constructor(min, max) { this.min = min || new Vector3(); this.max = max || new Vector3(); }
    setFromPoints() { return this; }
    expandByPoint() { return this; }
    containsPoint() { return true; }
  }
  class BufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.count = array ? array.length / itemSize : 0; this.needsUpdate = false; }
    getX(i) { return this.array[i * this.itemSize]; }
    getY(i) { return this.array[i * this.itemSize + 1]; }
    getZ(i) { return this.array[i * this.itemSize + 2]; }
  }
  class Float32BufferAttribute extends BufferAttribute {
    constructor(array, itemSize) { super(array instanceof Float32Array ? array : new Float32Array(array), itemSize); }
  }
  class BufferGeometry {
    constructor() { this.attributes = {}; this.index = null; this.boundingSphere = null; }
    setAttribute(n, a) { this.attributes[n] = a; return this; }
    getAttribute(n) { return this.attributes[n]; }
    deleteAttribute(n) { delete this.attributes[n]; return this; }
    setIndex(i) { this.index = i; return this; }
    getIndex() { return this.index; }
    computeBoundingSphere() { this.boundingSphere = { center: new Vector3(), radius: 1 }; }
    computeVertexNormals() {}
    dispose() {}
    translate() { return this; }
    rotateY() { return this; }
    scale() { return this; }
  }
  class Object3D {
    constructor() { this.children = []; this.position = new Vector3(); this.rotation = { x: 0, y: 0, z: 0, set() {} }; this.scale = new Vector3(1, 1, 1); this.userData = {}; this.visible = true; this.matrix = {}; }
    add(c) { if (c) this.children.push(c); return this; }
    remove(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return this; }
    traverse(fn) { fn(this); for (const c of this.children) if (c.traverse) c.traverse(fn); }
    updateMatrix() {}
    updateMatrixWorld() {}
    lookAt() {}
  }
  class Mesh extends Object3D {
    constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; this.castShadow = false; this.receiveShadow = false; }
  }
  class InstancedMesh extends Mesh {
    constructor(g, m, count) { super(g, m); this.count = count; this.instanceMatrix = { needsUpdate: false }; this.instanceColor = null; }
    setMatrixAt() {} setColorAt() {}
  }
  function material(params) {
    const m = Object.assign({ side: 0, needsUpdate: false }, params || {});
    m.dispose = function () {};
    m.clone = function () { return material(Object.assign({}, m)); };
    return m;
  }
  return {
    Color, Vector3, Box3, BufferAttribute, Float32BufferAttribute, BufferGeometry,
    Object3D, Group: Object3D, Mesh, InstancedMesh,
    MeshLambertMaterial: material, MeshBasicMaterial: material, MeshStandardMaterial: material,
    BoxGeometry: BufferGeometry, CylinderGeometry: BufferGeometry, PlaneGeometry: BufferGeometry,
    Quaternion: class { set() { return this; } setFromAxisAngle() { return this; } },
    Matrix4: class { makeRotationY() { return this; } compose() { return this; } identity() { return this; } },
    DoubleSide: 2, FrontSide: 0, MathUtils: { degToRad: (d) => (d * Math.PI) / 180 },
  };
}

/** Load the browser modules in index.html order into one shared context. */
function makeContext(files) {
  const THREE = makeThree();
  const win = { VF: {}, THREE: THREE, devicePixelRatio: 1 };
  const context = {
    window: win,
    THREE: THREE,
    document: { createElement: () => ({ getContext: () => null, style: {} }), addEventListener() {} },
    console: console,
    performance: { now: () => Date.now() },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: () => 0,
    setTimeout: setTimeout,
    Math: Math,
  };
  context.globalThis = context;
  context.self = context;
  vm.createContext(context);
  for (const f of files) {
    vm.runInNewContext(fs.readFileSync(path.join(root, f), 'utf8'), context, { filename: f });
  }
  return { context, VF: win.VF };
}

/** The prop <script> order actually shipped in index.html. */
function propScriptsFromIndex() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const re = /<script src="(js\/props\/[^"?]+)/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function fnv(arr) {
  let h = 0x811c9dc5;
  for (let i = 0; i < arr.length; i++) {
    h ^= arr[i] & 0xff;
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function decodeRle(prop) {
  const vol = new Uint8Array(prop.w * prop.d * prop.h);
  let o = 0;
  for (let i = 0; i < prop.rle.length; i += 2) {
    vol.fill(prop.rle[i], o, o + prop.rle[i + 1]);
    o += prop.rle[i + 1];
  }
  ok(o === vol.length, 'RLE 展开长度 ' + o + ' != w*d*h ' + vol.length);
  return vol;
}

const report = {};
const scripts = propScriptsFromIndex();
ok(scripts.length > 0, 'index.html 里找不到任何 js/props/*.js');
ok(
  scripts[0] === 'js/props/prop-palette.js',
  'prop-palette.js 必须是第一个 prop 脚本（它要在任何烘焙 prop 之前注册调色板），实际: ' + scripts[0]
);

/* =========================================================== *
 * A. File shape — read the raw bundle BEFORE registration so the
 *    rle still holds 1-based shared-palette indices.
 * =========================================================== */
const raw = (function () {
  const g = { VF: {} };
  for (const f of scripts) {
    if (f.endsWith('prop-palette.js')) continue; // shape pass: no registration
    vm.runInNewContext(fs.readFileSync(path.join(root, f), 'utf8'), { window: g, globalThis: g, console: console }, { filename: f });
  }
  return g.VF;
})();
const rawPal = raw.PROP_PALETTE;
const rawProps = raw.PROPS || {};
const manifest = raw.PROP_MANIFEST || [];

ok(rawPal && Array.isArray(rawPal.pal) && rawPal.pal.length > 0, '缺少 VF.PROP_PALETTE.pal');
ok(Array.isArray(rawPal.hits) && rawPal.hits.length === rawPal.pal.length, 'pal/hits 长度不一致');
ok(new Set(rawPal.pal).size === rawPal.pal.length, '共享调色板内有重复颜色');
for (const h of rawPal.pal) ok(Number.isInteger(h) && h >= 0 && h <= 0xffffff, '共享调色板非法颜色 ' + h);
for (const v of rawPal.hits) ok(Number.isInteger(v) && v >= 1, '共享调色板非法硬度 ' + v);
const N = rawPal.pal.length;
ok(N + vox.maxGameBlockId() + 1 <= 256, '共享调色板 ' + N + ' 色会让 block id 超过 255');

const hitTable = vox.gameBreakableHits();
const solid = vox.solidPalette();

/* --- B. Durability parity on the shared palette --- */
for (let i = 0; i < N; i++) {
  const hex = rawPal.pal[i];
  const want = vox.durabilityFor(hex, solid, hitTable).hits;
  ok(
    rawPal.hits[i] === want,
    '共享色 #' + hex.toString(16).padStart(6, '0') + ' 硬度 ' + rawPal.hits[i] +
      ' != 最近材质继承值 ' + want + '（改动会影响手感，不再是纯视觉）'
  );
}

ok(Object.keys(rawProps).length > 0, '没有加载到任何 VF.PROPS');
const palUsed = new Set();
for (const id of Object.keys(rawProps)) {
  const p = rawProps[id];
  ok(p.w > 0 && p.d > 0 && p.h > 0, id + ': 尺寸非法');
  ok(Array.isArray(p.rle) && p.rle.length % 2 === 0, id + ': rle 长度必须是偶数');
  const vol = decodeRle(p);
  let solidCount = 0;
  const seen = new Set();
  for (const b of vol) if (b) { solidCount++; seen.add(b); palUsed.add(b); }
  // Pre-registration the rle carries 1-based indices into the shared palette.
  for (const b of seen) ok(b >= 1 && b <= N, id + ': 调色板下标 ' + b + ' 超出 1..' + N);
  report[id] = { mode: 'shared', solid: solidCount, ids: [...seen].sort((a, b) => a - b).join(',') };
}
// Every palette entry must be used by at least one prop (else it wastes an id).
for (let i = 1; i <= N; i++) ok(palUsed.has(i), '共享调色板第 ' + i + ' 项没被任何 prop 使用');
// Manifest and props must agree.
for (const id of Object.keys(rawProps)) ok(manifest.some((m) => m.id === id), id + ' 不在 PROP_MANIFEST');
for (const m of manifest) ok(rawProps[m.id], 'manifest 里的 ' + m.id + ' 没有对应 prop');

/* =========================================================== *
 * C. Registration, ids, budget — real load order, one context.
 * =========================================================== */
const engine = makeContext(['js/voxel-world.js'].concat(scripts));
const VF = engine.VF;
const PP = VF.PropPalette;
ok(PP, 'VF.PropPalette 未定义');
ok(VF.PROP_PALETTE && VF.PROP_PALETTE.ids, 'registerShared 没有分配共享 ids');
ok(VF.PROP_PALETTE.ids.length === N, '共享 ids 数 ' + VF.PROP_PALETTE.ids.length + ' != 调色板数 ' + N);

const baseId = PP.baseId();
ok(baseId === vox.maxGameBlockId() + 1, 'baseId ' + baseId + ' != maxGameBlockId+1 ' + (vox.maxGameBlockId() + 1));

const engineIds = new Set(Object.keys(VF.BLOCK).map((k) => VF.BLOCK[k]));
const allocated = [...PP.byHex.values()].sort((a, b) => a - b);
ok(allocated.length === PP.usedIds(), '分配数与 usedIds 不一致');
ok(allocated.length === N, '分配 id 数 ' + allocated.length + ' != 共享调色板 ' + N);
for (const id of allocated) {
  ok(id >= baseId, 'id ' + id + ' 低于 baseId ' + baseId);
  ok(id <= 255, 'id ' + id + ' 超过 Uint8Array 上限 255');
  ok(!engineIds.has(id), 'id ' + id + ' 与引擎 BLOCK 表冲突');
  ok(VF.BLOCK_COLORS[id] != null, 'id ' + id + ' 没有注册颜色');
  ok(VF.BLOCK_HITS[id] != null, 'id ' + id + ' 没有注册硬度');
}
// Contiguous, no holes.
for (let i = 0; i < allocated.length; i++) {
  ok(allocated[i] === baseId + i, 'id 不连续：期望 ' + (baseId + i) + ' 得到 ' + allocated[i]);
}
// byHex must be injective in both directions.
ok(new Set(allocated).size === PP.byHex.size, 'byHex 有重复 id');

// Post-registration every prop's rle must hold real shared ids.
const sharedIdSet = new Set(VF.PROP_PALETTE.ids);
for (const id of Object.keys(VF.PROPS)) {
  const p = VF.PROPS[id];
  ok(p.ids === VF.PROP_PALETTE.ids, id + ': prop.ids 未指向共享 ids');
  const vol = decodeRle(p);
  for (const b of vol) if (b) ok(sharedIdSet.has(b), id + ': rle 含非共享 id ' + b);
}

// Reusing an engine id for a matching hex would be a trap (WATER/GLASS/SMOKE
// are excluded by _isSolid), so we always allocate fresh. Warn if a hex collides.
const engineHexes = new Set(Object.keys(VF.BLOCK_COLORS).filter((k) => +k < baseId).map((k) => VF.BLOCK_COLORS[k]));
const hexClash = [...PP.byHex.keys()].filter((h) => engineHexes.has(h));

/* =========================================================== *
 * D. Mesher reachability + E. terrain-fill invariant.
 *
 * EVERY prop, each in its own fresh world. This used to test
 * `Object.keys(VF.PROPS)[0]` only, which meant a newly added asset was never
 * stamped, never meshed, and never checked against the terrain-fill invariant
 * — the suite passed while saying nothing about the thing that just changed.
 * A fresh world per prop is required because the breakability test below is
 * destructive and because two props would otherwise fight over the same site.
 * =========================================================== */
let meshReached = 0;
for (const propId of Object.keys(VF.PROPS)) {
  const prop = VF.PROPS[propId];
  const world = new VF.VoxelWorld(new engine.context.THREE.Group());

  const cx = 512;
  const cz = 512;
  const gy = world._surface ? world._surface(cx, cz) : 9;
  // Flat, dry ground so the stamp is not rejected and heights are predictable.
  // The pad must clear the prop's own footprint with margin, so scale the
  // flattened area to the model instead of assuming a fixed 60.
  const flat = Math.max(prop.w, prop.d) + 20;
  for (let z = cz - flat; z <= cz + flat; z++) {
    for (let x = cx - flat; x <= cx + flat; x++) {
      if (x < 1 || z < 1 || x >= world.worldSize - 1 || z >= world.worldSize - 1) continue;
      if (world.groundY) world.groundY[z * world.worldSize + x] = gy;
      if (world.terrainH) world.terrainH[z * world.worldSize + x] = gy + 1;
    }
  }

  // A model taller than world.height - 5 cannot be placed at all (see the
  // two-sided clamp in prop-stamp.js). Catch that here rather than letting the
  // stamp-returned-null assertion below blame the terrain.
  ok(
    prop.h <= world.height - 5,
    propId + ': 高 ' + prop.h + ' 米超过世界高度上限 ' + (world.height - 5) +
      ' 米，摆放会被拒绝（会被埋进地下且不可破坏）'
  );

  const placed = VF.Props.stamp(world, propId, { cx: cx, cz: cz, yaw: 0 });
  ok(placed, propId + ': stamp 返回 null（被水/边界/高度拒绝？）');

  // The real ids this prop actually uses (post-registration decode).
  const usedIds = new Set();
  { const vol = decodeRle(prop); for (const b of vol) if (b) usedIds.add(b); }

  // E. every prop voxel must sit strictly above groundY, else _isTerrainFill
  //    marks it natural terrain and breakBlock refuses to break it.
  let above = 0;
  let atOrBelow = 0;
  for (let y = 0; y < world.height; y++) {
    for (let z = placed.oz; z < placed.oz + placed.d; z++) {
      for (let x = placed.ox; x < placed.ox + placed.w; x++) {
        const t = world.get(x, y, z);
        if (!usedIds.has(t)) continue;
        if (y > (world.groundY ? world.groundY[z * world.worldSize + x] : gy)) above++;
        else atOrBelow++;
      }
    }
  }
  ok(atOrBelow === 0, propId + ': 有 ' + atOrBelow + ' 个 prop 体素落在 groundY 及以下 → 会被判为地形填充，打不坏也不渲染');
  ok(above > 0, propId + ': 没有任何 prop 体素被写入世界');

  // Mesh every chunk the stamp touched, with the real mesher.
  const cs = world.chunkSize;
  for (let ccz = Math.floor(placed.oz / cs); ccz <= Math.floor((placed.oz + placed.d) / cs); ccz++) {
    for (let ccx = Math.floor(placed.ox / cs); ccx <= Math.floor((placed.ox + placed.w) / cs); ccx++) {
      world._rebuildChunk(ccx, ccz);
    }
  }

  // COLORS[type] || 0xffffff — white in the cache means a stamped id had no
  // colour registered. _colorCache is keyed by hex, so it is a faithful record
  // of exactly which colours the mesher actually resolved.
  ok(
    world._colorCache[0xffffff] === undefined,
    propId + ': mesher 回落到白色：有 block id 没有 BLOCK_COLORS 条目'
  );
  for (const id of usedIds) {
    const hex = VF.BLOCK_COLORS[id];
    ok(hex != null, propId + ': id ' + id + ' 没有注册颜色');
    ok(world._colorCache[hex] !== undefined,
      propId + ': 颜色 #' + hex.toString(16).padStart(6, '0') + ' 没有到达 mesher');
    meshReached++;
  }
  report[propId].meshedColors = usedIds.size;

  /* --- F. idempotency (before the destructive break test below, which would
   *        otherwise show up as a re-stamp "difference") --- */
  const sumBefore = fnv(prop.rle);
  const nextBefore = PP.nextId();
  PP.registerShared();
  PP.registerShared();
  ok(fnv(prop.rle) === sumBefore, propId + ': 重复 registerShared 改写了 rle');
  ok(PP.nextId() === nextBefore, propId + ': 重复 registerShared 又分配了 id');

  // Stamping twice at the same spot must be a no-op (match restart path).
  const snap = [];
  for (let z = placed.oz; z < placed.oz + placed.d; z++) {
    for (let x = placed.ox; x < placed.ox + placed.w; x++) {
      for (let y = gy; y < gy + prop.h + 2; y++) snap.push(world.get(x, y, z));
    }
  }
  VF.Props.stamp(world, propId, { cx: cx, cz: cz, yaw: 0 });
  let k = 0;
  let drift = 0;
  for (let z = placed.oz; z < placed.oz + placed.d; z++) {
    for (let x = placed.ox; x < placed.ox + placed.w; x++) {
      for (let y = gy; y < gy + prop.h + 2; y++) if (snap[k++] !== world.get(x, y, z)) drift++;
    }
  }
  ok(drift === 0, propId + ': 同点二次 stamp 产生了 ' + drift + ' 格差异（开局重来会不一致）');

  /* --- breakability: a 3-hit shared colour THIS prop uses must survive two
   *     hits. Picking the palette's first 3-hit colour would silently skip the
   *     test for any prop that happens not to use it. Destructive, so last. --- */
  const hardIdx = VF.PROP_PALETTE.hits.findIndex(
    (h, i) => h === 3 && usedIds.has(VF.PROP_PALETTE.ids[i])
  );
  if (hardIdx >= 0) {
    const targetId = VF.PROP_PALETTE.ids[hardIdx];
    let found = null;
    for (let y = world.height - 1; y >= 0 && !found; y--) {
      for (let z = placed.oz; z < placed.oz + placed.d && !found; z++) {
        for (let x = placed.ox; x < placed.ox + placed.w && !found; x++) {
          if (world.get(x, y, z) === targetId) found = { x, y, z };
        }
      }
    }
    ok(found, propId + ': 找不到 3 击材质的体素');
    ok(world.breakBlock(found.x, found.y, found.z) === false, propId + ': 3 击材质第 1 枪就破了');
    ok(world.breakBlock(found.x, found.y, found.z) === false, propId + ': 3 击材质第 2 枪就破了');
    ok(world.breakBlock(found.x, found.y, found.z) === true, propId + ': 3 击材质第 3 枪没破');
    report[propId].breakTested = true;
  }
}

/* =========================================================== *
 * G. Synthetic stress — registerShared and the 255 ceiling.
 * =========================================================== */
{
  const s = makeContext(['js/voxel-world.js', 'js/props/prop-palette.js']);
  const P = s.VF.PropPalette;
  const mk = (n) => ({ w: 1, d: 1, h: n, rle: Array.from({ length: n }, (_, i) => [i + 1, 1]).flat() });

  s.VF.PROP_PALETTE = { pal: [0x111111, 0x222222, 0x333333], hits: [2, 2, 2] };
  s.VF.PROPS = { synth: mk(3) };
  const before = P.usedIds();
  const ids = P.registerShared();
  ok(ids && ids.length === 3, 'registerShared 应分配 3 个 id，实际 ' + (ids && ids.length));
  ok(P.usedIds() - before === 3, 'registerShared 分配了 ' + (P.usedIds() - before) + ' 个 id，期望 3');
  ok(s.VF.PROPS.synth.rle[0] === ids[0], 'registerShared 没有把 rle 改写为真实 id');

  // Ceiling: ask for far more colours than remain.
  s.VF.PROP_PALETTE = { pal: [], hits: [] };
  for (let i = 0; i < 300; i++) { s.VF.PROP_PALETTE.pal.push(0x010000 + i); s.VF.PROP_PALETTE.hits.push(2); }
  s.VF.PROPS = { big: mk(300) };
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  const bigIds = P.registerShared();
  console.error = realErr;
  ok(bigIds && bigIds.length === 300, '溢出时仍应为每项返回一个 id');
  for (const id of bigIds) {
    ok(Number.isInteger(id) && id > 0 && id <= 255, '溢出时产出了非法 id ' + id);
  }
  ok(P.nextId() <= 256, 'nextId 超过 256');
  ok(errs.length > 0, 'id 耗尽时没有报错日志');
}

console.log(
  JSON.stringify(
    {
      ok: true,
      props: report,
      idBase: baseId,
      idsUsed: PP.usedIds(),
      idsFree: PP.freeIds(),
      mesherColorsReached: meshReached,
      propsDeepTested: Object.keys(VF.PROPS).length,
      hexClashWithEngine: hexClash.map((h) => '#' + h.toString(16).padStart(6, '0')),
      checks:
        'shape, durability parity, id budget, mesher reachability, ' +
        'terrain-fill, breakability, idempotency, shared-palette, 255 ceiling ' +
        '(D–F run per prop, each in a fresh world)',
    },
    null,
    2
  )
);
