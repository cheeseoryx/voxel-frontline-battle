# @forgeax/engine-pack

## MaterialAsset 唯一成功路径

Pack 承载 `paramSchema -> derive -> compile/reflect -> cook/load -> extract/record`
中的 cook/load 边界：producer 先发布含 `coordinateSet`、transform、
`physicalUvScale`、artifact 与 `layoutIdentity` 的 receipt，再由 catalog 按 GUID
提供给 runtime。identity 或 receipt 过期时 inspect producer evidence，修复后
recook 并重新验证，不手改 cooked payload。

> [!IMPORTANT]
> Pack 是发布与证据边界，不是第二份 schema；恢复动作依赖结构化状态与 receipt，
> 并沿 producer owner 回到源输入。

## Authoring and recovery index

## ScriptablePack 与 Pack authoring

> [!IMPORTANT]
> 这里有两个一等 source 实体，且必须保持可见区别：`ScriptablePack` 是可执行的
> `*.pack.ts` TypeScript source；`Pack` 是可编辑、可持久化的 `*.pack.json` JSON
> source。参数化只是 ScriptablePack/Pack instance 的可选能力，不是第三种实体。
> 构建后的 Pack v2 是 transport 产物；runtime 只按 GUID 加载产物。

The current authoring contract keeps one Pack identity and derives every output
identity from the author-owned pair `(packageId, sourceKey)`:

```ts
import { AssetGuid, definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';

const packageId = definePackageId('01900000-0000-7000-8000-000000000001');

export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  build: ({ packageId: subjectId }) =>
    ok({
      'mesh/main': { kind: 'mesh', materialSlots: [] },
      'scene/main': {
        kind: 'scene',
        entities: [],
        mounts: [],
        mesh: AssetGuid.format(AssetGuid.derive(subjectId, 'mesh/main')),
      },
    }),
});
```

`definePack` omits `parameters` for the default zero-parameter path; its build
context then has `packageId` and `readByGuid()` only. A non-empty `parameters`
array opts into typed `values`, defaults, numeric bounds, enum choices, vectors,
colors, and asset-GUID kind constraints. The build return object is the whole
current output topology: there is no output manifest, `output.add()`,
`externalAssets`, or per-output GUID field.

`Pack` authoring (`*.pack.json`) uses schema `3.0.0`. A direct document stores
`assets[sourceKey]`; an instance stores only its own `packageId`, `parent`, and
sparse `values`. These branches are mutually exclusive. Every instance has an
independent package identity, while the parent chain is resolved through the
current Source Index. The authoring form is lowered to the ordinary Pack v2
transport before runtime; player code still calls `loadByGuid()` and never
executes TypeScript or understands parameters.

`@forgeax/engine-pack/build` exposes the filesystem gateway
`createFileSystemPackAuthoringGateway()`. Its read operations are
`asset.list`, `asset.inspect`, `asset.resolve`, and `asset.verify`; mutations
are `asset-source.create`, `asset-source.clone`,
`asset-source.create-instance`, `asset-source.apply-values`,
`asset-source.rebuild`, and `asset-source.cold-cook`. Every operation carries a
caller-minted `requestId`; source mutations are confined to the game root,
atomic, and CAS-protected by `expectedRevision`.

`AssetGuid.derive(packageId, sourceKey)` is the browser-safe UUIDv5 projection.
`PackageId` and `AssetGuid` are distinct brands, and a derived identity alone
reports only `identity`; `present` and `ready` require current materialization
and validated Pack/artifact evidence respectively.

## 灯光 Pack/Catalog 入口

三条最短入口：

1. scene Pack 只保存 `RectAreaLight`、`SpotLight`、`LightProbe` 的 authored 字段，并把 `iesProfile`/`cookie` 写入 `refs`。
2. `IesProfileAsset` 由 `iesImporter` 在 build-time 生成 fixed cooked payload；`SpotLight.cookie` 仍是普通 `TextureAsset`。
3. runtime 按 GUID 读取 Catalog/Pack 记录；`current`、`accepted`、`lastKnownGood`、`verified` 分层检查，缺失时回到 producer 重建。

Pack 是 published 边界，不是 author authority、runtime registry 或 GPU owner。源文件与 Meta 保留 authored identity，DDC/Catalog 是可丢弃或可重建的 projection；`sourceKey` 只表达 producer 语义，不是 URL 替身。

