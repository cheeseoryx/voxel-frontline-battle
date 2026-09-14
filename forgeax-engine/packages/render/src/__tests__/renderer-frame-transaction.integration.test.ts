import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type RhiCommandEncoder, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { executeRendererFrameTransaction } from '../assembly/renderer-frame-transaction';
import { DeviceScope } from '../device/device-scope';
import { selectEnvironment } from '../environment/frame';
import { EnvironmentLifecycle } from '../environment/lifecycle';
import { RhiErrorListenerRegistry } from '../lifecycle';
import type { RenderFrameState } from '../record/frame-snapshot';
import { executeCompiledFrameGraph } from '../record/typed-frame-graph';
import { createRenderPipelineTarget, type RenderPipelineFrame } from '../render-pipeline';
import {
  commitTemporalGpuSubmit,
  getTemporalBindGroupResources,
  getTemporalGpuState,
  getTemporalParamsBuffer,
  stageTemporalGpuSubmit,
} from '../temporal/gpu';
import { createTemporalView } from '../temporal/view';
import { addTypedTemporalResolvePass } from '../typed-render-graph-primitives';

type Stage = 'build' | 'execute' | 'finish' | 'submit';

type TemporalResolveFailure = 'params' | 'bind-group' | 'pipeline';

function selectedEnvironment(sourceKey?: string) {
  return selectEnvironment({
    environments:
      sourceKey === undefined ? [] : [{ kind: 'image' as const, entityKey: 1, sourceKey }],
    fogs: [],
    suns: [],
    lane: 'direct',
  }).unwrap();
}

function temporalResolveFrame(
  device: RhiDevice,
  scope: DeviceScope,
  frameState: RenderFrameState,
  pipeline: object | null,
): RenderPipelineFrame {
  return {
    encoder: device.createCommandEncoder({ label: 'taa-resolve-transaction' }).unwrap(),
    pipelineState: { format: 'rgba16float', colorAttachmentFormat: 'rgba16float' },
    runtime: {
      device,
      deviceScope: scope,
      errorRegistry: { fire: () => undefined },
      getPostProcessPipeline: () => pipeline as never,
    },
    frameState,
    view: undefined as never,
    clear: [0, 0, 0, 1],
    targetW: 8,
    targetH: 8,
    currentTexture: undefined as never,
    camera: {
      position: [0, 0, 2] as never,
      world: new Float32Array(16),
      fov: 1,
      aspect: 1,
      near: 0.1,
      far: 100,
      projection: 'perspective',
      orthoLeft: -1,
      orthoRight: 1,
      orthoBottom: -1,
      orthoTop: 1,
      tonemap: 'none',
      exposure: 1,
      whitePoint: 1,
      antialias: 'taa',
      bloom: 'off',
      bloomThreshold: 1,
      bloomIntensity: 1,
      bloomBlurRadius: 1,
      clearColor: [0, 0, 0, 1],
      temporal: frameState.lastSuccessfulTemporalView,
    },
    postProcessParams: new Map(),
    msaaActive: false,
    geometryColorResolveView: null,
    ldrSpriteColorView: null,
  } as unknown as RenderPipelineFrame;
}

