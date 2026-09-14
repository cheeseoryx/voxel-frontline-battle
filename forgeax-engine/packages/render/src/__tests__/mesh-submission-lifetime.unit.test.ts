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
