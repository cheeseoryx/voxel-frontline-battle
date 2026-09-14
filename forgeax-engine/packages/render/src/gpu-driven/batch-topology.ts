import type { PrimitiveTopology } from '@forgeax/engine-types';
import type { BatchTopologyInspection } from '../inspection-types';
import type { CameraSnapshot } from '../render-contract';
import type { RenderSceneApplyResult, RenderSceneSlot } from '../scene/render-scene-types';
import { type GpuLodRow, selectGpuLod } from '../scene/visibility/gpu-lod';
import { projectedHeight as measureProjectedHeight } from '../scene/visibility/lod-selector';
import type { PreparedGpuDrivenDraw } from './prepared-draw';

export type { BatchTopologyInspection } from '../inspection-types';

export interface GpuDrivenBatchKey {
  readonly assetHandle: number;
  readonly drawKind: 'indexed' | 'non-indexed';
  readonly first: number;
  readonly count: number;
  readonly baseVertex: number;
  readonly materialSlot: number;
  readonly topology: PrimitiveTopology;
  readonly pipelineClass: string;
  readonly materialResourceClass: string;
  /** Stable producer-owned identity; topology never derives this from a shader name. */
  readonly preparedIdentity?: string;
  /** Resource identity projected by the prepared material contract. */
  readonly resourceIdentity?: string;
  /** Closed admission lane for the prepared Standard PBR draw. */
  readonly admission?: 'opaque' | 'alpha-mask';
}

export interface GpuDrivenCandidate {
  readonly primitiveIndex: number;
  readonly generation: number;
  readonly drawItemIndex: number;
  readonly instanceOrdinal: number;
  /** Absolute coverage rows uploaded to the GPU selector; root is implicit. */
  readonly lodCoverages?: readonly number[];
  readonly lodHysteresis?: number;
  readonly projectedHeight?: number;
  readonly lodRanges?: readonly {
    readonly first: number;
    readonly count: number;
    readonly baseVertex: number;
  }[];
  readonly prepared?: PreparedGpuDrivenDraw;
}

export interface GpuDrivenBatch {
  readonly batchId: number;
  readonly generation: number;
  readonly key: GpuDrivenBatchKey;
  readonly candidates: readonly GpuDrivenCandidate[];
  readonly visibleBase: number;
  readonly visibleCapacity: number;
  readonly indirectOffset: number;
}

export interface SubmissionPlan {
  readonly revision: number;
  readonly batches: readonly GpuDrivenBatch[];
  readonly candidateCount: number;
  readonly visibleCapacity: number;
}

export interface GpuLodCandidateInput {
  readonly candidate: GpuDrivenCandidate;
  readonly rows: readonly GpuLodRow[];
  readonly projectedHeight: number;
  readonly previousLevel: number;
  readonly historyValid: boolean;
}

export interface GpuLodCompactCandidate {
  readonly candidate: GpuDrivenCandidate;
  readonly level: number;
  readonly confidence: number;
}

/** Selects one level per stable topology candidate without mutating membership. */
export function compactGpuLodCandidates(
  inputs: readonly GpuLodCandidateInput[],
): readonly GpuLodCompactCandidate[] {
  return Object.freeze(
    inputs.map((input) => {
      const selection = selectGpuLod(input.rows, input);
      return Object.freeze({ candidate: input.candidate, ...selection });
    }),
  );
}

interface MutableBatch {
  readonly batchId: number;
  readonly generation: number;
  readonly key: GpuDrivenBatchKey;
  readonly candidates: Map<string, GpuDrivenCandidate>;
}

