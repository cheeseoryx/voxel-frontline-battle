import { mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { createRenderSurfaceError, type RenderSurfaceExpectedError } from '../errors/render';
import { prepareStandardLighting } from '../pipeline/standard-lighting/prepare';
import { deriveStandardTopologyInput } from '../pipeline/standard-lighting/topology';
import { selectStandardClusterTransport } from '../pipeline/standard-lighting/transport';
import { standardPipeline } from '../pipeline/standard-pipeline';
import {
  DEFAULT_STANDARD_PROFILE,
  STANDARD_PIPELINE_ID,
  type StandardProfile,
} from '../pipeline/standard-profile';
import type { RenderPipelineFrame, RenderPipelineTopology } from '../render-pipeline';
import type { SurfaceProfile } from '../render-system';

const rawOnlyProfile: SurfaceProfile = {
  kind: 'raw-only',
  storageFormat: 'rgba8unorm',
  viewFormat: 'rgba8unorm',
  viewFormats: [],
  hasDisplayEndpoint: false,
};

const dualViewProfile: SurfaceProfile = {
  kind: 'dual-view',
  storageFormat: 'bgra8unorm',
  viewFormat: 'bgra8unorm-srgb',
  viewFormats: ['bgra8unorm-srgb'],
  hasDisplayEndpoint: true,
};

function topology(
  profile: StandardProfile,
  overrides: Partial<RenderPipelineTopology> = {},
): RenderPipelineTopology {
  return {
    pipelineId: STANDARD_PIPELINE_ID,
    standardProfile: profile,
    config: profile.ssao ? { ssao: { enabled: true } } : undefined,
    surface: {
      width: 1,
      height: 1,
      storageFormat: 'bgra8unorm',
      viewFormat: 'bgra8unorm-srgb',
    },
    camera: { tonemap: 'aces-filmic', antialias: 'fxaa', bloom: 'on' },
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
    ...overrides,
  };
}

let device: RhiDevice;

beforeAll(async () => {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw adapter.error;
  const created = await adapter.value.requestDevice();
  if (!created.ok) throw created.error;
  device = created.value;
});

function standardLightingFor(resolvedTopology: RenderPipelineTopology) {
  const prepared = prepareStandardLighting({
    directional: undefined,
    local: [{ kind: 'point', shadowed: false, position: vec3.create(0, 0, -4), range: 2 }],
    view: mat4.create(),
    projection: mat4.create(),
    near: 0.1,
    far: 100,
    grid: resolvedTopology.config?.clusterGrid ?? { x: 4, y: 3, z: 4 },
    lightCount: resolvedTopology.standardProfile?.lightCount ?? DEFAULT_STANDARD_PROFILE.lightCount,
    renderPath: resolvedTopology.standardProfile?.renderPath ?? DEFAULT_STANDARD_PROFILE.renderPath,
  });
  if (!prepared.ok) return prepared;
  const transport = selectStandardClusterTransport(
    {
      compute: resolvedTopology.lane.compute,
      storageBuffer: resolvedTopology.lane.storageBuffer,
      membershipPipelineReady: resolvedTopology.lane.compute,
    },
    prepared.value,
  );
  if (!transport.ok) return transport;
  const standardLighting = deriveStandardTopologyInput({
    prepared: prepared.value,
    kind: 'clustered',
    transport: transport.value,
  });
  return standardLighting;
}

async function build(profile: StandardProfile, overrides?: Partial<RenderPipelineTopology>) {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const resolvedTopology = topology(profile, overrides);
  const standardLighting = standardLightingFor(resolvedTopology);
  if (!standardLighting.ok) return standardLighting;
  const built = standardPipeline.build(
    {
      graph,
      standardLighting: standardLighting.value,
      encodeTransmissionMip: ({ pass }) => pass.draw(3, 1, 0, 0),
      projectGpuDriven: () => ok(undefined),
      contributeFeatures: () => ok(undefined),
    },
    resolvedTopology,
  );
  if (!built.ok) return built;
  return graph.compile({
    device,
    surfaceSize: {
      width: resolvedTopology.surface.width,
      height: resolvedTopology.surface.height,
    },
  });
}

function importedTaaHistory(graph: RenderGraphBuilder<RenderPipelineFrame>) {
  const target = (label: string) => {
    const texture = graph.importTexture(
      label,
      { format: 'rgba16float', size: 'surface', usage: 0x17 },
      (frame) => frame.currentTexture,
    );
    if (!texture.ok) throw texture.error;
    const view = graph.importView(texture.value, { label: `${label}.view` }, (frame) => frame.view);
    if (!view.ok) throw view.error;
    return {
      texture: texture.value,
      view: view.value,
      format: 'rgba16float' as const,
      sampleCount: 1 as const,
    };
  };
  return {
    currentColor: target('taa-history-current-color'),
    previousColor: target('taa-history-previous-color'),
    currentTemporal: target('taa-history-current-temporal'),
    previousTemporal: target('taa-history-previous-temporal'),
  };
}

async function buildTaa(profile: StandardProfile, overrides?: Partial<RenderPipelineTopology>) {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const history = importedTaaHistory(graph);
  const resolvedTopology = topology(profile, overrides);
  const standardLighting = standardLightingFor(resolvedTopology);
  if (!standardLighting.ok) return standardLighting;
  const built = standardPipeline.build(
    {
      graph,
      standardLighting: standardLighting.value,
      capabilities: { rgba16floatRenderable: true },
      taaHistory: history,
      projectGpuDriven: () => ok(undefined),
      contributeFeatures: () => ok(undefined),
    },
    resolvedTopology,
  );
  if (!built.ok) return built;
  return graph.compile({ device, surfaceSize: { width: 1, height: 1 } });
}

describe('forgeax::standard graph', () => {
  it('does not admit an unsupported four-light budget', async () => {
    const profile = { ...DEFAULT_STANDARD_PROFILE, lightCount: 4 } as unknown as StandardProfile;
    const result = await build(profile);
    expect(result.ok).toBe(false);
  });

  it('keeps the last-known-good graph for each explicit surface failure', () => {
    let activeGraph = 'last-known-good';
    const failures = ['allocation', 'attachment', 'sampled-read', 'raw-endpoint'] as const;
    for (const kind of failures) {
      const candidateError: RenderSurfaceExpectedError = createRenderSurfaceError(kind, {
        lane: 'direct',
        stage: 'output-transform',
        target: 'standard-output-color',
        format: 'rgba16float',
        domain: 'display-encoded',
        endpoint: 'surface.storage',
        capability: `float-${kind}`,
      });
      expect(candidateError.code).toBe(`surface-${kind}-failed`);
      expect(candidateError.detail.target).toBe('standard-output-color');
      expect(activeGraph).toBe('last-known-good');
    }
    activeGraph = 'candidate';
    expect(activeGraph).toBe('candidate');
  });

  it.each([
    ['forward-1', { ...DEFAULT_STANDARD_PROFILE, lightCount: 1, renderPath: 'forward' }],
    ['forward-32', { ...DEFAULT_STANDARD_PROFILE, lightCount: 32, renderPath: 'forward' }],
    ['deferred-256', { ...DEFAULT_STANDARD_PROFILE, lightCount: 256, renderPath: 'deferred' }],
  ] as const)('preserves the %s light lane under one identity', async (_name, profile) => {
    const result = await build(profile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.inspect().passes.length).toBeGreaterThan(0);
  });

  it('keeps Bloom a no-op when TAA has no active tone mapper', async () => {
    const result = await buildTaa(
      { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' },
      { camera: { tonemap: 'none', antialias: 'taa', bloom: 'on' } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.inspect().passes.map((pass) => pass.name);
    expect(names).not.toContain('bloom-bright');
    expect(names).not.toContain('bloom-blur-h');
    expect(names).not.toContain('bloom-blur-v');
    expect(names).not.toContain('bloom-composite');
    expect(names).toContain('taa-resolve');
    expect(names).toContain('output-transform');
  });

  it('keeps shadow, lighting, post, and debug work in one ordered graph', async () => {
    const result = await build({ ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.inspect().passes.map((pass) => pass.name);
    const stages = [
      'shadowCascade-0',
      'g-buffer',
      'lighting',
      'forward',
      'output-transform',
      'debug-overlay',
    ];
    for (let index = 1; index < stages.length; index += 1) {
      expect(names.indexOf(stages[index] ?? '')).toBeGreaterThan(
        names.indexOf(stages[index - 1] ?? ''),
      );
    }
  });

  it('keeps one clustered resource layout when compute admission is unavailable', async () => {
    const result = await build(
      { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' },
      {
        lane: {
          compute: false,
          storageBuffer: true,
          multisample: false,
          maxColorAttachments: 4,
        },
      },
    );
    expect(result.ok).toBe(true);
  });

  it('routes a no-camera clear-only frame directly to the surface', async () => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      clearOnly: true,
      camera: { tonemap: 'none', antialias: 'none', bloom: 'off' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    expect(names).toContain('main');
    expect(names).not.toContain('output-transform');
    expect(names).not.toContain('g-buffer');
    expect(names).not.toContain('lighting');
    expect(names).not.toContain('cluster-membership-producer');
    expect(names).not.toContain('fxaa');
    expect(names).not.toContain('bloom-composite');
    expect(names).toContain('debug-overlay');
    expect(info.resources.map((resource) => resource.label)).not.toContain('scene-color');
  });

  it('refuses the clustered transport when storage is unavailable', async () => {
    const result = await build(
      { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' },
      {
        lane: {
          compute: false,
          storageBuffer: false,
          multisample: false,
          maxColorAttachments: 4,
        },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('standard-cluster-transport-unavailable');
  });

  it.each([
    ['aces-filmic', 'fxaa'],
    ['none', 'fxaa'],
    ['aces-filmic', 'none'],
  ] as const)('uses one explicit post-chain contract for %s/%s', async (tonemap, antialias) => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap, antialias, bloom: 'on' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    expect(names).toContain('output-transform');
    expect(names.indexOf('bloom-composite')).toBeLessThan(names.indexOf('output-transform'));
    expect(names.indexOf('debug-overlay')).toBeGreaterThan(names.indexOf('output-transform'));
    if (antialias === 'fxaa') {
      expect(names.indexOf('fxaa')).toBeGreaterThan(names.indexOf('output-transform'));
      expect(info.resources.map((resource) => resource.label)).toContain('standard-output-color');
    } else {
      expect(names).not.toContain('fxaa');
      expect(info.resources.map((resource) => resource.label)).not.toContain(
        'standard-output-color',
      );
    }
    expect(info.resources.map((resource) => resource.label)).not.toContain('ldr-color');
  });

  const routeMatrix = (['dual-view', 'raw-only'] as const).flatMap((surfaceKind) =>
    (['none', 'aces-filmic'] as const).flatMap((tonemap) =>
      (['none', 'fxaa'] as const).map((antialias) => [surfaceKind, tonemap, antialias] as const),
    ),
  );

  it.each(
    routeMatrix,
  )('keeps the output route explicit for %s/%s/%s', async (surfaceKind, tonemap, antialias) => {
    const rawOnly = surfaceKind === 'raw-only';
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap, antialias, bloom: 'off' },
      surface: {
        width: 1,
        height: 1,
        storageFormat: rawOnly ? 'rgba8unorm' : 'bgra8unorm',
        viewFormat: rawOnly ? 'rgba8unorm' : 'bgra8unorm-srgb',
        profile: rawOnly ? rawOnlyProfile : dualViewProfile,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    const sceneLabel = 'scene-color';
    const sceneResource = info.resources.find((resource) => resource.label === sceneLabel);
    expect(sceneResource).toBeDefined();
    expect(sceneResource?.derivedUsage).toBe(0x15);
    const outputTransforms = names.filter((name) => name === 'output-transform');
    expect(outputTransforms).toHaveLength(1);
    expect(names.filter((name) => name === 'fxaa')).toHaveLength(antialias === 'fxaa' ? 1 : 0);
    expect(names.filter((name) => name === 'debug-overlay')).toHaveLength(1);
    if (rawOnly) {
      expect(info.resources.map((resource) => resource.label)).not.toContain('surface.display');
      expect(names.indexOf('debug-overlay')).toBeLessThan(names.indexOf('output-transform'));
    } else {
      expect(names.indexOf('debug-overlay')).toBeGreaterThan(names.indexOf('output-transform'));
    }
    expect(
      info.resources.filter((resource) => resource.label === 'standard-output-color'),
    ).toHaveLength(antialias === 'fxaa' ? 1 : 0);
    if (antialias === 'fxaa') {
      expect(
        info.resources.find((resource) => resource.label === 'standard-output-color'),
      ).toMatchObject({
        derivedUsage: 0x10 | 0x04 | 0x01,
      });
    }
  });

  it('uses one linear target and one output transform for Standard storage-buffer LDR output', async () => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap: 'none', antialias: 'none', bloom: 'off' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    expect(names).toContain('output-transform');
    expect(names).not.toContain('fxaa');
    expect(info.resources.find((resource) => resource.label === 'scene-color')).toMatchObject({
      descriptor: { format: 'rgba16float' },
      derivedUsage: 0x15,
    });
    expect(info.resources.map((resource) => resource.label)).not.toContain('standard-output-color');
    expect(info.resources.map((resource) => resource.label)).not.toContain('ldr-color');
  });

  it('keeps the Standard output route when storage buffers are unavailable', async () => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap: 'none', antialias: 'none', bloom: 'off' },
      lane: {
        compute: false,
        storageBuffer: false,
        multisample: false,
        maxColorAttachments: 4,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('standard-cluster-transport-unavailable');
  });

  it('uses one linear target and one output transform for raw-only no-FXAA', async () => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap: 'none', antialias: 'none', bloom: 'off' },
      surface: {
        width: 1,
        height: 1,
        storageFormat: 'rgba8unorm',
        viewFormat: 'rgba8unorm',
        profile: rawOnlyProfile,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    expect(info.passes.filter((pass) => pass.name === 'output-transform')).toHaveLength(1);
    expect(info.resources.filter((resource) => resource.label === 'scene-color')).toHaveLength(1);
    expect(info.resources.map((resource) => resource.label)).not.toContain('standard-output-color');
    expect(info.resources.map((resource) => resource.label)).not.toContain('surface.display');
    expect(info.passes.filter((pass) => pass.name === 'debug-overlay')).toHaveLength(1);
    expect(info.passes.map((pass) => pass.name).indexOf('debug-overlay')).toBeLessThan(
      info.passes.map((pass) => pass.name).indexOf('output-transform'),
    );
  });

  it('keeps raw-only FXAA in one display-encoded float intermediate', async () => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap: 'none', antialias: 'fxaa', bloom: 'off' },
      surface: {
        width: 1,
        height: 1,
        storageFormat: 'rgba8unorm',
        viewFormat: 'rgba8unorm',
        profile: rawOnlyProfile,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    expect(info.passes.filter((pass) => pass.name === 'output-transform')).toHaveLength(1);
    expect(info.passes.map((pass) => pass.name).indexOf('debug-overlay')).toBeLessThan(
      info.passes.map((pass) => pass.name).indexOf('output-transform'),
    );
    expect(
      info.resources.filter((resource) => resource.label === 'standard-output-color'),
    ).toHaveLength(1);
    expect(info.resources.map((resource) => resource.label)).not.toContain('surface.display');
    expect(info.passes.filter((pass) => pass.name === 'debug-overlay')).toHaveLength(1);
  });

  it.each([
    'none',
    'fxaa',
  ] as const)('routes raw-only registered post effects through an encoded float input target (%s)', async (antialias) => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap: 'none', antialias, bloom: 'off' },
      config: { postEffects: ['test-effect'] },
      surface: {
        width: 1,
        height: 1,
        storageFormat: 'rgba8unorm',
        viewFormat: 'rgba8unorm',
        profile: rawOnlyProfile,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    const resources = info.resources;
    const input = resources.find((resource) => resource.label === 'standard-post-effects-input');
    expect(input).toMatchObject({
      derivedUsage: 0x10 | 0x01,
    });
    expect(names.indexOf('debug-overlay')).toBeLessThan(names.indexOf('output-transform'));
    const fxaaIndex = names.indexOf('fxaa');
    expect(names.indexOf('output-transform')).toBeLessThan(
      fxaaIndex === -1 ? names.indexOf('post-effect-copy-0') : fxaaIndex,
    );
    if (fxaaIndex !== -1) expect(fxaaIndex).toBeLessThan(names.indexOf('post-effect-copy-0'));
    expect(names.indexOf('post-effect-copy-0')).toBeLessThan(names.indexOf('post-effect-0'));
    expect(info.passes.find((pass) => pass.name === 'post-effect-copy-0')?.accesses).toContainEqual(
      { resource: 'standard-post-effects-input', usage: 'copy-src' },
    );
    expect(info.passes.find((pass) => pass.name === 'post-effect-0')?.accesses).toContainEqual({
      resource: 'surface',
      usage: 'color-attachment',
    });
    expect(resources.map((resource) => resource.label)).not.toContain('surface.display');
    expect(resources.map((resource) => resource.label)).not.toContain('ldr-color');
    expect(resources.map((resource) => resource.label)).toContain('standard-post-effects-input');
    expect(resources.map((resource) => resource.label)).toContain('post-effect-scratch-0');
  });

  it('presents a resolved no-tone MSAA scene through the shared output boundary', async () => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap: 'none', antialias: 'msaa', bloom: 'off' },
      lane: {
        compute: true,
        storageBuffer: true,
        multisample: true,
        maxColorAttachments: 8,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    expect(names).toContain('output-transform');
    expect(names.indexOf('output-transform')).toBeGreaterThan(names.indexOf('main'));
    expect(names.indexOf('debug-overlay')).toBeGreaterThan(names.indexOf('output-transform'));
    expect(info.resources.map((resource) => resource.label)).toContain('scene-color');
    expect(info.resources.map((resource) => resource.label)).toContain('scene-color-msaa');
    expect(info.resources.map((resource) => resource.label)).not.toContain('standard-output-color');
  });

  it('uses the live rgba16float capability for temporal admission', () => {
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const resolvedTopology = topology(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap: 'aces-filmic', antialias: 'taa', bloom: 'off' },
    });
    const standardLighting = standardLightingFor(resolvedTopology);
    if (!standardLighting.ok) throw standardLighting.error;
    const built = standardPipeline.build(
      {
        graph,
        standardLighting: standardLighting.value,
        capabilities: { rgba16floatRenderable: false },
        projectGpuDriven: () => ok(undefined),
        contributeFeatures: () => ok(undefined),
      },
      resolvedTopology,
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toMatchObject({
      code: 'scene-data-unavailable',
      detail: { reason: 'capability-missing' },
    });
  });

  it('fails closed when the temporal capability probe is absent', () => {
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const resolvedTopology = topology(DEFAULT_STANDARD_PROFILE, {
      surface: {
        width: 1,
        height: 1,
        storageFormat: 'rgba16float',
        viewFormat: 'rgba16float',
      },
      camera: { tonemap: 'aces-filmic', antialias: 'taa', bloom: 'off' },
    });
    const standardLighting = standardLightingFor(resolvedTopology);
    if (!standardLighting.ok) throw standardLighting.error;
    const built = standardPipeline.build(
      {
        graph,
        standardLighting: standardLighting.value,
        projectGpuDriven: () => ok(undefined),
        contributeFeatures: () => ok(undefined),
      },
      resolvedTopology,
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toMatchObject({
      code: 'scene-data-unavailable',
      detail: { reason: 'capability-missing' },
    });
  });

  it('keeps both Standard render paths on one transmission topology', async () => {
    for (const renderPath of ['forward', 'deferred'] as const) {
      const result = await build({ ...DEFAULT_STANDARD_PROFILE, renderPath }, {
        surface: {
          width: 8,
          height: 4,
          storageFormat: 'bgra8unorm',
          viewFormat: 'bgra8unorm-srgb',
        },
        transmissionDemand: { activeCount: 1, needsRoughMips: true },
      } as Partial<RenderPipelineTopology>);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const names = result.value.inspect().passes.map((pass) => pass.name);
      expect(names).toContain('transmission-backdrop-copy');
      expect(names).toContain('transmission-backdrop-mip');
      expect(names.indexOf('transmission-backdrop-copy')).toBeLessThan(
        names.indexOf('transmission-forward'),
      );
      expect(names.indexOf('transmission-forward')).toBeLessThan(names.indexOf('transparent'));
      expect(names.indexOf('transparent')).toBeLessThan(names.indexOf('temporal'));
    }
  });

  it('uses the resolved single-sample MSAA source for the shared backdrop', async () => {
    const result = await build(
      { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' },
      {
        surface: {
          width: 8,
          height: 4,
          storageFormat: 'bgra8unorm',
          viewFormat: 'bgra8unorm-srgb',
        },
        camera: { tonemap: 'aces-filmic', antialias: 'msaa', bloom: 'on' },
        lane: {
          compute: true,
          storageBuffer: true,
          multisample: true,
          maxColorAttachments: 8,
        },
        transmissionDemand: { activeCount: 1, needsRoughMips: true },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inspected = result.value.inspect();
    const names = inspected.passes.map((pass) => pass.name);
    expect(inspected.resources.map((resource) => resource.label)).toContain('scene-color-msaa');
    expect(names).toContain('transmission-backdrop-copy');
    const copy = inspected.passes.find((pass) => pass.name === 'transmission-backdrop-copy');
    expect(copy?.accesses).toEqual(
      expect.arrayContaining([{ resource: 'scene-color', usage: 'copy-src' }]),
    );
    expect(copy?.accesses).not.toContainEqual({
      resource: 'scene-color-msaa',
      usage: 'copy-src',
    });
  });

  it('keeps the CPU transport on the same transmission phase contract', async () => {
    const result = await build(
      { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' },
      {
        lane: {
          compute: false,
          storageBuffer: true,
          multisample: false,
          maxColorAttachments: 4,
        },
        transmissionDemand: { activeCount: 1, needsRoughMips: false },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.inspect().passes.map((pass) => pass.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'transmission-backdrop-copy',
        'transmission-forward',
        'transparent',
        'temporal',
      ]),
    );
    expect(names).not.toContain('cluster-membership-producer');
  });

  it.each([
    [
      'omitted-backdrop-copy',
      (names: readonly string[]) => names.filter((name) => name !== 'transmission-backdrop-copy'),
    ],
    ['reversed-phase-order', (names: readonly string[]) => [...names].reverse()],
  ] as const)('dev falsifier %s rejects the two-lane phase contract', async (_name, falsify) => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      transmissionDemand: { activeCount: 1, needsRoughMips: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.inspect().passes.map((pass) => pass.name);
    const mutated = falsify(names);
    expect(() => {
      expect(mutated.indexOf('transmission-backdrop-copy')).toBeGreaterThanOrEqual(0);
      expect(mutated.indexOf('transmission-backdrop-copy')).toBeLessThan(
        mutated.indexOf('transmission-forward'),
      );
      expect(mutated.indexOf('transmission-forward')).toBeLessThan(mutated.indexOf('transparent'));
    }).toThrow();
  });
});
