/*
 * check-level-editor.js — 关卡编辑器增量写入通道的集成断言（不需要浏览器）。
 *
 *   node scripts/check-level-editor.js
 *
 * check-map-terrain.js 验的是采样器本身（纯函数）。这里验的是**它和真实
 * VoxelWorld 接在一起还对不对** —— 也就是"编辑器改控制点 → setTerrainTop →
 * blocks/groundY/terrainH 三份数据一致"这条链。
 *
 * 为什么值得单独一个脚本：地形有三份平行数据（blocks 体素、groundY 整数列高、
 * terrainH 浮点行走面），任何一处不同步都会在游戏里变成"人卡在半空/掉进地里"
 * 或者"地形网格有洞"。terrain-fine.js 提供了 assertTerrainColumn 来抓这个，
 * 这里就是拿它当断言逐格扫。
 *
 * 建真实世界很慢（1024² × ~14 层体素填充 + 网格化），所以用一个缩小的世界：
 * 覆盖同样的代码路径，跑几秒钟。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

let checks = 0;
function ok(condition, message) {
  checks++;
  if (!condition) throw new Error(message);
}

/**
 * 从源码里原样抠出一个顶层函数声明（含函数体）。
 *
 * 用途：level-editor.js 是浏览器 IIFE，要 document / indexedDB / THREE，整体加载
 * 不现实。但笔刷那几个函数是纯计算的，抠出来配几个桩就能跑 —— 而且跑的是**真
 * 代码**，不是这里重写的一份影子实现（那种测试只会证明影子是对的）。
 *
 * 靠数大括号找结尾。函数体里的字符串/正则里若有不配对的大括号会数错，笔刷这几个
 * 函数没有；真出问题会立刻在 vm 里语法错误，不会静默通过。
 */
function extractFn(src, name) {
  const head = 'function ' + name + '(';
  const start = src.indexOf(head);
  if (start < 0) throw new Error('源码里找不到函数 ' + name);
  let i = src.indexOf('{', start);
  if (i < 0) throw new Error(name + ' 没有函数体');
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(name + ' 的大括号不配对');
}

/* ------------------------------------------------------------------ *
 * THREE 桩。voxel-world / terrain-fine 只用到几何体和 Object3D。
 * ------------------------------------------------------------------ */
function makeThree() {
  class Vector3 {
    constructor(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new Vector3(this.x, this.y, this.z); }
    addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
    length() { return Math.hypot(this.x, this.y, this.z); }
    normalize() { const l = this.length() || 1; this.x /= l; this.y /= l; this.z /= l; return this; }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    applyEuler() { return this; }
  }
  // 区块网格化（_rebuildChunk）会用 Color 做顶点色，所以要凑齐 r/g/b + 链式方法
  class Color {
    constructor(v) { this.r = 0; this.g = 0; this.b = 0; if (v != null) this.setHex(v); }
    setHex(v) {
      this.r = ((v >> 16) & 0xff) / 255;
      this.g = ((v >> 8) & 0xff) / 255;
      this.b = (v & 0xff) / 255;
      return this;
    }
    getHex() {
      return (Math.round(this.r * 255) << 16) | (Math.round(this.g * 255) << 8) | Math.round(this.b * 255);
    }
    copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
    clone() { const c = new Color(); return c.copy(this); }
    multiplyScalar(s) { this.r *= s; this.g *= s; this.b *= s; return this; }
    set(v) { return typeof v === 'number' ? this.setHex(v) : this.copy(v); }
  }
  class BufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.count = array.length / itemSize; }
  }
  class Float32BufferAttribute extends BufferAttribute {
    constructor(a, i) { super(a instanceof Float32Array ? a : new Float32Array(a), i); }
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
    constructor() {
      this.children = []; this.position = new Vector3();
      this.rotation = { x: 0, y: 0, z: 0, set() {} };
      this.scale = new Vector3(1, 1, 1); this.userData = {};
      this.visible = true; this.matrix = {}; this.parent = null;
    }
    add(c) { if (c) { this.children.push(c); c.parent = this; } return this; }
    remove(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parent = null; } return this; }
    traverse(fn) { fn(this); for (const c of this.children) if (c.traverse) c.traverse(fn); }
    updateMatrix() {} updateMatrixWorld() {} lookAt() {}
  }
  class Mesh extends Object3D {
    constructor(g, m) { super(); this.geometry = g; this.material = m; this.castShadow = false; this.receiveShadow = false; }
    // 真实 THREE 里 Mesh 和 InstancedMesh 都有这个（_stampShallowWater 会调）
    computeBoundingSphere() {}
    raycast() {}
  }
  class InstancedMesh extends Mesh {
    constructor(g, m, count) { super(g, m); this.count = count; this.instanceMatrix = { needsUpdate: false }; this.instanceColor = null; }
    setMatrixAt() {} setColorAt() {}
  }
  function material(params) {
    const m = Object.assign({ side: 0, needsUpdate: false }, params || {});
    m.dispose = function () {};
    m.clone = function () { return material(Object.assign({}, m)); };
    if (m.color != null && typeof m.color === 'number') m.color = new Color(m.color);
    return m;
  }
  return {
    Color, Vector3, BufferAttribute, Float32BufferAttribute, BufferGeometry,
    Object3D, Group: Object3D, Mesh, InstancedMesh,
    Box3: class { constructor() { this.min = new Vector3(); this.max = new Vector3(); } },
    MeshLambertMaterial: material, MeshBasicMaterial: material, MeshStandardMaterial: material,
    BoxGeometry: BufferGeometry, CylinderGeometry: BufferGeometry,
    PlaneGeometry: BufferGeometry, RingGeometry: BufferGeometry,
    Quaternion: class { set() { return this; } setFromAxisAngle() { return this; } setFromEuler() { return this; } },
    Matrix4: class { makeRotationY() { return this; } compose() { return this; } identity() { return this; } },
    Euler: class { constructor() {} set() { return this; } },
    Raycaster: class { setFromCamera() {} },
    Vector2: class { constructor(x, y) { this.x = x || 0; this.y = y || 0; } },
    DoubleSide: 2, FrontSide: 0,
    MathUtils: { degToRad: (d) => (d * Math.PI) / 180 },
  };
}

