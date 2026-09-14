import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { Camera, MotionBlur } from '../components';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type {
  ExtractedFrame,
  MaterialSnapshot,
  RenderableSnapshot,
} from '../render-system-extract';
import { PersistentRenderScene, RenderScene } from '../scene/render-scene';
import { primitiveKey, viewKey } from '../scene/visibility/types';
import { classifySceneDataCoverage } from '../temporal/coverage';

const material = {} as MaterialSnapshot;

function guid(value: string) {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw new Error(`invalid fixture guid: ${value}`);
  return parsed.value;
}

const LOD_MESH_GUID = guid('019d0000-0000-7000-8000-000000000001');

function snapshot(entityKey: number, translationX: number): RenderableSnapshot {
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  world[12] = translationX;
  return {
    assetHandle: 1,
    transform: { world },
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
  };
}

describe('RenderScene canonical owner', () => {
  it('rebuilds the retained composition when Motion Blur is toggled', () => {
    const world = new World();
    const camera = world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 0, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        {
          component: Camera,
          data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 },
        },
        {
          component: MotionBlur,
          data: { shutterAngle: 180, maxRadiusPixels: 32, sampleCount: 8 },
        },
      )
      .unwrap();
    const lease = createRenderReadLease(world);
    const frame = {
      cameras: [{ ...makeZeroCameraFallbackSnapshot(), worldId: 0, entityKey: camera as number }],
      renderables: [],
      dispatch: [],
    } as unknown as ExtractedFrame;
    const persistent = new PersistentRenderScene();
    let builds = 0;
    const build = (): ExtractedFrame => {
      builds += 1;
      return frame;
    };

    persistent.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, 0, build, [lease]);
    expect(builds).toBe(1);

    world.removeComponent(camera, MotionBlur).unwrap();
    world.update().unwrap();
    persistent.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, 0, build, [lease]);
    expect(builds).toBe(2);

    world
      .addComponent(camera, {
        component: MotionBlur,
        data: { shutterAngle: 180, maxRadiusPixels: 32, sampleCount: 8 },
      })
      .unwrap();
    world.update().unwrap();
    persistent.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, 0, build, [lease]);
    expect(builds).toBe(3);
    lease.dispose();
  });

  it('retains renderable topology while refreshing per-frame resources', () => {
    const world = new World();
    const lease = createRenderReadLease(world);
    const camera = { ...makeZeroCameraFallbackSnapshot(), worldId: 0, entityKey: 1 };
    const renderables = Array.from({ length: 1024 }, (_, entityKey) =>
      snapshot(entityKey + 1, entityKey * 0.01),
    );
    const frame = {
      cameras: [camera],
      renderables,
      dispatch: [],
    } as unknown as ExtractedFrame;
    const persistent = new PersistentRenderScene();
    let builds = 0;
    const build = (): ExtractedFrame => {
      builds += 1;
      return frame;
    };
    const first = persistent.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      build,
      [lease],
    );
    const stable = persistent.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      build,
      [lease],
    );

    expect(stable).not.toBe(first);
    expect(stable.renderables).toEqual(first.renderables);
    expect(builds).toBe(2);
    expect(persistent.inspect()).toMatchObject({
      worldEntitiesScanned: 0,
      noChangeFrames: 1,
      projectionRecords: 1024,
    });
    lease.dispose();
  });

  it('projects current scene contributors without owning temporal history', () => {
    const coverage = classifySceneDataCoverage({
      contributors: [{ id: 'world', kind: 'reactive' }],
      requiredContributorIds: ['world', 'camera'],
    });
    expect(coverage.reactiveContributorIds).toEqual(['world']);
    expect(coverage.missingContributorIds).toEqual(['camera']);
  });

  it('coalesces create and transform updates into one stable slot', () => {
    const projection = new RenderScene();
    const initial = snapshot(7, 1);
    const updatedWorld = new Float32Array(initial.transform.world);
    updatedWorld[12] = 9;

    const result = projection.apply([
      { kind: 'create', snapshot: initial },
      { kind: 'update-transform', worldId: 0, entityKey: 7, world: updatedWorld },
    ]);

    expect(result).toMatchObject({ created: 1, updated: 0, removed: 0, recreated: 0 });
    expect(projection.inspect().records).toEqual([
      expect.objectContaining({ slot: 0, generation: 0, worldId: 0, entityKey: 7 }),
    ]);
    expect(projection.materialize()[0]?.transform.world[12]).toBe(9);
  });

  it('updates cached dynamic world bounds without replacing the bounds object', () => {
    const projection = new RenderScene();
    const initial = {
      ...snapshot(7, 1),
      localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    };
    projection.apply([{ kind: 'create', snapshot: initial }]);
    const retained = projection.materialize()[0];
    if (retained === undefined) throw new Error('expected retained snapshot');
    const first = projection.cullingWorldBounds(retained);
    const moved = new Float32Array(initial.transform.world);
    moved[12] = 9;

    projection.applyTransformSpans([{ worldId: 0, entities: new Uint32Array([7]), worlds: moved }]);

    const next = projection.cullingWorldBounds(retained);
    expect(next).toBe(first);
    expect(next?.min[0]).toBe(8);
    expect(next?.max[0]).toBe(10);
  });

  it('cancels a transient create/remove pair without allocating a slot', () => {
    const projection = new RenderScene();

    const result = projection.apply([
      { kind: 'create', snapshot: snapshot(3, 1) },
      { kind: 'remove', worldId: 0, entityKey: 3 },
    ]);

    expect(result).toMatchObject({ created: 0, updated: 0, removed: 0, recreated: 0 });
    expect(projection.inspect().records).toEqual([]);
  });

  it('bumps generation when remove and recreate reuse a slot', () => {
    const projection = new RenderScene();
    projection.apply([{ kind: 'create', snapshot: snapshot(5, 1) }]);
    const before = projection.inspect().records[0];

    const result = projection.apply([
      { kind: 'remove', worldId: 0, entityKey: 5 },
      { kind: 'create', snapshot: snapshot(5, 2) },
      { kind: 'update-transform', worldId: 0, entityKey: 5, world: snapshot(5, 7).transform.world },
    ]);

    const after = projection.inspect().records[0];
    expect(result).toMatchObject({ created: 0, updated: 0, removed: 0, recreated: 1 });
    expect(after?.slot).toBe(before?.slot);
    expect(after?.generation).toBe((before?.generation ?? -1) + 1);
    expect(projection.materialize()[0]?.transform.world[12]).toBe(7);
  });

  it('ignores an update that arrives after removal', () => {
    const projection = new RenderScene();
    projection.apply([{ kind: 'create', snapshot: snapshot(9, 1) }]);

    const result = projection.apply([
      { kind: 'remove', worldId: 0, entityKey: 9 },
      { kind: 'update-transform', worldId: 0, entityKey: 9, world: snapshot(9, 4).transform.world },
    ]);

    expect(result).toMatchObject({ removed: 1, ignoredLateUpdates: 1 });
    expect(projection.inspect().records).toEqual([]);
  });

  it('keeps identical entity handles isolated by World identity', () => {
    const projection = new RenderScene();
    projection.apply([
      { kind: 'create', snapshot: snapshot(1, 3) },
      { kind: 'create', snapshot: { ...snapshot(1, 8), worldId: 1 } },
    ]);

    expect(projection.materialize().map((record) => record.transform.world[12])).toEqual([3, 8]);
  });

  it('suppresses an occluded LOD candidate after two zero results and reopens it on a hit', () => {
    const world = new World();
    const camera = {
      ...makeZeroCameraFallbackSnapshot(),
      worldId: 0,
      entityKey: 1,
    };
    const candidate = {
      ...snapshot(7, 1),
      lods: [{ mesh: LOD_MESH_GUID, screenCoverage: 0.5 }],
      localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    } as RenderableSnapshot;
    const dispatch = {
      entityIndex: candidate.entityKey,
      materialHandle: 0,
      renderableIndex: 0,
      passIndex: 0,
      queue: 2000,
      layer: 0,
      tags: {},
      renderState: undefined,
      defines: undefined,
      vertexEntry: undefined,
      fragmentEntry: undefined,
      materialShaderId: 'forgeax::default-unlit',
      paramSnapshot: undefined,
    };
    const frame = {
      cameras: [camera],
      dispatch: [dispatch],
      renderables: [candidate],
    } as unknown as ExtractedFrame;
    const persistent = new PersistentRenderScene();
    const lease = createRenderReadLease(world);
    persistent.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, 0, () => frame, [
      lease,
    ]);
    const renderableInput = [candidate];
    const dispatchInput = [dispatch];
    persistent.updateVisibilityFacet([world], camera, renderableInput);
    const view = viewKey({
      attachmentId: world.identity,
      cameraEntity: camera.entityKey ?? 0,
      viewRole: 'main',
      viewGeneration: camera.historyVersion ?? 0,
    });
    const primitive = primitiveKey({
      attachmentId: world.identity,
      worldGeneration: 0,
      primitiveSlot: 0,
      slotGeneration: 0,
    });
    const facets = persistent.visibilityFacetStore();
    const initialProjection = persistent.projectVisibility(
      [world],
      camera,
      renderableInput,
      dispatchInput,
    );
    const beforeCompletionRevision = facets.drawRevisionValue;
    expect(facets.applyCompletion(view, primitive, 0, { level: 0, confidence: 1 })).toBe(true);
    expect(facets.drawRevisionValue).toBe(beforeCompletionRevision);
    expect(persistent.projectVisibility([world], camera, renderableInput, dispatchInput)).toBe(
      initialProjection,
    );
    facets.applyConfidence(view, primitive, {
      type: 'result',
      samples: 0,
      submissionGeneration: 1,
    });
    facets.applyConfidence(view, primitive, {
      type: 'result',
      samples: 0,
      submissionGeneration: 2,
    });
    const hidden = persistent.projectVisibility([world], camera, renderableInput, dispatchInput);
    expect(hidden.renderables).toHaveLength(0);
    expect(hidden.dispatch).toHaveLength(0);
    expect(hidden.suppressed).toBe(1);

    facets.applyConfidence(view, primitive, {
      type: 'result',
      samples: 1,
      submissionGeneration: 3,
    });
    const reopened = persistent.projectVisibility([world], camera, renderableInput, dispatchInput);
    expect(reopened.renderables).toHaveLength(1);
    expect(reopened.dispatch).toHaveLength(1);
    expect(reopened.activeEntityKeys.size).toBe(1);
    lease.dispose();
  });

  it('keeps a secondary World primitive identity stable across composition reorder', () => {
    const worldA = new World();
    const worldB = new World();
    const leaseA = createRenderReadLease(worldA);
    const leaseB = createRenderReadLease(worldB);
    const cameraA = { ...makeZeroCameraFallbackSnapshot(), worldId: 0, entityKey: 10 };
    const candidateB = {
      ...snapshot(7, 1),
      worldId: 1,
      lods: [{ mesh: LOD_MESH_GUID, screenCoverage: 0.5 }],
      localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    } as RenderableSnapshot;
    const ordinaryA = snapshot(8, -1);
    const dispatchFor = (renderableIndex: number) => ({
      entityIndex: 7,
      materialHandle: 0,
      renderableIndex,
      passIndex: 0,
      queue: 2000,
      layer: 0,
      tags: {},
      renderState: undefined,
      defines: undefined,
      variantSet: undefined,
      vertexEntry: undefined,
      fragmentEntry: undefined,
      materialShaderId: 'forgeax::default-unlit',
      paramSnapshot: undefined,
    });
    const frameAB = {
      cameras: [cameraA],
      dispatch: [dispatchFor(1)],
      renderables: [ordinaryA, candidateB],
    } as unknown as ExtractedFrame;
    const persistent = new PersistentRenderScene();
    persistent.extractComposition(
      [worldA, worldB],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      () => frameAB,
      [leaseA, leaseB],
    );
    persistent.updateVisibilityFacet([worldA, worldB], cameraA, [ordinaryA, candidateB]);
    const viewA = viewKey({
      attachmentId: worldA.identity,
      cameraEntity: 10,
      viewRole: 'main',
      viewGeneration: 0,
    });
    const primitiveB = primitiveKey({
      attachmentId: worldA.identity,
      worldGeneration: 1,
      primitiveSlot: 1,
      slotGeneration: 0,
    });
    const facets = persistent.visibilityFacetStore();
    facets.applyConfidence(viewA, primitiveB, {
      type: 'result',
      samples: 0,
      submissionGeneration: 1,
    });
    facets.applyConfidence(viewA, primitiveB, {
      type: 'result',
      samples: 0,
      submissionGeneration: 2,
    });

    const reorderedCandidateB = { ...candidateB, worldId: 0 };
    const reorderedOrdinaryA = { ...ordinaryA, worldId: 1 };
    const cameraAReordered = { ...cameraA, worldId: 1 };
    const frameBA = {
      cameras: [cameraAReordered],
      dispatch: [dispatchFor(0)],
      renderables: [reorderedCandidateB, reorderedOrdinaryA],
    } as unknown as ExtractedFrame;
    persistent.extractComposition(
      [worldB, worldA],
      { cameraOwner: 1, resourceOwner: 1 },
      0,
      () => frameBA,
      [leaseB, leaseA],
    );
    persistent.updateVisibilityFacet([worldB, worldA], cameraAReordered, [reorderedCandidateB]);
    const projected = persistent.projectVisibility(
      [worldB, worldA],
      cameraAReordered,
      [reorderedCandidateB],
      [dispatchFor(0)],
    );
    expect(projected.suppressed).toBe(1);
    expect(projected.renderables).toHaveLength(0);
    leaseA.dispose();
    leaseB.dispose();
  });

  it('clears visibility facets when a same-World topology rebuild reuses slots', () => {
    const world = new World();
    const lease = createRenderReadLease(world);
    const camera = { ...makeZeroCameraFallbackSnapshot(), worldId: 0, entityKey: 10 };
    const candidate = {
      ...snapshot(7, 1),
      lods: [{ mesh: LOD_MESH_GUID, screenCoverage: 0.5 }],
      localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    } as RenderableSnapshot;
    const dispatch = {
      entityIndex: 7,
      materialHandle: 0,
      renderableIndex: 0,
      passIndex: 0,
      queue: 2000,
      layer: 0,
      tags: {},
      renderState: undefined,
      defines: undefined,
      variantSet: undefined,
      vertexEntry: undefined,
      fragmentEntry: undefined,
      materialShaderId: 'forgeax::default-unlit',
      paramSnapshot: undefined,
    };
    const frame = {
      cameras: [camera],
      dispatch: [dispatch],
      renderables: [candidate],
    } as unknown as ExtractedFrame;
    const persistent = new PersistentRenderScene();
    persistent.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, 0, () => frame, [
      lease,
    ]);
    persistent.updateVisibilityFacet([world], camera, [candidate]);
    const view = viewKey({
      attachmentId: world.identity,
      cameraEntity: 10,
      viewRole: 'main',
      viewGeneration: 0,
    });
    const before = persistent.compositionSlots()[0];
    const primitive = primitiveKey({
      attachmentId: world.identity,
      worldGeneration: 0,
      primitiveSlot: before?.slot ?? 0,
      slotGeneration: before?.generation ?? 0,
    });
    const facets = persistent.visibilityFacetStore();
    facets.applyConfidence(view, primitive, {
      type: 'result',
      samples: 0,
      submissionGeneration: 1,
    });
    facets.applyConfidence(view, primitive, {
      type: 'result',
      samples: 0,
      submissionGeneration: 2,
    });
    expect(persistent.projectVisibility([world], camera, [candidate], [dispatch]).suppressed).toBe(
      1,
    );

    // A real journal change forces the composition rebuild. The callback adds
    // a new renderable, so the previous slot generation could otherwise ABA
    // into the newly rebuilt projection.
    world.spawn({ component: Transform, data: {} }).unwrap();
    world.update().unwrap();
    const extra = { ...snapshot(8, 2), localAabb: candidate.localAabb };
    const rebuiltFrame = {
      cameras: [camera],
      dispatch: [dispatch, { ...dispatch, entityIndex: 8, renderableIndex: 1 }],
      renderables: [candidate, extra],
    } as unknown as ExtractedFrame;
    persistent.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      () => rebuiltFrame,
      [lease],
    );
    persistent.updateVisibilityFacet([world], camera, [candidate]);
    expect(persistent.projectVisibility([world], camera, [candidate], [dispatch]).suppressed).toBe(
      0,
    );
    lease.dispose();
  });
});

