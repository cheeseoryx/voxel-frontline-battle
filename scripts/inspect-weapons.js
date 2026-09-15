#!/usr/bin/env node
/*
 * scripts/inspect-weapons.js — 枪械美术资产体检
 *
 * 扫描 assets/weapons/raw/（没有就看 assets/weapons/）下所有 .glb，输出判断
 * 「能不能接、要不要修正」所需的数据：
 *   - 节点树 / mesh / 材质 / 贴图
 *   - 世界包围盒与三轴尺寸 → 长轴是不是 Z（游戏约定枪口朝 -Z）
 *   - 沿长轴的粗细分布 → 哪一端是枪口（细的一端）
 *   - 原点在世界包围盒的什么位置 → 要不要平移到握把
 *   - 有没有 Muzzle 空节点
 *
 * 用法：node scripts/inspect-weapons.js
 * 无第三方依赖，纯解析 GLB 容器。结果同时写 tmp/weapons-inspect.txt（UTF-8）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = [
  path.join(ROOT, 'assets', 'weapons', 'raw'),
  path.join(ROOT, 'assets', 'weapons'),
];
const OUT = path.join(ROOT, 'tmp', 'weapons-inspect.txt');

const TYPE_NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/* ---------- GLB ---------- */

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) {
    throw new Error('不是 GLB: ' + file);
  }
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  const binOfs = 20 + jsonLen + 8;
  return { json: json, bin: buf.slice(binOfs), size: buf.length };
}

function accessorMinMax(glb, idx) {
  const acc = glb.json.accessors[idx];
  if (!acc || !acc.min || !acc.max) return null;
  return { min: acc.min.slice(), max: acc.max.slice() };
}

const COMP_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

/** 读 POSITION 全部顶点（只处理 float32 / uint16 / int16 归一化的常见情况） */
function readPositions(glb, idx, limit) {
  const acc = glb.json.accessors[idx];
  if (!acc) return [];
  const view = glb.json.bufferViews[acc.bufferView];
  const n = TYPE_NUM[acc.type] || 3;
  const s = COMP_SIZE[acc.componentType] || 4;
  const stride = view.byteStride || n * s;
  const start = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const count = limit ? Math.min(limit, acc.count) : acc.count;
  const raw = glb.bin;
  const out = [];
  for (let i = 0; i < count; i++) {
    const base = start + i * stride;
    if (base + n * s > raw.length) break;
    const p = [];
    for (let k = 0; k < 3; k++) {
      const o = base + k * s;
      if (acc.componentType === 5126) p.push(raw.readFloatLE(o));
      else if (acc.componentType === 5123) p.push(raw.readUInt16LE(o) / 65535);
      else if (acc.componentType === 5122) p.push(raw.readInt16LE(o) / 32767);
      else p.push(raw.readFloatLE(o));
    }
    if (acc.normalized && (acc.componentType === 5123 || acc.componentType === 5122)) {
      // 已按上面归一化
    }
    out.push(p);
  }
  return out;
}

/* ---------- 矩阵 ---------- */

function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

// glTF 是列主序：m[col*4 + row]
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = v;
    }
  }
  return out;
}

function fromTRS(t, r, s) {
  t = t || [0, 0, 0];
  s = s || [1, 1, 1];
  let m;
  if (r) {
    const [x, y, z, w] = r;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    m = [
      1 - (yy + zz), xy + wz, xz - wy, 0,
      xy - wz, 1 - (xx + zz), yz + wx, 0,
      xz + wy, yz - wx, 1 - (xx + yy), 0,
      0, 0, 0, 1,
    ];
  } else {
    m = identity();
  }
  for (let i = 0; i < 3; i++) {
    m[i * 4 + 0] *= s[0];
    m[i * 4 + 1] *= s[1];
    m[i * 4 + 2] *= s[2];
  }
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  return m;
}

function transformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function localMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  return fromTRS(node.translation, node.rotation, node.scale);
}

/* ---------- 遍历 ---------- */

function walk(glb, parentMatrix, nodeIdx, depth, visit) {
  const node = glb.json.nodes[nodeIdx];
  const m = multiply(parentMatrix, localMatrix(node));
  visit(node, m, depth, nodeIdx);
  (node.children || []).forEach((c) => walk(glb, m, c, depth + 1, visit));
}

