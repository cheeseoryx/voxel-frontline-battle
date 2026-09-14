# 体素战争 · 造化原生迁移工程

**仍在迁移，尚不能 100% 替换原版。** 当前使用造化原生渲染、实体、资源、物理与更新循环，没有套壳运行旧网页。

## 启动

双击 `启动造化预览.cmd`，或执行 `pnpm preview:windows`。新引擎预览地址为 http://localhost:8766/。原版 8765 服务保留，两个端口的浏览器存档独立。

开发基于 `../forgeax-engine` 本地源码。CLI 读取 `.forgeax/engine-binding.json`；类型检查与测试也解析同一本地引擎的官方 facades。Node.js 24、pnpm 11.7.0。后台预览启动器检查端口身份，日志写入 `artifacts/preview/`。

## 当前接入的内容

渲染与物理按造化能力实施，不以旧渲染器逐像素或旧解算逐帧一致为验收条件。玩法完整性仍需逐项验证。

- 首页、模式大厅、装备整备、部署、战场、暂停和返回。
- 六种战场：大征服 32 对 32、核心攻防 25 对 25、团队死斗 12 对 12、爆破 5 对 5、自由混战和枪械模式各 8 人。
- 新战术 AI：分层寻路、动态车辆避让、受阻重规划、视线遮挡、距离/移动命中率、战斗、撤退、占点、攻核与炸弹目标；移动使用造化角色控制器。
- 大征服控制点/兵力/胜负；核心 HP/资源/建造、前哨占领与部署；爆破携带、丢包、安装、拆除、单命回合与换边。
- 吉普、步战车、坦克：驾驶、登乘、座位/武器切换、车载武器、独立装填/备弹/过热、损毁重生与基地补给。
- 六兵种主动技能，原生手雷/C4/动态碎块；原版 93 个声音样本通过造化音频组件播放。
- 核心地图原版 59 项布局、45 栋建筑、两层桥网、6 条可双向通行的原生滑索。
- 原版静态士兵、武器、载具和地图作者数据；导入器可重现并记录源文件哈希。

“接入”不等于整项验收完成。逐项状态以 `docs/migration/replacement-status.json` 为准。

## 验证

```text
pnpm run doctor
pnpm typecheck
pnpm test
pnpm build
pnpm verify:original
pnpm verify:replacement
```

`verify:replacement` 当前预期返回未完成，防止将局部运行结果当作完整替代版。它不随构建成功自动通过。

浏览器脚本需要 Playwright 和本机 Chrome：

- `scripts/check-native-systems.cjs conquest|core|tdm|demo|ffa|gungame`：模式进出、移动、射击与重入。
- `scripts/check-native-interactions.cjs`：载具操作和投掷物。
- `scripts/check-native-skills.cjs`：兵种技能与原生音频状态。
- `scripts/check-native-objectives.cjs conquest|core|demo`：较长时间的目标推进。

默认自动化测试包含隔离进攻 AI 和六条滑索双向通行；设置环境变量 `NATIVE_FULL_CORE=1` 后，核心用例改为完整 50 人目标推进仿真。两种验收范围分别记录。

实际报告与截图在 `artifacts/`。物理/技能/建造测试使用真实 Rapier WASM；渲染旅程使用真实 Chrome WebGPU。未用静态状态代替实战证明。

`pnpm import:original` 重新导入作者数据。旧代码只在离线导入阶段执行；原始文件完整性依据 `docs/migration/source-inventory.json` 检查。

## 完整替换前仍需完成

1. 真实联机房间、浏览服务器、PVP、真人替换 AI 与重连。当前原生预览对局仍在本机运行。
2. 核心攻防完整队伍推进：50 人无玩家干预长测仍未伤到核心，该项未验收通过。以及完整战局、地图随机生成和换图、战斗补给、特殊武器/投掷物、全部被动技能及组合操作。
3. 门、关卡附属物、结构拆分和相关破坏玩法，在新引擎能力上继续实施。
4. 角色关节动画、枪械动作、命中反馈、天气、完整音频空间化及设置。
5. 地图/关卡/塔楼编辑器、装备档案、购买、训练场和全部存档兼容。
6. 最终打包实玩、长时间负载、性能与 Studio 开发验收。

单人搜打撤设计属于后续开发；当前单人入口不能被描述为搜打撤已完成。

开发热重载仍有缓存与资源请求问题，当前采用生产构建与预览。已知引擎问题和本地修复见 `docs/feedback.md`、`docs/migration/engine-source.md`。
