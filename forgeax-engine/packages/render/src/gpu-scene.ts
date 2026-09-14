import type { Buffer, Result, RhiDevice } from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import {
  GPU_SCENE_LAYOUTS,
  type GpuSceneTableLayout,
  gpuSceneFieldOffset,
} from './gpu-scene-schema';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_STORAGE,
} from './gpu-usage';
import type { GpuSceneInspection } from './inspection-types';
import type { RenderSceneApplyResult, RenderSceneSlot } from './scene/render-scene-types';

export type { GpuSceneInspection } from './inspection-types';

const PRIMITIVE = GPU_SCENE_LAYOUTS.primitive;
const INSTANCE = GPU_SCENE_LAYOUTS.instance;
const TRANSFORM = GPU_SCENE_LAYOUTS.transform;
const DRAW_TEMPLATE = GPU_SCENE_LAYOUTS.drawTemplate;
const MATERIAL = GPU_SCENE_LAYOUTS.material;
const PRIMITIVE_ACTIVE = 1;
const PRIMITIVE_HAS_BOUNDS = 2;
const PRIMITIVE_GPU_DRIVEN = 4;
const IDENTITY_MATRIX = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

interface GpuSceneBuffers {
  readonly primitive: Buffer;
  readonly instance: Buffer;
  readonly transform: Buffer;
  readonly drawTemplate: Buffer;
  readonly material: Buffer;
}

interface PrimitiveAllocation {
  readonly instanceStart: number;
  readonly instanceCount: number;
  readonly transformStart: number;
  readonly instanceTransformStart: number;
  readonly instanceTransformCount: number;
  readonly drawStart: number;
  readonly drawCount: number;
  readonly materialStart: number;
  readonly materialCount: number;
}

class StableRangeAllocator {
  private next = 0;
  private readonly free: Array<{ start: number; count: number }> = [];

  allocate(count: number): number {
    const freeIndex = this.free.findIndex((range) => range.count >= count);
    if (freeIndex >= 0) {
      const range = this.free[freeIndex];
      if (range === undefined) throw new RangeError('free range disappeared');
      const start = range.start;
      if (range.count === count) this.free.splice(freeIndex, 1);
      else this.free[freeIndex] = { start: range.start + count, count: range.count - count };
      return start;
    }
    const start = this.next;
    this.next += count;
    return start;
  }

  release(start: number, count: number): void {
    if (count <= 0) return;
    this.free.push({ start, count });
    this.free.sort((left, right) => left.start - right.start);
    for (let index = this.free.length - 1; index > 0; index -= 1) {
      const current = this.free[index];
      const previous = this.free[index - 1];
      if (
        current === undefined ||
        previous === undefined ||
        previous.start + previous.count !== current.start
      ) {
        continue;
      }
      this.free[index - 1] = { start: previous.start, count: previous.count + current.count };
      this.free.splice(index, 1);
    }
  }

  requiredCapacity(): number {
    return this.next;
  }

  reset(start = 0): void {
    this.next = start;
    this.free.length = 0;
  }
}

type GpuSceneTableName = keyof GpuSceneBuffers;

const TABLE_LAYOUTS = {
  primitive: PRIMITIVE,
  instance: INSTANCE,
  transform: TRANSFORM,
  drawTemplate: DRAW_TEMPLATE,
  material: MATERIAL,
} as const satisfies Readonly<Record<GpuSceneTableName, GpuSceneTableLayout>>;

const TABLE_NAMES = Object.keys(TABLE_LAYOUTS) as readonly GpuSceneTableName[];

export interface GpuSceneSyncResult {
  readonly ranges: number;
  readonly bytes: number;
  readonly grew: boolean;
  readonly cleared: number;
}

export type GpuSceneAvailability =
  | { readonly status: 'available'; readonly scene: GpuScene }
  | { readonly status: 'unavailable'; readonly reason: 'storage-buffer-unavailable' };

