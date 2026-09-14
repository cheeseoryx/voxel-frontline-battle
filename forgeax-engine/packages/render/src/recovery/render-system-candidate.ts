import type { MipmapEncoderWork } from '@forgeax/engine-assets-runtime';
import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import {
  type CommandBuffer,
  err,
  ok,
  type RenderPipeline,
  type Result,
  RhiError,
} from '@forgeax/engine-rhi';
import type { Handle, MeshAsset, SamplerAsset, TextureAsset } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { createClusterBinScratch } from '../cluster-binner';
import type { EnvironmentLifecycle } from '../environment/lifecycle';
import {
  getRenderFeaturePlanExecutionProjection,
  type RenderFeatureHost,
  type RenderFeaturePreparedGraphicsResolverInput,
  runRenderFeatureFrame,
} from '../features/host';
import type { RenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import { resolveStandardRenderFeatureTargets } from '../features/targets';
import {
  buildFullscreenPostProcessPass,
  entryHasDepthRead,
  type PostProcessShaderEntry,
  postProcessShaderEntrySignature,
} from '../fullscreen-post-process-pass';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { disposeInstanceBufferChunks, disposeInstanceBuffers } from '../instance-buffer-cache';
import { inspectStandardLighting } from '../pipeline/standard-lighting/inspection';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import { inspectPointShadow } from '../point-shadow-inspection';
import type { PreparedGraphicsResolver } from '../prepare/prepared-graphics-resolver';
import { validateRenderables } from '../record/frame';
import { prepareFrameLighting } from '../record/frame-lighting';
import type { RenderFrameState, ValidatedRenderable } from '../record/frame-snapshot';
import { resolveGeometryInstanceBuffer } from '../record/main-pass-geometry';
import { computeSplitLdrSprite } from '../record/main-pass-sprite-draws';
import {
  prepareRecoveryPipelineReadiness,
  type RecoveryPipelineReadiness,
} from '../record/recovery-pipeline';
import type { PointsLinesRecordOwner, RenderSystemInternals } from '../record/render-context';
import {
  ensureCompiledFrameGraph,
  getRenderFeatureGraphState,
  type RenderFeatureGraphCandidate,
} from '../record/typed-frame-graph';
import { STANDARD_OUTPUT_TRANSFORM_FEATURE_ID } from '../render-contract';
import type {
  RecoveryGraphCandidate,
  RecoveryGraphCandidatePreparation,
  RecoveryGraphCandidateRuntime,
  RecoveryGraphSetupSubmission,
  RecoveryPointsLinesCandidate,
} from '../render-system';
import type { ExtractedFrame, MaterialSnapshot } from '../render-system-extract';
import type { PersistentGpuDrivenCandidate, PersistentRenderScene } from '../scene/render-scene';
import { SHADOW_ATLAS_DEFAULT_LAYERS } from '../shadow-atlas';
import { createTemporalFrameTransaction } from '../temporal/frame';
import {
  getTemporalBindGroupResources,
  getTemporalGpuState,
  getTemporalParamsBuffer,
} from '../temporal/gpu';

export interface PreparedResolverCaches {
  readonly preparedPipelineIds: WeakMap<object, string>;
  readonly preparedMaterialPipelineShaders: WeakMap<object, string>;
  readonly preparedGroup0Pipelines: WeakSet<object>;
  readonly preparedViewOnlyPipelines: WeakSet<object>;
  readonly preparedRenderMaterialPipelines: WeakSet<object>;
  readonly preparedAssetHandles: WeakMap<World, Map<string, number>>;
}

export interface RecoveryFrameSeed {
  readonly frame: ExtractedFrame;
  readonly worlds: readonly World[];
  readonly cameraOwner: number;
  readonly resourceOwner: number;
  readonly width: number;
  readonly height: number;
}

export interface RenderSystemRecoveryDependencies {
  readonly frameState: RenderFrameState;
  readonly internals: RenderSystemInternals;
  readonly getEnvironmentLifecycle: () => EnvironmentLifecycle;
  readonly getGpuDrivenProduction: () => GpuDrivenProduction;
  readonly setGpuDrivenProduction: (production: GpuDrivenProduction) => void;
  readonly disposeFeatureGpuWork: () => void;
  readonly setFeatureGpuWork: (owner: RenderFeatureGpuWorkOwner) => void;
  readonly getActiveFeaturePostProcessEntries: () => ReadonlyMap<string, PostProcessShaderEntry>;
  readonly setActiveFeaturePostProcessEntries: (
    entries: ReadonlyMap<string, PostProcessShaderEntry>,
  ) => void;
  readonly postProcessPipelineCache: Map<string, RenderPipeline>;
  readonly clearPostProcessPipelineCache: (id: string) => void;
  readonly clearPostProcessPipelineEntry: (id: string, entry: PostProcessShaderEntry) => void;
  readonly invalidatePostProcessModule: (id: string) => void;
  readonly persistentRenderScene: PersistentRenderScene;
  readonly gpuDrivenShaderFactory: PipelineBuilderShaderModuleFactory;
  readonly createFeatureGpuWorkOwner: (runtime: RenderSystemInternals) => RenderFeatureGpuWorkOwner;
  readonly pointsLinesOwner: PointsLinesRecordOwner & {
    prepareRecoveryCandidate: (
      entries: readonly ValidatedRenderable[],
      clustered: boolean,
      runtime: RenderSystemInternals,
    ) => RecoveryPointsLinesCandidate | undefined;
  };
  readonly createPreparedResolverFactory: (
    runtime: RenderSystemInternals,
    gpuWork: RenderFeatureGpuWorkOwner,
    worlds: readonly World[],
    caches: PreparedResolverCaches,
  ) => (input: RenderFeaturePreparedGraphicsResolverInput) => PreparedGraphicsResolver;
  readonly createPreparedResolverCaches: () => PreparedResolverCaches;
}

export interface RenderSystemRecoveryOwner {
  setLastSuccessfulFrameSeed(seed: RecoveryFrameSeed): void;
  prepareRecoveryGraphCandidate(
    runtime: RecoveryGraphCandidateRuntime,
  ): Promise<RecoveryGraphCandidatePreparation>;
  submitCandidateSetup(
    candidate: RecoveryGraphCandidate,
    isValid: () => boolean,
  ): Result<RecoveryGraphSetupSubmission, RhiError>;
  publishRecoveryGraphCandidate(candidate: RecoveryGraphCandidate): void;
  discardRecoveryGraphCandidate(candidate: RecoveryGraphCandidate): void;
}

export function materialTextureHandles(
  material: MaterialSnapshot,
): readonly Handle<'TextureAsset', 'shared'>[] {
  const handles = new Map<number, Handle<'TextureAsset', 'shared'>>();
  const add = (handle: Handle<'TextureAsset', 'shared'> | undefined): void => {
    if (handle !== undefined) handles.set(Number(handle), handle);
  };
  for (const handle of material.textureHandles?.values() ?? []) add(handle);
  add(material.baseColorTexture);
  add(material.metallicRoughnessTexture);
  add(material.normalTexture);
  add(material.emissiveTexture);
  add(material.occlusionTexture);
  return [...handles.values()];
}

export function materialSamplerHandles(
  material: MaterialSnapshot,
): readonly Handle<'SamplerAsset', 'shared'>[] {
  const handles = new Map<number, Handle<'SamplerAsset', 'shared'>>();
  for (const handle of material.samplerHandles?.values() ?? []) {
    handles.set(Number(handle), handle);
  }
  return [...handles.values()];
}

export function createRenderSystemRecovery(
  deps: RenderSystemRecoveryDependencies,
): RenderSystemRecoveryOwner {
  const {
    frameState,
    internals,
    getEnvironmentLifecycle,
    getGpuDrivenProduction,
    setGpuDrivenProduction,
    disposeFeatureGpuWork,
    setFeatureGpuWork,
    getActiveFeaturePostProcessEntries,
    setActiveFeaturePostProcessEntries,
    postProcessPipelineCache,
    clearPostProcessPipelineCache,
    clearPostProcessPipelineEntry,
    invalidatePostProcessModule,
    persistentRenderScene,
    gpuDrivenShaderFactory,
    createFeatureGpuWorkOwner,
    pointsLinesOwner,
    createPreparedResolverFactory,
    createPreparedResolverCaches,
  } = deps;

  // This is a detached CPU projection, retained only after queue submission.
  // It is not a World/lease cache and it never carries target or scheduler state.
  let lastSuccessfulFrameSeed: RecoveryFrameSeed | undefined;

  const createRecoveryCandidateFrameState = (): RenderFrameState => {
    const { probeBlendRecordBuffer: discardedProbeBlendRecordBuffer, ...baseFrameState } =
      frameState;
    void discardedProbeBlendRecordBuffer;
    return {
      ...baseFrameState,
      successfulTemporalFrameIndex: 0,
      temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
      temporalFrameInput: undefined,
      graphTargetCapture: undefined,
      perFrameGraph: null,
      directionalShadowCache: null,
      directionalShadowCacheRecorded: false,
      compiledFrameGraph: null,
      compiledFrameGraphTopologyKey: null,
      volumetricFogPreviousGraph: null,
      volumetricFogPreviousGraphKey: null,
      volumetricFogCandidateGraph: null,
      volumetricFogParamsBuffers: [null, null],
      volumetricFogParamsPendingSlot: null,
      volumetricFogParamsAcceptedSlot: null,
      volumetricFogAcceptedParams: undefined,
      volumetricFogPendingParams: undefined,
      volumetricFogAccepted: undefined,
      volumetricFogAcceptedContext: undefined,
      volumetricFogHistoryGraph: null,
      volumetricFogHistorySlot: null,
      volumetricFogHistorySignature: null,
      retiredCompiledFrameGraphs: new Set(),
      currentFrameObservationSource: undefined,
      lastSuccessfulCameraAntialias: undefined,
      temporalGpuState: undefined,
      activeTemporalGpuState: undefined,
      retiringTemporalGpuStates: new Set(),
      lastSuccessfulTemporalView: undefined,
      pendingTemporalCommit: { kind: 'none' },
      environmentGeneration: undefined,
      currentDirectionalShadowView: null,
      currentSpotShadowView: null,
      instanceBuffers: new Map(),
      instanceBufferChunks: new Map(),
      instanceResidency: new Map(),
      morphBuffers: new Map(),
      hdrpClusterBinScratch: createClusterBinScratch(),
      hdrpClusterGridScratch: null,
      hdrpLightIndexListScratch: null,
      hdrpClusterMembership: null,
      standardLightingGraphSignature: '',
      standardLightingInspection: undefined,
      pointShadowInspection: undefined,
      transientInstanceBuffers: [],
      pointShadowAtlas: null,
      pointShadowSnapshots: [],
      spotShadowSnapshots: [],
      viewBindGroupCache: new WeakMap(),
      meshBindGroupCache: new WeakMap(),
      materialBgPerEntity: new Map(),
      instancesBgPerEntity: new Map(),
      instancesBgShared: new WeakMap(),
      materialBgShared: new Map(),
      materialBgAssemblyCache: new Map(),
      singletonMaterialCache: new Map(),
      postProcessBgCache: new WeakMap(),
      probeBlendBuffers: new Map(),
      probeBlendRecordBufferCapacity: 0,
      standardOncePerFrameFired: new Set(),
    } as RenderFrameState;
  };

  const publishRecoveryGraphCandidate = (candidate: RecoveryGraphCandidate): void => {
    candidate.recoveryReadiness.assertFirstRecoveryFrame();
    const previousFeatureHost = internals.featureHost;
    // The caller enters this method only after the active generation swap and
    // after resetForRecover() has shed every lost-device owner. Replace the
    // whole device-bound frame projection so no stale cache/map/temporal view
    // survives publication; the candidate was already built from the CPU/LKG
    // facts before this synchronous boundary.
    Object.assign(frameState, candidate.frameState);
    // EnvironmentLifecycle is published by the candidate root bundle. The
    // candidate frame state was created before that owner switch, so bind the
    // freshly selected lifecycle explicitly at the same boundary.
    Object.assign(frameState, {
      environmentLifecycle: getEnvironmentLifecycle(),
      temporalFrame: undefined,
      bloomFrameReceipts: undefined,
    });
    candidate.gpuDrivenScene?.publish();
    if (candidate.gpuDrivenProduction !== undefined) {
      getGpuDrivenProduction().dispose();
      setGpuDrivenProduction(candidate.gpuDrivenProduction);
    }
    if (candidate.featureGpuWork !== undefined) {
      disposeFeatureGpuWork();
      setFeatureGpuWork(candidate.featureGpuWork);
    }
    if (candidate.featureHost !== undefined) {
      const setFeatureHost = internals.setFeatureHost;
      if (setFeatureHost !== undefined) setFeatureHost(candidate.featureHost);
      if (previousFeatureHost !== undefined && previousFeatureHost !== candidate.featureHost) {
        const disposed = previousFeatureHost.dispose();
        if (!disposed.ok) internals.errorRegistry.fire(disposed.error);
      }
    }
    if (candidate.featureGraphCandidate !== undefined) {
      for (const [id, previous] of getActiveFeaturePostProcessEntries()) {
        const next = candidate.featureGraphCandidate.fullscreenEffects.get(id);
        if (next === undefined) {
          clearPostProcessPipelineCache(id);
          invalidatePostProcessModule(id);
        } else if (
          postProcessShaderEntrySignature(previous) !== postProcessShaderEntrySignature(next)
        ) {
          clearPostProcessPipelineEntry(id, previous);
          if (previous.source !== next.source) invalidatePostProcessModule(id);
        }
      }
      setActiveFeaturePostProcessEntries(candidate.featureGraphCandidate.fullscreenEffects);
      const graphState = getRenderFeatureGraphState(internals);
      graphState.plans = candidate.featureGraphCandidate.plans;
      graphState.fullscreenEffects = candidate.featureGraphCandidate.fullscreenEffects;
    }
    for (const [key, pipeline] of candidate.postProcessPipelines ?? []) {
      postProcessPipelineCache.set(key, pipeline);
    }
  };

  const discardRecoveryGraphCandidate = (candidate: RecoveryGraphCandidate): void => {
    candidate.release();
  };

  const prepareRecoveryGraphCandidate = async (
    runtime: RecoveryGraphCandidateRuntime,
  ): Promise<RecoveryGraphCandidatePreparation> => {
    const seed = lastSuccessfulFrameSeed;
    if (seed === undefined) return { kind: 'no-seed' };
    const camera = seed.frame.cameras[0];
    // A successful clear-only draw can have no display camera. There is no
    // frame graph to rehydrate in that case, but the device generation is
    // still recoverable; the next camera-bearing draw will build its graph
    // from the current World composition.
    if (camera === undefined) return { kind: 'no-seed' };

    const candidateFrameState = createRecoveryCandidateFrameState();
    Object.assign(candidateFrameState, {
      temporalFrame: undefined,
      bloomFrameReceipts: undefined,
    });
    const setupWorks: MipmapEncoderWork[] = [];
    const candidateGpuStore = runtime.internals.gpuStore;
    let candidateGpuDrivenScene: PersistentGpuDrivenCandidate | undefined;
    let candidateGpuDrivenProduction: GpuDrivenProduction | undefined;
    let candidateFeatureHost: RenderFeatureHost | undefined;
    let candidateFeatureGpuWork: RenderFeatureGpuWorkOwner | undefined;
    let candidatePointsLines: RecoveryPointsLinesCandidate | undefined;
    let candidateFeatureGraph: RenderFeatureGraphCandidate = {
      plans: Object.freeze([]),
      fullscreenEffects: new Map(),
    };
    let candidateValidated: ValidatedRenderable[] = [];
    let recoveryReadiness: RecoveryPipelineReadiness | undefined;
    let preparedGpuDriven:
      | import('../gpu-driven/production-raster').PreparedGpuDrivenFrame
      | undefined;
    let recoveryGraphFailure: unknown;
    let candidatePublished = false;
    let candidateReleased = false;
    const releaseCandidate = (): void => {
      if (candidateReleased || candidatePublished) return;
      candidateReleased = true;
      for (const work of setupWorks) work.discard();
      setupWorks.length = 0;
      const graph = candidateFrameState.compiledFrameGraph;
      candidateFrameState.compiledFrameGraph = null;
      candidateFrameState.perFrameGraph = null;
      try {
        graph?.retire().catch(() => undefined);
      } catch {
        // Candidate cleanup continues through every independent owner.
      }
      try {
        candidateFrameState.pointShadowAtlas?.dispose();
      } catch {
        // Candidate cleanup continues through every independent owner.
      }
      candidateFrameState.pointShadowAtlas = null;
      candidateFeatureGraph.onAbandoned?.();
      const featureHost = candidateFeatureHost;
      candidateFeatureHost = undefined;
      if (featureHost !== undefined) {
        featureHost.dispose();
      }
      candidateFeatureGpuWork?.dispose();
      candidateFeatureGpuWork = undefined;
      candidateGpuDrivenProduction?.dispose();
      candidateGpuDrivenProduction = undefined;
      candidateGpuDrivenScene?.release();
      candidateGpuDrivenScene = undefined;
      candidatePointsLines?.release();
      candidatePointsLines = undefined;
      disposeInstanceBuffers(candidateFrameState.instanceBuffers, runtime.internals.errorRegistry);
      if (candidateFrameState.instanceBufferChunks !== undefined) {
        disposeInstanceBufferChunks(
          candidateFrameState.instanceBufferChunks,
          runtime.internals.errorRegistry,
        );
      }
      candidateGpuStore.destroyAll();
    };
    const markPublished = (): void => {
      candidatePointsLines?.publish();
      candidatePublished = true;
    };
    const failed = (
      reason: string,
      cause: unknown = recoveryGraphFailure,
    ): RecoveryGraphCandidatePreparation => {
      releaseCandidate();
      return cause === undefined ? { kind: 'failed', reason } : { kind: 'failed', reason, cause };
    };

    try {
      const gpuScene = persistentRenderScene.prepareRecoveryGpuDrivenCandidate(
        runtime.internals.device,
      );
      if (!gpuScene.ok) return failed('candidate GPU scene preparation failed', gpuScene.error);
      candidateGpuDrivenScene = gpuScene.value;
      if (candidateGpuDrivenScene.state !== undefined) {
        const production = await GpuDrivenProduction.forRecoveryDevice(
          runtime.internals.device,
          gpuDrivenShaderFactory,
          (descriptor) =>
            internals.createShaderModule === undefined
              ? Promise.resolve(gpuDrivenShaderFactory.createShaderModule(descriptor))
              : internals.createShaderModule(runtime.internals.device, descriptor),
        );
        if (!production.ok)
          return failed('candidate GPU-driven shader preparation failed', production.error);
        candidateGpuDrivenProduction = production.value;
        const prepared = candidateGpuDrivenProduction.prepare({
          scene: candidateGpuDrivenScene.state,
          camera,
          meshes: runtime.pipelineState.meshes,
          viewBindGroupLayout: runtime.pipelineState.viewBindGroupLayout,
          meshResidencyEpoch: runtime.internals.gpuStore.meshResidencyEpoch,
          hdrp: false,
        });
        if (!prepared.ok) return failed('candidate GPU-driven preparation failed', prepared.error);
        preparedGpuDriven = prepared.value;
      }
      candidateFeatureHost = runtime.internals.featureHost;
      if (candidateFeatureHost !== undefined && candidateFeatureHost.size > 0) {
        candidateFeatureGpuWork = createFeatureGpuWorkOwner(runtime.internals);
        const featureTargets = resolveStandardRenderFeatureTargets({
          tonemap: camera.tonemap,
          antialias: camera.antialias,
          colorAttachmentFormat: runtime.pipelineState.colorAttachmentFormat,
          storageBuffer: runtime.internals.device.caps.storageBuffer,
          multisample: runtime.internals.device.caps.backendKind !== 'wgpu-webgl2',
        });
        const featureFrame = runRenderFeatureFrame(candidateFeatureHost, {
          worlds: seed.worlds,
          owner: seed.resourceOwner,
          frameNumber: candidateFrameState.frameNumber,
          visibilitySnapshots: seed.frame.featureVisibilitySnapshots,
          hiddenEntityReports: seed.frame.hiddenEntityReports,
          targets: featureTargets,
          generation: runtime.internals.deviceScope.generation,
          caps: runtime.internals.device.caps,
          ...(runtime.internals.getMaterialShaderBindingContract === undefined
            ? {}
            : {
                materialShaderBindingContract: runtime.internals.getMaterialShaderBindingContract,
              }),
          createPreparedGraphicsResolver: createPreparedResolverFactory(
            runtime.internals,
            candidateFeatureGpuWork,
            seed.worlds,
            createPreparedResolverCaches(),
          ),
          gpuWork: candidateFeatureGpuWork,
        });
        if (featureFrame.errors.length > 0) {
          return failed('candidate render-feature preparation failed');
        }
        const featurePreparationIncomplete = featureFrame.plans.some((planned) => {
          const execution = getRenderFeaturePlanExecutionProjection(planned);
          return (
            execution === undefined ||
            execution.passes.some(
              (pass) =>
                (pass.graphics !== undefined && pass.resolvedGraphics === undefined) ||
                (pass.gpuCompute !== undefined && pass.resolvedGpuCompute === undefined),
            )
          );
        });
        if (featurePreparationIncomplete) {
          return failed('candidate render-feature resources are not fully prepared');
        }
        const batches = Object.freeze([...featureFrame.preparedResourceBatches]);
        let batchesReleased = false;
        const releaseBatches = (): void => {
          if (batchesReleased) return;
          batchesReleased = true;
          for (const batch of batches) {
            const released = batch.release();
            if (!released.ok) runtime.internals.errorRegistry.fire(released.error);
          }
        };
        candidateFeatureGraph = {
          plans: featureFrame.plans,
          fullscreenEffects: featureFrame.fullscreenEffects,
          ...(batches.length === 0
            ? {}
            : { preparedResourceKey: `recovery-${runtime.internals.deviceScope.generation}` }),
          onRejected: releaseBatches,
          onAbandoned: releaseBatches,
        };
      }
      for (const renderable of seed.frame.renderables) {
        const world = seed.worlds[renderable.worldId];
        if (world === undefined) return failed(`world ${renderable.worldId} is unavailable`);
        if (!runtime.pipelineState.meshes.has(renderable.assetHandle)) {
          const mesh = resolveAssetHandle<MeshAsset>(
            world,
            toShared<'MeshAsset'>(renderable.assetHandle),
          );
          if (!mesh.ok) return failed(`mesh ${renderable.assetHandle} resolution failed`);
          const preparedMesh = runtime.internals.gpuStore.prepareResidentForRecovery(
            toShared<'MeshAsset'>(renderable.assetHandle),
            mesh.value,
            world,
          );
          if (!preparedMesh.ok) return failed(`mesh ${renderable.assetHandle} residency failed`);
          if (preparedMesh.value.mipmapWork !== undefined) {
            setupWorks.push(preparedMesh.value.mipmapWork);
          }
        }
        for (const material of renderable.materials) {
          for (const textureHandle of materialTextureHandles(material)) {
            const texture = resolveAssetHandle<TextureAsset>(world, textureHandle);
            if (!texture.ok) return failed(`texture ${textureHandle} resolution failed`);
            const preparedTexture = runtime.internals.gpuStore.prepareResidentForRecovery(
              textureHandle,
              texture.value,
              world,
            );
            if (!preparedTexture.ok) return failed(`texture ${textureHandle} residency failed`);
            if (preparedTexture.value.mipmapWork !== undefined) {
              setupWorks.push(preparedTexture.value.mipmapWork);
            }
          }
          for (const samplerHandle of materialSamplerHandles(material)) {
            const sampler = resolveAssetHandle<SamplerAsset>(world, samplerHandle);
            if (!sampler.ok) return failed(`sampler ${samplerHandle} resolution failed`);
            const preparedSampler = runtime.internals.gpuStore.ensureSamplerResident(
              samplerHandle,
              sampler.value,
              world,
            );
            if (!preparedSampler.ok) return failed(`sampler ${samplerHandle} residency failed`);
          }
        }
      }
      const resourceWorld = seed.worlds[seed.resourceOwner] ?? seed.worlds[0];
      if (resourceWorld === undefined)
        return failed('recovery resource-owner world is unavailable');
      const volumetricFog = seed.frame.volumetricFog;
      if (volumetricFog?.status === 'available') {
        const volumeWorld =
          seed.worlds[volumetricFog.worldId ?? seed.resourceOwner] ?? resourceWorld;
        if (volumetricFog.densityHandle === undefined || volumetricFog.densityAsset === undefined) {
          return failed('recovery volumetric density source is unavailable');
        }
        const preparedDensity = candidateGpuStore.prepareResidentForRecovery(
          volumetricFog.densityHandle,
          volumetricFog.densityAsset,
          volumeWorld,
        );
        if (!preparedDensity.ok) return failed('volumetric density residency failed');
        if (preparedDensity.value.mipmapWork !== undefined) {
          setupWorks.push(preparedDensity.value.mipmapWork);
        }
        if (
          volumetricFog.projectorHandle !== undefined &&
          volumetricFog.projectorAsset !== undefined
        ) {
          const preparedProjector = candidateGpuStore.prepareResidentForRecovery(
            volumetricFog.projectorHandle,
            volumetricFog.projectorAsset,
            volumeWorld,
          );
          if (!preparedProjector.ok) return failed('volumetric projector residency failed');
          if (preparedProjector.value.mipmapWork !== undefined) {
            setupWorks.push(preparedProjector.value.mipmapWork);
          }
        }
      }
      candidateValidated = validateRenderables(
        runtime.internals,
        resourceWorld,
        seed.worlds,
        runtime.pipelineState,
        candidateFrameState,
        seed.frame.renderables,
        seed.frame.dispatch,
      );
      if (candidateValidated.length !== seed.frame.renderables.length) {
        return failed('candidate validation did not retain every LKG-visible renderable');
      }
      for (const entry of candidateValidated) {
        if (entry.source.instances === undefined) continue;
        const prepared = resolveGeometryInstanceBuffer(
          {
            runtime: runtime.internals,
            pipelineState: runtime.pipelineState,
            frameState: candidateFrameState,
            bindGroupCounts: { createBindGroup: 0, keys: [] },
          },
          entry,
          [],
          false,
        );
        if (prepared === null) return failed('candidate instance preparation failed');
      }
      // These uploads belong to recovery preparation, never to a rendered frame.
      for (const [id, residency] of candidateFrameState.instanceResidency ?? []) {
        candidateFrameState.instanceResidency?.set(id, { ...residency, frameNumber: -1 });
      }
      const lighting = prepareFrameLighting(
        runtime.internals,
        candidateFrameState,
        seed.frame.lights,
        camera,
        runtime.pipelineState,
      );
      if (!lighting.ok) return failed('candidate lighting preparation failed');
      candidatePointsLines = pointsLinesOwner.prepareRecoveryCandidate(
        candidateValidated,
        lighting.value.standard?.kind === 'clustered',
        runtime.internals,
      );
      recoveryReadiness = prepareRecoveryPipelineReadiness({
        internals: runtime.internals,
        pipelineState: runtime.pipelineState,
        camera,
        standardLighting: lighting.value.standard,
        validated: candidateValidated,
        dispatch: seed.frame.dispatch,
        shadowCastersActive:
          seed.frame.lights.pointShadow.length > 0 ||
          seed.frame.lights.spot.some((spot) => spot.castShadow === true) ||
          (seed.frame.lights.lightViewProj?.length ?? 0) > 0,
        splitLdrSprite: computeSplitLdrSprite(
          candidateValidated,
          camera.tonemap !== 'none',
          seed.frame.dispatch,
        ),
        reflectionFallbackAvailable: candidateFrameState.reflectionFallbackDemand === true,
      });
      const candidatePostProcessIds = new Set<string>([
        ...(candidateFrameState.installedPipelineConfig?.postEffects ?? []),
        ...candidateFeatureGraph.fullscreenEffects.keys(),
      ]);
      const configuredPostEffects = candidateFrameState.installedPipelineConfig?.postEffects ?? [];
      const postProcessPipeline = runtime.internals.getPostProcessPipeline;
      const postProcessLookup = runtime.internals.lookupPostProcess;
      if (postProcessPipeline === undefined || postProcessLookup === undefined) {
        return failed('candidate post-process pipeline owner is unavailable');
      }
      const depthMultisampled =
        camera.antialias === 'msaa' && runtime.internals.device.caps.backendKind !== 'wgpu-webgl2';
      const warmPostProcessPipeline = (
        id: string,
        colorFormat: GPUTextureFormat,
        entryOverride?: PostProcessShaderEntry,
      ): void => {
        const entry =
          entryOverride ?? candidateFeatureGraph.fullscreenEffects.get(id) ?? postProcessLookup(id);
        if (entry === undefined) {
          throw new Error(`recovery post-process declaration is unavailable: ${id}`);
        }
        const built = buildFullscreenPostProcessPass(
          { device: runtime.internals.device, errorRegistry: runtime.internals.errorRegistry },
          entry,
          depthMultisampled,
        );
        if (
          built === null ||
          built.sampler === null ||
          (entryHasDepthRead(entry) && built.depthSampler === null)
        ) {
          throw new Error(`recovery post-process bindings are unavailable: ${id}`);
        }
        const pipeline = postProcessPipeline(id, built.bindGroupLayout, colorFormat, entry);
        if (pipeline === null) {
          throw new Error(`recovery post-process pipeline is unavailable: ${id}`);
        }
      };
      const rawOnlyPostInput =
        runtime.pipelineState.surfaceProfile === 'raw-only' &&
        runtime.internals.device.caps.storageBuffer &&
        configuredPostEffects.length > 0;
      const outputFormat =
        camera.antialias === 'fxaa' || rawOnlyPostInput
          ? ('rgba16float' as GPUTextureFormat)
          : (runtime.pipelineState.format as GPUTextureFormat);
      // Standard's output transform is a graph pass even when no authored
      // effect is installed. Warm its exact target format before publication;
      // the first recovery frame must only resolve this candidate-owned cache.
      warmPostProcessPipeline(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID, outputFormat);
      if (camera.antialias === 'taa') {
        const temporal = getTemporalGpuState(
          candidateFrameState,
          runtime.internals.device,
          runtime.internals.deviceScope,
          seed.width,
          seed.height,
        );
        getTemporalParamsBuffer(temporal);
        const temporalBindings = getTemporalBindGroupResources(temporal);
        const taaEntry = postProcessLookup('forgeax.taa-resolve');
        if (taaEntry === undefined) {
          throw new Error('recovery TAA post-process declaration is unavailable');
        }
        const taaPipeline = postProcessPipeline(
          'forgeax.taa-resolve',
          temporalBindings.layout,
          'rgba16float',
          taaEntry,
        );
        if (taaPipeline === null) {
          throw new Error('recovery TAA pipeline is unavailable');
        }
      }
      if (camera.motionBlur?.shutterAngle !== undefined && camera.motionBlur.shutterAngle > 0) {
        warmPostProcessPipeline('forgeax.motion-blur', 'rgba16float');
      }
      for (const id of candidatePostProcessIds) {
        warmPostProcessPipeline(id, runtime.pipelineState.format as GPUTextureFormat);
      }
      if (camera.bloom === 'on' && camera.tonemap !== 'none') {
        runtime.pipelineState.perPassResources.ensureBloomResources?.();
        const bloom = runtime.pipelineState.perPassResources.getBloomResources?.();
        if (
          bloom === null ||
          bloom === undefined ||
          bloom.bloomBrightPipeline === null ||
          bloom.bloomBlurHPipeline === null ||
          bloom.bloomBlurVPipeline === null ||
          bloom.bloomCompositePipeline === null ||
          bloom.bloomBrightBindGroupLayout === null ||
          bloom.bloomBlurBindGroupLayout === null ||
          bloom.bloomCompositeBindGroupLayout === null ||
          bloom.bloomSampler === null ||
          bloom.bloomBrightParamsBuffer === null ||
          bloom.bloomBlurHParamsBuffer === null ||
          bloom.bloomBlurVParamsBuffer === null ||
          bloom.bloomCompositeParamsBuffer === null
        ) {
          throw new Error('recovery Bloom resources are incomplete');
        }
      }
      const graph = ensureCompiledFrameGraph(
        runtime.internals,
        candidateFrameState,
        runtime.pipelineState,
        camera,
        seed.frame.lights,
        seed.width,
        seed.height,
        undefined,
        preparedGpuDriven,
        candidateFeatureGraph,
        undefined,
        false,
        undefined,
        undefined,
        seed.frame.volumetricFog,
        seed.frame.volumetricFog?.status === 'available',
        lighting.value.standard,
        (error) => {
          recoveryGraphFailure ??= error;
        },
      );
      if (graph === null) return failed('candidate frame graph compilation failed');
      if (recoveryReadiness === undefined)
        return failed('candidate pipeline readiness was not prepared');
      // Keep recovery inspection derived from the exact Standard declaration
      // admitted to the candidate graph.  The point-shadow projection is
      // likewise detached from the candidate atlas and never waits for the
      // first post-recovery frame to rediscover the retained budget.
      candidateFrameState.standardLightingInspection = inspectStandardLighting(
        lighting.value.standard,
      );
      candidateFrameState.pointShadowInspection = inspectPointShadow(
        seed.frame.lights.pointShadow,
        SHADOW_ATLAS_DEFAULT_LAYERS,
      );
      return {
        kind: 'ready',
        candidate: {
          frameState: candidateFrameState,
          setupWorks: Object.freeze(setupWorks),
          device: runtime.internals.device,
          generation: runtime.internals.deviceScope.generation,
          ...(candidateGpuDrivenProduction === undefined
            ? {}
            : { gpuDrivenProduction: candidateGpuDrivenProduction }),
          ...(candidateGpuDrivenScene === undefined
            ? {}
            : { gpuDrivenScene: candidateGpuDrivenScene }),
          ...(candidatePointsLines === undefined ? {} : { pointsLines: candidatePointsLines }),
          ...(candidateFeatureHost === undefined ? {} : { featureHost: candidateFeatureHost }),
          ...(candidateFeatureGpuWork === undefined
            ? {}
            : { featureGpuWork: candidateFeatureGpuWork }),
          featureGraphCandidate: candidateFeatureGraph,
          postProcessPipelines: new Map(
            runtime.internals.getRecoveryPostProcessPipelines?.() ?? [],
          ),
          recoveryReadiness,
          release: releaseCandidate,
          markPublished,
        },
      };
    } catch (cause) {
      return failed(`candidate preparation threw: ${String(cause)}`, cause);
    }
  };

  const submitCandidateSetup = (
    candidate: RecoveryGraphCandidate,
    isValid: () => boolean,
  ): Result<RecoveryGraphSetupSubmission, RhiError> => {
    const setupFailure = (hint: string): Result<never, RhiError> =>
      err(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'recovery setup remains candidate-only and valid before publication',
          hint,
        }),
      );
    const discardSetupWorks = (): void => {
      for (const work of candidate.setupWorks) work.discard();
    };
    try {
      if (!isValid()) {
        discardSetupWorks();
        return setupFailure('discard the recovery candidate after its setup deadline or loss');
      }
      const commandBuffers: CommandBuffer[] = [];
      for (const work of candidate.setupWorks) {
        const finished = work.finish();
        if (!finished.ok) {
          discardSetupWorks();
          return err(finished.error);
        }
        if (finished.value !== undefined) commandBuffers.push(finished.value);
      }
      if (!isValid()) {
        discardSetupWorks();
        return setupFailure('discard the recovery candidate after mip setup became stale');
      }
      if (commandBuffers.length === 0) return ok({});
      const submitted = candidate.device.queue.submit(commandBuffers);
      if (!submitted.ok) {
        discardSetupWorks();
        return err(submitted.error);
      }
      if (!isValid()) {
        discardSetupWorks();
        return setupFailure('discard the recovery candidate after setup submission became stale');
      }
      return ok({ completion: candidate.device.queue.onSubmittedWorkDone() });
    } catch (cause) {
      discardSetupWorks();
      if (cause instanceof RhiError) return err(cause);
      return setupFailure(`recovery setup submission raised: ${String(cause)}`);
    }
  };

  return {
    setLastSuccessfulFrameSeed(seed: RecoveryFrameSeed): void {
      lastSuccessfulFrameSeed = seed;
    },
    prepareRecoveryGraphCandidate,
    submitCandidateSetup,
    publishRecoveryGraphCandidate,
    discardRecoveryGraphCandidate,
  };
}
