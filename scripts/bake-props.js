/*
 * bake-props.js — Batch-bake every .vox under assets/props/ into a SHARED
 * colour palette. This replaces per-prop `--exact` baking for the scene-editor
 * workflow: one palette, allocated once at load, so the number of props no
 * longer eats the Uint8Array block-id budget one palette at a time.
 *
 *   node scripts/bake-props.js                 # bake everything
 *   node scripts/bake-props.js --colors 128    # cap the shared palette
 *
 * Two source formats:
 *   .vox  — pre-voxellised, baked straight through (as before).
 *   .glb  — voxelised at bake time and additionally baked into a per-face
 *           micro-texture atlas (块面微缩纹理), so signs / windows / treads keep
 *           their art instead of collapsing to a flat block colour.
 *           Per-asset overrides go in assets/props/<id>.json, e.g.
 *             { "res": 48, "faceft": 8, "sat": 1.1 }
 *
 * The directory IS the manifest: every assets/props/<id>.vox is baked into the
 * single self-contained js/props/props-bundle.js (shared palette + manifest +
 * every prop's geometry + the registerShared() call), so adding a prop never
 * touches index.html. To add a prop, drop a .vox in assets/props/ and re-run.
 * To remove one, delete the .vox and re-run.
 *
 * Artists should run assets/props/烘焙资产.bat (→ scripts/bake-assets.js)
 * instead of this script directly: it also bumps index.html's cache token and
 * runs the checks.
 *
 * Colour mapping: every distinct colour used across ALL props is quantised
 * (median-cut, weighted by voxel count, deterministic) down to --colors bins.
 * If the union already fits, it is kept 1:1. Hardness is inherited from the
 * Lab-nearest engine material via vox.durabilityFor, exactly as before.
 *
 * Output palette is stored in props-bundle.js as VF.PROP_PALETTE; each prop's rle
 * holds 1-based indices into it, rewritten to real block ids by
 * PropPalette.registerShared() at load.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vox = require('./lib/vox.js');
const glbProp = require('./lib/prop-glb.js');

const PROPS_DIR = path.join(vox.ROOT, 'assets', 'props');
const OUT_DIR = path.join(vox.ROOT, 'js', 'props');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv) {
  const o = {
    colors: 128,
    factor: 1,
    threshold: 1,
    keepBase: false,
    // .glb 资产的体素化参数（可被 assets/props/<id>.json 逐资产覆盖）
    res: 32,
    faceft: 8,
    facethr: 10,
    faceray: 4,
    facess: 1,
    ss: 1,
    sat: 1,
    fill: false,
    nofaces: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--colors') o.colors = parseInt(argv[++i], 10);
    else if (a === '--factor') o.factor = parseInt(argv[++i], 10);
    else if (a === '--threshold') o.threshold = parseInt(argv[++i], 10);
    else if (a === '--res') o.res = parseInt(argv[++i], 10);
    else if (a === '--faceft') o.faceft = parseInt(argv[++i], 10);
    else if (a === '--facethr') o.facethr = parseInt(argv[++i], 10);
    else if (a === '--faceray') o.faceray = parseInt(argv[++i], 10);
    else if (a === '--facess') o.facess = parseInt(argv[++i], 10);
    else if (a === '--ss') o.ss = parseInt(argv[++i], 10);
    else if (a === '--sat') o.sat = parseFloat(argv[++i]);
    else if (a === '--keep-base') o.keepBase = true;
    else if (a === '--fill') o.fill = true;
    else if (a === '--nofaces') o.nofaces = true;
    else fail('未知参数: ' + a);
  }
  if (!(o.colors >= 1)) fail('--colors 必须是 ≥1 的整数');
  if (!(o.factor >= 1) || !(o.threshold >= 1)) fail('--factor / --threshold 必须是 ≥1 的整数');
  if (!(o.res >= 1)) fail('--res 必须是 ≥1 的整数');
  if (!(o.faceft >= 1)) fail('--faceft 必须是 ≥1 的整数');
  if (!(o.facethr >= 0)) fail('--facethr 必须是 ≥0 的整数');
  if (!(o.faceray >= 1)) fail('--faceray 必须是 ≥1 的整数');
  if (!(o.facess >= 1)) fail('--facess 必须是 ≥1 的整数');
  if (!(o.ss >= 1)) fail('--ss 必须是 ≥1 的整数');
  return o;
}

/** Filename → prop id, guarded by the same JS-identifier rule as bake-vox-prop. */
function idFromFile(file) {
  const id = path.basename(file, path.extname(file));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) {
    fail('资产文件名 ' + path.basename(file) + ' 不是合法 JS 标识符（只能 [A-Za-z_][A-Za-z0-9_]*）');
  }
  return id;
}