## Material contract index

Pack is the single material-cook and publication boundary. It publishes one
GUID-addressed receipt and artifact for the resolved contract; it does not
redefine `paramSchema` or mint runtime feature macros. Keep
`materialContractDigest`, `sourceClosureDigest`, `layoutIdentity`,
`programIdentity`, `cookIdentity`, and `materialPublicationIdentity` together
as layered identity. Inspect `current` versus `generation`, repair the owning
producer at the first divergence, cold-cook the same GUID, and verify receipt,
artifact, and provenance.

## Mesh binary v4 boundary

Mesh artifacts use one canonical `geometry` projection and one strict wire
contract. The pack package owns the header facts and digest implementation in
[`src/mesh-bin-contract.ts`](src/mesh-bin-contract.ts); consumers must not
recreate that table.

| Fact | Owner | Recovery |
|:--|:--|:--|
| projection mask, schema version, stride, digest | `@forgeax/engine-geometry` + pack contract | Re-cook from source and Meta |
| vertex/index cardinality and payload bounds | build-time import producer | Repair source payload, then cold-cook |
| malformed or legacy mesh binary | strict runtime loader | Keep LKG; publish only a fully validated replacement |

> [!WARNING]
> Mesh binary v4 is the only accepted/emitted mesh wire version. v2/v3 are
> rejected closed; runtime never decodes or re-cooks a legacy payload.

## ScriptablePack in 30 seconds

The public happy path is: declare one stable `packageId` and return a complete
`sourceKey -> Asset` topology from `definePack`, run the Vite Pack producer,
publish Pack v2 plus the Catalog, then call `AssetRegistry.loadByGuid(guid)`.
The durable consumer matrix is the exported
`SCRIPTABLE_PACK_ASSET_KINDS` list: mesh, material, scene, texture, equirect,
sampler, font, render-pipeline, tileset, video, skeleton, skin,
animation-clip, animation-graph, audio, particle-effect, and ies-profile.

Every successful row keeps its `sourceKey` identity, dependency `refs`, and
producer-owned `artifacts`. Audio keeps `mediaType` and bytes; particle effects
keep `programFingerprint` and the cooked program. Animation and tile consumers
turn a loaded payload into a World-owned shared reference at their own boundary.

For failure, switch on `code`, inspect `expected`, `hint`, and narrowed `detail`:
repair the definition or producer, rebuild/cold-cook, refresh the Catalog LKG,
or attach the missing Host capability. A missing audio/video/VFX capability is
an install/play/execute error, not a durable-load error. The machine contract
lives in [`pack.schema.json`](schema/pack.schema.json) and
[`meta.schema.json`](schema/meta.schema.json); this section is guidance, not a
second manifest.

The machine contract is [`asset-authority.schema.json`](../../asset-authority.schema.json). The audit gate is [`check-asset-authority-audit.mjs`](../../scripts/forgeax/check-asset-authority-audit.mjs); it reports subject, execution, author authority, runtime source, lifecycle, owner, producer, and sourceKey evidence for every named category.

The staged route is explicit: `author-validation` -> `external-declaration` ->
`import` -> `native-cook` -> `ddc-validation` -> `runtime-parse` ->
`editor-capability`. Each stage keeps its own evidence; a cache hit does not
replace author authority, and an Editor capability does not become a runtime
source.

| Need | Entry | Safe action |
|:--|:--|:--|
| Inspect one asset | `forgeax asset inspect --subject <guid> --root <project> --json` | Read structured evidence and diagnostics |
| Verify a result | `forgeax asset verify --root <project> --json` | Repair the producer or package, then retry |
| Rebuild a cooked result | Pack/import runner and the declared producer | Cold cook after discarding invalid DDC |
| Preview old output | Catalog evidence with explicit last-known-good state | Preview only; never publish it as current |

Pack or external source plus Meta owns author facts. DDC and Catalog are derived projections; they are not author databases or write authorities.

## Engine builtin mesh descriptors

The Engine-owned primitive mesh identities are published from one UUIDv5 table
(`@forgeax/engine-pack/builtin`). A standalone DevKit build materializes only
the missing rows as an ordinary Pack v2 tuple; Geometry then derives the mesh
payload from the `procedural-*` token at load time.

