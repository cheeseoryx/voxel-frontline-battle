# 后处理管线基础设施 — 设计文档

日期：2026-09-01

## 背景

项目当前渲染方式是纯手写的 `renderer.render(scene, camera)`（`js/main.js:1345`），没有任何 Composer/后处理层。场景背景是纯色 + 简单 `THREE.Fog`（`js/main.js:201-219`），光照是 1 个 AmbientLight + 2 个 DirectionalLight。项目没有 npm/构建工具，`js/` 下全部是通过 `<script>` 标签加载的全局脚本；`js/vendor/three.gltf.global.js` 是手动打包好的 THREE 核心（不含官方 postprocessing 插件）。

目标是给项目加入天空盒、光照、体积雾、"Post Process Volume"（区域性后处理参数切换）等美术效果。这些效果分属 4 个相对独立的子系统，本轮只做地基：**后处理管线核心基础设施**，天空盒/光照/雾等具体效果留给后续迭代逐个接入。

## 决策记录

- **不引入 Three.js 官方 postprocessing 插件**，完全手写一套轻量 Composer（RenderTarget 双缓冲 + 全屏三角形 + 自定义 ShaderMaterial）。原因：项目无构建流程，引入官方插件需要额外打包步骤并对齐 THREE 版本，手写更符合现有"手动 vendor 全局脚本"的项目习惯，也是用户明确要求的方向。
- **本轮只搭基础设施，不带具体美术效果**。只内置 `CopyPass`（验证管线直通不改变画面）和 `ToneMappingPass`（一个真实可调参数，用来跑通调参面板全链路）。
- **复用现有 `feel-tuner.js` / `feel-config.js` 模式**搭建开发期调参面板，而不是从零设计新的配置系统。
- **预留 `enabled` 降级开关**，因为这是实时多人对抗游戏，需要能在管线层面完全跳过 Composer、零额外开销回退到原始直渲染路径，便于将来给低性能设备关闭后处理。

## 架构

### `js/render-pipeline.js`（新增）

沿用项目现有的 `(function(global){...})(window)` + constructor/prototype 风格（参照 `js/atmosphere.js`），不引入 ES6 class 或模块系统。

- **Composer**
  - 持有两个 `WebGLRenderTarget`（`rtA`/`rtB`），尺寸随 `setSize(w, h)` 联动。
  - 一个模块级共享的全屏三角形 `BufferGeometry` + `OrthographicCamera`，供所有 Pass 复用（避免全屏四边形对角缝的标准做法）。
  - `Composer.prototype.render(scene, camera, dt)` 流程：
    1. 把 `scene`/`camera` 渲染进当前 write RT（替代 main.js 里原来的直接 `renderer.render(scene, camera)`）。
    2. 交换 read/write RT，依次跑所有 `enabled = true` 的 Pass，两个 RT 之间乒乓交换（每个 Pass 读一个、写另一个）。
    3. 最后一个启用的 Pass 输出到屏幕（`renderer.setRenderTarget(null)`）。
    4. 若没有任何效果 Pass 启用，自动退化为一次 `CopyPass` 直出，保证管线本身不引入画面差异。
  - `Composer.prototype.setSize(w, h)`：同步调整两个 RT 尺寸及所有 Pass。
  - 初始化时 `try/catch` 创建 RenderTarget；若失败（极老显卡 / WebGL 上下文异常），自动将 `VF.RenderConfig.enabled` 置为 `false` 并 `console.warn`，回退直渲染，不阻断游戏启动。

- **Pass 接口**（鸭子类型，不强制基类）：
  ```
  {
    enabled: boolean,
    setSize(w, h),
    render(renderer, readBuffer, writeBuffer, dt)
  }
  ```

- **本轮内置 Pass**：
  - `CopyPass`：纯直通 shader，验证接线正确。
  - `ToneMappingPass`：读取 `VF.RenderConfig.toneMapping.exposure`，做曝光调整，作为第一个"真实可调"效果验证调参面板全链路。

### `js/render-config.js`（新增，生产环境保留）

```js
global.VF.RenderConfig = {
  enabled: true,
  toneMapping: { exposure: 1.0 }
};
```

结构与 `js/feel-config.js` 完全一致（顶层挂 `global.VF`，纯数据）。

### `js/render-tuner.js`（新增，开发期专用，可随时整体删除）

- 复刻 `js/feel-tuner.js` 的模式：按键 **F9** 打开面板（F10 已被 feel-tuner 占用）。
- Schema 驱动的滑杆，绑定 `VF.RenderConfig.toneMapping.exposure`。
- 草稿存 `localStorage('vf_render_draft_v1')`，仅在本脚本加载时读取。
- "导出" 按钮下载覆盖后的 `render-config.js` 内容，人工替换仓库文件后提交——与 feel-tuner 的"调完导出 → 替换文件 → 提交"工作流一致。
- 文件头注释注明"生产环境删除本文件 + index.html 对应 `<script>`，保留 render-config.js"，与 feel-tuner.js 文件头注释一致。

## 集成点：`js/main.js`

- 渲染器/场景创建之后（约第 200 行区域）：
  ```js
  game.pipeline = VF.createRenderPipeline(renderer, scene, camera);
  ```
- `animate()` 内第 1345 行：
  ```js
  if (VF.RenderConfig.enabled && game.pipeline) {
    game.pipeline.render(game.scene, game.camera, dt);
  } else {
    game.renderer.render(game.scene, game.camera);
  }
  ```
- 两处 resize 处理（约 191、1123 行）追加：
  ```js
  game.pipeline && game.pipeline.setSize(window.innerWidth, window.innerHeight);
  ```

## `index.html` 加载顺序

- `render-config.js`、`render-pipeline.js` 加载在 `main.js` 之前（`main.js` 初始化时需要用到它们）。
- `render-tuner.js` 加载在 `main.js` 之后，位置紧邻现有 `feel-tuner.js`。

## 错误处理

- Composer 构造失败 → 捕获异常，`VF.RenderConfig.enabled = false`，`console.warn`，游戏继续用直渲染路径运行，不抛出未捕获异常。
- Pass 内部 shader 编译失败：暂不特殊处理（本轮两个 Pass 均为极简 shader，风险低），留给后续迭代按需加固。

## 验收方式（手动验证，项目无自动化测试框架）

1. 管线开启、`exposure = 1.0` 时画面应与管线关闭时逐像素几乎一致（Copy + ToneMapping 恒等变换）。
2. 按 F9 打开调参面板，调整 exposure 能实时看到画面变亮/变暗。
3. 触发一次浏览器窗口 resize，确认不花屏、不报错、不产生渐进式内存泄漏（RT 未被正确释放）。
4. 将 `VF.RenderConfig.enabled` 设为 `false`，确认完全回退到原始直渲染路径，画面与改动前完全一致。
5. 在正常游玩场景下（有士兵、建筑、特效同时渲染）观察帧率，确认管线开启后没有明显掉帧。

## 范围之外（后续迭代）

- 天空盒（HDRI/Sky shader）
- 光照系统重构（IBL、阴影）
- 体积雾（深度缓冲驱动的 screen-space 体积雾 Pass）
- Post Process Volume（区域性后处理参数混合/切换机制）

以上均作为独立子项目，在本地基完成后逐个走 brainstorming → 设计 → 实现 流程。
