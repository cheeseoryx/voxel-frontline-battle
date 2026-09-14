# 原版 → 造化版：剩余功能审计

日期：2026-09-14。结论：当前仍不能完整替换原版。

对照原版模块和原生实际接线；引用 2026-09-14 已有测试报告；本轮仅重新执行原版 290 文件完整性检查，未重新进行整套实机测试。

## 对照范围与读法

原版：F:/voxel-frontline-battle/index.html 与 modes/small-battle 的现存原版源码。新版：F:/voxel-frontline-battle/forgeax 的当前原生运行入口。

- **未接入**：原版有实现或有效路径，当前原生运行入口未接通。
- **部分实现**：已有可用子集，但行为、操作或界面链路尚不完整。
- **验收失败**：已有明确失败证据，需要修复并重测。
- **未验收**：代码或部分证据存在，未证明完整场景可用；不等同于没有功能。

本次拆分为 **36 条审计项**：未接入 8 条；部分实现 23 条；验收失败 1 条；未验收 4 条。粒度不同，不能据此计算完成百分比。

- **P0**：影响替换成立、核心可玩性或后续主工程开发。
- **P1**：原版保留功能的必要迁移项。
- **P2**：在主玩法闭环后补齐的表现与体验项。

## 已有可用基础

- 首页、模式选择、装备整备、部署、进入/退出六种基础模式。
- 原生渲染、Rapier 碰撞/角色移动、基础体素破坏、手雷和动态碎块。
- 新 AI 寻路与射击、基本占点/核心/爆破/死斗/混战/枪械规则；不代表全部整局验证通过。
- 三类载具及基础驾驶/座位/武器/装填/补给，六小型兵种技能激活，93 份音效资产。

## 先处理的阻断项

- [NET-01] 服务器浏览、创建/加入房间与快速匹配（未接入）：接通服务器列表刷新、选房加入、按模式查房/建房、房间参数和错误反馈。保持“选模式→装备整备→直接开局”，不增加准备房。
- [NET-02] 真人 PVP、AI 席位替换与房间生命周期（未接入）：同步玩家、射击伤害、破坏、建造、载具、目标和比分；接通真人替换 AI、退出补位、断线恢复与主客端状态处理。
- [EQ-01] 装备整备与战场道具槽实际对应（部分实现）：将各槽位的已选道具传入战斗，接通部署、数量、补给、切换和交互，避免界面选择与实战不一致。
- [EQ-04] 武器机制：散布、霰弹、后坐力与发射物（部分实现）：按武器接回霰弹多弹丸、射击散布、后坐力、发射器弹道/爆炸与相应命中结算；以新引擎承担表现和碰撞。
- [TEAM-01] 倒地、流血、求救、拖拽与救援（未接入）：接通完整救援生命周期、玩家与 AI 救援交互、救援保护与兵力扣除时机。
- [AI-02] 核心攻防满员 AI 目标推进（验收失败）：修复满员环境中的进攻路径、交火停滞、目标优先级和攻防协作，重新进行完整人数测试。
- [DEV-01] Studio 开发流程与热更新稳定性（未验收）：验证 Studio 打开、编辑场景/资源、预览、保存、重启、重新构建，并处理开发态资源问题。
- [DEV-02] 完整替换包、性能与长时间稳定（未验收）：从最终打包产物验收全部模式/菜单、多人同步、持续破坏、人数与载具满载、进出循环、内存和帧时间。

## 联机与房间

### NET-01 服务器浏览、创建/加入房间与快速匹配

- [ ] **P0 · 未接入**
- 原版：原版有房间发现、创建、加入，以及房主直接开局、玩家中途加入的路径。原网络以本机通信与可选 PeerJS 为基础。
- 新版现状：新版服务器页能打开；模式按钮直接创建本地战场，没有连接房间。
- 仍需补齐：接通服务器列表刷新、选房加入、按模式查房/建房、房间参数和错误反馈。保持“选模式→装备整备→直接开局”，不增加准备房。
- 完成判据：两个独立客户端能发现并进入同一房间，模式和地图一致；无人房按原规则由 AI 填充。
- 证据：[js/pvp.js:1](F:/voxel-frontline-battle/js/pvp.js:1)；[js/pvp.js:545](F:/voxel-frontline-battle/js/pvp.js:545)；[forgeax/assets/ui/ui.plugin.ts:114](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:114)；[forgeax/assets/gameplay/native-arena.ts:36](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:36)

### NET-02 真人 PVP、AI 席位替换与房间生命周期

- [ ] **P0 · 未接入**
- 原版：原版存在真人房间、共享战场同步及进退房逻辑。
- 新版现状：当前六种模式中的其他角色均由本机 AI 驱动；64 人战场不代表支持 64 名联机玩家。
- 仍需补齐：同步玩家、射击伤害、破坏、建造、载具、目标和比分；接通真人替换 AI、退出补位、断线恢复与主客端状态处理。
- 完成判据：双端完成交火、破坏、上下车、目标交互、退房重进；按原房间人数上限验收，另行定义是否扩容。
- 证据：[js/pvp.js:1](F:/voxel-frontline-battle/js/pvp.js:1)；[js/net-protocol.js:1](F:/voxel-frontline-battle/js/net-protocol.js:1)；[js/net-simulation.js:1](F:/voxel-frontline-battle/js/net-simulation.js:1)；[modes/small-battle/js/sd-net.js:1](F:/voxel-frontline-battle/modes/small-battle/js/sd-net.js:1)；[forgeax/assets/gameplay/native-arena.ts:36](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:36)

