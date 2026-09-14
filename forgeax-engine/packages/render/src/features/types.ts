/** Public RenderFeature lifecycle, diagnostics, and host-context declarations. */
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { RhiCaps } from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import type { RenderError, RenderFeatureErrorDescriptor } from '../errors/render';
import type { VisibilitySnapshot } from '../extract/visibility';
import type { RenderFeaturePlan, RenderFeaturePlanContext } from './plan';
import type { RenderFeatureCapabilityKey } from './vocabulary';

export type {
  RenderFeatureCapabilityMissingDetail,
  RenderFeatureCleanupFailure,
  RenderFeatureDrawRecordingFailedDetail,
  RenderFeatureErrorCode,
  RenderFeatureErrorDescriptor,
  RenderFeaturePassOrderConflictDetail,
  RenderFeaturePreparationFailedDetail,
  RenderFeaturePreparedStateMismatchDetail,
  RenderFeatureRegistrationConflictDetail,
  RenderFeatureStageFailedDetail,
} from '../errors/render';
export type {
  RenderFeatureDispatch,
  RenderFeatureDraw,
  RenderFeatureDrawDeclaration,
  RenderFeatureFullscreenProgramDeclaration,
  RenderFeatureLogicalTarget,
  RenderFeaturePassDeclaration,
  RenderFeaturePlan,
  RenderFeaturePlanContext,
  RenderFeatureResourceDeclaration,
  RenderFeatureResourceUsage,
} from './plan';
export type { RenderFeatureTargetHandle } from './targets';
export type {
  PreparedKind,
  RenderFeatureCapabilityKey,
  RenderFeatureRecovery,
  RenderFeatureStage,
} from './vocabulary';

/** Closed lifecycle states exposed by the feature host. */
export type RenderFeatureStatus = 'active' | 'failed' | 'disabled' | 'disposed';

/**
 * Shader preparation policy for feature-owned GPU programs.
 *
 * `validated` waits for the backend's diagnostic-rich shader preparation before
 * exposing a module to the render graph. `immediate` is reserved for generated
 * feature programs that must hand a WebGPU module to pipeline creation without
 * serialising first-use on `getCompilationInfo()`; pipeline creation remains
 * the validation boundary for that mode.
 */
export type RenderFeatureShaderModuleMode = 'validated' | 'immediate';

export interface RenderFeatureResourceHandle {
  readonly __renderFeatureResource: unique symbol;
}

/** One World-local visibility snapshot prepared for the current frame batch. */
export interface RenderFeatureWorldVisibilitySnapshot {
  readonly world: World;
  readonly snapshot: VisibilitySnapshot;
}

/** A producer's structured report for one hidden render candidate. */
export interface RenderFeatureHiddenEntityReport {
  readonly world: World;
  readonly entity: EntityHandle;
}

export interface RenderFeatureExtractContext {
  readonly worlds: readonly World[];
  readonly owner: number;
  readonly frameNumber: number;
  /** Same-batch World snapshots; absent for synthetic direct feature probes. */
  readonly visibilitySnapshots?: readonly RenderFeatureWorldVisibilitySnapshot[];
  /** Host-owned report sink; feature code never owns the merged diagnostic. */
  readonly reportHiddenEntity?: (report: RenderFeatureHiddenEntityReport) => void;
}

/**
 * Producer-owned extension seam for one render frame.
 *
 * `FrameData` is the single value that crosses extract into the mandatory
 * declarative plan. The host derives preparation, graph access, recording,
 * recovery, and retirement from that plan; no producer callback receives GPU
 * authority or maintains a parallel lifecycle.
 */
export interface RenderFeature<FrameData> {
  readonly identity: string;
  readonly requiredCapabilities?: readonly RenderFeatureCapabilityKey[];
  /** Optional feature-owned shader preparation policy; defaults to `validated`. */
  readonly shaderModuleMode?: RenderFeatureShaderModuleMode;
  /**
   * Material shader identifiers whose modules must be ready before the first
   * frame. The renderer resolves these against the loaded manifest and seeds
   * the same lazy module cache used by prepared graphics.
   */
  readonly requiredMaterialShaders?: readonly string[];
  /**
   * Fullscreen program sources that must be module-ready before the first
   * frame. The renderer seeds the same lazy post-process module cache used by
   * the typed graph, so a synchronous frame driver cannot observe a cleared
   * target while a boot-installed effect is compiling.
   */
  readonly requiredFullscreenPostProcesses?: readonly {
    readonly identity: string;
    readonly source: string;
  }[];
  extract(context: RenderFeatureExtractContext): Result<FrameData, RenderError>;
  plan(data: FrameData, context: RenderFeaturePlanContext): Result<RenderFeaturePlan, RenderError>;
}

export interface RenderFeatureRecoverInput {
  readonly caps: Readonly<RhiCaps>;
  readonly frameNumber: number;
}

/** Read-only, machine-readable lifecycle state for one registered feature. */
export interface RenderFeatureDiagnostics {
  readonly identity: string;
  readonly order: number;
  readonly status: RenderFeatureStatus;
  readonly latestError: RenderFeatureErrorDescriptor | undefined;
}
