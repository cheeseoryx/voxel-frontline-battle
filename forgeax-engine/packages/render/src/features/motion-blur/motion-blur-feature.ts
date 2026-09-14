import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { RenderError } from '../../errors/render';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../../render-pipeline';
import { SCENE_DATA_TEMPORAL_V1_SCHEMA } from '../../temporal/scene-data';
import { addTypedFullscreenPass } from '../../typed-render-graph-primitives';
import type { RenderFeaturePlan, RenderFeaturePlanContext } from '../plan';
import type { RenderFeature, RenderFeatureExtractContext } from '../types';
import {
  type MotionBlurParams,
  motionBlurTemporalDemand,
  validateMotionBlurParams,
} from './motion-blur-params';

export const MOTION_BLUR_FEATURE_IDENTITY = 'forgeax.motion-blur';

export function addMotionBlurPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: RenderPipelineTarget,
  temporal: RenderPipelineTarget,
  output: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  return addTypedFullscreenPass(graph, {
    name: 'motion-blur',
    shader: MOTION_BLUR_FEATURE_IDENTITY,
    input,
    additionalReads: [{ key: 'scene-temporal', target: temporal }],
    output,
  });
}

export interface MotionBlurFeatureFrame {
  readonly params: MotionBlurParams | undefined;
  readonly demanded: boolean;
}

export function planMotionBlur(
  params: MotionBlurParams,
  context: RenderFeaturePlanContext,
): Result<RenderFeaturePlan, RenderError> {
  if (!motionBlurTemporalDemand(params)) return ok({ resources: [], passes: [] });
  try {
    const temporal = context.sceneData.require(SCENE_DATA_TEMPORAL_V1_SCHEMA);
    const outputFormat =
      context.targets.find((target) => target.name === 'motion-output')?.format ?? 'rgba16float';
    return ok({
      resources: [
        {
          kind: 'fullscreen-program',
          name: 'motion-blur',
          source: 'forgeax::shader::motion-blur',
          reads: ['scene-color', 'scene-temporal'],
          params: { byteSize: 16, defaultValue: new Uint8Array(16) },
        },
        {
          kind: 'graphics-program',
          name: 'motion-blur-pipeline',
          program: {
            shader: MOTION_BLUR_FEATURE_IDENTITY,
            vertexLayout: 'none',
            colorFormats: [outputFormat],
            sampleCount: 1,
          },
        },
        {
          kind: 'graphics-bindings',
          name: 'motion-blur-bindings',
          program: 'motion-blur-pipeline',
          values: {
            group: 1,
            fullscreen: true,
            shader: MOTION_BLUR_FEATURE_IDENTITY,
            input: 'motion-input',
            temporal,
          },
          logicalTargets: { input: 'motion-input' },
        },
      ],
      passes: [
        {
          kind: 'raster',
          name: 'motion-blur',
          colorAttachments: [{ target: 'motion-output', loadOp: 'clear', storeOp: 'store' }],
          sampledTargets: ['motion-input', temporal],
          draws: [
            {
              program: 'motion-blur-pipeline',
              bindings: ['motion-blur-bindings'],
              vertexData: [],
              vertexLayout: 'none',
              draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
            },
          ],
        },
      ],
    });
  } catch (cause) {
    return err(cause as RenderError);
  }
}

export function createMotionBlurFeature(
  read: () => Partial<MotionBlurParams> | undefined,
): RenderFeature<MotionBlurFeatureFrame> {
  return Object.freeze({
    identity: MOTION_BLUR_FEATURE_IDENTITY,
    extract: (_context: RenderFeatureExtractContext) => {
      const input = read();
      const validated = validateMotionBlurParams(input);
      if (!validated.ok) return err(validated.error as unknown as RenderError);
      const params = input === undefined ? undefined : validated.value;
      return ok({ params, demanded: motionBlurTemporalDemand(params) });
    },
    plan: (frame: MotionBlurFeatureFrame, context: RenderFeaturePlanContext) =>
      frame.params === undefined
        ? ok({ resources: [], passes: [] })
        : planMotionBlur(frame.params, context),
  });
}
