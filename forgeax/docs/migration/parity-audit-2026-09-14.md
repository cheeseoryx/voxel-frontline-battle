# 原版与造化版完整差异审计

日期：2026-09-14。审计对象是当前本地原版源码与 localhost:8766 运行的原生构建。

## 结论

**当前版本尚不能100%替换原版。已迁入的是原生运行基础、模型/地图数据和部分玩法流程，原版的大量系统尚未接齐；此外存在实现错误和明显性能问题。** 用户观察到的后坐力缺失、无枪械弹道表现和远景建筑消失都有明确源码原因。基础 R 装填和友方吉普登车在本轮 QQ 操作中可用，但控制习惯和完整体验没有对齐。

“资源已导入”“有类/函数”“能进入模式”“短测试通过”分别只能证明相应层级，不能用来宣称整款游戏已完成迁移。

51项是可跟进的差异/问题/验收单元，包含总体验收项与细项，不是51个互不重叠功能，也不能换算成迁移完成百分比。

2026-09-15 更新：共 51 个跟进单元，已完成 3 项（EQ-01、EQ-02、EQ-03），其余 48 项继续跟进。未接入 10 项；部分实现 29 项；验收失败 2 项；未验收 5 项；实现有误 2 项。未完成优先级：P0 16 项；P1 31 项；P2 1 项。

## 本次六个直接问题

### 没有后坐力：确认未接入

QQ 连续13发，视角 pitch 保持0；当前没有开火后坐/回正代码。 对应 EQ-07。

### 射击看不到子弹：步兵射击表现未接入

普通枪射线结算可以保留，但原有曳光、枪口闪光、命中反馈未接回；炮弹/手雷的可见方块不能代替枪械表现。 对应 EQ-08、EQ-04。

### 地图远景消失：远景建筑几何缺失

近景只保留9×9块，远景只有地形高度网格；相机远裁剪已为1100，增加裁剪距离不能显示没有创建的楼房。 对应 MAP-03。

### 整体帧率极低：已实测复现

QQ 64单位新版本无分析器约11.6次画面回调/秒，原版出生点约46.1；两版内部画布与视角不同，不计算严格倍数。CPU样本显示材质布局与参数处理为主要热点。 对应 PERF-01、PERF-02。

### 无法换弹：基础R装填实测通过；体验不完整

QQ：30/150→13发后17/150→R后30/137。缺失换弹动画与空弹自动换弹；用户其他失败情境仍需单独复现。 对应 EQ-09、INPUT-01。

### 无法进入载具：按键已变化；并非全部载具入口都不存在

距友方吉普5.96米时，旧键E无效，新键F可上车，随后驾驶/下车成功。其他车型与复杂交互仍未全测。 对应 VEH-03、VEH-02。

## 两版的底层与产品差异

- **运行组织**：原版是 JavaScript/Three.js 的大征服与小型战斗入口；新版是 TypeScript 插件、实体组件、统一界面状态和造化原生渲染。实际入口由 forge.json 与 assets/plugin.ts 决定，旧源码仍在目录不代表仍在执行。
- **渲染**：新版使用造化材质、灯光与相机；目前采用压缩导入地图及有限范围近景网格。高DPI兼容修复只证明画面能显示，不证明远景、动画、效果或帧率已达原版水平。
- **物理**：玩家/AI 使用 Rapier 角色控制器，车辆是运动学长方体控制器，手雷/碎块和部分炮弹使用动态物理体。已有碰撞与爆炸碎块，不代表全建筑结构坍塌、完整底盘或所有旧交互已迁入。
- **AI**：当前是重新编写的寻路/视线/射击/目标 AI，未完整承接旧小队、救援、职业支援与乘员协作。另有射速单位错误和核心满员推进失败。
- **模式/联机**：六个模式入口及部分规则存在，运行的主要是本地 AI 战场。服务器按钮、真人房间、联网伤害/破坏/载具同步尚未接齐；64个单位不是64名真人联机。
- **装备与数据**：已补齐六槽装备、六类投掷物与 C4/黏弹遥控（EQ-01 至 EQ-03）；枪械的其他表现、购买、战绩、档案与旧站点存档仍按对应条目跟进。
- **开发交付**：造化作者工程已经建立，但 Studio 完整开发闭环、最终打包与全负载性能验收仍不完整；项目 fps/bench/gate 指标当前停用。

## 已有能力及证据边界

- 首页→模式选择→整备→小队部署→战场→返回的基础路径，以及六种基础模式入口。
- 原生模型与地图显示、相机、移动跳跃、基本命中与破坏、血甲/弹药/基础小地图。
- QQ 本轮默认枪械扣弹、手动装填，友方吉普上车/驾驶/下车。
- 原生碰撞、手雷和短时动态碎块；载具基础控制/武器和小型兵种技能存在，部分有历史专项测试。
- 基础 AI、占点/核心、爆破/死斗/混战/枪械的规则模块已接入；这不等于全场胜负、全部装备与多人场景通过。

## 测量结果与限制

同机、同QQ、普通GPU设置、1805×1083 CSS、DPR1.5、64战斗单位，分别顺序运行；各取12秒。原版与新版视角/出生点/内部画布/AI不同，不是控制变量基准。rAF是画面回调频率，含CPU分析的样本另行标注；新版提交计数也约每秒10帧。

- 原版：约 46.1 次画面回调/秒；帧间隔中位数 16.7ms，p95 33.4ms。
- 新版，无CPU分析器：约 11.6 次/秒；中位数 83.3ms，p95 116.7ms。
- 新版附带CPU采样时约9–10次/秒。当前热点是布局SHA-256、材质纹理来源扫描和参数布局派生；不是凭感觉将全部低帧率归于物理或显卡。
- 跨块远景重建、体素面生成、碰撞块调度、AI寻路和逐帧HUD更新是源码确认的后续排查对象，**尚未证明每一项都是本次主要耗时**。

实测记录：[forgeax/artifacts/parity-audit-2026-09-14/qq-controls-final.json](F:/voxel-frontline-battle/forgeax/artifacts/parity-audit-2026-09-14/qq-controls-final.json)、[forgeax/artifacts/parity-audit-2026-09-14/qq-actions-first.json](F:/voxel-frontline-battle/forgeax/artifacts/parity-audit-2026-09-14/qq-actions-first.json)、[forgeax/artifacts/parity-audit-2026-09-14/qq-actions-performance.json](F:/voxel-frontline-battle/forgeax/artifacts/parity-audit-2026-09-14/qq-actions-performance.json)、[forgeax/artifacts/parity-audit-2026-09-14/qq-cpu-profile.json](F:/voxel-frontline-battle/forgeax/artifacts/parity-audit-2026-09-14/qq-cpu-profile.json)、[forgeax/artifacts/parity-audit-2026-09-14/original-qq.json](F:/voxel-frontline-battle/forgeax/artifacts/parity-audit-2026-09-14/original-qq.json)。

## 分类差异与逐项验收

### 联机与房间

#### NET-01 · 服务器浏览、创建/加入房间与快速匹配〔未接入 / P0〕

- **原版**：原版有房间发现、创建、加入，以及房主直接开局、玩家中途加入的路径。原网络以本机通信与可选 PeerJS 为基础。
- **当前新版**：新版服务器页能打开；模式按钮直接创建本地战场，没有连接房间。
- **剩余工作**：接通服务器列表刷新、选房加入、按模式查房/建房、房间参数和错误反馈。保持“选模式→装备整备→直接开局”，不增加准备房。
- **验收条件**：两个独立客户端能发现并进入同一房间，模式和地图一致；无人房按原规则由 AI 填充。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/pvp.js:1](F:/voxel-frontline-battle/js/pvp.js:1)；[js/pvp.js:545](F:/voxel-frontline-battle/js/pvp.js:545)；[forgeax/assets/ui/ui.plugin.ts:114](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:114)；[forgeax/assets/gameplay/native-arena.ts:36](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:36)。

#### NET-02 · 真人 PVP、AI 席位替换与房间生命周期〔未接入 / P0〕

- **原版**：原版存在真人房间、共享战场同步及进退房逻辑。
- **当前新版**：当前六种模式中的其他角色均由本机 AI 驱动；64 人战场不代表支持 64 名联机玩家。
- **剩余工作**：同步玩家、射击伤害、破坏、建造、载具、目标和比分；接通真人替换 AI、退出补位、断线恢复与主客端状态处理。
- **验收条件**：双端完成交火、破坏、上下车、目标交互、退房重进；按原房间人数上限验收，另行定义是否扩容。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/pvp.js:1](F:/voxel-frontline-battle/js/pvp.js:1)；[js/net-protocol.js:1](F:/voxel-frontline-battle/js/net-protocol.js:1)；[js/net-simulation.js:1](F:/voxel-frontline-battle/js/net-simulation.js:1)；[modes/small-battle/js/sd-net.js:1](F:/voxel-frontline-battle/modes/small-battle/js/sd-net.js:1)；[forgeax/assets/gameplay/native-arena.ts:36](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:36)。

