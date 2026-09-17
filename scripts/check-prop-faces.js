'use strict';
/*
 * check-prop-faces.js — 校验 js/props/prop-faces.js 的纯数学部分：
 *
 *   1. YAW_MAP 每个 yaw 档位都必须是 6 个面的置换（不能丢面/重面）
 *   2. q=0 必须是恒等（glb 轴 == 世界轴，靠 prop-glb 的预翻转与 prop-stamp 的
 *      lz = D-1-by 相消；如果这里不是恒等，摆件会整体镜像或转向）
 *   3. 面内变换必须是纯旋转（det = +1）。det = -1 说明纹理被镜像了
 *   4. buildCornerUv 必须把每个面的 4 个角点映射到单位正方形的 4 个角，
 *      且顺序与面自己的顶点顺序一致（ winding 不能翻，否则贴图会转/翻）
 *
 * 用法： node scripts/check-prop-faces.js
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

global.window = undefined;
global.VF = {};
require(path.join(ROOT, 'js', 'props', 'prop-faces.js'));
const PF = global.VF.PropFaces;

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
}

/** uv code → 对 (su,sv) 的线性系数 [a, b]，即 u = a*su + b*sv (+ 常数) */
const COEF = [[1, 0], [-1, 0], [0, 1], [0, -1]];

console.log('PropFaces 面映射');
console.log('');

// ---- 1 / 2 / 3：YAW_MAP ----
for (let q = 0; q < 4; q++) {
  const map = PF.YAW_MAP[q];
  const srcs = map.map((m) => m.src).sort((a, b) => a - b);
  ok(srcs.join(',') === '0,1,2,3,4,5', 'yaw ' + q * 90 + '° 面映射是 0..5 的置换', srcs.join(','));

  let det = null;
  let detOk = true;
  for (let f = 0; f < 6; f++) {
    const m = map[f];
    const [a, b] = COEF[m.ru];
    const [c, d] = COEF[m.rv];
    const dt = a * d - b * c;
    if (det === null) det = dt;
    else if (dt !== det) detOk = false;
  }
  ok(detOk && det === 1, 'yaw ' + q * 90 + '° 面内变换是纯旋转（det=+1，未镜像）', 'det=' + det);
}

{
  const m0 = PF.YAW_MAP[0];
  let idOk = true;
  for (let f = 0; f < 6; f++) {
    if (m0[f].src !== f || m0[f].ru !== 0 || m0[f].rv !== 2) idOk = false;
  }
  ok(idOk, 'yaw 0° 是恒等映射（glb 轴 == 世界轴）');
}

// ---- 4：buildCornerUv ----
// 与 js/voxel-world.js _rebuildChunk 的 faces[] 保持一致
const faces = [
  { n: [0, 1, 0], d: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { n: [0, -1, 0], d: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [1, 0, 0], d: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { n: [-1, 0, 0], d: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  { n: [0, 0, 1], d: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { n: [0, 0, -1], d: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
];
const cuv = PF.buildCornerUv(faces);
const NAMES = ['+Y', '-Y', '+X', '-X', '+Z', '-Z'];
for (let f = 0; f < 6; f++) {
  const got = cuv[f].map((c) => c[0] + ',' + c[1]).join(' | ');
  let inRange = true;
  let covers = true;
  const seen = new Set();
  for (const c of cuv[f]) {
    if (c[0] < -1e-9 || c[0] > 1 + 1e-9 || c[1] < -1e-9 || c[1] > 1 + 1e-9) inRange = false;
    seen.add(c[0] + ',' + c[1]);
  }
  for (const corner of ['0,0', '1,0', '1,1', '0,1']) if (!seen.has(corner)) covers = false;
  // 顶点顺序必须绕单位正方形一圈（相邻两点只差一条边）
  let winding = true;
  for (let v = 0; v < 4; v++) {
    const a = cuv[f][v];
    const b = cuv[f][(v + 1) % 4];
    if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) !== 1) winding = false;
  }
  ok(inRange && covers && winding, NAMES[f] + ' 面角点 uv 覆盖单位正方形且绕向正确', got);
}

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