function eligibleKeys(slot: RenderSceneSlot): readonly GpuDrivenBatchKey[] {
  const snapshot = slot.snapshot;
  const draws = snapshot.gpuDrivenDraws;
  if (
    draws === undefined ||
    draws.length === 0 ||
    snapshot.instances?.instanceCount === 0 ||
    snapshot.localAabb === undefined ||
    snapshot.skin !== undefined ||
    snapshot.morph !== undefined ||
    snapshot.spriteInstances !== undefined
  ) {
    return [];
  }
  return draws.flatMap((draw) => {
    const prepared = draw.prepared;
    const material = snapshot.materials[draw.materialSlot] ?? snapshot.material;
    if (prepared !== undefined) {
      const isStandardPbr =
        (material.materialShaderId === 'forgeax::default-standard-pbr' &&
          prepared.identity.material === 'forgeax::default-standard-pbr') ||
        (material.materialShaderId === 'forgeax::default-standard-pbr-skin' &&
          prepared.identity.material === 'forgeax::default-standard-pbr-skin');
      const isAlphaBlend =
        material.transparent === true || material.renderState?.blend !== undefined;
      if (!isStandardPbr || isAlphaBlend || prepared.identity.deformation !== 'rigid') return [];
      const preparedIdentity = `${prepared.identity.material}|${prepared.identity.geometry}|${prepared.identity.deformation}`;
      const admission =
        typeof material.paramSnapshot?.alphaCutoff === 'number' ? 'alpha-mask' : 'opaque';
      return [
        {
          assetHandle: snapshot.assetHandle,
          drawKind: draw.kind,
          first: prepared.first,
          count: prepared.count,
          baseVertex: prepared.baseVertex,
          materialSlot: draw.materialSlot,
          topology: prepared.topology,
          pipelineClass: preparedIdentity,
          materialResourceClass: draw.materialResourceClass,
          preparedIdentity,
          resourceIdentity: draw.materialResourceClass,
          admission,
        },
      ];
    }
    return [
      {
        assetHandle: snapshot.assetHandle,
        drawKind: draw.kind,
        first: draw.first,
        count: draw.count,
        baseVertex: draw.baseVertex,
        materialSlot: draw.materialSlot,
        topology: draw.topology,
        pipelineClass: draw.pipelineClass,
        materialResourceClass: draw.materialResourceClass,
      },
    ];
  });
}

function keyText(key: GpuDrivenBatchKey): string {
  return JSON.stringify(key);
}

/**
 * A GPU indirect draw has one index/vertex range for the whole batch.  LOD
 * selection is per candidate, so sharing a batch between LOD candidates would
 * let `finalizeView` pick the first candidate's range for every visible
 * instance. Keep LOD candidates in single-candidate batches; ordinary meshes
 * retain the existing compatibility batching path.
 */
function candidateBatchText(
  key: GpuDrivenBatchKey,
  primitiveIndex: number,
  drawItemIndex: number,
  instanceOrdinal: number,
  hasLod: boolean,
): string {
  return hasLod
    ? `${keyText(key)}|lod:${primitiveIndex}:${drawItemIndex}:${instanceOrdinal}`
    : keyText(key);
}

function membershipTexts(slot: RenderSceneSlot): readonly string[] {
  const keys = eligibleKeys(slot);
  const instanceCount = slot.snapshot.instances?.instanceCount ?? 1;
  const hasLod = (slot.snapshot.lods?.length ?? 0) > 0;
  const texts: string[] = [];
  for (let drawItemIndex = 0; drawItemIndex < keys.length; drawItemIndex += 1) {
    const key = keys[drawItemIndex];
    if (key === undefined) continue;
    for (let instanceOrdinal = 0; instanceOrdinal < instanceCount; instanceOrdinal += 1) {
      texts.push(candidateBatchText(key, slot.slot, drawItemIndex, instanceOrdinal, hasLod));
    }
  }
  return texts;
}

function alignInstanceBase(value: number): number {
  // Raster binds each batch's visible-index and compact-transform segment at
  // a static storage-buffer offset. WebGPU requires those offsets to satisfy
  // minStorageBufferOffsetAlignment (256 bytes on the portable baseline), so
  // both the u32 stream (64 entries) and mat4 stream (4 entries) align when
  // the shared instance base is a multiple of 64.
  return Math.ceil(value / 64) * 64;
}

