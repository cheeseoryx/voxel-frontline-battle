import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { attachDeviceLostFanout } from '../assembly/recovery/device-loss-fanout';
import {
  HealthListenerRegistry,
  LostListenerRegistry,
  RhiErrorListenerRegistry,
} from '../lifecycle';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('device loss fan-out generation fence', () => {
  it('counts a late old-generation notification without changing active health', async () => {
    const lost = deferred<{ readonly reason: 'unknown'; readonly message: string }>();
    const lostRegistry = new LostListenerRegistry();
    const errorRegistry = new RhiErrorListenerRegistry();
    const healthRegistry = new HealthListenerRegistry();
    const currentGeneration = 2;
    let staleLossEvents = 0;
    let lostEvents = 0;
    let healthEvents = 0;
    let errorEvents = 0;
    const device = { lost: lost.promise } as unknown as RhiDevice;
    lostRegistry.add(() => {
      lostEvents += 1;
    });
    healthRegistry.add(() => {
      healthEvents += 1;
    });
    errorRegistry.add(() => {
      errorEvents += 1;
    });

    attachDeviceLostFanout(
      device,
      { rhi },
      {
        lostRegistry,
        errorRegistry,
        healthRegistry,
        generation: 1,
        currentGeneration: () => currentGeneration,
        onStaleLoss: () => {
          staleLossEvents += 1;
        },
      },
    );

    lost.resolve({ reason: 'unknown', message: 'late retired-device notification' });
    await Promise.resolve();
    await Promise.resolve();

    expect(currentGeneration).toBe(2);
    expect(staleLossEvents).toBe(1);
    expect(lostEvents).toBe(0);
    expect(healthEvents).toBe(0);
    expect(errorEvents).toBe(0);
    expect(healthRegistry.getLastSnapshot().reason).toBe('alive');
  });

  it('uses the backend loss projection for deterministic recovery fixtures', async () => {
    const native = deferred<{ readonly reason: 'unknown'; readonly message: string }>();
    const projected = deferred<{ readonly reason: 'unknown'; readonly message: string }>();
    const lostRegistry = new LostListenerRegistry();
    const errorRegistry = new RhiErrorListenerRegistry();
    const healthRegistry = new HealthListenerRegistry();
    let lostEvents = 0;
    lostRegistry.add(() => {
      lostEvents += 1;
    });
    const device = { lost: native.promise } as unknown as RhiDevice;

    attachDeviceLostFanout(
      device,
      {
        rhi,
        instrumentation: {
          deviceLost: () => projected.promise,
        },
      },
      {
        lostRegistry,
        errorRegistry,
        healthRegistry,
        generation: 0,
        currentGeneration: () => 0,
      },
    );

    projected.resolve({ reason: 'unknown', message: 'fixture-projected loss' });
    await Promise.resolve();
    await Promise.resolve();

    expect(lostEvents).toBe(1);
    expect(healthRegistry.getLastSnapshot().reason).toBe('device-lost');
  });
});
