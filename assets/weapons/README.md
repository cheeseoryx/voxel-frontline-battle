# assets/weapons/ — 武器美术资产（枪械 + 投掷物）

替换游戏里的程序化盒子武器。目前全部是代码用 `THREE.BoxGeometry` 拼的，
美术资产到位后按 ID 逐个顶掉，没到位的继续用程序化兜底，不会开天窗。

> 目录里现在是**三类**资产，别混为一谈：
> - **第一批枪**（`SM_*_001.glb`，5 把）：长轴 Z，枪口朝 **+Z**。
> - **第二批枪**（`Mod_*.glb`，6 把）：长轴 Z，枪口朝 **-Z**。
> - **第三批投掷物**（`Mod_Grenade/Flashbang/SmokeBomb.glb`，3 个）：长轴 **Y**（竖着放），
>   **没有枪口**。规格和消费点都跟枪不一样，见文末「投掷物（第三批）」。

## 当前状态（2026-09-15）

美术已提供 **11 把枪（分两批）+ 3 个投掷物**（验收截图见 `tmp/weapons-check/*.png`、
`tmp/weapons-side/*.png` 与 `tmp/throwables/*.png`）：

**第一批**（`SM_*_001.glb`，UE 5.8 导出）

| 文件 | weaponId | 尺寸 (W×H×D) | 长轴 | 原枪口端 | 原点 | 面数 |
| --- | --- | --- | --- | --- | --- | --- |
| `SM_M249_001.glb` | `m249` | 0.340×0.431×1.082 | Z | **+Z** | 握把 | 2001 |
| `SM_MP5_001.glb` | `mp5` | 0.062×0.305×0.699 | Z | **+Z** | 握把 | 1927 |
| `SM_MP7_001.glb` | `mp7` | 0.058×0.294×0.588 | Z | **+Z** | 握把 | 1678 |
| `SM_P90_001.glb` | `p90` | 0.051×0.210×0.513 | Z | **+Z** | 握把 | 2138 |
| `SM_USP_001.glb` | `usp` | 0.034×0.145×0.214 | Z | **+Z** | 握把 | 1297 |

**第二批**（`Mod_*.glb`，UE 5.8.2 导出，2026-09-15 补充）

| 文件 | weaponId | 尺寸 (W×H×D) | 长轴 | 原枪口端 | 原点 | 面数 |
| --- | --- | --- | --- | --- | --- | --- |
| `Mod_ACR.glb` | `acr` | 0.086×0.355×0.944 | Z | **-Z** | 包围盒中心 | 3066 |
| `Mod_AK_74.glb` | `ak74` | 0.044×0.284×0.938 | Z | **-Z** | 包围盒中心 | 2320 |
| `Mod_HK419.glb` | `hk419` | 0.081×0.350×0.927 | Z | **-Z** | 包围盒中心（x 还偏 2%） | 3454 |
| `Mod_M4A1.glb` | `m4a1` | 0.088×0.329×0.994 | Z | **-Z** | 包围盒中心 | 2744 |
| `Mod_MK14EBR.glb` | `mk14ebr` | 0.062×0.189×0.948 | Z | **-Z** | 包围盒中心 | 3259 |
| `Mod_SCAR_H.glb` | `scarh` | 0.100×0.386×1.179 | Z | **-Z** | 包围盒中心 | 2585 |

**第三批投掷物**（`Mod_*.glb`，2026-09-15 补充，**竖着放、长轴 Y、没有枪口**）

| 文件 | throwableId | 显示名 | 尺寸 (W×H×D) | 长轴 | 原点 | 面数 |
| --- | --- | --- | --- | --- | --- | --- |
| `Mod_Grenade.glb` | `frag` | 破片手雷 | 0.079×0.103×0.073 | **Y** | 底面中心 | — |
| `Mod_Flashbang.glb` | `flash` | 闪光弹 | 0.062×0.162×0.063 | **Y** | 底面中心 | — |
| `Mod_SmokeBomb.glb` | `smoke` | 烟雾弹 | 0.061×0.140×0.063 | **Y** | 底面中心 | — |

投掷物的 ID 不是 `weapon-catalog.js` 的 weaponId，而是 `js/throwables.js` 里
`THROWABLES` 表的 id。目前只有这三个有资产，`stun`（震撼弹）/ `molotov`（燃烧瓶）
继续程序化兜底。