| Descriptor | GUID source | Geometry token |
|:--|:--|:--|
| Cube | `HANDLE_CUBE` | `procedural-cube` |
| Triangle | `HANDLE_TRIANGLE` | `procedural-triangle` |
| Quad | `HANDLE_QUAD` | `procedural-quad` |
| Sphere | `HANDLE_SPHERE` | `procedural-sphere` |
| Nine-slice quad | `HANDLE_NINESLICE_QUAD` | `procedural-nine-slice-quad` |
| Cylinder | `HANDLE_CYLINDER` | `procedural-cylinder` |

This keeps the runtime registry generic while ensuring a packaged game can
resolve legacy scene references without a second process-static asset owner.

> [!IMPORTANT]
> The pack contract has one material authoring shape: a `MaterialAsset` payload. The cook stage resolves inheritance, values, texture coordinates, module references, artifact bytes, and a receipt into one record. Runtime consumers use the GUID and catalog locator; they do not author a second shader resource.

## MaterialAsset cook contract

Put the material payload in the package `assets[]` row and keep its `refs[]` graph complete. The `passes`, `values`, `parent`, and texture `coordinates` remain one authored route. A valid cooked material record contains `resolved`, `refs`, `artifact`, and `receipt`. If any part is absent, recover by fixing the producer payload or re-running the cook; this is the recovery route. Then repeat `lookup/verify --guid --project --catalog --json`.

当 `parameters` 将字段声明为 `texture` 时，`values` 可保留纹理 GUID 字符串简写；省略
`parameters` 的默认材质也只对 `MATERIAL_TEXTURE_SLOTS` 中的纹理槽启用该简写。只有
sampler、强度或非默认坐标等附加元数据才使用结构化纹理对象。坐标字段的省略由运行时
统一解析为 identity，但 cook/load 不得把 identity 坐标自动展开并写回创作 payload。

> [!IMPORTANT]
> The producer publishes facts; the consumer does not guess. `packageId`,
> `provenance`, `revision`, `sourceKey`, relations, and diagnostics survive
> package moves and DDC relocation. Paths and array positions are locators,
> not identities.

Disk schema, GUID tools (`AssetGuid` brand + UUIDv7/v5), mesh-binary wire facts, and scanner fail-fast chain (13-member `PackErrorCode`) for the ForgeaX asset package system. The unified `asset list`, `asset inspect`, and `asset verify` commands call this owner in filesystem mode; they are offline and require no WS connection.

> Package name vs directory: this package is published as `@forgeax/engine-pack` but lives at `packages/pack` on disk. The `@forgeax/engine-` prefix is the IDE-autocomplete entrypoint AI users discover the package family by; the directory drops the prefix to keep tree depth flat (mirrors the `packages/runtime` / `@forgeax/engine-runtime` pair). All other packages in the engine family follow the same convention.

## AssetEvidence: the offline proof chain

Pack owns the offline half of the GUID evidence chain: `source inventory -> catalog packageUrl/cookReceiptUrl -> producer CookReceipt -> Pack v2 package and artifact verification -> AssetEvidence`.

The catalog is a locator, not proof. `lookup/verify --guid --project --catalog --json` joins the source meta or authored pack, the catalog row, the receipt, and the package descriptors. Both commands emit one JSON record on stdout or one structured `{code, expected, hint, detail}` record on stderr; there is no runtime or WebSocket dependency.

## VFX Pack v2 migration

VFX source v2 is cooked in one atomic producer step. The executable contract is
`scripts/asset-cook-contract.mjs`; a package-local scripts path is not valid.
The cook publishes the Pack payload and
`particle-effect/program.json` with the same source fingerprint. Runtime loads
the GUID-indexed artifact and never compiles author WGSL.

When adding a Batch B renderer, update the source declaration, explicit material
or mesh refs, native-cook catalog, and receipt together. Re-run `lookup` and
`verify`; stale output is repaired by the owning importer or native cooker, not
by a demo-side mesh substitute.

`notCooked` means a source declaration has no successful receipt. `ready/current` means the receipt fingerprint matches the source; `ready/stale` means it does not. `unknown` is reserved for missing evidence. Artifact and package status remain `notChecked`, `passed`, or `failed`; a historical receipt never upgrades an unchecked package.