function createBuffers(device: RhiDevice, capacity: number): Result<GpuSceneBuffers, RhiError> {
  const usage = GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC;
  const created: Partial<Record<GpuSceneTableName, Buffer>> = {};
  for (const name of TABLE_NAMES) {
    const result = device.createBuffer({
      label: `gpu-scene-${name}-table`,
      size: capacity * TABLE_LAYOUTS[name].stride,
      usage,
      mappedAtCreation: false,
    });
    if (!result.ok) {
      for (const buffer of Object.values(created)) device.destroyBuffer(buffer);
      return result;
    }
    created[name] = result.value;
  }
  const { primitive, instance, transform, drawTemplate, material } = created;
  if (
    primitive === undefined ||
    instance === undefined ||
    transform === undefined ||
    drawTemplate === undefined ||
    material === undefined
  ) {
    return err(
      new RhiError({
        code: 'internal-error',
        expected: 'GPU scene creates one buffer for every table',
        hint: 'rebuild the renderer after inspecting the device resource failure',
      }),
    );
  }
  return ok({ primitive, instance, transform, drawTemplate, material });
}

function writeMat4(view: DataView, byteOffset: number, value: Float32Array): void {
  for (let lane = 0; lane < 16; lane += 1) {
    view.setFloat32(byteOffset + lane * 4, value[lane] ?? 0, true);
  }
}

function writeVec4(view: DataView, byteOffset: number, values: readonly number[]): void {
  for (let lane = 0; lane < 4; lane += 1) {
    view.setFloat32(byteOffset + lane * 4, values[lane] ?? 0, true);
  }
}

function offset(layout: GpuSceneTableLayout, field: string): number {
  return gpuSceneFieldOffset(layout, field);
}

function stableU32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function coalesceSlots(
  slots: readonly number[],
): readonly { readonly start: number; readonly end: number }[] {
  let alreadyOrdered = true;
  for (let index = 1; index < slots.length; index += 1) {
    if ((slots[index] ?? 0) <= (slots[index - 1] ?? 0)) {
      alreadyOrdered = false;
      break;
    }
  }
  const ordered = alreadyOrdered ? slots : [...new Set(slots)].sort((a, b) => a - b);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const slot of ordered) {
    const previous = ranges.at(-1);
    if (previous !== undefined && previous.end === slot) {
      previous.end = slot + 1;
    } else {
      ranges.push({ start: slot, end: slot + 1 });
    }
  }
  return ranges;
}

/** Persistent GPU tables derived only from renderer projection slots. */
export class GpuScene {
  private disposed = false;
  private tableBytes: Record<GpuSceneTableName, ArrayBuffer>;
  private transformBytes: Uint8Array;
  private transformView: DataView;
  private buffers: GpuSceneBuffers;
  private uploadRanges = 0;
  private uploadBytes = 0;
  private capacityGrows = 0;
  private fullRebuilds = 0;
  private clearedSlots = 0;
  private noChangeFrames = 0;
  private identityUploaded = false;
  private readonly allocations: Array<PrimitiveAllocation | undefined> = [];
  private readonly instances = new StableRangeAllocator();
  private readonly transforms = new StableRangeAllocator();
  private readonly draws = new StableRangeAllocator();
  private readonly materials = new StableRangeAllocator();
  private readonly writesByTable: Record<GpuSceneTableName, number[]> = {
    primitive: [],
    instance: [],
    transform: [],
    drawTemplate: [],
    material: [],
  };
  /** Transform rows whose previous value advances only after submit. */
  private readonly pendingTemporalTransforms = new Set<number>();
  /** Previous rows whose post-submit upload must be retried before the next draw. */
  private readonly pendingTemporalUploads = new Set<number>();

  private constructor(
    private readonly device: RhiDevice,
    private capacity: number,
    buffers: GpuSceneBuffers,
  ) {
    this.buffers = buffers;
    this.tableBytes = this.allocateCpuTables(capacity);
    this.transformBytes = new Uint8Array(this.tableBytes.transform);
    this.transformView = new DataView(this.tableBytes.transform);
    this.transforms.reset(1);
    this.writeIdentityTransform();
  }

  static create(device: RhiDevice, initialCapacity = 256): Result<GpuSceneAvailability, RhiError> {
    if (!device.caps.storageBuffer) {
      return ok({ status: 'unavailable', reason: 'storage-buffer-unavailable' });
    }
    const requestedCapacity = Number.isFinite(initialCapacity)
      ? Math.max(1, Math.ceil(initialCapacity))
      : 256;
    const capacity = 2 ** Math.ceil(Math.log2(requestedCapacity));
    const buffers = createBuffers(device, capacity);
    if (!buffers.ok) return err(buffers.error);
    return ok({ status: 'available', scene: new GpuScene(device, capacity, buffers.value) });
  }