### 装备与射击

#### EQ-01 · 装备整备与战场道具槽实际对应〔已完成 / 原 P0〕

六个装备槽以快照进入战场，按所选道具切换、部署、使用和消耗；恢复大征服补给箱、RPG、C4、望远镜及刀具接线，小型战斗保留独立按键和数量规则。

2026-09-15：类型检查、50 项项目测试（含 15 项装备专项）及生产构建通过；QQ 默认 GPU 配置的 14 个实际界面流程检查通过，零错误。详细证据见 EQ-01 交付记录。

[实现与验收记录](F:/voxel-frontline-battle/forgeax/docs/migration/eq-01-implementation.md)

#### EQ-02 · 完整投掷物种类与作用〔已完成 / P1〕

- **原版**：大征服可选破片、闪光、烟雾；小型战斗还包括黏性炸弹、燃烧瓶、震撼弹。
- **当前新版**：六类投掷物的原生物理投掷、引信、黏附、区域作用、致盲/震撼、AI 与小地图烟雾遮挡、友伤与音画反馈已接入；烟雾和火焰按用户授权使用造化原生网格/材质重构。
- **剩余工作**：本项已完成；整体性能、枪械反馈、载具、联机及地图破坏等仍由其他条目跟进。
- **验收条件**：每一种投掷物均从整备选择进入实战，效果、持续时间、数量消耗、友伤规则和音画反馈可验证。
- **验证结果**：2026-09-15：68 项自动测试通过；QQ 默认图形环境下六种投掷物完成 17 步操作复验，零页面/控制台错误，烟雾/燃烧/致盲/震撼消退已实测。生产构建通过。
- **实现与证据**：[EQ-02 实现记录](F:/voxel-frontline-battle/forgeax/docs/migration/eq-02-implementation.md)、[QQ 实测](F:/voxel-frontline-battle/forgeax/artifacts/eq-02/qq-throwables.json)。

#### EQ-03 · C4 / 黏性炸药的统一遥控与黏附〔已完成 / P1〕

- **原版**：大征服道具 C4 支持贴墙/地面、遥控引爆；小型战斗先锋 C4 有自己的定时规则。
- **当前新版**：统一 C4 / 黏性炸药为左键投出、右键引爆本人全部已投出设备（含飞行中）；补齐墙面、角色、友敌载具的黏附与转向跟随、支撑丢失下落、子弹/爆炸摧毁和连锁。大征服两枚与弹药箱补充；小型先锋 G 取出、投出后 24 秒冷却，黏弹 Q 取出，空库存/冷却仍能遥控。
- **剩余工作**：本项当前授权范围已完成。按用户本次要求替代旧同装备键引爆和定时引爆；整体物理、性能和联网同步继续由其他条目跟进。
- **验收条件**：持有 C4 或黏性炸药时左键只投出一枚，右键引爆所有本人已投出的这两类设备；不等待落地，不因切换装备/空库存左键触发。可黏附墙地、角色和移动载具，受损摧毁，复活/离局无残留。
- **证据等级**：2026-09-15：83 项自动测试 / 13 个文件通过；生产构建及类型检查通过；QQ Chromium 138 无界面自动化完成 12 步生产构建操作，零页面/控制台错误。可见窗口中已确认持有模型；桌面焦点中断记录与测试边界见 EQ-03 实现记录。
- **来源**：[实现与操作记录](F:/voxel-frontline-battle/forgeax/docs/migration/eq-03-implementation.md)；[QQ 实测记录](F:/voxel-frontline-battle/forgeax/artifacts/eq-03/qq-remote-explosives.json)。

#### EQ-04 · 散布、霰弹多弹丸与步兵发射器〔部分实现 / P0〕

- **原版**：原版武器定义及射击过程区分弹丸数、散布、后坐力、自动/半自动和发射器。
- **当前新版**：原武器数据、模型、伤害、射速和弹量已导入；当前玩家开火统一使用一条准星射线，未消费散布/弹丸数量。步兵 RPG 没有接通独立飞行弹体路径。
- **剩余工作**：接回霰弹多弹丸、腰射/瞄准散布、发射器弹道与爆炸。后坐力、换弹和视觉反馈详见 EQ-07 至 EQ-11。
- **验收条件**：代表性步枪、手枪、霰弹枪、狙击枪和发射器的实际伤害形态与设计一致，不能只验证能扣弹和命中。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/weapons.js:64](F:/voxel-frontline-battle/js/weapons.js:64)；[js/weapons.js:212](F:/voxel-frontline-battle/js/weapons.js:212)；[js/weapons.js:298](F:/voxel-frontline-battle/js/weapons.js:298)；[forgeax/assets/gameplay/battle.plugin.ts:102](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:102)。

#### EQ-05 · 近战攻击与局内检视〔未接入 / P1〕

- **原版**：原版有战斗刀挥砍、背刺/近战判定和小型战斗武器检视。
- **当前新版**：新版装备检视模型已存在；战斗输入未接入独立近战和局内检视操作。
- **剩余工作**：恢复近战切换、挥砍范围、背刺/伤害规则、持刀速度，以及局内武器检视。
- **验收条件**：能够从整备选择近战装备并在场内击中目标；检视可进入、退出且不影响射击状态。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/melee.js:1](F:/voxel-frontline-battle/js/melee.js:1)；[js/gadgets.js:1398](F:/voxel-frontline-battle/js/gadgets.js:1398)；[modes/small-battle/js/weapon-inspect.js:1](F:/voxel-frontline-battle/modes/small-battle/js/weapon-inspect.js:1)；[forgeax/assets/gameplay/battle.plugin.ts:84](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:84)。

#### EQ-06 · 兵种主动/被动技能与职业作用〔部分实现 / P1〕

- **原版**：原版大征服兵种配合道具与团队系统；小型战斗有六兵种技能及冲刺等动作。
- **当前新版**：新版六个小型兵种均能触发技能，但部分被动/效果为简化实现；大征服 G 键分支直接投手雷。
- **剩余工作**：逐兵种核对完整作用、被动、资源/冷却和大征服道具联动。移动动作另见 MOVE-01。
- **验收条件**：每个兵种执行一组实战场景，检查对自己、友军、敌军、载具和地形的实际影响；激活成功不等于效果等价。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[modes/small-battle/js/skills.js:31](F:/voxel-frontline-battle/modes/small-battle/js/skills.js:31)；[modes/small-battle/js/skills.js:1228](F:/voxel-frontline-battle/modes/small-battle/js/skills.js:1228)；[js/player.js:1](F:/voxel-frontline-battle/js/player.js:1)；[forgeax/assets/gameplay/native-skills.ts:14](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-skills.ts:14)；[forgeax/assets/gameplay/battle.plugin.ts:84](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:84)。

#### EQ-07 · 后坐力、首发跳动与回正〔未接入 / P0〕

- **原版**：原版按垂直/水平后坐力、首发倍率和 ADS 系数计算镜头及枪体后坐，并回正。
- **当前新版**：当前玩家射击不修改 yaw/pitch，也不驱动枪体后坐。QQ 中连续 13 发时 pitch 保持 0；固定持枪网格没有开火动作。
- **剩余工作**：建立开火事件→武器后坐→镜头反馈→回正链路，消费原武器参数并区分腰射/瞄准。
- **验收条件**：固定鼠标连续射击可观察到枪体和准星跳动；停止后按武器参数回正；半自动首发和连续射击均可复核。
- **证据等级**：本轮源码与 QQ 开火实测
- **来源**：[js/weapons.js:842](F:/voxel-frontline-battle/js/weapons.js:842)；[js/player.js:1330](F:/voxel-frontline-battle/js/player.js:1330)；[forgeax/assets/gameplay/battle.plugin.ts:67](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:67)；[forgeax/assets/gameplay/battle.plugin.ts:102](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:102)；[forgeax/artifacts/parity-audit-2026-09-14/qq-actions-retry.json](F:/voxel-frontline-battle/forgeax/artifacts/parity-audit-2026-09-14/qq-actions-retry.json)。

#### EQ-08 · 步枪曳光、枪口火光和命中反馈〔未接入 / P0〕

