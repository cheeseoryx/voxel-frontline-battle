# Game Feedback

记录开发期间确认的 Engine、SDK、模板、构建、资产、运行时或浏览器问题。该文件会和根
`README.md` 一起原样进入 Web ZIP；不要写入 token、密码、私有 URL 或其他敏感信息。

```markdown
### YYYY-MM-DD — Short issue title

- Scope: Engine | SDK | template | build | asset | runtime | browser
- Reproduction: exact command or smallest user-visible sequence
- Expected: what should happen
- Actual: what happened
- Evidence: log, screenshot, URL, or commit path
- Status: open | workaround | fixed | blocked
```

## 2026-09-11：Windows SDK 启动器

范围：SDK 0.1.28、Node 24.18.0、pnpm 11.19.0、Windows x64。
复现：SDK 根目录运行 node bin/forgeax.mjs project init --json。
期望：完成 SDK 预检。实际：spawnSync corepack.cmd EINVAL，尚未执行预检。
证据：SDK bin/forgeax.mjs 在 Windows 直接 spawnSync corepack.cmd；本次命令返回该堆栈。
恢复：使用已有同版本 @forgeax/engine/dist/bin/forgeax.mjs，并设置官方支持的 FORGEAX_SDK_ROOT。
验证：SDK project init 和外部 project new --template game-3d 均返回 ok:true。
状态：迁移工具链已恢复；未修改 SDK、node_modules 或生成态；上游启动器问题仍存在。

## 2026-09-11：ScriptablePack JSON 依赖

复现：pack.ts 直接 import soldiers.json；tsc 通过但 catalog scan 返回 pack-parameter-invalid / Debug Failure. Output generation failed。期望：结构化拒绝不支持的导入或正常编译。处理：转换器输出等价 TypeScript 作者数据，避免 JSON 编译路径。状态：已重建通过，保留等价 TypeScript 作者数据。

## 2026-09-11：构建与首次浏览器诊断

1. 自带 Chromium 启动 spawn UNKNOWN；设置 FORGEAX_BROWSER_EXECUTABLE 指向本机 Chrome 后可启动官方捕获。
2. 初次 dist 构建仍含 /__forgeax/host 连接，静态 preview 返回 200 而无法 WebSocket 握手，触发 host-transport-failure。显式 NODE_ENV=production 重建后通过静态浏览器验证，工具脚本已固定该设置。
3. 开发捕获报告 host-assembly-revision-mismatch。根插件依赖 gameHost，但 forge.json 缺少同名 inject；已补齐入口依赖声明，待验证。
证据：artifacts-capture.log、artifacts-capture-dev.log、artifacts/capture/original-soldiers.json。以上不属于玩法验证通过。

## 2026-09-11：RGBA 顶点布局验证差异

SDK geometry 文档与 packInterleavedVertexAttributes 支持 color RGBA（16 floats），但 assets-runtime/src/payload-validate.ts 的步幅只计算 12 基础 floats、skin 和额外 UV，未计入 color。模型可构建，运行加载报 mesh-vertex-stride-mismatch。
处理：原角色每个三角形颜色恒定，转换为对应原生材质槽，转换时断言三个顶点颜色一致，不丢弃颜色。
状态：重新验证中；后续大量动态体素顶点色仍须修复引擎 owner 或验证高效的受支持表示，不可据此宣称破坏系统已移植。

## 2026-09-11：公开源码 Windows 构建

原始 SDK 源码复制到仓库 forgeax-engine 后依赖安装成功。首次 pnpm build:engine 失败：C:\Program is not recognized。scripts/build.mjs 把带空格的 process.execPath 交给 shell:true。
已在用户工程的源码副本修正：Node 可执行文件直接启动，仅命令 shim 经过 Windows shell。原 SDK 未修改。原始失败记录：engine-build.log（重试日志另存）。状态：公开源码完整构建通过。

## 2026-09-11 — Local engine binding rejects a built subpath-only package

- Scope: public SDK source, devkit engine workspace inspection.
- Reproduction: build all Engine packages; bind the game to the local source; run project engine check.
- Expected: all 62 built packages accepted. Actual: engine-net-websocket reported missing, although dist/browser.mjs and dist/node.mjs exist. Its exports have no root entry.
- Evidence: engine-check.log; engine-binding-red.log (3 pass, 1 fail).
- Owner fix: inspect explicit runtime subpaths when a package has no root export, excluding package metadata and wildcard entries.
- Status: fixed; four binding tests pass and the rebuilt CLI reports 62/62 built packages.

