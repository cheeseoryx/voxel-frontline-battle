import { World } from '@forgeax/engine-ecs';
import { Camera, type Renderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { createAppObservation } from '../observation';

describe('createAppObservation', () => {
  it('uses the first authored camera when ActiveCamera is absent', () => {
    const world = new World();
    const camera = world
      .spawn({ component: Transform, data: { pos: [1, 2, 3] } }, { component: Camera, data: {} })
      .unwrap();

    const observation = createAppObservation(world, {} as Renderer, { report: () => ({}) });
    expect(observation.camera.get()).toMatchObject({ entity: camera });
  });
});
