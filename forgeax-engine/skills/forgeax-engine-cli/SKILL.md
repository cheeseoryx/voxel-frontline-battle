---
name: forgeax-engine-cli
description: >-
  ForgeaX project CLI, authoring-operation, preview, and live-inspection entrypoint. Use when
  creating or validating games, running tools, managing plugins, capturing evidence, or inspecting a live engine.
---

# forgeax-engine-cli

> [!IMPORTANT]
> **这里只有一个产品入口：`forgeax`。** 使用 `forgeax help` 逐层发现命令，
> `forgeax help --tree --json` 输出完整的结构化命令树；`ToolContribution`、`ToolClient`
> 与 `ToolRun` 是 CLI 背后的内部组合契约，不是第二套产品入口。

## 先按意图路由

| 意图 | 入口 |
|:--|:--|
| 把外部 `forge.json` 游戏构建成静态发布目录 | `forgeax project build <project> --base <url> --out-dir <dir> --json` |
| 从 npm 安装完整离线 SDK | `forgeax sdk install <dir> [--version VERSION]` |
| 从 SDK 创建工程或初始化已有工程 | `forgeax project new [dir] --template empty\|game-3d` / `forgeax project init` / `forgeax project check` |
| 安装或校验游戏根 Engine skills | `forgeax project skill install` / `forgeax project skill verify` |
| 生成可托管、包含 Engine runtime 的 Web ZIP | `forgeax project package --format web-zip [--output release/game-web.zip]` |
| 生成可双击离线交付的单 HTML 候选 | `forgeax project package --format single-html --output release/game-offline.html --json` |
| 浏览器合成截图（Canvas + HTML/Shadow DOM UI） | `forgeax project capture --backend auto --require-ui --output <png> --json` |
| 无显示器/无物理 GPU 的软件截图 | `forgeax project capture --backend software --require-ui --output <png> --json` |
| 同一局自动游玩并在多个状态检查点截图 | `a Node or Bun script using the SDK command client <scenario.mjs> --json` + `browser.open()` / `session.capture()` |
| 发现命令和参数 | `forgeax help [path] [--tree] [--json]` |
| 执行 build/resource-preview/authoring operation | `forgeax project ...` / `forgeax asset ...` / `forgeax debug ...` |
| 用程序组合多个 operation | 普通 Node 或 Bun 模块导入 SDK command client |
| 检查或维护项目插件 | `forgeax project plugin list|inspect|configure|disable|enable|install|uninstall` |
| 查询或修改活 World/Renderer | 下文 `eval(script)` |
| 离线分析 RHI tape | `forgeax-engine-rhi-debug` |

> [!IMPORTANT]
> `forgeax project new` 必须显式选择模板：3D 游戏用 `game-3d`，否则用 `empty`。目标必须位于解压 SDK 之外；SDK 根或其子目录返回 `project-target-inside-sdk`。`forgeax project init` 面向已有外部工程。

> [!IMPORTANT]
> 选择 `game-3d` 会复制可直接运行的、有内容的 third-person reference，而不是空白场景：示例 scene、可见物/碰撞体、角色/材质/动画 pack 和 UI 都会进入新工程。创建后先读生成的 `README.md`，再按目标保留、调整、替换或删除；删除时同步更新 scene、runtime code 和 pack references。

`sdk install` 从公开 npm registry 获取与当前 CLI 相同版本的
`@forgeax/engine-sdk` carrier；npm integrity 是传输校验，carrier 内的
`sdk-manifest.json` 再校验 SDK 版本。GitHub Release 是私有内部归档，不是
用户下载源。目标必须为空，下载、版本检查和复制任一步失败都会清理 staging。

项目操作、组合、preview evidence 和可选 service acceleration 的完整契约见
[`references/authoring-operations.md`](references/authoring-operations.md)。只在这些任务中加载该页。

