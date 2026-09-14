# Asset catalog and import contracts

Use `../SKILL.md` for authority and recovery. This reference covers Catalog identity,
source sidecars, compression, custom importers, and runtime byte decode.

## CatalogSource：先订阅，再枚举

> [!IMPORTANT]
> Catalog 是完整可枚举行集加可订阅行级变化。`CatalogDelta` 只表达
> `added`、`changed`、`removed` 三集合；Vite producer 不替 consumer 选择
> reload。先 `subscribeCatalog`，再 `enumerateCatalog`，本地以 GUID 合并。

```ts
const stop = assets.subscribeCatalog((delta) => mergeRowsByGuid(delta));
const snapshot = await assets.enumerateCatalog();
if (!snapshot.ok) {
  console.error(snapshot.error.code, snapshot.error.hint);
  // 修复 source / endpoint 后再次 enumerate；失败不永久缓存。
} else {
  replaceOrMergeRowsByGuid(snapshot.value);
}
stop();
```

- `added` / `changed` 均携带完整 `CatalogEntry`；`removed` 仅携带稳定 GUID。
  完整字段以 `@forgeax/engine-types` 的 `CatalogEntry` / `CatalogDelta` 为 SSOT。
- `setCatalogSource(source)` 是 runtime 注入点；未注入时返回结构化
  `catalog-source-unconfigured`，读取 `.code` / `.hint` 自救，不能把失败当空列表。
- 晚订阅或 transport 中断后，重新 `enumerateCatalog()` 并按 GUID 幂等归并；
  静态 source 的 subscribe 是安全 no-op，不伪造持续变化。
- `pluginPack` 只发送 `forgeax:catalog-delta`。需要内容热刷新 的 engine host
  在 `vite.config.ts` 显式 `refresh: reloadAssetHost()`；source-only 字节变化不伪造 delta。
  editor 使用同一 source 增量更新 Content Browser，不应通过 engine 增加 CRUD 或 reload 特例。

Editor consumer 必须 pin 到包含此合同的 engine revision；不要用未固定 workspace
link 宣称跨仓验证。实际的 pin 和组合 gate 由 editor 的 `packages/engine` gitlink
及 CI assertion 共同固定。

**`refs` 是权威引用图协议**。每个资产的 `AssetEnvelope.refs: readonly AssetRef[]` 携带该资产 transitive 依赖的所有 GUID，递归加载 `loadByGuid` 遍历 `envelope.refs`，kind-agnostic（不按 `asset.kind` 分发）。三条历史旁路——`collectRefs()`（按 kind 穷举 switch 图遍历）、`storedNameOf` side-table（name 旁路存储）、`assetBrand()` 穷举 switch——全部退役，由 envelope 内的 `refs` / `name` / `ASSET_BRAND` Record 表替代。

### AssetRef 边元数据

```ts
interface AssetRef {
  readonly guid: string;                              // 被引用资产的 GUID
  readonly sourceField?: {
    readonly componentName?: string;                  // 组件名（如 'MeshRenderer'、'MeshFilter'）
    readonly fieldName: string;                       // handle 字段名（如 'mesh'、'materials'、'parent'）
    readonly arrayIndex?: number;                     // 数组下标（array<handle<T>> 时）
  };
  readonly sceneEntityId?: number;                    // scene 实体 localId（sceneAsset 内引用时）
}
```

**sourceField 是结构化 triple**——AI 用户通过属性访问消费（`ref.sourceField?.componentName` / `ref.sourceField?.fieldName` / `ref.sourceField?.arrayIndex`），永远不需要字符串解析（charter P3）。贴图边（texture edges）无 entity 视角来源 → `sourceField = undefined`。`sceneEntityId` 仅在场景内 handle 字段引用时有值。

### 递归加载：kind-agnostic

`loadByGuid(guid)` 的递归核心只有一个循环：`for (const ref of envelope.refs) { loadByGuid(ref.guid) }`。不再有 `if (asset.kind === 'material') { /* Path A: texture preload */ }` 或 `if (asset.kind === 'material' && parent) { /* Path B: parent preload */ }` 的 per-kind 分支——所有引用统一走 `envelope.refs`。material parent edge 的特殊面包屑提示「loading parent material X for child Y」通过检测 `ref.sourceField?.fieldName === 'parent'` 在统一循环内分支产生。

## 心智模型

资产的唯一身份是 **GUID**，不是文件路径。展示身份是 `<packagePath>.<name>` 两段式，由 `resolveName(guid)` 统一解析——name 不入 POD（OOS-2），不入 `Package` 对象（Derive 原则）。链路四段：

