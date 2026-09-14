import type { Result, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import type { ShaderCatalog } from '@forgeax/engine-shader';

import { invokeDeviceCreateShaderModule } from './material-shader-policy';
import { runShimStep } from './renderer-helpers';

type AsyncCreateShaderModule = (
  device: RhiDevice,
  desc: { code: string; label?: string | undefined },
) => Promise<Result<ShaderModule, RhiError>>;

/**
 * Prewarm producer-declared material shaders and all published capability
 * variants before the first prepared frame. Variant labels mirror the lazy
 * material pipeline adapter's module lookup contract.
 */
export async function prewarmRequiredMaterialShaders({
  rhiDevice,
  registry,
  asyncCreateShaderModule,
  requiredMaterialShaders,
  seedShaderModule,
}: {
  readonly rhiDevice: RhiDevice;
  readonly registry: ShaderCatalog;
  readonly asyncCreateShaderModule: AsyncCreateShaderModule | undefined;
  readonly requiredMaterialShaders: readonly string[];
  readonly seedShaderModule: (label: string, module: ShaderModule) => void;
}): Promise<void> {
  for (const materialShaderId of requiredMaterialShaders) {
    const lookup = registry.findMaterialArtifact(materialShaderId);
    if (!lookup.ok) {
      throw new RhiError({
        code: 'shader-compile-failed',
        expected: `declared render feature material shader '${materialShaderId}' is present in the loaded manifest`,
        hint: `add material shader '${materialShaderId}' to the shader manifest or remove it from the feature declaration`,
      });
    }
    const label = `module-${materialShaderId}`;
    const shaderResult = await runShimStep(
      () =>
        asyncCreateShaderModule
          ? asyncCreateShaderModule(rhiDevice, { code: lookup.value.source, label })
          : invokeDeviceCreateShaderModule(rhiDevice, { code: lookup.value.source, label }),
      'shader-compile-failed',
      `declared render feature material shader '${materialShaderId}' compiled`,
      `inspect the composed WGSL for '${materialShaderId}' and check device.features`,
    );
    if (!shaderResult.ok) throw shaderResult.error;
    seedShaderModule(label, shaderResult.value);

    const prewarmedSources = new Map<string, ShaderModule>([
      [lookup.value.source, shaderResult.value],
    ]);
    const manifestEntry = [...registry.materialShaderManifestEntries()].find(
      (candidate) => candidate.identifier === materialShaderId,
    );
    if (manifestEntry === undefined) continue;

    for (const variant of manifestEntry.variants) {
      const variantLabel = `module-${materialShaderId}#${variant.definesKey}`;
      if (variantLabel === label) continue;
      let variantModule = prewarmedSources.get(variant.composedWgsl);
      if (variantModule === undefined) {
        const variantResult = await runShimStep(
          () =>
            asyncCreateShaderModule
              ? asyncCreateShaderModule(rhiDevice, {
                  code: variant.composedWgsl,
                  label: variantLabel,
                })
              : invokeDeviceCreateShaderModule(rhiDevice, {
                  code: variant.composedWgsl,
                  label: variantLabel,
                }),
          'shader-compile-failed',
          `declared render feature material shader variant '${variantLabel}' compiled`,
          `inspect the composed WGSL for '${materialShaderId}' variant '${variant.definesKey}' and check device.features`,
        );
        if (!variantResult.ok) throw variantResult.error;
        variantModule = variantResult.value;
        prewarmedSources.set(variant.composedWgsl, variantModule);
      }
      seedShaderModule(variantLabel, variantModule);
    }
  }
}
