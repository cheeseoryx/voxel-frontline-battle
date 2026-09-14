import { FixedTime, FixedUpdate, Time, World } from '@forgeax/engine-ecs';
import type { FrameReceipt, Renderer } from '@forgeax/engine-render';
import { describe, expect, it, vi } from 'vitest';

import { createFrameLoop } from '../internal/frame-loop';

function renderer(): Renderer {
  return {
    state: () => 'alive' as const,
    backend: 'webgpu',
    ready: Promise.resolve({ ok: true, value: undefined }),
    attach: () => ({ ok: true, value: undefined }),
    detachWorld: () => {},
    draw: () => ({ ok: true, value: undefined }),
    onError: () => () => {},
    onLost: () => () => {},
    dispose: () => {},
  } as unknown as Renderer;
}

function scheduler() {
  let callback: ((timestamp: number) => void) | undefined;
  return {
    raf: (next: (timestamp: number) => void): number => {
      callback = next;
      return 1;
    },
    caf: (): void => {
      callback = undefined;
    },
    tick(timestamp: number): void {
      const next = callback;
      callback = undefined;
      next?.(timestamp);
    },
  };
}

function deferredReceipt(frameId: number): {
  readonly receipt: FrameReceipt;
  readonly settle: () => void;
  readonly reject: (cause: unknown) => void;
} {
  let resolve!: (value: { ok: true; value: undefined }) => void;
  let reject!: (cause: unknown) => void;
  const completed = new Promise<{ ok: true; value: undefined }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    receipt: { frameId, deviceGeneration: 0, completed: completed as FrameReceipt['completed'] },
    settle: () => resolve({ ok: true, value: undefined }),
    reject,
  };
}

function receiptRenderer(draw: () => { ok: true; value: FrameReceipt }): Renderer {
  return {
    backend: 'webgpu',
    ready: Promise.resolve({ ok: true, value: undefined }),
    attach: () => ({ ok: true, value: { dispose: () => {} } }),
    detachWorld: () => {},
    draw,
    onError: () => () => {},
    onLost: () => () => {},
    dispose: () => {},
  } as unknown as Renderer;
}