export function projectedHeightForCandidate(slot: RenderSceneSlot, camera: CameraSnapshot): number {
  const aabb = slot.snapshot.localAabb;
  if (aabb === undefined || aabb.length < 6) return Number.NaN;
  const halfX = Math.abs((aabb[3] ?? 0) - (aabb[0] ?? 0)) * 0.5;
  const halfY = Math.abs((aabb[4] ?? 0) - (aabb[1] ?? 0)) * 0.5;
  const halfZ = Math.abs((aabb[5] ?? 0) - (aabb[2] ?? 0)) * 0.5;
  const world = slot.snapshot.transform.world;
  // Transform the local AABB's half extents through the absolute value of the
  // world 3x3. This is the conservative world-space sphere bound for every
  // rotation and signed/non-uniform scale, and keeps CPU projection aligned
  // with the world transform uploaded to the GPU selector.
  const worldHalfX =
    Math.abs(world[0] ?? 0) * halfX +
    Math.abs(world[4] ?? 0) * halfY +
    Math.abs(world[8] ?? 0) * halfZ;
  const worldHalfY =
    Math.abs(world[1] ?? 0) * halfX +
    Math.abs(world[5] ?? 0) * halfY +
    Math.abs(world[9] ?? 0) * halfZ;
  const worldHalfZ =
    Math.abs(world[2] ?? 0) * halfX +
    Math.abs(world[6] ?? 0) * halfY +
    Math.abs(world[10] ?? 0) * halfZ;
  const radius = Math.hypot(worldHalfX, worldHalfY, worldHalfZ);
  const dx = (world[12] ?? 0) - (camera.position[0] ?? 0);
  const dy = (world[13] ?? 0) - (camera.position[1] ?? 0);
  const dz = (world[14] ?? 0) - (camera.position[2] ?? 0);
  return measureProjectedHeight({
    radius,
    depth: Math.hypot(dx, dy, dz),
    projection: camera.projection,
    fov: camera.fov,
    orthoHeight: Math.abs(camera.orthoTop - camera.orthoBottom),
  });
}

/** Stable compatibility grouping; per-view visibility never mutates this owner. */
export class BatchTopology {
  private readonly batches = new Map<string, MutableBatch>();
  private readonly membershipByPrimitive = new Map<
    number,
    readonly { readonly batchText: string; readonly candidateKey: string }[]
  >();
  private readonly ineligiblePrimitives = new Set<number>();
  private readonly generationByBatchId: number[] = [];
  private readonly freeBatchIds: number[] = [];
  private revision = 0;
  private rebuilds = 0;
  private patches = 0;
  private cachedPlan: SubmissionPlan | undefined;

  rebuild(slots: readonly RenderSceneSlot[]): void {
    this.batches.clear();
    this.membershipByPrimitive.clear();
    this.ineligiblePrimitives.clear();
    this.generationByBatchId.length = 0;
    this.freeBatchIds.length = 0;
    for (const slot of slots) this.add(slot);
    this.revision += 1;
    this.rebuilds += 1;
    this.cachedPlan = undefined;
  }

  apply(delta: RenderSceneApplyResult): boolean {
    let changed = false;
    for (const removed of delta.removedSlots) changed = this.remove(removed.slot) || changed;
    for (const slot of delta.recreatedSlots) {
      changed = this.remove(slot.slot) || changed;
      changed = this.add(slot) || changed;
    }
    // Most updated slots are transform-only. A full renderable update can
    // still carry a changed material/geometry/draw topology, so compare the
    // stable batch memberships and patch only when that key actually changed.
    // This keeps moving entities on the zero-work transform lane while making
    // same-entity resource edits visible to the GPU-driven owner.
    for (const slot of delta.updatedSlots) {
      const previous = this.membershipByPrimitive.get(slot.slot) ?? [];
      const next = membershipTexts(slot);
      if (
        previous.length === next.length &&
        previous.every((membership, index) => membership.batchText === next[index])
      ) {
        continue;
      }
      changed = this.remove(slot.slot) || changed;
      changed = this.add(slot) || changed;
    }
    for (const slot of delta.createdSlots) changed = this.add(slot) || changed;
    if (changed) {
      this.revision += 1;
      this.patches += 1;
      this.cachedPlan = undefined;
    }
    return changed;
  }

  plan(): SubmissionPlan {
    if (this.cachedPlan !== undefined) return this.cachedPlan;
    const ordered = [...this.batches.values()].sort((left, right) => left.batchId - right.batchId);
    let visibleBase = 0;
    const batches = ordered.map((batch): GpuDrivenBatch => {
      visibleBase = alignInstanceBase(visibleBase);
      const candidates = [...batch.candidates.values()].sort(
        (left, right) =>
          left.primitiveIndex - right.primitiveIndex ||
          left.drawItemIndex - right.drawItemIndex ||
          left.instanceOrdinal - right.instanceOrdinal,
      );
      const result = {
        batchId: batch.batchId,
        generation: batch.generation,
        key: batch.key,
        candidates,
        visibleBase,
        visibleCapacity: candidates.length,
        indirectOffset: batch.batchId * 20,
      };
      visibleBase += candidates.length;
      return Object.freeze(result);
    });
    this.cachedPlan = Object.freeze({
      revision: this.revision,
      batches: Object.freeze(batches),
      candidateCount: batches.reduce((total, batch) => total + batch.candidates.length, 0),
      visibleCapacity: visibleBase,
    });
    return this.cachedPlan;
  }

