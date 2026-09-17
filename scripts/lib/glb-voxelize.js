'use strict';
/**
 * GLB -> 体素网格 + 块面微缩纹理（face texture）图集
 *
 * 从 E:\Test\aks\tools\voxelize.js 移植。保留全部算法：
 *   - 三角形/体素 AABB 求交（Akenine-Möller SAT）
 *   - mipmap 金字塔选级采样（块大而不糊：一个体素覆盖多少 texel 就取该区域的真实平均色）
 *   - UV 占用掩码（贴图 padding 用块均值兜底，避免黑斑）
 *   - 面纹理烘焙：正交射线 + 面平面分桶 + 超采样降采样 + 方差判定图案/纯色 + 内容精确去重图集
 *
 * 与源工程的三处差异（都是为了使它适配 voxel-frontline-battle）：
 *   1) 面序改为本工程 chunk mesher 的顺序 +Y,-Y,+X,-X,+Z,-Z（源工程是 BoxGeometry 的
 *      px,nx,py,ny,pz,nz）。切向基 FACE_UV 同步改写，保证烘焙出来的图集能直接贴在
 *      voxel-world.js 生成的面上，横向招牌不会躺倒。
 *   2) 三角形用扁平 Float32Array 存储（源工程是嵌套数组），大幅降低大模型的内存/GC 压力。
 *   3) 贴图解码用 scripts/lib/png.js（Node 内置 zlib），不依赖 pngjs。
 *
 * 输出：
 *   {
 *     nx, ny, nz, voxel, origin:[min xyz], size:[xyz], count,
 *     index:   Int32Array(N)      体素在网格中的线性下标 gi = x + nx*(y + ny*z)
 *     coord:   Int32Array(N*3)    (gx,gy,gz)，与 index 同序
 *     color:   Uint8Array(N*3)    每体素表面平均色（未量化，供外部调色板量化）
 *     faceSlot:Uint16Array(N*6)   每体素 6 面的图集槽位，0xFFFF = 被邻体素遮挡
 *     atlas:  { grid, rows, slots, texel, data: Uint8Array(AW*AH*3) }
 *   }
 */

const { decodeSync: decodePng } = require('./png.js');

// ------------------------------------------------------------------ 常量

/** 面法线顺序 —— 必须与 voxel-world.js 的 chunk mesher 完全一致 */
const FACE_DIRS = [
  [0, 1, 0],  // 0 +Y
  [0, -1, 0], // 1 -Y
  [1, 0, 0],  // 2 +X
  [-1, 0, 0], // 3 -X
  [0, 0, 1],  // 4 +Z
  [0, 0, -1], // 5 -Z
];
const FACE_NAMES = ['+Y', '-Y', '+X', '-X', '+Z', '-Z'];

/**
 * 各面的 uv 切向（t1 = uv.x 增大方向, t2 = uv.y 增大方向），满足 t1 × t2 = 面法线。
 *
 * 这三个基向量是从 voxel-world.js 的 faces[].d 顶点顺序推出来的：
 *   d0=(0,0) d1=(1,0) d2=(1,1) d3=(0,1)  →  u 沿 d0→d1，v 沿 d0→d3
 *   +Y: d0(0,1,1) d1(1,1,1) d3(0,1,0) → u=+X, v=-Z
 *   -Y: d0(0,0,0) d1(1,0,0) d3(0,0,1) → u=+X, v=+Z
 *   +X: d0(1,0,0) d1(1,1,0) d3(1,0,1) → u=+Y, v=+Z
 *   -X: d0(0,0,1) d1(0,1,1) d3(0,0,0) → u=+Y, v=-Z
 *   +Z: d0(0,0,1) d1(1,0,1) d3(0,1,1) → u=+X, v=+Y
 *   -Z: d0(1,0,0) d1(0,0,0) d3(1,1,0) → u=-X, v=+Y
 * 图集内容按 content[(v行)*FT + (u列)] 存，第 0 行 = v 最小处（DataTexture flipY=false）。
 */
const FACE_UV = [
  [[1, 0, 0], [0, 0, -1]],  // 0 +Y
  [[1, 0, 0], [0, 0, 1]],   // 1 -Y
  [[0, 1, 0], [0, 0, 1]],   // 2 +X
  [[0, 1, 0], [0, 0, -1]],  // 3 -X
  [[1, 0, 0], [0, 1, 0]],   // 4 +Z
  [[-1, 0, 0], [0, 1, 0]],  // 5 -Z
];

const DEFAULT_OPT = {
  res: 64,          // 最长边的体素数
  fill: false,      // 是否把内部填满（默认只做外壳）
  ss: 1,            // mipmap 基础上的额外多点采样
  jitter: 0,        // 每体素明暗抖动幅度（默认关：本工程的颜色由外部调色板统一量化）
  sat: 1,           // 饱和度补偿
  quant: 0,         // 颜色量化级数，0 = 不量化
  faceft: 8,        // 每面纹理边长（texel）
  facethr: 10,      // 标准差低于此值 → 纯色面
  faceray: 4,       // 射线最大命中距离（体素数）
  facess: 1,        // 面纹理额外超采样倍数
  faces: true,      // 是否烘焙面纹理
  onLog: null,      // (msg) => void
};

// ------------------------------------------------------------------ GLB 解析

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const COMP_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NUMCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function parseGLB(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB 文件（magic 不是 glTF）');
  let off = 12;
  let json = null, bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.toString('ascii', off + 4, off + 8).replace(/\0/g, '');
    if (type === 'JSON') json = JSON.parse(buf.toString('utf8', off + 8, off + 8 + len));
    if (type === 'BIN') bin = buf.subarray(off + 8, off + 8 + len);
    off += 8 + len;
  }
  if (!json) throw new Error('GLB 缺少 JSON chunk');
  return { json, bin: bin || Buffer.alloc(0) };
}

