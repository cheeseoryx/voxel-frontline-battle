// Public renderer facade and profile validation.
// This module narrows the lifetime-heavy host implementation to the stable
// lease/receipt contract and owns the profile/error projection helpers.

import { err, ok, type RhiError } from '@forgeax/engine-rhi';
import type {
  DynamicGeometryCandidate,
  DynamicGeometryOrdering,
  DynamicGeometryPrepareInput,
} from '../dynamic-geometry';
import { type RecoverFailure, RecoveryFailedError } from '../errors/recover';
import {
  type RenderError,
  RendererContractFailureError,
  type RendererOperationCause,
  RendererOperationError,
} from '../errors/render';
import {
  STANDARD_LIGHT_COUNTS,
  STANDARD_PIPELINE_ID,
  STANDARD_POST_STAGE_NAMES,
} from '../pipeline/standard-profile';
import type {
  Renderer,
  RendererError,
  RendererEventListener,
  RendererState,
  RenderInspection,
  RenderProfile,
  RenderResult,
} from '../render-contract';
import type { RendererHostImplementation } from './host-contract';
import { createRendererLifecycle, isRendererStateOperational } from './renderer-lifecycle';

/** Narrow the concrete host to the lease/receipt-only public contract. */
export function exposeRenderer(renderer: RendererHostImplementation): Renderer {
  const listeners = new Set<RendererEventListener>();
  const lifecycle = createRendererLifecycle(renderer.inspect().state);
  let disposed = lifecycle.state() === 'disposed';
  let recoverInFlight: Promise<RenderResult<void, RenderError>> | undefined;

  const emit = (event: Parameters<RendererEventListener>[0]): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (cause) {
        console.error('[Renderer.subscribe] listener threw:', cause);
      }
    }
  };
  const transition = (next: RendererState): void => {
    const previous = lifecycle.state();
    if (previous === next || !lifecycle.transition(next)) return;
    emit(Object.freeze({ kind: 'state-changed', previous, current: next }));
  };
  const eventError = (cause: RendererError): RenderError =>
    cause instanceof RendererOperationError
      ? cause
      : new RendererOperationError('device-operation-failed', {
          operation: 'renderer-event',
          cause: structuredRendererCause(cause, 'renderer-event'),
        });
  const drawError = (cause: RhiError | RenderError): RenderError => {
    if (cause instanceof RendererOperationError) return cause;
    if (cause instanceof RendererContractFailureError) {
      return new RendererOperationError('device-operation-failed', {
        operation: 'draw',
        cause: structuredRendererCause(cause, 'draw'),
      });
    }
    return new RendererOperationError('device-operation-failed', {
      operation: 'draw',
      cause: structuredRendererCause(cause, 'draw'),
    });
  };
  const offHostEvents = renderer.subscribeHostEvents((event) => {
    if (event.kind === 'error') {
      emit(Object.freeze({ kind: 'error', error: eventError(event.error) }));
      return;
    }
    transition(
      event.health.reason === 'device-lost'
        ? 'device-lost'
        : event.health.reason === 'internal-fault'
          ? 'faulted'
          : 'alive',
    );
  });

  return {
    attach: (world) => {
      const result = renderer.attach(world);
      return result.ok
        ? result
        : err(
            new RendererOperationError('world-lease-invalid', {
              operation: 'attach',
              cause: result.error,
            }),
          );
    },
    prepareDynamicGeometry: (input: DynamicGeometryPrepareInput) =>
      renderer.prepareDynamicGeometry(input),
    acceptDynamicGeometry: (
      candidate: DynamicGeometryCandidate,
      ordering: DynamicGeometryOrdering,
    ) => renderer.acceptDynamicGeometry(candidate, ordering),
    dynamicGeometryReceipt: (candidate: DynamicGeometryCandidate) =>
      renderer.dynamicGeometryReceipt(candidate),
    cancelDynamicGeometry: (candidate: DynamicGeometryCandidate) =>
      renderer.cancelDynamicGeometry(candidate),
    retireDynamicGeometry: (candidate: DynamicGeometryCandidate) =>
      renderer.retireDynamicGeometry(candidate),
    createRenderTarget: (descriptor) => renderer.createRenderTarget(descriptor),
    resizeRenderTarget: (target, descriptor) => renderer.resizeRenderTarget(target, descriptor),
    createRenderTargetTextureSource: (target, options) =>
      renderer.createRenderTargetTextureSource(target, options),
    requestTargetReadback: (target, request) => renderer.requestTargetReadback(target, request),
    destroyRenderTarget: (target) => renderer.destroyRenderTarget(target),
    setProfile: (profile) => {
      const state = lifecycle.state();
      if (!isRendererStateOperational(state)) {
        return err(
          new RendererOperationError('renderer-state-invalid', {
            operation: 'set-profile',
            state,
          }),
        );
      }
      return renderer.setProfile(profile);
    },
    state: () => lifecycle.state(),
    draw: (request) => {
      const state = lifecycle.state();
      if (!isRendererStateOperational(state)) {
        return err(
          new RendererOperationError('renderer-state-invalid', {
            operation: 'draw',
            state,
          }),
        );
      }
      const result = renderer.drawFrame(request);
      if (!result.ok) return err(drawError(result.error));
      emit(
        Object.freeze({
          kind: 'frame-submitted',
          frameId: result.value.frameId,
          deviceGeneration: result.value.deviceGeneration,
        }),
      );
      return ok(result.value);
    },
    inspect: () => ({ ...renderer.inspect(), state: lifecycle.state() }),
    observe: (receipt, request) => renderer.observe(receipt, request),
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    releaseSurface: () => {
      const result = renderer.releaseSurface();
      return result.ok
        ? result
        : err(
            new RendererOperationError('surface-unavailable', {
              operation: 'release-surface',
              cause: result.error,
            }),
          );
    },
    restoreSurface: () => {
      const result = renderer.restoreSurface();
      return result.ok
        ? result
        : err(
            new RendererOperationError('surface-unavailable', {
              operation: 'restore-surface',
              cause: result.error,
            }),
          );
    },
    recover: () => {
      if (recoverInFlight !== undefined) return recoverInFlight;
      const state = lifecycle.state();
      if (state !== 'device-lost') {
        return Promise.resolve(
          err(
            new RendererOperationError('renderer-state-invalid', {
              operation: 'recover',
              state,
            }),
          ),
        );
      }
      transition('recovering');
      recoverInFlight = renderer
        .recover()
        .then((result): RenderResult<void, RenderError> => {
          if (!result.ok) {
            const error = new RendererOperationError('recovery-failed', {
              operation: 'recover',
              ...projectRecoveryFailureDetail(result.error, renderer.inspect().recovery),
              cause: structuredRendererCause(result.error, 'recover'),
            });
            emit(Object.freeze({ kind: 'error', error }));
            return err(error);
          }
          return ok(undefined);
        })
        .finally(() => {
          transition(renderer.inspect().state);
          recoverInFlight = undefined;
        });
      return recoverInFlight;
    },
    dispose: async () => {
      if (disposed) return ok(undefined);
      const result = renderer.dispose();
      if (!result.ok) emit(Object.freeze({ kind: 'error', error: result.error }));
      disposed = true;
      transition('disposed');
      offHostEvents();
      listeners.clear();
      return result;
    },
  };
}