- **原版**：原版普通枪采用射线结算，同时绘制枪口闪光与曳光轨迹；发射器另有飞行弹体。不是每发普通子弹都依赖刚体模拟。
- **当前新版**：步兵开火路径只扣弹、发声、射线伤害/破坏，没有对应可视轨迹和枪口/命中特效。载具炮弹和手雷已有可见小方块，不能算步兵枪械表现已完成。
- **剩余工作**：在新引擎接通枪口位置、曳光轨迹、材质命中反馈和命中提示；普通枪可保留射线判定，发射器使用真实弹体。
- **验收条件**：玩家与 AI 开火均有可辨识反馈；可见弹道与实际命中一致，遮挡和射程正确。
- **证据等级**：本轮源码复核；区别判定与表现
- **来源**：[js/weapons.js:788](F:/voxel-frontline-battle/js/weapons.js:788)；[js/weapons.js:1379](F:/voxel-frontline-battle/js/weapons.js:1379)；[js/weapons.js:1581](F:/voxel-frontline-battle/js/weapons.js:1581)；[forgeax/assets/gameplay/battle.plugin.ts:102](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:102)；[forgeax/assets/gameplay/native-ordnance.ts:9](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-ordnance.ts:9)。

#### EQ-09 · 换弹闭环与空弹自动装填〔部分实现 / P0〕

- **原版**：原版支持 R 装填、空弹点击自动装填、阶段音效、动作和取消逻辑。
- **当前新版**：QQ 实测 R 有效：30/150→射击后17/150→R后30/137；开始与结束提示也变化。但没有装填动画，空弹开火不会自动装填。核心建造时 R 用于旋转，上车后 R 用于车载武器。用户所述其他失效场景尚未复现定位。
- **剩余工作**：恢复空弹自动装填和动作时序；清楚显示当前输入状态；覆盖建造/切枪/死亡/暂停/入场阶段等分支后再关闭用户问题。
- **验收条件**：各类武器手动和空弹装填正确扣备弹，动画与完成时间一致；切枪/上下车/暂停后无卡死；不得仅以满弹匣按 R 验证。
- **证据等级**：本轮 QQ 手动装填通过；完整状态矩阵未验收
- **来源**：[js/weapons.js:749](F:/voxel-frontline-battle/js/weapons.js:749)；[js/weapons.js:1863](F:/voxel-frontline-battle/js/weapons.js:1863)；[forgeax/assets/gameplay/battle.plugin.ts:84](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:84)；[forgeax/assets/gameplay/battle.plugin.ts:95](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:95)；[forgeax/assets/gameplay/battle.plugin.ts:96](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:96)；[forgeax/artifacts/parity-audit-2026-09-14/qq-actions-retry.json](F:/voxel-frontline-battle/forgeax/artifacts/parity-audit-2026-09-14/qq-actions-retry.json)。

#### EQ-10 · 瞄准、切枪、武器动作和手感参数〔部分实现 / P1〕

- **原版**：原版武器视模有瞄准过渡、持枪位置、奔跑摆动、切换及装填动作，并消费多项武器手感参数。
- **当前新版**：新版 ADS 主要切换 FOV 和鼠标灵敏度；枪械相对相机的位置固定，未对齐机械瞄具或驱动视模动作。切换是替换网格并固定等待 0.2 秒。
- **剩余工作**：接回武器瞄准位置、过渡、切换速度、跑动/呼吸摆动；结合新引擎动画系统，而非只导入静态网格。
- **验收条件**：不同武器能正确举枪瞄准；切枪/开镜/装填互斥和中断规则清楚，姿态与实际可开火时机一致。
- **证据等级**：本轮源码复核
- **来源**：[js/player.js:120](F:/voxel-frontline-battle/js/player.js:120)；[js/player.js:1354](F:/voxel-frontline-battle/js/player.js:1354)；[js/weapon-viewmodels.js:1](F:/voxel-frontline-battle/js/weapon-viewmodels.js:1)；[forgeax/assets/gameplay/battle.plugin.ts:67](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:67)；[forgeax/assets/gameplay/battle.plugin.ts:84](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:84)；[forgeax/assets/gameplay/battle.plugin.ts:101](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:101)。

#### EQ-11 · 距离衰减、部位伤害与破坏概率〔部分实现 / P0〕

- **原版**：原版有武器距离衰减、头/躯干/四肢及姿态相关命中区域、方块破坏概率与核心专用衰减。
- **当前新版**：新版直接传武器基础 damage；单位判定为简化竖直区域，头部固定乘 1.6；未消费原距离衰减/四肢倍率/破坏概率。命中方块直接减少耐久次数。
- **剩余工作**：将武器数据映射到实际伤害和破坏规则，恢复部位与姿态判定，并明确任何平衡改动。
- **验收条件**：同把枪近/远、头/身/四肢以及不同护甲目标的伤害与设计案例一致；核心与建筑破坏规则单独验证。
- **证据等级**：本轮源码复核
- **来源**：[js/hitboxes.js:34](F:/voxel-frontline-battle/js/hitboxes.js:34)；[js/hitboxes.js:67](F:/voxel-frontline-battle/js/hitboxes.js:67)；[js/weapons.js:1141](F:/voxel-frontline-battle/js/weapons.js:1141)；[js/weapons.js:1457](F:/voxel-frontline-battle/js/weapons.js:1457)；[forgeax/assets/gameplay/battle.plugin.ts:102](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:102)；[forgeax/assets/gameplay/native-arena.ts:106](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:106)；[forgeax/assets/gameplay/voxel-map.ts:22](F:/voxel-frontline-battle/forgeax/assets/gameplay/voxel-map.ts:22)。

### 团队作战与 AI

#### TEAM-01 · 倒地、流血、求救、拖拽与救援〔未接入 / P0〕

- **原版**：原版大征服有玩家/AI 倒地、流血倒计时、求救、拖拽、复活和放弃救援。
- **当前新版**：新版生命归零后直接进入死亡和自动重生，没有倒地状态。
- **剩余工作**：接通完整救援生命周期、玩家与 AI 救援交互、救援保护与兵力扣除时机。
- **验收条件**：大征服玩家和 AI 均可被救起；拖拽、超时死亡、主动放弃、救援取消、票数结算均正确。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/revive.js:115](F:/voxel-frontline-battle/js/revive.js:115)；[js/revive.js:262](F:/voxel-frontline-battle/js/revive.js:262)；[js/main.js:2502](F:/voxel-frontline-battle/js/main.js:2502)；[forgeax/assets/gameplay/native-arena.ts:71](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:71)。

#### TEAM-02 · 真实小队管理与队长指令〔未接入 / P1〕

- **原版**：原版支持加入/退出小队、锁队、队长转移、目标命令及命令完成判定。
- **当前新版**：新版部署四人卡片属于展示，战场没有对应的小队管理系统。
- **剩余工作**：接回小队成员关系、队长/锁队操作、占领/防守命令、队员状态与命令反馈。
- **验收条件**：部署显示与战场实际小队一致；改变成员/队长后，命令权限和 AI 执行目标同步更新。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/squads.js:125](F:/voxel-frontline-battle/js/squads.js:125)；[js/squads.js:199](F:/voxel-frontline-battle/js/squads.js:199)；[js/main.js:2503](F:/voxel-frontline-battle/js/main.js:2503)；[forgeax/assets/ui/ui.plugin.ts:58](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:58)。

#### TEAM-03 · 死亡后部署选择〔部分实现 / P1〕

- **原版**：原版提供部署地图和出生点选择，并结合阵营、已占点及小队等条件。
- **当前新版**：新版可在控制点/前哨附近自动出生，但玩家没有完整的选择部署流程。
- **剩余工作**：恢复可选部署地点、可用条件、禁止出生状态、部署确认与阵营相关限制。
- **验收条件**：死亡后能选择合法出生点；争夺、失守和占用状态更新后不能进入无效位置。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/ui.js:138](F:/voxel-frontline-battle/js/ui.js:138)；[js/conquest.js:1009](F:/voxel-frontline-battle/js/conquest.js:1009)；[forgeax/assets/gameplay/native-arena.ts:56](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:56)；[forgeax/assets/gameplay/native-arena.ts:102](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:102)。

#### TEAM-04 · 战术标记与团队贡献计分〔未接入 / P1〕

- **原版**：原版有敌人/地点标记、队长目标通报，以及助攻、救援、治疗、补弹、侦察、命令、摧毁载具等计分。
- **当前新版**：新版有击杀提示和基础比分，但没有接入原 Comms/Scoring 的完整事件体系。
- **剩余工作**：恢复标记与通报、贡献分归属、去重/冷却、勋带和团队/个人统计。
- **验收条件**：同一动作只计分一次；救援、补给、侦察、占领等行为能在 HUD 和结算中准确追溯。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/comms.js:64](F:/voxel-frontline-battle/js/comms.js:64)；[js/scoring.js:7](F:/voxel-frontline-battle/js/scoring.js:7)；[forgeax/assets/gameplay/objective-rules.ts:13](F:/voxel-frontline-battle/forgeax/assets/gameplay/objective-rules.ts:13)；[forgeax/assets/ui/ui.plugin.ts:144](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:144)。

