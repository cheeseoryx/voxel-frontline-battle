import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MOTION_BLUR_PARAMS,
  motionBlurTemporalDemand,
  validateMotionBlurParams,
} from '../motion-blur-params';

describe('Motion Blur parameter validation', () => {
  it('applies the bounded defaults', () => {
    expect(validateMotionBlurParams({})).toEqual({ ok: true, value: DEFAULT_MOTION_BLUR_PARAMS });
    expect(DEFAULT_MOTION_BLUR_PARAMS).toEqual({
      shutterAngle: 180,
      maxRadiusPixels: 32,
      sampleCount: 8,
    });
  });

  it.each([
    [{ shutterAngle: 0 }, 'identity shutter'],
    [{ shutterAngle: 360, maxRadiusPixels: 0, sampleCount: 4 }, 'lower and upper bounds'],
    [{ shutterAngle: 12, maxRadiusPixels: 64, sampleCount: 16 }, 'valid upper bounds'],
  ] as const)('accepts %s (%s)', (input, _label) => {
    const result = validateMotionBlurParams(input);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['shutterAngle', -0.01],
    ['shutterAngle', 360.01],
    ['maxRadiusPixels', -0.01],
    ['maxRadiusPixels', 64.01],
    ['sampleCount', 3],
    ['sampleCount', 17],
    ['sampleCount', 8.5],
  ] as const)('returns structured failure for %s=%s', (field, value) => {
    const result = validateMotionBlurParams({ [field]: value });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('motion-blur-invalid-params');
      expect(result.error.detail.field).toBe(field);
      expect(result.error.expected).toContain(field);
      expect(result.error.hint).toContain(field);
    }
  });

  it('does no temporal work when omitted or shutter is zero', () => {
    expect(motionBlurTemporalDemand(undefined)).toBe(false);
    expect(motionBlurTemporalDemand({ shutterAngle: 0, maxRadiusPixels: 32, sampleCount: 8 })).toBe(
      false,
    );
    expect(motionBlurTemporalDemand(DEFAULT_MOTION_BLUR_PARAMS)).toBe(true);
  });
});
