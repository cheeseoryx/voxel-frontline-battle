'use strict';
/**
 * 把 .glb 资产变成 bake-props.js 能直接消费的模型形状。
 *
 * 坐标约定（关键）：
 *   glb-voxelize 输出的网格是 glTF 的 Y-up 右手系，与游戏世界一致 → 直接 (gx,gy,gz)=(X,Y,Z)。
 *   bake-props / prop-stamp 的 prop 局部坐标是 .vox 风格的 (宽 bx, 深 by, 高 bz)，
 *   stamp 里 lz = D-1-by（翻深度轴，用来把 Z-up 的 .vox 修正成 Y-up）。
 *   对 GLB 我们**预先翻一遍** by = nz-1-gz，与 stamp 的那次翻转相消 → 净效果是恒等变换，
 *   既不会镜像模型，也不需要改 prop-stamp 的轴向逻辑。
 *
 * 面槽位 faceSlot 与体素网格线性下标 gi = gx + nx*(gy + ny*gz) 同序（升序），
 * 由 giToK 提供 gi → k 的反查。
 */

const fs = require('fs');
const path = require('path');
const { voxelize } = require('./glb-voxelize.js');

const DEFAULT_GLB_OPT = {
  res: 32,
  faceft: 12,
  facethr: 10,
  faceray: 4,
  facess: 1,
  ss: 1,
  sat: 1,
  fill: false,
  keepBase: false,
};

/** 读取可选的 <name>.json（与 .glb 同名），只认白名单键 */
function loadCfg(glbPath) {
  const cfgPath = glbPath.replace(/\.glb$/i, '.json');
  if (!fs.existsSync(cfgPath)) return {};
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    throw new Error('配置文件解析失败 ' + path.basename(cfgPath) + ': ' + e.message);
  }
  const out = {};
  for (const k of Object.keys(DEFAULT_GLB_OPT)) {
    if (raw[k] !== undefined) out[k] = raw[k];
  }
  return out;
}

/**
 * @param {string} file .glb 路径
 * @param {object} globalOpt 全局默认（CLI），会被同名 .json 覆盖
 * @param {(msg:string)=>void} log
 */
function loadGlbProp(file, globalOpt, log) {
  const cfg = loadCfg(file);
  const opt = Object.assign({}, DEFAULT_GLB_OPT, globalOpt || {}, cfg);
  log('体素化 ' + path.basename(file) +
    '  res=' + opt.res + ' faceft=' + opt.faceft + ' sat=' + opt.sat + (opt.fill ? ' fill' : ''));

  const r = voxelize(fs.readFileSync(file), {
    res: opt.res,
    faceft: opt.faceft,
    facethr: opt.facethr,
    faceray: opt.faceray,
    facess: opt.facess,
    ss: opt.ss,
    sat: opt.sat,
    fill: !!opt.fill,
    onLog: (m) => log('    ' + m),
  });

  const { nx, ny, nz, count } = r;
  if (!count) throw new Error('体素化结果为空: ' + path.basename(file));

  // gi -> k（faceSlot / color 的下标）
  const giToK = new Int32Array(nx * ny * nz).fill(-1);
  for (let k = 0; k < count; k++) giToK[r.index[k]] = k;

  // 颜色去重成紧凑调色板
  const palette = [];
  const palOf = new Map();
  const colorIdx = new Int32Array(count);
  for (let k = 0; k < count; k++) {
    const hex = ((r.color[k * 3] << 16) | (r.color[k * 3 + 1] << 8) | r.color[k * 3 + 2]) & 0xffffff;
    let pi = palOf.get(hex);
    if (pi === undefined) {
      pi = palette.length;
      palOf.set(hex, pi);
      palette.push(hex);
    }
    colorIdx[k] = pi;
  }

  // prop 局部坐标：x=宽(gx)  y=深(nz-1-gz)  z=高(gy)
  const voxels = new Array(count);
  const gv = new Int32Array(count * 3);
  for (let k = 0; k < count; k++) {
    const gx = r.coord[k * 3], gy = r.coord[k * 3 + 1], gz = r.coord[k * 3 + 2];
    // k = 该体素在 faceSlot / gv / color 里的原始下标（stripBaseSlab 过滤后仍要能反查）
    voxels[k] = { x: gx, y: nz - 1 - gz, z: gy, c: colorIdx[k], k: k };
    gv[k * 3] = gx; gv[k * 3 + 1] = gy; gv[k * 3 + 2] = gz;
  }

  return {
    id: path.basename(file, '.glb'),
    isGlb: true,
    voxels,
    palette,
    gv,
    giToK,
    grid: { nx, ny, nz },
    faceSlot: r.faceSlot,
    atlas: r.atlas,
    opt,
  };
}

module.exports = { loadGlbProp, loadCfg, DEFAULT_GLB_OPT };
