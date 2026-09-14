import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { InstanceProjectionStore } from '../instances';

function matrices(x: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
}

describe('renderer instance projection', () => {
  it('derives independent complete snapshots for consumers that skip different updates', () => {
    const world = new World();
    const first = new InstanceProjectionStore();
    const late = new InstanceProjectionStore();
    const before = first.project(world, 1, matrices(0));
    late.project(world, 1, matrices(0));
    first.project(world, 1, matrices(1));
    first.project(world, 1, matrices(2));
    const latest = late.project(world, 1, matrices(2));
    expect(before.transforms[12]).toBe(0);
    expect(latest.transforms[12]).toBe(2);
    const stable = late.project(world, 1, matrices(2));
    expect(stable.transforms).toBe(latest.transforms);
    expect(stable.revision).toBe(latest.revision);
  });

  it('does not alias identical entity numbers across World identities', () => {
    const projection = new InstanceProjectionStore();
    const a = projection.project(new World(), 1, matrices(10));
    const b = projection.project(new World(), 1, matrices(99));
    expect(a.collectionId).not.toBe(b.collectionId);
    expect(a.transforms[12]).toBe(10);
    expect(b.transforms[12]).toBe(99);
  });

  it('rebuilds from unchanged source after dropping renderer resources', () => {
    const world = new World();
    const transforms = matrices(4);
    const projection = new InstanceProjectionStore();
    projection.project(world, 1, transforms);
    projection.dispose();
    expect(projection.project(world, 1, transforms).transforms).toEqual(transforms);
    expect(new InstanceProjectionStore().project(world, 1, transforms).transforms).toEqual(
      transforms,
    );
  });
});
