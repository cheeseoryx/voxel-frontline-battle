import {
  type GraphAccess,
  type GraphTextureDescriptor,
  type RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import { SceneDataUnavailableError, StandardProfileInvalidError } from '../errors/render';
import type { FramePlan } from '../extract/environment';
import { DEFERRED_COLOR_FORMATS } from '../pipeline-spec';
import type {
  RenderPipeline,
  RenderPipelineBuildContext,
  RenderPipelineFrame,
  RenderPipelineTopology,
} from '../render-pipeline';
import {
  createRenderPipelineTarget,
  importRenderPipelineSurface,
  type RenderPipelineTarget,
} from '../render-pipeline';
import {
  addStandardSceneDataPass,
  aggregateTemporalDemand,
  createStandardSceneDataTarget,
  standardTemporalLaneAdmission,
} from '../temporal/standard-scene-data';
import {
  addTransmissionBackdropPasses,
  addTransmissionBackdropTemporalPass,
  resolveTransmissionBackdropTopology,
  transmissionDemandForTopology,
} from '../transmission/backdrop';
import {
  addTypedFrameObservationPass,
  addTypedScenePass,
  addTypedSkyboxPass,
  addTypedSsaoPasses,
  typedFrameClearColor,
} from '../typed-render-graph-primitives';
import { addTypedShadowPasses } from '../typed-shadow-passes';
import { addAuthoredVolumetricFogPasses } from '../volume/passes';
import { buildStandardForwardLane } from './standard-forward-lane';
import {
  addStandardClusterMembershipPass,
  importStandardClusterBuffers,
  standardClusterReadAccesses,
} from './standard-lighting/graph';
import {
  deriveStandardTopologyInput,
  type StandardTopologyInputValue,
} from './standard-lighting/topology';
import { addStandardPost } from './standard-post';
import {
  DEFAULT_STANDARD_PROFILE,
  STANDARD_LIGHT_COUNTS,
  STANDARD_PIPELINE_ID,
  type StandardProfile,
} from './standard-profile';

/** WGSL owner for the Standard clustered membership producer. */
export const STANDARD_CLUSTER_MEMBERSHIP_WGSL = /* wgsl */ `
struct ClusterUniform {
  grid : vec4<u32>,
  near_far_log : vec4<f32>,
};

@group(0) @binding(0) var<storage, read> cluster_grid : array<u32>;
@group(0) @binding(1) var<storage, read_write> light_index_list : array<u32>;
@group(0) @binding(2) var<uniform> cluster_uniform : ClusterUniform;
@group(0) @binding(3) var<storage, read> light_bounds : array<i32>;

@compute @workgroup_size(64)
fn cs_cluster_membership(@builtin(global_invocation_id) global_id : vec3<u32>) {
  let cluster_index = global_id.x;
  let grid_x = cluster_uniform.grid.x;
  let grid_y = cluster_uniform.grid.y;
  let grid_z = cluster_uniform.grid.z;
  let cluster_count = grid_x * grid_y * grid_z;
  if (cluster_index >= cluster_count) {
    return;
  }

  let cluster_x = cluster_index % grid_x;
  let cluster_yz = cluster_index / grid_x;
  let cluster_y = cluster_yz % grid_y;
  let cluster_z = cluster_yz / grid_y;
  let grid_offset = cluster_index * 2u;
  let output_offset = cluster_grid[grid_offset];
  let output_count = cluster_grid[grid_offset + 1u];
  let cluster_x_i = i32(cluster_x);
  let cluster_y_i = i32(cluster_y);
  let cluster_z_i = i32(cluster_z);
  var output_index = output_offset;

  var light_index = 0u;
  loop {
    if (light_index >= cluster_uniform.grid.w || light_index >= 256u) {
      break;
    }
    let bounds_offset = light_index * 6u;
    let min_x = light_bounds[bounds_offset];
    if (min_x >= 0) {
      let min_y = light_bounds[bounds_offset + 1u];
      let min_z = light_bounds[bounds_offset + 2u];
      let max_x = light_bounds[bounds_offset + 3u];
      let max_y = light_bounds[bounds_offset + 4u];
      let max_z = light_bounds[bounds_offset + 5u];
      if (
        cluster_x_i >= min_x && cluster_x_i <= max_x &&
        cluster_y_i >= min_y && cluster_y_i <= max_y &&
        cluster_z_i >= min_z && cluster_z_i <= max_z
      ) {
        if (output_index < output_offset + output_count) {
          light_index_list[output_index] = light_index;
          output_index += 1u;
        }
      }
    }
    light_index += 1u;
  }
}
`;
export function validateClusterGrid(grid: {
  x: number;
  y: number;
  z: number;
}): Result<{ x: number; y: number; z: number }, StandardProfileInvalidError> {
  const { x, y, z } = grid;
  return Number.isInteger(x) &&
    Number.isInteger(y) &&
    Number.isInteger(z) &&
    x >= 1 &&
    x <= 64 &&
    y >= 1 &&
    y <= 64 &&
    z >= 1 &&
    z <= 64
    ? ok({ x, y, z })
    : err(
        new StandardProfileInvalidError(
          `clusterGrid {x:${x}, y:${y}, z:${z}} is invalid; set x, y, and z to positive integers in [1, 64]`,
          { field: 'clusterGrid', actual: { x, y, z } },
        ),
      );
}

function target(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  descriptor: GraphTextureDescriptor,
): Result<RenderPipelineTarget, RenderGraphError> {
  return createRenderPipelineTarget(graph, label, descriptor);
}

function buildStandardDeferredLane(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  lighting: StandardTopologyInputValue,
): ReturnType<RenderPipeline['build']> {
  const graph = context.graph;
  const surface = importRenderPipelineSurface(graph, topology);
  if (!surface.ok) return surface;
  const buffers = importStandardClusterBuffers(graph, lighting);
  if (!buffers.ok) return buffers;
  const membership =
    buffers.value === null
      ? ok(undefined)
      : addStandardClusterMembershipPass(graph, lighting, buffers.value);
  if (!membership.ok) return membership;
  const shadows = addTypedShadowPasses(graph, topology);
  if (!shadows.ok) return shadows;

  const depth = target(graph, 'hdrp-depth', {
    format: 'depth24plus-stencil8',
    size: 'surface',
  });
  if (!depth.ok) return depth;
  const gbuffer0 = target(graph, 'gbuffer-normal-roughness', {
    format: DEFERRED_COLOR_FORMATS[0] ?? 'rgba16float',
    size: 'surface',
  });
  if (!gbuffer0.ok) return gbuffer0;
  const gbuffer1 = target(graph, 'gbuffer-albedo-metallic', {
    format: DEFERRED_COLOR_FORMATS[1] ?? 'rgba8unorm',
    size: 'surface',
  });
  if (!gbuffer1.ok) return gbuffer1;
  const gbuffer2 = target(graph, 'gbuffer-emissive-ao', {
    format: DEFERRED_COLOR_FORMATS[2] ?? 'rgba16float',
    size: 'surface',
  });
  if (!gbuffer2.ok) return gbuffer2;
  const scene = target(graph, 'hdrp-scene-color', { format: 'rgba16float', size: 'surface' });
  if (!scene.ok) return scene;
  const temporalDemand = aggregateTemporalDemand({
    taa: topology.camera.antialias === 'taa',
    motionBlur: topology.temporal?.motionBlur === true,
  });
  const temporalLane = topology.lane.compute ? 'clustered' : 'cpu-webgl2';
  const temporalAdmission = standardTemporalLaneAdmission({
    lane: temporalLane,
    demand: temporalDemand,
    capabilities: {
      compute: topology.lane.compute,
      storageBuffer: topology.lane.storageBuffer,
      rgba16floatRenderable: context.capabilities?.rgba16floatRenderable ?? false,
    },
  });
  if (temporalAdmission.status === 'unavailable' && temporalAdmission.reason !== 'no-demand') {
    return err(
      new SceneDataUnavailableError({
        featureIdentity: 'forgeax::standard',
        schema: 'forgeax::scene-data::temporal-v1',
        lane: temporalLane,
        reason: temporalAdmission.reason,
        missingContributorIds: [],
        omittedMissingContributorCount: 0,
        recovery: 'enable-capability',
      }),
    );
  }
  const gpuDriven = context.projectGpuDriven({
    format: scene.value.format,
    sampleCount: scene.value.sampleCount,
  });
  if (!gpuDriven.ok) return gpuDriven;
  const gbuffer = addTypedScenePass(graph, {
    name: 'g-buffer',
    color: gbuffer0.value,
    colorTargets: [gbuffer0.value, gbuffer1.value, gbuffer2.value],
    depth: depth.value,
    selector: { LightMode: ['Deferred'] },
    passKind: 'deferred',
    clearColor: [0, 0, 0, 0],
  });
  if (!gbuffer.ok) return gbuffer;

  let ssao: RenderPipelineTarget | undefined;
  if (topology.config?.ssao?.enabled === true) {
    const raw = target(graph, 'ssao-raw', { format: 'r8unorm', size: 'half-surface' });
    if (!raw.ok) return raw;
    const blurred = target(graph, 'ssao-blurred', { format: 'r8unorm', size: 'half-surface' });
    if (!blurred.ok) return blurred;
    const passes = addTypedSsaoPasses(graph, {
      normal: gbuffer0.value,
      depth: depth.value,
      raw: raw.value,
      blurred: blurred.value,
    });
    if (!passes.ok) return passes;
    ssao = blurred.value;
  }

  const lightingAccesses: GraphAccess[] = [
    { resource: gbuffer0.value.view, usage: 'sampled-read' },
    { resource: gbuffer1.value.view, usage: 'sampled-read' },
    { resource: gbuffer2.value.view, usage: 'sampled-read' },
    { resource: depth.value.view, usage: 'depth-stencil-read' },
    ...(buffers.value === null ? [] : standardClusterReadAccesses(buffers.value)),
    ...(ssao === undefined
      ? []
      : ([{ resource: ssao.view, usage: 'sampled-read' }] satisfies GraphAccess[])),
    { resource: scene.value.view, usage: 'color-attachment' },
  ];
  const lightingPass = graph.addRasterPass('lighting', {
    accesses: lightingAccesses,
    colorAttachments: [
      {
        view: scene.value.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: typedFrameClearColor,
      },
    ],
    encode: () => undefined,
  });
  if (!lightingPass.ok) return lightingPass;

  const skybox = addTypedSkyboxPass(graph, scene.value);
  if (!skybox.ok) return skybox;

  const transmissionDemand = transmissionDemandForTopology(topology);
  const transmissionActive = resolveTransmissionBackdropTopology({
    demand: transmissionDemand,
    sourceSampleCount: scene.value.sampleCount,
  }).active;
  const forwardExtraAccesses: GraphAccess[] =
    buffers.value === null ? [] : [...standardClusterReadAccesses(buffers.value)];

  const forward = addTypedScenePass(graph, {
    name: 'forward',
    color: scene.value,
    depth: depth.value,
    selector: { LightMode: ['Forward'] },
    colorLoadOp: 'load',
    depthLoadOp: 'clear',
    sampled: [
      gbuffer0.value,
      gbuffer1.value,
      gbuffer2.value,
      ...(shadows.value.directional === undefined ? [] : [shadows.value.directional]),
      shadows.value.spot,
      ...(shadows.value.point === undefined ? [] : [shadows.value.point]),
      ...(ssao === undefined ? [] : [ssao]),
    ],
    ...(shadows.value.directional === undefined
      ? {}
      : { directionalShadow: shadows.value.directional }),
    spotShadow: shadows.value.spot,
    ...(ssao === undefined ? {} : { ssao }),
    ...(gpuDriven.value === undefined ? {} : { gpuDriven: gpuDriven.value }),
    passKind: 'forward',
    ...(transmissionActive ? { recordMode: 'opaque' as const } : {}),
    ...(context.occlusion === undefined ? {} : { occlusion: context.occlusion }),
    extraAccesses: forwardExtraAccesses,
  });
  if (!forward.ok) return forward;

  const temporal =
    temporalDemand.targetCount === 1 ? createStandardSceneDataTarget(graph) : ok(undefined);
  if (!temporal.ok) return temporal;
  if (temporal.value !== undefined) {
    const producer = addStandardSceneDataPass(graph, temporal.value.temporal, depth.value);
    if (!producer.ok) return producer;
  }
  const transmission = addTransmissionBackdropPasses({
    graph,
    source: scene.value,
    demand: transmissionDemand,
    copySize: { width: topology.surface.width, height: topology.surface.height },
    encodeRoughMip: context.encodeTransmissionMip,
    includeConsumerPasses: false,
  });
  if (!transmission.ok) return transmission;
  if (transmission.value.topology.active) {
    const transmissionPass = addTypedScenePass(graph, {
      name: 'transmission-forward',
      color: scene.value,
      depth: depth.value,
      selector: { LightMode: ['Forward'] },
      colorLoadOp: 'load',
      depthLoadOp: 'load',
      sampled: [
        gbuffer0.value,
        gbuffer1.value,
        gbuffer2.value,
        ...(shadows.value.directional === undefined ? [] : [shadows.value.directional]),
        shadows.value.spot,
        ...(shadows.value.point === undefined ? [] : [shadows.value.point]),
        ...(ssao === undefined ? [] : [ssao]),
      ],
      directionalShadow: shadows.value.directional,
      spotShadow: shadows.value.spot,
      ...(ssao === undefined ? {} : { ssao }),
      passKind: 'forward',
      recordMode: 'transmission',
      // Inject the complete backdrop view so the Standard shader can select
      // the producer's optional roughness mip level. mipViews[0] is only the
      // copy destination view and intentionally exposes one level.
      transmissionBackdrop: transmission.value.backdrop?.view,
      extraAccesses: forwardExtraAccesses,
    });
    if (!transmissionPass.ok) return transmissionPass;

    const transparentPass = addTypedScenePass(graph, {
      name: 'transparent',
      color: scene.value,
      depth: depth.value,
      selector: { LightMode: ['Forward'] },
      colorLoadOp: 'load',
      depthLoadOp: 'load',
      sampled: [
        gbuffer0.value,
        gbuffer1.value,
        gbuffer2.value,
        ...(shadows.value.directional === undefined ? [] : [shadows.value.directional]),
        shadows.value.spot,
        ...(shadows.value.point === undefined ? [] : [shadows.value.point]),
        ...(ssao === undefined ? [] : [ssao]),
      ],
      directionalShadow: shadows.value.directional,
      spotShadow: shadows.value.spot,
      ...(ssao === undefined ? {} : { ssao }),
      passKind: 'forward',
      recordMode: 'transparent',
      extraAccesses: forwardExtraAccesses,
    });
    if (!transparentPass.ok) return transparentPass;
    const temporal = addTransmissionBackdropTemporalPass(graph, scene.value);
    if (!temporal.ok) return temporal;
  }
  if (topology.volumetricFog?.enabled === true) {
    const depthSample = graph.view(depth.value.texture, {
      label: 'scene-depth.sample',
      dimension: '2d',
      aspect: 'depth-only',
    });
    if (!depthSample.ok) return depthSample;
    const volume = addAuthoredVolumetricFogPasses(
      graph,
      topology,
      scene.value,
      depthSample.value,
      shadows.value.directional?.view,
      shadows.value.spot.view,
      buffers.value,
    );
    if (!volume.ok) return volume;
  }
  // The volume-composite pass remains in linear HDR before tone mapping.

  const features = context.contributeFeatures([
    {
      name: 'linear-hdr',
      kind: 'scene-color',
      texture: scene.value.texture,
      view: scene.value.view,
      format: scene.value.format,
      sampleCount: 1,
    },
    {
      kind: 'scene-depth',
      texture: depth.value.texture,
      view: depth.value.view,
      format: depth.value.format,
      sampleCount: 1,
    },
  ]);
  if (!features.ok) return features;
  const observation = addTypedFrameObservationPass(graph, scene.value, 'forgeax::standard');
  if (!observation.ok) return observation;
  const post = addStandardPost(
    context,
    topology,
    scene.value,
    depth.value,
    surface.value,
    temporal.value?.temporal,
  );
  if (!post.ok) return post;
  const cubeCaptures = context.contributeCubeCaptures?.();
  if (cubeCaptures !== undefined && !cubeCaptures.ok) return cubeCaptures;
  return ok(undefined);
}
export interface StandardPipeline extends RenderPipeline {
  readonly identity: typeof STANDARD_PIPELINE_ID;
}

export function standardProfileSupportsReflectionProbes(_profile: StandardProfile): boolean {
  return true;
}

/** Standard graph inputs are derived once from the immutable frame plan. */
export type StandardFramePlan = FramePlan;

function profileFor(topology: RenderPipelineTopology): StandardProfile {
  return topology.standardProfile ?? DEFAULT_STANDARD_PROFILE;
}

function resolveStandardTopologyInput(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
): Result<StandardTopologyInputValue, RenderGraphError> {
  const supplied = context.standardLighting;
  if (supplied !== undefined) {
    const derived = deriveStandardTopologyInput(supplied);
    if (derived.ok) return derived;
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'Forward/Deferred consume one prepared Standard topology input',
        hint: derived.error.hint,
        detail: {
          resourceLabel: 'forgeax::standard',
          field: `standardLighting.${derived.error.detail.field}`,
          expected: derived.error.expected,
          actual: 'invalid',
        },
      }),
    );
  }

  return err(
    new RenderGraphError({
      code: 'resource-descriptor-invalid',
      expected: 'RenderPipelineBuildContext.standardLighting from frame preparation',
      hint: 'prepare Standard lighting once, select a proven Cluster transport, and pass it to both lanes',
      detail: {
        resourceLabel: 'forgeax::standard',
        field: 'standardLighting',
        expected: 'prepared Standard lighting topology input',
        actual: 'invalid',
      },
    }),
  );
}