  get primitiveBuffer(): Buffer {
    return this.buffers.primitive;
  }

  get instanceBuffer(): Buffer {
    return this.buffers.instance;
  }

  get transformBuffer(): Buffer {
    return this.buffers.transform;
  }

  get drawTemplateBuffer(): Buffer {
    return this.buffers.drawTemplate;
  }

  get materialBuffer(): Buffer {
    return this.buffers.material;
  }

  sync(delta: RenderSceneApplyResult): Result<GpuSceneSyncResult, RhiError> {
    for (const transformIndex of this.pendingTemporalUploads) {
      this.writesByTable.transform.push(transformIndex);
    }
    const pendingWrites = TABLE_NAMES.some((name) => this.writesByTable[name].length > 0);
    if (
      delta.createdSlots.length === 0 &&
      delta.updatedSlots.length === 0 &&
      delta.recreatedSlots.length === 0 &&
      delta.removedSlots.length === 0 &&
      !pendingWrites
    ) {
      this.noChangeFrames += 1;
      return ok({ ranges: 0, bytes: 0, grew: false, cleared: 0 });
    }
    const writesByTable = this.writesByTable;
    if (!this.identityUploaded && !writesByTable.transform.includes(0)) {
      writesByTable.transform.push(0);
    }
    let highestChangedSlot = -1;
    const contentUpdatedSlots = delta.contentUpdatedSlots ?? [];
    const contentUpdatedSlotIds = new Set(contentUpdatedSlots.map((record) => record.slot));
    const allocationResets = new Set<number>();
    // RenderScene may recycle a released CPU slot for a different identity in
    // the same delta. Clear the old GPU allocation before ensuring the new
    // record; otherwise the later removal pass clears the newly allocated
    // record and the next transform-only update sees no allocation.
    for (const record of delta.removedSlots) {
      if (record.slot > highestChangedSlot) highestChangedSlot = record.slot;
      this.clearSlot(record.slot, writesByTable);
    }
    for (const records of [delta.createdSlots, contentUpdatedSlots, delta.recreatedSlots]) {
      for (const record of records) {
        const previous = this.allocations[record.slot];
        this.ensureAllocation(record, writesByTable);
        if (previous !== this.allocations[record.slot]) allocationResets.add(record.slot);
        if (record.slot > highestChangedSlot) highestChangedSlot = record.slot;
      }
    }
    for (const record of delta.updatedSlots) {
      if (record.slot > highestChangedSlot) highestChangedSlot = record.slot;
    }
    const requiredCapacity = Math.max(
      highestChangedSlot + 1,
      this.instances.requiredCapacity(),
      this.transforms.requiredCapacity(),
      this.draws.requiredCapacity(),
      this.materials.requiredCapacity(),
    );
    const grew = requiredCapacity > this.capacity;
    if (grew) {
      const grown = this.grow(requiredCapacity);
      if (!grown.ok) return grown;
    }

    for (const record of delta.createdSlots) this.writeSlot(record, true, writesByTable);
    for (const record of contentUpdatedSlots) {
      this.writeSlot(record, allocationResets.has(record.slot), writesByTable);
    }
    for (const record of delta.updatedSlots) {
      if (contentUpdatedSlotIds.has(record.slot)) continue;
      this.writeRootTransform(record, false, writesByTable);
    }
    for (const record of delta.recreatedSlots) this.writeSlot(record, true, writesByTable);
    const uploaded = this.uploadRows(writesByTable);
    if (!uploaded.ok) return uploaded;
    this.pendingTemporalUploads.clear();
    for (const name of TABLE_NAMES) writesByTable[name].length = 0;
    this.identityUploaded = true;
    this.clearedSlots += delta.removedSlots.length;
    return ok({
      ranges: uploaded.value.ranges,
      bytes: uploaded.value.bytes,
      grew,
      cleared: delta.removedSlots.length,
    });
  }

