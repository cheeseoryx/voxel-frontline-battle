import type { Antialias } from '../components/camera';

type Jitter = readonly [number, number];

export const HALTON_23_8 = Object.freeze([
  Object.freeze([0, -1 / 6]),
  Object.freeze([-1 / 4, 1 / 6]),
  Object.freeze([1 / 4, -5 / 18]),
  Object.freeze([-3 / 8, -1 / 18]),
  Object.freeze([1 / 8, 5 / 18]),
  Object.freeze([-1 / 8, -7 / 54]),
  Object.freeze([3 / 8, 11 / 54]),
  Object.freeze([-7 / 16, 7 / 18]),
] as const);

export type TemporalResetReason =
  | 'first-frame'
  | 'resize'
  | 'camera-cut'
  | 'history-version'
  | 'view-switch'
  | 'environment-change'
  | 'fog-change'
  | 'device-recover'
  | 'submit-failure';

export interface TemporalViewInput {
  readonly antialias: Antialias;
  readonly width: number;
  readonly height: number;
  readonly frameIndex?: number;
  readonly historyVersion?: number;
  readonly viewIdentity?: string;
  readonly environmentSignature?: string;
  readonly fogSignature?: string;
  readonly deviceGeneration?: number;
  readonly cameraCut?: boolean;
  readonly historyValid?: boolean;
  readonly currentUnjitteredViewProjection?: ArrayLike<number> | undefined;
  readonly previousUnjitteredViewProjection?: ArrayLike<number> | undefined;
  readonly currentCameraPosition?: readonly [number, number, number] | undefined;
  readonly previousCameraPosition?: readonly [number, number, number] | undefined;
  readonly resetReason?: TemporalResetReason | undefined;
}

interface TemporalViewSnapshot {
  readonly antialias: Antialias;
  readonly width: number;
  readonly height: number;
  readonly frameIndex: number;
  readonly historyVersion: number;
  readonly viewIdentity: string;
  readonly environmentSignature: string;
  readonly fogSignature: string;
  readonly deviceGeneration: number;
  readonly cameraCut: boolean;
  readonly historyValid: boolean;
  readonly currentUnjitteredViewProjection: ArrayLike<number> | undefined;
  readonly previousUnjitteredViewProjection: ArrayLike<number> | undefined;
  readonly currentCameraPosition: readonly [number, number, number] | undefined;
  readonly previousCameraPosition: readonly [number, number, number] | undefined;
  readonly resetReason: TemporalResetReason | undefined;
}

export interface TemporalView {
  readonly input: Readonly<TemporalViewSnapshot>;
  readonly historyVersion: number;
  readonly mode: 'off' | 'taa';
  readonly jitter: readonly [number, number] | undefined;
  readonly jitterCancellationUv: readonly [number, number] | undefined;
  readonly currentJitterUv: readonly [number, number] | undefined;
  readonly historyValid: boolean;
  readonly temporalFrameIndex: number;
  /** Unjittered matrices are supplied by the renderer projection owner. */
  readonly currentUnjitteredViewProjection: ArrayLike<number> | undefined;
  readonly previousUnjitteredViewProjection: ArrayLike<number> | undefined;
  /** Camera origins follow the same accepted-submit boundary as the matrices. */
  readonly currentCameraPosition: readonly [number, number, number] | undefined;
  readonly previousCameraPosition: readonly [number, number, number] | undefined;
  readonly currentProjection: 'jittered' | 'unjittered';
  readonly previousProjection: 'unjittered';
  readonly historyRequired: boolean;
  readonly resetReason: TemporalResetReason | undefined;
}

function validDimension(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer.`);
  }
  return value;
}

export function createTemporalView(input: TemporalViewInput): TemporalView {
  const width = validDimension(input.width, 'width');
  const height = validDimension(input.height, 'height');
  const historyVersion = input.historyVersion ?? 0;
  const frameIndex = input.frameIndex ?? 0;
  const deviceGeneration = input.deviceGeneration ?? 0;
  if (!Number.isSafeInteger(historyVersion) || historyVersion < 0) {
    throw new RangeError('historyVersion must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
    throw new RangeError('frameIndex must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(deviceGeneration) || deviceGeneration < 0) {
    throw new RangeError('deviceGeneration must be a non-negative safe integer.');
  }
  const normalized: TemporalViewSnapshot = Object.freeze({
    ...input,
    width,
    height,
    frameIndex,
    historyVersion,
    viewIdentity: input.viewIdentity ?? 'camera:default',
    environmentSignature: input.environmentSignature ?? '',
    fogSignature: input.fogSignature ?? '',
    deviceGeneration,
    cameraCut: input.cameraCut ?? false,
    historyValid: input.historyValid ?? false,
    currentUnjitteredViewProjection: input.currentUnjitteredViewProjection,
    previousUnjitteredViewProjection: input.previousUnjitteredViewProjection,
    currentCameraPosition: input.currentCameraPosition,
    previousCameraPosition: input.previousCameraPosition,
    resetReason: input.resetReason,
  });
  const taa = input.antialias === 'taa';
  const jitter: Jitter | undefined = taa
    ? (HALTON_23_8[frameIndex % HALTON_23_8.length] as Jitter)
    : undefined;
  return Object.freeze({
    input: normalized,
    historyVersion,
    mode: taa ? 'taa' : 'off',
    jitter,
    jitterCancellationUv:
      jitter === undefined
        ? undefined
        : (Object.freeze([jitter[0] / width, jitter[1] / height]) as Jitter),
    currentJitterUv:
      jitter === undefined
        ? undefined
        : (Object.freeze([jitter[0] / width, jitter[1] / height]) as Jitter),
    historyValid: normalized.historyValid,
    temporalFrameIndex: frameIndex,
    currentUnjitteredViewProjection: input.currentUnjitteredViewProjection,
    previousUnjitteredViewProjection: input.previousUnjitteredViewProjection,
    currentCameraPosition: input.currentCameraPosition,
    previousCameraPosition: input.previousCameraPosition,
    currentProjection: taa ? 'jittered' : 'unjittered',
    previousProjection: 'unjittered',
    historyRequired: taa,
    resetReason: input.resetReason,
  });
}

export function resolveTemporalReset(
  previous: TemporalView | undefined,
  next: TemporalView,
): TemporalResetReason | undefined {
  if (next.mode !== 'taa') return undefined;
  if (previous === undefined || previous.mode !== 'taa') return 'first-frame';
  const before = previous.input;
  const after = next.input;
  if (before.width !== after.width || before.height !== after.height) return 'resize';
  if (after.cameraCut) return 'camera-cut';
  if (before.historyVersion !== after.historyVersion) return 'history-version';
  if (before.viewIdentity !== after.viewIdentity) return 'view-switch';
  if (before.environmentSignature !== after.environmentSignature) return 'environment-change';
  if (before.fogSignature !== after.fogSignature) return 'fog-change';
  if (before.deviceGeneration !== after.deviceGeneration) return 'device-recover';
  return undefined;
}