async function buildTemporalResolveGraph(device: RhiDevice) {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const descriptor = (format: 'rgba8unorm' | 'rgba16float') => ({
    format,
    size: { width: 8, height: 8 },
  });
  const targets = {
    scene: createRenderPipelineTarget(graph, 'taa-scene', descriptor('rgba16float')).unwrap(),
    currentTemporal: createRenderPipelineTarget(
      graph,
      'taa-current-temporal',
      descriptor('rgba16float'),
    ).unwrap(),
    depth: createRenderPipelineTarget(graph, 'taa-depth', descriptor('rgba16float')).unwrap(),
    historyColor: createRenderPipelineTarget(
      graph,
      'taa-history-color',
      descriptor('rgba16float'),
    ).unwrap(),
    historyTemporal: createRenderPipelineTarget(
      graph,
      'taa-history-temporal',
      descriptor('rgba16float'),
    ).unwrap(),
    writeColor: createRenderPipelineTarget(
      graph,
      'taa-write-color',
      descriptor('rgba16float'),
    ).unwrap(),
    writeTemporal: createRenderPipelineTarget(
      graph,
      'taa-write-temporal',
      descriptor('rgba16float'),
    ).unwrap(),
  };
  const seed = [
    targets.scene,
    targets.currentTemporal,
    targets.historyColor,
    targets.historyTemporal,
  ];
  expect(
    graph.addRasterPass('taa-seed', {
      accesses: seed.map(({ view }) => ({ resource: view, usage: 'color-attachment' as const })),
      colorAttachments: seed.map(({ view }) => ({
        view,
        loadOp: 'clear' as const,
        storeOp: 'store' as const,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      })),
      encode: ({ pass }) => pass.draw(3, 1, 0, 0),
    }).ok,
  ).toBe(true);
  expect(addTypedTemporalResolvePass(graph, targets).ok).toBe(true);
  return graph.compile({ device, surfaceSize: { width: 8, height: 8 } }).unwrap();
}

