# 体素战争 · ForgeaX 迁移工程

**状态：原生迁移进行中，尚未完成整款游戏迁移。** 这里已经能够使用 ForgeaX 渲染原版兵种，显示原版首页、模式大厅与服务器浏览界面。模式开局、装备交互、战斗和联机尚未移植，不能替代仓库根目录的可玩版本。

## 工程位置

- 本目录是造化工程根目录，包含 forge.json、package.json、assets 和 Engine skills。
- 原游戏保留在上一级 F:/voxel-frontline-battle。原启动游戏.cmd 与 8765 服务保持原样。
- SDK 基线为 0.1.28。目前通过官方本地绑定使用上一级 forgeax-engine 源码及编译产物。公开源码包版本显示为 0.0.0，不表示游戏已回退到其他 SDK。Node >=22.13.0，pnpm >=11.7.0 <12。
- 造化工程入口为本目录 forge.json。已验证 CLI 构建与静态预览；Studio 导入与编辑器操作尚未验证。

## 已验证范围

- 原版首页；首次进入停留在首页。
- 首页 → 模式大厅 → 浏览服务器 → 返回大厅 → 返回首页。服务器列表目前是界面接入，不代表发现或加入房间已完成。
- 双方阵营共 8 个原版兵种的静态网格、原版零件颜色材质槽与稳定 GUID 资产链。动画、武器切换和角色碰撞尚待迁移。
- 现有 UI 的原始背景、字体与图标成为 UI 伴随资源。行内样式转为样式表；展示标签按 Engine UI 规范转换。动态 Canvas/SVG 面板仍需各功能的 native owner 接入。
- TypeScript、UI authoring 校验、原生资源构建，以及 HTTP 预览中超过 300 个真实 Engine 渲染帧；没有页面、控制台或资源请求错误。此证据只覆盖静态角色和基础导航，不是战斗负载或 HTTPS 发布验收。

## 开发与验证

在本目录终端运行：

```text
pnpm install --frozen-lockfile
pnpm engine:check
pnpm typecheck
pnpm test
pnpm build
pnpm preview
```

构建脚本为 production 显式设置 NODE_ENV，避免 SDK 开发 host WebSocket 混入静态构建。开发服务命令是 pnpm dev，但当前仅首次就绪通过：实际热重载出现 504 依赖缓存失效和 UI 图标 404，尚未通过验收。现阶段使用 pnpm build 后 pnpm preview 的手动编译流程。Windows 上如 SDK 的内置 Chromium 无法启动，可设置 FORGEAX_BROWSER_EXECUTABLE 为本机 Chrome 路径；本项目工具入口会在该路径存在时采用它。

## 本地引擎与环境恢复

当前机器已安装并编译。复制工程到新位置后，需要保留同级 forgeax-engine，并依次运行：

```text
pnpm --dir ../forgeax-engine install --frozen-lockfile
pnpm engine:build
pnpm engine:local
pnpm engine:check
```

本地绑定由官方命令写入 .forgeax；不要手写状态文件。工具脚本按这份绑定选择相应的官方 CLI。修复清单及 SDK 基线见 docs/migration/engine-source.md。

## 作者资源

- assets/identity.ts：本工程新分配的包身份和 GUID 派生。
- assets/soldiers.pack.ts：原版静态兵种网格与材质。
- assets/scene.pack.ts：原生部署验证场景。
- assets/ui/frontline.ui.html / .ui.css：原版 UI 的可读作者源。
- assets/ui/ui.plugin.ts：当前已接通的导航与清理生命周期。
- scripts/import-original-models.cjs / import-original-ui.cjs：从上级原项目重新提取源内容；这些工具只在迁移时运行，玩家运行时不加载 Three.js。

不要把尚未完成的按钮补成旧网页跳转或 iframe。继续迁移时按 docs/migration/README.md 的清单接入各功能；原始文件 SHA-256 清单记录在 source-inventory.json，保留原版模型与 UI 比对依据。

## 尚未完成

大征服、五种小型模式、单人入口现有功能；装备档案与部署完整流程；玩家移动/射击/技能；AI；载具；体素破坏与碰撞；建造和地图编辑器；音频；房间发现、加入、PVP 同步与退出清理。单局搜打撤目前仅有设计文档，不计为已实现内容。

已知 SDK 接入问题与修复证据见 docs/feedback.md。
