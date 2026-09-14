import { vec3 } from '@forgeax/engine-math';
import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import type { CameraSnapshot } from '../../render-contract';
import type { RenderableSnapshot } from '../../render-system-extract';
import type { TemporalView } from '../../temporal/temporal-view';
import type { ValidatedRenderable } from '../frame-snapshot';
import { uploadMeshSsboBatch } from '../mesh-ssbo';
import { writeViewUbo } from '../view-ubo';

function identityMatrix(): Float32Array {
  const matrix = new Float32Array(16);
  matrix[0] = 1;
  matrix[5] = 1;
  matrix[10] = 1;
  matrix[15] = 1;
  return matrix;
}

function translatedMatrix(x: number): Float32Array {
  const matrix = identityMatrix();
  matrix[12] = x;
  return matrix;
}

function recordingQueue(): {
  readonly queue: RhiQueue;
  readonly uploads: readonly Uint8Array[];
} {
  const uploads: Uint8Array[] = [];
  const queue = {
    writeBuffer: (
      _buffer: Buffer,
      _bufferOffset: number,
      data: ArrayBufferView | ArrayBuffer,
      _dataOffset?: number,
      size?: number,
    ) => {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data, 0, size ?? data.byteLength)
          : new Uint8Array(data.buffer, data.byteOffset, size ?? data.byteLength);
      uploads.push(new Uint8Array(bytes));
      return { ok: true, value: undefined } as const;
    },
  } as unknown as RhiQueue;
  return { queue, uploads };
}

function camera(): CameraSnapshot {
  return {
    entityKey: 1,
    worldId: 0,
    historyVersion: 0,
    position: vec3.create(0, 0, 5),
    world: identityMatrix(),
    fov: Math.PI / 3,
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
    whitePoint: 4,
    antialias: 'none',
    bloom: 'off',
    bloomThreshold: 1,
    bloomIntensity: 1,
    bloomBlurRadius: 4,
    clearColor: [0, 0, 0, 1],
  };
}

function temporalView(): TemporalView {
  const current = identityMatrix();
  current[0] = 2;
  const previous = identityMatrix();
  previous[0] = 3;
  return {
    viewId: '0:1:0',
    historyVersion: 0,
    temporalFrameIndex: 1,
    historyValid: true,
    resetReason: undefined,
    currentJitterUv: [0, 0],
    previousJitterUv: [0, 0],
    currentJitteredViewProjection: current,
    currentUnjitteredViewProjection: current,
    previousUnjitteredViewProjection: previous,
    projection: 'perspective',
    near: 0.1,
    far: 100,
  };
}

describe('temporal GPU payloads', () => {
  it('keeps the zero-directional fallback direction finite and unscaled', () => {
    const { queue, uploads } = recordingQueue();
    writeViewUbo(
      queue,
      {} as Buffer,
      camera(),
      {
        kind: 'directional',
        direction: vec3.create(0, -1, 0),
        color: vec3.create(0, 0, 0),
        intensity: 0,
      },
      { point: [], spot: [] } as never,
      [],
    );

    const payload = new Float32Array(uploads[0]?.buffer ?? new ArrayBuffer(0));
    expect(Array.from(payload.slice(16, 19))).toEqual([0, -1, 0]);
    expect(Array.from(payload.slice(20, 23))).toEqual([0, 0, 0]);
    expect(Array.from(payload.slice(16, 23)).every(Number.isFinite)).toBe(true);
  });

  it('keeps directional orientation independent from light intensity', () => {
    const { queue, uploads } = recordingQueue();
    writeViewUbo(
      queue,
      {} as Buffer,
      camera(),
      {
        kind: 'directional',
        direction: vec3.create(0.25, -0.5, 0.75),
        color: vec3.create(1, 1, 1),
        intensity: 4,
      },
      { point: [], spot: [] } as never,
      [],
    );

    const payload = new Float32Array(uploads[0]?.buffer ?? new ArrayBuffer(0));
    expect(Array.from(payload.slice(16, 19))).toEqual([0.25, -0.5, 0.75]);
  });

  it('writes temporal current/previous projection after the spot-light lanes', () => {
    const { queue, uploads } = recordingQueue();
    writeViewUbo(
      queue,
      {} as Buffer,
      camera(),
      {
        kind: 'directional',
        direction: vec3.create(0, -1, 0),
        color: vec3.create(1, 1, 1),
        intensity: 1,
      },
      { point: [], spot: [] } as never,
      [],
      temporalView(),
    );

    const payload = new Float32Array(uploads[0]?.buffer ?? new ArrayBuffer(0));
    expect(payload.length).toBe(240);
    expect(payload[196]).toBeCloseTo(Math.sqrt(3));
    expect(payload[212]).toBe(3);
    expect(payload[228]).toBeCloseTo(0.1);
    expect(payload[229]).toBe(100);
    expect(payload[230]).toBe(0);
  });

  it('seeds previousWorld on the first frame and uses the submitted snapshot later', () => {
    const first = translatedMatrix(4);
    const previous = translatedMatrix(2);
    const second = translatedMatrix(6);
    const makeEntry = (world: Float32Array, temporal?: object) =>
      ({
        source: {
          transform: { world },
          materials: [{ transparent: false }],
          ...(temporal === undefined ? {} : { temporal }),
        } as unknown as RenderableSnapshot,
      }) as unknown as ValidatedRenderable;
    const firstRecording = recordingQueue();
    uploadMeshSsboBatch(firstRecording.queue, { buffer: {} as Buffer }, [makeEntry(first)], null);
    const firstPayload = new Float32Array(firstRecording.uploads[0]?.buffer ?? new ArrayBuffer(0));
    expect(firstPayload[12]).toBe(4);
    expect(firstPayload[28 + 12]).toBe(4);

    const secondRecording = recordingQueue();
    uploadMeshSsboBatch(
      secondRecording.queue,
      { buffer: {} as Buffer },
      [
        makeEntry(second, {
          previousTransform: { world: previous },
          reactive: false,
        }),
      ],
      null,
    );
    const secondPayload = new Float32Array(
      secondRecording.uploads[0]?.buffer ?? new ArrayBuffer(0),
    );
    expect(secondPayload[12]).toBe(6);
    expect(secondPayload[28 + 12]).toBe(2);
    expect(secondPayload[44]).toBe(0);
  });
});