  /** Publish current transforms as previous only after a successful submit. */
  commitTemporalFrame(enabled = true): Result<void, RhiError> {
    if (!enabled) {
      this.pendingTemporalTransforms.clear();
      this.pendingTemporalUploads.clear();
      return ok(undefined);
    }
    if (this.pendingTemporalTransforms.size === 0) return ok(undefined);
    const currentOffset = offset(TRANSFORM, 'currentWorld');
    const previousOffset = offset(TRANSFORM, 'previousWorld');
    const ranges = coalesceSlots([...this.pendingTemporalTransforms]);
    for (const range of ranges) {
      for (let index = range.start; index < range.end; index += 1) {
        this.pendingTemporalUploads.add(index);
      }
    }
    for (const range of ranges) {
      for (let index = range.start; index < range.end; index += 1) {
        this.transformBytes.copyWithin(
          index * TRANSFORM.stride + previousOffset,
          index * TRANSFORM.stride + currentOffset,
          index * TRANSFORM.stride + currentOffset + 64,
        );
      }
    }
    for (const range of ranges) {
      const firstOffset = range.start * TRANSFORM.stride;
      const lastOffset = range.end * TRANSFORM.stride;
      const uploaded = this.device.queue.writeBuffer(
        this.buffers.transform,
        firstOffset,
        this.transformBytes.subarray(firstOffset, lastOffset),
      );
      if (!uploaded.ok) return uploaded;
    }
    this.pendingTemporalTransforms.clear();
    this.pendingTemporalUploads.clear();
    const bytes = ranges.reduce(
      (total, range) => total + (range.end - range.start) * TRANSFORM.stride,
      0,
    );
    this.uploadRanges += ranges.length;
    this.uploadBytes += bytes;
    return ok(undefined);
  }

  rebuild(slots: readonly RenderSceneSlot[]): Result<GpuSceneSyncResult, RhiError> {
    this.allocations.length = 0;
    this.instances.reset();
    this.transforms.reset(1);
    this.draws.reset();
    this.materials.reset();
    this.pendingTemporalTransforms.clear();
    this.pendingTemporalUploads.clear();
    for (const name of TABLE_NAMES) this.writesByTable[name].length = 0;
    const writesByTable: Record<GpuSceneTableName, number[]> = {
      primitive: [],
      instance: [],
      transform: [],
      drawTemplate: [],
      material: [],
    };
    for (const slot of slots) this.ensureAllocation(slot, writesByTable);
    const highestSlot = slots.reduce((maximum, slot) => Math.max(maximum, slot.slot), -1);
    const requiredCapacity = Math.max(
      highestSlot + 1,
      this.instances.requiredCapacity(),
      this.transforms.requiredCapacity(),
      this.draws.requiredCapacity(),
      this.materials.requiredCapacity(),
    );
    let grew = false;
    if (requiredCapacity > this.capacity) {
      const grown = this.grow(requiredCapacity);
      if (!grown.ok) return grown;
      grew = true;
    }
    for (const bytes of Object.values(this.tableBytes)) new Uint8Array(bytes).fill(0);
    this.writeIdentityTransform();
    for (const slot of slots) this.writeSlot(slot, true, writesByTable);
    let bytes = 0;
    for (const name of TABLE_NAMES) {
      const table = this.tableBytes[name];
      const write = this.device.queue.writeBuffer(this.buffers[name], 0, new Uint8Array(table));
      if (!write.ok) return write;
      bytes += table.byteLength;
    }
    this.uploadRanges += TABLE_NAMES.length;
    this.uploadBytes += bytes;
    this.fullRebuilds += 1;
    this.identityUploaded = true;
    return ok({ ranges: TABLE_NAMES.length, bytes, grew, cleared: 0 });
  }

  inspect(): GpuSceneInspection {
    return {
      capacity: this.capacity,
      tables: {
        primitive: {
          capacity: this.capacity,
          bytes: this.tableBytes.primitive.byteLength,
        },
        instance: {
          capacity: this.capacity,
          bytes: this.tableBytes.instance.byteLength,
        },
        transform: {
          capacity: this.capacity,
          bytes: this.tableBytes.transform.byteLength,
        },
        drawTemplate: {
          capacity: this.capacity,
          bytes: this.tableBytes.drawTemplate.byteLength,
        },
        material: {
          capacity: this.capacity,
          bytes: this.tableBytes.material.byteLength,
        },
      },
      uploadRanges: this.uploadRanges,
      uploadBytes: this.uploadBytes,
      capacityGrows: this.capacityGrows,
      fullRebuilds: this.fullRebuilds,
      clearedSlots: this.clearedSlots,
      noChangeFrames: this.noChangeFrames,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const buffer of Object.values(this.buffers)) this.device.destroyBuffer(buffer);
  }