### ⚠️ 两批的枪口朝向是**相反**的

| 批次 | 文件名式样 | 原始枪口端 | 代码 `yawOffset` |
| --- | --- | --- | --- |
| 第一批 | `SM_*.glb` | **+Z** | `Math.PI` |
| 第二批 | `Mod_*.glb` | **-Z** | `0`（不用转） |

两批导出的工具链/约定不同，这事没法"猜"，也不能靠"哪端细"来判断 ——
第一批的 M249 / MP5 / MP7 在枪管轴线的 -Z 端有一段预留段或消焰器，
第二批的 P90 / USP 枪托比握把粗，**用粗细判断会全部判反**。

判朝向只看这三个参照的相对位置：**握把 / 扳机 在中间、弹匣在握把前下方、
枪托在握把后方**。`scripts/check-weapons-side.js` 就是为此做的：它给每把枪
渲一张大侧视图，把包围盒两端分别标成青色 `Z+` / 品红 `Z-`，用肉眼看，
不做自动推断。

### ⚠️ 两批的原点也不一样

- 第一批：原点**正好在握把**（撞在项目约定上，理想）。
- 第二批：原点在**包围盒中心**（z 50%），纵向偏到枪身中部。

代码**不做纵向回中**，两个原因：
1. 纵向（Z）位置由第一人称的 `muzzleDistance` 逐把补偿（`GLB_CONFIG[id].muzzle.z`），
   再统一往后撤一点，做回中反而要重调一遍；
2. 第二批的 Z 回中刚好等于 0（包围盒对称），回中等于没回。

横向（X）在 `bakeGeometry` 里统一归中到枪管轴线；**高度（Y）不回中** ——
模型本来就往 y≥0 长，握把贴着 y=0，回中会把纵向基准从握把挪到枪身中部，
第一人称全部摆位都得重调。

> **一个小坑**：P90 与 USP 的握把和枪托贴合得比较近，画在握把中心里的原点
> 会视觉上偏到握把上沿"之外"，看着像在枪身外，其实是对的。

## 目录

| 路径 | 用途 | 入库 |
| --- | --- | --- |
| `assets/weapons/SM_<型号>_001.glb` | 第一批枪原始导出，游戏直接加载 | ✓ |
| `assets/weapons/Mod_<型号>.glb` | 第二批枪原始导出，游戏直接加载 | ✓ |
| `assets/weapons/Mod_Grenade.glb` 等 | 第三批投掷物原始导出，游戏直接加载 | ✓ |
| `assets/weapons/raw/` | 需要转换时才用的中转目录 | ✗（.gitignore） |

示例：`assets/weapons/SM_M249_001.glb` → 代码注册为 `m249`；
`assets/weapons/Mod_M4A1.glb` → 注册为 `m4a1`（**文件名不是 weaponId**，
对应关系是在 `js/weapon-models.js` 的 `GLB_CONFIG` 里手写的）。

## 命名

代码侧的 weaponId 必须是 `js/weapon-catalog.js` 里的 **weaponId**（`gun('xxx', ...)` 的
第一个参数，全小写），不是枪的显示名。已接入的 11 把枪 + 3 个投掷物：

| weaponId | 显示名 | 类别 | 批次 |
| --- | --- | --- | --- |
| `m249` | M249 | lmg | 1 |
| `mp5` | MP5 | smg | 1 |
| `mp7` | MP7 | smg | 1 |
| `p90` | P90 | smg | 1 |
| `usp` | USP | pistol | 1 |
| `acr` | ACR | assault | 2 |
| `ak74` | AK-74 | assault | 2 |
| `hk419` | HK419 | carbine | 2 |
| `m4a1` | M4A1 | carbine | 2 |
| `mk14ebr` | MK14 EBR | dmr | 2 |
| `scarh` | SCAR-H | assault | 2 |
| `frag` | 破片手雷 | 投掷物 | 3 |
| `flash` | 闪光弹 | 投掷物 | 3 |
| `smoke` | 烟雾弹 | 投掷物 | 3 |

其余 36 把：