  inspect(): BatchTopologyInspection {
    let candidateCount = 0;
    for (const batch of this.batches.values()) candidateCount += batch.candidates.size;
    return {
      revision: this.revision,
      batchCount: this.batches.size,
      candidateCount,
      rebuilds: this.rebuilds,
      patches: this.patches,
      ineligible: this.ineligiblePrimitives.size,
    };
  }

  private add(slot: RenderSceneSlot): boolean {
    const keys = eligibleKeys(slot);
    if (keys.length === 0) {
      this.ineligiblePrimitives.add(slot.slot);
      return false;
    }
    this.ineligiblePrimitives.delete(slot.slot);
    const memberships: Array<{ batchText: string; candidateKey: string }> = [];
    const instanceCount = slot.snapshot.instances?.instanceCount ?? 1;
    const hasLod = (slot.snapshot.lods?.length ?? 0) > 0;
    for (let drawItemIndex = 0; drawItemIndex < keys.length; drawItemIndex += 1) {
      const key = keys[drawItemIndex];
      if (key === undefined) continue;
      for (let instanceOrdinal = 0; instanceOrdinal < instanceCount; instanceOrdinal += 1) {
        const text = candidateBatchText(key, slot.slot, drawItemIndex, instanceOrdinal, hasLod);
        let batch = this.batches.get(text);
        if (batch === undefined) {
          const reused = this.freeBatchIds.pop();
          const batchId = reused ?? this.generationByBatchId.length;
          const generation =
            reused === undefined ? 0 : (this.generationByBatchId[batchId] ?? -1) + 1;
          this.generationByBatchId[batchId] = generation;
          batch = { batchId, generation, key, candidates: new Map() };
          this.batches.set(text, batch);
        }
        const candidateKey = `${slot.slot}:${drawItemIndex}:${instanceOrdinal}`;
        const draw = slot.snapshot.gpuDrivenDraws?.[drawItemIndex];
        const prepared = draw?.prepared;
        batch.candidates.set(candidateKey, {
          primitiveIndex: slot.slot,
          generation: slot.generation,
          drawItemIndex,
          instanceOrdinal,
          ...(draw?.projectedHeight === undefined ? {} : { projectedHeight: draw.projectedHeight }),
          ...(slot.snapshot.lods === undefined
            ? {}
            : {
                lodCoverages: [1, ...slot.snapshot.lods.map((lod) => lod.screenCoverage)],
                ...(slot.snapshot.gpuDrivenDraws?.[drawItemIndex]?.lodRanges === undefined
                  ? {}
                  : {
                      lodRanges: slot.snapshot.gpuDrivenDraws[drawItemIndex]
                        ?.lodRanges as readonly {
                        readonly first: number;
                        readonly count: number;
                        readonly baseVertex: number;
                      }[],
                    }),
                ...(slot.snapshot.lodHysteresis === undefined
                  ? {}
                  : { lodHysteresis: slot.snapshot.lodHysteresis }),
              }),
          ...(prepared === undefined ? {} : { prepared }),
        });
        memberships.push({ batchText: text, candidateKey });
      }
    }
    this.membershipByPrimitive.set(slot.slot, memberships);
    return true;
  }

  private remove(primitiveIndex: number): boolean {
    this.ineligiblePrimitives.delete(primitiveIndex);
    const memberships = this.membershipByPrimitive.get(primitiveIndex);
    this.membershipByPrimitive.delete(primitiveIndex);
    if (memberships === undefined) return false;
    for (const membership of memberships) {
      const batch = this.batches.get(membership.batchText);
      if (batch === undefined) continue;
      batch.candidates.delete(membership.candidateKey);
      if (batch.candidates.size === 0) {
        this.batches.delete(membership.batchText);
        this.freeBatchIds.push(batch.batchId);
      }
    }
    return true;
  }
}