#### AI-01 · AI 兵种分工、支援与乘员协作〔部分实现 / P1〕

- **原版**：原版 AI 与小队、救援、兵种和载具系统存在联动。
- **当前新版**：新版已有寻路、避障、视线、射击、撤退、目标选择和核心地图跳跃/滑索；普通 AI 单位仍以统一步兵配置为主。
- **剩余工作**：为新 AI 接回不同装备和职责、救援/补给、队长命令、载具乘员协作；继续改进跨地形路径。
- **验收条件**：在满员实战中观察到明确的职业支援和目标协作，不能只让所有 AI 以相同武器互射。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/ai.js:2396](F:/voxel-frontline-battle/js/ai.js:2396)；[js/ai.js:2603](F:/voxel-frontline-battle/js/ai.js:2603)；[js/main.js:2409](F:/voxel-frontline-battle/js/main.js:2409)；[forgeax/assets/gameplay/native-arena.ts:65](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:65)。

#### AI-02 · 核心攻防满员 AI 目标推进〔验收失败 / P0〕

- **原版**：核心攻防的主要目标是攻击并摧毁敌方核心。
- **当前新版**：隔离单个进攻 AI 可以摧毁核心；完整 50 人仿真在 360 秒模拟时间内未伤到核心，浏览器推进测试也失败。
- **剩余工作**：修复满员环境中的进攻路径、交火停滞、目标优先级和攻防协作，重新进行完整人数测试。
- **验收条件**：满员 AI 能持续推进并实际伤到核心；同时验证可达的胜负结束流程。360 秒是当前测试门槛，不代表原版保证六分钟结束。
- **证据等级**：历史满员失败记录，本轮未重跑；当前没有关闭此失败项的后续证据。
- **来源**：[forgeax/docs/migration/validation-2026-09-14.json:1](F:/voxel-frontline-battle/forgeax/docs/migration/validation-2026-09-14.json:1)；[forgeax/artifacts/native-core-full-simulation.log:1](F:/voxel-frontline-battle/forgeax/artifacts/native-core-full-simulation.log:1)；[forgeax/assets/gameplay/native-arena.ts:86](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:86)。

#### AI-03 · 大征服 AI 射速单位错误〔实现有误 / P0〕

- **原版**：大征服武器 fireRate 是每分钟发数，例如 AK-74 为 670 RPM；小型战斗同字段是每发间隔秒数。
- **当前新版**：玩家路径做了单位转换，AI 路径直接用 Math.max(0.24, fireRate) 作为秒数冷却。因此大征服 AI 可能开一枪后等待数百个游戏秒；小型战斗又被统一限制为不快于 0.24 秒一发。
- **剩余工作**：按武器所属数据协议统一射速单位，加入 AI 弹匣、装填与角色火力差异；核查所有共享字段单位。
- **验收条件**：固定目标记录 AI 连续射击间隔，步枪应符合 RPM 换算；两种数据来源都通过，不能只验证首发伤害。
- **证据等级**：本轮实际导入数据与消费代码确认；尚未运行长间隔实战验收
- **来源**：[forgeax/assets/original/rules.ts](F:/voxel-frontline-battle/forgeax/assets/original/rules.ts)；[forgeax/assets/gameplay/catalog.ts:17](F:/voxel-frontline-battle/forgeax/assets/gameplay/catalog.ts:17)；[forgeax/assets/gameplay/native-arena.ts:94](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:94)；[forgeax/assets/gameplay/battle.plugin.ts:102](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:102)。

### 模式完整性

#### MODE-01 · 大征服规则与点位对应〔部分实现 / P1〕

- **原版**：原版有地图控制点配置、兵力消耗、团队贡献分、救援和补给联动。
- **当前新版**：新版有六点占领、争夺、兵力和胜负；六个点按两基地插值生成，个人击杀加 25 分，与原计分 100 分不同。
- **剩余工作**：核对原地图点位和模式参数，恢复各系统联动；玩法数值如需改动应明确作为设计变更。
- **验收条件**：以原规则案例验证点位、占领、票数和计分；在 64 人场景完成一局并正确退出、再开局。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/conquest.js:252](F:/voxel-frontline-battle/js/conquest.js:252)；[js/scoring.js:7](F:/voxel-frontline-battle/js/scoring.js:7)；[forgeax/assets/gameplay/native-arena.ts:39](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:39)；[forgeax/assets/gameplay/objective-rules.ts:13](F:/voxel-frontline-battle/forgeax/assets/gameplay/objective-rules.ts:13)。

#### MODE-02 · 核心攻防建造交互〔部分实现 / P1〕

- **原版**：原版有建造预览、旋转、掩体和塔楼设计联动。
- **当前新版**：新版已恢复默认地图、前哨、滑索、资源、掩体和防御塔；当前使用固定塔蓝图，没有可视化放置预览。
- **剩余工作**：接回合法/非法放置预览、自定义塔方案、相关入口和建筑附属交互。
- **验收条件**：玩家可预览并旋转建筑；保存的自定义蓝图能带入对局，资源扣除和失败回退正确。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/building.js:55](F:/voxel-frontline-battle/js/building.js:55)；[js/tower-designer.js:1](F:/voxel-frontline-battle/js/tower-designer.js:1)；[forgeax/assets/gameplay/native-building.ts:4](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-building.ts:4)。

#### MODE-03 · 团队死斗与自由混战整局循环〔未验收 / P1〕

- **原版**：原版有模式计分、胜负、复活和结果页。
- **当前新版**：新版导入原计分规则并接入 AI；已通过进入、移动、开火、退出和重进的短流程。
- **剩余工作**：补做分数达到上限、时间结束、平局/排名、死亡复活、结算再开局，以及满员长时实战验证。
- **验收条件**：两个模式均从首页完整游玩至结算后再次开局；通过所有条件后才能标记完整。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[modes/small-battle/js/tdm-match.js:1](F:/voxel-frontline-battle/modes/small-battle/js/tdm-match.js:1)；[modes/small-battle/js/ffa-match.js:1](F:/voxel-frontline-battle/modes/small-battle/js/ffa-match.js:1)；[forgeax/assets/gameplay/native-arena.ts:43](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:43)；[forgeax/docs/migration/validation-2026-09-14.json:1](F:/voxel-frontline-battle/forgeax/docs/migration/validation-2026-09-14.json:1)。

#### MODE-04 · 爆破整场多回合〔未验收 / P1〕

- **原版**：原版有携带、丢弃、拾取、安拆炸弹、单命回合、换边和整场胜负。
- **当前新版**：新版已接入炸弹和回合规则；浏览器证据证明过一回合，完整 BO13 未完成实测。
- **剩余工作**：补做完整多回合、半场换边、不同炸弹结局和整场结束；模式专属统计/UI 另列为未接通项。
- **验收条件**：真实浏览器完成至先得 7 分，并覆盖攻守换边、安拆/爆炸/歼灭及下一场状态清理。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[modes/small-battle/js/sd-match.js:1](F:/voxel-frontline-battle/modes/small-battle/js/sd-match.js:1)；[modes/small-battle/js/sd-bomb.js:1](F:/voxel-frontline-battle/modes/small-battle/js/sd-bomb.js:1)；[forgeax/assets/gameplay/native-arena.ts:42](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:42)；[forgeax/docs/migration/validation-2026-09-14.json:1](F:/voxel-frontline-battle/forgeax/docs/migration/validation-2026-09-14.json:1)。

#### MODE-05 · 枪械模式完整晋级与特殊击杀规则〔部分实现 / P1〕

- **原版**：原版有武器序列晋级、最终级胜利和降级等特殊规则。
- **当前新版**：新版已导入原晋级规则；整条序列未实战跑通，近战/特殊武器操作不完整会影响规则可达性。
- **剩余工作**：补齐对应攻击操作，验证有效武器击杀、降级、最终级胜利和再次开局。
- **验收条件**：从第一把武器实战晋级到胜利；覆盖无效武器击杀、近战/自杀等原已启用的特殊规则。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[modes/small-battle/js/gg-match.js:302](F:/voxel-frontline-battle/modes/small-battle/js/gg-match.js:302)；[modes/small-battle/js/gg-match.js:399](F:/voxel-frontline-battle/modes/small-battle/js/gg-match.js:399)；[forgeax/assets/gameplay/battle.plugin.ts:84](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:84)；[forgeax/assets/gameplay/native-arena.ts:43](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:43)。

#### MODE-06 · TDM 连杀空袭与战场飞机事件〔部分实现 / P1〕

