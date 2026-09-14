# 体素战争：造化原生迁移记录

状态：迁移进行中。创建成功不代表完整移植完成；旧版依旧位于仓库根目录。

## 能力采用计划

Need: 保留首页、模式大厅、装备档案、团队部署和战斗内 UI。
Use: Engine UI + Host plugin，复用原始 HTML/CSS 和背景资源。
Entry: forgeax-engine-app、forgeax-engine-assets、engine-ui README。
Proof: 初次首页、模式导航、各分辨率截图及往返流程。
Defer: 重做美术与新增模式。

Need: 原版体素角色、地图、载具与武器进入原生渲染链。
Use: ScriptablePack、GUID catalog、ECS Scene、程序网格、Standard material。
Entry: forgeax-engine-assets、engine-geometry、engine-render。
Proof: asset verify、类型检查、原版资产比对、真实 Engine 帧和浏览器截图。
Defer: 新角色、新背景、超出现有表现的画质升级。

Need: 保持现有射击、碰撞、AI、破坏、建造、大小模式及网络房间规则。
Use: ECS Update/FixedUpdate、输入、物理、音频与网络 owner plugin。
Entry: forgeax-engine-ecs、physics、audio、net 文档。
Proof: 逐模式实玩与两端联机，破坏后碰撞一致、退出重进无残留。
Defer: 仅存在策划文档的单人搜打撤；不把该功能算作已实现。

## Template Disposition

- Runtime/controller code: ADAPT — 复用插件与生命周期契约；改为本项目第一人称和原有模式规则。
- Player character and animation: REPLACE — 使用原版 Soldier 几何与姿态；不采用模板人物。
- Scene entities and composition: REPLACE — 使用原游戏地图和部署构图。
- Meshes and materials: REPLACE — 原始体素与装备资源转换，保留颜色和形状。
- Lighting and environment: ADAPT — 原版天空/灯光参数转换到造化。
- UI and copy: REPLACE — 复用现有排版、文案、背景。
- Template tests: REWRITE — 按模式、输入、资源和生命周期实际验收。
- Residual template identifiers allowed at delivery: none（SDK skills 内示例除外）。

## 迁移验收

- [x] SDK 环境预检；官方 game-3d 工程创建。
- [x] 原始代码与资源 SHA-256 清点（source-inventory.json）。
- [ ] 原始内容进入 GUID 资产链，模板可见内容彻底替换。
- [ ] 首页→模式→装备→部署→开局→退出的完整原生流程。
- [ ] 大征服、TDM、爆破、自由混战、枪械模式、核心攻防规则。
- [ ] 单人入口按当前实现迁移，不冒充尚未开发的搜打撤。
- [ ] 角色、枪械、载具、AI、体素破坏、建造与编辑器。
- [ ] 浏览服务器、创建/加入、PVP、AI 填充及断线清理。
- [ ] 类型/测试/资源校验/构建/最终包实玩；至少 300 帧和错误统计。
- [ ] Studio 打开及后续开发启动说明；通过前不替换原启动入口。

## 当前已交付的局部迁移

本地 Engine 62 包编译与绑定、原首页/模式/浏览服务器界面的导航、8 个原版静态兵种的 GUID 资源及材质颜色。类型、3 项游戏数据测试和 300 帧静态浏览器验证通过。服务器浏览目前仅接入界面。完整玩法、装备交互、部署开局、网络功能均不能计为完成。开发热重载仍有缓存/资源错误，详见 engine-source.md。