function makeAccessorReader(json, bin) {
  return function readAccessor(i) {
    const a = json.accessors[i];
    if (!a) throw new Error('accessor 不存在: ' + i);
    const Ctor = COMP[a.componentType];
    if (!Ctor) throw new Error('不支持的 componentType: ' + a.componentType);
    const n = NUMCOMP[a.type];
    const out = new Ctor(a.count * n);
    if (a.bufferView === undefined) return out;
    const bv = json.bufferViews[a.bufferView];
    const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const csz = COMP_SIZE[a.componentType];
    const tight = n * csz;
    if (bv.byteStride && bv.byteStride !== tight) {
      // 交错数据：逐元素拷贝
      const stride = bv.byteStride;
      for (let k = 0; k < a.count; k++) {
        for (let c = 0; c < n; c++) {
          const p = base + k * stride + c * csz;
          switch (a.componentType) {
            case 5126: out[k * n + c] = bin.readFloatLE(p); break;
            case 5125: out[k * n + c] = bin.readUInt32LE(p); break;
            case 5123: out[k * n + c] = bin.readUInt16LE(p); break;
            case 5121: out[k * n + c] = bin.readUInt8(p); break;
            case 5122: out[k * n + c] = bin.readInt16LE(p); break;
            case 5120: out[k * n + c] = bin.readInt8(p); break;
          }
        }
      }
      return out;
    }
    for (let k = 0; k < out.length; k++) {
      const p = base + k * csz;
      switch (a.componentType) {
        case 5126: out[k] = bin.readFloatLE(p); break;
        case 5125: out[k] = bin.readUInt32LE(p); break;
        case 5123: out[k] = bin.readUInt16LE(p); break;
        case 5121: out[k] = bin.readUInt8(p); break;
        case 5122: out[k] = bin.readInt16LE(p); break;
        case 5120: out[k] = bin.readInt8(p); break;
      }
    }
    return out;
  };
}

/** 取被 baseColorTexture 引用的第一张贴图，用零依赖解码器解码成 RGBA */
function decodeFirstTexture(json, bin, log) {
  if (!json.textures || !json.textures.length || !json.images) return null;
  let texIdx = 0;
  for (const m of (json.materials || [])) {
    const t = m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorTexture;
    if (t) { texIdx = t.index; break; }
  }
  const tex = json.textures[texIdx];
  if (!tex) return null;
  const img = json.images[tex.source !== undefined ? tex.source : 0];
  if (!img) return null;
  let data;
  if (img.bufferView !== undefined) {
    const bv = json.bufferViews[img.bufferView];
    data = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  } else if (img.uri && img.uri.startsWith('data:')) {
    data = Buffer.from(img.uri.split(',')[1], 'base64');
  } else return null;
  try {
    return decodePng(data);
  } catch (e) {
    if (log) log('贴图解码失败（将退回按高度着色）: ' + e.message);
    return null;
  }
}

// ------------------------------------------------------------------ 矩阵

function nodeMatrix(n) {
  if (n.matrix) return n.matrix.slice();
  const t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const m = new Array(16);
  m[0] = (1 - (yy + zz)) * s[0]; m[1] = (xy + wz) * s[0]; m[2] = (xz - wy) * s[0]; m[3] = 0;
  m[4] = (xy - wz) * s[1]; m[5] = (1 - (xx + zz)) * s[1]; m[6] = (yz + wx) * s[1]; m[7] = 0;
  m[8] = (xz + wy) * s[2]; m[9] = (yz - wx) * s[2]; m[10] = (1 - (xx + yy)) * s[2]; m[11] = 0;
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}

function mul(a, b) { // a*b，列主序
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}

// ------------------------------------------------------------------ 主流程

/**
 * @param {Buffer} buf GLB 文件字节
 * @param {object} userOpt 见 DEFAULT_OPT
 */
