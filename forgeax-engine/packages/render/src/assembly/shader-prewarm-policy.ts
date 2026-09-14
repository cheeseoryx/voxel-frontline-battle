import type { Result, RhiError, ShaderModule } from '@forgeax/engine-rhi';
import { findVariantByKey, type MaterialShaderManifestEntry } from '@forgeax/engine-shader';

/** Minimum sampled-texture limit needed by Standard transmission variants. */
export const STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES = 17;

/** Select HDRP variants that must be seeded during ready-state construction. */
export function selectHdrpPbrPrewarmVariants(
  manifestEntry: MaterialShaderManifestEntry | undefined,
  storageBufferCapable: boolean,
  extendedLightingShaderAvailableOrTransmissionCapable = true,
  transmissionCapable = true,
  directionalPcssAvailable = true,
  projectorAvailable: boolean = true,
): readonly MaterialShaderManifestEntry['variants'][number][] {
  const variants = manifestEntry?.variants ?? [];
  const hasExtendedLightingAxis = variants.some(
    (variant) => 'EXTENDED_LIGHTING_AVAILABLE' in variant.defines,
  );
  const extendedLightingShaderAvailable = hasExtendedLightingAxis
    ? extendedLightingShaderAvailableOrTransmissionCapable
    : true;
  const effectiveTransmissionCapable = hasExtendedLightingAxis
    ? transmissionCapable
    : extendedLightingShaderAvailableOrTransmissionCapable;
  if (!storageBufferCapable) return [];
  return (
    variants.filter(
      (variant) =>
        variant.defines.STORAGE_BUFFER_AVAILABLE === storageBufferCapable &&
        (!('EXTENDED_LIGHTING_AVAILABLE' in variant.defines) ||
          variant.defines.EXTENDED_LIGHTING_AVAILABLE === extendedLightingShaderAvailable) &&
        variant.defines.CLUSTER_FORWARD_AVAILABLE === true &&
        (!('DIRECTIONAL_PCSS_AVAILABLE' in variant.defines) ||
          variant.defines.DIRECTIONAL_PCSS_AVAILABLE === directionalPcssAvailable) &&
        (!('PROJECTOR_AVAILABLE' in variant.defines) ||
          variant.defines.PROJECTOR_AVAILABLE === projectorAvailable) &&
        variant.defines.PROBE_BLEND_AVAILABLE !== true &&
        (effectiveTransmissionCapable || variant.defines.TRANSMISSION_AVAILABLE !== true),
    ) ?? []
  );
}

/** Return every active-capability pbr-skin variant used by URP and HDRP draws. */
export function selectSkinPrewarmVariants(
  manifestEntry: MaterialShaderManifestEntry | undefined,
  storageBufferCapable: boolean,
): readonly MaterialShaderManifestEntry['variants'][number][] {
  return (
    manifestEntry?.variants.filter(
      (variant) =>
        variant.defines.STORAGE_BUFFER_AVAILABLE === storageBufferCapable &&
        (storageBufferCapable || variant.defines.CLUSTER_FORWARD_AVAILABLE !== true) &&
        variant.defines.PROBE_BLEND_AVAILABLE !== true,
    ) ?? []
  );
}

/** Select probe-enabled material modules for recovery candidate prewarming. */
export function selectProbePrewarmVariants(
  manifestEntry: MaterialShaderManifestEntry | undefined,
  storageBufferCapable: boolean,
  extendedLightingShaderAvailable = true,
  transmissionCapable = true,
  directionalPcssAvailable = true,
  projectorAvailable: boolean = true,
  webgl2Downlevel = false,
): readonly MaterialShaderManifestEntry['variants'][number][] {
  if (!storageBufferCapable) return [];
  return (
    manifestEntry?.variants.filter((variant) => {
      const defines = variant.defines;
      return (
        defines.PROBE_BLEND_AVAILABLE === true &&
        defines.STORAGE_BUFFER_AVAILABLE === storageBufferCapable &&
        (!('WEBGL2_COMPAT' in defines) || defines.WEBGL2_COMPAT === webgl2Downlevel) &&
        (!('EXTENDED_LIGHTING_AVAILABLE' in defines) ||
          defines.EXTENDED_LIGHTING_AVAILABLE === extendedLightingShaderAvailable) &&
        (!('DIRECTIONAL_PCSS_AVAILABLE' in defines) ||
          defines.DIRECTIONAL_PCSS_AVAILABLE === directionalPcssAvailable) &&
        (!('PROJECTOR_AVAILABLE' in defines) ||
          defines.PROJECTOR_AVAILABLE === projectorAvailable) &&
        (transmissionCapable || defines.TRANSMISSION_AVAILABLE !== true)
      );
    }) ?? []
  );
}