## 2026-09-11 — Cooked Standard material does not consume vertex colors

- Reproduction: one white Standard material, native RGBA mesh attributes, static production build.
- Expected: original soldier colors. Actual: white soldiers; no GPU error, 317 submitted frames.
- Evidence: the initial white-soldier screenshot inspected during this session (the current screenshot has since been replaced by the corrected material-slot capture); shader-compiler/src/material/variant-context.ts lowerMaterialVariantContext has no vertex-color geometry fact; render record intentionally bypasses variants for cooked material artifacts.
- Status: unresolved Engine capability gap, separate from the repaired mesh stride validator. Current soldier authoring retains the original per-part flat material colors as native material slots; it does not claim cooked RGBA support. Dynamic terrain color migration still requires a decision at its geometry owner.

## 2026-09-11 — Original-model converter replaced zero normal components

- Scope: game migration authoring tool, not SDK.
- Reproduction: unit-length normal assertion on exported original soldiers.
- Actual: JavaScript falsy fallback changed a valid normal Y=0 to Y=1.
- Fix: use nullish fallback and regenerate original data; evidence model-normals-red.log and game unit gate.

## 2026-09-11 — Windows live development reload loop

- Reproduction: official dev start; recursive filesystem observer receives null filename events while the daemon writes its own generated session state.
- Actual: repeated generations (up to 14), no stable ready session; first CLI launch times out. A read-only observer reproduced three change/null events.
- Owner: devkit live-dev watcher treated unidentifiable events as game source changes.
- Fix: reject null/undefined/empty filenames before source invalidation; keep identified author events and generated-output exclusions.
- Evidence: artifacts/live-watch-red.log (3 fail); artifacts/live-watch-green.log; real dev startup/reload verification pending.

Live watcher follow-up: tracing the actual daemon also observed artifacts-capture.log as a reload trigger (artifacts/watch-events.log). Output logs are not author inputs; added case-insensitive .log exclusion with a separate red regression (artifacts/live-watch-logs-red.log). The earlier null-event repair alone did not establish a stable dev session.

## 最终验证状态（2026-09-11）

RGBA 步幅验证修复已通过 owner 回归和完整构建，但 cooked 材质颜色缺口仍未修复，两个问题不能合并为“顶点色支持完成”。原角色使用原版零件颜色材质，单独通过几何与颜色比对。模型法线回归由失败变为通过。

