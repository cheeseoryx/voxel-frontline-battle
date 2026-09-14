/**
 * Renderer-owned inspection PODs. Keeping these projections free of renderer
 * implementation imports prevents the observation contract from reopening the
 * extract/record dependency graph.
 */

import type { DirectionalShadowFilterLabel } from './components/directional-shadow-filter';
import type { PointsLinesInspection } from './points-lines/inspection';
import type { LodOcclusionInspection } from './scene/visibility/inspection';
import type { SsrAdmissionIdentity } from './ssr/identity';

export type {
  LodOcclusionInspection,
  LodOcclusionInspectionRow,
  LodOcclusionWorldAttribution,
  LodOcclusionWorldInspection,
} from './scene/visibility/inspection';

export interface LodOcclusionInspectionSummary extends LodOcclusionInspection {
  readonly timing?: {
    readonly medianUs: number;
    readonly p95Us: number;
    readonly samples: number;
  };
}

/**
 * SSR M0 inspection is a detached projection of the consumer admission
 * result. The admission owner remains in `ssr/admission`; this re-export
 * keeps inspection callers on the same typed identity and status vocabulary.
 */
export type {
  SsrAdmissionBudget,
  SsrAdmissionResult,
  SsrAdmissionWork,
  SsrDependenciesInspection,
  SsrFormatReceipt,
  SsrReflectionFallbackReceipt,
  SsrTemporalReceipt,
} from './ssr/admission';
export type {
  SsrAdmissionError,
  SsrAdmissionErrorCode,
  SsrAdmissionErrorDetail,
  SsrOwnerRecoveryAction,
} from './ssr/errors';
export type { SsrAdmissionIdentity } from './ssr/identity';

export interface LightInspectionInput {
  readonly generation: number;
  readonly candidate: string | undefined;
  readonly accepted: string | undefined;
  readonly lastKnownGood: string | undefined;
  readonly failure: string | undefined;
  readonly failureKeys: readonly string[];
  readonly resourceCount: number;
  readonly uploadBytes: number;
}

export type LightInspection = Readonly<LightInspectionInput>;

export function projectLightInspection(input: LightInspectionInput): LightInspection {
  return Object.freeze({
    generation: input.generation,
    candidate: input.candidate,
    accepted: input.accepted,
    lastKnownGood: input.lastKnownGood,
    failure: input.failure,
    failureKeys: [...input.failureKeys],
    resourceCount: input.resourceCount,
    uploadBytes: input.uploadBytes,
  });
}

export function lightInspectionIdentity(topology: string, generation: number): string {
  return `${topology}:generation-${generation}`;
}

export type BloomGraphStatus = 'empty' | 'valid' | 'invalid';

export interface BloomInspection {
  readonly graphStatus: BloomGraphStatus;
  readonly enabled: boolean;
  readonly targetCount: number;
  readonly targetBytes: number;
  readonly resourceCount: number;
  readonly passCount: number;
  readonly encodeCount: number;
  readonly bindGroupCount: number;
  readonly uploadCount: number;
  readonly residentChildBytes: number;
  readonly generation: number;
  readonly state: 'off' | 'active' | 'retiring';
}
export type { TransmissionInspection } from './transmission/inspection';

export interface BatchTopologyInspection {
  readonly revision: number;
  readonly batchCount: number;
  readonly candidateCount: number;
  readonly rebuilds: number;
  readonly patches: number;
  readonly ineligible: number;
}

export interface ProbeBlendRecordInspection {
  readonly objectKey: number;
  readonly generation: number;
  readonly localBlendFraction: number;
  readonly shPreblend: readonly number[];
  readonly byteLength: number;
  readonly candidate: boolean;
  readonly accepted: boolean;
  readonly lastKnownGood: boolean;
  readonly sentinel: string | undefined;
  readonly probeBlendIndex: number;
  readonly contributors: readonly {
    readonly identity: string;
    readonly distance: number;
    readonly radius: number;
    readonly coverage: number;
    readonly q: number;
    readonly qHat: number;
    readonly alpha: number;
  }[];
  readonly qHatSum: number;
  readonly rStar: number;
  readonly fallbackReason: string | undefined;
}

export interface ProbeSkyInspection {
  readonly available: boolean;
  readonly identity: string | undefined;
  readonly sourceKey: string | undefined;
  readonly irradiance: readonly [number, number, number];
  readonly fallbackReason: string | undefined;
}

export interface ProbeBlendInspection {
  readonly activeContributorCount: number;
  readonly admittedProbeCount: number;
  readonly coverage: number;
  readonly skyResidualFraction: number;
  readonly finite: boolean;
  readonly errorCode: 'capacity-exceeded' | 'invalid-admitted-prefix' | undefined;
  readonly records: readonly ProbeBlendRecordInspection[];
  readonly sky: ProbeSkyInspection;
  readonly dirtyVisitCount: number;
  readonly dirtyReasons: readonly string[];
  readonly receipt: {
    readonly activeIdentities: readonly string[];
    readonly admittedIdentities: readonly string[];
    readonly rejectedIdentities: readonly string[];
    readonly stableOrder: readonly string[];
    readonly capacity: number;
    readonly scaleRadius: number;
    readonly finite: boolean;
    readonly overflowReason: 'active-count-exceeds-capacity' | undefined;
  };
}

