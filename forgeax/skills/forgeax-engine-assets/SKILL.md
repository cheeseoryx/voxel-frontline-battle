---
name: forgeax-engine-assets
description: >-
  ForgeaX authoring-to-runtime asset route with GUID identity and producer-owned recovery.
  Use when authoring, importing, cooking, loading, validating, or repairing any game asset.
---

# forgeax-engine-assets

## 灯光资产最短路由

三条最短入口：

1. `RectAreaLight` 与 `LightProbe` 通过现有 render ECS schema 创作。
2. `SpotLight.iesProfile` 绑定 build-time cooked `IesProfileAsset`，`SpotLight.cookie` 绑定普通 `TextureAsset`，`rollDeg` 只表达方位角。
3. 通过 `inspect` 查看 `subject`、`execution`、`lifecycle`、`lastKnownGood` 与 `sourceKey`，再按 owner 执行 `rebuild`/`cold-cook`。

IES 不进入 runtime source parser；Cookie 不建立第二 texture registry。Catalog 是 projection，DDC 是 cache evidence，Pack/Meta 才保留 authored authority；`accepted` 或 `verified` 缺失时不得宣称 ready。

> [!IMPORTANT]
> Material assets follow one route inside the catalog: authored `MaterialAsset` with `passes` and `values` -> cook record and artifact -> `loadByGuid` -> World handle. Keep `parent` references, texture references, module identifiers, and per-slot `coordinates` transforms in the same package graph. The recovery route repairs the producer or cook output and retries the same GUID.

## M5 asset authority index

Start with [`asset-authority.schema.json`](../../asset-authority.schema.json) and its gate [`check-asset-authority-audit.mjs`](../../scripts/forgeax/check-asset-authority-audit.mjs). Pack or external source plus Meta is author authority. Import and native cook produce validated outputs. DDC is disposable cache evidence, Catalog is a projection, and runtime only reads the validated projection. Editor writes go through the asset-authoring gateway.

For any category, inspect the `subject`, `execution`, `lifecycle`, `lastKnownGood`, and `sourceKey` fields before choosing recovery. The AI path is `inspect` -> `rebuild` or `cold-cook`; `preview-LKG` is read-only, while `override`, `promote`, and `stop-publish` are explicit gateway or publication operations. Do not infer identity from a suffix, path, cache hit, or message text.

### Transmission/refraction

For transmission/refraction, preserve the same Standard values through GLTF parse, Pack cook, GUID
catalogue, and runtime inspection. Keep `sourceKey` as producer identity (not a file path), and repair
stale or invalid material output by rebuilding the producer or cold-cooking the same GUID.

### Mental model

The recovery route is producer-owned: validate the `MaterialAsset`, cook the
specialization, publish the record and artifact, then load by GUID. A Catalog
row is evidence and DDC is cache evidence; neither replaces author authority.

### Display-name projection

`deriveAssetName` is the single display-name projection used by Catalog build
and runtime `resolveName`. A producer-supplied `storedName` is authoritative for
an authored entry regardless of whether its package currently has one member or
many. When no stored name is available, a packaged asset falls back to the
package path basename; an asset without a package resolves to the empty string.
Keep this projection in the Pack owner and do not reimplement cardinality rules
in Editor or other consumers.

### Catalog source and evidence

`CatalogSource` is the runtime boundary for catalog navigation. The source
emits `CatalogDelta` rows (`added`, `changed`, and `removed`); it does not prove
that a payload is cooked or current. Register the source, call
`subscribeCatalog`, and only then call `enumerateCatalog` so the editor pinned consumer
cannot miss an update between its initial snapshot and its live subscription.
Merge both snapshots and deltas by GUID, and dispose the
subscription with the host.

```ts
const stop = assets.subscribeCatalog((delta) => mergeRowsByGuid(delta));
const snapshot = await assets.enumerateCatalog();
mergeRowsByGuid(snapshot);
```

Vite's dev transport uses `reloadAssetHost()` to refresh the source after an
import or HMR change; a static build still navigates the same Pack v2 rows.
When the source is not configured, keep the structured failure instead of
inventing a fallback row.

The Vite boundary has one producer and one Catalog projection. `pluginPack`
publishes the scoped dev/build result; `createCatalogClient` subscribes to the
dev delta stream and enumerates the initial snapshot without moving Vite into the
runtime. `runtimeBinding` carries the active scope and `generation`, so a late
publication from an old host is rejected. Preserve `sourceKey` as the semantic
source identity in Catalog facts; it is not a URL, filename, or GUID fallback.

`AssetEvidence` is the read-only join of source declaration, the catalog's
`packageUrl`/`cookReceiptUrl`, producer receipt freshness, and Pack artifact
verification. Use `lookup/verify --guid --project --catalog --json` (or the
injected runtime inspection surface) to distinguish `notCooked`, `ready/current`,
`ready/stale`, and `unknown`; `unknown` is not a pass. Repair the producer or
recook for `notCooked`/`stale`, then rerun the probe. A catalog locator alone
cannot upgrade missing or failed evidence to ready.

