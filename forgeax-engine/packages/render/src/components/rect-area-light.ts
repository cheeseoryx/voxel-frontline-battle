// @forgeax/engine-render - single-sided rectangular area-light authoring facts.

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Single-sided rectangular area light. Transform supplies the center and
 * world orientation; width and height remain authored emitter dimensions.
 */
export const RectAreaLight = defineComponent('RectAreaLight', {
  color: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
  intensity: { type: 'f32', default: 1 },
  width: { type: 'f32', default: 1 },
  height: { type: 'f32', default: 1 },
  range: { type: 'f32', default: 10 },
});