| 类别 | weaponId |
| --- | --- |
| 突击步枪 | `auga3` `famas` `sg550` `f2000` |
| 战斗步枪 | `ak15` `fal` `g3` |
| 卡宾枪 | `g36c` `asval` `groza` `ak5c` |
| 冲锋枪 | `honeybadger` `vector` `ump45` `pp19` `scorpionevo` `pp2000` |
| 轻机枪 | `l86a1` `mg36` `rpk16` `ultimax100` |
| 精确射手 | `mk20` `m110` `sr`（SVD） |
| 狙击枪 | `ssg69` `sv98` `l96` `rem700` `m200` `msr` |
| 手枪 | `m9` `mp443` `glock18` `unica` `deserteagle` `rsh12` |

## 导出规格（后续资产按这个来，否则接不进去）

1. **单位米、Y 轴向上、长轴 Z。** 已确认（`check-weapons.js` 会断言长轴是 Z，
   换轴会让所有手调的 yawOffset / 枪口偏移全部失效）。
2. **枪口朝 +Z 或 -Z 都能吃，但一批里要统一。** 代码用 `GLB_CONFIG[id].yawOffset`
   逐把归一化到"枪口朝 -Z"。**新批次务必在交付说明里写清朝向**，不要靠代码猜。
3. **原点放主手握把（pistol grip）中心最好**；放包围盒中心也能用，但纵向偏
   靠 `muzzle` 表补，多一层手工对账。横向偏移代码会自动归中，不用管。
4. **不需要 `Muzzle` 节点。** 代码按 `GLB_CONFIG[id].muzzle.z` 指定枪口在长轴上的
   位置（负数，握把前方多少米）。要自己指定枪口，加一个名为 `Muzzle` 的空节点即可。
5. **不要骨骼、不要动画。** 后坐、换弹摆动、开镜位移全是代码改 transform 做的。
6. **单 mesh 单材质，贴图内嵌进 .glb。** 现有 11 把都是 1 mesh / 1 material /
   1 张内嵌 PNG，已经很理想。
7. **按真实尺寸导出，不要为凑视角放大。** 缩放系数在代码的 `GLB_CONFIG` 里逐把调
   （只作用于第三人称几何体，第一人称按真枪尺寸最好看）。
8. **面数**：第一批 1.3k–2.1k 偏保守，第一批第一人称看着会有点糙；
   第二批 2.3k–3.5k 好一些。建议后续提到 5k–10k，贴图 1024²。

## 游戏里四个消费点

| 位置 | 代码 | 现在怎么来的 |
| --- | --- | --- |
| 第一人称手持 | `js/soldier.js` `createViewModel` → `VF.WeaponModels.build(id)` | 直接取 GLB，再按 `muzzleDistance` 重新摆位 |
| **武器选择界面预览** | `js/arsenal.js` `_rebuildPreview` → `VF.WeaponViewModels.buildGun(def, {art:true})` | 取 GLB + 按包围盒自动取景 |
| 第三人称 / AI 手持 | `js/soldier.js` `buildGunProp(style, muzzleZ, weaponId)` | 按武器 ID 取 GLB，没有就按类别套盒子 |
| 背部挂枪 | `js/soldier-voxel.js` `_mountBackWeapon` | 挂在 `Dummy001` 骨骼上，摆位四元数不同 |

> ⚠️ **`buildGun` 的美术分支是显式 opt-in（`{art:true}`），不是默认行为。**
> 别顺手把它改成默认 —— 有三个调用方要的是**程序化**枪：
> - `modes/small-battle/js/soldier.js` 的第一人称：双手是以固定局部坐标 add 到
>   `gun` 节点上的，是照"原点在枪膛、总长 1.34m"的盒子枪量的；换成真枪尺寸 +
>   原点在握把的 GLB，手就浮在枪外了。
> - `forgeax/scripts/import-original-weapons.cjs`：靠这个函数导出**原始程序化**
>   武器做对照，默认给 GLB 会把对照基准弄坏。
> - `js/soldier.js` 自己的 `useCatalogGun` 回退分支。
>
> `check-weapons-arsenal.js` / `check-weapons-arsenal-small.js` 里各有一条
> "默认程序化 / `{art:true}` 走 GLB"的契约断言锁住这件事。

### ⚠️ 共享几何体：不能被 dispose