Build-time importers write source meta and producer receipts; the Vite plugin publishes the locator. Runtime packages consume the resulting Pack v2 bytes and must not import this Node-only evidence adapter. See [`packages/types/src/asset-evidence.ts`](../types/src/asset-evidence.ts) for the exact schema and closed errors.

Browser runtime code uses the focused Pack subpaths instead of the Node-oriented
root barrel. The root entry remains the build-time scanner/evidence surface.

| Runtime need | Browser-safe entry |
|:--|:--|
| Pack v2 validation and parsing | `@forgeax/engine-pack/runtime` |
| Artifact locator validation | `@forgeax/engine-pack/artifact-path` |
| Cooked material records | `@forgeax/engine-pack/material-cook` |
| Mesh wire facts | `@forgeax/engine-pack/mesh-bin-contract` |

## Quick start

### ScriptablePack source (`*.pack.ts`)

Use `@forgeax/engine-pack/source` when one trusted TypeScript source declares
and builds a multi-asset package. The definition owns one stable `packageId`;
each build returns ordinary typed Assets keyed by author-owned `sourceKey`.
The Pack boundary derives every output GUID as
`AssetGuid.derive(packageId, sourceKey)`, so the source does not contain a
per-output GUID table, `externalAssets`, or an output writer.

```ts
import { AssetGuid, definePackageId, definePack } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';

const packageId = definePackageId('01900000-0000-7000-8000-000000000001');

export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  build: ({ packageId: subjectId }) =>
    ok({
      'mesh/main': { kind: 'mesh', payload: {}, refs: [] },
      'scene/main': {
        kind: 'scene',
        payload: { mesh: AssetGuid.derive(subjectId, 'mesh/main') },
        refs: [],
      },
    }),
});
```

Omitting `parameters` selects the zero-parameter path; a non-empty
`parameters` array adds typed `values`, defaults, ranges, enum choices,
vectors, colors, and asset-GUID constraints. The isolated Pack worker passes
only serializable authoring data to the build and never exposes filesystem or
runtime state.

`forgeax asset inspect --subject <source.pack.ts> --root <project> --json` executes module initialization, validates the default export, and projects canonical Meta without calling `build`. `@forgeax/engine-pack/source-node` accepts a host executor with `load` and optional `dispose`; `timeoutMs` bounds module initialization and `buildTimeoutMs` bounds one `build(context)` call. A build timeout returns one structured `pack-source-load-failed` Result with `detail.phase: 'build'`, the configured `timeoutMs`, and deterministic cleanup of the isolated worker and compile root.

The default worker executes the complete relative TypeScript module closure on the supported Node floor, including Node 22 hosts that do not load `.ts` files directly. It transpiles that closure into a disposable ESM directory, resolves bare imports through the source project's nearest `node_modules`, and removes the directory when the worker is disposed. Bulk producers use the internal `createScriptablePackModuleExecutorPool()` with two recyclable workers; a pooled lease is released after metadata projection or one build, so a generation never retains one live Worker-backed definition per source.

> [!IMPORTANT]
> Source authoring is an explicit Node contract. Every gateway call carries a
> caller-minted `requestId`; mutations may carry `expectedRevision` for
> SHA-256 CAS. The filesystem port confines paths to one game root and only
> writes constrained generated source or structured v3 JSON. Arbitrary valid
> TypeScript remains inspectable and rebuildable, but unsupported structural
> edits fail closed with stable `pack-source-*` errors.

`PACK_AUTHORING_OPERATION_DESCRIPTORS` is the producer-owned structured capability manifest for tools. The existing `asset.preflight` operation returns the current revision, canonical Meta, incoming references, and shape-derived mutation capabilities before any write.

```typescript
import { AssetGuid } from "@forgeax/engine/pack/guid";
import { scan, scanInventory } from "@forgeax/engine/pack/scanner";

// Runtime: resolve a known GUID at build time
const result = AssetGuid.parse("cbe42beb-8975-5096-b3a1-3dda4cb4c077");
if (!result.ok) throw result.error; // PackError with .code 'pack-guid-malformed'
const guid = result.value;

// Build / CI: validate an asset directory
const scanResult = await scan(["apps/hello/cube/assets"]);
if (!scanResult.ok) throw scanResult.error; // PackError with .code/.hint/.detail
console.log(scanResult.value); // PackEntry[]

// Build hosts can retain one validated inventory and project paths from it.
const inventory = await scanInventory(["apps/hello/cube/assets"]);
if (!inventory.ok) throw inventory.error;
console.log(inventory.value.paths, inventory.value.declarations);
```

