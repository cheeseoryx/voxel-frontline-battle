import type {
  GraphTextureDescriptor,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import { SceneDataUnavailableError } from '../errors/render';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
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
  addReflectionFallbackObservationPass,
  addTypedFrameObservationPass,
  addTypedScenePass,
  addTypedSkyboxPass,
} from '../typed-render-graph-primitives';
import { addTypedShadowPasses } from '../typed-shadow-passes';
import { addAuthoredVolumetricFogPasses } from '../volume/passes';
import {
  addStandardClusterMembershipPass,
  importStandardClusterBuffers,
  standardClusterReadAccesses,
} from './standard-lighting/graph';
import type { StandardTopologyInputValue } from './standard-lighting/topology';
import { addStandardPost } from './standard-post';

function target(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  descriptor: GraphTextureDescriptor,
): Result<RenderPipelineTarget, RenderGraphError> {
  return createRenderPipelineTarget(graph, label, descriptor);
}

function buildUrp(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  lighting: StandardTopologyInputValue,
): ReturnType<RenderPipeline['build']> {
  const graph = context.graph;
  const surface = importRenderPipelineSurface(graph, topology);
  if (!surface.ok) return surface;

  const clearOnly = topology.clearOnly === true;
  const msaa = !clearOnly && topology.camera.antialias === 'msaa' && topology.lane.multisample;
  const hdr =
    !clearOnly && (topology.camera.tonemap !== 'none' || topology.camera.antialias === 'taa');
  const fxaa = !clearOnly && topology.camera.antialias === 'fxaa';
  const taa = !clearOnly && topology.camera.antialias === 'taa';
  const rawOnly = !clearOnly && topology.surface.profile?.kind === 'raw-only';
  // Every non-clear lane keeps a linear float scene target until the shared
  // Output Transform. This includes no-AA and the no-storage fallback: the
  // final dither and display encoding must have one graph-owned boundary.
  // MSAA resolves into a separate linear target before presentation. Treat
  // that resolved target like linear LDR so the shared Output Transform owns
  // its write into the surface storage view; without this, the resolve is
  // never presented and MSAA is indistinguishable from the no-AA path.
  const linearLdr = !clearOnly && !hdr;
  const temporalDemand = aggregateTemporalDemand({
    taa,
    motionBlur: !clearOnly && topology.temporal?.motionBlur === true,
  });
  const needsTemporalIntermediate = temporalDemand.targetCount === 1;
  const sceneFormat =
    hdr || linearLdr || rawOnly || needsTemporalIntermediate
      ? 'rgba16float'
      : topology.surface.storageFormat;

  const depth = target(graph, 'scene-depth', {
    format: 'depth24plus-stencil8',
    size: 'surface',
    sampleCount: msaa ? 4 : 1,
  });
  if (!depth.ok) return depth;

  const sceneResolved = clearOnly
    ? surface.value.display === undefined
      ? target(graph, 'scene-color', {
          format: topology.surface.storageFormat,
          size: 'surface',
          sampleCount: 1,
          domain: 'display-encoded',
        })
      : ok(surface.value.display)
    : hdr || fxaa || linearLdr || msaa || rawOnly || needsTemporalIntermediate
      ? target(graph, 'scene-color', {
          format: sceneFormat,
          size: 'surface',
          sampleCount: 1,
          domain: 'linear-ldr',
          ...(sceneFormat === topology.surface.storageFormat &&
          topology.surface.storageFormat !== topology.surface.viewFormat
            ? { viewFormats: [topology.surface.viewFormat] }
            : {}),
        })
      : surface.value.display === undefined
        ? target(graph, 'scene-color', {
            format: topology.surface.storageFormat,
            size: 'surface',
            sampleCount: 1,
            domain: 'display-encoded',
          })
        : ok(surface.value.display);
  if (!sceneResolved.ok) return sceneResolved;
  const scene = msaa
    ? target(graph, 'scene-color-msaa', {
        format: sceneFormat,
        size: 'surface',
        sampleCount: 4,
        domain: 'linear-ldr',
        ...(sceneFormat === topology.surface.storageFormat &&
        topology.surface.storageFormat !== topology.surface.viewFormat
          ? { viewFormats: [topology.surface.viewFormat] }
          : {}),
      })
    : sceneResolved;
  if (!scene.ok) return scene;

  const reflectionFallback = topology.reflectionFallback?.enabled
    ? target(graph, 'reflection-fallback-linear-hdr', {
        format: 'rgba16float',
        size: 'surface',
        sampleCount: scene.value.sampleCount,
        domain: 'linear-hdr',
        usage:
          GPU_TEXTURE_USAGE_COPY_SRC |
          GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
          GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      })
    : ok(undefined);
  if (!reflectionFallback.ok) return reflectionFallback;
  if (reflectionFallback.value !== undefined) {
    const initialized = graph.addRasterPass('reflection-fallback-clear', {
      accesses: [{ resource: reflectionFallback.value.view, usage: 'color-attachment' }],
      colorAttachments: [
        {
          view: reflectionFallback.value.view,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
      encode: () => {},
    });
    if (!initialized.ok) return initialized;
  }

  const shadows = addTypedShadowPasses(graph, topology);
  if (!shadows.ok) return shadows;

  const clusterBuffers = clearOnly ? ok(null) : importStandardClusterBuffers(graph, lighting);
  if (!clusterBuffers.ok) return clusterBuffers;
  const clusterMembership =
    clusterBuffers.value === null
      ? ok(undefined)
      : addStandardClusterMembershipPass(graph, lighting, clusterBuffers.value);
  if (!clusterMembership.ok) return clusterMembership;
  const clusterReads =
    clusterBuffers.value === null ? [] : standardClusterReadAccesses(clusterBuffers.value);

  const skybox = addTypedSkyboxPass(graph, scene.value);
  if (!skybox.ok) return skybox;
  const gpuDriven = context.projectGpuDriven({
    format: scene.value.format,
    sampleCount: scene.value.sampleCount,
  });
  if (!gpuDriven.ok) return gpuDriven;
  const transmissionDemand = transmissionDemandForTopology(topology);
  const transmissionActive = resolveTransmissionBackdropTopology({
    demand: transmissionDemand,
    sourceSampleCount: scene.value.sampleCount,
  }).active;
  const main = addTypedScenePass(graph, {
    name: 'main',
    color: scene.value,
    ...(reflectionFallback.value === undefined
      ? {}
      : { colorTargets: [scene.value, reflectionFallback.value] }),
    depth: depth.value,
    ...(msaa ? { resolve: sceneResolved.value } : {}),
    sampled: [
      ...(shadows.value.directional === undefined ? [] : [shadows.value.directional]),
      shadows.value.spot,
      ...(shadows.value.point === undefined ? [] : [shadows.value.point]),
    ],
    ...(shadows.value.directional === undefined
      ? {}
      : { directionalShadow: shadows.value.directional }),
    spotShadow: shadows.value.spot,
    selector: { LightMode: ['Forward'] },
    colorLoadOp: 'load',
    extraAccesses: clusterReads,
    ...(transmissionActive ? { recordMode: 'opaque' as const } : {}),
    ...(gpuDriven.value === undefined ? {} : { gpuDriven: gpuDriven.value }),
    ...(context.occlusion === undefined ? {} : { occlusion: context.occlusion }),
  });
  if (!main.ok) return main;

  const temporalLane = topology.lane.compute ? 'clustered' : 'cpu-webgl2';
  const temporalAdmission = standardTemporalLaneAdmission({
    lane: temporalLane,
    demand: temporalDemand,
    capabilities: {
      compute: topology.lane.compute,
      storageBuffer: topology.lane.storageBuffer,
      // Capability probes are the sole authority. A surface/storage format is
      // not evidence that rgba16float render targets are actually renderable.
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
  const temporal =
    temporalDemand.targetCount === 1 ? createStandardSceneDataTarget(graph) : ok(undefined);
  if (!temporal.ok) return temporal;
  if (temporal.value !== undefined) {
    const producer = addStandardSceneDataPass(graph, temporal.value.temporal, depth.value);
    if (!producer.ok) return producer;
  }

  const transmission = addTransmissionBackdropPasses({
    graph,
    source: sceneResolved.value,
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
      ...(msaa ? { resolve: sceneResolved.value } : {}),
      sampled: [
        ...(shadows.value.directional === undefined ? [] : [shadows.value.directional]),
        shadows.value.spot,
        ...(shadows.value.point === undefined ? [] : [shadows.value.point]),
      ],
      directionalShadow: shadows.value.directional,
      spotShadow: shadows.value.spot,
      selector: { LightMode: ['Forward'] },
      colorLoadOp: 'load',
      depthLoadOp: 'load',
      recordMode: 'transmission',
      extraAccesses: clusterReads,
      // Inject the complete backdrop view so the Standard shader can select
      // the producer's optional roughness mip level. mipViews[0] is only the
      // copy destination view and intentionally exposes one level.
      transmissionBackdrop: transmission.value.backdrop?.view,
    });
    if (!transmissionPass.ok) return transmissionPass;

    const transparentPass = addTypedScenePass(graph, {
      name: 'transparent',
      color: scene.value,
      depth: depth.value,
      ...(msaa ? { resolve: sceneResolved.value } : {}),
      sampled: [
        ...(shadows.value.directional === undefined ? [] : [shadows.value.directional]),
        shadows.value.spot,
        ...(shadows.value.point === undefined ? [] : [shadows.value.point]),
      ],
      directionalShadow: shadows.value.directional,
      spotShadow: shadows.value.spot,
      selector: { LightMode: ['Forward'] },
      colorLoadOp: 'load',
      depthLoadOp: 'load',
      recordMode: 'transparent',
      extraAccesses: clusterReads,
    });
    if (!transparentPass.ok) return transparentPass;
    const temporal = addTransmissionBackdropTemporalPass(graph, sceneResolved.value);
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
      sceneResolved.value,
      depthSample.value,
      shadows.value.directional?.view,
      shadows.value.spot.view,
      clusterBuffers.value,
    );
    if (!volume.ok) return volume;
  }

  const features = context.contributeFeatures([
    {
      name: 'linear-hdr',
      kind: 'scene-color',
      texture: scene.value.texture,
      view: scene.value.view,
      ...(msaa ? { resolveTarget: sceneResolved.value.view } : {}),
      format: scene.value.format,
      sampleCount: scene.value.sampleCount,
    },
    {
      kind: 'scene-depth',
      texture: depth.value.texture,
      view: depth.value.view,
      format: depth.value.format,
      sampleCount: depth.value.sampleCount,
    },
  ]);
  if (!features.ok) return features;

  if (hdr || linearLdr || rawOnly) {
    const observation = addTypedFrameObservationPass(
      graph,
      sceneResolved.value,
      'forgeax::standard',
    );
    if (!observation.ok) return observation;
  }
  if (reflectionFallback.value?.sampleCount === 1) {
    const fallbackObservation = addReflectionFallbackObservationPass(
      graph,
      reflectionFallback.value,
    );
    if (!fallbackObservation.ok) return fallbackObservation;
  }

  const post = addStandardPost(
    context,
    topology,
    sceneResolved.value,
    depth.value,
    surface.value,
    temporal.value?.temporal,
  );
  if (!post.ok) return post;
  const cubeCaptures = context.contributeCubeCaptures?.();
  if (cubeCaptures !== undefined && !cubeCaptures.ok) return cubeCaptures;
  return ok(undefined);
}

export const buildStandardForwardLane = buildUrp;