describe('renderer successful-submit transaction', () => {
  it.each<Stage>([
    'build',
    'execute',
    'finish',
    'submit',
  ])('aborts atomically at %s', (failureAt) => {
    let submits = 0;
    let commits = 0;
    const before = {
      signature: 'stable',
      revision: 7,
      jitter: 3,
      previous: 'old',
      history: 4,
      frameIndex: 9,
    };
    const result = executeRendererFrameTransaction({
      build: () =>
        failureAt === 'build'
          ? { ok: false, stage: 'build' as const }
          : { ok: true, value: before },
      execute: () =>
        failureAt === 'execute'
          ? { ok: false, stage: 'execute' as const }
          : { ok: true, value: undefined },
      finish: () =>
        failureAt === 'finish'
          ? { ok: false, stage: 'finish' as const }
          : { ok: true, value: undefined },
      submit: () => {
        submits += 1;
        return failureAt === 'submit'
          ? { ok: false, stage: 'submit' as const }
          : { ok: true, value: undefined };
      },
      commit: () => {
        commits += 1;
      },
    });
    expect(result).toEqual({ ok: false, error: { stage: failureAt } });
    expect(submits).toBe(failureAt === 'submit' ? 1 : 0);
    expect(commits).toBe(0);
    expect(before).toEqual({
      signature: 'stable',
      revision: 7,
      jitter: 3,
      previous: 'old',
      history: 4,
      frameIndex: 9,
    });
  });

  it('publishes staged Environment, Fog, and Temporal state only after submit', () => {
    const published: string[] = [];
    const result = executeRendererFrameTransaction({
      build: () => ({ ok: true, value: { environment: 'env:2', fog: 'fog:2', temporal: 'taa:2' } }),
      execute: () => ({ ok: true, value: undefined }),
      finish: () => ({ ok: true, value: undefined }),
      submit: () => ({ ok: true, value: undefined }),
      commit: (candidate) =>
        published.push(`${candidate.environment}/${candidate.fog}/${candidate.temporal}`),
    });
    expect(result.ok).toBe(true);
    expect(published).toEqual(['env:2/fog:2/taa:2']);
  });

  it('rejects a missing temporal write before queue.submit and cleans the candidate', async () => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const scope = DeviceScope.create(91, 'renderer');
    const frameState = {
      temporalGpuState: undefined,
      activeTemporalGpuState: undefined,
      retiringTemporalGpuStates: new Set(),
      pendingTemporalCommit: { kind: 'none' },
      environmentGeneration: undefined,
      environmentLifecycle: undefined,
    } as unknown as RenderFrameState;
    const candidate = getTemporalGpuState(frameState, device, scope, 8, 8);
    getTemporalBindGroupResources(candidate);
    const graphBuilder = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    expect(
      graphBuilder.addCopyPass('temporal-readiness-probe', {
        accesses: [],
        encode: () => undefined,
      }).ok,
    ).toBe(true);
    const compiled = graphBuilder.compile({
      device,
      surfaceSize: { width: 8, height: 8 },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    frameState.compiledFrameGraph = compiled.value;
    const submits = vi.spyOn(device.queue, 'submit');
    const errors = new RhiErrorListenerRegistry();
    const result = executeCompiledFrameGraph(
      { device, errorRegistry: errors } as never,
      frameState,
      {
        encoder: device.createCommandEncoder({ label: 'temporal-readiness-probe' }).unwrap(),
      } as unknown as RenderPipelineFrame,
      device.createCommandEncoder({ label: 'temporal-readiness-probe-submit' }).unwrap(),
    );
    expect(result).toBe(false);
    expect(submits).not.toHaveBeenCalled();
    expect(frameState.activeTemporalGpuState).toBeUndefined();
    expect(frameState.temporalGpuState).toBeUndefined();
    expect(candidate.childScope.resourceDelta()).toBe(0);
    expect(candidate.childScope.state).toBe('retired');
  });

  it.each<TemporalResolveFailure>([
    'params',
    'bind-group',
    'pipeline',
  ])('rejects a real TAA resolve when %s fails and retries atomically', async (failureAt) => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const scope = DeviceScope.create(92, 'renderer');
    const environmentLifecycle = new EnvironmentLifecycle(scope);
    const activeEnvironment = environmentLifecycle.ensure(selectedEnvironment(), 'direct').unwrap();
    environmentLifecycle.publish(activeEnvironment);
    const environmentFrame = selectedEnvironment('environment:candidate');
    const environmentGeneration = environmentLifecycle.ensure(environmentFrame, 'direct').unwrap();
    const discardEnvironment = vi.spyOn(environmentLifecycle, 'discard');
    const publishEnvironment = vi.spyOn(environmentLifecycle, 'publish');
    const lastSuccessfulTemporalView = createTemporalView({
      antialias: 'taa',
      width: 4,
      height: 4,
      frameIndex: 6,
      historyValid: true,
    });
    const frameState = {
      temporalGpuState: undefined,
      activeTemporalGpuState: undefined,
      retiringTemporalGpuStates: new Set(),
      pendingTemporalCommit: {
        kind: 'taa',
        view: createTemporalView({
          antialias: 'taa',
          width: 4,
          height: 4,
          frameIndex: 6,
          historyValid: true,
        }),
      },
      environmentGeneration,
      environmentLifecycle,
      successfulTemporalFrameIndex: 7,
      lastSuccessfulTemporalView,
    } as unknown as RenderFrameState;
    const active = getTemporalGpuState(frameState, device, scope, 4, 4);
    getTemporalBindGroupResources(active);
    getTemporalParamsBuffer(active);
    stageTemporalGpuSubmit(active);
    expect(commitTemporalGpuSubmit(active)).toBe(true);
    frameState.lastSuccessfulTemporalView = lastSuccessfulTemporalView;
    frameState.activeTemporalGpuState = active;
    frameState.temporalGpuState = undefined;
    const candidate = getTemporalGpuState(frameState, device, scope, 8, 8);
    getTemporalBindGroupResources(candidate);
    getTemporalParamsBuffer(candidate);
    const graph = await buildTemporalResolveGraph(device);
    frameState.compiledFrameGraph = graph;

    const failure = new RhiError({
      code: 'webgpu-runtime-error',
      expected: `TAA ${failureAt} operation succeeds`,
      hint: 'repair the injected operation and retry the same frame',
    });
    const writeBuffer = vi.spyOn(device.queue, 'writeBuffer');
    const createBindGroup = vi.spyOn(device, 'createBindGroup');
    if (failureAt === 'params') {
      const originalWriteBuffer = device.queue.writeBuffer;
      writeBuffer.mockImplementation((buffer, offset, data, dataOffset, size) => {
        if (buffer === candidate.paramsBuffer) return err(failure);
        return originalWriteBuffer.call(device.queue, buffer, offset, data, dataOffset, size);
      });
    }
    if (failureAt === 'bind-group') createBindGroup.mockReturnValue(err(failure));
    const errors = new RhiErrorListenerRegistry();
    const observed: unknown[] = [];
    errors.add((error) => observed.push(error));
    const submits = vi.spyOn(device.queue, 'submit');
    const failedFrame = temporalResolveFrame(
      device,
      scope,
      frameState,
      failureAt === 'pipeline' ? null : {},
    );
    const failed = executeCompiledFrameGraph(
      { device, errorRegistry: errors } as never,
      frameState,
      failedFrame,
      failedFrame.encoder,
    );
    expect(failed).toBe(false);
    expect(submits).not.toHaveBeenCalled();
    expect(observed[0]).toMatchObject({ code: 'pass-encode-failed' });
    const cause = (observed[0] as { detail?: { cause?: unknown } }).detail?.cause;
    expect(cause).toBeInstanceOf(RhiError);
    expect(cause).toMatchObject({
      expected:
        failureAt === 'params'
          ? 'TAA resolve params upload succeeds'
          : failureAt === 'bind-group'
            ? 'TAA resolve bind group creation succeeds'
            : 'TAA resolve pipeline is ready before frame encoding',
    });
    expect(frameState.activeTemporalGpuState).toBe(active);
    expect(frameState.temporalGpuState).toBeUndefined();
    expect(candidate.childScope.resourceDelta()).toBe(0);
    expect(candidate.childScope.state).toBe('retired');
    expect(frameState.successfulTemporalFrameIndex).toBe(7);
    expect(active.childScope.state).toBe('active');

    writeBuffer.mockRestore();
    createBindGroup.mockRestore();
    expect(frameState.environmentGeneration).toBeUndefined();
    expect(discardEnvironment).toHaveBeenCalledTimes(1);
    expect(publishEnvironment).not.toHaveBeenCalled();
    expect(active.valid).toBe(true);
    expect(active.readIndex).toBe(1);
    expect(frameState.lastSuccessfulTemporalView).toBe(lastSuccessfulTemporalView);
    expect(environmentLifecycle.inspect().activeSignature).toBe(activeEnvironment.signature);
    expect(environmentLifecycle.inspect().lkgSignature).toBe(activeEnvironment.signature);
    frameState.environmentGeneration = environmentLifecycle
      .ensure(environmentFrame, 'direct')
      .unwrap();
    frameState.pendingTemporalCommit = {
      kind: 'taa',
      view: createTemporalView({
        antialias: 'taa',
        width: 8,
        height: 8,
        frameIndex: 7,
        historyValid: true,
      }),
    };
    const retryFrame = temporalResolveFrame(device, scope, frameState, {});
    const retried = executeCompiledFrameGraph(
      { device, errorRegistry: errors } as never,
      frameState,
      retryFrame,
      retryFrame.encoder,
    );
    expect(retried).toBe(true);
    expect(submits).toHaveBeenCalledTimes(1);
    expect(frameState.activeTemporalGpuState).not.toBe(active);
    expect(frameState.successfulTemporalFrameIndex).toBe(8);
    expect(frameState.temporalGpuState).toBeUndefined();
    expect(frameState.retiringTemporalGpuStates.size).toBe(1);
    expect(publishEnvironment).toHaveBeenCalledTimes(1);
    expect(discardEnvironment).toHaveBeenCalledTimes(1);
    active.childScope.retire();
    frameState.activeTemporalGpuState?.childScope.retire();
    scope.dispose();
  });
});
