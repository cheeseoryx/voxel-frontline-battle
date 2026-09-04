/**
 * island-conquest-terrain.js — 荒盆的地形覆盖层。
 *
 * 由游戏内关卡编辑器（js/level-editor.js，F8）写入，勿手改。
 *
 * 这里存的是**在程序地形之上的偏移量**，不是完整地形。地形本体是
 * js/maps/island-conquest.js heightAtMeters() 的闭式解；这一层只记编辑器改动
 * 过的地方。采样和编解码全在 js/maps/map-terrain.js。
 *
 *   step   控制点间距（米）
 *   cells  控制网格边长（cells × step 应覆盖 worldSize）
 *   h      高度偏移 RLE，单位分米（10cm），行主序，双线性插值
 *   mat    表面材质覆盖 RLE，VF.BLOCK id，0 = 不覆盖，最近邻
 *   water  轮廓覆盖 RLE，0 继承 / 1 强制水 / 2 强制陆地，最近邻
 *
 * RLE 格式：[值, 连续个数, ...]。全零的一层就是 [0, cells*cells] 两个数字。
 */
(function (g) {
  'use strict';
  g.VF = g.VF || {};
  g.VF.MAP_TERRAIN = g.VF.MAP_TERRAIN || {};
  g.VF.MAP_TERRAIN["island-conquest"] = {
    step: 4,
    cells: 256,
    h: [0, 65536],
    mat: [0, 65536],
    water: [0, 65536],
  };
})(typeof window !== "undefined" ? window : globalThis);
