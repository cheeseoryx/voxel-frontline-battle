import type { RhiAdapter, RhiDevice } from '@forgeax/engine-rhi';
import { EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES } from '../prepare/extended-lighting/resources';

const COMPRESSION_FEATURES: GPUFeatureName[] = [
  'texture-compression-bc',
  'texture-compression-etc2',
  'texture-compression-astc',
];

// The Standard transmission fragment ABI needs 17 sampled textures across its
// material, IBL, clustered-light, and SSAO bindings. Ordinary Standard draws
// use the non-transmission variant and remain valid on the WebGPU minimum of
// 16. The extended-lighting topology reserves 20, so a device descriptor must
// request that larger limit when the adapter can provide it; adapter limits are
// not automatically inherited by requestDevice().
export const STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES = 17;
/**
 * The complete Standard physical root can declare all optional texture slots.
 * Its material group therefore needs one more sampled-texture entry than the
 * extended-lighting topology alone. Request this ceiling when the adapter can
 * provide it; lower-capability devices remain fail-closed at material
 * pipeline admission instead of receiving an invalid WebGPU layout.
 */
export const STANDARD_PHYSICAL_REQUIRED_SAMPLED_TEXTURES = 21;

export interface DeviceFeatureAdmissionOptions {
  readonly gpuPassTiming?: object | undefined;
  readonly captureGpuTimings?: boolean | undefined;
}

export interface DeviceFeatureAdmission {
  readonly requiredFeatures: GPUFeatureName[];
  readonly requiredLimits?: {
    readonly maxSampledTexturesPerShaderStage: number;
  };
}

type AdapterFeatureProbe = Pick<RhiAdapter, 'features'> & Partial<Pick<RhiAdapter, 'limits'>>;

export function deriveDeviceFeatureAdmission(
  adapter: AdapterFeatureProbe,
  options?: DeviceFeatureAdmissionOptions,
): DeviceFeatureAdmission {
  const requiredFeatures = COMPRESSION_FEATURES.filter((feature) => adapter.features.has(feature));
  const timestampRequested =
    options?.gpuPassTiming !== undefined || options?.captureGpuTimings === true;
  if (timestampRequested && adapter.features.has('timestamp-query')) {
    requiredFeatures.push('timestamp-query');
  }
  const adapterSampledTextureLimit = adapter.limits?.maxSampledTexturesPerShaderStage ?? 0;
  const requiredSampledTextureLimit =
    adapterSampledTextureLimit >= STANDARD_PHYSICAL_REQUIRED_SAMPLED_TEXTURES
      ? STANDARD_PHYSICAL_REQUIRED_SAMPLED_TEXTURES
      : adapterSampledTextureLimit >= EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES
        ? EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES
        : adapterSampledTextureLimit >= STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES
          ? STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES
          : undefined;
  return {
    requiredFeatures,
    ...(requiredSampledTextureLimit === undefined
      ? {}
      : {
          requiredLimits: {
            maxSampledTexturesPerShaderStage: requiredSampledTextureLimit,
          },
        }),
  };
}

export function deviceOptionsForAdapter(
  adapter: AdapterFeatureProbe,
  options?: DeviceFeatureAdmissionOptions,
): DeviceFeatureAdmission | undefined {
  const admission = deriveDeviceFeatureAdmission(adapter, options);
  return admission.requiredFeatures.length === 0 && admission.requiredLimits === undefined
    ? undefined
    : admission;
}

export function isTimestampQueryAdmitted(
  caps: Pick<RhiDevice['caps'], 'timestampQuery' | 'timestampPeriodNanoseconds'>,
): boolean {
  return (
    caps.timestampQuery === true &&
    caps.timestampPeriodNanoseconds !== null &&
    Number.isFinite(caps.timestampPeriodNanoseconds) &&
    caps.timestampPeriodNanoseconds > 0
  );
}