/* ------------------------------------------------------------------ *
 * Colour quantisation: median-cut on the global voxel histogram.
 * ------------------------------------------------------------------ */

function medianCut(hist, N) {
  const entries = [...hist.entries()]
    .map(([hex, count]) => ({
      hex,
      count,
      r: (hex >> 16) & 255,
      g: (hex >> 8) & 255,
      b: hex & 255,
    }))
    .sort((a, b) => a.hex - b.hex); // deterministic regardless of voxel order

  let buckets = [entries];
  const ch = ['r', 'g', 'b'];
  while (buckets.length < N) {
    let bestIdx = -1;
    let bestRange = -1;
    let bestCh = 0;
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      if (b.length < 2) continue;
      for (let c = 0; c < 3; c++) {
        let mn = 255;
        let mx = 0;
        for (const e of b) {
          const v = e[ch[c]];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        const range = mx - mn;
        if (range > bestRange) {
          bestRange = range;
          bestIdx = i;
          bestCh = c;
        }
      }
    }
    if (bestIdx < 0) break; // nothing left to split
    const b = buckets[bestIdx];
    b.sort((x, y) => x[ch[bestCh]] - y[ch[bestCh]]);
    const total = b.reduce((s, e) => s + e.count, 0);
    let acc = 0;
    let split = 0;
    for (let i = 0; i < b.length; i++) {
      acc += b[i].count;
      if (acc >= total / 2) {
        split = i + 1;
        break;
      }
    }
    if (split === 0 || split === b.length) split = Math.max(1, Math.floor(b.length / 2));
    buckets.splice(bestIdx, 1, b.slice(0, split), b.slice(split));
  }

  // Bucket average colour, sorted ascending for a stable palette.
  const pal = buckets.map((b) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    let n = 0;
    for (const e of b) {
      r += e.r * e.count;
      g += e.g * e.count;
      bl += e.b * e.count;
      n += e.count;
    }
    return {
      hex: ((Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(bl / n)) & 0xffffff,
      members: b,
    };
  });
  pal.sort((a, b) => a.hex - b.hex);

  // hex → 1-based palette index.
  const indexOf = new Map();
  pal.forEach((p, i) => {
    for (const e of p.members) indexOf.set(e.hex, i + 1);
  });
  return { pal: pal.map((p) => p.hex), indexOf };
}

/** Build the shared palette + hex→index map from all models at once. */
function buildSharedPalette(models, N) {
  const hist = new Map();
  for (const m of models) {
    for (const v of m.voxels) {
      const hex = m.palette[v.c] & 0xffffff;
      if (!hex) continue;
      hist.set(hex, (hist.get(hex) || 0) + 1);
    }
  }
  if (!hist.size) fail('没有任何体素颜色');
  if (hist.size <= N) {
    const hexes = [...hist.keys()].sort((a, b) => a - b);
    const indexOf = new Map(hexes.map((h, i) => [h, i + 1]));
    return { pal: hexes, indexOf };
  }
  return medianCut(hist, N);
}

/* ------------------------------------------------------------------ *
 * Per-prop geometry bake (mirrors bake-vox-prop.js, but emits shared-palette
 * indices instead of per-prop ids).
 * ------------------------------------------------------------------ */

function tightBbox(voxels) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const v of voxels) {
    if (v.x < x0) x0 = v.x; if (v.x > x1) x1 = v.x;
    if (v.y < y0) y0 = v.y; if (v.y > y1) y1 = v.y;
    if (v.z < z0) z0 = v.z; if (v.z > z1) z1 = v.z;
  }
  return { x0, x1, y0, y1, z0, z1 };
}

function stripBaseSlab(voxels, bbox, keepBase) {
  if (keepBase) return { voxels, dropped: 0 };
  const footprint = (bbox.x1 - bbox.x0 + 1) * (bbox.y1 - bbox.y0 + 1);
  let base = 0;
  for (const v of voxels) if (v.z === bbox.z0) base++;
  if (base / footprint < 0.8) return { voxels, dropped: 0 };
  return { voxels: voxels.filter((v) => v.z !== bbox.z0), dropped: base };
}

