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

## 2026-09-14 原生迁移进展

- 原规则与经济转换、20 个预览角色 + 4 个 AI 角色、94 个枪械、手臂及检查视图作者资源。
- 原荒盆数据与三个原小型竞技场固定种子样本。
- World.Update 管理第一人称控制、碰撞、射击、换弹、方块命中和对局时钟。
- 团队死斗、自由混战、枪械模式接入原版计分/进阶、AI、出生算法；角色位置直接读写原生 ECS Transform，无第二棵场景树。
- 原 UI 装备选择、兵种切换、装备检查、部署倒计时和返回流程。
- 原始 290 个文件完整性验证；具体测试及浏览器证据见 artifacts/native-*。

## 当前迁移局限

完整替换验收仍未通过。明确缺口逐项保存在 replacement-status.json；运行 pnpm verify:replacement 会以非零退出码列出。当前三种小型模式虽然已可开局，仍缺原版全部武器行为、技能、视听表现、随机地图和联机，不能单独据此勾选完整模式验收。大征服目前只接通地图与基本第一人称交互。

规则导入器保留原算法；原 UI/音频/材质等宿主依赖由各 native owner 接管，不能用空实现宣称迁移完成。模型静态合并尚无关节动画，原 AI 的死亡表现被原生粒子代替，视觉一致性尚待完成。
