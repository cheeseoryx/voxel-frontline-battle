'use strict';
/**
 * 移植一致性校验：scripts/lib/glb-voxelize.js  vs  源工程 E:\Test\aks\tools\voxelize.js
 *
 * 两边用**同一组参数**跑同一个 GLB，然后逐项比对：
 *   1) index / color：必须完全相同（这条路径与面序无关）
 *   2) 隐藏面标记（0xFFFF）：必须完全相同
 *   3) 面纹理内容：
 *        +Y/-Y/+Z/-Z 四面 → 切向基与 aks 相同，内容必须逐字节相同
 *        +X/-X 两面     → 本工程 mesher 的切向基与 aks 差 90°，
 *                         内容应相差一个纯 90° 旋转：ours(j,i) == aks(i, FT-1-j)
 *
 * 用法:
 *   node scripts/check-glb-voxelize.js [--glb <path>] [--res 32] [--faceft 12]
 * 需要 E:\Test\aks 存在（比对基准）。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const AKS = 'E:\\Test\\aks';
const NODE = process.execPath;

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const GLB = arg('glb', path.join(ROOT, 'assets/vehicles/tank.glb'));
const RES = arg('res', '32');
const FACEFT = arg('faceft', '12');

const aksOut = path.join(ROOT, 'tmp/_cmp_aks.js');
const oursOut = path.join(ROOT, 'tmp/_cmp_ours.json');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS  ' + msg); } else { fail++; console.log('  FAIL  ' + msg); } };

function deb(b64, Ctor) {
  const b = Buffer.from(b64, 'base64');
  return new Ctor(b.buffer, b.byteOffset, b.byteLength / Ctor.BYTES_PER_ELEMENT);
}

// 面序：aks = px,nx,py,ny,pz,nz ；本工程 = +Y,-Y,+X,-X,+Z,-Z
const AKS_OF_OURS = [2, 3, 0, 1, 4, 5];   // ours f -> aks f
const OURS_NAMES = ['+Y', '-Y', '+X', '-X', '+Z', '-Z'];
const ROTATED = new Set([2, 3]);          // 需要 90° 旋转比对的 X 面

function run() {
  console.log(`模型: ${path.basename(GLB)}   res=${RES} faceft=${FACEFT}`);
  if (!fs.existsSync(AKS)) { console.error('缺少基准工程 ' + AKS); process.exit(2); }

  // --- 跑源工程
  console.log('\n[1/3] 运行源工程 voxelize.js ...');
  execFileSync(NODE, [path.join(AKS, 'tools/voxelize.js'), GLB, aksOut, `--res=${RES}`, `--faceft=${FACEFT}`],
    { cwd: AKS, stdio: 'inherit', env: Object.assign({}, process.env, { NODE_PATH: 'C:/Users/ronal/.workbuddy/binaries/node/workspace/node_modules' }) });

  // --- 跑本工程（参数必须对齐：aks 默认 quant=64 / jitter=0.12 / sat=1）
  console.log('\n[2/3] 运行 scripts/voxelize-glb.js ...');
  execFileSync(NODE, [path.join(ROOT, 'scripts/voxelize-glb.js'), GLB, oursOut,
    `--res=${RES}`, `--faceft=${FACEFT}`, '--quant=64', '--jitter=0.12', '--sat=1'], { stdio: 'inherit' });

  // --- 载入
  const aksSrc = fs.readFileSync(aksOut, 'utf8');
  const window = {};
  new Function('window', aksSrc)(window);
  const A = window.HOUSE_VOXELS;
  const O = JSON.parse(fs.readFileSync(oursOut, 'utf8'));

  console.log('\n[3/3] 比对 ...');

  ok(A.nx === O.nx && A.ny === O.ny && A.nz === O.nz,
    `网格尺寸 ${O.nx}x${O.ny}x${O.nz} (aks ${A.nx}x${A.ny}x${A.nz})`);
  ok(A.count === O.count, `体素数 ${O.count} (aks ${A.count})`);
  ok(Math.abs(A.voxel - O.voxel) < 1e-9, `voxel 尺寸 ${O.voxel.toFixed(6)}`);

  const aIdx = deb(A.index, Int32Array);
  const oIdx = deb(O.index, Int32Array);
  let idxBad = 0;
  for (let i = 0; i < Math.min(aIdx.length, oIdx.length); i++) if (aIdx[i] !== oIdx[i]) idxBad++;
  ok(idxBad === 0, `index 逐项一致（${oIdx.length} 项，${idxBad} 处不同）`);

  const aCol = deb(A.color, Uint8Array);
  const oCol = deb(O.color, Uint8Array);
  let colBad = 0, colMax = 0;
  for (let i = 0; i < aCol.length; i++) {
    const d = Math.abs(aCol[i] - oCol[i]);
    if (d > 0) colBad++;
    if (d > colMax) colMax = d;
  }
  ok(colBad === 0, `color 逐字节一致（${oCol.length} 字节，${colBad} 处不同，最大差 ${colMax}）`);

  // --- 图集
  const FT = A.atlas.texel;
  ok(A.atlas.texel === O.atlas.texel, `texel ${FT}`);
  ok(A.atlas.slots === O.atlas.slots, `图集槽数 ${O.atlas.slots} (aks ${A.atlas.slots})`);

  const aAtl = deb(A.atlas.data, Uint8Array);
  const oAtl = deb(O.atlas.data, Uint8Array);
  const aFS = deb(A.faceSlot, Uint16Array);
  const oFS = deb(O.faceSlot, Uint16Array);

  const slotContent = (data, grid, slot) => {
    const gx = (slot % grid) * FT, gy = Math.floor(slot / grid) * FT;
    const aw = grid * FT;
    const out = new Uint8Array(FT * FT * 3);
    for (let y = 0; y < FT; y++) for (let x = 0; x < FT; x++) {
      const si = (y * FT + x) * 3, di = ((gy + y) * aw + gx + x) * 3;
      out[si] = data[di]; out[si + 1] = data[di + 1]; out[si + 2] = data[di + 2];
    }
    return out;
  };
  // 缓存：避免重复切片
  const aCache = new Map(), oCache = new Map();
  const aSlot = (s) => { let c = aCache.get(s); if (!c) { c = slotContent(aAtl, A.atlas.grid, s); aCache.set(s, c); } return c; };
  const oSlot = (s) => { let c = oCache.get(s); if (!c) { c = slotContent(oAtl, O.atlas.grid, s); oCache.set(s, c); } return c; };

  /**
   * 把 aks 的内容按 90° 旋转成 ours 的坐标系。
   *   ours(j,i) 期望等于 aks 的 (row=sj, col=si)
   *   rot 0：不转        si=i,          sj=j
   *   rot 1：顺时针 90°  si=FT-1-j,     sj=i
   *   rot 2：逆时针 90°  si=j,          sj=FT-1-i
   */
  const rotate = (src, rot) => {
    const out = new Uint8Array(FT * FT * 3);
    for (let j = 0; j < FT; j++) for (let i = 0; i < FT; i++) {
      let si, sj;
      if (rot === 0) { si = i; sj = j; }
      else if (rot === 1) { si = FT - 1 - j; sj = i; }
      else { si = j; sj = FT - 1 - i; }
      const s = (sj * FT + si) * 3, d = (j * FT + i) * 3;
      out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2];
    }
    return out;
  };

  /** 内容是否非纯色（纯色面在任何旋转下都成立，不能用来判定旋转） */
  const isVariegated = (c) => {
    const r = c[0], g = c[1], b = c[2];
    for (let i = 3; i < c.length; i += 3) if (c[i] !== r || c[i + 1] !== g || c[i + 2] !== b) return true;
    return false;
  };

  // --- 逐（体素, 面）比对
  let hiddenMismatch = 0;
  const perFace = [0, 0, 0, 0, 0, 0];      // 每个方向的总差异 texel 数
  const perFaceN = [0, 0, 0, 0, 0, 0];
  const rotHit = [0, 0, 0];                 // 三种旋转各自的命中数（X 面）
  let compared = 0, varX = 0, flatX = 0, rotMissSample = null;

  for (let k = 0; k < O.count; k++) {
    for (let f = 0; f < 6; f++) {
      const os = oFS[k * 6 + f];
      const as = aFS[k * 6 + AKS_OF_OURS[f]];
      if ((os === 0xFFFF) !== (as === 0xFFFF)) { hiddenMismatch++; continue; }
      if (os === 0xFFFF) continue;
      const oc = oSlot(os);
      const ac = aSlot(as);
      perFaceN[f]++;
      if (ROTATED.has(f)) {
        // 只有非纯色面才能区分旋转方向；纯色面单独统计
        if (!isVariegated(oc)) { flatX++; continue; }
        let best = -1, bestDiff = Infinity;
        const diffs = [];
        for (let rot = 0; rot < 3; rot++) {
          const rc = rotate(ac, rot);
          let d = 0;
          for (let i = 0; i < oc.length; i++) d += Math.abs(oc[i] - rc[i]);
          diffs.push(d);
          if (d < bestDiff) { bestDiff = d; best = rot; }
        }
        rotHit[best] += bestDiff === 0 ? 1 : 0;
        perFace[f] += bestDiff;
        if (bestDiff !== 0) rotMissSample = { k, f, diffs };
        varX++;
      } else {
        let d = 0;
        for (let i = 0; i < oc.length; i++) d += Math.abs(oc[i] - ac[i]);
        perFace[f] += d;
      }
      compared++;
    }
  }

  ok(hiddenMismatch === 0, `隐藏面标记一致（${hiddenMismatch} 处不一致）`);

  for (let f = 0; f < 6; f++) {
    const n = perFaceN[f];
    if (!n) { console.log(`  --    ${OURS_NAMES[f]} 面：无暴露面`); continue; }
    if (ROTATED.has(f)) {
      const good = perFace[f] === 0 && rotHit[1] > 0 && rotHit[0] === 0 && rotHit[2] === 0;
      ok(good, `${OURS_NAMES[f]} 面：与 aks 差 90° 旋转后逐字节一致` +
        `（图案面 ${varX}，纯色面 ${flatX}；rot0/1/2 命中 ${rotHit[0]}/${rotHit[1]}/${rotHit[2]}，累积差 ${perFace[f]}）`);
      if (!good && rotMissSample) console.log('        首个不符:', JSON.stringify(rotMissSample));
    } else {
      ok(perFace[f] === 0, `${OURS_NAMES[f]} 面：与 aks 逐字节一致（${n} 面，累积差 ${perFace[f]}）`);
    }
  }
  console.log(`  （共比对 ${compared} 个可见面）`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

run();
