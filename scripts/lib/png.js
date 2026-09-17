'use strict';
/**
 * 零依赖 PNG 解码器（仅用 Node 内置 zlib）。
 *
 * 存在目的：烘焙工具需要读 GLB 内嵌的 baseColor 贴图（PNG），
 * 但本项目不想为此引入 pngjs 依赖 —— 整个 scripts/ 目录应该能直接拷走运行。
 *
 * 支持：
 *   - colorType 0(灰) / 2(RGB) / 3(调色板) / 4(灰+α) / 6(RGBA)
 *   - bitDepth 1/2/4（仅 colorType 0/3）、8、16
 *   - 非隔行（Adam7 会直接报错）
 *   - tRNS：灰/RGB 的关键色透明 + 调色板的 α 表
 * 输出：{ width, height, data: Uint8Array(w*h*4) }  —— 永远是 RGBA8。
 *
 * 不处理：iCCP/gAMA 颜色管理、隔行、APNG、16 位以上的非常规组合。
 */

const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 每个 colorType 的通道数（采样数，不是字节数） */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * 解码 PNG。
 * @param {Buffer|Uint8Array} buf PNG 文件字节
 * @returns {{width:number, height:number, data:Uint8Array}}
 */
function decodeSync(buf) {
  const src = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
  if (src.length < 8 || !src.subarray(0, 8).equals(SIG)) throw new Error('png: not a PNG file');

  let off = 8;
  let ihdr = null;
  const idat = [];
  let plte = null;
  let trns = null;

  while (off + 8 <= src.length) {
    const len = src.readUInt32BE(off);
    const type = src.toString('ascii', off + 4, off + 8);
    const body = src.subarray(off + 8, off + 8 + len);
    off += 12 + len; // len + type + data + crc

    if (type === 'IHDR') {
      if (len !== 13) throw new Error('png: bad IHDR length');
      ihdr = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        compression: body[10],
        filter: body[11],
        interlace: body[12],
      };
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'PLTE') {
      plte = Buffer.from(body);
    } else if (type === 'tRNS') {
      trns = Buffer.from(body);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!ihdr) throw new Error('png: missing IHDR');
  if (ihdr.interlace !== 0) throw new Error('png: interlaced (Adam7) PNG not supported');
  if (ihdr.compression !== 0) throw new Error('png: unknown compression method ' + ihdr.compression);
  if (ihdr.filter !== 0) throw new Error('png: unknown filter method ' + ihdr.filter);

  const { width: W, height: H, bitDepth: BD, colorType: CT } = ihdr;
  if (!(W > 0 && H > 0)) throw new Error('png: zero size');
  if (CHANNELS[CT] === undefined) throw new Error('png: unknown colorType ' + CT);
  if (CT === 3 && plte === null) throw new Error('png: palette image without PLTE');
  if (CT === 3 && BD === 16) throw new Error('png: 16-bit palette not allowed');
  if ((CT === 2 || CT === 4 || CT === 6) && BD !== 8 && BD !== 16) {
    throw new Error('png: bad bitDepth ' + BD + ' for colorType ' + CT);
  }
  if ((CT === 0 || CT === 3) && ![1, 2, 4, 8, 16].includes(BD)) {
    throw new Error('png: bad bitDepth ' + BD + ' for colorType ' + CT);
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));

  const ch = CHANNELS[CT];
  // 每条扫描线 = 1 字节 filter type + stride 字节像素数据
  const bpp = Math.max(1, (ch * BD) >> 3); // 每像素字节数（bitDepth<8 时一字节存多采样）
  const stride = Math.ceil((W * ch * BD) / 8);
  if (raw.length !== (stride + 1) * H) {
    throw new Error('png: inflated size mismatch (' + raw.length + ' != ' + (stride + 1) * H + ')');
  }

  const out = new Uint8Array(W * H * 4);
  const cur = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);

  // 关键色透明（灰 / RGB）。
  // 比较统一在 8bit 空间做：BD<8 的关键值按 scaleTo8 拉伸，BD=16 的关键值右移 8 位。
  let keyR = -1, keyG = -1, keyB = -1;
  if (trns && (CT === 0 || CT === 2)) {
    if (BD === 16) {
      keyR = trns.readUInt16BE(0) >> 8;
      keyG = CT === 2 ? trns.readUInt16BE(2) >> 8 : keyR;
      keyB = CT === 2 ? trns.readUInt16BE(4) >> 8 : keyR;
    } else {
      keyR = scaleTo8(trns[0], BD);
      keyG = CT === 2 ? trns[2] : keyR;
      keyB = CT === 2 ? trns[4] : keyR;
    }
  }

  // 打包位深下单个采样能取到的最大值
  const maxVal = (1 << BD) - 1;

  let p = 0; // raw 读指针
  for (let y = 0; y < H; y++) {
    const ft = raw[p++];
    raw.copy(cur, 0, p, p + stride);
    p += stride;
    unfilter(ft, cur, prev, stride, bpp);

    const rowOut = y * W * 4;
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0, a = 255;

      if (BD === 16) {
        const i = x * ch * 2;
        if (CT === 0) { r = g = b = (cur[i] << 8) | cur[i + 1]; }
        else if (CT === 4) { r = g = b = (cur[i] << 8) | cur[i + 1]; a = (cur[i + 2] << 8) | cur[i + 3]; }
        else if (CT === 2) { r = (cur[i] << 8) | cur[i + 1]; g = (cur[i + 2] << 8) | cur[i + 3]; b = (cur[i + 4] << 8) | cur[i + 5]; }
        else { r = (cur[i] << 8) | cur[i + 1]; g = (cur[i + 2] << 8) | cur[i + 3]; b = (cur[i + 4] << 8) | cur[i + 5]; a = (cur[i + 6] << 8) | cur[i + 7]; }
        r >>= 8; g >>= 8; b >>= 8; a >>= 8;
      } else if (BD === 8) {
        const i = x * ch;
        if (CT === 0) { r = g = b = cur[i]; }
        else if (CT === 4) { r = g = b = cur[i]; a = cur[i + 1]; }
        else if (CT === 3) {
          const idx = cur[i];
          r = plte[idx * 3]; g = plte[idx * 3 + 1]; b = plte[idx * 3 + 2];
          if (trns && idx < trns.length) a = trns[idx];
        } else if (CT === 2) { r = cur[i]; g = cur[i + 1]; b = cur[i + 2]; }
        else { r = cur[i]; g = cur[i + 1]; b = cur[i + 2]; a = cur[i + 3]; }
      } else {
        // bitDepth 1/2/4：一字节内打包多个采样
        const per = 8 / BD;
        const byteIdx = (x * ch) >> Math.log2(per);
        const shift = 8 - BD * (((x * ch) % per) + 1);
        const v = (cur[byteIdx] >> shift) & maxVal;
        if (CT === 0) {
          r = g = b = scaleTo8(v, BD);
        } else {
          r = plte[v * 3]; g = plte[v * 3 + 1]; b = plte[v * 3 + 2];
          if (trns && v < trns.length) a = trns[v];
        }
      }

      if (keyR >= 0 && r === keyR && g === keyG && b === keyB) a = 0;

      const o = rowOut + x * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }

    cur.copy(prev);
  }

  return { width: W, height: H, data: out };
}

