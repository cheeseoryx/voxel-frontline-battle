/**
 * island-conquest-props.js — 荒盆的摆件与预制体布局。
 *
 * 由游戏内关卡编辑器（js/level-editor.js，F8）写入，勿手改。坐标为归一化
 * 0..1（nx/nz × worldSize），世界尺寸变了不用重摆。
 *
 * MAP_PROPS    烘焙的 .vox 摆件（VF.PROPS 里的 id）
 * MAP_PREFABS  程序化预制体（world.stampEditorPrefab 的 kind）
 *
 * yaw ∈ {0, 90, 180, 270}（体素网格只能 90° 旋转）。
 */
(function (g) {
  'use strict';
  g.VF = g.VF || {};
  g.VF.MAP_PROPS = g.VF.MAP_PROPS || {};
  g.VF.MAP_PREFABS = g.VF.MAP_PREFABS || {};
  g.VF.MAP_PROPS["island-conquest"] = [
    { id: "hotel", nx: 0.4717, nz: 0.1445, yaw: 0 },
    { id: "house", nx: 0.3496, nz: 0.1631, yaw: 0 },
  ];
  g.VF.MAP_PREFABS["island-conquest"] = [
  ];
})(typeof window !== "undefined" ? window : globalThis);
