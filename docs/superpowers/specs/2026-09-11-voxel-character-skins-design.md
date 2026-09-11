# 体素角色外观（Soldier01–04）接入 — 功能方案

日期：2026-09-11
状态：**待实施**
资产来源：`assets/Roles/体素动作.zip`、`assets/Roles/另外三个角色.zip`（UE 5.5.3 导出）

## 背景

新增美术资产共 7 个 GLB：4 个角色蒙皮（`Soldier01~04_Skin.glb`）+ 3 个动作（`Soldier01_Walk_120`、`Soldier01_Run_245`、`Soldier01_Pick`）。

现有游戏里的士兵**全部是程序化体素盒子**（`js/soldier.js` 的 `buildVanguard` / `buildMedic` / `buildGhost` / `buildEngineer`），没有任何骨骼角色接入。`js/soldier-glb.js` 是上一轮 Mixamo `Soldier.glb` 试点的遗留文件——从未写进 `index.html`，整个 FBX→GLB retarget 分支也因 rest-pose 冲突被注释掉了。

### 资产体检结论

已通过解析 GLB 的 JSON chunk + 正向运动学解算验证：

| 事实 | 数值 | 影响 |
|---|---|---|
| 骨架 | 四个角色**完全相同**的 3ds Max Biped，33 骨，根 `Root_zhujue01` / `Bip001` | Soldier01 的动作可直接套到 02/03/04，**不需要 retarget** |
| 单位 | 米制，身高 1.8m（`Bip001-HeadNub` y=1.788） | 与游戏世界尺度一致，无需缩放 |
| 朝向 | **+Z**（`Bip001-L-Toe0` 相对 `Bip001-L-Foot` 为 +0.128 Z） | 与盒子兵同向，`SoldierFacing` 沿用 `rotation.y = π` |
| 根位移 | 三个 clip 的 `Root_zhujue01` translation 全程为 0 | 原地动画，可直接接 `updateLocomotion` |
| 循环 | 三个 clip 的 `Bip001` 首帧 == 末帧 | 可无缝循环 |
| 挂点 | `Dummy001_R-Hand`（右手）、`Dummy002_L-Hand`（左手）、`Dummy001`（背部，Spine1 后方 0.22m） | 武器可挂骨骼，网格内**不含武器** |
| 面数 | 3498–4759 三角面 | 轻量，不构成性能问题 |
| 贴图 | 01 是 1024²（879KB）；02/03/04 是 **4096²（12–14MB）** | 三个角色 40MB，必须重采样 |

**动作只有 Walk(1.2s) / Run(0.8s) / Pick(1.6s) 三个**——没有 Idle、开火、蹲、死亡。

绑定姿势是 A-pose（双手外撇至 x=±0.536），不能直接当站姿。FK 解算对比三个 clip 的首帧后确定：**`Pick` 第 0 帧是唯一可用的站姿**——双脚落平（L/R foot y = 0.158/0.157，与绑定姿势 0.149 一致），手臂自然下垂（x=±0.37/0.41）。Walk 首帧左脚抬起 27cm、Run 首帧整个人前倾，都不可用。

## 目标

1. 玩家可以在部署页为自己挑选角色形象（原盒子兵 + 四个体素角色）。
2. 所选形象在**所有展示位**生效：部署页站台、出击演出、PvP 同步屏预览。
3. 联机时**对手/队友屏幕上的你**也是所选形象。
4. 资产总量压到可以进 git、可以上 Netlify 的规模。
5. 任何加载失败都静默回退盒子兵，不出现空模型。

## 非目标（本轮不做）

- **战斗中的自己**——游戏是纯第一人称，战斗里看不到自己身体（只有 `createViewModel` 的第一人称手臂，那是另一套程序化模型，不在本轮范围）。
- **AI 与敌人**——单机 AI、敌方单位一律保持现有盒子兵。
- **开火 / 蹲 / 死亡动画**——资产没有这些 clip，不做任何模拟或凑合。这是资产限制，不是实现取舍。
- 第一人称手臂（viewmodel）的替换。
- 角色与兵种绑定——角色形象与兵种完全解耦，任何形象可配任何兵种。

