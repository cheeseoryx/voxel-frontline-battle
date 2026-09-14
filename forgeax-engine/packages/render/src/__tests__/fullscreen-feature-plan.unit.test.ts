import { describe, expect, it } from 'vitest';
import { createFullscreenRenderFeature } from '../features/fullscreen';
import { freezeRenderFeaturePlan } from '../features/plan';
import {
  postProcessShaderEntrySignature,
  postProcessShaderModuleLabel,
  postProcessShaderPipelineLabel,
} from '../fullscreen-post-process-pass';
import { createSceneDataCatalog } from '../temporal/scene-data-catalog';

describe('fullscreen RenderFeature plan', () => {
  it('keeps the cooked effect on the Standard post-stage owner', () => {
    const feature = createFullscreenRenderFeature({
      identity: 'test::fullscreen',
      source: '@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }',
      params: { byteSize: 4, defaultValue: new Uint8Array([1, 0, 0, 0]) },
    });
    const planned = feature.plan(undefined, {
      caps: {} as never,
      frame: { frameNumber: 1 },
      generation: 1,
      targets: [{ name: 'scene-color', kind: 'color', format: 'rgba16float', sampleCount: 1 }],
      sceneData: createSceneDataCatalog({
        featureIdentity: 'test::fullscreen',
        generation: 1,
        planIdentity: 'test::fullscreen:1',
        rgba16floatRenderable: true,
      }),
    });

    expect(feature.requiredFullscreenPostProcesses).toEqual([
      {
        identity: 'test::fullscreen',
        source: '@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }',
      },
    ]);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(
      freezeRenderFeaturePlan(feature.identity, planned.value, [
        { name: 'scene-color', kind: 'color', format: 'rgba16float', sampleCount: 1 },
      ]).ok,
    ).toBe(true);
    expect(planned.value.resources[0]).toMatchObject({
      kind: 'fullscreen-program',
      source: '@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }',
    });
    expect(planned.value.passes).toEqual([]);
  });

  it('treats source, params, and reads as one cached declaration identity', () => {
    const base = {
      source: 'fn fs_main() -> vec4f { return vec4f(1); }',
      params: { byteSize: 16, defaultValue: new Uint8Array(16) },
      reads: ['scene-color'],
    } as const;
    expect(postProcessShaderEntrySignature(base)).not.toBe(
      postProcessShaderEntrySignature({ ...base, source: `${base.source}\n// next` }),
    );
    expect(postProcessShaderEntrySignature(base)).not.toBe(
      postProcessShaderEntrySignature({
        ...base,
        params: { byteSize: 16, defaultValue: new Uint8Array([1, ...new Uint8Array(15)]) },
      }),
    );
    expect(postProcessShaderEntrySignature(base)).not.toBe(
      postProcessShaderEntrySignature({ ...base, reads: ['other-color'] }),
    );
    expect(postProcessShaderModuleLabel('test::fullscreen', base.source)).not.toBe(
      postProcessShaderModuleLabel('test::fullscreen', `${base.source}\n// next`),
    );
    expect(postProcessShaderPipelineLabel('test::fullscreen', base.source)).not.toBe(
      postProcessShaderPipelineLabel('test::fullscreen', `${base.source}\n// next`),
    );
  });
});
