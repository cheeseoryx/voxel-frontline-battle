import {
  type MaterialRenderProjection as AssetMaterialRenderProjection,
  projectMaterialRecord,
} from '@forgeax/engine-assets-runtime';
import {
  type CookedMaterialRecord,
  materialLayerPlanIdentity,
} from '@forgeax/engine-pack/material-cook';
import type { StandardLayerPlan } from '@forgeax/engine-types';
import { projectStandardLayerPlan } from './standard-layer-projection.js';

export type { MaterialRenderPassProjection } from '@forgeax/engine-assets-runtime';
export interface MaterialRenderProjection extends AssetMaterialRenderProjection {
  readonly layerPlan: StandardLayerPlan;
}

export function assembleMaterialProjection(record: CookedMaterialRecord): MaterialRenderProjection {
  const layerPlan = projectStandardLayerPlan(record.resolved.parameters, record.resolved.passes);
  const expectedLayerPlanIdentity = materialLayerPlanIdentity(record);
  if (
    expectedLayerPlanIdentity !== undefined &&
    record.receipt.derivedInterface.layerPlanIdentity !== expectedLayerPlanIdentity
  ) {
    throw new Error(
      `Standard material layer-plan identity mismatch: expected ${expectedLayerPlanIdentity}, got ${record.receipt.derivedInterface.layerPlanIdentity ?? 'missing'}`,
    );
  }
  return {
    ...projectMaterialRecord(record),
    layerPlan,
  };
}