describe('frame-loop Time forwarding', () => {
  it.each([
    [60, 1],
    [30, 1],
    [60, 2],
    [60, 3],
  ])('preserves simulated time at %i Hz with receipts settling every %i ticks', async (hz, cadence) => {
    // ai-weapon-spirit: slow GPU receipts must not slow the game clock.
    const world = new World();
    const injected = new World();
    world.addSystem(FixedUpdate, { name: 'clock-probe', queries: [], fn: () => {} }).unwrap();
    const clock = scheduler();
    const pending: ReturnType<typeof deferredReceipt>[] = [];
    let timestamp = 0;
    let frameId = 0;
    const onError = vi.fn();
    const loop = createFrameLoop({
      world,
      renderer: receiptRenderer(() => {
        const frame = deferredReceipt(++frameId);
        pending.push(frame);
        return { ok: true, value: frame.receipt };
      }),
      now: () => timestamp,
      raf: clock.raf,
      caf: clock.caf,
      drawSource: () => ({ worlds: [world, injected], cameraOwner: 0, resourceOwner: 0 }),
      onError,
    });
    loop.start().unwrap();
    for (let tick = 1; tick <= hz * 10; tick++) {
      if (tick % cadence === 0) {
        pending.shift()?.settle();
        await Promise.resolve();
      }
      timestamp = (tick * 1000) / hz;
      clock.tick(timestamp);
    }
    loop.stop().unwrap();
    for (const receipt of pending) receipt.settle();
    await loop.drainFrameReceipts();

    expect(onError).not.toHaveBeenCalled();
    expect(loop.inspect().highWater).toBeLessThanOrEqual(2);
    expect(loop.inspect().throttledTicks > 0).toBe(cadence > 1);
    expect(world.getResource(Time).elapsed).toBeCloseTo(10, 8);
    expect(injected.getResource(Time).elapsed).toBeCloseTo(10, 8);
    expect(world.getResource(FixedTime).tick).toBeGreaterThanOrEqual(599);
    expect(world.getResource(FixedTime).droppedSeconds).toBe(0);
  });

  it('forwards one measured delta to own and injected Worlds', () => {
    const own = new World();
    const injected = new World();
    const clock = scheduler();
    const loop = createFrameLoop({
      world: own,
      renderer: renderer(),
      now: (() => {
        const values = [1000, 1016];
        return () => values.shift() ?? 1016;
      })(),
      raf: clock.raf,
      caf: clock.caf,
      drawSource: () => ({ worlds: [own, injected], cameraOwner: 0, resourceOwner: 0 }),
    });

    loop.start().unwrap();
    clock.tick(1016);

    expect(own.getResource(Time).delta).toBeCloseTo(0.016);
    expect(injected.getResource(Time).delta).toBeCloseTo(0.016);
  });

  it('limits ordinary frames to two in-flight receipts and reports throttle/settle counts', async () => {
    const own = new World();
    const clock = scheduler();
    const first = deferredReceipt(1);
    const second = deferredReceipt(2);
    const third = deferredReceipt(3);
    const receipts = [first, second, third] as const;
    let drawIndex = 0;
    const draw = vi.fn(() => {
      const receipt = receipts[drawIndex++];
      if (receipt === undefined) throw new Error('test renderer ran out of receipts');
      return { ok: true as const, value: receipt.receipt };
    });
    const loop = createFrameLoop({
      world: own,
      renderer: receiptRenderer(draw),
      now: () => 1000,
      raf: clock.raf,
      caf: clock.caf,
    });

    loop.start().unwrap();
    clock.tick(1016);
    clock.tick(1032);
    clock.tick(1048);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(loop.inspect()).toEqual({
      submitted: 2,
      completed: 0,
      inFlight: 2,
      highWater: 2,
      throttledTicks: 1,
    });

    first.settle();
    await Promise.resolve();
    expect(loop.inspect()).toMatchObject({ submitted: 2, completed: 1, inFlight: 1 });
    clock.tick(1064);
    expect(draw).toHaveBeenCalledTimes(3);
    expect(loop.inspect()).toMatchObject({ submitted: 3, completed: 1, inFlight: 2 });
    loop.stop().unwrap();
  });

  it('settles rejected receipts and routes the failure without an unhandled rejection', async () => {
    const own = new World();
    const clock = scheduler();
    const first = deferredReceipt(1);
    const second = deferredReceipt(2);
    const pending = [first, second] as const;
    let drawIndex = 0;
    const onError = vi.fn();
    const draw = vi.fn(() => {
      const receipt = pending[drawIndex++];
      if (receipt === undefined) throw new Error('test renderer ran out of receipts');
      return { ok: true as const, value: receipt.receipt };
    });
    const loop = createFrameLoop({
      world: own,
      renderer: receiptRenderer(draw),
      onError,
      now: () => 1000,
      raf: clock.raf,
      caf: clock.caf,
    });

    loop.start().unwrap();
    clock.tick(1016);
    clock.tick(1032);
    second.reject(new Error('queue completion failed'));
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'app-system-update-failed' });
    expect(loop.inspect()).toEqual({
      submitted: 2,
      completed: 1,
      inFlight: 1,
      highWater: 2,
      throttledTicks: 0,
    });
    first.settle();
    await Promise.resolve();
    expect(loop.inspect()).toMatchObject({ submitted: 2, completed: 2, inFlight: 0 });
    loop.stop().unwrap();
  });

  it('drains all pending frame receipts without changing credit accounting', async () => {
    const own = new World();
    const clock = scheduler();
    const first = deferredReceipt(1);
    const second = deferredReceipt(2);
    let drawIndex = 0;
    const receipts = [first, second] as const;
    const loop = createFrameLoop({
      world: own,
      renderer: receiptRenderer(() => {
        const receipt = receipts[drawIndex++];
        if (receipt === undefined) throw new Error('renderer ran out of test receipts');
        return { ok: true as const, value: receipt.receipt };
      }),
      now: () => 1000,
      raf: clock.raf,
      caf: clock.caf,
    });

    loop.start().unwrap();
    clock.tick(1016);
    clock.tick(1032);
    const drained = loop.drainFrameReceipts();
    let settled = false;
    void drained.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    first.settle();
    await Promise.resolve();
    expect(settled).toBe(false);
    second.settle();
    await drained;
    expect(settled).toBe(true);
    expect(loop.inspect()).toMatchObject({ submitted: 2, completed: 2, inFlight: 0 });
    loop.stop().unwrap();
  });
});
