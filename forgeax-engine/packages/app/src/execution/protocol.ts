import type { AudioIntent } from '@forgeax/engine-audio';
import type { InputBackendSample } from '@forgeax/engine-input';
import type { CanvasDrawingBufferSize } from '../types';
import type { ExecutionAssetCatalog, ExecutionFrameInspection } from './types';

export interface ExecutionFrameMessage {
  readonly kind: 'frame';
  readonly worldIdentity: string;
  readonly frameId: number;
  readonly deltaSeconds: number;
  readonly inputSample: InputBackendSample;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

export interface ExecutionFrameCompletion {
  readonly kind: 'frame-complete';
  readonly worldIdentity: string;
  readonly frameId: number;
  /** Renderer queue-submit generation for the browser compositor witness. */
  readonly deviceGeneration?: number;
  readonly engineUpdateMs: number;
  readonly kernelWaitMs: number;
  readonly audioIntents?: readonly AudioIntent[];
  readonly kernelDispatch?: {
    readonly eligible: boolean;
    readonly usedShared: boolean;
    readonly reason: import('./types').KernelDispatchReason;
    readonly dispatched: number;
    readonly completed: number;
  };
}

export type FrameCompletionDisposition = 'accepted' | 'duplicate' | 'stale-world' | 'late';

export class FrameCreditLedger {
  private nextFrameId = 1;
  private inFlight: number | null = null;
  private completed = 0;
  private completedCount = 0;
  private submitted = 0;
  private highWater = 0;
  private throttledTicks = 0;

  constructor(readonly worldIdentity: string) {}

  issue(
    deltaSeconds: number,
    sampleInput: () => InputBackendSample,
    canvasSize: CanvasDrawingBufferSize = { width: 0, height: 0 },
  ): ExecutionFrameMessage | undefined {
    if (this.inFlight !== null) {
      this.throttledTicks += 1;
      return undefined;
    }
    const frameId = this.nextFrameId;
    this.nextFrameId += 1;
    this.inFlight = frameId;
    this.submitted += 1;
    this.highWater = Math.max(this.highWater, 1);
    return {
      kind: 'frame',
      worldIdentity: this.worldIdentity,
      frameId,
      deltaSeconds,
      inputSample: sampleInput(),
      canvasWidth: canvasSize.width,
      canvasHeight: canvasSize.height,
    };
  }

  complete(message: ExecutionFrameCompletion): FrameCompletionDisposition {
    if (message.worldIdentity !== this.worldIdentity) return 'stale-world';
    if (message.frameId <= this.completed) return 'duplicate';
    if (message.frameId !== this.inFlight) return 'late';
    this.completed = message.frameId;
    this.completedCount += 1;
    this.inFlight = null;
    return 'accepted';
  }

  inspect(): ExecutionFrameInspection {
    return {
      submitted: this.submitted,
      completed: this.completedCount,
      inFlight: this.inFlight === null ? 0 : 1,
      highWater: this.highWater,
      throttledTicks: this.throttledTicks,
    };
  }

  get hasCreditInFlight(): boolean {
    return this.inFlight !== null;
  }
}

export interface ExecutionInitMessage {
  readonly kind: 'init';
  readonly canvas: OffscreenCanvas;
  readonly bootstrapUrl: string;
  readonly bootstrapData?: import('./types').ExecutionBootstrapValue;
  readonly bootstrapPort?: MessagePort;
  /** Realm-serializable asset catalog configuration. */
  readonly assetCatalog?: ExecutionAssetCatalog;
  readonly shaderManifestUrl?: string;
  /** Exact checkout revision emitted by the host build-tool adapter. */
  readonly build?: string;
  readonly time?: import('@forgeax/engine-ecs').TimePolicy;
  readonly tier: import('./types').ExecutionTier;
}

export interface ExecutionHostControlMessage {
  readonly kind: 'host-control';
  readonly command: 'set-pointer-lock-allowed';
  readonly allowed: boolean;
}

export interface ExecutionReadyMessage {
  readonly kind: 'ready';
  readonly worldIdentity: string;
  readonly realm: 'worker';
  readonly workerWebGpu: boolean;
}

export interface ExecutionFaultMessage {
  readonly kind: 'fault';
  readonly worldIdentity: string | null;
  readonly source: 'bootstrap' | 'handshake' | 'runtime' | 'kernel' | 'world' | 'rebuild';
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: unknown;
  readonly partialWrite: boolean;
  readonly retryable: boolean;
}

export interface ExecutionRebuildMessage {
  readonly kind: 'rebuild';
  readonly worldIdentity: string;
}

export interface ExecutionRebuiltMessage {
  readonly kind: 'rebuilt';
  readonly previousWorldIdentity: string;
  readonly worldIdentity: string;
}

/** A serialized inspection request executed by the selected Engine realm. */
export interface ExecutionInspectMessage {
  readonly kind: 'inspect';
  readonly requestId: number;
  readonly code: string;
  /** World identity observed by the caller before the request was queued. */
  readonly worldIdentity: string;
}

export interface ExecutionInspectCancelMessage {
  readonly kind: 'inspect-cancel';
  readonly requestId: number;
  readonly worldIdentity: string;
}

export interface ExecutionInspectStartedMessage {
  readonly kind: 'inspect-started';
  readonly requestId: number;
  readonly worldIdentity: string;
}

/** Worker-side cancellation admission witness. `admitted` means execution may continue. */
export interface ExecutionInspectCanceledMessage {
  readonly kind: 'inspect-canceled';
  readonly requestId: number;
  readonly worldIdentity: string;
  readonly admitted: boolean;
}

export interface ExecutionInspectResultMessage {
  readonly kind: 'inspect-result';
  readonly requestId: number;
  readonly worldIdentity: string;
  readonly result:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: unknown };
}

export type HostToEngineMessage =
  | ExecutionInitMessage
  | ExecutionFrameMessage
  | ExecutionRebuildMessage
  | ExecutionInspectMessage
  | ExecutionInspectCancelMessage
  | { readonly kind: 'dispose' };
export type EngineToHostMessage =
  | ExecutionReadyMessage
  | ExecutionFrameCompletion
  | ExecutionFaultMessage
  | ExecutionRebuiltMessage
  | ExecutionInspectStartedMessage
  | ExecutionInspectCanceledMessage
  | ExecutionInspectResultMessage
  | ExecutionHostControlMessage;
