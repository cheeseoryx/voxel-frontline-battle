/*
 * check-map-terrain.js — 关卡编辑器地形覆盖层的数据级断言（不需要浏览器）。
 *
 *   node scripts/check-map-terrain.js
 *
 * 最重要的一条是 (1)：覆盖层为空时，heightAtMeters / isLand / isWater / isBank
 * 必须和加这层之前**逐点相同**。地形是所有关卡逻辑的地基（旗点、载具出生、AI
 * 寻路、部署地图），一点偏移都会静默地毁掉一张地图。这里拿 git HEAD 里的旧版
 * island-conquest.js 当对照，所以只要文件还在版本控制里，这条断言就不会腐烂。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const SIZE = 1024;
const MAP_KEY = 'island-conquest';

let checks = 0;
function ok(condition, message) {
  checks++;
  if (!condition) throw new Error(message);
}

/** 在一个新的 VF 上下文里加载若干脚本，返回那个 VF。 */
function loadVF(files) {
  const context = { window: { VF: {} }, console: console };
  context.globalThis = context;
  for (const f of files) {
    const src = typeof f === 'string' ? fs.readFileSync(path.join(root, f), 'utf8') : f.src;
    vm.runInNewContext(src, context, { filename: typeof f === 'string' ? f : f.name });
  }
  return context.window.VF;
}

/* ------------------------------------------------------------------ *
 * 1. 空覆盖层必须和改动前逐点一致
 * ------------------------------------------------------------------ */
let baseSrc = null;
try {
  baseSrc = execFileSync('git', ['show', 'HEAD:js/maps/island-conquest.js'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  });
} catch (e) {
  // 首次提交前 / 非 git 检出：跳过对照，其它断言照跑。
  process.stderr.write('  (跳过基线对照：拿不到 git HEAD 的 island-conquest.js)\n');
}

if (baseSrc) {
  const base = loadVF([{ name: 'HEAD:island-conquest.js', src: baseSrc }]).IslandConquestMap;
  // 关键：MapTerrain **要加载**，数据文件也要加载（全零），走的是真实生产配置。
  const live = loadVF([
    'js/maps/map-terrain.js',
    'js/maps/island-conquest-terrain.js',
    'js/maps/island-conquest.js',
  ]);
  const now = live.IslandConquestMap;

  ok(live.MapTerrain, 'MapTerrain 没有挂到 VF 上');
  ok(
    live.MapTerrain.isBlank(live.MapTerrain.get(MAP_KEY)),
    'js/maps/island-conquest-terrain.js 不是空覆盖层 —— 基线对照会失效。' +
      '如果这是有意的（已经用编辑器改过地形），请把这条断言改成对照一份固化的采样表。'
  );

  let samples = 0;
  for (let z = 0; z < SIZE; z += 5) {
    for (let x = 0; x < SIZE; x += 5) {
      samples++;
      const a = base.heightAtMeters(x, z, SIZE);
      const b = now.heightAtMeters(x, z, SIZE);
      if (a !== b) {
        throw new Error(
          '空覆盖层下地形高度变了：(' + x + ',' + z + ') ' + a + ' → ' + b
        );
      }
      if (base.isLand(x, z, SIZE) !== now.isLand(x, z, SIZE)) {
        throw new Error('空覆盖层下 isLand 变了：(' + x + ',' + z + ')');
      }
      if (base.isWater(x, z, SIZE) !== now.isWater(x, z, SIZE)) {
        throw new Error('空覆盖层下 isWater 变了：(' + x + ',' + z + ')');
      }
      if (base.isBank(x, z, SIZE) !== now.isBank(x, z, SIZE)) {
        throw new Error('空覆盖层下 isBank 变了：(' + x + ',' + z + ')');
      }
    }
  }
  checks += 4;
  ok(samples > 40000, '基线对照的采样点太少：' + samples);
}

/* ------------------------------------------------------------------ *
 * 后续断言共用一份加载好的模块
 * ------------------------------------------------------------------ */
