import type { Buffer, Sampler, TextureView } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { assembleMaterialWithSkylightEntries } from '../../ibl/skylight-bind-group';
import { defaultViewForUserRegionField } from '../main-pass-material';
import { buildSpritePassBaseMaterialEntries } from '../main-pass-sprite-draws';
import type { PipelineState } from '../render-context';

describe('sprite Standard material ABI', () => {
  it('uses the dedicated neutral anisotropy fallback instead of white', () => {
    const white = {} as TextureView;
    const anisotropy = {} as TextureView;
    const pipelineState = {
      defaultWhiteTextureView: white,
      defaultAnisotropyTextureView: anisotropy,
      defaultNormalTextureView: {} as TextureView,
      fallbackTextureView: {} as TextureView,
    } as PipelineState;

    expect(defaultViewForUserRegionField('anisotropyTexture', pipelineState)).toBe(anisotropy);
    expect(defaultViewForUserRegionField('baseColorTexture', pipelineState)).toBe(
      pipelineState.fallbackTextureView,
    );
  });

  it('covers transmission and thickness before IBL injection', () => {
    const sampler = {} as Sampler;
    const white = {} as TextureView;
    const pipelineState = {
      materialUniformBuffer: { buffer: {} },
      nearestSampler: sampler,
      defaultSampler: sampler,
      defaultWhiteTextureView: white,
      defaultNormalTextureView: {} as TextureView,
      fallbackTextureView: {} as TextureView,
    } as PipelineState;
    const spriteTexture = {} as TextureView;

    const entries = buildSpritePassBaseMaterialEntries(pipelineState, spriteTexture);

    expect(entries.map((entry) => entry.binding)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect(entries[13]).toMatchObject({ binding: 13, resource: { kind: 'sampler' } });
    expect(entries[14]).toMatchObject({ binding: 14, resource: { kind: 'textureView' } });
    expect(entries[2]?.resource).toMatchObject({ kind: 'textureView', value: spriteTexture });
    expect(entries).toHaveLength(15);

    const merged = assembleMaterialWithSkylightEntries(entries, {
      irradianceView: {} as TextureView,
      irradianceSampler: sampler,
      prefilterView: {} as TextureView,
      prefilterSampler: sampler,
      brdfLutView: {} as TextureView,
      brdfLutSampler: sampler,
      intensityBuffer: {} as Buffer,
    });
    expect(merged[15]).toMatchObject({
      binding: 15,
      resource: { kind: 'textureView' },
    });
    expect(merged[22]).toMatchObject({
      binding: 22,
      resource: { kind: 'sampler', value: sampler },
    });
    expect(merged[23]).toMatchObject({
      binding: 23,
      resource: { kind: 'textureView' },
    });
    expect(merged).toHaveLength(24);

    const backdrop = {} as TextureView;
    const active = assembleMaterialWithSkylightEntries(
      entries,
      {
        irradianceView: {} as TextureView,
        irradianceSampler: sampler,
        prefilterView: {} as TextureView,
        prefilterSampler: sampler,
        brdfLutView: {} as TextureView,
        brdfLutSampler: sampler,
        intensityBuffer: {} as Buffer,
      },
      { sampler, backdropView: backdrop },
    );
    expect(active[23]).toMatchObject({
      binding: 23,
      resource: { kind: 'textureView', value: backdrop },
    });
  });
});
