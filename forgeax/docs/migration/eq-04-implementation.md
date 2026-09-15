# EQ-04：散布、霰弹与步兵发射器

## 能力采用计划
- Need：恢复原版两套武器的腰射/瞄准散布、霰弹独立弹丸与单发耗弹、自动/半自动射击，校正 RPG 原生弹道、碰撞和伤害。
- Use：现有 Engine ECS、Standard 渲染、Rapier 动态刚体/CCD、体素扫掠、装备和伤害 owner、导入的原版武器数据。
- Entry：battle.plugin.ts、native-equipment.ts、equipment-projectiles.ts、native-arena.ts、native-vehicles.ts；新增纯射击规则与共享射线结算。
- Proof：原版参数对照、逐弹丸遮挡/伤害测试、真实 Rapier 发射器测试、类型检查、生产构建及 QQ 浏览器实操。
- Defer：EQ-07 后坐力、EQ-08 曳光/枪口火光、EQ-09 换弹动画、EQ-10 ADS 姿态、EQ-11 距离衰减/分区护甲，以及其他清单条目。

## Template Disposition
- Runtime/controller code: ADAPT — 保留游戏生命周期，补齐枪械射击和导弹判定。
- Player character and animation: KEEP — 用户指定原版角色和武器手臂。
- Scene entities and composition: KEEP — 用户项目既有战场。
- Meshes and materials: ADAPT — RPG 弹体沿飞行方向显示，沿用 Engine 材质和已有爆炸效果。
- Lighting and environment: KEEP — 用户指定新引擎环境。
- UI and copy: KEEP — 保留现有 UI 布局与交互；仅扩充只读对局记录供验证。
- Template tests: KEEP — 保留已完成装备回归，增加 EQ-04 对照与原生验证。
- Residual template identifiers allowed at delivery: none.

## 规则来源
- 大征服：../js/weapons.js fireInterval / spreadFromAccuracy / adsSpreadMul / _fireRays。
- 小型战斗：../modes/small-battle/js/weapons.js _fireRays。
- RPG：../js/vehicles.js WEAPON_DEFS.rpg / _updateProjectiles，../js/main.js projectileBlastRadius / damageInfantryBlast / onProjectileUpdate。
- 使用新引擎重力积分；不恢复旧 Three.js 渲染和第二套弹道积分器。

## 最终实现
- 普通枪械从导入的武器定义读取散布和弹丸数量。大征服使用 accuracy → 0.12 × (1 - accuracy / 100)，以及狙击镜 0.03、光学镜 0.31、其他瞄具 0.6 的 ADS 系数；显式 spread / adsSpread 优先。小型战斗使用各枪原有 spread / adsSpread。
- 随机分布沿用原版 XYZ 独立扰动后归一化；保留零散布。两套原版 _fireRays 源码在测试中实际执行，对所有导入武器及腰射/瞄准端点逐颗比较结果。
- Remington 870 一发消耗一颗弹药、发出一次枪声、进入一次射击间隔，并生成 8 颗独立弹丸，每颗基础伤害 14。每颗分别查询体素、遥控设备、步兵、载具和核心，选择最近命中后再提交伤害。目标/武器因击杀升级改变时，当前整发仍保留发射时的武器定义。
- 保留自动连射、半自动一次按下只射一发；沿用原 RPM / 秒间隔转换，换弹、准备阶段、交互、装备占用和死亡期间不能开枪。
- RPG 继续由单一 Rapier 原生动态刚体推进：38 米/秒初速、1.5 米/秒²重力、7 秒寿命，无空气阻尼；飞行姿态随弹道，碰撞前不结算伤害，到期消失不自行爆炸。原版用方向归一化近似重力，新版按用户要求使用造化真实重力积分，长距离曲线并非逐浮点复刻。
- RPG 扫掠碰撞选择前方最近的墙体、步兵或旋转载具，防止穿越薄墙或发射点落到墙后。修正 Rapier 派生碰撞体中心偏移：碰撞几何以弹体中心为原点，避免初始化时额外偏移 0.09 / 0.10 / 0.09 米。
- RPG 直击装甲使用原版 150 点/装甲系数；步兵为 3.2 米范围、60 点基础线性衰减、范围内最低 12 点；不会把同一枚火箭的直击和范围伤害叠加到载具，也不额外伤害旁边未击中的车辆。己方火箭不自伤，步兵范围伤害的队伍/距离规则沿用原版。击中世界时以 1.45 米体素中心半径破坏，接入当前原生破坏和音画 owner。
- 已完成的六类投掷物和 C4 / 黏弹遥控继续走原有 owner；子弹和 RPG 爆炸仍能损伤遥控设备。没有替换角色、手臂、背景、地图或界面布局。
- 对局只读投影增加最近一发的方向、散布、弹丸命中类型/距离及最近 RPG 状态；最多保留一发记录，不记录无限历史，也不提供修改游戏状态的调试入口。

## 验证与证据
- 类型检查通过；102 项测试 / 15 个文件全部通过，含本次新增 19 项：artifacts/eq-04-tests.log。
- 测试包含原版源码对照、近距离 8 × 14 = 112 点霰弹伤害、距离造成部分命中、ADS 收束、射程截止、墙/单位/设备/旋转载具/核心的最近命中、半自动/连发、射击状态门控、枪械升级中保持整发规则、真实 Rapier 初速/下坠/寿命、碰撞直击与范围伤害、薄墙和枪口防穿透、RPG 库存与退出清理。
- 生产构建通过：artifacts/eq-04-build.json。实际服务入口为 http://localhost:8766/。
- QQBrowser 21.8 / Chromium 138，默认 GPU、隔离存档、1805 × 1083 CSS、DPR 1.5：11 个步骤通过，零页面/控制台错误。实操涵盖大征服 AK-74 腰射连发与 ADS、USP 持续按住单发、RPG 发射/碰撞/R 装填/再射；小型 TDM 的 Remington 870 腰射和 ADS、SVD ADS，以及离局重进状态清理。
- 浏览器证据：artifacts/eq-04/qq-weapon-shots.json 与同目录 11 张截图；可复跑 scripts/check-weapon-shots.cjs。QQ 以无界面自动化运行，真实页面鼠标/键盘操作，不冒充用户当前可见窗口验收。状态采集与截图先后执行，不声称来自同一渲染帧。
- 整次浏览器会话渲染提交计数 2 → 1464。短采样的大征服平均帧间隔约 79.9 毫秒、小型约 52.4 毫秒；只是本次操作现场记录，性能问题仍未完成，不能据此宣称帧率优化或完整替换成立。

## 范围边界
EQ-04 关闭；后坐力 EQ-07、曳光/枪口反馈 EQ-08、换弹动画 EQ-09、ADS 动画 EQ-10、伤害衰减/分区护甲 EQ-11 以及 AI、地图、性能、联机等仍按原清单跟进。当前武器命中沿用现有身体判定和伤害 owner，本次没有将它们误记为完整旧版分区伤害。小型模式没有原版 RPG，因此不新增该装备入口。