GLB 的几何体 / 材质在 `js/weapon-models.js` 的 `CACHE` 里是**跨帧、跨消费点共用**
的一份（第一人称、背枪、展示界面同时引用同一份）。而 `arsenal.js` 每次换枪都会
`traverse` + `dispose` 旧预览的几何体和材质，会把别人正在用的 GPU 缓冲一起扔掉
（three 之后会重新上传，不报错，只是白费一次、第一人称看起来闪一下）。

所以 `bakeGeometry` / `cloneMaterial` 会给几何体和材质打 `userData.shared = true`，
`buildWith` 给整棵树打 `gun.userData.artAssets = true`，两个 `arsenal.js` 的
dispose 循环都跳过带 `shared` 标记的。**新加任何"会 dispose 别人给的模型"的代码，
都要照这个规则来。**

### ⚠️ 枪体节点名有两套，改 `soldier.js` 时必须同时认

美术 GLB 走 `weapon-models.js` 的 `buildWith`，节点名固定 **`ViewGun`**
（和第一人称 viewmodel 保持一致）；程序化盒子枪由 `buildGunProp` 造，节点名是
**`Weapon`**。`soldier.js` 里凡是 `getObjectByName('Weapon')` 找枪的地方，
都必须改成 `findHeldGun(wrap)`，否则美术枪会静默漏掉整段处理：

- `finishSoldier` 的"把枪从背后镜像回身前"补偿 → 枪反过来插进角色身体里；
- `initLocomotion` / `updateCrouchPose` 拿不到 `loco.gun` → 走路枪不晃、蹲下枪不压。

这两条以前都是**静默失效**，画面上只表现为"枪的位置有点怪"，很难看出来。
`scripts/check-weapons-tps.js` 就是为此加的，它断言第三人称**枪口**
落在角色前方（root 空间 z < -0.5）。

另外找枪时**必须按父节点筛**：体素角色的背枪也叫 `ViewGun` / `Weapon`，
且挂在 `Dummy001` 下，不筛会先命中背枪，把所有断言都带偏。

## 投掷物（第三批）—— 跟枪不是一回事

手雷 / 闪光弹 / 烟雾弹跟枪**结构上就不一样**，别拿枪的管线去套：

| | 枪 | 投掷物 |
| --- | --- | --- |
| 长轴 | **Z**（横着） | **Y**（竖着放，底面在 y=0） |
| 枪口 | 有，`GLB_CONFIG[id].muzzle.z` | **没有**（`GLB_CONFIG` 里别写 `muzzle`，否则会在手雷旁边挂一个假的 MuzzleFlash） |
| 归中 | 只把横向 X 归中到轴线 | **三轴全归中**（`center:'all'`） |
| 登记 | `kind` 省略（默认 `'gun'`） | `kind:'throwable'` |
| 节点名 | `ViewGun` | `ViewThrowable` |
| 尺寸 | 真枪 0.6–1.2 m，直接用 | 真雷 ~0.10 m，游戏里程序化盒子是 0.28 m → **要放大** |

```js
/* js/weapon-models.js —— 第三批：投掷物，长轴 Y（竖着放），原点在底面中心 */
frag:  { url: DIR + 'Mod_Grenade.glb',   kind: 'throwable', center: 'all', yawOffset: 0, scale: 1.0 },
```

### 为什么投掷物要三轴归中

枪只归中 X，是因为第一人称的握把基准就是原点，动 Y/Z 会把摆位全带偏。
投掷物反过来：**飞行时 mesh 会随机自转**（`js/throwables.js` 的 `_updateLive`），
原点留在底面中心的话，转起来是**绕着底边画圈**，看着像在甩而不是在滚。
所以 `bakeGeometry` 加了 `center:'all'` 分支，把几何中心挪到 (0,0,0)。

### 缩放：真雷太小，得放大

真实手雷只有 0.10 m，而 `js/throwables.js` 的程序化盒子是 0.28 m
（小型遭遇战那套是 0.33 m）。直接按真尺寸换上去会小得看不见，所以：

| 位置 | 常量 | 值 |
| --- | --- | --- |
| 主游戏 `js/throwables.js` | `ART_SCALE` | `2.0` |
| `modes/small-battle/js/throwables.js` | `ART_SCALE` | `2.6` |