function collect(glb) {
  const meshes = []; // { name, worldMatrix, min, max }
  const nodes = []; // { name, worldPos, depth, hasMesh }
  const scenes = glb.json.scenes || [];
  const roots = (scenes[0] && scenes[0].nodes) || glb.json.nodes.map((_, i) => i);

  roots.forEach((r) =>
    walk(glb, identity(), r, 0, (node, m, depth, idx) => {
      const worldPos = [m[12], m[13], m[14]];
      nodes.push({ name: node.name || '(unnamed)', worldPos, depth, hasMesh: node.mesh != null, idx });
      if (node.mesh != null) {
        const mesh = glb.json.meshes[node.mesh];
        (mesh.primitives || []).forEach((prim) => {
          const mm = accessorMinMax(glb, prim.attributes.POSITION);
          if (!mm) return;
          meshes.push({
            name: (mesh.name || node.name || '') + '#' + (prim.material != null ? prim.material : '?'),
            worldMatrix: m,
            min: mm.min,
            max: mm.max,
            posIdx: prim.attributes.POSITION,
          });
        });
      }
    })
  );
  return { meshes, nodes };
}

function worldAabb(meshes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  meshes.forEach((e) => {
    const { min: lo, max: hi } = e;
    for (let i = 0; i < 8; i++) {
      const p = [
        i & 1 ? hi[0] : lo[0],
        i & 2 ? hi[1] : lo[1],
        i & 4 ? hi[2] : lo[2],
      ];
      const w = transformPoint(e.worldMatrix, p);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], w[k]);
        max[k] = Math.max(max[k], w[k]);
      }
    }
  });
  return { min, max };
}

/**
 * 顶点级剖面：沿长轴切 N 段，统计每段顶点数、另两轴的跨度、到轴线的最大半径。
 * 枪口端（枪管）半径小，枪托端（机匣/枪托）半径大。
 */
function vertexProfile(glb, meshes, axis, n) {
  n = n || 24;
  const aabb = worldAabb(meshes);
  const lo = aabb.min[axis];
  const span = aabb.max[axis] - aabb.min[axis];
  if (!(span > 0)) return null;
  const o1 = (axis + 1) % 3;
  const o2 = (axis + 2) % 3;
  const center = [0, 1, 2].map((k) => (aabb.min[k] + aabb.max[k]) / 2);
  const buckets = [];
  for (let i = 0; i < n; i++) {
    buckets.push({ count: 0, ex: [Infinity, -Infinity], ey: [Infinity, -Infinity], r: 0 });
  }

  meshes.forEach((e) => {
    const verts = readPositions(glb, e.posIdx);
    verts.forEach((p) => {
      const w = transformPoint(e.worldMatrix, p);
      const t = (w[axis] - lo) / span;
      const b = Math.min(n - 1, Math.max(0, Math.floor(t * n)));
      const bk = buckets[b];
      bk.count++;
      bk.ex[0] = Math.min(bk.ex[0], w[o1]); bk.ex[1] = Math.max(bk.ex[1], w[o1]);
      bk.ey[0] = Math.min(bk.ey[0], w[o2]); bk.ey[1] = Math.max(bk.ey[1], w[o2]);
      const d1 = w[o1] - center[o1];
      const d2 = w[o2] - center[o2];
      bk.r = Math.max(bk.r, Math.sqrt(d1 * d1 + d2 * d2));
    });
  });
  return buckets.map((b, i) => ({
    seg: i,
    from: +(lo + (span * i) / n).toFixed(3),
    to: +(lo + (span * (i + 1)) / n).toFixed(3),
    count: b.count,
    e1: b.count ? +(b.ex[1] - b.ex[0]).toFixed(3) : 0,
    e2: b.count ? +(b.ey[1] - b.ey[0]).toFixed(3) : 0,
    r: +b.r.toFixed(3),
  }));
}

/**
 * ASCII 侧视图：长轴横向（左=负方向，右=正方向），另一轴（高度）纵向。
 * 一眼看出枪托 / 弹匣 / 枪管分别在哪一端。
 */