## 方案

新建 `js/soldier-voxel.js` 承载全部体素角色逻辑，在 `VF.Soldier` 的工厂函数里按 `skinId` 分发。盒子兵保持默认路径且永远可回退。

否决的替代方案：改造 `js/soldier-glb.js`（一半篇幅是本方案用不上的 retarget 死代码）；各调用点自行判断（5 处散落的 if + 重复回退逻辑）。

---

## 1. 资产管线：`scripts/bake-roles.js`

原始资产有严重冗余：三个动作文件各自带了一份完整网格 + 879KB 贴图，而动作数据本身只有几十 KB。

### 产物

| 路径 | 内容 | 预计大小 |
|---|---|---|
| `assets/characters/soldier_anims.glb` | 仅 33 节点骨架 + `Walk` / `Run` / `Pick` 三个 clip，剥除 mesh / skin / images / materials | ~80KB |
| `assets/characters/soldier01.glb` … `soldier04.glb` | 仅蒙皮网格 + 骨架，贴图统一重采样到 1024²，剥除 animations | ~1.4MB × 4 |

**合计约 5.7MB**（原始 44MB）。`assets/*` 在 netlify.toml 里是 `max-age=604800`，且路径是全新的，无缓存冲突。

### 脚本职责

1. **动作库**：从三个动作 GLB 中各取 `animations[0]`，重命名为 `Walk` / `Run` / `Pick`，连同它们引用的 accessor / bufferView 数据合并进一个只含骨架节点的 GLB。three.js 的 `AnimationClip` track 按**节点名**寻址，因此动作库与蒙皮文件只要骨骼名一致即可跨文件套用（与仓库里 `AnimationLibrary_Godot_Standard.glb` 同款做法）。
2. **贴图重采样**：把 02/03/04 的 4096² PNG 降到 1024²，替换回 GLB 的 image bufferView。像素重采样 shell out 给 Python + Pillow（本机 12.2.0 已装）；Pillow 缺失时脚本明确报错并中止，不产出半成品。贴图是逐面小色块图集，4096→1024 后每块仍有 20–40 像素，无可见损失。
3. **自检**：产出后校验每个 skin 的顶点数、骨骼名列表、包围盒与原始一致；动作库的 clip 数 == 3 且 track 引用的节点名全部存在于 skin 骨架中。任一项不符则删除产物并非零退出。
4. **收尾提示**：照 `scripts/bake-assets.js` 的惯例，提示 bump `index.html` 的 `?v=` 缓存令牌。

脚本**写临时文件，全部校验通过后才替换正式产物**，失败不留破损输出（沿用 `bake-props.js` 的教训）。

原始 zip 与解压出的大文件留在 `assets/Roles/`，加进 `.gitignore`（与现有 `assets/Anims/`、`assets/Soldier.glb` 的处理一致）。

---

## 2. 运行时模块：`js/soldier-voxel.js`

### 对外接口

```
VF.SoldierVoxel.SKINS                              // 元数据数组：{id, nameZh, file}
VF.SoldierVoxel.preload(skinId) -> Promise<bool>   // 懒加载，结果（含失败）缓存
VF.SoldierVoxel.isReady(skinId) -> bool
VF.SoldierVoxel.create(skinId, {classId, team})    // -> root，未就绪返回 null
VF.SoldierVoxel.drive(root, dt, state)             // 由 updateLocomotion 委托
```

`SKINS` 的 id 为 `'voxel01'` … `'voxel04'`。中文名在实现阶段渲染出四个角色的预览图、由用户确认后填入；在此之前用 `体素兵 01` … `04` 占位。

### 加载策略

- **动作库启动即预载**（80KB，可忽略）。
- **蒙皮按需加载**：部署页打开时并行预载四个（5.7MB，只发生在菜单，不在战斗中）；`ensureRemoteAvatar` 遇到未就绪的 skin 时先用盒子兵，加载完成后再替换。
- 每个 skin 一个 promise 缓存，失败态同样缓存——不重试，不阻塞。

