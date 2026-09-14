import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { BindGroup } from '@forgeax/engine-rhi';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import {
  createStandardPbrArtifactReceipt,
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  DEFAULT_UNLIT_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderer as constructRenderer } from '../assembly/factory';
import { Camera, MeshFilter, MeshRenderer, PointLight } from '../components';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { BatchTopology } from '../gpu-driven/batch-topology';
import {
  adaptStandardPbrFrameResources,
  GpuDrivenProduction,
  projectStandardPbrScene,
} from '../gpu-driven/production-raster';
import { GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { GpuBuffer } from '../gpu-resource';
import { GpuScene } from '../gpu-scene';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_UNIFORM,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import { makeZeroCameraFallbackSnapshot, worldEntityKey } from '../record/frame-snapshot';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';

const STANDARD_PBR_RECEIPT = createStandardPbrArtifactReceipt();

const EMPTY_RESOURCE_CLASS = JSON.stringify({ textures: [], samplers: [], video: [] });
const OUTPUT_TRANSFORM_WGSL =
  '@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> { ' +
  'var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)); ' +
  'return vec4<f32>(p[i], 0.0, 1.0); } ' +
  '@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(0.0); }';

const STANDARD_PBR_URP_VARIANT_KEY =
  'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+TRANSMISSION_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=false';
const STANDARD_PBR_TRANSMISSION_VARIANT_KEY =
  'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+TRANSMISSION_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false';

function manifestDataUrl(): string {
  const pbrWgsl = '/* pbr stub - calls f_schlick( */';
  const unlitWgsl = '/* unlit stub */';
  const tonemapWgsl = OUTPUT_TRANSFORM_WGSL;
  const standardPbrVariant = (transmissionAvailable: boolean, definesKey: string) => ({
    definesKey,
    defines: {
      CLUSTER_FORWARD_AVAILABLE: false,
      STORAGE_BUFFER_AVAILABLE: true,
      TRANSMISSION_AVAILABLE: transmissionAvailable,
      VERTEX_COLOR_AVAILABLE: false,
    },
    composedWgsl: pbrWgsl,
  });
  const materialShader = (
    identifier: string,
    paramSchema: readonly unknown[],
    composedWgsl: string,
    variants: readonly unknown[] = [],
  ) => ({
    identifier,
    sourcePath: `${identifier}.wgsl`,
    composedWgsl,
    paramSchema: JSON.stringify(paramSchema),
    variants,
  });
  return `data:application/json,${encodeURIComponent(
    JSON.stringify({
      schemaVersion: '1.0.0',
      entries: [
        { hash: 'pbr00000', wgsl: pbrWgsl, glsl: '', bindings: '' },
        { hash: 'unlit000', wgsl: unlitWgsl, glsl: '', bindings: '' },
        { hash: 'tonemap0', wgsl: tonemapWgsl, glsl: '', bindings: '' },
      ],
      materialShaders: [
        materialShader(
          'forgeax::default-standard-pbr',
          DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
          pbrWgsl,
          [
            standardPbrVariant(false, STANDARD_PBR_URP_VARIANT_KEY),
            standardPbrVariant(true, STANDARD_PBR_TRANSMISSION_VARIANT_KEY),
          ],
        ),
        materialShader('forgeax::default-unlit', DEFAULT_UNLIT_PARAM_SCHEMA, unlitWgsl),
      ],
    }),
  )}`;
}

function snapshot(entityKey: number, assetHandle: number): RenderableSnapshot {
  const material = {
    baseColor: new Float32Array([0.25 * entityKey, 0.5, 0.75]),
    metallic: 0,
    roughness: 1,
    materialShaderId: 'forgeax::default-unlit',
  } as MaterialSnapshot;
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  return {
    assetHandle,
    transform: { world },
    localAabb: new Float32Array([-0.25, -0.25, -0.25, 0.25, 0.25, 0.25]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 3,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'forgeax::default-unlit|triangle-list|null',
        materialResourceClass: EMPTY_RESOURCE_CLASS,
      },
    ],
  };
}