function scaleTo8(v, bd) {
  switch (bd) {
    case 1: return v ? 255 : 0;
    case 2: return v * 85;      // 0..3 -> 0..255
    case 4: return v * 17;      // 0..15 -> 0..255
    default: return v;
  }
}

/**
 * PNG 行过滤逆运算（原地改 cur）。
 * filter type: 0 None / 1 Sub / 2 Up / 3 Average / 4 Paeth
 */
function unfilter(ft, cur, prev, stride, bpp) {
  if (ft === 0) return;
  if (ft === 1) {
    for (let i = bpp; i < stride; i++) cur[i] = (cur[i] + cur[i - bpp]) & 0xff;
  } else if (ft === 2) {
    for (let i = 0; i < stride; i++) cur[i] = (cur[i] + prev[i]) & 0xff;
  } else if (ft === 3) {
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      cur[i] = (cur[i] + ((a + prev[i]) >> 1)) & 0xff;
    }
  } else if (ft === 4) {
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      cur[i] = (cur[i] + paeth(a, b, c)) & 0xff;
    }
  } else {
    throw new Error('png: unknown filter type ' + ft);
  }
}

function paeth(a, b, c) {
  const pp = a + b - c;
  const pa = Math.abs(pp - a);
  const pb = Math.abs(pp - b);
  const pc = Math.abs(pp - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

module.exports = { decodeSync, decode: decodeSync };