function makeContext(files) {
  const THREE = makeThree();
  const win = { VF: {}, THREE: THREE, devicePixelRatio: 1, addEventListener() {} };
  const context = {
    window: win,
    THREE: THREE,
    document: {
      createElement: () => ({ getContext: () => null, style: {}, addEventListener() {} }),
      addEventListener() {},
      getElementById: () => null,
      head: { appendChild() {} },
      body: { appendChild() {}, classList: { add() {}, remove() {} } },
      readyState: 'complete',
    },
    console: console,
    performance: { now: () => Date.now() },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    indexedDB: { open: () => ({}) },
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
  return { context, VF: win.VF, THREE: THREE };
}

/**
 * 缩小世界。真实的 1024² 建一次要好几秒，这里用 CHUNK_SIZE × 8 = 128。
 * voxel-world.js 把尺寸写死成模块常量，所以构造完之后重新铺一遍数组 —— 走的还是
 * _buildHeightTerrain 的真实代码路径，只是范围小。
 */
function buildSmallWorld(VF, THREE, size) {
  const W = Object.create(VF.VoxelWorld.prototype);
  W.scene = new THREE.Object3D();
  W.chunkSize = 16;
  W.worldChunks = size / 16;
  W.worldSize = size;
  W.height = 101;
  W.blocks = new Uint8Array(size * W.height * size);
  W.groundY = new Int8Array(size * size);
  W.terrainH = new Float32Array(size * size);
  W._lodCamX = size * 0.5;
  W._lodCamZ = size * 0.5;
  W._blockDurability = new Map();
  W.chunkMeshes = new Map();
  W.props = [];
  W.rooftops = [];
  W.buildings = [];
  W.skyBridges = [];
  W.ziplines = [];
  W.stairVoxels = new Set();
  W.mapSeed = 0;
  W._noiseSeed = 0;
  W._dirtyChunks = new Set();
  W._lodDirtyChunks = new Set();
  W._meshStats = { lastFlushMs: 0, lastFlushCount: 0, fine: 0, mid: 0, far: 0 };
  W._deathStains = [];
  // clone() 是必需的：terrain-fine._buildTerrainChunkMesh 会克隆它做地形材质，
  // 缺了会静默退回 1m 体素网格 —— 那样就测不到真正的 10cm 高度场路径了。
  W._chunkMat = { dispose() {}, clone() { return W._chunkMat; }, vertexColors: true };
  W._colorCache = {};
  W._propPt = new THREE.Vector3();
  W.group = new THREE.Object3D();
  W._mapLayout = 'ridge';
  W._plannedLandmarks = [];
  W._plannedBases = [];
  W._kitFlags = [];
  W._shallowWater = [];
  return W;
}

/* ------------------------------------------------------------------ *
 * 加载 index.html 里那一串（顺序照抄），外加 terrain-fine（它 attach 到原型上）
 * ------------------------------------------------------------------ */
const loaded = makeContext([
  'js/voxel-world.js',
  'js/maps/map-terrain.js',
  'js/maps/island-conquest-terrain.js',
  'js/maps/island-conquest-props.js',
  'js/maps/island-conquest.js',
  'js/terrain-fine.js',
]);
const VF = loaded.VF;
const MT = VF.MapTerrain;
const MAP = VF.IslandConquestMap;
const BLOCK = VF.BLOCK;
const MAP_KEY = 'island-conquest';

ok(VF.VoxelWorld, 'VoxelWorld 没加载');
ok(MT, 'MapTerrain 没加载');
ok(MAP, 'IslandConquestMap 没加载');
ok(
  typeof VF.VoxelWorld.prototype.setTerrainTop === 'function',
  'terrain-fine.js 没有 attach 到 VoxelWorld 原型（setTerrainTop 缺失）'
);
ok(MAP.mapKey === MAP_KEY, 'IslandConquestMap.mapKey 不对：' + MAP.mapKey);

// index.html 的脚本顺序必须保证 map-terrain 在 island-conquest 之前
(function checkScriptOrder() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const at = function (p) {
    const i = html.indexOf(p);
    ok(i >= 0, 'index.html 里找不到 ' + p);
    return i;
  };
  const terrainSampler = at('js/maps/map-terrain.js');
  const terrainData = at('js/maps/island-conquest-terrain.js');
  const consumer = at('js/maps/island-conquest.js');
  const voxel = at('js/voxel-world.js');
  ok(terrainSampler < consumer, 'map-terrain.js 必须在 island-conquest.js 之前');
  ok(terrainData < consumer, 'island-conquest-terrain.js 必须在 island-conquest.js 之前');
  ok(voxel < terrainSampler, 'voxel-world.js 必须在 map-terrain.js 之前（BLOCK 常量）');
  ok(html.indexOf('js/level-editor.js') > consumer, 'level-editor.js 应该在最后加载');
  ok(html.indexOf('js/prop-editor.js') < 0, 'index.html 还在引用已重命名的 js/prop-editor.js');
})();

