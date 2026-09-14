import type {
  GraphAccess,
  GraphResourceResolver,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
  ResolveContext,
} from '@forgeax/engine-render-graph';
import { RhiError, type TextureView } from '@forgeax/engine-rhi';
import { ok, type PassKind, type PassSelector, type Result } from '@forgeax/engine-types';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from './gpu-texture-usage';
import { buildPerFrameBindGroups } from './record/frame-lighting';
import { encodeMainPass } from './record/main-pass';
import type {
  _InternalRenderPipelineContext,
  RenderSystemInternals,
} from './record/render-context';
import {
  encodeSkyboxPass,
  recordBloomBlurHPass,
  recordBloomBlurVPass,
  recordBloomBrightPass,
  recordBloomCompositePass,
} from './record/skybox-post-pass';
import { STANDARD_OUTPUT_TRANSFORM_FEATURE_ID } from './render-contract';
import {
  encodeFullscreenPass,
  recordSsaoBlurPass,
  recordSsaoCalcPass,
} from './render-graph-primitives';
import type { RenderPipelineFrame, RenderPipelineGpuDrivenProjection } from './render-pipeline';
import { createRenderPipelineTarget, type RenderPipelineTarget } from './render-pipeline';
import type { OcclusionFrameProjection } from './scene/visibility/occlusion-runtime';
import {
  getTemporalBindGroupResources,
  getTemporalGpuState,
  getTemporalParamsBuffer,
  stageTemporalGpuSubmit,
} from './temporal/gpu';

function resolvedView(resources: GraphResourceResolver, view: GraphTextureView): TextureView {
  const result = resources.textureView(view);
  if (!result.ok) throw result.error;
  return result.value;
}

function throwTemporalEncodeFailure(expected: string, cause?: unknown): never {
  throw new RhiError({
    code: 'webgpu-runtime-error',
    expected,
    hint:
      cause === undefined
        ? 'retry the temporal frame after repairing its GPU resource'
        : String(cause),
  });
}

export function typedFrameClearColor(frame: RenderPipelineFrame): GPUColor {
  return {
    r: frame.clear[0] ?? 0,
    g: frame.clear[1] ?? 0,
    b: frame.clear[2] ?? 0,
    a: frame.clear[3] ?? 1,
  };
}

function resolvedDepthView(
  frame: RenderPipelineFrame,
  resources: GraphResourceResolver,
  target: RenderPipelineTarget,
): TextureView {
  const texture = resources.texture(target.texture);
  if (!texture.ok) throw texture.error;
  const view = frame.runtime.device.createTextureView(texture.value, {
    label: 'typed-ssao-depth-only-view',
    dimension: '2d',
    aspect: 'depth-only',
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  });
  if (!view.ok) throw view.error;
  return view.value;
}

function legacyResolver(
  resources: GraphResourceResolver,
  targets: Readonly<Record<string, RenderPipelineTarget>>,
): ResolveContext {
  return {
    resolve: (name) => {
      const target = targets[name];
      return target === undefined ? undefined : resolvedView(resources, target.view);
    },
  };
}

export function addTypedSkyboxPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  color: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  return graph.addRasterPass('skybox', {
    accesses: [{ resource: color.view, usage: 'color-attachment' }],
    colorAttachments: [
      {
        view: color.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: typedFrameClearColor,
      },
    ],
    encode: ({ pass, frame }) => encodeSkyboxPass(frame as _InternalRenderPipelineContext, pass),
  });
}

export interface TypedScenePassOptions {
  readonly name: string;
  readonly color: RenderPipelineTarget;
  readonly depth: RenderPipelineTarget;
  readonly resolve?: RenderPipelineTarget | undefined;
  readonly sampled?: readonly RenderPipelineTarget[] | undefined;
  readonly directionalShadow?: RenderPipelineTarget | undefined;
  readonly spotShadow?: RenderPipelineTarget | undefined;
  readonly ssao?: RenderPipelineTarget | undefined;
  readonly selector: PassSelector;
  readonly passKind?: PassKind | undefined;
  readonly colorTargets?: readonly RenderPipelineTarget[] | undefined;
  readonly clearColor?: readonly [number, number, number, number] | undefined;
  readonly colorLoadOp?: GPULoadOp | undefined;
  readonly depthLoadOp?: GPULoadOp | undefined;
  readonly recordMode?: 'opaque' | 'transmission' | 'transparent' | undefined;
  readonly transmissionBackdrop?: GraphTextureView | undefined;
  readonly extraAccesses?: readonly GraphAccess[] | undefined;
  readonly gpuDriven?: RenderPipelineGpuDrivenProjection | undefined;
  readonly occlusion?: OcclusionFrameProjection | undefined;
}

