import { expectTypeOf } from 'vitest';
import type { RenderFeaturePlan, RenderFeaturePlanContext, SceneDataTarget } from '../index';
import { SCENE_DATA_TEMPORAL_V1_SCHEMA, type SceneDataSchemaId } from '../temporal/scene-data';

declare const context: RenderFeaturePlanContext;
const target = context.sceneData.require(SCENE_DATA_TEMPORAL_V1_SCHEMA);

expectTypeOf(target).toEqualTypeOf<SceneDataTarget<typeof SCENE_DATA_TEMPORAL_V1_SCHEMA>>();
expectTypeOf<SceneDataSchemaId>().toEqualTypeOf<typeof SCENE_DATA_TEMPORAL_V1_SCHEMA>();
expectTypeOf(context.sceneData).toHaveProperty('require');

const plan: RenderFeaturePlan = {
  resources: [],
  passes: [
    {
      kind: 'raster',
      name: 'temporal-consumer',
      colorAttachments: [{ target: 'scene-color', loadOp: 'load', storeOp: 'store' }],
      sampledTargets: [target],
      draws: [],
    },
  ],
};

void plan;

const sampledRead = { target };
void sampledRead;

// @ts-expect-error unknown schema ids are not part of the closed v1 contract
context.sceneData.require('forgeax::scene-data::unknown-v1');

// @ts-expect-error a scene-data token is not a render attachment target
const attachmentTarget: 'scene-color' = target;
void attachmentTarget;