/** Compile and seed a selected material-shader variant set without duplicate modules. */
export async function prewarmMaterialShaderVariants(
  variants: readonly MaterialShaderManifestEntry['variants'][number][],
  prewarmedModules: Map<string, ShaderModule>,
  compile: (
    variant: MaterialShaderManifestEntry['variants'][number],
    moduleLabel: string,
  ) => Promise<Result<ShaderModule, RhiError>>,
  seed: (moduleLabel: string, module: ShaderModule) => void,
): Promise<void> {
  for (const variant of variants) {
    const moduleLabel = `module-forgeax::default-standard-pbr#${variant.definesKey}`;
    let module = prewarmedModules.get(variant.composedWgsl);
    if (module === undefined) {
      const result = await compile(variant, moduleLabel);
      if (!result.ok) throw result.error;
      module = result.value;
      prewarmedModules.set(variant.composedWgsl, module);
    }
    seed(moduleLabel, module);
  }
}

/** Select the declared Standard URP transmission variants for exact prewarm. */
export function selectStandardPbrTransmissionPrewarmVariants(
  manifestEntry: MaterialShaderManifestEntry | undefined,
  storageBufferCapable: boolean,
  directionalPcssAvailable = true,
  projectorAvailable: boolean = true,
  extendedLightingShaderAvailable = true,
): readonly MaterialShaderManifestEntry['variants'][number][] {
  if (manifestEntry === undefined) {
    throw new Error('Standard material shader manifest row is missing');
  }
  const selected: MaterialShaderManifestEntry['variants'][number][] = [];
  for (const transmissionAvailable of [false, true]) {
    const declared = manifestEntry.variants.find(
      (variant) =>
        variant.defines.STORAGE_BUFFER_AVAILABLE === storageBufferCapable &&
        variant.defines.CLUSTER_FORWARD_AVAILABLE === standardBootClusterAxis() &&
        variant.defines.VERTEX_COLOR_AVAILABLE === false &&
        (!('DIRECTIONAL_PCSS_AVAILABLE' in variant.defines) ||
          variant.defines.DIRECTIONAL_PCSS_AVAILABLE === directionalPcssAvailable) &&
        (!('PROJECTOR_AVAILABLE' in variant.defines) ||
          variant.defines.PROJECTOR_AVAILABLE === projectorAvailable) &&
        (!('EXTENDED_LIGHTING_AVAILABLE' in variant.defines) ||
          variant.defines.EXTENDED_LIGHTING_AVAILABLE === extendedLightingShaderAvailable) &&
        variant.defines.PROBE_BLEND_AVAILABLE !== true &&
        variant.defines.TRANSMISSION_AVAILABLE === transmissionAvailable,
    );
    if (declared === undefined) {
      throw new Error(
        `Standard material shader manifest lacks exact TRANSMISSION_AVAILABLE=${transmissionAvailable} prewarm variant`,
      );
    }
    const exact = findVariantByKey(manifestEntry, declared.definesKey);
    if (exact === undefined) {
      throw new Error(
        `Standard material shader manifest exact lookup failed for TRANSMISSION_AVAILABLE=${transmissionAvailable}`,
      );
    }
    selected.push(exact);
  }
  return selected;
}

function standardBootClusterAxis(): boolean {
  return false;
}