`GLB_CONFIG` 里的 `scale` 保持 `1.0`（真尺寸），放大只在这一层做，
免得三个消费点各写一个倍数。

### 三个消费点（跟枪的四个完全不重叠）

| 位置 | 代码 |
| --- | --- |
| 世界里飞 / 落地的那个 | `js/throwables.js` `makeMesh(id)` |
| 第一人称手上拿的 | `js/throwables.js` `_styleHeldItem`（同一个 `makeMesh` 出来的） |
| **武器选择界面投掷物槽** | `js/arsenal.js` `_rebuildPreview` 的 `slot==='grenade'` 分支 → `VF.Throwables.makeMesh(id)` |

> 主游戏根 `js/throwables.js` **原来没导出 `makeMesh`**，是这轮为军械库预览补上的
> （`Api.makeMesh = makeMesh;`）。军械库的投掷物槽以前只有一张 2D SVG 图标，
> 现在走的是同一个 3D 模型 —— 手上拿的就是扔出去的那个。

没资产的投掷物（`stun` 震撼弹 / `molotov` 燃烧瓶）继续走程序化兜底：
`_styleHeldItem` 里美术件存在时**隐藏全部三个程序化形状**（g1 手雷 / g2 瓶子 / g3 罐子），
美术没到就把形状显示回来，不会开天窗。

### ⚠️ 世界用的材质必须 clone 出来

`makeMesh` 给世界用时，会把共享材质 `clone()` 一份并打开 `fog`
（`js/throwables.js` 的 `artThrowable(id, scale, forWorld)`）。原因是：

- **几何体是共享的**（`userData.shared = true`），任何人不许 dispose；
- **材质是每实例私有的**（`shared:false`、`fog:true`），谁持有谁 dispose。

军械库换枪换雷时会 `traverse` + `dispose` 旧预览，跳过 `shared` 的就正好
"只丢私有材质、保留共享几何体"，符合预期。反过来如果图省事直接用共享材质，
世界里的雾效会不对，而且会被别人 dispose 掉。

## 验证脚本

| 脚本 | 覆盖 |
| --- | --- |
| `scripts/inspect-weapons.js` | 静态解析 GLB（尺寸/长轴/朝向/原点/材质），产物 `tmp/weapons-inspect.txt` |
| `scripts/check-weapons.js` | 逐把渲染三视图（正/俯/等轴 + 坐标轴）+ 断言长轴是 Z，产物 `tmp/weapons-check/` |
| `scripts/check-weapons-side.js` | 逐把渲染大侧视图，包围盒两端标青 `Z+` / 品红 `Z-`，**人工判枪口朝向用**，产物 `tmp/weapons-side/` |
| `scripts/check-weapons-e2e.js` | 组件级：`createViewModel` + `createClassSoldier` 两路，产物 `tmp/weapons-e2e/` |
| `scripts/check-weapons-tps.js` | 组件级：盒子兵第三人称手持 + 背枪两个消费点，产物 `tmp/weapons-tps/` |
| `scripts/check-weapons-tps-ingame.js` | **主游戏真机**：体素化身背挂美术枪，产物 `tmp/weapons-tps-ingame/` |
| `scripts/check-weapons-main.js` | **主游戏真机**：进对局 → `weapons.equip()` → 第一人称截图，产物 `tmp/weapons-main/` |
| `scripts/check-weapons-arsenal.js` | **主游戏武器选择界面**：逐把选中 → 预览是 GLB 且有贴图 + 共享标记，产物 `tmp/weapons-arsenal/` |
| `scripts/check-weapons-arsenal-small.js` | **小型遭遇战武器选择界面**：同上，另加"第一人称仍是盒子枪 + 双手贴合"，产物 `tmp/weapons-arsenal-small/` |
| `scripts/check-throwables.js` | **投掷物专用**：主游戏 + 小型遭遇战两边，覆盖 `makeMesh` / 手持 / 军械库投掷物槽三处，另断言 `stun`、`molotov` 静默回退，产物 `tmp/throwables/` |

> ⚠️ **`VF.WeaponModels.ids()` 现在同时返回枪和投掷物。** 只想要枪就传
> `ids('gun')`（`check-weapons-e2e` 就是这么改的）。新增的 `kind(id)`
> 可以查单个 id 是 `'gun'` 还是 `'throwable'`。不加过滤的循环会把
> 投掷物当枪处理（找 `muzzle` → null 引用崩）。

