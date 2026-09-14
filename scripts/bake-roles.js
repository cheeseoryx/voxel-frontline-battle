#!/usr/bin/env node
/*
 * scripts/bake-roles.js — 体素角色资产烘焙（44MB -> 约 6MB）
 *
 * 输入（.gitignore 排除的原始导出，assets/Roles/）：
 *   Soldier01~04_Skin.glb      蒙皮网格（02~04 内嵌 4096² PNG）
 *   Soldier01_Walk_120.glb     原地 Walk，1.2s，首尾同姿势
 *   Soldier01_Run_245.glb      原地 Run，0.8s，首尾同姿势
 *   Soldier01_Pick.glb         Pick，1.6s，第 0 帧是可用站姿
 *
 * 输出（提交进仓库，assets/characters/）：
 *   soldier01.glb … soldier04.glb   蒙皮网格，贴图统一 1024²
 *   soldier_anims.glb               仅骨架 + Walk/Run/Pick 三个 clip
 *
 * 用法：node scripts/bake-roles.js
 * 依赖：python + Pillow（仅贴图重采样；缺失时明确报错并中止，不产出半成品）
 *
 * 安全：全部产物先写 *.tmp，自检通过后才 rename 替换正式文件。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'Roles');
const OUT = path.join(ROOT, 'assets', 'characters');
const RESIZE_PY = path.join(__dirname, 'lib', 'resize_png.py');
const TEX_SIZE = 1024;

const SKINS = [
  { src: 'Soldier01_Skin.glb', out: 'soldier01.glb' },
  { src: 'Soldier02_Skin.glb', out: 'soldier02.glb' },
  { src: 'Soldier03_Skin.glb', out: 'soldier03.glb' },
  { src: 'Soldier04_Skin.glb', out: 'soldier04.glb' },
];
const ANIMS = [
  { src: 'Soldier01_Walk_120.glb', name: 'Walk' },
  { src: 'Soldier01_Run_245.glb', name: 'Run' },
  { src: 'Soldier01_Pick.glb', name: 'Pick' },
];

/* ---------- GLB 读写 ---------- */

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) {
    throw new Error('不是 GLB: ' + file);
  }
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  const binOfs = 20 + jsonLen + 8; // 跳过 BIN chunk 头（本批文件 JSON 在前 BIN 在后）
  return { json, bin: buf.slice(binOfs) };
}

function writeGlb(file, json, bin) {
  let jsonStr = JSON.stringify(json);
  while (jsonStr.length % 4) jsonStr += ' ';
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  const binPad = (4 - (bin.length % 4)) % 4;
  const binBuf = binPad ? Buffer.concat([bin, Buffer.alloc(binPad)]) : bin;
  const total = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(binBuf.length, 0);
  bh.writeUInt32LE(0x004e4942, 4); // 'BIN\0'
  fs.writeFileSync(file, Buffer.concat([head, jh, jsonBuf, bh, binBuf]));
}

// 用 newData 替换第 replaceIndex 个 bufferView 并重建 BIN（4 字节对齐）。
// bufferView 索引保持不变，byteOffset 重排。
function repackBin(glb, replaceIndex, newData) {
  const parts = [];
  let offset = 0;
  const newViews = glb.json.bufferViews.map((v, i) => {
    const data =
      i === replaceIndex
        ? newData
        : glb.bin.slice(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength);
    const nv = { buffer: 0, byteLength: data.length };
    if (offset) nv.byteOffset = offset;
    if (v.byteStride != null) nv.byteStride = v.byteStride;
    if (v.target != null) nv.target = v.target;
    if (v.name) nv.name = v.name;
    parts.push(data);
    offset += data.length;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      parts.push(Buffer.alloc(pad));
      offset += pad;
    }
    return nv;
  });
  const json = Object.assign({}, glb.json, { bufferViews: newViews });
  json.buffers = [{ byteLength: offset }];
  return { json, bin: Buffer.concat(parts) };
}

/* ---------- PNG ---------- */

function pngSize(png) {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('不是 PNG（或文件头损坏）');
  }
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

