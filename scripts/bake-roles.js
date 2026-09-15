#!/usr/bin/env node
/*
 * scripts/bake-roles.js — 体素角色资产烘焙（44MB -> 约 6MB）
 *
 * 输入（.gitignore 排除的原始导出，assets/Roles/，规格见 assets/Roles/README.md）：
 *   Soldier01~04_Skin.glb      蒙皮网格（02~04 内嵌 4096² PNG）
 *   Soldier01_<动作>.glb        动作，只导骨骼、原地、可循环
 *     已有：Walk_120(1.2s) / Run_245(0.8s) / Pick(1.6s，第 0 帧当站姿用)
 *     新增动作：在下方 ANIMS 加一行即可，命名 Soldier01_Idle.glb 这种
 *
 * 输出（提交进仓库，assets/characters/）：
 *   soldier01.glb … soldier04.glb   蒙皮网格，贴图统一 1024²
 *   soldier_anims.glb               仅骨架 + ANIMS 里全部 clip
 *
 * 体检：node scripts/inspect-roles.js —— 打印 assets/Roles/ 下每个 GLB 的
 *   骨架比对 / clip 时长 / 是否原地 / 能否循环，用来判断新动作能不能接。
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
// 动作列表：美术把 Soldier01_XXX.glb 放进 assets/Roles/ 后，在这里加一行即可。
// name 即运行时 clip 名，js/soldier-voxel.js 靠它取动作。
// loop=false 的一次性动作（开火/换弹/落地/死亡…）播完由运行时自行回落。
//
// assets/Roles/ 现有 39 个动作，这里只收游戏真用得上的 15 个：
//   - 手枪系列（Pistol_*）暂不收：第三人称化身不区分武器，先统一用步枪姿态
//   - Idle(20.5s)/Rifle_Idle(14s) 太长，改用 Common_Fight_Idle(2s) 持枪战斗待机
//   - Pick 已废弃：以前没 Idle 才拿它的第 0 帧当站姿，现在有真 Idle 了
//   - AnNiu / InHand / Put_Away / Common_Attack_* / Hit_Down_* / Crouch_Idle 徒手版
//     等暂不收，等玩法真的用上再加
const ANIMS = [
  // 移动（原地、可循环）
  { src: 'Soldier01_Common_Fight_Idle.glb', name: 'Idle', loop: true },
  { src: 'Soldier01_Walk_120.glb', name: 'Walk', loop: true },
  { src: 'Soldier01_Run_245.glb', name: 'Run', loop: true },
  { src: 'Soldier01_Fast_Run_410.glb', name: 'Sprint', loop: true },
  { src: 'Soldier01_Rifle_Crouch_Idle.glb', name: 'CrouchIdle', loop: true },
  { src: 'Soldier01_Crouch_Walk_90.glb', name: 'CrouchWalk', loop: true },
  // 跳跃
  { src: 'Soldier01_Jump_Start.glb', name: 'JumpStart', loop: false },
  { src: 'Soldier01_Jump_Loop.glb', name: 'JumpLoop', loop: true },
  { src: 'Soldier01_Jump_end.glb', name: 'JumpEnd', loop: false },
  // 战斗
  { src: 'Soldier01_Rifle_Shoot_Once.glb', name: 'Shoot', loop: false },
  { src: 'Soldier01_Rifle_HuanDan.glb', name: 'Reload', loop: false },
  { src: 'Soldier01_Rifle_Aim_Idle.glb', name: 'AimIdle', loop: true },
  // 受击 / 死亡（Death、HitLarge 原始带约 1m 根位移，烘焙时会压平原地）
  { src: 'Soldier01_Hit_F.glb', name: 'Hit', loop: false },
  { src: 'Soldier01_Hit_Large.glb', name: 'HitLarge', loop: false },
  { src: 'Soldier01_Death.glb', name: 'Death', loop: false },
];
// 缺了就直接烘焙失败（站立与移动是硬需求）；其余动作可多可少。
const REQUIRED_CLIPS = ['Idle', 'Walk', 'Run'];

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

const COMP_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

// 读 FLOAT accessor 成二维数组（本批导出全部是 FLOAT，非 FLOAT 直接报错，
// 不做隐式转换——量化过的 accessor 走这条路会静默出错）。
function readFloats(glb, idx) {
  const acc = glb.json.accessors[idx];
  if (acc.componentType !== 5126) {
    throw new Error('accessor ' + idx + ' 不是 FLOAT，componentType=' + acc.componentType);
  }
  const n = TYPE_NUM[acc.type];
  const view = glb.json.bufferViews[acc.bufferView];
  const start = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const raw = glb.bin.slice(start, start + acc.count * n * 4);
  const out = [];
  for (let i = 0; i < acc.count; i++) {
    const el = [];
    for (let k = 0; k < n; k++) el.push(raw.readFloatLE(i * n * 4 + k * 4));
    out.push(el);
  }
  return out;
}

function writeFloats(rows) {
  const n = rows[0].length;
  const buf = Buffer.alloc(rows.length * n * 4);
  for (let i = 0; i < rows.length; i++) {
    for (let k = 0; k < n; k++) buf.writeFloatLE(rows[i][k], i * n * 4 + k * 4);
  }
  return buf;
}

function isConstant(rows, eps) {
  const e = eps == null ? 1e-5 : eps;
  for (let i = 1; i < rows.length; i++) {
    for (let k = 0; k < rows[i].length; k++) {
      if (Math.abs(rows[i][k] - rows[0][k]) > e) return false;
    }
  }
  return true;
}

function isUnitScale(rows) {
  return rows.every((r) => r.every((v) => Math.abs(v - 1) < 1e-4));
}

// 动作文件共享同一副 34 节点骨架（0 号是蒙皮网格节点，1..33 是骨骼）。
// 动作库只保留 1..33 号节点（索引整体 -1），合并各 clip 的 accessor 数据。
//
// 两条归一化规则（都是为了让资产能直接接进游戏）：
//   1) 根节点 Root_zhujue01 的 translation 压成首帧常量 —— Death / Hit_Large
//      原始带约 1m 根位移，不处理的话角色会倒着滑出去一米再停住。
//      位移由游戏逻辑驱动，动画必须是原地的。
//   2) 恒为 (1,1,1) 的 scale 轨道整条丢掉 —— 约省 30% 体积。代价是运行时
//      不再写 scale，等于保持节点 rest 值，所以下面校验 rest scale 必须是 1。
function bakeAnims(skinBones) {
  const base = readGlb(path.join(SRC, ANIMS[0].src));
  // 所有动作文件的节点序列必须一致，否则 channel 的 node 索引会串到别的骨头上
  const baseSig = base.json.nodes.map((n) => n.name || '?').join('|');

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
  const stats = { dropScale: 0, flattenRoot: 0 };
  const inputMap = new Map(); // 时间轴按内容去重，跨 clip 复用

  const pushAccessor = (accDef, data, dropMinMax) => {
    const nv = { buffer: 0, byteLength: data.length };
    if (offset) nv.byteOffset = offset;
    if (accDef.byteStride != null) nv.byteStride = accDef.byteStride;
    json.bufferViews.push(nv);
    parts.push(data);
    offset += data.length;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      parts.push(Buffer.alloc(pad));
      offset += pad;
    }
    const acc = Object.assign({}, accDef);
    acc.bufferView = json.bufferViews.length - 1;
    if (dropMinMax) {
      delete acc.min;
      delete acc.max;
    }
    json.accessors.push(acc);
    return json.accessors.length - 1;
  };

  ANIMS.forEach((entry) => {
    const src = readGlb(path.join(SRC, entry.src));
    const sig = src.json.nodes.map((n) => n.name || '?').join('|');
    if (sig !== baseSig) {
      throw new Error(entry.src + ' 节点序列与 ' + ANIMS[0].src + ' 不一致');
    }
    const anim = src.json.animations && src.json.animations[0];
    if (!anim) throw new Error(entry.src + ' 没有动作');

    // 时间轴按内容去重：99 条轨道共用同一份 input，不去重会白存 99 遍
    const remapInput = (oldIndex) => {
      const acc = src.json.accessors[oldIndex];
      const view = src.json.bufferViews[acc.bufferView];
      const data = src.bin.slice(
        view.byteOffset || 0,
        (view.byteOffset || 0) + view.byteLength
      );
      const key = data.toString('base64');
      if (inputMap.has(key)) return inputMap.get(key);
      // input 必须保留 min/max（glTF 规范对 sampler input 有要求），所以原样拷贝
      const idx = pushAccessor(acc, data, false);
      inputMap.set(key, idx);
      return idx;
    };

    const samplers = [];
    const channels = [];

    anim.channels.forEach((ch) => {
      const smp = anim.samplers[ch.sampler];
      const srcNode = src.json.nodes[ch.target.node];
      const name = srcNode && srcNode.name;
      const outAcc = src.json.accessors[smp.output];
      const rows = readFloats(src, smp.output);

      // 规则 2：恒定的 scale 轨道 → 丢掉。判据是「动画常量 == 节点 rest scale」：
      // 剥掉后运行时不再写 scale，骨骼就等于一直保持 rest 值，两者必须一致。
      // （脚趾 Bip001-*-Toe0Nub 这类有几根骨骼 scale 不是 1，剥不掉就原样保留）
      if (ch.target.path === 'scale' && isConstant(rows)) {
        const rest = (srcNode && srcNode.scale) || [1, 1, 1];
        const c = rows[0];
        const same = c.every(
          (v, k) => Math.abs(v - (rest[k] != null ? rest[k] : 1)) < 1e-4
        );
        if (same) {
          stats.dropScale++;
          return;
        }
      }

      // 规则 1：根节点位移压平
      let touched = false;
      if (ch.target.path === 'translation' && name === 'Root_zhujue01' && !isConstant(rows)) {
        const first = rows[0].slice();
        rows.forEach((r) => {
          for (let k = 0; k < r.length; k++) r[k] = first[k];
        });
        touched = true;
        stats.flattenRoot++;
      }

      const data = touched ? writeFloats(rows) : src.bin.slice(
        src.json.bufferViews[outAcc.bufferView].byteOffset || 0,
        (src.json.bufferViews[outAcc.bufferView].byteOffset || 0) +
          src.json.bufferViews[outAcc.bufferView].byteLength
      );
      samplers.push({
        input: remapInput(smp.input),
        // output 的 min/max 是可选字段（规范只对 POSITION 强制要求），
        // 近 3000 条 accessor 各带一份能占到几百 KB，统一删掉
        output: pushAccessor(outAcc, data, true),
        interpolation: smp.interpolation || 'LINEAR',
      });
      channels.push({
        sampler: samplers.length - 1,
        target: { node: ch.target.node - 1, path: ch.target.path },
      });
    });

    json.animations.push({ name: entry.name, samplers: samplers, channels: channels });
  });

  console.log(
    '  归一化：剥 scale 轨道 ' + stats.dropScale + ' 条，压平原地位移 ' + stats.flattenRoot + ' 条'
  );

  json.buffers[0].byteLength = offset;

  const tmpPath = path.join(OUT, 'soldier_anims.glb.tmp');
  writeGlb(tmpPath, json, Buffer.concat(parts));

  // 自检：重读产物，clip 名齐全、索引不越界、动作骨骼名 ⊆ 蒙皮骨骼名
  const check = readGlb(tmpPath);
  const names = check.json.animations.map((a) => a.name);
  // 站立与移动是硬需求，缺了直接失败；其余动作随 ANIMS 自由增删。
  REQUIRED_CLIPS.forEach((r) => {
    if (names.indexOf(r) < 0) throw new Error('soldier_anims.glb 缺 clip: ' + r);
  });
  if (new Set(names).size !== names.length) {
    throw new Error('soldier_anims.glb 有重名 clip: ' + names.join(','));
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
  // 归一化生效验证：根节点（新 0 号，原 Root_zhujue01）的 translation 必须恒定
  check.json.animations.forEach((a) => {
    a.channels.forEach((c) => {
      if (c.target.node !== 0 || c.target.path !== 'translation') return;
      const rows = readFloats(check, a.samplers[c.sampler].output);
      if (!isConstant(rows)) {
        throw new Error('clip ' + a.name + ' 根节点仍有位移，归一化没生效');
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
  // 只补动作时用 --anims-only：蒙皮已经烘焙过、原始 Soldier02~04_Skin.glb
  // 不在目录里也能跑，骨架基准改从已有产物 soldier01.glb 取。
  const animsOnly = process.argv.indexOf('--anims-only') >= 0;
  fs.mkdirSync(OUT, { recursive: true });
  ANIMS.forEach((a) => {
    if (!fs.existsSync(path.join(SRC, a.src))) throw new Error('缺输入: ' + a.src);
  });

  let skinBones;
  if (animsOnly) {
    skinBones = boneNames(readGlb(path.join(OUT, 'soldier01.glb')).json);
    console.log('--anims-only：跳过蒙皮，骨架基准取自 soldier01.glb');
  } else {
    SKINS.forEach((s) => {
      if (!fs.existsSync(path.join(SRC, s.src))) throw new Error('缺输入: ' + s.src);
    });
    skinBones = bakeSkin(SKINS[0]);
    SKINS.slice(1).forEach(bakeSkin);
  }

  bakeAnims(skinBones);
  console.log('done. 记得把 index.html 相关 js 的 ?v= 令牌 bump 一个新值');
}

main();
