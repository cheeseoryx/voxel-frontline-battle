import {
  type MaterialCookProgramContext,
  validateMaterialCookProgramContext,
} from '@forgeax/engine-pack/material-cook';
import { err, ok, type Result } from '@forgeax/engine-types';

export type MaterialBackend = MaterialCookProgramContext['backend'];
export type MaterialCapability = MaterialCookProgramContext['capability'];
export type MaterialPipeline = MaterialCookProgramContext['pipeline'];
export type MaterialGeometry = MaterialCookProgramContext['geometry'];
export type MaterialPass = MaterialCookProgramContext['pass'];
export type MaterialInstrumentation = MaterialCookProgramContext['instrumentation'];
export type MaterialVariantContextInput = MaterialCookProgramContext;
export type MaterialVariantContext = MaterialCookProgramContext;

export const DEFAULT_MATERIAL_VARIANT_CONTEXT: MaterialVariantContext = {
  backend: 'webgpu',
  capability: 'storage-buffer',
  pipeline: 'forward',
  geometry: 'mesh',
  pass: 'forward',
  profile: 'forgeax-material-wgsl-v1',
  toolchain: 'naga-oil',
  instrumentation: 'none',
};

export interface MaterialVariantContextError {
  readonly code: 'material-variant-context-invalid' | 'material-variant-axis-reserved';
  readonly field: string;
  readonly expected: string;
  readonly actual: unknown;
  readonly action: 'use-domain-owner-field' | 'remove-material-override';
}

const RESERVED_AXES = new Set([
  'STORAGE_BUFFER_AVAILABLE',
  'WEBGL2_COMPAT',
  'CLUSTER_FORWARD_AVAILABLE',
  'PROJECTOR_AVAILABLE',
  'POINT_SHADOW_AVAILABLE',
  'PER_INSTANCE_REGION',
]);

function invalid(field: string, actual: unknown): Result<never, MaterialVariantContextError> {
  return err({
    code: 'material-variant-context-invalid',
    field,
    expected: 'a closed MaterialVariantContext field',
    actual,
    action: 'use-domain-owner-field',
  });
}

export function createMaterialVariantContext(
  value: unknown,
): Result<MaterialVariantContext, MaterialVariantContextError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('context', value);
  }
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (RESERVED_AXES.has(field)) {
      return err({
        code: 'material-variant-axis-reserved',
        field,
        expected: 'the corresponding domain-owned context field',
        actual: record[field],
        action: 'remove-material-override',
      });
    }
  }
  const validated = validateMaterialCookProgramContext(value);
  if (!validated.ok) {
    return invalid(
      validated.error.detail.field.replace(/^context\./, ''),
      validated.error.detail.actual,
    );
  }
  return ok(validated.value);
}

/**
 * Lower a validated domain snapshot to the compiler's private boolean selectors.
 * Material callers cannot provide or merge this map themselves.
 */
export function lowerMaterialVariantContext(
  context: MaterialVariantContext,
): Readonly<Record<string, boolean>> {
  return Object.freeze({
    STORAGE_BUFFER_AVAILABLE: context.capability === 'storage-buffer',
    WEBGL2_COMPAT: context.backend === 'webgl2',
    PER_INSTANCE_REGION: false,
    SKINNING_DISABLED: context.geometry !== 'skinned',
    POINT_SHADOW_AVAILABLE: false,
    MATERIAL_VALIDATION_ENABLED: context.instrumentation === 'validation',
  });
}
