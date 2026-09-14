// @forgeax/engine-shader — runtime shader registry public surface.
//
// Shape rules (plan-strategy §S-10 / D-R10 / OQ-5 close):
// - instance-per-engine — exposed through the lazy `engine.shader:
//   ShaderRegistry` property; module-level singletons / static methods are
//   forbidden (aligned with `Engine.create({ rhi })`'s instance-based style).
// - Physical isolation — this package's deps only contain `@forgeax/engine-rhi` +
//   `@forgeax/engine-types`; importing `@forgeax/engine-shader-compiler` / `@forgeax/engine-naga`
//   / `@forgeax/engine-wgpu-wasm` directly or transitively is **forbidden**
//   (guarded by the AC-06 triple-grep gate; feat-20260511-naga-rhi-wgpu-merge
//   M4 replaced the legacy single-shim ban with the merged ban triple above).
// - Result model — expected failures go through
//   `Result.err(RhiError | ShaderError)` and **never throw** (AGENTS.md
//   "Errors are structured" / charter proposition 4: explicit failure).
//
// Top-level surface (charter proposition 1: progressive disclosure):
// - ShaderRegistry / ShaderRegistryOptions / ShaderRegistryDevice — main class
//   + injection interface
// - ShaderError / ShaderErrorCode / 2 factories — runtime error types
// - Result<T, E> + ok / err — binary result type and constructors
// - ManifestEntry — re-exported from `@forgeax/engine-types` (manifest schema SSOT)

export type { ManifestEntry, ParamSchemaEntry } from '@forgeax/engine-types';

import type { MaterialAsset, MaterialParameter, MaterialValue } from '@forgeax/engine-types';
import { standardSurfaceParameters } from '@forgeax/engine-types';
import { STANDARD_PBR_ALPHA_CUTOFF_DEFAULT } from './material-schemas.js';

export { MATERIAL_PARAM_TYPES } from '@forgeax/engine-types';
export {
  err,
  manifestMalformed,
  materialShaderNotFound,
  ok,
  type Result,
  type ResultErr,
  type ResultOk,
  ShaderError,
  type ShaderErrorCode,
  type ShaderErrorDetail,
  shaderNotFound,
} from './errors.js';
export {
  generateLtcTables,
  hashLtcTable,
  LTC_SOURCE_PROVENANCE,
  LTC_TABLE_HASHES,
  LTC_TABLE_HEIGHT,
  LTC_TABLE_INPUT_HASHES,
  LTC_TABLE_WIDTH,
  LTC_TABLES,
} from './ltc/tables.js';
export {
  type MaterialArtifactConflictError,
  type MaterialArtifactInspection,
  MaterialArtifactRegistry,
  type MaterialRuntimeArtifact,
} from './material/artifact-registry.js';
export {
  createStandardPbrArtifactReceipt,
  isMaterialShaderArtifact,
  type MaterialShaderArtifact,
  type MaterialShaderArtifactReceipt,
  type MaterialShaderResourceSlot,
  type MaterialShaderVertexInput,
} from './material/artifact-types.js';
export {
  DEFAULT_MSDF_TEXT_PARAM_SCHEMA,
  DEFAULT_SPRITE_PARAM_SCHEMA,
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  DEFAULT_UNLIT_PARAM_SCHEMA,
  STANDARD_BASE_PARAM_SCHEMA,
  STANDARD_PBR_ALPHA_CUTOFF_DEFAULT,
  STANDARD_PBR_ARTIFACT_RECEIPT,
  STANDARD_PBR_SKIN_ARTIFACT_RECEIPT,
  STANDARD_PHYSICAL_LAYER_PARAM_SCHEMA,
  STANDARD_PHYSICAL_TEXTURE_FIELDS,
  STANDARD_PIPELINE_PARAM_SCHEMA,
  type StandardPhysicalTextureField,
  standardPhysicalTextureFields,
} from './material-schemas.js';
export {
  registerDefaultSpriteLit,
  type SpriteLitCaps,
} from './register-default-sprite-lit.js';
export { registerDefaultStandardPbrSkin } from './register-default-standard-pbr-skin.js';
export const RECT_AREA_LTC_SHADER_MODULE = 'forgeax::lighting-rect-area' as const;
export {
  FORGEAX_RESERVED_PATH_PREFIX,
  type MaterialShaderEntry,
  type RegisteredMaterialShaderEntry,
  ShaderRegistry,
  ShaderRegistry as ShaderCatalog,
  type ShaderRegistryDevice,
  type ShaderRegistryDevice as ShaderCatalogDevice,
  type ShaderRegistryOptions,
  type ShaderRegistryOptions as ShaderCatalogOptions,
} from './ShaderRegistry.js';
export {
  findVariantByKey,
  type MaterialShaderManifestEntry,
  type MaterialShaderManifestVariant,
} from './types.js';

export const BUILTIN_MATERIAL_MODULES = {
  standard: 'forgeax_material::standard',
  unlit: 'forgeax_material::unlit',
  sprite: 'forgeax_material::sprite',
} as const;

