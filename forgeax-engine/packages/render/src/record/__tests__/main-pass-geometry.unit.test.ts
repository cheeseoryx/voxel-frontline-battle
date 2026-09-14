import { describe, expect, it } from 'vitest';
import {
  geometryRenderStateForPass,
  requestsStandardTransmissionVariant,
} from '../main-pass-geometry';

describe('geometry pass render state', () => {
  it('keeps the main depth authority while admitting equal temporal depth', () => {
    const base = {
      cullMode: 'back' as const,
      depthCompare: 'less' as const,
      depthWriteEnabled: true,
    };

    expect(geometryRenderStateForPass(base, 'temporal')).toMatchObject({
      cullMode: 'back',
      depthCompare: 'less-equal',
      depthWriteEnabled: false,
    });
  });

  it('does not rewrite the base state for colour passes', () => {
    const base = {
      cullMode: 'none' as const,
      depthCompare: 'less-equal' as const,
      depthWriteEnabled: false,
    };

    expect(geometryRenderStateForPass(base, 'forward')).toBe(base);
  });

  it.each([
    ['far then near', [0.8, 0.2]],
    ['near then far', [0.2, 0.8]],
  ] as const)('keeps the near fragment visible for %s temporal overlap', (_order, depths) => {
    const state = geometryRenderStateForPass(
      { cullMode: 'back', depthCompare: 'less', depthWriteEnabled: true },
      'temporal',
    );
    if (state === undefined) throw new Error('temporal render state is required');
    const visibleDepth = 0.2;
    const accepted = depths.filter((depth) => {
      if (state.depthCompare === 'less-equal') return depth <= visibleDepth;
      return depth < visibleDepth;
    });

    expect(state.depthWriteEnabled).toBe(false);
    expect(accepted).toEqual([visibleDepth]);
  });
});

describe('Standard transmission variant selection', () => {
  it('uses authored transmission presence instead of the canonical reserved schema', () => {
    const baseOnly = {
      materialShaderId: 'forgeax::default-standard-pbr',
      paramSnapshot: { alphaCutoff: 0.25 },
    } as const;
    const transmission = {
      materialShaderId: 'forgeax::default-standard-pbr',
      paramSnapshot: { transmission: 0 },
    } as const;

    expect(requestsStandardTransmissionVariant(baseOnly)).toBe(false);
    expect(requestsStandardTransmissionVariant(transmission)).toBe(true);
    expect(
      requestsStandardTransmissionVariant({
        materialShaderId: 'custom::standard',
        paramSnapshot: { transmission: 1 },
      }),
    ).toBe(false);
  });
});
