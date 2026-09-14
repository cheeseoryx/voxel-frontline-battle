import { deriveVertexBufferLayoutFromProjection } from '@forgeax/engine-geometry';
import { frustum, mat3, mat4 } from '@forgeax/engine-math';
import type {
  GraphAccess,
  GraphBuffer,
  GraphResourceResolver,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  RenderPipeline,
  Result,
  RhiDevice,
  ShaderModule,
  TextureFormat,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { MaterialRenderState } from '@forgeax/engine-types';
import type { DeviceScope, LifecycleResourceSpec } from '../device/device-scope';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { GPU_SCENE_WGSL } from '../gpu-scene-schema';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import { assembleMaterialWithSkylightEntries } from '../ibl/skylight-bind-group';
import type { GpuDrivenProductionInspection } from '../inspection-types';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import { worldEntityKey } from '../record/frame-snapshot';
import { geometryRenderStateForTopology } from '../record/main-pass-material';
import { MESH_SSBO_BYTES } from '../record/mesh-ssbo';
import type { PipelineState } from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import type { RenderPipelineFrame, RenderPipelineGpuDrivenProjection } from '../render-pipeline';
import type { RenderableSnapshot } from '../render-system-extract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import { selectLod } from '../scene/visibility/lod-selector';
import type { OcclusionFrameProjection } from '../scene/visibility/occlusion-runtime';
import {
  type GpuDrivenBatch,
  type GpuDrivenCandidate,
  projectedHeightForCandidate,
  type SubmissionPlan,
} from './batch-topology';
import {
  GPU_DRIVEN_VIEW_WGSL,
  type GpuDrivenLodSelectionInspection,
  GpuDrivenView,
  selectGpuLodLane,
} from './view-gpu';

const VERTEX_STAGE = 0x1;
const FRAGMENT_STAGE = 0x2;
const EMPTY_RESOURCE_CLASS = JSON.stringify({ textures: [], samplers: [], video: [] });

export interface StandardPbrSceneCandidate {
  readonly primitiveIndex: number;
  readonly world: Float32Array;
}

export interface StandardPbrSceneProjection {
  readonly entryPoint: string;
  readonly layoutIdentity: string;
  readonly receiptGeneration: number;
  /** Packed Mesh rows: mat4 + padded mat3 + previous mat4 + temporal vec4. */
  readonly rows: Float32Array;
}

/**
 * Build the producer-owned Standard PBR scene-index projection. The receipt is
 * the only source of the vertex entry and layout identity; callers cannot
 * silently fall back to the legacy GPU-driven shader ABI.
 */
export function projectStandardPbrScene(input: {
  readonly artifact: MaterialShaderArtifact;
  readonly candidates: readonly StandardPbrSceneCandidate[];
}):
  | { readonly ok: true; readonly value: StandardPbrSceneProjection }
  | {
      readonly ok: false;
      readonly error: { readonly code: 'missing-material-receipt' | 'invalid-material-receipt' };
    } {
  const receipt = input.artifact.receipt;
  if (receipt === undefined) return { ok: false, error: { code: 'missing-material-receipt' } };
  if (receipt.reflection.layoutIdentity !== input.artifact.layoutIdentity) {
    return { ok: false, error: { code: 'invalid-material-receipt' } };
  }
  const rows = new Float32Array(input.candidates.length * 48);
  const normal = mat3.create();
  for (let index = 0; index < input.candidates.length; index += 1) {
    const candidate = input.candidates[index];
    if (candidate === undefined) continue;
    const base = index * 48;
    for (let value = 0; value < 16; value += 1) {
      rows[base + value] = candidate.world[value] ?? 0;
      rows[base + 28 + value] = candidate.world[value] ?? 0;
    }
    const normalMatrix = mat3.normalMatrix(normal, candidate.world);
    for (let column = 0; column < 3; column += 1) {
      const source = column * 3;
      const target = base + 16 + column * 4;
      rows[target] = normalMatrix[source] ?? 0;
      rows[target + 1] = normalMatrix[source + 1] ?? 0;
      rows[target + 2] = normalMatrix[source + 2] ?? 0;
    }
  }
  return {
    ok: true,
    value: {
      entryPoint: receipt.sceneIndexEntry,
      layoutIdentity: input.artifact.layoutIdentity,
      receiptGeneration: receipt.generation,
      rows,
    },
  };
}

export interface StandardPbrFrameResourceBinding {
  readonly entryPoint: string;
  readonly layoutIdentity: string;
  readonly receiptGeneration: number;
  readonly bindGroups: readonly [BindGroup, BindGroup, BindGroup, BindGroup];
  readonly resourceSlots: NonNullable<MaterialShaderArtifact['receipt']>['resourceSlots'];
}

/**
 * Adapt the frame's already-created Standard PBR groups to the GPU-driven
 * scene-index draw. This deliberately accepts group handles rather than
 * rebuilding layouts or shader artifacts; the receipt remains the binding
 * contract and the regular frame producers remain the resource owners.
 */
export function adaptStandardPbrFrameResources(input: {
  readonly artifact: MaterialShaderArtifact;
  readonly view: BindGroup;
  readonly material: BindGroup;
  readonly mesh: BindGroup;
  readonly instances: BindGroup;
}):
  | { readonly ok: true; readonly value: StandardPbrFrameResourceBinding }
  | {
      readonly ok: false;
      readonly error: { readonly code: 'missing-material-receipt' | 'invalid-material-receipt' };
    } {
  const receipt = input.artifact.receipt;
  if (receipt === undefined) return { ok: false, error: { code: 'missing-material-receipt' } };
  const reflected = receipt.reflection;
  const sameSlots =
    reflected.resourceSlots.length === receipt.resourceSlots.length &&
    reflected.resourceSlots.every((slot, index) => {
      const expected = receipt.resourceSlots[index];
      return (
        expected !== undefined &&
        slot.name === expected.name &&
        slot.parameter === expected.parameter &&
        slot.kind === expected.kind &&
        slot.group === expected.group &&
        slot.binding === expected.binding
      );
    });
  if (
    reflected.layoutIdentity !== input.artifact.layoutIdentity ||
    !sameSlots ||
    receipt.resourceSlots.some((slot) => slot.group !== 1)
  ) {
    return { ok: false, error: { code: 'invalid-material-receipt' } };
  }
  return {
    ok: true,
    value: {
      entryPoint: receipt.sceneIndexEntry,
      layoutIdentity: input.artifact.layoutIdentity,
      receiptGeneration: receipt.generation,
      bindGroups: [input.view, input.material, input.mesh, input.instances],
      resourceSlots: receipt.resourceSlots,
    },
  };
}

export const GPU_DRIVEN_RIGID_UNLIT_WGSL = /* wgsl */ `
${GPU_SCENE_WGSL}

struct ViewData {
  slots: array<vec4<f32>, 49>,
};

@group(0) @binding(0) var<uniform> view: ViewData;
@group(1) @binding(0) var<storage, read> primitives: array<GpuScenePrimitive>;
@group(1) @binding(1) var<storage, read> instances: array<GpuSceneInstance>;
@group(1) @binding(2) var<storage, read> materials: array<GpuSceneMaterial>;
@group(1) @binding(3) var<storage, read> visibleItems: array<vec2<u32>>;
@group(1) @binding(4) var<storage, read> transforms: array<GpuSceneTransform>;

struct VertexInput {
  @location(0) position: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput, @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
  let viewProjection = mat4x4<f32>(view.slots[0], view.slots[1], view.slots[2], view.slots[3]);
  let visible = visibleItems[instanceIndex];
  let sceneInstance = instances[visible.x];
  let primitiveIndex = sceneInstance.primitiveIndex;
  let primitive = primitives[primitiveIndex];
  let material = materials[visible.y];
  var output: VertexOutput;
  let world = transforms[primitive.transformIndex].currentWorld * transforms[sceneInstance.transformIndex].currentWorld;
  output.position = viewProjection * world * vec4<f32>(input.position, 1.0);
  output.color = material.params0;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return input.color;
}
`;

interface PreparedBatch {
  readonly batch: GpuDrivenBatch;
  readonly mesh: MeshGpuHandles;
  readonly renderState: MaterialRenderState | undefined;
  /** Stable World attachment key used to join same-submit GPU counters. */
  readonly worldKey: number;
  /** Stable representative slot identity for this homogeneous batch. */
  readonly primitiveSlot: number;
  readonly slotGeneration: number;
}

interface ProjectedBatch extends PreparedBatch {
  readonly bindings: BindGroup;
  readonly pipeline: RenderPipeline;
  readonly vertex: GraphBuffer;
  readonly index?: GraphBuffer;
}

function bufferBinding(
  buffer: import('@forgeax/engine-rhi').Buffer,
  offset?: number,
  size?: number,
) {
  return {
    kind: 'buffer' as const,
    value: {
      buffer,
      ...(offset === undefined ? {} : { offset }),
      ...(size === undefined ? {} : { size }),
    },
  };
}

function activeFrustum(camera: CameraSnapshot): Float32Array {
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
  const view = mat4.invert(mat4.create(), camera.world);
  return frustum.fromViewProjection(
    frustum.create(),
    mat4.multiply(mat4.create(), projection, view),
  );
}

/**
 * LOD projected height is a view fact, not a scene-topology fact. Keep the
 * filtered plan cache scene-stable while still rebuilding its candidate
 * heights whenever a camera input used by the selector changes.
 */
function lodProjectionFingerprint(camera: CameraSnapshot): string {
  return JSON.stringify({
    position: Array.from(camera.position),
    world: Array.from(camera.world),
    projection: camera.projection,
    fov: camera.fov,
    aspect: camera.aspect,
    orthoHeight: camera.orthoTop - camera.orthoBottom,
  });
}

function productionEligible(snapshot: RenderableSnapshot, batch: GpuDrivenBatch): boolean {
  const material = snapshot.materials[batch.key.materialSlot] ?? snapshot.material;
  const shader = material.materialShaderId ?? 'forgeax::default-unlit';
  return (
    shader === 'forgeax::default-unlit' &&
    // The production rigid shader owns triangle-list raster only. Lines and
    // points stay with their CPU/specialized topology owners.
    batch.key.topology === 'triangle-list' &&
    batch.key.materialResourceClass === EMPTY_RESOURCE_CLASS &&
    material.baseColorTexture === undefined &&
    material.transparent !== true
  );
}

/**
 * Prepared Standard PBR draws have an explicit receipt identity on their
 * batch key. Unprepared batches stay on the rigid production shader; the
 * presence of a frame-wide PBR artifact is not permission to reinterpret an
 * unlit batch with the PBR bind-group layout.
 */
function isStandardPbrBatch(batch: GpuDrivenBatch): boolean {
  return batch.key.preparedIdentity !== undefined;
}

function meshSupportsBatch(mesh: MeshGpuHandles, batch: GpuDrivenBatch): boolean {
  if (
    batch.candidates.some((candidate) => {
      const lodCount = candidate.lodCoverages?.length ?? 0;
      return (
        lodCount > 1 &&
        (mesh.lodRanges === undefined ||
          mesh.lodRanges.length < lodCount ||
          mesh.lodRanges.some((ranges) => ranges[candidate.drawItemIndex] === undefined))
      );
    })
  ) {
    return false;
  }
  return batch.key.drawKind === 'indexed'
    ? mesh.indexed && mesh.indexBuffer !== null
    : !mesh.indexed;
}

function selectedLodLevel(candidate: GpuDrivenCandidate): number {
  const coverages = candidate.lodCoverages;
  if (coverages === undefined || coverages.length <= 1) return 0;
  return selectLod({
    levels: coverages.slice(1).map((screenCoverage) => ({ screenCoverage })),
    projectedHeight: candidate.projectedHeight ?? Number.NaN,
    previousLevel: 0,
    hysteresis: candidate.lodHysteresis ?? 0.08,
    ready: coverages.map(() => true),
    historyValid: false,
  }).level;
}

function selectedLodRange(
  batch: GpuDrivenBatch,
  candidate: GpuDrivenCandidate,
): { readonly first: number; readonly count: number; readonly baseVertex: number } {
  const level = selectedLodLevel(candidate);
  return (
    (level === 0 ? undefined : candidate.lodRanges?.[level - 1]) ?? {
      first: batch.key.first,
      count: batch.key.count,
      baseVertex: batch.key.baseVertex,
    }
  );
}

/**
 * One raster indirect command is emitted for each selector batch that has at
 * least one admitted candidate. Selector-only batches remain in the compute
 * and readback plan, but they must not inflate the raster command count.
 */
function admittedRasterBatchCount(plan: SubmissionPlan): number {
  return plan.batches.reduce((count, batch) => count + (batch.visibleCapacity > 0 ? 1 : 0), 0);
}

function filteredPlan(
  source: SubmissionPlan,
  slots: PersistentGpuDrivenState['slots'],
  meshes: ReadonlyMap<number, MeshGpuHandles>,
  camera: CameraSnapshot,
  activeEntityKeys?: ReadonlySet<number>,
  worldKeys?: readonly number[],
): {
  readonly plan: SubmissionPlan;
  readonly batches: readonly PreparedBatch[];
  readonly entityKeys: ReadonlySet<number>;
  /** No source primitive can enter this lane without a topology/material change. */
  readonly topologyInvariantEmpty: boolean;
} {
  const slotByPrimitive = new Map(slots.map((slot) => [slot.slot, slot] as const));
  const participatingByPrimitive = new Map<number, Set<GpuDrivenBatch>>();
  for (const batch of source.batches) {
    for (const candidate of batch.candidates) {
      const participating = participatingByPrimitive.get(candidate.primitiveIndex);
      if (participating === undefined) {
        participatingByPrimitive.set(candidate.primitiveIndex, new Set([batch]));
      } else {
        participating.add(batch);
      }
    }
  }
  const entityKeys = new Set<number>();
  const worldKeyFor = (slot: PersistentGpuDrivenState['slots'][number]): number =>
    worldKeys?.[slot.snapshot.worldId] ?? slot.snapshot.worldId;
  const activeKey = (slot: PersistentGpuDrivenState['slots'][number]): number =>
    worldEntityKey(worldKeyFor(slot), slot.snapshot.entityKey);
  const eligiblePrimitives = new Set<number>();
  let topologyEligiblePrimitiveCount = 0;
  for (const slot of slots) {
    const mesh = meshes.get(slot.snapshot.assetHandle);
    const participating = participatingByPrimitive.get(slot.slot);
    const participatingBatches = participating === undefined ? [] : [...participating];
    const topologyEligible =
      participatingBatches.length > 0 &&
      participatingBatches.length === (slot.snapshot.gpuDrivenDraws?.length ?? 0) &&
      participatingBatches.every((batch) => productionEligible(slot.snapshot, batch));
    if (topologyEligible) topologyEligiblePrimitiveCount += 1;
    if (
      mesh !== undefined &&
      topologyEligible &&
      participatingBatches.every((batch) => meshSupportsBatch(mesh, batch))
    ) {
      eligiblePrimitives.add(slot.slot);
      // Record validation still keys extracted renderables by their current
      // stable world/entity key. Suppressed candidates remain in the GPU
      // selector, but only admitted entities are owned by the compacted draw.
      if (activeEntityKeys === undefined || activeEntityKeys.has(activeKey(slot))) {
        entityKeys.add(activeKey(slot));
      }
    }
  }
  // BatchTopology deliberately keeps LOD candidates individually addressable
  // so topology updates never alias a candidate's selector state.  Once the
  // camera has projected the candidates, the renderer can safely coalesce
  // candidates that have identical immutable geometry/LOD facts and the same
  // selected range.  The GPU selector uses the same no-history inputs below,
  // so one indirect range remains correct for every candidate in a group.
  const groups = new Map<
    string,
    {
      readonly source: GpuDrivenBatch;
      readonly mesh: MeshGpuHandles;
      readonly renderState: MaterialRenderState | undefined;
      readonly candidates: GpuDrivenCandidate[];
    }
  >();
  for (const batch of source.batches) {
    const candidates = batch.candidates.filter((candidate) => {
      const slot = slotByPrimitive.get(candidate.primitiveIndex);
      if (slot === undefined || !eligiblePrimitives.has(slot.slot)) return false;
      const mesh = meshes.get(slot.snapshot.assetHandle);
      return mesh !== undefined && meshSupportsBatch(mesh, batch);
    });
    if (candidates.length === 0) continue;
    for (const candidate of candidates) {
      const slot = slotByPrimitive.get(candidate.primitiveIndex);
      if (slot === undefined) continue;
      const mesh = meshes.get(slot.snapshot.assetHandle);
      if (mesh === undefined) continue;
      const physicalLodRanges = mesh.lodRanges
        ?.slice(1)
        .map((ranges) => ranges[candidate.drawItemIndex]);
      const projected = Object.freeze({
        ...candidate,
        submitAdmission: activeEntityKeys === undefined || activeEntityKeys.has(activeKey(slot)),
        projectedHeight: projectedHeightForCandidate(slot, camera),
        ...(physicalLodRanges?.every((range) => range !== undefined)
          ? { lodRanges: physicalLodRanges as NonNullable<typeof candidate.lodRanges> }
          : {}),
      });
      const selectedRange = selectedLodRange(batch, projected);
      const groupKey = JSON.stringify({
        key: batch.key,
        worldKey: worldKeyFor(slot),
        lodCoverages: projected.lodCoverages ?? null,
        lodRanges: projected.lodRanges ?? null,
        selectedRange,
        selectedLevel: selectedLodLevel(projected),
      });
      const existing = groups.get(groupKey);
      if (existing === undefined) {
        const material = slot.snapshot.materials[batch.key.materialSlot] ?? slot.snapshot.material;
        groups.set(groupKey, {
          source: batch,
          mesh,
          renderState: geometryRenderStateForTopology(batch.key.topology, material.renderState),
          candidates: [projected],
        });
      } else {
        existing.candidates.push(projected);
      }
    }
  }

  const batches: PreparedBatch[] = [];
  let visibleBase = 0;
  const filteredBatches: GpuDrivenBatch[] = [];
  let batchId = 0;
  for (const group of groups.values()) {
    visibleBase = Math.ceil(visibleBase / 64) * 64;
    const admittedCount = group.candidates.reduce(
      (count, candidate) =>
        count +
        ((candidate as GpuDrivenCandidate & { readonly submitAdmission?: boolean })
          .submitAdmission === false
          ? 0
          : 1),
      0,
    );
    const filtered: GpuDrivenBatch = Object.freeze({
      ...group.source,
      batchId,
      candidates: Object.freeze(group.candidates),
      visibleBase,
      visibleCapacity: admittedCount,
      indirectOffset: batchId * 20,
    });
    visibleBase += admittedCount;
    filteredBatches.push(filtered);
    const firstCandidate = group.candidates[0];
    const firstSlot =
      firstCandidate === undefined ? undefined : slotByPrimitive.get(firstCandidate.primitiveIndex);
    if (firstCandidate === undefined || firstSlot === undefined) continue;
    batches.push({
      batch: filtered,
      mesh: group.mesh,
      renderState: group.renderState,
      worldKey: worldKeyFor(firstSlot),
      primitiveSlot: firstSlot.slot,
      slotGeneration: firstSlot.generation,
    });
    batchId += 1;
  }
  return {
    plan: Object.freeze({
      revision: source.revision,
      batches: Object.freeze(filteredBatches),
      candidateCount: filteredBatches.reduce((total, batch) => total + batch.candidates.length, 0),
      visibleCapacity: visibleBase,
    }),
    batches: Object.freeze(batches),
    entityKeys,
    topologyInvariantEmpty: topologyEligiblePrimitiveCount === 0,
  };
}

type FilteredProductionPlan = ReturnType<typeof filteredPlan>;

export interface GpuDrivenWorldLodSelectionInspection {
  readonly worldKey: number;
  readonly primitiveSlot: number;
  readonly slotGeneration: number;
  readonly candidateCount: number;
  readonly visible: number;
  readonly occluded: number;
  readonly lodHistogram: readonly { readonly level: number; readonly count: number }[];
}

function sameEntityKeySet(
  left: ReadonlySet<number> | undefined,
  right: ReadonlySet<number> | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

class GpuDrivenRigidRaster {
  private readonly pipelines = new Map<string, RenderPipeline>();

  private constructor(
    private readonly device: RhiDevice,
    private readonly layout: BindGroupLayout,
    private readonly pipelineLayout: import('@forgeax/engine-rhi').PipelineLayout,
    private readonly module: ShaderModule,
  ) {}

  static create(input: {
    readonly device: RhiDevice;
    readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory;
    readonly viewBindGroupLayout: BindGroupLayout;
  }): Result<GpuDrivenRigidRaster, RhiError> {
    const layout = input.device.createBindGroupLayout({
      label: 'gpu-driven-rigid-raster-bgl',
      entries: [
        { binding: 0, visibility: VERTEX_STAGE, buffer: { type: 'read-only-storage' } },
        {
          binding: 1,
          visibility: VERTEX_STAGE,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 2,
          visibility: VERTEX_STAGE | FRAGMENT_STAGE,
          buffer: { type: 'read-only-storage' },
        },
        { binding: 3, visibility: VERTEX_STAGE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: VERTEX_STAGE, buffer: { type: 'read-only-storage' } },
      ],
    });
    if (!layout.ok) return layout;
    const pipelineLayout = input.device.createPipelineLayout({
      label: 'gpu-driven-rigid-raster-pl',
      bindGroupLayouts: [input.viewBindGroupLayout, layout.value],
    });
    if (!pipelineLayout.ok) return pipelineLayout;
    const module = input.shaderModuleFactory.createShaderModule({
      label: 'gpu-driven-rigid-unlit',
      code: GPU_DRIVEN_RIGID_UNLIT_WGSL,
    });
    if (!module.ok) return module;
    return ok(
      new GpuDrivenRigidRaster(input.device, layout.value, pipelineLayout.value, module.value),
    );
  }

  pipeline(
    format: TextureFormat,
    sampleCount: 1 | 4,
    vertexStride: number,
    topology: GpuDrivenBatch['key']['topology'],
    stripIndexFormat: 'uint16' | 'uint32' | undefined,
    renderState: MaterialRenderState | undefined,
  ): Result<RenderPipeline, RhiError> {
    const key = `${format}|${sampleCount}|${vertexStride}|${topology}|${stripIndexFormat ?? ''}|${JSON.stringify(renderState ?? null)}`;
    const cached = this.pipelines.get(key);
    if (cached !== undefined) return ok(cached);
    const created = this.device.createRenderPipeline({
      label: `gpu-driven-rigid-unlit.${key}`,
      layout: this.pipelineLayout,
      vertex: {
        module: this.module,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: vertexStride,
            stepMode: 'vertex',
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
          },
        ],
      },
      fragment: {
        module: this.module,
        entryPoint: 'fs_main',
        targets: [
          {
            format,
            ...(renderState?.blend === undefined ? {} : { blend: renderState.blend }),
          },
        ],
      },
      primitive: {
        topology,
        cullMode: renderState?.cullMode ?? 'back',
        frontFace: renderState?.frontFace ?? 'ccw',
        ...(stripIndexFormat === undefined ? {} : { stripIndexFormat }),
      },
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthWriteEnabled: renderState?.depthWriteEnabled ?? true,
        depthCompare: renderState?.depthCompare ?? 'less',
        ...(renderState?.stencil === undefined
          ? {}
          : {
              stencilFront: renderState.stencil,
              stencilBack: renderState.stencil,
              stencilReadMask: renderState.stencilReadMask,
              stencilWriteMask: renderState.stencilWriteMask,
            }),
      },
      ...(sampleCount === 4
        ? {
            multisample: {
              count: 4,
              alphaToCoverageEnabled: renderState?.alphaToCoverageEnabled ?? false,
            },
          }
        : {}),
    });
    if (!created.ok) return created;
    this.pipelines.set(key, created.value);
    return created;
  }

  bindGroup(
    scene: PersistentGpuDrivenState['scene'],
    view: GpuDrivenView,
    batch: GpuDrivenBatch,
  ): Result<BindGroup, RhiError> {
    const visible = view.visibleBuffer;
    if (visible === undefined) {
      return err(
        new RhiError({
          code: 'internal-error',
          expected: 'GPU-driven view buffers exist after a successful view update',
          hint: 'prepare the GPU-driven view before projecting its raster batches',
        }),
      );
    }
    return this.device.createBindGroup({
      label: `gpu-driven-rigid-batch-${batch.batchId}`,
      layout: this.layout,
      entries: [
        { binding: 0, resource: bufferBinding(scene.primitiveBuffer) },
        { binding: 1, resource: bufferBinding(scene.instanceBuffer) },
        { binding: 2, resource: bufferBinding(scene.materialBuffer) },
        {
          binding: 3,
          resource: bufferBinding(visible, batch.visibleBase * 8, batch.visibleCapacity * 8),
        },
        {
          binding: 4,
          resource: bufferBinding(scene.transformBuffer),
        },
      ],
    });
  }
}