Resource preview operations are Engine-owned host-realm plugins. The public operation union is
`project.preview`, `material.preview`, `mesh.preview`, `vfx.preview`, and `texture.preview`;
the four resource operations accept `{ "guid": "...", "size": 512 }`, where `size` is optional,
square, and power-of-two (64..4096, default 512). Mesh framing derives from the asset AABB;
texture framing is an aspect-preserving orthographic unlit quad on black with no lights or tonemap.
`forgeax dev start` / `forgeax project preview` start the source-development asset path; `forgeax project preview` verifies and
serves built `dist/`. They are project commands, not resource `*.preview` operations. There is no
generic `asset.preview` facade or legacy preview command.

## 浏览器合成截图

> [!IMPORTANT]
> 这是开发态视觉证据能力，不限定为无 GPU 主机。默认 auto 使用可用的浏览器适配器；
> 需要在无显示器/无物理 GPU 环境运行时，显式传 backend software。普通 preview、玩家路径和
> release acceptance 不会自动切换到软件后端。

```bash
forgeax project capture --backend auto --require-ui \
  --output artifacts/capture/game-ui.png \
  --width 1280 --height 720 --wait-ms 4000 --json
```

命令使用 source-development host；Linux 缺少 `$DISPLAY` 时自动补 Xvfb，并调用真实 Chromium
的 `page.screenshot()`。因此一张 PNG 同时包含 Canvas、普通 HTML 和 open
ShadowRoot UI；只读 canvas pixels 或 `canvas.toDataURL()` 不包含 DOM UI。相邻 JSON sidecar
记录实际 `GPUAdapterInfo`、Chrome 版本、X display、lavapipe ICD、canvas/UI witness 与
console/page errors。`--require-ui` 要求生成 host 的 `#game-ui` 下至少挂载一个游戏 UI 子节点；
引擎或浏览器自身的 ShadowRoot 不能冒充游戏 UI。

backend auto 在 WebGPU adapter 不可用时回退到 software；backend hardware 要求非软件 adapter；
backend software 固定 SwiftShader/lavapipe 兼容参数。旧 `--software` 仍是 software 别名。
CLI 会自适应等待 canvas 出现非平坦像素，再追加 `--wait-ms` settle；uniform 黑帧即使
canvas、adapter、ShadowRoot 结构都存在也失败。sidecar 的 `pixels` 保存 canvas-only sampled
luma range；witness 截图会临时隐藏所有非 canvas 元素，因此 HTML HUD 自身的颜色变化不能
掩盖黑色 3D 帧；最终 PNG 仍是完整页面合成结果。

Browser context 固定 viewport/screen、DPR 1、sRGB、light color scheme、`en-US`、UTC，并等待
`document.fonts.ready`。项目仍须携带同一份 Web 字体；system font fallback 不能作为布局或色彩
parity 契约。

本机与远端要比较像素或色彩时，加 `--deterministic`。CLI 会用 `?forgeaxCapture=1` 打开页面；
Engine App 在 Renderer 真实提交帧后发布 `document.documentElement.dataset.forgeaxFrameSubmitted`，
并在 canvas 派发 `forgeax:frame-submitted`。CLI 先等待这个引擎信号和非平坦 canvas crop，再等待
游戏发布的 `document.documentElement.dataset.forgeaxCaptureReady = 'true'`。游戏在发布 ready 前负责
固定随机种子、逻辑帧、状态与项目内 Web 字体。只固定 viewport、DPR 和等待毫秒数不构成 parity。

连续游玩截图不要循环调用一次性 `capture`，否则每张图都会重启页面和 World。用已有组合入口：

```js
export default async function scenario({ browser }) {
  const session = await browser.open({
    backend: 'auto',
    deterministic: true,
    requireUi: true,
    outputDir: 'artifacts/playthrough/boss-flow',
  });
  try {
    const { page } = session;
    await page.getByRole('button', { name: '开始' }).click();
    const spawn = await session.capture('spawn');
    await page.keyboard.press('KeyW');
    const arena = await session.capture('arena');
    return { report: session.reportPath, captures: [spawn, arena] };
  } finally {
    await session.close();
  }
}
```

