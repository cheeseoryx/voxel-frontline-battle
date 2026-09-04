/**
 * map-terrain.js — 地图地形覆盖层的采样器 + 编解码。
 *
 * 地形高度本身是**纯函数**（js/maps/island-conquest.js heightAtMeters：高斯包 +
 * 正弦扰动 + 盆地边缘斜坡，无 RNG、不依赖 mapSeed）。所以关卡编辑器不需要序列
 * 化 100MB 的体素数组，只要存一层"在程序高度之上的偏移量"。这个模块就是那层
 * 覆盖数据的读写口。
 *
 * ── 为什么必须单独成模块 ─────────────────────────────────────────────
 *
 * 编辑器实时预览用的高度、和刷新页面后 _buildHeightTerrain 生成的高度，**必须
 * 来自同一个采样函数**，否则保存后重进场景地形会整体错位。把采样收在这里，
 * island-conquest.js（加载路径）和 level-editor.js（编辑路径）都调它，
 * js/maps/*-terrain.js 保持纯数据。
 *
 * ── 三层数据 ─────────────────────────────────────────────────────────
 *
 *   h      高度偏移，单位**分米**（10cm）。双线性插值 —— 地形要平滑，最近邻
 *          会造出台阶悬崖和走不上去的坡。
 *   mat    表面材质覆盖，VF.BLOCK id，0 = 不覆盖。最近邻（离散类别，插值无意义）。
 *   water  水域/陆地轮廓覆盖：0 继承程序判定、1 强制水、2 强制陆地。最近邻。
 *
 * 三层共用一个 cells×cells 控制网格，间距 step 米。
 *
 * ── 两种表示 ─────────────────────────────────────────────────────────
 *
 *   raw   数据文件里的样子：{ step, cells, h: [RLE], mat: [RLE], water: [RLE] }。
 *         **永不被修改** —— reset() 靠它回滚未保存的改动。
 *   live  解码后的样子：{ step, cells, h: Int16Array, mat/water: Uint8Array }。
 *         编辑器直接改这个，采样也读这个。
 *
 * 无 DOM 依赖，可以在 node 里直接 require/vm 跑（见 scripts/check-map-terrain.js）。
 */
