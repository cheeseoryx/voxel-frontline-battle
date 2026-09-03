# 移动、命中反馈与击杀播报 — 功能方案

日期：2026-09-03  
状态：**实施中（按键修正：趴下为 Z；本轮不做探头）**  
对标：BattleBit Remastered 的跟手密度（不是 254 人规模）

## 背景

当前步兵只有冲刺 / 蹲 / 跳 / 滑索（`js/player.js`）。命中是胸部附近的单球（AI 半径 1.0–1.25，`js/ai.js` `_raycastTeam`；远程玩家半径约 1.15，`js/pvp.js` `raycastRemote`），没有爆头。准星已有开火 / 命中 / 击杀闪（`ui.js` `flashCrosshair`），连杀靠 toast（`ai.js` `_registerPlayerKill`）。没有屏幕角落的击杀播报列表。64 名 AI 同场时，若把所有 AI 互杀都刷进播报会不可读。

本轮只改 **本地玩家手感 + 命中可读性 + 信息层**。不做延迟补偿、附件系统、语音。

## 目标

1. 对枪时能用身位（蹲、趴、滑、翻越），而不是只会站着strafe。
2. 打中头、胸、四肢手感不同，击倒和击杀准星有明确区别。
3. 自己、小队、附近的击杀/击倒能在 HUD 上扫一眼看懂。

## 非目标（本轮不做）

- 远程插值、命中回滚、专用服
- 枪械附件、压制系统
- AI 自己趴/滑/探头（AI 只作为被命中的身体，沿用现有蹲姿）
- 漂浮伤害数字
- 完整死亡回放（倒地击杀卡已有，本轮最多加 0.8s 看向击杀者）
- 改 Q 标记、E 交互、X 兵种技、V 冲刺位移的键位语义

## 决策记录

- **Ctrl 继续是蹲**。冲刺中按 Ctrl = 滑铲（BattleBit / 主流 FPS 肌肉记忆）。**Z 切换趴下**。不把蹲改成点按切换，避免和建造/菜单抢键。
- **本轮不做探头**（原 Left Alt + A/D 方案取消）。Q 是标记、E 是交互/上车、X 是兵种技，不能抢。
- **翻越：移动中按空格，对腰高体素自动翻**。纯跳仍保留；翻越锁定 0.32–0.40s 位移，期间不能射击。
- **体力条约束冲刺 / 滑铲 / 翻越**，走路与蹲走回复。避免无限滑铲。
- **命中箱三截：头 / 躯干 / 四肢**，胶囊相交，不引入 ragdoll 骨骼。倍率进 `VF.Feel.hitboxes`。
- **征服里把人打进倒地算「击倒」**；流血死亡或跳过倒地才算「击杀」。准星击杀闪在击倒时就触发（玩家需要立刻反馈）。
- **击杀播报默认过滤**：本地玩家相关、小队、自己造成伤害的目标、以及 28m 内。不播全图 AI 互杀。
- **不改现有 `Scoring.confirmKill` 计分公式**，播报只订阅事件，不重复加分。

---

## 1. 移动

### 1.1 姿态与速度（相对站立走速）

现有：`MOVE_SPEED = 8.5`，`sprintMul = 1.5`，`crouchMul = 0.48`，`adsMul = 0.55`（`feel-config.js` `playerMove` + `player.js` 常量）。

| 姿态 | 水平倍率 | 眼高 | 胶囊高 | 能否冲刺 | 射击 |
|------|----------|------|--------|----------|------|
| 站立走 | 1.00 | 1.85 | 2.00 | 可以（耗体力） | 正常 |
| 冲刺 | 1.50 | 1.85 | 2.00 | — | 散布略增（已有 hip spread，本轮只加体力） |
| 蹲 | 0.48 | 1.05 | 1.15 | 否 | 正常 |
| 趴 | 0.22 | 0.38 | 0.48 | 否 | 允许，起身 0.40s 内不能冲刺 |
| 滑铲 | 1.35（相对走速） | 蹲眼高 | 蹲高 | 过程中不可再冲 | 允许但散布按 hip×1.35 |
| 翻越 | 锁定位移 | 过渡 | 站立 | 否 | 否 |
| 探头 | 当前姿态速度×0.85 | 不变 | 不变 | 否 | 正常 |