function voxelize(buf, userOpt) {
  const opt = Object.assign({}, DEFAULT_OPT, userOpt || {});
  const log = opt.onLog || function () {};
  const T0 = Date.now();

  const RES = Math.max(1, parseInt(opt.res, 10));
  const SS = Math.max(1, parseInt(opt.ss, 10));
  const JITTER = parseFloat(opt.jitter);
  const SAT = parseFloat(opt.sat);
  const QUANT = parseInt(opt.quant, 10);

  // ---------- 读 GLB ----------
  const { json, bin } = parseGLB(buf);
  const readAccessor = makeAccessorReader(json, bin);

  const tex = decodeFirstTexture(json, bin, log);
  if (tex) log(`贴图: ${tex.width}x${tex.height}`);

  // ---------- mipmap 金字塔 ----------
  let MIPS = null;
  if (tex) {
    const t0m = Date.now();
    MIPS = [];
    let w = tex.width, h = tex.height;
    let cur = new Uint8Array(w * h * 3);
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      cur[i * 3] = tex.data[j]; cur[i * 3 + 1] = tex.data[j + 1]; cur[i * 3 + 2] = tex.data[j + 2];
    }
    MIPS.push({ w, h, d: cur });
    while (w > 1 || h > 1) {
      const pw = w, ph = h, pd = cur;
      const nw = Math.max(1, pw >> 1), nh = Math.max(1, ph >> 1);
      const nd = new Uint8Array(nw * nh * 3);
      for (let y = 0; y < nh; y++) {
        const y0 = y * 2, y1 = Math.min(y0 + 1, ph - 1);
        for (let x = 0; x < nw; x++) {
          const x0 = x * 2, x1 = Math.min(x0 + 1, pw - 1);
          const i00 = (y0 * pw + x0) * 3, i10 = (y0 * pw + x1) * 3;
          const i01 = (y1 * pw + x0) * 3, i11 = (y1 * pw + x1) * 3;
          const o = (y * nw + x) * 3;
          for (let c = 0; c < 3; c++) nd[o + c] = (pd[i00 + c] + pd[i10 + c] + pd[i01 + c] + pd[i11 + c] + 2) >> 2;
        }
      }
      cur = nd; w = nw; h = nh;
      MIPS.push({ w, h, d: cur });
    }
    log(`mipmap: ${MIPS.length} 级 (${tex.width}x${tex.height} → ${w}x${h})  ${((Date.now() - t0m) / 1000).toFixed(2)}s`);
  }

  const wrapI = (n, m) => ((n % m) + m) % m;
  function sampleBilinear(m, u, v, out) {
    const x = u * m.w - 0.5, y = v * m.h - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const yy0 = wrapI(y0, m.h) * m.w, yy1 = wrapI(y0 + 1, m.h) * m.w;
    const xa = wrapI(x0, m.w), xb = wrapI(x0 + 1, m.w);
    for (let c = 0; c < 3; c++) {
      const a = m.d[(yy0 + xa) * 3 + c] * (1 - fx) + m.d[(yy0 + xb) * 3 + c] * fx;
      const b = m.d[(yy1 + xa) * 3 + c] * (1 - fx) + m.d[(yy1 + xb) * 3 + c] * fx;
      out[c] = a * (1 - fy) + b * fy;
    }
  }
  const _ma = [0, 0, 0], _mb = [0, 0, 0];
  function sampleMip(u, v, level, out) {
    if (!MIPS) return false;
    const maxL = MIPS.length - 1;
    const l = level <= 0 ? 0 : (level >= maxL ? maxL : level);
    const l0 = Math.floor(l), l1 = Math.min(maxL, l0 + 1), t = l - l0;
    sampleBilinear(MIPS[l0], u, v, _ma);
    if (t > 1e-4 && l1 !== l0) sampleBilinear(MIPS[l1], u, v, _mb);
    else { _mb[0] = _ma[0]; _mb[1] = _ma[1]; _mb[2] = _ma[2]; }
    out[0] = _ma[0] * (1 - t) + _mb[0] * t;
    out[1] = _ma[1] * (1 - t) + _mb[1] * t;
    out[2] = _ma[2] * (1 - t) + _mb[2] * t;
    return true;
  }

  // ---------- 收集三角形 ----------
  const scene = json.scenes[json.scene || 0];
  if (!scene) throw new Error('GLB 没有 scene');
  const posArr = [], uvArr = [];
  const hasUvArr = [];
  {
    const applyM = (m, x, y, z) => [
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
    ];
    const I16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    function walk(nodeIdx, parentM) {
      const n = json.nodes[nodeIdx];
      const m = mul(parentM, nodeMatrix(n));
      if (n.mesh !== undefined) {
        const mesh = json.meshes[n.mesh];
        for (const p of mesh.primitives) {
          if (p.mode !== undefined && p.mode !== 4) continue; // 只处理三角形
          if (p.attributes.POSITION === undefined) continue;
          const pos = readAccessor(p.attributes.POSITION);
          const uvA = p.attributes.TEXCOORD_0 !== undefined ? readAccessor(p.attributes.TEXCOORD_0) : null;
          const idx = p.indices !== undefined ? readAccessor(p.indices) : null;
          const nVert = pos.length / 3;
          const count = idx ? idx.length : nVert;
          for (let i = 0; i < count; i += 3) {
            const a = idx ? idx[i] : i, b = idx ? idx[i + 1] : i + 1, c = idx ? idx[i + 2] : i + 2;
            const A = applyM(m, pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]);
            const B = applyM(m, pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]);
            const C = applyM(m, pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]);
            posArr.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
            if (uvA) {
              uvArr.push(uvA[a * 2], uvA[a * 2 + 1], uvA[b * 2], uvA[b * 2 + 1], uvA[c * 2], uvA[c * 2 + 1]);
              hasUvArr.push(1);
            } else {
              uvArr.push(0, 0, 0, 0, 0, 0);
              hasUvArr.push(0);
            }
          }
        }
      }
      (n.children || []).forEach(ch => walk(ch, m));
    }
    (scene.nodes || []).forEach(ni => walk(ni, I16));
  }
  const nTri = hasUvArr.length;
  const triPos = new Float32Array(posArr);
  const triUv = new Float32Array(uvArr);
  const triHasUv = Uint8Array.from(hasUvArr);
  log(`三角形: ${nTri}`);
  if (!nTri) throw new Error('GLB 里没有可用三角形');

  // ---------- 包围盒与网格 ----------
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < triPos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = triPos[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const maxDim = Math.max(size[0], size[1], size[2]);
  if (!(maxDim > 0)) throw new Error('模型包围盒退化');
  const voxel = maxDim / RES;
  const nx = Math.max(1, Math.ceil(size[0] / voxel) + 1);
  const ny = Math.max(1, Math.ceil(size[1] / voxel) + 1);
  const nz = Math.max(1, Math.ceil(size[2] / voxel) + 1);
  const NC = nx * ny * nz;
  if (NC > 64e6) throw new Error(`体素网格过大 (${nx}x${ny}x${nz})，请降低 --res`);
  log(`包围盒 size=${size.map(s => s.toFixed(3)).join(' x ')}`);
  log(`体素网格: ${nx} x ${ny} x ${nz} (voxel=${voxel.toFixed(4)}, 目标 ${RES})`);

  const gi = (x, y, z) => x + nx * (y + ny * z);

  // ---------- 三角形 / AABB 相交（Akenine-Möller SAT） ----------
  const half = [voxel / 2, voxel / 2, voxel / 2];
  function triBoxOverlap(bcx, bcy, bcz, t) {
    const ax = triPos[t] - bcx, ay = triPos[t + 1] - bcy, az = triPos[t + 2] - bcz;
    const bx = triPos[t + 3] - bcx, by = triPos[t + 4] - bcy, bz = triPos[t + 5] - bcz;
    const cx = triPos[t + 6] - bcx, cy = triPos[t + 7] - bcy, cz = triPos[t + 8] - bcz;
    const e0x = bx - ax, e0y = by - ay, e0z = bz - az;
    const e1x = cx - bx, e1y = cy - by, e1z = cz - bz;
    const e2x = ax - cx, e2y = ay - cy, e2z = az - cz;
    let mn, mx, rad, p0, p1, p2, fex, fey, fez;

    fex = Math.abs(e0x); fey = Math.abs(e0y); fez = Math.abs(e0z);
    p0 = e0z * ay - e0y * az; p2 = e0z * cy - e0y * cz;
    mn = Math.min(p0, p2); mx = Math.max(p0, p2); rad = fez * half[1] + fey * half[2];
    if (mn > rad || mx < -rad) return false;
    p0 = -e0z * ax + e0x * az; p2 = -e0z * cx + e0x * cz;
    mn = Math.min(p0, p2); mx = Math.max(p0, p2); rad = fez * half[0] + fex * half[2];
    if (mn > rad || mx < -rad) return false;
    p1 = e0y * bx - e0x * by; p2 = e0y * cx - e0x * cy;
    mn = Math.min(p1, p2); mx = Math.max(p1, p2); rad = fey * half[0] + fex * half[1];
    if (mn > rad || mx < -rad) return false;

    fex = Math.abs(e1x); fey = Math.abs(e1y); fez = Math.abs(e1z);
    p0 = e1z * ay - e1y * az; p2 = e1z * cy - e1y * cz;
    mn = Math.min(p0, p2); mx = Math.max(p0, p2); rad = fez * half[1] + fey * half[2];
    if (mn > rad || mx < -rad) return false;
    p0 = -e1z * ax + e1x * az; p2 = -e1z * cx + e1x * cz;
    mn = Math.min(p0, p2); mx = Math.max(p0, p2); rad = fez * half[0] + fex * half[2];
    if (mn > rad || mx < -rad) return false;
    p0 = e1y * ax - e1x * ay; p1 = e1y * bx - e1x * by;
    mn = Math.min(p0, p1); mx = Math.max(p0, p1); rad = fey * half[0] + fex * half[1];
    if (mn > rad || mx < -rad) return false;

    fex = Math.abs(e2x); fey = Math.abs(e2y); fez = Math.abs(e2z);
    p0 = e2z * ay - e2y * az; p1 = e2z * by - e2y * bz;
    mn = Math.min(p0, p1); mx = Math.max(p0, p1); rad = fez * half[1] + fey * half[2];
    if (mn > rad || mx < -rad) return false;
    p0 = -e2z * ax + e2x * az; p1 = -e2z * bx + e2x * bz;
    mn = Math.min(p0, p1); mx = Math.max(p0, p1); rad = fez * half[0] + fex * half[2];
    if (mn > rad || mx < -rad) return false;
    p1 = e2y * bx - e2x * by; p2 = e2y * cx - e2x * cy;
    mn = Math.min(p1, p2); mx = Math.max(p1, p2); rad = fey * half[0] + fex * half[1];
    if (mn > rad || mx < -rad) return false;

    mn = Math.min(ax, bx, cx); mx = Math.max(ax, bx, cx);
    if (mn > half[0] || mx < -half[0]) return false;
    mn = Math.min(ay, by, cy); mx = Math.max(ay, by, cy);
    if (mn > half[1] || mx < -half[1]) return false;
    mn = Math.min(az, bz, cz); mx = Math.max(az, bz, cz);
    if (mn > half[2] || mx < -half[2]) return false;

    const nxv = e0y * e1z - e0z * e1y;
    const nyv = e0z * e1x - e0x * e1z;
    const nzv = e0x * e1y - e0y * e1x;
    let vmin = 0, vmax = 0;
    for (let q = 0; q < 3; q++) {
      const nq = q === 0 ? nxv : q === 1 ? nyv : nzv;
      const vq = q === 0 ? ax : q === 1 ? ay : az;
      if (nq > 0) { vmin += nq * (-half[q] - vq); vmax += nq * (half[q] - vq); }
      else { vmin += nq * (half[q] - vq); vmax += nq * (-half[q] - vq); }
    }
    if (vmin > 0 || vmax < 0) return false;
    return true;
  }

  // 三角形内 UV 对世界坐标是线性映射 → 每个三角形只算一次梯度，之后 dot 即可求任意方向 UV 变化率
  function uvGradient(t, g) {
    const A = t, B = t + 3, C = t + 6;
    const d1x = triPos[B] - triPos[A], d1y = triPos[B + 1] - triPos[A + 1], d1z = triPos[B + 2] - triPos[A + 2];
    const d2x = triPos[C] - triPos[A], d2y = triPos[C + 1] - triPos[A + 1], d2z = triPos[C + 2] - triPos[A + 2];
    const a = d1x * d1x + d1y * d1y + d1z * d1z;
    const b = d1x * d2x + d1y * d2y + d1z * d2z;
    const c = d2x * d2x + d2y * d2y + d2z * d2z;
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-20) return false;
    const base = (t / 9) * 6; // 三角形 ti 的 6 个 uv 分量起点
    const du1 = triUv[base + 2] - triUv[base + 0], dv1 = triUv[base + 3] - triUv[base + 1];
    const du2 = triUv[base + 4] - triUv[base + 0], dv2 = triUv[base + 5] - triUv[base + 1];
    g[0] = d1x; g[1] = d1y; g[2] = d1z; g[3] = d2x; g[4] = d2y; g[5] = d2z;
    g[6] = (c * du1 - b * du2) / det; g[7] = (a * du2 - b * du1) / det;
    g[8] = (c * dv1 - b * dv2) / det; g[9] = (a * dv2 - b * dv1) / det;
    return true;
  }

  /** 重心坐标（clamp 到三角形内），返回 [w0(A), w1(B), w2(C)] 写入 out */
  function baryClamp(t, px, py, pz, out) {
    const A = t, B = t + 3, C = t + 6;
    const d1x = triPos[B] - triPos[A], d1y = triPos[B + 1] - triPos[A + 1], d1z = triPos[B + 2] - triPos[A + 2];
    const d2x = triPos[C] - triPos[A], d2y = triPos[C + 1] - triPos[A + 1], d2z = triPos[C + 2] - triPos[A + 2];
    const nxv = d1y * d2z - d1z * d2y, nyv = d1z * d2x - d1x * d2z, nzv = d1x * d2y - d1y * d2x;
    const den = nxv * nxv + nyv * nyv + nzv * nzv;
    if (den < 1e-20) { out[0] = 1; out[1] = 0; out[2] = 0; return; }
    let u, v;
    const anx = Math.abs(nxv), any = Math.abs(nyv), anz = Math.abs(nzv);
    const qx = px - triPos[A], qy = py - triPos[A + 1], qz = pz - triPos[A + 2];
    if (anx >= any && anx >= anz) {
      u = (qy * d2z - qz * d2y) / nxv;
      v = (qz * d1y - qy * d1z) / nxv;
    } else if (any >= anz) {
      u = (qz * d2x - qx * d2z) / nyv;
      v = (qx * d1z - qz * d1x) / nyv;
    } else {
      u = (qx * d2y - qy * d2x) / nzv;
      v = (qy * d1x - qx * d1y) / nzv;
    }
    const cl = (s) => s < 0 ? 0 : (s > 1 ? 1 : s);
    let w = 1 - u - v;
    if (u < 0) { const s = cl(v); u = 0; v = s; w = 1 - s; }
    else if (v < 0) { const s = cl(u); u = s; v = 0; w = 1 - s; }
    else if (w < 0) { const s = cl(v / (u + v)); u = 1 - s; v = s; w = 0; }
    out[0] = w; out[1] = u; out[2] = v;
  }

  // ---------- 体素化 ----------
  const acc = new Float32Array(NC * 3);
  const cnt = new Uint32Array(NC);
  const triMip = new Float32Array(nTri);
  const uvOut = [0, 0, 0];
  const g = new Float64Array(10);
  const bw = [0, 0, 0];
  let t0 = Date.now();

  for (let ti = 0; ti < nTri; ti++) {
    const t = ti * 9;
    const Au = triHasUv[ti] && tex;
    // 这个三角形上「一个体素覆盖多少 texel」→ 决定用哪级 mipmap
    let mipLv = 0;
    if (Au && MIPS && uvGradient(t, g)) {
      const l1 = Math.hypot(g[0], g[1], g[2]) || 1e-9;
      const t1x = g[0] / l1, t1y = g[1] / l1, t1z = g[2] / l1;
      let nxv = g[1] * g[5] - g[2] * g[4];
      let nyv = g[2] * g[3] - g[0] * g[5];
      let nzv = g[0] * g[4] - g[1] * g[3];
      const nl = Math.hypot(nxv, nyv, nzv) || 1e-9;
      nxv /= nl; nyv /= nl; nzv /= nl;
      const t2x = nyv * t1z - nzv * t1y, t2y = nzv * t1x - nxv * t1z, t2z = nxv * t1y - nyv * t1x;
      const hv = voxel * 0.5;
      const foot = (dx, dy, dz) => {
        const p1 = dx * g[0] + dy * g[1] + dz * g[2];
        const p2 = dx * g[3] + dy * g[4] + dz * g[5];
        const du = (g[6] * p1 + g[7] * p2) * MIPS[0].w;
        const dv = (g[8] * p1 + g[9] * p2) * MIPS[0].h;
        return Math.hypot(du, dv);
      };
      const f1 = foot(t1x * hv, t1y * hv, t1z * hv);
      const f2 = foot(t2x * hv, t2y * hv, t2z * hv);
      const fTexel = Math.max(f1, f2);
      mipLv = fTexel > 1 ? Math.log2(fTexel) : 0;
    }
    triMip[ti] = mipLv;

    const mnx = Math.min(triPos[t], triPos[t + 3], triPos[t + 6]);
    const mxx = Math.max(triPos[t], triPos[t + 3], triPos[t + 6]);
    const mny = Math.min(triPos[t + 1], triPos[t + 4], triPos[t + 7]);
    const mxy = Math.max(triPos[t + 1], triPos[t + 4], triPos[t + 7]);
    const mnz = Math.min(triPos[t + 2], triPos[t + 5], triPos[t + 8]);
    const mxz = Math.max(triPos[t + 2], triPos[t + 5], triPos[t + 8]);
    const x0 = Math.max(0, Math.floor((mnx - min[0]) / voxel) - 1);
    const x1 = Math.min(nx - 1, Math.floor((mxx - min[0]) / voxel) + 1);
    const y0 = Math.max(0, Math.floor((mny - min[1]) / voxel) - 1);
    const y1 = Math.min(ny - 1, Math.floor((mxy - min[1]) / voxel) + 1);
    const z0 = Math.max(0, Math.floor((mnz - min[2]) / voxel) - 1);
    const z1 = Math.min(nz - 1, Math.floor((mxz - min[2]) / voxel) + 1);

    const ub = ti * 6;
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const cx = min[0] + (x + 0.5) * voxel;
      const cy = min[1] + (y + 0.5) * voxel;
      const cz = min[2] + (z + 0.5) * voxel;
      if (!triBoxOverlap(cx, cy, cz, t)) continue;
      let r, gg, b;
      if (Au) {
        if (SS > 1) {
          const e1x = triPos[t + 3] - triPos[t], e1y = triPos[t + 4] - triPos[t + 1], e1z = triPos[t + 5] - triPos[t + 2];
          const e2x = triPos[t + 6] - triPos[t], e2y = triPos[t + 7] - triPos[t + 1], e2z = triPos[t + 8] - triPos[t + 2];
          const l1 = Math.hypot(e1x, e1y, e1z) || 1;
          const l2 = Math.hypot(e2x, e2y, e2z) || 1;
          const u1 = [e1x / l1, e1y / l1, e1z / l1];
          const u2 = [e2x / l2, e2y / l2, e2z / l2];
          const off = voxel * 0.5 / SS;
          let sr = 0, sg = 0, sb = 0;
          for (let si = 0; si < SS; si++) for (let sj = 0; sj < SS; sj++) {
            const fi = (si + 0.5) / SS * 2 * off * SS - off * SS + off;
            const fj = (sj + 0.5) / SS * 2 * off * SS - off * SS + off;
            baryClamp(t, cx + u1[0] * fi + u2[0] * fj, cy + u1[1] * fi + u2[1] * fj, cz + u1[2] * fi + u2[2] * fj, bw);
            const uu = bw[0] * triUv[ub] + bw[1] * triUv[ub + 2] + bw[2] * triUv[ub + 4];
            const vv = bw[0] * triUv[ub + 1] + bw[1] * triUv[ub + 3] + bw[2] * triUv[ub + 5];
            sampleMip(uu, vv, mipLv, uvOut);
            sr += uvOut[0]; sg += uvOut[1]; sb += uvOut[2];
          }
          const n = SS * SS;
          r = sr / n; gg = sg / n; b = sb / n;
        } else {
          baryClamp(t, cx, cy, cz, bw);
          const uu = bw[0] * triUv[ub] + bw[1] * triUv[ub + 2] + bw[2] * triUv[ub + 4];
          const vv = bw[0] * triUv[ub + 1] + bw[1] * triUv[ub + 3] + bw[2] * triUv[ub + 5];
          sampleMip(uu, vv, mipLv, uvOut);
          r = uvOut[0]; gg = uvOut[1]; b = uvOut[2];
        }
      } else {
        const h = (cy - min[1]) / (size[1] || 1);
        r = 120 + h * 100; gg = 110 + h * 90; b = 100 + h * 80;
      }
      const key = gi(x, y, z);
      acc[key * 3] += r; acc[key * 3 + 1] += gg; acc[key * 3 + 2] += b;
      cnt[key]++;
    }
  }
  let N = 0;
  for (let i = 0; i < NC; i++) if (cnt[i]) N++;
  log(`表面体素: ${N}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ---------- 可选：按列填充内部 ----------
  if (opt.fill) {
    t0 = Date.now();
    let added = 0;
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const ys = [];
      for (let y = 0; y < ny; y++) if (cnt[gi(x, y, z)]) ys.push(y);
      if (ys.length < 2) continue;
      let segStart = ys[0];
      for (let i = 1; i <= ys.length; i++) {
        const gap = i < ys.length ? ys[i] - ys[i - 1] : Infinity;
        if (gap > 2) {
          const yA = segStart, yB = ys[i - 1];
          for (let y = yA + 1; y < yB; y++) {
            const key = gi(x, y, z);
            if (!cnt[key]) {
              const lo = gi(x, yA, z), hi = gi(x, yB, z);
              const tv = (y - yA) / Math.max(1, yB - yA);
              for (let c = 0; c < 3; c++) {
                acc[key * 3 + c] = ((acc[lo * 3 + c] / cnt[lo]) * (1 - tv) + (acc[hi * 3 + c] / cnt[hi]) * tv) * 0.88;
              }
              cnt[key] = 1;
              added++;
            }
          }
          if (i < ys.length) segStart = ys[i];
        }
      }
    }
    N += added;
    log(`填充内部体素: ${added}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // ---------- keys（排序，保证 index / color / faceSlot 三者同序） ----------
  const keys = new Int32Array(N);
  {
    let k = 0;
    for (let i = 0; i < NC; i++) if (cnt[i]) keys[k++] = i;
  }

  let faceSlotArr = new Uint16Array(N * 6);
  let atlas = null;

  if (opt.faces) {
    // ---------- UV 占用掩码 ----------
    const MRES = 1024;
    const uvmask = new Uint8Array(MRES * MRES);
    {
      const t0u = Date.now();
      for (let ti = 0; ti < nTri; ti++) {
        if (!triHasUv[ti]) continue;
        const ub = ti * 6;
        const p0 = [triUv[ub] * MRES, triUv[ub + 1] * MRES];
        const p1 = [triUv[ub + 2] * MRES, triUv[ub + 3] * MRES];
        const p2 = [triUv[ub + 4] * MRES, triUv[ub + 5] * MRES];
        const ymin = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
        const ymax = Math.min(MRES - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));
        for (let y = ymin; y <= ymax; y++) {
          const yc = y + 0.5;
          const xs = [];
          const ps = [p0, p1, p2];
          for (let i = 0; i < 3; i++) {
            const a = ps[i], b = ps[(i + 1) % 3];
            if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) {
              xs.push(a[0] + (yc - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
            }
          }
          if (xs.length < 2) continue;
          xs.sort((m, n) => m - n);
          const xa = Math.max(0, Math.ceil(xs[0])), xb = Math.min(MRES - 1, Math.floor(xs[xs.length - 1]));
          const row = y * MRES;
          for (let x = xa; x <= xb; x++) uvmask[row + x] = 1;
        }
      }
      const dil = new Uint8Array(MRES * MRES);
      const R = 2;
      for (let y = 0; y < MRES; y++) for (let x = 0; x < MRES; x++) {
        if (!uvmask[y * MRES + x]) continue;
        for (let dy = -R; dy <= R; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= MRES) continue;
          for (let dx = -R; dx <= R; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < MRES) dil[yy * MRES + xx] = 1;
          }
        }
      }
      uvmask.set(dil);
      let cov = 0;
      for (let i = 0; i < uvmask.length; i++) cov += uvmask[i];
      log(`UV 掩码: ${MRES}², 覆盖 ${(cov / MRES / MRES * 100).toFixed(1)}%  用时 ${((Date.now() - t0u) / 1000).toFixed(1)}s`);
    }
    const uvValid = (u, v) => {
      const mx = Math.floor(u * MRES), my = Math.floor(v * MRES);
      if (mx < 0 || my < 0 || mx >= MRES || my >= MRES) return false;
      return uvmask[my * MRES + mx] === 1;
    };

    // ---------- 面烘焙索引：按面方向把正面三角形投到面平面 2D 桶 ----------
    const FT = Math.max(1, parseInt(opt.faceft, 10));
    const FACE_THR = parseFloat(opt.facethr);
    const RAY_MULT = parseFloat(opt.faceray);
    const FSS = Math.max(1, parseInt(opt.facess, 10));
    const DIMS = [nx, ny, nz];
    const faceIndex = [];
    for (let f = 0; f < 6; f++) {
      const d = FACE_DIRS[f];
      const ax = d[0] !== 0 ? 0 : (d[1] !== 0 ? 1 : 2);
      const u_ax = ax === 0 ? 1 : 0;
      const v_ax = ax === 2 ? 1 : 2;
      const NU = DIMS[u_ax], NV = DIMS[v_ax];
      const buckets = new Array(NU * NV).fill(null);
      let kept = 0, ins = 0;
      for (let ti = 0; ti < nTri; ti++) {
        const t = ti * 9;
        const e1x = triPos[t + 3] - triPos[t], e1y = triPos[t + 4] - triPos[t + 1], e1z = triPos[t + 5] - triPos[t + 2];
        const e2x = triPos[t + 6] - triPos[t], e2y = triPos[t + 7] - triPos[t + 1], e2z = triPos[t + 8] - triPos[t + 2];
        const nxv = e1y * e2z - e1z * e2y, nyv = e1z * e2x - e1x * e2z, nzv = e1x * e2y - e1y * e2x;
        if (nxv * d[0] + nyv * d[1] + nzv * d[2] <= 0) continue;   // 背面剔除
        kept++;
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        for (let k = 0; k < 3; k++) {
          const iu = (triPos[t + k * 3 + u_ax] - min[u_ax]) / voxel;
          const iv = (triPos[t + k * 3 + v_ax] - min[v_ax]) / voxel;
          if (iu < u0) u0 = iu; if (iu > u1) u1 = iu;
          if (iv < v0) v0 = iv; if (iv > v1) v1 = iv;
        }
        const bi0 = Math.max(0, Math.floor(u0)), bi1 = Math.min(NU - 1, Math.floor(u1));
        const bj0 = Math.max(0, Math.floor(v0)), bj1 = Math.min(NV - 1, Math.floor(v1));
        for (let bj = bj0; bj <= bj1; bj++) for (let bi = bi0; bi <= bi1; bi++) {
          const kk = bj * NU + bi;
          if (buckets[kk] === null) buckets[kk] = [];
          buckets[kk].push(ti); ins++;
        }
      }
      faceIndex.push({ ax, u_ax, v_ax, NU, NV, buckets, kept, ins });
    }
    log('面索引: ' + faceIndex.map((fi, i) => `${FACE_NAMES[i]}=${fi.kept}`).join(' ') +
      `  插入 ${faceIndex.reduce((s, x) => s + x.ins, 0)}`);

    // ---------- 逐面烘焙 ----------
    const FACE_QUANT = 8;
    const t0f = Date.now();
    faceSlotArr.fill(0xFFFF);
    const slotMap = new Map();
    const atlasList = [new Uint8Array(FT * FT * 3).fill(255)]; // 槽 0 = 白色占位
    const FC = FT * 2 * FSS;
    const SS2 = 2 * FSS;
    let patFaces = 0, flatFaces = 0;
    const smp = [0, 0, 0];
    const occ = cnt; // cnt>0 即存在
    // 复用的临时缓冲（每面都会完整覆写全部 FC*FC 项）
    const tmp = new Float32Array(FC * FC * 3);
    const valid = new Uint8Array(FC * FC);

    for (let k = 0; k < N; k++) {
      const key = keys[k];
      const cx0 = key % nx, cy0 = Math.floor(key / nx) % ny, cz0 = Math.floor(key / (nx * ny));
      const c = [min[0] + (cx0 + 0.5) * voxel, min[1] + (cy0 + 0.5) * voxel, min[2] + (cz0 + 0.5) * voxel];
      const n = cnt[key];
      const avg = [acc[key * 3] / n, acc[key * 3 + 1] / n, acc[key * 3 + 2] / n];

      for (let f = 0; f < 6; f++) {
        const d = FACE_DIRS[f];
        const X = cx0 + d[0], Y = cy0 + d[1], Z = cz0 + d[2];
        if (X >= 0 && Y >= 0 && Z >= 0 && X < nx && Y < ny && Z < nz && occ[X + nx * (Y + ny * Z)]) continue; // 被遮挡
        const fIdx = k * 6 + f;
        const content = new Uint8Array(FT * FT * 3);

        if (tex) {
          const fc = [c[0] + d[0] * voxel / 2, c[1] + d[1] * voxel / 2, c[2] + d[2] * voxel / 2];
          const RAY_OUT = voxel * 0.5, RAY_MAX = voxel * RAY_MULT;
          const rd = [-d[0], -d[1], -d[2]];
          const FI = faceIndex[f];
          const t1 = FACE_UV[f][0], t2 = FACE_UV[f][1];
          for (let j = 0; j < FC; j++) for (let i = 0; i < FC; i++) {
            const a = ((i + 0.5) / FC - 0.5) * voxel, b = ((j + 0.5) / FC - 0.5) * voxel;
            const p = [
              fc[0] + d[0] * RAY_OUT + t1[0] * a + t2[0] * b,
              fc[1] + d[1] * RAY_OUT + t1[1] * a + t2[1] * b,
              fc[2] + d[2] * RAY_OUT + t1[2] * a + t2[2] * b,
            ];
            // 正交射线求交（Möller–Trumbore），取沿视线朝内的第一命中
            let bestD = Infinity, bestU = 0, bestV = 0, bestLv = 0;
            const iu = ((p[FI.u_ax] - min[FI.u_ax]) / voxel) | 0;
            const iv = ((p[FI.v_ax] - min[FI.v_ax]) / voxel) | 0;
            const list = (iu >= 0 && iv >= 0 && iu < FI.NU && iv < FI.NV) ? FI.buckets[iv * FI.NU + iu] : null;
            for (let li = 0; list && li < list.length; li++) {
              const ti = list[li];
              const t = ti * 9;
              const Av = triPos[t];
              const e1x = triPos[t + 3] - Av, e1y = triPos[t + 4] - triPos[t + 1], e1z = triPos[t + 5] - triPos[t + 2];
              const e2x = triPos[t + 6] - Av, e2y = triPos[t + 7] - triPos[t + 1], e2z = triPos[t + 8] - triPos[t + 2];
              const pxv = rd[1] * e2z - rd[2] * e2y, pyv = rd[2] * e2x - rd[0] * e2z, pzv = rd[0] * e2y - rd[1] * e2x;
              const det = e1x * pxv + e1y * pyv + e1z * pzv;
              if (det <= 1e-14) continue;   // 掠射面 或 背面
              const inv = 1 / det;
              const tvx = p[0] - Av, tvy = p[1] - triPos[t + 1], tvz = p[2] - triPos[t + 2];
              const u = (tvx * pxv + tvy * pyv + tvz * pzv) * inv;
              if (u < -1e-6 || u > 1 + 1e-6) continue;
              const qx = tvy * e1z - tvz * e1y, qy = tvz * e1x - tvx * e1z, qz = tvx * e1y - tvy * e1x;
              const v = (rd[0] * qx + rd[1] * qy + rd[2] * qz) * inv;
              if (v < -1e-6 || u + v > 1 + 1e-6) continue;
              const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
              if (tt < 1e-9 || tt >= bestD || tt > RAY_MAX) continue;
              bestD = tt;
              const ub = ti * 6;
              bestU = triUv[ub] * (1 - u - v) + triUv[ub + 2] * u + triUv[ub + 4] * v;
              bestV = triUv[ub + 1] * (1 - u - v) + triUv[ub + 3] * u + triUv[ub + 5] * v;
              bestLv = triMip[ti];
            }
            const si2 = (j * FC + i) * 3;
            if (bestD === Infinity) {
              tmp[si2] = avg[0]; tmp[si2 + 1] = avg[1]; tmp[si2 + 2] = avg[2];
              valid[j * FC + i] = 0;
            } else {
              sampleMip(bestU, bestV, Math.max(0, bestLv - Math.log2(FC)), smp);
              const ok = uvValid(bestU, bestV);
              if (!ok) { smp[0] = avg[0]; smp[1] = avg[1]; smp[2] = avg[2]; }
              tmp[si2] = smp[0]; tmp[si2 + 1] = smp[1]; tmp[si2 + 2] = smp[2];
              valid[j * FC + i] = ok ? 1 : 0;
            }
          }
          // FC² → FT² 降采样，只平均有效子点
          for (let j = 0; j < FT; j++) for (let i = 0; i < FT; i++) {
            const si = (j * FT + i) * 3;
            for (let c = 0; c < 3; c++) {
              let s = 0, nn = 0;
              for (let dj = 0; dj < SS2; dj++) for (let di = 0; di < SS2; di++) {
                const q = (j * SS2 + dj) * FC + i * SS2 + di;
                if (valid[q]) { s += tmp[q * 3 + c]; nn++; }
              }
              content[si + c] = nn ? s / nn : avg[c];
            }
          }
          // 方差判定：图案面 or 纯色面
          let m0 = 0, m1 = 0, m2 = 0;
          for (let i = 0; i < content.length; i += 3) { m0 += content[i]; m1 += content[i + 1]; m2 += content[i + 2]; }
          m0 /= FT * FT; m1 /= FT * FT; m2 /= FT * FT;
          let vs = 0;
          for (let i = 0; i < content.length; i += 3) {
            const dr = content[i] - m0, dg = content[i + 1] - m1, db = content[i + 2] - m2;
            vs += dr * dr + dg * dg + db * db;
          }
          if (Math.sqrt(vs / (FT * FT * 3)) < FACE_THR) {
            const q = (val) => Math.max(0, Math.min(255, Math.round(val / FACE_QUANT) * FACE_QUANT));
            for (let i = 0; i < content.length; i += 3) {
              content[i] = q(avg[0]); content[i + 1] = q(avg[1]); content[i + 2] = q(avg[2]);
            }
            flatFaces++;
          } else patFaces++;
        } else {
          for (let i = 0; i < content.length; i += 3) {
            content[i] = Math.round(avg[0]); content[i + 1] = Math.round(avg[1]); content[i + 2] = Math.round(avg[2]);
          }
          flatFaces++;
        }

        // 全内容精确去重（有损哈希会让"仅在部分 texel 上不同"的两张面碰撞共享槽位 → 图案错乱）
        const s = Buffer.from(content).toString('base64');
        let slot = slotMap.get(s);
        if (slot === undefined) { slot = atlasList.length; slotMap.set(s, slot); atlasList.push(content); }
        faceSlotArr[fIdx] = slot;
      }
    }

    // 组装图集
    const AGRID = Math.max(16, 1 << Math.ceil(Math.log2(Math.ceil(Math.sqrt(atlasList.length)))));
    const AROWS = Math.ceil(atlasList.length / AGRID);
    const AW = AGRID * FT, AH = AROWS * FT;
    const atlasRGB = new Uint8Array(AW * AH * 3);
    atlasList.forEach((content, s) => {
      const gx = (s % AGRID) * FT, gy = Math.floor(s / AGRID) * FT;
      for (let y = 0; y < FT; y++) for (let x = 0; x < FT; x++) {
        const si = (y * FT + x) * 3, di = ((gy + y) * AW + gx + x) * 3;
        atlasRGB[di] = content[si]; atlasRGB[di + 1] = content[si + 1]; atlasRGB[di + 2] = content[si + 2];
      }
    });
    // contents 保留每个槽位的原始小块：多个模型合并成一张全局图集时需要它来重新去重
    atlas = { grid: AGRID, rows: AROWS, slots: atlasList.length, texel: FT, data: atlasRGB, contents: atlasList };
    log(`面纹理: 图案面 ${patFaces} + 纯色面 ${flatFaces} → 图集 ${atlasList.length} 槽 (${AW}x${AH})  用时 ${((Date.now() - t0f) / 1000).toFixed(1)}s`);
  }

  // ---------- 输出 ----------
  const index = new Int32Array(N);
  const coord = new Int32Array(N * 3);
  const color = new Uint8Array(N * 3);
  const stepQ = QUANT > 1 ? 255 / (QUANT - 1) : 0;
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let lumMin = 255, lumMax = 0;
  for (let i = 0; i < N; i++) {
    const key = keys[i];
    const n = cnt[key];
    index[i] = key;
    const x = key % nx, y = Math.floor(key / nx) % ny, z = Math.floor(key / (nx * ny));
    coord[i * 3] = x; coord[i * 3 + 1] = y; coord[i * 3 + 2] = z;
    let cr = acc[key * 3] / n, cg = acc[key * 3 + 1] / n, cb = acc[key * 3 + 2] / n;
    if (SAT !== 1) {
      const lum = 0.299 * cr + 0.587 * cg + 0.114 * cb;
      cr = lum + (cr - lum) * SAT;
      cg = lum + (cg - lum) * SAT;
      cb = lum + (cb - lum) * SAT;
    }
    const rgb = [cr, cg, cb];
    for (let c = 0; c < 3; c++) {
      let v = rgb[c];
      if (stepQ) v = Math.round(v / stepQ) * stepQ;
      if (JITTER) v *= 1 - JITTER / 2 + rnd() * JITTER;
      v = Math.max(0, Math.min(255, Math.round(v)));
      color[i * 3 + c] = v;
    }
    const l = 0.299 * color[i * 3] + 0.587 * color[i * 3 + 1] + 0.114 * color[i * 3 + 2];
    if (l < lumMin) lumMin = l;
    if (l > lumMax) lumMax = l;
  }
  log(`亮度范围: ${lumMin.toFixed(0)} ~ ${lumMax.toFixed(0)}   总用时 ${((Date.now() - T0) / 1000).toFixed(1)}s`);

  return {
    nx, ny, nz, voxel,
    origin: [min[0], min[1], min[2]],
    size: [size[0], size[1], size[2]],
    count: N,
    index, coord, color,
    faceSlot: faceSlotArr,
    atlas,
  };
}

module.exports = { voxelize, FACE_DIRS, FACE_UV, FACE_NAMES, parseGLB };
