import { err, ok, type Result } from '@forgeax/engine-types';
import { type VolumeError, VolumeOwnerConflictError } from '../errors/render';
import {
  type ValidatedVolumetricFog,
  type VolumetricFogAuthoring,
  validateVolumetricFog,
} from './component';

export type VolumetricFogExtract =
  | { readonly status: 'off' }
  | { readonly status: 'available'; readonly fog: ValidatedVolumetricFog };

export function extractVolumetricFog(
  inputs: readonly VolumetricFogAuthoring[],
): Result<VolumetricFogExtract, VolumeError> {
  if (inputs.length === 0) return ok({ status: 'off' });
  if (inputs.length !== 1) return err(new VolumeOwnerConflictError(inputs.length));
  const validated = validateVolumetricFog(inputs[0] as VolumetricFogAuthoring);
  if (!validated.ok) return validated;
  return ok({ status: 'available', fog: validated.value });
}