## 装备与射击

### EQ-01 装备整备与战场道具槽实际对应

- [ ] **P0 · 部分实现**
- 原版：原版支持主副武器、两格道具、投掷物、近战装备；急救箱、弹药箱、RPG、望远镜有实际用途。
- 新版现状：新版可选择装备，但战场 equipment 只保存主副武器；3 键固定回血，Q 固定手雷。
- 仍需补齐：将各槽位的已选道具传入战斗，接通部署、数量、补给、切换和交互，避免界面选择与实战不一致。
- 完成判据：逐项更换整备装备后入场，验证使用的物品、数量、效果和冷却均对应选择。
- 证据：[js/gadgets.js:34](F:/voxel-frontline-battle/js/gadgets.js:34)；[forgeax/assets/gameplay/battle.plugin.ts:70](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:70)；[forgeax/assets/gameplay/battle.plugin.ts:84](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:84)

### EQ-02 完整投掷物种类与作用

- [ ] **P1 · 部分实现**
- 原版：大征服可选破片、闪光、烟雾；小型战斗还包括黏性炸弹、燃烧瓶、震撼弹。
- 新版现状：已接通原生物理手雷和爆炸碎块；通用投掷接口只有普通/大威力两种定时爆炸。
- 仍需补齐：补齐闪光致盲、烟雾遮挡、持续燃烧、震撼、黏附与对应 AI 感知影响；按各模式原可选列表开放。
- 完成判据：每一种投掷物均从整备选择进入实战，效果、持续时间、数量消耗、友伤规则和音画反馈可验证。
- 证据：[js/throwables.js:15](F:/voxel-frontline-battle/js/throwables.js:15)；[modes/small-battle/js/throwables.js:15](F:/voxel-frontline-battle/modes/small-battle/js/throwables.js:15)；[forgeax/assets/gameplay/native-ordnance.ts:11](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-ordnance.ts:11)

### EQ-03 C4 的黏附与大征服遥控引爆

- [ ] **P1 · 部分实现**
- 原版：大征服道具 C4 支持贴墙/地面、遥控引爆；小型战斗先锋 C4 有自己的定时规则。
- 新版现状：新版 C4 使用 throwGrenade(true)，固定 2.2 秒后爆炸，无黏附和大征服遥控操作。
- 仍需补齐：按两个原模式分别接回引爆规则；补齐黏附、存量、投掷提示和可销毁对象。
- 完成判据：大征服 C4 可贴墙并由玩家主动引爆；小型战斗 C4 按原先锋规则触发，不能混用两套规则。
- 证据：[js/gadgets.js:44](F:/voxel-frontline-battle/js/gadgets.js:44)；[js/gadgets.js:1495](F:/voxel-frontline-battle/js/gadgets.js:1495)；[modes/small-battle/js/skills.js:9](F:/voxel-frontline-battle/modes/small-battle/js/skills.js:9)；[forgeax/assets/gameplay/native-ordnance.ts:11](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-ordnance.ts:11)

### EQ-04 武器机制：散布、霰弹、后坐力与发射物

- [ ] **P0 · 部分实现**
- 原版：原版武器定义及射击过程区分弹丸数、散布、后坐力、自动/半自动和发射器。
- 新版现状：新版已接入武器数据、模型、伤害、射速、弹量和换弹；开火统一使用准星方向的一条射线。
- 仍需补齐：按武器接回霰弹多弹丸、射击散布、后坐力、发射器弹道/爆炸与相应命中结算；以新引擎承担表现和碰撞。
- 完成判据：代表性步枪、手枪、霰弹枪、狙击枪和发射器的实际伤害形态与设计一致，不能只验证能扣弹和命中。
- 证据：[js/weapons.js:64](F:/voxel-frontline-battle/js/weapons.js:64)；[js/weapons.js:212](F:/voxel-frontline-battle/js/weapons.js:212)；[js/weapons.js:298](F:/voxel-frontline-battle/js/weapons.js:298)；[forgeax/assets/gameplay/battle.plugin.ts:102](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:102)

### EQ-05 近战攻击与局内检视

- [ ] **P1 · 未接入**
- 原版：原版有战斗刀挥砍、背刺/近战判定和小型战斗武器检视。
- 新版现状：新版装备检视模型已存在；战斗输入未接入独立近战和局内检视操作。
- 仍需补齐：恢复近战切换、挥砍范围、背刺/伤害规则、持刀速度，以及局内武器检视。
- 完成判据：能够从整备选择近战装备并在场内击中目标；检视可进入、退出且不影响射击状态。
- 证据：[js/melee.js:1](F:/voxel-frontline-battle/js/melee.js:1)；[js/gadgets.js:1398](F:/voxel-frontline-battle/js/gadgets.js:1398)；[modes/small-battle/js/weapon-inspect.js:1](F:/voxel-frontline-battle/modes/small-battle/js/weapon-inspect.js:1)；[forgeax/assets/gameplay/battle.plugin.ts:84](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:84)