- **原版**：原版 TDM 每连续 5 次击杀可调用空袭；原战场事件系统有飞机、导弹和阵营伤害。
- **当前新版**：新版保留计分模块中的调用，但 game 对象没有 battlefieldEvents 实例，所以空袭不会产生。
- **剩余工作**：用新引擎接入飞机/空袭事件、伤害归属、反制、触发与场景清理。
- **验收条件**：达到连杀阈值会出现一次真实空袭，能对目标造成正确伤害；环境击杀不得循环召唤空袭。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[modes/small-battle/js/tdm-match.js:280](F:/voxel-frontline-battle/modes/small-battle/js/tdm-match.js:280)；[modes/small-battle/js/battlefield-events.js:748](F:/voxel-frontline-battle/modes/small-battle/js/battlefield-events.js:748)；[modes/small-battle/js/main.js:273](F:/voxel-frontline-battle/modes/small-battle/js/main.js:273)；[forgeax/assets/gameplay/native-arena.ts:36](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:36)。

### 单人与训练

#### SOLO-01 · 训练场与试枪流程〔未接入 / P1〕

- **原版**：原版主界面/大厅具有独立训练场入口，支持武器试用和返回。
- **当前新版**：新版 tutorial 只是说明弹层；没有创建 Range 训练场。
- **剩余工作**：接回靶场场景、试枪、命中反馈、装备切换和进出流程。
- **验收条件**：从大厅进入训练场使用代表性装备后返回，不触发正式对局结算或残留战场状态。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/range.js:1](F:/voxel-frontline-battle/js/range.js:1)；[js/main.js:332](F:/voxel-frontline-battle/js/main.js:332)；[modes/small-battle/js/main.js:374](F:/voxel-frontline-battle/modes/small-battle/js/main.js:374)；[forgeax/assets/ui/ui.plugin.ts:132](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:132)。

#### SOLO-02 · 单人入口与原个人城区地图路径〔部分实现 / P1〕

- **原版**：原版小型战斗存在个人模式路径；个人自由混战有 Doodle District 城区生成分支。
- **当前新版**：新版已有本地 AI 对局；单人按钮固定选择 conquest，尚未承接个人城区地图的独立选择路径。
- **剩余工作**：明确单人按钮的当前内容，恢复需要保留的个人模式与城区地图；未来搜打撤另行设计开发。
- **验收条件**：单人入口清楚标示实际玩法并进入对应地图；城区布局/出生点可验证。不要把原 pve-district 文件误认为已经完成的搜打撤。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[modes/small-battle/js/main.js:345](F:/voxel-frontline-battle/modes/small-battle/js/main.js:345)；[modes/small-battle/js/voxel-world.js:645](F:/voxel-frontline-battle/modes/small-battle/js/voxel-world.js:645)；[forgeax/assets/ui/ui.plugin.ts:123](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:123)；[forgeax/assets/gameplay/battle.plugin.ts:51](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:51)。

### 载具

#### VEH-01 · 制导、弹种和装甲伤害〔部分实现 / P1〕

- **原版**：原版具有瞄准制导导弹和按伤害类型/装甲类型处理的载具伤害。
- **当前新版**：新版吉普、步战车、坦克可驾驶射击，有装填/弹药/过热；弹体没有后续制导，车辆伤害直接减血。
- **剩余工作**：恢复瞄准制导、弹种适配、装甲伤害规则和命中反馈，核查载具与步兵的射线/爆炸判定。
- **验收条件**：能实际引导导弹改变路径；不同弹种对不同装甲目标的结果符合规则，墙后及偏离射线的目标不能误伤。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/vehicles.js:3126](F:/voxel-frontline-battle/js/vehicles.js:3126)；[js/vehicles.js:3648](F:/voxel-frontline-battle/js/vehicles.js:3648)；[forgeax/assets/gameplay/native-vehicles.ts:28](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-vehicles.ts:28)；[forgeax/assets/gameplay/native-vehicles.ts:31](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-vehicles.ts:31)。

#### VEH-02 · 载具乘员与维修完整交互〔部分实现 / P1〕

- **原版**：原版有乘员/座位关系、AI 乘车联动及载具维修补给逻辑。
- **当前新版**：新版有玩家乘车/换座/下车和敌方车辆自动驾驶；完整乘员关系与 AI 协作未接齐。T 键在近处直接加50血，缺少完整道具约束。具体上下车实测见 VEH-03。
- **剩余工作**：接回实际乘员占位、座位权限、AI 协作、玩家/乘员受伤规则及维修条件；联机乘员依赖 NET-02。
- **验收条件**：逐种车辆验证不同座位驾驶/射击权限、车毁乘员结果、维修条件、补给和重生。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/vehicles.js:225](F:/voxel-frontline-battle/js/vehicles.js:225)；[js/ai.js:2405](F:/voxel-frontline-battle/js/ai.js:2405)；[forgeax/assets/gameplay/native-vehicles.ts:23](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-vehicles.ts:23)；[forgeax/assets/gameplay/native-vehicles.ts:44](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-vehicles.ts:44)。

#### VEH-03 · 上下车按键、交互范围与提示〔部分实现 / P0〕

- **原版**：原版 E 上下车，F 用于滑索；还有直接座位键与车内控制。
- **当前新版**：新版只在 conquest/core 创建可驾驶载具；使用 F，E 不触发登车。仅允许进入7米中心距离内的存活友方车辆，F 与滑索存在优先级。QQ 实测距友方吉普约5.96米时按 E 无反应、按 F 成功登车，并可行驶和下车；完整车型/模式仍待验收。
- **剩余工作**：统一并明确显示车辆交互键；恢复应保留的控制习惯或给出键位迁移；按车辆外形而非不透明中心距离设计入口反馈，处理滑索竞争和受阻下车。
- **验收条件**：三个车型逐座位测试，上下车成功/失败原因可见；旧键位兼容或设置说明明确；每个开放载具的模式均通过。
- **证据等级**：本轮 QQ 对照按 E/F、驾驶、下车通过；其他车型未全测
- **来源**：[js/player.js:634](F:/voxel-frontline-battle/js/player.js:634)；[forgeax/assets/gameplay/battle.plugin.ts:77](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:77)；[forgeax/assets/gameplay/battle.plugin.ts:84](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:84)；[forgeax/assets/gameplay/native-vehicles.ts:26](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-vehicles.ts:26)；[forgeax/artifacts/parity-audit-2026-09-14/qq-actions-first.json](F:/voxel-frontline-battle/forgeax/artifacts/parity-audit-2026-09-14/qq-actions-first.json)；[forgeax/artifacts/parity-audit-2026-09-14/qq-controls-final.json](F:/voxel-frontline-battle/forgeax/artifacts/parity-audit-2026-09-14/qq-controls-final.json)。

#### VEH-04 · 载具底盘、炮塔/座位视角与模型动作〔部分实现 / P1〕

- **原版**：原版载具有车型运动、炮塔/武器、车内/车外视角和乘员控制逻辑。
- **当前新版**：新版有速度、转向、重力和碰撞，但底盘以运动学长方体角色控制器移动，车身是静态导入网格。不能等同于完整轮式/履带底盘、关节炮塔或车内视角。
- **剩余工作**：以新引擎的物理能力定义并接通车型运动、坡面姿态、炮塔转向/瞄准和座位视角；保留玩家需要的驾驶/射击功能。
- **验收条件**：斜坡、台阶、碰撞、转向和不同座位射击可用；炮口朝向、镜头和实际弹道一致。无需复刻旧物理解算。
- **证据等级**：本轮实现结构复核；底盘专项实测未完成
- **来源**：[js/vehicles.js:1](F:/voxel-frontline-battle/js/vehicles.js:1)；[js/player.js:612](F:/voxel-frontline-battle/js/player.js:612)；[forgeax/assets/gameplay/native-vehicles.ts:20](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-vehicles.ts:20)；[forgeax/assets/gameplay/native-physics.ts:21](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-physics.ts:21)。

#### VEH-05 · 爆炸范围伤害没有覆盖载具〔实现有误 / P0〕

- **原版**：原版载具伤害与爆炸、反载具武器及伤害类型联动。
- **当前新版**：新版炮弹直击能调用车辆 damage；但通用 arena.blast 只遍历步兵和方块，没有遍历车辆。手雷或炮弹在车辆旁边爆炸不会经此路径造成车辆溅射伤害。
- **剩余工作**：统一爆炸事件对步兵、车辆和场景的作用，接回距离衰减、装甲、遮挡、阵营及击杀归属。
- **验收条件**：同一载具分别接受直击、近旁爆炸和墙后爆炸；血量结果符合弹种与遮挡规则。
- **证据等级**：本轮爆炸调用链确认；未逐弹种实测
- **来源**：[js/vehicles.js:3648](F:/voxel-frontline-battle/js/vehicles.js:3648)；[forgeax/assets/gameplay/native-arena.ts:109](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:109)；[forgeax/assets/gameplay/native-vehicles.ts:28](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-vehicles.ts:28)；[forgeax/assets/gameplay/native-vehicles.ts:40](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-vehicles.ts:40)；[forgeax/assets/gameplay/native-ordnance.ts:12](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-ordnance.ts:12)。