const SIZE = 128;

/** 建一个只有地形的小世界（不跑 island.stamp —— 那会摆房子/旗点，干扰断言）。 */
function freshWorld() {
  const W = buildSmallWorld(VF, loaded.THREE, SIZE);
  W._buildHeightTerrain(MAP);
  return W;
}

/**
 * terrainH 是 Float32Array —— 存 46.4 读回来是 46.400001525878906。所以所有
 * 高度比较都用这个容差，而不是 1e-6。float32 在 ~100 量级的相对精度约 6e-6，
 * 0.001 足够宽松，又远小于 10cm 量化步长（不会掩盖真正的一格错位）。
 */
const F32_EPS = 0.001;

/** 逐格断言三份数据一致。这是本脚本存在的理由。 */
function assertColumns(W, label) {
  for (let z = 1; z < SIZE - 1; z++) {
    for (let x = 1; x < SIZE - 1; x++) {
      if (!W.assertTerrainColumn(x, z)) {
        const i = z * SIZE + x;
        throw new Error(
          label + '：地形三份数据不一致 @(' + x + ',' + z + ') ' +
          'terrainH=' + W.terrainH[i] + ' groundY=' + W.groundY[i] +
          ' block@groundY=' + W.get(x, W.groundY[i], z)
        );
      }
    }
  }
  checks++;
}

/* ------------------------------------------------------------------ *
 * 1. 生成路径本身自洽（基线）
 * ------------------------------------------------------------------ */
(function baseline() {
  MT.reset(MAP_KEY);
  const W = freshWorld();
  assertColumns(W, '空覆盖层的生成结果');

  // terrainH 必须等于 heightAtMeters，groundY 必须等于 round-1
  for (let z = 2; z < SIZE - 2; z += 3) {
    for (let x = 2; x < SIZE - 2; x += 3) {
      const i = z * SIZE + x;
      const want = MAP.heightAtMeters(x, z, SIZE);
      ok(
        Math.abs(W.terrainH[i] - want) < F32_EPS,
        'terrainH 和 heightAtMeters 不一致 @(' + x + ',' + z + ')：' + W.terrainH[i] + ' vs ' + want
      );
      ok(
        W.groundY[i] === Math.round(want) - 1,
        'groundY 不等于 round(top)-1 @(' + x + ',' + z + ')'
      );
    }
  }
})();

/* ------------------------------------------------------------------ *
 * 2. 增量路径：改控制点 → setTerrainTop → 三份数据仍然一致
 *
 * 这是编辑器 repaintHeightBox() 做的事情。用几种极端形状，因为
 * setTerrainTop 有"不能抬进已有结构体"的分支，只测平缓抬升会漏掉它。
 * ------------------------------------------------------------------ */
(function incrementalHeight() {
  const shapes = [
    { name: '整片抬升 +8m', fn: (d) => d.h.fill(80) },
    { name: '整片下沉 -6m', fn: (d) => d.h.fill(-60) },
    { name: '推到上限', fn: (d) => d.h.fill(MT.H_MAX) },
    { name: '推到下限', fn: (d) => d.h.fill(MT.H_MIN) },
    {
      name: '棋盘极值（相邻控制点差 180m）',
      fn: (d) => {
        for (let i = 0; i < d.h.length; i++) {
          d.h[i] = (i + Math.floor(i / d.cells)) % 2 ? MT.H_MAX : MT.H_MIN;
        }
      },
    },
    {
      // 尖峰要落在缩小世界内部（网格覆盖 1024m，测试世界只有 SIZE 米）
      name: '单点尖峰',
      fn: (d) => {
        d.h.fill(0);
        const g = Math.floor(SIZE * 0.5 / d.step);
        d.h[g * d.cells + g] = MT.H_MAX;
      },
    },
  ];

  for (const shape of shapes) {
    MT.reset(MAP_KEY);
    const W = freshWorld();
    const data = MT.get(MAP_KEY);
    shape.fn(data);
    // 直接改数组绕过了笔刷，所以要手动让 isBlank 缓存失效 —— 编辑器里
    // applyHeightBrush 等函数内部会做这件事。
    MT.touch(data);

    // 编辑器 repaintHeightBox 的循环
    let changed = 0;
    for (let z = 1; z < SIZE - 1; z++) {
      for (let x = 1; x < SIZE - 1; x++) {
        const target = MAP.heightAtMeters(x, z, SIZE);
        if (W.setTerrainTop(x, z, target, { deferDirty: true, protect: false })) changed++;
      }
    }
    ok(changed > 0, shape.name + '：setTerrainTop 一格都没改动（笔刷不会生效）');
    assertColumns(W, '增量写入后（' + shape.name + '）');

    // 增量的结果必须和"直接重新生成"一致 —— 否则保存后刷新页面地形会跳。
    const regen = freshWorld();
    let mismatch = 0;
    let worst = 0;
    for (let z = 1; z < SIZE - 1; z++) {
      for (let x = 1; x < SIZE - 1; x++) {
        const i = z * SIZE + x;
        const d = Math.abs(W.terrainH[i] - regen.terrainH[i]);
        if (d > F32_EPS) {
          mismatch++;
          if (d > worst) worst = d;
        }
      }
    }
    ok(
      mismatch === 0,
      shape.name + '：增量写入和重新生成的地形不一致（' + mismatch +
      ' 格，最大差 ' + worst.toFixed(2) + 'm）—— 保存后刷新会跳变'
    );
  }
  MT.reset(MAP_KEY);
})();

