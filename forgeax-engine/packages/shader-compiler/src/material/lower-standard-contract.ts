import { isStandardRootModule } from '@forgeax/engine-pack';
import type {
  MaterialParameter,
  MaterialPass,
  ParamSchemaEntry,
  Result,
  StandardLayerPlan,
} from '@forgeax/engine-types';
import {
  createMaterialError,
  derive,
  deriveStandardLayerPlan,
  err,
  isMaterialPhysicalContractError,
  type MaterialError,
  ok,
  STANDARD_PHYSICAL_TEXTURE_FIELDS,
  STANDARD_TRANSMISSION_PARAMETER_NAMES,
  standardPhysicalTextureFields,
} from '@forgeax/engine-types';

/** The one build-time projection consumed by both Pack cooking and Vite. */
export interface LoweredStandardContract {
  readonly layerPlan: StandardLayerPlan;
  readonly paramSchema: readonly ParamSchemaEntry[];
  readonly defines: Readonly<Record<string, boolean>>;
  readonly layoutIdentity: string;
}

function usesStandardTemplate(passes: readonly MaterialPass[] | undefined): boolean {
  return passes?.some((pass) => isStandardRootModule(pass.program.module)) ?? false;
}

function materialTypeToSchema(parameter: MaterialParameter): ParamSchemaEntry | undefined {
  switch (parameter.type) {
    case 'bool':
      return undefined;
    case 'f32':
    case 'i32':
    case 'u32':
    case 'vec2':
    case 'vec3':
    case 'vec4':
    case 'color': {
      const value = parameter.default;
      const defaultValue =
        typeof value === 'number' || Array.isArray(value) ? { default: value } : {};
      return {
        name: parameter.name,
        type: parameter.type,
        ...(parameter.colorSpace === undefined ? {} : { colorSpace: parameter.colorSpace }),
        ...defaultValue,
      } as ParamSchemaEntry;
    }
    case 'texture':
      return { name: parameter.name, type: 'texture2d' };
    case 'texture_cube':
      return { name: parameter.name, type: 'texture_cube' };
  }
}

/** Lower authored MaterialParameter values to the generic ParamSchema ABI. */
export function projectStandardParameterSchema(
  parameters: readonly MaterialParameter[],
): Result<readonly ParamSchemaEntry[], MaterialError> {
  const projected: ParamSchemaEntry[] = [];
  for (const parameter of parameters) {
    const schema = materialTypeToSchema(parameter);
    if (schema !== undefined) projected.push(schema);
  }
  return ok(projected);
}

function definePhysicalLayers(
  schema: readonly ParamSchemaEntry[],
  layerPlan: StandardLayerPlan,
): Readonly<Record<string, boolean>> {
  const names = new Set(schema.map((entry) => entry.name));
  const defines: Record<string, boolean> = {};
  const hasLayer = (name: string): boolean => layerPlan.layers.some((layer) => layer.name === name);
  if (hasLayer('anisotropy')) defines.ANISOTROPY_AVAILABLE = true;
  if (hasLayer('sheen')) defines.SHEEN_AVAILABLE = true;
  if (hasLayer('iridescence')) defines.IRIDESCENCE_AVAILABLE = true;
  if (hasLayer('clearcoat')) defines.CLEARCOAT_AVAILABLE = true;
  if (names.has('clearcoatTexture')) defines.CLEARCOAT_TEXTURE_AVAILABLE = true;
  if (names.has('clearcoatRoughnessTexture')) {
    defines.CLEARCOAT_ROUGHNESS_TEXTURE_AVAILABLE = true;
  }
  if (names.has('clearcoatNormalTexture')) defines.CLEARCOAT_NORMAL_TEXTURE_AVAILABLE = true;
  if (names.has('anisotropyTexture')) defines.ANISOTROPY_TEXTURE_AVAILABLE = true;
  if (names.has('sheenColorTexture')) defines.SHEEN_COLOR_TEXTURE_AVAILABLE = true;
  if (names.has('sheenRoughnessTexture')) defines.SHEEN_ROUGHNESS_TEXTURE_AVAILABLE = true;
  if (names.has('iridescenceTexture')) defines.IRIDESCENCE_TEXTURE_AVAILABLE = true;
  if (names.has('iridescenceThicknessTexture')) {
    defines.IRIDESCENCE_THICKNESS_TEXTURE_AVAILABLE = true;
  }
  if (names.has('specularTexture')) defines.SPECULAR_TEXTURE_AVAILABLE = true;
  if (names.has('specularColorTexture')) defines.SPECULAR_COLOR_TEXTURE_AVAILABLE = true;
  if (
    [...names].some((name) => STANDARD_TRANSMISSION_PARAMETER_NAMES.has(name) && name !== 'ior')
  ) {
    defines.TRANSMISSION_AVAILABLE = true;
  }
  return defines;
}

/**
 * Lower one Standard root contract exactly once.  The result is deliberately
 * independent of runtime values, texture GUIDs, or sampler identity: only
 * declared parameter names select the physical source and ABI.
 */
