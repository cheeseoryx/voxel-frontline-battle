import type { ParamSchemaEntry } from '@forgeax/engine-types';
import {
  STANDARD_MATERIAL_PARAM_SCHEMA,
  STANDARD_PHYSICAL_PARAMETER_NAMES,
} from '@forgeax/engine-types';
import {
  createStandardPbrArtifactReceipt,
  type MaterialShaderArtifactReceipt,
} from './material/artifact-types.js';

export const STANDARD_PBR_ALPHA_CUTOFF_DEFAULT = 0;

/** Shared material contract for the standard PBR and skinned PBR shaders. */
export const DEFAULT_STANDARD_PBR_PARAM_SCHEMA = STANDARD_MATERIAL_PARAM_SCHEMA;

export type { StandardPhysicalTextureField } from '@forgeax/engine-types';
/**
 * Backward-compatible export name for callers that need the physical
 * projection.  Every entry is selected from the Standard root schema above;
 * no independent defaults or binding inventory can drift from it.
 */
/**
 * Stable physical texture injection order.  The order is part of the
 * Standard template's resource ABI and is derived from the root schema by
 * `standardPhysicalTextureFields`; render/cook must not maintain another
 * field inventory.
 */
export {
  STANDARD_PHYSICAL_TEXTURE_FIELDS,
  standardPhysicalTextureFields,
} from '@forgeax/engine-types';

export const STANDARD_PHYSICAL_LAYER_PARAM_SCHEMA: readonly ParamSchemaEntry[] =
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA.filter((entry) =>
    STANDARD_PHYSICAL_PARAMETER_NAMES.has(entry.name),
  );

/**
 * Canonical static Standard entry.  It deliberately contains only the base
 * contract (including the specular extension) so a base-only material keeps
 * its Deferred path and carries no second-stage physical resources.
 */
export const STANDARD_BASE_PARAM_SCHEMA: readonly ParamSchemaEntry[] =
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA.filter(
    (entry) =>
      !STANDARD_PHYSICAL_PARAMETER_NAMES.has(entry.name) &&
      ![
        'transmission',
        'thickness',
        'attenuationColor',
        'attenuationDistance',
        'transmissionTexture',
        'thicknessTexture',
      ].includes(entry.name),
  );

/**
 * Canonical boot-time user region for the shared Standard material BGL.
 *
 * It is still a projection of the root schema, but unlike the author-facing
 * base-only projection it retains the pre-existing transmission texture pair.
 * The template reserves those two pairs before the IBL/backdrop injection so
 * a base-only shader and a transmissive shader can share one boot layout;
 * physical texture pairs are never included here and are appended only for a
 * root contract that declares them.
 */
export const STANDARD_PIPELINE_PARAM_SCHEMA: readonly ParamSchemaEntry[] =
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA.filter(
    // The canonical Standard UBO keeps every numeric root coordinate,
    // including the physical-layer tail. Physical map pairs are engine-owned
    // resources and are injected after the stable user region.
    (entry) =>
      !(STANDARD_PHYSICAL_PARAMETER_NAMES.has(entry.name) && entry.type.startsWith('texture')),
  );

/** The single producer receipt shared by direct and scene-index Standard PBR. */
export const STANDARD_PBR_ARTIFACT_RECEIPT: MaterialShaderArtifactReceipt =
  createStandardPbrArtifactReceipt();

/** Skinned Standard PBR keeps the material receipt identity and adds palette ABI. */
export const STANDARD_PBR_SKIN_ARTIFACT_RECEIPT: MaterialShaderArtifactReceipt =
  createStandardPbrArtifactReceipt(true);

export const DEFAULT_UNLIT_PARAM_SCHEMA: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'alphaCutoff', type: 'f32', default: 0 },
  { name: 'baseColorTexture', type: 'texture2d' },
];

export const DEFAULT_SPRITE_PARAM_SCHEMA: readonly ParamSchemaEntry[] = [
  { name: 'colorTint', type: 'vec4', colorSpace: 'srgb', default: [1, 1, 1, 1] },
  { name: 'region', type: 'vec4', default: [0, 0, 1, 1] },
  { name: 'pivotAndSize', type: 'vec4', default: [0.5, 0.5, 1, 1] },
  { name: 'slicesAndMode', type: 'vec4', default: [0, 0, 0, 0] },
  { name: 'baseColorTexture', type: 'texture2d' },
];

export const DEFAULT_MSDF_TEXT_PARAM_SCHEMA: readonly ParamSchemaEntry[] = [
  { name: 'tintColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'distanceRange', type: 'vec4', default: [4, 512, 512, 0] },
  { name: 'baseColorTexture', type: 'texture2d' },
];
