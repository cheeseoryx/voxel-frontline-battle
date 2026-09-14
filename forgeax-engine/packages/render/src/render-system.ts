// @forgeax/engine-runtime - RenderSystem main entry (D-S2 three-stage Extract ->
// Prepare -> Record + 4-tier error fan-out).
//
// Engine-internal phase: NOT registered to World schedule (AC-09);
// `Renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 })` invokes once per frame. See `Renderer` JSDoc in
// `./render-contract.ts` for the public error/frame contract and AGENTS.md
// "ECS render bridge" section for the AI-user-facing contract.
//
// Stage carve-out (review round 1 finding #3 - 505 line cap fallback):
//   - render-system.ts          (this file)             types + orchestration
//   - render-system-extract.ts  Extract ECS query phase + snapshot helpers
//   - render-system-record.ts   Prepare + Record GPU phase + matrix helpers
//
// @forgeax/engine-math is referenced through render-system-record.ts which builds
// view/proj matrices and worldFromLocal via `mat4.compose / .multiply /
// .invert` (charter proposition 5: no math reinvention; render-system.test.ts
// asserts `/@forgeax\/engine-math/` shows up in render-system.ts source).

import {
  type MipmapEncoderWork,
  numMipLevels,
  resolveAssetHandle,
} from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import type { RecorderSession } from '@forgeax/engine-profiler';
import type { CompiledRenderGraphInfo } from '@forgeax/engine-render-graph';
import type {
  BindGroupEntry,
  BindGroupLayout,
  Buffer,
  RenderPipeline,
  RhiDevice,
} from '@forgeax/engine-rhi';
import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import {
  derive,
  deriveTextureLayout,
  type Handle,
  type MaterialAsset,
  type MaterialTextureValue,
  type RenderPipelineAsset,
  RenderQueue,
  type SamplerAsset,
  type TextureAsset,
  toShared,
} from '@forgeax/engine-types';
import {
  type DirectionalShadowInspectionSource,
  directionalShadowProfileFromQuality,
  projectDirectionalShadowInspectionSource,
} from './assembly/directional-shadow-inspection';
import { createClusterBinScratch } from './cluster-binner';
import type { DeviceScope, LifecycleResourceSpec } from './device/device-scope';
import type { EnvironmentGeneration } from './environment/generation';
import { EnvironmentLifecycle } from './environment/lifecycle';
import {
  type ObservationUnavailableError,
  type RenderError,
  TransmissionCapabilityMissingError,
} from './errors/render';
import {
  type RenderFeatureHost,
  type RenderFeaturePreparedGraphicsResolverInput,
  runRenderFeatureFrame,
  settlePreparedGraphicsCompletion,
} from './features/host';
import {
  createRenderFeatureGpuWorkOwner,
  type RenderFeatureGpuWorkOwner,
} from './features/prepared-gpu-work';
import { resolveStandardRenderFeatureTargets } from './features/targets';
import {
  buildFullscreenPostProcessPass,
  DEPTH_MIN_PARAMS_BYTE_SIZE,
  entryHasDepthRead,
  type PostProcessShaderEntry,
  postProcessShaderEntrySignature,
  postProcessShaderModuleLabel,
  postProcessShaderPipelineLabel,
} from './fullscreen-post-process-pass';
import { GpuDrivenProduction } from './gpu-driven/production-raster';
import type {
  BloomInspection,
  DirectionalShadowInspection,
  GpuDrivenProductionInspection,
  LodOcclusionInspection,
  LodOcclusionInspectionRow,
  LodOcclusionWorldInspection,
  MotionBlurInspection,
  ReflectionProbeInspection,
  RenderSceneInspection,
  SsrDependenciesInspection,
  TemporalTargetInspection,
  TransmissionInspection,
} from './inspection-types';
import { buildOcclusionProxyVertices } from './occlusion-proxy';
import type { PointsLinesRetainedSnapshot } from './points-lines/snapshot';
import { StandardPointsLinesOwner } from './points-lines/standard-owner';
import {
  createRenderSystemRecovery,
  materialSamplerHandles,
  materialTextureHandles,
} from './recovery/render-system-candidate';
import { ReflectionProbeRecordOwner } from './reflection/record-owner';
import {
  OcclusionRenderRuntime,
  type OcclusionRuntimeCandidate,
} from './scene/visibility/occlusion-runtime';
import { primitiveKey, viewKey } from './scene/visibility/types';
import { inspectVolumetricFog } from './volume/inspection';

export type { RenderSceneInspection } from './inspection-types';