## Indexed producer recovery playbook

Use the same five-step loop for images, cubemaps, glTF, fonts, materials, and
native cooked assets:

1. **Inspect** source plus Meta, Catalog, DDC lifecycle, receipt, and artifact
   verification. Read `.code`, `.detail`, `.expected`, and `.hint` as data.
2. **Repair** the named importer, native cooker, source, or Meta declaration.
   The source package plus Meta is author authority; the producer owns output.
3. **Rebuild or cold-cook** through the producer. Remove invalid DDC evidence
   only as part of that producer-owned recovery, never by editing a generated
   Pack product into a substitute.
4. **Verify** GUID closure, receipt freshness, DDC integrity, Pack artifacts,
   and the Catalog lifecycle.
5. **Retry** the same GUID after verification. `lastKnownGood` is a read-only
   preview, and `unknown` is not a pass.

Producer readiness is a host concern. `before-consume` needs all required
importers/cookers registered before the consumer load; `on-demand` needs both
the producer route and the explicit dev transport. Runtime does not import
source files, write DDC, parse log strings, or replace a missing engine asset
with a custom mesh/material workaround.

## ScriptablePack authoring route

Keep the two authoring entities distinct. `ScriptablePack` is executable
`*.pack.ts` source: import `definePack` from `@forgeax/engine/pack/source`, keep
one stable `packageId`, optionally declare a non-empty `parameters` capability,
and return a complete `sourceKey -> Asset` map from `build(context)`. `Pack` is
editable `*.pack.json` source: a direct document stores `assets[sourceKey]`,
while an instance stores its own `packageId`, `parent`, and sparse `values`.
Neither source declares per-output GUIDs or `externalAssets`; the build boundary
derives GUIDs from `(packageId, sourceKey)`. Pack instances may execute their
parent ScriptablePack during build, but runtime only consumes cooked Pack v2 via
`loadByGuid` and never executes source or resolves parameter inheritance.

| Action | Command or owner |
|:--|:--|
| Inspect identity and topology | `forgeax asset inspect <source.pack.ts> --json` |
| Read external content | `context.readByGuid(guid)` inside `build` |
| Serialize or cook an output kind | Registered `AssetOutputProducerRegistry` producer |
| Rebuild | Vite or CLI producer lifecycle |
| Load at runtime | Existing Catalog plus `loadByGuid<T>(guid)` |

> [!IMPORTANT]
> `build` must not create GUIDs, write source, publish packages, or mutate a live World. A missing or extra output key, undeclared read/ref GUID, unused external declaration, or kind mismatch is a structured failure; repair the source contract and rebuild the same identity.

For generated `material` and `mesh` outputs, register
`materialAssetOutputProducer` and `meshAssetOutputProducer` from
`@forgeax/engine/import` at the Vite host. Omit `assetSource` when the build is
self-contained; provide the host snapshot source before using
`reader.loadByGuid`.

For ordinary prebuilt `.pack.json` dependencies, create the source in the
build-time owner with `createScriptablePackFileAssetSnapshotSource({
assetRoots })` from `@forgeax/engine-import`. It validates and indexes GUIDs
once, returns private Asset snapshots with deterministic generation/digest
evidence, and keeps missing, malformed, unreadable, and colliding files as
structured `Result` errors.

## MaterialAsset catalog recovery

Use `configurePackIndex('/pack-index.json')` and `loadByGuid<MaterialAsset>` for
both root and derived materials. A ready result must have an effective pass,
resolved `passes`, `values`, `parent`, and `coordinates`, complete references, a cooked artifact, and a receipt. On a
failure, switch on `.code`, read `.detail` and `.hint`, repair the producer or
cook output, and retry. Do not substitute a custom mesh or app-local shader
artifact when an engine resource is missing.


## Contract routing

| Task | Load |
|:--|:--|
| Catalog subscription, refs, package identity, compression | [`catalog-and-import.md`](references/catalog-and-import.md#catalogsource先订阅再枚举) |
| Custom importers, sidecars, source resolution, byte decode | [`catalog-and-import.md`](references/catalog-and-import.md#host-自定义-importer-注册--3-步) |
| Mesh UV contracts and structured recovery | [`runtime-and-mesh.md`](references/runtime-and-mesh.md#多套-uv-导入--gltffbx-texcoord_07-全保留) |
| Runtime load, VFX, handles, video, nested scenes | [`runtime-and-mesh.md`](references/runtime-and-mesh.md#核心-api-速查) |
| Scene writeback, new kinds, custom loaders, evidence | [`scene-and-custom-kinds.md`](references/scene-and-custom-kinds.md#scene-save--writeback活-entitysceneasset-存回闭环) |