const VF = loadVF([
  'js/maps/map-terrain.js',
  'js/maps/island-conquest-terrain.js',
  'js/maps/island-conquest.js',
]);
const MT = VF.MapTerrain;
const MAP = VF.IslandConquestMap;

/* ------------------------------------------------------------------ *
 * 2. RLE 往返无损
 * ------------------------------------------------------------------ */
(function rleRoundTrip() {
  const cases = [];
  // 全零（最常见的那一份）
  cases.push(new Int16Array(64 * 64));
  // 全同一个非零值
  const flat = new Int16Array(64 * 64);
  flat.fill(-37);
  cases.push(flat);
  // 每格都不同 —— RLE 的最坏情况
  const alt = new Int16Array(1000);
  for (let i = 0; i < alt.length; i++) alt[i] = i % 2 ? 5 : -5;
  cases.push(alt);
  // 伪随机分块
  const blocky = new Int16Array(4096);
  let seed = 12345;
  for (let i = 0; i < blocky.length; ) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const run = 1 + (seed % 40);
    const val = ((seed >> 8) % 200) - 100;
    for (let k = 0; k < run && i < blocky.length; k++, i++) blocky[i] = val;
  }
  cases.push(blocky);

  for (let c = 0; c < cases.length; c++) {
    const src = cases[c];
    const rle = MT.encode(src);
    const back = MT.decode(rle, new Int16Array(src.length));
    for (let i = 0; i < src.length; i++) {
      ok(src[i] === back[i], 'RLE 往返不无损（用例 ' + c + '，下标 ' + i + '）');
    }
    // encode 只在这些用例上验，不做一般性的压缩率断言。
    ok(rle.length % 2 === 0, 'RLE 长度必须是偶数（值/个数成对）');
  }

  // 空零层压成两个数字 —— 这是"未编辑的数据文件只有几百字节"的依据。
  const blankRle = MT.encode(new Int16Array(256 * 256));
  ok(blankRle.length === 2, '全零层没有压成 2 个数字：' + blankRle.length);
  ok(blankRle[0] === 0 && blankRle[1] === 65536, '全零层的 RLE 内容不对');

  // decode 对坏数据要容错，不能抛
  const short = MT.decode([7, 5], new Int16Array(20));
  ok(short[0] === 7 && short[4] === 7 && short[5] === 0, 'RLE 短于目标时应留零');
  const long = MT.decode([3, 999], new Int16Array(4));
  ok(long[0] === 3 && long[3] === 3, 'RLE 长于目标时应截断而不是越界');
  MT.decode(null, new Int16Array(4));
  MT.decode([], new Int16Array(4));
  MT.decode([1], new Int16Array(4)); // 奇数长度
  checks += 3;
})();

/* ------------------------------------------------------------------ *
 * 3. 双线性：控制点上必须精确等于该控制点的值
 * ------------------------------------------------------------------ */
(function bilinearExactAtNodes() {
  const data = MT.blank(4, 64);
  let seed = 999;
  for (let i = 0; i < data.h.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data.h[i] = (seed % 400) - 200;
  }
  // 最后一列/行是钳位边界，双线性在那里退化，单独排除。
  for (let gz = 0; gz < 63; gz++) {
    for (let gx = 0; gx < 63; gx++) {
      const want = data.h[gz * 64 + gx] * 0.1;
      const got = MT.heightOffsetAt(data, gx * 4, gz * 4);
      ok(
        Math.abs(got - want) < 1e-9,
        '双线性在控制点 (' + gx + ',' + gz + ') 不精确：' + got + ' ≠ ' + want
      );
    }
  }

  // 两个控制点正中间 = 两者平均
  const g = MT.blank(4, 8);
  g.h[0] = 0;
  g.h[1] = 100; // 世界 x=4
  const mid = MT.heightOffsetAt(g, 2, 0);
  ok(Math.abs(mid - 5) < 1e-9, '双线性中点不是平均值：' + mid);

  // 四格中心 = 四者平均
  const q = MT.blank(4, 8);
  q.h[0] = 0;
  q.h[1] = 40;
  q.h[8] = 80;
  q.h[9] = 120;
  const centre = MT.heightOffsetAt(q, 2, 2);
  ok(Math.abs(centre - 6) < 1e-9, '双线性四格中心不是平均值：' + centre);

  // 越界钳位，不抛不 NaN
  for (const p of [[-100, -100], [1e6, 1e6], [-1, 500], [500, -1]]) {
    const v = MT.heightOffsetAt(data, p[0], p[1]);
    ok(isFinite(v), '越界采样返回了非有限值：' + p);
  }
  checks += 4;
})();