### EQ-06 兵种差异、主动/被动技能和移动动作

- [ ] **P1 · 部分实现**
- 原版：原版大征服兵种配合道具与团队系统；小型战斗有六兵种技能及冲刺等动作。
- 新版现状：新版六个小型兵种均能触发技能，但部分被动/效果为简化实现；大征服 G 键分支直接投手雷。
- 仍需补齐：逐兵种核对技能完整作用、被动、资源/冷却；补齐原动作中的冲刺、滑铲和实际蹲姿，接回大征服职业作用。
- 完成判据：每个兵种执行一组实战场景，检查对自己、友军、敌军、载具和地形的实际影响；激活成功不等于效果等价。
- 证据：[modes/small-battle/js/skills.js:31](F:/voxel-frontline-battle/modes/small-battle/js/skills.js:31)；[modes/small-battle/js/skills.js:1228](F:/voxel-frontline-battle/modes/small-battle/js/skills.js:1228)；[js/player.js:1](F:/voxel-frontline-battle/js/player.js:1)；[forgeax/assets/gameplay/native-skills.ts:14](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-skills.ts:14)；[forgeax/assets/gameplay/battle.plugin.ts:84](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:84)

## 团队作战与 AI

### TEAM-01 倒地、流血、求救、拖拽与救援

- [ ] **P0 · 未接入**
- 原版：原版大征服有玩家/AI 倒地、流血倒计时、求救、拖拽、复活和放弃救援。
- 新版现状：新版生命归零后直接进入死亡和自动重生，没有倒地状态。
- 仍需补齐：接通完整救援生命周期、玩家与 AI 救援交互、救援保护与兵力扣除时机。
- 完成判据：大征服玩家和 AI 均可被救起；拖拽、超时死亡、主动放弃、救援取消、票数结算均正确。
- 证据：[js/revive.js:115](F:/voxel-frontline-battle/js/revive.js:115)；[js/revive.js:262](F:/voxel-frontline-battle/js/revive.js:262)；[js/main.js:2502](F:/voxel-frontline-battle/js/main.js:2502)；[forgeax/assets/gameplay/native-arena.ts:71](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:71)

### TEAM-02 真实小队管理与队长指令

- [ ] **P1 · 未接入**
- 原版：原版支持加入/退出小队、锁队、队长转移、目标命令及命令完成判定。
- 新版现状：新版部署四人卡片属于展示，战场没有对应的小队管理系统。
- 仍需补齐：接回小队成员关系、队长/锁队操作、占领/防守命令、队员状态与命令反馈。
- 完成判据：部署显示与战场实际小队一致；改变成员/队长后，命令权限和 AI 执行目标同步更新。
- 证据：[js/squads.js:125](F:/voxel-frontline-battle/js/squads.js:125)；[js/squads.js:199](F:/voxel-frontline-battle/js/squads.js:199)；[js/main.js:2503](F:/voxel-frontline-battle/js/main.js:2503)；[forgeax/assets/ui/ui.plugin.ts:58](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:58)

### TEAM-03 死亡后部署选择

- [ ] **P1 · 部分实现**
- 原版：原版提供部署地图和出生点选择，并结合阵营、已占点及小队等条件。
- 新版现状：新版可在控制点/前哨附近自动出生，但玩家没有完整的选择部署流程。
- 仍需补齐：恢复可选部署地点、可用条件、禁止出生状态、部署确认与阵营相关限制。
- 完成判据：死亡后能选择合法出生点；争夺、失守和占用状态更新后不能进入无效位置。
- 证据：[js/ui.js:138](F:/voxel-frontline-battle/js/ui.js:138)；[js/conquest.js:1009](F:/voxel-frontline-battle/js/conquest.js:1009)；[forgeax/assets/gameplay/native-arena.ts:56](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:56)；[forgeax/assets/gameplay/native-arena.ts:102](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:102)

### TEAM-04 战术标记与团队贡献计分

- [ ] **P1 · 未接入**
- 原版：原版有敌人/地点标记、队长目标通报，以及助攻、救援、治疗、补弹、侦察、命令、摧毁载具等计分。
- 新版现状：新版有击杀提示和基础比分，但没有接入原 Comms/Scoring 的完整事件体系。
- 仍需补齐：恢复标记与通报、贡献分归属、去重/冷却、勋带和团队/个人统计。
- 完成判据：同一动作只计分一次；救援、补给、侦察、占领等行为能在 HUD 和结算中准确追溯。
- 证据：[js/comms.js:64](F:/voxel-frontline-battle/js/comms.js:64)；[js/scoring.js:7](F:/voxel-frontline-battle/js/scoring.js:7)；[forgeax/assets/gameplay/objective-rules.ts:13](F:/voxel-frontline-battle/forgeax/assets/gameplay/objective-rules.ts:13)；[forgeax/assets/ui/ui.plugin.ts:144](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:144)

### AI-01 AI 兵种分工、支援与乘员协作