/* ------------------------------------------------------------------ *
 * 3. 材质覆盖：生成路径和增量路径产出同一个表面块
 * ------------------------------------------------------------------ */
(function materialOverlay() {
  MT.reset(MAP_KEY);
  const data = MT.get(MAP_KEY);
  const paint = BLOCK.ASPHALT;
  data.mat.fill(paint);
  MT.touch(data);

  const W = freshWorld();
  // 生成路径：_buildHeightTerrain 应该已经把表面刷成 paint
  let painted = 0;
  for (let z = 2; z < SIZE - 2; z += 2) {
    for (let x = 2; x < SIZE - 2; x += 2) {
      const gy = W.groundY[z * SIZE + x];
      if (W.get(x, gy, z) === paint) painted++;
    }
  }
  ok(painted > 100, '材质覆盖没有在生成路径生效（只有 ' + painted + ' 格）');
  assertColumns(W, '材质覆盖后');

  // 覆盖成 0（不覆盖）应该回到程序材质，且不是 AIR
  data.mat.fill(0);
  MT.touch(data);
  const W2 = freshWorld();
  let air = 0;
  for (let z = 2; z < SIZE - 2; z += 2) {
    for (let x = 2; x < SIZE - 2; x += 2) {
      const gy = W2.groundY[z * SIZE + x];
      if (W2.get(x, gy, z) === BLOCK.AIR) air++;
    }
  }
  ok(air === 0, '清除材质覆盖后有 ' + air + ' 格地表变成空气');
  MT.reset(MAP_KEY);
})();

/* ------------------------------------------------------------------ *
 * 4. 轮廓覆盖：强制水/陆地不会破坏三份数据一致性
 * ------------------------------------------------------------------ */
(function contourOverlay() {
  for (const v of [MT.WATER_FORCE_WET, MT.WATER_FORCE_LAND]) {
    MT.reset(MAP_KEY);
    const data = MT.get(MAP_KEY);
    data.water.fill(v);
    MT.touch(data);
    const W = freshWorld();
    assertColumns(W, '轮廓覆盖 ' + v + ' 后');
  }
  MT.reset(MAP_KEY);
})();

/* ------------------------------------------------------------------ *
 * 5. 摆件不变量：地形笔刷不能把地面抬到摆件高度上限之上
 *
 * prop-stamp.js 拒绝 world.height - H - 4 < 1 的摆件。地形最高 TOP_MAX=90，
 * 也就是 groundY 最高 89，那么摆件最多还能有 101-89-4 = 8 米。这条断言的作用是：
 * 如果以后有人把 TOP_MAX 调高，会立刻在这里失败，而不是等到美术发现某个摆件
 * "摆不上去"。
 * ------------------------------------------------------------------ */
(function propHeadroom() {
  const worldH = 101;
  const maxGy = Math.round(MAP.TOP_MAX) - 1;
  const headroom = worldH - maxGy - 4;
  ok(
    headroom >= 8,
    '地形上限 TOP_MAX=' + MAP.TOP_MAX + ' 时摆件只剩 ' + headroom +
    ' 米高度余量，太矮了。要么降 TOP_MAX，要么明确接受高摆件不能放在最高处。'
  );
})();

/* ------------------------------------------------------------------ *
 * 6. 预制体接线：stampPrefabs 真的会读 VF.MAP_PREFABS
 * ------------------------------------------------------------------ */
