/*
 * bake-vox-prop.js — Bake a .vox (Vengi/MagicaVoxel) model into a JS prop
 * file under js/props/, ready for VF.Props.stamp() at runtime.
 *
 *   node scripts/bake-vox-prop.js assets/props/house.vox --id house --exact --factor 1
 *
 * Pipeline (each step answers a measured finding about the source model):
 *   tight bbox → drop full-coverage base slab → colour map → majority-vote
 *   downsample → RLE → write IIFE.
 *
 * Two colour modes:
 *   default   Lab-quantise to the 12 solid, breakable engine materials. Cheap,
 *             but house.vox measured only 28% colour-layer retention (32 source
 *             colours collapsed into 9), which reads as "the colours are wrong".
 *   --exact   keep every source colour 1:1. The prop file carries its own
 *             palette and js/props/prop-palette.js allocates real block ids for
 *             it at load time, so voxel-world.js's tables stay untouched.
 *
 *   --factor      downsample factor (default 2; 1 voxel = 1m in game)
 *   --threshold   min source voxels per output cell to keep it solid (default 2)
 *   --exact       1:1 colours (see above) instead of quantising
 *   --keep-base   keep the bottom layer even if it is a full slab
 *   --preview     also print threshold 1/2/4 front elevations for comparison
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vox = require('./lib/vox.js');

const SLAB_RATIO = 0.8; // drop bottom layer when it fills >= 80% of the footprint

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv) {
  if (!argv[0]) {
    console.error('用法: node scripts/bake-vox-prop.js <文件.vox> --id <名> [--exact] [--factor 2] [--threshold 2] [--keep-base] [--preview]');
    process.exit(2);
  }
  const o = { input: argv[0], id: 'prop', factor: 2, threshold: 2, keepBase: false, preview: false, exact: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--id') o.id = argv[++i];
    else if (a === '--factor') o.factor = parseInt(argv[++i], 10);
    else if (a === '--threshold') o.threshold = parseInt(argv[++i], 10);
    else if (a === '--exact') o.exact = true;
    else if (a === '--keep-base') o.keepBase = true;
    else if (a === '--preview') o.preview = true;
    else fail('未知参数: ' + a);
  }
  if (!o.id || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.id)) fail('--id 必须是合法 JS 标识符');
  if (!(o.factor >= 1) || !(o.threshold >= 1)) fail('--factor / --threshold 必须是 ≥1 的整数');
  return o;
}

function tightBbox(voxels) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const v of voxels) {
    if (v.x < x0) x0 = v.x; if (v.x > x1) x1 = v.x;
    if (v.y < y0) y0 = v.y; if (v.y > y1) y1 = v.y;
    if (v.z < z0) z0 = v.z; if (v.z > z1) z1 = v.z;
  }
  return { x0, x1, y0, y1, z0, z1 };
}

/**
 * Drop a full-coverage base slab: many Vengi exports carry a solid plate on
 * the lowest layer. The game's own pad logic (see prop-stamp.js) replaces it.
 */
function stripBaseSlab(voxels, bbox, keepBase) {
  if (keepBase) return { voxels, dropped: 0 };
  const footprint = (bbox.x1 - bbox.x0 + 1) * (bbox.y1 - bbox.y0 + 1);
  let base = 0;
  for (const v of voxels) if (v.z === bbox.z0) base++;
  if (base / footprint < SLAB_RATIO) return { voxels, dropped: 0 };
  return { voxels: voxels.filter((v) => v.z !== bbox.z0), dropped: base };
}

