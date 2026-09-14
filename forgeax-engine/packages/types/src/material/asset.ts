import type { AssetGuid } from '../index.js';
import type { MaterialColorSpace } from './color-space.js';
import {
  MATERIAL_ERROR_EXPECTED,
  MATERIAL_ERROR_HINTS,
  type MaterialChildContractInvalidDetail,
} from './errors.js';

export type MaterialParameterType =
  | 'bool'
  | 'f32'
  | 'i32'
  | 'u32'
  | 'vec2'
  | 'vec3'
  | 'vec4'
  | 'color'
  | 'texture'
  | 'texture_cube';

export interface MaterialParameter {
  readonly name: string;
  readonly type: MaterialParameterType;
  /**
   * Asset-side transfer function for an authored color value. `color`
   * parameters default to `srgb`; numeric vectors default to linear unless
   * explicitly tagged. An asset-level `colorSpace` overrides this schema
   * default. Runtime material values are always linear.
   */
  readonly colorSpace?: MaterialColorSpace;
  readonly default?: MaterialValue;
  readonly optional?: boolean;
}

export interface MaterialTextureCoordinates {
  readonly set?: number;
  /** Producer-owned logical-to-physical texture extent correction. */
  readonly physicalUvScale?: readonly [number, number];
  readonly transform?: {
    readonly offset?: readonly [number, number];
    readonly scale?: readonly [number, number];
    readonly rotation?: number;
  };
}

export interface ResolvedMaterialTextureCoordinates {
  readonly set: number;
  readonly transform: {
    readonly offset: readonly [number, number];
    readonly scale: readonly [number, number];
    readonly rotation: number;
  };
}

export function resolveMaterialTextureCoordinates(
  coordinates?: MaterialTextureCoordinates,
): ResolvedMaterialTextureCoordinates {
  return {
    set: coordinates?.set ?? 0,
    transform: {
      offset: coordinates?.transform?.offset ?? [0, 0],
      scale: coordinates?.transform?.scale ?? [1, 1],
      rotation: coordinates?.transform?.rotation ?? 0,
    },
  };
}

export type MaterialTextureReference = AssetGuid | number | string;

export interface MaterialTextureValue {
  readonly texture: MaterialTextureReference;
  readonly sampler?: MaterialTextureReference;
  readonly coordinates?: MaterialTextureCoordinates;
  readonly normalScale?: number;
  readonly occlusionStrength?: number;
}

export type MaterialValue = boolean | number | readonly number[] | string | MaterialTextureValue;

export interface MaterialProgram {
  readonly module: string;
  readonly vertexEntry?: string;
  readonly fragmentEntry?: string;
  readonly moduleSlots?: Readonly<Record<string, string>>;
}

export interface MaterialPass {
  readonly name: string;
  readonly program: MaterialProgram;
  readonly renderState?: Readonly<Record<string, unknown>>;
}

export type MaterialPassList = readonly [MaterialPass, ...MaterialPass[]];

/**
 * Root-owned material contract. A root owns the pass and parameter schema;
 * descendants select it through `parent` and may only author runtime values.
 */
export interface MaterialRootAsset {
  readonly kind: 'material';
  /**
   * Transfer function override for all authored color parameters. Omitted
   * parameters ultimately default to sRGB.
   * Explicit `linear` is reserved for physical/imported data such as glTF
   * factors. Numeric values are never rewritten when this metadata changes.
   */
  readonly colorSpace?: MaterialColorSpace;
  readonly parent?: never;
  readonly passes?: MaterialPassList;
  readonly parameters?: readonly MaterialParameter[];
  readonly values?: Readonly<Record<string, MaterialValue | null>>;
}

/**
 * Minimal parent-bearing material contract. The root supplies color space,
 * passes, and parameters during resolution; a child can only override values.
 */
export interface MaterialChildAsset {
  readonly kind: 'material';
  readonly parent: AssetGuid;
  readonly colorSpace?: never;
  readonly passes?: never;
  readonly parameters?: never;
  readonly values?: Readonly<Record<string, MaterialValue | null>>;
}

/**
 * One authored material subject. Pack publishes the resolved contract;
 * runtime and render consume read-only projections. Values and module slots
 * are runtime data with a closed compiler context; compiler macros and
 * feature defines are not part of this contract.
 */
export type MaterialAsset = MaterialRootAsset | MaterialChildAsset;

export const MATERIAL_CHILD_FORBIDDEN_FIELDS = ['colorSpace', 'passes', 'parameters'] as const;
export type MaterialChildForbiddenField = (typeof MATERIAL_CHILD_FORBIDDEN_FIELDS)[number];

function hasOwn(value: object, field: PropertyKey): boolean {
  return Object.hasOwn(value, field);
}

/** Return the root-owned fields that make a parent-bearing child invalid. */
export function materialChildForbiddenFields(
  asset: MaterialAsset,
): readonly MaterialChildForbiddenField[] {
  if (asset.parent === undefined) return [];
  return MATERIAL_CHILD_FORBIDDEN_FIELDS.filter((field) => hasOwn(asset, field));
}

function materialParentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) {
    return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return String(value);
}

export interface MaterialAuthoringErrorDetail {
  readonly code: 'material-authoring-field-forbidden';
  readonly owner: 'material-runtime' | 'material-authoring';
  readonly field: string;
  readonly actual: unknown;
  readonly action: 'remove-field';
}

export class MaterialAssetContractError extends Error {
  readonly code = 'material-authoring-field-forbidden' as const;
  readonly expected =
    'material authoring contains only runtime values and source-owned module selection';
  readonly hint =
    'remove the compiler macro field and use a runtime value, module slot, or compiler context';
  readonly detail: MaterialAuthoringErrorDetail;

  constructor(detail: Omit<MaterialAuthoringErrorDetail, 'code'>) {
    super(`${detail.field}: material compiler macro fields are not supported`);
    this.name = 'MaterialAssetContractError';
    this.detail = { code: 'material-authoring-field-forbidden', ...detail };
  }
}

/** Structured loading-boundary failure for a non-minimal derived material. */
export class MaterialChildContractError extends Error {
  readonly code = 'material-child-contract-invalid' as const;
  readonly expected = MATERIAL_ERROR_EXPECTED['material-child-contract-invalid'];
  readonly hint = MATERIAL_ERROR_HINTS['material-child-contract-invalid'];
  readonly detail: MaterialChildContractInvalidDetail;

  constructor(detail: Omit<MaterialChildContractInvalidDetail, 'code'>) {
    super(`${detail.material}: parent-bearing material contains forbidden fields`);
    this.name = 'MaterialChildContractError';
    this.detail = { code: 'material-child-contract-invalid', ...detail };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate JSON-authored material descriptors at their loading boundary. */
export function assertMaterialAsset(
  value: unknown,
  context = 'material',
): asserts value is MaterialAsset {
  if (!isRecord(value) || value.kind !== 'material') {
    throw new Error(`${context}: expected a material asset`);
  }
  for (const field of Object.keys(value)) {
    if (!['kind', 'colorSpace', 'parent', 'passes', 'parameters', 'values'].includes(field)) {
      throw new MaterialAssetContractError({
        owner:
          field === 'features' || field === 'defines' ? 'material-authoring' : 'material-runtime',
        field,
        actual: value[field],
        action: 'remove-field',
      });
    }
  }
  const forbidden = materialChildForbiddenFields(value as unknown as MaterialAsset);
  if (forbidden.length > 0) {
    throw new MaterialChildContractError({
      material: context,
      parent: materialParentText(value.parent),
      forbidden,
      action: 'remove-forbidden-fields',
    });
  }
  if (
    value.colorSpace !== undefined &&
    value.colorSpace !== 'srgb' &&
    value.colorSpace !== 'linear'
  ) {
    throw new Error(`${context}: invalid colorSpace`);
  }
  if (value.passes !== undefined) {
    if (!Array.isArray(value.passes) || value.passes.length === 0) {
      throw new Error(`${context}: passes must be a non-empty array`);
    }
    for (const [index, pass] of value.passes.entries()) {
      if (!isRecord(pass) || typeof pass.name !== 'string' || !isRecord(pass.program)) {
        throw new Error(`${context}: pass ${index} is malformed`);
      }
      if (typeof pass.program.module !== 'string' || pass.program.module.length === 0) {
        throw new Error(`${context}: pass ${index} has no module identity`);
      }
      if (
        (pass.program.vertexEntry !== undefined && typeof pass.program.vertexEntry !== 'string') ||
        (pass.program.fragmentEntry !== undefined && typeof pass.program.fragmentEntry !== 'string')
      ) {
        throw new Error(`${context}: pass ${index} has malformed entry points`);
      }
      if (pass.program.moduleSlots !== undefined) {
        if (!isRecord(pass.program.moduleSlots)) {
          throw new Error(`${context}: pass ${index} has malformed module slots`);
        }
        for (const [name, slot] of Object.entries(pass.program.moduleSlots)) {
          if (typeof slot !== 'string')
            throw new Error(`${context}: module slot ${name} is not a string`);
        }
      }
    }
  }
  if (value.parameters !== undefined) {
    if (!Array.isArray(value.parameters))
      throw new Error(`${context}: parameters must be an array`);
    for (const [index, parameter] of value.parameters.entries()) {
      if (
        !isRecord(parameter) ||
        typeof parameter.name !== 'string' ||
        typeof parameter.type !== 'string'
      ) {
        throw new Error(`${context}: parameter ${index} is malformed`);
      }
      if (
        parameter.colorSpace !== undefined &&
        parameter.colorSpace !== 'srgb' &&
        parameter.colorSpace !== 'linear'
      ) {
        throw new Error(`${context}: parameter ${index} has invalid colorSpace`);
      }
      if ('static' in parameter) {
        throw new MaterialAssetContractError({
          owner: 'material-authoring',
          field: 'parameters.static',
          actual: parameter.static,
          action: 'remove-field',
        });
      }
    }
  }
}