- **磁盘 sidecar**——每个资产一份，两条路按"有无源转换"二选一（详见 §两路 sidecar 选择）：有源文件待转换（图片 / glTF / 字体 / UI HTML/CSS / host 自定义二进制）用 `<source>.meta.json`（`external-asset-package`，`importer` 字段选导入器），无源转换的手写或已准备好 payload 的资产用 `<name>.pack.json`（`internal-text-package`，自包含 payload）。UI 的可读 HTML/CSS 应优先使用 `*.ui.html` + 同名 `*.ui.css` + `.meta.json`，由 UI importer 生成最终 `UiAsset`；只有刻意准备好的终态小 UI 才直接使用 `*.pack.json`
- **CLI 扫描**——`forgeax asset scan/verify` 跑 6 步 fail-fast 校验
- **构建期折叠**——`vite-plugin-pack` 把所有 sidecar 折成一张 `pack-index.json`（`PackIndexEntry` 行含 `name?` 字段，add-only）
- **runtime 取 payload + identity**——两条入口：编译期已知资产用 `assets.register(asset)` / `registerWithGuid(guid, asset)` 直接登记；磁盘资产先 `assets.configurePackIndex(url)` 再 `await assets.loadByGuid<T>(guid)` 异步取回 payload `T`（feat-20260614 de-handle 后直接返 `T`）；`resolveName(guid)` 统一解析 `<packagePath>.<name>` 的 name 段。内部 `assetCatalog: Map<string, AssetEnvelope>` 按 GUID 存信封 `{ guid, kind, name?, payload, refs }`——`refs` 是加载递归的权威源，`name` 是 per-GUID 存储名的唯一位置。

### Package 概念（feat-20260618）

每个导入源文件是一个 **Package**：同一 `.glb` / `.fbx` / `.pack.json` 产出的所有 asset 共享一个 `Package`。`AssetRegistry` 维护 `packageOf: Map<guid, Package | null>`，并由 `deriveAssetName` 统一投影显示名：有显式 entry name 时优先使用（单/多 asset 均适用），否则使用 package path basename；无 package asset（builtin / 内存态 `catalog()`）为 `null`，无自带名时返回空串。1 个 package 的 asset 数从 1 增至 N 时，registry 只对原先无名 asset 自动固化派生名为存储名；幂等，调用方无感无报错。

`Package` payload 经 `@forgeax/engine-types` 单入口 IDE autocomplete 可发现。`packageOf(guid)` 返 `Package | null | undefined`（undefined = GUID 未注册）。

### 压缩管线（compression pipeline）

> [!NOTE]
> feat-20260706 M1-M5 引入 zstd 通用打包底座 + KTX2 容器统一。压缩对 AI 用户完全透明：`loadByGuid<T>` 调用形态零变化，`fetchBinary` 内部自动解压。

**`compression` 字段**：`PackIndexEntry.compression?: 'none' | 'zstd' | 'basis-etc1s' | 'basis-uastc' | 'basis-uastc-hdr'`（以及 `ImageMetadata.compression?` / `meta.json` `subAssets[].compression`）。`'zstd'` 表示资产 `.bin` 经 zstd 通用压缩，`'basis-*'` 表示纹理经 Basis 块压缩编码为 `.ktx2`。`undefined` 或 `'none'` 表示未压缩。默认策略：mesh `.bin` → `'zstd'`，纹理 `.bin/.ktx2` → 由 sidecar `compressionMode` 字段决定（default `'auto'`）。

**自动解压（transparent to AI user）**：`loadByGuid` 内部经 `fetchBinary(url, { compression })` 关口。当 `compression === 'zstd'` 时，`fetchBinary` 自动调用 `@forgeax/engine-codec` 的 `decompressZstd` 解压后返回原始字节。当 `compression` 以 `'basis-'` 开头时，`fetchBinary` pass-through（Ktx2 payload already raw block data），`loadTextureAsset` 的 Basis 臂调用 `selectTranscodeTarget` → `transcodeKtx2` 转到设备原生块格式。Loader 侧零逻辑改动——只多传一个参数。解压失败进入 `asset-fetch-failed` 错误（`.detail` 携带 codec 错误），`decompression-failed` / `codec-init-failed` 等 codec 错误码透传在 `.detail` 内。

### compressionMode sidecar（块压缩纹理）