(function prefabWiring() {
  const src = fs.readFileSync(path.join(root, 'js/maps/island-conquest.js'), 'utf8');
  ok(src.indexOf('MAP_PREFABS') >= 0, 'island-conquest.js 没有读 VF.MAP_PREFABS');

  // 顺序：预制体必须在 .vox 摆件之前（摆件要 claim 自己的地基）。
  // 只看 stamp() 函数体内的**调用**，不看文件里的函数定义位置 —— 定义顺序无关。
  const bodyStart = src.indexOf('function stamp(world)');
  ok(bodyStart > 0, 'island-conquest.js 里找不到 stamp(world)');
  const body = src.slice(bodyStart);
  const callPrefabs = body.indexOf('stampPrefabs(world);');
  const callProps = body.indexOf('stampVoxProps(world);');
  ok(callPrefabs > 0, 'stamp() 里没有调用 stampPrefabs');
  ok(callProps > 0, 'stamp() 里没有调用 stampVoxProps');
  ok(
    callPrefabs < callProps,
    'stampPrefabs 必须在 stampVoxProps 之前 —— 否则摆件的 footprint claim 保不住'
  );

  MT.reset(MAP_KEY);
  const W = freshWorld();
  W._noise = VF.VoxelWorld.prototype._noise.bind(W);
  W._rngState = 1;
  const before = W.blocks.reduce((a, v) => a + (v ? 1 : 0), 0);
  const rec = W.stampEditorPrefab('house', SIZE * 0.5, SIZE * 0.5, 0);
  ok(rec && rec.kind === 'house', 'stampEditorPrefab("house") 没有返回记录');
  const after = W.blocks.reduce((a, v) => a + (v ? 1 : 0), 0);
  ok(after > before, 'stampEditorPrefab 没有往世界里写任何体素');
  MT.reset(MAP_KEY);
})();

/* ------------------------------------------------------------------ *
 * 7. 编辑器源码层面的约定（改坏了会静默出问题的几条）
 * ------------------------------------------------------------------ */
(function editorSourceContracts() {
  const src = fs.readFileSync(path.join(root, 'js/level-editor.js'), 'utf8');
  ok(src.indexOf('global.VF.LevelEditor = {') >= 0, 'level-editor.js 没有导出 VF.LevelEditor');
  ok(
    src.indexOf('global.VF.PropEditor = global.VF.LevelEditor') >= 0,
    '旧名 VF.PropEditor 的别名没了 —— 漏改的引用会静默失效'
  );
  // 笔刷必须绕过保护圈，否则地图一大半刷不动
  ok(
    src.indexOf('protect: false') >= 0,
    '笔刷没有传 protect:false —— _terrainCellProtected 会拒绝基地/旗点/摆件附近的所有格子'
  );
  // 增量写入必须延迟标脏再统一 dirtyRect，否则每格一次 remesh
  ok(
    src.indexOf('deferDirty: true') >= 0,
    '笔刷没有用 deferDirty —— 每格都会触发一次区块标脏'
  );
  // 滑杆不能靠 syncHud 刷新（会打断拖动）
  const sliderBlock = src.slice(src.indexOf("querySelector('#pe-radius')"));
  ok(
    sliderBlock.slice(0, 400).indexOf('syncHud()') < 0,
    '半径滑杆的 input 处理器里调了 syncHud —— 整块 innerHTML 重建会打断拖动'
  );

  const mainSrc = fs.readFileSync(path.join(root, 'js/main.js'), 'utf8');
  ok(mainSrc.indexOf('VF.PropEditor') < 0, 'main.js 还在用旧名 VF.PropEditor');
  ok(mainSrc.indexOf('VF.LevelEditor.update(dt)') >= 0, 'main.js 没有每帧调 LevelEditor.update');
  ok(
    mainSrc.indexOf('VF.MapEditor.isFps()') >= 0,
    'main.js 的 levelEditing 分支没有区分是哪个编辑器在开（会双 tick）'
  );

  // 笔刷圆环必须覆盖水域页：water 和 height/material 共用 state.brush.radius
  // （Shift+滚轮那段就是三页一起判的），漏掉它就变成"能调半径但看不见"。
  // 只看 brushing 那个赋值 —— 函数体后面 tint 分支里也有 'water'，整体 match
  // 会假通过（这条断言第一版就是这么漏的）。
  const ringFn = extractFn(src, 'updateBrushRing');
  const brushingDecl = /const brushing =([^;]*);/.exec(ringFn);
  ok(brushingDecl, 'updateBrushRing 里找不到 brushing 判断');
  for (const tool of ['height', 'material', 'water']) {
    ok(
      brushingDecl[1].indexOf("'" + tool + "'") >= 0,
      '「' + tool + '」页不显示笔刷圆环 —— updateBrushRing 的 brushing 判断漏了它'
    );
  }
  // Shift+滚轮调半径的页面集合必须和显示圆环的一致，否则又会出现
  // "能调半径但看不见调的是多大"。
  const all = src.match(/const brushing =[^;]*;/g) || [];
  ok(all.length >= 2, 'level-editor.js 里应该有两处 brushing 判断（圆环 + 滚轮）');
  for (let i = 0; i < all.length; i++) {
    for (const tool of ['height', 'material', 'water']) {
      ok(
        all[i].indexOf("'" + tool + "'") >= 0,
        '第 ' + (i + 1) + ' 处 brushing 判断漏了 ' + tool + ' —— ' +
          '圆环可见性和 Shift+滚轮调半径必须覆盖同样的页面'
      );
    }
  }
})();