### 地图与破坏交互

#### MAP-01 · 地图生成、变体与自定义地图加载〔部分实现 / P1〕

- **原版**：原版有种子重建、TDM/爆破/FFA 和个人城区等生成分支及编辑内容。
- **当前新版**：新版导出了默认/固定种子的地图；核心默认布局和四份小地图复现校验已通过。
- **剩余工作**：接回运行时地图选择/变体/种子生成和自定义地图加载，以及地图参数和出生点校验。
- **验收条件**：可选择至少两组种子/变体，重开和联机使用相同数据；默认地图仍可复现。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[modes/small-battle/js/voxel-world.js:403](F:/voxel-frontline-battle/modes/small-battle/js/voxel-world.js:403)；[modes/small-battle/js/voxel-world.js:555](F:/voxel-frontline-battle/modes/small-battle/js/voxel-world.js:555)；[forgeax/assets/gameplay/battle.plugin.ts:51](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:51)；[forgeax/docs/migration/validation-2026-09-14.json:1](F:/voxel-frontline-battle/forgeax/docs/migration/validation-2026-09-14.json:1)。

#### MAP-02 · 细地形和门/楼梯等独立附属物〔部分实现 / P1〕

- **原版**：原版有 10 厘米地形高度场，以及独立网格碰撞的门、半格楼梯和门破坏交互。
- **当前新版**：新版原生碰撞、体素破坏、投掷物和碎块已经工作；当前地图以整米数据为主，未完整导入这些附属对象。
- **剩余工作**：迁入细地形数据及其原生碰撞，接回门/楼梯等附属物及可破坏属性；以造化能力实现。
- **验收条件**：原本可通行楼梯仍可通行；门的阻挡、破坏和消失同步正确，细地形不出现明显悬空/卡位。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/terrain-fine.js:2](F:/voxel-frontline-battle/js/terrain-fine.js:2)；[js/voxel-world.js:817](F:/voxel-frontline-battle/js/voxel-world.js:817)；[js/voxel-world.js:839](F:/voxel-frontline-battle/js/voxel-world.js:839)；[forgeax/assets/gameplay/voxel-map.ts:22](F:/voxel-frontline-battle/forgeax/assets/gameplay/voxel-map.ts:22)。

#### MAP-03 · 远景建筑、地图轮廓与分块切换〔部分实现 / P0〕

- **原版**：原版逐步建立全地图 chunk，并保留建筑几何；另有地形 LOD 和外圈环境内容。
- **当前新版**：新版只保留玩家周围 9×9 个16米块的细节网格，超出范围卸载。远景网格每8米采样地形高度，不包含楼房、桥梁等地上体素，因此近处有建筑、远处只剩地形。相机 far 已是1100，单改裁剪距离无法恢复。
- **剩余工作**：为建筑/桥梁/地标建立远景几何与分层加载，避免只保留高度场；保持破坏后的远景同步和近远切换。
- **验收条件**：在固定观察点能看到原地图远处关键地标，移动/转身时不整片消失；远景版本与破坏状态一致。
- **证据等级**：本轮源码与 QQ 战场画面确认
- **来源**：[js/voxel-world.js:2770](F:/voxel-frontline-battle/js/voxel-world.js:2770)；[js/voxel-world.js:2812](F:/voxel-frontline-battle/js/voxel-world.js:2812)；[js/world-outskirts.js:1](F:/voxel-frontline-battle/js/world-outskirts.js:1)；[forgeax/assets/gameplay/battle.plugin.ts:38](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:38)；[forgeax/assets/gameplay/battle.plugin.ts:58](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:58)；[forgeax/assets/gameplay/voxel-map.ts:38](F:/voxel-frontline-battle/forgeax/assets/gameplay/voxel-map.ts:38)。

#### MAP-04 · 细地形形变与破坏后的渲染/碰撞同步〔部分实现 / P1〕

- **原版**：原版有细高度场与 deformTerrainCircle/setTerrainTop 专用地形变更路径，普通 breakBlock 不直接破坏地表。
- **当前新版**：新版普通和爆炸破坏仍禁止 ground 以下实体，未接入细地形形变路径；远景始终使用初始 terrain 数组。已有原生手雷/碎块碰撞，不代表地表变形与建筑失去支撑后的结构解体已实现。
- **剩余工作**：若保留原地形编辑/形变功能，接通细高度场变更、近远网格和原生碰撞更新；结构坍塌作为另行明确的目标，不能凭碎块效果宣称完成。
- **验收条件**：以原版实际可触发的地形变更操作对照，变化后脚底高度、碰撞、小地图与远景一致。
- **证据等级**：本轮源码复核；不把未证明的旧版结构坍塌算作回退
- **来源**：[js/terrain-fine.js:1](F:/voxel-frontline-battle/js/terrain-fine.js:1)；[js/voxel-world.js:3075](F:/voxel-frontline-battle/js/voxel-world.js:3075)；[forgeax/assets/gameplay/voxel-map.ts:22](F:/voxel-frontline-battle/forgeax/assets/gameplay/voxel-map.ts:22)；[forgeax/assets/gameplay/voxel-map.ts:40](F:/voxel-frontline-battle/forgeax/assets/gameplay/voxel-map.ts:40)；[forgeax/assets/gameplay/native-physics.ts:13](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-physics.ts:13)。

### 界面与档案

#### UI-01 · 档案、设置等菜单的真实交互〔部分实现 / P1〕

- **原版**：原版界面含士兵档案、设置、编辑/训练等入口。
- **当前新版**：新版首页→模式→装备→部署→战场→返回已打通；archive 标记始终为 false，多个保留入口没有对应处理。
- **剩余工作**：逐按钮接通档案/设置和所属功能，清理占位状态；保留已确认的首页和部署 UI 流程。
- **验收条件**：对当前可见按钮逐个验收；每个入口都有可返回的有效内容，设置可应用并在重启后保持。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/soldier-menu.js:1](F:/voxel-frontline-battle/js/soldier-menu.js:1)；[js/config.js:1](F:/voxel-frontline-battle/js/config.js:1)；[forgeax/assets/ui/ui.plugin.ts:22](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:22)；[forgeax/assets/ui/ui.plugin.ts:114](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:114)。

#### UI-02 · 完整战场 HUD、计分板与模式结果页〔部分实现 / P1〕

- **原版**：原版具有模式专属 HUD、计分/战绩和爆破统计结果界面。
- **当前新版**：新版显示血甲、弹药、基础小地图、计时、比分和简要胜负；结果页主要列前五名击杀。
- **剩余工作**：接回完整计分板、队友/目标信息、爆破专属统计、枪械进度和载具弹药/座位状态；对照各模式避免误显示。
- **验收条件**：同一 HUD 字段能追溯到实时游戏状态；步兵/载具、回合/整场结果均显示对应内容。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/ui.js:1](F:/voxel-frontline-battle/js/ui.js:1)；[modes/small-battle/js/sd-stats.js:1](F:/voxel-frontline-battle/modes/small-battle/js/sd-stats.js:1)；[modes/small-battle/js/sd-result.js:1](F:/voxel-frontline-battle/modes/small-battle/js/sd-result.js:1)；[modes/small-battle/js/gg-ui.js:1](F:/voxel-frontline-battle/modes/small-battle/js/gg-ui.js:1)；[forgeax/assets/ui/ui.plugin.ts:140](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:140)。

#### DATA-01 · 购买/解锁与装备档案闭环〔部分实现 / P1〕

- **原版**：原版有交易规则、武器购买、材料/武器菜单和装备使用。
- **当前新版**：新版原经济函数已经迁移并通过对照测试，已拥有装备可穿戴；UI 没有调用购买，未解锁项只能查看。
- **剩余工作**：接通购买、余额/条件反馈、库存更新、装备更新和战后经济入口。
- **验收条件**：购买成功扣款一次并永久解锁；失败不扣款；重载后库存与装备正确。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/hub.js:881](F:/voxel-frontline-battle/js/hub.js:881)；[modes/small-battle/js/arsenal.js:485](F:/voxel-frontline-battle/modes/small-battle/js/arsenal.js:485)；[forgeax/assets/ui/ui.plugin.ts:70](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:70)；[forgeax/assets/gameplay/__tests__/rules-and-voxel.test.ts:11](F:/voxel-frontline-battle/forgeax/assets/gameplay/__tests__/rules-and-voxel.test.ts:11)。

#### DATA-02 · 原战争模式战绩、成就与旧档数据兼容〔部分实现 / P1〕