> 两条第三人称路径别混（都叫"第三人称"，但不是一回事）：
> - **体素骨骼角色**（真机队友 / AI 化身）走 `AnimationMixer`，身上**只有背枪**
>   （挂 `Dummy001` 骨骼下）。
> - **盒子兵**（`voxel:false`，AI 占位 / 预览）才有独立手持枪，走 `addGun`。
>   真机里能验的第三人称只有背枪，手持枪在组件级用 `check-weapons-tps.js` 覆盖。

> 展示界面截图有两个坑：
> 1. 预览会自转 / 摇摆，"每把枪截图都不同"会变成必然成立 —— 断言等于白设。
>    两份脚本都钩住 `renderer.render` 每帧把 yaw 钉回静止角（主游戏 `0`，
>    小型遭遇战 `baseYaw = -PI/2`）。
> 2. 军械库是 `position:fixed` 全屏 overlay，**必须整页截图、不能 `clip`** ——
>    Playwright 对 fixed overlay 上的 clip 会合成错（多次 clip 得到同一张图）。

跑法（本机 Bash 工具链不可用，用 PowerShell；Playwright 需 `NODE_PATH`）：

```powershell
$env:NODE_PATH="C:/Users/ronal/.workbuddy/binaries/node/workspace/node_modules"
& "C:/Users/ronal/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" scripts/check-weapons-tps.js
```

> 主游戏入口是根 `index.html`（`启动游戏.cmd` → `127.0.0.1:8765/`）。
> `modes/small-battle/` 下另有一整套分叉副本（`modes/small-battle/js/*.js`），
> **改根目录 `js/` 不会影响它，反之亦然**。枪械这套接入已经在两边都落过一遍：
> 根 `js/weapon-viewmodels.js` + `js/arsenal.js`，以及
> `modes/small-battle/js/weapon-viewmodels.js` + `modes/small-battle/js/arsenal.js`
> （小型遭遇战**只用一份** `../../js/weapon-models.js` 注册表，所以 GLB 配置改根目录就够）。
> 主游戏首页的「小型遭遇战」入口会跳到那一套（`js/game-entry.js:60`），
> 所以两边的界面都要验。

## 接入流程

1. 文件丢进 `assets/weapons/`，说一声。
   - 是**枪**：务必带上"这批枪口朝哪端"。
   - 是**投掷物**：说一声就行，长轴朝 Y、没枪口是默认约定（见上一节）。
2. 跑 `node scripts/inspect-weapons.js`（静态解析：尺寸 / 长轴 / 朝向 / 原点）。
   - 枪：再跑 `check-weapons.js`（三视图，断言长轴 Z）+
     `check-weapons-side.js`（大侧视图，**肉眼定枪口朝向**）。
   - 投掷物：`inspect-weapons.js` 会报"长轴是 Y ✗"，这是**对的**，不是要修的问题。
3. 在 `js/weapon-models.js` 的 `GLB_CONFIG` 注册，按批次分组写好注释；
   换的是 GLB 资产本身时，把 `TOKEN`（缓存键前缀）和两个 `index.html` 里
   `weapon-models.js` 的 `?v=` 一起 +1。
   - 枪：`yawOffset` + `scale` + `muzzle` 偏移。
   - 投掷物：`kind:'throwable'` + `center:'all'`，**不要写 `muzzle`**；
     另在 `js/throwables.js`（主游戏）和 `modes/small-battle/js/throwables.js`
     各对一次 `ART_SCALE`（两边程序化盒子尺寸不同，倍数也不同）。
4. 消费点自动命中，没有 GLB 的武器继续走程序化。
5. 跑验收：
   - 枪：`check-weapons-tps.js` + `check-weapons-tps-ingame.js` +
     `check-weapons-main.js` + `check-weapons-arsenal.js` + `check-weapons-arsenal-small.js`。
   - 投掷物：`check-throwables.js`。
   - 动过 `weapon-models.js` 就**全量跑一遍**（`ids()` 这类共享接口一改，
     旁边的老脚本会跟着炸，这轮 `check-weapons-e2e` 就中过招）。
