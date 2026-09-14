import { describe, expect, it } from 'vitest';
import { SCENE_DATA_TEMPORAL_V1_SCHEMA } from '../../../temporal/scene-data';
import { createSceneDataCatalog } from '../../../temporal/scene-data-catalog';
import { freezeRenderFeaturePlan } from '../../plan';
import { planMotionBlur } from '../motion-blur-feature';
import { DEFAULT_MOTION_BLUR_PARAMS } from '../motion-blur-params';

const caps = {
  rgba16floatRenderable: true,
  compute: true,
  storageBuffer: true,
} as never;

describe('Motion Blur feature plan', () => {
  it('declares one projected fullscreen draw with semantic reads', () => {
    const catalog = createSceneDataCatalog({
      featureIdentity: 'forgeax.motion-blur',
      generation: 4,
      planIdentity: 'forgeax.motion-blur:4',
      rgba16floatRenderable: true,
    });
    const planned = planMotionBlur(DEFAULT_MOTION_BLUR_PARAMS, {
      caps,
      frame: { frameNumber: 7 },
      generation: 4,
      targets: [
        { name: 'motion-input', kind: 'color', format: 'rgba16float', sampleCount: 1 },
        { name: 'motion-output', kind: 'color', format: 'rgba16float', sampleCount: 1 },
      ],
      sceneData: catalog,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const frozen = freezeRenderFeaturePlan('forgeax.motion-blur', planned.value, [
      { name: 'motion-input', kind: 'color', format: 'rgba16float', sampleCount: 1 },
      { name: 'motion-output', kind: 'color', format: 'rgba16float', sampleCount: 1 },
    ]);
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    const bindings = frozen.value.resources.find(
      (resource) => resource.kind === 'graphics-bindings',
    );
    expect(bindings?.kind).toBe('graphics-bindings');
    const program = frozen.value.resources.find(
      (resource) => resource.kind === 'fullscreen-program',
    );
    expect(program?.kind).toBe('fullscreen-program');
    if (program?.kind === 'fullscreen-program') {
      expect(program.reads).toEqual(['scene-color', 'scene-temporal']);
      expect(program.reads).not.toContainEqual({ key: 'scene-depth', sampleType: 'depth' });
    }
    if (bindings?.kind === 'graphics-bindings') {
      expect(bindings.values).not.toHaveProperty('depth');
      expect(bindings.logicalTargets).toEqual({ input: 'motion-input' });
    }
    expect(frozen.value.passes).toHaveLength(1);
    const pass = frozen.value.passes[0];
    expect(pass?.kind).toBe('raster');
    if (pass?.kind !== 'raster') return;
    expect(pass.draws[0]?.vertexLayout).toBe('none');
    expect(pass.sampledTargets).toEqual(
      expect.arrayContaining(['motion-input', catalog.require(SCENE_DATA_TEMPORAL_V1_SCHEMA)]),
    );
    expect(pass.sampledTargets).not.toContain('motion-depth');
    expect(catalog.schema).toBe(SCENE_DATA_TEMPORAL_V1_SCHEMA);
  });
});