以上新字段全部进 `VF.Feel.playerMove`，F10 可调。

### 1.2 状态机

```
stand ──Ctrl──► crouch ──Z──► prone
  ▲                │              │
  └──可站起─────────┴──────Z/空格──┘
  │
  └─冲刺中 Ctrl──► slide ──0.45s 或撞墙──► crouch
  └─移动+空格+前方腰高──► vault ──0.36s──► stand
```

互斥：

- 载具 / 滑索 / 倒地 / 急救读条 / 修车读条：忽略滑、趴、翻。
- 趴时不能滑、不能翻越、不能探头。
- ADS 时可以蹲/趴，不能滑、不能翻越。
- 头顶不够时不能从蹲/趴站起（沿用 `_canStand()`，趴站起先到蹲再检测站立）。

### 1.3 键位

| 动作 | 键 | 备注 |
|------|----|------|
| 蹲 | Ctrl 按住 | 保持现状 |
| 滑铲 | 冲刺且 `onGround` 时按下 Ctrl | 进入滑铲，松 Ctrl 不中断，持续到结束 |
| 趴 | Z 切换 | 蹲或站都可趴；再按 Z 或空格起身（空格优先起身，不跳） |
| 跳 | 空格 | 站/蹲且可站起时跳（现状） |
| 翻越 | 空格 | 满足翻越条件时吞掉跳跃 |
| 冲刺 | Shift | 有体力才加速；耗尽降为走 |

V 冲刺位移（`skills.js` dash）不动。

### 1.4 滑铲

- 条件：`onGround`、未趴、未 ADS、冲刺中、体力 ≥ 20。
- 时长 0.45s，方向为按下瞬间的水平速度方向（无输入则面朝）。
- 立即扣 28 体力；期间胶囊用蹲高；结束强制蹲。
- 撞实体/载具提前结束。
- 第三人称：`soldier.js` 在蹲姿上再压低并拉长 0.15（仅玩家与远程同步的 `slide` 标志）。

### 1.5 翻越

- 条件：`onGround`、未趴、未 ADS、水平速度 > 2.5、体力 ≥ 18、空格按下（非 repeat）。
- 探测：脚前 0.85m 水平射线，障碍顶面相对脚高 **0.55–1.28m**（体素一层到一层半），落点前 0.7m 为可走空位且头顶可站。
- 失败则走原跳跃。
- 成功：0.36s 沿抛物线到落点，锁视角 pitch 不超过 ±12°，`isChanneling` 同类：武器 `tryFire` 直接 return。
- 扣 18 体力。

楼梯体素已有自动 step-up（`STEP_UP = 1.05`），翻越不替代爬楼梯。

### 1.6 探头

- 相机相对站立胶囊中心水平偏 0.32m，roll ±7°。
- 与碰撞：先做短射线，被墙挡住则探头幅度降到不穿墙。
- 同步：远程/AI 第三人称略旋转躯干即可，不做完整侧身骨骼。

### 1.7 体力

```
staminaMax: 100
sprintDrainPerSec: 16
slideCost: 28
vaultCost: 18
regenPerSec: 22
regenDelaySec: 0.55
```

HUD：生命条上方或准星下不常驻；仅低于 40 或正在消耗时显示细条（避免常驻噪音）。

### 1.8 网络同步（最小）

`pvp.js` 远程状态已有 `crouch`。本轮加 `prone`、`slide`（bool）。不预测滑铲，guest 只播姿势。

---

## 2. 命中反馈

### 2.1 命中箱

相对脚底（mesh/object.position）：

| 部位 | 相对脚底中心 Y | 半径 | 伤害倍率 |
|------|-----------------|------|----------|
| 头 | 站 1.62 / 蹲 0.92 / 趴 0.22 | 0.22 | 1.75 |
| 躯干 | 站 1.10 / 蹲 0.62 / 趴 0.14 | 0.32 | 1.00 |
| 四肢 | 站 0.55 / 蹲 0.32 / 趴 0.10 | 0.28 | 0.72 |

规则：沿射线由近到远测三球，取最近命中。载具内单位仍不可打（现状 `vehicleId != null` skip）。

改造点：