### root 结构（与盒子兵同构）

```
root (Group, name='SoldierVoxel_<classId>')
├── SoldierFacing (Group, rotation.y = π)
│   └── <SkeletonUtils.clone 的蒙皮模型>
│       └── Dummy001 ──> Weapon (体素枪，背挂)
└── TeamMarker (RingGeometry 色环)

root.userData = { glbAnim, muzzle, variant, classId, team }
```

`userData.glbAnim` 的存在即是 `updateLocomotion` 的分流信号，沿用 `soldier-glb.js` 既有约定。所有 mesh 设 `frustumCulled = false`（蒙皮动画后包围盒失效会导致闪没）。

### 武器

复用 `js/soldier.js` 现有的体素枪外形，挂到**背部挂点 `Dummy001`**（Spine1 后方 0.22m）。选背挂而非手持：Walk / Run 不是持枪动作，手臂是自然摆动的，手里握把枪会变成"提着枪走"；背挂与自然摆臂的动作完全不矛盾。

`addGun` 目前是 `soldier.js` 的模块私有函数且按盒子兵局部坐标摆位，需要提取为可复用的构造函数（只产出 gun Group，不负责摆位），由两边各自定位。这是本方案对现有代码唯一的结构性改动，属于"改到的地方顺手理清"，不扩散。

### 动画状态机

只有三个 clip，规则必须简单：

- **待机** → `Pick` 冻结在第 0 帧（`action.play()` 后 `action.paused = true; action.time = 0`）。
- **移动** → 按 `state.speedRatio` 在 `Walk` / `Run` 间切，`timeScale` 随速度微调。
- **滞回**：走停边界加 120ms 滞回，禁止每帧互切（`soldier-glb.js` 已验证过这个数值，物理/寻路在停走边界会抖）。
- **呼吸**：`mixer.update()` 之后给 `Bip001-Spine1` 叠一条极慢正弦（周期约 4s，幅度 ~0.015 rad）。必须在 mixer 之后写，否则被 clip 覆盖。
- 开火 / 蹲 / 死亡不触发任何动画响应。

---

## 3. 分发与存储

### 存储

`localStorage` 键 `vf_soldier_skin`，值 `'box'`（默认）| `'voxel01'` … `'voxel04'`。读取时对未知值回退 `'box'`（与 `lobby.js` 处理 `STORAGE_CLASS` 的写法一致）。

由 `VF.Soldier` 提供 `getPlayerSkinId()` / `setPlayerSkinId(id)` 统一读写，避免各处直接碰 localStorage。

### 分发

- `VF.Soldier.createClassSoldier(classId, opts)` 的 `opts` 增加 `skinId`：非 `'box'` 且 `SoldierVoxel.isReady(skinId)` 为真 → 委托 `SoldierVoxel.create`，否则原路构造盒子兵。
- `createPreviewSoldier` 透传 `opts.skinId`。
- `updateLocomotion(root, dt, state)` 开头加分支：`root.userData.glbAnim` 存在 → `SoldierVoxel.drive(root, dt, state)` 并 return。

### 调用点改动（5 处）

| 文件 | 位置 | 改动 |
|---|---|---|
| `js/ui.js` | `_startClassPreviews` 的模型构造循环 | 传入当前 skinId；skinId 变更时重建模型 |
| `js/ui.js` | 第二处预览循环（~3870） | 同上 |
| `js/deployment-presentation.js` | 出击演出模型构造 | 传入 skinId |
| `js/pvp.js` | `_makePreviewModel` | 传入本地 skinId |
| `js/pvp.js` | `ensureRemoteAvatar` | 用远端 skinId；缓存判定加入 skinId 比较 |

### 新文件接线

`index.html` 在 `js/soldier.js` **之后**、`js/player.js` 之前插入 `<script src="js/soldier-voxel.js?v=voxelskin1"></script>`。同时把 `js/soldier.js` 的 `?v=` 令牌一并 bump（`/js/*` 是 `max-age=3600`，不 bump 则普通刷新拿到旧文件）。