```bash
a Node or Bun script using the SDK command client tests/playthrough.mjs --json
```

游戏把命名状态写入 `document.documentElement.dataset.forgeaxCaptureReady`；`capture('arena')` 组合
等待 Engine frame signal、精确值、非平坦 canvas crop 后截浏览器 compositor。`session.page` 保留原生 Playwright 输入与
断言，不再造 workflow DSL；DevKit 只拥有 Vite/Xvfb/Chrome 生命周期、画面稳定、PNG/evidence
和有序 `run.json`。普通 Node 或 Bun 模块只返回 JSON-safe 值，并在 `finally` 释放自己创建的
`Page` 或 session。

| 路径 | 软件后端 | 证据边界 |
|:--|:--|:--|
| Dawn/Node smoke | Mesa lavapipe | GPUTexture readback；不含 DOM |
| `forgeax project capture --backend auto` | Chrome 硬件适配器（不可用时回退 software） | 浏览器最终合成的 Canvas + DOM/Shadow DOM |
| `forgeax project capture --backend software` / `a Node or Bun script using the SDK command client` persistent session | Chrome SwiftShader + Xvfb | 浏览器最终合成的 Canvas + DOM/Shadow DOM；后者保留同一游戏状态连续截图 |

> [!CAUTION]
> 软件像素用于截图迭代和确定性回归，不代表物理 GPU 性能、厂商驱动兼容、HDR 显示设备或发布验收。

## 外部游戏静态构建

```bash
forgeax project build ./games/my-game \
  --base /games/my-game/ \
  --out-dir ./website-staging/games/my-game \
  --json
```

| 输入 | 契约 |
|:--|:--|
| `<project>` | 包含 `forge.json` 与项目入口的外部游戏目录；项目文件是 author authority。 |
| `--base` | 静态托管 URL 前缀；传入 Vite、Pack index 与运行时资源 URL。 |
| `--out-dir` | 专用派生目录；相对路径以项目目录解析，构建前清空。 |
| `--json` | 返回 `forgeax-dist.json` 对应的完整 artifact/digest 闭包。 |

DevKit 是生成 host、Vite、Shader、Pack cooking 与 dist manifest 的唯一 owner。Website、CI
和其他发布 host 只选择输入/输出位置，不复制构建配置，也不重写 Engine 产物。
`forge.json#plugins[]` 是唯一的启动与组合权威；DevKit 从这棵 EntryTree 派生各 realm 的
静态 Catalog，并在项目启动时交给原生 Loader/Fiber。发布 host 不需要也不得再生成第二套
入口或 bootstrap 清单。

## Web 游戏发布

```bash
forgeax project package --format web-zip --json
forgeax project package --format web-zip --output release/my-game-web.zip --json
```

`package` 重新执行相对基址生产构建，校验 `forgeax-dist.json` 中每个文件的大小与 SHA-256，
再按显式 format 生成交付物。未传 `--format` 时保持 `web-zip` 默认值。ZIP 根直接包含
`index.html`、hashed JS/WASM、shader manifest、pack index 与 cooked assets；Engine runtime 已在
闭包内，不携带 SDK source、`node_modules`、author source 或 remote 调试服务。

| 动作 | 入口 | 判定 |
|:--|:--|:--|
| 本机开发 | `forgeax dev start` | HMR 与开发 catalog；不是发行证据 |
| 本机验收 | `forgeax project preview` | 通过 HTTP 服务已校验的 `dist/` |
| 生成 Web 发行物 | `forgeax project package --format web-zip` | 输出 `release/*-web.zip` 与 SHA-256 |
| 分享给玩家 | 将 ZIP 上传到 HTTPS 静态/HTML 游戏托管 | 玩家打开 URL；不得双击 `index.html` |

> [!CAUTION]
> 这条 HTTP(S) 约束只适用于 `web-zip`：ZIP 内的 `index.html` 仍不得通过 `file://` 双击。
> `single-html` 是另一种显式制品，只有它通过下面的单文件验收门后才支持 `file://`。

