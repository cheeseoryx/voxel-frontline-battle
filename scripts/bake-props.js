/*
 * bake-props.js — Batch-bake every .vox under assets/props/ into a SHARED
 * colour palette. This replaces per-prop `--exact` baking for the scene-editor
 * workflow: one palette, allocated once at load, so the number of props no
 * longer eats the Uint8Array block-id budget one palette at a time.
 *
 *   node scripts/bake-props.js                 # bake everything
 *   node scripts/bake-props.js --colors 128    # cap the shared palette
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

const PROPS_DIR = path.join(vox.ROOT, 'assets', 'props');
const OUT_DIR = path.join(vox.ROOT, 'js', 'props');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv) {
  const o = { colors: 128, factor: 1, threshold: 1, keepBase: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--colors') o.colors = parseInt(argv[++i], 10);
    else if (a === '--factor') o.factor = parseInt(argv[++i], 10);
    else if (a === '--threshold') o.threshold = parseInt(argv[++i], 10);
    else if (a === '--keep-base') o.keepBase = true;
    else fail('未知参数: ' + a);
  }
  if (!(o.colors >= 1)) fail('--colors 必须是 ≥1 的整数');
  if (!(o.factor >= 1) || !(o.threshold >= 1)) fail('--factor / --threshold 必须是 ≥1 的整数');
  return o;
}

/** Filename → prop id, guarded by the same JS-identifier rule as bake-vox-prop. */
function idFromFile(file) {
  const id = path.basename(file, '.vox');
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

/**
 * One self-contained bundle: shared palette + manifest + every prop's geometry,
 * followed by registerShared(). A single <script> tag in index.html loads it
 * all, so adding/removing a prop never touches index.html — just re-run this
 * script and the bundle updates in place.
 */
function writeBundle(entries, bakedList, shared, hits) {
  const hex6 = (v) => '0x' + v.toString(16).padStart(6, '0');
  const palRows = [];
  for (let i = 0; i < shared.pal.length; i += 8) {
    palRows.push('      ' + shared.pal.slice(i, i + 8).map(hex6).join(', '));
  }
  const manifest = entries.map((e) => ({ id: e.id, src: e.src }));

  const propBlocks = entries.map((e, i) => {
    const b = bakedList[i];
    return (
      '  g.VF.PROPS.' + e.id + ' = {\n' +
      '    w: ' + b.W + ', d: ' + b.D + ', h: ' + b.H + ',\n' +
      '    rle: ' + JSON.stringify(b.rle) + ',\n' +
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

  const files = fs.readdirSync(PROPS_DIR)
    .filter((f) => f.endsWith('.vox'))
    .sort();

  if (!files.length) fail('assets/props/ 下没有 .vox 文件');

  const models = [];
  const entries = [];
  for (const f of files) {
    const id = idFromFile(f);
    const file = path.join(PROPS_DIR, f);
    const srcRel = path.relative(vox.ROOT, file);
    const { models: ms, palette } = vox.parseVox(fs.readFileSync(file));
    if (!ms.length) fail('模型为空: ' + f);
    // props are single-model; keep the palette reference on the model for baking
    ms[0].palette = palette;
    models.push(ms[0]);
    entries.push({ id, src: f });
  }

  const shared = buildSharedPalette(models, o.colors);
  const solid = vox.solidPalette();
  const hitTable = vox.gameBreakableHits();
  const hits = shared.pal.map((h) => vox.durabilityFor(h, solid, hitTable).hits);

  const maxId = vox.maxGameBlockId();
  const used = maxId + 1 + shared.pal.length;

  const bakedList = [];
  for (let i = 0; i < models.length; i++) {
    const baked = bakeOne(models[i], shared, o.factor, o.threshold, o.keepBase);
    baked.factor = o.factor;
    baked.threshold = o.threshold;
    bakedList.push(baked);
    console.log(
      entries[i].id.padEnd(20) +
      (baked.W + '×' + baked.D + '×' + baked.H).padEnd(12) +
      '实心 ' + String(baked.solidCount).padStart(5) +
      (baked.dropped ? '（去地基板 ' + baked.dropped + ' 格）' : '') +
      sizeNote(baked)
    );
  }

  // Validate BEFORE writing: an overflowing bake used to leave a broken
  // props-bundle.js on disk alongside a non-zero exit code, so the next page
  // load punched AIR holes through every building.
  if (used > 255) {
    fail('调色板 ' + shared.pal.length + ' 色会让 block id 超过 255（需 ' + used + '）——请降低 --colors');
  }

  const bundleOut = writeBundle(entries, bakedList, shared, hits);
  console.log('');
  console.log('共享调色板  ' + shared.pal.length + ' 色（上限 ' + o.colors + '）');
  console.log('block id     ' + (maxId + 1) + '..' + (used - 1) + '（引擎占 0..' + maxId + '，剩余 ' + (256 - used) + ' 个空位）');
  console.log('资产数量     ' + entries.length + ' 个（assets/props/*.vox）');
  console.log('打包文件     ' + path.relative(vox.ROOT, bundleOut));
}

main();