/** Bake one model → { W, D, H, rle, vol, solidCount, dist } (ids are block ids). */
function buildBaked(model, palette, solid, factor, threshold, keepBase, exact) {
  const bbox = tightBbox(model.voxels);
  const { voxels, dropped } = stripBaseSlab(model.voxels, bbox, keepBase);
  if (!voxels.length) fail('模型在去掉地基板后为空');
  const bb = tightBbox(voxels);

  // Pre-map palette index → emitted value once (not once per voxel).
  //   quantised: the Lab-nearest solid material's real block id
  //   exact:     a 1-based index into this prop's own palette, which
  //              js/props/prop-palette.js turns into real block ids at load
  let idOf;
  let pal = null;
  let hits = null;
  let near = null;
  if (exact) {
    const ep = vox.exactPalette(voxels, palette);
    idOf = ep.ofIndex;
    pal = ep.hexes;
  } else {
    idOf = new Array(256).fill(0);
    for (let i = 1; i < 256; i++) {
      const rgb = palette[i];
      if (rgb === 0) continue; // index 0 is reserved/empty
      idOf[i] = vox.nearestMaterial(rgb, solid).id;
    }
  }

  const W = Math.ceil((bb.x1 - bb.x0 + 1) / factor);
  const D = Math.ceil((bb.y1 - bb.y0 + 1) / factor);
  const H = Math.ceil((bb.z1 - bb.z0 + 1) / factor);

  // Majority vote per output cell: id -> count.
  const tally = new Map();
  for (const v of voxels) {
    const id = idOf[v.c];
    if (!id) continue;
    const bx = Math.floor((v.x - bb.x0) / factor);
    const by = Math.floor((v.y - bb.y0) / factor);
    const bz = Math.floor((v.z - bb.z0) / factor);
    const key = (bz * D + by) * W + bx;
    let t = tally.get(key);
    if (!t) { t = new Map(); tally.set(key, t); }
    t.set(id, (t.get(id) || 0) + 1);
  }

  const vol = new Uint8Array(W * D * H);
  const dist = new Map();
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
    dist.set(bestId, (dist.get(bestId) || 0) + 1);
  }

  if (exact) {
    // Downsampling / --threshold can orphan a colour. Drop orphans so they
    // never consume a global block id, then remap the volume to the compacted
    // palette. (house.vox loses none even at --factor 3, but other models will.)
    const used = new Set();
    for (const b of vol) if (b) used.add(b);
    if (used.size !== pal.length) {
      const remap = new Uint8Array(pal.length + 1);
      const keep = [];
      for (let i = 0; i < pal.length; i++) {
        if (!used.has(i + 1)) continue;
        keep.push(pal[i]);
        remap[i + 1] = keep.length;
      }
      for (let i = 0; i < vol.length; i++) if (vol[i]) vol[i] = remap[vol[i]];
      pal = keep;
      // dist was tallied with pre-compaction indices; rebuild from the volume.
      dist.clear();
      for (const b of vol) if (b) dist.set(b, (dist.get(b) || 0) + 1);
    }
    const hitTable = vox.gameBreakableHits();
    near = pal.map((h) => vox.durabilityFor(h, solid, hitTable));
    hits = near.map((d) => d.hits);
  }

  return {
    W, D, H, vol, rle: rleEncode(vol), solidCount, dist, dropped,
    srcCount: voxels.length, pal, hits, near,
  };
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

function rleDecode(rle, len) {
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i < rle.length; i += 2) out.fill(rle[i], o, (o += rle[i + 1]));
  if (o !== len) throw new Error('RLE 解码长度 ' + o + ' != 期望 ' + len);
  return out;
}