## 单 HTML 离线交付

```bash
forgeax project package --format single-html \
  --output release/my-game-offline.html --json
```

`single-html` 与 `web-zip` 共享 project facts、相对基址生产构建和
`forgeax-dist.json` 完整闭包校验；随后 DevKit 把真实模块入口、动态模块、Engine/Kernel
Worker、WASM、Pack、Shader、媒体与字体资源收进一个 HTML。输出位于 `dist/` 之外，并写入
相邻 `release/my-game-offline.html.sha256`；JSON 结果中的 `html.path`、HTML SHA-256、
`distManifestSha256` 和 `embeddedAssets` 是候选身份，验收和晋升始终指向同一个绝对路径。

先完成通用门，再运行游戏工程自己的玩法 scenario：

| 层 | 必须证明 |
|:--|:--|
| 结构 | 候选只有一个 HTML，且闭合已校验的 dist 资源；无旁路 JS/CSS/Worker/WASM 文件 |
| 离线 | 目标 Chrome 以 `file://` 打开候选，HTTP/HTTPS 请求数、failed request 和资源 miss 均为 0 |
| Engine | `console/page error` 为 0，Canvas 尺寸正确且有真实提交/非平坦画面，Worker/WASM/Pack/Shader 可用 |
| 可玩 | 项目 scenario 证明输入、状态变化和关键玩法；ready 或单纯有 Canvas 不能替代它 |

`browser.open({ target: { kind: 'single-html', path }, launchProfile: 'release' })` 可复用
浏览器生命周期做通用门；release profile 不使用 `--allow-file-access-from-files` 等 unsafe
放宽参数。硬件或可见目标 Chrome 不可用时，保留候选与已通过证据并标记玩家条件
`not-run`，不得把软件截图或 HTTP preview 宣称成单文件玩家通过。

活实例路径由 `@forgeax/engine-remote` 把一段 JS 发给运行中的引擎实例求值并取回结果。用
`world.query` 发现 handle，再直接读写活根；包自带 bin 处理离线数据。

## 心智模型

`eval(script)` 在 host 进程的 `new Function` 作用域执行，作用域内注入五个活根：

| 活根 | 类型 | 用途 |
|:--|:--|:--|
| `world` | `World`（来自 `@forgeax/engine-ecs`） | ECS 读写：spawn / despawn / set / query |
| `renderer` | `Renderer` | 渲染器控制：创建/销毁 RT、读 backbuffer |
| `assets` | `AssetRegistry` | 资产查询：loadByGuid / resolveName / rename |
| `rhiCapture` | `{ captureFrame(options?) } \| undefined` | RHI 单帧抓取：返回一个 `{ kind: 'rhi-tape', digest, bytes }` artifact。**仅当 createApp 运行在 `FORGEAX_ENGINE_RHI_DEBUG=1` 时注入**，否则 `undefined`（用前先 guard）。world / renderer / assets 三根恒在场。 |
| `profiler` | `Profiler \| undefined` | Bounded CPU capture through `startCapture({ frameLimit, eventLimit })`; injected only when the host opts in. |

脚本内通过 `_import(specifier)` 按需引入组件 token。`_import` 是 eval 作用域注入的 import 函数；脚本内没有裸 `import` 关键字。

> [!NOTE]
> **协议层另有一个内建方法 `introspect`**（与 `eval` 并列）：返回 OpenRPC L2 子集文档，列出可用方法（`eval` / `introspect`）+ eval 作用域活根。AI 用户连上后可先 `introspect` 自描述，无需读源码即知能 eval 什么。错误码映射 JSON-RPC -32001..-32005。

**安全模型**：eval 全开（无只读拦截、无能力黑名单）。唯一边界是 host 起不起 server：`createApp` dev 模式默认 wire `app.remote`（WS server 在场）；production 默认不起 server（天然安全）。危险 API（`renderer.dispose()` / `world.despawn`）允许执行，详见末尾 NOTE。

## 传输路径

三条路径统一收束到同一个 `eval(script)` 协议：

