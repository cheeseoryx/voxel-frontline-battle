import { describe, expect, it } from 'vitest';
import type { MaterialParameter } from '../asset.js';
import { deriveStandardLayerPlan } from '../standard-layer-plan.js';

const baseParameters: readonly MaterialParameter[] = [
  { name: 'baseColor', type: 'color' },
  { name: 'metallic', type: 'f32' },
  { name: 'roughness', type: 'f32' },
];

describe('Standard layer plan contract', () => {
  it('derives base-only without reading values', () => {
    const plan = deriveStandardLayerPlan(baseParameters);
    expect(plan.mode).toBe('base-only');
    expect(plan.layers).toEqual([]);
    expect(plan.passFamily).toEqual(['forward', 'deferred', 'shadow']);
  });

  it('keeps a declared zero-factor layer present', () => {
    const plan = deriveStandardLayerPlan([
      ...baseParameters,
      { name: 'clearcoat', type: 'f32', default: 0 },
      { name: 'clearcoatRoughness', type: 'f32', default: 0 },
    ]);
    expect(plan.mode).toBe('physical');
    expect(plan.layers).toEqual([
      { name: 'clearcoat', parameters: ['clearcoat', 'clearcoatRoughness'] },
    ]);
    expect(plan.passFamily).toEqual(['forward', 'shadow']);
  });

  it('uses one canonical order for multiple declared layers', () => {
    const plan = deriveStandardLayerPlan([
      ...baseParameters,
      { name: 'sheenColor', type: 'vec3' },
      { name: 'sheenRoughness', type: 'f32' },
      { name: 'clearcoat', type: 'f32' },
      { name: 'clearcoatRoughness', type: 'f32' },
    ]);
    expect(plan.layers.map((layer) => layer.name)).toEqual(['sheen', 'clearcoat']);
  });
});