export interface GpuSceneTableInspection {
  readonly capacity: number;
  readonly bytes: number;
}

type GpuSceneTableName = 'primitive' | 'instance' | 'transform' | 'drawTemplate' | 'material';

export interface GpuSceneInspection {
  readonly capacity: number;
  readonly tables: Readonly<Record<GpuSceneTableName, GpuSceneTableInspection>>;
  readonly uploadRanges: number;
  readonly uploadBytes: number;
  readonly capacityGrows: number;
  readonly fullRebuilds: number;
  readonly clearedSlots: number;
  readonly noChangeFrames: number;
}

export interface GpuDrivenProductionInspection {
  readonly gpuOwnedSnapshotsMaterialized: number;
  readonly filteredPlanBuilds: number;
  readonly gpuOwnedEntityCount: number;
  readonly candidateUploadBytes: number;
  readonly batchUploadBytes: number;
  readonly viewConstantsUploadBytes: number;
  readonly batchBindGroupCreates: number;
  readonly viewBindGroupCreates: number;
  readonly topologyRevision: number | undefined;
  readonly validatedGpuOwnedRows: number;
  readonly cpuFallbackDrawItems: number;
  /** Index work accumulated by the real GPU LOD selector for the last submit. */
  readonly geometryWork: number;
  /** Level-0 index work for the same selected candidates. */
  readonly rootGeometryWork: number;
  /** `1 - geometryWork / rootGeometryWork` when the root denominator is non-zero. */
  readonly geometryWorkReduction: number;
  /** Number of selector batches in the last filtered production plan. */
  readonly batchCount: number;
  /** Number of non-zero-capacity indirect raster commands actually encoded. */
  readonly indirectDrawCount: number;
}

export type DirectionalShadowEffectiveProfile =
  | 'off'
  | DirectionalShadowFilterLabel
  | 'rhi-null-structural';

export type DirectionalShadowProfile = 'off' | DirectionalShadowFilterLabel;

export interface DirectionalShadowInspectionError {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
}

/** Bounded, detached Directional shadow facts for AI-readable inspection. */
export interface DirectionalShadowInspection {
  readonly requested: DirectionalShadowProfile;
  readonly effective: DirectionalShadowEffectiveProfile;
  readonly status: 'accepted' | 'fallback' | 'rejected';
  readonly fallbackReason?: 'webgl2-unsupported' | 'rhi-null-structural' | 'candidate-failed';
  readonly lastKnownGood: boolean;
  readonly pixelEvidence: 'available' | 'not-available';
  readonly cascadeCount: number;
  readonly mapSize: number;
  readonly atlasBytes: number;
  readonly writerPasses: number;
  readonly blockerTaps: number;
  readonly filterTapUpperBound: number;
  readonly seamTapUpperBound: number;
  readonly shadowAngularRadius: number | undefined;
  readonly maxPenumbraTexels: number | undefined;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
  readonly error?: DirectionalShadowInspectionError;
}

export type ReflectionProbeSelectionInspection =
  | { readonly kind: 'probe'; readonly worldId: number; readonly entityKey: number }
  | { readonly kind: 'skylight' };

export type ReflectionFallbackSource = 'probe' | 'skylight' | 'neutral';

export type ReflectionFallbackState = 'candidate' | 'active' | 'lkg' | 'neutral' | 'unavailable';

/** Detached committed fallback facts; never exposes a live GPU handle. */
export interface ReflectionFallbackReceipt {
  /** Device-scope owner that identifies the renderer transaction. */
  readonly rendererId?: string;
  /** Stable producer identity for this detached projection. */
  readonly producerId?: string;
  /** Stable main-pass renderable identity, when this is a per-renderable row. */
  readonly renderableKey?: string;
  /** Stable producer source identity, never a physical resource handle. */
  readonly sourceKey?: string;
  /** Frame number that produced this detached receipt. */
  readonly frameId?: number;
  readonly source: ReflectionFallbackSource;
  readonly sourceGeneration: number;
  readonly projectionGeneration: number;
  readonly deviceGeneration: number;
  readonly state: ReflectionFallbackState;
  readonly candidateVisible: false;
  readonly coverage: number;
  readonly extent?: readonly [number, number, number];
  readonly brdfSignature: string;
  /** Exact host identity of the detached producer transaction, when bound. */
  readonly identity?: SsrAdmissionIdentity;
}