/** The GPU-driven bridge to the existing four-group Standard PBR pipeline. */
class StandardPbrRasterAdapter {
  private readonly pipelines = new Map<string, RenderPipeline>();
  private readonly projectionBuffers: Buffer[] = [];

  private constructor(
    private readonly device: RhiDevice,
    private readonly pipelineLayout: import('@forgeax/engine-rhi').PipelineLayout,
    private readonly meshLayout: BindGroupLayout,
    private readonly module: ShaderModule,
    private readonly materialBindGroup: BindGroup,
    private readonly instancesBindGroup: BindGroup,
    private readonly artifact: MaterialShaderArtifact,
  ) {}

  static create(input: {
    readonly device: RhiDevice;
    readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory;
    readonly pipelineState: PipelineState;
    readonly artifact: MaterialShaderArtifact;
  }): Result<StandardPbrRasterAdapter, RhiError> {
    const pipelineLayout = input.pipelineState.pbrPipelineLayout;
    const fallback = input.pipelineState.skylightFallback;
    if (pipelineLayout === null || fallback === null) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'Standard PBR pipeline layout and Skylight fallback',
          hint: 'initialize the Standard PBR pipeline before enabling GPU-driven raster',
        }),
      );
    }
    const module = input.shaderModuleFactory.createShaderModule({
      label: 'standard-pbr-gpu-driven-scene-index',
      code: input.artifact.wgsl,
    });
    if (!module.ok) return module;
    const materialBuffer = input.device.createBuffer({
      label: 'standard-pbr-gpu-driven-material-row',
      size: 384,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!materialBuffer.ok) return materialBuffer;
    const materialPayload = new Float32Array(96);
    materialPayload[0] = 1;
    materialPayload[1] = 1;
    materialPayload[2] = 1;
    materialPayload[3] = 1;
    materialPayload[5] = 1;
    materialPayload[6] = 1;
    const materialWrite = input.device.queue.writeBuffer(materialBuffer.value, 0, materialPayload);
    if (!materialWrite.ok) return materialWrite;
    const baseEntries = [
      { binding: 0, resource: bufferBinding(materialBuffer.value, 0, 384) },
      ...Array.from({ length: 8 }, (_, index) => [
        {
          binding: index * 2 + 1,
          resource: { kind: 'sampler' as const, value: fallback.sampler },
        },
        {
          binding: index * 2 + 2,
          resource: {
            kind: 'textureView' as const,
            value:
              index === 2
                ? input.pipelineState.defaultNormalTextureView
                : input.pipelineState.defaultWhiteTextureView,
          },
        },
      ]).flat(),
    ];
    const materialEntries = assembleMaterialWithSkylightEntries(
      baseEntries,
      {
        irradianceView: fallback.irradianceView,
        irradianceSampler: fallback.sampler,
        prefilterView: fallback.prefilterView,
        prefilterSampler: fallback.sampler,
        brdfLutView: fallback.brdfLutView,
        brdfLutSampler: fallback.sampler,
        intensityBuffer: fallback.intensityBuffer,
      },
      { sampler: fallback.sampler, backdropView: input.pipelineState.defaultWhiteTextureView },
    );
    const materialBindGroup = input.device.createBindGroup({
      label: 'standard-pbr-gpu-driven-material-bg',
      layout: input.pipelineState.materialBindGroupLayout,
      entries: materialEntries,
    });
    if (!materialBindGroup.ok) return materialBindGroup;
    const instancesBindGroup = input.device.createBindGroup({
      label: 'standard-pbr-gpu-driven-identity-instances-bg',
      layout: input.pipelineState.instancesBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: bufferBinding(input.pipelineState.identityInstanceBuffer),
        },
      ],
    });
    if (!instancesBindGroup.ok) return instancesBindGroup;
    return ok(
      new StandardPbrRasterAdapter(
        input.device,
        pipelineLayout,
        input.pipelineState.meshBindGroupLayout,
        module.value,
        materialBindGroup.value,
        instancesBindGroup.value,
        input.artifact,
      ),
    );
  }

  pipeline(
    format: TextureFormat,
    sampleCount: 1 | 4,
    layoutProjection: MeshGpuHandles['layoutProjection'],
    topology: GpuDrivenBatch['key']['topology'],
    stripIndexFormat: 'uint16' | 'uint32' | undefined,
    renderState: MaterialRenderState | undefined,
  ): Result<RenderPipeline, RhiError> {
    const projectedLayout = deriveVertexBufferLayoutFromProjection(
      layoutProjection,
      this.artifact.uvSetCount === undefined
        ? undefined
        : { shaderUvSetCount: this.artifact.uvSetCount },
    )[0];
    const vertexStride = projectedLayout?.arrayStride ?? layoutProjection.arrayStride;
    const attributes = projectedLayout?.attributes ?? layoutProjection.attributes;
    const key = `${format}|${sampleCount}|${vertexStride}|${topology}|${stripIndexFormat ?? ''}|${JSON.stringify(renderState ?? null)}|${this.artifact.layoutIdentity}`;
    const cached = this.pipelines.get(key);
    if (cached !== undefined) return ok(cached);
    const pipeline = this.device.createRenderPipeline({
      label: `standard-pbr-gpu-driven.${key}`,
      layout: this.pipelineLayout,
      vertex: {
        module: this.module,
        entryPoint: this.artifact.receipt?.sceneIndexEntry ?? 'vs_scene_index',
        buffers: [
          {
            arrayStride: vertexStride,
            stepMode: 'vertex',
            attributes: attributes.map(({ shaderLocation, offset, format }) => ({
              shaderLocation,
              offset,
              format: format as GPUVertexFormat,
            })),
          },
        ],
      },
      fragment: {
        module: this.module,
        entryPoint: 'fs_main',
        targets: [{ format }],
      },
      primitive: {
        topology,
        cullMode: renderState?.cullMode ?? 'back',
        frontFace: renderState?.frontFace ?? 'ccw',
        ...(stripIndexFormat === undefined ? {} : { stripIndexFormat }),
      },
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthWriteEnabled: renderState?.depthWriteEnabled ?? true,
        depthCompare: renderState?.depthCompare ?? 'less',
      },
      ...(sampleCount === 4 ? { multisample: { count: 4 } } : {}),
    });
    if (!pipeline.ok) return pipeline;
    this.pipelines.set(key, pipeline.value);
    return pipeline;
  }

  projectionBindGroup(rows: Float32Array): Result<BindGroup, RhiError> {
    const buffer = this.device.createBuffer({
      label: 'standard-pbr-gpu-driven-scene-meshes',
      size: Math.max(MESH_SSBO_BYTES, rows.byteLength),
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!buffer.ok) return buffer;
    const write = this.device.queue.writeBuffer(buffer.value, 0, rows);
    if (!write.ok) return write;
    this.projectionBuffers.push(buffer.value);
    return this.device.createBindGroup({
      label: 'standard-pbr-gpu-driven-scene-mesh-bg',
      layout: this.meshLayout,
      entries: [{ binding: 0, resource: bufferBinding(buffer.value, 0, rows.byteLength) }],
    });
  }

  dispose(): void {
    for (const buffer of this.projectionBuffers) this.device.destroyBuffer(buffer);
    this.projectionBuffers.length = 0;
  }

  get frameGroups(): readonly [BindGroup, BindGroup] {
    return [this.materialBindGroup, this.instancesBindGroup];
  }
}

