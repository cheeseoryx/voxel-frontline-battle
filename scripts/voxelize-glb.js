'use strict';
/**
 * GLB -> 体素 + 块面微缩纹理 的命令行入口（scripts/lib/glb-voxelize.js 的薄封装）
 *
 * 用法:
 *   node scripts/voxelize-glb.js <input.glb> <out.json> [--res=32] [--faceft=12] [--fill] [--sat=1.1] ...
 *
 * 参数（都是 --key=value 形式）：
 *   res       最长边体素数            默认 64
 *   faceft    每面纹理边长(texel)     默认 8   （降 res 时要同步调高：48→8, 32→12, 24→16）
 *   facethr   图案/纯色判定标准差阈值 默认 10
 *   faceray   射线最大命中距离(体素)  默认 4
 *   facess    面纹理额外超采样倍数    默认 1
 *   ss        mip 基础上额外多点采样  默认 1
 *   sat       饱和度补偿              默认 1
 *   quant     颜色量化级数（0=不量化）默认 0
 *   jitter    每体素明暗抖动幅度      默认 0
 *   fill      按列填充内部（默认只做外壳）
 *   nofaces   跳过面纹理烘焙
 *
 * 输出 JSON 里 index/color/faceSlot/atlas.data 都是 base64。
 */

const fs = require('fs');
const path = require('path');
const { voxelize } = require('./lib/glb-voxelize.js');

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const opt = {};
for (const a of args.filter(a => a.startsWith('--'))) {
  const [k, v] = a.replace(/^--/, '').split('=');
  opt[k] = v === undefined ? true : v;
}

const INPUT = positional[0];
const OUT = positional[1];
if (!INPUT || !OUT) {
  console.error('用法: node scripts/voxelize-glb.js <input.glb> <out.json> [--res=32] [--faceft=12] [--fill]');
  process.exit(1);
}

const runOpt = {
  res: opt.res,
  faceft: opt.faceft,
  facethr: opt.facethr,
  faceray: opt.faceray,
  facess: opt.facess,
  ss: opt.ss,
  sat: opt.sat,
  quant: opt.quant,
  jitter: opt.jitter,
  fill: !!opt.fill,
  faces: !opt.nofaces,
  onLog: (m) => console.log('  ' + m),
};
// 去掉 undefined，让 lib 用默认值
for (const k of Object.keys(runOpt)) if (runOpt[k] === undefined) delete runOpt[k];

console.log(`体素化 ${path.basename(INPUT)}  ${JSON.stringify(runOpt)}`);
const t0 = Date.now();
const r = voxelize(fs.readFileSync(INPUT), runOpt);

const b64 = (buf) => Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('base64');
const out = {
  nx: r.nx, ny: r.ny, nz: r.nz, voxel: r.voxel,
  origin: r.origin, size: r.size, count: r.count,
  source: path.basename(INPUT),
  index: b64(r.index),
  coord: b64(r.coord),
  color: b64(r.color),
  faceSlot: r.atlas ? b64(r.faceSlot) : null,
  atlas: r.atlas ? {
    grid: r.atlas.grid, rows: r.atlas.rows, slots: r.atlas.slots, texel: r.atlas.texel,
    data: b64(r.atlas.data),
  } : null,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`\n写出 ${OUT}  (${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log(`体素 ${r.count}  图集 ${r.atlas ? r.atlas.slots + ' 槽 ' + (r.atlas.grid * r.atlas.texel) + 'x' + (r.atlas.rows * r.atlas.texel) : '无'}`);