## Schema shapes

External imports and authored Packs have different identity owners. An external
source keeps importer-owned sub-asset GUIDs in its `.meta.json`; an authored
Pack keeps one `packageId` and names outputs with `sourceKey`.

### `.meta.json` -- external-asset-package

```json
{
  "schemaVersion": "1.0.0",
  "kind": "external-asset-package",
    "importer": "gltf",
  "source": "<source-filename>",
  "importSettings": {},
  "subAssets": [
    { "guid": "<UUIDv7-or-UUIDv5>", "sourceIndex": 0, "kind": "mesh", "compression": "zstd" }
  ]
}
```

> [!NOTE]
> `compression?: 'none' | 'zstd'` on `PackIndexEntry` (and `subAssets[].compression`)
> indicates whether the asset's `.bin` is zstd-compressed. See
> `@forgeax/engine-codec` README for the full codec API and error codes.
> Runtime `fetchBinary` transparently decompresses when this field is `'zstd'`.
>
> **Declaring compression intent (AC-01):** set `importSettings.compression`
> (`'none' | 'zstd'`) to override the build-time default strategy for this asset
> (default: mesh -> `zstd`, texture -> `none`; `.pack.json` never compressed).
> The importer honors the override and writes the resulting `compression` onto
> the output catalog row. Omit it to accept the kind-keyed default.

### `.pack.json` -- authored Pack v3

Direct authoring names its outputs by `sourceKey`; it never stores output GUIDs:

```json
{
  "schemaVersion": "3.0.0",
  "packageId": "01900000-0000-7000-8000-000000000010",
  "assets": {
    "mesh/main": { "kind": "mesh", "payload": {}, "refs": [] }
  }
}
```

An instance uses the same extension and schema version, but has only its own
identity, parent, and sparse parameter values:

```json
{
  "schemaVersion": "3.0.0",
  "packageId": "01900000-0000-7000-8000-000000000011",
  "parent": "01900000-0000-7000-8000-000000000010",
  "values": { "count": 4 }
}
```

The two v3 branches are mutually exclusive. The build lowers them to the
runtime Pack v2 projection, whose rows contain derived GUIDs and `kind:
"internal-text-package"`; runtime still loads only that cooked projection.

### Producer provenance and topology

Authored and cooked Pack projections carry producer-owned `packageId`,
`provenance`, `revision`, and structured `diagnostics`. Asset/output rows may
declare a stable `sourceKey`; `sourceIndex` is positional evidence only. The
runtime function `diffTopology(previous, next)` preserves GUIDs by `sourceKey`,
reports additions, removals, and kind changes, and marks multi-output
source-index-only matching as ambiguous.

| Fact | Published by | Consumer rule |
|:--|:--|:--|
| `packageId` | Producer declaration | Keep stable across path or URL relocation |
| `provenance` | Producer declaration | Copy without replacing it with importer guesses |
| `revision` | Producer/DDC | Use to detect stale updates; do not silently overwrite a verified snapshot |
| `sourceKey` | Imported-output producer | Match topology only when the producer supplies a stable semantic key |
| `sourceIndex` | Imported-output producer | Display or inspect position; never use it as identity |
| `relations` / `diagnostics` | Producer facts | Preserve the complete structured values |

> [!WARNING]
> A missing `sourceKey` in a multi-output declaration is evidence insufficiency,
> not permission to hash a path or promote `sourceIndex`. Keep the result
> ambiguous and expose the repair hint.

The DDC path is also lossless: the import runner copies package-level facts to
the `.pack.json` envelope and copies each declared output's `sourceKey`,
`sourceIndex`, and relations onto the matching GUID row. The catalog builder
then projects those rows into `PackIndexEntry`; it does not create a second
authoritative fact store.

### MaterialAsset shape -- pass-based material in `.pack.json`

