import type { Buffer, Sampler, TextureView } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { assembleMaterialWithSkylightEntries } from '../ibl/skylight-bind-group.js';
import { Materials } from '../materials.js';

describe('Materials.standard clearcoat public contract', () => {
  it('declares clearcoat only when the physical root is authored', () => {
    const base = Materials.standard({ baseColor: [1, 1, 1, 1] });
    const zero = Materials.standard({ baseColor: [1, 1, 1, 1], clearcoat: 0 });
    expect(base.parameters?.map((parameter) => parameter.name)).not.toContain('clearcoat');
    expect(zero.parameters?.map((parameter) => parameter.name)).toContain('clearcoat');
    expect(zero.passes?.map((pass) => pass.name)).toEqual(['forward', 'shadow-caster']);
  });

  it('uses the R, G, and RG channel matrix without a guessed UV set', () => {
    const options = {
      baseColor: [1, 1, 1, 1] as const,
      clearcoat: 0.5,
      clearcoatRoughness: 0.25,
      clearcoatTexture: 1,
      clearcoatRoughnessTexture: 2,
      clearcoatNormalTexture: 3,
      clearcoatNormalScale: 0.75,
    } as Parameters<typeof Materials.standard>[0] & Record<string, unknown>;
    const material = Materials.standard(options);
    expect(material.values).toMatchObject(options);
    expect(material.values).not.toHaveProperty('clearcoatTexCoord');
  });

  it('keeps scalar clearcoat identity without charging unauthored map slots', () => {
    const scalar = Materials.standard({
      baseColor: [1, 1, 1, 1],
      clearcoat: 0,
      clearcoatRoughness: 0.5,
      clearcoatNormalScale: 1,
    });
    const names = scalar.parameters?.map((parameter) => parameter.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(['clearcoat', 'clearcoatRoughness']));
    expect(names).not.toEqual(
      expect.arrayContaining([
        'clearcoatTexture',
        'clearcoatRoughnessTexture',
        'clearcoatNormalTexture',
      ]),
    );
  });

  it('declares each clearcoat map slot only when its root value is authored', () => {
    const material = Materials.standard({
      baseColor: [1, 1, 1, 1],
      clearcoat: 1,
      clearcoatTexture: 1,
      clearcoatNormalTexture: 2,
    });
    const names = material.parameters?.map((parameter) => parameter.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(['clearcoatTexture', 'clearcoatNormalTexture']));
    expect(names).not.toContain('clearcoatRoughnessTexture');
  });

  it('keeps physical scalar fields before texture coordinate records', () => {
    const material = Materials.standard({
      baseColor: [1, 1, 1, 1],
      clearcoat: 0.5,
      clearcoatRoughness: 0.25,
      clearcoatTexture: 1,
    });
    const names = material.parameters?.map((parameter) => parameter.name) ?? [];
    expect(names.indexOf('clearcoat')).toBeLessThan(names.indexOf('baseColorTexture'));
    expect(names.indexOf('clearcoatRoughness')).toBeLessThan(names.indexOf('baseColorTexture'));
  });

  it('keeps authored clearcoat map pairs contiguous after the material ABI', () => {
    const sampler = {} as Sampler;
    const view = {} as TextureView;
    const entries = Array.from({ length: 17 }, (_, binding) => ({
      binding,
      resource:
        binding === 0
          ? { kind: 'buffer' as const, value: { buffer: {} as Buffer } }
          : binding % 2 === 1
            ? { kind: 'sampler' as const, value: sampler }
            : { kind: 'textureView' as const, value: view },
    }));
    const merged = assembleMaterialWithSkylightEntries(
      entries,
      {
        irradianceView: view,
        irradianceSampler: sampler,
        prefilterView: view,
        prefilterSampler: sampler,
        brdfLutView: view,
        brdfLutSampler: sampler,
        intensityBuffer: {} as Buffer,
      },
      undefined,
      [
        { slot: 0, sampler, view },
        { slot: 1, sampler, view },
        { slot: 2, sampler, view },
      ],
    );
    expect(merged.slice(-6).map((entry) => entry.binding)).toEqual([26, 27, 28, 29, 30, 31]);
  });
});