function resizePng(png, size) {
  const tmpIn = path.join(OUT, '_bake_in.png');
  const tmpOut = path.join(OUT, '_bake_out.png');
  fs.writeFileSync(tmpIn, png);
  try {
    execFileSync('python', [RESIZE_PY, tmpIn, tmpOut, String(size)], {
      stdio: 'pipe',
    });
  } catch (e) {
    throw new Error(
      '贴图重采样失败：需要 python + Pillow（pip install pillow）。' +
        (e.stderr ? '\n' + e.stderr.toString() : '')
    );
  }
  const out = fs.readFileSync(tmpOut);
  fs.unlinkSync(tmpIn);
  fs.unlinkSync(tmpOut);
  return out;
}

/* ---------- 蒙皮烘焙 ---------- */

function boneNames(json) {
  return json.nodes
    .filter((n) => n.name && n.name.indexOf('Bip001') === 0)
    .map((n) => n.name)
    .sort();
}

function bakeSkin(entry) {
  const srcPath = path.join(SRC, entry.src);
  const glb = readGlb(srcPath);
  const json = glb.json;
  const img = json.images && json.images[0];
  if (!img || img.bufferView == null) {
    throw new Error(entry.src + ' 没有内嵌贴图');
  }
  const view = json.bufferViews[img.bufferView];
  const png = glb.bin.slice(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
  const dim = pngSize(png);

  let baked = glb;
  if (dim.w > TEX_SIZE || dim.h > TEX_SIZE) {
    baked = repackBin(glb, img.bufferView, resizePng(png, TEX_SIZE));
  }

  const tmpPath = path.join(OUT, entry.out + '.tmp');
  writeGlb(tmpPath, baked.json, baked.bin);

  // 自检：重读产物，顶点数 / 包围盒 / 骨骼名 / 贴图尺寸与原始一致
  const check = readGlb(tmpPath);
  const prim0 = json.meshes[0].primitives[0];
  const prim1 = check.json.meshes[0].primitives[0];
  const posA = json.accessors[prim0.attributes.POSITION];
  const posB = check.json.accessors[prim1.attributes.POSITION];
  if (posA.count !== posB.count) throw new Error(entry.out + ' 顶点数不一致');
  if (JSON.stringify(posA.min) !== JSON.stringify(posB.min)) {
    throw new Error(entry.out + ' 包围盒 min 不一致');
  }
  if (JSON.stringify(posA.max) !== JSON.stringify(posB.max)) {
    throw new Error(entry.out + ' 包围盒 max 不一致');
  }
  if (JSON.stringify(boneNames(json)) !== JSON.stringify(boneNames(check.json))) {
    throw new Error(entry.out + ' 骨骼名不一致');
  }
  const outView = check.json.bufferViews[check.json.images[0].bufferView];
  const outPng = check.bin.slice(outView.byteOffset || 0, (outView.byteOffset || 0) + outView.byteLength);
  const outDim = pngSize(outPng);
  if (outDim.w > TEX_SIZE || outDim.h > TEX_SIZE) {
    throw new Error(entry.out + ' 贴图未降到 ' + TEX_SIZE);
  }
  const size = fs.statSync(tmpPath).size;
  fs.renameSync(tmpPath, path.join(OUT, entry.out));
  console.log(
    'bake skin ' + entry.out + '  tex ' + dim.w + '->' + outDim.w +
    '  ' + (size / 1048576).toFixed(2) + 'MB'
  );
  return boneNames(check.json);
}

/* ---------- 动作库烘焙 ---------- */

// 三个动作文件共享同一副 34 节点骨架（0 号是蒙皮网格节点，1..33 是骨骼）。
// 动作库只保留 1..33 号节点（索引整体 -1），合并三个 clip 的 accessor 数据。
function bakeAnims(skinBones) {
  const base = readGlb(path.join(SRC, ANIMS[0].src));
  const nodes = base.json.nodes.slice(1).map((n) => {
    const node = { name: n.name };
    if (n.translation) node.translation = n.translation;
    if (n.rotation) node.rotation = n.rotation;
    if (n.scale) node.scale = n.scale;
    if (n.children) node.children = n.children.map((c) => c - 1);
    return node;
  });

  const json = {
    asset: { version: '2.0', generator: 'bake-roles.js (UE5 voxel soldier exports)' },
    scene: 0,
    scenes: [{ nodes: [0] }], // 旧 1 号 Root_zhujue01 -> 新 0 号
    nodes: nodes,
    accessors: [],
    bufferViews: [],
    buffers: [{ byteLength: 0 }],
    animations: [],
  };
  const parts = [];
  let offset = 0;

  ANIMS.forEach((entry) => {
    const src = readGlb(path.join(SRC, entry.src));
    const anim = src.json.animations && src.json.animations[0];
    if (!anim) throw new Error(entry.src + ' 没有动作');
    const accMap = new Map();
    const remapAccessor = (oldIndex) => {
      if (accMap.has(oldIndex)) return accMap.get(oldIndex);
      const acc = Object.assign({}, src.json.accessors[oldIndex]);
      const view = src.json.bufferViews[acc.bufferView];
      const data = src.bin.slice(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
      const nv = { buffer: 0, byteLength: data.length };
      if (offset) nv.byteOffset = offset;
      json.bufferViews.push(nv);
      parts.push(data);
      offset += data.length;
      const pad = (4 - (offset % 4)) % 4;
      if (pad) {
        parts.push(Buffer.alloc(pad));
        offset += pad;
      }
      acc.bufferView = json.bufferViews.length - 1;
      json.accessors.push(acc);
      accMap.set(oldIndex, json.accessors.length - 1);
      return accMap.get(oldIndex);
    };
    const samplers = anim.samplers.map((s) => ({
      input: remapAccessor(s.input),
      output: remapAccessor(s.output),
      interpolation: s.interpolation || 'LINEAR',
    }));
    const channels = anim.channels.map((c) => ({
      sampler: c.sampler,
      target: { node: c.target.node - 1, path: c.target.path },
    }));
    json.animations.push({ name: entry.name, samplers: samplers, channels: channels });
  });

  json.buffers[0].byteLength = offset;

  const tmpPath = path.join(OUT, 'soldier_anims.glb.tmp');
  writeGlb(tmpPath, json, Buffer.concat(parts));

  // 自检：重读产物，clip 名齐全、索引不越界、动作骨骼名 ⊆ 蒙皮骨骼名
  const check = readGlb(tmpPath);
  const names = check.json.animations.map((a) => a.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(['Pick', 'Run', 'Walk'])) {
    throw new Error('soldier_anims.glb clip 名不对: ' + names.join(','));
  }
  check.json.animations.forEach((a) => {
    a.channels.forEach((c) => {
      if (c.target.node < 0 || c.target.node >= check.json.nodes.length) {
        throw new Error('soldier_anims.glb 存在越界节点索引');
      }
    });
    a.samplers.forEach((s) => {
      if (s.input >= check.json.accessors.length || s.output >= check.json.accessors.length) {
        throw new Error('soldier_anims.glb 存在越界 accessor 索引');
      }
    });
  });
  const animBoneSet = new Set(
    check.json.nodes.filter((n) => n.name && n.name.indexOf('Bip001') === 0).map((n) => n.name)
  );
  skinBones.forEach((b) => {
    if (!animBoneSet.has(b)) throw new Error('动作库缺少骨骼: ' + b);
  });
  animBoneSet.forEach((b) => {
    if (skinBones.indexOf(b) < 0) throw new Error('动作库存在蒙皮没有的骨骼: ' + b);
  });
  const size = fs.statSync(tmpPath).size;
  fs.renameSync(tmpPath, path.join(OUT, 'soldier_anims.glb'));
  console.log('bake anims soldier_anims.glb  ' + (size / 1024).toFixed(0) + 'KB');
}

/* ---------- main ---------- */

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  SKINS.forEach((s) => {
    if (!fs.existsSync(path.join(SRC, s.src))) throw new Error('缺输入: ' + s.src);
  });
  ANIMS.forEach((a) => {
    if (!fs.existsSync(path.join(SRC, a.src))) throw new Error('缺输入: ' + a.src);
  });
  const skinBones = bakeSkin(SKINS[0]);
  SKINS.slice(1).forEach(bakeSkin);
  bakeAnims(skinBones);
  console.log('done. 记得把 index.html 相关 js 的 ?v= 令牌 bump 为 voxelskin1');
}

main();
