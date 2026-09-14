import type { World } from '@forgeax/engine-ecs';
import type { RhiErrorCode } from '@forgeax/engine-rhi';

const MATRIX_STRIDE = 16;

export type InstanceCollectionId = number & {
  readonly __forgeaxInstanceCollectionId: unique symbol;
};

export interface InstanceCollectionInfo {
  readonly collectionId: InstanceCollectionId;
  readonly count: number;
  readonly revision: number;
}

export interface InstanceUploadRange {
  start: number;
  end: number;
}

export interface InstanceCollectionSnapshot extends InstanceCollectionInfo {
  readonly transforms: Float32Array;
}

/** The renderer-owned submission lane selected for one collection. */
export type InstanceSubmissionLane =
  | 'unresident'
  | 'direct-storage'
  | 'chunked-storage'
  | 'direct-uniform'
  | 'chunked-uniform'
  | 'unavailable';

/** Backend identity carried by collection residency and failure facts. */
export type InstanceBackendKind = 'webgpu' | 'wgpu-native' | 'wgpu-webgl2' | 'null' | 'unknown';

/** Closed record-stage failure vocabulary for collection residency. */
export type InstanceCollectionFailureCode = RhiErrorCode | 'queue-write-buffer-failed';

/** Typed producer facts retained when a collection cannot be admitted. */
export interface InstanceCollectionFailureFacts {
  readonly requestedBytes: number;
  readonly supportedBytes: number | undefined;
  readonly backend: InstanceBackendKind;
  readonly owner: 'renderer.instances';
  readonly cause: string;
  readonly recovery: string;
}

/** Detached, bounded collection evidence exposed by Renderer.inspect(). */
export interface InstanceCollectionInspection extends InstanceCollectionInfo {
  readonly residentGeneration: number | undefined;
  readonly lane: InstanceSubmissionLane;
  readonly uploadRanges: readonly InstanceUploadRange[];
  readonly uploadedBytes: number;
  readonly requestedBytes: number;
  readonly supportedBytes: number | undefined;
  readonly backend: InstanceBackendKind;
  readonly owner: 'renderer.instances';
  readonly error:
    | {
        readonly code: InstanceCollectionFailureCode;
        readonly expected: string;
        readonly hint: string;
        readonly detail: InstanceCollectionFailureFacts;
      }
    | undefined;
}

export interface InstanceResidency {
  readonly frameNumber: number;
  readonly residentGeneration: number | undefined;
  readonly lane: InstanceSubmissionLane;
  readonly uploadRanges: readonly InstanceUploadRange[];
  readonly uploadedBytes: number;
  readonly requestedBytes: number;
  readonly supportedBytes: number | undefined;
  readonly backend: InstanceBackendKind;
  readonly error: InstanceCollectionInspection['error'];
}

function appendRange(ranges: InstanceUploadRange[], start: number, end: number): void {
  if (start >= end) return;
  // Updates are allowed to arrive in any order. Insert at the first range
  // whose end reaches the new interval, then consume every range that starts
  // before the merged end. This preserves the complete union for both
  // adjacent and overlapping writes (for example [10, 12) then [8, 11)).
  let index = 0;
  while (index < ranges.length) {
    const existing = ranges[index];
    if (existing === undefined || existing.end >= start) break;
    index += 1;
  }
  while (index < ranges.length) {
    const existing = ranges[index];
    if (existing === undefined || existing.start > end) break;
    start = Math.min(start, existing.start);
    end = Math.max(end, existing.end);
    ranges.splice(index, 1);
  }
  ranges.splice(index, 0, { start, end });
}

interface CollectionRecord extends InstanceCollectionInfo {
  readonly world: World;
  readonly entity: number;
  readonly transforms: Float32Array;
}

/** Rebuildable per-renderer projection. World remains the authoring authority. */
export class InstanceProjectionStore {
  private nextId = 1;
  private identities = new WeakMap<World, Map<number, InstanceCollectionId>>();
  private readonly records = new Map<InstanceCollectionId, CollectionRecord>();

  project(world: World, entity: number, transforms: ArrayLike<number>): InstanceCollectionSnapshot {
    let entities = this.identities.get(world);
    if (entities === undefined) {
      entities = new Map();
      this.identities.set(world, entities);
    }
    let collectionId = entities.get(entity);
    if (collectionId === undefined) {
      collectionId = this.nextId++ as InstanceCollectionId;
      entities.set(entity, collectionId);
    }
    const previous = this.records.get(collectionId);
    const unchanged =
      previous !== undefined &&
      previous.transforms.length === transforms.length &&
      previous.transforms.every((value, index) => Object.is(value, transforms[index]));
    const record: CollectionRecord = unchanged
      ? previous
      : {
          collectionId,
          world,
          entity,
          transforms: new Float32Array(transforms),
          count: transforms.length / MATRIX_STRIDE,
          revision: (previous?.revision ?? 0) + 1,
        };
    this.records.set(collectionId, record);
    // Every consumer gets a complete snapshot. Reading never acknowledges an
    // upload; each GPU resident records its own successfully uploaded revision.
    return { ...this.info(record), transforms: record.transforms };
  }

