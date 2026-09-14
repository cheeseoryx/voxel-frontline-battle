import type { EntityHandle, Query, World } from '@forgeax/engine-ecs';
import { componentId } from '@forgeax/engine-ecs/internal';
import type { RenderReadLease, RenderReadVersion } from '@forgeax/engine-ecs/projection';
import { box3, frustum, mat4 } from '@forgeax/engine-math';
import { type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { ChildOf, GlobalTransform, MorphWeights, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  Camera,
  DirectionalLight,
  Instances,
  Layer,
  LightProbe,
  Lines,
  MeshFilter,
  MeshRenderer,
  MotionBlur,
  PointLight,
  PointLightShadow,
  Points,
  PostProcessParams,
  ReflectionProbe,
  SkyboxBackground,
  Skylight,
  SortKey,
  SpotLight,
  SpriteInstances,
  SpriteRegionOverride,
  Visibility,
} from '../components';
import type { DeviceScope, LifecycleResourceSpec } from '../device/device-scope';
import {
  BatchTopology,
  type BatchTopologyInspection,
  type SubmissionPlan,
} from '../gpu-driven/batch-topology';
import { GpuScene } from '../gpu-scene';
import type { PersistentRenderSceneInspection } from '../inspection-types';
import type { InstanceProjectionStore } from '../instances';
import { fingerprintNumericArray, InstanceBoundsCache } from '../instances-derived-bounds';
import type { PointsLinesInspection } from '../points-lines/inspection';
import type { PointsLinesRetainedSnapshot } from '../points-lines/snapshot';
import { worldEntityKey } from '../record/frame-snapshot';
import {
  type ReflectionProbeFact,
  ReflectionProbeProjection,
  type ReflectionProbeSelectionResult,
} from '../reflection/projection';
import type { CameraSnapshot } from '../render-contract';
import type {
  DispatchEntry,
  ExtractedFrame,
  MaterialSnapshot,
  MaterialSnapshotCachesByWorld,
  RenderableReactiveReason,
  RenderableSnapshot,
  RenderableTemporalSnapshot,
} from '../render-system-extract';
import type { SkinPaletteAllocator } from '../systems/skin-palette-allocator';
import {
  PersistentTransmissionDemandProjection,
  type TransmissionDemand,
  type TransmissionDemandOperation,
} from '../transmission/projection';
import { VolumetricFog } from '../volume/component';
import { ProbeBlendSceneProjection, type ProbeSceneObjectInput } from './probe-blend';
import type {
  RenderSceneApplyResult,
  RenderSceneBounds,
  RenderSceneInspection,
  RenderSceneOperation,
  RenderSceneRecord,
  RenderSceneResyncReason,
  RenderSceneSlot,
} from './render-scene-types';
import { createVisibilityBudget, type VisibilityBudget } from './visibility/budget';
import {
  primitiveKey,
  primitiveKeyId,
  VisibilityFacetStore,
  viewKey,
  viewKeyId,
} from './visibility/facet';
import { decideVisibility } from './visibility/occlusion-confidence';
import type { PrimitiveKey, ViewKey, VisibilityCandidate } from './visibility/types';

export type {
  RenderSceneApplyResult,
  RenderSceneBounds,
  RenderSceneIdentity,
  RenderSceneInspection,
  RenderSceneOperation,
  RenderSceneRecord,
  RenderSceneResyncReason,
  RenderSceneSlot,
} from './render-scene-types';

interface PendingIdentity {
  readonly worldId: number;
  readonly entityKey: number;
  readonly initial: RenderSceneSlot | undefined;
  current: RenderableSnapshot | undefined;
  removed: boolean;
  contentChanged: boolean;
}

interface WorldTransformSpan {
  readonly worldId: number;
  readonly entities: Readonly<Uint32Array>;
  readonly worlds: Readonly<Float32Array>;
}

type GlobalTransformChangeQuery = Query<readonly [typeof GlobalTransform]>;

/** The normal extract request used by the persistent scene owner. */
export type PersistentRenderCandidateRequest =
  | 'full'
  | 'none'
  | {
      readonly kind: 'partial';
      /** Entity keys are local to the corresponding World entry. */
      readonly entitiesByWorld: readonly (ReadonlySet<number> | undefined)[];
    };

export interface RenderSceneSubmissionCapture {
  readonly revision: number;
  readonly slots: readonly {
    readonly slot: number;
    readonly current: RenderSceneSlot | undefined;
  }[];
  readonly visible: ReadonlySet<string>;
}

export interface RenderSceneSubmissionDelta {
  readonly epoch: number;
  readonly slots: readonly number[];
}

function identityKey(worldId: number, entityKey: number): string {
  return `${worldId}:${entityKey}`;
}

const STANDARD_TRANSMISSION_SHADER = 'forgeax::default-standard-pbr';

function transmissionValue(material: MaterialSnapshot): number {
  const value = material.paramSnapshot?.transmission;
  return typeof value === 'number' ? value : 0;
}

function transmissionRoughness(material: MaterialSnapshot): number {
  const value = material.paramSnapshot?.roughness;
  return typeof value === 'number' ? value : material.roughness;
}

function transmissionDemandOperations(
  renderables: readonly RenderableSnapshot[],
): readonly TransmissionDemandOperation[] {
  const operations: TransmissionDemandOperation[] = [];
  for (const renderable of renderables) {
    for (const [materialIndex, material] of renderable.materials.entries()) {
      operations.push({
        kind: 'upsert',
        key: `${renderable.worldId}:${renderable.entityKey}:${materialIndex}`,
        candidate: {
          attached: true,
          ready:
            material.materialShaderId === STANDARD_TRANSMISSION_SHADER &&
            material.paramSnapshot !== undefined,
          transmission: transmissionValue(material),
          roughness: transmissionRoughness(material),
        },
      });
    }
  }
  return operations;
}

function ownSnapshot(snapshot: RenderableSnapshot): RenderableSnapshot {
  const { temporal: _temporal, ...current } = snapshot;
  return {
    ...current,
    transform: { ...snapshot.transform, world: new Float32Array(snapshot.transform.world) },
    ...(snapshot.localAabb === undefined
      ? {}
      : { localAabb: new Float32Array(snapshot.localAabb) }),
    ...(snapshot.instances === undefined
      ? {}
      : {
          instances: {
            ...snapshot.instances,
            transforms: new Float32Array(snapshot.instances.transforms),
          },
        }),
    ...(snapshot.spriteInstances === undefined
      ? {}
      : {
          spriteInstances: {
            ...snapshot.spriteInstances,
            transforms: new Float32Array(snapshot.spriteInstances.transforms),
            regions: new Float32Array(snapshot.spriteInstances.regions),
          },
        }),
    ...(snapshot.pointsLines === undefined
      ? {}
      : { pointsLines: ownPointsLinesSnapshot(snapshot.pointsLines) }),
    ...(snapshot.skinJointEntities === undefined
      ? {}
      : { skinJointEntities: [...snapshot.skinJointEntities] }),
  };
}

function ownPointsLinesSnapshot(
  snapshot: PointsLinesRetainedSnapshot,
): PointsLinesRetainedSnapshot {
  return {
    ...snapshot,
    style: snapshot.style === undefined ? undefined : { ...snapshot.style },
    sourceBounds: new Float32Array(snapshot.sourceBounds),
    viewport: { ...snapshot.viewport },
    projection: new Float32Array(snapshot.projection),
  };
}

function withWorld(snapshot: RenderableSnapshot, world: Float32Array): RenderableSnapshot {
  return {
    ...snapshot,
    transform: { ...snapshot.transform, world: new Float32Array(world) },
  };
}

function intersects(left: RenderSceneBounds, right: RenderSceneBounds): boolean {
  return (
    left.min[0] <= right.max[0] &&
    left.max[0] >= right.min[0] &&
    left.min[1] <= right.max[1] &&
    left.max[1] >= right.min[1] &&
    left.min[2] <= right.max[2] &&
    left.max[2] >= right.min[2]
  );
}

function worldBounds(
  snapshot: RenderableSnapshot,
  target?: RenderSceneBounds,
): RenderSceneBounds | undefined {
  const local = snapshot.localAabb;
  if (local === undefined || local.length < 6) return undefined;
  const world = snapshot.transform.world;
  const min = (target?.min ?? [0, 0, 0]) as [number, number, number];
  const max = (target?.max ?? [0, 0, 0]) as [number, number, number];
  const centerX = ((local[0] ?? 0) + (local[3] ?? 0)) * 0.5;
  const centerY = ((local[1] ?? 0) + (local[4] ?? 0)) * 0.5;
  const centerZ = ((local[2] ?? 0) + (local[5] ?? 0)) * 0.5;
  const extentX = ((local[3] ?? 0) - (local[0] ?? 0)) * 0.5;
  const extentY = ((local[4] ?? 0) - (local[1] ?? 0)) * 0.5;
  const extentZ = ((local[5] ?? 0) - (local[2] ?? 0)) * 0.5;
  const worldCenterX =
    (world[0] ?? 0) * centerX +
    (world[4] ?? 0) * centerY +
    (world[8] ?? 0) * centerZ +
    (world[12] ?? 0);
  const worldCenterY =
    (world[1] ?? 0) * centerX +
    (world[5] ?? 0) * centerY +
    (world[9] ?? 0) * centerZ +
    (world[13] ?? 0);
  const worldCenterZ =
    (world[2] ?? 0) * centerX +
    (world[6] ?? 0) * centerY +
    (world[10] ?? 0) * centerZ +
    (world[14] ?? 0);
  const worldExtentX =
    Math.abs(world[0] ?? 0) * extentX +
    Math.abs(world[4] ?? 0) * extentY +
    Math.abs(world[8] ?? 0) * extentZ;
  const worldExtentY =
    Math.abs(world[1] ?? 0) * extentX +
    Math.abs(world[5] ?? 0) * extentY +
    Math.abs(world[9] ?? 0) * extentZ;
  const worldExtentZ =
    Math.abs(world[2] ?? 0) * extentX +
    Math.abs(world[6] ?? 0) * extentY +
    Math.abs(world[10] ?? 0) * extentZ;
  min[0] = worldCenterX - worldExtentX;
  min[1] = worldCenterY - worldExtentY;
  min[2] = worldCenterZ - worldExtentZ;
  max[0] = worldCenterX + worldExtentX;
  max[1] = worldCenterY + worldExtentY;
  max[2] = worldCenterZ + worldExtentZ;
  return target ?? { min, max };
}

function boundsFromArray(bounds: ArrayLike<number>): RenderSceneBounds | undefined {
  if (bounds.length < 6) return undefined;
  const min: [number, number, number] = [Number(bounds[0]), Number(bounds[1]), Number(bounds[2])];
  const max: [number, number, number] = [Number(bounds[3]), Number(bounds[4]), Number(bounds[5])];
  if (
    !min.every(Number.isFinite) ||
    !max.every(Number.isFinite) ||
    min[0] > max[0] ||
    min[1] > max[1] ||
    min[2] > max[2]
  ) {
    return undefined;
  }
  return { min, max };
}

/**
 * The renderer's single rebuildable CPU scene authority.
 *
 * World/entity identity maps, stable slot generations, material reverse
 * lookup, and spatial facts live together here. Frame-local consumers read
 * snapshots from this owner and never create a second projection ledger.
 */
export class RenderScene {
  private readonly slots: Array<RenderSceneSlot | undefined> = [];
  private readonly lastSubmittedSlots: Array<RenderSceneSlot | undefined> = [];
  private readonly previousWorldBySlot: Array<Float32Array | undefined> = [];
  private readonly generations: number[] = [];
  private readonly freeSlots: number[] = [];
  private readonly slotsByWorld = new Map<number, Map<number, number>>();
  private readonly slotsByMaterial = new Map<number, Set<number>>();
  private readonly dirtySinceSubmitted = new Set<number>();
  private readonly transformUpdatedSlots: RenderSceneSlot[] = [];
  private temporalTracking = false;
  private lastSubmittedVisible = new Set<string>();
  private submittedEpoch = 0;
  // Bounds are a derived column of the stable render slot, not metadata of a
  // transient snapshot wrapper. Undefined means dirty; null means that the
  // retained row has no usable bounds and must be conservatively visible.
  private readonly worldBoundsBySlot: Array<RenderSceneBounds | null | undefined> = [];
  private readonly instanceBoundsCache = new InstanceBoundsCache();
  private orderedSlots: number[] = [];
  private materialized: RenderableSnapshot[] | undefined;
  private slotSnapshot: readonly RenderSceneSlot[] | undefined;
  private revision = 0;
  private noChangeFrames = 0;
  private deltaFrames = 0;
  private renderableScans = 0;
  private fullRebuilds = 0;
  private resyncs = 0;
  private lastResyncReason: RenderSceneResyncReason | undefined;

  /** Bounded current-scene facts for the Standard temporal producer. */
  temporalContributorCount(): number {
    return this.orderedSlots.length;
  }

  apply(operations: readonly RenderSceneOperation[]): RenderSceneApplyResult {
    if (operations.length === 0) {
      this.noChangeFrames += 1;
      this.renderableScans = 0;
      return this.emptyResult();
    }

    this.deltaFrames += 1;
    this.renderableScans = operations.length;
    const pendingByWorld = new Map<number, Map<number, PendingIdentity>>();
    const pendingOrder: PendingIdentity[] = [];
    let ignoredLateUpdates = 0;

    const pendingFor = (worldId: number, entityKey: number): PendingIdentity => {
      let entities = pendingByWorld.get(worldId);
      if (entities === undefined) {
        entities = new Map<number, PendingIdentity>();
        pendingByWorld.set(worldId, entities);
      }
      let pending = entities.get(entityKey);
      if (pending !== undefined) return pending;
      const initial = this.lookup(worldId, entityKey);
      pending = {
        worldId,
        entityKey,
        initial,
        current: initial?.snapshot,
        removed: false,
        contentChanged: false,
      };
      entities.set(entityKey, pending);
      pendingOrder.push(pending);
      return pending;
    };

    for (const operation of operations) {
      if (operation.kind === 'create') {
        const { worldId, entityKey } = operation.snapshot;
        const pending = pendingFor(worldId, entityKey);
        pending.current = ownSnapshot(operation.snapshot);
        pending.contentChanged = true;
        continue;
      }
      const pending = pendingFor(operation.worldId, operation.entityKey);
      if (operation.kind === 'remove') {
        pending.current = undefined;
        pending.removed = true;
        continue;
      }
      if (pending.current === undefined) {
        ignoredLateUpdates += 1;
        continue;
      }
      pending.current = withWorld(pending.current, operation.world);
    }

    let created = 0;
    let updated = 0;
    let removed = 0;
    let recreated = 0;
    const createdSlots: RenderSceneSlot[] = [];
    const updatedSlots: RenderSceneSlot[] = [];
    const contentUpdatedSlots: RenderSceneSlot[] = [];
    const removedSlots: RenderSceneRecord[] = [];
    const recreatedSlots: RenderSceneSlot[] = [];
    for (const pending of pendingOrder) {
      if (pending.initial === undefined) {
        if (pending.current === undefined) continue;
        const createdSlot = this.allocate(pending.current);
        this.dirtySinceSubmitted.add(createdSlot.slot);
        createdSlots.push(createdSlot);
        created += 1;
        continue;
      }
      if (pending.current === undefined) {
        this.dirtySinceSubmitted.add(pending.initial.slot);
        this.release(pending.initial);
        removedSlots.push(pending.initial);
        removed += 1;
        continue;
      }
      if (pending.removed) {
        this.dirtySinceSubmitted.add(pending.initial.slot);
        this.release(pending.initial);
        const recreatedSlot = this.allocate(pending.current);
        this.dirtySinceSubmitted.add(recreatedSlot.slot);
        recreatedSlots.push(recreatedSlot);
        recreated += 1;
        continue;
      }
      const updatedSlot: RenderSceneSlot = {
        ...pending.initial,
        snapshot: pending.current,
      };
      this.unindexMaterials(pending.initial);
      this.slots[pending.initial.slot] = updatedSlot;
      this.worldBoundsBySlot[updatedSlot.slot] = undefined;
      this.indexMaterials(updatedSlot);
      this.dirtySinceSubmitted.add(updatedSlot.slot);
      updatedSlots.push(updatedSlot);
      if (pending.contentChanged) contentUpdatedSlots.push(updatedSlot);
      updated += 1;
    }

    const changed = created + updated + removed + recreated > 0;
    if (changed) {
      this.revision += 1;
      this.invalidateSnapshots();
    }
    return {
      created,
      updated,
      removed,
      recreated,
      ignoredLateUpdates,
      createdSlots,
      updatedSlots,
      contentUpdatedSlots,
      removedSlots,
      recreatedSlots,
      resynced: 0,
    };
  }

  /** Apply version-selected GlobalTransform columns without allocating per-entity operations. */
  applyTransformSpans(spans: readonly WorldTransformSpan[]): RenderSceneApplyResult {
    this.deltaFrames += 1;
    let scanned = 0;
    let updated = 0;
    let ignoredLateUpdates = 0;
    const updatedSlots = this.transformUpdatedSlots;
    updatedSlots.length = 0;
    for (const span of spans) {
      scanned += span.entities.length;
      for (let row = 0; row < span.entities.length; row += 1) {
        const entity = span.entities[row];
        if (entity === undefined) continue;
        const slot = this.lookup(span.worldId, entity);
        if (slot === undefined) {
          ignoredLateUpdates += 1;
          continue;
        }
        const target = slot.snapshot.transform.world;
        const sourceStart = row * 16;
        for (let index = 0; index < 16; index += 1) {
          target[index] = span.worlds[sourceStart + index] ?? target[index] ?? 0;
        }
        if (slot.snapshot.instances === undefined) {
          const cached = this.worldBoundsBySlot[slot.slot];
          const bounds = worldBounds(slot.snapshot, cached ?? undefined);
          this.worldBoundsBySlot[slot.slot] = bounds ?? null;
        } else {
          this.worldBoundsBySlot[slot.slot] = undefined;
        }
        if (this.temporalTracking) this.dirtySinceSubmitted.add(slot.slot);
        updatedSlots.push(slot);
        updated += 1;
      }
    }
    this.renderableScans = scanned;
    if (updated > 0) this.revision += 1;
    return {
      created: 0,
      updated,
      removed: 0,
      recreated: 0,
      ignoredLateUpdates,
      createdSlots: [],
      updatedSlots,
      removedSlots: [],
      recreatedSlots: [],
      resynced: 0,
    };
  }

  /** Reconcile the current identity set while retaining slots for survivors. */
  reset(snapshots: readonly RenderableSnapshot[], countAsRebuild = true): void {
    // A full reconciliation is a temporal cut.  Survivors may keep their
    // stable slot, but no prior slot is valid until this frame submits.
    this.lastSubmittedSlots.length = 0;
    this.lastSubmittedVisible.clear();
    this.dirtySinceSubmitted.clear();
    this.submittedEpoch = 0;
    const desired = new Map<string, RenderableSnapshot>();
    for (const snapshot of snapshots) {
      desired.set(identityKey(snapshot.worldId, snapshot.entityKey), snapshot);
    }

    for (const slot of this.slots) {
      if (slot === undefined) continue;
      if (!desired.has(identityKey(slot.worldId, slot.entityKey))) this.release(slot);
    }

    this.orderedSlots = [];
    for (const snapshot of desired.values()) {
      const existing = this.lookup(snapshot.worldId, snapshot.entityKey);
      if (existing === undefined) {
        const created = this.allocate(snapshot);
        this.dirtySinceSubmitted.add(created.slot);
        continue;
      }
      const updated: RenderSceneSlot = {
        ...existing,
        snapshot: ownSnapshot(snapshot),
      };
      this.unindexMaterials(existing);
      this.slots[existing.slot] = updated;
      this.worldBoundsBySlot[updated.slot] = undefined;
      this.indexMaterials(updated);
      this.dirtySinceSubmitted.add(updated.slot);
      this.orderedSlots.push(existing.slot);
    }

    this.revision += 1;
    if (countAsRebuild) this.fullRebuilds += 1;
    this.invalidateSnapshots();
  }

  rebuild(snapshots: readonly RenderableSnapshot[]): void {
    this.reset(snapshots);
  }

  /** Enable previous-frame publication only while a temporal feature consumes it. */
  setTemporalTracking(enabled: boolean): void {
    if (enabled === this.temporalTracking) return;
    this.temporalTracking = enabled;
    if (!enabled) {
      this.dirtySinceSubmitted.clear();
      return;
    }
    for (const slot of this.orderedSlots) this.dirtySinceSubmitted.add(slot);
  }

  materialize(): RenderableSnapshot[] {
    if (this.materialized !== undefined) return this.materialized;
    const snapshots: RenderableSnapshot[] = [];
    for (const slot of this.orderedSlots) {
      const record = this.slots[slot];
      if (record !== undefined) snapshots.push(record.snapshot);
    }
    this.materialized = snapshots;
    return this.materialized;
  }

  lastSubmittedSlotByIndex(slot: number): RenderSceneSlot | undefined {
    return this.lastSubmittedSlots[slot];
  }

  temporalSnapshotBySlot(slot: number): RenderableTemporalSnapshot | undefined {
    const current = this.slots[slot];
    return current === undefined ? undefined : this.temporalSnapshot(current);
  }

  withTemporal(snapshot: RenderableSnapshot): RenderableSnapshot {
    const slot = this.lookup(snapshot.worldId, snapshot.entityKey);
    return slot === undefined ? snapshot : { ...snapshot, temporal: this.temporalSnapshot(slot) };
  }

  wasLastSubmittedVisible(slot: number, generation: number): boolean {
    return this.lastSubmittedVisible.has(`${slot}:${generation}`);
  }

  captureSubmission(
    visible: readonly Pick<RenderableSnapshot, 'worldId' | 'entityKey'>[],
  ): RenderSceneSubmissionCapture {
    const visibleSlots = new Set<string>();
    for (const snapshot of visible) {
      const slot = this.lookup(snapshot.worldId, snapshot.entityKey);
      if (slot !== undefined) visibleSlots.add(`${slot.slot}:${slot.generation}`);
    }
    return {
      revision: this.revision,
      slots: [...this.dirtySinceSubmitted].map((slot) => ({
        slot,
        current: this.slots[slot],
      })),
      visible: visibleSlots,
    };
  }

  commitSubmission(capture: RenderSceneSubmissionCapture): RenderSceneSubmissionDelta {
    if (capture.revision !== this.revision) {
      throw new RangeError('render scene changed while its temporal submission was active');
    }
    for (const update of capture.slots) {
      this.lastSubmittedSlots[update.slot] = update.current;
      const currentWorld = update.current?.snapshot.transform.world;
      if (currentWorld !== undefined) {
        let previousWorld = this.previousWorldBySlot[update.slot];
        if (previousWorld === undefined) {
          previousWorld = new Float32Array(16);
          this.previousWorldBySlot[update.slot] = previousWorld;
        }
        previousWorld.set(currentWorld);
      }
      this.dirtySinceSubmitted.delete(update.slot);
    }
    this.lastSubmittedVisible = new Set(capture.visible);
    this.submittedEpoch += 1;
    this.invalidateSnapshots();
    return {
      epoch: this.submittedEpoch,
      slots: capture.slots.map((update) => update.slot),
    };
  }

  slotsSnapshot(): readonly RenderSceneSlot[] {
    if (this.slotSnapshot !== undefined) return this.slotSnapshot;
    const records: RenderSceneSlot[] = [];
    for (const slot of this.orderedSlots) {
      const record = this.slots[slot];
      if (record !== undefined) records.push(record);
    }
    this.slotSnapshot = Object.freeze(records);
    return this.slotSnapshot;
  }

  slot(worldId: number, entityKey: number): RenderSceneSlot | undefined {
    return this.lookup(worldId, entityKey);
  }

  has(worldId: number, entityKey: number): boolean {
    return this.lookup(worldId, entityKey) !== undefined;
  }

  snapshot(worldId: number, entityKey: number): RenderableSnapshot | undefined {
    return this.lookup(worldId, entityKey)?.snapshot;
  }

  pointsLinesSnapshots(): readonly PointsLinesRetainedSnapshot[] {
    const snapshots: PointsLinesRetainedSnapshot[] = [];
    for (const slot of this.orderedSlots) {
      const record = this.slots[slot];
      const snapshot = record?.snapshot.pointsLines;
      if (record !== undefined && snapshot !== undefined) {
        snapshots.push(ownPointsLinesSnapshot({ ...snapshot, worldId: record.worldId }));
      }
    }
    return Object.freeze(snapshots);
  }

  slotsForMaterial(materialHandle: number): readonly RenderSceneSlot[] {
    const slots = this.slotsByMaterial.get(materialHandle);
    if (slots === undefined) return [];
    const records: RenderSceneSlot[] = [];
    for (const slot of slots) {
      const record = this.slots[slot];
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  querySpatial(bounds: RenderSceneBounds): readonly RenderSceneSlot[] {
    const records: RenderSceneSlot[] = [];
    for (const slot of this.orderedSlots) {
      const record = this.slots[slot];
      if (record === undefined) continue;
      const candidate = this.cullingWorldBoundsAt(record);
      if (candidate === null || candidate === undefined) continue;
      if (intersects(candidate, bounds)) records.push(record);
    }
    return records;
  }

  inspect(): RenderSceneInspection {
    return {
      records: this.slotsSnapshot().map(({ slot, generation, worldId, entityKey }) => ({
        slot,
        generation,
        worldId,
        entityKey,
      })),
      slotCapacity: this.slots.length,
      freeSlots: this.freeSlots.length,
      revision: this.revision,
      noChangeFrames: this.noChangeFrames,
      deltaFrames: this.deltaFrames,
      renderableScans: this.renderableScans,
      fullRebuilds: this.fullRebuilds,
      resyncs: this.resyncs,
      lastResyncReason: this.lastResyncReason,
    };
  }

  private emptyResult(): RenderSceneApplyResult {
    return {
      created: 0,
      updated: 0,
      removed: 0,
      recreated: 0,
      ignoredLateUpdates: 0,
      createdSlots: [],
      updatedSlots: [],
      removedSlots: [],
      recreatedSlots: [],
      resynced: 0,
    };
  }

  private lookup(worldId: number, entityKey: number): RenderSceneSlot | undefined {
    const slot = this.slotsByWorld.get(worldId)?.get(entityKey);
    return slot === undefined ? undefined : this.slots[slot];
  }

  private allocate(snapshot: RenderableSnapshot): RenderSceneSlot {
    const reused = this.freeSlots.pop();
    const slot = reused ?? this.slots.length;
    const generation = reused === undefined ? 0 : (this.generations[slot] ?? -1) + 1;
    const record: RenderSceneSlot = {
      slot,
      generation,
      worldId: snapshot.worldId,
      entityKey: snapshot.entityKey,
      snapshot: ownSnapshot(snapshot),
    };
    let previousWorld = this.previousWorldBySlot[slot];
    if (previousWorld === undefined) {
      previousWorld = new Float32Array(16);
      this.previousWorldBySlot[slot] = previousWorld;
    }
    previousWorld.set(record.snapshot.transform.world);
    this.generations[slot] = generation;
    this.slots[slot] = record;
    this.worldBoundsBySlot[slot] = undefined;
    let entities = this.slotsByWorld.get(snapshot.worldId);
    if (entities === undefined) {
      entities = new Map<number, number>();
      this.slotsByWorld.set(snapshot.worldId, entities);
    }
    entities.set(snapshot.entityKey, slot);
    this.indexMaterials(record);
    this.orderedSlots.push(slot);
    return record;
  }

  private release(record: RenderSceneSlot): void {
    this.slots[record.slot] = undefined;
    this.worldBoundsBySlot[record.slot] = undefined;
    this.instanceBoundsCache.invalidate(record.entityKey, record.worldId);
    this.unindexMaterials(record);
    const entities = this.slotsByWorld.get(record.worldId);
    entities?.delete(record.entityKey);
    if (entities?.size === 0) this.slotsByWorld.delete(record.worldId);
    const orderIndex = this.orderedSlots.indexOf(record.slot);
    if (orderIndex >= 0) this.orderedSlots.splice(orderIndex, 1);
    this.freeSlots.push(record.slot);
  }

  private indexMaterials(record: RenderSceneSlot): void {
    for (const material of record.snapshot.materials) {
      const handle = material.materialHandle ?? 0;
      let slots = this.slotsByMaterial.get(handle);
      if (slots === undefined) {
        slots = new Set<number>();
        this.slotsByMaterial.set(handle, slots);
      }
      slots.add(record.slot);
    }
  }

  private unindexMaterials(record: RenderSceneSlot): void {
    for (const material of record.snapshot.materials) {
      const handle = material.materialHandle ?? 0;
      const slots = this.slotsByMaterial.get(handle);
      slots?.delete(record.slot);
      if (slots?.size === 0) this.slotsByMaterial.delete(handle);
    }
  }

  private temporalSnapshot(slot: RenderSceneSlot): RenderableTemporalSnapshot {
    const submitted = this.lastSubmittedSlots[slot.slot];
    const sameGeneration = submitted?.generation === slot.generation;
    const wasVisible =
      sameGeneration && this.lastSubmittedVisible.has(`${slot.slot}:${slot.generation}`);
    const reasons: RenderableReactiveReason[] = [];
    if (!sameGeneration) {
      reasons.push(submitted === undefined ? 'new-slot' : 'generation-reuse');
    } else if (!wasVisible) {
      reasons.push('reentered');
    }
    if (
      sameGeneration &&
      submitted !== undefined &&
      submitted.snapshot.assetHandle !== slot.snapshot.assetHandle
    ) {
      reasons.push('geometry-revision');
    }
    if (
      sameGeneration &&
      submitted !== undefined &&
      submitted.snapshot.materials !== slot.snapshot.materials
    ) {
      reasons.push('material-revision');
    }
    const seedCurrent =
      !sameGeneration ||
      !wasVisible ||
      reasons.includes('geometry-revision') ||
      reasons.includes('material-revision');
    const previous = seedCurrent || submitted === undefined ? slot.snapshot : submitted.snapshot;
    const previousWorld = this.previousWorldBySlot[slot.slot];
    return {
      previousEpoch: seedCurrent ? undefined : this.submittedEpoch,
      previousSource: seedCurrent ? 'current-seed' : 'last-submitted',
      reactive: reasons.length > 0,
      reactiveReasons: reasons,
      previousTransform:
        seedCurrent || previousWorld === undefined
          ? previous.transform
          : { ...previous.transform, world: previousWorld },
      previousInstances: previous.instances,
      previousSkin: previous.skin,
      previousMorphWeights: previous.morph?.weights,
    };
  }

  private invalidateSnapshots(): void {
    this.materialized = undefined;
    this.slotSnapshot = undefined;
  }

  /**
   * Return the CPU culling projection for one retained snapshot. Instances
   * use a renderer-derived union, while the GPU scene keeps the mesh-local
   * bounds for its independent per-instance visibility pass. Unknown or
   * empty instance facts deliberately return undefined (conservative no-cull).
   */
  cullingWorldBoundsAt(slot: RenderSceneSlot): RenderSceneBounds | undefined {
    let candidate = this.worldBoundsBySlot[slot.slot];
    if (candidate !== undefined) return candidate ?? undefined;
    const snapshot = slot.snapshot;
    if (snapshot.instances !== undefined) {
      const instanceCount = snapshot.instances.instanceCount;
      if (instanceCount === 0 || snapshot.localAabb === undefined) {
        this.worldBoundsBySlot[slot.slot] = null;
        return undefined;
      }
      const derived = this.instanceBoundsCache.get({
        worldId: snapshot.worldId,
        entityKey: snapshot.entityKey,
        meshGeneration: fingerprintNumericArray(snapshot.localAabb) ^ (snapshot.assetHandle >>> 0),
        transformGeneration: fingerprintNumericArray(snapshot.transform.world),
        matrixGeneration: snapshot.instances.revision ?? snapshot.instances.archVersion,
        meshAabb: snapshot.localAabb,
        entityWorld: snapshot.transform.world,
        transforms: snapshot.instances.transforms,
      });
      candidate = boundsFromArray(derived ?? []);
    } else {
      candidate = worldBounds(snapshot, candidate ?? undefined);
    }
    this.worldBoundsBySlot[slot.slot] = candidate ?? null;
    return candidate;
  }

  cullingWorldBounds(snapshot: RenderableSnapshot): RenderSceneBounds | undefined {
    const slot = this.lookup(snapshot.worldId, snapshot.entityKey);
    return slot === undefined ? worldBounds(snapshot) : this.cullingWorldBoundsAt(slot);
  }
}

export interface PersistentRenderSceneOptions {
  readonly getDevice?: (() => RhiDevice) | undefined;
  readonly onGpuError?: ((error: RhiError) => void) | undefined;
  readonly onSharedRefMutation?: ((worldId: number, handle: number) => void) | undefined;
  readonly configuredQueryBudget?: number | undefined;
  /** Rebuildable projection of World-owned instance matrices. */
  readonly instanceCollections?: InstanceProjectionStore | undefined;
  readonly getSkinPaletteAllocator?: (() => SkinPaletteAllocator | null) | undefined;
}

export interface PersistentGpuDrivenState {
  readonly scene: GpuScene;
  readonly plan: SubmissionPlan;
  readonly slots: readonly RenderSceneSlot[];
  /** Stable renderer-local World keys aligned with RenderSceneSlot.worldId. */
  readonly worldKeys?: readonly number[];
}

export interface CpuDirectViewInput {
  readonly view: ViewKey;
  readonly primitives: readonly PrimitiveKey[];
}

export interface CpuDirectCandidate {
  readonly view: ViewKey;
  readonly primitive: PrimitiveKey;
  readonly candidate: VisibilityCandidate;
}

/**
 * The one renderer-owned submission projection for a display view.
 *
 * Occlusion completion updates the facet asynchronously, so extraction must
 * retain every query candidate while record/prepare consume this projection.
 * Keeping the dispatch reindex here prevents CPU direct and GPU indirect
 * lanes from rebuilding a second visibility map with different identity
 * semantics.
 */
export interface PersistentVisibilityProjection {
  readonly renderables: readonly RenderableSnapshot[];
  readonly dispatch: readonly DispatchEntry[];
  readonly activeEntityKeys: ReadonlySet<number>;
  /** Monotonic owner revision for exactly this active-key projection. */
  readonly activeEntityRevision: number;
  readonly suppressed: number;
}

/** Project one selected candidate per view and primitive from the facet owner. */
export function projectCpuDirectCandidates(
  facets: VisibilityFacetStore,
  views: readonly CpuDirectViewInput[],
): readonly CpuDirectCandidate[] {
  const candidates: CpuDirectCandidate[] = [];
  for (const { view, primitives } of views) {
    for (const primitive of primitives) {
      const candidate = facets.getCandidate(view, primitive);
      if (candidate !== undefined) candidates.push({ view, primitive, candidate });
    }
  }
  return candidates;
}

/** Detached GPU scene prepared from the retained CPU composition. */
export interface PersistentGpuDrivenCandidate {
  readonly state: PersistentGpuDrivenState | undefined;
  /** Candidate-owned scene root; never references the active GPU scene. */
  createRecoveryRoot(scope: DeviceScope): LifecycleResourceSpec<unknown>;
  publish(): void;
  discard(): void;
  /** Release the candidate scene even after it has crossed publication. */
  release(): void;
}

export interface RenderSceneRecoveryRoot {
  readonly generation: number;
  readonly revision: number;
  readonly visibleSlots: number;
}

type PersistentGpuSceneInspection = PersistentRenderSceneInspection['gpu'];

interface PersistentCompositionEntry {
  readonly token: object;
  readonly worlds: readonly World[];
  readonly cameraOwner: number;
  readonly resourceOwner: number;
  readonly projection: RenderScene;
  readonly topology: BatchTopology;
  readonly transmissionDemand: PersistentTransmissionDemandProjection;
  structure: Pick<
    ExtractedFrame,
    | 'dispatch'
    | 'visibilityStats'
    | 'visibilitySnapshots'
    | 'featureVisibilitySnapshots'
    | 'hiddenEntityReports'
  >;
  /** Stable renderer-local World keys; unlike RenderableSnapshot.worldId they survive reorder. */
  readonly worldKeys: readonly number[];
  readonly readVersions: RenderReadVersion[];
  readonly leaseIdentities: readonly string[];
  readonly transformQueries: readonly GlobalTransformChangeQuery[];
  readonly renderChangeQueries: readonly ReadonlyMap<number, Query>[];
  readonly dispatchBySlot: Map<number, readonly DispatchEntry[]>;
  dispatchRevision: number;
  dispatchCache:
    | { readonly revision: number; readonly value: readonly DispatchEntry[] }
    | undefined;
  readonly skinConsumersByJoint: Map<string, Set<number>>;
  /** Renderable identities whose partial producer still needs a successful publish. */
  readonly pendingRenderableEntitiesByWorld: Set<number>[];
  /** Slots retained for recovery but excluded from direct and indirect submission. */
  readonly unavailableSlots: Set<number>;
  catalogEpoch: number;
  readonly probeProjection: ProbeBlendSceneProjection;
  temporalDemanded: boolean;
  gpuDrivenSceneRequired: boolean;
}

const RENDER_RELEVANT_COMPONENT_IDS = new Set([
  componentId(GlobalTransform),
  componentId(ChildOf),
  componentId(MeshFilter),
  componentId(MeshRenderer),
  componentId(Instances),
  componentId(SpriteInstances),
  componentId(SpriteRegionOverride),
  componentId(Skin),
  componentId(Layer),
  componentId(Visibility),
  componentId(MorphWeights),
  componentId(Points),
  componentId(Lines),
  componentId(SortKey),
  componentId(Camera),
  componentId(MotionBlur),
  componentId(DirectionalLight),
  componentId(LightProbe),
  componentId(PointLight),
  componentId(PointLightShadow),
  componentId(SpotLight),
  componentId(Skylight),
  componentId(SkyboxBackground),
  componentId(PostProcessParams),
  componentId(ReflectionProbe),
  componentId(VolumetricFog),
]);

// These components can change the retained renderable source. Other relevant
// components affect frame resources and still require a composition rebuild;
// they must not cause a renderable-only partial extraction to silently retain
// stale lights, cameras, or environment facts.
const RENDERABLE_SOURCE_COMPONENTS = [
  GlobalTransform,
  ChildOf,
  MeshFilter,
  MeshRenderer,
  Instances,
  SpriteInstances,
  SpriteRegionOverride,
  Skin,
  Layer,
  Visibility,
  MorphWeights,
  Points,
  Lines,
  SortKey,
] as const;
const RENDERABLE_SOURCE_COMPONENT_IDS = new Set(
  RENDERABLE_SOURCE_COMPONENTS.map((component) => componentId(component)),
);
const VISIBILITY_DEPENDENCY_COMPONENT_IDS = new Set([
  componentId(ChildOf),
  componentId(Visibility),
]);
const STRUCTURAL_MEMBERSHIP_SCAN_COMPONENT_IDS = new Set([
  componentId(ChildOf),
  componentId(Layer),
  componentId(Visibility),
  componentId(SpriteRegionOverride),
  componentId(SortKey),
]);

function createGlobalTransformChangeQuery(world: World): GlobalTransformChangeQuery {
  const result = world.query({ read: [GlobalTransform], changed: [GlobalTransform] });
  if (!result.ok) throw result.error;
  const query = result.value as GlobalTransformChangeQuery;
  for (const _span of query.spans().unwrap()) {
    // The full rebuild consumed these values; establish the observation baseline.
  }
  return query;
}

function createRenderChangeQueries(world: World): ReadonlyMap<number, Query> {
  const queries = new Map<number, Query>();
  for (const component of RENDERABLE_SOURCE_COMPONENTS) {
    const result = world.query({ read: [component], changed: [component] });
    if (!result.ok) throw result.error;
    const query = result.value as Query;
    // The initial full extraction has already consumed this change evidence.
    // Keep the query compiled so subsequent frames iterate only rows whose
    // component version changed.
    for (const _span of query.spans().unwrap()) {
      // Establish the observation baseline.
    }
    queries.set(componentId(component), query);
  }
  return queries;
}

function collectRenderableEntities(world: World): ReadonlySet<number> {
  const result = new Set<number>();
  const query = world.query({ read: [MeshRenderer], with: [Transform, MeshFilter] }).unwrap();
  for (const row of query) result.add(row.entity as number);
  return result;
}

function sourceMembershipChanged(world: World, slot: RenderSceneSlot): boolean {
  const entity = slot.entityKey as EntityHandle;
  const snapshot = slot.snapshot;
  return (
    !world.hasComponent(entity, GlobalTransform) ||
    (snapshot.instances !== undefined) !== world.hasComponent(entity, Instances) ||
    (snapshot.spriteInstances !== undefined) !== world.hasComponent(entity, SpriteInstances) ||
    (snapshot.skin !== undefined) !== world.hasComponent(entity, Skin) ||
    (snapshot.morph !== undefined) !== world.hasComponent(entity, MorphWeights) ||
    (snapshot.pointsLines?.component === 'Points') !== world.hasComponent(entity, Points) ||
    (snapshot.pointsLines?.component === 'Lines') !== world.hasComponent(entity, Lines)
  );
}

function skinJointKey(worldId: number, jointEntity: number): string {
  return `${worldId}:${jointEntity}`;
}

function addSkinConsumer(index: Map<string, Set<number>>, snapshot: RenderableSnapshot): void {
  for (const jointEntity of snapshot.skinJointEntities ?? []) {
    const key = skinJointKey(snapshot.worldId, jointEntity);
    let consumers = index.get(key);
    if (consumers === undefined) {
      consumers = new Set<number>();
      index.set(key, consumers);
    }
    consumers.add(snapshot.entityKey);
  }
}

function removeSkinConsumer(index: Map<string, Set<number>>, snapshot: RenderableSnapshot): void {
  for (const jointEntity of snapshot.skinJointEntities ?? []) {
    const key = skinJointKey(snapshot.worldId, jointEntity);
    const consumers = index.get(key);
    consumers?.delete(snapshot.entityKey);
    if (consumers?.size === 0) index.delete(key);
  }
}

function dispatchEntriesBySlot(
  frame: ExtractedFrame,
  projection: RenderScene,
): Map<number, readonly DispatchEntry[]> {
  const bySlot = new Map<number, DispatchEntry[]>();
  const byRenderable = new Map<number, DispatchEntry[]>();
  for (const entry of frame.dispatch) {
    const list = byRenderable.get(entry.renderableIndex);
    if (list === undefined) byRenderable.set(entry.renderableIndex, [entry]);
    else list.push(entry);
  }
  for (let index = 0; index < frame.renderables.length; index += 1) {
    const renderable = frame.renderables[index];
    if (renderable === undefined) continue;
    const slot = projection.slot(renderable.worldId, renderable.entityKey);
    if (slot === undefined) continue;
    bySlot.set(slot.slot, byRenderable.get(index) ?? []);
  }
  return bySlot;
}

function dispatchForProjection(
  dispatchBySlot: ReadonlyMap<number, readonly DispatchEntry[]>,
  projection: RenderScene,
  unavailableSlots: ReadonlySet<number>,
): readonly DispatchEntry[] {
  const dispatch: DispatchEntry[] = [];
  const renderables = projection.materialize();
  for (let renderableIndex = 0; renderableIndex < renderables.length; renderableIndex += 1) {
    const renderable = renderables[renderableIndex];
    if (renderable === undefined) continue;
    const slot = projection.slot(renderable.worldId, renderable.entityKey);
    if (slot === undefined) continue;
    if (unavailableSlots.has(slot.slot)) continue;
    for (const entry of dispatchBySlot.get(slot.slot) ?? []) {
      dispatch.push({ ...entry, renderableIndex });
    }
  }
  return dispatch;
}

function topologyDeltaForAvailable(
  delta: RenderSceneApplyResult,
  unavailableSlots: ReadonlySet<number>,
  newlyUnavailable: readonly RenderSceneSlot[],
): RenderSceneApplyResult {
  const updatedSlots = delta.updatedSlots.filter((slot) => !unavailableSlots.has(slot.slot));
  const contentUpdatedSlots = delta.contentUpdatedSlots?.filter(
    (slot) => !unavailableSlots.has(slot.slot),
  );
  return {
    ...delta,
    updatedSlots: [
      ...updatedSlots,
      ...newlyUnavailable.map((slot) => ({
        ...slot,
        snapshot: { ...slot.snapshot, gpuDrivenDraws: [] },
      })),
    ],
    ...(contentUpdatedSlots === undefined ? {} : { contentUpdatedSlots }),
  };
}

function addSharedRefConsumers(
  projection: RenderScene,
  worldId: number,
  handle: number,
  target: Set<number>,
): void {
  for (const slot of projection.slotsSnapshot()) {
    if (
      slot.worldId === worldId &&
      (slot.snapshot.assetHandle === handle ||
        slot.snapshot.materials.some((material) => material.materialHandle === handle))
    ) {
      target.add(slot.entityKey);
    }
  }
}

function frameDemandsTemporal(frame: ExtractedFrame): boolean {
  const camera = frame.cameras[0];
  return camera?.antialias === 'taa' || (camera?.motionBlur?.shutterAngle ?? 0) > 0;
}

function cameraFrusta(cameras: readonly CameraSnapshot[]): readonly Float32Array[] {
  const planes: Float32Array[] = [];
  for (const camera of cameras) {
    if (
      (camera.projection === 'perspective' && (camera.fov <= 0 || camera.aspect <= 0)) ||
      camera.near >= camera.far
    ) {
      planes.push(new Float32Array(0));
      continue;
    }
    const projection = mat4.create();
    if (camera.projection === 'orthographic') {
      mat4.orthographic(
        projection,
        camera.orthoLeft,
        camera.orthoRight,
        camera.orthoTop,
        camera.orthoBottom,
        camera.near,
        camera.far,
      );
    } else {
      mat4.perspective(projection, camera.fov, camera.aspect, camera.near, camera.far);
    }
    const view = mat4.create();
    mat4.invert(view, camera.world);
    const viewProjection = mat4.create();
    mat4.multiply(viewProjection, projection, view);
    const cameraPlanes = frustum.create();
    frustum.fromViewProjection(cameraPlanes, viewProjection);
    planes.push(cameraPlanes);
  }
  return planes;
}

let cullProjectedIndexScratch = new Int32Array(0);

function cullPersistentFrame(
  frame: ExtractedFrame,
  candidates: readonly RenderableSnapshot[],
  boundsOf: (snapshot: RenderableSnapshot, index: number) => RenderSceneBounds | undefined = (
    snapshot,
  ) => worldBounds(snapshot),
): ExtractedFrame {
  const planes = cameraFrusta(frame.cameras);
  const visible: RenderableSnapshot[] = [];
  if (cullProjectedIndexScratch.length < candidates.length) {
    cullProjectedIndexScratch = new Int32Array(candidates.length);
  }
  const projectedIndex = cullProjectedIndexScratch;
  projectedIndex.fill(-1, 0, candidates.length);
  const worldAabb = box3.create();
  let total = 0;
  let culled = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    if (candidate.authorVisible === false) {
      culled += 1;
      continue;
    }
    let isVisible = true;
    const candidateBounds = boundsOf(candidate, index);
    if (candidateBounds !== undefined) {
      total += 1;
      worldAabb[0] = candidateBounds.min[0] ?? 0;
      worldAabb[1] = candidateBounds.min[1] ?? 0;
      worldAabb[2] = candidateBounds.min[2] ?? 0;
      worldAabb[3] = candidateBounds.max[0] ?? 0;
      worldAabb[4] = candidateBounds.max[1] ?? 0;
      worldAabb[5] = candidateBounds.max[2] ?? 0;
      isVisible = planes.length === 0;
      for (const cameraPlanes of planes) {
        if (
          cameraPlanes.length === 0 ||
          frustum.intersectsBox(cameraPlanes as frustum.Frustum, worldAabb as box3.Box3Like)
        ) {
          isVisible = true;
          break;
        }
      }
    }
    if (!isVisible) {
      culled += 1;
      continue;
    }
    projectedIndex[index] = visible.length;
    // The culling candidate is the persistent projection snapshot used for
    // bounds, while `frame.renderables[index]` may carry frame-owned
    // attachments (for example the probe blend record). Preserve that
    // attached renderable in the output; pushing the bare candidate here
    // silently drops the object-level Probe ABI before record selection.
    visible.push(frame.renderables[index] ?? candidate);
  }

  const dispatch: DispatchEntry[] = [];
  for (const entry of frame.dispatch) {
    const candidateIndex = entry.renderableIndex;
    const renderableIndex = projectedIndex[candidateIndex];
    if (renderableIndex === undefined || renderableIndex < 0) continue;
    dispatch.push({ ...entry, renderableIndex });
  }
  return {
    ...frame,
    renderables: visible,
    dispatch,
    frustumStats: { culled, total },
  };
}

function attachProbeRecords(
  frame: ExtractedFrame,
  candidates: RenderableSnapshot[],
  slots: readonly RenderSceneSlot[],
  projection: ProbeBlendSceneProjection,
): ExtractedFrame {
  if (!projection.hasRecords()) {
    return frame.renderables === candidates ? frame : { ...frame, renderables: candidates };
  }
  const objectKeys = new Map<string, number>();
  for (const slot of slots)
    objectKeys.set(identityKey(slot.worldId, slot.snapshot.entityKey), slot.slot);
  const renderables = candidates.map((candidate) => {
    const slot = objectKeys.get(identityKey(candidate.worldId, candidate.entityKey));
    const record = slot === undefined ? undefined : projection.getRecord(slot);
    return record === undefined ? candidate : { ...candidate, probeBlendRecord: record };
  });
  return { ...frame, renderables };
}

/** Persistent scene projection used by the renderer's multi-World composition path. */
export class PersistentRenderScene {
  private readonly visibilityBudget: VisibilityBudget;
  private readonly visibilityFacets: VisibilityFacetStore;
  /** World identity is the author/runtime identity; array position is only a frame routing detail. */
  private readonly visibilityWorldKeys = new Map<string, number>();
  private nextVisibilityWorldKey = 0;
  private readonly materialSnapshotCaches: MaterialSnapshotCachesByWorld = new WeakMap();
  private fullRebuilds = 0;
  private worldEntitiesScanned = 0;
  private noChangeFrames = 0;
  private deltaFrames = 0;
  private transformUpdates = 0;
  private lastResyncReason: RenderSceneResyncReason | undefined;
  private composition: PersistentCompositionEntry | undefined;
  private gpuScene: GpuScene | undefined;
  private gpuOwner: object | undefined;
  private gpuDevice: RhiDevice | undefined;
  private gpuStatus: 'inactive' | 'unsupported' | 'resident' | 'rebuild-pending' | 'error' =
    'inactive';
  private temporalCapture:
    | { readonly projection: RenderScene; readonly capture: RenderSceneSubmissionCapture }
    | undefined;
  /** Monotonic token for camera/dynamic frame facts consumed by visibility caches. */
  private frameEpoch = 0;
  private visibilityFacetFrame:
    | {
        readonly frameEpoch: number;
        readonly viewId: string;
        readonly renderables: readonly RenderableSnapshot[];
      }
    | undefined;
  private visibilityProjectionCache:
    | {
        readonly frameEpoch: number;
        readonly drawRevision: number;
        readonly viewId: string;
        readonly renderables: readonly RenderableSnapshot[];
        readonly dispatch: readonly DispatchEntry[];
        readonly projection: PersistentVisibilityProjection;
      }
    | undefined;
  private visibilityProjectionRevision = 0;
  private lastActiveEntityKeys: ReadonlySet<number> | undefined;
  /** Stable renderer-world/entity lookup; rebuilt only with composition topology. */
  private readonly stableSlotByEntity = new Map<number, RenderSceneSlot>();
  private pointsLinesInspections: readonly PointsLinesInspection[] = [];
  private readonly reflectionProbes = new ReflectionProbeProjection();

  constructor(private readonly options: PersistentRenderSceneOptions = {}) {
    this.visibilityBudget = createVisibilityBudget(options.configuredQueryBudget);
    this.visibilityFacets = new VisibilityFacetStore(this.visibilityBudget);
  }

  /** RenderScene owns the per-World material fact cache used during extraction. */
  materialSnapshotCacheStore(): MaterialSnapshotCachesByWorld {
    return this.materialSnapshotCaches;
  }

  /** The sole renderer-owned ViewKey x PrimitiveKey visibility state. */
  visibilityFacetStore(): VisibilityFacetStore {
    return this.visibilityFacets;
  }

  visibilityBudgetValue(): VisibilityBudget {
    return this.visibilityBudget;
  }

  private visibilityWorldKey(world: World | undefined, fallback: number): number {
    if (world === undefined) return fallback;
    const existing = this.visibilityWorldKeys.get(world.identity);
    if (existing !== undefined) return existing;
    const key = this.nextVisibilityWorldKey;
    this.nextVisibilityWorldKey += 1;
    this.visibilityWorldKeys.set(world.identity, key);
    return key;
  }

  private worldKeyAt(worlds: readonly World[], worldId: number): number {
    return this.visibilityWorldKey(worlds[worldId], worldId);
  }

  /** Stable World routing keys for the current worlds[] frame projection. */
  visibilityWorldKeysFor(worlds: readonly World[]): readonly number[] {
    return worlds.map((world, worldId) => this.visibilityWorldKey(world, worldId));
  }

  /** Current retained slots, available to CPU query transport as well as GPU. */
  compositionSlots(): readonly RenderSceneSlot[] {
    return this.composition?.projection.slotsSnapshot() ?? [];
  }

  /** Stable renderer-world/entity lookup shared by query and final projection paths. */
  compositionSlotByStableEntity(): ReadonlyMap<number, RenderSceneSlot> {
    return this.stableSlotByEntity;
  }

  private stableEntityKey(
    worlds: readonly World[],
    renderable: Pick<RenderableSnapshot, 'worldId' | 'entityKey'>,
  ): number {
    return worldEntityKey(this.worldKeyAt(worlds, renderable.worldId), renderable.entityKey);
  }

  /** Feed the facet from extracted renderables using persistent slot identity. */
  updateVisibilityFacet(
    worlds: readonly World[],
    camera: CameraSnapshot | undefined,
    renderables: readonly RenderableSnapshot[],
  ): void {
    const world = worlds[camera?.worldId ?? 0];
    if (world === undefined || camera === undefined) return;
    const view = viewKey({
      attachmentId: world.identity,
      cameraEntity: camera.entityKey ?? 0,
      viewRole: 'main',
      viewGeneration: camera.historyVersion ?? 0,
    });
    const viewId = viewKeyId(view);
    const previous = this.visibilityFacetFrame;
    if (
      previous?.frameEpoch === this.frameEpoch &&
      previous.viewId === viewId &&
      previous.renderables === renderables
    ) {
      return;
    }
    this.visibilityFacets.activateView(view);
    const activePrimitiveIds = new Set<string>();
    for (const renderable of renderables) {
      const bounds = renderable.localAabb;
      if (
        renderable.lods === undefined ||
        renderable.lods.length === 0 ||
        bounds === undefined ||
        bounds.length < 6 ||
        [...bounds].some((value) => !Number.isFinite(value))
      ) {
        continue;
      }
      const slot = this.stableSlotByEntity.get(this.stableEntityKey(worlds, renderable));
      if (slot === undefined) continue;
      const primitive = primitiveKey({
        attachmentId: world.identity,
        worldGeneration: this.worldKeyAt(worlds, renderable.worldId),
        primitiveSlot: slot.slot,
        slotGeneration: slot.generation,
      });
      activePrimitiveIds.add(primitiveKeyId(primitive));
      this.visibilityFacets.setCandidate(view, primitive, { level: 0, confidence: 1 });
    }
    this.visibilityFacets.pruneCandidates(view, activePrimitiveIds);
    this.visibilityFacetFrame = { frameEpoch: this.frameEpoch, viewId, renderables };
  }

  /**
   * Project the current facet into the final primary-raster submission.
   *
   * Only renderables carrying authored lower-detail levels are queryable. A
   * plain mesh therefore remains on the ordinary visibility path, while an
   * LOD candidate with two accepted zero-sample results is suppressed until
   * the confidence scheduler requests its bounded re-test. Unknown identity,
   * invalid bounds, and non-queryable confidence all remain conservatively
   * visible through `decideVisibility`.
   */
  projectVisibility(
    worlds: readonly World[],
    camera: CameraSnapshot | undefined,
    renderables: readonly RenderableSnapshot[],
    dispatch: readonly DispatchEntry[],
  ): PersistentVisibilityProjection {
    if (camera === undefined) {
      const activeEntityKeys = new Set(
        renderables.map((renderable) => this.stableEntityKey(worlds, renderable)),
      );
      return {
        renderables,
        dispatch,
        activeEntityKeys,
        activeEntityRevision: this.activeEntityRevision(activeEntityKeys),
        suppressed: 0,
      };
    }
    const cameraWorld = worlds[camera.worldId ?? 0];
    if (cameraWorld === undefined) {
      const activeEntityKeys = new Set(
        renderables.map((renderable) => this.stableEntityKey(worlds, renderable)),
      );
      return {
        renderables,
        dispatch,
        activeEntityKeys,
        activeEntityRevision: this.activeEntityRevision(activeEntityKeys),
        suppressed: 0,
      };
    }
    const view = viewKey({
      attachmentId: cameraWorld.identity,
      cameraEntity: camera.entityKey ?? 0,
      viewRole: 'main',
      viewGeneration: camera.historyVersion ?? 0,
    });
    const viewId = viewKeyId(view);
    const cached = this.visibilityProjectionCache;
    if (
      cached?.frameEpoch === this.frameEpoch &&
      cached.drawRevision === this.visibilityFacets.drawRevisionValue &&
      cached.viewId === viewId &&
      cached.renderables === renderables &&
      cached.dispatch === dispatch
    ) {
      return cached.projection;
    }
    const projectedIndex = new Int32Array(renderables.length);
    projectedIndex.fill(-1);
    const projected: RenderableSnapshot[] = [];
    const activeEntityKeys = new Set<number>();
    let suppressed = 0;
    for (let index = 0; index < renderables.length; index += 1) {
      const renderable = renderables[index];
      if (renderable === undefined) continue;
      const slot = this.stableSlotByEntity.get(this.stableEntityKey(worlds, renderable));
      let draw = true;
      if (slot !== undefined && (renderable.lods?.length ?? 0) > 0) {
        const primitive = primitiveKey({
          attachmentId: cameraWorld.identity,
          worldGeneration: this.worldKeyAt(worlds, renderable.worldId),
          primitiveSlot: slot.slot,
          slotGeneration: slot.generation,
        });
        const bounds = renderable.localAabb;
        const validBounds =
          bounds !== undefined &&
          bounds.length >= 6 &&
          [...bounds].every((value) => Number.isFinite(value));
        draw = decideVisibility({
          authorVisible: renderable.authorVisible !== false,
          validBounds,
          frustumVisible: true,
          lodReady: true,
          occlusion: this.visibilityFacets.getConfidence(view, primitive),
          lane: 'gpu',
        }).draw;
      }
      if (!draw) {
        suppressed += 1;
        continue;
      }
      projectedIndex[index] = projected.length;
      projected.push(renderable);
      activeEntityKeys.add(this.stableEntityKey(worlds, renderable));
    }
    const projectedDispatch: DispatchEntry[] = [];
    for (const entry of dispatch) {
      const renderableIndex = projectedIndex[entry.renderableIndex];
      if (renderableIndex === undefined || renderableIndex < 0) continue;
      projectedDispatch.push({ ...entry, renderableIndex });
    }
    const projection = {
      renderables: Object.freeze(projected),
      dispatch: Object.freeze(projectedDispatch),
      activeEntityKeys,
      activeEntityRevision: this.activeEntityRevision(activeEntityKeys),
      suppressed,
    };
    this.visibilityProjectionCache = {
      frameEpoch: this.frameEpoch,
      drawRevision: this.visibilityFacets.drawRevisionValue,
      viewId,
      renderables,
      dispatch,
      projection,
    };
    return projection;
  }

  /**
   * Advance the projection revision only when the active stable-entity set
   * changes. Camera fingerprints and scene-plan identity cover view/topology
   * changes; keeping this token set-stable preserves the GPU filtered-plan
   * cache on ordinary no-change frames.
   */
  private activeEntityRevision(activeEntityKeys: ReadonlySet<number>): number {
    const previous = this.lastActiveEntityKeys;
    if (
      previous === undefined ||
      previous.size !== activeEntityKeys.size ||
      [...previous].some((key) => !activeEntityKeys.has(key))
    ) {
      this.lastActiveEntityKeys = new Set(activeEntityKeys);
      this.visibilityProjectionRevision += 1;
    }
    return this.visibilityProjectionRevision;
  }

  private invalidateActiveEntityRevision(): void {
    this.lastActiveEntityKeys = undefined;
    this.visibilityProjectionRevision += 1;
  }

  /** Project probe facts and per-primitive selection into the persistent scene owner. */
  projectReflectionProbes(probes: readonly ReflectionProbeFact[]): void {
    const projection = this.composition?.projection;
    if (projection === undefined) return;
    if (probes.length === 0) {
      this.reflectionProbes.update([], []);
      return;
    }
    const primitives = projection
      .slotsSnapshot()
      .map((slot) => {
        const resolved = projection.cullingWorldBoundsAt(slot);
        if (resolved === undefined || resolved === null) return undefined;
        return {
          worldId: slot.worldId,
          entityKey: slot.entityKey,
          renderableKey: `${slot.worldId}:${slot.entityKey}`,
          center: [
            (resolved.min[0] + resolved.max[0]) / 2,
            (resolved.min[1] + resolved.max[1]) / 2,
            (resolved.min[2] + resolved.max[2]) / 2,
          ] as [number, number, number],
        };
      })
      .filter((primitive): primitive is NonNullable<typeof primitive> => primitive !== undefined);
    this.reflectionProbes.update(probes, primitives);
  }

  reflectionProbeSelection(worldId: number, entityKey: number): ReflectionProbeSelectionResult {
    return this.reflectionProbes.selection(worldId, entityKey);
  }

  reflectionProbeProjection(): ReturnType<ReflectionProbeProjection['snapshot']> {
    return this.reflectionProbes.snapshot();
  }

  extractComposition(
    worlds: readonly World[],
    owner: { readonly cameraOwner: number; readonly resourceOwner: number },
    catalogEpoch: number,
    buildCandidateFrame: (request: PersistentRenderCandidateRequest) => ExtractedFrame,
    leases?: readonly RenderReadLease[],
  ): ExtractedFrame {
    this.worldEntitiesScanned = 0;
    const entry = this.composition;
    const sameWorldSet =
      entry !== undefined &&
      entry.worlds.length === worlds.length &&
      entry.worlds.every((world) => worlds.includes(world));
    const worldOrderChanged =
      entry !== undefined &&
      sameWorldSet &&
      entry.worlds.some((world, index) => world !== worlds[index]);
    const leaseSetPreserved =
      entry !== undefined &&
      leases !== undefined &&
      leases.length === worlds.length &&
      entry.leaseIdentities.length === leases.length &&
      entry.leaseIdentities.every((identity) =>
        leases.some((lease) => lease.worldIdentity === identity),
      );
    const preserveVisibilityOnReorder =
      entry !== undefined &&
      worldOrderChanged &&
      entry.catalogEpoch === catalogEpoch &&
      leaseSetPreserved;
    if (
      entry === undefined ||
      entry.catalogEpoch !== catalogEpoch ||
      entry.cameraOwner !== owner.cameraOwner ||
      entry.resourceOwner !== owner.resourceOwner ||
      entry.worlds.length !== worlds.length ||
      entry.worlds.some((world, index) => world !== worlds[index]) ||
      leases === undefined ||
      leases.length !== worlds.length
    ) {
      return this.rebuildComposition(
        worlds,
        owner,
        catalogEpoch,
        buildCandidateFrame,
        leases,
        preserveVisibilityOnReorder,
      );
    }
    let requiresRebuild = false;
    const changedEntitiesByWorld = worlds.map(
      (_, worldId) => new Set(entry.pendingRenderableEntitiesByWorld[worldId] ?? []),
    );
    const nextReadVersions = entry.readVersions.slice();
    const structureChangedWorlds = new Set<number>();
    const structuralComponentIdsByWorld = worlds.map(() => new Set<number>());
    let refreshStructureFacts = false;
    let currentRenderableEntitiesByWorld: readonly (ReadonlySet<number> | undefined)[] | undefined;
    const removedSlots: RenderSceneSlot[] = [];
    for (let worldId = 0; worldId < worlds.length; worldId += 1) {
      const world = worlds[worldId];
      if (world === undefined) continue;
      const lease = leases?.[worldId];
      if (lease === undefined || entry.leaseIdentities[worldId] !== lease.worldIdentity) {
        requiresRebuild = true;
        break;
      }
      const version = entry.readVersions[worldId];
      if (version === undefined) {
        requiresRebuild = true;
        break;
      }
      let read: ReturnType<RenderReadLease['readChanges']>;
      try {
        read = lease.readChanges(version);
      } catch {
        requiresRebuild = true;
        break;
      }
      if (read.status === 'rebuild') {
        structureChangedWorlds.add(worldId);
        refreshStructureFacts = true;
      }
      const changes = read.world;
      const shared = read.sharedRefs;
      if (shared.records.length > 0) {
        for (const record of shared.records) {
          this.options.onSharedRefMutation?.(worldId, record.handle);
          const changed = changedEntitiesByWorld[worldId];
          if (changed !== undefined)
            addSharedRefConsumers(entry.projection, worldId, record.handle, changed);
        }
      }
      for (const changedComponentId of changes.changedComponentIds) {
        if (read.status === 'rebuild') {
          structuralComponentIdsByWorld[worldId]?.add(changedComponentId);
        }
        if (!RENDER_RELEVANT_COMPONENT_IDS.has(changedComponentId)) continue;
        if (!RENDERABLE_SOURCE_COMPONENT_IDS.has(changedComponentId)) {
          requiresRebuild = true;
          break;
        }
        const changed = changedEntitiesByWorld[worldId];
        if (changed === undefined) continue;
        if (VISIBILITY_DEPENDENCY_COMPONENT_IDS.has(changedComponentId)) {
          refreshStructureFacts = true;
          // Visibility and parent changes affect the effective state of a
          // subtree. The normal update path evaluates the current rows; the
          // set is deliberately allowed to be broad, while empty work still
          // exits naturally without a candidate loop.
          for (const entity of collectRenderableEntities(world)) changed.add(entity);
          continue;
        }
        if (changedComponentId === componentId(GlobalTransform)) {
          const query = entry.renderChangeQueries[worldId]?.get(changedComponentId);
          for (const row of query ?? []) {
            const consumers = entry.skinConsumersByJoint.get(
              skinJointKey(worldId, row.entity as number),
            );
            for (const consumer of consumers ?? []) changed.add(consumer);
          }
          continue;
        }
        const query = entry.renderChangeQueries[worldId]?.get(changedComponentId);
        if (query !== undefined) {
          for (const row of query) changed.add(row.entity as number);
        }
      }
      if (requiresRebuild) break;
      nextReadVersions[worldId] = read.version;
    }
    if (requiresRebuild) {
      return this.rebuildComposition(worlds, owner, catalogEpoch, buildCandidateFrame, leases);
    }

    if (structureChangedWorlds.size > 0) {
      this.visibilityFacets.clear();
      this.invalidateActiveEntityRevision();
      const currentByWorld = worlds.map((world) => collectRenderableEntities(world));
      currentRenderableEntitiesByWorld = currentByWorld;
      for (let worldId = 0; worldId < currentByWorld.length; worldId += 1) {
        const world = worlds[worldId];
        const current = currentByWorld[worldId];
        if (world === undefined || current === undefined) continue;
        const changed = changedEntitiesByWorld[worldId];
        if (changed !== undefined && structureChangedWorlds.has(worldId)) {
          // A joint can disappear without leaving a row in the joint's
          // GlobalTransform change query. Wake every dependent renderable so
          // the next partial extraction validates the dangling reference and
          // either republishes or retires its palette data.
          for (const [jointKey, consumers] of entry.skinConsumersByJoint) {
            const separator = jointKey.indexOf(':');
            const indexedWorldId = Number(jointKey.slice(0, separator));
            if (indexedWorldId !== worldId) continue;
            const jointEntity = Number(jointKey.slice(separator + 1));
            if (world.hasComponent(jointEntity as EntityHandle, GlobalTransform)) continue;
            for (const consumer of consumers) changed.add(consumer);
          }
          for (const entity of current) {
            if (entry.projection.slot(worldId, entity) === undefined) changed.add(entity);
          }
          const structuralComponentIds = structuralComponentIdsByWorld[worldId];
          const scanAllMembership =
            structuralComponentIds !== undefined &&
            [...structuralComponentIds].some((id) =>
              STRUCTURAL_MEMBERSHIP_SCAN_COMPONENT_IDS.has(id),
            );
          for (const slot of entry.projection.slotsSnapshot()) {
            if (slot.worldId !== worldId || !current.has(slot.entityKey)) continue;
            const membershipChanged = sourceMembershipChanged(world, slot);
            if (scanAllMembership || membershipChanged) {
              changed.add(slot.entityKey);
              if (
                slot.snapshot.instances !== undefined &&
                !world.hasComponent(slot.entityKey as EntityHandle, Instances)
              ) {
                this.options.instanceCollections?.release(world, slot.entityKey);
              }
              if (
                slot.snapshot.skin !== undefined &&
                !world.hasComponent(slot.entityKey as EntityHandle, Skin)
              ) {
                this.options
                  .getSkinPaletteAllocator?.()
                  ?.releaseSliceFor(`${world.identity}:${slot.entityKey}`);
              }
            }
          }
        }
        for (const slot of entry.projection.slotsSnapshot()) {
          if (slot.worldId !== worldId || current.has(slot.entityKey)) continue;
          removedSlots.push(slot);
        }
        this.worldEntitiesScanned += current.size;
      }
    }

    // Query iteration is an observation step, not publication. Persist every
    // requested identity before invoking any producer so a thrown or omitted
    // partial extraction is retried even after ECS change evidence is drained.
    for (let worldId = 0; worldId < changedEntitiesByWorld.length; worldId += 1) {
      const pending = entry.pendingRenderableEntitiesByWorld[worldId];
      if (pending === undefined) continue;
      for (const entityKey of changedEntitiesByWorld[worldId] ?? []) pending.add(entityKey);
    }

    let changedDelta: RenderSceneApplyResult | undefined;
    const hasChangedEntities = changedEntitiesByWorld.some((entities) => entities.size > 0);
    if (hasChangedEntities || removedSlots.length > 0) {
      const operations: RenderSceneOperation[] = [];
      const removedDemand: TransmissionDemandOperation[] = [];
      const replacedSkinSnapshots: RenderableSnapshot[] = [];
      for (let worldId = 0; worldId < changedEntitiesByWorld.length; worldId += 1) {
        for (const entityKey of changedEntitiesByWorld[worldId] ?? []) {
          const slot = entry.projection.slot(worldId, entityKey);
          if (slot !== undefined) replacedSkinSnapshots.push(slot.snapshot);
        }
      }
      for (const slot of removedSlots) {
        operations.push({ kind: 'remove', worldId: slot.worldId, entityKey: slot.entityKey });
        if (slot.snapshot.skinJointEntities !== undefined) {
          removeSkinConsumer(entry.skinConsumersByJoint, slot.snapshot);
        }
        const world = worlds[slot.worldId];
        if (world !== undefined) this.options.instanceCollections?.release(world, slot.entityKey);
        this.options
          .getSkinPaletteAllocator?.()
          ?.releaseSliceFor(`${world?.identity ?? slot.worldId}:${slot.entityKey}`);
        for (
          let materialIndex = 0;
          materialIndex < slot.snapshot.materials.length;
          materialIndex += 1
        ) {
          removedDemand.push({
            kind: 'remove',
            key: `${slot.worldId}:${slot.entityKey}:${materialIndex}`,
          });
        }
      }
      for (let worldId = 0; worldId < changedEntitiesByWorld.length; worldId += 1) {
        for (const entityKey of changedEntitiesByWorld[worldId] ?? []) {
          const slot = entry.projection.slot(worldId, entityKey);
          if (slot === undefined) continue;
          for (
            let materialIndex = 0;
            materialIndex < slot.snapshot.materials.length;
            materialIndex += 1
          ) {
            removedDemand.push({ kind: 'remove', key: `${worldId}:${entityKey}:${materialIndex}` });
          }
        }
      }
      const partial = hasChangedEntities
        ? buildCandidateFrame({ kind: 'partial', entitiesByWorld: changedEntitiesByWorld })
        : undefined;
      const publishedEntitiesByWorld = worlds.map(() => new Set<number>());
      for (const snapshot of partial?.renderables ?? []) {
        operations.push({ kind: 'create', snapshot });
        publishedEntitiesByWorld[snapshot.worldId]?.add(snapshot.entityKey);
      }
      changedDelta = entry.projection.apply(operations);
      const publishedSkinKeys = new Set<string>();
      for (const snapshot of partial?.renderables ?? []) {
        publishedSkinKeys.add(`${snapshot.worldId}:${snapshot.entityKey}`);
      }
      for (const snapshot of replacedSkinSnapshots) {
        // Keep the old dependency while a failed/omitted partial publication
        // retains its CPU slot.  The pending identity must still be woken by
        // a later joint transform change so the producer gets another chance.
        if (
          snapshot.skinJointEntities !== undefined &&
          publishedSkinKeys.has(`${snapshot.worldId}:${snapshot.entityKey}`)
        ) {
          removeSkinConsumer(entry.skinConsumersByJoint, snapshot);
        }
      }
      for (const snapshot of partial?.renderables ?? []) {
        if (snapshot.skinJointEntities !== undefined) {
          addSkinConsumer(entry.skinConsumersByJoint, snapshot);
        }
      }
      entry.transmissionDemand.apply([
        ...removedDemand,
        ...transmissionDemandOperations(partial?.renderables ?? []),
      ]);
      for (const removed of changedDelta.removedSlots) entry.dispatchBySlot.delete(removed.slot);
      for (const recreated of changedDelta.recreatedSlots)
        entry.dispatchBySlot.delete(recreated.slot);
      if (partial !== undefined) {
        if (refreshStructureFacts) {
          entry.structure = {
            ...entry.structure,
            dispatch: partial.dispatch,
            visibilityStats: partial.visibilityStats,
            visibilitySnapshots: partial.visibilitySnapshots,
            featureVisibilitySnapshots: partial.featureVisibilitySnapshots,
            hiddenEntityReports: partial.hiddenEntityReports,
          };
        }
        const partialDispatch = dispatchEntriesBySlot(partial, entry.projection);
        for (const [slot, dispatch] of partialDispatch) entry.dispatchBySlot.set(slot, dispatch);
        // A changed renderable which now fails producer validation still owns
        // its retained identity; replace its old dispatch with an empty list.
        for (const snapshot of partial.renderables) {
          const slot = entry.projection.slot(snapshot.worldId, snapshot.entityKey);
          if (slot !== undefined && !partialDispatch.has(slot.slot))
            entry.dispatchBySlot.set(slot.slot, []);
        }
      }
      for (let worldId = 0; worldId < changedEntitiesByWorld.length; worldId += 1) {
        const requested = changedEntitiesByWorld[worldId];
        const published = publishedEntitiesByWorld[worldId];
        if (requested === undefined || published === undefined) continue;
        const pending = entry.pendingRenderableEntitiesByWorld[worldId];
        for (const entityKey of requested) {
          const slot = entry.projection.slot(worldId, entityKey);
          if (published.has(entityKey)) {
            pending?.delete(entityKey);
            continue;
          }
          if (slot === undefined) {
            const current = currentRenderableEntitiesByWorld?.[worldId];
            if (current !== undefined && !current.has(entityKey)) pending?.delete(entityKey);
            continue;
          }
          // The producer did not publish this requested identity. Keep the
          // old CPU slot for recovery, but stop submitting stale dispatch and
          // retry the same identity even if its World version stays still.
          pending?.add(entityKey);
          if (slot !== undefined) entry.dispatchBySlot.set(slot.slot, []);
        }
      }
      const newlyUnavailable: RenderSceneSlot[] = [];
      for (let worldId = 0; worldId < changedEntitiesByWorld.length; worldId += 1) {
        const requested = changedEntitiesByWorld[worldId];
        const published = publishedEntitiesByWorld[worldId];
        if (requested === undefined || published === undefined) continue;
        for (const entityKey of requested) {
          const slot = entry.projection.slot(worldId, entityKey);
          if (slot === undefined || published.has(entityKey)) {
            if (slot !== undefined) entry.unavailableSlots.delete(slot.slot);
            continue;
          }
          if (!entry.unavailableSlots.has(slot.slot)) newlyUnavailable.push(slot);
          entry.unavailableSlots.add(slot.slot);
        }
      }
      for (const removed of changedDelta.removedSlots) entry.unavailableSlots.delete(removed.slot);
      for (const recreated of changedDelta.recreatedSlots)
        entry.unavailableSlots.delete(recreated.slot);
      entry.dispatchRevision += 1;
      entry.dispatchCache = undefined;
      entry.topology.apply(
        topologyDeltaForAvailable(changedDelta, entry.unavailableSlots, newlyUnavailable),
      );
      this.syncGpuOwner(entry.token, entry.projection, changedDelta);
      this.deltaFrames +=
        changedDelta.created +
          changedDelta.updated +
          changedDelta.removed +
          changedDelta.recreated >
        0
          ? 1
          : 0;
      this.transformUpdates += changedDelta.updated;
    }

    const transformSpans: WorldTransformSpan[] = [];
    for (let worldId = 0; worldId < entry.transformQueries.length; worldId += 1) {
      const query = entry.transformQueries[worldId];
      if (query === undefined) continue;
      for (const span of query.spans().unwrap()) {
        const changedWorlds = span.get(GlobalTransform).world;
        if (!(changedWorlds instanceof Float32Array)) {
          requiresRebuild = true;
          break;
        }
        transformSpans.push({ worldId, entities: span.entities, worlds: changedWorlds });
      }
      if (requiresRebuild) break;
    }
    if (requiresRebuild) {
      return this.rebuildComposition(worlds, owner, catalogEpoch, buildCandidateFrame, leases);
    }
    if (transformSpans.length === 0 && changedDelta === undefined) {
      this.noChangeFrames += 1;
      this.syncGpuOwner(entry.token, entry.projection);
      const result = this.deriveFramePlan(entry, buildCandidateFrame);
      for (let worldId = 0; worldId < nextReadVersions.length; worldId += 1) {
        const version = nextReadVersions[worldId];
        if (version !== undefined) entry.readVersions[worldId] = version;
      }
      return result;
    }
    if (transformSpans.length > 0) {
      const delta = entry.projection.applyTransformSpans(transformSpans);
      entry.topology.apply(topologyDeltaForAvailable(delta, entry.unavailableSlots, []));
      this.syncGpuOwner(entry.token, entry.projection, delta);
      this.deltaFrames += 1;
      this.transformUpdates += delta.updated;
    }
    const result = this.deriveFramePlan(entry, buildCandidateFrame);
    for (let worldId = 0; worldId < nextReadVersions.length; worldId += 1) {
      const version = nextReadVersions[worldId];
      if (version !== undefined) entry.readVersions[worldId] = version;
    }
    return result;
  }

  invalidate(): void {
    this.composition = undefined;
    this.temporalCapture = undefined;
    this.visibilityFacets.clear();
    this.invalidateActiveEntityRevision();
    this.visibilityFacetFrame = undefined;
    this.visibilityProjectionCache = undefined;
    this.stableSlotByEntity.clear();
    this.lastResyncReason = 'explicit-invalidate';
  }

  setCompositionGpuSceneDemand(sceneRowsRequired: boolean): void {
    const entry = this.composition;
    if (entry === undefined) return;
    entry.gpuDrivenSceneRequired = sceneRowsRequired;
  }

  detach(world: World): void {
    this.visibilityFacets.detachAttachment(world.identity);
    this.materialSnapshotCaches.delete(world);
    const detachedComposition = this.composition?.worlds.includes(world)
      ? this.composition
      : undefined;
    if (detachedComposition !== undefined) {
      for (const slot of detachedComposition.projection.slotsSnapshot()) {
        if (detachedComposition.worlds[slot.worldId] !== world) continue;
        this.options.instanceCollections?.release(world, slot.entityKey);
        if (slot.snapshot.skin === undefined) continue;
        this.options
          .getSkinPaletteAllocator?.()
          ?.releaseSliceFor(`${world.identity}:${slot.entityKey}`);
      }
    }
    if (detachedComposition !== undefined) this.composition = undefined;
    if (detachedComposition !== undefined) this.temporalCapture = undefined;
    if (detachedComposition !== undefined) {
      this.visibilityFacets.clear();
      this.invalidateActiveEntityRevision();
    }
    if (detachedComposition !== undefined) {
      this.visibilityFacetFrame = undefined;
      this.visibilityProjectionCache = undefined;
      this.stableSlotByEntity.clear();
    }
    if (this.gpuOwner !== world && this.gpuOwner !== detachedComposition?.token) return;
    this.gpuScene?.dispose();
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuDevice = undefined;
    this.gpuStatus = 'inactive';
  }

  /** Drop only device-owned tables; the CPU projection remains the recovery authority. */
  resetGpuForRecover(): void {
    if (this.composition !== undefined) this.composition.gpuDrivenSceneRequired = true;
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuDevice = undefined;
    this.gpuStatus = this.options.getDevice === undefined ? 'inactive' : 'rebuild-pending';
  }

  /** Prepare a detached GPU scene without changing the active scene owner. */
  prepareRecoveryGpuDrivenCandidate(
    device: RhiDevice,
  ): Result<PersistentGpuDrivenCandidate, RhiError> {
    const composition = this.composition;
    if (composition === undefined) {
      return ok({
        state: undefined,
        createRecoveryRoot: (scope) => ({
          kind: 'scene-table',
          create: () => {
            if (!scope.isAlive()) throw new Error('GPU-driven candidate scope is not active.');
            throw new Error('GPU-driven candidate has no scene resource.');
          },
          cleanup: () => undefined,
        }),
        publish: () => undefined,
        discard: () => undefined,
        release: () => undefined,
      });
    }
    const created = GpuScene.create(
      device,
      Math.max(256, composition.projection.inspect().slotCapacity),
    );
    if (!created.ok) return created;
    if (created.value.status === 'unavailable') {
      return ok({
        state: undefined,
        createRecoveryRoot: (scope) => ({
          kind: 'scene-table',
          create: () => {
            if (!scope.isAlive()) throw new Error('GPU-driven candidate scope is not active.');
            throw new Error('GPU-driven candidate has no scene resource.');
          },
          cleanup: () => undefined,
        }),
        publish: () => undefined,
        discard: () => undefined,
        release: () => undefined,
      });
    }
    const scene = created.value.scene;
    const slots = composition.projection.slotsSnapshot();
    const rebuilt = scene.rebuild(slots);
    if (!rebuilt.ok) {
      scene.dispose();
      return rebuilt;
    }
    const state: PersistentGpuDrivenState = Object.freeze({
      scene,
      plan: composition.topology.plan(),
      slots,
    });
    let published = false;
    let released = false;
    return ok({
      state,
      createRecoveryRoot: (scope) => ({
        kind: 'scene-table',
        create: () => {
          if (!scope.isAlive()) throw new Error('GPU-driven candidate scope is not active.');
          return scene;
        },
        cleanup: () => undefined,
      }),
      publish: () => {
        if (published || released) return;
        published = true;
        this.gpuScene = scene;
        this.gpuOwner = composition.token;
        this.gpuDevice = device;
        this.gpuStatus = 'resident';
      },
      discard: () => {
        if (published || released) return;
        released = true;
        scene.dispose();
      },
      release: () => {
        if (published || released) return;
        released = true;
        scene.dispose();
      },
    });
  }

  createRecoveryRoot(scope: DeviceScope): LifecycleResourceSpec<unknown> {
    return {
      kind: 'scene-table',
      create: () => {
        const composition = this.composition;
        if (!scope.isAlive() || composition === undefined) {
          throw new Error('RenderScene CPU projection is not ready for recovery.');
        }
        return Object.freeze({
          generation: scope.generation,
          revision: composition.projection.inspect().revision,
          visibleSlots: composition.projection.slotsSnapshot().length,
        });
      },
      cleanup: () => undefined,
    };
  }

  setPointsLinesInspections(inspections: readonly PointsLinesInspection[]): void {
    this.pointsLinesInspections = inspections.map((inspection) => ({
      ...inspection,
      cache: { ...inspection.cache },
      ...(inspection.refusal === undefined ? {} : { refusal: { ...inspection.refusal } }),
    }));
  }

  dispose(): void {
    this.gpuScene?.dispose();
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuDevice = undefined;
    this.gpuStatus = 'inactive';
    this.composition = undefined;
    this.temporalCapture = undefined;
    this.visibilityFacets.clear();
    this.invalidateActiveEntityRevision();
    this.visibilityFacetFrame = undefined;
    this.visibilityProjectionCache = undefined;
    this.stableSlotByEntity.clear();
    this.pointsLinesInspections = [];
  }

  inspect(): PersistentRenderSceneInspection {
    const entry = this.composition;
    const pointsLines = this.pointsLinesInspections;
    return {
      worldEntitiesScanned: this.worldEntitiesScanned,
      fullRebuilds: this.fullRebuilds,
      noChangeFrames: this.noChangeFrames,
      deltaFrames: this.deltaFrames,
      transformUpdates: this.transformUpdates,
      lastResyncReason: this.lastResyncReason,
      projectionRecords: entry?.projection.inspect().records.length ?? 0,
      ...(entry === undefined ? {} : { probeBlend: entry.probeProjection.inspect() }),
      topology:
        entry?.topology.inspect() ??
        ({
          revision: 0,
          batchCount: 0,
          candidateCount: 0,
          rebuilds: 0,
          patches: 0,
          ineligible: 0,
        } satisfies BatchTopologyInspection),
      gpu: this.inspectGpu(),
      pointsLines,
    };
  }

  compositionGpuDrivenState(): PersistentGpuDrivenState | undefined {
    const entry = this.composition;
    if (entry === undefined || this.gpuOwner !== entry.token || this.gpuScene === undefined) {
      return undefined;
    }
    return {
      scene: this.gpuScene,
      plan: entry.topology.plan(),
      slots: entry.projection.slotsSnapshot(),
      worldKeys: entry.worldKeys,
    };
  }

  /** Publish renderer-owned previous transforms after queue submission. */
  commitTemporalFrame(): Result<void, RhiError> {
    // Previous transforms are consumed only by TAA and motion blur. Ordinary
    // frames must not copy and upload the complete GPU transform table.
    const gpuCommit = this.gpuScene?.commitTemporalFrame(this.temporalCapture !== undefined);
    if (gpuCommit !== undefined && !gpuCommit.ok) return gpuCommit;
    const temporalCapture = this.temporalCapture;
    if (temporalCapture !== undefined) {
      try {
        temporalCapture.projection.commitSubmission(temporalCapture.capture);
      } catch (cause) {
        void cause;
        return err(
          new RhiError({
            code: 'internal-error',
            expected: 'render scene remains unchanged while a submitted temporal frame commits',
            hint: 'retry the temporal frame after the renderer-owned scene snapshot is stable',
          }),
        );
      }
      this.temporalCapture = undefined;
    }
    return ok(undefined);
  }

  /** Capture current CPU scene facts; commitTemporalFrame publishes them only after submit. */
  prepareTemporalFrame(
    visible: readonly Pick<RenderableSnapshot, 'worldId' | 'entityKey'>[],
  ): void {
    const projection = this.composition?.projection;
    this.temporalCapture =
      projection === undefined
        ? undefined
        : { projection, capture: projection.captureSubmission(visible) };
  }

  pointsLinesSnapshots(): readonly PointsLinesRetainedSnapshot[] {
    return this.composition?.projection.pointsLinesSnapshots() ?? [];
  }

  private inspectGpu(): PersistentGpuSceneInspection {
    if (this.gpuStatus === 'resident' && this.gpuScene !== undefined) {
      return { status: 'resident', ...this.gpuScene.inspect() };
    }
    if (this.gpuStatus === 'unsupported') {
      return { status: 'unsupported', reason: 'storage-buffer-unavailable' };
    }
    if (this.gpuStatus === 'rebuild-pending') return { status: 'rebuild-pending' };
    if (this.gpuStatus === 'error') return { status: 'error' };
    return { status: 'inactive' };
  }

  private rebuildComposition(
    worlds: readonly World[],
    owner: { readonly cameraOwner: number; readonly resourceOwner: number },
    catalogEpoch: number,
    buildCandidateFrame: (request: PersistentRenderCandidateRequest) => ExtractedFrame,
    leases?: readonly RenderReadLease[],
    preserveVisibilityOnReorder = false,
  ): ExtractedFrame {
    const previousEntry = this.composition;
    const candidateFrame = buildCandidateFrame('full');
    this.temporalCapture = undefined;
    this.worldEntitiesScanned = candidateFrame.renderables.length;
    const worldKeys = this.visibilityWorldKeysFor(worlds);
    if (!preserveVisibilityOnReorder) {
      this.visibilityFacets.clear();
      this.invalidateActiveEntityRevision();
    } else if (previousEntry !== undefined) {
      const previousKeys = new Set(
        previousEntry.projection
          .slotsSnapshot()
          .map((slot) =>
            worldEntityKey(previousEntry.worldKeys[slot.worldId] ?? slot.worldId, slot.entityKey),
          ),
      );
      const currentKeys = new Set(
        candidateFrame.renderables.map((renderable) =>
          worldEntityKey(worldKeys[renderable.worldId] ?? renderable.worldId, renderable.entityKey),
        ),
      );
      if (
        previousKeys.size !== currentKeys.size ||
        [...previousKeys].some((key) => !currentKeys.has(key))
      ) {
        this.visibilityFacets.clear();
        this.invalidateActiveEntityRevision();
      }
    }
    // Slot allocation is renderer-owned identity. Sort by stable World identity
    // before allocating so a worlds[] reorder does not silently change a
    // primitive's slot/generation. Dispatch is remapped below to the sorted
    // renderable projection and remains frame-order independent.
    const sorted = candidateFrame.renderables
      .map((snapshot, sourceIndex) => ({ snapshot, sourceIndex }))
      .sort((left, right) => {
        const leftWorld = worldKeys[left.snapshot.worldId] ?? left.snapshot.worldId;
        const rightWorld = worldKeys[right.snapshot.worldId] ?? right.snapshot.worldId;
        return leftWorld - rightWorld || left.snapshot.entityKey - right.snapshot.entityKey;
      });
    const sortedRenderables = sorted.map(({ snapshot }) => snapshot);
    const renderableIndex = new Int32Array(candidateFrame.renderables.length);
    for (let index = 0; index < sorted.length; index += 1) {
      const sourceIndex = sorted[index]?.sourceIndex;
      if (sourceIndex !== undefined) renderableIndex[sourceIndex] = index;
    }
    const sortedDispatch = candidateFrame.dispatch.flatMap((entry) => {
      const index = renderableIndex[entry.renderableIndex];
      return index === undefined ? [] : [{ ...entry, renderableIndex: index }];
    });
    const stableCandidateFrame = {
      ...candidateFrame,
      renderables: sortedRenderables,
      dispatch: sortedDispatch,
    };
    const projection = new RenderScene();
    projection.reset(sortedRenderables);
    this.stableSlotByEntity.clear();
    for (const slot of projection.slotsSnapshot()) {
      const stableWorld = worldKeys[slot.worldId] ?? slot.worldId;
      this.stableSlotByEntity.set(worldEntityKey(stableWorld, slot.entityKey), slot);
    }
    const transmissionDemand = new PersistentTransmissionDemandProjection();
    transmissionDemand.apply(transmissionDemandOperations(candidateFrame.renderables));
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const skinConsumersByJoint = new Map<string, Set<number>>();
    for (const snapshot of stableCandidateFrame.renderables) {
      if (snapshot.skinJointEntities !== undefined) addSkinConsumer(skinConsumersByJoint, snapshot);
    }
    const token = {};
    const entry: PersistentCompositionEntry = {
      token,
      worlds: [...worlds],
      cameraOwner: owner.cameraOwner,
      resourceOwner: owner.resourceOwner,
      projection,
      topology,
      transmissionDemand,
      structure: {
        dispatch: stableCandidateFrame.dispatch,
        visibilityStats: stableCandidateFrame.visibilityStats,
        visibilitySnapshots: stableCandidateFrame.visibilitySnapshots,
        featureVisibilitySnapshots: stableCandidateFrame.featureVisibilitySnapshots,
        hiddenEntityReports: stableCandidateFrame.hiddenEntityReports,
      },
      worldKeys,
      readVersions:
        leases === undefined || leases.length !== worlds.length
          ? []
          : leases.map((lease) => lease.captureVersion()),
      leaseIdentities:
        leases === undefined || leases.length !== worlds.length
          ? []
          : leases.map((lease) => lease.worldIdentity),
      transformQueries:
        leases === undefined || leases.length !== worlds.length
          ? []
          : worlds.map(createGlobalTransformChangeQuery),
      renderChangeQueries:
        leases === undefined || leases.length !== worlds.length
          ? []
          : worlds.map(createRenderChangeQueries),
      dispatchBySlot: dispatchEntriesBySlot(stableCandidateFrame, projection),
      dispatchRevision: 0,
      dispatchCache: undefined,
      skinConsumersByJoint,
      pendingRenderableEntitiesByWorld: worlds.map(() => new Set<number>()),
      unavailableSlots: new Set<number>(),
      catalogEpoch,
      probeProjection: new ProbeBlendSceneProjection(),
      temporalDemanded: frameDemandsTemporal(candidateFrame),
      gpuDrivenSceneRequired: true,
    };
    this.composition = entry;
    projection.setTemporalTracking(entry.temporalDemanded);
    // The projection must be installed before deriving probe primitives.  On
    // the first composition rebuild `projectReflectionProbes` otherwise sees
    // no composition and silently drops every per-renderable selection,
    // leaving the producer on its neutral/no-demand path until an unrelated
    // later rebuild.
    this.projectReflectionProbes(candidateFrame.reflectionProbes ?? []);
    this.projectProbes(entry, candidateFrame);
    this.syncGpuOwner(token, projection, undefined, true);
    this.fullRebuilds += 1;
    this.lastResyncReason = 'attach';
    const materialized = projection.materialize();
    const candidates = entry.temporalDemanded
      ? materialized.map((snapshot) => projection.withTemporal(snapshot))
      : materialized;
    const frameWithProbes = attachProbeRecords(
      { ...stableCandidateFrame, renderables: candidates },
      candidates,
      projection.slotsSnapshot(),
      entry.probeProjection,
    );
    const slots = projection.slotsSnapshot();
    const result = cullPersistentFrame(
      frameWithProbes,
      frameWithProbes.renderables,
      (snapshot, index) => {
        const slot = slots[index];
        return slot === undefined
          ? projection.cullingWorldBounds(snapshot)
          : projection.cullingWorldBoundsAt(slot);
      },
    );
    this.frameEpoch += 1;
    this.visibilityFacetFrame = undefined;
    this.visibilityProjectionCache = undefined;
    return result;
  }

  /** Internal topology fact; the renderer does not expose demand as public API. */
  transmissionTopologyDemand(): TransmissionDemand {
    return (
      this.composition?.transmissionDemand.inspect() ?? {
        activeCount: 0,
        needsRoughMips: false,
      }
    );
  }

  /**
   * Derive an ephemeral frame plan from persistent scene facts. The scene
   * retains identity/topology/read versions; no prior frame object is an authority.
   */
  private deriveFramePlan(
    entry: PersistentCompositionEntry,
    buildCandidateFrame: (request: PersistentRenderCandidateRequest) => ExtractedFrame,
  ): ExtractedFrame {
    const resourceFrame = buildCandidateFrame('none');
    const cachedDispatch = entry.dispatchCache;
    const dispatch: DispatchEntry[] = [
      ...(cachedDispatch?.revision === entry.dispatchRevision
        ? cachedDispatch.value
        : dispatchForProjection(entry.dispatchBySlot, entry.projection, entry.unavailableSlots)),
    ];
    if (cachedDispatch?.revision !== entry.dispatchRevision) {
      entry.dispatchCache = { revision: entry.dispatchRevision, value: dispatch };
    }
    const candidateFrame: ExtractedFrame = {
      ...resourceFrame,
      ...entry.structure,
      dispatch,
    };
    entry.temporalDemanded = frameDemandsTemporal(candidateFrame);
    entry.projection.setTemporalTracking(entry.temporalDemanded);
    this.projectProbes(entry, candidateFrame);
    this.projectReflectionProbes(candidateFrame.reflectionProbes ?? []);
    const materialized = entry.projection.materialize();
    const candidates = entry.temporalDemanded
      ? materialized.map((snapshot) => entry.projection.withTemporal(snapshot))
      : materialized;
    const drawableCandidates =
      entry.unavailableSlots.size === 0
        ? candidates
        : candidates.map((snapshot) => {
            const slot = entry.projection.slot(snapshot.worldId, snapshot.entityKey);
            return slot !== undefined && entry.unavailableSlots.has(slot.slot)
              ? { ...snapshot, authorVisible: false }
              : snapshot;
          });
    const frameWithProbes = attachProbeRecords(
      { ...candidateFrame, renderables: drawableCandidates },
      drawableCandidates,
      entry.projection.slotsSnapshot(),
      entry.probeProjection,
    );
    const slots = entry.projection.slotsSnapshot();
    const result = cullPersistentFrame(
      frameWithProbes,
      frameWithProbes.renderables,
      (snapshot, index) => {
        const slot = slots[index];
        return slot === undefined
          ? entry.projection.cullingWorldBounds(snapshot)
          : entry.projection.cullingWorldBoundsAt(slot);
      },
    );
    this.frameEpoch += 1;
    this.visibilityFacetFrame = undefined;
    this.visibilityProjectionCache = undefined;
    return result;
  }

  private projectProbes(entry: PersistentCompositionEntry, frame: ExtractedFrame): void {
    const sky =
      frame.skylight === undefined
        ? {
            available: false,
            irradiance: [0, 0, 0] as const,
            fallbackReason: 'no-skylight',
          }
        : {
            available: true,
            identity: `skylight:${frame.skylight.entityHandle}`,
            sourceKey:
              frame.skylight.equirectHandle > 0
                ? `equirect:${frame.skylight.equirectHandle}`
                : `skylight:${frame.skylight.entityHandle}`,
            irradiance: [
              frame.skylight.color[0] * frame.skylight.intensity,
              frame.skylight.color[1] * frame.skylight.intensity,
              frame.skylight.color[2] * frame.skylight.intensity,
            ] as [number, number, number],
          };
    const probes = frame.lightProbes ?? [];
    // Sky is evaluated by the global environment path. With no local light
    // probes there can be no per-object ProbeBlendRecord, regardless of how
    // many dynamic objects moved this frame. Preserve the projection call so
    // a transition from probes to no probes still clears retained records.
    if (probes.length === 0) {
      entry.probeProjection.apply({ objects: [], probes, sky });
      return;
    }
    const objects: ProbeSceneObjectInput[] = entry.projection.slotsSnapshot().map((slot) => ({
      objectKey: slot.slot,
      generation: slot.generation,
      position: [
        slot.snapshot.transform.world[12] ?? 0,
        slot.snapshot.transform.world[13] ?? 0,
        slot.snapshot.transform.world[14] ?? 0,
      ],
    }));
    entry.probeProjection.apply({
      objects,
      probes,
      sky,
    });
  }

  private syncGpuOwner(
    owner: object,
    projection: RenderScene,
    delta?: RenderSceneApplyResult,
    full = false,
  ): void {
    if (this.composition?.token === owner && !this.composition.gpuDrivenSceneRequired) return;
    const acquired = this.acquireGpuScene(owner, projection);
    if (acquired === undefined || acquired.rebuilt) return;
    const result = full
      ? acquired.scene.rebuild(projection.slotsSnapshot())
      : delta === undefined
        ? acquired.scene.sync({
            created: 0,
            updated: 0,
            removed: 0,
            recreated: 0,
            ignoredLateUpdates: 0,
            createdSlots: [],
            updatedSlots: [],
            removedSlots: [],
            recreatedSlots: [],
            resynced: 0,
          })
        : acquired.scene.sync(delta);
    if (!result.ok) this.failGpu(result.error);
  }

  private acquireGpuScene(
    owner: object,
    projection: RenderScene,
  ): { readonly scene: GpuScene; readonly rebuilt: boolean } | undefined {
    const getDevice = this.options.getDevice;
    if (getDevice === undefined) return undefined;
    const device = getDevice();
    if (this.gpuDevice !== undefined && this.gpuDevice !== device) {
      this.gpuScene = undefined;
      this.gpuOwner = undefined;
      this.gpuStatus = 'rebuild-pending';
    }
    if (this.gpuStatus === 'error' && this.gpuDevice === device) return undefined;
    if (this.gpuStatus === 'unsupported' && this.gpuDevice === device) return undefined;
    if (this.gpuScene !== undefined && this.gpuOwner === owner) {
      return { scene: this.gpuScene, rebuilt: false };
    }
    if (this.gpuScene !== undefined) this.gpuScene.dispose();
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuDevice = device;
    const created = GpuScene.create(device, Math.max(256, projection.inspect().slotCapacity));
    if (!created.ok) {
      this.failGpu(created.error);
      return undefined;
    }
    if (created.value.status === 'unavailable') {
      this.gpuStatus = 'unsupported';
      return undefined;
    }
    const scene = created.value.scene;
    const rebuilt = scene.rebuild(projection.slotsSnapshot());
    if (!rebuilt.ok) {
      scene.dispose();
      this.failGpu(rebuilt.error);
      return undefined;
    }
    this.gpuScene = scene;
    this.gpuOwner = owner;
    this.gpuStatus = 'resident';
    return { scene, rebuilt: true };
  }

  private failGpu(error: RhiError): void {
    this.gpuScene?.dispose();
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuStatus = 'error';
    this.options.onGpuError?.(error);
  }
}
