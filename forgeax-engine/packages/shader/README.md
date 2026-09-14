# @forgeax/engine-shader

## Public shader input boundary

The build manifest is the single published shader input catalog. The plugin
composes engine WGSL modules and material rows once; runtime resolves the
content-addressed result through `ShaderRegistry`. The shared View module is
identified by `forgeax_view::common`; its typed ABI describes offsets and
binding metadata only, never a device or GPU handle. Fog and temporal fields
are transported through this existing module/reflection path rather than a
second manifest or registry.

## MaterialAsset 唯一成功路径

`paramSchema -> derive -> compile/reflect -> cook/load -> extract/record`
贯穿 shader 与 material。WGSL producer 只声明与 schema 对应的字段；纹理槽
携带 `coordinateSet`、transform 与 `physicalUvScale`，cook 后由
`layoutIdentity` 绑定 shader artifact。identity 失效时修 source 或 cook 输入，
再执行 recook/load。

> [!IMPORTANT]
> Runtime 只查找已发布的 content-addressed artifact；恢复沿 producer、cook
> 与 catalog 的 owner 边界进行，不在 app 侧复制 shader artifact。

## Standard Surface contract

Standard material 的作者只需要通过 `#import` 使用
[`surface_v1.wgsl`](./src/surface_v1.wgsl)，并实现唯一的
`evaluate_surface(SurfaceInput) -> SurfaceData`。`SurfaceData` 是 Standard
BRDF 的输入，不是最终颜色；Engine-owned Standard pass family 负责顶点、光照、
阴影、Forward/Deferred、G-buffer、雾和输出。内建默认值位于
[`default_standard_surface.wgsl`](./src/default_standard_surface.wgsl)。

### Minimal authoring shape

`SurfaceData` is deliberately base-only. Its frozen field order is:

| Order | Field | Meaning |
|:--:|:--|:--|
| 1 | `baseColor: vec3<f32>` | Base reflectance color |
| 2 | `normalWS: vec3<f32>` | World-space shading normal |
| 3 | `metallic: f32` | Metallic factor |
| 4 | `roughness: f32` | Roughness factor |
| 5 | `emissive: vec3<f32>` | Emissive contribution |
| 6 | `occlusion: f32` | Ambient occlusion factor |
| 7 | `opacity: f32` | Surface opacity |
| 8 | `alphaClipThreshold: f32` | Alpha-test threshold |

```wgsl
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}

fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  return SurfaceData(
    vec3<f32>(0.45, 0.18, 0.06), input.geometricNormalWS, 0.8, 0.42,
    vec3<f32>(0.0), 1.0, 1.0, 0.5,
  );
}
```

The matching TypeScript entry is also import-first: the caller names the
compiled Surface module and supplies only its parameters and values. The
Engine still owns stage entry points, bindings, BRDF composition, and pass
projection.

```ts
import { Materials } from '@forgeax/engine-render';

const rustedIron = Materials.standard({
  surfaceModule: 'game_3d::rusted_iron_surface',
  parameters: [
    { name: 'ironColor', type: 'color' },
    { name: 'rustDark', type: 'color' },
    { name: 'rustBright', type: 'color' },
    { name: 'noiseScale', type: 'f32', default: 1.85 },
  ],
  values: {
    ironColor: [0.4, 0.45, 0.47, 1],
    rustDark: [0.42, 0.085, 0.018, 1],
    rustBright: [0.95, 0.34, 0.055, 1],
    noiseScale: 1.85,
  },
});
```

