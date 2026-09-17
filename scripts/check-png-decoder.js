'use strict';
/**
 * 零依赖 PNG 解码器自测：scripts/lib/png.js
 *
 * 两部分：
 *   1) 合成 PNG 往返测试 —— 自己编码（zlib.deflateSync）各种 colorType / bitDepth / filter，
 *      解码回来比对像素，确保解码逻辑不依赖外部样本。
 *   2) 真实 PNG 校验 —— 解码 assets/*.png，与参考解码器（PowerShell System.Drawing）的
 *      抽样结果比对，输出抽样 JSON 供人工核对。
 *
 * 用法：
 *   node scripts/check-png-decoder.js              # 跑合成测试 + 真实文件解码冒烟
 *   node scripts/check-png-decoder.js --ref f.json # 用参考解码器输出比对真实文件
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { decodeSync } = require('./lib/png.js');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- 合成 PNG 编码

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 生成非隔行 PNG。px(x,y) -> [r,g,b,a] / [g,a] / [gray] / [index] */
function encodePng(W, H, colorType, bitDepth, px, opts = {}) {
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const stride = Math.ceil((W * ch * bitDepth) / 8);
  const bpp = Math.max(1, (ch * bitDepth) >> 3);
  const filters = opts.filters || null;

  // 第一步：生成所有未过滤的原始行
  const rows = [];
  for (let y = 0; y < H; y++) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < W; x++) {
      const v = px(x, y);
      if (bitDepth === 8) {
        for (let c = 0; c < ch; c++) row[x * ch + c] = v[c];
      } else if (bitDepth === 16) {
        for (let c = 0; c < ch; c++) row.writeUInt16BE(v[c], (x * ch + c) * 2);
      } else {
        const per = 8 / bitDepth;
        const shift = 8 - bitDepth * ((x % per) + 1);
        row[x >> Math.log2(per)] |= (v[0] & ((1 << bitDepth) - 1)) << shift;
      }
    }
    rows.push(row);
  }

  // 第二步：逐行应用 filter（Up/Average/Paeth 引用的是上一行**原始**像素，与解码端一致）
  const raw = Buffer.alloc((stride + 1) * H);
  for (let y = 0; y < H; y++) {
    const ft = filters ? filters[y % filters.length] : 0;
    const row = rows[y];
    const prev = y > 0 ? rows[y - 1] : Buffer.alloc(stride);
    const base = y * (stride + 1);
    raw[base] = ft;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (ft === 1) v = row[i] - a;
      else if (ft === 2) v = row[i] - b;
      else if (ft === 3) v = row[i] - ((a + b) >> 1);
      else if (ft === 4) v = row[i] - paeth(a, b, c);
      raw[base + 1 + i] = v & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ];
  if (opts.plte) parts.push(chunk('PLTE', opts.plte));
  if (opts.trns) parts.push(chunk('tRNS', opts.trns));
  parts.push(chunk('IDAT', zlib.deflateSync(raw, { level: opts.level == null ? 6 : opts.level })));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function paeth(a, b, c) {
  const pp = a + b - c;
  const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// ---------------------------------------------------------------- 断言工具

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  PASS  ' + msg); }
  else { fail++; console.log('  FAIL  ' + msg); }
}