/* ------------------------------------------------------------------ *
 * 7b. 笔刷圆环必须逐顶点贴地（回归：曾经是个平面圆盘）
 *
 * 旧实现是 RingGeometry + ring.position.y = 光标那一点的高度。在斜坡上就一半埋进
 * 土里一半悬空；更糟的是刷的过程中中心比边缘变化快（smoothstep 衰减），于是抬升
 * 时环整体浮起来（离相机更近 → 看着"越来越大"）、降低时环沉进地里 —— 看起来像
 * 笔刷坏了，其实地形是对的。
 *
 * 这里把 updateBrushRing 抠出来，喂一个已知斜率的地形桩，验环上顶点的 Y 真的跟着
 * 各自脚下的地形走。
 * ------------------------------------------------------------------ */
(function ringFollowsTerrain() {
  const src = fs.readFileSync(path.join(root, 'js/level-editor.js'), 'utf8');

  const consts = [];
  for (const name of ['RING_SEGMENTS', 'RING_WIDTH', 'RING_LIFT', 'RING_KEY']) {
    const m = new RegExp('const ' + name + ' = ([^;]+);').exec(src);
    ok(m, 'level-editor.js 里找不到 ' + name);
    consts.push('const ' + name + ' = ' + m[1] + ';');
  }
  const SEGMENTS = /const RING_SEGMENTS = (\d+)/.exec(src)[1] | 0;
  const LIFT = parseFloat(/const RING_LIFT = ([\d.]+)/.exec(src)[1]);

  // 已知斜率的地形：top = 10 + x * 0.5（沿 +x 每米升 0.5m）
  const slope = function (x) { return 10 + x * 0.5; };

  const n = SEGMENTS + 1;
  const arr = new Float32Array(n * 2 * 3);
  const sandbox = {
    Math: Math,
    RADIUS: 12,
    CURSOR: { x: 40, z: 40 },
    arr: arr,
    needsUpdate: 0,
    visible: null,
    tintSet: -1,
    state: {
      active: true,
      tool: 'height',
      contourValue: 1,
      brush: { radius: 12, mode: 'lower', ring: null, ringKey: null },
    },
  };
  const code =
    consts.join('\n') + '\n' +
    extractFn(src, 'updateBrushRing') + '\n' +
    'const BRUSH_TINT = { raise: 1, lower: 2, smooth: 3, flatten: 4, reset: 5, material: 6 };\n' +
    'const CONTOUR_TINT = { 0: 7, 1: 8, 2: 9 };\n' +
    'function rebuildBrushRing() { throw new Error("不该在这里重建"); }\n' +
    'function groundPoint() { return CURSOR; }\n' +
    'function world() { return { getTerrainTop: function (x) { return 10 + x * 0.5; } }; }\n' +
    'this.run = updateBrushRing;\n';
  vm.runInNewContext(code, sandbox, { filename: 'level-editor.js(ring)' });

  // 装一个假 ring，几何体已经"建好"（ringKey 命中，不会走 rebuild）
  sandbox.state.brush.ringKey = /const RING_KEY = '([^']+)'/.exec(src)[1];
  sandbox.state.brush.ring = {
    visible: false,
    material: { color: { setHex: function (v) { sandbox.tintSet = v; } } },
    geometry: {
      getAttribute: function (name) {
        return name === 'position'
          ? { array: arr, set needsUpdate(v) { sandbox.needsUpdate++; }, get needsUpdate() { return false; } }
          : null;
      },
    },
  };

  sandbox.run();
  ok(sandbox.state.brush.ring.visible === true, '圆环没有被设成可见');
  ok(sandbox.needsUpdate > 0, '改了顶点却没有设 needsUpdate —— 屏幕上不会更新');

  // 每个顶点的 Y 必须等于它自己脚下的地形高度 + RING_LIFT
  let maxErr = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n * 2; i++) {
    const x = arr[i * 3];
    const y = arr[i * 3 + 1];
    maxErr = Math.max(maxErr, Math.abs(y - (slope(x) + LIFT)));
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  ok(
    maxErr < 1e-4,
    '圆环顶点没有贴各自脚下的地形：最大误差 ' + maxErr + 'm（应为 0）'
  );
  // 斜率 0.5、半径 12 → 环跨越 ~12m 高差。全都一样高就说明又变回平面圆盘了。
  ok(
    maxY - minY > 5,
    '圆环在斜坡上是平的（高差只有 ' + (maxY - minY).toFixed(2) + 'm）—— ' +
      '又变回"整圈共用一个 Y"的平面圆盘了'
  );

  // 半径变了不该重建几何体（rebuildBrushRing 的桩会抛错）
  sandbox.state.brush.radius = 40;
  sandbox.run();
  checks += 1;

  // 环必须闭合：首尾那对顶点重合
  const last = n - 1;
  ok(
    Math.abs(arr[0] - arr[last * 6]) < 1e-6 && Math.abs(arr[2] - arr[last * 6 + 2]) < 1e-6,
    '圆环没闭合 —— 首尾顶点不重合，会缺一个缺口'
  );
})();

