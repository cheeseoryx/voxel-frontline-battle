/** Staged frame state committed only after the renderer submit barrier. */
export interface RendererFrameTransaction<T> {
  readonly candidate: T;
  readonly commit: () => T;
  readonly abort: () => void;
}

export function stageRendererFrame<T>(
  candidate: T,
  onAbort: () => void = () => undefined,
): RendererFrameTransaction<T> {
  let closed = false;
  return {
    candidate,
    commit: () => {
      if (closed) throw new Error('renderer frame transaction is closed');
      closed = true;
      return candidate;
    },
    abort: () => {
      if (closed) return;
      closed = true;
      onAbort();
    },
  };
}

export type RendererFrameStage = 'build' | 'execute' | 'finish' | 'submit';

export interface RendererFrameStageFailure {
  readonly stage: RendererFrameStage;
}

export type RendererFrameStageResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly stage: RendererFrameStage };

export interface RendererFrameTransactionSteps<T> {
  readonly build: () => RendererFrameStageResult<T>;
  readonly execute: (candidate: T) => RendererFrameStageResult<void>;
  readonly finish: (candidate: T) => RendererFrameStageResult<void>;
  readonly submit: (candidate: T) => RendererFrameStageResult<void>;
  readonly commit: (candidate: T) => void;
  readonly abort?: (failure: RendererFrameStageFailure) => void;
  readonly generationFence?: RendererGenerationFence;
}

export interface RendererGenerationFence {
  readonly capturedGeneration: number;
  readonly currentGeneration: () => number;
}

export type ContinuationKind = 'readback' | 'query' | 'mapAsync' | 'queue-completion';

export interface ContinuationTerminationReason {
  readonly code: 'device-lost' | 'disposed' | 'stale-generation';
  readonly detail?: unknown;
}

export interface ContinuationTerminator {
  terminate(reason: ContinuationTerminationReason): boolean;
  promise(): Promise<ContinuationTerminationReason>;
  isTerminated(): boolean;
  guard(kind: ContinuationKind): boolean;
}

export function createContinuationTerminator(): ContinuationTerminator {
  let termination: ContinuationTerminationReason | undefined;
  let resolveTermination: ((reason: ContinuationTerminationReason) => void) | undefined;
  const terminated = new Promise<ContinuationTerminationReason>((resolve) => {
    resolveTermination = resolve;
  });
  return {
    terminate: (reason) => {
      if (termination !== undefined) return false;
      termination = Object.freeze({ ...reason });
      resolveTermination?.(termination);
      return true;
    },
    promise: () => terminated,
    isTerminated: () => termination !== undefined,
    guard: () => termination === undefined,
  };
}

/**
 * Run the four renderer stages behind one commit barrier. A stage can expose
 * only a structured failure; the candidate is never published until submit
 * has returned success, so a failed frame cannot advance last-known-good state.
 */
export function executeRendererFrameTransaction<T>(
  steps: RendererFrameTransactionSteps<T>,
):
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RendererFrameStageFailure } {
  const fail = (
    stage: RendererFrameStage,
  ): { readonly ok: false; readonly error: RendererFrameStageFailure } => {
    const error = { stage } as const;
    steps.abort?.(error);
    return { ok: false, error };
  };

  const built = steps.build();
  if (!built.ok) return fail('build');
  const executed = steps.execute(built.value);
  if (!executed.ok) return fail('execute');
  const finished = steps.finish(built.value);
  if (!finished.ok) return fail('finish');
  if (
    steps.generationFence !== undefined &&
    steps.generationFence.currentGeneration() !== steps.generationFence.capturedGeneration
  ) {
    return fail('submit');
  }
  const submitted = steps.submit(built.value);
  if (!submitted.ok) return fail('submit');
  steps.commit(built.value);
  return { ok: true, value: built.value };
}