export function addTypedScenePass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  options: TypedScenePassOptions,
): Result<void, RenderGraphError> {
  const colorTargets = options.colorTargets ?? [options.color];
  const accesses: GraphAccess[] = [
    ...colorTargets.map((target) => ({
      resource: target.view,
      usage: 'color-attachment' as const,
    })),
    { resource: options.depth.view, usage: 'depth-stencil-write' },
    ...(options.sampled ?? []).map((target) => ({
      resource: target.view,
      usage: 'sampled-read' as const,
    })),
    ...(options.transmissionBackdrop === undefined
      ? []
      : [{ resource: options.transmissionBackdrop, usage: 'sampled-read' as const }]),
    ...(options.extraAccesses ?? []),
    ...(options.gpuDriven?.accesses ?? []),
  ];
  if (options.resolve !== undefined) {
    accesses.push({ resource: options.resolve.view, usage: 'color-attachment' });
  }
  return graph.addRasterPass(options.name, {
    accesses,
    colorAttachments: colorTargets.map((target, index) => ({
      view: target.view,
      ...(index === 0 && options.resolve !== undefined
        ? { resolveTarget: options.resolve.view }
        : {}),
      loadOp: options.colorLoadOp ?? 'clear',
      storeOp: 'store',
      clearValue: {
        r: options.clearColor?.[0] ?? 0,
        g: options.clearColor?.[1] ?? 0,
        b: options.clearColor?.[2] ?? 0,
        a: options.clearColor?.[3] ?? 1,
      },
    })),
    depthStencilAttachment: {
      view: options.depth.view,
      depthClearValue: 1,
      depthLoadOp: options.depthLoadOp ?? 'clear',
      depthStoreOp: 'store',
      stencilClearValue: 0,
      stencilLoadOp: options.depthLoadOp ?? 'clear',
      stencilStoreOp: 'store',
    },
    occlusionQuerySet: options.occlusion?.querySet,
    encode: ({ pass, frame, resources }) => {
      const colorViews = colorTargets.map((target) => resolvedView(resources, target.view));
      const depthView = resolvedView(resources, options.depth.view);
      const resolveView =
        options.resolve === undefined ? null : resolvedView(resources, options.resolve.view);
      const internal = frame as _InternalRenderPipelineContext;
      const directionalShadow =
        options.directionalShadow === undefined
          ? undefined
          : resolvedView(resources, options.directionalShadow.view);
      const spotShadow =
        options.spotShadow === undefined
          ? undefined
          : resolvedView(resources, options.spotShadow.view);
      const ssao =
        options.ssao === undefined ? undefined : resolvedView(resources, options.ssao.view);
      const transmissionBackdrop =
        options.transmissionBackdrop === undefined
          ? null
          : resolvedView(resources, options.transmissionBackdrop);
      internal.frameState.currentDirectionalShadowView = directionalShadow ?? null;
      internal.frameState.currentSpotShadowView = spotShadow ?? null;
      const groups = buildPerFrameBindGroups(
        internal.runtime as RenderSystemInternals,
        internal.frameState,
        internal.pipelineState,
        internal.validated.length > 0 || options.gpuDriven !== undefined,
        internal.bindGroupCounts,
        {
          directionalShadow,
          spotShadow,
          projector: internal.spotLightProjector?.view ?? internal.volumetricFog?.projectorView,
          projectorSampler:
            internal.spotLightProjector?.sampler ?? internal.volumetricFog?.projectorSampler,
        },
        true,
        internal.standardLighting,
      );
      if (groups.viewBindGroup !== null) {
        options.gpuDriven?.encode(groups.viewBindGroup, pass, resources);
      }
      // The context carries the frame's primary occlusion projection for
      // pipeline construction, but only the pass that owns that projection
      // may begin its query. Forwarding it to deferred/temporal scene passes
      // leaves their descriptors without an occlusionQuerySet and makes Dawn
      // reject beginOcclusionQuery in those passes.
      const activeOcclusion = options.occlusion;
      encodeMainPass(
        {
          ...internal,
          ...(activeOcclusion === undefined ? {} : { occlusion: activeOcclusion }),
          geometryColorView: colorViews[0] ?? null,
          geometryDepthView: depthView,
          geometryColorResolveView: resolveView,
          transparentColorFormat: colorTargets[0]?.format as GPUTextureFormat,
          ...(colorTargets[1]?.format === 'rgba16float'
            ? { reflectionFallbackColorFormat: 'rgba16float' as const }
            : {}),
          msaaActive: colorTargets[0]?.sampleCount === 4,
          viewBindGroup: groups.viewBindGroup,
          meshBindGroup: groups.meshBindGroup,
          hdrpClusterBindGroup: groups.hdrpClusterBindGroup,
          hdrpClusterMembershipBindGroup: groups.hdrpClusterMembershipBindGroup,
          ...(ssao === undefined ? {} : { hdrpSsaoBlurredView: ssao }),
        },
        pass,
        options.selector,
        {
          colorViews,
          colorFormats: colorTargets.map((target) => target.format as GPUTextureFormat),
          depthView,
          passKind: options.passKind ?? 'forward',
          ...(options.clearColor === undefined ? {} : { clearColor: options.clearColor }),
          ...(options.recordMode === undefined ? {} : { recordMode: options.recordMode }),
          ...(options.transmissionBackdrop === undefined
            ? {}
            : { transmissionBackdropView: transmissionBackdrop }),
        },
      );
      if (activeOcclusion !== undefined) {
        const proxyResult = activeOcclusion.encodeProxyBounds(pass);
        if (!proxyResult.ok) throw proxyResult.error;
      }
    },
  });
}