function writeProp(id, baked, factor, threshold, srcRel, exact) {
  const outDir = path.join(vox.ROOT, 'js', 'props');
  fs.mkdirSync(outDir, { recursive: true });
  const hex6 = (v) => '0x' + v.toString(16).padStart(6, '0');

  let fields = '    w: ' + baked.W + ', d: ' + baked.D + ', h: ' + baked.H + ',\n';
  if (exact) {
    // Wrap the palette at 8 per line so a colour change is a readable diff.
    const rows = [];
    for (let i = 0; i < baked.pal.length; i += 8) {
      rows.push('      ' + baked.pal.slice(i, i + 8).map(hex6).join(', '));
    }
    fields +=
      '    /** Source .vox colours, 1:1. prop-palette.js turns these into real block ids. */\n' +
      '    pal: [\n' + rows.join(',\n') + ',\n    ],\n' +
      '    /** Hits-to-break per pal entry, inherited from the Lab-nearest engine material. */\n' +
      '    hits: [' + baked.hits.join(', ') + '],\n';
  }
  fields += '    rle: ' + JSON.stringify(baked.rle) + ',\n';

  const body =
    '/** ' + id + ' — baked from ' + srcRel + ' (' + (exact ? 'exact colours, ' : '') +
    '1/' + factor + ' downsample, threshold ' + threshold + '). */\n' +
    '(function (g) {\n' +
    "  'use strict';\n" +
    '  g.VF = g.VF || {};\n' +
    '  g.VF.PROPS = g.VF.PROPS || {};\n' +
    '  g.VF.PROPS.' + id + ' = {\n' + fields + '  };\n' +
    (exact
      ? '  // rle holds 1-based pal indices until register() rewrites them in place.\n' +
        '  if (g.VF.PropPalette) g.VF.PropPalette.register(' + JSON.stringify(id) + ');\n'
      : '') +
    '})(typeof window !== "undefined" ? window : globalThis);\n';

  const outPath = path.join(outDir, id + '.js');
  fs.writeFileSync(outPath, body);
  return outPath;
}