开发监听修复后，官方 dev start 曾在 generation=1 到达 ready、world-1、main-serial、444 帧。随后真实源码变更/恢复测试失败：artifacts/dev-reload.log。浏览器报告包含 Outdated Optimize Dep 504 和 __forgeax-ddc/.../media/*.svg 404。源码探针已恢复，故障 dev 实例通过官方 stop 关闭；热重载尚未验收通过。

静态 build + preview 路径仍通过，预览仅覆盖首页、模式导航与静态原角色；玩法和联机迁移待完成。

## 2026-09-14 原版模块移植与资源规模问题

- 范围：原版武器资源导出。原版 js/weapon-viewmodels.js 的 addRail 调用漏传 gun，调用部分武器构造时抛出 gun.add is not a function。导出器只修正离线 VM 输入，原始源码未修改；具体哈希及修正见 docs/migration/weapons-provenance.json。状态：转换可用，原版自身缺陷仍保留在原文件。
- 范围：ScriptablePack author worker。78 个武器/手臂网格以 9.7 MB 数字字面量导入时，equipment.pack.ts 扫描出现 Worker terminated due to reaching memory limit，外层误归类为 pack-malformed-meta。期望正常导入或报告内存预算；证据：artifacts/native-build-sept14.log（后续构建覆盖）及本条复现。修正：author 数据改为 Float64/Uint32 无损编码，仍走正式 pack/GUID 链，未改 worker 限额。状态：待重建验证。
- 范围：ESM 原规则导入。将原 IIFE 改为带默认参数的工厂时，函数内 use strict 与非简单参数冲突。修正：移除已由 ESM 保证的重复 strict 指令。16 项原规则/资源测试已通过。
- 当前局限：AI 决策与物理保留原算法，但关节动画、精确死亡效果和原版材质受击闪烁尚未对齐；不能据此宣称完整表现替换。

### 2026-09-14 后续验证

- 上述 pack-worker 内存问题已通过无损编码解决；全量原始数据重新导入后，环境检查、类型检查、17 项测试和生产构建均通过。
- 实战发现原生 AI 碎块误用大型地图材质 GUID，首次受击/死亡时触发 mesh-default-not-ready。已改为当前小型地图的已加载材质；再次实测团队死斗正常计分、补员回 24 人和退出重进，浏览器无错误。
- 调整玩家初始护甲为原版的 50，出生使用原版出生区的高度，准备阶段冻结移动；修正原生原型行为差异。
- 造化预览已改由 scripts/start-preview.ps1 启动隐藏后台服务，默认 8766；原版静态服务保留在 8765。两个服务均已检查就绪。服务就绪不等于完整迁移验收通过。

## 2026-09-14：原生战场地形超过 32 个碰撞体后停止
- 范围：physics-rapier3d 派生体素碰撞体的候选额度。
- 复现：团队死斗原生战场流式创建超过 32 个区块；第一条浏览器错误见 artifacts/systems-tdm/errors.jsonl。
- 期望：已发布的地形保留碰撞，同时释放待处理工作的额度。
- 实际：published 记录仍占用 maxCandidates / maxCandidateBytes，世界因 derived-candidate-budget-exceeded 停止。
- 修复：额度仅统计未发布工作；保留已发布状态供形状/物体查询和卸载；32 个待处理候选限制仍有效。
- 证据：../forgeax-engine/artifacts/physics-stream-red.log（修复前失败），physics-stream-green.log（82 项通过）；引擎物理包重新构建。游戏浏览器复验继续进行。
- 补充：接入层曾将 voxel origin 加了半格，导致脚底嵌入地形。已改为整数格原点；游戏真实 WASM 穿墙缺口测试通过。
- 全量引擎 Dawn/hello/browser 发布矩阵未在此局部修复中完成，不能把包级结果视为完整引擎发行验收。

## 2026-09-14：后续接入问题和验证边界

- 物理包入口未导出内部已有的 SystemHandle。现导出四个固定更新系统，游戏仅给 Step 增加公开 runIf，退出插件恢复。真实 WASM 暂停/恢复测试通过，未另写求解器。
- 原类型检查和单测仍解析安装版 SDK，和生产构建不一致。tsconfig / vitest 已统一使用本地引擎官方 facades，测试重新执行。
- devkit 默认提供 webAudioPlugin/audioPlugin；重复安装导致启动失败。移除重复组合，使用 Host 的 AudioEngine。浏览器已观察到 contextState=running、lastError=null。
- 核心地图导出遗漏了基地建造，默认点落在河道。已执行作者基地平台/围墙步骤并导出计划基地、出生与核心坐标；陆地 AI 和载具出生排除深水。截图和目标推进复验仍需完成。
- 载具相机加入跟随及避墙；登车隐藏手持模型。传送等待固定更新后再接受移动，避免下车和重生位置被旧物理状态覆盖。
- 联网、工具、部分玩法表现和长局/Studio 验收仍开放。包级测试不代表完整引擎发行矩阵或完整游戏迁移通过。
## 2026-09-14 原生碰撞分组与地图通路补齐

- Rapier 角色控制器原先以 undefined 查询分组调用 computeColliderMovement，忽略 Collider.collisionGroups。症状为本应互相穿过的 AI 相互堵塞。现传入当前 collider.collisionGroups()，保留原生求解器；隔离分组回归修复前失败、修复后通过，物理包共 83 项测试通过。
- 补丁：docs/migration/engine-native-physics.patch；引擎 JS 与声明已重新构建。此结果仍不能代替全量引擎 Dawn/hello/Studio 发行验收。
- 核心地图只执行 regenerate 会漏掉默认地图套件。导入流程改为原 prepareEditorCanvas、基地平台、45 栋建筑、两层桥网和 6 个滑索元数据，并执行原出生点布局；总计 59 项作者布局，原文件未修改。
- 新战术导航支持桥面分层与滑索连接，路径保留逐格中间点，角色遇到台阶按原生控制器做跳跃。滑索的实际通路在现有体素中检查净空，玩家和 AI 共用原生移动；没有通过取消碰撞或瞬移穿过桥面。
- 核心前哨加入 20 秒占领、争夺/离开重置、主基地不可占领、所属队伍重生。新 AI 分配前哨与核心目标，核心射击优先于附近普通目标，避免射击冷却永远被普通目标消耗。
- 6 条滑索双向玩家物理测试及单名进攻 AI 跨图摧毁核心通过。该案例禁用了其他 AI，明确只证明导航/核心交战/胜负和清理；完整队伍对战单独长测，不能混用证明。
- 载具武器按原参数分别管理弹匣、备弹、装填、冷却及机枪过热。车载声音使用原 soundId。浏览器换座检查验证驾驶武器与炮手武器都确实开火。
- 车辆使用独立地面导航，不使用步兵滑索连接。多辆车靠近时按视线与距离选择登车目标，界面提示与操作使用同一选择结果。

完整队伍长测补充：首次 600 秒浏览器观察到 45/50 名角色活动、持续击杀/重生，但双方核心仍为 1000 HP，核心目标验收失败。保留报告于 artifacts/long-core-before-dynamic-obstacles/verification.json。位置证据显示一批步兵停在车辆尾部；为此新增动态车辆占地绕行和受阻重规划，再单独复验。不得将该失败记录改写为成功。

进一步验证：动态车辆绕行后，原生三模式进入/战斗/重入再次通过；240 秒完整队伍核心测试仍未伤到核心。双方在平行桥段的远距离互射构成新阻塞，旧 AI 命中判定为与距离和移动无关的常数 0.38。当前改为距离、移动和武器类别决定的命中概率，并用 NATIVE_FULL_CORE=1 的完整 50 人场景单独验证。历史失败报告保存于 artifacts/long-core-before-aim-model/verification.json。

本轮最终核心长测边界：增加距离/运动命中模型及按 7 m/s 初速、18 m/s² 重力检查的短距离跳跃路径后，50 人原生仿真 360 秒仍为 1000:1000，目标推进验收失败，报告 artifacts/native-core-full-simulation.log。不能描述为完整核心对局已通过，也不能以默认隔离测试替代此失败结果。保留当前模式功能和改进，下一步需要完善多路径协作、攻防节奏和真人参与的完整实战验收。


## 2026-09-14 战场空白：网格资源编号复用

用户报告独立 Chrome/Edge 中 HUD 可见，但战场黑屏或纯色。调查中确认旧 systems-tdm 的灰屏截图是向前走到墙面后产生的遮挡，不能作为全模式渲染失败的证据。有效复现是同一浏览器依次进入 conquest → core → tdm → demo → ffa → gungame：后续地图出现缺失楼体/地面，gungame 几乎只有天空；相机位置、地图区块和模拟仍正常，无控制台错误。相同地图反复进入不一定暴露问题，必须覆盖不同地图。

根因：Engine GpuResidencyCache 用 World + handleSlot 命中网格 GPU 缓存，丢失了完整句柄中的 generation。ECS 释放并复用同一 slot 后，新地形错误地获得旧地形的 GPU 顶点/索引缓冲。修复：缓存同时记录完整 sourceHandle，查找/租用/失效/释放/更新均验证版本；上传新版本后按既有提交和租约生命周期延迟销毁旧资源，旧租约也不能销毁新一局的替代资源。没有改动地图、UI、角色、物理、模式规则或引入页面重载兜底。

证据：artifacts/black-screen-all-modes 保留修复前六模式记录；artifacts/black-screen-regression-red.log 为修复前两条编号复用测试失败；artifacts/black-screen-regression-green.log 为 37 项相关测试通过；artifacts/black-screen-dawn.log 为 3 项真实 GPU 上传测试通过；Engine 源码构建、引擎渲染类型检查、游戏生产构建与类型检查通过。

新增 check:visibility：在实际生产页面上连续进入不同地图，按世界区域像素判定纯色/空白，并覆盖进入、开战、退出、再进入。旧 gungame 空白截图会被这道断言拒绝，记录 artifacts/black-screen-pixel-red.log。浏览器最终结果见 docs/migration/render-blank-fix-2026-09-14.json。调查用全局探针已移除。

Need: 修复战场空白并防止测试只凭 HUD/区块数误报。Use: 造化 Camera/Transform、Renderer.inspect、真实浏览器画布截图。Entry: engine-debug、engine-rhi-debug、render/README.md 和 game-context.ts。Proof: 编号复用回归红/绿、真实 GPU 上传、生产入口不同地图重入的截图和像素断言。Defer: 本轮不扩展迁移玩法；公开 SDK 的本次局部验证不能替代贡献者全量 hello/learn-render、browser/Dawn 发行矩阵。Template Disposition: 保留现有游戏资产和功能，修复引擎缓存所有者。

## 2026-09-14 QQ 浏览器黑屏、兵种预览消失与重复玩家标签

- 范围与复现：使用本机 QQ 21.8.7003.400 / Chromium 138，无额外 GPU 参数，访问生产入口 localhost:8766，依次进入装备整备、小队部署和大战场。QQ 的 browser-native WebGPU adapter 返回 null，引擎自动采用正式 wgpu/WASM WebGL2 通道。HUD、地图区块和帧提交正常，但兵种和战场均不可见。原始证据：../artifacts/qq-before、artifacts/qq-shaders。
- 根因一：PBR 阴影使用 textureSampleCompareLevel，经 Naga 转成 textureLod(sampler2DShadow)。QQ/ANGLE 在实际 draw 时才报告 X3013 gl_texture2D_comparisonLod0 参数不匹配，导致整批三维绘制失败。仅检查 shader link、首页或提交帧数无法发现。修复在共享 shadow-pcf owner：现有单 mip 阴影图的 uniform-fallback 变体使用 textureSampleCompare，并在该函数限定 derivative_uniformity 诊断范围；保留 PCF、深度比较、材质和阴影。WebGPU 分支保留显式 level-zero。方向光各 PCF 入口统一使用共享比较函数。
- 根因二：canvas 在全屏与装备/部署容器之间移动时，HTML drawing buffer 已改变，但 WASM surface 仍沿用最初的全屏尺寸，造成模型放大、偏移和裁切。rhi-wgpu makeCanvasContext 现在在下一次 acquire 前按实际 drawing-buffer 尺寸重新配置；先提交未完成的 surface texture。失败返回原错误并允许下次重试，不借用旧尺寸图像。红测 artifacts/qq-resize-red.log 两项失败；绿测 artifacts/qq-rhi-final.log 共 62 项通过，类型无错误。
- UI：原卡片外层与名字内层重复使用 squad-member-name，同时还显式添加玩家标签；CSS ::after 因而重复显示。外层改为 squad-member-heading，保留一个名字和一个玩家标记。未修改原版角色、背景或对局规则。
- 调查边界：GLSL textureGrad 替换只用于定位，没有进入生产代码；直接 textureLoad 深度图的候选方案被 Naga 的 GLSL 不支持错误否决并已替换。诊断脚本归档 artifacts/qq-diagnostic-scripts。生产修复不使用浏览器原型钩子，不关闭阴影，也不另建渲染器。
- 实际验证：artifacts/qq-visibility-final 为 QQ 九次连续对局（六种多人规则、跨地图重进、单人入口），每次检查进入与正式开战的世界区域像素，均通过；零着色器/绘制错误。artifacts/qq-preview-final 覆盖四种兵种、1280×720 / 1600×960 / 2704×1626 预览、部署与战场；画布尺寸、按钮裁切和唯一玩家标签断言通过，截图目视确认模型。Chrome 三次跨模式回归通过。76 项相关 owner 测试、类型检查、引擎及游戏构建、修改的 TypeScript lint 通过。
- 归档：docs/migration/engine-qq-render-compatibility.patch；汇总 docs/migration/qq-render-fix-2026-09-14.json。后续可运行 check:qq，以及 BATTLE_BROWSER=qq 的 check:visibility。测试使用独立自动化 profile，未修改用户 QQ 设置。

Need: QQ 上恢复真实三维画面与正确预览尺寸，修复重复 UI。Use: 原生 shader 变体、RHI CanvasContext 与现有 UI 插件。Entry: engine-debug / engine-rhi-debug、shader 与 rhi-wgpu owner README、SDK 能力目录。Proof: QQ 原始动态着色器错误、尺寸红绿测试、实际生产页面像素和截图、Chrome 回归。Defer: 不扩大到未完成玩法迁移；公开 SDK 的局部验证不能代替完整 hello/learn-render/browser/Dawn 发行矩阵。
Template Disposition: Runtime/controller KEEP（本游戏逻辑）；character/animation、scene、meshes/materials、lighting/environment KEEP（用户要求保留的原版内容）；UI ADAPT（只消除重复标签）；template tests KEEP（既有有效测试），新增实际 QQ 可见性与尺寸回归。未新增模板角色、背景或产品标识。

补充验证：游戏自身 9 个测试文件、35 项测试全部通过（artifacts/qq-game-tests.log）；汇总已更新。

## 2026-09-14 续报：150% 显示缩放下小队与战场仍黑屏

用户新截图中的重复玩家标签已经消失，证明上一轮 UI 修改已加载；不能继续归因为缓存。上一轮浏览器使用 DPR=1，大视口检查也只停留在较窄的装备预览，再回到 1600 宽进入部署，因此没有触发兼容设备尺寸上限。此前“已修复”的结论未覆盖用户的显示缩放条件。

- 有效复现：本机 QQ 21.8.7003.400，viewport=1805×1083、DPR=1.5，自动化与正常窗口均失败。装备预览仍可见，小队预览透明，进入战场只显示 HUD。artifacts/qq-dpr-repro 与 qq-headed-repro 保存失败截图和错误；qq-headed-repro/gpu.json 为正常窗口的 NVIDIA RTX 5070 / ANGLE D3D11 事实。
- 第一条真实底层错误：Surface::configure TooLarge，请求 2708×1625，当前 device.maxTextureDimension2D=2048。WASM requestDevice 使用 downlevel_webgl2_defaults；物理 GPU 的能力不等于已创建设备声明的额度。小队画布宽约 2567，同样超过额度。详见 artifacts/qq-dpr-exceptions/exceptions.json。
- 修复 owner：engine-app 的主线程 Canvas Host。首次完成 RendererHost 构造后，以及每次 Update 同步画布时，读取现有内部 host 的当前 device.limits.maxTextureDimension2D，以统一比例限制两轴 drawing buffer。未写死 QQ 浏览器判断或 2048 常数作为策略；设备额度较大时保留原 DPR，恢复设备后也读取新额度；CSS 大小与 UI 布局不变。维持既有尺寸写入去重，避免每帧在超大与缩小画布间反复重置。
- 红绿证据：qq-device-limit-red.log 中两个高 DPI / 竖屏测试失败；修复后同文件 19 项通过。补充构造阶段设备额度接线验证，并修正三个旧模拟 RendererHost 缺少 device 的测试夹具；qq-dpi-app-regression.log 为 11 个测试文件、62 项通过、2 项原有跳过，类型无错误。Engine 和游戏完整构建、游戏类型检查通过。
- 验收加强：check:qq 新增实际模型像素差异检测；截图与隐藏 canvas 后的同一区域比较，排除背景图和 UI 造成的假阳性。旧版本在 deployment 报 modelPixels=0（artifacts/qq-model-pixel-red），不再凭按钮/画布尺寸宣布模型存在。修复后 QQ 正常窗口 DPR=1.5 下四兵种、三视口、部署和战场通过，部署模型区域差异约 41.7%，零浏览器错误（artifacts/qq-dpi-headed-final）。
- QQ 正常窗口 DPR=1.5 的九次连续对局（六种多人模式、跨地图重入、单人入口）均通过进入/正式开战世界像素判定，artifacts/qq-dpi-all-modes-final。额外缩放与其他浏览器结果在本条后补充。
- 当前边界：这是主线程游戏入口按已创建设备额度适配尺寸的修复；没有改变 Rust/WASM 的默认设备额度，也没有宣称提高兼容通道的物理分辨率上限。未改角色、背景、UI 排版或玩法。补丁 docs/migration/engine-high-dpi-canvas.patch。

Need: 修复用户 150% 缩放下仍黑屏的真实入口。Use: 已有 RendererHost.device.limits 与 App canvas-aspect 生命周期。Entry: engine-app README/create-app.ts、RHI/WASM requestDevice、QQ 捕获的首个结构化 Surface 错误。Proof: 正常窗口失败、尺寸红绿、模型像素红绿、九次实战图像。Defer: Worker 独立宿主和全量引擎发行矩阵未在此局部修改中验收。Template Disposition: 原游戏角色/场景/材质/背景/UI/控制器 KEEP；Canvas Host ADAPT；验收测试 ADAPT；无新增模板内容。

最终补测：QQ 正常窗口 DPR=2 的四兵种/三视口/部署/战场也通过（artifacts/qq-dpi-200-final）；Chrome 正常窗口 DPR=1.5 的 conquest → tdm → gungame 进入与正式开战通过（artifacts/qq-dpi-chrome-final）。汇总和补丁哈希见 docs/migration/qq-high-dpi-fix-2026-09-14.json。