function rleEncode(vol) {
  const out = [];
  let cur = vol[0];
  let n = 1;
  for (let i = 1; i < vol.length; i++) {
    if (vol[i] === cur) n++;
    else { out.push(cur, n); cur = vol[i]; n = 1; }
  }
  out.push(cur, n);
  return out;
}

function bakeOne(model, shared, factor, threshold, keepBase) {
  const bbox = tightBbox(model.voxels);
  const { voxels, dropped } = stripBaseSlab(model.voxels, bbox, keepBase);
  if (!voxels.length) fail('模型在去掉地基板后为空');
  const bb = tightBbox(voxels);

  const W = Math.ceil((bb.x1 - bb.x0 + 1) / factor);
  const D = Math.ceil((bb.y1 - bb.y0 + 1) / factor);
  const H = Math.ceil((bb.z1 - bb.z0 + 1) / factor);

  const tally = new Map();
  for (const v of voxels) {
    const idx = shared.indexOf.get(model.palette[v.c] & 0xffffff);
    if (!idx) continue;
    const bx = Math.floor((v.x - bb.x0) / factor);
    const by = Math.floor((v.y - bb.y0) / factor);
    const bz = Math.floor((v.z - bb.z0) / factor);
    const key = (bz * D + by) * W + bx;
    let t = tally.get(key);
    if (!t) { t = new Map(); tally.set(key, t); }
    t.set(idx, (t.get(idx) || 0) + 1);
  }

  const vol = new Uint8Array(W * D * H);
  let solidCount = 0;
  for (const [key, t] of tally) {
    let total = 0;
    for (const c of t.values()) total += c;
    if (total < threshold) continue;
    let bestId = 0;
    let bestC = 0;
    for (const [id, c] of t) if (c > bestC) { bestC = c; bestId = id; }
    vol[key] = bestId;
    solidCount++;
  }

  return { W, D, H, vol, rle: rleEncode(vol), solidCount, dropped, srcCount: voxels.length };
}

/* ------------------------------------------------------------------ *
 * GLB 资产：体素化 + 块面微缩纹理
 * ------------------------------------------------------------------ */

/** 最近邻重采样一个 texel×texel 的 RGB 小块，用来把不同 faceft 的模型并进同一张图集。 */
function resampleContent(c, from, to) {
  if (from === to) return c;
  const out = new Uint8Array(to * to * 3);
  for (let y = 0; y < to; y++) {
    const sy = Math.min(from - 1, Math.floor((y * from) / to));
    for (let x = 0; x < to; x++) {
      const sx = Math.min(from - 1, Math.floor((x * from) / to));
      const si = (sy * from + sx) * 3;
      const di = (y * to + x) * 3;
      out[di] = c[si]; out[di + 1] = c[si + 1]; out[di + 2] = c[si + 2];
    }
  }
  return out;
}

/**
 * 把所有 .glb 的图集合并成一张全局图集，并给每个模型生成 slotRemap（本地槽位 → 全局槽位）。
 * 槽 0 恒为纯白：运行时把它当作「没有面纹理」的采样目标，这样无纹理面的着色
 * 与今天的行为完全一致（顶点色 × 白 = 顶点色）。
 */
function mergeAtlas(glbModels) {
  if (!glbModels.length) return null;
  let texel = 0;
  for (const m of glbModels) if (m.atlas) texel = Math.max(texel, m.atlas.texel);
  if (!texel) return null;

  const slotKey = new Map();
  const contents = [new Uint8Array(texel * texel * 3).fill(255)];
  for (const m of glbModels) {
    if (!m.atlas) continue;
    const remap = new Int32Array(m.atlas.slots);
    for (let s = 0; s < m.atlas.slots; s++) {
      const c = resampleContent(m.atlas.contents[s], m.atlas.texel, texel);
      const key = Buffer.from(c).toString('base64');
      let g = slotKey.get(key);
      if (g === undefined) {
        g = contents.length;
        slotKey.set(key, g);
        contents.push(c);
      }
      remap[s] = g;
    }
    m.slotRemap = remap;
  }
  const grid = Math.max(16, 1 << Math.ceil(Math.log2(Math.ceil(Math.sqrt(contents.length)))));
  const rows = Math.ceil(contents.length / grid);
  const aw = grid * texel, ah = rows * texel;
  const data = new Uint8Array(aw * ah * 3);
  contents.forEach((c, s) => {
    const gx = (s % grid) * texel, gy = Math.floor(s / grid) * texel;
    for (let y = 0; y < texel; y++) for (let x = 0; x < texel; x++) {
      const si = (y * texel + x) * 3, di = ((gy + y) * aw + gx + x) * 3;
      data[di] = c[si]; data[di + 1] = c[si + 1]; data[di + 2] = c[si + 2];
    }
  });
  return { grid, rows, slots: contents.length, texel, data };
}