describe('RenderScene', () => {
  it('retains attached probe records through persistent frustum culling', () => {
    const scene = new PersistentRenderScene();
    const renderable = {
      ...snapshot(7, 0),
      localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    };
    const frame = {
      cameras: [],
      renderables: [renderable],
      dispatch: [],
      lightProbes: [
        {
          identity: 'probe-a',
          position: [0, 0, 0] as const,
          radius: 2,
          irradiance: new Float32Array(27).fill(1),
          admitted: true,
        },
      ],
    } as unknown as ExtractedFrame;

    const projected = scene.extractComposition(
      [{} as World],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      () => frame,
    );

    expect(projected.renderables[0]?.probeBlendRecord).toMatchObject({
      objectKey: 0,
      localBlendFraction: 1,
      accepted: true,
    });
  });

  it('keeps world identity slots stable across a composition reorder', () => {
    const scene = new RenderScene();
    const first = snapshot(1, 3);
    const second = { ...snapshot(1, 8), worldId: 1 };

    scene.reset([first, second]);
    const before = scene.slot(0, 1);
    scene.reset([second, first]);

    expect(scene.slotsSnapshot().map((entry) => [entry.worldId, entry.entityKey])).toEqual([
      [1, 1],
      [0, 1],
    ]);
    expect(scene.slot(0, 1)).toMatchObject({
      slot: before?.slot,
      generation: before?.generation,
    });
  });

  it('keeps one stable slot across reorder and reports no-change without scanning', () => {
    const scene = new RenderScene();
    scene.apply([
      { kind: 'create', snapshot: snapshot(7, 1) },
      { kind: 'create', snapshot: { ...snapshot(8, 2), worldId: 1 } },
    ]);

    const before = scene.slot(0, 7);
    scene.apply([]);
    const after = scene.slot(0, 7);

    expect(after).toMatchObject({ slot: before?.slot, generation: before?.generation });
    expect(scene.inspect()).toMatchObject({ noChangeFrames: 1, renderableScans: 0 });
  });

  it('indexes material and spatial facts from the same scene slots', () => {
    const scene = new RenderScene();
    scene.apply([
      {
        kind: 'create',
        snapshot: {
          ...snapshot(11, 4),
          localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
          material: { ...material, materialHandle: 42 },
          materials: [{ ...material, materialHandle: 42 }],
        },
      },
    ]);

    expect(scene.slotsForMaterial(42)).toHaveLength(1);
    expect(
      scene.querySpatial({ min: [2, -2, -2], max: [6, 2, 2] }).map((entry) => entry.entityKey),
    ).toEqual([11]);
  });

  it('refreshes spatial facts when a transform delta moves a slot', () => {
    const scene = new RenderScene();
    const initial = {
      ...snapshot(12, 0),
      localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    };
    scene.apply([{ kind: 'create', snapshot: initial }]);

    expect(scene.querySpatial({ min: [-2, -2, -2], max: [2, 2, 2] })).toHaveLength(1);

    const moved = new Float32Array(initial.transform.world);
    moved[12] = 10;
    scene.apply([{ kind: 'update-transform', worldId: 0, entityKey: 12, world: moved }]);

    expect(scene.querySpatial({ min: [-2, -2, -2], max: [2, 2, 2] })).toEqual([]);
    expect(scene.querySpatial({ min: [9, -2, -2], max: [11, 2, 2] })).toHaveLength(1);
  });
});
