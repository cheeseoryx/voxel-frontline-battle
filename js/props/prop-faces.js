/**
 * prop-faces.js — 块面微缩纹理（face texture）运行时。
 *
 * 烘焙侧（scripts/lib/glb-voxelize.js）给每个暴露面烘一张 texel² 的微缩图，
 * 内容去重后打进一张图集；本模块负责在运行时把图集贴回体素表面：
 *
 *   · 解码 VF.PROP_FACE_ATLAS → THREE.DataTexture（Nearest + sRGB）
 *   · 把图集挂到 voxel-world 的 chunk 材质上（mat.map）
 *   · 提供 per-voxel 面槽位的读写（world._faceSlots）
 *   · 提供「世界面 f 的角点 uv → 图集 uv」的换算，含 yaw 旋转
 *
 * 关键约定
 *   面序 [ +Y, -Y, +X, -X, +Z, -Z ]，与 voxel-world.js _rebuildChunk 的
 *   faces[]、scripts/lib/glb-voxelize.js 的 FACE_DIRS 完全一致。
 *
 *   面切向基 FACE_UV[f] = [U, V]：texel(0,0) 落在 U、V 的**负端**。
 *   这是 bake 端 `a = ((i+0.5)/FC - 0.5) * voxel` 的直接结果（i=0 → U 负端）。
 *
 *   图集槽 0 恒为纯白。没有面纹理的方块一律指向槽 0：
 *   顶点色 × 白 = 顶点色，所以没图集时的画面与今天逐像素一致。
 *   反过来，凡是槽 ≠ 0 的面，顶点色必须置白，否则会和面纹理叠乘变暗。
 *
 * yaw
 *   摆件局部轴 → 世界轴的旋转（0/90/180/270）。prop-glb.js 预先翻了
 *   by = nz-1-gz，与 prop-stamp.js 的 lz = D-1-by 相消，所以 q=0 时
 *   glb 轴恒等于世界轴；q>0 才真正旋转。YAW_MAP 在加载时算好，
 *   同时给出「世界面 wf 该用 glb 面 gf 的槽」和「面内 90° 旋转码」。
 *
 * 无图集短路
 *   VF.PROP_FACE_ATLAS 不存在（或没有任何带 face 的 .glb 摆件）时，
 *   texture() 返回 null，_rebuildChunk 完全不生成 uv 属性，
 *   材质也不挂 map —— 行为与接入前完全一致。
 */