export interface PreparedGpuDrivenFrame {
  readonly topologySignature: string;
  readonly entityKeys: ReadonlySet<number>;
  readonly ownsAllRenderables: boolean;
  readonly occlusion?: OcclusionFrameProjection;
  /** @internal Commits a replacement generation only after graph promotion. */
  readonly _commitResourceReplacement: () => void;
  project(
    graph: RenderGraphBuilder<RenderPipelineFrame>,
    format: TextureFormat,
    sampleCount: 1 | 4,
  ): Result<RenderPipelineGpuDrivenProjection, RenderGraphError | RhiError>;
}

export interface RecoveryCapabilityFacts {
  readonly generation: number;
  readonly shaderCompilation: boolean;
  readonly compute: boolean;
  readonly storageBuffer: boolean;
  readonly indirectDrawing: boolean;
  readonly multisample: boolean;
}

export type RecoveryCapabilityOutcome =
  | {
      readonly status: 'ready' | 'fallback';
      readonly generation: number;
      readonly disabled: readonly string[];
    }
  | {
      readonly status: 'disabled';
      readonly generation: number;
      readonly disabled: readonly string[];
      readonly allocations: 0;
    }
  | {
      readonly status: 'refused';
      readonly generation: number;
      readonly failedOwner: 'shader-material-pipeline';
      readonly resourceKind: 'pipeline';
    };