/* ------------------------------------------------------------------ *
 * 8. 笔刷的浮点累加器（回归：曾经整个高度笔刷是死的）
 *
 * h 层是分米整数网格，而笔刷按帧累加。默认强度 1.5m/s 在 60fps 下一帧只有
 * 0.25dm —— 直接 Math.round 写回 data.h 是 0，下一帧又从 0 算出 0.25，永远跨不
 * 过取整门槛，抬升/降低**完全没反应**。而且它依赖帧率：30fps 恰好 0.5dm 能刷。
 *
 * 所以这里不重写笔刷逻辑，而是把编辑器源码里的那几个函数**原样抠出来**跑 ——
 * 只有真代码正确才能通过。（level-editor.js 是浏览器 IIFE，要 document/
 * indexedDB，整体加载不现实。）
 * ------------------------------------------------------------------ */
(function brushAccumulator() {
  const src = fs.readFileSync(path.join(root, 'js/level-editor.js'), 'utf8');
  const parts = [
    'const strokeAcc = ' + (function () {
      const i = src.indexOf('const strokeAcc = ');
      ok(i >= 0, 'level-editor.js 里找不到 strokeAcc —— 笔刷浮点累加器没了');
      return src.slice(i + 'const strokeAcc = '.length, src.indexOf(';', i) + 1);
    })(),
    extractFn(src, 'accBegin'),
    extractFn(src, 'accGet'),
    extractFn(src, 'falloffAt'),
    extractFn(src, 'brushCellRange'),
    extractFn(src, 'brushWorldBox'),
    extractFn(src, 'applyHeightBrush'),
    // 撤销去重的逻辑就在 noteCell 里，所以它也要用真代码而不是桩。
    extractFn(src, 'beginStroke'),
    extractFn(src, 'noteCell'),
    extractFn(src, 'noteBox'),
    extractFn(src, 'endStroke'),
    'const UNDO_LIMIT = ' + (function () {
      const m = /const UNDO_LIMIT = (\d+)/.exec(src);
      ok(m, 'level-editor.js 里找不到 UNDO_LIMIT');
      return m[1] + ';';
    })(),
  ];

  /** 把抠出来的函数装进一个带桩的作用域，返回可调用的笔刷。 */
  function makeBrush(data, mode, strength, radius) {
    const sandbox = {
      MTREAL: MT,
      DATA: data,
      PROC_TOP: 12,      // proceduralTopAt 的桩：程序地形恒为 12m
      repaints: 0,
      Math: Math,
      Object: Object,
      state: {
        brush: { radius: radius, strength: strength, mode: mode, flattenTo: null },
        dirty: false,
        undo: [],
      },
    };
    const code =
      parts.join('\n') + '\n' +
      'function mapTerrain() { return MTREAL; }\n' +
      'function draftTerrain() { return DATA; }\n' +
      'function world() { return { worldSize: 1024 }; }\n' +
      'function proceduralTopAt() { return PROC_TOP; }\n' +
      'function repaintHeightBox() { repaints++; }\n' +
      'this.run = applyHeightBrush;\n' +
      'this.beginStroke = beginStroke;\n' +
      'this.acc = strokeAcc;\n';
    vm.runInNewContext(code, sandbox, { filename: 'level-editor.js(brush)' });
    sandbox.state.brush.flattenTo = null;
    /** 当前这一笔记下的 [gi, oldValue] 列表。 */
    sandbox.notedCells = function () {
      const s = sandbox.state.undo[sandbox.state.undo.length - 1];
      return s ? s.cells : [];
    };
    return sandbox;
  }

  const CELLS = 64;
  const CX = 100;
  const CZ = 100;

  /** 圆心控制点的下标（笔刷中心 falloff = 1 的那个格子）。 */
  function centreIndex(data) {
    return Math.round(CZ / data.step) * data.cells + Math.round(CX / data.step);
  }

  /** 跑 frames 帧，每帧 dt 秒。 */
  function stroke(mode, strength, radius, frames, dt, before) {
    const data = MT.blank(4, CELLS);
    if (before) before(data);
    const box = makeBrush(data, mode, strength, radius);
    box.beginStroke('h');
    if (mode === 'flatten') box.state.brush.flattenTo = box.PROC_TOP + 4; // 目标 +4m
    for (let i = 0; i < frames; i++) box.run(CX, CZ, dt);
    return { data: data, box: box };
  }

  // ── 抬升：1 秒 × 1.5m/s 应该在圆心涨 ~15dm ────────────────────────
  const raised = stroke('raise', 1.5, 12, 60, 1 / 60);
  const gi = centreIndex(raised.data);
  const got = raised.data.h[gi];
  ok(
    got !== 0,
    '默认强度 60fps 下抬升笔刷一秒没有任何改动 —— 每帧增量被 Math.round 吃掉了' +
      '（这正是浮点累加器要修的 bug）'
  );
  ok(
    Math.abs(got - 15) <= 1,
    '抬升 1 秒 × 1.5m/s 的圆心偏移应该约 15dm，实际 ' + got + 'dm'
  );

  // ── 帧率无关：30fps 跑同样的时长要得到同样的结果 ───────────────────
  const raised30 = stroke('raise', 1.5, 12, 30, 1 / 30);
  ok(
    Math.abs(raised30.data.h[gi] - got) <= 1,
    '笔刷依赖帧率：60fps 得到 ' + got + 'dm，30fps 得到 ' + raised30.data.h[gi] + 'dm'
  );

  // ── 更小的强度也要能刷动（0.2 m/s 是滑杆下限）────────────────────
  const weak = stroke('raise', 0.2, 12, 60, 1 / 60);
  ok(
    weak.data.h[gi] > 0,
    '最小强度 0.2m/s 刷一秒仍然是 0 —— 累加器没生效'
  );

  // ── 降低是抬升的镜像 ──────────────────────────────────────────────
  const lowered = stroke('lower', 1.5, 12, 60, 1 / 60);
  ok(
    lowered.data.h[gi] < 0 && Math.abs(lowered.data.h[gi] + got) <= 1,
    '降低笔刷和抬升不对称：' + lowered.data.h[gi] + ' vs -' + got
  );

  // ── 衰减：圆心改动量必须大于边缘 ──────────────────────────────────
  (function falloffShape() {
    const data = raised.data;
    const edgeGx = Math.round((CX + 10) / data.step);
    const edge = data.h[Math.round(CZ / data.step) * data.cells + edgeGx];
    ok(
      Math.abs(edge) < Math.abs(got),
      'smoothstep 衰减没生效：边缘 ' + edge + ' 不小于圆心 ' + got
    );
    // 半径外必须完全没动
    const outGx = Math.round((CX + 24) / data.step);
    ok(
      data.h[Math.round(CZ / data.step) * data.cells + outGx] === 0,
      '笔刷改动了半径之外的控制点'
    );
  })();

  // ── reset：把一片非零偏移收敛回 0 ─────────────────────────────────
  const resetRun = stroke('reset', 1.5, 12, 90, 1 / 60, function (data) {
    data.h.fill(200);
  });
  ok(
    resetRun.data.h[gi] < 200,
    '「恢复程序原状」没有把偏移拉回 0：仍是 ' + resetRun.data.h[gi]
  );

  // ── smooth：把一个尖峰抹平 ────────────────────────────────────────
  const smoothRun = stroke('smooth', 1.5, 12, 90, 1 / 60, function (data) {
    data.h[centreIndex(data)] = 600;
  });
  ok(
    smoothRun.data.h[gi] < 600,
    '「抹平」没有降低尖峰：仍是 ' + smoothRun.data.h[gi]
  );

  // ── flatten：朝锁定的目标高度收敛（目标 = 程序高度 + 4m → +40dm）──
  const flatRun = stroke('flatten', 1.5, 12, 120, 1 / 60);
  ok(
    flatRun.data.h[gi] > 20,
    '「压平到光标高度」没有朝目标偏移收敛：' + flatRun.data.h[gi] + 'dm（目标 40dm）'
  );

  // ── 累加器要钳位：按住抬升不放不能让浮点跑到 1e9 ─────────────────
  // 8m/s × 1/60s = 1.33dm/帧，1000 帧足够越过 H_MAX=900。
  const long = stroke('raise', 8, 12, 1000, 1 / 60);
  ok(
    long.box.acc.v[gi] <= MT.H_MAX,
    '浮点累加器没有钳位：' + long.box.acc.v[gi] + ' 超过 H_MAX=' + MT.H_MAX
  );
  ok(long.data.h[gi] === MT.H_MAX, '长时间抬升应该停在 H_MAX，实际 ' + long.data.h[gi]);

  // ── 撤销栈：同一个控制点在一笔里只记第一次的原值 ─────────────────
  (function undoRecordsOriginal() {
    const data = MT.blank(4, CELLS);
    data.h.fill(50);
    const box = makeBrush(data, 'raise', 1.5, 12);
    box.beginStroke('h');
    for (let i = 0; i < 60; i++) box.run(CX, CZ, 1 / 60);
    const first = box.notedCells().filter(function (n) { return n[0] === gi; });
    ok(first.length === 1, '同一个控制点在一笔里被记了 ' + first.length + ' 次原值');
    ok(first[0][1] === 50, '撤销记的不是这一笔之前的原值：' + first[0][1]);
  })();

  // ── 起新的一笔要从当前 data.h 重新播种，不能沿用上一笔的浮点进度 ──
  (function seedFromCurrent() {
    const data = MT.blank(4, CELLS);
    const box = makeBrush(data, 'raise', 1.5, 12);
    box.beginStroke('h');
    for (let i = 0; i < 60; i++) box.run(CX, CZ, 1 / 60);
    const afterFirst = data.h[gi];
    // 模拟撤销：直接把控制点改回去，再起一笔
    data.h[gi] = 0;
    box.beginStroke('h');
    box.run(CX, CZ, 1 / 60);
    ok(
      Math.abs(box.acc.v[gi]) < afterFirst,
      '新起一笔沿用了上一笔的浮点进度（' + box.acc.v[gi] + '）—— 撤销后会跳回去'
    );
  })();
})();

console.log('level-editor checks: OK (' + checks + ' 条断言)');
