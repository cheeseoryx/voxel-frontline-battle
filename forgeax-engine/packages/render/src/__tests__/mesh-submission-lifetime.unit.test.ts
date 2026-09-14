import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';

it('fences ordinary mesh submissions independently of candidates, including reversed completion', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    undefined,
    () => {
      throw new Error('no cubemap');
    },
    device.caps,
  );
  const world = new World();
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const handle = world.allocSharedRef('MeshAsset', mesh);
  store.ensureResident(handle, mesh, world).unwrap();
  const original = store.getMeshGpuHandles(handle, world);
  if (original === undefined) throw new Error('mesh residency missing');
  let finishFirst!: () => void;
  let finishSecond!: () => void;
  const first = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const second = new Promise<void>((resolve) => {
    finishSecond = resolve;
  });
  store.trackMeshSubmission(first);
  store.trackMeshSubmission(second);
  const lease = store.retainMeshResidency(handle, world);
  if (lease === undefined) throw new Error('residency lease missing');
  store.invalidateMesh(handle, world);
  lease.release(true);
  expect(original.vertexBuffer.isDestroyed).toBe(false);
  // The same cache key can upload its replacement before old work completes.
  store.ensureResident(handle, mesh, world).unwrap();
  const replacement = store.getMeshGpuHandles(handle, world);
  if (replacement === undefined) throw new Error('replacement residency missing');
  expect(replacement).not.toBe(original);
  finishSecond();
  await second;
  expect(original.vertexBuffer.isDestroyed).toBe(false);
  finishFirst();
  await first;
  expect(original.vertexBuffer.isDestroyed).toBe(true);
  expect(store.getMeshGpuHandles(handle, world)).toBe(replacement);
  expect(replacement.vertexBuffer.isDestroyed).toBe(false);
  store.destroyAll();
});

it.each([
  'draw',
  'recovery',
] as const)('reuploads a recycled mesh slot on %s without evicting its replacement', async (path) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    undefined,
    () => {
      throw new Error('no cubemap');
    },
    device.caps,
  );
  const world = new World();
  const oldMesh = createBoxGeometry(1, 1, 1).unwrap();
  const oldHandle = world.allocSharedRef('MeshAsset', oldMesh);
  const oldEntry = store.ensureResident(oldHandle, oldMesh, world).unwrap();
  let finish!: () => void;
  const submitted = new Promise<void>((resolve) => {
    finish = resolve;
  });
  store.trackMeshSubmission(submitted);
  const lease = store.retainMeshResidency(oldHandle, world);
  if (lease === undefined) throw new Error('original residency lease missing');
  world.sharedRefs.release(oldHandle).unwrap();
  const nextMesh = createBoxGeometry(8, 2, 3).unwrap();
  const nextHandle = world.allocSharedRef('MeshAsset', nextMesh);
  expect(Number(nextHandle) & 0xffffff).toBe(Number(oldHandle) & 0xffffff);
  expect(nextHandle).not.toBe(oldHandle);
  expect(store.getMeshGpuHandles(nextHandle, world)).toBeUndefined();
  if (path === 'draw') store.ensureResident(nextHandle, nextMesh, world).unwrap();
  else store.prepareResidentForRecovery(nextHandle, nextMesh, world).unwrap();
  const nextEntry = store.getMeshGpuHandles(nextHandle, world);
  if (nextEntry === undefined) throw new Error('replacement residency missing');
  expect(nextEntry).toBeDefined();
  expect(nextEntry).not.toBe(oldEntry);
  expect(store.ensureResident(nextHandle, nextMesh, world).unwrap()).toBe(nextEntry);
  expect(store.getMeshGpuHandles(oldHandle, world)).toBeUndefined();
  expect(store.retainMeshResidency(oldHandle, world)).toBeUndefined();
  store.evictMesh(oldHandle, world);
  store.invalidateMesh(oldHandle, world);
  lease.release(true);
  expect(oldEntry.vertexBuffer.isDestroyed).toBe(false);
  finish();
  await submitted;
  expect(oldEntry.vertexBuffer.isDestroyed).toBe(true);
  expect(store.getMeshGpuHandles(nextHandle, world)).toBe(nextEntry);
  expect(nextEntry.vertexBuffer.isDestroyed).toBe(false);
  store.destroyAll();
});