function mesh(device: RhiNullDevice, indexed = true, withLod = false): MeshGpuHandles {
  const vertex = device
    .createBuffer({
      size: 144,
      usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const index = indexed
    ? device
        .createBuffer({
          size: 8,
          usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
        })
        .unwrap()
    : null;
  return {
    vertexBuffer: new GpuBuffer(device, vertex),
    indexBuffer: index === null ? null : new GpuBuffer(device, index),
    vboBytes: 144,
    iboBytes: indexed ? 8 : 0,
    indexCount: indexed ? 3 : 0,
    indexFormat: 'uint16',
    layout: '12F',
    layoutProjection: deriveVertexLayoutProjection({
      position: new Float32Array(9),
      normal: new Float32Array(9),
      uv: new Float32Array(6),
      tangent: new Float32Array(12),
    }),
    uvSetCount: 1,
    vertexCount: 3,
    indexed,
    topology: 'triangle-list',
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 3,
        materialSlot: 0,
        topology: 'triangle-list',
      },
    ],
    ...(withLod
      ? {
          lodRanges: [
            [{ first: 0, count: 3, baseVertex: 0 }],
            [{ first: 3, count: 1, baseVertex: 0 }],
          ],
        }
      : {}),
  };
}

describe('GPU-driven production projection', () => {
  it('retains suppressed LOD candidates for selector accounting while admitting only active draws', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const projection = new RenderScene();
    const lodMeshGuid = '00000000-0000-7000-8000-000000000001' as never;
    const makeLodSnapshot = (entityKey: number): RenderableSnapshot => {
      const base = snapshot(entityKey, 3);
      const draw = base.gpuDrivenDraws?.[0];
      if (draw === undefined) throw new Error('LOD test snapshot has no draw');
      return {
        ...base,
        lods: [{ mesh: lodMeshGuid, screenCoverage: 0.5 }],
        gpuDrivenDraws: [{ ...draw, lodRanges: [{ first: 3, count: 1, baseVertex: 0 }] }],
      };
    };
    const delta = projection.apply([
      { kind: 'create', snapshot: makeLodSnapshot(1) },
      { kind: 'create', snapshot: makeLodSnapshot(2) },
    ]);
    const availability = GpuScene.create(device, 2).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const prepared = production
      .prepare({
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshes: new Map([[3, mesh(device, true, true)]]),
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
        hdrp: false,
        activeEntityKeys: new Set([worldEntityKey(0, 1)]),
        activeEntityRevision: 1,
      })
      .unwrap();
    expect(prepared?.entityKeys).toEqual(new Set([worldEntityKey(0, 1)]));
    // Both candidates are uploaded to the selector (2 * 304 bytes), while
    // only the active entity is admitted into the compacted draw stream.
    expect(production.inspect()).toMatchObject({
      candidateUploadBytes: 2 * 304,
      batchCount: 1,
      indirectDrawCount: 1,
    });
    if (prepared === undefined) return;
    const projected = prepared
      .project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1)
      .unwrap();
    expect(projected.accesses.length).toBeGreaterThan(0);
    expect(production.inspect()).toMatchObject({
      batchBindGroupCreates: 1,
      indirectDrawCount: 1,
    });
    expect(production.inspect().indirectDrawCount).toBeGreaterThan(0);
    expect(production.inspect().indirectDrawCount).toBeLessThanOrEqual(
      production.inspect().batchCount,
    );

    const suppressed = production
      .prepare({
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshes: new Map([[3, mesh(device, true, true)]]),
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
        hdrp: false,
        activeEntityKeys: new Set(),
        activeEntityRevision: 2,
      })
      .unwrap();
    expect(suppressed?.topologySignature).not.toBe(prepared.topologySignature);
    expect(production.inspect()).toMatchObject({
      batchCount: 1,
      indirectDrawCount: 0,
    });

    const restored = production
      .prepare({
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshes: new Map([[3, mesh(device, true, true)]]),
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
        hdrp: false,
        activeEntityKeys: new Set([worldEntityKey(0, 1)]),
        activeEntityRevision: 3,
      })
      .unwrap();
    expect(restored?.topologySignature).not.toBe(suppressed?.topologySignature);
    expect(production.inspect()).toMatchObject({
      batchCount: 1,
      indirectDrawCount: 1,
    });
    expect(GPU_DRIVEN_VIEW_WGSL.indexOf('atomicAdd(&counters[lodCounterIndex')).toBeLessThan(
      GPU_DRIVEN_VIEW_WGSL.indexOf('if (candidate.submitAdmission == 0u)'),
    );
    expect(GPU_DRIVEN_VIEW_WGSL.indexOf('if (candidate.submitAdmission == 0u)')).toBeLessThan(
      GPU_DRIVEN_VIEW_WGSL.indexOf('atomicAdd(&counters[counterIndex(candidate.batchIndex)], 1u)'),
    );
    production.dispose();
    availability.scene.dispose();
  });

  it('keeps a suppressed-only batch in selector telemetry without raster resources', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const projection = new RenderScene();
    const candidate = snapshot(1, 3);
    const delta = projection.apply([{ kind: 'create', snapshot: candidate }]);
    const availability = GpuScene.create(device, 1).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const prepared = production
      .prepare({
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshes: new Map([[3, mesh(device)]]),
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
        hdrp: false,
        activeEntityKeys: new Set(),
        activeEntityRevision: 1,
      })
      .unwrap();
    expect(prepared).toBeDefined();
    expect(production.requiresSceneRows()).toBe(true);
    expect(production.inspect()).toMatchObject({
      batchCount: 1,
      indirectDrawCount: 0,
      batchBindGroupCreates: 0,
    });
    if (prepared === undefined) return;
    prepared.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap();
    expect(production.inspect()).toMatchObject({
      batchCount: 1,
      indirectDrawCount: 0,
      batchBindGroupCreates: 0,
    });
    production.dispose();
    availability.scene.dispose();
  });

  it('keeps GPU batches World-homogeneous for same-submit counter attribution', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const projection = new RenderScene();
    const first = snapshot(1, 3);
    const second = { ...snapshot(2, 3), worldId: 1 };
    const delta = projection.apply([
      { kind: 'create', snapshot: first },
      { kind: 'create', snapshot: second },
    ]);
    const availability = GpuScene.create(device, 2).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const prepared = production
      .prepare({
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshes: new Map([[3, mesh(device)]]),
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
        hdrp: false,
      })
      .unwrap();
    expect(prepared).toBeDefined();
    expect(production.inspect()).toMatchObject({ batchCount: 2, indirectDrawCount: 2 });
    production.dispose();
    availability.scene.dispose();
  });

  it('uses renderer-local World keys for CPU validation telemetry', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const gpuLodRow = {
      ...snapshot(7, 3),
      worldId: 1,
      lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.5 }],
    };
    const plainFallbackRow = { ...snapshot(2, 3), worldId: 0 };
    const gpuOwned = new Set([worldEntityKey(101, gpuLodRow.entityKey)]);
    const worldKeys = [202, 101];

    // A GPU-owned row is removed from validation before this telemetry hook;
    // the remaining plain row must still be counted as the one CPU fallback.
    production.recordCpuValidation([{ source: plainFallbackRow }], gpuOwned, worldKeys);
    expect(production.inspect()).toMatchObject({
      cpuFallbackDrawItems: 1,
      validatedGpuOwnedRows: 0,
    });

    // Prove the same renderer-local namespace recognizes the GPU row when a
    // diagnostic caller supplies it directly, even though its extracted
    // RenderableSnapshot still carries the reordered array index.
    production.recordCpuValidation([{ source: gpuLodRow }], gpuOwned, worldKeys);
    expect(production.inspect()).toMatchObject({
      cpuFallbackDrawItems: 1,
      validatedGpuOwnedRows: 1,
    });
    production.dispose();
  });

  it('coalesces LOD candidates that share the selected geometry range', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const projection = new RenderScene();
    const lodMeshGuid = '00000000-0000-7000-8000-000000000001' as never;
    const makeLodSnapshot = (entityKey: number): RenderableSnapshot => {
      const base = snapshot(entityKey, 3);
      const draw = base.gpuDrivenDraws?.[0];
      if (draw === undefined) throw new Error('LOD test snapshot has no draw');
      return {
        ...base,
        lods: [{ mesh: lodMeshGuid, screenCoverage: 0.5 }],
        gpuDrivenDraws: [{ ...draw, lodRanges: [{ first: 3, count: 1, baseVertex: 0 }] }],
      };
    };
    const delta = projection.apply([
      { kind: 'create', snapshot: makeLodSnapshot(1) },
      { kind: 'create', snapshot: makeLodSnapshot(2) },
    ]);
    const availability = GpuScene.create(device, 2).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const prepared = production
      .prepare({
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
        },
        camera: { ...makeZeroCameraFallbackSnapshot(), position: vec3.create(0, 0, 5) },
        meshes: new Map([[3, mesh(device, true, true)]]),
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
        hdrp: false,
      })
      .unwrap();
    expect(prepared).toBeDefined();
    expect(production.inspect()).toMatchObject({
      batchCount: 1,
      indirectDrawCount: 1,
      candidateUploadBytes: 2 * 304,
    });
    production.dispose();
    availability.scene.dispose();
  });

  it('projects scene rows from the receipt-selected scene-index entry', () => {
    const result = projectStandardPbrScene({
      artifact: {
        material: 'forgeax::default-standard-pbr',
        pass: 'forward',
        wgsl: 'standard-pbr',
        layoutIdentity: STANDARD_PBR_RECEIPT.reflection.layoutIdentity,
        bindings: [],
        deps: [],
        vertexInputs: STANDARD_PBR_RECEIPT.vertexInputs.map((input) => ({ ...input })),
        receipt: STANDARD_PBR_RECEIPT,
      },
      candidates: [
        {
          primitiveIndex: 3,
          world: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1]),
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entryPoint).toBe('vs_scene_index');
    expect(result.value.rows[0]).toBe(1);
    expect(result.value.rows[12]).toBe(2);
    expect(result.value.rows[13]).toBe(3);
    expect(result.value.rows[14]).toBe(4);
  });

  it('adapts the four existing Standard PBR groups from one receipt', () => {
    const groups = {
      view: { id: 'view' },
      material: { id: 'material' },
      mesh: { id: 'mesh' },
      instances: { id: 'instances' },
    } as unknown as {
      readonly view: BindGroup;
      readonly material: BindGroup;
      readonly mesh: BindGroup;
      readonly instances: BindGroup;
    };
    const result = adaptStandardPbrFrameResources({
      artifact: {
        material: 'forgeax::default-standard-pbr',
        pass: 'forward',
        wgsl: 'standard-pbr',
        layoutIdentity: STANDARD_PBR_RECEIPT.reflection.layoutIdentity,
        bindings: [],
        deps: [],
        vertexInputs: STANDARD_PBR_RECEIPT.vertexInputs.map((input) => ({ ...input })),
        receipt: STANDARD_PBR_RECEIPT,
      },
      ...groups,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entryPoint).toBe('vs_scene_index');
    expect(result.value.bindGroups).toEqual([
      groups.view,
      groups.material,
      groups.mesh,
      groups.instances,
    ]);
    expect(result.value.resourceSlots).toEqual(STANDARD_PBR_RECEIPT.resourceSlots);
  });

  it('projects aligned multi-batch compute work into one indirect raster pass', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const viewUniform = device
      .createBuffer({ size: 784, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST })
      .unwrap();
    const viewBindGroup = device
      .createBindGroup({
        layout: viewLayout,
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: viewUniform } } }],
      })
      .unwrap();
    const first = snapshot(1, 3);
    const firstDraw = first.gpuDrivenDraws?.[0];
    expect(firstDraw).toBeDefined();
    if (firstDraw === undefined) return;
    const second = { ...snapshot(2, 4), worldId: 1 };
    const secondDraw = second.gpuDrivenDraws?.[0];
    expect(secondDraw).toBeDefined();
    if (secondDraw === undefined) return;
    const preparedMaterial = {
      ...second.material,
      materialHandle: 42,
      renderState: { cullMode: 'none' as const, depthCompare: 'less-equal' as const },
    };
    const renderables = [
      { ...first, gpuDrivenDraws: [firstDraw, { ...firstDraw, first: 3 }] },
      {
        ...second,
        material: preparedMaterial,
        materials: [preparedMaterial],
        gpuDrivenDraws: [
          {
            ...secondDraw,
            kind: 'non-indexed' as const,
            pipelineClass:
              'forgeax::default-unlit|triangle-list|{"cullMode":"none","depthCompare":"less-equal"}',
          },
        ],
      },
    ];
    const projection = new RenderScene();
    const delta = projection.apply(
      renderables.map((renderable) => ({ kind: 'create' as const, snapshot: renderable })),
    );
    const availability = GpuScene.create(device, 2).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    expect(topology.plan()).toMatchObject({
      candidateCount: 3,
      visibleCapacity: 129,
      batches: [{ visibleBase: 0 }, { visibleBase: 64 }, { visibleBase: 128 }],
    });
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const meshes = new Map([
      [3, mesh(device)],
      [4, mesh(device, false)],
    ]);
    const prepared = production
      .prepare({
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshes,
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
        hdrp: false,
      })
      .unwrap();
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    expect([...prepared.entityKeys]).toEqual([worldEntityKey(0, 1), worldEntityKey(1, 2)]);
    expect(production.inspect()).toMatchObject({
      gpuOwnedSnapshotsMaterialized: 2,
      filteredPlanBuilds: 1,
      candidateUploadBytes: 912,
      batchUploadBytes: 96,
      viewBindGroupCreates: 1,
    });

    const stable = production
      .prepare({
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshes,
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
        hdrp: false,
      })
      .unwrap();
    expect(stable?.topologySignature).toBe(prepared.topologySignature);
    expect(production.inspect()).toMatchObject({
      gpuOwnedSnapshotsMaterialized: 0,
      filteredPlanBuilds: 0,
      candidateUploadBytes: 0,
      batchUploadBytes: 0,
      viewConstantsUploadBytes: 112,
      viewBindGroupCreates: 0,
      batchBindGroupCreates: 0,
      indirectDrawCount: 3,
    });

    // The scene topology is unchanged, but projectedHeight is camera-owned
    // input to the GPU LOD selector. A moved camera must rebuild the filtered
    // candidate plan instead of reusing the previous view's heights.
    const movedCamera = {
      ...makeZeroCameraFallbackSnapshot(),
      position: vec3.create(0, 0, 6),
    };
    const moved = production
      .prepare({
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
        },
        camera: movedCamera,
        meshes,
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
        hdrp: false,
      })
      .unwrap();
    expect(moved).toBeDefined();
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 1,
      candidateUploadBytes: 912,
      batchUploadBytes: 96,
    });
    if (moved === undefined) return;

    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const gpu = moved.project(graph, 'rgba8unorm', 1).unwrap();
    const color = graph
      .createTexture('gpu-driven-production-color', {
        format: 'rgba8unorm',
        size: { width: 1, height: 1 },
      })
      .unwrap();
    const colorView = graph.view(color).unwrap();
    graph
      .addRasterPass('main', {
        accesses: [...gpu.accesses, { resource: colorView, usage: 'color-attachment' }],
        colorAttachments: [
          {
            view: colorView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
        encode: ({ pass, resources }) => gpu.encode(viewBindGroup, pass, resources),
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    expect(compiled.inspect().passes.at(-1)).toMatchObject({
      name: 'main',
      dependencies: ['gpu-driven.frustum-compact', 'gpu-driven.finalize-indirect'],
    });
    const encoder = device.createCommandEncoder({ label: 'gpu-driven-production' }).unwrap();
    compiled.execute({ viewBindGroup, encoder } as unknown as RenderPipelineFrame).unwrap();
    encoder.finish().unwrap();
    expect(device.framePassNames).toEqual([
      'gpu-driven.view-reset',
      'gpu-driven.frustum-compact',
      'gpu-driven.finalize-indirect',
      'main',
    ]);
    expect(device.totalDispatchCount).toBe(3);
    expect(device.totalDrawCount).toBe(3);
    expect(production.inspect().indirectDrawCount).toBe(3);
    expect(production.inspect().indirectDrawCount).toBeLessThanOrEqual(
      production.inspect().batchCount,
    );

    // The facet projection is the same admission set consumed by the GPU
    // candidate upload. A suppressed entity must disappear from the indirect
    // plan without making the remaining entity fall back to CPU validation.
    const activeOnly = production
      .prepare({
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
        },
        camera: movedCamera,
        meshes,
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
        hdrp: false,
        activeEntityKeys: new Set([worldEntityKey(0, 1)]),
        activeEntityRevision: 1,
      })
      .unwrap();
    expect(activeOnly?.entityKeys).toEqual(new Set([1]));
    expect(activeOnly?.ownsAllRenderables).toBe(true);

    const changedActive = production
      .prepare({
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
        },
        camera: movedCamera,
        meshes,
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
        hdrp: false,
        activeEntityKeys: new Set([worldEntityKey(1, 2)]),
        activeEntityRevision: 2,
      })
      .unwrap();
    expect(changedActive?.entityKeys).toEqual(new Set([worldEntityKey(1, 2)]));
    // Production inspection counters are per-prepare-frame facts. The changed
    // revision must trigger exactly one rebuild for this frame, not accumulate
    // the prior frame's count.
    expect(production.inspect().filteredPlanBuilds).toBe(1);

    const replacement = GpuScene.create(device, 2).unwrap();
    expect(replacement.status).toBe('available');
    if (replacement.status !== 'available') return;
    replacement.scene.sync(delta).unwrap();
    const replacementPrepared = production
      .prepare({
        scene: {
          scene: replacement.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshes,
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
        hdrp: false,
      })
      .unwrap();
    expect(replacementPrepared?.topologySignature).not.toBe(prepared.topologySignature);

    production.dispose();
    replacement.scene.dispose();
    availability.scene.dispose();
  });

  it('keeps an ineligible production topology empty while the camera moves', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const base = snapshot(1, 3);
    const material = {
      ...base.material,
      materialShaderId: 'forgeax::default-standard-pbr',
    };
    const projection = new RenderScene();
    const delta = projection.apply([
      { kind: 'create', snapshot: { ...base, material, materials: [material] } },
    ]);
    const availability = GpuScene.create(device, 1).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const input = {
      scene: {
        scene: availability.scene,
        plan: topology.plan(),
        slots: projection.slotsSnapshot(),
      },
      meshes: new Map([[3, mesh(device)]]),
      viewBindGroupLayout: viewLayout,
      hdrp: false,
    } as const;

    expect(
      production
        .prepare({
          ...input,
          camera: makeZeroCameraFallbackSnapshot(),
          meshResidencyEpoch: 1,
        })
        .unwrap(),
    ).toBeUndefined();
    expect(production.requiresSceneRows()).toBe(false);
    expect(production.inspect().filteredPlanBuilds).toBe(1);
    expect(
      production
        .prepare({
          ...input,
          camera: { ...makeZeroCameraFallbackSnapshot(), position: vec3.create(0, 0, 6) },
          meshResidencyEpoch: 2,
        })
        .unwrap(),
    ).toBeUndefined();
    expect(production.requiresSceneRows()).toBe(false);
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      gpuOwnedSnapshotsMaterialized: 0,
      gpuOwnedEntityCount: 0,
    });

    production.dispose();
    availability.scene.dispose();
  });

  it('activates inside the renderer-owned clustered Standard graph and removes the CPU draw', async () => {
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
    const renderer = await constructRenderer(
      canvas,
      { rhi },
      { shaderManifestUrl: manifestDataUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World();
    expect(renderer.attach(world).ok).toBe(true);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 1] } },
        { component: PointLight, data: {} },
      )
      .unwrap();

    for (let frame = 0; frame < 4; frame += 1) {
      world.update(1 / 60).unwrap();
      expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);
      await Promise.resolve();
    }
    const device = renderer.device as RhiNullDevice;
    device.totalDrawCount = 0;
    world.update(1 / 60).unwrap();
    expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);
    expect(renderer.perFramePassNames).toEqual(
      expect.arrayContaining(['cluster-membership-producer', 'main', 'output-transform']),
    );
    expect(renderer.perFramePassNames).toContain('output-transform');
    // Storage-buffer LDR frames keep the scene linear until the one output
    // transform writes the encoded surface; the GPU-driven indirect raster
    // draw and that fullscreen pass are the only draws in this topology.
    // A plain mesh has no LOD relation, so it stays on the CPU visibility
    // path for occlusion while GPU-driven raster + output-transform remain
    // the only draws in this graph.
    expect(device.totalDrawCount).toBe(2);
    expect(renderer.inspect().lodOcclusion).toMatchObject({
      fallback: { active: false },
      degradation: { active: false },
      pagePressure: { used: 0, capacity: 3 * 4096 },
    });
    expect(renderer.renderScene).toMatchObject({
      worldEntitiesScanned: 0,
      fullRebuilds: 1,
      projectionRecords: 1,
      topology: { batchCount: 1, candidateCount: 1 },
      gpu: { status: 'resident' },
      gpuDriven: {
        gpuOwnedSnapshotsMaterialized: 0,
        filteredPlanBuilds: 0,
        candidateUploadBytes: 0,
        batchUploadBytes: 0,
        batchBindGroupCreates: 0,
        viewBindGroupCreates: 0,
        validatedGpuOwnedRows: 0,
        cpuFallbackDrawItems: 0,
      },
    });
    renderer.dispose();
  });

  it('keeps a stable multi-World composition resident and patches one World transform', async () => {
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
    const renderer = await constructRenderer(
      canvas,
      { rhi },
      { shaderManifestUrl: manifestDataUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const cameraWorld = new World();
    const sceneWorld = new World();
    expect(renderer.attach(cameraWorld).ok).toBe(true);
    expect(renderer.attach(sceneWorld).ok).toBe(true);
    cameraWorld
      .spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    const rendered = sceneWorld
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();

    for (let frame = 0; frame < 4; frame += 1) {
      cameraWorld.update(1 / 60).unwrap();
      sceneWorld.update(1 / 60).unwrap();
      expect(
        renderer.draw([cameraWorld, sceneWorld], { cameraOwner: 0, resourceOwner: 0 }).ok,
      ).toBe(true);
      await Promise.resolve();
    }
    expect(renderer.renderScene).toMatchObject({
      worldEntitiesScanned: 0,
      projectionRecords: 1,
      topology: { batchCount: 1, candidateCount: 1 },
      gpu: { status: 'resident' },
      gpuDriven: { cpuFallbackDrawItems: 0, validatedGpuOwnedRows: 0 },
    });

    sceneWorld.set(rendered, Transform, { pos: [1, 0, 0] }).unwrap();
    cameraWorld.update(1 / 60).unwrap();
    sceneWorld.update(1 / 60).unwrap();
    expect(renderer.draw([cameraWorld, sceneWorld], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(
      true,
    );
    expect(renderer.renderScene).toMatchObject({
      worldEntitiesScanned: 0,
      fullRebuilds: 1,
      transformUpdates: 1,
      projectionRecords: 1,
    });
    renderer.dispose();
  });
});