- `AI.prototype._raycastTeam` 返回 `{ enemy, unit, point, dist, part }`
- `Pvp.raycastRemote` 同样返回 `part`
- 玩家受击：`weapons` / AI 射击玩家时用同一套函数（抽到 `js/hitboxes.js` 或 `soldier.js` 导出 `raycastSoldier(origin, dir, range, pose)`），避免三套半径。

趴下时三球几乎贴地，避免还能打到「站立头高」。

### 2.2 伤害结算

```
final = round(baseRangeDamage * partMul * ghostMods)
```

`_applyGhostDamageMods` 仍在部位倍率之后。护甲吸收逻辑不变（`player.takeDamage`）。

`Scoring.recordDamage` 增加可选 `part` 字段，供击杀卡显示「爆头」。

### 2.3 射手反馈

在现有 `flashCrosshair` 上扩展 kind：

| kind | 何时 | 视觉 |
|------|------|------|
| fire | 未命中敌兵 | 现状红十字 |
| hit | 躯干/四肢 | 现状红 × |
| head | 头部且未击倒 | 白×转橙，略大 |
| kill | `_shotKill`（含击倒） | 现状金 × + 环 |

音频：躯干 `hit`，头 `hit_heavy`，击倒/击杀保持 `kill`。

**不做** 屏幕飘字。爆头只靠准星颜色 + 更脆的音效。

载具击中、跳弹仍走现有 toast「跳弹」，不进准星击杀闪。

### 2.4 受击反馈

保留 `_applyHurtFeedback`（闪红、轻震）。新增：

- HUD 边缘 **方向指示**（8 向楔形，0.7s），由 `fromPos` 相对 yaw 计算。倒地界面已有击杀卡，站立时才显示楔形。
- 爆头受击：闪红略强（`hurt.headMul = 1.35`），不额外眩晕。

### 2.5 击倒 vs 击杀（准星）

`AI._damageUnit` 已返回 `{ killed, downed, dmg }`。`weapons.js` 在 `result.killed` 时设 `_shotKill`（击倒也是 killed:true）。保持这一点：打倒就要金闪，不要等流血结束。

远程 PVP：`dealDamageToRemote` 若 hp 过 0，本轮按 kill 闪（对端倒地由对端 revive 处理）。

### 2.6 抽共用命中

新建 `js/hitboxes.js`（IIFE，`VF.Hitboxes.raycast(entity, origin, dir, range)`）。`entity` 提供 `position`、`crouch`、`prone`、`radiusScale`（heavy AI 1.15）。

`index.html` 加在 `soldier.js` 之后、`weapons.js` 之前。

---

## 3. 击杀播报

### 3.1 表现

- 屏幕 **右上**，记分板/击杀信息下方，宽约 280px。
- 最多 **6** 行，新行从上插入，5.2s 淡出。
- 一行：`击杀者名` + 武器短图标 + `受击者名`；爆头加小菱形；击倒用灰字「击倒」，击杀用白字。
- 本地玩家名字高亮（己方蓝、敌方红，沿用 HUD 色）。
- 载具撞击：武器位显示「撞击」而不是枪名。
- 不显示助攻行。

### 3.2 事件源（只订阅，不算分）

统一 `VF.UI.pushKillFeed(entry)`，`entry`：

```
{
  killerId, killerName, killerTeam,
  victimId, victimName, victimTeam,
  weaponId,   // 'vehicle-ram' | gadget id | gun id | 'bleed'
  part,       // 'head' | 'torso' | 'limb' | null
  kind,       // 'down' | 'kill'
  at
}
```

接入点：

| 来源 | 文件 | 何时 |
|------|------|------|
| 枪打 AI | `ai.js` `_damageUnit` 进入 downAI / 死亡 | down 或非征服死亡 |
| 流血/放弃 | `revive.js` `_finalizePlayer` / `finalizeAI` | kind=kill，killer 用 lastDamager |
| 枪打远程 | `pvp.js` 远端 hp≤0 | 本端乐观一条 |
| 载具撞击 | `vehicles.js` `vehicle-ram-infantry` | 已 emit，main.js 钩子里补 feed |
| 爆炸/C4 | `gadgets.js` 击杀路径 | 有 killed 时 |
| AI 互杀 | `_damageUnit` fromPlayer=false | **仅当** victim 为小队或距玩家 < 28m |

