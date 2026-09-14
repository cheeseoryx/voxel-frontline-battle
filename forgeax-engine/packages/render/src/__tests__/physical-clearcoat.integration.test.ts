import { STANDARD_PIPELINE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { Materials } from '../materials.js';
import {
  buildBindGroupLayoutDescriptor,
  materialBindGroupLayoutIdentity,
} from '../pbr-pipeline.js';

describe('Standard clearcoat root contract', () => {
  it('keeps a declared factor-zero clearcoat physical and forward-only', () => {
    const material = Materials.standard({ baseColor: [1, 1, 1, 1], clearcoat: 0 });
    expect(material.passes?.map((pass) => pass.name)).toEqual(['forward', 'shadow-caster']);
    expect(material.parameters?.map((parameter) => parameter.name)).toContain('clearcoat');
    expect(material.values).toMatchObject({ clearcoat: 0 });
  });

  it('retains a single root identity when coat maps are present', () => {
    const options = {
      baseColor: [1, 1, 1, 1] as const,
      clearcoat: 0.8,
      clearcoatRoughness: 0.2,
      clearcoatTexture: 11,
      clearcoatRoughnessTexture: 12,
      clearcoatNormalTexture: 13,
      clearcoatNormalScale: 0.5,
    } as Parameters<typeof Materials.standard>[0] & Record<string, unknown>;
    const material = Materials.standard(options);
    expect(material.values).toMatchObject({
      clearcoat: 0.8,
      clearcoatRoughness: 0.2,
      clearcoatTexture: 11,
      clearcoatRoughnessTexture: 12,
      clearcoatNormalTexture: 13,
      clearcoatNormalScale: 0.5,
    });
  });

  it('keys equivalent schema instances by the same merged layout identity', () => {
    const withTexture = (name: string) => [
      ...STANDARD_PIPELINE_PARAM_SCHEMA,
      { name, type: 'texture2d' as const },
    ];
    const rigidR = withTexture('clearcoatTexture');
    const rigidRClone = [...rigidR];
    const rigidG = withTexture('clearcoatRoughnessTexture');
    const rigidRg = [...rigidR, { name: 'clearcoatNormalTexture', type: 'texture2d' as const }];

    expect(materialBindGroupLayoutIdentity('forgeax::default-standard-pbr', rigidR)).toBe(
      materialBindGroupLayoutIdentity('forgeax::default-standard-pbr', rigidRClone),
    );
    expect(materialBindGroupLayoutIdentity('forgeax::default-standard-pbr', rigidR)).not.toBe(
      materialBindGroupLayoutIdentity('forgeax::default-standard-pbr', rigidG),
    );
    expect(materialBindGroupLayoutIdentity('forgeax::default-standard-pbr', rigidR)).not.toBe(
      materialBindGroupLayoutIdentity('forgeax::default-standard-pbr', rigidRg),
    );
  });

  it('keeps the built-in Standard IBL ABI stable when physical maps are appended', () => {
    const schema = [
      ...STANDARD_PIPELINE_PARAM_SCHEMA,
      { name: 'clearcoatTexture', type: 'texture2d' as const },
      { name: 'clearcoatNormalTexture', type: 'texture2d' as const },
    ];
    const descriptor = buildBindGroupLayoutDescriptor(
      {
        shader: { id: 'forgeax::default-standard-pbr', passKind: 'forward', variantSet: undefined },
        attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
        geometry: { topology: 'triangle-list', vertexLayout: {} },
        renderState: undefined,
      },
      { kind: 'pbr-material-merged', materialParamSchema: schema },
    );

    // The canonical seven texture pairs occupy bindings 1..14. IBL remains
    // at 15..21 and transmission at 22..23; authored physical maps append at
    // 24..27. Compacting the authored root here shifts WGSL IBL bindings and
    // causes Dawn to reject the pipeline before any pixels are submitted.
    expect(descriptor.entries).toHaveLength(28);
    expect(descriptor.entries.slice(0, 15).map((entry) => entry.binding)).toEqual(
      Array.from({ length: 15 }, (_, binding) => binding),
    );
    expect(descriptor.entries[15]?.texture).toMatchObject({ viewDimension: 'cube' });
    expect(descriptor.entries[17]?.texture).toMatchObject({ viewDimension: 'cube' });
    expect(descriptor.entries[22]?.sampler).toMatchObject({ type: 'filtering' });
    expect(descriptor.entries[23]?.texture).toMatchObject({ viewDimension: '2d' });
    expect(descriptor.entries.slice(24).map((entry) => entry.binding)).toEqual([24, 25, 26, 27]);
  });
});
