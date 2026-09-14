import { createWorldContext, FixedTime, World } from '@forgeax/engine-ecs';
import { createBoxGeometry, meshFromInterleaved } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import { RigidBody, RigidBodyTypeValue } from '@forgeax/engine-physics';
import {
  createRapier3DPhysicsWorld,
  loadRapier3D,
  registerPhysicsSystems,
} from '@forgeax/engine-physics-rapier3d';
import {
  ANTIALIAS_TAA,
  Camera,
  DirectionalLight,
  type DynamicGeometryCandidate,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { ChildOf, propagateTransforms, scenePlugin, Transform } from '@forgeax/engine-scene';
import { err, type MeshAsset, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createRenderer } from '../createRenderer';

// Deterministic external geometry output: four boxes form an aperture.
// The Engine consumes an ordinary MeshAsset, without a voxel renderer.
function aperture(): MeshAsset {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (const [x, y, w, h] of [
    [-0.8, 0, 0.4, 2],
    [0.8, 0, 0.4, 2],
    [0, -0.8, 1.2, 0.4],
    [0, 0.8, 1.2, 0.4],
  ] as const) {
    const box = createBoxGeometry(w, h, 0.5).unwrap();
    const offset = vertices.length / 8;
    const { position, normal, uv } = box.attributes;
    if (position === undefined || normal === undefined || uv === undefined)
      throw new Error('box attribute closure');
    for (let i = 0; i < position.length / 3; i++) {
      vertices.push(
        (position[i * 3] ?? 0) + x,
        (position[i * 3 + 1] ?? 0) + y,
        position[i * 3 + 2] ?? 0,
        normal[i * 3] ?? 0,
        normal[i * 3 + 1] ?? 0,
        normal[i * 3 + 2] ?? 0,
        uv[i * 2] ?? 0,
        uv[i * 2 + 1] ?? 0,
      );
    }
    for (const index of box.indices) indices.push(index + offset);
  }
  return meshFromInterleaved(new Float32Array(vertices), new Uint16Array(indices)).unwrap();
}

it('atomically publishes physics and PBR apertures with shadow, parent motion and fresh TAA history', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 384;
  canvas.style.width = '384px';
  canvas.style.height = '384px';
  document.body.appendChild(canvas);
  const renderer = (
    await createRenderer(canvas, {}, { shaderManifestUrl: '/shaders/manifest.json' })
  ).unwrap();
  const errors: string[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error.code);
  });
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const physics = createRapier3DPhysicsWorld(rapier);
  world.insertResource('PhysicsWorld', physics);
  const releasePhysics = registerPhysicsSystems(world);
  try {
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [0.7, 0.24, 0.06, 1], metallic: 0.15, roughness: 0.45 }),
    );
    const gray = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [0.55, 0.6, 0.65, 1], metallic: 0, roughness: 0.8 }),
    );
    const closedMesh = createBoxGeometry(2, 2, 0.5).unwrap();
    const openMesh = aperture();
    const closedHandle = world.allocSharedRef('MeshAsset', closedMesh);
    const openHandle = world.allocSharedRef('MeshAsset', openMesh);
    const parent = world
      .spawn(
        { component: Transform, data: {} },
        { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
      )
      .unwrap();
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: ChildOf, data: { parent } },
        { component: MeshFilter, data: { assetHandle: closedHandle } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    const floor = world.allocSharedRef('MeshAsset', createBoxGeometry(7, 0.2, 7).unwrap());
    world
      .spawn(
        { component: Transform, data: { pos: [0, -1.25, 0] } },
        { component: MeshFilter, data: { assetHandle: floor } },
        { component: MeshRenderer, data: { materials: [gray] } },
      )
      .unwrap();
    const light = world
      .spawn({
        component: DirectionalLight,
        data: { direction: [-0.5, -0.9, -0.7], intensity: 3, castShadow: true },
      })
      .unwrap();
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 1, 7] } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 40 } },
      )
      .unwrap();
    const lease = renderer.attach(world).unwrap();
    const physicsInput = (revision: number, opened: boolean) => {
      const cells: [number, number, number][] = [];
      for (let x = -2; x <= 2; x++)
        for (let y = -2; y <= 2; y++) {
          if (!opened || Math.abs(x) === 2 || Math.abs(y) === 2) cells.push([x, y, 0]);
        }
      return {
        entity: parent,
        revision,
        sourceKey: 'wave1:slab',
        worldIdentity: world,
        bodyType: 'static' as const,
        shapes: [
          {
            id: 'slab',
            revision,
            cells,
            voxelSize: [0.4, 0.4, 0.5] as const,
            origin: [-0.2, -0.2, -0.25] as const,
          },
        ],
      };
    };
    const centerHit = () => physics.raycast(vec3.create(0, 0, 4), vec3.create(0, 0, -1), 8);
    world.update(1 / 60).unwrap();
    physics
      .admitDerivedShapeCandidate(
        physics.prepareDerivedShapeCandidate(physicsInput(1, false)).unwrap(),
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(centerHit()?.entity).toBe(parent);
    const draw = async () => {
      propagateTransforms(world).unwrap();
      const receipt = renderer
        .draw({ leases: [lease], camera: { lease }, environment: { lease } })
        .unwrap();
      (await receipt.completed).unwrap();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return receipt;
    };
    const shot = async (name: string) => {
      const value = await page
        .elementLocator(canvas)
        .screenshot({ path: `wave1-${name}.png`, base64: true });
      return typeof value === 'string' ? value : value.base64;
    };
    await draw();
    const closed = await shot('closed');
    const candidate = renderer
      .prepareDynamicGeometry({
        world,
        entity,
        physicsEntity: parent,
        mesh: openMesh,
        meshHandle: openHandle,
        revision: 2,
      })
      .unwrap();
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(closedHandle);
    await draw();
    expect(await shot('prepared')).toBe(closed);
    let accepted: DynamicGeometryCandidate | undefined;
    physics
      .admitDerivedShapeCandidate(
        physics.prepareDerivedShapeCandidate(physicsInput(2, true)).unwrap(),
        () => {
          const result = renderer.acceptDynamicGeometry(candidate, {
            world,
            fixedStep: world.getResource(FixedTime).tick,
          });
          if (!result.ok) return err(result.error);
          accepted = result.value;
          expect(
            renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
          ).toMatchObject({ ok: false, error: { code: 'frame-input-invalid' } });
          return ok(undefined);
        },
      )
      .unwrap();
    world.update(0).unwrap();
    expect(accepted).toBeUndefined();
    expect(centerHit()?.entity).toBe(parent);
    world.update(2 / 60).unwrap();
    expect(accepted).toBeDefined();
    if (accepted === undefined) throw new Error('paired admission did not run');
    expect(centerHit()).toBeUndefined();
    const frame = await draw();
    expect(renderer.dynamicGeometryReceipt(accepted)?.frameId).toBe(frame.frameId);
    const opened = await shot('open');
    expect(opened).not.toBe(closed);
    world.set(light, DirectionalLight, { castShadow: false }).unwrap();
    await draw();
    expect(await shot('no-shadow')).not.toBe(opened);
    world.set(light, DirectionalLight, { castShadow: true }).unwrap();
    world.set(parent, Transform, { pos: [0.75, 0, 0] }).unwrap();
    world.update(1 / 60).unwrap();
    await draw();
    expect(await shot('moved')).not.toBe(opened);
    const replacement = renderer
      .prepareDynamicGeometry({
        world,
        entity,
        physicsEntity: parent,
        mesh: closedMesh,
        meshHandle: closedHandle,
        materialIdentity: String(material),
        revision: 3,
      })
      .unwrap();
    world.set(entity, MeshRenderer, { materials: [gray] }).unwrap();
    physics
      .admitDerivedShapeCandidate(
        physics.prepareDerivedShapeCandidate(physicsInput(3, false)).unwrap(),
        () => {
          const result = renderer.acceptDynamicGeometry(replacement, {
            world,
            fixedStep: world.getResource(FixedTime).tick,
          });
          return result.ok ? ok(undefined) : err(result.error);
        },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(physics.getDerivedPublication(parent)?.revision).toBe(2);
    expect(physics.getDerivedFailure(parent)?.recovery).toBe('old-state-retained');
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(openHandle);
    renderer.cancelDynamicGeometry(replacement).unwrap();
    world.set(entity, MeshRenderer, { materials: [material] }).unwrap();
    const sealedCandidate = renderer
      .prepareDynamicGeometry({
        world,
        entity,
        physicsEntity: parent,
        mesh: closedMesh,
        meshHandle: closedHandle,
        revision: 4,
      })
      .unwrap();
    physics
      .admitDerivedShapeCandidate(
        physics.prepareDerivedShapeCandidate(physicsInput(4, false)).unwrap(),
        () => {
          const result = renderer.acceptDynamicGeometry(sealedCandidate, {
            world,
            fixedStep: world.getResource(FixedTime).tick,
          });
          return result.ok ? ok(undefined) : err(result.error);
        },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(physics.getDerivedPublication(parent)?.revision).toBe(4);
    await draw();
    renderer.retireDynamicGeometry(accepted as DynamicGeometryCandidate).unwrap();
    await shot('sealed');
    world.set(camera, Camera, { antialias: ANTIALIAS_TAA }).unwrap();
    for (let i = 0; i < 8; i++) await draw();
    await shot('taa-sealed');
    expect(renderer.inspect().temporal.mode).toBe('taa');
    expect(renderer.inspect().temporal.historyValid).toBe(true);
    expect(renderer.inspect().temporal.frameIndex).toBeGreaterThanOrEqual(7);
    const taaCandidate = renderer
      .prepareDynamicGeometry({
        world,
        entity,
        physicsEntity: parent,
        mesh: openMesh,
        meshHandle: openHandle,
        revision: 5,
      })
      .unwrap();
    physics
      .admitDerivedShapeCandidate(
        physics.prepareDerivedShapeCandidate(physicsInput(5, true)).unwrap(),
        () => {
          const result = renderer.acceptDynamicGeometry(taaCandidate, {
            world,
            fixedStep: world.getResource(FixedTime).tick,
          });
          return result.ok ? ok(undefined) : err(result.error);
        },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    await draw();
    expect(renderer.inspect().temporal.frameIndex).toBe(0);
    await shot('taa-open-first');
    expect(errors).toEqual([]);
  } finally {
    unsubscribe();
    await renderer.dispose();
    releasePhysics();
    const entities = [...world.query({ read: [Transform] }).unwrap()].map((row) => row.entity);
    for (const entity of entities.reverse()) world.despawn(entity).unwrap();
    await scene.fiber.dispose();
    physics.dispose();
    canvas.remove();
  }
}, 60000);
