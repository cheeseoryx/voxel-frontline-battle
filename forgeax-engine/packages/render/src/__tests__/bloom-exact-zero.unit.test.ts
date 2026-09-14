import { readFileSync } from 'node:fs';
import { mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { prepareStandardLighting } from '../pipeline/standard-lighting/prepare';
import { deriveStandardTopologyInput } from '../pipeline/standard-lighting/topology';
import { selectStandardClusterTransport } from '../pipeline/standard-lighting/transport';
import { standardPipeline } from '../pipeline/standard-pipeline';
import { inspectStandardBloomGraph, STANDARD_BLOOM_TARGET_SPEC } from '../pipeline/standard-post';
import { DEFAULT_STANDARD_PROFILE, STANDARD_PIPELINE_ID } from '../pipeline/standard-profile';
import type { RenderPipelineFrame, RenderPipelineTopology } from '../render-pipeline';

let device: RhiDevice;

beforeAll(async () => {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw adapter.error;
  const result = await adapter.value.requestDevice();
  if (!result.ok) throw result.error;
  device = result.value;
});

function topology(bloom: 'off' | 'on'): RenderPipelineTopology {
  return {
    pipelineId: STANDARD_PIPELINE_ID,
    standardProfile: DEFAULT_STANDARD_PROFILE,
    config: { ssao: { enabled: false } },
    surface: {
      width: 640,
      height: 360,
      storageFormat: 'bgra8unorm',
      viewFormat: 'bgra8unorm-srgb',
    },
    camera: { tonemap: 'aces-filmic', antialias: 'fxaa', bloom },
    shadow: {
      directional: { mapSize: 64, cascadeCount: 1 },
      spotMapSize: 64,
      pointCount: 0,
      pointFaceSize: 64,
      spotCount: 0,
    },
    lane: {
      compute: true,
      storageBuffer: true,
      multisample: false,
      maxColorAttachments: 8,
    },
    featureTopologySignature: 'none',
    gpuDrivenTopologySignature: '',
  };
}

function clusteredStandardLighting() {
  const prepared = prepareStandardLighting({
    directional: undefined,
    local: [{ kind: 'point' as const, shadowed: false, position: vec3.create(0, 0, -4), range: 2 }],
    view: mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]),
    projection: mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.1, 100),
    near: 0.1,
    far: 100,
    grid: { x: 4, y: 3, z: 4 },
    lightCount: DEFAULT_STANDARD_PROFILE.lightCount,
    renderPath: 'forward',
  });
  if (!prepared.ok) throw prepared.error;
  const transport = selectStandardClusterTransport(
    { compute: true, storageBuffer: true, membershipPipelineReady: true },
    prepared.value,
  );
  if (!transport.ok) throw transport.error;
  const lighting = deriveStandardTopologyInput({
    kind: 'clustered',
    prepared: prepared.value,
    transport: transport.value,
  });
  if (!lighting.ok) throw lighting.error;
  return lighting.value;
}

function inspect(bloom: 'off' | 'on') {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const built = standardPipeline.build(
    {
      graph,
      standardLighting: clusteredStandardLighting(),
      projectGpuDriven: () => ok(undefined),
      contributeFeatures: () => ok(undefined),
    },
    topology(bloom),
  );
  if (!built.ok) throw built.error;
  const compiled = graph.compile({ device, surfaceSize: { width: 640, height: 360 } });
  if (!compiled.ok) throw compiled.error;
  return compiled.value.inspect();
}

