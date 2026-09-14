import type {
  GraphTextureDescriptor,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';
import { createRenderPipelineTarget } from '../render-pipeline';
import { addTypedFullscreenPass, addTypedScenePass } from '../typed-render-graph-primitives';

export interface StandardTemporalDemandInput {
  readonly taa: boolean;
  readonly motionBlur: boolean;
}

export interface StandardTemporalDemand {
  readonly consumerIds: readonly ('taa' | 'motion-blur')[];
  readonly targetCount: 0 | 1;
  readonly producerPassCount: 0 | 1;
  readonly historyCount: 0 | 1;
}

export interface StandardTemporalDemandDescription {
  readonly consumerCount: number;
  readonly targetCount: 0 | 1;
  readonly producerPassCount: 0 | 1;
  readonly historyCount: 0 | 1;
  readonly byteLength: 0 | 1;
}

/** Aggregate all temporal consumers before any graph resource is allocated. */
export function aggregateTemporalDemand(
  input: StandardTemporalDemandInput,
): StandardTemporalDemand {
  const consumerIds = [
    ...(input.taa ? (['taa'] as const) : []),
    ...(input.motionBlur ? (['motion-blur'] as const) : []),
  ];
  const requested = consumerIds.length > 0;
  return Object.freeze({
    consumerIds: Object.freeze(consumerIds),
    targetCount: requested ? 1 : 0,
    producerPassCount: requested ? 1 : 0,
    historyCount: input.taa ? 1 : 0,
  });
}

export function describeTemporalDemand(
  demand: StandardTemporalDemand,
): StandardTemporalDemandDescription {
  return {
    consumerCount: demand.consumerIds.length,
    targetCount: demand.targetCount,
    producerPassCount: demand.producerPassCount,
    historyCount: demand.historyCount,
    byteLength: demand.targetCount,
  };
}

export type StandardTemporalLane = 'direct' | 'clustered' | 'cpu-webgl2' | 'rhi-null';

export type StandardTemporalLaneAdmission =
  | {
      readonly status: 'available';
      readonly schema: typeof import('./scene-data').SCENE_DATA_TEMPORAL_V1_SCHEMA;
      readonly producerId: 'forgeax::standard::scene-data';
      readonly structuralOnly: boolean;
      readonly format: 'rgba16float';
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'capability-missing' | 'producer-missing' | 'no-demand';
      readonly format?: never;
    };

export function standardTemporalLaneAdmission(input: {
  readonly lane: StandardTemporalLane;
  readonly demand: StandardTemporalDemand;
  readonly capabilities: {
    readonly compute: boolean;
    readonly storageBuffer: boolean;
    readonly rgba16floatRenderable: boolean;
    readonly filterable?: boolean;
    readonly copy?: boolean;
    readonly readback?: boolean;
    readonly producerPresent?: boolean;
  };
}): StandardTemporalLaneAdmission {
  if (input.demand.targetCount === 0) return { status: 'unavailable', reason: 'no-demand' };
  if (input.capabilities.producerPresent === false)
    return { status: 'unavailable', reason: 'producer-missing' };
  if (
    !input.capabilities.rgba16floatRenderable ||
    input.capabilities.filterable === false ||
    input.capabilities.copy === false ||
    input.capabilities.readback === false
  ) {
    return { status: 'unavailable', reason: 'capability-missing' };
  }
  return {
    status: 'available',
    schema: 'forgeax::scene-data::temporal-v1',
    producerId: 'forgeax::standard::scene-data',
    structuralOnly: input.lane === 'rhi-null',
    format: 'rgba16float',
  };
}

export function standardTemporalPostOrder(input: {
  readonly taa: boolean;
  readonly motionBlur: boolean;
  readonly bloom: boolean;
}): readonly string[] {
  const order = ['scene'];
  if (input.taa || input.motionBlur) order.push('standard-scene-data');
  if (input.taa) order.push('taa-resolve');
  if (input.motionBlur) order.push('motion-blur');
  if (input.bloom) order.push('bloom', 'tone');
  order.push('output');
  return Object.freeze(order);
}

export interface StandardSceneDataTargets {
  readonly temporal: RenderPipelineTarget;
}

const TEMPORAL_TARGET: GraphTextureDescriptor = {
  format: 'rgba16float',
  size: 'surface',
  sampleCount: 1,
};

/** The single Standard TAA current-frame producer target. */
export function createStandardSceneDataTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
): Result<StandardSceneDataTargets, RenderGraphError> {
  const temporal = createRenderPipelineTarget(graph, 'standard-scene-temporal', TEMPORAL_TARGET);
  return temporal.ok ? ok({ temporal: temporal.value }) : temporal;
}

export function addStandardSceneDataPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  target: RenderPipelineTarget,
  depth: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  return addTypedScenePass(graph, {
    name: 'standard-scene-data',
    color: target,
    depth,
    selector: { LightMode: ['Deferred', 'Forward'] },
    passKind: 'temporal',
    // The temporal producer re-rasterizes the current scene after the main
    // color pass has populated depth. Its output is a semantic motion target;
    // it must cover the same fragments even when TAA jitter moves the raster
    // edge by a subpixel, while the loaded scene depth remains the consumer's
    // depth-rejection source for Motion Blur/TAA.
    clearColor: [0, 0, -1, 1],
    colorLoadOp: 'clear',
    depthLoadOp: 'load',
  });
}

export function addTaaResolvePass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  current: RenderPipelineTarget,
  currentTemporal: RenderPipelineTarget,
  previousColor: RenderPipelineTarget,
  previousTemporal: RenderPipelineTarget,
  output: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  return addTypedFullscreenPass(graph, {
    name: 'taa-resolve',
    shader: 'forgeax.taa-resolve',
    input: current,
    output,
    additionalReads: [
      { key: 'scene-temporal', target: currentTemporal },
      { key: 'taa-history-color', target: previousColor },
      { key: 'taa-history-temporal', target: previousTemporal },
    ],
  });
}