```mermaid
flowchart TD
    A[AI 用户 / CLI / 进程内] -->|eval| E[eval 核心<br/>host realm new Function]
    E -.->|_import| ECS["component tokens"]
    E --> R["eval 作用域活根<br/>world · renderer · assets · rhiCapture · profiler"]
    R --> W[运行中 World / Renderer]
```

| 路径 | 形态 | 适用场景 |
|:--|:--|:--|
| 进程内 client | `app` 获取 `RemoteHandle`，`client.eval(script)` | host 自身做查询/调试（零网络开销） |
| WS JSON-RPC 2.0 | `ws://localhost:5732` 发 `{"method":"eval","params":{"script":"..."}}` | 外部工具 / AI 代理连运行中引擎 |
| 统一 CLI | `forgeax help`、`forgeax asset`、`forgeax debug`、`forgeax dev` | 发现、离线操作和活实例观察 |

## 核心 API / bin 速查

| 名字 | 来源 | 形态 | 用途 |
|:--|:--|:--|:--|
| `client.eval(script)` | `@forgeax/engine-remote` | `async (script: string) => Promise<Result<unknown, RemoteError>>` | 对运行中引擎执行一段 JS，取返回值 |
| `RemoteHandle` | `@forgeax/engine-types` | `{ port: number; close(): Promise<void> }` | `app.remote` 的类型；暴露 server 端口与关闭方法 |
| `RemoteError` | `@forgeax/engine-remote` | class extends Error，含 `.code` / `.expected` / `.hint` / bounded `.detail` | 结构化错误，5 成员 `RemoteErrorCode` 闭集 |

> [!IMPORTANT]
> 所有公开操作都从统一命令树进入。`RemoteErrorCode` 只描述运行中 eval 的执行桥错误；离线命令使用各自领域的结构化错误联合。

## handle 发现配方

空 descriptor 访问所有启用实体；`row.entity` 是完整 packed handle。

```js
const query = world.query({});
if (!query.ok) throw query.error;
return Array.from(query.value, (row) => row.entity);
```

带组件数据时从所属包导入 token，并声明 `read` / `write` / `optional` / filter 角色：

```js
const { MeshRenderer } = await _import('@forgeax/engine-render');
const { Transform } = await _import('@forgeax/engine-scene');
const query = world.query({ read: [Transform], with: [MeshRenderer] });
if (!query.ok) throw query.error;
return Array.from(query.value, (row) => ({
  entity: row.entity,
  position: Array.from(row.get(Transform).pos),
}));
```

## 读写配方

### 读组件值

```js
const { Transform } = await _import('@forgeax/engine-scene');
const query = world.query({ read: [Transform] });
if (!query.ok) throw query.error;
return Array.from(query.value, (row) => ({
  entity: row.entity,
  position: Array.from(row.get(Transform).pos),
}));
```

`Transform.pos` is the flat `array<f32, 3>` column; row `i` starts at
`i * 3`. `quat` and `scale` use strides 4 and 3 respectively, and query
bundles do not expose `.x` / `.y` / `.z` sub-fields.

### 写组件值 / 生命周期

```js
// spawn——带组件
const scene = await _import('@forgeax/engine-scene');
const h = world.spawn({
  component: scene.Transform,
  data: { pos: [0, 5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
}).unwrap();

// set——直接修改已存在实体的组件值
world.set(h, scene.Transform, { pos: [1, 2, 3] });

// despawn
world.despawn(h);
```

eval 无任何写入拦截——`spawn` / `set` / `despawn` 直接执行，不会返回 `inspector-write-denied`（该错误码已随 sandbox 删除）。危险操作（`renderer.dispose()` 等）见末尾 NOTE。

## rhiCapture 单帧抓取

eval 内通过第 4 活根 `rhiCapture` 做 RHI 帧抓取：

```js
if (rhiCapture === undefined) return { ok: false, error: { code: 'capture-unavailable' } };
const capture = await rhiCapture.captureFrame();
if (!capture.ok) return capture;
return { kind: capture.value.kind, digest: capture.value.digest };
```

