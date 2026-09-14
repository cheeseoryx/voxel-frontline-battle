// @perf-budget-skip: intentional full Renderer submit-failure and LKG recovery integration gate.
import { World } from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  perspective,
  TONEMAP_ACES_FILMIC,
  VolumetricFog,
} from '@forgeax/engine-render';
import type { CommandBuffer, RhiQueue } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi as nullRhi, RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { err, type Result, type TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderer } from '../createRenderer';

const VOLUME_MANIFEST = `data:application/json,${encodeURIComponent(
  JSON.stringify({
    entries: [
      { hash: 'pbr', wgsl: 'f_schlick', glsl: '', bindings: '' },
      { hash: 'unlit', wgsl: 'unlit', glsl: '', bindings: '' },
      { hash: 'tonemap', wgsl: 'struct TonemapParams {}', glsl: '', bindings: '' },
      { hash: 'volume-inject', wgsl: 'fn volume_inject() {}', glsl: '', bindings: '' },
      { hash: 'volume-integrate', wgsl: 'fn volume_integrate() {}', glsl: '', bindings: '' },
      { hash: 'volume-temporal', wgsl: 'fn volume_temporal() {}', glsl: '', bindings: '' },
      { hash: 'volume-composite', wgsl: 'fn volume_fs() {}', glsl: '', bindings: '' },
    ],
  }),
)}`;

function canvas(): HTMLCanvasElement {
  return { width: 64, height: 64, getContext: () => null } as unknown as HTMLCanvasElement;
}

function density(): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '3d', extent: { width: 64, height: 64, depth: 64 } },
    format: 'r8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(64 * 64 * 64).fill(32),
  };
}

function failingNullRhi(controller: { failNext: boolean }) {
  const adapter = new RhiNullAdapter();
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (options) => {
    const result = await requestDevice(options);
    if (!result.ok) return result;
    const queue: RhiQueue = result.value.queue;
    const submit = queue.submit.bind(queue);
    queue.submit = (buffers: readonly CommandBuffer[]): Result<void, RhiError> => {
      if (controller.failNext) {
        controller.failNext = false;
        return err(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'queue submission to succeed',
            hint: 'the recovery regression intentionally rejects one submit',
          }),
        );
      }
      return submit(buffers);
    };
    return result;
  };
  return {
    ...nullRhi,
    requestAdapter: async () => ({ ok: true, value: adapter }),
  };
}

describe('volumetric fog record recovery projection', () => {
  it('keeps accepted LKG inspection on a failed submit and clears it after repair', async () => {
    const controller = { failNext: false };
    const created = await createRenderer(
      canvas(),
      { rhi: failingNullRhi(controller) as never },
      { shaderManifestUrl: VOLUME_MANIFEST },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const renderer = created.value;

    const world = new World();
    const densityHandle = world.allocSharedRef('TextureAsset', density());
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        {
          component: Camera,
          data: {
            ...perspective({ fov: Math.PI / 4, aspect: 1 }),
            tonemap: TONEMAP_ACES_FILMIC,
          },
        },
      )
      .unwrap();
    const directionalLight = world
      .spawn({
        component: DirectionalLight,
        data: { direction: [-0.4, -0.8, -0.3], castShadow: true },
      })
      .unwrap();
    const fogEntity = world
      .spawn({
        component: VolumetricFog,
        data: {
          light: directionalLight,
          density: densityHandle,
          boundsMin: [-1, -1, -1],
          boundsMax: [1, 1, 1],
          extinction: [0.2, 0.2, 0.2],
          albedo: [0.8, 0.8, 0.8],
          emission: [0, 0, 0],
          anisotropy: 0,
          maxDistance: 50,
        },
      })
      .unwrap();
    expect(world.update(1 / 60).ok).toBe(true);

    const lease = renderer.attach(world);
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    const request = {
      leases: [lease.value],
      camera: { lease: lease.value },
      environment: { lease: lease.value },
    } as const;

    expect(renderer.draw(request).ok).toBe(true);
    expect(renderer.inspect().volumetricFog).toMatchObject({
      status: 'available',
      resourceStage: 'accepted',
      generation: 1,
      passCount: 4,
    });

    controller.failNext = true;
    expect(renderer.draw(request).ok).toBe(false);
    expect(renderer.inspect().volumetricFog).toMatchObject({
      status: 'degraded',
      resourceStage: 'lkg',
      generation: 1,
      lkgGeneration: 1,
      candidateGeneration: 1,
      candidateFailure: 'submit-failed',
      passCount: 4,
      // The packed high profile uses a 64x64x16 physical froxel texture,
      // representing 64 logical slices per pixel. Inspection reports the
      // descriptor-derived allocation bytes for this recovery fixture.
      sampleCount: 64 * 64 * 16,
      memoryBytes: 71808,
    });

    expect(renderer.draw(request).ok).toBe(true);
    expect(renderer.inspect().volumetricFog).toMatchObject({
      status: 'available',
      resourceStage: 'accepted',
      generation: 1,
      passCount: 4,
      candidateFailure: undefined,
    });

    expect(world.removeComponent(fogEntity, VolumetricFog).ok).toBe(true);
    expect(world.update(1 / 60).ok).toBe(true);
    expect(renderer.draw(request).ok).toBe(true);
    expect(renderer.inspect().volumetricFog).toMatchObject({
      status: 'off',
      passCount: 0,
      sampleCount: 0,
      memoryBytes: 0,
    });
    expect((await renderer.dispose()).ok).toBe(true);
  });
});