export function addTypedFrameObservationPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  target: RenderPipelineTarget,
  pipelineId: 'forgeax::standard',
): Result<void, RenderGraphError> {
  return graph.addCopyPass('linear-hdr-observation', {
    accesses: [{ resource: target.view, usage: 'copy-src' }],
    encode: ({ frame, resources }) => {
      const internal = frame as _InternalRenderPipelineContext;
      const texture = resources.texture(target.texture);
      if (!texture.ok) throw texture.error;
      internal.frameState.currentFrameObservationSource = {
        texture: texture.value,
        descriptor: {
          texture: texture.value,
          format: target.format,
          size: { width: frame.targetW, height: frame.targetH },
          usage:
            GPU_TEXTURE_USAGE_COPY_SRC |
            GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
            GPU_TEXTURE_USAGE_TEXTURE_BINDING,
          sample: target.sampleCount,
        },
        frameId: internal.frameState.frameNumber,
        pipelineId,
        backendId: frame.runtime.device.caps.backendKind,
      };
    },
  });
}

/** Publish the same-frame fallback MRT as a detached, copy-readable source. */
export function addReflectionFallbackObservationPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  target: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  return graph.addCopyPass('reflection-fallback-observation', {
    accesses: [{ resource: target.view, usage: 'copy-src' }],
    encode: ({ frame, resources }) => {
      const internal = frame as _InternalRenderPipelineContext;
      const texture = resources.texture(target.texture);
      if (!texture.ok) throw texture.error;
      internal.frameState.reflectionFallbackObservationSource = {
        texture: texture.value,
        descriptor: {
          texture: texture.value,
          format: target.format,
          size: { width: frame.targetW, height: frame.targetH },
          usage:
            GPU_TEXTURE_USAGE_COPY_SRC |
            GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
            GPU_TEXTURE_USAGE_TEXTURE_BINDING,
          sample: target.sampleCount,
        },
        frameId: internal.frameState.frameNumber,
        pipelineId: 'forgeax::standard',
        backendId: internal.runtime.device.caps.backendKind,
      };
    },
  });
}

export interface TypedBloomTargets {
  readonly scene: RenderPipelineTarget;
  readonly composited: RenderPipelineTarget;
  readonly bright: RenderPipelineTarget;
  readonly blurH: RenderPipelineTarget;
  readonly blurV: RenderPipelineTarget;
}

/** The semantic Bloom pass owner; graph inspection consumes these same identities. */
export const TYPED_BLOOM_PASS_NAMES = {
  bright: 'bloom-bright',
  blurH: 'bloom-blur-h',
  blurV: 'bloom-blur-v',
  composite: 'bloom-composite',
} as const;