/**
 * The engine-owned Standard Surface selected by a built-in Standard material.
 * Keep this explicit in the authored pass so the build-time cooker sees the
 * same slot contract as Materials.standard().
 */
export const DEFAULT_STANDARD_SURFACE_MODULE =
  'forgeax_material::default_standard_surface' as const;

/** Stable build-time module id for the temporal-v1 accessor owner. */
export const SCENE_DATA_TEMPORAL_V1_SHADER_MODULE = 'forgeax_scene_temporal' as const;

/**
 * Material modules whose shader source and parameter contract are owned by
 * the Engine. They live in the runtime ShaderRegistry, so a Pack containing
 * one of these materials carries authored values only and does not require a
 * project material-cook artifact. A Standard pass with a project Surface slot
 * is deliberately excluded: its root composition is project-owned and must
 * arrive with a cooked material publication.
 */
export const ENGINE_MATERIAL_MODULES = [
  'forgeax::default-standard-pbr',
  'forgeax::pbr-skin',
  'forgeax::default-standard-pbr-skin',
  'forgeax::default-unlit',
  'forgeax::default-shadow-caster',
  'forgeax::sprite',
  'forgeax::sprite-lit',
  'forgeax::msdf-text',
  BUILTIN_MATERIAL_MODULES.standard,
  BUILTIN_MATERIAL_MODULES.unlit,
  BUILTIN_MATERIAL_MODULES.sprite,
  'forgeax_material::sprite-lit',
] as const;

/** Names of the zero-binding Standard reflection-probe shader helpers. */
export const REFLECTION_PROBE_SHADER_HELPERS = Object.freeze([
  'box_project',
  'sampleReflectionProbeSpecular',
] as const);

export function isEngineMaterialModule(module: string): boolean {
  return (ENGINE_MATERIAL_MODULES as readonly string[]).includes(module);
}

export function isEngineMaterial(material: Pick<MaterialAsset, 'passes'>): boolean {
  const passes = material.passes ?? [];
  return (
    passes.length > 0 &&
    passes.every(
      (pass) =>
        isEngineMaterialModule(pass.program.module) &&
        (pass.program.moduleSlots?.surface === undefined ||
          pass.program.moduleSlots.surface === DEFAULT_STANDARD_SURFACE_MODULE),
    )
  );
}

export type BuiltinMaterialKind = keyof typeof BUILTIN_MATERIAL_MODULES;

const BUILTIN_PARAMETERS: Readonly<Record<BuiltinMaterialKind, readonly MaterialParameter[]>> = {
  standard: [
    { name: 'baseColor', type: 'color' },
    { name: 'metallic', type: 'f32' },
    { name: 'roughness', type: 'f32' },
    { name: 'alphaCutoff', type: 'f32', optional: true },
  ],
  unlit: [{ name: 'baseColor', type: 'color' }],
  sprite: [{ name: 'colorTint', type: 'vec4', colorSpace: 'srgb' }],
};

const BUILTIN_VALUES: Readonly<
  Record<BuiltinMaterialKind, Readonly<Record<string, MaterialValue>>>
> = {
  standard: {
    baseColor: [1, 1, 1, 1],
    metallic: 0,
    roughness: 0.5,
    alphaCutoff: STANDARD_PBR_ALPHA_CUTOFF_DEFAULT,
  },
  unlit: { baseColor: [1, 1, 1, 1] },
  sprite: { colorTint: [1, 1, 1, 1] },
};

export function createBuiltinMaterialAsset(kind: BuiltinMaterialKind): MaterialAsset {
  return {
    kind: 'material',
    passes: [
      {
        name: 'forward',
        program: {
          module: BUILTIN_MATERIAL_MODULES[kind],
          ...(kind === 'standard'
            ? { moduleSlots: { surface: DEFAULT_STANDARD_SURFACE_MODULE } }
            : {}),
        },
      },
    ],
    parameters:
      kind === 'standard'
        ? standardSurfaceParameters(BUILTIN_PARAMETERS[kind])
        : BUILTIN_PARAMETERS[kind],
    values: BUILTIN_VALUES[kind],
  };
}

/**
 * Shared luminance epsilon floor for the extended Reinhard tone-map
 * (feat-20260519-tonemap-reinhard-mvp / D-O3).
 *
 * Both the TS port at `packages/runtime/src/systems/tonemap.ts` and the WGSL
 * fragment stage in `packages/shader/src/tonemap.wgsl` apply
 * `max(Y, TONEMAP_LUMINANCE_EPSILON)` before dividing the luminance ratio.
 * The floor keeps the divisor finite at degenerate inputs (`Y = 0` from black
 * pixels, `Y < 0` from rare numerical artefacts). Single SSOT here so a
 * single `import { TONEMAP_LUMINANCE_EPSILON } from '@forgeax/engine-shader'`
 * keeps TS / WGSL byte-equivalent.
 *
 * Value: `1e-5` — small enough to not perturb any plausible HDR luminance.
 */
export const TONEMAP_LUMINANCE_EPSILON = 1e-5;

export { TONEMAP_SHADER_MODE, type TonemapShaderMode } from './tonemap.js';