- [ ] **P1 · 部分实现**
- 原版：原版 AI 与小队、救援、兵种和载具系统存在联动。
- 新版现状：新版已有寻路、避障、视线、射击、撤退、目标选择和核心地图跳跃/滑索；普通 AI 单位仍以统一步兵配置为主。
- 仍需补齐：为新 AI 接回不同装备和职责、救援/补给、队长命令、载具乘员协作；继续改进跨地形路径。
- 完成判据：在满员实战中观察到明确的职业支援和目标协作，不能只让所有 AI 以相同武器互射。
- 证据：[js/ai.js:2396](F:/voxel-frontline-battle/js/ai.js:2396)；[js/ai.js:2603](F:/voxel-frontline-battle/js/ai.js:2603)；[js/main.js:2409](F:/voxel-frontline-battle/js/main.js:2409)；[forgeax/assets/gameplay/native-arena.ts:65](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:65)

### AI-02 核心攻防满员 AI 目标推进

- [ ] **P0 · 验收失败**
- 原版：核心攻防的主要目标是攻击并摧毁敌方核心。
- 新版现状：隔离单个进攻 AI 可以摧毁核心；完整 50 人仿真在 360 秒模拟时间内未伤到核心，浏览器推进测试也失败。
- 仍需补齐：修复满员环境中的进攻路径、交火停滞、目标优先级和攻防协作，重新进行完整人数测试。
- 完成判据：满员 AI 能持续推进并实际伤到核心；同时验证可达的胜负结束流程。360 秒是当前测试门槛，不代表原版保证六分钟结束。
- 证据：[forgeax/docs/migration/validation-2026-09-14.json:1](F:/voxel-frontline-battle/forgeax/docs/migration/validation-2026-09-14.json:1)；[forgeax/artifacts/native-core-full-simulation.log:1](F:/voxel-frontline-battle/forgeax/artifacts/native-core-full-simulation.log:1)；[forgeax/assets/gameplay/native-arena.ts:86](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:86)

## 模式完整性

### MODE-01 大征服规则与点位对应

- [ ] **P1 · 部分实现**
- 原版：原版有地图控制点配置、兵力消耗、团队贡献分、救援和补给联动。
- 新版现状：新版有六点占领、争夺、兵力和胜负；六个点按两基地插值生成，个人击杀加 25 分，与原计分 100 分不同。
- 仍需补齐：核对原地图点位和模式参数，恢复各系统联动；玩法数值如需改动应明确作为设计变更。
- 完成判据：以原规则案例验证点位、占领、票数和计分；在 64 人场景完成一局并正确退出、再开局。
- 证据：[js/conquest.js:252](F:/voxel-frontline-battle/js/conquest.js:252)；[js/scoring.js:7](F:/voxel-frontline-battle/js/scoring.js:7)；[forgeax/assets/gameplay/native-arena.ts:39](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:39)；[forgeax/assets/gameplay/objective-rules.ts:13](F:/voxel-frontline-battle/forgeax/assets/gameplay/objective-rules.ts:13)

### MODE-02 核心攻防建造交互

- [ ] **P1 · 部分实现**
- 原版：原版有建造预览、旋转、掩体和塔楼设计联动。
- 新版现状：新版已恢复默认地图、前哨、滑索、资源、掩体和防御塔；当前使用固定塔蓝图，没有可视化放置预览。
- 仍需补齐：接回合法/非法放置预览、自定义塔方案、相关入口和建筑附属交互。
- 完成判据：玩家可预览并旋转建筑；保存的自定义蓝图能带入对局，资源扣除和失败回退正确。
- 证据：[js/building.js:55](F:/voxel-frontline-battle/js/building.js:55)；[js/tower-designer.js:1](F:/voxel-frontline-battle/js/tower-designer.js:1)；[forgeax/assets/gameplay/native-building.ts:4](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-building.ts:4)

### MODE-03 团队死斗与自由混战整局循环

- [ ] **P1 · 未验收**
- 原版：原版有模式计分、胜负、复活和结果页。
- 新版现状：新版导入原计分规则并接入 AI；已通过进入、移动、开火、退出和重进的短流程。
- 仍需补齐：补做分数达到上限、时间结束、平局/排名、死亡复活、结算再开局，以及满员长时实战验证。
- 完成判据：两个模式均从首页完整游玩至结算后再次开局；通过所有条件后才能标记完整。
- 证据：[modes/small-battle/js/tdm-match.js:1](F:/voxel-frontline-battle/modes/small-battle/js/tdm-match.js:1)；[modes/small-battle/js/ffa-match.js:1](F:/voxel-frontline-battle/modes/small-battle/js/ffa-match.js:1)；[forgeax/assets/gameplay/native-arena.ts:43](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:43)；[forgeax/docs/migration/validation-2026-09-14.json:1](F:/voxel-frontline-battle/forgeax/docs/migration/validation-2026-09-14.json:1)

### MODE-04 爆破整场多回合

- [ ] **P1 · 未验收**
- 原版：原版有携带、丢弃、拾取、安拆炸弹、单命回合、换边和整场胜负。
- 新版现状：新版已接入炸弹和回合规则；浏览器证据证明过一回合，完整 BO13 未完成实测。
- 仍需补齐：补做完整多回合、半场换边、不同炸弹结局和整场结束；模式专属统计/UI 另列为未接通项。
- 完成判据：真实浏览器完成至先得 7 分，并覆盖攻守换边、安拆/爆炸/歼灭及下一场状态清理。
- 证据：[modes/small-battle/js/sd-match.js:1](F:/voxel-frontline-battle/modes/small-battle/js/sd-match.js:1)；[modes/small-battle/js/sd-bomb.js:1](F:/voxel-frontline-battle/modes/small-battle/js/sd-bomb.js:1)；[forgeax/assets/gameplay/native-arena.ts:42](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:42)；[forgeax/docs/migration/validation-2026-09-14.json:1](F:/voxel-frontline-battle/forgeax/docs/migration/validation-2026-09-14.json:1)