function ascii(vol, W, D, H) {
  const front = [];
  for (let z = H - 1; z >= 0; z--) {
    let s = '';
    for (let x = 0; x < W; x++) {
      let c = 0;
      for (let y = 0; y < D; y++) if (vol[(z * D + y) * W + x]) c++;
      s += c === 0 ? '.' : c < 3 ? '-' : c < 6 ? '+' : c < 10 ? '#' : '@';
    }
    front.push(String(z).padStart(2) + ' ' + s);
  }
  const top = [];
  for (let y = 0; y < D; y++) {
    let s = '';
    for (let x = 0; x < W; x++) {
      let c = 0;
      for (let z = 0; z < H; z++) if (vol[(z * D + y) * W + x]) c++;
      s += c === 0 ? '.' : c < 3 ? '-' : c < 6 ? '+' : c < 9 ? '#' : '@';
    }
    top.push(String(y).padStart(2) + ' ' + s);
  }
  return { front, top };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const file = path.resolve(vox.ROOT, o.input);
  if (!fs.existsSync(file)) fail('找不到文件: ' + file);
  const srcRel = path.relative(vox.ROOT, file);

  const { models, palette } = vox.parseVox(fs.readFileSync(file));
  if (!models.length) fail('模型为空');
  const solid = vox.solidPalette();
  const idToName = {};
  for (const s of solid) idToName[s.id] = s.name;
  const validIds = new Set(solid.map((s) => s.id));

  const baked = buildBaked(models[0], palette, solid, o.factor, o.threshold, o.keepBase, o.exact);

  // Assertions — keep the pipeline honest.
  const decoded = rleDecode(baked.rle, baked.W * baked.D * baked.H);
  let decSolid = 0;
  const seen = new Set();
  for (const b of decoded) {
    if (!b) continue;
    decSolid++;
    seen.add(b);
    if (o.exact) {
      // Local 1-based palette indices, not block ids — solidPalette() does not apply.
      if (b < 1 || b > baked.pal.length) {
        fail('非法调色板下标 ' + b + '（调色板只有 ' + baked.pal.length + ' 项）');
      }
    } else if (!validIds.has(b)) {
      fail('非法 block id ' + b + '（不在实心可破坏材质集内）');
    }
  }
  if (decSolid !== baked.solidCount) fail('RLE 编解码不一致: ' + decSolid + ' != ' + baked.solidCount);

  let idBase = 0;
  if (o.exact) {
    if (baked.pal.length !== baked.hits.length) fail('调色板与硬度数组长度不一致');
    if (new Set(baked.pal).size !== baked.pal.length) fail('调色板内有重复颜色');
    if (seen.size !== baked.pal.length) {
      fail('调色板有 ' + (baked.pal.length - seen.size) + ' 项没有被任何体素使用');
    }
    // world.blocks is a Uint8Array: id 256 wraps to AIR and punches holes.
    idBase = vox.maxGameBlockId() + 1;
    if (idBase + baked.pal.length - 1 > 255) {
      fail('颜色数 ' + baked.pal.length + ' 会让 block id 超过 255（起始 ' + idBase + '）');
    }
  }

  const outPath = writeProp(o.id, baked, o.factor, o.threshold, srcRel, o.exact);

  console.log('烘焙完成  ' + path.relative(vox.ROOT, outPath));
  console.log('  尺寸      ' + baked.W + '×' + baked.D + '×' + baked.H +
    '  实心 ' + baked.solidCount + '/' + (baked.W * baked.D * baked.H) +
    ' (' + ((baked.solidCount / (baked.W * baked.D * baked.H)) * 100).toFixed(1) + '%)');
  console.log('  来源体素  ' + baked.srcCount + (baked.dropped ? '（已去掉地基板 ' + baked.dropped + ' 格）' : ''));
  console.log('  文件体积  ' + (fs.statSync(outPath).size / 1024).toFixed(1) + ' KB');

  if (o.exact) {
    const hex6 = (v) => '#' + v.toString(16).padStart(6, '0');
    const tagOf = (i) => o.id.toUpperCase() + '_C' + String(i).padStart(2, '0');
    console.log('  颜色      ' + baked.pal.length + ' 种（精确 1:1）→ block id ' +
      idBase + '..' + (idBase + baked.pal.length - 1) +
      '，独占时剩余 ' + (256 - idBase - baked.pal.length) + ' 个空位');
    console.log('');
    console.log('   id  材质名           颜色      体素数   最近材质 (Δ)        硬度');
    for (let i = 0; i < baked.pal.length; i++) {
      const n = baked.near[i].near;
      console.log(
        '  ' + String(idBase + i).padStart(3) +
        '  ' + tagOf(i).padEnd(16) +
        ' ' + hex6(baked.pal[i]) +
        '  ' + String(baked.dist.get(i + 1) || 0).padStart(6) +
        '   ' + (n.name + ' (Δ' + n.dist.toFixed(0) + ')').padEnd(18) +
        '  ' + baked.hits[i]
      );
    }
    // Publish the durability profile so a re-bake can be checked for feel drift.
    const split = new Map();
    let wsum = 0;
    for (let i = 0; i < baked.pal.length; i++) {
      const c = baked.dist.get(i + 1) || 0;
      split.set(baked.hits[i], (split.get(baked.hits[i]) || 0) + c);
      wsum += baked.hits[i] * c;
    }
    console.log('');
    console.log('  硬度分布  ' + [...split.entries()].sort((a, b) => a[0] - b[0])
      .map(([h, c]) => h + '击 ' + c + ' (' + ((c / baked.solidCount) * 100).toFixed(1) + '%)')
      .join(' · '));
    console.log('  加权均值  ' + (wsum / baked.solidCount).toFixed(3) + ' 击');
  } else {
    const mat = [...baked.dist.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, c]) => (idToName[id] || id) + '×' + c)
      .join(' ');
    console.log('  材质      ' + mat);
  }

  if (o.preview) {
    for (const th of [1, 2, 4]) {
      const b = buildBaked(models[0], palette, solid, o.factor, th, o.keepBase, o.exact);
      console.log('\n── 阈值 ' + th + ' 正视图 (x→, z↑ 高) ──');
      for (const line of ascii(b.vol, b.W, b.D, b.H).front) console.log('  ' + line);
      console.log('  实心率 ' + ((b.solidCount / (b.W * b.D * b.H)) * 100).toFixed(1) + '%');
    }
  }
}

main();