// ─── feat-20260520-directional-light-shadow-mapping M1c / w8 helpers ────────

// ─── Helpers ────────────────────────────────────────────────────────────────

export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}

export function structuredRendererCause(cause: unknown, operation: string): RendererOperationCause {
  if (typeof cause === 'object' && cause !== null) {
    const candidate = cause as Partial<RendererOperationCause>;
    if (
      typeof candidate.code === 'string' &&
      typeof candidate.expected === 'string' &&
      typeof candidate.hint === 'string'
    ) {
      return {
        code: candidate.code,
        expected: candidate.expected,
        hint: candidate.hint,
        ...(candidate.detail === undefined ? {} : { detail: candidate.detail }),
      };
    }
  }
  const contractFailure = new RendererContractFailureError(
    'draw',
    `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
  return {
    code: contractFailure.code,
    expected: contractFailure.expected,
    hint: contractFailure.hint,
    detail: contractFailure.detail,
  };
}

function projectRecoveryFailureDetail(
  failure: RecoverFailure,
  inspection: RenderInspection['recovery'],
): Omit<
  import('../errors/render').RendererOperationDetailByCode['recovery-failed'],
  'operation' | 'cause'
> {
  if (failure instanceof RecoveryFailedError) {
    return {
      phase: failure.detail.phase,
      oldGeneration: failure.detail.oldGeneration,
      candidateGeneration: failure.detail.candidateGeneration,
      attempt: failure.detail.attempt,
      elapsedMs: failure.detail.elapsedMs,
      retryable: failure.detail.retryable,
      guidance: failure.detail.guidance,
      owner: failure.detail.owner,
      resourceKind: failure.detail.resourceKind,
      lastOutcome: failure.detail.lastOutcome,
      rehydratedRoots: failure.detail.rehydratedRoots,
      staleLossEvents: failure.detail.staleLossEvents,
      cleanupFailures: Object.freeze(
        failure.detail.cleanupFailures.map((cause: unknown) =>
          structuredRendererCause(cause, 'recovery-cleanup'),
        ),
      ),
    };
  }
  const lastOutcome = inspection.lastOutcome === 'disposed' ? 'disposed' : 'failed';
  return {
    phase: inspection.phase ?? 'cleanup',
    oldGeneration: inspection.fromGeneration,
    candidateGeneration: inspection.candidateGeneration,
    attempt: inspection.attempt,
    elapsedMs: inspection.elapsedMs,
    retryable: false,
    guidance: 'rebuild-renderer',
    owner: inspection.failedOwner ?? 'renderer',
    resourceKind: inspection.failedResourceKind ?? 'pipeline',
    lastOutcome,
    rehydratedRoots: inspection.rehydratedRoots,
    staleLossEvents: inspection.staleLossEvents,
    cleanupFailures: Object.freeze([]),
  };
}

const RENDER_PROFILE_KEYS = new Set([
  'pipelineId',
  'lightCount',
  'renderPath',
  'shadows',
  'pbr',
  'ibl',
  'ssao',
  'postStages',
]);

export function validateRenderProfile(profile: RenderProfile): string | undefined {
  if (typeof profile !== 'object' || profile === null) return 'RenderProfile must be a POD object';
  const unknownKey = Object.keys(profile).find((key) => !RENDER_PROFILE_KEYS.has(key));
  if (unknownKey !== undefined) return `RenderProfile contains unsupported field '${unknownKey}'`;
  if (profile.pipelineId !== STANDARD_PIPELINE_ID) {
    return `RenderProfile.pipelineId must be '${STANDARD_PIPELINE_ID}'`;
  }
  if (!STANDARD_LIGHT_COUNTS.some((count) => count === profile.lightCount)) {
    return 'RenderProfile.lightCount must be 1, 32, or 256';
  }
  if (profile.renderPath !== 'forward' && profile.renderPath !== 'deferred') {
    return "RenderProfile.renderPath must be 'forward' or 'deferred'";
  }
  if (profile.shadows !== 'off' && profile.shadows !== 'hard' && profile.shadows !== 'filtered') {
    return "RenderProfile.shadows must be 'off', 'hard', or 'filtered'";
  }
  for (const field of ['pbr', 'ibl', 'ssao'] as const) {
    if (typeof profile[field] !== 'boolean') return `RenderProfile.${field} must be boolean`;
  }
  const stages = STANDARD_POST_STAGE_NAMES;
  if (
    !Array.isArray(profile.postStages) ||
    profile.postStages.length !== stages.length ||
    stages.some((stage, index) => profile.postStages[index] !== stage)
  ) {
    return 'RenderProfile.postStages must preserve the Standard post stage order';
  }
  return undefined;
}

export function freezeRenderProfile(profile: RenderProfile): RenderProfile {
  return Object.freeze({
    ...profile,
    postStages: Object.freeze([...profile.postStages]) as RenderProfile['postStages'],
  });
}