### MODE-05 枪械模式完整晋级与特殊击杀规则

- [ ] **P1 · 部分实现**
- 原版：原版有武器序列晋级、最终级胜利和降级等特殊规则。
- 新版现状：新版已导入原晋级规则；整条序列未实战跑通，近战/特殊武器操作不完整会影响规则可达性。
- 仍需补齐：补齐对应攻击操作，验证有效武器击杀、降级、最终级胜利和再次开局。
- 完成判据：从第一把武器实战晋级到胜利；覆盖无效武器击杀、近战/自杀等原已启用的特殊规则。
- 证据：[modes/small-battle/js/gg-match.js:302](F:/voxel-frontline-battle/modes/small-battle/js/gg-match.js:302)；[modes/small-battle/js/gg-match.js:399](F:/voxel-frontline-battle/modes/small-battle/js/gg-match.js:399)；[forgeax/assets/gameplay/battle.plugin.ts:84](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:84)；[forgeax/assets/gameplay/native-arena.ts:43](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:43)

### MODE-06 TDM 连杀空袭与战场飞机事件

- [ ] **P1 · 部分实现**
- 原版：原版 TDM 每连续 5 次击杀可调用空袭；原战场事件系统有飞机、导弹和阵营伤害。
- 新版现状：新版保留计分模块中的调用，但 game 对象没有 battlefieldEvents 实例，所以空袭不会产生。
- 仍需补齐：用新引擎接入飞机/空袭事件、伤害归属、反制、触发与场景清理。
- 完成判据：达到连杀阈值会出现一次真实空袭，能对目标造成正确伤害；环境击杀不得循环召唤空袭。
- 证据：[modes/small-battle/js/tdm-match.js:280](F:/voxel-frontline-battle/modes/small-battle/js/tdm-match.js:280)；[modes/small-battle/js/battlefield-events.js:748](F:/voxel-frontline-battle/modes/small-battle/js/battlefield-events.js:748)；[modes/small-battle/js/main.js:273](F:/voxel-frontline-battle/modes/small-battle/js/main.js:273)；[forgeax/assets/gameplay/native-arena.ts:36](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:36)

## 单人与训练

### SOLO-01 训练场与试枪流程

- [ ] **P1 · 未接入**
- 原版：原版主界面/大厅具有独立训练场入口，支持武器试用和返回。
- 新版现状：新版 tutorial 只是说明弹层；没有创建 Range 训练场。
- 仍需补齐：接回靶场场景、试枪、命中反馈、装备切换和进出流程。
- 完成判据：从大厅进入训练场使用代表性装备后返回，不触发正式对局结算或残留战场状态。
- 证据：[js/range.js:1](F:/voxel-frontline-battle/js/range.js:1)；[js/main.js:332](F:/voxel-frontline-battle/js/main.js:332)；[modes/small-battle/js/main.js:374](F:/voxel-frontline-battle/modes/small-battle/js/main.js:374)；[forgeax/assets/ui/ui.plugin.ts:132](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:132)

### SOLO-02 单人入口与原个人城区地图路径

- [ ] **P1 · 部分实现**
- 原版：原版小型战斗存在个人模式路径；个人自由混战有 Doodle District 城区生成分支。
- 新版现状：新版已有本地 AI 对局；单人按钮固定选择 conquest，尚未承接个人城区地图的独立选择路径。
- 仍需补齐：明确单人按钮的当前内容，恢复需要保留的个人模式与城区地图；未来搜打撤另行设计开发。
- 完成判据：单人入口清楚标示实际玩法并进入对应地图；城区布局/出生点可验证。不要把原 pve-district 文件误认为已经完成的搜打撤。
- 证据：[modes/small-battle/js/main.js:345](F:/voxel-frontline-battle/modes/small-battle/js/main.js:345)；[modes/small-battle/js/voxel-world.js:645](F:/voxel-frontline-battle/modes/small-battle/js/voxel-world.js:645)；[forgeax/assets/ui/ui.plugin.ts:123](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:123)；[forgeax/assets/gameplay/battle.plugin.ts:51](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:51)

## 载具

### VEH-01 制导、弹种和装甲伤害

- [ ] **P1 · 部分实现**
- 原版：原版具有瞄准制导导弹和按伤害类型/装甲类型处理的载具伤害。
- 新版现状：新版吉普、步战车、坦克可驾驶射击，有装填/弹药/过热；弹体没有后续制导，车辆伤害直接减血。
- 仍需补齐：恢复瞄准制导、弹种适配、装甲伤害规则和命中反馈，核查载具与步兵的射线/爆炸判定。
- 完成判据：能实际引导导弹改变路径；不同弹种对不同装甲目标的结果符合规则，墙后及偏离射线的目标不能误伤。
- 证据：[js/vehicles.js:3126](F:/voxel-frontline-battle/js/vehicles.js:3126)；[js/vehicles.js:3648](F:/voxel-frontline-battle/js/vehicles.js:3648)；[forgeax/assets/gameplay/native-vehicles.ts:28](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-vehicles.ts:28)；[forgeax/assets/gameplay/native-vehicles.ts:31](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-vehicles.ts:31)