For the complete source-to-runtime example, see the
[`game-3d` rusted-iron fixture](../../templates/game-3d/README.md#import-first-surface-material-example).

> [!CAUTION]
> Surface is a base-facts function only. Do not add `clearcoat`,
> `clearcoatRoughness`, other physical-layer fields, stage entries, resource
> bindings, Engine entry points, or vertex-position mutation. Physical layers
> and pass admission remain Engine-owned.

渐进导航：`Materials.standard()` → `moduleSlots.surface` → build-time
`#import` composition / reflection → Pack cook → runtime GUID readiness。
Surface source 不声明 stage entry、`@group/@binding` 或 vertex mutation；参数
资源由同一 `MaterialAsset.parameters` contract 派生。编译或 cook 失败时读取
`code`、`detail`、`hint`，修复 authored source 或 producer 后重新 cook，不在
runtime 读取 raw WGSL 或创建 app-local artifact。

> [!IMPORTANT]
> A custom material starts as WGSL source plus one `MaterialAsset` contract. The build manifest publishes the composed module and the material cook publishes the resolved record, artifact bytes, references, and receipt. Runtime resolves those facts from the catalog; application code does not install or duplicate shader artifacts. The recovery route is always source or cook repair.

## Standard lit shader contract

The Standard lit and skinned PBR shaders consume one
`forgeax_standard::cluster::evaluateStandardClusterLights` accessor. The
accessor decodes the shared `DirectLightSlot` and delegates punctual BRDF evaluation;
Forward and Deferred differ only in graph topology. Unlit and fog consumers do
not import this accessor. The canonical source is `src/standard-cluster.wgsl`;
all Standard lit variants compose this one module, so there is no second
implementation to maintain.

## MaterialAsset and shader route

The recovery route is to inspect the structured code, detail, and hint, then
repair the source or cook input before retrying the catalog load.

Declare `passes[].program.module`, `parameters`, `values`, and optional `parent` on the same
MaterialAsset. A texture value keeps its own `coordinates.set` and
`coordinates.transform`, so every slot remains explicit from glTF import to
fragment sampling. The root contract is inherited by child materials; a child
only supplies values it owns.

```ts
assets.configurePackIndex('/pack-index.json');
const result = await assets.loadByGuid<MaterialAsset>(materialGuid);
if (!result.ok) {
  report(result.error.code, result.error.detail, result.error.hint);
  return;
}
const materialHandle = world.allocSharedRef('MaterialAsset', result.value);
```

The custom-shader demo is the executable reference: [`apps/hello/custom-shader`](../../apps/hello/custom-shader). It loads the root and derived GUIDs, validates their cooked records, checks the manifest artifact, and only then draws.

## Shader module catalog

`ShaderRegistry` owns the content-addressed build manifest. It is a runtime
lookup boundary, not an authoring store.

| Entry | Shape | Description |
|:--|:--|:--|
| `ShaderRegistry.loadManifest()` | `() => Promise<Result<void, ShaderError>>` | Load and validate the manifest |
| `ShaderRegistry.get(hash)` | `(string) => Result<ShaderModule, RhiError \| ShaderError>` | Resolve an engine module by content hash |
| `ShaderRegistry.entries()` | `() => IterableIterator<ManifestEntry>` | Enumerate published content-addressed modules in manifest order |
| `ShaderRegistry.materialShaderManifestEntries()` | `() => IterableIterator<MaterialShaderManifestEntry>` | Enumerate validated material shader manifest rows |
| `ShaderRegistry.findMaterialArtifact(id)` | `(string) => Result<MaterialArtifact, ShaderError>` | Find the published module selected by a cooked material |
| `ShaderRegistry.materialShaderIdentifiers()` | `() => IterableIterator<string>` | Enumerate published material module identifiers |

`loadManifest()` validates the complete document before publication. A malformed
entry or material shader row returns one `manifest-malformed` error and leaves
`entries()`, `materialShaderManifestEntries()`, and lazy `get()` resolution
unchanged. Repair the same source and retry on the same registry; a successful
load publishes rows in source order and a later call is idempotent.

The WGSL-level module and the RHI GPU handle are different concepts. This
package owns the former; `@forgeax/engine-rhi` owns the latter.

## Contract derivation

The compiler derives binding layout, uniform offsets, texture field names, and
the injection boundary from the material parameter contract. WGSL reflection
must agree with that derived shape before a record is published. Per-slot
texture coordinates are data in `MaterialTextureValue`, not a global shader
switch.

## Error recovery

Material and shader errors are closed. Switch on `error.code`, then use the
code-specific `detail` and `hint`:

| Code | Meaning | Recovery |
|:--|:--|:--|
| `material-contract-program-mismatch` | A pass does not satisfy the root contract | Align the pass module and re-cook |
| `material-reflection-binding-mismatch` | Reflection differs from the derived bindings | Fix WGSL or parameters, then re-cook |
| `shader-module-not-found` | The published module is absent | Add it to the build source catalog and rebuild |
| `material-specialization-not-cooked` | No runtime artifact exists for the selection | Run the cook path and publish its record |
| `material-specialization-stale-generation` | A dependency changed after cooking | Wait for dependencies to settle and re-cook |
| `material-surface-slot-missing` | Standard pass has no `surface` module slot | Add the slot to the authored pass and re-cook |
| `material-surface-abi-mismatch` | Surface export does not match `surface_v1` | Repair `evaluate_surface` signature and re-cook |
| `material-surface-forbidden-interface` | Surface declares a stage, resource, or vertex mutation | Remove the forbidden interface and re-cook |
| `material-physical-contract-invalid` | A root physical layer is incomplete or unsupported | Repair the root parameter fragment before composing or cooking |

Never hide one of these errors by creating an app-local artifact or changing a
demo's material shape.

For the canonical error detail and executable recovery fields, use
[`material/errors.ts`](../types/src/material/errors.ts). The producer recovery
path is `inspect -> repair authored source -> cold-cook -> verify publication`;
runtime does not reinterpret a Surface error.

## Temporal-v1 accessor

`forgeax_scene_temporal` is the single WGSL accessor ABI for the
`forgeax::scene-data::temporal-v1` sampled data. Standard PBR producers pack
the shared `SceneTemporalV1` record, and TAA resolve samples it through the
same accessors. Consumers must not add a private velocity or G-buffer unpack,
or import compiler, Naga, or backend policy into runtime shader code.

The public render route supplies the semantic target; this package supplies the
stable shader module identifier `SCENE_DATA_TEMPORAL_V1_SHADER_MODULE`. Layout,
clear values, invalid-depth handling, and reactive fallback remain owned by the
shared accessor source.

## Portable Motion Blur

`motion-blur.wgsl` is the sole built-in raster Motion Blur producer. It samples
the shared `forgeax_scene_temporal` accessor, derives a clamped motion vector,
and performs a depth-aware symmetric gather while preserving alpha. Invalid,
reactive, reset, subpixel, and depth-rejected samples return the current color;
the shader never reads or writes a private velocity buffer, G-buffer, storage
texture, or TAA history. Runtime code selects the pass through the typed render
plan; shader lookup remains a published content-addressed artifact and never
imports compiler, Naga, or backend policy.

## Points and Lines shader contract

Points and Lines use the engine-owned `forgeax::points-lines` material shader
manifest row. The row is a content-addressed runtime artifact selected by the
same `MaterialAsset` and `Materials.unlit` route as other built-in materials.
The Standard renderer binds the Points/Lines view at group 0, binding 10, then
uses the prepared expansion geometry in the active main geometry pass.

The runtime contract is compiler-free: it loads a published artifact and never
imports Naga, a shader compiler, or WGSL authoring helpers. `paramSchema`
remains the single source for derived layout and uniform shape. Manifest
validation is atomic; a malformed or stale row leaves the prior published
catalog unchanged and returns a structured error.

| Evidence | Meaning |
|:--|:--|
| shader manifest row | `forgeax::points-lines` is published and content-addressed |
| runtime isolation triple | no Naga in dist, no runtime shader compiler dependency, and no compiler import |
| graph contract | points-lines uses the existing Standard main pass and material binding path |
| lane contract | direct WebGPU is the focused runtime route; clustered unlit and WebGL2 restrictions are structural contracts unless a lane-specific runtime probe is available |

When lookup or reflection fails, inspect `.code`, `.expected`, `.hint`, and the
code-specific `.detail`; repair the source or cook input and republish through
the build-time producer. Do not create an app-local WGSL module, bypass the
manifest, or add a backend-specific shader branch. The same retained/prepared
state supplies render inspection and recovery evidence.

## Built-in PBR contract

The built-in PBR shader has named coordinate records for base color, metallic
roughness, normal, specular weight/color, emissive, occlusion, transmission,
and the declared physical texture slots. Each record carries offset, scale,
rotation, coordinate set, and physical extent metadata. The render package
projects the records into the UBO; the shader selects the declared vertex
coordinate input per slot. `specular`/`specularColor` replace the removed
The former specular-tint vocabulary was removed in one cut; no compatibility alias is supported.

Physical layer declarations are lowered from the Standard root contract. The
compiler appends only authored physical resources after the engine-owned IBL
and transmission region, so a base-only root has no physical binding or sample
and retains its Deferred pass. The five glTF extensions use the same schema and
the same Forward physical evaluator; runtime never compiles or patches this
layout.

## References

- [`@forgeax/engine-types` MaterialAsset](../types/README.md#materialasset-route)
- [`@forgeax/engine-pack` cook contract](../pack/README.md#materialasset-cook-contract)
- [`MaterialAsset migration`](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/material-asset-migration.md)

## Surface authoring checklist

- [x] Import `forgeax_material::surface_v1` and return the eight-field `SurfaceData`.
- [x] Read generated material parameters through `forgeax_material::parameters`.
- [x] Keep vertex, light, BRDF, pass, binding, and output ownership in Engine modules.
- [x] Let the root parameter contract determine physical layers and pass admission.
- [ ] Add an engine entry point or resource binding to a Surface module.

The final unchecked item is intentionally forbidden. If an effect needs its own
entry points or render targets, declare an explicit full-custom material and
publish its pass/lane provenance instead of disguising it as a Standard Surface.