离线 operation（`rhi.summary` / `rhi.inspect`）是纯本地工具，不连 WS，不受 eval 收编影响。详见 [`forgeax-engine-rhi-debug`](../forgeax-engine-rhi-debug/SKILL.md)。

## Profiler artifact path

When the host passes the public `profiler` capability to `createApp`, use the existing `eval`
method to start a bounded capture. This adds no RPC method and does not change the remote transport.

```js
if (profiler === undefined) return { ok: false, error: { code: 'profiler-not-enabled' } };
const started = profiler.startCapture({ frameLimit: 120, eventLimit: 1024 });
if (!started.ok) return started;
// Drive the live App, then finish and persist the returned ProfileCapture.
return started.value.finish();
```

For offline analysis, use the unified debug command on the captured artifact:

```bash
forgeax debug profile summary --root ./game --artifact profile-capture.json --json
forgeax debug profile frame --root ./game --artifact profile-capture.json --frame-id 12 --json
forgeax debug profile phase --root ./game --artifact profile-capture.json --source render --phase record --json
```

Read `validateProfileCapture` and `buildProfileModel` from the profiler package for schema and
semantic recovery. The profiler covers bounded App/Render CPU evidence only; it is not an ECS span,
GPU timestamp, UI, or external trace path.

## createApp 默认在场

`createApp` dev 模式默认起 remote server，消隐"没 wire 等于没有"黑洞：

```ts
import { createApp } from '@forgeax/engine-app';

const app = await createApp({ canvas });

// dev 模式：app.remote 非 undefined，port > 0
if (app.remote) {
  console.log('remote eval server on port', app.remote.port);
  // 进程内直接 client.eval(...)
  // 或外部工具连 ws://localhost:<port>
}

// production 模式：app.remote 为 undefined（server 不启，天然安全）
```

`RemoteHandle` 类型（`{ port: number; close(): Promise<void> }`）定义在 `@forgeax/engine-types`，host 类型面不静态引 `@forgeax/engine-remote`。

## dev：驱动**运行中的浏览器**引擎

> [!IMPORTANT]
> **浏览器由 `forgeax dev` 持有。** Node 端负责项目重载、前端连接和稳定控制端点；浏览器只通过 App execution bridge 执行观察操作，CLI 不复制 World。

`dev start` 在稳定宿主外启动可替换的项目进程，并让页面拨出一条 loopback bridge；后端通过 HTTP 控制端点转发到真实 main 或 Worker realm。页面刷新、Project 重载或 World 重建都会旋转实例身份。

```
 forgeax dev eval  --HTTP-->  持久化 dev owner  --bridge-->  浏览器页面
   (CLI)          <--{ok,value}--   真实 App/Worker realm     <--{result}--
```

页面 bridge 只在 DevKit 开发宿主显式注入时启用；普通项目启动和 production 不连接 loopback。断线时宿主报告 `bridgeConnected=false`，不会伪造 ready。

**帧起始 drain（确定性）**：WS `message` 可能落在 rAF tick 任意相位，页面**不内联 eval**，而是入队、在 `app.registerUpdate`（帧起始）里 drain——每次 bridge 写都保证过这一帧的 systems，跨运行可复现。代价：回复延到那次 drain（亚毫秒）；**页面被切到后台 → rAF 暂停 → drain 停 → 30s 超时**，保持窗口前台。

**安全**：中继给"任何能 POST 到 :5733 的东西"授予"在页面里跑任意 JS"。仅 loopback、仅 DEV、只由 dev 栈启动。**绝不**对 production / 公网暴露。

### 用法

```bash
forgeax dev start --root ./game --json
forgeax dev status --root ./game --json
forgeax dev focus --root ./game --instance-id '<from status>' --world-identity '<from status>' --entity 42 --json
forgeax dev capture --root ./game --instance-id '<from status>' --world-identity '<from status>' --output focused.png --json
forgeax dev eval --root ./game --instance-id '<from status>' --world-identity '<from status>' --code 'return world.identity' --json
```