/* ------------------------------------------------------------------ *
 * 4. 任意偏移下高度都量化到 10cm，且落在 [TOP_MIN, TOP_MAX]
 *
 * 这两条一起守住 voxel-world._buildHeightTerrain 的不变量：它把 gy 钳到
 * [6, height-8] 却写**未钳位**的 surfH 进 terrainH。surfH 必须让
 * round(surfH)-1 自然落在 [6,93] 内，否则 groundY 和 terrainH 当场不一致，
 * terrain-fine.assertTerrainColumn 会抛 'Terrain column desynchronized'。
 * ------------------------------------------------------------------ */
(function heightInvariants() {
  ok(MAP.TOP_MIN >= 6.5, 'TOP_MIN 低于 6.5，round(h)-1 会掉到 groundY 钳位下界外');
  ok(MAP.TOP_MAX <= 94.49, 'TOP_MAX 高于 94.49，round(h)-1 会超过 groundY 钳位上界');
  ok(MAP.TOP_MAX <= 101 - 5, 'TOP_MAX 没给摆件（上限 height-5）留余量');

  const data = MT.get(MAP_KEY);
  // 极端偏移：整片推到上限、整片压到下限、以及一片强烈起伏。
  const patterns = [
    function () { data.h.fill(MT.H_MAX); },
    function () { data.h.fill(MT.H_MIN); },
    function () {
      for (let i = 0; i < data.h.length; i++) {
        data.h[i] = i % 3 === 0 ? MT.H_MAX : i % 3 === 1 ? MT.H_MIN : 0;
      }
    },
  ];
  const contours = [0, MT.WATER_FORCE_WET, MT.WATER_FORCE_LAND];

  for (const apply of patterns) {
    for (const c of contours) {
      apply();
      data.water.fill(c);
      for (let z = 0; z < SIZE; z += 37) {
        for (let x = 0; x < SIZE; x += 37) {
          const h = MAP.heightAtMeters(x, z, SIZE);
          if (Math.abs(h * 10 - Math.round(h * 10)) > 1e-9) {
            throw new Error('高度没有量化到 10cm：(' + x + ',' + z + ') = ' + h);
          }
          if (h < MAP.TOP_MIN - 1e-9 || h > MAP.TOP_MAX + 1e-9) {
            throw new Error('高度越界：(' + x + ',' + z + ') = ' + h);
          }
          // 真正要守的那条：gy 必须落在生成器的钳位范围内
          const gy = Math.round(h) - 1;
          if (gy < 6 || gy > 101 - 8) {
            throw new Error(
              'groundY 会被 _buildHeightTerrain 钳位（导致和 terrainH 不一致）：' +
                '(' + x + ',' + z + ') h=' + h + ' gy=' + gy
            );
          }
        }
      }
      checks += 3;
    }
  }
  MT.reset(MAP_KEY);
})();

/* ------------------------------------------------------------------ *
 * 5. 轮廓覆盖能翻转 isWater / isLand，且 isBank 跟着变
 * ------------------------------------------------------------------ */
