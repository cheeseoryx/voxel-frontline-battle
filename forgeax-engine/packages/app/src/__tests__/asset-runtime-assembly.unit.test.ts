import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import type { Loader } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

import { createAssetRuntimeAssembly } from '../assets-runtime-assembly';

describe('AssetRegistry app assembly', () => {
  it('reuses the supplied Registry, installs explicit decoders, and disposes the lease', () => {
    const registry = new AssetRegistry({} as never);
    const decoder = {
      kind: 'app-test-decoder',
      load: () => ({ kind: 'app-test-asset' }),
    } as Loader<unknown>;
    const result = createAssetRuntimeAssembly(registry, {
      registry,
      catalogSource: createCatalogSource({ entries: [] }),
      decoderContributions: [decoder],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.registry).toBe(registry);
    expect(registry.packIndexUrl).toBe('/pack-index.json');
    expect(registry.loaders.get(decoder.kind)).toBe(decoder);

    result.value.dispose();
    result.value.dispose();
    expect(registry.loaders.get(decoder.kind)).toBeUndefined();
    expect(registry.catalogSnapshot()).toBeUndefined();
  });

  it('returns a closed assembly error instead of creating a second Registry owner', () => {
    const rendererRegistry = new AssetRegistry({} as never);
    const injectedRegistry = new AssetRegistry({} as never);
    const result = createAssetRuntimeAssembly(rendererRegistry, { registry: injectedRegistry });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'asset-assembly-failed',
        detail: expect.objectContaining({ kind: 'registry' }),
      }),
    });
  });
});