### VEH-02 载具乘员与维修完整交互

- [ ] **P1 · 部分实现**
- 原版：原版有乘员/座位关系、AI 乘车联动及载具维修补给逻辑。
- 新版现状：新版玩家能上车、换座和下车；AI 主要是敌方车辆自动驾驶。T 键在近处直接加 50 血，缺少完整道具约束。
- 仍需补齐：接回实际乘员占位、座位权限、AI 协作、玩家/乘员受伤规则及维修条件；联机乘员依赖 NET-02。
- 完成判据：逐种车辆验证不同座位驾驶/射击权限、车毁乘员结果、维修条件、补给和重生。
- 证据：[js/vehicles.js:225](F:/voxel-frontline-battle/js/vehicles.js:225)；[js/ai.js:2405](F:/voxel-frontline-battle/js/ai.js:2405)；[forgeax/assets/gameplay/native-vehicles.ts:23](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-vehicles.ts:23)；[forgeax/assets/gameplay/native-vehicles.ts:44](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-vehicles.ts:44)

## 地图与破坏交互

### MAP-01 地图生成、变体与自定义地图加载

- [ ] **P1 · 部分实现**
- 原版：原版有种子重建、TDM/爆破/FFA 和个人城区等生成分支及编辑内容。
- 新版现状：新版导出了默认/固定种子的地图；核心默认布局和四份小地图复现校验已通过。
- 仍需补齐：接回运行时地图选择/变体/种子生成和自定义地图加载，以及地图参数和出生点校验。
- 完成判据：可选择至少两组种子/变体，重开和联机使用相同数据；默认地图仍可复现。
- 证据：[modes/small-battle/js/voxel-world.js:403](F:/voxel-frontline-battle/modes/small-battle/js/voxel-world.js:403)；[modes/small-battle/js/voxel-world.js:555](F:/voxel-frontline-battle/modes/small-battle/js/voxel-world.js:555)；[forgeax/assets/gameplay/battle.plugin.ts:51](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:51)；[forgeax/docs/migration/validation-2026-09-14.json:1](F:/voxel-frontline-battle/forgeax/docs/migration/validation-2026-09-14.json:1)

### MAP-02 细地形和门/楼梯等独立附属物

- [ ] **P1 · 部分实现**
- 原版：原版有 10 厘米地形高度场，以及独立网格碰撞的门、半格楼梯和门破坏交互。
- 新版现状：新版原生碰撞、体素破坏、投掷物和碎块已经工作；当前地图以整米数据为主，未完整导入这些附属对象。
- 仍需补齐：迁入细地形数据及其原生碰撞，接回门/楼梯等附属物及可破坏属性；以造化能力实现。
- 完成判据：原本可通行楼梯仍可通行；门的阻挡、破坏和消失同步正确，细地形不出现明显悬空/卡位。
- 证据：[js/terrain-fine.js:2](F:/voxel-frontline-battle/js/terrain-fine.js:2)；[js/voxel-world.js:817](F:/voxel-frontline-battle/js/voxel-world.js:817)；[js/voxel-world.js:839](F:/voxel-frontline-battle/js/voxel-world.js:839)；[forgeax/assets/gameplay/voxel-map.ts:22](F:/voxel-frontline-battle/forgeax/assets/gameplay/voxel-map.ts:22)

## 界面与档案

### UI-01 档案、设置等菜单的真实交互

- [ ] **P1 · 部分实现**
- 原版：原版界面含士兵档案、设置、编辑/训练等入口。
- 新版现状：新版首页→模式→装备→部署→战场→返回已打通；archive 标记始终为 false，多个保留入口没有对应处理。
- 仍需补齐：逐按钮接通档案/设置和所属功能，清理占位状态；保留已确认的首页和部署 UI 流程。
- 完成判据：对当前可见按钮逐个验收；每个入口都有可返回的有效内容，设置可应用并在重启后保持。
- 证据：[js/soldier-menu.js:1](F:/voxel-frontline-battle/js/soldier-menu.js:1)；[js/config.js:1](F:/voxel-frontline-battle/js/config.js:1)；[forgeax/assets/ui/ui.plugin.ts:22](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:22)；[forgeax/assets/ui/ui.plugin.ts:114](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:114)

### UI-02 完整战场 HUD、计分板与模式结果页

- [ ] **P1 · 部分实现**
- 原版：原版具有模式专属 HUD、计分/战绩和爆破统计结果界面。
- 新版现状：新版显示血甲、弹药、基础小地图、计时、比分和简要胜负；结果页主要列前五名击杀。
- 仍需补齐：接回完整计分板、队友/目标信息、爆破专属统计、枪械进度和载具弹药/座位状态；对照各模式避免误显示。
- 完成判据：同一 HUD 字段能追溯到实时游戏状态；步兵/载具、回合/整场结果均显示对应内容。
- 证据：[js/ui.js:1](F:/voxel-frontline-battle/js/ui.js:1)；[modes/small-battle/js/sd-stats.js:1](F:/voxel-frontline-battle/modes/small-battle/js/sd-stats.js:1)；[modes/small-battle/js/sd-result.js:1](F:/voxel-frontline-battle/modes/small-battle/js/sd-result.js:1)；[modes/small-battle/js/gg-ui.js:1](F:/voxel-frontline-battle/modes/small-battle/js/gg-ui.js:1)；[forgeax/assets/ui/ui.plugin.ts:140](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:140)