export function classifyRecoveryCapability(
  facts: RecoveryCapabilityFacts,
): RecoveryCapabilityOutcome {
  if (!facts.shaderCompilation) {
    return {
      status: 'refused',
      generation: facts.generation,
      failedOwner: 'shader-material-pipeline',
      resourceKind: 'pipeline',
    };
  }
  if (!facts.compute || !facts.storageBuffer || !facts.indirectDrawing) {
    return {
      status: 'disabled',
      generation: facts.generation,
      disabled: ['gpu-driven'],
      allocations: 0,
    };
  }
  return {
    status: facts.multisample ? 'ready' : 'fallback',
    generation: facts.generation,
    disabled: [],
  };
}

export class GpuDrivenProduction {
  private disposed = false;
  private view: GpuDrivenView | undefined;
  private raster: GpuDrivenRigidRaster | undefined;
  private standardRaster: StandardPbrRasterAdapter | undefined;
  private readonly sceneIdentities = new WeakMap<object, number>();
  private nextSceneIdentity = 1;
  private filteredCache:
    | {
        readonly source: SubmissionPlan;
        readonly meshResidencyEpoch: number;
        readonly lodProjectionFingerprint: string;
        readonly activeEntityRevision?: number;
        readonly activeEntityKeys?: ReadonlySet<number>;
        readonly value: FilteredProductionPlan;
      }
    | undefined;
  private gpuOwnedSnapshotsMaterialized = 0;
  private filteredPlanBuilds = 0;
  private gpuOwnedEntityCount = 0;
  private batchBindGroupCreates = 0;
  private validatedGpuOwnedRows = 0;
  private cpuFallbackDrawItems = 0;
  private telemetryPrepared = false;
  private telemetryCandidateCount = 0;
  private telemetryGeometryWork = 0;
  private telemetryRootGeometryWork = 0;
  private indirectDrawCount = 0;
  private sceneRowsRequired = true;
  private standardPbrProjection: StandardPbrSceneProjection | undefined;
  private signatureCache:
    | {
        readonly filtered: FilteredProductionPlan;
        readonly sceneIdentity: number;
        readonly viewResourceGeneration: number;
        readonly meshResidencyEpoch: number;
        readonly value: string;
      }
    | undefined;