describe('Standard Bloom exact-zero topology', () => {
  it('Bloom off declares no Bloom targets or passes', () => {
    const info = inspect('off');
    const bloomPasses = info.passes.filter((pass) => pass.name.startsWith('bloom-'));
    const bloomResources = info.resources.filter((resource) => resource.label.startsWith('bloom-'));
    expect(bloomPasses).toHaveLength(0);
    expect(bloomResources).toHaveLength(0);
    expect(inspectStandardBloomGraph(info)).toEqual({
      status: 'empty',
      targetCount: 0,
      targetBytes: 0,
      passCount: 0,
    });
    expect({
      targetCount: bloomResources.length,
      passCount: bloomPasses.length,
      encodeCount: bloomPasses.length,
      bindGroupCount: bloomPasses.length,
      uploadCount: bloomPasses.length,
      residentBytes: bloomResources.length,
    }).toEqual({
      targetCount: 0,
      passCount: 0,
      encodeCount: 0,
      bindGroupCount: 0,
      uploadCount: 0,
      residentBytes: 0,
    });
  });

  it('keeps Bloom declaration behind the camera gate in both lane owners', () => {
    const forwardSource = readFileSync(
      new URL('../pipeline/standard-forward-lane.ts', import.meta.url),
      'utf8',
    );
    const clusteredSource = readFileSync(
      new URL('../pipeline/standard-pipeline.ts', import.meta.url),
      'utf8',
    );
    const postSource = readFileSync(
      new URL('../pipeline/standard-post.ts', import.meta.url),
      'utf8',
    );
    expect(forwardSource).toContain('addStandardPost');
    expect(clusteredSource).toContain('addStandardPost');
    const gate = postSource.indexOf("topology.camera.bloom === 'on'");
    const declaration = postSource.indexOf('STANDARD_BLOOM_TARGET_SPEC.composited');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(declaration).toBeGreaterThan(gate);
  });

  it('keeps one shared Bloom chain when enabled', () => {
    {
      const info = inspect('on');
      expect(inspectStandardBloomGraph(info)).toEqual({
        status: 'valid',
        targetCount: 4,
        targetBytes: (640 * 360 + 3 * 320 * 180) * 8,
        passCount: 4,
      });
      expect(info.resources.find((resource) => resource.label === 'bloom-bright')).toMatchObject({
        descriptor: {
          kind: 'texture',
          format: 'rgba16float',
          size: STANDARD_BLOOM_TARGET_SPEC.bright.size,
          width: 320,
          height: 180,
          depthOrArrayLayers: 1,
          mipLevelCount: 1,
          sampleCount: 1,
        },
      });
      expect(
        info.passes.map((pass) => pass.name).filter((name) => name.startsWith('bloom-')),
      ).toEqual(['bloom-bright', 'bloom-blur-h', 'bloom-blur-v', 'bloom-composite']);
    }
  });

  it('fails closed when a canonical Bloom descriptor drifts', () => {
    const info = inspect('on');
    const drifted = {
      ...info,
      resources: info.resources.map((resource) =>
        resource.label === STANDARD_BLOOM_TARGET_SPEC.bright.label
          ? {
              ...resource,
              descriptor:
                resource.descriptor.kind === 'texture'
                  ? { ...resource.descriptor, format: 'rgba8unorm' as const }
                  : resource.descriptor,
            }
          : resource,
      ),
    };
    expect(inspectStandardBloomGraph(drifted)).toEqual({
      status: 'invalid',
      targetCount: 0,
      targetBytes: 0,
      passCount: 0,
    });
  });

  it('rejects a graph with a missing canonical Bloom target', () => {
    const info = inspect('on');
    const drifted = {
      ...info,
      resources: info.resources.filter(
        (resource) => resource.label !== STANDARD_BLOOM_TARGET_SPEC.bright.label,
      ),
    };
    expect(inspectStandardBloomGraph(drifted)).toEqual({
      status: 'invalid',
      targetCount: 0,
      targetBytes: 0,
      passCount: 0,
    });
  });

  it('rejects a graph with a missing canonical Bloom pass', () => {
    const info = inspect('on');
    const drifted = {
      ...info,
      passes: info.passes.filter((pass) => pass.name !== 'bloom-blur-h'),
    };
    expect(inspectStandardBloomGraph(drifted)).toEqual({
      status: 'invalid',
      targetCount: 0,
      targetBytes: 0,
      passCount: 0,
    });
  });
});