  private writeSlot(
    record: RenderSceneSlot,
    resetPrevious: boolean,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    const allocation = this.allocations[record.slot];
    if (allocation === undefined) throw new RangeError('GPU Scene allocation unavailable');
    const primitiveOffset = record.slot * PRIMITIVE.stride;
    const primitive = new DataView(this.tableBytes.primitive);
    const bounds = record.snapshot.localAabb;
    primitive.setUint32(primitiveOffset + offset(PRIMITIVE, 'generation'), record.generation, true);
    primitive.setUint32(
      primitiveOffset + offset(PRIMITIVE, 'flags'),
      PRIMITIVE_ACTIVE |
        (bounds === undefined ? 0 : PRIMITIVE_HAS_BOUNDS) |
        (record.snapshot.gpuDrivenDraws === undefined ? 0 : PRIMITIVE_GPU_DRIVEN),
      true,
    );
    primitive.setUint32(
      primitiveOffset + offset(PRIMITIVE, 'transformIndex'),
      allocation.transformStart,
      true,
    );
    primitive.setUint32(
      primitiveOffset + offset(PRIMITIVE, 'materialIndex'),
      allocation.materialStart,
      true,
    );
    primitive.setUint32(
      primitiveOffset + offset(PRIMITIVE, 'drawTemplateIndex'),
      allocation.drawStart,
      true,
    );
    primitive.setUint32(
      primitiveOffset + offset(PRIMITIVE, 'instanceStart'),
      allocation.instanceStart,
      true,
    );
    primitive.setUint32(
      primitiveOffset + offset(PRIMITIVE, 'instanceCount'),
      allocation.instanceCount,
      true,
    );
    primitive.setUint32(
      primitiveOffset + offset(PRIMITIVE, 'assetHandle'),
      record.snapshot.assetHandle,
      true,
    );
    writeVec4(primitive, primitiveOffset + offset(PRIMITIVE, 'localBoundsMin'), [
      bounds?.[0] ?? 0,
      bounds?.[1] ?? 0,
      bounds?.[2] ?? 0,
      0,
    ]);
    writeVec4(primitive, primitiveOffset + offset(PRIMITIVE, 'localBoundsMax'), [
      bounds?.[3] ?? 0,
      bounds?.[4] ?? 0,
      bounds?.[5] ?? 0,
      0,
    ]);

    const instance = new DataView(this.tableBytes.instance);
    const transform = this.transformView;
    for (let ordinal = 0; ordinal < allocation.instanceCount; ordinal += 1) {
      const instanceIndex = allocation.instanceStart + ordinal;
      const instanceOffset = instanceIndex * INSTANCE.stride;
      const transformIndex =
        allocation.instanceTransformCount === 0 ? 0 : allocation.instanceTransformStart + ordinal;
      instance.setUint32(instanceOffset + offset(INSTANCE, 'primitiveIndex'), record.slot, true);
      instance.setUint32(instanceOffset + offset(INSTANCE, 'transformIndex'), transformIndex, true);
      instance.setUint32(instanceOffset + offset(INSTANCE, 'customDataStart'), 0, true);
      instance.setUint32(instanceOffset + offset(INSTANCE, 'flags'), PRIMITIVE_ACTIVE, true);
      if (allocation.instanceTransformCount > 0) {
        const local = record.snapshot.instances?.transforms.subarray(
          ordinal * 16,
          ordinal * 16 + 16,
        );
        const localWorld = local?.length === 16 ? local : IDENTITY_MATRIX;
        const localOffset = transformIndex * TRANSFORM.stride;
        const localCurrentOffset = localOffset + offset(TRANSFORM, 'currentWorld');
        const localPreviousOffset = localOffset + offset(TRANSFORM, 'previousWorld');
        writeMat4(transform, localCurrentOffset, localWorld);
        if (resetPrevious) writeMat4(transform, localPreviousOffset, localWorld);
        else this.pendingTemporalTransforms.add(transformIndex);
        writes.transform.push(transformIndex);
      }
      writes.instance.push(instanceIndex);
    }

    this.writeRootTransform(record, resetPrevious, writes);
    writes.primitive.push(record.slot);

    const draw = new DataView(this.tableBytes.drawTemplate);
    const drawSnapshots = record.snapshot.gpuDrivenDraws ?? [];
    for (let ordinal = 0; ordinal < allocation.drawCount; ordinal += 1) {
      const drawIndex = allocation.drawStart + ordinal;
      const drawOffset = drawIndex * DRAW_TEMPLATE.stride;
      const drawSnapshot = drawSnapshots[ordinal];
      draw.setUint32(
        drawOffset + offset(DRAW_TEMPLATE, 'pipelineClass'),
        drawSnapshot === undefined
          ? 0
          : stableU32(
              drawSnapshot.prepared === undefined
                ? drawSnapshot.pipelineClass
                : `${drawSnapshot.prepared.identity.material}|${drawSnapshot.prepared.identity.geometry}|${drawSnapshot.prepared.identity.deformation}`,
            ),
        true,
      );
      draw.setUint32(
        drawOffset + offset(DRAW_TEMPLATE, 'materialIndex'),
        allocation.materialStart + (drawSnapshot?.materialSlot ?? 0),
        true,
      );
      draw.setUint32(
        drawOffset + offset(DRAW_TEMPLATE, 'firstIndex'),
        drawSnapshot?.prepared?.first ?? drawSnapshot?.first ?? 0,
        true,
      );
      draw.setUint32(
        drawOffset + offset(DRAW_TEMPLATE, 'indexCount'),
        drawSnapshot?.prepared?.count ?? drawSnapshot?.count ?? 0,
        true,
      );
      draw.setInt32(
        drawOffset + offset(DRAW_TEMPLATE, 'baseVertex'),
        drawSnapshot?.prepared?.baseVertex ?? drawSnapshot?.baseVertex ?? 0,
        true,
      );
      draw.setUint32(drawOffset + offset(DRAW_TEMPLATE, 'firstInstance'), 0, true);
      draw.setUint32(drawOffset + offset(DRAW_TEMPLATE, 'passFlags'), 0, true);
      draw.setUint32(drawOffset + offset(DRAW_TEMPLATE, 'reserved'), 0, true);
      writes.drawTemplate.push(drawIndex);
    }

    const material = new DataView(this.tableBytes.material);
    for (let ordinal = 0; ordinal < allocation.materialCount; ordinal += 1) {
      const materialIndex = allocation.materialStart + ordinal;
      const materialOffset = materialIndex * MATERIAL.stride;
      const snapshot = record.snapshot.materials[ordinal] ?? record.snapshot.material;
      writeVec4(material, materialOffset + offset(MATERIAL, 'params0'), [
        snapshot.baseColor?.[0] ?? 0,
        snapshot.baseColor?.[1] ?? 0,
        snapshot.baseColor?.[2] ?? 0,
        1,
      ]);
      writeVec4(material, materialOffset + offset(MATERIAL, 'params1'), [
        snapshot.metallic ?? 0,
        snapshot.roughness ?? 1,
      ]);
      writeVec4(material, materialOffset + offset(MATERIAL, 'params2'), [
        snapshot.emissive?.[0] ?? 0,
        snapshot.emissive?.[1] ?? 0,
        snapshot.emissive?.[2] ?? 0,
        snapshot.emissiveIntensity ?? 0,
      ]);
      writeVec4(material, materialOffset + offset(MATERIAL, 'params3'), [
        snapshot.normalScale ?? 1,
        snapshot.occlusionStrength ?? 1,
        0,
        0,
      ]);
      material.setUint32(
        materialOffset + offset(MATERIAL, 'resource0'),
        snapshot.baseColorTexture ?? 0,
        true,
      );
      material.setUint32(
        materialOffset + offset(MATERIAL, 'resource1'),
        snapshot.metallicRoughnessTexture ?? 0,
        true,
      );
      material.setUint32(
        materialOffset + offset(MATERIAL, 'resource2'),
        snapshot.normalTexture ?? 0,
        true,
      );
      material.setUint32(
        materialOffset + offset(MATERIAL, 'resource3'),
        snapshot.emissiveTexture ?? 0,
        true,
      );
      writes.material.push(materialIndex);
    }
  }

