#!/usr/bin/env node
/*
 * scripts/inspect-roles.js — 美术原始资产体检
 *
 * 扫描 assets/Roles/ 下所有 .glb，打印判断「能不能接、接成什么」所需的元数据：
 *   - 骨架是否与现有 soldier_anims.glb 完全一致（同名同构才不用 retarget）
 *   - 每个 clip 的时长 / 采样数 / 帧率 / 轨道数
 *   - 是否原地动画（根节点有没有 translation 轨道、幅度多大）
 *   - 首尾帧姿势差（能不能循环）
 *   - 是否带网格（动作文件不该带）
 *
 * 用法：node scripts/inspect-roles.js
 * 无第三方依赖，纯解析 GLB 容器。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'Roles');
const REF = path.join(ROOT, 'assets', 'characters', 'soldier_anims.glb');

const COMP_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
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
  return { json: json, bin: buf.slice(binOfs) };
}

function readAccessor(glb, idx) {
  const acc = glb.json.accessors[idx];
  const view = glb.json.bufferViews[acc.bufferView];
  const n = TYPE_NUM[acc.type];
  const s = COMP_SIZE[acc.componentType];
  const start = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const raw = glb.bin.slice(start, start + acc.count * n * s);
  const out = [];
  for (let i = 0; i < acc.count; i++) {
    const el = [];
    for (let k = 0; k < n; k++) {
      const o = i * n * s + k * s;
      if (acc.componentType === 5126) el.push(raw.readFloatLE(o));
      else if (acc.componentType === 5125) el.push(raw.readUInt32LE(o));
      else if (acc.componentType === 5123) el.push(raw.readUInt16LE(o));
      else if (acc.componentType === 5122) el.push(raw.readInt16LE(o));
      else el.push(raw[o]);
    }
    out.push(el);
  }
  return out;
}

function maxAbsDiff(a, b) {
  let d = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    d = Math.max(d, Math.abs(a[i] - b[i]));
  }
  return d;
}

function boneSet(json) {
  const set = new Set();
  (json.nodes || []).forEach((n) => {
    if (n.name && n.name.indexOf('Bip001') === 0) set.add(n.name);
  });
  return set;
}

/* ---------- 分析 ---------- */

function inspectFile(file) {
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  const glb = readGlb(file);
  const json = glb.json;
  const res = {
    file: name,
    size: size,
    nodes: (json.nodes || []).length,
    meshes: (json.meshes || []).length,
    skins: (json.skins || []).length,
    bones: boneSet(json),
    rootName: json.nodes && json.nodes[0] ? json.nodes[0].name : '(none)',
    clips: [],
    error: null,
  };

  (json.animations || []).forEach((anim) => {
    const times = readAccessor(glb, anim.samplers[0].input);
    const dur = times.length ? times[times.length - 1][0] : 0;

    const paths = {};
    let rootTranslation = 0;
    let loopDiff = 0;

    anim.channels.forEach((ch) => {
      paths[ch.target.path] = (paths[ch.target.path] || 0) + 1;
      const smp = anim.samplers[ch.sampler];
      const out = readAccessor(glb, smp.output);
      if (!out.length) return;
      loopDiff = Math.max(loopDiff, maxAbsDiff(out[0], out[out.length - 1]));
      const node = json.nodes[ch.target.node];
      if (
        ch.target.path === 'translation' &&
        node &&
        (node.name === 'Root_zhujue01' || ch.target.node === 0)
      ) {
        for (let i = 0; i < out.length; i++) {
          rootTranslation = Math.max(
            rootTranslation,
            Math.abs(out[i][0]) + Math.abs(out[i][1]) + Math.abs(out[i][2])
          );
        }
      }
    });

    res.clips.push({
      name: anim.name || '(unnamed)',
      dur: dur,
      samples: times.length,
      fps: dur > 0 ? (times.length - 1) / dur : 0,
      channels: anim.channels.length,
      paths: Object.keys(paths)
        .map((p) => p + ':' + paths[p])
        .join(' '),
      rootTranslation: rootTranslation,
      loopDiff: loopDiff,
    });
  });

  return res;
}

/* ---------- 输出 ---------- */

function fmt(n, d) {
  return n.toFixed(d == null ? 3 : d);
}

function report(results, refBones) {
  const L = [];
  L.push('=== assets/Roles/ 资产体检 ===');
  L.push('基准骨架（soldier_anims.glb）：' + refBones.size + ' 根 Bip001 骨骼');
  L.push('');

  results.forEach((r) => {
    L.push('--- ' + r.file + '  ' + (r.size / 1024).toFixed(0) + 'KB');
    if (r.error) {
      L.push('  [错误] ' + r.error);
      L.push('');
      return;
    }
    L.push('  节点 ' + r.nodes + ' / 网格 ' + r.meshes + ' / 蒙皮 ' + r.skins +
      ' / 骨骼 ' + r.bones.size + '  根="' + r.rootName + '"');

    if (r.meshes > 0) L.push('  [提示] 含网格 —— 动作文件不该带网格');

    // 骨架比对
    const missing = [];
    refBones.forEach((b) => {
      if (!r.bones.has(b)) missing.push(b);
    });
    const extra = [];
    r.bones.forEach((b) => {
      if (!refBones.has(b)) extra.push(b);
    });
    if (!missing.length && !extra.length) {
      L.push('  骨架：与基准完全一致 ✔ 可直接套用，无需 retarget');
    } else {
      if (missing.length) L.push('  骨架：缺 ' + missing.length + ' 根 → ' + missing.join(','));
      if (extra.length) L.push('  骨架：多 ' + extra.length + ' 根 → ' + extra.join(','));
    }

    if (!r.clips.length) {
      L.push('  动作：无');
    } else {
      L.push('  动作：');
      r.clips.forEach((c) => {
        L.push(
          '    ' + c.name +
            '  ' + fmt(c.dur) + 's  ' + c.samples + ' 样本  ' +
            fmt(c.fps, 1) + 'fps  ' + c.channels + ' 轨道 [' + c.paths + ']'
        );
        L.push(
          '      原地=' +
            (c.rootTranslation < 1e-4 ? '是 ✔' : '否 ✘ 根节点位移 ' + fmt(c.rootTranslation) + 'm') +
            '   首尾帧差=' + fmt(c.loopDiff, 5) +
            (c.loopDiff < 1e-3 ? ' → 可循环 ✔' : ' → 不循环 ✘')
        );
      });
    }
    L.push('');
  });
  return L.join('\n');
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.log('目录不存在：' + SRC);
    return;
  }
  const files = fs
    .readdirSync(SRC)
    .filter((f) => f.toLowerCase().endsWith('.glb'))
    .sort();
  if (!files.length) {
    console.log('assets/Roles/ 下没有 .glb');
    return;
  }

  let refBones;
  try {
    refBones = boneSet(readGlb(REF).json);
  } catch (e) {
    console.log('读基准骨架失败: ' + e.message);
    return;
  }

  const results = files.map((f) => {
    try {
      return inspectFile(path.join(SRC, f));
    } catch (e) {
      return { file: f, size: fs.statSync(path.join(SRC, f)).size, error: e.message, clips: [], bones: new Set() };
    }
  });

  console.log(report(results, refBones));
}

main();