import { createCubeCaptureScheduler } from './capture/scheduler';
import type { GpuResidencyCache } from './device/gpu-residency';
import type { EnvironmentInspection } from './environment/inspection';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from './gpu-usage';
import { resetHdrpBuffers } from './hdrp-buffers';
import { assembleMaterialWithSkylightEntries } from './ibl/skylight-bind-group';
import {
  disposeInstanceBufferChunks,
  disposeInstanceBuffers,
  disposeTransientInstanceBuffers,
} from './instance-buffer-cache';
import type { InstanceCollectionInspection } from './instances';
import { InstanceProjectionStore } from './instances';
import {
  type MeshMaterialBindingObservation,
  type MeshMaterialBindingPreparationFailure,
  type MeshMaterialBindingResidency,
  projectMeshMaterialBindingObservation,
} from './mesh-material-bindings';
import type { StandardLightingInspection } from './pipeline/standard-lighting/inspection';
import { validateClusterGrid } from './pipeline/standard-pipeline';
import { DEFAULT_CLUSTER_GRID } from './pipeline/standard-profile';
import { PipelineSpecError } from './pipeline-spec';
import type { PointShadowInspection } from './point-shadow-inspection';
import { PostProcessError } from './post-process-errors';
import {
  createPreparedGraphicsResolver,
  type PreparedGraphicsResolver,
} from './prepare/prepared-graphics-resolver';
import {
  type CubeCaptureFrameInput,
  type FrameObservation,
  type FrameObservationOptions,
  observeCurrentFrame,
  type RecordProfileRunner,
  recordFrame,
} from './record/frame';
import { buildPerFrameBindGroups } from './record/frame-lighting';
import type {
  CurrentGraphTarget,
  GraphTargetCaptureRequest,
  RenderFrameState,
} from './record/frame-snapshot';
import { getTextureIdentity, worldEntityKey } from './record/frame-snapshot';
import type { GpuPassTimingReason } from './record/gpu-pass-timing/errors';
import type {
  GpuPassTimingCapture,
  GpuPassTimingFrameIdentity,
  GpuPassTimingSession,
} from './record/gpu-pass-timing/session';
import type { GpuTimingCapture } from './record/gpu-timing';
import { applyParamSnapshotToUbo, residentTextureView } from './record/main-pass-material';
import type { RecoveryPipelineReadiness } from './record/recovery-pipeline';
import type { PipelineState, RenderSystemInternals } from './record/render-context';
import type { CubeCaptureGraphState } from './record/typed-frame-graph';
import {
  type RenderFeatureGraphCandidate,
  resetRenderFeatureGraphState,
  settleVolumetricFogGraphCandidate,
} from './record/typed-frame-graph';
import {
  type CameraSnapshot,
  type DrawOwnerOptions,
  RENDER_PHASE_CATALOG,
  type RenderPhase,
  type RenderPhaseSkipReason,
  type RenderRecordPhase,
} from './render-contract';
import type {
  DispatchEntry,
  ExtractedFrame,
  ExtractedLights,
  MaterialSnapshot,
  RenderableSnapshot,
} from './render-system-extract';
import { extractFrames } from './render-system-extract';
import {
  type PersistentGpuDrivenCandidate,
  type PersistentRenderCandidateRequest,
  PersistentRenderScene,
} from './scene/render-scene';
import { inspectLodOcclusion } from './scene/visibility/inspection';
import { resolveSsaoParameters } from './ssao-config';
import { projectSsrDependencies, resolveSsrAdmissionGeneration } from './ssr/admission';
import {
  getTransparentSortConfig,
  TRANSPARENT_SORT_MODE_DISTANCE,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from './systems/transparent-sort-config';
import type { RenderTarget } from './targets/contracts';
import { createTemporalFrameTransaction, type TemporalFrame } from './temporal/frame';
import { retireTemporalGpuState } from './temporal/gpu';
import { inspectTemporal, type TemporalInspection } from './temporal/inspection';
import {
  evaluateTransmissionCapability,
  probeTransmissionCapability,
  resolveTransmissionBackdropTopology,
  TransmissionCandidateAdmission,
} from './transmission/backdrop';
import {
  estimateTransmissionBackdropBytes,
  inspectTransmission,
  inspectTransmissionFromAdmission,
} from './transmission/inspection';

function canonicalizeWorldComposition(
  worlds: readonly World[],
  owners: Pick<DrawOwnerOptions, 'cameraOwner' | 'resourceOwner'>,
  leases: readonly RenderReadLease[] | undefined,
): {
  readonly worlds: readonly World[];
  readonly owners: Pick<DrawOwnerOptions, 'cameraOwner' | 'resourceOwner'>;
  readonly leases: readonly RenderReadLease[] | undefined;
} {
  const order = worlds
    .map((world, index) => ({ world, index }))
    .sort((left, right) => left.world.identity.localeCompare(right.world.identity));
  const indexByOriginal = new Map(order.map((entry, index) => [entry.index, index]));
  return {
    worlds: Object.freeze(order.map((entry) => entry.world)),
    owners: {
      cameraOwner: indexByOriginal.get(owners.cameraOwner) ?? owners.cameraOwner,
      resourceOwner: indexByOriginal.get(owners.resourceOwner) ?? owners.resourceOwner,
    },
    leases:
      leases === undefined
        ? undefined
        : Object.freeze(
            order.map((entry) => leases[entry.index]).filter((lease) => lease !== undefined),
          ),
  };
}

interface LodInspectionQuerySummary {
  readonly used: number;
  readonly capacity: number;
}

function createLodWorldInspections(
  worlds: readonly World[],
  renderables: readonly RenderableSnapshot[],
  submittedRenderables: readonly RenderableSnapshot[],
  camera: CameraSnapshot,
  frameId: number,
  worldKeys: readonly number[],
  slots: ReadonlyMap<number, { readonly slot: number; readonly generation: number }>,
  query: LodInspectionQuerySummary,
  fallback: LodOcclusionInspection['fallback'],
  degradation: LodOcclusionInspection['degradation'],
): readonly LodOcclusionWorldInspection[] {
  // The CPU projection knows which renderables belong to each World, but it
  // does not receive the GPU selector/query counters split by World from the
  // same submit. Keep these rows available for diagnostics while explicitly
  // marking their attribution unavailable; producers must not promote them
  // to World-reorder evidence by inferring facts from array order.
  const attribution = Object.freeze({
    status: 'unavailable' as const,
    reason: 'projection-only' as const,
  });
  const submitted = new Set(submittedRenderables);
  const sampleLimit = 64;
  const accumulators = worlds.map(() => ({
    allCount: 0,
    allVisible: 0,
    allSamples: [] as RenderableSnapshot[],
    lodCount: 0,
    lodVisible: 0,
    lodSamples: [] as RenderableSnapshot[],
  }));
  // Keep this projection bounded: the old implementation filtered the full
  // 100k renderable list twice per World on every frame and retained another
  // Set-backed traversal just to derive the six counters below. One pass is
  // enough because the inspection only needs counts, the first row identity,
  // and at most 64 detached samples.
  for (const renderable of renderables) {
    const accumulator = accumulators[renderable.worldId];
    if (accumulator === undefined) continue;
    const visible = submitted.has(renderable);
    accumulator.allCount += 1;
    if (visible) accumulator.allVisible += 1;
    if (accumulator.allSamples.length < sampleLimit) accumulator.allSamples.push(renderable);
    if ((renderable.lods?.length ?? 0) > 0) {
      accumulator.lodCount += 1;
      if (visible) accumulator.lodVisible += 1;
      if (accumulator.lodSamples.length < sampleLimit) accumulator.lodSamples.push(renderable);
    }
  }
  const result: LodOcclusionWorldInspection[] = [];
  for (let worldId = 0; worldId < worlds.length; worldId += 1) {
    const world = worlds[worldId];
    if (world === undefined) continue;
    const accumulator = accumulators[worldId];
    if (accumulator === undefined || accumulator.allCount === 0) {
      result.push(
        Object.freeze({ attachmentId: world.identity, rows: Object.freeze([]), attribution }),
      );
      continue;
    }
    const usesLod = accumulator.lodCount > 0;
    const candidateCount = usesLod ? accumulator.lodCount : accumulator.allCount;
    const visible = usesLod ? accumulator.lodVisible : accumulator.allVisible;
    const samples = usesLod ? accumulator.lodSamples : accumulator.allSamples;
    const first = samples[0];
    const slot =
      first === undefined
        ? undefined
        : slots.get(worldEntityKey(worldKeys[first.worldId] ?? first.worldId, first.entityKey));
    const row: LodOcclusionInspectionRow = {
      root: {
        guid: first === undefined ? 'none' : `asset-handle:${first.assetHandle}`,
        sourceKey: `render-world:${world.identity}`,
      },
      view: {
        attachmentId: world.identity,
        cameraEntity: world === worlds[camera.worldId ?? 0] ? (camera.entityKey ?? 0) : 0,
        viewRole: 'main',
        viewGeneration: camera.historyVersion ?? 0,
      },
      slot: { primitiveSlot: slot?.slot ?? 0, slotGeneration: slot?.generation ?? 0 },
      generation: frameId,
      count: { candidates: candidateCount, visible, occluded: candidateCount - visible },
      lodHistogram: [{ level: 0, count: candidateCount }],
      queryLatencyUs: { median: 0, p95: 0, last: 0 },
      pagePressure: query,
      fallback,
      degradation,
      samples: samples.map((candidate, index) => ({
        primitiveSlot:
          slots.get(
            worldEntityKey(worldKeys[candidate.worldId] ?? candidate.worldId, candidate.entityKey),
          )?.slot ?? index,
        level: 0,
        visible: submitted.has(candidate),
      })),
    };
    result.push(
      Object.freeze({
        attachmentId: world.identity,
        rows: Object.freeze([row]),
        attribution,
      }),
    );
  }
  return Object.freeze(
    result.sort((left, right) => left.attachmentId.localeCompare(right.attachmentId)),
  );
}

type TimingSessionHost = RenderSystemInternals & {
  gpuPassTimingSession?: GpuPassTimingSession | undefined;
  gpuPassTimingCapture?: GpuPassTimingCapture | undefined;
  gpuPassTimingFrameIdentity?: GpuPassTimingFrameIdentity | undefined;
  gpuPassTimingBeginReason?: GpuPassTimingReason | undefined;
};

/** Attach the Render-owned timing session without widening the public renderer surface. */
export function attachGpuPassTimingSession(
  internals: object,
  session: GpuPassTimingSession | undefined,
): void {
  (internals as TimingSessionHost).gpuPassTimingSession = session;
}

export type {
  _InternalRenderPipelineContext,
  _StandardForwardSceneView,
  PerPassResources,
  PipelineState,
  RenderSystemInternals,
  RenderSystemRuntime,
  SurfaceBackendKind,
  SurfaceCapabilityFacts,
  SurfaceProfile,
  SwapChainFormatPair,
} from './record/render-context';
export {
  configureSurface,
  MATERIAL_PER_ENTITY_STRIDE,
  resolveSurfaceFormatPair,
  resolveSurfaceProfile,
  STANDARD_PBR_UBO_SIZE,
  selectSwapChainFormat,
} from './record/render-context';

export type RendererProducerRootKind =
  | 'backend-surface'
  | 'shader-material-pipeline'
  | 'mesh-texture-sampler'
  | 'render-scene'
  | 'gpu-driven'
  | 'feature'
  | 'external-source'
  | 'render-graph'
  | 'target-history'
  | 'observation-lease';

export interface RendererProducerRoot {
  readonly kind: RendererProducerRootKind;
  readonly owner: string;
  readonly candidateScope: 'device-scope';
  readonly visibility: 'visible-workset' | 'non-visible-lazy';
  readonly disabledWork: 'zero' | 'lazy';
}

/** Device-bound post-process resources prepared off to the side of the active renderer. */
export interface RecoveryPostProcessResources {
  readonly device: RhiDevice;
  readonly paramsBuffers: Map<string, Buffer>;
}

const PRODUCER_ROOT_MATRIX: readonly RendererProducerRoot[] = Object.freeze([
  {
    kind: 'backend-surface',
    owner: 'backend-surface-owner',
    candidateScope: 'device-scope',
    visibility: 'visible-workset',
    disabledWork: 'zero',
  },
  {
    kind: 'shader-material-pipeline',
    owner: 'shader-material-pipeline-owner',
    candidateScope: 'device-scope',
    visibility: 'visible-workset',
    disabledWork: 'zero',
  },
  {
    kind: 'mesh-texture-sampler',
    owner: 'gpu-residency',
    candidateScope: 'device-scope',
    visibility: 'visible-workset',
    disabledWork: 'lazy',
  },
  {
    kind: 'render-scene',
    owner: 'persistent-render-scene',
    candidateScope: 'device-scope',
    visibility: 'visible-workset',
    disabledWork: 'zero',
  },
  {
    kind: 'gpu-driven',
    owner: 'gpu-driven-production',
    candidateScope: 'device-scope',
    visibility: 'visible-workset',
    disabledWork: 'zero',
  },
  {
    kind: 'feature',
    owner: 'render-feature-host',
    candidateScope: 'device-scope',
    visibility: 'visible-workset',
    disabledWork: 'lazy',
  },
  {
    kind: 'external-source',
    owner: 'external-source-owner',
    candidateScope: 'device-scope',
    visibility: 'non-visible-lazy',
    disabledWork: 'zero',
  },
  {
    kind: 'render-graph',
    owner: 'typed-frame-graph',
    candidateScope: 'device-scope',
    visibility: 'visible-workset',
    disabledWork: 'zero',
  },
  {
    kind: 'target-history',
    owner: 'temporal-target-owner',
    candidateScope: 'device-scope',
    visibility: 'visible-workset',
    disabledWork: 'zero',
  },
  {
    kind: 'observation-lease',
    owner: 'render-observation-owner',
    candidateScope: 'device-scope',
    visibility: 'non-visible-lazy',
    disabledWork: 'zero',
  },
]);

export function createRendererProducerRootMatrix(): readonly RendererProducerRoot[] {
  return PRODUCER_ROOT_MATRIX;
}

/**
 * Production-owned recovery facts. These values are projections of the live
 * RenderSystem owners; they are not a test ledger or a second graph model.
 */
export interface RecoveryProductionEvidence {
  readonly producerRoots: readonly RendererProducerRoot[];
  readonly graph: {
    readonly ready: boolean;
    readonly generation: number;
    readonly passCount: number;
    readonly resourceCount: number;
  };
  readonly residency: { readonly meshResidencyEpoch: number };
  readonly submissions: {
    readonly count: number;
    readonly lastGeneration: number | undefined;
  };
}

/**
 * Unified transparent-queue sub-sort covering all four
 * {@link TransparentSortConfig} modes. Reorders the
 * `queue === RenderQueue.Transparent` segment of the dispatch list;
 * all other queue segments keep their relative order.
 *
 * | mode | primary key | secondary key | tertiary key |
 * |:--:|:--|:--|:--|
 * | 0 (LAYER_Z)   | `layer` ASC | `posZ` ASC | `materialHandle` ASC |
 * | 1 (LAYER_Y)   | `layer` ASC | `-(posY - pivotY * sizeY)` ASC | `materialHandle` ASC |
 * | 2 (LAYER_YZ)  | `layer` ASC | `(posY - pivotY * sizeY) + yzAlpha * posZ` ASC | `materialHandle` ASC |
 * | 3 (DISTANCE)  | `-(dist² from camera)` ASC (back-to-front, layer ignored) | — |
 *
 * The `materialHandle` tertiary key for modes 0/1/2 groups same-material
 * entries together whenever the primary+secondary sort values are equal
 * (e.g. tilemap tiles in the same row/layer share `posY` in LAYER_Y mode).
 * Consecutive same-material groups then collapse into fold buckets in the
 * record-stage fold operator, significantly reducing draw call count for
 * tilemap-heavy scenes.
 *
 * `posX/Y/Z` = translation column of the entity's world mat4 (indices 12/13/14).
 * `pivotY` = `RenderableSnapshot.material.paramSnapshot.pivotAndSize[1]` (default 0.5).
 * `sizeY`  = length of the Y-axis column of the world mat4 (indices 4/5/6).
 */
function sortTransparentDispatch(
  dispatch: DispatchEntry[],
  world: World,
  cameras: readonly CameraSnapshot[],
  renderables: readonly RenderableSnapshot[],
): DispatchEntry[] {
  const cfg = getTransparentSortConfig(world);
  const mode = cfg.mode;

  // Indices of Transparent-queue entries within the dispatch list.
  const transparentSlots: number[] = [];
  for (let i = 0; i < dispatch.length; i++) {
    if (dispatch[i]?.queue === RenderQueue.Transparent) transparentSlots.push(i);
  }
  if (transparentSlots.length <= 1) return dispatch;

  let sortedSlotOrder: number[];

  if (mode === TRANSPARENT_SORT_MODE_DISTANCE) {
    const camera = cameras[0];
    if (camera === undefined) return dispatch;
    const camPos = camera.position;

    // Squared camera distance per entry (negated → ascending = back-to-front).
    // D-3: world position = translation column of GlobalTransform.world (m[12,13,14]).
    const negDistSq = (entry: DispatchEntry): number => {
      const tx = renderables[entry.renderableIndex]?.transform;
      if (tx === undefined) return 0;
      const w = tx.world;
      const dx = (w[12] ?? 0) - (camPos[0] ?? 0);
      const dy = (w[13] ?? 0) - (camPos[1] ?? 0);
      const dz = (w[14] ?? 0) - (camPos[2] ?? 0);
      return -(dx * dx + dy * dy + dz * dz);
    };

    sortedSlotOrder = transparentSlots.slice().sort((a, b) => {
      const da = negDistSq(dispatch[a] as DispatchEntry);
      const db = negDistSq(dispatch[b] as DispatchEntry);
      if (da < db) return -1;
      if (da > db) return 1;
      return 0;
    });
  } else {
    // Modes 0/1/2: primary = layer ASC, secondary = mode-formula ASC.
    // sizeY = length of the Y-axis column (col1 = indices 4,5,6) of the
    // world mat4; rotation-invariant and handles flipV sign correctly.
    const sortVal = (entry: DispatchEntry): number => {
      const tx = renderables[entry.renderableIndex]?.transform;
      const w = tx?.world;
      const posY = (w?.[13] ?? 0) as number;
      const posZ = (w?.[14] ?? 0) as number;
      if (mode === TRANSPARENT_SORT_MODE_LAYER_Z) return posZ;
      const mat = renderables[entry.renderableIndex]?.material;
      // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w15: post
      // SpriteFieldsSnapshot ablation, pivot lives in paramSnapshot
      // .pivotAndSize[0..1] (UBO-aligned vec4 slot 2, plan D-6). Non-sprite
      // materials carry paramSnapshot=undefined and fall back to 0.5.
      const pivotAndSize = mat?.paramSnapshot?.pivotAndSize as readonly number[] | undefined;
      const pivotY = (pivotAndSize?.[1] ?? 0.5) as number;
      const wy4 = (w?.[4] ?? 0) as number;
      const wy5 = (w?.[5] ?? 1) as number;
      const wy6 = (w?.[6] ?? 0) as number;
      const sizeY = Math.sqrt(wy4 * wy4 + wy5 * wy5 + wy6 * wy6);
      const footY = posY - pivotY * sizeY;
      if (mode === TRANSPARENT_SORT_MODE_LAYER_Y) return -footY;
      if (mode === TRANSPARENT_SORT_MODE_LAYER_YZ) return footY + cfg.yzAlpha * posZ;
      // Defensive fallback for an unknown mode that slips past setTransparentSortConfig.
      return posZ;
    };

    sortedSlotOrder = transparentSlots.slice().sort((a, b) => {
      const da = dispatch[a] as DispatchEntry;
      const db = dispatch[b] as DispatchEntry;
      const la = da.layer;
      const lb = db.layer;
      if (la !== lb) return la - lb;
      const va = sortVal(da);
      const vb = sortVal(db);
      if (va < vb) return -1;
      if (va > vb) return 1;
      // Tertiary tiebreaker: group same-materialHandle entries together so
      // fold-eligible consecutive runs form. Entries at equal (layer,
      // sortVal) — e.g. tilemap tiles in the same row under LAYER_Y — are
      // depth-equivalent; reordering them by material does not change the
      // visual result but maximises fold-bucket width.
      return da.materialHandle - db.materialHandle;
    });
  }

  // Scatter the reordered Transparent entries back into their original slots.
  const result = dispatch.slice();
  for (let k = 0; k < transparentSlots.length; k++) {
    const targetSlot = transparentSlots[k] as number;
    const sourceSlot = sortedSlotOrder[k] as number;
    result[targetSlot] = dispatch[sourceSlot] as DispatchEntry;
  }
  return result;
}

/**
 * Engine-internal Extract / Prepare / Record driver; constructed by createRenderer.
 *
 * w15 M5 dual-pipeline dispatch: `pipelineDispatchCounts` surfaces per-frame
 * counters of how many entities were routed to each pipeline (plan-strategy
 * D-P4 / requirements AC-07). The counts roll over monotonically — test
 * callers read them after `draw([world], { cameraOwner: 0, resourceOwner: 0 })` to assert each tag saw >= 1 draw.
 * Reset is intentional on every `draw([world], { cameraOwner: 0, resourceOwner: 0 })` entry so per-frame assertions
 * stay local (charter proposition 4 explicit failure: test code sees exact
 * per-draw counts, not stale cross-frame totals).
 *
 * bug-20260519: BUILTIN cube migrated to 12F so the legacy `unlitBuiltin`
 * counter is gone; the surface collapses to `unlit` (every entity whose
 * shader identity is `forgeax::default-unlit`) + `standard` (every entity
 * whose shader identity is `forgeax::default-standard-pbr`).
 */
export interface RenderSystem {
  /** Returns true only when this invocation reached queue submission. */
  draw(
    worlds: readonly World[],
    opts: DrawOwnerOptions,
    renderReadLeases?: readonly RenderReadLease[],
    timingCapture?: GpuTimingCapture,
  ): boolean;
  /**
   * Return the asset binding consumed by the last successful record pass.
   * Dynamic geometry uses this renderer-owned frame fact as its publication
   * barrier; ECS component presence alone is not a draw receipt.
   */
  isDynamicGeometryConsumed(world: World, entity: number, meshHandle: number | undefined): boolean;
  invalidateGeometryHistory(): void;
  /** Prepare a detached graph candidate without entering the frame record path. */
  prepareRecoveryGraphCandidate(
    runtime: RecoveryGraphCandidateRuntime,
  ): Promise<RecoveryGraphCandidatePreparation>;
  /** Finish and submit detached candidate setup, never a frame receipt. */
  submitCandidateSetup(
    candidate: RecoveryGraphCandidate,
    isValid: () => boolean,
  ): Result<RecoveryGraphSetupSubmission, RhiError>;
  /** Publish a detached graph candidate at the generation publication boundary. */
  publishRecoveryGraphCandidate(candidate: RecoveryGraphCandidate): void;
  /** Discard a detached graph candidate that did not reach publication. */
  discardRecoveryGraphCandidate(candidate: RecoveryGraphCandidate): void;
  /** Release renderer-owned persistent state for one detached World. */
  detachScene(world: World): void;
  /** Release the profiler catalog contribution owned by this RenderSystem. */
  releaseProfilerCatalog(): void;
  observeCurrentFrame(
    options: FrameObservationOptions,
  ): Promise<Result<FrameObservation, ObservationUnavailableError>>;
  /** Resolve the renderer-owned GPU LOD counters for the last accepted submit. */
  observeLodOcclusion(): Promise<void>;
  /** Internal same-frame graph target access for backend diagnostics. */
  getCurrentGraphTarget(name: string): CurrentGraphTarget | undefined;
  /** Internal test capture copied into the draw's command submission. */
  requestGraphTargetCapture(request: GraphTargetCaptureRequest): void;
  readonly pipelineDispatchCounts: {
    readonly unlit: number;
  };
  /** Detached residency and upload facts for explicit instance collections. */
  readonly instanceCollectionsInspection: readonly InstanceCollectionInspection[];
  /**
   * feat-20260528-frustum-culling M5 / w14: per-frame frustum-culling counters.
   * Updated by `draw([world], { cameraOwner: 0, resourceOwner: 0 })` on every call from the Extract stage.
   */
  readonly frustumStats: { culled: number; total: number };
  /** Per-frame candidate entities rejected by author visibility. */
  readonly visibilityStats: { explicitlyHidden: number };
  /** Persistent scene maintenance evidence from the ordinary single-World path. */
  readonly renderScene: RenderSceneInspection;
  readonly reflectionProbes: ReflectionProbeInspection;
  /** Live producer/RHI/temporal receipts projected through SSR admission. */
  readonly ssrDependencies: SsrDependenciesInspection;
  /** Producer completion fence included in the public FrameReceipt. */
  readonly reflectionFallbackCompletion: Promise<void> | undefined;
  /** True while a progressive CubeCamera candidate still owns unfinished faces. */
  isCubeCapturePending(target: RenderTarget): boolean;
  readonly environment: EnvironmentInspection;
  readonly temporal: TemporalInspection;
  readonly bloom: BloomInspection;
  readonly motionBlurInspection: MotionBlurInspection | undefined;
  readonly temporalTargetInspection: TemporalTargetInspection | undefined;
  readonly lodOcclusionInspection: LodOcclusionInspection | undefined;
  /** Bounded GPU-driven counters without materializing the persistent scene table. */
  readonly gpuDrivenInspection: GpuDrivenProductionInspection;
  /** Last completed transmission candidate facts, detached from GPU handles. */
  readonly transmission: TransmissionInspection | undefined;
  /** Single production projection of Directional author/extract/record facts. */
  readonly directionalShadow: DirectionalShadowInspection;
  /** Last prepared Standard transport facts, detached from GPU handles. */
  readonly standardLightingInspection: StandardLightingInspection | undefined;
  /** Last submitted point-shadow atlas budget facts, detached from GPU handles. */
  readonly pointShadowInspection: PointShadowInspection | undefined;
  /** Retained Points/Lines authoring facts from the single scene projection. */
  readonly pointsLinesSnapshots: readonly PointsLinesRetainedSnapshot[];
  /** Current mesh-slot provenance and active diagnostics from the last frame. */
  readonly meshMaterialBindings: readonly MeshMaterialBindingObservation[];
  /** Final-submit IBL binding-chain receipt for the last diagnostic frame. */
  readonly iblBinding: import('./mesh-material-bindings').IblBindingInspection | undefined;
  /**
   * feat-20260531-bloom-first-declarative-render-graph-pass M4 fix-up w19:
   * per-frame render-graph pass names in declaration order. Empty array
   * before the first `draw([world], { cameraOwner: 0, resourceOwner: 0 })` call; populated after the per-frame
   * graph is built (lazily on first draw). Read-only introspection surface
   * so smoke tests can assert the declarative pass chain is wired without
   * reaching into engine internals.
   */
  readonly perFramePassNames: readonly string[];
  /** Camera antialias mode for the last successfully submitted frame. */
  readonly lastSuccessfulCameraAntialias: CameraSnapshot['antialias'] | undefined;
  /** Detached compiled-graph facts used by the renderer inspection owner. */
  readonly perFrameGraphInfo: CompiledRenderGraphInfo | undefined;
  /** Production-owner recovery facts used by Renderer.inspect(). */
  readonly recoveryEvidence: RecoveryProductionEvidence;
  /**
   * feat-20260531-per-frame-bind-group-cache M1 / w4: per-frame
   * createBindGroup counter. Reset to 0 on every `draw([world], { cameraOwner: 0, resourceOwner: 0 })` entry,
   * bumped on each cache-miss createBindGroup call in the record stage.
   * Aligns with pipelineDispatchCounts precedent: closure-mutable object
   * + draw-entry reset + readonly getter. Stable-frame AC-03 asserts
   * createBindGroup == 0 when all bind groups are cache-resident.
   *
   * M5 / w19 type-safe finalization: the return type is purposely the
   * narrowest inline object literal `{ readonly createBindGroup: number }`
   * rather than a wider Record/alias — this ensures TS language service
   * hover shows the exact field name + type, and AC-09 consumption sites
   * infer `number` without `as` casts (plan-strategy D-7 + sec.8
   * discoverability).
   */
  readonly bindGroupCounts: {
    readonly createBindGroup: number;
    readonly keys: readonly string[];
  };
  /** Latest accepted-submit temporal POD; absent until the first accepted frame. */
  readonly temporalFrame: TemporalFrame | undefined;
  /** Current renderer-owned volumetric fog inspection snapshot. */
  readonly volumetricFog: import('./volume/inspection').VolumetricFogInspection;
  /** Configure the sole Standard graph owner before the first frame. */
  configureStandard(config: RenderPipelineAsset['config']): void;
  /** Register one engine-owned post-process shader used by the Standard lane. */
  registerBuiltinPostProcess(id: string, entry: PostProcessShaderEntry): () => void;
  /** Resolve one active built-in post-process declaration for a detached candidate. */
  readonly lookupPostProcess: (id: string) => PostProcessShaderEntry | undefined;
  /**
   * feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M5 / w21:
   * release the per-RenderSystem frame-state GPU bookkeeping during
   * `Renderer.dispose()`. Retires the compiled graph and clears the instance-buffer cache.
   *
   * Idempotent (architecture-principles §6): a second call after both
   * structures are cleared is a no-op. Per-step failures inside drain /
   * disposeInstanceBuffers fall through silently -- the Renderer.dispose
   * cascade owns the try/catch + errorRegistry.fire fan-out (D-3).
   */
  disposeFrameState(): void;

  /**
   * feat-20260622-s5 M3 / B-2 / w18: drop the device-bound state the recover()
   * rebuild must shed before re-running the pipeline build against a fresh
   * device. Two effects, both keyed to the lost device:
   *   1. the per-frame render-graph's pendingDestroy queue (PooledTextures
   *      minted by the lost device — clearPendingDestroy skips destroyTexture);
   *   2. post-process declarations + their eager param UBOs. Declarations are
   *      CPU-owned author intent and survive; UBOs are stale lost-device
   *      handles and are rebuilt after the replacement device is live.
   * Idempotent and graph-optional (no-op when nothing has compiled yet).
   */
  resetForRecover(retiringPipelineState?: PipelineState, replacementDevice?: RhiDevice): void;
  /** Build post-process parameter buffers without mutating the active bundle. */
  prepareRecoveryPostProcessResources(
    device: RhiDevice,
  ): Result<RecoveryPostProcessResources, RhiError>;
  /** Publish a previously prepared post-process bundle at the recovery boundary. */
  publishRecoveryPostProcessResources(candidate: RecoveryPostProcessResources): void;
  /** Release a candidate bundle that was never published. */
  discardRecoveryPostProcessResources(candidate: RecoveryPostProcessResources): void;
  /** Recreate post-process GPU parameter resources after a device rebuild. */
  restorePostProcessResources(): void;
  /** Build candidate roots from explicit candidate-owned device state. */
  prepareRecoveryRoots(runtime: RecoveryRootRuntime): RecoveryRootBundle;
}

function isStructuredRendererError(error: unknown): error is RhiError | RenderError {
  if (!(error instanceof Error)) return false;
  const structured = error as {
    readonly code?: unknown;
    readonly expected?: unknown;
    readonly hint?: unknown;
    readonly detail?: unknown;
  };
  return (
    typeof structured.code === 'string' &&
    typeof structured.expected === 'string' &&
    typeof structured.hint === 'string' &&
    structured.detail !== undefined
  );
}

function reportPreparedGraphicsCompletionError(
  internals: RenderSystemInternals,
  error: unknown,
): void {
  if (isStructuredRendererError(error)) {
    internals.errorRegistry.fire(error);
    return;
  }
  const innerError =
    error instanceof RhiError
      ? error
      : { code: 'unknown' as const, message: String(error), name: (error as Error)?.name };
  internals.errorRegistry.fire(
    new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'prepared graphics completion cleanup reports its errors',
      hint: 'inspect detail.error for the underlying retirement or recovery failure',
      detail: { error: innerError },
    }),
  );
}

function isPendingRenderFeaturePreparation(error: RenderError): boolean {
  return (
    error.code === 'render-feature-preparation-failed' &&
    error.detail.reason.startsWith('rhi-not-available:')
  );
}

function makePreparedPipelinePendingError(): RhiError {
  return new RhiError({
    code: 'rhi-not-available',
    expected: 'prepared pipeline shader module warm-up to finish asynchronously',
    hint: 'retry the prepared graphics pass on the next frame',
  });
}

/** The single Points/Lines owner’s staged device-generation handoff. */
export interface RecoveryPointsLinesCandidate {
  createRecoveryRoot(scope: DeviceScope): LifecycleResourceSpec<unknown>;
  publish(): void;
  release(): void;
}

