import type { RhiAdapter, RhiDevice } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import {
  deriveDeviceFeatureAdmission,
  isTimestampQueryAdmitted,
} from '../assembly/device-feature-admission.js';

function adapter(
  features: string[],
  limits?: Readonly<Record<string, number>>,
): Pick<RhiAdapter, 'features'> & Partial<Pick<RhiAdapter, 'limits'>> {
  return {
    features: new Set(features) as RhiAdapter['features'],
    ...(limits === undefined ? {} : { limits }),
  };
}

function deviceCaps(
  timestampQuery: boolean,
  timestampPeriodNanoseconds: number | null,
): Pick<RhiDevice['caps'], 'timestampQuery' | 'timestampPeriodNanoseconds'> {
  return { timestampQuery, timestampPeriodNanoseconds };
}

describe('shared device feature admission', () => {
  it('keeps timestamp-query out of the disabled and unsupported descriptors', () => {
    const supported = adapter(['timestamp-query', 'texture-compression-bc']);
    const disabled = deriveDeviceFeatureAdmission(supported);
    const unsupported = deriveDeviceFeatureAdmission(adapter(['texture-compression-bc']), {
      gpuPassTiming: {},
    });

    expect(disabled.requiredFeatures).toEqual(['texture-compression-bc']);
    expect(unsupported.requiredFeatures).toEqual(['texture-compression-bc']);
  });

  it('adds only adapter-supported timestamp-query once for either timing producer', () => {
    const result = deriveDeviceFeatureAdmission(adapter(['timestamp-query']), {
      gpuPassTiming: {},
    });

    expect(result.requiredFeatures).toEqual(['timestamp-query']);
  });

  it('requests the largest supported sampled-texture topology for the device', () => {
    expect(
      deriveDeviceFeatureAdmission(adapter([], { maxSampledTexturesPerShaderStage: 48 })),
    ).toEqual({
      requiredFeatures: [],
      requiredLimits: { maxSampledTexturesPerShaderStage: 21 },
    });
    expect(
      deriveDeviceFeatureAdmission(adapter([], { maxSampledTexturesPerShaderStage: 20 })),
    ).toEqual({
      requiredFeatures: [],
      requiredLimits: { maxSampledTexturesPerShaderStage: 20 },
    });
    expect(
      deriveDeviceFeatureAdmission(adapter([], { maxSampledTexturesPerShaderStage: 17 })),
    ).toEqual({
      requiredFeatures: [],
      requiredLimits: { maxSampledTexturesPerShaderStage: 17 },
    });
    expect(
      deriveDeviceFeatureAdmission(adapter([], { maxSampledTexturesPerShaderStage: 18 })),
    ).toEqual({
      requiredFeatures: [],
      requiredLimits: { maxSampledTexturesPerShaderStage: 17 },
    });
    expect(
      deriveDeviceFeatureAdmission(adapter([], { maxSampledTexturesPerShaderStage: 16 })),
    ).toEqual({ requiredFeatures: [] });
  });

  it('requires both device capability and a finite positive period before admission', () => {
    expect(isTimestampQueryAdmitted(deviceCaps(true, 1))).toBe(true);
    expect(isTimestampQueryAdmitted(deviceCaps(false, 1))).toBe(false);
    expect(isTimestampQueryAdmitted(deviceCaps(true, null))).toBe(false);
    expect(isTimestampQueryAdmitted(deviceCaps(true, Number.NaN))).toBe(false);
    expect(isTimestampQueryAdmitted(deviceCaps(true, 0))).toBe(false);
  });

  it('derives byte-identical initial and recovery request descriptors', () => {
    const supported = adapter(['texture-compression-etc2', 'timestamp-query']);
    const options = { gpuPassTiming: {} };

    expect(deriveDeviceFeatureAdmission(supported, options)).toEqual(
      deriveDeviceFeatureAdmission(supported, options),
    );
  });
});