function asciiProfile(prof, axisName, upName, cols, rows) {
  cols = cols || 72;
  rows = rows || 14;
  const maxE = Math.max.apply(null, prof.map((p) => p.e1 + p.e2)) || 1;
  const maxR = Math.max.apply(null, prof.map((p) => p.r)) || 1;
  const grid = [];
  for (let r = 0; r < rows; r++) grid.push(new Array(cols).fill(' '));

  for (let c = 0; c < cols; c++) {
    const p = prof[Math.min(prof.length - 1, Math.floor((c / cols) * prof.length))];
    if (!p || !p.count) continue;
    const half = (p.e2 / maxE) * (rows / 2); // e2 = 高度轴跨度（axis+2）
    const mid = rows / 2;
    const top = Math.max(0, Math.round(mid - half));
    const bot = Math.min(rows - 1, Math.round(mid + half));
    for (let r = top; r <= bot; r++) {
      grid[r][c] = p.r > maxR * 0.66 ? '#' : p.r > maxR * 0.33 ? '+' : '.';
    }
  }
  const lines = grid.map((row) => '    |' + row.join('') + '|');
  lines.push('    +' + '-'.repeat(cols) + '+');
  lines.push('     ' + axisName + '- ' + prof[0].from + 'm' + ' '.repeat(Math.max(0, cols - 22)) +
    axisName + '+ ' + prof[prof.length - 1].to.toFixed(3) + 'm');
  lines.push('     （纵向 = ' + upName + ' 轴跨度，# 粗 / + 中 / . 细）');
  return lines.join('\n');
}

/* ---------- 主流程 ---------- */

function listGlb() {
  const out = [];
  DIRS.forEach((dir) => {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach((f) => {
      if (f.toLowerCase().endsWith('.glb')) {
        out.push({ file: path.join(dir, f), name: f, fromRaw: path.basename(dir) === 'raw' });
      }
    });
  });
  return out;
}

function fmt(v) {
  return v.map((x) => (+x).toFixed(3)).join(', ');
}