`dev eval` 的 caller timeout 与实际脚本执行分离：尚未进入执行端可撤销，已开始则明确返回 `live-eval-continuing`，期间 status 可见且冲突写操作被拒绝。`reload`/`stop` 销毁旧页面或 Worker 后，旧实例身份立即失效。

> [!NOTE]
> **Node 与浏览器共用同一执行契约**：`dev` 负责浏览器现场，Node/dawn-node 仍可显式启用 `@forgeax/engine-remote/server`；两条路都收束到同一个 `executeScript` eval 核和 `RemoteError` 模型。

## RemoteErrorCode 闭集（5 成员）

```mermaid
stateDiagram-v2
    direction LR
    state "脚本语法错" as scriptSyntaxError
    state "脚本运行期抛错" as scriptRuntimeError
    state "server 起不来（端口被占等）" as serverStartupFailed
    state "server 未运行（客户端尝试连接但 host 未起）" as serverNotRunning
    state "eval 结果不能跨 JSON-RPC" as evalResultNotSerializable
```

| code | JSON-RPC 段位 | `.expected` | `.hint` |
|:--|:--|:--|:--|
| `script-syntax-error` | -32001 | `'script body is valid JavaScript'` | `'check syntax position in errMessage; fix and resubmit'` |
| `script-runtime-error` | -32002 | `'script executes without throwing'` | `'inspect error; verify symbol availability; eval has full access to world/renderer/assets'` |
| `server-startup-failed` | -32003 | `'server starts successfully on requested port'` | `'check if port is already in use (default 5732); pass different port; or kill existing process holding the port'` |
| `server-not-running` | -32004 | `'server is reachable at ws://localhost:<port>'` | `'start the demo first; verify app.remote is wired; pass --port to override default 5732'` |
| `eval-result-not-serializable` | -32005 | `'eval result is JSON-serializable'` | `'return a JSON-safe value; BigInt and cyclic objects are unsupported over JSON-RPC'` |

消费方式——`switch (err.code)` 穷举 5 成员，无 `default` 分支（TS 严格模式守完整性）：

```ts
import { RemoteError, type RemoteErrorCode } from '@forgeax/engine-remote';

function recover(code: RemoteErrorCode): string {
  switch (code) {
    case 'script-syntax-error':     return 'fix script body syntax and resubmit';
    case 'script-runtime-error':    return 'inspect stack trace; verify symbol availability';
    case 'server-startup-failed':   return 'pick a different port or free port 5732';
    case 'server-not-running':      return 'start demo dev or wire app.remote';
    case 'eval-result-not-serializable': return 'return a JSON-safe eval result';
  }
}
```

## 统一命令

渐进式发现和执行都从同一份插件声明派生：

```bash
forgeax help
forgeax help asset --tree --json
forgeax asset list --root ./game --json
forgeax asset verify --root ./game --json
forgeax asset import ./model.glb --root ./game --json
forgeax dev status --root ./game --json
```

状态查询通过 `forgeax dev eval` 发送到当前实例；领域插件负责导入、Cook、Meta 和 LKG 规则。

## 踩坑

- **eval 内不能用裸 `import`**：脚本作用域不认 `import` 关键字——用注入的 `_import(specifier)` 函数做动态 ESM 引入。`const ecs = await _import('@forgeax/engine-ecs')`。
- **`world.query` 返回 `Result`**：先处理失败，再迭代 `result.value`；不要忽略 descriptor 冲突或 span capability 错误。
- **浏览器现场不可用**：确认 `forgeax dev status --root ./game --json` 的 `phase`、`bridgeConnected` 和 `worldIdentity`，不要临时创建第二个 Page。Node/dawn-node 才显式启用 `@forgeax/engine-remote/server`。
- **旧独立 bin 找不到**：这是预期行为；使用 `forgeax help --tree` 发现统一的 `asset`、`debug` 和 `dev` 命令。

## 深入

