# 2026-09-14 迁移验收修订

用户确认：渲染和物理表现采用造化引擎能力；保留游戏功能，接入新的战术 AI、载具和缺失模式。

Need: 玩家、AI、载具共用碰撞与实体时钟。
Use: Rapier 3D / CharacterController / derived voxel shapes / World Update。
Entry: skills/forgeax-engine-physics/SKILL.md；本地 physics/physics-rapier3d 源码。
Proof: 真实 WASM 碰撞测试、各模式浏览器运行、退出重入与资产清理。
Defer: 不接入外部语言模型 NPC 服务；即时战术决策由游戏插件拥有。

Template Disposition: 延续既有原创资源和 UI；渲染使用原生管线；角色、地形与车辆通过原生 ECS/资产；以新引擎物理替换旧碰撞控制器；保留原版计分和回合规则。

不再以旧渲染器逐像素对齐或旧物理解算逐帧一致作为迁移门槛。模式、操作和玩法完整性仍需逐项验收。

## 音频与暂停的原生接入

Need: 音效、动态物体暂停、测试与生产引擎一致。
Use: AudioSource/AudioListener/AudioEngine；ECS replaceSystem/runIf 包装原 PhysicsStepSimulation 的调度条件，保留引擎自身求解函数。
Entry: forgeax-engine-audio/SKILL.md；本地 devkit/src/host.ts 默认音频插件；physics-rapier3d 系统描述符。
Proof: 真实 WASM 测试暂停、恢复与速度保留；浏览器 AudioEngine 状态；类型与测试解析指向本地引擎。
Template Disposition: 不重复安装 Host 默认插件，不创建第二 AudioContext，不接入另一个物理循环。

核心地图补充：执行原 bases.js 的基地建造步骤并导出计划基地、出生点和核心坐标，不能使用未写入的 _allyBasePos 的猜测值。陆地导航和载具出生排除深水。
## 地图、战术 AI 与载具验收范围

Need: 原地图不漏作者布局；新 AI 使用原生实体沿可行地形/滑索行动；核心前哨和车载武器具有真实状态。
Use: 原版离线作者数据、原生 Mesh/Transform/CharacterController、World 时间、分层 A*、CoreSpawnRules、VehicleArmament。
Entry: game plugin 下 native-arena / tactical-navigation / core-spawn-rules / native-vehicles / vehicle-armament。
Proof: 4 张固定种子小型地图重复离线导出逐字节一致；原版 290 文件未变；真实 Rapier 测试 6 条滑索往返以及单名进攻 AI 跨图摧毁核心；车辆独立弹药/冷却/过热测试；浏览器实际驾驶和换座射击。
Template Disposition: 六种模式使用同一原生战场、同一物理后端及现有 UI 流程。原有 renderer、旧碰撞循环和旧 AI runtime 均未放回运行入口。

单名进攻 AI 的核心用例会禁用其余 AI，以隔离地图通路、射击优先级及胜负判断；不能用它声称 50 人无人干预长局已经通过。完整队伍对战、联机、编辑器、最终性能与 Studio 开发验收继续按 replacement-status.json 保留未完成状态。
