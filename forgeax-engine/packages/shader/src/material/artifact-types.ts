import type { BindGroupLayoutDescriptor } from '@forgeax/engine-types';

export interface MaterialShaderResourceSlot {
  readonly name: string;
  readonly parameter: string;
  readonly kind: 'sampler' | 'texture';
  readonly group: number;
  readonly binding: number;
}

export interface MaterialShaderVertexInput {
  readonly semantic: string;
  readonly location: number;
  readonly format: string;
}

export interface MaterialShaderArtifactReceipt {
  readonly directEntry: string;
  readonly sceneIndexEntry: string;
  readonly materialRow: {
    readonly byteLength: number;
    readonly fields: readonly string[];
  };
  readonly resourceSlots: readonly MaterialShaderResourceSlot[];
  readonly uvSets: readonly { readonly parameter: string; readonly set: number }[];
  readonly vertexInputs: readonly MaterialShaderVertexInput[];
  readonly alphaMask: { readonly cutoff: string; readonly source: string };
  readonly skinPaletteAddress?: {
    readonly group: number;
    readonly binding: number;
    readonly stride: number;
  };
  readonly reflection: {
    readonly layoutIdentity: string;
    readonly resourceSlots: readonly MaterialShaderResourceSlot[];
    readonly vertexInputs: readonly MaterialShaderVertexInput[];
  };
  readonly receiptIdentity: string;
  readonly generation: number;
}

export interface MaterialShaderArtifact {
  readonly material: string;
  readonly pass: string;
  readonly wgsl: string;
  readonly layoutIdentity: string;
  /** Naga-reflected UV set count used to derive clamp-to-last vertex aliases. */
  readonly uvSetCount?: number;
  readonly bindings: readonly BindGroupLayoutDescriptor[];
  readonly deps: readonly string[];
  readonly vertexInputs: readonly Readonly<Record<string, unknown>>[];
  readonly specializationKey?: string;
  /** Producer-owned ABI facts shared by direct and scene-index consumers. */
  readonly receipt?: MaterialShaderArtifactReceipt;
}

const STANDARD_PBR_TEXTURES = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
  'specularColorTexture',
  'emissiveTexture',
  'occlusionTexture',
  'transmissionTexture',
  'thicknessTexture',
] as const;

const STANDARD_PBR_NUMERIC_FIELDS = [
  'baseColor',
  'metallic',
  'roughness',
  'metallicChannel',
  'roughnessChannel',
  'aoChannel',
  'extraChannel',
  'emissive',
  'emissiveIntensity',
  'occlusionStrength',
  'alphaCutoff',
  'clearcoat',
  'clearcoatRoughness',
  'specularColor',
  'normalScale',
  'transmission',
  'ior',
  'thickness',
  'attenuationColor',
  'attenuationDistance',
] as const;

const STANDARD_PBR_VERTEX_INPUTS: readonly MaterialShaderVertexInput[] = [
  { semantic: 'position', location: 0, format: 'float32x3' },
  { semantic: 'normal', location: 1, format: 'float32x3' },
  { semantic: 'uv', location: 2, format: 'float32x2' },
  { semantic: 'tangent', location: 3, format: 'float32x4' },
];

function standardPbrResourceSlots(): MaterialShaderResourceSlot[] {
  return STANDARD_PBR_TEXTURES.flatMap((parameter, index) => [
    {
      name: `${parameter}_sampler`,
      parameter,
      kind: 'sampler' as const,
      group: 1,
      binding: index * 2 + 1,
    },
    {
      name: parameter,
      parameter,
      kind: 'texture' as const,
      group: 1,
      binding: index * 2 + 2,
    },
  ]);
}

/**
 * Builds the one Standard PBR ABI receipt consumed by both material lanes.
 * The skinned module uses the same material producer and only adds its palette
 * address; it must retain the same receipt identity for material compatibility.
 */
export function createStandardPbrArtifactReceipt(skinned = false): MaterialShaderArtifactReceipt {
  const resourceSlots = standardPbrResourceSlots();
  const uvSets = STANDARD_PBR_TEXTURES.map((parameter) => ({ parameter, set: 0 }));
  const vertexInputs = skinned
    ? [
        ...STANDARD_PBR_VERTEX_INPUTS,
        { semantic: 'skinIndex', location: 4, format: 'uint16x4' },
        { semantic: 'skinWeight', location: 5, format: 'float32x4' },
      ]
    : [...STANDARD_PBR_VERTEX_INPUTS];
  return {
    directEntry: 'vs_main',
    sceneIndexEntry: 'vs_scene_index',
    materialRow: { byteLength: 384, fields: [...STANDARD_PBR_NUMERIC_FIELDS] },
    resourceSlots,
    uvSets,
    vertexInputs,
    alphaMask: { cutoff: 'alphaCutoff', source: 'baseColor.a' },
    ...(skinned ? { skinPaletteAddress: { group: 2, binding: 1, stride: 64 } } : {}),
    reflection: {
      layoutIdentity: 'standard-pbr/material-row-v1',
      resourceSlots,
      vertexInputs,
    },
    receiptIdentity: 'standard-pbr/material-row-v1',
    generation: 1,
  };
}

export function isMaterialShaderArtifact(value: unknown): value is MaterialShaderArtifact {
  if (value === null || typeof value !== 'object') return false;
  const artifact = value as Partial<MaterialShaderArtifact>;
  return (
    typeof artifact.material === 'string' &&
    typeof artifact.pass === 'string' &&
    typeof artifact.wgsl === 'string' &&
    typeof artifact.layoutIdentity === 'string' &&
    Array.isArray(artifact.bindings) &&
    Array.isArray(artifact.deps) &&
    Array.isArray(artifact.vertexInputs)
  );
}