/**
 * One completed readback for the frame-owned fallback attachment.
 *
 * This is an aggregate attachment fact, not a per-renderable row.  Row
 * receipts deliberately carry source/coverage identity only, so one pixel
 * cannot be mistaken for every renderable's BRDF result.
 */
export interface ReflectionFallbackReadbackReceipt {
  readonly rendererId: string;
  readonly producerId: string;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
  readonly textureIdentity: number;
  readonly format: string;
  readonly size: { readonly width: number; readonly height: number };
  readonly linearHdr: readonly [number, number, number, number];
  readonly readbackHash: string;
  readonly readbackStatus: 'complete';
}

export type ReflectionFallbackFailureStage =
  | 'prepare'
  | 'filter'
  | 'build'
  | 'encode'
  | 'finish'
  | 'submit'
  | 'completion';

export type ReflectionFallbackRecoveryAction =
  | 'use-LKG'
  | 'use-Skylight'
  | 'use-neutral'
  | 'recapture'
  | 'rebuild'
  | 'retry';

export interface ReflectionFallbackInspection {
  readonly receipt: ReflectionFallbackReceipt;
  readonly failureStage?: ReflectionFallbackFailureStage;
  readonly failureCode?: string;
  readonly expected?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly recoveryAction: ReflectionFallbackRecoveryAction;
}

export interface ReflectionProbeInspection {
  readonly selection: ReflectionProbeSelectionInspection;
  readonly factCount: number;
  readonly acceptedCount: number;
  readonly activeCount: number;
  readonly rawFacesCaptured: number;
  readonly filteredStepsCompleted: number;
  readonly filteredMipLevels: readonly number[];
  readonly scheduledRawFaces: number;
  readonly scheduledFilteredSteps: number;
  readonly pipelineReady: boolean;
  readonly pipelineWarmupAttempts: number;
  readonly pipelineWarmupFailure?: string;
  readonly reflectionFallback: ReflectionFallbackReceipt;
  /** Latest bounded fallback failure and owner-directed recovery action. */
  readonly reflectionFallbackInspection: ReflectionFallbackInspection;
  /** Bounded per-renderable projections; no live graph resources are included. */
  readonly reflectionFallbacks?: readonly ReflectionFallbackReceipt[];
  /** Completed frame attachment readback; separate from per-renderable rows. */
  readonly reflectionFallbackReadback?: ReflectionFallbackReadbackReceipt;
}

/** Detached semantic descriptor for the Standard scene-temporal producer. */
export interface TemporalTargetInspection {
  readonly identity: 'standard-scene-temporal';
  readonly producerId: 'forgeax::standard::scene-data';
  readonly schema: 'forgeax::scene-data::temporal-v1';
  readonly targetCount: 1;
  readonly descriptor: {
    readonly format: 'rgba16float';
    readonly width: number;
    readonly height: number;
    readonly sampleCount: 1;
    readonly bytes: number;
  };
}

/** Detached, bounded Motion Blur facts; no graph, device, target, or history handle. */
export type MotionBlurInspectionStatus = 'off' | 'active' | 'reset' | 'invalid';

export interface MotionBlurInspection {
  readonly enabled: boolean;
  readonly status: MotionBlurInspectionStatus;
  readonly shutterAngle: number;
  readonly maxRadiusPixels: number;
  readonly sampleCount: number;
  readonly temporalDemand: 'none' | 'scene-data-temporal-v1';
  readonly passName: 'motion-blur';
  readonly historyWrites: 0;
  readonly lastFailure?: 'invalid-params' | 'scene-data-unavailable';
}

export type RenderSceneResyncReason =
  | 'attach'
  | 'asset-catalog-changed'
  | 'shared-ref-changed'
  | 'unsupported-change'
  | 'non-rigid-lane'
  | 'explicit-invalidate';

export interface PersistentRenderSceneInspection {
  readonly worldEntitiesScanned: number;
  readonly fullRebuilds: number;
  readonly noChangeFrames: number;
  readonly deltaFrames: number;
  readonly transformUpdates: number;
  readonly lastResyncReason: RenderSceneResyncReason | undefined;
  readonly projectionRecords: number;
  /** Numeric probe ownership facts; no GPU handles or object graph references. */
  readonly probeBlend?: ProbeBlendInspection;
  readonly topology: BatchTopologyInspection;
  readonly gpu:
    | { readonly status: 'inactive' }
    | { readonly status: 'unsupported'; readonly reason: 'storage-buffer-unavailable' }
    | ({ readonly status: 'resident' } & GpuSceneInspection)
    | { readonly status: 'rebuild-pending' }
    | { readonly status: 'error' };
  /** Bounded retained authoring observations; no graph or backend handles. */
  readonly pointsLines: readonly PointsLinesInspection[];
}

export type RenderSceneInspection = PersistentRenderSceneInspection & {
  readonly gpuDriven: GpuDrivenProductionInspection;
};