`Scoring.confirmKill` 仍只在「票/分数意义的击杀」调用（流血确认）。播报比计分更早出现（击倒即出），避免等 28s。

### 3.3 过滤

`pushKillFeed` 内：

1. killer 或 victim 是本地玩家 → 必显示  
2. 任一方是小队成员 → 显示  
3. victimId 在本地 10s 伤害记录里 → 显示  
4. 与玩家距离 < `Feel.killfeed.rangeM`（默认 28）→ 显示  
5. 否则丢弃  

同 `lifeId` 的 down 后再 kill：更新同一行（击倒→击杀），不占两行。

### 3.4 与现有 toast 连杀

保留 `_registerPlayerKill` 的「双杀/三杀」toast，位置仍偏下。播报不重复写「三杀」大字。

### 3.5 倒地看向击杀者（可选小项）

若 `fromPos` / killer 网格存在，倒地镜头 0.8s 内 yaw 转向来源，然后交给现有倒地相机。不做自由死亡观战。

---

## 4. 集成点

| 文件 | 改动 |
|------|------|
| `js/player.js` | 姿态状态机、体力、滑/趴/翻/探头、眼高与胶囊 |
| `js/soldier.js` | 趴/滑第三人称；导出给 hitboxes 的高度表 |
| `js/hitboxes.js` | **新增** 部位射线 |
| `js/ai.js` | 改用 Hitboxes；feed 事件 |
| `js/pvp.js` | 同步 prone/slide；remote 用 Hitboxes |
| `js/weapons.js` | part 倍率；flashCrosshair('head') |
| `js/ui.js` + `index.html` + `style.css` | 体力条、探头无需 UI、击杀播报、爆头准星、受击方向 |
| `js/feel-config.js` | `playerMove` / `hitboxes` / `killfeed` |
| `js/main.js` | ram 事件 → feed；script 顺序 |
| `js/revive.js` | 流血击杀更新 feed 行 |
| `js/gadgets.js` | 爆炸击杀 feed |
| `index.html` 教程 | 一行键位：Ctrl 蹲/滑、Z 趴、空格翻越 |

`feel-tuner.js` 为本轮新字段加一组滑杆（可选，若改 tuner 成本高可第二步）。

---

## 5. 验收

移动

- [ ] 站立冲刺中点 Ctrl：滑铲落地成蹲，体力下降，不能连滑两次（体力不够）
- [ ] C 趴下眼高明显降低；头顶矮掩体可趴入，站起被挡住时停在蹲
- [ ] 腰高墙面冲上去按空格：翻过且不跳飞；对 2m 墙仍是跳
- [ ] Alt+A 探头不穿墙；Q 仍标记、E 仍上车
- [ ] 载具内上述动作全部无效

命中

- [ ] 打头：橙爆头准星 + 更高伤害；打腿：红命中、伤害更低
- [ ] 趴着的敌人头箱在贴地，站着打原头高打不中
- [ ] 击倒金闪；友军命中仍只有青火花、无红×
- [ ] heavy AI 箱体略大，不回到现在 1.25 整球

播报

- [ ] 自己击倒敌人：右上出现一行，流血死后同行变成击杀
- [ ] 地图另一侧两名无关 AI 互杀：不出现
- [ ] 小队友军击杀：出现
- [ ] 载具撞击：武器位为撞击
- [ ] 最多 6 行，旧行顶出

回归

- [ ] 滑索、冲刺位移 V、兵种 X、建造 B/N、倒地救援不受影响
- [ ] F10 移动速度仍控制走/冲/蹲

## 6. 风险

- 翻越在体素台阶上可能和 `STEP_UP` 抢输入：优先 step-up（已贴合楼梯）时不进翻越。
- 三球命中比单球「更难打中」：躯干半径 0.32 小于现在 1.0，需要把躯干半径收到 **0.38–0.42** 若手感过瘦。验收时以「胸对胸 30m 点射」为准，宁可先略宽再收。
- 击杀播报过滤过严会导致战场「好安静」：`rangeM` 做成 Feel 项，默认 28，可调到 50。