(function (global) {
  'use strict';

  global.VF = global.VF || {};
  const VF = global.VF;

  const FACE_DIRS = [
    [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
  ];
  const FACE_UV = [
    [[1, 0, 0], [0, 0, -1]], // 0 +Y
    [[1, 0, 0], [0, 0, 1]],  // 1 -Y
    [[0, 1, 0], [0, 0, 1]],  // 2 +X
    [[0, 1, 0], [0, 0, -1]], // 3 -X
    [[1, 0, 0], [0, 1, 0]],  // 4 +Z
    [[-1, 0, 0], [0, 1, 0]], // 5 -Z
  ];

  // yaw q 下 glb 基向量 → 世界基向量（列向量 = glb e_x / e_y / e_z 的像）
  const YAW_R = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
    [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];

  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const applyR = (q, v) => {
    const R = YAW_R[q];
    return [
      R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2],
      R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2],
      R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2],
    ];
  };
  /** (a,b) 是 ±1/0 的单位分量对 → 0:su  1:1-su  2:sv  3:1-sv */
  function uvCode(a, b) {
    if (a === 1) return 0;
    if (a === -1) return 1;
    return b === 1 ? 2 : 3;
  }

  /** YAW_MAP[q][世界面 wf] = { src: glb 面 gf, ru, rv } */
  const YAW_MAP = [];
  for (let q = 0; q < 4; q++) {
    const map = new Array(6);
    for (let gf = 0; gf < 6; gf++) {
      const nw = applyR(q, FACE_DIRS[gf]);
      let wf = -1;
      for (let f = 0; f < 6; f++) if (dot3(FACE_DIRS[f], nw) === 1) wf = f;
      if (wf < 0) throw new Error('[PropFaces] 面法线映射失败 q=' + q + ' gf=' + gf);
      const uw = applyR(q, FACE_UV[gf][0]);
      const vw = applyR(q, FACE_UV[gf][1]);
      const U = FACE_UV[wf][0];
      const V = FACE_UV[wf][1];
      map[wf] = {
        src: gf,
        ru: uvCode(dot3(U, uw), dot3(V, uw)),
        rv: uvCode(dot3(U, vw), dot3(V, vw)),
      };
    }
    YAW_MAP.push(map);
  }

  function rotApply(code, su, sv) {
    return code === 0 ? su : code === 1 ? 1 - su : code === 2 ? sv : 1 - sv;
  }

  /* ------------------------------------------------------------------ *
   * base64 → 字节
   * ------------------------------------------------------------------ */
  // 纯 JS base64 解码：不依赖 Buffer / atob。
  // scripts/check-props.js 是在 vm 沙箱里跑这些运行时文件的，那里两者都没有；
  // 浏览器里 atob 虽然可用，但统一走一条路径能少一个环境分支。
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64INV = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) B64INV[B64.charCodeAt(i)] = i;

  function b64ToBytes(s) {
    let n = s.length;
    while (n > 0 && s.charCodeAt(n - 1) === 61) n--; // 去掉尾部 '='
    const out = new Uint8Array((n * 3) >> 2);
    let o = 0;
    let acc = 0;
    let bits = 0;
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i);
      const v = c < 128 ? B64INV[c] : -1;
      if (v < 0) continue; // 换行 / 空白
      acc = ((acc << 6) | v) & 0xffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[o++] = (acc >> bits) & 255;
      }
    }
    return out;
  }
  function b64ToU16(s) {
    const u8 = b64ToBytes(s);
    return new Uint16Array(u8.buffer, u8.byteOffset, u8.length >> 1);
  }

  /* ------------------------------------------------------------------ *
   * 图集
   * ------------------------------------------------------------------ */
  const state = { init: false, tex: null, grid: 0, rows: 0, texel: 0, aw: 0, ah: 0 };

  function ensure() {
    if (state.init) return state;
    state.init = true;
    const A = VF.PROP_FACE_ATLAS;
    if (!A || !A.data || !global.THREE) return state;

    const rgb = b64ToBytes(A.data);
    const W = A.grid * A.texel;
    const H = A.rows * A.texel;
    const rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      rgba[i * 4] = rgb[i * 3];
      rgba[i * 4 + 1] = rgb[i * 3 + 1];
      rgba[i * 4 + 2] = rgb[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
    const THREE = global.THREE;
    const tex = new THREE.DataTexture(rgba, W, H, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    // 图集存的是 sRGB 字节。three r152+ 在 WebGL2 下会用 SRGB8_ALPHA8 内部格式，
    // 采样时由 GPU 完成 EOTF，所以这里标成 sRGB 就够了，不用手改 shader。
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;

    state.tex = tex;
    state.grid = A.grid;
    state.rows = A.rows;
    state.texel = A.texel;
    state.aw = W;
    state.ah = H;
    return state;
  }

  function texture() {
    return ensure().tex;
  }

  /**
   * 把图集挂到 chunk 材质上。只做一次（material.userData.propFaces 打标）。
   * 返回贴图；没有图集时返回 null，调用方据此整条短路。
   */
  function patchMaterial(mat) {
    const tex = texture();
    if (!tex || !mat) return null;
    if (mat.userData && mat.userData.propFaces) return tex;
    if (!mat.userData) mat.userData = {};
    mat.userData.propFaces = true;
    mat.map = tex;
    mat.needsUpdate = true;
    return tex;
  }

  /* ------------------------------------------------------------------ *
   * per-voxel 面槽位
   * ------------------------------------------------------------------
   * world._faceSlots: Map<"x,y,z", Uint16Array(7)>
   *   [0..5] = glb 面序的图集槽位（0 = 无面纹理 / 纯白）
   *   [6]    = 摆放时的 yaw 档位 q（0..3）
   */
  function slotsOf(world) {
    if (!world) return null;
    if (!world._faceSlots) {
      world._faceSlots = new Map();
      world._faceChunks = new Set();
    }
    return world._faceSlots;
  }

  function put(world, x, y, z, arr) {
    const m = slotsOf(world);
    const i = world.index ? world.index(x, y, z) : -1;
    if (i < 0) return;
    m.set(i, arr);
    // 记下这个 chunk 有面数据：_rebuildChunk 用它跳过绝大多数无摆件的 chunk，
    // 省掉每体素一次 Map 查找（一个 16×101×16 的 chunk 就是 2.5 万次）。
    const cs = world.chunkSize || 16;
    world._faceChunks.add(((x / cs) | 0) + ',' + ((z / cs) | 0));
  }

  function dropIndex(world, i) {
    const m = world && world._faceSlots;
    if (m) m.delete(i);
  }

  /** 该方块有面槽位吗？返回 Uint16Array(7) 或 null。 */
  function getIndex(world, i) {
    const m = world && world._faceSlots;
    if (!m || !m.size) return null;
    return m.get(i) || null;
  }

  /**
   * 网格化前的两级短路：这个世界有没有面纹理数据、这个 chunk 有没有。
   * 绝大多数 chunk 两者都没有，此时完全不生成 uv、不改顶点色。
   */
  function active(world, cx, cz) {
    const m = world && world._faceSlots;
    if (!m || !m.size || !ensure().tex) return false;
    if (cx === undefined) return true;
    return world._faceChunks ? world._faceChunks.has(cx + ',' + cz) : true;
  }

  /* ------------------------------------------------------------------ *
   * uv 换算
   * ------------------------------------------------------------------ */

  /**
   * 由 _rebuildChunk 的 faces[]（单位立方体角点）算出每个面 4 个角在
   * 该面切向基下的 [0,1]² uv。返回 [f][v] = [su, sv]。
   * 结果缓存在 world 上，每个世界只算一次。
   */
  function buildCornerUv(faces) {
    const out = [];
    for (let f = 0; f < 6; f++) {
      const U = FACE_UV[f][0];
      const V = FACE_UV[f][1];
      let mu = Infinity;
      let mv = Infinity;
      const su = new Array(4);
      const sv = new Array(4);
      for (let v = 0; v < 4; v++) {
        const d = faces[f].d[v];
        su[v] = dot3(d, U);
        sv[v] = dot3(d, V);
        if (su[v] < mu) mu = su[v];
        if (sv[v] < mv) mv = sv[v];
      }
      const row = [];
      for (let v = 0; v < 4; v++) row.push([su[v] - mu, sv[v] - mv]);
      out.push(row);
    }
    return out;
  }

  /**
   * 世界面 f、角点 v 的图集 uv。
   * @param {Uint16Array|null} rec 该方块的槽位记录（null → 槽 0 纯白）
   * @returns {[number, number]}
   */
  function faceUv(rec, f, cornerUv, v) {
    const s = ensure();
    let slot = 0;
    let ru = 0;
    let rv = 2; // 恒等：u←su, v←sv
    if (rec) {
      const q = rec[6];
      const m = YAW_MAP[q] ? YAW_MAP[q][f] : null;
      if (m) {
        slot = rec[m.src];
        ru = m.ru;
        rv = m.rv;
      }
    }
    const c = cornerUv[f][v];
    const ug = rotApply(ru, c[0], c[1]);
    const vg = rotApply(rv, c[0], c[1]);
    const gx = (slot % s.grid) * s.texel;
    const gy = Math.floor(slot / s.grid) * s.texel;
    // 半 texel 内缩：su=0/1 正好落在槽边界，Nearest 采样会溢到相邻槽
    const span = s.texel - 1;
    return [(gx + 0.5 + ug * span) / s.aw, (gy + 0.5 + vg * span) / s.ah];
  }

  /** 该面是否由面纹理供色（是则顶点色必须置白，避免叠乘变暗）。 */
  function isTextured(rec, f) {
    if (!rec) return false;
    const m = YAW_MAP[rec[6]] ? YAW_MAP[rec[6]][f] : null;
    return !!m && rec[m.src] !== 0;
  }

  /**
   * 解码某个摆件的 face（base64 → Uint16Array，长度 = 实心格数 × 6）。
   * 结果缓存在 prop._faceU16 上。
   */
  function decodePropFace(prop) {
    if (!prop || !prop.face) return null;
    if (prop._faceU16) return prop._faceU16;
    prop._faceU16 = b64ToU16(prop.face);
    return prop._faceU16;
  }

  VF.PropFaces = {
    texture: texture,
    patchMaterial: patchMaterial,
    active: active,
    getIndex: getIndex,
    put: put,
    dropIndex: dropIndex,
    buildCornerUv: buildCornerUv,
    faceUv: faceUv,
    isTextured: isTextured,
    decodePropFace: decodePropFace,
    FACE_DIRS: FACE_DIRS,
    FACE_UV: FACE_UV,
    YAW_MAP: YAW_MAP,
    info: function () {
      const s = ensure();
      return s.tex
        ? { slots: s.grid * s.rows, texel: s.texel, w: s.aw, h: s.ah }
        : null;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