### DATA-01 购买/解锁与装备档案闭环

- [ ] **P1 · 部分实现**
- 原版：原版有交易规则、武器购买、材料/武器菜单和装备使用。
- 新版现状：新版原经济函数已经迁移并通过对照测试，已拥有装备可穿戴；UI 没有调用购买，未解锁项只能查看。
- 仍需补齐：接通购买、余额/条件反馈、库存更新、装备更新和战后经济入口。
- 完成判据：购买成功扣款一次并永久解锁；失败不扣款；重载后库存与装备正确。
- 证据：[js/hub.js:881](F:/voxel-frontline-battle/js/hub.js:881)；[modes/small-battle/js/arsenal.js:485](F:/voxel-frontline-battle/modes/small-battle/js/arsenal.js:485)；[forgeax/assets/ui/ui.plugin.ts:70](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:70)；[forgeax/assets/gameplay/__tests__/rules-and-voxel.test.ts:11](F:/voxel-frontline-battle/forgeax/assets/gameplay/__tests__/rules-and-voxel.test.ts:11)

### DATA-02 原战争模式战绩、成就与旧档数据兼容

- [ ] **P1 · 部分实现**
- 原版：原版小型战斗有跨局战绩、成就、经济结算和本地存档。
- 新版现状：新版有新的本地经济存储；原 Career 及完整战后持久结算没有接到当前战场，也没有旧站点存档迁移入口。
- 仍需补齐：恢复原战争模式战后记录和成就，提供旧存档导出/导入及版本校验；8765 与 8766 的存储不能视为自动共享。
- 完成判据：完成一局后刷新仍有正确战绩/收益；旧存档可显式迁入并保留原文件。此项不要求未来搜打撤加入长期养成。
- 证据：[modes/small-battle/js/career.js:14](F:/voxel-frontline-battle/modes/small-battle/js/career.js:14)；[modes/small-battle/js/economy.js:710](F:/voxel-frontline-battle/modes/small-battle/js/economy.js:710)；[forgeax/assets/ui/ui.plugin.ts:20](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:20)；[forgeax/assets/ui/ui.plugin.ts:145](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:145)

## 开发工具

### TOOL-01 地图、关卡和塔楼编辑器

- [ ] **P1 · 未接入**
- 原版：原版有地图编辑器、关卡编辑器、塔楼设计器及导入导出流程。
- 新版现状：新版导入了一部分生成后的地图和固定塔蓝图；没有接通这些编辑器的实际入口/保存/加载流程。
- 仍需补齐：以造化原生工具承接编辑、保存、导入导出、内容校验和进入游戏测试。
- 完成判据：从编辑器新建地图/塔楼，保存并重新打开，打包后在游戏中载入同一内容。
- 证据：[js/map-editor.js:1](F:/voxel-frontline-battle/js/map-editor.js:1)；[js/level-editor.js:1](F:/voxel-frontline-battle/js/level-editor.js:1)；[js/tower-designer.js:1](F:/voxel-frontline-battle/js/tower-designer.js:1)；[forgeax/assets/gameplay/native-building.ts:3](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-building.ts:3)；[forgeax/forge.json:1](F:/voxel-frontline-battle/forgeax/forge.json:1)

## 动作与反馈

### FX-01 角色动作和第一人称武器动作

- [ ] **P1 · 部分实现**
- 原版：原版士兵与枪械有动作、姿态和射击反馈。
- 新版现状：新版角色/枪械模型和相机已接入；战场角色为静态网格，关节动作和枪械动作没有完整接回。
- 仍需补齐：用新引擎补齐行走/奔跑/蹲姿、持枪、开火、换弹、近战和技能动作，并与玩法时序绑定。
- 完成判据：第三人称能识别角色当前动作，第一人称换弹/开火/技能反馈和实际操作时间一致。
- 证据：[js/soldier.js:1](F:/voxel-frontline-battle/js/soldier.js:1)；[js/weapon-viewmodels.js:1](F:/voxel-frontline-battle/js/weapon-viewmodels.js:1)；[js/weapons.js:2](F:/voxel-frontline-battle/js/weapons.js:2)；[forgeax/assets/gameplay/native-arena.ts:30](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:30)；[forgeax/assets/gameplay/battle.plugin.ts:102](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:102)

### FX-02 空间音频与完整事件音效

- [ ] **P1 · 部分实现**
- 原版：原版音频路由支持空间声音和多类玩法事件。
- 新版现状：新版 93 个音效文件已导入并播放枪声、脚步、受伤、爆炸、载具循环；AudioSource 的 spatialBlend 当前为 0，仅手动按距离调音量。
- 仍需补齐：接回空间方位、更多武器/动作/交互事件及音量设置，验证监听与生命周期。
- 完成判据：转身后声源方向正确变化；不同距离、武器、载具和状态的声音符合事件，退出后无残留声源。
- 证据：[js/audio.js:2](F:/voxel-frontline-battle/js/audio.js:2)；[forgeax/assets/gameplay/native-audio.ts:20](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-audio.ts:20)；[forgeax/assets/gameplay/native-audio.ts:24](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-audio.ts:24)