export function addTypedBloomPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  targets: TypedBloomTargets,
): Result<void, RenderGraphError> {
  const named = {
    hdrColor: targets.scene,
    hdrComposited: targets.composited,
    bloomBright: targets.bright,
    bloomBlurH: targets.blurH,
    bloomBlurV: targets.blurV,
  };
  const descriptors = [
    {
      name: TYPED_BLOOM_PASS_NAMES.bright,
      reads: [targets.scene],
      write: targets.bright,
      encode: recordBloomBrightPass,
    },
    {
      name: TYPED_BLOOM_PASS_NAMES.blurH,
      reads: [targets.bright],
      write: targets.blurH,
      encode: recordBloomBlurHPass,
    },
    {
      name: TYPED_BLOOM_PASS_NAMES.blurV,
      reads: [targets.blurH],
      write: targets.blurV,
      encode: recordBloomBlurVPass,
    },
    {
      name: TYPED_BLOOM_PASS_NAMES.composite,
      reads: [targets.scene, targets.blurV],
      write: targets.composited,
      encode: recordBloomCompositePass,
    },
  ] as const;
  for (const descriptor of descriptors) {
    const added = graph.addRasterPass(descriptor.name, {
      accesses: [
        ...descriptor.reads.map((target) => ({
          resource: target.view,
          usage: 'sampled-read' as const,
        })),
        { resource: descriptor.write.view, usage: 'color-attachment' },
      ],
      colorAttachments: [
        {
          view: descriptor.write.view,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
      encode: ({ pass, frame, resources }) =>
        descriptor.encode(
          frame as _InternalRenderPipelineContext,
          legacyResolver(resources, named),
          pass,
        ),
    });
    if (!added.ok) return added;
  }
  return ok(undefined);
}

export interface TypedSsaoTargets {
  readonly normal: RenderPipelineTarget;
  readonly depth: RenderPipelineTarget;
  readonly raw: RenderPipelineTarget;
  readonly blurred: RenderPipelineTarget;
}

export function addTypedSsaoPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  targets: TypedSsaoTargets,
): Result<void, RenderGraphError> {
  const calc = graph.addRasterPass('ssao-calc', {
    accesses: [
      { resource: targets.normal.view, usage: 'sampled-read' },
      { resource: targets.depth.view, usage: 'sampled-read' },
      { resource: targets.raw.view, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: targets.raw.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 1, g: 1, b: 1, a: 1 },
      },
    ],
    encode: ({ pass, frame, resources }) => {
      const normal = resolvedView(resources, targets.normal.view);
      const depthCacheKey = resolvedView(resources, targets.depth.view);
      recordSsaoCalcPass(
        frame as _InternalRenderPipelineContext,
        undefined,
        undefined,
        undefined,
        undefined,
        pass,
        {
          output: resolvedView(resources, targets.raw.view),
          normal,
          depth: resolvedDepthView(frame, resources, targets.depth),
          depthCacheKey,
        },
      );
    },
  });
  if (!calc.ok) return calc;

  return graph.addRasterPass('ssao-blur', {
    accesses: [
      { resource: targets.raw.view, usage: 'sampled-read' },
      { resource: targets.normal.view, usage: 'sampled-read' },
      { resource: targets.depth.view, usage: 'sampled-read' },
      { resource: targets.blurred.view, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: targets.blurred.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 1, g: 1, b: 1, a: 1 },
      },
    ],
    encode: ({ pass, frame, resources }) => {
      const normal = resolvedView(resources, targets.normal.view);
      const depthCacheKey = resolvedView(resources, targets.depth.view);
      recordSsaoBlurPass(
        frame as _InternalRenderPipelineContext,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        pass,
        {
          output: resolvedView(resources, targets.blurred.view),
          raw: resolvedView(resources, targets.raw.view),
          normal,
          depth: resolvedDepthView(frame, resources, targets.depth),
          depthCacheKey,
        },
      );
    },
  });
}

export interface TypedFullscreenPassOptions {
  readonly name: string;
  readonly shader: string;
  readonly input: RenderPipelineTarget;
  readonly output: RenderPipelineTarget;
  readonly outputOnly?: boolean | undefined;
  readonly rawSwapchainOutput?: boolean | undefined;
  readonly depth?: RenderPipelineTarget | undefined;
  readonly additionalReads?: readonly {
    readonly key: string;
    readonly target: RenderPipelineTarget;
  }[];
  /** Optional per-pass copy of the params UBO payload. */
  readonly paramsTransform?:
    | ((params: Uint8Array | undefined) => Uint8Array | undefined)
    | undefined;
}