(function (global) {
  'use strict';

  global.VF = global.VF || {};

  const DEFAULT_STEP = 4;
  const DEFAULT_CELLS = 256;

  /** 高度偏移的取值范围（分米）。±900dm = ±90m，够把任何地方推到高度钳位边界。 */
  const H_MIN = -900;
  const H_MAX = 900;

  /** water 层的取值。 */
  const WATER_INHERIT = 0;
  const WATER_FORCE_WET = 1;
  const WATER_FORCE_LAND = 2;

  /* ------------------------------------------------------------------ *
   * RLE 编解码
   *
   * 格式：[值, 连续个数, 值, 连续个数, ...]，行主序。未编辑的一层就是
   * [0, 65536] 两个数字，所以空数据文件只有几百字节。
   * ------------------------------------------------------------------ */
  function encode(grid) {
    const out = [];
    const n = grid.length;
    if (!n) return out;
    let cur = grid[0];
    let run = 1;
    for (let i = 1; i < n; i++) {
      const v = grid[i];
      if (v === cur) {
        run++;
        continue;
      }
      out.push(cur, run);
      cur = v;
      run = 1;
    }
    out.push(cur, run);
    return out;
  }

  /**
   * 解码进 out。RLE 比 out 长就截断，短就把剩下的留成 0 —— 数据文件手改坏了
   * 或者 cells 改过，宁可少一块地形也不要抛错卡住整个游戏加载。
   */
  function decode(rle, out) {
    if (!rle || !rle.length) return out;
    let o = 0;
    const cap = out.length;
    for (let i = 0; i + 1 < rle.length; i += 2) {
      let run = rle[i + 1] | 0;
      if (run <= 0) continue;
      if (o + run > cap) run = cap - o;
      if (run <= 0) break;
      out.fill(rle[i] | 0, o, o + run);
      o += run;
      if (o >= cap) break;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * live 对象
   * ------------------------------------------------------------------ */
  function blank(step, cells) {
    step = step > 0 ? step | 0 : DEFAULT_STEP;
    cells = cells > 0 ? cells | 0 : DEFAULT_CELLS;
    const n = cells * cells;
    return {
      step: step,
      cells: cells,
      h: new Int16Array(n),
      mat: new Uint8Array(n),
      water: new Uint8Array(n),
      /**
       * isBlank 的记忆化结果。**这是有意公开的契约**，不只是私有缓存：
       * island-conquest.js 的 overlay() 在 heightAtMeters 热路径里直接读它，
       * 好让"覆盖层是空的"这个最常见的判断退化成一次属性读。
       *
       *   true   已知三层全零
       *   false  已知有非零值
       *   null   未知，需要重新扫（touch() 设成这个）
       *
       * 初始值是 null 而不是 true，尽管刚 new 出来的数组确实全零 —— 因为拿到这个
       * 对象的人下一步很可能就往里写（fromRaw 解码、测试直接 fill、编辑器笔刷）。
       * 默认"未知"意味着忘了调 touch() 的后果只是多扫一次；默认 true 的后果是
       * 静默读到错的答案。
       */
      _blankCache: null,
    };
  }

  function fromRaw(raw) {
    if (!raw) return blank();
    const live = blank(raw.step, raw.cells);
    decode(raw.h, live.h);
    decode(raw.mat, live.mat);
    decode(raw.water, live.water);
    return live;
  }

  function toRaw(live) {
    return {
      step: live.step,
      cells: live.cells,
      h: encode(live.h),
      mat: encode(live.mat),
      water: encode(live.water),
    };
  }

  /**
   * 三层全为 0 —— 用来跳过采样，让未编辑的地图走和改动前逐字节相同的路径。
   *
   * **结果要缓存。** 这个函数在 heightAtMeters 的热路径上（island-conquest.js
   * 的 overlay()），而 worldgen 会调 heightAtMeters 一百万次以上。不缓存的话
   * 每次采样都要扫 65536 个格子 —— 实测让一次建图从几秒变成一分半。
   *
   * 缓存靠 dirty 标记失效：编辑器改完控制点必须调 touch()。改数组的入口只有
   * fillRect / 编辑器的笔刷，所以标记点是可控的。
   */
  function isBlank(live) {
    if (!live) return true;
    if (live._blankCache != null) return live._blankCache;
    const n = live.cells * live.cells;
    let blank = true;
    for (let i = 0; i < n; i++) {
      if (live.h[i] || live.mat[i] || live.water[i]) {
        blank = false;
        break;
      }
    }
    live._blankCache = blank;
    return blank;
  }

  /**
   * 声明"我改过这份数据了"。作用是让 isBlank 的缓存失效。
   *
   * 笔刷每帧改几十个控制点，所以这个函数必须是 O(1) —— 它只是清掉缓存，
   * 下一次 isBlank 才真的重扫。而 isBlank 只在 overlay() 里被调，一旦
   * 结果是 false（已编辑过）就一直是 false，重扫会立刻在第一个非零格短路。
   */
  function touch(live) {
    if (live) live._blankCache = null;
  }

  /* ------------------------------------------------------------------ *
   * 注册表：mapKey → live，按需从 VF.MAP_TERRAIN[mapKey] 解码
   *
   * 缓存里带着解码来源 raw。VF.MAP_TERRAIN[mapKey] 换了对象（编辑器换草稿、或
   * 者数据文件热重载）就重新解码。
   * ------------------------------------------------------------------ */
  const registry = Object.create(null);

  function rawOf(mapKey) {
    const all = global.VF.MAP_TERRAIN;
    return (all && all[mapKey]) || null;
  }

  /**
   * 当前生效的 live 数据。
   *
   * 这是**唯一**该拿 live 引用的入口，调用方不要缓存返回值 —— reset() 会换成一个
   * 新对象，缓存住旧引用就会读到已经作废的数据（这条曾经真的出过 bug：
   * island-conquest.js 的 overlay() 按 raw 缓存，而 reset 不换 raw，于是回滚后
   * 采样还在读被撤销的地形）。要判断"是不是还是原来那份"，用 generation()。
   */
  function get(mapKey) {
    const raw = rawOf(mapKey);
    const hit = registry[mapKey];
    if (hit && hit.raw === raw) return hit.live;
    const live = fromRaw(raw);
    registry[mapKey] = { raw: raw, live: live };
    return live;
  }

  /** 丢掉未保存的改动，从数据文件的 raw 重新解码。 */
  function reset(mapKey) {
    delete registry[mapKey];
    return get(mapKey);
  }

  /**
   * 保存成功后调用：把当前 live 的内容固化成新的 raw 并写回 VF.MAP_TERRAIN，
   * 这样之后的 reset() 回滚到的是刚保存的状态，不是文件加载时的状态。
   */
  function commit(mapKey) {
    const live = get(mapKey);
    const raw = toRaw(live);
    global.VF.MAP_TERRAIN = global.VF.MAP_TERRAIN || {};
    global.VF.MAP_TERRAIN[mapKey] = raw;
    registry[mapKey] = { raw: raw, live: live };
    return raw;
  }

  /* ------------------------------------------------------------------ *
   * 采样
   *
   * 世界坐标 → 控制网格坐标：gx = x / step。控制点 (gx,gz) 位于世界
   * (gx*step, gz*step)。cells=256 / step=4 覆盖 0..1020，最后 4m 落在网格外 ——
   * 那里是 _buildBedrockShell 的不可破坏边框（且 _terrainCellProtected 也拒绝
   * x<=1 / x>=size-2），所以直接钳到最后一个控制点，不做特殊处理。
   * ------------------------------------------------------------------ */

  /** 双线性采样 h，返回**米**。data 为空或全零时返回 0。 */
  function heightOffsetAt(data, x, z) {
    if (!data) return 0;
    const cells = data.cells;
    const h = data.h;
    const fx = x / data.step;
    const fz = z / data.step;
    let gx0 = Math.floor(fx);
    let gz0 = Math.floor(fz);
    let tx = fx - gx0;
    let tz = fz - gz0;
    if (gx0 < 0) { gx0 = 0; tx = 0; }
    if (gz0 < 0) { gz0 = 0; tz = 0; }
    if (gx0 >= cells - 1) { gx0 = cells - 1; tx = 0; }
    if (gz0 >= cells - 1) { gz0 = cells - 1; tz = 0; }
    const gx1 = gx0 + 1 < cells ? gx0 + 1 : gx0;
    const gz1 = gz0 + 1 < cells ? gz0 + 1 : gz0;
    const r0 = gz0 * cells;
    const r1 = gz1 * cells;
    const a = h[r0 + gx0];
    const b = h[r0 + gx1];
    const c = h[r1 + gx0];
    const d = h[r1 + gx1];
    const top = a + (b - a) * tx;
    const bot = c + (d - c) * tx;
    return (top + (bot - top) * tz) * 0.1;
  }

  /** 最近邻采样。四舍五入到最近控制点，不是向下取整 —— 否则刷出来的色块会 */
  /* 相对圆环偏移半格。 */
  function nearestIndex(data, x, z) {
    const cells = data.cells;
    let gx = Math.round(x / data.step);
    let gz = Math.round(z / data.step);
    if (gx < 0) gx = 0;
    else if (gx > cells - 1) gx = cells - 1;
    if (gz < 0) gz = 0;
    else if (gz > cells - 1) gz = cells - 1;
    return gz * cells + gx;
  }

  /** 表面材质覆盖，返回 VF.BLOCK id，0 = 不覆盖。 */
  function matAt(data, x, z) {
    if (!data) return 0;
    return data.mat[nearestIndex(data, x, z)];
  }

  /** 水域轮廓覆盖，返回 0 继承 / 1 强制水 / 2 强制陆地。 */
  function waterAt(data, x, z) {
    if (!data) return WATER_INHERIT;
    return data.water[nearestIndex(data, x, z)];
  }

  /* ------------------------------------------------------------------ *
   * 编辑器用的写入口
   * ------------------------------------------------------------------ */

  /** 控制点索引，越界返回 -1。 */
  function cellIndex(data, gx, gz) {
    if (!data) return -1;
    const cells = data.cells;
    if (gx < 0 || gz < 0 || gx >= cells || gz >= cells) return -1;
    return gz * cells + gx;
  }

  function clampH(dm) {
    if (dm < H_MIN) return H_MIN;
    if (dm > H_MAX) return H_MAX;
    return Math.round(dm);
  }

  /** 覆盖某层的一片控制点范围（含端点），供"恢复程序原状"之类的整片操作用。 */
  function fillRect(data, layer, gx0, gz0, gx1, gz1, value) {
    const grid = data && data[layer];
    if (!grid) return 0;
    touch(data);
    const cells = data.cells;
    const x0 = Math.max(0, Math.min(cells - 1, gx0));
    const x1 = Math.max(0, Math.min(cells - 1, gx1));
    const z0 = Math.max(0, Math.min(cells - 1, gz0));
    const z1 = Math.max(0, Math.min(cells - 1, gz1));
    let n = 0;
    for (let gz = z0; gz <= z1; gz++) {
      const row = gz * cells;
      for (let gx = x0; gx <= x1; gx++) {
        grid[row + gx] = value;
        n++;
      }
    }
    return n;
  }

  global.VF.MapTerrain = {
    DEFAULT_STEP: DEFAULT_STEP,
    DEFAULT_CELLS: DEFAULT_CELLS,
    H_MIN: H_MIN,
    H_MAX: H_MAX,
    WATER_INHERIT: WATER_INHERIT,
    WATER_FORCE_WET: WATER_FORCE_WET,
    WATER_FORCE_LAND: WATER_FORCE_LAND,

    encode: encode,
    decode: decode,
    blank: blank,
    fromRaw: fromRaw,
    toRaw: toRaw,
    isBlank: isBlank,
    touch: touch,

    get: get,
    reset: reset,
    commit: commit,

    heightOffsetAt: heightOffsetAt,
    matAt: matAt,
    waterAt: waterAt,

    cellIndex: cellIndex,
    clampH: clampH,
    fillRect: fillRect,
  };
})(typeof window !== 'undefined' ? window : globalThis);