纹理的 `.meta.json` 支持可选 `compressionMode`: `'auto' | 'etc1s' | 'uastc' | 'none'`（default `'auto'`，零配置）。完整语义见 [`@forgeax/engine-image` README](../../../packages/image/README.md#compressionmode-sidecar-field)。

| Mode | 行为 |
|:--|:--|
| `'auto'`（默认） | colorSpace=srgb → ETC1S, colorSpace=linear → UASTC-LDR, HDR(.hdr) → UASTC-HDR |
| `'etc1s'` | 强制 ETC1S Basis 编码（fast preset, deterministic） |
| `'uastc'` | 强制 UASTC-LDR 4x4 Basis 编码（fast preset, deterministic） |
| `'none'` | 跳过压缩，产出 raw RGBA `.bin`（旧路径兼容） |

### 压缩纹理 mip 离线烘焙约束

块压缩纹理 **不支持运行时 mipmap 生成**——压缩格式不是 render-target-compatible。加载压缩 `TextureAsset` + `mipmap: true` → `mipgen-unsupported-compressed-format` 错误（`.hint` 指引 `.meta.json` 设 `compressionMode:'none'` 或 `mipmap: false`）。mip 链必须在导入期离线烘焙：`.meta.json` 中 `importSettings.mipmap: true` 触发 encoder box-filter 离线 mip 链生成。非压缩纹理（`compressionMode:'none'`）运行时 mip-gen 正常支持。

**`@forgeax/engine-codec` 包**（新包，IDE autocomplete `@forgeax/engine-` 族可发现）：导出 runtime-safe `decompressZstd` / `parseKtx2` / `ktx2LevelsToRGBA`（主入口）和 build-time `compressZstd`（`/encode` 子路径，runtime 禁 import）。KTX2 容器解析器处理 header / index / levelIndex / DFD / KV / SGD 五部分，scheme=2 (zstd) payload 复用同一 `decompressZstd` 实现。详见 [`@forgeax/engine-codec` README](../../../packages/codec/README.md)（API 表 + 错误码 + Loop 2 扩展位）。

**隔离闸门**：`check-image-pipeline-isolation.mjs` path d 强制 runtime 不 import build-time 编码器（`@forgeax/engine-codec/encode`），只允许 runtime-safe 解码主入口。

### AssetEnvelope 信封形态

资产在 catalog 中统一以 **`AssetEnvelope`** 存储——从导入、到 catalog 登记、到递归加载，全程同一形状：

```ts
interface AssetEnvelope {
  readonly guid: string;
  readonly kind: string;          // Asset.kind discriminant 字符串
  readonly name?: string;         // per-GUID 存储名（resolveName 三参规则的 storedName 入参）
  readonly payload: Asset;        // 封闭 Asset union 成员（mesh/texture/scene/...）
  readonly refs: readonly AssetRef[];  // 权威引用图——所有 transitive 依赖 GUID + 边元数据
}
```

**`refs` 是递归加载的权威源**：内部 `loadByGuid` 遍历 `envelope.refs`，kind-agnostic，不按 `asset.kind` switch 分发。**`name` 是 per-GUID 存储名的唯一位置**——已退役的 `storedNameOf` side-table 合入 envelopes；`resolveName` 的三参显示名规则使用 `envelope.name` 作为显式名称，包路径仅作 fallback。

**`ASSET_BRAND` 表驱动品牌映射**——`ASSET_BRAND: Record<Asset['kind'], AssetBrand>` 在 `@forgeax/engine-types` 同文件与 `AssetBrand` union 并置（SSOT），替代已删除的 `assetBrand(asset)` 14-arm 穷举 switch。新增 Asset kind 时只需在 `ASSET_BRAND` 追加一行——Record 索引的键穷举由 TS 编译期守卫，漏写 kind → typecheck 报错。

## host 自定义 importer 注册 = 3 步

> [!IMPORTANT]
> **host（用引擎做游戏的开发者）能注册自己的 importer，把任意源文件折进 pack-index，引擎不需要任何硬编码白名单**（feat-20260629-importer-self-declared-fold-contract）。引擎自有的 `image` / `gltf` / `audio` / `font` importer 与 host importer 走**完全同一条注册路径**——没有特权内建 importer。端到端可运行样例：`apps/hello/custom-importer/`。

| 步 | 做什么 | 在哪 |
|:--|:--|:--|
| **1. 声明** | 写 `.meta.json`：`importer: '<key>'` + `subAssets[].kind: '<host-kind>'`（如 `'reel-game-blob'`）。schema 层 `importer` / `kind` 都是开放 string，host kind 直接被接受，无需改 schema | `assets/<source>.meta.json` |
| **2. 注入 importer** | `pluginPack({ importers: [myImporter()] })` 把 host importer 注入构建期 `ImporterRegistry` | `vite.config.ts` |
| **3. 注册 loader** | `assetLoaderPlugin(myLoader())` 挂入 `app.pluginContext`，以 Fiber effect 可逆登记同 kind 的 loader；`loadByGuid<T>(guid)` 返回 host 自定义 payload `T`（**不**进引擎封闭 `Asset` union） | host 运行期代码 |

### 透传折叠语义（无 `fold` 概念）

`Importer` 接口只有 **`{ key, import }`** 两个成员，**没有 `fold` 方法**——importer `import(ctx)` 产出的 `ImportedAsset.kind` **直接成为** pack-index 行的 `kind`（"透传折叠"）。

```ts
// host importer：透传型，无 fold，无 .bin emission
export function reelGameBlobImporter(): Importer {
  return {
    key: 'reel-game-blob',
    async import(ctx: ImportContext): Promise<readonly ImportedAsset[]> {
      const sub = ctx.subAssets[0];                  // meta 声明的 GUID + kind
      const read = await ctx.readSource();           // 读源字节（GUID import-stable 铁律：importer 不 mint GUID）
      if (sub === undefined || !read.ok) return [];  // 返 [] -> runner 精确归因（charter P3，不裸 throw）
      const payload = JSON.parse(new TextDecoder().decode(read.value));
      return [{ guid: sub.guid, kind: 'reel-game-blob', payload, refs: [] }];
    },
  };
}
```

构建期 `buildCatalog` 对 host importer 走**默认透传**：host 注册了该 key → 折成 pack-index 行（`kind` = `sub.kind`）；未注册 → 保留为 raw-source 行（**不报错拒绝**）。引擎自有 kind（`texture` / `mesh` / `material` / `scene` / `audio` / `font` 等）由引擎 importer 拥有——host importer 声明的 `sub.kind` **撞上引擎自有 kind 时构建期报冲突**（`catalog-host-kind-conflict`），不静默覆盖引擎 loader。

> [!TIP]
> 运行期 `loadByGuid<T>` 对未注册 loader 的 kind **不报错**：直接返回原始 payload（`Record<string, unknown>` + `kind`）让 host loader 自解；注册了 loader 则派发给它。host payload 全程不碰引擎封闭 `Asset` union（`packages/runtime/src/__tests__/host-custom-kind-contract.test.ts` 证端到端）。

## 两路 sidecar 选择（有源转换 vs 无源转换）

> [!IMPORTANT]
> sidecar 两种形态按"**有没有源文件需要转换**"二选一，不是"图片 vs 文本"。

| 维度 | `<source>.meta.json`（`external-asset-package`） | `<name>.pack.json`（`internal-text-package`） |
|:--|:--|:--|
| **适用** | 有源文件待**转换**：图片解码、glTF 解析、字体 bake、host 自定义二进制 → POD | **无源转换**：资产作者**手写** payload（自包含 JSON blob，无外部源） |
| **谁产出 payload** | 构建期 importer（`import(ctx)` 读源字节产 `ImportedAsset[]`） | 作者手写在文件里（`assets[].payload` 直接是 POD） |
| **构建期动作** | `vite-plugin-pack` 调 importer 折成 DDC `.pack.json` + 改写 pack-index 行 | 直接进 pack-index（payload 已自包含，无导入步） |
| **典型 kind** | `texture` / `mesh` / `material` / `scene` / `audio` / `font` / `ui` / host 自定义 | host 手写的纯数据 kind，或刻意准备好的终态 UI |
| **`importer` 字段** | 必填（选 importer） | N/A（无导入步） |

选择准则：**手上有一个源文件（png / glb / ui.html + ui.css / 二进制 blob）需要程序转换 → `.meta.json` + importer；payload 已经是终态 JSON、人就能写全 → `.pack.json`。**

## 运行时字节解码（`decodeImageBytes`，与磁盘导入正交）

> [!IMPORTANT]
> **两条路，不同场景**：磁盘 sidecar → 构建期导入 → `loadByGuid` 覆盖"资产在构建期已知"；**`decodeImageBytes` 覆盖"字节只在运行时才拿到"**（游戏层自 `fetch` URL、embedded base64、out-of-tree decoder 产出等）。两条路都产出同一个 `TextureAsset` POD，下游 `world.allocSharedRef('TextureAsset', pod)` + `GpuResourceStore.ensureResident` 通路一致（charter P4 一致抽象）——AI 用户对下游而言无需区分字节来自哪里（tweak-20260714）。

### 签名 + opts

```ts
import { decodeImageBytes } from '@forgeax/engine-assets-runtime';

async function decodeImageBytes(
  bytes: Uint8Array | ArrayBuffer,
  mime: string,                              // v1: 'image/png' | 'image/jpeg'
  opts?: { colorSpace?: 'srgb' | 'linear'; mipmap?: boolean },
): Promise<Result<TextureAsset, ImageError>>;
```

- `opts.colorSpace` 默认 `'srgb'`（对齐 `packages/image/src/image-importer.ts` `colorSpaceToFormat` SSOT）→ `format = 'rgba8unorm-srgb'`；`'linear'` → `format = 'rgba8unorm'`。
- `opts.mipmap` 默认 `true` → `mipLevelCount = numMipLevels({width,height})`；`false` → `mipLevelCount = 1`。
- 两个 opts 全省略即走默认（charter P1 渐进披露——主签名一行看懂，进阶按需展开）。

### v1 边界（显式非目标）

- **不做网络下载**：字节由游戏层提供，`decodeImageBytes` 不 `fetch`。
- **不做 GPU 上传**：产出 POD 后走既有 `allocSharedRef` + `ensureResident` 通路，本 API 不重造上传原语。
- **v1 仅 PNG / JPEG**：GIF / WebP / SVG / AVIF / KTX2 / HDR 落 `image-format-unsupported`——线下先转格式或走构建期 importer（能力更广）。
- **不替代静态 `.bin` / `.ktx2` loader**：那条路继续走 `loadByGuid`；本 API 只覆盖"字节只在运行时才拿到"的正交场景。
- **不做 Node / 服务端解码**：要 `createImageBitmap` + `OffscreenCanvas`（浏览器主线程 / Worker）；能力缺失以结构化 `image-decode-failed` 呈现，不静默返回破损 POD。

### 错误码闭合联合（4 成员子集）

`decodeImageBytes` 只可能落 `ImageErrorCode` 的这 4 个基础成员（union 中的 atlas-* / HDR 变体不可达）。全成员 SSOT 在 `packages/types/src/index.ts`（勿抄）：

| code | 触发 | `.detail` |
|:--|:--|:--|
| `image-format-unsupported` | mime 不在 `['image/png','image/jpeg']` | `{ actualMime, path?, formatColorSpaceConflict? }` |
| `image-decode-failed` | 解码器拒绝字节 / env 缺 `createImageBitmap` | `{ reason, path? }` |
| `image-dimension-out-of-bounds` | 保留（当前底层不主动落） | `{ requested: {width,height}, limit }` |
| `image-meta-missing` | 保留（不由本 API 触发） | `{ sourcePath, expectedSidecarPath }` |

### 消费骨架（结构化自救）

```ts
import { decodeImageBytes } from '@forgeax/engine-assets-runtime';

const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
const result = await decodeImageBytes(bytes, 'image/png');
if (!result.ok) {
  const err = result.error;
  // .hint 来自 IMAGE_ERROR_HINTS SSOT，含可复制粘贴的恢复指令（charter P3）
  console.error(err.code, err.hint);
  // 注：这里穷举 `err.detail.code` 而非 `err.code`——`ImageError` 有两个独立判别字段
  // （`.code` 与 `.detail.code`），TS 不做跨嵌套 correlation，只有以 detail 判别域为
  // scrutinee 时后续 `err.detail.<字段>` 才可编译期收窄（AGENTS.md Error model 里
  // 的 `switch (err.code)` 表述适用于单判别错误族；ImageError 属双判别族的特例）。
  switch (err.detail.code) {  // 穷举无 default，TS 编译期守卫
    case 'image-format-unsupported': /* err.detail.actualMime -- 换格式 */ break;
    case 'image-decode-failed':      /* err.detail.reason -- 换源 / 检查 env */ break;
    case 'image-dimension-out-of-bounds': /* err.detail.limit -- 降分辨率 */ break;
    case 'image-meta-missing':       /* 不由本 API 触发 */ break;
  }
  return;
}
// 字节进 / POD 出：一步心智，下游与静态贴图同构（charter P4）
const handle = world.allocSharedRef('TextureAsset', result.value);
```

### 隔离闸门

`decode-image-bytes.ts` 是 `@forgeax/engine-assets-runtime` **唯一**允许静态 `import '@forgeax/engine-image'` 的文件——`scripts/check-image-pipeline-isolation.mjs` (a.2-anti) 白名单精确锚定此单一路径；其余 assets-runtime 源与 runtime 源仍被禁，任何后续误加静态 import 会被 gate 立即拒（charter P3 显式失败）。

深入：`packages/assets-runtime/README.md` §Runtime image bytes decoder（含更长的 boundary / opts 表 / self-recovery 范式）。