export interface TypedTemporalResolveTargets {
  readonly scene: RenderPipelineTarget;
  readonly currentTemporal: RenderPipelineTarget;
  readonly depth: RenderPipelineTarget;
  readonly historyColor: RenderPipelineTarget;
  readonly historyTemporal: RenderPipelineTarget;
  readonly writeColor: RenderPipelineTarget;
  readonly writeTemporal: RenderPipelineTarget;
}

export function addTypedTemporalResolvePass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  targets: TypedTemporalResolveTargets,
): Result<void, RenderGraphError> {
  const added = graph.addRasterPass('taa-resolve', {
    accesses: [
      { resource: targets.scene.view, usage: 'sampled-read' },
      { resource: targets.currentTemporal.view, usage: 'sampled-read' },
      { resource: targets.historyColor.view, usage: 'sampled-read' },
      { resource: targets.historyTemporal.view, usage: 'sampled-read' },
      { resource: targets.writeColor.view, usage: 'color-attachment' },
      { resource: targets.writeTemporal.view, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: targets.writeColor.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
      {
        view: targets.writeTemporal.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
    encode: ({ pass, frame, resources }) => {
      const internal = frame as _InternalRenderPipelineContext;
      const state = getTemporalGpuState(
        internal.frameState,
        frame.runtime.device,
        (frame.runtime as import('./record/render-context').RenderSystemRuntime).deviceScope,
        frame.targetW,
        frame.targetH,
      );
      const built = getTemporalBindGroupResources(state);
      const current = resolvedView(resources, targets.scene.view);
      const currentTemporal = resolvedView(resources, targets.currentTemporal.view);
      const historyColor = resolvedView(resources, targets.historyColor.view);
      const historyTemporal = resolvedView(resources, targets.historyTemporal.view);
      const params = getTemporalParamsBuffer(state);
      if (params === undefined || built.sampler === null) {
        throwTemporalEncodeFailure('TAA resolve has an admitted params buffer and sampler');
      }
      const payload = new ArrayBuffer(16);
      new Float32Array(payload).set([
        frame.camera.temporal?.currentJitterUv?.[0] ?? 0,
        frame.camera.temporal?.currentJitterUv?.[1] ?? 0,
      ]);
      const words = new Uint32Array(payload);
      words[2] = state.valid && (frame.camera.temporal?.historyValid ?? true) ? 1 : 0;
      words[3] = frame.camera.temporal?.temporalFrameIndex ?? 0;
      const written = frame.runtime.device.queue.writeBuffer(params, 0, new Uint8Array(payload));
      if (!written.ok)
        throwTemporalEncodeFailure('TAA resolve params upload succeeds', written.error);
      const bindGroup = frame.runtime.device.createBindGroup({
        label: 'taa-resolve-bind-group',
        layout: built.layout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: current } },
          { binding: 1, resource: { kind: 'sampler', value: built.sampler } },
          { binding: 2, resource: { kind: 'textureView', value: historyColor } },
          { binding: 3, resource: { kind: 'sampler', value: built.sampler } },
          { binding: 4, resource: { kind: 'textureView', value: historyTemporal } },
          { binding: 5, resource: { kind: 'sampler', value: built.sampler } },
          { binding: 6, resource: { kind: 'textureView', value: currentTemporal } },
          { binding: 7, resource: { kind: 'sampler', value: built.sampler } },
          { binding: 8, resource: { kind: 'buffer', value: { buffer: params } } },
        ] as never,
      });
      if (!bindGroup.ok) {
        throwTemporalEncodeFailure('TAA resolve bind group creation succeeds', bindGroup.error);
      }
      const pipeline = frame.runtime.getPostProcessPipeline?.(
        'forgeax.taa-resolve',
        built.layout,
        targets.writeColor.format as GPUTextureFormat,
      );
      if (pipeline === null || pipeline === undefined) {
        throwTemporalEncodeFailure('TAA resolve pipeline is ready before frame encoding');
      }
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, bindGroup.value);
      pass.draw(3, 1, 0, 0);
      stageTemporalGpuSubmit(state);
      internal.frameState.temporalGpuState = state;
    },
  });
  return added;
}