### FX-03 天气、环境与命中特效

- [ ] **P2 · 部分实现**
- 原版：原版有 atmosphere、vehicle-effects 和射击/爆炸反馈内容。
- 新版现状：新版采用造化原生材质、灯光与相机，有基础爆炸碎块，但原环境与反馈事件未全部接入。
- 仍需补齐：按新引擎的表现标准补齐天气/环境、枪口、命中材质、装甲命中、烟尘与载具损毁等效果。
- 完成判据：代表性事件都有可辨识反馈，天气切换不破坏可读性；不以旧画面逐像素一致作为完成条件。
- 证据：[js/atmosphere.js:1](F:/voxel-frontline-battle/js/atmosphere.js:1)；[js/vehicle-effects.js:1](F:/voxel-frontline-battle/js/vehicle-effects.js:1)；[js/weapons.js:2](F:/voxel-frontline-battle/js/weapons.js:2)；[forgeax/assets/gameplay/native-ordnance.ts:10](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-ordnance.ts:10)

## 交付与开发验收

### DEV-01 Studio 开发流程与热更新稳定性

- [ ] **P0 · 未验收**
- 原版：后续开发目标是以造化工程/工具作为主工程。此项属于交付条件，不是旧游戏玩法缺失。
- 新版现状：CLI 检查、类型检查、生产构建已通过；历史记录仍有开发态依赖 504/资源 404，Studio 使用链路未验收。
- 仍需补齐：验证 Studio 打开、编辑场景/资源、预览、保存、重启、重新构建，并处理开发态资源问题。
- 完成判据：在 Studio 中完成一次资产和玩法修改，重启后仍能预览并生成可用构建；无依赖开发机临时状态的步骤。
- 证据：[forgeax/README.md:1](F:/voxel-frontline-battle/forgeax/README.md:1)；[forgeax/docs/feedback.md:1](F:/voxel-frontline-battle/forgeax/docs/feedback.md:1)；[forgeax/docs/migration/validation-2026-09-14.json:1](F:/voxel-frontline-battle/forgeax/docs/migration/validation-2026-09-14.json:1)

### DEV-02 完整替换包、性能与长时间稳定

- [ ] **P0 · 未验收**
- 原版：“可替换原版”要求全部保留玩法可用，并有可运行交付包。此项属于验收范围。
- 新版现状：最新记录有 35 项基础测试、83 项物理包测试、六模式短流程；完整核心推进失败，最终发布与全模式长时验收未完成。
- 仍需补齐：从最终打包产物验收全部模式/菜单、多人同步、持续破坏、人数与载具满载、进出循环、内存和帧时间。
- 完成判据：形成可分享运行包及目标机器性能数据，所有 P0 和保留玩法缺口关闭；构建成功或端口可打开不作为完整替换证明。
- 证据：[forgeax/docs/migration/validation-2026-09-14.json:1](F:/voxel-frontline-battle/forgeax/docs/migration/validation-2026-09-14.json:1)；[forgeax/docs/migration/replacement-status.json:1](F:/voxel-frontline-battle/forgeax/docs/migration/replacement-status.json:1)；[forgeax/scripts/verify-replacement.cjs:1](F:/voxel-frontline-battle/forgeax/scripts/verify-replacement.cjs:1)

## 范围澄清

- 原 PVP 源码标明 8v8 真人房、总计 16 名真人上限；新版本 64 个战斗单位的测试不能换算为 64 人联机能力。
- 个人城区生成分支属于原自由混战地图内容；不能因为文件名 pve-district 就称原版已完成独立搜打撤。
- 大征服与小型战斗的 C4、投掷物池及职业规则不同，必须分别对照。

## 不计入原版迁移缺口

- 旧 Three.js 渲染和旧物理解算的逐项复刻：按用户要求，表现与物理以造化功能为准。
- Teardown 等级的全部细体素、结构坍塌等远期愿望：未证明原版已实现的部分，不算原版功能倒退。
- 计划中的单人搜打撤完整系统：属于新玩法开发，不列为原版已实现功能；仍遵守单局体验、无长期养成、无武器配件、品质区分装备。
- 此前明确删除的准备房、模式页左下返回按钮等交互：不作为需要恢复的功能。

## 建议补齐顺序

1. 统一实际装备/武器行为，并修复核心攻防满员 AI 推进；同步打通 Studio 开发链路。
2. 接通真实房间与 PVP，同步破坏/建造/载具/目标及真人替换 AI。
3. 恢复救援、小队、部署、完整道具/兵种与模式特殊事件；逐模式完成整局。
4. 完成档案/经济/菜单和编辑工具，导入旧存档并检验自定义内容。
5. 补齐动作、音频、环境反馈；从最终包完成全模式长时与满载验收。

项目仍以 `replacement-status.json` 和实际证据为准；本清单提供更细粒度的工作项，不把未验收项假定为通过。
