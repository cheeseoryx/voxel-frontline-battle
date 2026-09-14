import { vec3 } from '@forgeax/engine-math';
import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import type { PreparedGpuDrivenDraw } from '../gpu-driven/prepared-draw';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';

const receipt = createStandardPbrArtifactReceipt();
const resourceClass = JSON.stringify({ textures: 8, samplers: 8, video: 0 });

function prepared(overrides: Partial<PreparedGpuDrivenDraw> = {}): PreparedGpuDrivenDraw {
  return {
    identity: { material: 'forgeax::default-standard-pbr', geometry: 'cube', deformation: 'rigid' },
    receiptGeneration: receipt.generation,
    directEntry: receipt.directEntry,
    sceneIndexEntry: receipt.sceneIndexEntry,
    materialRow: receipt.materialRow,
    resourceSlots: receipt.resourceSlots,
    uvSets: receipt.uvSets,
    vertexInputs: receipt.vertexInputs,
    alphaMask: receipt.alphaMask,
    skinPaletteAddress: receipt.skinPaletteAddress,
    topology: 'triangle-list',
    indexed: true,
    first: 0,
    count: 36,
    baseVertex: 0,
    ...overrides,
  };
}

function snapshot(
  entityKey: number,
  drawPrepared: PreparedGpuDrivenDraw,
  material: Partial<MaterialSnapshot> = {},
): RenderableSnapshot {
  const value = {
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 0.5,
    materialShaderId: 'forgeax::default-standard-pbr',
    textureHandles: new Map(
      receipt.resourceSlots
        .filter((slot) => slot.kind === 'texture')
        .map((slot, index) => [slot.parameter, index + 1]),
    ) as never,
    samplerHandles: new Map(
      receipt.resourceSlots
        .filter((slot) => slot.kind === 'sampler')
        .map((slot, index) => [slot.parameter, index + 101]),
    ) as never,
    ...material,
  } as MaterialSnapshot;
  return {
    assetHandle: 7,
    transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    material: value,
    materials: [value],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: drawPrepared.first,
        count: drawPrepared.count,
        baseVertex: drawPrepared.baseVertex,
        materialSlot: 0,
        topology: drawPrepared.topology,
        pipelineClass: 'prepared-standard-pbr',
        materialResourceClass: JSON.stringify({
          textures: drawPrepared.resourceSlots.filter((slot) => slot.kind === 'texture').length,
          samplers: drawPrepared.resourceSlots.filter((slot) => slot.kind === 'sampler').length,
          video: 0,
        }),
        prepared: drawPrepared,
      },
    ],
  };
}

function topologyFor(...snapshots: readonly RenderableSnapshot[]): BatchTopology {
  const projection = new RenderScene();
  projection.apply(snapshots.map((snapshot) => ({ kind: 'create' as const, snapshot })));
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  return topology;
}

describe('PBR prepared GPU-driven batch topology', () => {
  it('groups only by prepared identity and admits opaque plus Alpha Mask', () => {
    const mask = snapshot(2, prepared(), { paramSnapshot: { alphaCutoff: 0.5 } });
    const topology = topologyFor(snapshot(1, prepared()), mask);
    const plan = topology.plan();

    expect(plan.candidateCount).toBe(2);
    expect(plan.batches).toHaveLength(2);
    expect(plan.batches[0]?.key).toMatchObject({
      preparedIdentity: 'forgeax::default-standard-pbr|cube|rigid',
      resourceIdentity: resourceClass,
    });
  });

  it('keeps numeric edits in place and patches only resource identity changes', () => {
    const projection = new RenderScene();
    projection.apply([{ kind: 'create', snapshot: snapshot(1, prepared()) }]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const stableRevision = topology.inspect().revision;
    const numeric = projection.apply([
      {
        kind: 'update-transform',
        worldId: 0,
        entityKey: 1,
        world: snapshot(1, prepared()).transform.world,
      },
    ]);
    expect(topology.apply(numeric)).toBe(false);
    expect(topology.inspect().revision).toBe(stableRevision);

    const resourceChanged = projection.apply([
      {
        kind: 'create',
        snapshot: snapshot(1, prepared({ resourceSlots: receipt.resourceSlots.slice(0, 2) })),
      },
    ]);
    expect(topology.apply(resourceChanged)).toBe(true);
    expect(topology.inspect().patches).toBe(1);
    expect(topology.inspect().candidateCount).toBe(1);
  });

  it('routes Alpha Blend, morph and unsupported authoring out of the GPU lane', () => {
    const blend = snapshot(2, prepared(), {
      transparent: true,
      renderState: { blend: { color: {}, alpha: {} } } as never,
    });
    const morph = { ...snapshot(3, prepared()), morph: {} as never } as RenderableSnapshot;
    const custom = snapshot(4, prepared(), { materialShaderId: 'game::custom-shader' });
    const topology = topologyFor(snapshot(1, prepared()), blend, morph, custom);

    expect(topology.plan().candidateCount).toBe(1);
    expect(topology.inspect().ineligible).toBe(3);
  });
});