---

## 4. UI：部署页"角色形象"行

在 `index.html` 的 `class-deploy-footer` 内，`选择兵种` 那一行之后插入一行：

```
<span class="class-deploy-select-label">角色形象</span>
<div class="class-skin-list" id="class-skin-grid"></div>
```

由 `ui.js` 填充 5 个按钮（原型兵 + 体素 01–04），点击立即写入 `vf_soldier_skin` 并重建站台模型。状态：

- 未加载完 → 按钮显示加载中，不可点
- 加载失败 → 置灰 + title 提示，不可点
- 当前选中 → `active` 态，与兵种按钮同一套视觉

缩略图复用现有 `_bakeClassAvatars` 的离屏烘焙机制（skin 就绪后烘一次并缓存）。样式沿用 `class-list` 已有的按钮样式，`style.css` 只加必要的行布局。

---

## 5. 联机同步

`pvp` 的 loadout 载荷现为 `{classId, weaponId, spawnId, team}`。改动三处：

1. **发送端**（`js/pvp.js` ~2595、~2638 构造 loadout 处）：加 `skinId: VF.Soldier.getPlayerSkinId()`。
2. **`_sanitizeRemoteLoadout`**：`skinId` 过白名单（`'box'` + `SoldierVoxel.SKINS` 的 id），非法或缺失一律归为 `'box'`。
3. **`ensureRemoteAvatar`**：从 `remoteLoadout.skinId` 取值传给 `createClassSoldier`；缓存命中判定从 `(classId, team)` 扩展为 `(classId, team, skinId)`。

旧版客户端不发该字段 → sanitizer 归为 `'box'` → 显示盒子兵。**向后兼容，无需协议版本号。**

---

## 6. 验证

### 烘焙期

`scripts/bake-roles.js` 自带的三项自检（见 §1.3）。

### 运行期

新增 `scripts/check-roles.js`（沿用 `check-preview-fidelity.cjs` 的 playwright + 本地 Chrome 模式）：

1. 起本地静态服务，打开部署页
2. 依次点四个角色按钮，各截一张站台图，写到 `tmp/roles-check/`
3. 断言：无 `pageerror`；站台 canvas 非空白；四张图两两不同（证明确实换了模型）
4. 人工看图确认：朝向面对镜头（不是背对）、脚踩地面（不悬空/不陷地）、站姿自然（不是 A-pose 摊手）、贴图正常（重采样没串色）

**前置条件：playwright 当前未安装**，需先 `npm i -D playwright`（仓库无 `package.json`，需一并创建，或用已有的 `npx playwright`）。

### 手动回归

- 关掉网络/删掉 `assets/characters/` → 部署页仍能正常打开，显示盒子兵，控制台只有一条警告
- 切到体素角色后进单机战斗 → AI 与敌人仍是盒子兵，无异常
- 两窗口联机 → 双方各选不同角色，互相看到对方所选形象

---

## 7. 清理

删除 `js/soldier-glb.js`（Mixamo 试点，未提交、未接线）及 `.gitignore` 中对应的 `assets/Soldier.glb` 条目与本地文件。它解决的 FBX→GLB retarget 问题在本方案中不存在（同骨架直接套用），保留只会误导后来者。

---

## 风险与已知限制

| 风险 | 处置 |
|---|---|
| 四个角色只有三个动作，战斗中无开火/蹲/死亡表现 | 已在非目标中明确。若后续补充动作资产，状态机加 clip 即可，无需改结构 |
| 贴图是逐面色块图集，降采样理论上可能在色块边界串色 | 4096→1024 后每块仍有 20–40 像素；烘焙自检 + §6 人工看图把关 |
| 首次打开部署页需下载 5.7MB | 只在菜单发生，不阻塞战斗；未就绪时先显示盒子兵 |
| `addGun` 提取为公共函数会动到盒子兵路径 | 提取时只移动代码不改逻辑，盒子兵的定位参数原样保留在调用侧 |