  constructor(
    private readonly device: RhiDevice,
    private readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory,
  ) {}

  static forDevice(
    device: RhiDevice,
    shaderModuleFactory: PipelineBuilderShaderModuleFactory,
  ): GpuDrivenProduction {
    return new GpuDrivenProduction(device, shaderModuleFactory);
  }

  /** Recovery has no frame retry: await generated programs before preparing the graph. */
  static async forRecoveryDevice(
    device: RhiDevice,
    factory: PipelineBuilderShaderModuleFactory,
    createShaderModule: (descriptor: {
      code: string;
      label?: string;
    }) => Promise<Result<ShaderModule, RhiError>>,
  ): Promise<Result<GpuDrivenProduction, RhiError>> {
    const modules = new Map<string, ShaderModule>();
    for (const descriptor of [
      { label: 'gpu-driven-view', code: GPU_DRIVEN_VIEW_WGSL },
      { label: 'gpu-driven-rigid-unlit', code: GPU_DRIVEN_RIGID_UNLIT_WGSL },
    ]) {
      const module = await createShaderModule(descriptor);
      if (!module.ok) return module;
      modules.set(descriptor.code, module.value);
    }
    return ok(
      new GpuDrivenProduction(device, {
        createShaderModule: (descriptor) => {
          const module = modules.get(descriptor.code);
          return module === undefined ? factory.createShaderModule(descriptor) : ok(module);
        },
      }),
    );
  }

  createRecoveryRoot(scope: DeviceScope): LifecycleResourceSpec<unknown> {
    return {
      kind: 'scene-table',
      create: () => {
        if (!scope.isAlive()) throw new Error('GPU-driven candidate scope is not active.');
        // Keep the actual detached production owner in the generation
        // aggregate. The recovery transaction, not a marker object, is the
        // owner that is published or discarded exactly once.
        return this;
      },
      cleanup: () => undefined,
    };
  }

