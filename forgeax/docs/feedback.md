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