When `kind: 'material'`, the `payload` object carries `passes[]` + `values` (feat-20260527-material-registration-unification M3).

```json
{
  "guid": "<UUIDv7>",
  "kind": "material",
  "payload": {
    "kind": "material",
    "passes": [
      {
        "name": "Forward",
        "program": { "module": "forgeax::default-standard-pbr" }
      }
    ],
    "values": {
      "baseColor": [1.0, 0.8, 0.2],
      "metallic": 0.3
    }
  },
  "refs": []
}
```

**MaterialAsset fields in pack.json**:

| Field | Type | Description |
|:--|:--|:--|
| `passes` | `MaterialPass[]` | Root pass descriptors; each pass names a `program.module`. |
| `parameters` | `MaterialParameter[]` | Root parameter contract used by cook and reflection. |
| `values` | `Record<string, unknown>` | Child-owned values, including per-slot texture coordinates. |
| `parent` | `AssetGuid` | Optional serialized parent edge. |

**Validation** is performed by the material schema and build-time cook. The cook resolves the parent chain, validates values and pass programs, and emits a `material-cook/4` record, artifact, references, and receipt. The receipt keeps material, source, layout, program, pipeline, publication, and cook identities together with compiler/WASM provenance and generation counters. Runtime reports a structured missing-cook error instead of compiling a material; stale generations are recooked by the producer.

## `AssetGuid` API

| Function | Signature | Description |
|:--|:--|:--|
| `AssetGuid.parse` | `(input: string) => Result<AssetGuid, PackError>` | Parse dash-separated UUID string; returns `Ok(AssetGuid)` on success or `Err(PackError{code:'pack-guid-malformed'})` on failure. Never throws. |
| `AssetGuid.format` | `(guid: AssetGuid) => string` | Format as lowercase dash-separated UUID string |
| `AssetGuid.equals` | `(a: AssetGuid, b: AssetGuid) => boolean` | Constant-time equality |
| `AssetGuid.random` | `() => AssetGuid` | Generate a random UUIDv7 GUID |
| `deriveBuiltin` | `(name: string) => Promise<AssetGuid>` | Derive a deterministic UUIDv5 from a name within the ForgeaX namespace; async (SHA-1 via Web Crypto or node:crypto) |

## `PackErrorCode` -- 13-member closed union

Exhaustive `switch (err.code)` without `default` -- TS guards completeness.

| Code | `err.detail` shape |
|:--|:--|
| `pack-malformed-meta` | `{ path: string; ajvErrors: string[] }` |
| `pack-malformed-pack` | `{ path: string; ajvErrors: string[] }` |
| `pack-guid-malformed` | `{ raw: string; reason: string }` |
| `pack-orphan-meta` | `{ metaPath: string; expectedFile: string }` |
| `pack-meta-missing` | `{ sourcePath: string; expectedMetaPath: string }` |
| `pack-guid-collision` | `{ guid: string; paths: [string, string] }` |
| `pack-cyclic-reference` | `{ code; kind: 'childof' \| 'mount-asset'; cycle: string[] }` -- first and last element repeated; `kind` distinguishes runtime ChildOf cycle from build-time mount-asset cycle (R10) |
| `pack-subasset-index-out-of-range` | `{ metaPath: string; sourceIndex: number; maxIndex: number }` |
| `payload-schema-mismatch` | `{ guid: string; errors: { instancePath: string; message: string }[] }` -- material payload failed `buildMaterialAssetValidator` check (scanner step-7) |
| `pack-mount-localid-overlap` | `{ overlapping: number[]; sources: string[] }` -- mount memberFirst windows collide |
| `pack-mount-count-mismatch` | `{ mountLocalId; declared; actual }` -- mount.memberCount disagrees with referenced child SceneAsset.entities.length |
| `pack-mount-override-localid-out-of-range` | `{ overrideLocalId; mountLocalId; memberCount }` -- override.localId outside mount window |
| `pack-mount-override-unknown-field` | `{ comp; field; mountLocalId }` -- override.comp / override.field unknown to schema vocab |

Access `err.detail.<field>` directly after narrowing via `switch (err.code)` -- full IDE autocomplete.

## Unified asset commands

DevKit loads the Pack producer behind the unified `forgeax asset` command;
this package does not publish an independent executable.