(function contourOverride() {
  const data = MT.get(MAP_KEY);

  // 先找一个程序判定为「干燥陆地」的点，和一个「山外」的点。
  let dry = null;
  let outside = null;
  for (let z = 100; z < SIZE - 100 && (!dry || !outside); z += 3) {
    for (let x = 100; x < SIZE - 100; x += 3) {
      const land = MAP.isLand(x, z, SIZE);
      const wet = MAP.isWater(x, z, SIZE);
      if (!dry && land && !wet) dry = [x, z];
      if (!outside && !land) outside = [x, z];
      if (dry && outside) break;
    }
  }
  ok(dry, '找不到干燥陆地的采样点');
  ok(outside, '找不到盆地外的采样点');

  // 强制水
  MT.fillRect(data, 'water', 0, 0, data.cells - 1, data.cells - 1, MT.WATER_FORCE_WET);
  ok(MAP.isWater(dry[0], dry[1], SIZE) === true, '强制水没生效');
  ok(MAP.isLand(dry[0], dry[1], SIZE) === true, '强制水必须仍算 isLand（isWater ⊂ isLand）');
  ok(MAP.isLand(outside[0], outside[1], SIZE) === true, '强制水没把山外变成可游玩范围');

  // 强制陆地
  MT.fillRect(data, 'water', 0, 0, data.cells - 1, data.cells - 1, MT.WATER_FORCE_LAND);
  ok(MAP.isWater(dry[0], dry[1], SIZE) === false, '强制陆地没能取消水');
  ok(MAP.isLand(outside[0], outside[1], SIZE) === true, '强制陆地没把山外变成陆地');

  // isBank ⊂ isLand。isBank 的定义是 isLand && landDist > 0.78，所以盆地外被刷成
  // 强制陆地后它仍是 true —— 那是「边缘地形」，语义上说得通，而且 ridge 布局下
  // bank 只喂给 _riverInfo().bank，那些分支（voxel-world.js:653-687）走的是
  // _buildTerrain 的非高度图路径，ridge 不经过。这里只守子集关系。
  for (const p of [dry, outside]) {
    if (MAP.isBank(p[0], p[1], SIZE)) {
      ok(MAP.isLand(p[0], p[1], SIZE) === true, 'isBank 为真但 isLand 为假：' + p);
    }
  }

  // 强制陆地还要抹掉山脊斜坡，否则高度笔刷在盆地外刷不出平地
  const ridgeH = MAP.heightAtMeters(outside[0], outside[1], SIZE);
  MT.fillRect(data, 'water', 0, 0, data.cells - 1, data.cells - 1, MT.WATER_INHERIT);
  const wildH = MAP.heightAtMeters(outside[0], outside[1], SIZE);
  ok(ridgeH < wildH, '强制陆地没有抹掉山脊斜坡：' + ridgeH + ' 应低于 ' + wildH);

  MT.reset(MAP_KEY);
  ok(
    MT.isBlank(MT.get(MAP_KEY)),
    'reset() 没能把覆盖层回滚成数据文件里的样子'
  );
})();

/* ------------------------------------------------------------------ *
 * 5b. reset() 之后采样必须真的看到回滚结果（回归：曾经不是这样）
 *
 * 编辑器退出时如果没保存，会调 MT.reset() 把地形回滚，免得未保存的改动跑进正常
 * 对局。但 island-conquest.js 的 overlay() 一度按 raw 对象缓存 live 引用，而
 * reset() 只换 live 不换 raw —— 于是回滚之后 heightAtMeters 还在读被撤销的地形。
 * 这里编辑→回滚→再编辑→再回滚跑两轮，任何一层缓存搞错都会失败。
 * ------------------------------------------------------------------ */
(function resetIsVisibleToSampling() {
  const probe = [400, 400];
  MT.reset(MAP_KEY);
  const base = MAP.heightAtMeters(probe[0], probe[1], SIZE);

  for (let round = 0; round < 2; round++) {
    const data = MT.get(MAP_KEY);
    const delta = round ? -30 : 80;
    data.h.fill(delta);
    MT.touch(data);
    const edited = MAP.heightAtMeters(probe[0], probe[1], SIZE);
    ok(
      Math.abs(edited - (base + delta * 0.1)) < 1e-6,
      '第 ' + round + ' 轮编辑没有反映到采样：' + base + ' + ' + (delta * 0.1) + ' ≠ ' + edited
    );

    MT.reset(MAP_KEY);
    const rolled = MAP.heightAtMeters(probe[0], probe[1], SIZE);
    ok(
      rolled === base,
      '第 ' + round + ' 轮 reset() 后采样仍是编辑后的值（' + rolled + ' ≠ ' + base +
      '）—— 未保存的地形会漏进正常对局'
    );
  }
})();