  private writeRootTransform(
    record: RenderSceneSlot,
    resetPrevious: boolean,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    const allocation = this.allocations[record.slot];
    if (allocation === undefined) throw new RangeError('GPU Scene allocation unavailable');
    const transformOffset = allocation.transformStart * TRANSFORM.stride;
    const previousOffset = transformOffset + offset(TRANSFORM, 'previousWorld');
    if (resetPrevious) {
      writeMat4(this.transformView, previousOffset, record.snapshot.transform.world);
    }
    writeMat4(
      this.transformView,
      transformOffset + offset(TRANSFORM, 'currentWorld'),
      record.snapshot.transform.world,
    );
    if (!resetPrevious) this.pendingTemporalTransforms.add(allocation.transformStart);
    writes.transform.push(allocation.transformStart);
  }

  private clearSlot(slot: number, writes: Record<GpuSceneTableName, number[]>): void {
    for (const name of ['primitive'] as const) {
      const layout = TABLE_LAYOUTS[name];
      new Uint8Array(this.tableBytes[name], slot * layout.stride, layout.stride).fill(0);
      writes[name].push(slot);
    }
    const allocation = this.allocations[slot];
    if (allocation === undefined) return;
    this.clearAllocation(allocation, writes);
    this.allocations[slot] = undefined;
  }