  retain(ids: ReadonlySet<InstanceCollectionId>): void {
    for (const [id, record] of this.records) {
      if (ids.has(id)) continue;
      this.identities.get(record.world)?.delete(record.entity);
      this.records.delete(id);
    }
  }

  /** Release one producer-owned collection when its render identity is removed. */
  release(world: World, entity: number): void {
    const entities = this.identities.get(world);
    const collectionId = entities?.get(entity);
    if (collectionId === undefined) return;
    entities?.delete(entity);
    this.records.delete(collectionId);
  }

  dispose(): void {
    this.records.clear();
    this.identities = new WeakMap();
  }

  /**
   * Return detached residency facts for every live collection.
   *
   * @internal Joins CPU projection identity with the active device residency;
   * callers only receive immutable PODs and never GPU handles.
   */
  _inspections(
    residency: ReadonlyMap<InstanceCollectionId, InstanceResidency> | undefined,
    frameNumber: number,
  ): readonly InstanceCollectionInspection[] {
    return Object.freeze(
      [...this.records.values()].map((record) =>
        this.projectInspection(record, residency?.get(record.collectionId), frameNumber),
      ),
    );
  }

  private info(record: CollectionRecord): InstanceCollectionInfo {
    return Object.freeze({
      collectionId: record.collectionId,
      count: record.count,
      revision: record.revision,
    });
  }

  private projectInspection(
    record: CollectionRecord,
    residency: InstanceResidency | undefined,
    frameNumber: number,
  ): InstanceCollectionInspection {
    return Object.freeze({
      ...this.info(record),
      residentGeneration: residency?.residentGeneration,
      lane: residency?.lane ?? 'unresident',
      uploadRanges: Object.freeze(
        residency?.frameNumber === frameNumber
          ? residency.uploadRanges.map((range) => ({ ...range }))
          : [],
      ),
      uploadedBytes: residency?.frameNumber === frameNumber ? residency.uploadedBytes : 0,
      requestedBytes: residency?.requestedBytes ?? record.count * MATRIX_STRIDE * 4,
      supportedBytes: residency?.supportedBytes,
      backend: residency?.backend ?? 'unknown',
      owner: 'renderer.instances',
      error: residency?.error,
    });
  }
}

/** @internal Renderer record owner reports the accepted collection lane. */
export function recordInstanceResidency(
  residency: Map<InstanceCollectionId, InstanceResidency>,
  input: {
    readonly collectionId: InstanceCollectionId;
    readonly frameNumber: number;
    readonly residentGeneration: number;
    readonly lane: Exclude<InstanceSubmissionLane, 'unresident' | 'unavailable'>;
    readonly uploadRanges: readonly InstanceUploadRange[];
    readonly uploadedBytes: number;
    readonly requestedBytes: number;
    readonly supportedBytes: number | undefined;
    readonly backend: InstanceBackendKind;
  },
): void {
  const previous = residency.get(input.collectionId);
  const sameFrame =
    previous !== undefined &&
    previous.frameNumber === input.frameNumber &&
    previous.error === undefined;
  const uploadRanges = sameFrame
    ? [...previous.uploadRanges].reduce(
        (ranges, range) => {
          appendRange(ranges, range.start, range.end);
          return ranges;
        },
        input.uploadRanges.map((range) => ({ ...range })),
      )
    : input.uploadRanges.map((range) => ({ ...range }));
  residency.set(input.collectionId, {
    frameNumber: input.frameNumber,
    residentGeneration: input.residentGeneration,
    lane: input.lane,
    uploadRanges,
    uploadedBytes: sameFrame ? previous.uploadedBytes + input.uploadedBytes : input.uploadedBytes,
    requestedBytes: input.requestedBytes,
    supportedBytes: input.supportedBytes,
    backend: input.backend,
    error: undefined,
  });
}

/** @internal Renderer record owner reports a typed admission failure. */
export function recordInstanceFailure(
  residency: Map<InstanceCollectionId, InstanceResidency>,
  input: {
    readonly collectionId: InstanceCollectionId;
    readonly code: InstanceCollectionFailureCode;
    readonly expected: string;
    readonly hint: string;
    readonly facts: InstanceCollectionFailureFacts;
  },
): void {
  residency.set(input.collectionId, {
    frameNumber: -1,
    residentGeneration: undefined,
    lane: 'unavailable',
    uploadRanges: [],
    uploadedBytes: 0,
    requestedBytes: input.facts.requestedBytes,
    supportedBytes: input.facts.supportedBytes,
    backend: input.facts.backend,
    error: {
      code: input.code,
      expected: input.expected,
      hint: input.hint,
      detail: { ...input.facts },
    },
  });
}