- **原版**：原版小型战斗有跨局战绩、成就、经济结算和本地存档。
- **当前新版**：新版有新的本地经济存储；原 Career 及完整战后持久结算没有接到当前战场，也没有旧站点存档迁移入口。
- **剩余工作**：恢复原战争模式战后记录和成就，提供旧存档导出/导入及版本校验；8765 与 8766 的存储不能视为自动共享。
- **验收条件**：完成一局后刷新仍有正确战绩/收益；旧存档可显式迁入并保留原文件。此项不要求未来搜打撤加入长期养成。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[modes/small-battle/js/career.js:14](F:/voxel-frontline-battle/modes/small-battle/js/career.js:14)；[modes/small-battle/js/economy.js:710](F:/voxel-frontline-battle/modes/small-battle/js/economy.js:710)；[forgeax/assets/ui/ui.plugin.ts:20](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:20)；[forgeax/assets/ui/ui.plugin.ts:145](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:145)。

### 开发工具

#### TOOL-01 · 地图、关卡和塔楼编辑器〔未接入 / P1〕

- **原版**：原版有地图编辑器、关卡编辑器、塔楼设计器及导入导出流程。
- **当前新版**：新版导入了一部分生成后的地图和固定塔蓝图；没有接通这些编辑器的实际入口/保存/加载流程。
- **剩余工作**：以造化原生工具承接编辑、保存、导入导出、内容校验和进入游戏测试。
- **验收条件**：从编辑器新建地图/塔楼，保存并重新打开，打包后在游戏中载入同一内容。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/map-editor.js:1](F:/voxel-frontline-battle/js/map-editor.js:1)；[js/level-editor.js:1](F:/voxel-frontline-battle/js/level-editor.js:1)；[js/tower-designer.js:1](F:/voxel-frontline-battle/js/tower-designer.js:1)；[forgeax/assets/gameplay/native-building.ts:3](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-building.ts:3)；[forgeax/forge.json:1](F:/voxel-frontline-battle/forgeax/forge.json:1)。

### 动作与反馈

#### FX-01 · 第三人称角色动作与状态表达〔部分实现 / P1〕

- **原版**：原版士兵与枪械有动作、姿态和射击反馈。
- **当前新版**：新版角色/枪械模型和相机已接入；战场角色为静态网格，关节动作和枪械动作没有完整接回。
- **剩余工作**：用新引擎补齐第三人称行走、奔跑、蹲卧、射击、装填、受伤、近战与技能动作；第一人称视模详见 EQ-07/09/10。
- **验收条件**：第三人称能识别角色当前动作，第一人称换弹/开火/技能反馈和实际操作时间一致。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/soldier.js:1](F:/voxel-frontline-battle/js/soldier.js:1)；[js/weapon-viewmodels.js:1](F:/voxel-frontline-battle/js/weapon-viewmodels.js:1)；[js/weapons.js:2](F:/voxel-frontline-battle/js/weapons.js:2)；[forgeax/assets/gameplay/native-arena.ts:30](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:30)；[forgeax/assets/gameplay/battle.plugin.ts:102](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:102)。

#### FX-02 · 空间音频与完整事件音效〔部分实现 / P1〕

- **原版**：原版音频路由支持空间声音和多类玩法事件。
- **当前新版**：新版 93 个音效文件已导入并播放枪声、脚步、受伤、爆炸、载具循环；AudioSource 的 spatialBlend 当前为 0，仅手动按距离调音量。
- **剩余工作**：接回空间方位、更多武器/动作/交互事件及音量设置，验证监听与生命周期。
- **验收条件**：转身后声源方向正确变化；不同距离、武器、载具和状态的声音符合事件，退出后无残留声源。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/audio.js:2](F:/voxel-frontline-battle/js/audio.js:2)；[forgeax/assets/gameplay/native-audio.ts:20](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-audio.ts:20)；[forgeax/assets/gameplay/native-audio.ts:24](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-audio.ts:24)。

#### FX-03 · 天气、环境氛围与载具损毁效果〔部分实现 / P2〕

- **原版**：原版有 atmosphere、vehicle-effects 和射击/爆炸反馈内容。
- **当前新版**：新版采用造化原生材质、灯光与相机，有基础爆炸碎块，但原环境与反馈事件未全部接入。
- **剩余工作**：按新引擎表现标准接回环境动态、天气/尘埃和载具损毁/烟尘等事件。步兵枪口与命中特效见 EQ-08。
- **验收条件**：代表性事件都有可辨识反馈，天气切换不破坏可读性；不以旧画面逐像素一致作为完成条件。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[js/atmosphere.js:1](F:/voxel-frontline-battle/js/atmosphere.js:1)；[js/vehicle-effects.js:1](F:/voxel-frontline-battle/js/vehicle-effects.js:1)；[js/weapons.js:2](F:/voxel-frontline-battle/js/weapons.js:2)；[forgeax/assets/gameplay/native-ordnance.ts:10](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-ordnance.ts:10)。

### 交付与开发验收

#### DEV-01 · Studio 开发流程与热更新稳定性〔未验收 / P0〕

- **原版**：后续开发目标是以造化工程/工具作为主工程。此项属于交付条件，不是旧游戏玩法缺失。
- **当前新版**：CLI 检查、类型检查、生产构建已通过；历史记录仍有开发态依赖 504/资源 404，Studio 使用链路未验收。
- **剩余工作**：验证 Studio 打开、编辑场景/资源、预览、保存、重启、重新构建，并处理开发态资源问题。
- **验收条件**：在 Studio 中完成一次资产和玩法修改，重启后仍能预览并生成可用构建；无依赖开发机临时状态的步骤。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[forgeax/README.md:1](F:/voxel-frontline-battle/forgeax/README.md:1)；[forgeax/docs/feedback.md:1](F:/voxel-frontline-battle/forgeax/docs/feedback.md:1)；[forgeax/docs/migration/validation-2026-09-14.json:1](F:/voxel-frontline-battle/forgeax/docs/migration/validation-2026-09-14.json:1)。

#### DEV-02 · 完整替换包、性能与长时间稳定〔未验收 / P0〕

- **原版**：“可替换原版”要求全部保留玩法可用，并有可运行交付包。此项属于验收范围。
- **当前新版**：已有原生构建、基础规则测试和六模式短流程，以及先前高DPI模型/战场可见性验证。本轮再次发现低帧率与明确玩法缺口；fps/bench/gate 配置仍停用。短流程和构建通过不能证明完整替换。
- **剩余工作**：从最终打包产物验收全部模式/菜单、多人同步、持续破坏、人数与载具满载、进出循环、内存和帧时间。
- **验收条件**：形成可分享运行包及目标机器性能数据，所有 P0 和保留玩法缺口关闭；构建成功或端口可打开不作为完整替换证明。
- **证据等级**：本轮当前入口复核；详细原版对照沿用前次审计。除注明项目外，未逐项实机验收。
- **来源**：[forgeax/docs/migration/validation-2026-09-14.json:1](F:/voxel-frontline-battle/forgeax/docs/migration/validation-2026-09-14.json:1)；[forgeax/docs/migration/replacement-status.json:1](F:/voxel-frontline-battle/forgeax/docs/migration/replacement-status.json:1)；[forgeax/scripts/verify-replacement.cjs:1](F:/voxel-frontline-battle/forgeax/scripts/verify-replacement.cjs:1)。

### 角色与移动

#### MOVE-01 · 蹲伏、滑铲、卧倒、翻越与体力〔部分实现 / P1〕

- **原版**：原版有真实蹲姿、滑铲、卧倒、翻越和体力/动作状态，而非单纯速度变化。
- **当前新版**：新版已有行走、Shift 加速、跳跃和核心滑索；Ctrl 仅降低速度，角色胶囊高度不变，未接入卧倒/滑铲/翻越/体力状态。
- **剩余工作**：用造化角色控制器实现原移动能力、碰撞体变化、镜头高度和状态互斥，补齐第三人称动作。
- **验收条件**：蹲下可通过对应低矮空间，卧倒/翻越/滑铲有正确碰撞与动作限制，不能只改变速度。
- **证据等级**：本轮源码复核
- **来源**：[js/player.js:1825](F:/voxel-frontline-battle/js/player.js:1825)；[js/player.js:1895](F:/voxel-frontline-battle/js/player.js:1895)；[forgeax/assets/gameplay/native-physics.ts:21](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-physics.ts:21)；[forgeax/assets/gameplay/battle.plugin.ts:98](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:98)。

### 性能与稳定

#### PERF-01 · 实际帧率及材质处理热点〔验收失败 / P0〕