- 包定位 / RemoteError 类 / RemoteErrorCode SSOT / 物理隔离 gate：见 `packages/remote/README.md`
- 错误模型源码：`packages/remote/src/errors.ts`
- eval 执行引擎源码：`packages/remote/src/execute.ts`
- server 源码：`packages/remote/src/server.ts`
- `RemoteHandle` / `RemoteErrorCode` / `RemoteError` 类型定义：`packages/types/src/index.ts`
- producer owner 仍位于 `packages/pack/src/cli-asset.ts`、`packages/font/src/cli-font.ts` 和 `packages/gltf/src/cli-gltf.ts`；这些是 DevKit 延迟加载的内部实现，不再发布独立 bin。

## RHI 调试 operations（capture / summary / inspect）

> RHI 调试统一走 `forgeax debug rhi capture`、`forgeax debug rhi summary`、`forgeax debug rhi inspect` 三个命令。`rhi.capture` 返回单个 `ArtifactRef(kind='rhi-tape')`，`rhi.summary` 从 artifact 派生 `FrameModel.works`，`rhi.inspect` 按 `workIndex` 在 fresh backend 上读取状态和像素；不再走独立 JSON-RPC method。flag 表、输出 schema、症状定位工作流全在 [`forgeax-engine-rhi-debug`](../forgeax-engine-rhi-debug/SKILL.md)（SSOT）。

## 状态与资产命令

状态查询通过 `forgeax dev eval` 发送到当前实例；资产扫描、验证和导入统一走
`forgeax asset list|verify|import`。能力由项目插件声明，help 会显示可用的路径和参数。
状态查询通过 `forgeax dev eval` 发生在真实 Engine realm；状态插件保留自己的 schema 和生命周期，不再发布独立 CLI。

### Deeper

- State machine API surface: [`forgeax-engine-state`](../forgeax-engine-state/SKILL.md)

---

> [!CAUTION]
> **危险 API NOTE**：eval 全开可读写——脚本内可以调用 `renderer.dispose()`（销毁 GPU 上下文、整个 app 崩溃）、`world.despawn` 批量清实体、`AssetRegistry.clear()` 等破坏性操作。引擎不做代码层拦截。production 环境的天然安全来自不起 server（`app.remote` 为 `undefined`）；dev 环境的保护靠开发者自觉。AI 用户在 dev 模式 eval 前确认脚本不含毁灭性 API 调用。

## Visibility diagnostics quick start

Use the existing `introspect` and `eval` surfaces; there is no visibility CLI
command. First inspect `components.schemas.Visibility`, then evaluate the
same live path used by the app:

```ts
const render = await _import('@forgeax/engine-render');
const query = world.query({ read: [render.Visibility] }).unwrap();
for (const row of query) console.log(row.get(render.Visibility).state);
console.log(render.resolveVisibility(world).effective(entity));
console.log(renderer.visibilityStats);
```

| Signal | Meaning | Recovery |
|:--|:--|:--|
| `current` | Component intent currently stored in ECS | Use reflected labels and retry a rejected `world.set` |
| `effective` | Parent-resolved state consumed by render candidates | Repair `snapshot.diagnostics` when hierarchy input is invalid |
| `visibilityStats` | Renderer count for explicitly hidden candidates | Inspect the real render path; do not add an RPC or CLI method |

The remote server receives a JSON-safe registry projection from app. It keeps
the two existing methods and the closed `RemoteError` shape; production remote
still has no ECS, render, or runtime dependency. Camera, picking, lifecycle,
assets, material authoring, and VFX shadow policy are out of scope.

## Simulation inspection through the existing front door

Discover the `simulation` root from `introspect`, then read
`simulation.inspect()` through existing `eval` transport. Consume the summary
fields and schema; do not add a Remote/CLI restore or replay method and do not
return raw World, Rapier, or Web Audio objects.

For errors, switch on the closed `code` and use `expected`, `hint`, and
`detail`. Repair the owner or fresh target and inspect again. RHI tape replay
and game replay have separate commands and evidence owners.
