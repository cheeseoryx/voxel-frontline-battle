import { ok, type ShaderModule } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { findVariantByKey, ShaderRegistry, type ShaderRegistryDevice } from '../index.js';

type EngineShaderManifest = Awaited<
  ReturnType<typeof import('@forgeax/engine-vite-plugin-shader').buildEngineShaderManifest>
>;

function dataUrl(payload: unknown): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(payload))}`;
}

function device(): ShaderRegistryDevice {
  return {
    createShaderModule(): ReturnType<ShaderRegistryDevice['createShaderModule']> {
      return ok({} as ShaderModule);
    },
  };
}

async function engineManifest(): Promise<EngineShaderManifest> {
  engineManifestPromise ??= import('@forgeax/engine-vite-plugin-shader').then(
    ({ buildEngineShaderManifest }) => buildEngineShaderManifest(),
  );
  return engineManifestPromise;
}

let engineManifestPromise: Promise<EngineShaderManifest> | undefined;

describe('default Standard PBR transmission manifest contract', () => {
  it('publishes every supported capability combination including transmission', {
    timeout: 60_000,
  }, async () => {
    const manifest = await engineManifest();
    const standard = manifest.materialShaders.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );

    expect(standard).toBeDefined();
    if (standard === undefined) return;
    // Nine declared axes produce 512 combinations. The compiler publishes
    // the supported subset: storage is required by cluster/probe/extended
    // lighting, and extended lighting also requires the projector lane.
    expect(standard.variants).toHaveLength(224);
    expect(new Set(standard.variants.map((variant) => variant.definesKey)).size).toBe(224);
    expect(new Set(standard.variants.map((variant) => variant.composedWgsl)).size).toBe(224);
    expect(
      standard.variants.every(
        (variant) =>
          !(
            variant.defines.CLUSTER_FORWARD_AVAILABLE === true &&
            variant.defines.STORAGE_BUFFER_AVAILABLE === false
          ) &&
          !(
            variant.defines.PROBE_BLEND_AVAILABLE === true &&
            variant.defines.STORAGE_BUFFER_AVAILABLE === false
          ) &&
          !(
            variant.defines.EXTENDED_LIGHTING_AVAILABLE === true &&
            (variant.defines.STORAGE_BUFFER_AVAILABLE === false ||
              variant.defines.PROJECTOR_AVAILABLE === false)
          ),
      ),
    ).toBe(true);
    expect(standard.variants.every((variant) => 'TRANSMISSION_AVAILABLE' in variant.defines)).toBe(
      true,
    );
  });

  it('omits transmission and physical resources from the non-transmission fallback variant', {
    timeout: 60_000,
  }, async () => {
    const manifest = await engineManifest();
    const standard = manifest.materialShaders.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    expect(standard).toBeDefined();
    if (standard === undefined) return;

    const fallback = standard.variants.find(
      (variant) =>
        variant.defines.CLUSTER_FORWARD_AVAILABLE === false &&
        variant.defines.STORAGE_BUFFER_AVAILABLE === true &&
        variant.defines.EXTENDED_LIGHTING_AVAILABLE === false &&
        variant.defines.PROBE_BLEND_AVAILABLE === false &&
        variant.defines.TRANSMISSION_AVAILABLE === false &&
        variant.defines.VERTEX_COLOR_AVAILABLE === false,
    );
    expect(fallback).toBeDefined();
    if (fallback === undefined) return;
    expect(fallback.composedWgsl).not.toMatch(
      /var(?:<[^>]+>)?\s+(?:transmissionSampler|transmissionTexture|thicknessSampler|thicknessTexture|clearcoatTexture|clearcoatRoughnessTexture|clearcoatNormalTexture|anisotropyTexture|sheenColorTexture|sheenRoughnessTexture|iridescenceTexture|iridescenceThicknessTexture|specularTexture)\b/u,
    );
  });

  it('publishes the same explicit transmission axis for the skin Standard template', {
    timeout: 60_000,
  }, async () => {
    const manifest = await engineManifest();
    const skin = manifest.materialShaders.find((entry) => entry.identifier === 'forgeax::pbr-skin');
    expect(skin).toBeDefined();
    if (skin === undefined) return;
    expect(skin.variants.length).toBeGreaterThan(0);
    expect(skin.variants.every((variant) => 'TRANSMISSION_AVAILABLE' in variant.defines)).toBe(
      true,
    );
    expect(skin.variants.some((variant) => variant.defines.TRANSMISSION_AVAILABLE === false)).toBe(
      true,
    );
    expect(skin.variants.some((variant) => variant.defines.TRANSMISSION_AVAILABLE === true)).toBe(
      true,
    );
  });

  it('registers one Standard row and resolves a declared capability variant by exact key', {
    timeout: 20_000,
  }, async () => {
    const manifest = await engineManifest();
    const standard = manifest.materialShaders.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    expect(standard).toBeDefined();
    if (standard === undefined) return;

    const registry = new ShaderRegistry({
      device: device(),
      manifestUrl: dataUrl({ entries: [], materialShaders: [standard] }),
    });
    const loaded = await registry.loadManifest();
    expect(loaded.ok).toBe(true);
    const rows = Array.from(registry.materialShaderManifestEntries()).filter(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    expect(rows).toHaveLength(1);
    const registered = rows[0];
    expect(registered).toBeDefined();
    if (registered === undefined) return;

    const variant = registered.variants.find(
      (candidate) => candidate.defines.CLUSTER_FORWARD_AVAILABLE === false,
    );
    expect(variant).toBeDefined();
    if (variant === undefined) return;
    expect(findVariantByKey(registered, variant.definesKey)).toBe(variant);
    expect(findVariantByKey(registered, `${variant.definesKey}+UNDECLARED=true`)).toBeUndefined();
  });

  it('rejects duplicate variant keys instead of allowing ambiguous prewarm', async () => {
    const duplicateVariant = {
      identifier: 'forgeax::default-standard-pbr',
      sourcePath: 'default-standard-pbr.wgsl',
      composedWgsl: 'standard-default',
      paramSchema: '[]',
      variants: [
        {
          definesKey: 'CLUSTER_FORWARD_AVAILABLE=false',
          defines: { CLUSTER_FORWARD_AVAILABLE: false },
          composedWgsl: 'standard-a',
        },
        {
          definesKey: 'CLUSTER_FORWARD_AVAILABLE=false',
          defines: { CLUSTER_FORWARD_AVAILABLE: false },
          composedWgsl: 'standard-b',
        },
      ],
    };
    const registry = new ShaderRegistry({
      device: device(),
      manifestUrl: dataUrl({ entries: [], materialShaders: [duplicateVariant] }),
    });

    const loaded = await registry.loadManifest();
    expect(loaded.ok).toBe(false);
  });
});