/**
 * GLB 版的 bakeOne：与 .vox 路径同构（紧包围盒 / 去地基板 / 多数投票），
 * 额外把每个实心格的 6 个面槽位按 vol 的扁平顺序抽成 faceFlat。
 */
function bakeOneGlb(model, shared, factor, threshold, keepBase) {
  const bbox = tightBbox(model.voxels);
  const { voxels, dropped } = stripBaseSlab(model.voxels, bbox, keepBase);
  if (!voxels.length) fail('模型在去掉地基板后为空');
  const bb = tightBbox(voxels);

  const W = Math.ceil((bb.x1 - bb.x0 + 1) / factor);
  const D = Math.ceil((bb.y1 - bb.y0 + 1) / factor);
  const H = Math.ceil((bb.z1 - bb.z0 + 1) / factor);

  const cells = new Map(); // key -> { counts:Map(idx->n), src:Map(idx->k) }
  for (const v of voxels) {
    const idx = shared.indexOf.get(model.palette[v.c] & 0xffffff);
    if (!idx) continue;
    const bx = Math.floor((v.x - bb.x0) / factor);
    const by = Math.floor((v.y - bb.y0) / factor);
    const bz = Math.floor((v.z - bb.z0) / factor);
    const key = (bz * D + by) * W + bx;
    let c = cells.get(key);
    if (!c) { c = { counts: new Map(), src: new Map() }; cells.set(key, c); }
    c.counts.set(idx, (c.counts.get(idx) || 0) + 1);
    if (!c.src.has(idx)) c.src.set(idx, v.k);
  }

  const vol = new Uint8Array(W * D * H);
  const srcK = new Int32Array(W * D * H).fill(-1);
  let solidCount = 0;
  for (const [key, c] of cells) {
    let total = 0;
    for (const n of c.counts.values()) total += n;
    if (total < threshold) continue;
    let bestId = 0, bestC = 0;
    for (const [id, n] of c.counts) if (n > bestC) { bestC = n; bestId = id; }
    vol[key] = bestId;
    srcK[key] = c.src.get(bestId);
    solidCount++;
  }

  // 面槽位：按 vol 扁平顺序（与 rle 解码顺序一致）逐格抽出 6 面。
  // 0xFFFF（体素化时判定为被邻体素遮挡的隐藏面）一律归一成槽 0（纯白 = 无面纹理），
  // 运行时就不必再区分「没纹理」和「隐藏」两种情况。
  let faceFlat = null;
  const remap = model.slotRemap;
  if (remap && model.faceSlot) {
    faceFlat = new Uint16Array(solidCount * 6);
    const { nx, ny, nz } = model.grid;
    const { giToK, gv, faceSlot } = model;
    let j = 0;
    for (let bz = 0; bz < H; bz++) for (let by = 0; by < D; by++) for (let bx = 0; bx < W; bx++) {
      const key = (bz * D + by) * W + bx;
      if (!vol[key]) continue;
      const k = srcK[key];
      if (k >= 0) {
        const gi = gv[k * 3] + nx * (gv[k * 3 + 1] + ny * gv[k * 3 + 2]);
        const s = giToK[gi];
        if (s >= 0) {
          for (let f = 0; f < 6; f++) {
            const ls = faceSlot[s * 6 + f];
            faceFlat[j * 6 + f] = ls === 0xFFFF ? 0 : remap[ls];
          }
        }
      }
      j++;
    }
  }

  return { W, D, H, vol, rle: rleEncode(vol), solidCount, dropped, srcCount: voxels.length, faceFlat, isGlb: true };
}

/**
 * One self-contained bundle: shared palette + manifest + every prop's geometry,
 * followed by registerShared(). A single <script> tag in index.html loads it
 * all, so adding/removing a prop never touches index.html — just re-run this
 * script and the bundle updates in place.
 */