function pxEq(got, want, x, y, tol) {
  for (let c = 0; c < 4; c++) {
    const d = Math.abs(got[c] - want[c]);
    if (d > (tol || 0)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- 合成测试

function synthTests() {
  console.log('== 合成 PNG 往返测试 ==');
  const W = 13, H = 7;

  // --- colorType 6 (RGBA8), filter 0/1/3/4
  {
    const px = (x, y) => [(x * 17) & 255, (y * 31) & 255, ((x + y) * 7) & 255, ((x * y) * 3) & 255];
    for (const ft of [0, 1, 3, 4]) {
      const buf = encodePng(W, H, 6, 8, px, { filters: [ft] });
      const img = decodeSync(buf);
      let good = img.width === W && img.height === H;
      for (let y = 0; y < H && good; y++) {
        for (let x = 0; x < W && good; x++) {
          const o = (y * W + x) * 4;
          const g = [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
          if (!pxEq(g, px(x, y), x, y)) good = false;
        }
      }
      ok(good, `RGBA8 filter=${ft} 往返一致`);
    }
  }

  // --- colorType 2 (RGB8)
  {
    const px = (x, y) => [(x * 20) & 255, (y * 40) & 255, ((x ^ y) * 11) & 255];
    const buf = encodePng(W, H, 2, 8, px);
    const img = decodeSync(buf);
    let good = img.width === W && img.height === H;
    for (let y = 0; y < H && good; y++) for (let x = 0; x < W && good; x++) {
      const o = (y * W + x) * 4;
      const g = [img.data[o], img.data[o + 1], img.data[o + 2], 255];
      if (!pxEq(g, [...px(x, y), 255])) good = false;
    }
    ok(good, 'RGB8 往返一致（alpha 应为 255）');
  }

  // --- colorType 0 (灰 8) + tRNS 关键色
  {
    const px = (x, y) => [((x + y) * 9) & 255];
    const trns = Buffer.from([0, 0]); // 关键色 = 0
    const buf = encodePng(W, H, 0, 8, px, { trns });
    const img = decodeSync(buf);
    let good = true;
    for (let y = 0; y < H && good; y++) for (let x = 0; x < W && good; x++) {
      const o = (y * W + x) * 4;
      const v = px(x, y)[0];
      const wantA = v === 0 ? 0 : 255;
      if (img.data[o] !== v || img.data[o + 3] !== wantA) good = false;
    }
    ok(good, '灰8 + tRNS 关键色透明正确');
  }

  // --- colorType 4 (灰+α)
  {
    const px = (x, y) => [(x * 5) & 255, (y * 50) & 255];
    const buf = encodePng(W, H, 4, 8, px);
    const img = decodeSync(buf);
    let good = true;
    for (let y = 0; y < H && good; y++) for (let x = 0; x < W && good; x++) {
      const o = (y * W + x) * 4;
      const [v, a] = px(x, y);
      if (img.data[o] !== v || img.data[o + 3] !== a) good = false;
    }
    ok(good, '灰+α8 往返一致');
  }

  // --- colorType 3 (调色板, bitDepth 8) + tRNS 表
  {
    const pal = Buffer.alloc(4 * 3);
    for (let i = 0; i < 4; i++) { pal[i * 3] = i * 60; pal[i * 3 + 1] = 255 - i * 60; pal[i * 3 + 2] = i * 17; }
    const trns = Buffer.from([255, 128, 0, 255]);
    const px = (x, y) => [(x + y) & 3];
    const buf = encodePng(W, H, 3, 8, px, { plte: pal, trns });
    const img = decodeSync(buf);
    let good = true;
    for (let y = 0; y < H && good; y++) for (let x = 0; x < W && good; x++) {
      const o = (y * W + x) * 4;
      const idx = px(x, y)[0];
      const want = [pal[idx * 3], pal[idx * 3 + 1], pal[idx * 3 + 2], trns[idx]];
      if (!pxEq([img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]], want)) good = false;
    }
    ok(good, '调色板8 + tRNS 表正确');
  }

  // --- colorType 3, bitDepth 4（打包）
  {
    const pal = Buffer.alloc(8 * 3);
    for (let i = 0; i < 8; i++) { pal[i * 3] = i * 32; pal[i * 3 + 1] = i * 8; pal[i * 3 + 2] = 200 - i * 20; }
    const px = (x, y) => [(x * 3 + y) & 7];
    const buf = encodePng(W, H, 3, 4, px, { plte: pal });
    const img = decodeSync(buf);
    let good = true;
    for (let y = 0; y < H && good; y++) for (let x = 0; x < W && good; x++) {
      const o = (y * W + x) * 4;
      const idx = px(x, y)[0];
      const want = [pal[idx * 3], pal[idx * 3 + 1], pal[idx * 3 + 2], 255];
      if (!pxEq([img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]], want)) good = false;
    }
    ok(good, '调色板4bit 打包解码正确');
  }

  // --- colorType 3, bitDepth 1
  {
    const pal = Buffer.from([0, 0, 0, 255, 255, 255]);
    const px = (x, y) => [(x + y) & 1];
    const buf = encodePng(16, H, 3, 1, px, { plte: pal });
    const img = decodeSync(buf);
    let good = img.width === 16;
    for (let y = 0; y < H && good; y++) for (let x = 0; x < 16 && good; x++) {
      const o = (y * 16 + x) * 4;
      const want = px(x, y)[0] ? 255 : 0;
      if (img.data[o] !== want) good = false;
    }
    ok(good, '调色板1bit 打包解码正确');
  }

  // --- colorType 6, bitDepth 16
  {
    const px = (x, y) => [x * 5000, y * 9000, (x + y) * 1000, 65535 - x * 1000];
    const buf = encodePng(9, 5, 6, 16, px);
    const img = decodeSync(buf);
    let good = true;
    for (let y = 0; y < 5 && good; y++) for (let x = 0; x < 9 && good; x++) {
      const o = (y * 9 + x) * 4;
      const v = px(x, y);
      if (Math.abs(img.data[o] - (v[0] >> 8)) > 1) good = false;
      if (Math.abs(img.data[o + 3] - (v[3] >> 8)) > 1) good = false;
    }
    ok(good, 'RGBA16 降 8bit 正确');
  }

  // --- 错误处理
  {
    let threw = false;
    try { decodeSync(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])); } catch (e) { threw = true; }
    ok(threw, '非 PNG 签名应抛错');

    // 隔行
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 1;
    const adv = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0)),
    ]);
    threw = false;
    try { decodeSync(adv); } catch (e) { threw = /interlac/i.test(e.message); }
    ok(threw, '隔行 PNG 应明确报错（不静默出错）');
  }
}

