import { describe, expect, it } from 'vitest';
import { resolveVolumeTemporalReset, type VolumeTemporalSignature } from '../volume/temporal';

const signature: VolumeTemporalSignature = {
  cameraRevision: 4,
  fogRevision: 2,
  lightRevision: 7,
  densityGeneration: 3,
  width: 1280,
  height: 720,
};

describe('volumetric fog temporal contract', () => {
  it('keeps history for a stable signature and TAA-independent volume temporal', () => {
    expect(resolveVolumeTemporalReset(signature, signature)).toEqual({ reset: false });
    expect(resolveVolumeTemporalReset(signature, signature, { taaEnabled: false })).toEqual({
      reset: false,
    });
  });

  it.each([
    ['camera-cut', { ...signature, cameraRevision: 5 }],
    ['fog-revision', { ...signature, fogRevision: 3 }],
    ['light-revision', { ...signature, lightRevision: 8 }],
    ['density-generation', { ...signature, densityGeneration: 4 }],
    ['resize', { ...signature, width: 640, height: 360 }],
  ] as const)('resets history for %s', (reason, next) => {
    expect(resolveVolumeTemporalReset(signature, next)).toEqual({ reset: true, reason });
  });

  it('rejects out-of-screen reprojection and depth discontinuity without NaN', () => {
    expect(
      resolveVolumeTemporalReset(signature, signature, { reprojection: 'out-of-screen' }),
    ).toEqual({
      reset: true,
      reason: 'reprojection-out-of-screen',
    });
    expect(
      resolveVolumeTemporalReset(signature, signature, { reprojection: 'depth-discontinuity' }),
    ).toEqual({
      reset: true,
      reason: 'reprojection-depth-discontinuity',
    });
  });
});