- **原版**：本机普通 QQ、1805×1083 CSS、DPR1.5，原版征服64单位出生点12秒短采样约46.1次画面回调/秒，p95约33.4ms；主画布1805×1083。
- **当前新版**：新版同浏览器64单位场景，无分析器短采样约11.6次/秒，p95约116.7ms；带CPU分析器约9–10次/秒，主画布2048×1229。12秒样本中主线程几乎持续忙碌；热点集中在材质布局 SHA-256 重算和纹理来源遍历。
- **剩余工作**：优先处理稳定材质/布局的跨帧复用及无效参数扫描，随后按完整战场负载检查渲染、物理、寻路和界面；建立项目性能门槛。
- **验收条件**：在事先约定的机器/分辨率/浏览器和满员破坏场景中记录真实提交帧数、帧时间中位数/p95和长帧；优化前后同场景复测。上述不同视角/分辨率样本不用于声称精确性能倍数。
- **证据等级**：本轮普通 QQ 实测与 CPU 采样；非标准化性能基准
- **来源**：[forgeax/artifacts/parity-audit-2026-09-14/qq-actions-first.json](F:/voxel-frontline-battle/forgeax/artifacts/parity-audit-2026-09-14/qq-actions-first.json)；[forgeax/artifacts/parity-audit-2026-09-14/qq-actions-performance.json](F:/voxel-frontline-battle/forgeax/artifacts/parity-audit-2026-09-14/qq-actions-performance.json)；[forgeax/artifacts/parity-audit-2026-09-14/qq-actions-retry.json](F:/voxel-frontline-battle/forgeax/artifacts/parity-audit-2026-09-14/qq-actions-retry.json)；[forgeax/artifacts/parity-audit-2026-09-14/qq-cpu-profile.json](F:/voxel-frontline-battle/forgeax/artifacts/parity-audit-2026-09-14/qq-cpu-profile.json)；[forgeax/artifacts/parity-audit-2026-09-14/original-qq.json](F:/voxel-frontline-battle/forgeax/artifacts/parity-audit-2026-09-14/original-qq.json)；[forgeax-engine/packages/types/src/derive-paramschema.ts:343](F:/voxel-frontline-battle/forgeax-engine/packages/types/src/derive-paramschema.ts:343)；[forgeax-engine/packages/types/src/derive-paramschema.ts:731](F:/voxel-frontline-battle/forgeax-engine/packages/types/src/derive-paramschema.ts:731)；[forgeax-engine/packages/render/src/render-system-extract.ts:1666](F:/voxel-frontline-battle/forgeax-engine/packages/render/src/render-system-extract.ts:1666)。

#### PERF-02 · 地图、碰撞、寻路与 HUD 的负载预算〔部分实现 / P1〕

- **原版**：原版已有分块重建队列和内容/LOD优先级；新引擎承担这些需求后需要自己的性能预算。
- **当前新版**：新版逐暴露体素面生成近景，跨块时重建全地图远景高度网格；玩家/AI/车辆周围生成碰撞块；AI 同步寻路；HUD每帧写文本与整组位置JSON。6ms/7ms队列预算在单块处理后检查，不能保证单次工作不超时。
- **剩余工作**：按采样结果安排分块/碰撞缓存与调度、寻路预算、HUD变更更新和调试数据按需输出；避免盲目减少人数或删远景。
- **验收条件**：移动跨块、持续破坏、满员重寻路时不出现不可接受长帧；用性能记录证明每项优化收益，不能只凭代码推断瓶颈排名。
- **证据等级**：本轮源码确认风险；未将所有候选项都认定为已测主瓶颈
- **来源**：[js/voxel-world.js:3010](F:/voxel-frontline-battle/js/voxel-world.js:3010)；[forgeax/assets/gameplay/battle.plugin.ts:38](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:38)；[forgeax/assets/gameplay/voxel-map.ts:50](F:/voxel-frontline-battle/forgeax/assets/gameplay/voxel-map.ts:50)；[forgeax/assets/gameplay/native-physics.ts:13](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-physics.ts:13)；[forgeax/assets/gameplay/native-arena.ts:90](F:/voxel-frontline-battle/forgeax/assets/gameplay/native-arena.ts:90)；[forgeax/assets/ui/ui.plugin.ts:146](F:/voxel-frontline-battle/forgeax/assets/ui/ui.plugin.ts:146)。

#### INPUT-01 · 失焦、锁鼠标与恢复操作〔未验收 / P1〕

- **原版**：原版第一人称控制同样需要锁定鼠标，但迁移后的引擎输入与游戏输入需要协调。
- **当前新版**：本轮 QQ 自动化有窗口失焦时锁鼠标失败的记录，此时点击未形成射击；恢复前台聚焦后连续13发及R装填通过。该环境相关结果不能直接认定为用户全部射击/换弹故障的根因。
- **剩余工作**：检查锁鼠标请求的唯一归属、失败后的可见提示、重新聚焦/点击恢复、暂停及切换模式后的输入状态。
- **验收条件**：从入场、Escape暂停、切换窗口再返回均能恢复瞄准/射击；锁定失败时有提示且不会悄悄吞掉操作。
- **证据等级**：本轮环境相关实测；用户具体复现仍待验收
- **来源**：[forgeax/assets/gameplay/battle.plugin.ts:34](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:34)；[forgeax/assets/gameplay/battle.plugin.ts:87](F:/voxel-frontline-battle/forgeax/assets/gameplay/battle.plugin.ts:87)；[forgeax/artifacts/parity-audit-2026-09-14/qq-actions-performance.json](F:/voxel-frontline-battle/forgeax/artifacts/parity-audit-2026-09-14/qq-actions-performance.json)；[forgeax/artifacts/parity-audit-2026-09-14/qq-actions-retry.json](F:/voxel-frontline-battle/forgeax/artifacts/parity-audit-2026-09-14/qq-actions-retry.json)。

## 补齐顺序与发布条件

1. **先恢复可玩性**：处理性能材质热点、远景、枪械后坐/弹道/伤害、装填闭环与键位一致；修正AI射速和载具爆炸范围伤害。每项要有实战证据。
2. **再恢复单局玩法**：整备与实战道具对应、兵种/动作、倒地救援、部署点、小队、车辆武器与乘员、建造；让所有保留模式从进入到胜负到再次开局完整可达。
3. **接齐产品闭环**：按模式匹配/建房、真人替换AI、双端同步、完整HUD/结算、原战争模式经济/档案与设置、地图/编辑器。
4. **完成交付验收**：统一机器/画质/像素的性能基准，全人数、持续破坏、载具和多人长时运行；从最终包验证六模式、反复进退、资源释放及Studio开发闭环。

P0 表示阻碍替换成立或核心可玩性，P1 表示重要的原版保留功能，P2 为后续表现优化。优先级不代替用户已确定的产品范围。

## 不应混入旧功能缺失的内容

- 旧 Three.js 渲染和旧物理解算的逐项复刻：按用户要求，表现与物理以造化功能为准。
- Teardown 等级的全部细体素、结构坍塌等远期愿望：未证明原版已实现的部分，不算原版功能倒退。
- 计划中的单人搜打撤完整系统：属于新玩法开发，不列为原版已实现功能；仍遵守单局体验、无长期养成、无武器配件、品质区分装备。
- 此前明确删除的准备房、模式页左下返回按钮等交互：不作为需要恢复的功能。

- 原 PVP 源码标明 8v8 真人房、总计 16 名真人上限；新版本 64 个战斗单位的测试不能换算为 64 人联机能力。
- 个人城区生成分支属于原自由混战地图内容；不能因为文件名 pve-district 就称原版已完成独立搜打撤。
- 大征服与小型战斗的 C4、投掷物池及职业规则不同，必须分别对照。

尤其：原战争模式的购买/战绩是历史功能对照，不要求未来单人搜打撤加入长期养成；该单人模式仍遵守单局体验、品质装备、无配件的既定要求。

## 审计方式与工程范围

- 原版大征服已实机进入并采样；原版所有功能没有逐一重新实测。
- 新版本本轮重点实测大征服默认武器、友方吉普、QQ帧率；其他模式完整比赛、全部武器/兵种/车型、多人和发布包未完成整套验收。
- 历史核心满员推进失败仍保留；没有以本轮可见性或首发射击测试将其关闭。
- 同浏览器下的短采样不是性能承诺，帧率需在统一视角、内部像素和负载条件下正式验收。

本轮未修改游戏玩法、模型、背景、UI或引擎，只新增审计与复测材料。

Need / Use / Entry / Proof / Defer：需要完整替换差异→使用现存源码与真实QQ→以forge.json插件为入口→来源、操作、CPU采样作为证据→修复与未覆盖整局验收留给后续实施。

Template Disposition：运行代码、角色、场景、网格材质、灯光、UI及原测试全部KEEP（本轮只读审计，保留当前体素战争身份与用户已确认界面）；不引入模板内容或模板标识。