// ---------------------------------------------------------------- 真实文件

function realFiles() {
  console.log('\n== 真实 PNG 解码 ==');
  const files = [];
  const dirs = [path.join(ROOT, 'assets'), path.join(ROOT, 'assets', 'promo')];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (/\.png$/i.test(f)) files.push(path.join(d, f));
    }
  }
  if (!files.length) { console.log('  (未找到 .png)'); return; }

  for (const f of files.slice(0, 6)) {
    const t0 = Date.now();
    const img = decodeSync(fs.readFileSync(f));
    const ms = Date.now() - t0;
    // 统计：唯一颜色数、平均 alpha
    let sumA = 0, minA = 255, uniq = new Set();
    const step = Math.max(1, Math.floor((img.width * img.height) / 5000));
    let n = 0;
    for (let i = 0; i < img.width * img.height; i += step) {
      const o = i * 4;
      sumA += img.data[o + 3];
      if (img.data[o + 3] < minA) minA = img.data[o + 3];
      uniq.add((img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2]);
      n++;
    }
    const okSize = img.data.length === img.width * img.height * 4;
    console.log(
      `  ${okSize ? 'OK  ' : 'BAD '}${path.relative(ROOT, f)}  ${img.width}x${img.height}` +
      `  avgA=${(sumA / n).toFixed(1)} minA=${minA} 采样唯一色=${uniq.size}  ${ms}ms`
    );
    if (!okSize || img.width < 1 || uniq.size < 2) fail++; else pass++;
  }
}

// ---------------------------------------------------------------- 参考比对

function refCompare(refPath) {
  console.log('\n== 与参考解码器比对 ==');
  const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
  for (const item of ref) {
    const img = decodeSync(fs.readFileSync(path.join(ROOT, item.file)));
    let bad = 0;
    if (img.width !== item.width || img.height !== item.height) {
      console.log(`  FAIL  ${item.file} 尺寸 ${img.width}x${img.height} != ${item.width}x${item.height}`);
      fail++; continue;
    }
    for (const s of item.samples) {
      const o = (s.y * img.width + s.x) * 4;
      const got = [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
      const want = s.rgba;
      for (let c = 0; c < 4; c++) if (Math.abs(got[c] - want[c]) > 2) { bad++; break; }
    }
    if (bad) { fail++; console.log(`  FAIL  ${item.file} ${bad}/${item.samples.length} 抽样不符`); }
    else { pass++; console.log(`  PASS  ${item.file} ${item.samples.length} 抽样与参考一致`); }
  }
}

// ---------------------------------------------------------------- main

const refArg = process.argv.indexOf('--ref');
synthTests();
realFiles();
if (refArg > 0 && process.argv[refArg + 1]) refCompare(process.argv[refArg + 1]);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