function preparationFailureFrom(error: unknown): MeshMaterialBindingPreparationFailure | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = error as {
    readonly code?: unknown;
    readonly expected?: unknown;
    readonly hint?: unknown;
    readonly detail?: unknown;
  };
  if (
    typeof value.code !== 'string' ||
    typeof value.expected !== 'string' ||
    typeof value.hint !== 'string'
  ) {
    return undefined;
  }
  const detail =
    typeof value.detail === 'object' && value.detail !== null
      ? { ...(value.detail as Record<string, unknown>) }
      : undefined;
  return {
    code: value.code,
    expected: value.expected,
    hint: value.hint,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Candidate-only device/runtime inputs used by the recovery prepare seam. */
export interface RecoveryGraphCandidateRuntime {
  readonly internals: RenderSystemInternals;
  readonly pipelineState: PipelineState;
}

/** Detached graph state prepared on a replacement device, before publication. */
export interface RecoveryGraphCandidate {
  readonly frameState: RenderFrameState;
  readonly setupWorks: readonly MipmapEncoderWork[];
  readonly device: RhiDevice;
  readonly generation: number;
  readonly gpuDrivenProduction?: GpuDrivenProduction;
  readonly gpuDrivenScene?: PersistentGpuDrivenCandidate;
  /** Staged CPU-expanded Points/Lines buffers owned by the same RenderSystem. */
  readonly pointsLines?: RecoveryPointsLinesCandidate;
  readonly featureHost?: RenderFeatureHost;
  readonly featureGpuWork?: RenderFeatureGpuWorkOwner;
  readonly featureGraphCandidate?: RenderFeatureGraphCandidate;
  readonly postProcessPipelines?: ReadonlyMap<string, RenderPipeline>;
  readonly recoveryReadiness: RecoveryPipelineReadiness;
  /** Release all candidate roots before publication; safe to call repeatedly. */
  readonly release: () => void;
  /** Transfer candidate-root ownership to the published RenderSystem. */
  readonly markPublished: () => void;
}

/** Candidate setup completion; completion is bounded by the recovery owner. */
export interface RecoveryGraphSetupSubmission {
  readonly completion?: PromiseLike<unknown>;
}

export type RecoveryGraphCandidatePreparation =
  | { readonly kind: 'no-seed' }
  | { readonly kind: 'ready'; readonly candidate: RecoveryGraphCandidate }
  | { readonly kind: 'failed'; readonly reason: string; readonly cause?: unknown };

/** Explicit candidate-owned inputs for lifecycle-root preparation. */
export interface RecoveryRootRuntime {
  readonly scope: DeviceScope;
  readonly device: RhiDevice;
  readonly gpuStore: GpuResidencyCache;
  readonly graphCandidate?: RecoveryGraphCandidate | undefined;
}

/** Candidate roots plus the one synchronous owner switch at publication. */
export interface RecoveryRootBundle {
  readonly roots: readonly LifecycleResourceSpec<unknown>[];
  publish(): void;
  discard(): void;
}

/**
 * Project the producer-owned material and GPU store state into the one
 * renderer observation surface. This is intentionally recomputed from the
 * current frame's detached material snapshots; no readiness map is retained
 * by RenderSystem. A producer failure with an already resident resource is
 * reported as last-known-good, preserving recovery context without copying
 * the producer's lifecycle state.
 */
function observeMaterialResidency(
  world: World | undefined,
  material: MaterialSnapshot,
  internals: RenderSystemInternals,
): MeshMaterialBindingResidency {
  const textures: Array<{ readonly handle: number; readonly mipLevelCount: number }> = [];
  const samplers: Array<{ readonly handle: number; readonly resident: boolean }> = [];
  let pending = false;
  let resident = false;
  let failure: MeshMaterialBindingPreparationFailure | undefined;
  const keepFailure = (error: unknown): void => {
    if (failure === undefined) failure = preparationFailureFrom(error);
  };

  if (world === undefined) {
    pending = true;
  } else {
    const materialHandle = material.materialHandle;
    if (materialHandle !== undefined && materialHandle !== 0) {
      const materialResult = resolveAssetHandle<MaterialAsset>(
        world,
        toShared<'MaterialAsset'>(materialHandle),
      );
      if (!materialResult.ok) {
        keepFailure(materialResult.error);
      } else {
        const guid = internals.assets.guidOf(materialResult.value);
        if (guid !== undefined) {
          const readiness = internals.assets.getMaterialReadiness(guid);
          if (readiness?.status === 'Error') keepFailure(readiness.error);
          const load = internals.assets.loadState.get(guid);
          if (load?.status === 'provisional') pending = true;
        }
      }
    }

    for (const handle of materialTextureHandles(material)) {
      const existing = internals.gpuStore.getTextureGpuView(handle, world);
      const pod = resolveAssetHandle<TextureAsset>(world, handle);
      if (!pod.ok) {
        keepFailure(pod.error);
        continue;
      }
      let view = existing;
      if (view === undefined) {
        const prepared = internals.gpuStore.ensureResident(handle, pod.value, world);
        if (!prepared.ok) keepFailure(prepared.error);
        view = internals.gpuStore.getTextureGpuView(handle, world);
      }
      if (view === undefined) {
        pending = failure === undefined;
        continue;
      }
      const textureLayout = deriveTextureLayout({
        shape: pod.value.shape,
        format: pod.value.format,
        mips: pod.value.mips,
      });
      if (!textureLayout.ok) {
        keepFailure(textureLayout.error);
        continue;
      }
      resident = true;
      textures.push({
        handle: Number(handle),
        mipLevelCount: Math.max(1, textureLayout.value.levels.length),
      });
    }

    for (const handle of materialSamplerHandles(material)) {
      const pod = resolveAssetHandle<SamplerAsset>(world, handle);
      if (!pod.ok) {
        keepFailure(pod.error);
        samplers.push({ handle: Number(handle), resident: false });
        continue;
      }
      const prepared = internals.gpuStore.ensureSamplerResident(handle, pod.value, world);
      if (!prepared.ok) {
        keepFailure(prepared.error);
        samplers.push({ handle: Number(handle), resident: false });
      } else {
        resident = true;
        samplers.push({ handle: Number(handle), resident: true });
      }
    }
    // Video views are supplied by the dynamic host store at record time. They
    // are not static TextureAsset residents, so this bounded projection stays
    // pending until a dynamic observation contract exists rather than guessing
    // from the VideoAsset GUID.
    if ((material.videoTextureFields?.size ?? 0) > 0) pending = true;
  }

  const readiness =
    failure === undefined
      ? pending
        ? 'pending'
        : 'ready'
      : resident
        ? 'last-known-good'
        : 'failed';
  return {
    readiness,
    samplers,
    textures,
    ...(failure === undefined ? {} : { preparationFailure: failure }),
  };
}

export function createRenderSystem(internals: RenderSystemInternals): RenderSystem {
  const phaseCatalogRegistration = internals.profiler?.registerPhaseCatalog(
    'render',
    RENDER_PHASE_CATALOG,
  );
  let releaseProfilerCatalog =
    phaseCatalogRegistration?.ok === true ? phaseCatalogRegistration.value : undefined;
  let preparedWorlds: readonly World[] = [];
  let lastSubmittedDynamicGeometryBindings = new WeakMap<World, ReadonlyMap<number, number>>();
  let latestCamera: CameraSnapshot | undefined;
  const pointsLinesOwner = new StandardPointsLinesOwner(internals);
  const instanceCollections = new InstanceProjectionStore();
  const reflectionProbeOwner = new ReflectionProbeRecordOwner(internals);
  let ssrFormatReceipt: import('@forgeax/engine-rhi').RhiTextureFormatCapabilityReceipt | undefined;
  let ssrFormatProbeGeneration = -1;
  let ssrFormatProbe: Promise<void> | undefined;
  let ssrFallbackGeneration: number | undefined;
  const ensureSsrFormatProbe = (): void => {
    if (internals.ssrIdentity === undefined) return;
    const generation = internals.deviceScope.generation;
    if (
      ssrFormatReceipt?.deviceGeneration === generation ||
      ssrFormatProbeGeneration === generation ||
      ssrFormatProbe !== undefined ||
      typeof internals.device.probeTextureFormatCapability !== 'function'
    ) {
      return;
    }
    ssrFormatProbeGeneration = generation;
    const device = internals.device;
    ssrFormatProbe = device
      .probeTextureFormatCapability()
      .then((result) => {
        if (internals.device !== device || internals.deviceScope.generation !== generation) return;
        ssrFormatReceipt = result.ok ? result.value : undefined;
      })
      .catch(() => {
        if (internals.device === device && internals.deviceScope.generation === generation) {
          ssrFormatReceipt = undefined;
        }
      })
      .finally(() => {
        ssrFormatProbe = undefined;
      });
  };
  const cubeCaptureScheduler = createCubeCaptureScheduler({ maxFacesPerFrame: 1 });
  const cubeCaptureState: CubeCaptureGraphState = { work: [] };
  const persistentRenderScene = new PersistentRenderScene({
    getDevice: () => internals.device,
    onGpuError: (error) => internals.errorRegistry.fire(error),
    onSharedRefMutation: (worldId, handle) => {
      internals.gpuStore.invalidateMesh(handle, preparedWorlds[worldId] ?? worldId);
    },
    instanceCollections,
    getSkinPaletteAllocator: () => internals.getPipelineState()?.skinPaletteAllocator ?? null,
  });
  let environmentLifecycle = new EnvironmentLifecycle(internals.deviceScope);
  const transmissionAdmission = new TransmissionCandidateAdmission();
  let lastTransmissionInspection: TransmissionInspection | undefined;
  let lastTransmissionKey = '';
  let lastTransmissionAntialias: CameraSnapshot['antialias'] = 'none';
  let transmissionCapabilityGeneration = -1;
  let transmissionCapability:
    | import('./transmission/backdrop').TransmissionCapabilityFacts
    | undefined;
  const prepareTransmissionCandidate = (antialias: CameraSnapshot['antialias']): boolean => {
    const demand = persistentRenderScene.transmissionTopologyDemand();
    if (demand.activeCount === 0) return true;
    const topology = resolveTransmissionBackdropTopology({
      demand,
      sourceSampleCount: antialias === 'msaa' ? 4 : 1,
    });
    if (transmissionCapabilityGeneration !== internals.deviceScope.generation) {
      transmissionCapability = probeTransmissionCapability(internals.device);
      transmissionCapabilityGeneration = internals.deviceScope.generation;
    }
    if (transmissionCapability === undefined) {
      throw new Error('transmission capability probe did not produce a result');
    }
    const capability = {
      ...transmissionCapability,
      msaaResolve: antialias === 'msaa' || topology.sourceSampleCount === 1,
    } as const;
    const verdict = evaluateTransmissionCapability(capability);
    if (verdict.ok) return true;

    const extent = {
      width: Math.max(1, internals.canvas.width),
      height: Math.max(1, internals.canvas.height),
    };
    const resource = {
      extent,
      format: capability.format,
      mipCount: topology.mipCount === 0 ? 1 : numMipLevels(extent),
      bytes: estimateTransmissionBackdropBytes(
        extent,
        topology.mipCount === 0 ? 1 : numMipLevels(extent),
        capability.format,
      ),
      deviceGeneration: internals.deviceScope.generation,
    } as const;
    transmissionAdmission.admit(demand, capability, resource);
    internals.errorRegistry.fire(
      new TransmissionCapabilityMissingError('standard transmission', 'prepare', {
        lane: 'standard-forward',
        format: capability.format,
        missing: verdict.missing,
      }),
    );
    return false;
  };
  const updateTransmissionInspection = (
    antialias: CameraSnapshot['antialias'],
    submitted: boolean,
  ): void => {
    lastTransmissionAntialias = antialias;
    const demand = persistentRenderScene.transmissionTopologyDemand();
    if (demand.activeCount === 0) {
      lastTransmissionInspection = undefined;
      lastTransmissionKey = '';
      return;
    }
    const extent = {
      width: Math.max(1, internals.canvas.width),
      height: Math.max(1, internals.canvas.height),
    };
    const topology = resolveTransmissionBackdropTopology({
      demand,
      sourceSampleCount: antialias === 'msaa' ? 4 : 1,
    });
    if (transmissionCapabilityGeneration !== internals.deviceScope.generation) {
      transmissionCapability = probeTransmissionCapability(internals.device);
      transmissionCapabilityGeneration = internals.deviceScope.generation;
    }
    if (transmissionCapability === undefined) {
      throw new Error('transmission capability probe did not produce a result');
    }
    const resource = {
      extent,
      format: 'rgba16float',
      mipCount: topology.mipCount === 0 ? 1 : numMipLevels(extent),
      bytes: estimateTransmissionBackdropBytes(
        extent,
        topology.mipCount === 0 ? 1 : numMipLevels(extent),
      ),
      deviceGeneration: internals.deviceScope.generation,
    } as const;
    const key = `${demand.activeCount}:${demand.needsRoughMips}:${extent.width}:${extent.height}:${resource.deviceGeneration}:${antialias}:${submitted}`;
    if (key === lastTransmissionKey && lastTransmissionInspection !== undefined) return;
    if (submitted) {
      transmissionAdmission.admit(
        demand,
        {
          ...transmissionCapability,
          msaaResolve: antialias === 'msaa' || topology.sourceSampleCount === 1,
        },
        resource,
      );
    }
    const admission = transmissionAdmission.inspectLifecycle();
    lastTransmissionInspection = submitted
      ? inspectTransmissionFromAdmission({
          admission,
          topology,
          extent,
          transmissionDrawCount: demand.activeCount,
        })
      : inspectTransmission({
          demand,
          topology,
          extent,
          generation: admission.generation,
          lastKnownGood: admission.lastKnownGood,
          lifecycle: admission.lifecycle,
          recovery: admission.recovery,
          capability: admission.capability,
          resourcePresent: admission.resource !== undefined,
          transmissionDrawCount: demand.activeCount,
        });
    lastTransmissionKey = key;
  };
  // GPU-driven production uses the validated adapter for normal frames. The
  // assembly-supplied closure resolves its device-bound adapter at call time,
  // so recovery candidate preparation still follows candidateShaderState
  // rather than retaining a lost-generation module.
  const gpuDrivenShaderFactory =
    internals.shaderModuleFactory ??
    internals.immediateShaderModuleFactory ??
    ({
      createShaderModule: () =>
        err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'the renderer backend exposes shader module creation',
            hint: 'construct the renderer through the backend pack before activating GPU-driven rendering',
          }),
        ),
    } satisfies import('./pipeline-builder').PipelineBuilderShaderModuleFactory);
  let gpuDrivenProduction = GpuDrivenProduction.forDevice(internals.device, gpuDrivenShaderFactory);
  let occlusionRuntime: OcclusionRenderRuntime | undefined = new OcclusionRenderRuntime(
    internals.device,
    persistentRenderScene.visibilityFacetStore(),
    gpuDrivenShaderFactory,
    persistentRenderScene.visibilityBudgetValue(),
  );
  const ensureOcclusionRuntime = (): OcclusionRenderRuntime => {
    if (occlusionRuntime === undefined) {
      occlusionRuntime = new OcclusionRenderRuntime(
        internals.device,
        persistentRenderScene.visibilityFacetStore(),
        gpuDrivenShaderFactory,
        persistentRenderScene.visibilityBudgetValue(),
      );
    }
    return occlusionRuntime;
  };
  const createFeatureGpuWorkOwner = (runtime: RenderSystemInternals): RenderFeatureGpuWorkOwner =>
    createRenderFeatureGpuWorkOwner({
      getDevice: () => runtime.device,
      getShaderModuleFactory: () =>
        runtime.shaderModuleFactory ??
        ({
          createShaderModule: () =>
            err(
              new RhiError({
                code: 'rhi-not-available',
                expected: 'the renderer backend exposes shader module creation',
                hint: 'construct the renderer through the backend pack before activating GPU features',
              }),
            ),
        } satisfies import('./pipeline-builder').PipelineBuilderShaderModuleFactory),
      getImmediateShaderModuleFactory: () =>
        runtime.immediateShaderModuleFactory ??
        runtime.shaderModuleFactory ??
        ({
          createShaderModule: () =>
            err(
              new RhiError({
                code: 'rhi-not-available',
                expected: 'the renderer backend exposes shader module creation',
                hint: 'construct the renderer through the backend pack before activating GPU features',
              }),
            ),
        } satisfies import('./pipeline-builder').PipelineBuilderShaderModuleFactory),
    });
  let featureGpuWork = createFeatureGpuWorkOwner(internals);
  const disposeFeatureGpuWork = (): void => {
    const disposed = featureGpuWork.dispose();
    if (!disposed.ok) internals.errorRegistry.fire(disposed.error);
  };
  // Per-RenderSystem frame state: closure-internal frameNumber + the
  // per-entity instance GPU buffer cache (feat-20260514 M3 / w15: the
  // record stage owns GPU storage buffer allocation for Instances entities;
  // the `instanceBuffers` map is keyed by the packed Entity u32 surfaced
  // through `InstancesSnapshot.cacheKey` and rebuilds buffers on archetype
  // version bump or byte-length change). The legacy
  // `lastFiredLimitExceededFrame` engine-side dedup field was removed in
  // feat-20260513-instanced-mesh M5 (T-M5-1 + T-M5-3); the active
  // `'limit-exceeded'` emit point is now the record stage upload path.
  //
  // feat-20260708 M1 / D-1a #1: positive-half keys are worldEntityKey(worldId,
  // cacheKey) composites. Negative-half fold-bucket keys (sprite fold) stay
  // raw (material-handle-based, cross-world collision semantically correct).
  const frameState: RenderFrameState = {
    frameNumber: 0,
    reflectionFallbackDemand: false,
    graphGeneration: 0,
    successfulTemporalFrameIndex: 0,
    lastSuccessfulBloom: 'off',
    temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
    temporalFrameInput: undefined,
    reflectionFallbackReadback: undefined,
    directionalShadowCache: null,
    directionalShadowCacheRecorded: false,
    compiledFrameGraph: null,
    compiledFrameGraphTopologyKey: null,
    compiledFrameGraphGeneration: 0,
    volumetricFogPreviousGraph: null,
    volumetricFogPreviousGraphKey: null,
    volumetricFogCandidateGraph: null,
    volumetricFogParamsBuffers: [null, null],
    volumetricFogParamsPendingSlot: null,
    volumetricFogParamsAcceptedSlot: null,
    volumetricFogAcceptedParams: undefined,
    volumetricFogPendingParams: undefined,
    volumetricFogInspection: inspectVolumetricFog({ authored: false, capability: 'available' }),
    volumetricFogAccepted: undefined,
    volumetricFogAcceptedContext: undefined,
    volumetricFogHistoryGraph: null,
    volumetricFogHistorySlot: null,
    volumetricFogHistorySignature: null,
    retiredCompiledFrameGraphs: new Set(),
    currentFrameObservationSource: undefined,
    reflectionFallbackObservationSource: undefined,
    lastSuccessfulCameraAntialias: undefined,
    temporalGpuState: undefined,
    activeTemporalGpuState: undefined,
    retiringTemporalGpuStates: new Set(),
    lastSuccessfulTemporalView: undefined,
    pendingTemporalCommit: { kind: 'none' },
    environmentGeneration: undefined,
    environmentLifecycle,
    currentDirectionalShadowView: null,
    currentSpotShadowView: null,
    instanceBuffers: new Map(),
    instanceResidency: new Map(),
    instanceBufferChunks: new Map(),
    probeBlendBuffers: new Map(),
    probeBlendRecordBufferCapacity: 0,
    morphBuffers: new Map(),
    hdrpClusterBinScratch: createClusterBinScratch(),
    hdrpClusterGridScratch: null,
    hdrpLightIndexListScratch: null,
    hdrpClusterMembership: null,
    standardLightingGraphSignature: '',
    standardLightingInspection: undefined,
    pointShadowInspection: undefined,
    transientInstanceBuffers: [],
    warnedZeroLightStandard: false,
    warnedMultiLightDirectional: false,
    // feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w19:
    // once-warn latches for >1 Skylight / >1 SkyboxBackground (names winner).
    warnedMultiSkylight: false,
    warnedMultiSkybox: false,
    warnedSkyboxTonemapNone: false,
    // feat-20260520-2d-sprite-layer-mvp M-3 / w25 (AC-18 path 4): per-
    // handle warn-once anchor for the sprite-bucket missing-texture
    // fallback. Set<number> keyed by raw Handle<TextureAsset>; never
    // cleared (charter F1 minimal surface — the per-RenderSystem lifetime
    // is the natural upper bound).
    warnedMissingBaseColorTextureHandles: new Set<number>(),
    // feat-20260527-sprite-nineslice M2 / w11 + M4 / w16 (AC-16): once-per-
    // renderable guard for the runtime `nineslice.scale-too-small` metric
    // counter (`runtime.metrics.increment(...)` in render-system-record.ts).
    warnedNineSliceScaleEntities: new Set<number>(),
    // feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w18:
    // per-handle fire-once anchor for the lazy equirect projection failure
    // (EquirectProjectionFailedError). Set<number> keyed by raw
    // Handle<EquirectAsset>; never cleared (per-RenderSystem lifetime upper bound).
    firedEquirectProjectionFailedHandles: new Set<number>(),
    // feat-20260622-handle-to-id-allocator-elimination M1 / w3: per-frame
    // bind group caches as nested WeakMap chain roots. viewBindGroupCache
    // covers main and shadow variants; meshBindGroupCache keys on inner
    // buffer handles (D-3). Roots are stable between device recoveries.
    viewBindGroupCache: new WeakMap(),
    meshBindGroupCache: new WeakMap(),
    // feat-20260622-handle-to-id-allocator-elimination M1 / w2: per-entity
    // material and instances caches (outer Map<entityKey, WeakMap>).
    materialBgPerEntity: new Map(),
    instancesBgPerEntity: new Map(),
    instancesBgShared: new WeakMap(),
    // cross-entity shared material cache (outer Map<shaderId, WeakMap>).
    materialBgShared: new Map(),
    // cross-frame material assembly cache; entries are only retained when all
    // explicit texture/sampler handles resolved to resident GPU resources.
    materialBgAssemblyCache: new Map(),
    // singleton material cache (flat Map<variant, BindGroup>; D-6).
    singletonMaterialCache: new Map(),
    // post-process bind group cache (bloom / fxaa / ssao): identity-keyed
    // WeakMap chain so resize-retired transient targets rebuild automatically.
    postProcessBgCache: new WeakMap(),
    // feat-20260601-customizable-render-pipeline-seam M1 / w7: installed-pipeline state.
    // 0 = nothing installed yet (createRenderer dogfood installs the default before a
    // draw). activePipeline defaults to the built-in forward pipeline.
    installedPipelineHandle: 0,
    activePipeline: internals.standardPipeline,
    // feat-20260601 verify round 2: the standard forward pipeline installs with no config
    // (its topology is frame-invariant). Standard configuration overwrites this with the
    // resolved asset config on every swap so the active graph reads its current config.
    installedPipelineConfig: undefined,
    standardOncePerFrameFired: new Set(),
    // feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-2 (plan-strategy §D-1):
    // cube_array shadow atlas + per-frame snapshot list. Atlas is null until the
    // first frame whose extracted lights.pointShadow is non-empty (zero-shadow
    // scenes never allocate; AC-09); the snapshot list defaults to an empty
    // tuple so the typed point-shadow graph sees zero shadow lights as the
    // initial steady state.
    pointShadowAtlas: null,
    pointShadowSnapshots: [],
    // feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4 (D-1):
    // initial fold-bucket count is 0; recordFrame writes the per-frame
    // value from foldDispatchBuckets(...) before dispatch.
    lastFoldBucketCount: 0,
    // feat-20260625-spot-light-shadow-mapping M2 / w9 (D-2): empty initial spot
    // shadow snapshot list so the spotShadowDepth caster pass renders zero
    // tiles until the first frame with a castShadow spot (AC-03).
    spotShadowSnapshots: [],
  };
  let directFrameId = 0;
  let submittedFrameCount = 0;
  let lastSubmittedGeneration: number | undefined;
  let lastDirectionalShadowLights: ExtractedLights | undefined;
  let lastDirectionalShadowCandidate: 'accepted' | 'failed' = 'failed';
  let lastDirectionalShadowError: DirectionalShadowInspectionSource['error'];

  function beginProfilePhase(session: RecorderSession | undefined, phase: RenderPhase): boolean {
    if (session === undefined) return false;
    try {
      return session.beginPhase('render', phase).ok;
    } catch {
      return false;
    }
  }

  function endProfilePhase(session: RecorderSession | undefined): void {
    if (session === undefined) return;
    try {
      session.endPhase();
    } catch {
      // Profiler failures never alter rendering.
    }
  }

  function recordProfileSkip(
    session: RecorderSession | undefined,
    phase: RenderPhase,
    reason: RenderPhaseSkipReason,
  ): void {
    if (session === undefined) return;
    try {
      session.recordSkip({ source: 'render', phase, reason });
    } catch {
      // Profiler failures never alter rendering.
    }
  }

  function runProfiledRenderPhase<T>(
    session: RecorderSession | undefined,
    phase: RenderPhase,
    action: () => T,
  ): T {
    const opened = beginProfilePhase(session, phase);
    try {
      return action();
    } finally {
      if (opened) endProfilePhase(session);
    }
  }
  let lastBuiltPipelineHandle = 0;
  // Monotonic configuration epoch: bumped on every Standard configuration change to brand the
  // installed pipeline so `draw` can detect a swap and rebuild the per-frame
  // graph. Replaces the prior raw-handle brand (D-19: the pipeline configuration takes a
  // POD, no handle).
  let installEpoch = 0;
  // CPU post-process declarations are owned by the feature host and remain live
  // across recovery. Only device-bound buffers and pipelines are rebuilt here.
  // D-3 / D-8: per-shader params UBO resource table (id -> GPU Buffer).
  // Eager-created at register time when entry.params is present (byteSize >= 16,
  // defaultValue.length === byteSize); reused frame-to-frame via queue.writeBuffer.
  let postProcessParamsBuffers = new Map<string, Buffer>();
  let postProcessParamsDevice = internals.device;
  const builtinPostProcessEntries = new Map<string, PostProcessShaderEntry>();
  let activeFeaturePostProcessEntries: ReadonlyMap<string, PostProcessShaderEntry> = new Map();
  const lookupPostProcess = (id: string): PostProcessShaderEntry | undefined =>
    builtinPostProcessEntries.get(id) ?? activeFeaturePostProcessEntries.get(id);
  const invalidatePostProcessModule = (id: string): void => {
    const entry = lookupPostProcess(id);
    if (entry !== undefined) {
      internals.invalidateShaderModule?.(postProcessShaderModuleLabel(id, entry.source));
    }
  };
  // feat-20260621 M-A2 / w8: expose the eager-created per-id params UBO through
  // the narrow runtime surface so dispatchFullscreenPass can writeBuffer the
  // per-frame snapshot + bind it at group(1) binding(2).
  const getPostProcessParamsBuffer = (id: string): Buffer | undefined =>
    postProcessParamsBuffers.get(id);
  const postProcessDeclarations = (): readonly (readonly [string, PostProcessShaderEntry])[] => [
    ...builtinPostProcessEntries.entries(),
    ...activeFeaturePostProcessEntries.entries(),
  ];
  const disposePostProcessResources = (resources: RecoveryPostProcessResources): void => {
    for (const buffer of resources.paramsBuffers.values()) {
      const destroyed = resources.device.destroyBuffer(buffer);
      if (!destroyed.ok) internals.errorRegistry.fire(destroyed.error);
    }
  };
  const prepareRecoveryPostProcessResources = (
    device: RhiDevice,
  ): Result<RecoveryPostProcessResources, RhiError> => {
    const paramsBuffers = new Map<string, Buffer>();
    try {
      for (const [id, entry] of postProcessDeclarations()) {
        if (id === 'forgeax.taa-resolve') continue;
        let buffer: Buffer | undefined;
        if (entry.params !== undefined) {
          const created = device.createBuffer({
            label: `post-process-params-${id}`,
            size: entry.params.byteSize,
            usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
          });
          if (!created.ok) throw created.error;
          buffer = created.value;
          paramsBuffers.set(id, buffer);
          const written = device.queue.writeBuffer(buffer, 0, entry.params.defaultValue);
          if (!written.ok) throw written.error;
        } else if (entryHasDepthRead(entry)) {
          const created = device.createBuffer({
            label: `post-process-params-${id}`,
            size: DEPTH_MIN_PARAMS_BYTE_SIZE,
            usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
          });
          if (!created.ok) throw created.error;
          buffer = created.value;
        }
        if (buffer !== undefined) paramsBuffers.set(id, buffer);
      }
    } catch (cause) {
      disposePostProcessResources({ device, paramsBuffers });
      if (cause instanceof RhiError) return err(cause);
      return err(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'post-process recovery resources are created on the candidate device',
          hint: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }
    return ok({ device, paramsBuffers });
  };
  const publishRecoveryPostProcessResources = (candidate: RecoveryPostProcessResources): void => {
    if (candidate.paramsBuffers === postProcessParamsBuffers) return;
    const previous = { device: postProcessParamsDevice, paramsBuffers: postProcessParamsBuffers };
    postProcessParamsDevice = candidate.device;
    postProcessParamsBuffers = candidate.paramsBuffers;
    disposePostProcessResources(previous);
  };
  const discardRecoveryPostProcessResources = (candidate: RecoveryPostProcessResources): void => {
    if (candidate.paramsBuffers === postProcessParamsBuffers) {
      postProcessParamsBuffers = new Map();
      disposePostProcessResources(candidate);
      return;
    }
    disposePostProcessResources(candidate);
  };
  interface PostProcessParamsCandidate {
    readonly buffers: ReadonlyMap<string, Buffer>;
    readonly created: readonly Buffer[];
  }
  const postProcessParamsByteSize = (entry: PostProcessShaderEntry): number =>
    entry.params?.byteSize ?? (entryHasDepthRead(entry) ? DEPTH_MIN_PARAMS_BYTE_SIZE : 0);
  const destroyPostProcessParams = (buffers: readonly Buffer[]): void => {
    for (const buffer of buffers) {
      const destroyed = internals.device.destroyBuffer(buffer);
      if (!destroyed.ok) internals.errorRegistry.fire(destroyed.error);
    }
  };
  const preparePostProcessParamsResources = (
    featureEntries: ReadonlyMap<string, PostProcessShaderEntry>,
  ): Result<PostProcessParamsCandidate, RhiError> => {
    const declarations = new Map<string, PostProcessShaderEntry>([
      ...builtinPostProcessEntries.entries(),
      ...featureEntries.entries(),
    ]);
    const next = new Map<string, Buffer>();
    const allocated: Buffer[] = [];
    const discardCreated = (): void => destroyPostProcessParams(allocated);
    for (const [id, entry] of declarations) {
      if (id === 'forgeax.taa-resolve') continue;
      const byteSize = postProcessParamsByteSize(entry);
      if (byteSize === 0) continue;
      const existing = postProcessParamsBuffers.get(id);
      const accepted = lookupPostProcess(id);
      if (
        existing !== undefined &&
        accepted !== undefined &&
        postProcessShaderEntrySignature(accepted) === postProcessShaderEntrySignature(entry)
      ) {
        next.set(id, existing);
        continue;
      }
      const created = internals.device.createBuffer({
        label: `post-process-params-${id}`,
        size: byteSize,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
        mappedAtCreation: false,
      });
      if (!created.ok) {
        discardCreated();
        return err(created.error);
      }
      const buffer = created.value;
      allocated.push(buffer);
      if (entry.params !== undefined) {
        const written = internals.device.queue.writeBuffer(buffer, 0, entry.params.defaultValue);
        if (!written.ok) {
          discardCreated();
          return err(written.error);
        }
      }
      next.set(id, buffer);
    }
    return ok({ buffers: next, created: Object.freeze([...allocated]) });
  };
  const discardPostProcessParamsCandidate = (candidate: PostProcessParamsCandidate): void => {
    destroyPostProcessParams(candidate.created);
  };
  const retirePostProcessParams = (buffers: readonly Buffer[]): void => {
    if (buffers.length === 0) return;
    const release = (): void => destroyPostProcessParams(buffers);
    try {
      void internals.device.queue.onSubmittedWorkDone().then(release, release);
    } catch {
      release();
    }
  };
  const acceptPostProcessParamsCandidate = (candidate: PostProcessParamsCandidate): void => {
    const previous = [...postProcessParamsBuffers.values()];
    const next = new Set(candidate.buffers.values());
    postProcessParamsBuffers.clear();
    for (const [id, buffer] of candidate.buffers) {
      postProcessParamsBuffers.set(id, buffer);
    }
    retirePostProcessParams(previous.filter((buffer) => !next.has(buffer)));
  };
  // feat-20260609 M4 / T-10-a: post-process pipeline cache (declaration|colorFormat -> RhiRenderPipeline).
  // Solves CONCERN-1: dispatcher previously passed `pipeline=null` to
  // built.createHandle because per-frame execute closures cannot await async
  // shader compile. The cache here delegates the actual build to
  // `internals.buildPostProcessPipeline` (sync wrapper over the shared shader
  // adapter; 1-frame warmup), then memoizes by declaration identity + format.
  const postProcessPipelineCache = new Map<string, RenderPipeline>();
  const getPostProcessPipeline = (
    id: string,
    bgl: BindGroupLayout,
    colorFormat: GPUTextureFormat,
    entryOverride?: PostProcessShaderEntry,
  ): RenderPipeline | null => {
    const entry = entryOverride ?? lookupPostProcess(id);
    if (entry === undefined) return null;
    const signature = postProcessShaderEntrySignature(entry);
    const key = `${id}|${colorFormat}|${signature}`;
    const cached = postProcessPipelineCache.get(key);
    if (cached !== undefined) return cached;
    internals.recoveryColdWorkGuard?.notePipelineColdWork();
    const factory = internals.buildPostProcessPipeline;
    if (factory === undefined) return null;
    const built = factory(
      entry,
      bgl,
      colorFormat,
      postProcessShaderPipelineLabel(id, entry.source),
    );
    if (built === null) return null;
    postProcessPipelineCache.set(key, built);
    return built;
  };
  const clearPostProcessPipelineCache = (id: string): void => {
    for (const key of postProcessPipelineCache.keys()) {
      if (key.startsWith(`${id}|`)) postProcessPipelineCache.delete(key);
    }
  };
  const clearPostProcessPipelineEntry = (id: string, entry: PostProcessShaderEntry): void => {
    const suffix = `|${postProcessShaderEntrySignature(entry)}`;
    for (const key of postProcessPipelineCache.keys()) {
      if (key.startsWith(`${id}|`) && key.endsWith(suffix)) {
        postProcessPipelineCache.delete(key);
      }
    }
  };
  Object.assign(internals, {
    lookupPostProcess,
    getPostProcessParamsBuffer,
    getPostProcessPipeline,
    clearPostProcessPipelineCache,
  });
  // w15 M5 (plan-strategy D-P4 / AC-07): per-frame dispatch counters. Reset
  // on every `draw([world], { cameraOwner: 0, resourceOwner: 0 })` entry; bumped once per actual `pass.setPipeline`
  // dispatch in render-system-record.ts. Two-way split mirrors the two
  // render pipelines on PipelineState (bug-20260519: BUILTIN cube migrated
  // to 12F so `unlitBuiltin` retired): `unlit` covers every
  // unlit material, `standard` covers every PBR material.
  const dispatchCounts: { unlit: number } = {
    unlit: 0,
  };
  let lastLodOcclusionInspection: LodOcclusionInspection | undefined;
  // The GPU selector returns stable numeric World keys with its same-submit
  // counters. Keep the attachment join from that submit, rather than using
  // the current worlds[] position when the asynchronous readback completes.
  let lastLodWorldAttachments: ReadonlyMap<number, string> = new Map();
  let occlusionCandidateCache:
    | {
        readonly renderables: readonly RenderableSnapshot[];
        readonly camera: CameraSnapshot;
        readonly cameraWorldIdentity: string;
        readonly candidates: readonly OcclusionRuntimeCandidate[];
      }
    | undefined;
  let lodCandidateCountCache:
    | { readonly renderables: readonly RenderableSnapshot[]; readonly count: number }
    | undefined;
  let lodInspectionRenderablesCache:
    | {
        readonly submissionRenderables: readonly RenderableSnapshot[];
        readonly lodCandidateCount: number;
        readonly values: readonly RenderableSnapshot[];
      }
    | undefined;
  let orderedDispatchCache:
    | {
        readonly source: readonly DispatchEntry[];
        readonly world: World;
        readonly camera: readonly CameraSnapshot[];
        readonly renderables: readonly RenderableSnapshot[];
        readonly value: readonly DispatchEntry[];
      }
    | undefined;
  const applyLodSelectionTelemetry = (
    selection:
      | {
          readonly candidateCount: number;
          readonly visible: number;
          readonly occluded: number;
          readonly lodHistogram: readonly { readonly level: number; readonly count: number }[];
          readonly worldSelections?: readonly {
            readonly worldKey: number;
            readonly primitiveSlot: number;
            readonly slotGeneration: number;
            readonly candidateCount: number;
            readonly visible: number;
            readonly occluded: number;
            readonly lodHistogram: readonly { readonly level: number; readonly count: number }[];
          }[];
        }
      | undefined,
  ): void => {
    if (selection === undefined || lastLodOcclusionInspection === undefined) return;
    const inspection = lastLodOcclusionInspection;
    // The GPU readback histogram is the selector fact, while final submitted
    // counts are owned by the persistent visibility projection. Keeping the
    // projection count here excludes ordinary non-LOD geometry (for example a
    // benchmark occluder) from the LOD workload without inventing a second
    // visibility owner or mixing CPU/GPU admission decisions.
    let worlds = inspection.worlds;
    const worldSelections = selection.worldSelections;
    if (worldSelections !== undefined && worldSelections.length > 0) {
      const selectionsByAttachment = new Map<string, (typeof worldSelections)[number][]>();
      let attributionValid = true;
      for (const selected of worldSelections) {
        const attachmentId = lastLodWorldAttachments.get(selected.worldKey);
        if (attachmentId === undefined) {
          attributionValid = false;
          break;
        }
        const rows = selectionsByAttachment.get(attachmentId);
        if (rows === undefined) selectionsByAttachment.set(attachmentId, [selected]);
        else rows.push(selected);
      }
      if (attributionValid) {
        const nextWorlds = worlds.map((world) => {
          const selected = selectionsByAttachment.get(world.attachmentId);
          const baseRow = world.rows[0];
          if (selected === undefined || baseRow === undefined) {
            if (world.rows.length > 0) attributionValid = false;
            return world;
          }
          const candidateCount = selected.reduce((sum, row) => sum + row.candidateCount, 0);
          if (candidateCount !== baseRow.count.candidates) {
            attributionValid = false;
            return world;
          }
          return Object.freeze({
            ...world,
            attribution: Object.freeze({
              status: 'same-submit' as const,
              submit: inspection.submit,
            }),
            rows: Object.freeze(
              selected.map((row) => ({
                ...baseRow,
                slot: {
                  primitiveSlot: row.primitiveSlot,
                  slotGeneration: row.slotGeneration,
                },
                count: {
                  candidates: row.candidateCount,
                  visible: row.visible,
                  occluded: row.occluded,
                },
                lodHistogram: row.lodHistogram,
              })),
            ),
          });
        });
        if (attributionValid) worlds = Object.freeze(nextWorlds);
      }
    }
    lastLodOcclusionInspection = inspectLodOcclusion({
      ...inspection,
      count: {
        ...lastLodOcclusionInspection.count,
        candidates: selection.candidateCount,
        visible: selection.visible,
        occluded: selection.occluded,
      },
      lodHistogram: selection.lodHistogram,
      // Per-primitive samples are intentionally omitted until the GPU readback
      // carries stable primitive identities; the histogram is the authoritative
      // producer fact and is copied from the same GPU cull counters.
      samples: [],
      worlds,
    });
  };
  // feat-20260531-per-frame-bind-group-cache M1 / w4: per-frame
  // createBindGroup counter scaffolding. Reset on every draw([world], { cameraOwner: 0, resourceOwner: 0 }) entry,
  // bumped on cache-miss in render-system-record.ts (M2-M4 bump points).
  // Aligns with dispatchCounts precedent: closure-mutable object.
  const bindGroupCounts: { createBindGroup: number; keys: string[] } = {
    createBindGroup: 0,
    keys: [],
  };
  type PreparedResolverCaches = {
    readonly preparedPipelineIds: WeakMap<object, string>;
    readonly preparedMaterialPipelineShaders: WeakMap<object, string>;
    readonly preparedGroup0Pipelines: WeakSet<object>;
    readonly preparedViewOnlyPipelines: WeakSet<object>;
    readonly preparedRenderMaterialPipelines: WeakSet<object>;
    readonly preparedAssetHandles: WeakMap<World, Map<string, number>>;
  };
  const createPreparedResolverCaches = (): PreparedResolverCaches => ({
    preparedPipelineIds: new WeakMap(),
    preparedMaterialPipelineShaders: new WeakMap(),
    preparedGroup0Pipelines: new WeakSet(),
    preparedViewOnlyPipelines: new WeakSet(),
    preparedRenderMaterialPipelines: new WeakSet(),
    preparedAssetHandles: new WeakMap(),
  });
  const activePreparedResolverCaches = createPreparedResolverCaches();
  const preparedHandle = <Brand extends string>(
    runtime: RenderSystemInternals,
    caches: PreparedResolverCaches,
    world: World,
    guid: string,
    brand: Brand,
  ): Handle<Brand, 'shared'> | undefined => {
    let handles = caches.preparedAssetHandles.get(world);
    if (handles === undefined) {
      handles = new Map();
      caches.preparedAssetHandles.set(world, handles);
    }
    const key = `${brand}:${guid.toLowerCase()}`;
    const cached = handles.get(key);
    if (cached !== undefined) return cached as Handle<Brand, 'shared'>;
    const asset = runtime.assets.lookup(guid);
    if (asset === undefined) return undefined;
    const handle = world.allocSharedRef(brand, asset);
    handles.set(key, handle as number);
    return handle;
  };
  const preparedMaterialBindings = (
    runtime: RenderSystemInternals,
    caches: PreparedResolverCaches,
    worlds: readonly World[],
    materialShaderId: string,
    worldIndex: number,
    materialGuid: string,
    layout: BindGroupLayout,
  ) => {
    const world = worlds[worldIndex];
    const material = runtime.assets.lookup(materialGuid) as MaterialAsset | undefined;
    const pipelineState = runtime.getPipelineState();
    if (world === undefined || material?.kind !== 'material' || pipelineState === null) {
      return err(new Error('prepared material asset is unavailable'));
    }
    const schema = runtime.getParamSchema?.(materialShaderId) ?? [];
    const values = material.values ?? {};
    const derived = derive(schema);
    const fields = [...derived.textureFieldNames];
    let buffer: Buffer | undefined;
    let payloadByteLength = 0;
    if (derived.uboLayout.totalBytes > 0) {
      const payload = new Uint8Array(Math.max(16, derived.uboLayout.totalBytes));
      applyParamSnapshotToUbo(
        payload,
        schema,
        values as Readonly<Record<string, number | readonly number[]>>,
      );
      const created = runtime.device.createBuffer({
        label: `prepared-material:${materialGuid}`,
        size: payload.byteLength,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      });
      if (!created.ok) return created;
      buffer = created.value;
      payloadByteLength = payload.byteLength;
      const written = runtime.device.queue.writeBuffer(buffer, 0, payload);
      if (!written.ok) {
        runtime.device.destroyBuffer(buffer);
        return written;
      }
    }
    const textureResources: Array<{
      sampler: import('@forgeax/engine-rhi').Sampler;
      view: import('@forgeax/engine-rhi').TextureView;
    }> = [];
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index];
      const value = field === undefined ? undefined : values[field];
      const textureValue =
        typeof value === 'object' && value !== null && 'texture' in value
          ? (value as MaterialTextureValue)
          : undefined;
      let sampler = pipelineState.defaultSampler;
      if (textureValue?.sampler !== undefined) {
        const handle = preparedHandle(
          runtime,
          caches,
          world,
          String(textureValue.sampler),
          'SamplerAsset',
        );
        if (handle !== undefined) {
          const asset = resolveAssetHandle<SamplerAsset>(world, handle);
          if (asset.ok) {
            const resident = runtime.gpuStore.ensureSamplerResident(handle, asset.value, world);
            if (resident.ok) sampler = resident.value;
          }
        }
      }
      let view = pipelineState.defaultWhiteTextureView;
      if (textureValue !== undefined) {
        const handle = preparedHandle(
          runtime,
          caches,
          world,
          String(textureValue.texture),
          'TextureAsset',
        );
        if (handle !== undefined) {
          view = residentTextureView(world, runtime.gpuStore, runtime, handle) ?? view;
        }
      }
      textureResources.push({ sampler, view });
    }
    const entries: BindGroupEntry[] = [];
    let textureIndex = 0;
    for (let index = 0; index < derived.bglEntries.length; index += 1) {
      const expected = derived.bglEntries[index];
      if (expected?.buffer?.type === 'uniform' && buffer !== undefined) {
        entries.push({
          binding: expected.binding,
          resource: { kind: 'buffer', value: { buffer, size: payloadByteLength } },
        });
        continue;
      }
      const textureResource = textureResources[textureIndex];
      if (
        expected?.sampler?.type === 'filtering' &&
        derived.bglEntries[index + 1]?.texture !== undefined &&
        textureResource !== undefined
      ) {
        entries.push({
          binding: expected.binding,
          resource: { kind: 'sampler', value: textureResource.sampler },
        });
        continue;
      }
      if (expected?.texture !== undefined && textureResource !== undefined) {
        entries.push({
          binding: expected.binding,
          resource: { kind: 'textureView', value: textureResource.view },
        });
        textureIndex += 1;
        continue;
      }
      if (buffer !== undefined) runtime.device.destroyBuffer(buffer);
      return err(new Error('prepared material schema contains unsupported binding kinds'));
    }
    const fallback = pipelineState.skylightFallback;
    if (fallback === null) {
      if (buffer !== undefined) runtime.device.destroyBuffer(buffer);
      return err(new Error('prepared material skylight fallback is unavailable'));
    }
    const completeEntries = assembleMaterialWithSkylightEntries(entries, {
      irradianceView: fallback.irradianceView,
      irradianceSampler: fallback.sampler,
      prefilterView: fallback.prefilterView,
      prefilterSampler: fallback.sampler,
      brdfLutView: fallback.brdfLutView,
      brdfLutSampler: fallback.sampler,
      intensityBuffer: fallback.intensityBuffer,
    });
    const group = runtime.device.createBindGroup({ layout, entries: completeEntries });
    if (!group.ok) {
      if (buffer !== undefined) runtime.device.destroyBuffer(buffer);
      return group;
    }
    if (buffer === undefined) return group;
    return ok({
      handle: group.value,
      dynamicOffsets: [0, 0],
      release: () => runtime.device.destroyBuffer(buffer),
    });
  };
  const lastFrustumStats: { culled: number; total: number } = { culled: 0, total: 0 };
  const lastVisibilityStats: { explicitlyHidden: number } = { explicitlyHidden: 0 };
  let lastMeshMaterialBindings: readonly MeshMaterialBindingObservation[] = [];
  let lastMeshMaterialBindingFrame: ExtractedFrame | undefined;
  const createPreparedResolverFactory =
    (
      runtime: RenderSystemInternals,
      gpuWork: RenderFeatureGpuWorkOwner,
      worlds: readonly World[],
      caches: PreparedResolverCaches,
    ) =>
    (input: RenderFeaturePreparedGraphicsResolverInput): PreparedGraphicsResolver => {
      const {
        preparedPipelineIds,
        preparedMaterialPipelineShaders,
        preparedGroup0Pipelines,
        preparedViewOnlyPipelines,
        preparedRenderMaterialPipelines,
      } = caches;
      return createPreparedGraphicsResolver({
        device: runtime.device,
        featureIdentity: input.featureIdentity,
        generation: input.generation,
        capabilityAvailable: true,
        featureOrder: input.order,
        lookup: input.lookup,
        resolveGpuBuffer: (reference) => gpuWork.resolveBuffer(input.featureIdentity, reference),
        resolvePipeline: (descriptor) => {
          const postProcessEntry =
            input.fullscreenEffects.get(descriptor.shader) ??
            builtinPostProcessEntries.get(descriptor.shader);
          if (postProcessEntry !== undefined) {
            const fullscreen = buildFullscreenPostProcessPass(
              { device: runtime.device, errorRegistry: runtime.errorRegistry },
              postProcessEntry,
            );
            if (fullscreen === null) return err(new Error('prepared post-process layout failed'));
            const pipeline = runtime.getPostProcessPipeline?.(
              descriptor.shader,
              fullscreen.bindGroupLayout,
              descriptor.colorFormats[0] as GPUTextureFormat,
              postProcessEntry,
            );
            if (pipeline !== null && pipeline !== undefined) {
              preparedPipelineIds.set(pipeline as object, descriptor.shader);
              if (runtime.getMaterialShaderBindingContract?.(descriptor.shader) === 'group-0') {
                preparedGroup0Pipelines.add(pipeline as object);
              }
            }
            return pipeline === null || pipeline === undefined
              ? err(makePreparedPipelinePendingError())
              : ok(pipeline);
          }
          const preparedPipeline = runtime.getMaterialShaderPipeline?.(
            descriptor.shader,
            descriptor.colorFormats[0] === 'rgba16float',
            descriptor.renderState,
            descriptor.topology,
            descriptor.indexFormat,
            undefined,
            'forward',
            undefined,
            descriptor.sampleCount ?? 1,
            // Prepared graphics own their declared attachment format. Passing
            // it through keeps the PSO compatible with feature-target views
            // (the ordinary material path intentionally defaults to the
            // swap-chain view format).
            descriptor.colorFormats[0] as GPUTextureFormat,
            undefined,
            descriptor.depthFormat === undefined
              ? null
              : (descriptor.depthFormat as GPUTextureFormat),
            descriptor.vertexLayout,
            undefined,
            input.shaderModuleMode,
          );
          // A requested material shader is an exact pipeline contract. During
          // async shader warmup, substituting the generic unlit pipeline can
          // mismatch vertex layouts and HDR attachment formats, turning a
          // retryable next-frame prepare into an invalid GPU command buffer.
          const pipeline = preparedPipeline ?? null;
          if (pipeline !== null) {
            preparedMaterialPipelineShaders.set(pipeline as object, descriptor.shader);
            const bindingContract = runtime.getMaterialShaderBindingContract?.(descriptor.shader);
            if (bindingContract === 'group-0') {
              preparedGroup0Pipelines.add(pipeline as object);
            } else if (bindingContract === 'view-only') {
              preparedViewOnlyPipelines.add(pipeline as object);
            } else {
              preparedRenderMaterialPipelines.add(pipeline as object);
            }
          }
          return pipeline === null ? err(makePreparedPipelinePendingError()) : ok(pipeline);
        },
        resolveBindings: (descriptor, pipeline) => {
          const materialShaderId = preparedMaterialPipelineShaders.get(pipeline as object);
          const bindingContract =
            materialShaderId === undefined
              ? undefined
              : runtime.getMaterialShaderBindingContract?.(materialShaderId);
          if (bindingContract === 'group-0-resource') {
            return descriptor.values.sceneDepth === undefined
              ? err(new Error('prepared group-0 resource pipeline requires a scene target'))
              : ok(undefined);
          }
          if (bindingContract === 'view-and-scene-depth') {
            return ok(undefined);
          }
          if (preparedGroup0Pipelines.has(pipeline as object)) {
            const layout =
              (materialShaderId === undefined
                ? undefined
                : runtime.getMaterialBindGroupLayout?.(materialShaderId)) ??
              (
                pipeline as RenderPipeline & {
                  getBindGroupLayout?: (index: number) => BindGroupLayout;
                }
              ).getBindGroupLayout?.(0);
            return layout === undefined
              ? err(new Error('prepared group-0 pipeline bind group layout is unavailable'))
              : runtime.device.createBindGroup({ layout, entries: [] });
          }
          if (
            preparedViewOnlyPipelines.has(pipeline as object) ||
            (preparedRenderMaterialPipelines.has(pipeline as object) &&
              descriptor.values.group === 0) ||
            pipeline === runtime.getPipelineState()?.unlitPipeline
          ) {
            return ok(undefined);
          }
          const group = descriptor.values.group;
          const layout =
            (materialShaderId !== undefined
              ? (runtime.getMaterialBindGroupLayout?.(materialShaderId) ??
                (group === 0 ? runtime.getPipelineState()?.materialBindGroupLayout : undefined))
              : undefined) ??
            (
              pipeline as RenderPipeline & {
                getBindGroupLayout?: (index: number) => BindGroupLayout;
              }
            ).getBindGroupLayout?.(group === 1 ? 1 : 0);
          const material = descriptor.values.material;
          if (
            group === 1 &&
            layout !== undefined &&
            materialShaderId !== undefined &&
            typeof material === 'object' &&
            material !== null &&
            'world' in material &&
            'guid' in material &&
            typeof material.world === 'number' &&
            typeof material.guid === 'string'
          ) {
            return preparedMaterialBindings(
              runtime,
              caches,
              worlds,
              materialShaderId,
              material.world,
              material.guid,
              layout,
            );
          }
          return layout === undefined
            ? err(new Error('prepared pipeline bind group layout is unavailable'))
            : runtime.device.createBindGroup({
                layout,
                entries:
                  group === 1 && preparedPipelineIds.has(pipeline as object)
                    ? [
                        {
                          binding: 0,
                          resource: {
                            kind: 'textureView',
                            value: runtime.getPipelineState()?.fallbackTextureView as never,
                          },
                        },
                        {
                          binding: 1,
                          resource: {
                            kind: 'sampler',
                            value: runtime.getPipelineState()?.defaultSampler as never,
                          },
                        },
                        ...(runtime.getPostProcessParamsBuffer?.(
                          preparedPipelineIds.get(pipeline as object) ?? '',
                        ) === undefined
                          ? []
                          : [
                              {
                                binding: 2,
                                resource: {
                                  kind: 'buffer' as const,
                                  value: {
                                    buffer: runtime.getPostProcessParamsBuffer?.(
                                      preparedPipelineIds.get(pipeline as object) ?? '',
                                    ) as never,
                                  },
                                },
                              },
                            ]),
                      ]
                    : [],
              });
        },
      });
    };
  const preparedResolverFactory = (
    input: RenderFeaturePreparedGraphicsResolverInput,
  ): PreparedGraphicsResolver =>
    createPreparedResolverFactory(
      internals,
      featureGpuWork,
      preparedWorlds,
      activePreparedResolverCaches,
    )(input);
  const recoveryOwner = createRenderSystemRecovery({
    frameState,
    internals,
    getEnvironmentLifecycle: () => environmentLifecycle,
    getGpuDrivenProduction: () => gpuDrivenProduction,
    setGpuDrivenProduction: (production) => {
      gpuDrivenProduction = production;
    },
    disposeFeatureGpuWork,
    setFeatureGpuWork: (owner) => {
      featureGpuWork = owner;
    },
    getActiveFeaturePostProcessEntries: () => activeFeaturePostProcessEntries,
    setActiveFeaturePostProcessEntries: (entries) => {
      activeFeaturePostProcessEntries = entries;
    },
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
  });
  return {
    get instanceCollectionsInspection(): readonly InstanceCollectionInspection[] {
      return instanceCollections._inspections(
        frameState.instanceResidency,
        frameState.frameNumber - 1,
      );
    },
    releaseProfilerCatalog(): void {
      releaseProfilerCatalog?.();
      releaseProfilerCatalog = undefined;
    },
    invalidateGeometryHistory(): void {
      frameState.temporalFrameTransaction.reset('signature-change');
      frameState.temporalFrame = undefined;
      frameState.temporalFrameInput = undefined;
      frameState.lastSuccessfulTemporalView = undefined;
      frameState.successfulTemporalFrameIndex = 0;
      frameState.pendingTemporalCommit = { kind: 'none' };
    },
    get renderScene(): RenderSceneInspection {
      return {
        ...persistentRenderScene.inspect(),
        gpuDriven: gpuDrivenProduction.inspect(),
      };
    },
    get gpuDrivenInspection(): GpuDrivenProductionInspection {
      return gpuDrivenProduction.inspect();
    },
    get reflectionProbes(): ReflectionProbeInspection {
      return reflectionProbeOwner.inspect();
    },
    get ssrDependencies(): SsrDependenciesInspection {
      ensureSsrFormatProbe();
      const owner = reflectionProbeOwner.inspect();
      const nextGeneration = owner.reflectionFallback.projectionGeneration;
      const reset = resolveSsrAdmissionGeneration(ssrFallbackGeneration, nextGeneration);
      if (reset.changed) {
        frameState.temporalFrameTransaction.reset('signature-change');
        frameState.temporalFrame = undefined;
        frameState.temporalFrameInput = undefined;
        frameState.lastSuccessfulTemporalView = undefined;
        frameState.successfulTemporalFrameIndex = 0;
        frameState.pendingTemporalCommit = { kind: 'none' };
      }
      ssrFallbackGeneration = reset.generation;
      const temporal =
        frameState.lastSuccessfulTemporalView === undefined
          ? undefined
          : ({
              successfulSubmit: true,
              generation: frameState.lastSuccessfulTemporalView.input.deviceGeneration,
            } as const);
      return projectSsrDependencies({
        requested: frameState.reflectionFallbackDemand === true,
        identity: internals.ssrIdentity,
        reflectionFallback: owner.reflectionFallback,
        format: ssrFormatReceipt,
        temporal,
      });
    },
    get reflectionFallbackCompletion(): Promise<void> | undefined {
      return frameState.reflectionFallbackCompletion;
    },
    isCubeCapturePending(target: RenderTarget): boolean {
      return cubeCaptureScheduler.inspect(target).candidateGeneration !== undefined;
    },
    get environment(): EnvironmentInspection {
      return environmentLifecycle.inspect();
    },
    get temporal(): TemporalInspection {
      return inspectTemporal(frameState.lastSuccessfulTemporalView, undefined, {
        ...(frameState.activeTemporalGpuState === undefined
          ? {}
          : { active: frameState.activeTemporalGpuState }),
        ...(frameState.temporalGpuState === undefined
          ? {}
          : { candidate: frameState.temporalGpuState }),
        retiring: [...frameState.retiringTemporalGpuStates],
        deviceGeneration: internals.deviceScope.generation,
      });
    },
    get motionBlurInspection(): MotionBlurInspection | undefined {
      const camera = latestCamera;
      if (camera?.motionBlur === undefined) return undefined;
      const demanded = camera.motionBlur.shutterAngle > 0;
      const unavailable = demanded && !internals.device.caps.rgba16floatRenderable;
      const admitted =
        frameState.activeTemporalGpuState !== undefined ||
        frameState.temporalGpuState !== undefined;
      return {
        enabled: demanded,
        status: !demanded ? 'off' : unavailable || !admitted ? 'reset' : 'active',
        shutterAngle: camera.motionBlur.shutterAngle,
        maxRadiusPixels: camera.motionBlur.maxRadiusPixels,
        sampleCount: camera.motionBlur.sampleCount,
        temporalDemand: demanded ? 'scene-data-temporal-v1' : 'none',
        passName: 'motion-blur',
        historyWrites: 0,
        ...(unavailable ? { lastFailure: 'scene-data-unavailable' as const } : {}),
      };
    },
    get temporalTargetInspection(): TemporalTargetInspection | undefined {
      const graph = frameState.compiledFrameGraph?.inspect();
      if (graph === undefined) return undefined;
      const producer = graph.passes.find((pass) => pass.name === 'standard-scene-data');
      // The producer's semantic target is the graph-owned
      // `standard-scene-temporal` resource. Resolve it from the compiled
      // resource table rather than the pass access projection: a backend may
      // retain a view alias in the access list while the resource owner still
      // carries the canonical semantic label.
      const target = graph.resources.find(
        (resource) => resource.kind === 'texture' && resource.label === 'standard-scene-temporal',
      );
      if (producer === undefined || target === undefined) {
        return undefined;
      }
      const width = Math.max(1, internals.canvas.width);
      const height = Math.max(1, internals.canvas.height);
      return Object.freeze({
        identity: 'standard-scene-temporal',
        producerId: 'forgeax::standard::scene-data',
        schema: 'forgeax::scene-data::temporal-v1',
        targetCount: 1,
        descriptor: Object.freeze({
          format: 'rgba16float',
          width,
          height,
          sampleCount: 1,
          bytes: width * height * 8,
        }),
      });
    },
    get lodOcclusionInspection(): LodOcclusionInspection | undefined {
      return lastLodOcclusionInspection;
    },
    get bloom(): BloomInspection {
      const pipelineState = internals.getPipelineState();
      const resources = pipelineState?.perPassResources;
      const lifecycle = resources?.inspectBloomResources?.(
        frameState.compiledFrameGraph?.inspect(),
      );
      return Object.freeze(
        lifecycle ?? {
          graphStatus: 'empty',
          enabled: false,
          targetCount: 0,
          targetBytes: 0,
          resourceCount: 0,
          passCount: 0,
          encodeCount: 0,
          bindGroupCount: 0,
          uploadCount: 0,
          residentChildBytes: 0,
          generation: 0,
          state: 'off',
        },
      );
    },
    get transmission(): TransmissionInspection | undefined {
      return lastTransmissionInspection;
    },
    get directionalShadow(): DirectionalShadowInspection {
      const lights = lastDirectionalShadowLights;
      const pipelineState = internals.getPipelineState();
      const graph = frameState.compiledFrameGraph?.inspect();
      const requested = directionalShadowProfileFromQuality(lights?.directionalShadowQuality);
      const mapSize = pipelineState?.perPassResources.shadowMapSize ?? 0;
      const cascadeCount = lights?.cascadeCount ?? 0;
      const shadowReady = frameState.currentDirectionalShadowView !== null;
      const atlasBytes =
        shadowReady && mapSize > 0 && cascadeCount > 0
          ? mapSize * mapSize * Math.ceil(Math.sqrt(cascadeCount)) ** 2 * 4
          : 0;
      return projectDirectionalShadowInspectionSource({
        requested,
        candidate: lastDirectionalShadowCandidate,
        ...(frameState.directionalShadowCache === null
          ? {}
          : {
              lastKnownGood: directionalShadowProfileFromQuality(
                frameState.directionalShadowCache.directionalShadowQuality,
              ),
            }),
        cascadeCount,
        mapSize,
        atlasBytes,
        writerPasses:
          graph?.passes.filter((pass) => pass.name.startsWith('shadowCascade')).length ?? 0,
        shadowAngularRadius: lights?.directionalCsmConfig?.shadowAngularRadius,
        maxPenumbraTexels: lights?.directionalCsmConfig?.maxPenumbraTexels,
        deviceGeneration: internals.deviceScope.generation,
        graphGeneration: frameState.perFrameGraph?.graphGeneration ?? frameState.graphGeneration,
        shadowReady,
        ...(lastDirectionalShadowError === undefined ? {} : { error: lastDirectionalShadowError }),
      });
    },
    get standardLightingInspection(): StandardLightingInspection | undefined {
      const inspection = frameState.standardLightingInspection;
      return inspection === undefined ? undefined : Object.freeze({ ...inspection });
    },
    get pointShadowInspection(): PointShadowInspection | undefined {
      const inspection = frameState.pointShadowInspection;
      return inspection === undefined ? undefined : Object.freeze({ ...inspection });
    },
    get pointsLinesSnapshots(): readonly PointsLinesRetainedSnapshot[] {
      return persistentRenderScene.pointsLinesSnapshots();
    },
    detachScene(world: World): void {
      persistentRenderScene.detach(world);
    },
    draw(
      worlds: readonly World[],
      opts: DrawOwnerOptions,
      renderReadLeases?: readonly RenderReadLease[],
      timingCapture?: GpuTimingCapture,
    ): boolean {
      const composition = canonicalizeWorldComposition(worlds, opts, renderReadLeases);
      const compositionWorlds = composition.worlds;
      const compositionLeases = composition.leases;
      preparedWorlds = compositionWorlds;
      const profileSession = internals.profiler?.activeSession();
      let ownsProfileFrame = false;
      let submitted = false;
      // A failed draw must never leave a previous frame eligible to publish a
      // newly accepted dynamic-geometry candidate.
      lastSubmittedDynamicGeometryBindings = new WeakMap();
      const frameConsumedDynamicGeometryBindings = new WeakMap<World, Map<number, number>>();
      if (profileSession !== undefined && opts.profileFrame === undefined) {
        try {
          ownsProfileFrame = profileSession.beginFrame(++directFrameId).ok;
        } catch {
          ownsProfileFrame = false;
        }
      }
      try {
        pointsLinesOwner.beginFrame();
        // cameraOwner drives the surfaced cameras + frustum
        // cull; resourceOwner drives skylight/skybox/postProcess + per-world
        // record config.
        const { cameraOwner, resourceOwner } = composition.owners;
        // Keep the compiled graph as last-known-good until the candidate topology
        // compiles. The failed candidate frame does not execute it; successful
        // replacement retires it atomically in ensureCompiledFrameGraph.
        if (frameState.installedPipelineHandle !== lastBuiltPipelineHandle) {
          // Feature contributions describe the active pipeline graph. Drop the
          // old graph before the next frame re-runs feature contribution
          // so a hot-swap cannot reuse passes compiled for the retired pipeline.
          resetRenderFeatureGraphState(internals);
          lastBuiltPipelineHandle = frameState.installedPipelineHandle;
          persistentRenderScene.invalidate();
        }
        dispatchCounts.unlit = 0;

        // feat-20260708-composited-multi-world-rendering M3 / D-2 / m3-i2:
        // extractFrames merges per-world snapshots (renderables + lights from
        // every world, cameras + singleton resources from the owner world),
        // runs read-only extractFrame per world over the already-updated World,
        // resets frame state once, and isolates
        // per-world errors (AC-09).
        // Single-world draw([world], { cameraOwner: 0, resourceOwner: 0 }) is the identity path
        // (worldId=0), byte-for-byte equivalent to the pre-M3 direct
        // extractFrame path (AC-03 regression guarantee).
        //
        // Entry validation (empty worlds / owner out of range) is enforced by
        // the public renderer.draw facade (createRenderer.ts, D-5) before this
        // internal method is reached; the owner world is guaranteed present.
        //
        // feat-20260709-editor-world-partition M1 / w5+w6 (D-3): per-world
        // record configuration (transparent-sort mode, fold buckets, skybox /
        // asset resolution) is read from the resource-owner world — the world
        // that owns skylight / skybox / postProcessParams. w6 sources it from
        // the dedicated resourceOwner index. The variable is named
        // `resourceWorld` so the record-stage reads are self-describing (they
        // are resource-owner reads, not camera reads).
        const resourceWorld = compositionWorlds[resourceOwner] as World;
        const frame = runProfiledRenderPhase(profileSession, 'extract', () => {
          return persistentRenderScene.extractComposition(
            compositionWorlds,
            { cameraOwner, resourceOwner },
            internals.assets.catalogEpoch,
            (request: PersistentRenderCandidateRequest) =>
              extractFrames(
                compositionWorlds,
                { cameraOwner, resourceOwner },
                internals.assets,
                internals.getPipelineState(),
                persistentRenderScene.materialSnapshotCacheStore(),
                {
                  ...(internals.device.caps.backendKind === 'null'
                    ? {}
                    : {
                        materialContext: {
                          backend:
                            internals.device.caps.backendKind === 'wgpu-webgl2'
                              ? ('webgl2' as const)
                              : internals.device.caps.backendKind,
                          capability: internals.device.caps.storageBuffer
                            ? ('storage-buffer' as const)
                            : ('uniform-fallback' as const),
                          pipeline: 'forward' as const,
                          geometry: 'mesh' as const,
                          pass: 'forward' as const,
                          profile: 'forgeax-material-wgsl-v1' as const,
                          toolchain: 'naga-oil' as const,
                          instrumentation: 'none' as const,
                        },
                      }),
                  cull: 'none',
                  renderables: request === 'none' ? 'none' : 'full',
                  ...(request === 'none' || request === 'full'
                    ? {}
                    : { renderableEntitiesByWorld: request.entitiesByWorld }),
                  retainHidden: true,
                  instanceCollections,
                  ...(internals.getMaterialShaderArtifact === undefined
                    ? {}
                    : { getMaterialShaderArtifact: internals.getMaterialShaderArtifact }),
                },
              ),
            compositionLeases,
          );
        });
        const {
          cameras,
          cubeCameras,
          lights,
          environment,
          environmentReady,
          volumetricFog,
          renderables,
          dispatch,
          skylight,
          skylightCount,
          skybox,
          skyboxCount,
          fogFailure,
          frustumStats,
          visibilityStats,
          postProcessParams,
        } = frame;
        lastDirectionalShadowLights = lights;
        lastDirectionalShadowCandidate = 'failed';
        lastDirectionalShadowError = lights.directionalShadowError;
        const reflectionProbeRecord = reflectionProbeOwner.prepare(
          frame.reflectionProbes ?? [],
          persistentRenderScene.reflectionProbeProjection().selected,
          cameras[0],
          frameState.frameNumber,
          skylight,
        );
        latestCamera = cameras[0];
        persistentRenderScene.updateVisibilityFacet(compositionWorlds, latestCamera, renderables);
        let occlusionProjection:
          | import('./scene/visibility/occlusion-runtime').OcclusionFrameProjection
          | undefined;
        let occlusionFallback: LodOcclusionInspection['fallback'] = { active: false };
        const worldKeys = persistentRenderScene.visibilityWorldKeysFor(compositionWorlds);
        const slotByEntity = persistentRenderScene.compositionSlotByStableEntity();
        if (latestCamera !== undefined) {
          const camera = latestCamera;
          const cameraWorld = compositionWorlds[camera.worldId ?? cameraOwner];
          const view = viewKey({
            attachmentId: cameraWorld?.identity ?? 'missing-camera-world',
            cameraEntity: camera.entityKey ?? 0,
            viewRole: 'main',
            viewGeneration: camera.historyVersion ?? 0,
          });
          const cachedCandidates = occlusionCandidateCache;
          const candidates =
            cachedCandidates?.renderables === renderables &&
            cachedCandidates.camera === camera &&
            cachedCandidates.cameraWorldIdentity === (cameraWorld?.identity ?? '')
              ? cachedCandidates.candidates
              : renderables.flatMap((renderable) => {
                  const world = compositionWorlds[renderable.worldId];
                  const aabb = renderable.localAabb;
                  // Occlusion is a LOD transport concern. A plain mesh has no
                  // lower-detail range to select, so keep it on the ordinary CPU
                  // visibility path and do not allocate query resources for it.
                  if (
                    world === undefined ||
                    cameraWorld === undefined ||
                    aabb === undefined ||
                    aabb.length < 6 ||
                    renderable.lods === undefined ||
                    renderable.lods.length === 0
                  )
                    return [];
                  const slot = slotByEntity.get(
                    worldEntityKey(
                      worldKeys[renderable.worldId] ?? renderable.worldId,
                      renderable.entityKey,
                    ),
                  );
                  if (slot === undefined) return [];
                  const primitive = primitiveKey({
                    attachmentId: cameraWorld.identity,
                    worldGeneration: worldKeys[renderable.worldId] ?? renderable.worldId,
                    primitiveSlot: slot.slot,
                    slotGeneration: slot.generation,
                  });
                  return [
                    {
                      view,
                      primitive,
                      epoch: 0,
                      bounds: {
                        min: [aabb[0] ?? 0, aabb[1] ?? 0, aabb[2] ?? 0] as [number, number, number],
                        max: [aabb[3] ?? 0, aabb[4] ?? 0, aabb[5] ?? 0] as [number, number, number],
                      },
                      candidate: { level: 0, confidence: 1 },
                      deviceGeneration: internals.deviceScope.generation,
                      proxyVertices: buildOcclusionProxyVertices(
                        aabb,
                        renderable.transform.world,
                        camera,
                      ),
                    },
                  ];
                });
          occlusionCandidateCache = {
            renderables,
            camera,
            cameraWorldIdentity: cameraWorld?.identity ?? '',
            candidates,
          };
          occlusionProjection = runProfiledRenderPhase(profileSession, 'occlusion-prepare', () =>
            ensureOcclusionRuntime().prepareBatch(candidates, camera.antialias === 'msaa' ? 4 : 1),
          );
          const queryPool = ensureOcclusionRuntime().inspect();
          const queryUnavailable = ensureOcclusionRuntime().prepareUnavailable;
          const queryCapacityFallback =
            candidates.length > 0 && queryUnavailable && queryPool.availablePages === 0;
          occlusionFallback = queryCapacityFallback
            ? {
                active: true as const,
                reason: 'page-exhausted' as const,
                error: {
                  code: 'visibility-query-capacity-exhausted',
                  expected: 'one available occlusion-query page for the LOD candidate batch',
                  hint: 'retry the LOD query after an in-flight page completes',
                  detail: {
                    availablePages: queryPool.availablePages,
                    pageCount: queryPool.pageCount,
                    pageIndexLimit: queryPool.pageIndexLimit,
                  },
                },
              }
            : ({ active: false } as const);
        }
        // Query transport is best-effort and must fail open. A candidate that
        // was hidden by an earlier completion becomes visible again when this
        // device/frame cannot reserve a fresh query page; the next successful
        // submission can rebuild confidence from a real result.
        if (
          occlusionProjection === undefined &&
          latestCamera !== undefined &&
          ensureOcclusionRuntime().prepareUnavailable
        ) {
          const cameraWorld = compositionWorlds[latestCamera.worldId ?? cameraOwner];
          if (cameraWorld !== undefined) {
            const fallbackView = viewKey({
              attachmentId: cameraWorld.identity,
              cameraEntity: latestCamera.entityKey ?? 0,
              viewRole: 'main',
              viewGeneration: latestCamera.historyVersion ?? 0,
            });
            for (const renderable of renderables) {
              if ((renderable.lods?.length ?? 0) === 0) continue;
              const world = compositionWorlds[renderable.worldId];
              if (world === undefined) continue;
              const slot = slotByEntity.get(
                worldEntityKey(
                  worldKeys[renderable.worldId] ?? renderable.worldId,
                  renderable.entityKey,
                ),
              );
              if (slot === undefined) continue;
              persistentRenderScene.visibilityFacetStore().applyConfidence(
                fallbackView,
                primitiveKey({
                  attachmentId: cameraWorld.identity,
                  worldGeneration: worldKeys[renderable.worldId] ?? renderable.worldId,
                  primitiveSlot: slot.slot,
                  slotGeneration: slot.generation,
                }),
                { type: 'failure', submissionGeneration: frameState.frameNumber },
              );
            }
          }
        }
        const visibilityProjection = persistentRenderScene.projectVisibility(
          compositionWorlds,
          latestCamera,
          renderables,
          dispatch,
        );
        const submissionRenderables = visibilityProjection.renderables;
        const submissionDispatch = visibilityProjection.dispatch;
        const inspectionCamera = latestCamera;
        let lodCandidateCountForFrame = 0;
        if (inspectionCamera !== undefined) {
          const firstRenderable = renderables[0];
          const lodCandidateCount =
            lodCandidateCountCache?.renderables === renderables
              ? lodCandidateCountCache.count
              : (() => {
                  const count = renderables.reduce(
                    (total, renderable) => total + ((renderable.lods?.length ?? 0) > 0 ? 1 : 0),
                    0,
                  );
                  lodCandidateCountCache = { renderables, count };
                  return count;
                })();
          lodCandidateCountForFrame = lodCandidateCount;
          const inspectionRenderables =
            lodInspectionRenderablesCache?.submissionRenderables === submissionRenderables &&
            lodInspectionRenderablesCache.lodCandidateCount === lodCandidateCount
              ? lodInspectionRenderablesCache.values
              : (() => {
                  const values =
                    lodCandidateCount > 0
                      ? submissionRenderables.filter(
                          (renderable) => (renderable.lods?.length ?? 0) > 0,
                        )
                      : submissionRenderables;
                  lodInspectionRenderablesCache = {
                    submissionRenderables,
                    lodCandidateCount,
                    values,
                  };
                  return values;
                })();
          const candidateCount =
            lodCandidateCount > 0 ? lodCandidateCount : renderables.length + frustumStats.culled;
          const inspectionQuery = ensureOcclusionRuntime().inspect();
          const inspectionBudget = persistentRenderScene.visibilityBudgetValue();
          const inspectionWorlds = createLodWorldInspections(
            compositionWorlds,
            renderables,
            submissionRenderables,
            inspectionCamera,
            frameState.frameNumber,
            worldKeys,
            slotByEntity,
            {
              used:
                inspectionQuery.pageCount * inspectionQuery.pageIndexLimit -
                inspectionQuery.availablePages * inspectionQuery.pageIndexLimit,
              capacity: inspectionQuery.pageCount * inspectionQuery.pageIndexLimit,
            },
            occlusionFallback,
            ensureOcclusionRuntime().prepareUnavailable
              ? { active: true, reason: 'query-unavailable' as const }
              : { active: false },
          );
          const attachmentByWorldKey = new Map<number, string>();
          for (let worldId = 0; worldId < compositionWorlds.length; worldId += 1) {
            const world = compositionWorlds[worldId];
            if (world === undefined) continue;
            const worldKey = worldKeys[worldId] ?? worldId;
            if (attachmentByWorldKey.has(worldKey)) {
              attachmentByWorldKey.clear();
              break;
            }
            attachmentByWorldKey.set(worldKey, world.identity);
          }
          lastLodWorldAttachments = attachmentByWorldKey;
          lastLodOcclusionInspection = inspectLodOcclusion({
            root: {
              guid:
                firstRenderable === undefined
                  ? 'none'
                  : `asset-handle:${firstRenderable.assetHandle}`,
              sourceKey: `render-frame:${frameState.frameNumber}`,
            },
            view: {
              attachmentId:
                compositionWorlds[inspectionCamera.worldId ?? cameraOwner]?.identity ?? 'none',
              cameraEntity: inspectionCamera.entityKey ?? 0,
              viewRole: 'main',
              viewGeneration: inspectionCamera.historyVersion ?? 0,
            },
            slot: {
              primitiveSlot: 0,
              slotGeneration: persistentRenderScene.inspect().topology.revision,
            },
            generation: frameState.frameNumber,
            count: {
              candidates: candidateCount,
              visible: inspectionRenderables.length,
              occluded: visibilityProjection.suppressed,
            },
            lodHistogram: [{ level: 0, count: inspectionRenderables.length }],
            queryLatencyUs: { median: 0, p95: 0, last: 0 },
            pagePressure: { used: 0, capacity: 3 * 4096 },
            fallback: occlusionFallback,
            degradation: ensureOcclusionRuntime().prepareUnavailable
              ? { active: true, reason: 'query-unavailable' as const }
              : { active: false },
            samples: inspectionRenderables.slice(0, 64).map((_, index) => ({
              primitiveSlot: index,
              level: 0,
              visible: true,
            })),
            submit: {
              frameId: frameState.frameNumber,
              build: resolveInspectionBuild(internals),
              deviceGeneration: internals.deviceScope.generation,
            },
            budget: inspectionBudget,
            worlds: inspectionWorlds,
          });
        } else {
          lastLodOcclusionInspection = undefined;
          lastLodWorldAttachments = new Map();
        }
        const temporalDemanded =
          cameras[0]?.antialias === 'taa' || (cameras[0]?.motionBlur?.shutterAngle ?? 0) > 0;
        if (temporalDemanded) {
          persistentRenderScene.prepareTemporalFrame(submissionRenderables);
        }
        environmentLifecycle.bindScope(internals.deviceScope);
        if (fogFailure !== undefined) {
          environmentLifecycle.recordSelectionFailure(fogFailure);
        }
        if (!environmentReady || environment === undefined) {
          frameState.pendingTemporalCommit = { kind: 'none' };
          // A world with no camera still has a valid clear-only render path.
          // It has no environment candidate and therefore must not publish an
          // off/taa temporal state; camera-bearing rejected extraction remains
          // an atomic render failure.
          if (cameras.length > 0) return false;
        } else {
          const environmentCandidate = environmentLifecycle.ensure(environment);
          if (!environmentCandidate.ok) {
            environmentLifecycle.recordCandidateFailure(environmentCandidate.error);
            internals.errorRegistry.fire(environmentCandidate.error);
            return false;
          }
          if (!environmentLifecycle.isActive(environmentCandidate.value)) {
            frameState.environmentGeneration = environmentCandidate.value;
          }
        }
        const transmissionAntialias = frame.cameras[0]?.antialias ?? 'none';
        if (!prepareTransmissionCandidate(transmissionAntialias)) {
          // The candidate gate runs before bind-group preparation, graph
          // construction, and record/submit. A missing capability therefore
          // cannot publish or execute a transmission graph.
          updateTransmissionInspection(transmissionAntialias, false);
          return false;
        }
        if (lastMeshMaterialBindingFrame !== frame) {
          lastMeshMaterialBindingFrame = frame;
          lastMeshMaterialBindings = renderables.map((renderable) => {
            const materialWorld = preparedWorlds[renderable.worldId];
            return projectMeshMaterialBindingObservation({
              worldId: renderable.worldId,
              entityKey: renderable.entityKey,
              bindings: renderable.materials.map((material, slotIndex) => ({
                handle: material.materialHandle ?? 0,
                source: renderable.materialBindingSources[slotIndex] ?? 'engine-default',
              })),
              diagnostics: renderable.materialBindingDiagnostics ?? [],
              residency: renderable.materials.map((material) =>
                observeMaterialResidency(materialWorld, material, internals),
              ),
            });
          });
        }

        bindGroupCounts.createBindGroup = 0;
        bindGroupCounts.keys = [];
        const preparedPipelineState = internals.getPipelineState();
        const bindGroupSkipReason: RenderPhaseSkipReason | undefined =
          internals.featureHost === undefined
            ? 'feature-host-unavailable'
            : internals.featureHost.size === 0
              ? 'feature-host-empty'
              : preparedPipelineState === null
                ? 'pipeline-state-unavailable'
                : frame.cameras.length === 0
                  ? 'camera-unavailable'
                  : undefined;
        if (bindGroupSkipReason !== undefined || preparedPipelineState === null) {
          recordProfileSkip(
            profileSession,
            'bind-groups',
            bindGroupSkipReason ?? 'pipeline-state-unavailable',
          );
        } else {
          runProfiledRenderPhase(profileSession, 'bind-groups', () =>
            buildPerFrameBindGroups(
              internals,
              frameState,
              preparedPipelineState,
              true,
              bindGroupCounts,
              undefined,
              false,
            ),
          );
        }
        lastFrustumStats.culled = frustumStats.culled;
        lastFrustumStats.total = frustumStats.total;
        lastVisibilityStats.explicitlyHidden = visibilityStats.explicitlyHidden;
        const featureTargets =
          preparedPipelineState === null || cameras[0] === undefined
            ? []
            : resolveStandardRenderFeatureTargets({
                tonemap: cameras[0].tonemap,
                antialias: cameras[0].antialias,
                colorAttachmentFormat: preparedPipelineState.colorAttachmentFormat,
                storageBuffer: internals.device.caps.storageBuffer,
                multisample: internals.device.caps.backendKind !== 'wgpu-webgl2',
              });
        let featureGraphCandidate: RenderFeatureGraphCandidate | undefined;
        const preparedResourceBatches = runProfiledRenderPhase(profileSession, 'features', () => {
          if (internals.featureHost === undefined) return [];
          const featureFrame = runRenderFeatureFrame(internals.featureHost, {
            worlds: compositionWorlds,
            owner: resourceOwner,
            frameNumber: frameState.frameNumber,
            visibilitySnapshots: frame.featureVisibilitySnapshots,
            hiddenEntityReports: frame.hiddenEntityReports,
            targets: featureTargets,
            generation: internals.featureHost?.preparedGeneration ?? 0,
            caps: internals.device.caps,
            ...(internals.getMaterialShaderBindingContract === undefined
              ? {}
              : { materialShaderBindingContract: internals.getMaterialShaderBindingContract }),
            createPreparedGraphicsResolver: preparedResolverFactory,
            gpuWork: featureGpuWork,
          });
          lastVisibilityStats.explicitlyHidden = featureFrame.hiddenEntityReports.length;
          for (const featureError of featureFrame.errors) {
            if (!isPendingRenderFeaturePreparation(featureError)) {
              internals.errorRegistry.fire(featureError);
            }
          }
          const postProcessParamsCandidate = preparePostProcessParamsResources(
            featureFrame.fullscreenEffects,
          );
          if (!postProcessParamsCandidate.ok) {
            internals.errorRegistry.fire(postProcessParamsCandidate.error);
            for (const batch of featureFrame.preparedResourceBatches) {
              const released = batch.release();
              if (!released.ok) internals.errorRegistry.fire(released.error);
            }
            return [];
          }
          featureGraphCandidate = {
            plans: featureFrame.plans,
            fullscreenEffects: featureFrame.fullscreenEffects,
            ...(featureFrame.preparedResourceBatches.length === 0
              ? {}
              : { preparedResourceKey: `frame-${frameState.frameNumber}` }),
            onRejected: () => {
              for (const batch of featureFrame.preparedResourceBatches) {
                const released = batch.release();
                if (!released.ok) {
                  internals.errorRegistry.fire(released.error);
                }
              }
              discardPostProcessParamsCandidate(postProcessParamsCandidate.value);
            },
            onAbandoned: () => {
              discardPostProcessParamsCandidate(postProcessParamsCandidate.value);
            },
            onAccepted: () => {
              for (const [id, previous] of activeFeaturePostProcessEntries) {
                const next = featureFrame.fullscreenEffects.get(id);
                if (next === undefined) {
                  clearPostProcessPipelineCache(id);
                  invalidatePostProcessModule(id);
                } else if (
                  postProcessShaderEntrySignature(previous) !==
                  postProcessShaderEntrySignature(next)
                ) {
                  clearPostProcessPipelineEntry(id, previous);
                  if (previous.source !== next.source) {
                    invalidatePostProcessModule(id);
                  }
                }
              }
              acceptPostProcessParamsCandidate(postProcessParamsCandidate.value);
              activeFeaturePostProcessEntries = featureFrame.fullscreenEffects;
            },
          };
          return featureFrame.preparedResourceBatches;
        });

        // Unified transparent-sort: (layer ASC, sortValue ASC) for modes 0/1/2;
        // distance back-to-front for mode=3. The transparent-sort config is a
        // per-world resource; it is read from the resource-owner world (the
        // world that owns skylight / skybox / singleton render state, w5 / D-3).
        // Only the Transparent segment is reordered; queue ordering between
        // segments (sortDispatchByQueue, stable) is preserved.
        const orderedDispatch = runProfiledRenderPhase(profileSession, 'sort', () => {
          const cached = orderedDispatchCache;
          if (
            cached?.source === submissionDispatch &&
            cached.world === resourceWorld &&
            cached.camera === cameras &&
            cached.renderables === submissionRenderables
          ) {
            return cached.value;
          }
          const value = sortTransparentDispatch(
            [...submissionDispatch],
            resourceWorld,
            cameras,
            submissionRenderables,
          );
          orderedDispatchCache = {
            source: submissionDispatch,
            world: resourceWorld,
            camera: cameras,
            renderables: submissionRenderables,
            value,
          };
          return value;
        });

        // M3 / w26: single dispatch list replaces old three-bucket model.
        // Pass dispatch to recordFrame — the record stage iterates dispatch
        // entries in queue order per plan-strategy D-3.
        //
        // feat-20260709-editor-world-partition ENGINE-fix-round2 (defect 2):
        // the record stage must resolve each renderable's mesh + material
        // textures against the world it was EXTRACTED from — never the single
        // resourceWorld. The extract stage already resolves per-world
        // (extractFrames loops worlds[] and stamps RenderableSnapshot.worldId);
        // the record stage regressed to resolving everything against
        // resourceWorld, so a user-tier mesh living in the cameraOwner world
        // (e.g. an editor gizmo handle) resolves against resourceWorld's
        // sharedRefs — either a miss (asset-not-registered) or, when that slot
        // is occupied by an unrelated user-tier payload (equirect), a
        // wrong-kind resolve that throws in ensureResident. `worlds` is threaded
        // so the record stage can index worlds[renderable.worldId]. `resourceWorld`
        // stays the singleton-resource owner (skybox equirect / transparent-sort
        // config / video provider) — those ARE resource-owner reads.
        const recordProfilePhase: RecordProfileRunner | undefined =
          profileSession === undefined || profileSession.detail === 'owner'
            ? undefined
            : function recordProfilePhase<T>(phase: RenderRecordPhase, action: () => T): T {
                // `passes` deliberately keeps only the graph-pass boundary.
                // The same runner is also called by geometry/material helpers;
                // invoking those wrappers would turn a pass probe into the
                // high-overhead per-draw `nested` probe.
                if (profileSession.detail === 'passes') {
                  const isOcclusionOwner =
                    phase === 'record/occlusion-query-submit' ||
                    phase === 'record/occlusion-global-advance';
                  const isGraphOwner =
                    phase === 'record/graph-execute' ||
                    (phase.startsWith('record/graph-execute/') &&
                      (!phase.slice('record/graph-execute/'.length).includes('/') ||
                        phase.endsWith('/geometry-loop')));
                  if (!isOcclusionOwner && !isGraphOwner) return action();
                }
                return runProfiledRenderPhase(profileSession, phase, action);
              };
        if (cameras[0]?.bloom === 'on') {
          internals.getPipelineState()?.perPassResources.ensureBloomResources?.();
        }
        submitted = runProfiledRenderPhase(profileSession, 'record', () =>
          recordFrame(
            internals,
            resourceWorld,
            cameras,
            lights,
            [...submissionRenderables],
            orderedDispatch,
            frameState,
            dispatchCounts,
            bindGroupCounts,
            skylight,
            skylightCount,
            skybox,
            skyboxCount,
            postProcessParams,
            compositionWorlds,
            recordProfilePhase,
            {
              owner: gpuDrivenProduction,
              scene: persistentRenderScene.compositionGpuDrivenState(),
              onSceneDemand: (sceneRowsRequired) => {
                persistentRenderScene.setCompositionGpuSceneDemand(sceneRowsRequired);
              },
              activeEntityKeys: visibilityProjection.activeEntityKeys,
              activeEntityRevision: visibilityProjection.activeEntityRevision,
              telemetryCandidateCount: lodCandidateCountForFrame,
              ...(occlusionProjection === undefined ? {} : { occlusion: occlusionProjection }),
            },
            compositionLeases,
            featureGraphCandidate,
            pointsLinesOwner,
            {
              snapshots: cubeCameras,
              scheduler: cubeCaptureScheduler,
              state: cubeCaptureState,
              reflectionProbes: reflectionProbeRecord,
            } satisfies CubeCaptureFrameInput,
            environment?.environmentSignature ?? '',
            environment?.fogSignature ?? '',
            environmentReady && environment !== undefined,
            persistentRenderScene.transmissionTopologyDemand(),
            volumetricFog,
            timingCapture,
            (entry) => {
              const renderable = entry.source;
              const world = compositionWorlds[renderable.worldId];
              if (world === undefined) return;
              let bindings = frameConsumedDynamicGeometryBindings.get(world);
              if (bindings === undefined) {
                bindings = new Map();
                frameConsumedDynamicGeometryBindings.set(world, bindings);
              }
              bindings.set(renderable.entityKey, renderable.assetHandle);
            },
          ),
        );
        if (submitted) {
          lastSubmittedDynamicGeometryBindings = frameConsumedDynamicGeometryBindings;
        }
        if (submitted) {
          try {
            internals.recoveryColdWorkGuard?.finish();
          } catch (cause) {
            submitted = false;
            throw cause;
          }
        }
        if (submitted && lastLodOcclusionInspection !== undefined) {
          const query = ensureOcclusionRuntime().inspect();
          lastLodOcclusionInspection = {
            ...lastLodOcclusionInspection,
            pagePressure: {
              used:
                query.pageCount * query.pageIndexLimit -
                query.availablePages * query.pageIndexLimit,
              capacity: query.pageCount * query.pageIndexLimit,
            },
            fallback: occlusionFallback,
            degradation: ensureOcclusionRuntime().prepareUnavailable
              ? { active: true, reason: 'query-unavailable' as const }
              : { active: false },
          };
        }
        const directionalQuality = lights.directionalShadowQuality;
        const directionalShadowReady =
          directionalQuality === undefined ||
          (frameState.currentDirectionalShadowView !== null &&
            (lights.lightViewProj?.length ?? 0) > 0 &&
            (internals.getPipelineState()?.perPassResources.shadowMapSize ?? 0) > 0);
        if (submitted && directionalShadowReady) {
          lastDirectionalShadowCandidate = 'accepted';
        } else if (directionalQuality !== undefined) {
          lastDirectionalShadowError = {
            code: 'directional-shadow-candidate-failed',
            expected:
              'the extracted Directional CSM candidate has a valid graph target and fitted matrices',
            hint: 'inspect the retained LKG and retry after the graph or resource owner recovers',
            detail: {
              submitted,
              hasShadowView: frameState.currentDirectionalShadowView !== null,
              matrixCount: lights.lightViewProj?.length ?? 0,
              shadowMapSize: internals.getPipelineState()?.perPassResources.shadowMapSize ?? 0,
            },
          };
        }
        if (submitted) {
          recoveryOwner.setLastSuccessfulFrameSeed({
            frame,
            worlds: compositionWorlds,
            cameraOwner: composition.owners.cameraOwner,
            resourceOwner: composition.owners.resourceOwner,
            width: Math.max(1, internals.canvas.width),
            height: Math.max(1, internals.canvas.height),
          });
          submittedFrameCount += 1;
          lastSubmittedGeneration = internals.deviceScope?.generation;
          if (occlusionProjection === undefined) {
            runProfiledRenderPhase(profileSession, 'record/occlusion-global-advance', () =>
              ensureOcclusionRuntime().advanceSuccessfulSubmit(frameState.frameNumber),
            );
          }
          const temporalCommit = persistentRenderScene.commitTemporalFrame();
          if (!temporalCommit.ok) {
            internals.errorRegistry.fire(temporalCommit.error);
          }
          frameState.lastSuccessfulCameraAntialias = cameras[0]?.antialias;
          internals.getPipelineState()?.perPassResources.commitBloomResources?.();
          const nextBloom = cameras[0]?.bloom ?? 'off';
          if (frameState.lastSuccessfulBloom === 'on' && nextBloom !== 'on') {
            internals
              .getPipelineState()
              ?.perPassResources.retireBloomResources?.(
                internals.device.queue.onSubmittedWorkDone(),
              );
          }
          frameState.lastSuccessfulBloom = nextBloom;
        } else {
          internals.getPipelineState()?.perPassResources.discardBloomResources?.();
        }
        if (!submitted && frameState.environmentGeneration !== undefined) {
          environmentLifecycle.discard(frameState.environmentGeneration);
          frameState.environmentGeneration = undefined;
        }
        updateTransmissionInspection(transmissionAntialias, submitted);
        persistentRenderScene.setPointsLinesInspections(pointsLinesOwner.inspections());
        if (internals.featureHost !== undefined && preparedResourceBatches.length > 0) {
          const batches = preparedResourceBatches;
          if (submitted) {
            internals.featureHost.markPreparedGraphicsSubmitted(batches);
            settlePreparedGraphicsCompletion(
              internals.featureHost,
              batches,
              internals.device.queue.onSubmittedWorkDone(),
              (error) => reportPreparedGraphicsCompletionError(internals, error),
            );
          } else {
            const retired = internals.featureHost.retirePreparedGraphics();
            if (!retired.ok) internals.errorRegistry.fire(retired.error);
          }
        }
      } catch (err) {
        if (!submitted) {
          internals.getPipelineState()?.perPassResources.discardBloomResources?.();
        }
        const innerError =
          err instanceof PipelineSpecError
            ? {
                name: err.name,
                code: err.code,
                message: err.message,
                detail: err.detail,
              }
            : err instanceof RhiError
              ? err
              : { code: 'unknown' as const, message: String(err), name: (err as Error)?.name };
        internals.errorRegistry.fire(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'RenderSystem to record one frame without an internal exception',
            hint: 'inspect detail.error for the underlying cause; next frame will retry',
            detail: { error: innerError },
          }),
        );
      } finally {
        if (ownsProfileFrame) {
          try {
            profileSession?.endFrame();
          } catch {
            // Profiler failures never alter rendering.
          }
        }
      }
      return submitted;
    },
    isDynamicGeometryConsumed(
      world: World,
      entity: number,
      meshHandle: number | undefined,
    ): boolean {
      if (!Number.isInteger(entity) || meshHandle === undefined) return false;
      return lastSubmittedDynamicGeometryBindings.get(world)?.get(entity) === meshHandle;
    },
    pipelineDispatchCounts: dispatchCounts,
    observeCurrentFrame(options: FrameObservationOptions) {
      const currentFrameId = frameState.frameNumber - 1;
      return observeCurrentFrame(options, frameState.currentFrameObservationSource, currentFrameId);
    },
    async observeLodOcclusion(): Promise<void> {
      await ensureOcclusionRuntime().waitForCompletions();
      applyLodSelectionTelemetry(await gpuDrivenProduction.readLodSelection());
      if (lastLodOcclusionInspection !== undefined) {
        const queryLatency = ensureOcclusionRuntime().inspectQueryLatency();
        lastLodOcclusionInspection = inspectLodOcclusion({
          ...lastLodOcclusionInspection,
          queryLatencyUs: {
            median: queryLatency.median,
            p95: queryLatency.p95,
            last: queryLatency.last,
          },
        });
      }
    },
    getCurrentGraphTarget(name: string) {
      const graph = frameState.perFrameGraph;
      if (graph === undefined || graph === null) return undefined;
      const descriptor = graph.getColorTargetDescriptor(name);
      const texture = graph.getColorTargetTexture(name);
      if (descriptor === undefined || texture === undefined) return undefined;
      return {
        name,
        texture,
        textureIdentity: getTextureIdentity(texture),
        descriptor,
        frameId: frameState.frameNumber - 1,
        graphGeneration: graph.graphGeneration,
      };
    },
    requestGraphTargetCapture(request: GraphTargetCaptureRequest) {
      frameState.graphTargetCapture = request;
    },
    bindGroupCounts: bindGroupCounts,
    get temporalFrame(): TemporalFrame | undefined {
      const accepted = frameState.temporalFrame;
      if (accepted === undefined) return undefined;
      return {
        ...accepted,
        currentViewProjection: new Float32Array(accepted.currentViewProjection),
        previousViewProjection:
          accepted.previousViewProjection === undefined
            ? undefined
            : new Float32Array(accepted.previousViewProjection),
        jitter: [accepted.jitter[0], accepted.jitter[1]],
        viewport: { ...accepted.viewport },
      };
    },
    frustumStats: lastFrustumStats,
    visibilityStats: lastVisibilityStats,
    get meshMaterialBindings(): readonly MeshMaterialBindingObservation[] {
      return lastMeshMaterialBindings;
    },
    get iblBinding(): import('./mesh-material-bindings').IblBindingInspection | undefined {
      return frameState.iblBindingInspection;
    },
    get perFramePassNames(): readonly string[] {
      return frameState.compiledFrameGraph?.inspect().passes.map((pass) => pass.name) ?? [];
    },
    get lastSuccessfulCameraAntialias(): CameraSnapshot['antialias'] | undefined {
      return frameState.lastSuccessfulCameraAntialias;
    },
    get perFrameGraphInfo(): CompiledRenderGraphInfo | undefined {
      return frameState.compiledFrameGraph?.inspect();
    },
    get recoveryEvidence(): RecoveryProductionEvidence {
      const graph = frameState.compiledFrameGraph?.inspect();
      return Object.freeze({
        producerRoots: createRendererProducerRootMatrix(),
        graph: Object.freeze({
          ready: graph !== undefined,
          generation: frameState.graphGeneration,
          passCount: graph?.passes.length ?? 0,
          resourceCount: graph?.resources.length ?? 0,
        }),
        residency: Object.freeze({
          meshResidencyEpoch: internals.gpuStore.meshResidencyEpoch,
        }),
        submissions: Object.freeze({
          count: submittedFrameCount,
          lastGeneration: lastSubmittedGeneration,
        }),
      });
    },
    get volumetricFog(): import('./volume/inspection').VolumetricFogInspection {
      return frameState.volumetricFogInspection;
    },
    configureStandard(config: RenderPipelineAsset['config']): void {
      const profileConfig = internals.standardProfile;
      const resolvedConfig =
        profileConfig === undefined
          ? config
          : {
              clusterGrid: DEFAULT_CLUSTER_GRID,
              ...(profileConfig.ssao ? { ssao: { enabled: true } } : {}),
              ...config,
            };
      if (resolvedConfig?.clusterGrid !== undefined) {
        const grid = resolvedConfig.clusterGrid;
        const gridResult = validateClusterGrid(grid);
        if (!gridResult.ok) {
          throw gridResult.error;
        }
      }
      if (resolvedConfig?.ssao?.enabled === true) {
        const ssaoResult = resolveSsaoParameters(resolvedConfig.ssao);
        if (!ssaoResult.ok) {
          throw ssaoResult.error;
        }
      }
      // Standard configuration no longer carries a handle (D-19: RenderPipelineAsset is
      // supplied as a POD at boot/swap time before a World exists). The
      // brand-number that `draw` compares to force a per-frame graph rebuild is
      // now a monotonic epoch bumped on every install -- distinct configs (and
      // even identical re-installs) trigger the rebuild, which is correct: install
      // is a rare boot/swap event, never a per-frame cost.
      installEpoch += 1;
      frameState.installedPipelineHandle = installEpoch;
      frameState.installedPipelineConfig = resolvedConfig;
    },
    registerBuiltinPostProcess(id: string, entry: PostProcessShaderEntry): () => void {
      // D-3: eager-create params UBO at register time + fail-fast
      // byteSize / defaultValue validation (q5=A).
      let paramsBuffer: Buffer | undefined;
      try {
        if (id !== 'forgeax.taa-resolve' && entry.params !== undefined) {
          const { byteSize, defaultValue } = entry.params;
          if (byteSize < 16 || defaultValue.length !== byteSize) {
            throw new PostProcessError({
              code: 'params-size-mismatch',
              detail: { byteSize, actualLength: defaultValue.length },
            });
          }
          const paramsBufferResult = internals.device.createBuffer({
            label: `post-process-params-${id}`,
            size: byteSize,
            usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
          });
          if (!paramsBufferResult.ok) throw paramsBufferResult.error;
          paramsBuffer = paramsBufferResult.value;
          const writeResult = internals.device.queue.writeBuffer(paramsBuffer, 0, defaultValue);
          if (!writeResult.ok) throw writeResult.error;
        } else if (id !== 'forgeax.taa-resolve' && entryHasDepthRead(entry)) {
          const paramsBufferResult = internals.device.createBuffer({
            label: `post-process-params-${id}`,
            size: DEPTH_MIN_PARAMS_BYTE_SIZE,
            usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
          });
          if (!paramsBufferResult.ok) throw paramsBufferResult.error;
          paramsBuffer = paramsBufferResult.value;
        }
        if (builtinPostProcessEntries.has(id)) {
          throw new PostProcessError({
            code: 'post-process-already-registered',
            detail: { id },
          });
        }
        builtinPostProcessEntries.set(id, entry);
        if (paramsBuffer !== undefined) postProcessParamsBuffers.set(id, paramsBuffer);
        const moduleLabel = postProcessShaderModuleLabel(id, entry.source);
        return () => {
          if (builtinPostProcessEntries.get(id) === entry) {
            builtinPostProcessEntries.delete(id);
          }
          const current = postProcessParamsBuffers.get(id);
          if (current !== undefined) {
            internals.device.destroyBuffer(current);
            postProcessParamsBuffers.delete(id);
          }
          clearPostProcessPipelineCache(id);
          internals.invalidateShaderModule?.(moduleLabel);
        };
      } catch (cause) {
        if (paramsBuffer !== undefined) internals.device.destroyBuffer(paramsBuffer);
        throw cause;
      }
    },
    lookupPostProcess,
    prepareRecoveryGraphCandidate: recoveryOwner.prepareRecoveryGraphCandidate,
    submitCandidateSetup: recoveryOwner.submitCandidateSetup,
    publishRecoveryGraphCandidate: recoveryOwner.publishRecoveryGraphCandidate,
    discardRecoveryGraphCandidate: recoveryOwner.discardRecoveryGraphCandidate,
    disposeFrameState(): void {
      (internals as TimingSessionHost).gpuPassTimingSession?.dispose();
      (internals as TimingSessionHost).gpuPassTimingSession = undefined;
      (internals as TimingSessionHost).gpuPassTimingCapture = undefined;
      (internals as TimingSessionHost).gpuPassTimingSubmittedWork = undefined;
      (internals as TimingSessionHost).gpuPassTimingFrameIdentity = undefined;
      (internals as TimingSessionHost).gpuPassTimingBeginReason = undefined;
      pointsLinesOwner.dispose();
      persistentRenderScene.dispose();
      instanceCollections.dispose();
      gpuDrivenProduction.dispose();
      occlusionRuntime?.dispose();
      disposeFeatureGpuWork();
      reflectionProbeOwner.dispose();
      // Bloom generations are renderer-owned rather than graph-owned. Drain
      // candidate, active, and fence-retiring bundles before the rest of the
      // frame state is torn down; the owner callback is idempotent so the
      // outer Renderer.dispose cascade can safely call this once only.
      internals.getPipelineState()?.perPassResources.drainBloomResources?.();
      internals.clearPostProcessPipelineCache?.('forgeax.taa-resolve');
      invalidatePostProcessModule('forgeax.taa-resolve');
      resetHdrpBuffers(internals);
      // Retire graph-owned resources and dispose instance-buffer caches.
      // Both calls are idempotent + tolerate per-handle errors silently;
      // the Renderer.dispose() cascade owns the surrounding try/catch
      // (D-3 method A: void signature, sub-errors fan out via
      // errorRegistry.fire at the cascade layer, dispose still walks all
      // 6 steps).
      frameState.directionalShadowCache = null;
      frameState.directionalShadowCacheRecorded = false;
      frameState.currentFrameObservationSource = undefined;
      frameState.lastSuccessfulCameraAntialias = undefined;
      frameState.currentDirectionalShadowView = null;
      frameState.currentSpotShadowView = null;
      if (frameState.temporalGpuState !== undefined) {
        retireTemporalGpuState(frameState.temporalGpuState);
        frameState.temporalGpuState = undefined;
      }
      if (frameState.activeTemporalGpuState !== undefined) {
        retireTemporalGpuState(frameState.activeTemporalGpuState);
        frameState.activeTemporalGpuState = undefined;
      }
      for (const retiring of frameState.retiringTemporalGpuStates) {
        retireTemporalGpuState(retiring);
      }
      frameState.retiringTemporalGpuStates.clear();
      settleVolumetricFogGraphCandidate(frameState, false);
      for (const buffer of frameState.volumetricFogParamsBuffers) {
        if (buffer === null) continue;
        const destroyed = internals.device.destroyBuffer(buffer);
        if (!destroyed.ok) internals.errorRegistry.fire(destroyed.error);
      }
      frameState.volumetricFogParamsBuffers = [null, null];
      frameState.volumetricFogParamsPendingSlot = null;
      frameState.volumetricFogParamsAcceptedSlot = null;
      frameState.volumetricFogAcceptedParams = undefined;
      frameState.volumetricFogPendingParams = undefined;
      frameState.volumetricFogAccepted = undefined;
      frameState.volumetricFogAcceptedContext = undefined;
      frameState.volumetricFogHistoryGraph = null;
      frameState.volumetricFogHistorySlot = null;
      frameState.volumetricFogHistorySignature = null;
      frameState.hdrpClusterMembership = null;
      const compiled = frameState.compiledFrameGraph;
      frameState.compiledFrameGraph = null;
      frameState.compiledFrameGraphTopologyKey = null;
      frameState.perFrameGraph = null;
      frameState.standardLightingGraphSignature = '';
      frameState.standardLightingInspection = undefined;
      frameState.pointShadowInspection = undefined;
      if (compiled !== null) compiled.retire().catch(() => undefined);
      for (const retired of frameState.retiredCompiledFrameGraphs) {
        retired.retire().catch(() => undefined);
      }
      frameState.retiredCompiledFrameGraphs.clear();
      // feat-20260619 M4 (D-6): pass errorRegistry to disposeInstanceBuffers
      // so destroy failures fire structured errors (unified per-frame +
      // dispose error strategy).
      disposeInstanceBuffers(frameState.instanceBuffers, internals.errorRegistry);
      frameState.instanceResidency?.clear();
      if (frameState.instanceBufferChunks !== undefined) {
        disposeInstanceBufferChunks(frameState.instanceBufferChunks, internals.errorRegistry);
      }
      disposeTransientInstanceBuffers(frameState.transientInstanceBuffers, internals.errorRegistry);
      if (frameState.probeBlendRecordBuffer !== undefined) {
        if (!frameState.probeBlendRecordBuffer.isDestroyed) {
          const result = frameState.probeBlendRecordBuffer.destroy();
          if (!result.ok) internals.errorRegistry.fire(result.error);
        }
        delete frameState.probeBlendRecordBuffer;
      }
      frameState.probeBlendRecordBufferCapacity = 0;
      frameState.probeBlendBuffers.clear();
      if (frameState.morphBuffers !== undefined) {
        for (const entry of frameState.morphBuffers.values()) {
          if (!entry.buffer.isDestroyed) {
            const result = entry.buffer.destroy();
            if (!result.ok) internals.errorRegistry.fire(result.error);
          }
        }
        frameState.morphBuffers.clear();
      }
      // feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-2: dispose the
      // cube_array shadow atlas owned by the RenderSystem closure. The atlas
      // is per-RenderSystem (= per Renderer) and is shared transparently
      // between URP and HDRP pipelines.
      // Idempotent: dispose() on a null / already-disposed atlas is a no-op.
      if (frameState.pointShadowAtlas !== null) {
        frameState.pointShadowAtlas.dispose();
        frameState.pointShadowAtlas = null;
      }
    },
    resetForRecover(retiringPipelineState?: PipelineState, replacementDevice?: RhiDevice): void {
      frameState.lastSuccessfulTemporalView = undefined;
      frameState.successfulTemporalFrameIndex = 0;
      frameState.pendingTemporalCommit = { kind: 'none' };
      // The active expansion buffers belong to the lost generation. Abandon
      // their handles without invoking destroy on a device that can no longer
      // service cleanup; the staged candidate owns the replacement buffers.
      pointsLinesOwner.abandonForDeviceLoss();
      ssrFormatReceipt = undefined;
      ssrFormatProbeGeneration = -1;
      ssrFormatProbe = undefined;
      ssrFallbackGeneration = undefined;
      transmissionAdmission.markDeviceLost();
      lastTransmissionKey = '';
      transmissionCapabilityGeneration = -1;
      transmissionCapability = undefined;
      // The replacement device cannot consume buffers minted by the lost
      // device.  Drop the shared Standard Cluster bundle before the next
      // frame asks for a new generation; resetHdrpBuffers fences the bundle
      // using its own device/queue instead of the replacement runtime device.
      resetHdrpBuffers(internals);
      // Keep the persistent material demand observable across device loss.
      // The physical resource has already been fenced by markDeviceLost(); the
      // detached inspection now exposes the rebuild-required lifecycle until a
      // completed frame admits the replacement resource.
      updateTransmissionInspection(lastTransmissionAntialias, false);
      persistentRenderScene.resetGpuForRecover();
      gpuDrivenProduction.dispose();
      // The active renderer still points at the lost device until the caller
      // completes the synchronous publication boundary. Bind the replacement
      // explicitly so the first published draw never routes through an owner
      // recreated against the old physical device.
      gpuDrivenProduction = GpuDrivenProduction.forDevice(
        replacementDevice ?? internals.device,
        gpuDrivenShaderFactory,
      );
      occlusionRuntime?.dispose();
      // The replacement device is installed by the host after this hook. Do
      // not recreate device-bound query resources against the lost device;
      // the first post-recovery frame lazily binds the current device.
      occlusionRuntime = undefined;
      disposeFeatureGpuWork();
      featureGpuWork = createFeatureGpuWorkOwner(internals);
      reflectionProbeOwner.dispose();
      // A recovered device cannot retain handles from the lost device. The
      // Bloom owner abandons candidates and retires every committed generation
      // before the new PipelineState is rebuilt.
      (
        retiringPipelineState ?? internals.getPipelineState()
      )?.perPassResources.drainBloomResources?.();
      // feat-20260622-s5 M3 / B-2 / w18: recover() rebuild drops device-bound
      // state minted by the lost device. The active graph and per-entity caches
      // must be discarded, not merely marked for destruction: their opaque
      // handles cannot be used on the fresh device and the next draw must
      // lazily build a new graph from the preserved ECS / asset POD caches.
      settleVolumetricFogGraphCandidate(frameState, false);
      frameState.compiledFrameGraph?.retire().catch(() => undefined);
      frameState.compiledFrameGraph = null;
      frameState.compiledFrameGraphTopologyKey = null;
      frameState.volumetricFogPreviousGraph = null;
      frameState.volumetricFogPreviousGraphKey = null;
      frameState.volumetricFogCandidateGraph = null;
      frameState.volumetricFogAccepted = undefined;
      frameState.volumetricFogAcceptedContext = undefined;
      frameState.volumetricFogHistoryGraph = null;
      frameState.volumetricFogHistorySlot = null;
      frameState.volumetricFogHistorySignature = null;
      // The old device owns these transient params buffers. Discard their
      // handles without calling destroy() on the lost device; the next frame
      // must allocate fresh buffers on the replacement device.
      frameState.volumetricFogParamsBuffers = [null, null];
      frameState.volumetricFogParamsPendingSlot = null;
      frameState.volumetricFogParamsAcceptedSlot = null;
      frameState.volumetricFogAcceptedParams = undefined;
      frameState.volumetricFogPendingParams = undefined;
      // Do not expose graph-owned texture/descriptor accessors from the lost
      // device while recovery is between generations. Inspection and capture
      // must remain detached until the replacement graph is accepted.
      frameState.perFrameGraph = null;
      frameState.standardLightingGraphSignature = '';
      frameState.standardLightingInspection = undefined;
      frameState.pointShadowInspection = undefined;
      frameState.directionalShadowCache = null;
      frameState.directionalShadowCacheRecorded = false;
      frameState.currentFrameObservationSource = undefined;
      frameState.lastSuccessfulCameraAntialias = undefined;
      frameState.temporalFrameTransaction.reset('device-recovery');
      frameState.temporalFrame = undefined;
      frameState.temporalFrameInput = undefined;
      frameState.lastSuccessfulTemporalView = undefined;
      frameState.successfulTemporalFrameIndex = 0;
      frameState.pendingTemporalCommit = { kind: 'none' };
      frameState.currentDirectionalShadowView = null;
      frameState.currentSpotShadowView = null;
      if (frameState.temporalGpuState !== undefined) {
        retireTemporalGpuState(frameState.temporalGpuState);
        frameState.temporalGpuState = undefined;
      }
      if (frameState.activeTemporalGpuState !== undefined) {
        retireTemporalGpuState(frameState.activeTemporalGpuState);
        frameState.activeTemporalGpuState = undefined;
      }
      for (const retiring of frameState.retiringTemporalGpuStates) {
        retireTemporalGpuState(retiring);
      }
      frameState.retiringTemporalGpuStates.clear();
      frameState.hdrpClusterMembership = null;
      for (const retired of frameState.retiredCompiledFrameGraphs) {
        retired.retire().catch(() => undefined);
      }
      frameState.retiredCompiledFrameGraphs.clear();
      frameState.instanceBuffers.clear();
      frameState.instanceBufferChunks?.clear();
      frameState.instanceResidency?.clear();
      delete frameState.probeBlendRecordBuffer;
      frameState.probeBlendRecordBufferCapacity = 0;
      frameState.probeBlendBuffers.clear();
      frameState.morphBuffers?.clear();
      frameState.transientInstanceBuffers = [];
      frameState.pointShadowAtlas = null;
      // Bind groups retain opaque handles from the lost device. WeakMap roots
      // cannot be cleared, so replace them; the Map-backed caches can be
      // emptied in place. The next frame recreates every binding from the
      // rebuilt PipelineState and fresh residency handles.
      frameState.viewBindGroupCache = new WeakMap();
      frameState.meshBindGroupCache = new WeakMap();
      frameState.materialBgPerEntity.clear();
      frameState.instancesBgPerEntity.clear();
      frameState.materialBgShared.clear();
      frameState.materialBgAssemblyCache.clear();
      frameState.singletonMaterialCache.clear();
      frameState.postProcessBgCache = new WeakMap();
      // Fullscreen PSOs are cached outside frameState because the normal
      // path reuses them across frames. They still carry opaque handles from
      // the lost device, so recovery must invalidate this cache alongside the
      // feature-host declarations and UBOs below.
      postProcessPipelineCache.clear();
      // Logical declarations and the active params bundle stay live until the
      // candidate post-process bundle crosses the publication boundary.
      resetRenderFeatureGraphState(internals);
    },
    prepareRecoveryPostProcessResources(device: RhiDevice) {
      return prepareRecoveryPostProcessResources(device);
    },
    publishRecoveryPostProcessResources(candidate: RecoveryPostProcessResources): void {
      publishRecoveryPostProcessResources(candidate);
    },
    discardRecoveryPostProcessResources(candidate: RecoveryPostProcessResources): void {
      discardRecoveryPostProcessResources(candidate);
    },
    restorePostProcessResources(): void {
      const prepared = prepareRecoveryPostProcessResources(internals.device);
      if (!prepared.ok) throw prepared.error;
      publishRecoveryPostProcessResources(prepared.value);
    },
    prepareRecoveryRoots(runtime: RecoveryRootRuntime): RecoveryRootBundle {
      // Snapshot only CPU projections/declarations here. The root create
      // callbacks below must never close over a mutable active owner while
      // LifecycleTransaction is awaiting candidate construction.
      const candidateEnvironmentLifecycle = environmentLifecycle.createRecoveryCandidate(
        runtime.scope,
      );
      const roots: LifecycleResourceSpec<unknown>[] = [];
      let candidateEnvironmentGeneration: EnvironmentGeneration | undefined;
      let environmentRootCleaned = false;
      let published = false;
      if (candidateEnvironmentLifecycle.hasRecoveryFrame()) {
        const environmentRoot = candidateEnvironmentLifecycle.createRecoveryRoot(runtime.scope);
        roots.push({
          ...environmentRoot,
          create: async () => {
            const generation = (await environmentRoot.create()) as EnvironmentGeneration;
            candidateEnvironmentGeneration = generation;
            return generation;
          },
          cleanup: (value) => {
            if (environmentRootCleaned) return;
            environmentRootCleaned = true;
            if (candidateEnvironmentGeneration === value) {
              candidateEnvironmentGeneration = undefined;
            }
            if (published) {
              candidateEnvironmentLifecycle.retirePublishedGeneration(
                value as EnvironmentGeneration,
              );
            } else {
              environmentRoot.cleanup(value);
            }
          },
        });
      }
      const graphCandidate = runtime.graphCandidate;
      if (graphCandidate !== undefined) {
        const releaseGraphCandidate = (): void => graphCandidate.release();
        const compiledGraph = graphCandidate.frameState.compiledFrameGraph;
        if (compiledGraph !== null) {
          roots.push({
            kind: 'pipeline',
            create: () => {
              if (!runtime.scope.isAlive()) {
                throw new Error('Recovery graph candidate scope is not active.');
              }
              if (graphCandidate.frameState.compiledFrameGraph !== compiledGraph) {
                throw new Error('Recovery graph candidate was changed before aggregate assembly.');
              }
              return compiledGraph;
            },
            // All graph/feature/GPU-driven candidate resources share one
            // owner. The root is a real release seam, not a marker; the
            // candidate latch makes every root cleanup call harmless after
            // the first one.
            cleanup: releaseGraphCandidate,
          });
        }
        if (graphCandidate.featureHost !== undefined) {
          const featureRoot = graphCandidate.featureHost.createRecoveryRoot(runtime.scope);
          roots.push({ ...featureRoot, cleanup: releaseGraphCandidate });
        }
        if (graphCandidate.featureGpuWork !== undefined) {
          const featureWorkRoot = graphCandidate.featureGpuWork.createRecoveryRoot(runtime.scope);
          roots.push({ ...featureWorkRoot, cleanup: releaseGraphCandidate });
        }
        if (graphCandidate.gpuDrivenProduction !== undefined) {
          const productionRoot = graphCandidate.gpuDrivenProduction.createRecoveryRoot(
            runtime.scope,
          );
          roots.push({ ...productionRoot, cleanup: releaseGraphCandidate });
        }
        if (graphCandidate.gpuDrivenScene?.state !== undefined) {
          const sceneRoot = graphCandidate.gpuDrivenScene.createRecoveryRoot(runtime.scope);
          roots.push({ ...sceneRoot, cleanup: releaseGraphCandidate });
        }
        if (graphCandidate.pointsLines !== undefined) {
          const pointsLinesRoot = graphCandidate.pointsLines.createRecoveryRoot(runtime.scope);
          roots.push({ ...pointsLinesRoot, cleanup: releaseGraphCandidate });
        }
        if (runtime.gpuStore.recoveryResourceCount() > 0) {
          const gpuStoreRoot = runtime.gpuStore.createRecoveryRoot(runtime.scope);
          roots.push({ ...gpuStoreRoot, cleanup: releaseGraphCandidate });
        }
      }
      let discarded = false;
      return {
        roots: Object.freeze(roots),
        publish: () => {
          if (published || discarded) return;
          if (
            candidateEnvironmentGeneration !== undefined &&
            !candidateEnvironmentGeneration.retired
          ) {
            environmentLifecycle.retireActiveForReplacement();
            candidateEnvironmentLifecycle.publish(candidateEnvironmentGeneration);
          }
          published = true;
          environmentLifecycle = candidateEnvironmentLifecycle;
          Object.assign(frameState, { environmentLifecycle });
        },
        discard: () => {
          if (published || discarded) return;
          discarded = true;
          if (candidateEnvironmentGeneration !== undefined) {
            candidateEnvironmentLifecycle.discard(candidateEnvironmentGeneration);
            candidateEnvironmentGeneration = undefined;
          }
          candidateEnvironmentLifecycle.discardRecoveryCandidates();
          // The transaction can fail before it reaches any graph root (for
          // example while the environment root is created). Keep the graph,
          // feature, GPU-driven, and residency resources on the same real
          // candidate owner in that case; later scope/factory cleanup is a
          // harmless repeat through the candidate latch.
          graphCandidate?.release();
          runtime.scope.abandon();
        },
      };
    },
  };
}

/** Resolve the build identity used by every inspection submit. */
export function resolveInspectionBuild(internals: Pick<RenderSystemInternals, 'build'>): string {
  return internals.build ?? 'render-system';
}

// @forgeax/engine-render - built-in record context extension.
//
// The public RenderPipelineContext is canonical in render-contract.ts. This
// owner adds only concrete assembly state for built-in record closures.

/**
 * Package-private extension consumed by the built-in record closures only.
 * Custom pipeline authors see the leaf RenderPipelineContext contract and
 * never this surface.
 */