  private uploadRows(
    rows: Readonly<Record<GpuSceneTableName, readonly number[]>>,
  ): Result<{ readonly ranges: number; readonly bytes: number }, RhiError> {
    let rangeCount = 0;
    let bytes = 0;
    for (const name of TABLE_NAMES) {
      const ranges = coalesceSlots(rows[name]);
      rangeCount += ranges.length;
      for (const range of ranges) {
        const layout = TABLE_LAYOUTS[name];
        const tableOffset = range.start * layout.stride;
        const tableSize = (range.end - range.start) * layout.stride;
        const write = this.device.queue.writeBuffer(
          this.buffers[name],
          tableOffset,
          new Uint8Array(this.tableBytes[name], tableOffset, tableSize),
        );
        if (!write.ok) return write;
        bytes += tableSize;
      }
    }
    this.uploadRanges += rangeCount;
    this.uploadBytes += bytes;
    return ok({ ranges: rangeCount, bytes });
  }

  private ensureAllocation(
    record: RenderSceneSlot,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    // A present Instances component is authoritative even when its array is
    // empty: preserve zero so neither the GPU Scene nor the indirect topology
    // turns it into a synthetic identity instance. Entities without the
    // component retain the ordinary one-instance identity path.
    const explicitInstances = record.snapshot.instances;
    const instanceCount =
      explicitInstances === undefined
        ? 1
        : Math.max(0, Math.floor(explicitInstances.instanceCount));
    const instanceTransformCount = explicitInstances === undefined ? 0 : instanceCount;
    const drawCount = Math.max(1, record.snapshot.gpuDrivenDraws?.length ?? 0);
    const materialCount = Math.max(1, record.snapshot.materials.length);
    const existing = this.allocations[record.slot];
    if (
      existing?.instanceCount === instanceCount &&
      existing.instanceTransformCount === instanceTransformCount &&
      existing.drawCount === drawCount &&
      existing.materialCount === materialCount
    ) {
      return;
    }
    if (existing !== undefined) this.clearAllocation(existing, writes);
    const allocation = {
      instanceStart: this.instances.allocate(instanceCount),
      instanceCount,
      transformStart: this.transforms.allocate(1),
      instanceTransformStart:
        instanceTransformCount === 0 ? 0 : this.transforms.allocate(instanceTransformCount),
      instanceTransformCount,
      drawStart: this.draws.allocate(drawCount),
      drawCount,
      materialStart: this.materials.allocate(materialCount),
      materialCount,
    };
    this.allocations[record.slot] = allocation;
  }