export function lowerStandardContract(
  parameters: readonly MaterialParameter[],
  passes?: readonly MaterialPass[],
): Result<LoweredStandardContract, MaterialError> {
  const standard = usesStandardTemplate(passes);
  let layerPlan: StandardLayerPlan;
  try {
    layerPlan = deriveStandardLayerPlan(standard ? parameters : [], standard ? passes : undefined);
  } catch (error) {
    if (isMaterialPhysicalContractError(error)) {
      return err(
        createMaterialError('material-physical-contract-invalid', error.detail, error.message),
      );
    }
    throw error;
  }
  const schema = projectStandardParameterSchema(parameters);
  if (!schema.ok) return schema;
  const defines = standard ? definePhysicalLayers(schema.value, layerPlan) : {};
  return ok({
    layerPlan,
    paramSchema: schema.value,
    defines,
    layoutIdentity: derive(schema.value).layoutIdentity,
  });
}

/**
 * Move the template's reserved physical texture declarations into the compact
 * resource region for this exact root contract.  The template keeps readable
 * canonical slots (26, 28, …) while the cooked artifact owns the final ABI;
 * absent slots are removed by the normal boolean-define specialization pass.
 */
export function lowerStandardPhysicalBindings(
  source: string,
  schema: readonly ParamSchemaEntry[],
): string {
  const fields = standardPhysicalTextureFields(schema);
  const names = new Set(schema.map((entry) => entry.name));
  const physicalFieldSet = new Set<string>(fields);
  const nonPhysicalSchema = schema.filter((entry) => !physicalFieldSet.has(entry.name));
  const nonPhysical = derive(nonPhysicalSchema);
  let lowered = source;
  // The template keeps readable canonical slots for the base textures and
  // engine injections.  The effective root may omit the old specular-color
  // pair or any transmission pair, so move each fixed declaration to the
  // exact binding derived from the effective non-physical schema before
  // compacting IBL/transmission and the declaration-driven physical tail.
  const resourceBindings = new Map(
    nonPhysical.resourceBindings.map((resource) => [
      `${resource.parameter ?? resource.name}:${resource.kind}`,
      resource.binding,
    ]),
  );
  const remapResource = (field: string) => {
    const sampler = resourceBindings.get(`${field}:sampler`);
    const texture = resourceBindings.get(`${field}:texture`);
    const samplerNames = [`${field}_sampler`, `${field.replace(/Texture$/, '')}Sampler`];
    if (sampler !== undefined) {
      for (const samplerName of samplerNames) {
        lowered = lowered.replace(
          new RegExp(`(@group\\(1\\)\\s*@binding\\()\\d+(\\)\\s+var\\s+${samplerName}\\b)`, 'g'),
          `$1${sampler}$2`,
        );
      }
    }
    if (texture !== undefined) {
      lowered = lowered.replace(
        new RegExp(`(@group\\(1\\)\\s*@binding\\()\\d+(\\)\\s+var\\s+${field}\\b)`, 'g'),
        `$1${texture}$2`,
      );
    }
  };
  remapResource('baseColorTexture');
  remapResource('metallicRoughnessTexture');
  remapResource('normalTexture');
  remapResource('emissiveTexture');
  remapResource('occlusionTexture');
  remapResource('transmissionTexture');
  remapResource('thicknessTexture');

  const userRegionEnd = nonPhysical.userRegionBindingEnd;
  const transmissionAvailable = names.has('transmissionTexture') && names.has('thicknessTexture');
  const iblStart = userRegionEnd;
  const transmissionStart = iblStart + 7;
  const physicalStart = transmissionStart + 2;
  for (let index = 0; index < 7; index += 1) {
    const canonical = 17 + index;
    const target = iblStart + index;
    if (canonical === target) continue;
    lowered = lowered.replace(
      new RegExp(`(@group\\(1\\)\\s*@binding\\()${canonical}(\\))`, 'g'),
      `$1${target}$2`,
    );
  }
  if (transmissionAvailable) {
    for (let index = 0; index < 2; index += 1) {
      const canonical = 24 + index;
      const target = transmissionStart + index;
      if (canonical === target) continue;
      lowered = lowered.replace(
        new RegExp(`(@group\\(1\\)\\s*@binding\\()${canonical}(\\))`, 'g'),
        `$1${target}$2`,
      );
    }
  }
  for (const [canonicalIndex, field] of STANDARD_PHYSICAL_TEXTURE_FIELDS.entries()) {
    const targetIndex = fields.indexOf(field);
    if (targetIndex < 0) continue;
    const canonicalSampler = 26 + canonicalIndex * 2;
    const targetSampler = physicalStart + targetIndex * 2;
    if (canonicalSampler === targetSampler) continue;
    lowered = lowered.replace(
      new RegExp(`(@group\\(1\\)\\s*@binding\\()${canonicalSampler}(\\))`, 'g'),
      `$1${targetSampler}$2`,
    );
    lowered = lowered.replace(
      new RegExp(`(@group\\(1\\)\\s*@binding\\()${canonicalSampler + 1}(\\))`, 'g'),
      `$1${targetSampler + 1}$2`,
    );
  }
  return lowered;
}