| Subcommand | Description | Exit code |
|:--|:--|:--|
| `forgeax asset list --root <project> --json` | Print discovered `PackEntry` objects | 0 on valid roots |
| `forgeax asset inspect --subject <guid> --root <project> --json` | Print matching asset evidence | 0 found / 1 not found |
| `forgeax asset verify --root <project> --json` | Run the fail-fast scanner and return the first structured `PackError` | 0 clean / 1 error |

```bash
# Direct invocation (after pnpm -F @forgeax/engine-pack build)
forgeax asset list --root ./game --json
forgeax asset inspect --subject 01935f3b-aaaa-7000-8000-000000000001 --root ./game --json
forgeax asset verify --root ./game --json
```

## Scanner 7-step validation chain

The `verify` subcommand runs a fail-fast 7-step chain:

| Step | Check | Error code on failure |
|:--|:--|:--|
| 1 | Schema validation (`.meta.json` / `.pack.json` ajv) | `pack-malformed-meta` / `pack-malformed-pack` |
| 2 | GUID format check (UUIDv5/v7 dash format) | `pack-guid-malformed` |
| 3 | GUID collision detection (cross-file duplicate) | `pack-guid-collision` |
| 4 | Orphan `.meta.json` check (`.meta.json` without source file) | `pack-orphan-meta` |
| 5 | Missing `.meta.json` check (source file without sidecar) | `pack-meta-missing` |
| 6 | Subasset index bounds check (`.meta.json` subAssets[].sourceIndex) | `pack-subasset-index-out-of-range` |
| 7 | Material payload schema check (`buildMaterialAssetValidator(MATERIAL_PARAM_TYPES_V1)` for `kind: 'material'`) | `payload-schema-mismatch` |

## Mesh-binary artifact contract

`MESH_BIN_VERSION` and `MESH_BIN_HEADER_V4_BYTES` are the Pack-owned facts for
the v4 `<guid>.bin` mesh artifact. The header carries the geometry projection
version, attribute mask, stride, digest, cardinality, and payload byte lengths;
the import encoder and assets-runtime decoder consume those facts from the
package root. Independent test fixtures may keep literal header values only as
wire-format oracles, never as a second layout table.

> [!WARNING]
> v4 is the only accepted and emitted mesh-binary version. A v2/v3 artifact is
> a closed load error, not a compatibility input. Preserve the last-known-good
> catalog row, repair the source plus its `.meta.json` sidecar, then re-run the
> owning build-time importer/native cooker and `lookup/verify --guid --project
> --catalog --json` before publishing the replacement.

## Owner product and inventory contract

`scanInventory(...)` is the Pack-owned source inventory boundary. It preserves
GUID identity, source revision, source key, and source index before importer
work begins.

`finalizePackageProduct(...)` accepts the terminal producer product, validates
one receipt per GUID, validates asset-local artifact paths and bytes, and emits
the deterministic package URL and digest. Producers provide policy through the
finalizer sink; Pack owns package serialization and publication facts.

## Mesh LOD relation closure

LOD is a relation inside the root mesh payload, not an independent runtime
asset kind. A valid Pack row contains the lower MeshAsset GUID in both the
payload and root `refs[]`, and the lower row is present in the same package:

```json
{
  "kind": "mesh",
  "payload": { "lods": [{ "mesh": "<lod-guid>", "screenCoverage": 0.5 }] },
  "refs": ["<lod-guid>"]
}
```

The finalizer preserves this relation while sorting rows deterministically.
Missing closure, duplicate GUIDs, invalid artifacts, or incomplete receipts
fail before publication; repair the producer and retry the same source Meta.

## Entry subpaths

| Subpath | Exports |
|:--|:--|
| `.` | Re-exports from all subpaths |
| `./schema` | Compiled ajv validators for `.meta.json` and `.pack.json` |
| `./guid` | `AssetGuid` brand type + `parse` (returns `Result`) / `format` / `equals` / `random` + async `deriveBuiltin(name)` |
| `./errors` | `PackError` class + `PackErrorCode` closed union + `PackErrorDetail` discriminated union |
| `./bridge` | `AssetRegistry` GUID bridge helpers |
| `./scanner` | File tree scanner with fail-fast 7-step validation chain |