  private clearAllocation(
    allocation: PrimitiveAllocation,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    for (let ordinal = 0; ordinal < allocation.instanceCount; ordinal += 1) {
      const instanceIndex = allocation.instanceStart + ordinal;
      new Uint8Array(
        this.tableBytes.instance,
        instanceIndex * INSTANCE.stride,
        INSTANCE.stride,
      ).fill(0);
      writes.instance.push(instanceIndex);
    }
    for (let ordinal = -1; ordinal < allocation.instanceTransformCount; ordinal += 1) {
      const transformIndex =
        ordinal < 0 ? allocation.transformStart : allocation.instanceTransformStart + ordinal;
      new Uint8Array(
        this.tableBytes.transform,
        transformIndex * TRANSFORM.stride,
        TRANSFORM.stride,
      ).fill(0);
      writes.transform.push(transformIndex);
      this.pendingTemporalTransforms.delete(transformIndex);
      this.pendingTemporalUploads.delete(transformIndex);
    }
    for (let ordinal = 0; ordinal < allocation.drawCount; ordinal += 1) {
      const drawIndex = allocation.drawStart + ordinal;
      new Uint8Array(
        this.tableBytes.drawTemplate,
        drawIndex * DRAW_TEMPLATE.stride,
        DRAW_TEMPLATE.stride,
      ).fill(0);
      writes.drawTemplate.push(drawIndex);
    }
    for (let ordinal = 0; ordinal < allocation.materialCount; ordinal += 1) {
      const materialIndex = allocation.materialStart + ordinal;
      new Uint8Array(
        this.tableBytes.material,
        materialIndex * MATERIAL.stride,
        MATERIAL.stride,
      ).fill(0);
      writes.material.push(materialIndex);
    }
    this.instances.release(allocation.instanceStart, allocation.instanceCount);
    this.transforms.release(allocation.transformStart, 1);
    this.transforms.release(allocation.instanceTransformStart, allocation.instanceTransformCount);
    this.draws.release(allocation.drawStart, allocation.drawCount);
    this.materials.release(allocation.materialStart, allocation.materialCount);
  }

  private grow(requiredCapacity: number): Result<void, RhiError> {
    let nextCapacity = this.capacity;
    while (nextCapacity < requiredCapacity) nextCapacity *= 2;
    const nextBuffers = createBuffers(this.device, nextCapacity);
    if (!nextBuffers.ok) return err(nextBuffers.error);
    const nextTables = this.allocateCpuTables(nextCapacity);
    for (const name of TABLE_NAMES) {
      new Uint8Array(nextTables[name]).set(new Uint8Array(this.tableBytes[name]));
      const write = this.device.queue.writeBuffer(
        nextBuffers.value[name],
        0,
        new Uint8Array(nextTables[name]),
      );
      if (!write.ok) {
        for (const buffer of Object.values(nextBuffers.value)) this.device.destroyBuffer(buffer);
        return write;
      }
    }
    for (const buffer of Object.values(this.buffers)) this.device.destroyBuffer(buffer);
    this.buffers = nextBuffers.value;
    this.tableBytes = nextTables;
    this.refreshTransformViews();
    this.capacity = nextCapacity;
    this.capacityGrows += 1;
    this.uploadRanges += TABLE_NAMES.length;
    this.uploadBytes += Object.values(nextTables).reduce(
      (total, bytes) => total + bytes.byteLength,
      0,
    );
    return ok(undefined);
  }

  private allocateCpuTables(capacity: number): Record<GpuSceneTableName, ArrayBuffer> {
    return {
      primitive: new ArrayBuffer(capacity * PRIMITIVE.stride),
      instance: new ArrayBuffer(capacity * INSTANCE.stride),
      transform: new ArrayBuffer(capacity * TRANSFORM.stride),
      drawTemplate: new ArrayBuffer(capacity * DRAW_TEMPLATE.stride),
      material: new ArrayBuffer(capacity * MATERIAL.stride),
    };
  }

  private refreshTransformViews(): void {
    this.transformBytes = new Uint8Array(this.tableBytes.transform);
    this.transformView = new DataView(this.tableBytes.transform);
  }

  private writeIdentityTransform(): void {
    writeMat4(this.transformView, offset(TRANSFORM, 'currentWorld'), IDENTITY_MATRIX);
    writeMat4(this.transformView, offset(TRANSFORM, 'previousWorld'), IDENTITY_MATRIX);
  }
}