  prepare(input: {
    readonly scene: PersistentGpuDrivenState | undefined;
    readonly camera: CameraSnapshot;
    readonly meshes: ReadonlyMap<number, MeshGpuHandles>;
    readonly viewBindGroupLayout: BindGroupLayout;
    readonly meshResidencyEpoch: number;
    readonly hdrp: boolean;
    /** Entity keys admitted by the persistent visibility facet for this view. */
    readonly activeEntityKeys?: ReadonlySet<number>;
    /** Collision-free renderer-owned revision for the active visibility set. */
    readonly activeEntityRevision?: number;
    /** Total extracted candidates, including facet-suppressed rows. */
    readonly telemetryCandidateCount?: number;
    readonly occlusion?: OcclusionFrameProjection;
    /** Cooked producer artifact selected from the frame material catalog. */
    readonly standardPbrArtifact?: MaterialShaderArtifact;
    readonly standardPbrPipelineState?: PipelineState;
  }): Result<PreparedGpuDrivenFrame | undefined, RhiError> {
    this.gpuOwnedSnapshotsMaterialized = 0;
    this.filteredPlanBuilds = 0;
    this.batchBindGroupCreates = 0;
    this.validatedGpuOwnedRows = 0;
    this.cpuFallbackDrawItems = 0;
    this.telemetryPrepared = false;
    this.telemetryCandidateCount = input.telemetryCandidateCount ?? 0;
    this.telemetryGeometryWork = 0;
    this.telemetryRootGeometryWork = 0;
    this.indirectDrawCount = 0;
    const capability = classifyRecoveryCapability({
      generation: 0,
      shaderCompilation: true,
      compute: this.device.caps.compute,
      storageBuffer: this.device.caps.storageBuffer,
      indirectDrawing: this.device.caps.indirectDrawing,
      multisample: true,
    });
    if (
      input.hdrp ||
      input.scene === undefined ||
      capability.status === 'disabled' ||
      selectGpuLodLane(this.device.caps) === 'cpu'
    ) {
      this.gpuOwnedEntityCount = 0;
      this.sceneRowsRequired = false;
      return ok(undefined);
    }
    const scene = input.scene;
    const projectionFingerprint = lodProjectionFingerprint(input.camera);
    // An empty filtered plan means this topology/mesh-residency pair has no
    // renderables that this production lane can own. Camera and visibility
    // inputs only affect admitted candidates and LOD selection, so they cannot
    // turn that empty topology into an eligible one. Keep the negative result
    // resident instead of rescanning every scene slot as the camera moves.
    const cachedPlanIsTopologyInvariant = this.filteredCache?.value.topologyInvariantEmpty === true;
    const cachedPlanIsCameraInvariant = cachedPlanIsTopologyInvariant;
    const cachedVisibilityMatches =
      cachedPlanIsCameraInvariant || this.filteredCache === undefined
        ? true
        : input.activeEntityRevision !== undefined &&
            this.filteredCache.activeEntityRevision !== undefined
          ? input.activeEntityRevision === this.filteredCache.activeEntityRevision
          : sameEntityKeySet(this.filteredCache.activeEntityKeys, input.activeEntityKeys);
    let filtered = this.filteredCache?.value;
    if (
      filtered === undefined ||
      this.filteredCache?.source !== scene.plan ||
      (!cachedPlanIsTopologyInvariant &&
        this.filteredCache.meshResidencyEpoch !== input.meshResidencyEpoch) ||
      (!cachedPlanIsCameraInvariant &&
        this.filteredCache.lodProjectionFingerprint !== projectionFingerprint) ||
      !cachedVisibilityMatches
    ) {
      filtered = filteredPlan(
        scene.plan,
        scene.slots,
        input.meshes,
        input.camera,
        input.activeEntityKeys,
        scene.worldKeys,
      );
      this.filteredCache = {
        source: scene.plan,
        meshResidencyEpoch: input.meshResidencyEpoch,
        lodProjectionFingerprint: projectionFingerprint,
        ...(input.activeEntityRevision === undefined
          ? {}
          : { activeEntityRevision: input.activeEntityRevision }),
        ...(input.activeEntityKeys === undefined
          ? {}
          : { activeEntityKeys: input.activeEntityKeys }),
        value: filtered,
      };
      this.gpuOwnedSnapshotsMaterialized = scene.slots.length;
      this.filteredPlanBuilds = 1;
    }
    this.gpuOwnedEntityCount = filtered.entityKeys.size;
    this.sceneRowsRequired = !filtered.topologyInvariantEmpty;
    // Publish the command count from the current filtered plan on every
    // prepare call. A cached graph does not call project() again on stable
    // frames, so deriving this only while compiling the raster pass would
    // transiently report zero after prepare() reset the per-frame counters.
    this.indirectDrawCount = admittedRasterBatchCount(filtered.plan);
    if (filtered.batches.length === 0) return ok(undefined);
    this.standardPbrProjection = undefined;
    const usesStandardPbrRaster = filtered.batches.every(({ batch }) => isStandardPbrBatch(batch));
    if (usesStandardPbrRaster && input.standardPbrArtifact !== undefined) {
      const slotsByPrimitive = new Map(scene.slots.map((slot) => [slot.slot, slot] as const));
      const projection = projectStandardPbrScene({
        artifact: input.standardPbrArtifact,
        candidates: filtered.batches.flatMap(({ batch }) =>
          batch.candidates.flatMap((candidate) => {
            const slot = slotsByPrimitive.get(candidate.primitiveIndex);
            return slot === undefined
              ? []
              : [
                  {
                    primitiveIndex: candidate.primitiveIndex,
                    world: slot.snapshot.transform.world,
                  },
                ];
          }),
        ),
      });
      if (!projection.ok) {
        return err(
          new RhiError({
            code: 'shader-compile-failed',
            expected: 'receipt-derived Standard PBR scene projection',
            hint: 'publish one validated MaterialShaderArtifact receipt before entering the GPU lane',
          }),
        );
      }
      this.standardPbrProjection = projection.value;
      if (input.standardPbrPipelineState !== undefined && this.standardRaster === undefined) {
        const created = StandardPbrRasterAdapter.create({
          device: this.device,
          shaderModuleFactory: this.shaderModuleFactory,
          pipelineState: input.standardPbrPipelineState,
          artifact: input.standardPbrArtifact,
        });
        if (!created.ok) return created;
        this.standardRaster = created.value;
      }
    }
    if (this.view === undefined) {
      const created = GpuDrivenView.create({
        device: this.device,
        shaderModuleFactory: this.shaderModuleFactory,
      });
      if (!created.ok) return created;
      this.view = created.value;
    }
    if (this.raster === undefined) {
      const created = GpuDrivenRigidRaster.create({
        device: this.device,
        shaderModuleFactory: this.shaderModuleFactory,
        viewBindGroupLayout: input.viewBindGroupLayout,
      });
      if (!created.ok) return created;
      this.raster = created.value;
    }
    const updated = this.view.update(filtered.plan, scene.scene, activeFrustum(input.camera));
    if (!updated.ok) return updated;
    this.telemetryPrepared = true;
    const view = this.view;
    const raster = this.raster;
    const standardRaster = this.standardRaster;
    const standardArtifact = input.standardPbrArtifact;
    const sceneIdentity = this.sceneIdentity(scene.scene);
    const viewInspection = view.inspect();
    let signature = this.signatureCache?.value;
    if (
      signature === undefined ||
      this.signatureCache?.filtered !== filtered ||
      this.signatureCache.sceneIdentity !== sceneIdentity ||
      this.signatureCache.viewResourceGeneration !== viewInspection.resourceGeneration ||
      this.signatureCache.meshResidencyEpoch !== input.meshResidencyEpoch
    ) {
      signature = JSON.stringify({
        sceneIdentity,
        revision: filtered.plan.revision,
        meshResidencyEpoch: input.meshResidencyEpoch,
        standardPbrLayoutIdentity: this.standardPbrProjection?.layoutIdentity,
        viewResourceGeneration: viewInspection.resourceGeneration,
        batches: filtered.batches.map(({ batch, mesh }) => [
          batch.batchId,
          batch.generation,
          batch.visibleCapacity,
          batch.visibleBase,
          batch.candidates.map((candidate) => [
            candidate.primitiveIndex,
            candidate.generation,
            candidate.instanceOrdinal,
          ]),
          mesh.vboBytes,
          mesh.iboBytes,
          mesh.indexFormat,
          mesh.uvSetCount,
        ]),
        capacities: [
          viewInspection.candidateCapacity,
          viewInspection.visibleBufferCapacity,
          viewInspection.batchCapacity,
          viewInspection.indirectCapacity,
        ],
      });
      this.signatureCache = {
        filtered,
        sceneIdentity,
        viewResourceGeneration: viewInspection.resourceGeneration,
        meshResidencyEpoch: input.meshResidencyEpoch,
        value: signature,
      };
    }
    return ok({
      topologySignature: signature,
      entityKeys: filtered.entityKeys,
      ownsAllRenderables:
        input.activeEntityKeys === undefined
          ? filtered.entityKeys.size === scene.slots.length
          : filtered.entityKeys.size === input.activeEntityKeys.size,
      ...(input.occlusion === undefined ? {} : { occlusion: input.occlusion }),
      _commitResourceReplacement: () => view._commitResourceReplacement(),
      project: (graph, format, sampleCount) => {
        this.indirectDrawCount = admittedRasterBatchCount(filtered.plan);
        const outputs = view.addPasses(graph);
        if (!outputs.ok) return outputs;
        if (
          usesStandardPbrRaster &&
          standardRaster !== undefined &&
          standardArtifact !== undefined
        ) {
          const standardProjected: Array<{
            readonly batch: GpuDrivenBatch;
            readonly mesh: MeshGpuHandles;
            readonly vertex: GraphBuffer;
            readonly index?: GraphBuffer;
            readonly pipeline: RenderPipeline;
            readonly meshBindGroup: BindGroup;
          }> = [];
          const standardAccesses: GraphAccess[] = [
            { resource: outputs.value.primitive, usage: 'storage-read' },
            { resource: outputs.value.instance, usage: 'storage-read' },
            { resource: outputs.value.material, usage: 'storage-read' },
            { resource: outputs.value.visible, usage: 'storage-read' },
            { resource: outputs.value.transform, usage: 'storage-read' },
            { resource: outputs.value.indirect, usage: 'indirect-read' },
          ];
          const slotsByPrimitive = new Map(scene.slots.map((slot) => [slot.slot, slot] as const));
          const meshBuffers = new Map<
            number,
            { readonly vertex: GraphBuffer; readonly index?: GraphBuffer }
          >();
          for (const prepared of filtered.batches) {
            const candidates = prepared.batch.candidates.flatMap((candidate) => {
              const slot = slotsByPrimitive.get(candidate.primitiveIndex);
              return slot === undefined
                ? []
                : [
                    {
                      primitiveIndex: candidate.primitiveIndex,
                      world: slot.snapshot.transform.world,
                    },
                  ];
            });
            const projection = projectStandardPbrScene({
              artifact: standardArtifact,
              candidates,
            });
            if (!projection.ok) {
              return err(
                new RhiError({
                  code: 'shader-compile-failed',
                  expected: 'receipt-derived Standard PBR scene projection',
                  hint: 'keep the frame artifact receipt and projected rows on one identity',
                }),
              );
            }
            const meshBindGroup = standardRaster.projectionBindGroup(projection.value.rows);
            if (!meshBindGroup.ok) return meshBindGroup;
            let buffers = meshBuffers.get(prepared.batch.key.assetHandle);
            if (buffers === undefined) {
              const vertex = graph.importBuffer(
                `gpu-driven.standard.${prepared.batch.key.assetHandle}.vertex`,
                {
                  size: prepared.mesh.vboBytes,
                  usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
                },
                () => prepared.mesh.vertexBuffer.handle,
              );
              if (!vertex.ok) return vertex;
              let index: GraphBuffer | undefined;
              if (prepared.mesh.indexBuffer !== null) {
                const indexHandle = prepared.mesh.indexBuffer;
                const imported = graph.importBuffer(
                  `gpu-driven.standard.${prepared.batch.key.assetHandle}.index`,
                  {
                    size: prepared.mesh.iboBytes,
                    usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
                  },
                  () => indexHandle.handle,
                );
                if (!imported.ok) return imported;
                index = imported.value;
              }
              buffers = { vertex: vertex.value, ...(index === undefined ? {} : { index }) };
              meshBuffers.set(prepared.batch.key.assetHandle, buffers);
              standardAccesses.push({ resource: buffers.vertex, usage: 'vertex-read' });
              if (buffers.index !== undefined) {
                standardAccesses.push({ resource: buffers.index, usage: 'index-read' });
              }
            }
            const pipeline = standardRaster.pipeline(
              format,
              sampleCount,
              prepared.mesh.layoutProjection,
              prepared.batch.key.topology,
              prepared.batch.key.drawKind === 'indexed' &&
                (prepared.batch.key.topology === 'line-strip' ||
                  prepared.batch.key.topology === 'triangle-strip')
                ? prepared.mesh.indexFormat
                : undefined,
              prepared.renderState,
            );
            if (!pipeline.ok) return pipeline;
            standardProjected.push({
              batch: prepared.batch,
              mesh: prepared.mesh,
              ...buffers,
              pipeline: pipeline.value,
              meshBindGroup: meshBindGroup.value,
            });
          }
          const [materialBindGroup, instancesBindGroup] = standardRaster.frameGroups;
          return ok({
            accesses: standardAccesses,
            encode: (viewBindGroup, pass, resources: GraphResourceResolver) => {
              // pbr-view-bgl has two dynamic uniform bindings: the frame view
              // slot and the optional Points/Lines style slot.  Standard
              // draws do not use the latter, but WebGPU still requires one
              // offset per dynamic binding.
              pass.setBindGroup(0, viewBindGroup, [0, 0]);
              pass.setBindGroup(1, materialBindGroup, [0]);
              pass.setBindGroup(3, instancesBindGroup);
              let currentPipeline: RenderPipeline | undefined;
              let currentVertex: GraphBuffer | undefined;
              let currentIndex: GraphBuffer | undefined;
              for (const batch of standardProjected) {
                if (currentPipeline !== batch.pipeline) {
                  pass.setPipeline(batch.pipeline);
                  currentPipeline = batch.pipeline;
                }
                pass.setBindGroup(2, batch.meshBindGroup, [0]);
                if (currentVertex !== batch.vertex) {
                  const vertex = resources.buffer(batch.vertex);
                  if (!vertex.ok) throw vertex.error;
                  pass.setVertexBuffer(0, vertex.value);
                  currentVertex = batch.vertex;
                }
                if (batch.index !== undefined && currentIndex !== batch.index) {
                  const index = resources.buffer(batch.index);
                  if (!index.ok) throw index.error;
                  pass.setIndexBuffer(index.value, batch.mesh.indexFormat);
                  currentIndex = batch.index;
                }
                const indirect = resources.buffer(outputs.value.indirect);
                if (!indirect.ok) throw indirect.error;
                if (batch.batch.key.drawKind === 'indexed') {
                  pass.drawIndexedIndirect(indirect.value, batch.batch.indirectOffset);
                } else {
                  pass.drawIndirect(indirect.value, batch.batch.indirectOffset);
                }
              }
            },
          });
        }
        const projected: ProjectedBatch[] = [];
        const accesses: GraphAccess[] = [
          { resource: outputs.value.primitive, usage: 'storage-read' },
          { resource: outputs.value.instance, usage: 'storage-read' },
          { resource: outputs.value.material, usage: 'storage-read' },
          { resource: outputs.value.visible, usage: 'storage-read' },
          { resource: outputs.value.transform, usage: 'storage-read' },
          { resource: outputs.value.indirect, usage: 'indirect-read' },
        ];
        const meshBuffers = new Map<
          number,
          { readonly vertex: GraphBuffer; readonly index?: GraphBuffer }
        >();
        for (const prepared of filtered.batches) {
          // A selector-only batch can have zero admitted candidates. Keep it
          // in the GPU selector and readback counters, but do not create a
          // raster bind group or encode a zero-instance indirect draw.
          if (prepared.batch.visibleCapacity === 0) continue;
          let buffers = meshBuffers.get(prepared.batch.key.assetHandle);
          if (buffers === undefined) {
            const vertex = graph.importBuffer(
              `gpu-driven.mesh.${prepared.batch.key.assetHandle}.vertex`,
              {
                size: prepared.mesh.vboBytes,
                usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
              },
              () => prepared.mesh.vertexBuffer.handle,
            );
            if (!vertex.ok) return vertex;
            let index: GraphBuffer | undefined;
            const indexHandle = prepared.mesh.indexBuffer;
            if (indexHandle !== null) {
              const imported = graph.importBuffer(
                `gpu-driven.mesh.${prepared.batch.key.assetHandle}.index`,
                {
                  size: prepared.mesh.iboBytes,
                  usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
                },
                () => indexHandle.handle,
              );
              if (!imported.ok) return imported;
              index = imported.value;
            }
            buffers = { vertex: vertex.value, ...(index === undefined ? {} : { index }) };
            meshBuffers.set(prepared.batch.key.assetHandle, buffers);
            accesses.push({ resource: buffers.vertex, usage: 'vertex-read' });
            if (buffers.index !== undefined) {
              accesses.push({ resource: buffers.index, usage: 'index-read' });
            }
          }
          const pipeline = raster.pipeline(
            format,
            sampleCount,
            prepared.mesh.layoutProjection.arrayStride,
            prepared.batch.key.topology,
            prepared.batch.key.drawKind === 'indexed' &&
              (prepared.batch.key.topology === 'line-strip' ||
                prepared.batch.key.topology === 'triangle-strip')
              ? prepared.mesh.indexFormat
              : undefined,
            prepared.renderState,
          );
          if (!pipeline.ok) return pipeline;
          const bindings = raster.bindGroup(scene.scene, view, prepared.batch);
          if (!bindings.ok) return bindings;
          this.batchBindGroupCreates += 1;
          projected.push({
            ...prepared,
            ...buffers,
            pipeline: pipeline.value,
            bindings: bindings.value,
          });
        }
        this.indirectDrawCount = projected.length;
        return ok({
          accesses,
          encode: (viewBindGroup, pass, resources: GraphResourceResolver) => {
            // pbr-view-bgl carries the vertex-only Points/Lines UBO at binding
            // 10 as a dynamic uniform buffer.  The production view group is
            // shared by the GPU-driven raster pipeline, so even rigid draws
            // must provide the binding-10 offset (zero selects the frame
            // default slot).
            pass.setBindGroup(0, viewBindGroup, [0, 0]);
            let currentPipeline: RenderPipeline | undefined;
            let currentVertex: GraphBuffer | undefined;
            let currentIndex: GraphBuffer | undefined;
            for (const batch of projected) {
              if (currentPipeline !== batch.pipeline) {
                pass.setPipeline(batch.pipeline);
                currentPipeline = batch.pipeline;
              }
              pass.setBindGroup(1, batch.bindings);
              if (currentVertex !== batch.vertex) {
                const vertex = resources.buffer(batch.vertex);
                if (!vertex.ok) throw vertex.error;
                pass.setVertexBuffer(0, vertex.value);
                currentVertex = batch.vertex;
              }
              if (batch.index !== undefined && currentIndex !== batch.index) {
                const index = resources.buffer(batch.index);
                if (!index.ok) throw index.error;
                pass.setIndexBuffer(index.value, batch.mesh.indexFormat);
                currentIndex = batch.index;
              }
              const indirect = resources.buffer(outputs.value.indirect);
              if (!indirect.ok) throw indirect.error;
              const draw = (): void => {
                if (batch.batch.key.drawKind === 'indexed') {
                  pass.drawIndexedIndirect(indirect.value, batch.batch.indirectOffset);
                } else {
                  pass.drawIndirect(indirect.value, batch.batch.indirectOffset);
                }
              };
              draw();
            }
          },
        });
      },
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.view?.dispose();
    this.view = undefined;
    this.raster = undefined;
    this.filteredCache = undefined;
    this.signatureCache = undefined;
    this.sceneRowsRequired = true;
  }

  /** Whether the current production topology can consume GPU Scene row updates. */
  requiresSceneRows(): boolean {
    return this.sceneRowsRequired;
  }

  inspect(): GpuDrivenProductionInspection {
    const view = this.view?.inspect();
    return {
      gpuOwnedSnapshotsMaterialized: this.gpuOwnedSnapshotsMaterialized,
      filteredPlanBuilds: this.filteredPlanBuilds,
      gpuOwnedEntityCount: this.gpuOwnedEntityCount,
      candidateUploadBytes: view?.candidateUploadBytes ?? 0,
      batchUploadBytes: view?.batchUploadBytes ?? 0,
      viewConstantsUploadBytes: view?.viewConstantsUploadBytes ?? 0,
      batchBindGroupCreates: this.batchBindGroupCreates,
      viewBindGroupCreates: view?.bindGroupCreates ?? 0,
      topologyRevision: view?.topologyRevision,
      validatedGpuOwnedRows: this.validatedGpuOwnedRows,
      cpuFallbackDrawItems: this.cpuFallbackDrawItems,
      geometryWork: this.telemetryGeometryWork,
      rootGeometryWork: this.telemetryRootGeometryWork,
      geometryWorkReduction:
        this.telemetryRootGeometryWork > 0
          ? 1 - this.telemetryGeometryWork / this.telemetryRootGeometryWork
          : 0,
      batchCount: view?.batchCount ?? 0,
      indirectDrawCount: this.indirectDrawCount,
    };
  }

  /** Read renderer-owned LOD counters copied by the last GPU submission. */
  readLodSelection(): Promise<GpuDrivenLodSelectionInspection | undefined> {
    if (!this.telemetryPrepared) return Promise.resolve(undefined);
    return (this.view?.readLodSelection() ?? Promise.resolve(undefined)).then((selection) => {
      if (selection !== undefined) {
        this.telemetryGeometryWork = selection.geometryWork;
        this.telemetryRootGeometryWork = selection.rootGeometryWork;
      }
      if (selection === undefined || this.telemetryCandidateCount <= 0) return selection;
      const filtered = this.filteredCache?.value;
      if (filtered === undefined) return selection;
      const preparedByBatchId = new Map(
        filtered.batches.map((prepared) => [prepared.batch.batchId, prepared] as const),
      );
      const worldSelections = new Map<
        number,
        {
          readonly worldKey: number;
          readonly primitiveSlot: number;
          readonly slotGeneration: number;
          candidateCount: number;
          visible: number;
          occluded: number;
          readonly lodHistogram: Map<number, number>;
        }
      >();
      for (const batchSelection of selection.batches) {
        const prepared = preparedByBatchId.get(batchSelection.batchId);
        if (prepared === undefined) return selection;
        let aggregate = worldSelections.get(prepared.worldKey);
        if (aggregate === undefined) {
          aggregate = {
            worldKey: prepared.worldKey,
            primitiveSlot: prepared.primitiveSlot,
            slotGeneration: prepared.slotGeneration,
            candidateCount: 0,
            visible: 0,
            occluded: 0,
            lodHistogram: new Map(),
          };
          worldSelections.set(prepared.worldKey, aggregate);
        }
        aggregate.candidateCount += batchSelection.candidateCount;
        aggregate.visible += batchSelection.visible;
        aggregate.occluded += batchSelection.occluded;
        for (const row of batchSelection.lodHistogram) {
          aggregate.lodHistogram.set(
            row.level,
            (aggregate.lodHistogram.get(row.level) ?? 0) + row.count,
          );
        }
      }
      return {
        ...selection,
        candidateCount: this.telemetryCandidateCount,
        occluded: Math.max(0, this.telemetryCandidateCount - selection.visible),
        worldSelections: Object.freeze(
          [...worldSelections.values()].map((aggregate) =>
            Object.freeze({
              worldKey: aggregate.worldKey,
              primitiveSlot: aggregate.primitiveSlot,
              slotGeneration: aggregate.slotGeneration,
              candidateCount: aggregate.candidateCount,
              visible: aggregate.visible,
              occluded: aggregate.occluded,
              lodHistogram: Object.freeze(
                [...aggregate.lodHistogram.entries()]
                  .sort(([left], [right]) => left - right)
                  .map(([level, count]) => Object.freeze({ level, count })),
              ),
            } satisfies GpuDrivenWorldLodSelectionInspection),
          ),
        ),
      };
    });
  }

  recordCpuValidation(
    validated: readonly { readonly source: RenderableSnapshot }[],
    gpuOwned: ReadonlySet<number>,
    worldKeys?: readonly number[],
  ): void {
    this.cpuFallbackDrawItems = validated.length;
    let gpuOwnedRows = 0;
    for (const row of validated) {
      if (
        gpuOwned.has(
          worldEntityKey(
            worldKeys?.[row.source.worldId] ?? row.source.worldId,
            row.source.entityKey,
          ),
        )
      ) {
        gpuOwnedRows += 1;
      }
    }
    this.validatedGpuOwnedRows = gpuOwnedRows;
  }

  private sceneIdentity(scene: object): number {
    const existing = this.sceneIdentities.get(scene);
    if (existing !== undefined) return existing;
    const identity = this.nextSceneIdentity;
    this.nextSceneIdentity += 1;
    this.sceneIdentities.set(scene, identity);
    return identity;
  }
}