function writeBundle(entries, bakedList, shared, hits, atlas) {
  const hex6 = (v) => '0x' + v.toString(16).padStart(6, '0');
  const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
  const palRows = [];
  for (let i = 0; i < shared.pal.length; i += 8) {
    palRows.push('      ' + shared.pal.slice(i, i + 8).map(hex6).join(', '));
  }
  const manifest = entries.map((e) => ({ id: e.id, src: e.src }));

  // 块面微缩纹理图集：只有存在 .glb 资产时才输出。槽 0 恒为纯白，
  // 运行时把它当「无面纹理」——顶点色 × 白 = 顶点色，行为与没有图集时完全一致。
  const atlasBlock = atlas
    ? '  g.VF.PROP_FACE_ATLAS = {\n' +
      '    texel: ' + atlas.texel + ', grid: ' + atlas.grid + ', rows: ' + atlas.rows +
      ', slots: ' + atlas.slots + ', w: ' + atlas.grid * atlas.texel + ', h: ' + atlas.rows * atlas.texel + ',\n' +
      "    data: '" + b64(atlas.data) + "',\n" +
      '  };\n'
    : '';

  const propBlocks = entries.map((e, i) => {
    const b = bakedList[i];
    const faceLine = b.faceFlat ? "    face: '" + b64(b.faceFlat) + "',\n" : '';
    return (
      '  g.VF.PROPS.' + e.id + ' = {\n' +
      '    w: ' + b.W + ', d: ' + b.D + ', h: ' + b.H + ',\n' +
      '    rle: ' + JSON.stringify(b.rle) + ',\n' +
      faceLine +
      '  };'
    );
  }).join('\n');

  const body =
    '/** props-bundle.js — Generated by scripts/bake-props.js. Do not edit by hand. */\n' +
    '(function (g) {\n' +
    "  'use strict';\n" +
    '  g.VF = g.VF || {};\n' +
    '  g.VF.PROPS = g.VF.PROPS || {};\n' +
    '  g.VF.PROP_PALETTE = {\n' +
    '    pal: [\n' + palRows.join(',\n') + ',\n    ],\n' +
    '    hits: [' + hits.join(', ') + '],\n' +
    '  };\n' +
    atlasBlock +
    '  g.VF.PROP_MANIFEST = ' + JSON.stringify(manifest) + ';\n' +
    '\n' +
    propBlocks + '\n' +
    '\n' +
    '  // rle holds 1-based shared-palette indices until registerShared() rewrites them in place.\n' +
    '  if (g.VF.PropPalette) g.VF.PropPalette.registerShared();\n' +
    '})(typeof window !== "undefined" ? window : globalThis);\n';
  const outPath = path.join(OUT_DIR, 'props-bundle.js');
  fs.writeFileSync(outPath, body);
  return outPath;
}

/**
 * Flag models whose HEIGHT will misbehave in game. prop-stamp.js clamps the pad
 * to `world.height - h - 4` (= 97 - h); beyond that the pad goes negative, the
 * model is buried, and it silently becomes unbreakable terrain fill. Above ~60m
 * the clamp starts fighting the uphill-slope logic instead.
 *
 * Footprint is deliberately NOT warned on: house.vox is 51×40 and verified
 * working, so any threshold low enough to be useful would fire on a known-good
 * asset and teach artists to ignore the warnings.
 */
const WORLD_HEIGHT = 101; // js/voxel-world.js WORLD_HEIGHT
const MAX_PROP_H = WORLD_HEIGHT - 5; // pad would go negative beyond this