export function addTypedFullscreenPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  options: TypedFullscreenPassOptions,
): Result<void, RenderGraphError> {
  return graph.addRasterPass(options.name, {
    accesses: [
      { resource: options.input.view, usage: 'sampled-read' },
      { resource: options.output.view, usage: 'color-attachment' },
      ...(options.depth === undefined
        ? []
        : [{ resource: options.depth.view, usage: 'sampled-read' as const }]),
      ...(options.additionalReads?.map((read) => ({
        resource: read.target.view,
        usage: 'sampled-read' as const,
      })) ?? []),
    ],
    colorAttachments: [
      {
        view: options.output.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
    encode: ({ pass, frame, resources }) => {
      if (options.outputOnly && frame.runtime.lookupPostProcess?.(options.shader) === undefined) {
        return;
      }
      encodeFullscreenPass(frame, pass, {
        name: options.name,
        shader: options.shader,
        color: 'output',
        reads: ['input'],
        resolve: legacyResolver(resources, {
          input: options.input,
          output: options.output,
          ldrColor: options.input,
          'scene-color': options.input,
          ...(options.depth === undefined ? {} : { 'scene-depth': options.depth }),
          ...(options.additionalReads === undefined
            ? {}
            : Object.fromEntries(options.additionalReads.map((read) => [read.key, read.target]))),
        }),
        outputFormat: options.output.format as GPUTextureFormat,
        ...(options.depth === undefined
          ? {}
          : { depthView: resolvedDepthView(frame, resources, options.depth) }),
        ...(options.rawSwapchainOutput === undefined
          ? {}
          : { rawSwapchainOutput: options.rawSwapchainOutput }),
        ...(options.paramsTransform === undefined
          ? {}
          : {
              paramsOverride: options.paramsTransform(frame.postProcessParams.get(options.shader)),
            }),
      });
    },
  });
}

export function addTypedCompositePostEffects(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  effects: readonly string[],
  input: RenderPipelineTarget,
  output: RenderPipelineTarget,
  depth: RenderPipelineTarget,
  size: { readonly width: number; readonly height: number },
): Result<void, RenderGraphError> {
  let currentInput = input;
  for (let index = 0; index < effects.length; index += 1) {
    const shader = effects[index];
    if (shader === undefined) continue;
    const effectInput = currentInput;
    const scratch = createRenderPipelineTarget(graph, `post-effect-scratch-${index}`, {
      format: output.format as GPUTextureFormat,
      size: 'surface',
    });
    if (!scratch.ok) return scratch;
    const effectOutput =
      index === effects.length - 1
        ? ok(output)
        : createRenderPipelineTarget(graph, `post-effect-output-${index}`, {
            format: output.format as GPUTextureFormat,
            size: 'surface',
          });
    if (!effectOutput.ok) return effectOutput;
    const copied = graph.addCopyPass(`post-effect-copy-${index}`, {
      accesses: [
        { resource: effectInput.view, usage: 'copy-src' },
        { resource: scratch.value.view, usage: 'copy-dst' },
      ],
      encode: ({ encoder, resources }) => {
        const source = resources.texture(effectInput.texture);
        if (!source.ok) throw source.error;
        const destination = resources.texture(scratch.value.texture);
        if (!destination.ok) throw destination.error;
        encoder.copyTextureToTexture(
          { texture: source.value as never, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
          { texture: destination.value as never, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
          { width: size.width, height: size.height, depthOrArrayLayers: 1 },
        );
      },
    });
    if (!copied.ok) return copied;
    const effect = addTypedFullscreenPass(graph, {
      name: `post-effect-${index}`,
      shader,
      input: scratch.value,
      output: effectOutput.value,
      depth,
    });
    if (!effect.ok) return effect;
    currentInput = effectOutput.value;
  }
  return ok(undefined);
}

export function addTypedOutputTransformPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: RenderPipelineTarget,
  output: RenderPipelineTarget,
  options: { readonly outputOnly?: boolean; readonly dither?: boolean } = {},
): Result<void, RenderGraphError> {
  const outputOnly = options.outputOnly ?? false;
  return addTypedFullscreenPass(graph, {
    name: outputOnly ? 'present' : 'output-transform',
    shader: STANDARD_OUTPUT_TRANSFORM_FEATURE_ID,
    input,
    output,
    outputOnly,
    rawSwapchainOutput: outputOnly,
    ...(options.dither !== undefined
      ? {
          paramsTransform: (params: Uint8Array | undefined): Uint8Array | undefined => {
            if (params === undefined || params.byteLength !== 16) return params;
            const transformed = params.slice();
            new DataView(
              transformed.buffer,
              transformed.byteOffset,
              transformed.byteLength,
            ).setFloat32(12, options.dither === true ? 1 : 0, true);
            return transformed;
          },
        }
      : {}),
  });
}