function standardTopology(
  topology: RenderPipelineTopology,
  profile: StandardProfile,
): RenderPipelineTopology {
  const config = {
    ...(topology.config ?? {}),
    ssao: { enabled: profile.ssao },
  };
  return {
    ...topology,
    pipelineId: STANDARD_PIPELINE_ID,
    standardProfile: profile,
    config,
  };
}

/**
 * The sole built-in pipeline entry point. All local lights use the same
 * prepared Cluster topology; the profile chooses only Forward or Deferred
 * graph shape and never a second lighting authority.
 */
function buildStandard(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
): ReturnType<RenderPipeline['build']> {
  const profile = profileFor(topology);
  if (!STANDARD_LIGHT_COUNTS.some((count) => count === profile.lightCount)) {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'StandardProfile.lightCount is one of 1, 32, or 256',
        hint: 'set StandardProfile.lightCount to 1, 32, or 256',
        detail: {
          resourceLabel: 'forgeax::standard',
          field: 'lightCount',
          expected: '1 | 32 | 256',
          actual: profile.lightCount,
        },
      }),
    );
  }
  const effective = standardTopology(topology, profile);
  const lighting = resolveStandardTopologyInput(context);
  if (!lighting.ok) return lighting;
  // A missing Camera is an intentional clear-only frame. Keep it on the
  // forward raster lane so clustered resources cannot introduce work.
  if (effective.clearOnly === true) {
    return buildStandardForwardLane(context, effective, lighting.value);
  }
  return profile.renderPath === 'forward'
    ? buildStandardForwardLane(context, effective, lighting.value)
    : buildStandardDeferredLane(context, effective, lighting.value);
}

export const standardPipeline: StandardPipeline = Object.freeze({
  identity: STANDARD_PIPELINE_ID,
  build: buildStandard,
});

export { DEFAULT_STANDARD_PROFILE, STANDARD_PIPELINE_ID } from './standard-profile';