function sizeNote(baked) {
  if (baked.H > MAX_PROP_H) {
    return '  ✗ 高 ' + baked.H + ' 米超过上限 ' + MAX_PROP_H + ' 米，摆放会被拒绝';
  }
  if (baked.H > 60) {
    return '  ⚠ 高 ' + baked.H + ' 米偏高，摆到山坡上可能被压低';
  }
  return '';
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // .vox 先、.glb 后，各自按文件名排序：一个 .glb 都没有时，顺序与改造前完全一致。
  const all = fs.readdirSync(PROPS_DIR);
  const files = all.filter((f) => f.toLowerCase().endsWith('.vox')).sort();
  const glbFiles = all.filter((f) => f.toLowerCase().endsWith('.glb')).sort();

  if (!files.length && !glbFiles.length) fail('assets/props/ 下没有 .vox / .glb 文件');

  // 同名不同扩展名（house.vox + house.glb）会静默互相覆盖，必须显式报错。
  const seenId = new Map();
  for (const f of files.concat(glbFiles)) {
    const id = idFromFile(f);
    if (seenId.has(id)) {
      fail('资产重名：' + seenId.get(id) + ' 和 ' + f + ' 去掉扩展名后都叫 "' + id + '"，后一个会覆盖前一个');
    }
    seenId.set(id, f);
  }

  const models = [];
  const entries = [];
  for (const f of files) {
    const id = idFromFile(f);
    const file = path.join(PROPS_DIR, f);
    const { models: ms, palette } = vox.parseVox(fs.readFileSync(file));
    if (!ms.length) fail('模型为空: ' + f);
    // props are single-model; keep the palette reference on the model for baking
    ms[0].palette = palette;
    models.push(ms[0]);
    entries.push({ id, src: f });
  }

  // .glb：体素化 + 块面微缩纹理。同名 .json 可逐资产覆盖 res/faceft/sat/fill 等。
  const glbModels = [];
  for (const f of glbFiles) {
    const id = idFromFile(f);
    const file = path.join(PROPS_DIR, f);
    console.log('  [' + f + ']');
    const m = glbProp.loadGlbProp(file, {
      res: o.res,
      faceft: o.faceft,
      facethr: o.facethr,
      faceray: o.faceray,
      facess: o.facess,
      ss: o.ss,
      sat: o.sat,
      fill: o.fill,
      keepBase: o.keepBase,
      faces: !o.nofaces,
    }, (msg) => console.log('    ' + msg));
    glbModels.push(m);
    models.push(m);
    entries.push({ id, src: f });
  }

  const shared = buildSharedPalette(models, o.colors);
  const solid = vox.solidPalette();
  const hitTable = vox.gameBreakableHits();
  const hits = shared.pal.map((h) => vox.durabilityFor(h, solid, hitTable).hits);

  const maxId = vox.maxGameBlockId();
  const used = maxId + 1 + shared.pal.length;

  // 所有 .glb 的面纹理图集先合成一张全局图集（跨资产去重），再逐个烘焙。
  const atlas = mergeAtlas(glbModels);

  const bakedList = [];
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const baked = m.isGlb
      ? bakeOneGlb(m, shared, o.factor, o.threshold, m.opt.keepBase)
      : bakeOne(m, shared, o.factor, o.threshold, o.keepBase);
    baked.factor = o.factor;
    baked.threshold = o.threshold;
    bakedList.push(baked);
    console.log(
      entries[i].id.padEnd(20) +
      (baked.W + '×' + baked.D + '×' + baked.H).padEnd(12) +
      '实心 ' + String(baked.solidCount).padStart(5) +
      (baked.dropped ? '（去地基板 ' + baked.dropped + ' 格）' : '') +
      (baked.faceFlat ? '  面纹理 ' + baked.faceFlat.length / 6 + ' 格' : '') +
      sizeNote(baked)
    );
  }

  // Validate BEFORE writing: an overflowing bake used to leave a broken
  // props-bundle.js on disk alongside a non-zero exit code, so the next page
  // load punched AIR holes through every building.
  if (used > 255) {
    fail('调色板 ' + shared.pal.length + ' 色会让 block id 超过 255（需 ' + used + '）——请降低 --colors');
  }

  const bundleOut = writeBundle(entries, bakedList, shared, hits, atlas);
  console.log('');
  console.log('共享调色板  ' + shared.pal.length + ' 色（上限 ' + o.colors + '）');
  console.log('block id     ' + (maxId + 1) + '..' + (used - 1) + '（引擎占 0..' + maxId + '，剩余 ' + (256 - used) + ' 个空位）');
  console.log('资产数量     ' + entries.length + ' 个（.vox ' + files.length + ' + .glb ' + glbFiles.length + '）');
  if (atlas) {
    console.log('面纹理图集  ' + atlas.slots + ' 槽 · ' + atlas.texel + '×' + atlas.texel +
      ' texel · ' + (atlas.grid * atlas.texel) + '×' + (atlas.rows * atlas.texel) + ' px');
  }
  console.log('打包文件     ' + path.relative(vox.ROOT, bundleOut));
}

main();