/* ------------------------------------------------------------------ *
 * 6. mat 层采样 + 最近邻取整方向
 * ------------------------------------------------------------------ */
(function materialLayer() {
  const data = MT.blank(4, 16);
  const gi = MT.cellIndex(data, 5, 6);
  ok(gi === 6 * 16 + 5, 'cellIndex 算错了');
  ok(MT.cellIndex(data, -1, 0) === -1, 'cellIndex 越界应返回 -1');
  ok(MT.cellIndex(data, 16, 0) === -1, 'cellIndex 越界应返回 -1');

  data.mat[gi] = 7;
  // 控制点正中心
  ok(MT.matAt(data, 20, 24) === 7, 'matAt 在控制点上取不到值');
  // 最近邻是四舍五入：距离 < step/2 仍应命中
  ok(MT.matAt(data, 21.9, 24) === 7, 'matAt 最近邻半径不对（应四舍五入）');
  ok(MT.matAt(data, 18.1, 24) === 7, 'matAt 最近邻半径不对（应四舍五入）');
  // 超过半格就该落到邻居（值为 0）
  ok(MT.matAt(data, 23, 24) === 0, 'matAt 越过半格还命中，说明用了 floor 而非 round');
  ok(MT.waterAt(data, 20, 24) === 0, 'waterAt 不该读到 mat 层');
})();

/* ------------------------------------------------------------------ *
 * 7. toRaw / fromRaw 往返
 * ------------------------------------------------------------------ */
(function rawRoundTrip() {
  const a = MT.blank(4, 32);
  let seed = 4242;
  for (let i = 0; i < a.h.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    a.h[i] = (seed % 100) - 50;
    a.mat[i] = seed % 5 ? 0 : 3;
    a.water[i] = seed % 7 ? 0 : 1;
  }
  const b = MT.fromRaw(MT.toRaw(a));
  ok(b.step === a.step && b.cells === a.cells, 'toRaw/fromRaw 丢了 step/cells');
  for (let i = 0; i < a.h.length; i++) {
    ok(a.h[i] === b.h[i], 'toRaw/fromRaw h 层不一致 @' + i);
    ok(a.mat[i] === b.mat[i], 'toRaw/fromRaw mat 层不一致 @' + i);
    ok(a.water[i] === b.water[i], 'toRaw/fromRaw water 层不一致 @' + i);
  }
  ok(MT.isBlank(MT.blank(4, 8)) === true, 'blank() 应该 isBlank');
  const nz = MT.blank(4, 8);
  nz.water[3] = 1;
  ok(MT.isBlank(nz) === false, 'water 层非零时不该算 isBlank');
})();

/* ------------------------------------------------------------------ *
 * 8. clampH
 * ------------------------------------------------------------------ */
(function clamp() {
  ok(MT.clampH(1e9) === MT.H_MAX, 'clampH 上界不对');
  ok(MT.clampH(-1e9) === MT.H_MIN, 'clampH 下界不对');
  ok(MT.clampH(3.4) === 3, 'clampH 应取整');
  ok(MT.clampH(-3.6) === -4, 'clampH 应取整');
})();

/* ------------------------------------------------------------------ *
 * 9. 覆盖网格必须盖满世界
 * ------------------------------------------------------------------ */
(function coverage() {
  const raw = MT.toRaw(MT.get(MAP_KEY));
  const span = raw.cells * raw.step;
  ok(
    span >= SIZE - raw.step,
    '覆盖网格盖不住世界：' + raw.cells + '×' + raw.step + 'm = ' + span + 'm < ' + SIZE + 'm'
  );
})();

console.log('map-terrain checks: OK (' + checks + ' 条断言)');