function main() {
  const lines = [];
  const log = (s) => {
    lines.push(s);
    console.log(s);
  };
  const files = listGlb();
  if (!files.length) {
    log('没找到 .glb（找过 ' + DIRS.map((d) => path.relative(ROOT, d)).join(' / ') + '）');
    return;
  }

  files.forEach((f) => {
    log('');
    log('='.repeat(72));
    log(f.name + '   [' + (f.fromRaw ? 'raw' : 'weapons') + ']  ' +
        (fs.statSync(f.file).size / 1024).toFixed(0) + ' KB');
    let glb;
    try {
      glb = readGlb(f.file);
    } catch (e) {
      log('  读取失败: ' + e.message);
      return;
    }
    const j = glb.json;
    log('  glTF ' + (j.asset && j.asset.version) + '  generator: ' + (j.asset && j.asset.generator));
    log('  scenes=' + (j.scenes || []).length + ' nodes=' + (j.nodes || []).length +
        ' meshes=' + (j.meshes || []).length + ' materials=' + (j.materials || []).length +
        ' images=' + (j.images || []).length + ' animations=' + (j.animations || []).length +
        ' skins=' + (j.skins || []).length);
    const extUsed = j.extensionsUsed || [];
    if (extUsed.length) log('  extensions: ' + extUsed.join(', '));

    // 材质与贴图
    (j.materials || []).forEach((m, i) => {
      log('  material[' + i + '] ' + JSON.stringify(m));
    });
    (j.images || []).forEach((im, i) => {
      const src = j.bufferViews[(j.samplers && false) ? 0 : (im.bufferView != null ? im.bufferView : 0)];
      log('  image[' + i + '] ' + JSON.stringify(im) +
          (im.bufferView != null ? '  bufferView 字节数=' + (src && src.byteLength) : ' (uri)'));
    });

    // 节点变换（判断 UE→glTF 的轴向映射）
    (j.nodes || []).slice(0, 3).forEach((n, i) => {
      const parts = [];
      if (n.matrix) parts.push('matrix=[' + n.matrix.map((v) => (+v).toFixed(3)).join(',') + ']');
      if (n.translation) parts.push('T=[' + fmt(n.translation) + ']');
      if (n.rotation) parts.push('R=[' + n.rotation.map((v) => (+v).toFixed(3)).join(',') + ']');
      if (n.scale) parts.push('S=[' + fmt(n.scale) + ']');
      log('  node[' + i + '] "' + (n.name || '(unnamed)') + '" ' + (parts.join('  ') || '(无变换)'));
    });

    const { meshes, nodes } = collect(glb);
    if (!meshes.length) {
      log('  !! 没有可度量的 mesh（POSITION 缺 min/max）');
      return;
    }
    const aabb = worldAabb(meshes);
    const size = [aabb.max[0] - aabb.min[0], aabb.max[1] - aabb.min[1], aabb.max[2] - aabb.min[2]];
    log('  世界 AABB min=[' + fmt(aabb.min) + ']  max=[' + fmt(aabb.max) + ']');
    log('  尺寸 W(x)=' + size[0].toFixed(3) + '  H(y)=' + size[1].toFixed(3) + '  D(z)=' + size[2].toFixed(3) + ' m');

    const axisNames = ['X', 'Y', 'Z'];
    let longAxis = 0;
    for (let k = 1; k < 3; k++) if (size[k] > size[longAxis]) longAxis = k;
    const rest = [0, 1, 2].filter((k) => k !== longAxis).map((k) => size[k]);
    log('  长轴 = ' + axisNames[longAxis] + ' (' + size[longAxis].toFixed(3) + 'm)，另两轴 ' +
        rest.map((r) => r.toFixed(3)).join(' / '));
    log('  判断: ' + (longAxis === 2
      ? '长轴是 Z ✓（符合枪口朝 -Z 的约定，只需确认正负方向）'
      : '长轴是 ' + axisNames[longAxis] + ' ✗（需要旋转到 Z 轴）'));

    const prof = vertexProfile(glb, meshes, longAxis, 24);
    if (prof) {
      const valid = prof.filter((p) => p.count > 0);
      if (valid.length >= 4) {
        const head = valid.slice(0, 4).reduce((s, p) => s + p.r, 0) / 4;
        const tail = valid.slice(-4).reduce((s, p) => s + p.r, 0) / 4;
        log('  侧视轮廓（长轴 ' + axisNames[longAxis] + ' 横向，左=负 右=正）:');
        log(asciiProfile(prof, axisNames[longAxis], axisNames[(longAxis + 2) % 3]));
        log('  半径剖面 r: ' + prof.map((p) => p.r.toFixed(2)).join(' '));
        const muzzleEnd = head < tail ? '负' : '正';
        log('  → 推测枪口在 ' + axisNames[longAxis] + ' 的' + muzzleEnd + '方向' +
            '（负端半径均值 ' + head.toFixed(3) + ' vs 正端 ' + tail.toFixed(3) + '）');
      }
    }

    // 原点相对包围盒的位置
    const rel = [0, 1, 2].map((k) => {
      const s = size[k];
      return s > 1e-6 ? ((0 - aabb.min[k]) / s * 100).toFixed(0) + '%' : 'n/a';
    });
    log('  原点(0,0,0) 在包围盒中的位置: x=' + rel[0] + ' y=' + rel[1] + ' z=' + rel[2] +
        '   （握把应在长轴 25~45% 处、高度 20~50% 处）');

    // Muzzle 节点
    const muzzleNode = nodes.find((n) => /muzzle|muzzleflash|枪口|socket/i.test(n.name));
    log('  Muzzle 节点: ' + (muzzleNode
      ? '有 → "' + muzzleNode.name + '" 世界坐标 [' + fmt(muzzleNode.worldPos) + ']'
      : '无 ✗（需按包围盒自动补）'));

    // 节点树（前 3 层）
    log('  节点树:');
    nodes.filter((n) => n.depth <= 2).forEach((n) => {
      log('    ' + '  '.repeat(n.depth) + '- ' + n.name + (n.hasMesh ? '  [mesh]' : ''));
    });
    if (nodes.some((n) => n.depth > 2)) log('    ...（更深节点省略，共 ' + nodes.length + ' 个）');
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
  console.log('\n结果已写入 ' + path.relative(ROOT, OUT));
}

main();
