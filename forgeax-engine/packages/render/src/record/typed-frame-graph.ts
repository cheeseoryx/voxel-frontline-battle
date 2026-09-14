import { encodeMipmapLevel } from '@forgeax/engine-assets-runtime';
import {
  type CompiledRenderGraph,
  type GraphResourceResolver,
  RenderGraphBuilder,
  RenderGraphError,
  type RenderGraphPassInstrumentation,
  type RenderGraphPassInstrumentationScope,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  CommandBuffer,
  RenderPipeline,
  RhiCommandEncoder,
  Sampler,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { executeRendererFrameTransaction } from '../assembly/renderer-frame-transaction';
import { type RenderError, RenderFeatureStageFailedError } from '../errors/render';
import {
  getRenderFeaturePlanExecutionProjection,
  type RenderFeaturePlanExecution,
} from '../features/host';
import { type RenderFeaturePlannedFrame, renderFeaturePlanSignature } from '../features/plan';
import { projectRenderFeaturePlans as projectPlanExecutions } from '../features/render-graph-contribution';
import type {
  RenderFeatureGraphBindingsResolution,
  RenderFeatureGraphTargetResolver,
} from '../features/render-graph-raster';
import { isRenderFeatureTargetHandle } from '../features/targets';
import type { PostProcessShaderEntry } from '../fullscreen-post-process-pass';
import {
  buildFullscreenPostProcessPass,
  createFullscreenBindGroup,
  isTemporalFullscreenBinding,
  postProcessShaderEntrySignature,
} from '../fullscreen-post-process-pass';
import type { PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  type StandardTopologyInputValue,
  standardLightingTopologySignature,
} from '../pipeline/standard-lighting/topology';
import { resolveVolumetricFogProfile, STANDARD_PIPELINE_ID } from '../pipeline/standard-profile';
import type { CameraSnapshot } from '../render-contract';
import type {
  RenderPipelineFeatureTarget,
  RenderPipelineFrame,
  RenderPipelineTopology,
} from '../render-pipeline';
import type { ExtractedLights, ExtractedVolumetricFog } from '../render-system-extract';
import { SHADOW_ATLAS_DEFAULT_FACE_SIZE, SHADOW_ATLAS_DEFAULT_LAYERS } from '../shadow-atlas';
import type { SsrAdmissionResult } from '../ssr/admission';
import type { RenderTarget } from '../targets/contracts';
import type { RenderTargetPhysical } from '../targets/physical';
import {
  abortTemporalGpuSubmit,
  commitTemporalGpuSubmit,
  getTemporalGpuState,
  hasPendingTemporalGpuSubmit,
  retireTemporalGpuState,
  retireTemporalGpuStateAfterFence,
  temporalReadIndex,
  temporalWriteIndex,
} from '../temporal/gpu';
import { isSceneDataTarget } from '../temporal/scene-data';
import type { TransmissionDemand } from '../transmission/projection';
import { hasVolumetricFogCapability } from '../volume/capability';
import { deriveVolumetricFogExtent, deriveVolumetricFogResolvedExtent } from '../volume/resources';
import { buildPerFrameBindGroups } from './frame-lighting';
import { getTextureIdentity, type RenderFrameState } from './frame-snapshot';
import type { GpuPassTimingPassIdentity } from './gpu-pass-timing/contract.js';
import type { GpuPassTimingCapture, GpuPassTimingSession } from './gpu-pass-timing/session.js';
import type { GpuTimingCapture } from './gpu-timing';
import { encodeMainPass } from './main-pass';
import type {
  _InternalRenderPipelineContext,
  PipelineState,
  RenderSystemInternals,
} from './render-context';
import { resolveSurfaceFormatPair, resolveSurfaceProfile } from './render-context';

export interface TemporalGraphCapabilities {
  readonly rgba16floatRender: boolean;
  readonly rgba16floatSample: boolean;
  readonly mrt: boolean;
}

export interface TemporalGraphRoster {
  readonly enabled?: boolean;
  readonly targets: readonly string[];
  readonly passes: readonly string[];
  readonly uploads: number;
}

export interface ReflectionFallbackGraphRoster {
  readonly enabled: boolean;
  readonly attachments: readonly string[];
  readonly passes: readonly string[];
  readonly bindings: readonly string[];
  readonly historyCount: 0;
  readonly temporalDemand: 0;
}

export interface ReflectionFallbackGraphCandidate {
  readonly generation: number;
  readonly source: 'probe' | 'skylight' | 'neutral';
  readonly roster: ReflectionFallbackGraphRoster;
}

export interface SsrAdmissionGraphRoster {
  readonly enabled: boolean;
  readonly attachments: readonly string[];
  readonly passes: readonly string[];
  readonly bindings: readonly string[];
  readonly historyCount: 0;
  readonly temporalDemand: 0;
}

/**
 * Admission is the sole switch for parent SSR graph work. A blocked result
 * projects to an empty roster, so missing receipts cannot allocate or bind
 * any SSR resource.
 */
export function createSsrAdmissionGraphRoster(
  admission: Pick<SsrAdmissionResult, 'status'>,
): SsrAdmissionGraphRoster {
  if (admission.status !== 'admitted') {
    return {
      enabled: false,
      attachments: [],
      passes: [],
      bindings: [],
      historyCount: 0,
      temporalDemand: 0,
    };
  }
  return {
    enabled: true,
    attachments: ['ssr-reflection-admission'],
    passes: ['ssr-m0-admission'],
    bindings: ['ssr-reflection-admission'],
    historyCount: 0,
    temporalDemand: 0,
  };
}

export type ReflectionFallbackGraphFailure = 'compile-failed' | 'encode-failed' | 'submit-failed';

export function createReflectionFallbackGraphRoster(input: {
  readonly fallbackDemand: boolean;
}): ReflectionFallbackGraphRoster {
  if (!input.fallbackDemand) {
    return {
      enabled: false,
      attachments: [],
      passes: [],
      bindings: [],
      historyCount: 0,
      temporalDemand: 0,
    };
  }
  return {
    enabled: true,
    attachments: ['reflection-fallback-linear-hdr'],
    passes: ['standard-main'],
    bindings: ['reflection-fallback-output'],
    historyCount: 0,
    temporalDemand: 0,
  };
}

export function commitReflectionFallbackGraph(
  candidate: ReflectionFallbackGraphCandidate,
  result:
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: ReflectionFallbackGraphFailure },
): {
  readonly visible: boolean;
  readonly generation: number;
  readonly source?: ReflectionFallbackGraphCandidate['source'];
} {
  if (!result.ok || !candidate.roster.enabled) return { visible: false, generation: 0 };
  return { visible: true, generation: candidate.generation, source: candidate.source };
}

function importTemporalHistoryTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  kind: 'color' | 'temporal',
  role: 'read' | 'write',
): import('../render-pipeline').RenderPipelineTarget {
  const texture = graph.importTexture(
    label,
    {
      format: 'rgba16float',
      size: 'surface',
      usage:
        GPU_TEXTURE_USAGE_COPY_SRC |
        GPU_TEXTURE_USAGE_COPY_DST |
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
        GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    },
    (frame) => {
      const internal = frame as import('./render-context')._InternalRenderPipelineContext;
      const state = getTemporalGpuState(
        internal.frameState,
        internal.runtime.device,
        internal.runtime.deviceScope,
        frame.targetW,
        frame.targetH,
      );
      const index = role === 'read' ? temporalReadIndex(state) : temporalWriteIndex(state);
      return (kind === 'color' ? state.color[index] : state.temporal[index]).texture;
    },
  );
  if (!texture.ok) throw texture.error;
  const view = graph.importView(
    texture.value,
    { label: `${label}.view`, dimension: '2d' },
    (frame) => {
      const internal = frame as import('./render-context')._InternalRenderPipelineContext;
      const state = getTemporalGpuState(
        internal.frameState,
        internal.runtime.device,
        internal.runtime.deviceScope,
        frame.targetW,
        frame.targetH,
      );
      const index = role === 'read' ? temporalReadIndex(state) : temporalWriteIndex(state);
      return (kind === 'color' ? state.color[index] : state.temporal[index]).view;
    },
  );
  if (!view.ok) throw view.error;
  return { texture: texture.value, view: view.value, format: 'rgba16float', sampleCount: 1 };
}

function importTemporalHistoryTargets(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
): NonNullable<
  import('../render-pipeline').RenderPipelineBuildContext<RenderPipelineFrame>['taaHistory']
> {
  return {
    currentColor: importTemporalHistoryTarget(graph, 'taa-history-current-color', 'color', 'write'),
    previousColor: importTemporalHistoryTarget(
      graph,
      'taa-history-previous-color',
      'color',
      'read',
    ),
    currentTemporal: importTemporalHistoryTarget(
      graph,
      'taa-history-current-temporal',
      'temporal',
      'write',
    ),
    previousTemporal: importTemporalHistoryTarget(
      graph,
      'taa-history-previous-temporal',
      'temporal',
      'read',
    ),
  };
}

export function shouldUseTemporalFrameTransaction(
  antialias: CameraSnapshot['antialias'],
  temporalDemand = false,
): boolean {
  return antialias === 'taa' || temporalDemand;
}

export function isMotionBlurTemporalDemand(
  motionBlur: CameraSnapshot['motionBlur'] | undefined,
): boolean {
  return motionBlur?.shutterAngle !== undefined && motionBlur.shutterAngle > 0;
}

/**
 * Derive the TAA topology from camera POD and backend capabilities. Both
 * Standard lanes consume this declaration; the lane only affects lighting
 * work and never creates a second temporal resolve.
 */
export function createTemporalGraphRoster(input: {
  readonly antialias: 'none' | 'fxaa' | 'taa';
  readonly lane: 'direct' | 'clustered';
  readonly capabilities?: TemporalGraphCapabilities;
}): TemporalGraphRoster {
  if (input.antialias !== 'taa') return { targets: [], passes: [], uploads: 0 };
  const capabilities = input.capabilities ?? {
    rgba16floatRender: true,
    rgba16floatSample: true,
    mrt: true,
  };
  if (!capabilities.rgba16floatRender || !capabilities.rgba16floatSample || !capabilities.mrt) {
    return { enabled: false, targets: [], passes: [], uploads: 0 };
  }
  return {
    enabled: true,
    targets: [
      'standard-scene-temporal',
      'taa-history-current-color',
      'taa-history-previous-color',
      'taa-history-current-temporal',
      'taa-history-previous-temporal',
    ],
    passes: ['main', 'standard-scene-data', 'taa-resolve', 'output-transform'],
    uploads: 1,
  };
}

export interface CubeCaptureGraphWork {
  readonly target: RenderTarget;
  readonly faceIndex: number;
  readonly physical: RenderTargetPhysical;
  readonly faceCamera: import('../render-contract').CameraSnapshot;
  readonly viewBindGroupDynamicOffset: number;
}

export interface CubeCaptureGraphState {
  work: readonly CubeCaptureGraphWork[];
  reflectionProbes?: ReflectionProbeGraphState;
}

export interface ReflectionProbeFilterGraphWork {
  readonly probeIndex: number;
  readonly faceIndex: number;
  readonly mipLevel: number;
}

export interface ReflectionProbeFilterGraphState {
  readonly work: readonly ReflectionProbeFilterGraphWork[];
  readonly maxStepsPerFrame: number;
}

export interface ReflectionProbeGraphWork {
  readonly probeIndex: number;
  readonly rawTexture: Texture;
  readonly rawCubeView: TextureView;
  readonly rawFaceViews: readonly TextureView[];
  readonly rawDepthTexture: Texture;
  readonly rawCaptureFace: number | undefined;
  readonly rawDepthView: TextureView;
  readonly rawSize: number;
  readonly faceCamera?: import('../render-contract').CameraSnapshot;
  readonly viewBindGroupDynamicOffset?: number;
  readonly filteredTexture: Texture;
  readonly filteredCubeView: TextureView;
  readonly filteredFaceViewsByMip: readonly (readonly TextureView[])[];
  readonly outputFormat: TextureFormat;
  readonly sampler: Sampler;
  readonly filterPipeline: RenderPipeline;
  readonly filterGroup0: BindGroup | undefined;
  readonly filterGroup1: BindGroup;
  readonly cubeVertexBuffer: Buffer;
  readonly filteredSize: number;
  readonly step: ReflectionProbeFilterGraphWork | undefined;
}

export interface ReflectionProbeGraphState {
  readonly work: readonly ReflectionProbeGraphWork[];
}

export function boundedReflectionProbeFilterWork(
  state: ReflectionProbeFilterGraphState,
): readonly ReflectionProbeFilterGraphWork[] {
  return state.work.slice(0, Math.max(0, state.maxStepsPerFrame));
}

function renderTargetMipCount(work: CubeCaptureGraphWork): number {
  const { descriptor } = work.physical;
  return descriptor.mipLevels === 1
    ? 1
    : Math.floor(Math.log2(Math.max(descriptor.width, descriptor.height))) + 1;
}

function addCubeCaptureGraphPasses(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  state: CubeCaptureGraphState,
): Result<void, RenderGraphError> {
  for (let index = 0; index < state.work.length; index += 1) {
    const slot = index;
    const initial = state.work[slot];
    if (initial === undefined) continue;
    const current = (): CubeCaptureGraphWork => state.work[slot] ?? initial;
    const texture = builder.importTexture(
      `cube-capture.${slot}.texture`,
      {
        format: initial.physical.descriptor.format,
        size: {
          width: initial.physical.descriptor.width,
          height: initial.physical.descriptor.height,
          depthOrArrayLayers: initial.physical.descriptor.sampleCount === 4 ? 1 : 6,
        },
        mipLevelCount:
          initial.physical.descriptor.sampleCount === 4 ? 1 : renderTargetMipCount(initial),
        sampleCount: initial.physical.descriptor.sampleCount,
        dimension: '2d',
        usage: 0x10 | 0x04 | 0x01,
      },
      () => current().physical.colorTextures[current().faceIndex] ?? initial.physical.texture,
    );
    if (!texture.ok) return texture;
    const color = builder.importView(
      texture.value,
      {
        label: `cube-capture.${slot}.color`,
        dimension: '2d',
        baseMipLevel: 0,
        mipLevelCount: 1,
        baseArrayLayer: initial.physical.descriptor.sampleCount === 4 ? 0 : initial.faceIndex,
        arrayLayerCount: 1,
      },
      () =>
        current().physical.faceViews[current().faceIndex] ??
        initial.physical.faceViews[initial.faceIndex] ??
        initial.physical.view,
    );
    if (!color.ok) return color;
    const depthTexture = builder.importTexture(
      `cube-capture.${slot}.depth-texture`,
      {
        format: 'depth24plus-stencil8',
        size: {
          width: initial.physical.descriptor.width,
          height: initial.physical.descriptor.height,
          depthOrArrayLayers: initial.physical.descriptor.sampleCount === 4 ? 1 : 6,
        },
        mipLevelCount: 1,
        sampleCount: initial.physical.descriptor.sampleCount,
        dimension: '2d',
        usage: 0x10,
      },
      () => current().physical.depthTextures[current().faceIndex] as Texture,
    );
    if (!depthTexture.ok) return depthTexture;
    const depth = builder.importView(
      depthTexture.value,
      {
        label: `cube-capture.${slot}.depth`,
        dimension: '2d',
        baseArrayLayer: initial.physical.descriptor.sampleCount === 4 ? 0 : initial.faceIndex,
        arrayLayerCount: 1,
      },
      () => current().physical.depthViews[current().faceIndex] as TextureView,
    );
    if (!depth.ok) return depth;
    const resolveTexture =
      initial.physical.descriptor.sampleCount === 4
        ? builder.importTexture(
            `cube-capture.${slot}.resolve-texture`,
            {
              format: initial.physical.descriptor.format,
              size: {
                width: initial.physical.descriptor.width,
                height: initial.physical.descriptor.height,
                depthOrArrayLayers: 6,
              },
              mipLevelCount: renderTargetMipCount(initial),
              sampleCount: 1,
              dimension: '2d',
              usage: 0x10 | 0x04 | 0x01,
            },
            () =>
              current().physical.resolveTexture ??
              initial.physical.resolveTexture ??
              initial.physical.texture,
          )
        : undefined;
    if (resolveTexture !== undefined && !resolveTexture.ok) return resolveTexture;
    const resolve =
      resolveTexture === undefined
        ? undefined
        : builder.importView(
            resolveTexture.value,
            {
              label: `cube-capture.${slot}.resolve`,
              dimension: '2d',
              baseMipLevel: 0,
              mipLevelCount: 1,
              baseArrayLayer: initial.faceIndex,
              arrayLayerCount: 1,
            },
            () =>
              current().physical.resolveFaceViews[current().faceIndex] ??
              initial.physical.resolveFaceViews[initial.faceIndex] ??
              initial.physical.resolveView,
          );
    if (resolve !== undefined && !resolve.ok) return resolve;
    const added = builder.addRasterPass(`cube-capture-face.${slot}`, {
      accesses: [
        { resource: color.value, usage: 'color-attachment' },
        { resource: depth.value, usage: 'depth-stencil-write' },
        ...(resolve === undefined
          ? []
          : [{ resource: resolve.value, usage: 'color-attachment' as const }]),
      ],
      colorAttachments: [
        {
          view: color.value,
          ...(resolve === undefined ? {} : { resolveTarget: resolve.value }),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: () => {
            return { r: 0, g: 0, b: 0, a: 1 };
          },
        },
      ],
      depthStencilAttachment: {
        view: depth.value,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        stencilClearValue: 0,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'store',
      },
      encode: ({ pass, frame, resources }) => {
        const internal = frame as _InternalRenderPipelineContext;
        const captureColor = resources.textureView(color.value);
        if (!captureColor.ok) return;
        const captureDepth = resources.textureView(depth.value);
        if (!captureDepth.ok) return;
        const captureResolve =
          resolve === undefined ? undefined : resources.textureView(resolve.value);
        if (resolve !== undefined && (captureResolve === undefined || !captureResolve.ok)) return;
        const captureResolveView = captureResolve?.ok ? captureResolve.value : null;
        const captureContext = {
          ...internal,
          gpuDrivenEntityKeys: new Set<number>(),
          camera: current().faceCamera,
          // Cube faces are raw scene captures, not display-camera HDR output.
          // Select the PSO against the actual target attachment so an LDR
          // cube target is rendered by a compatible forward pipeline.
          tonemapActive: false,
          skyboxActive: false,
          transparentColorFormat: initial.physical.descriptor.format as GPUTextureFormat,
          msaaActive: initial.physical.descriptor.sampleCount === 4,
          viewBindGroupDynamicOffset: current().viewBindGroupDynamicOffset,
          geometryColorView: captureColor.value,
          geometryDepthView: captureDepth.value,
          geometryColorResolveView: captureResolveView,
          splitLdrSprite: false,
          ldrSpritePassView: null,
        };
        encodeMainPass(captureContext, pass, undefined, {
          colorViews: [captureColor.value],
          colorFormats: [initial.physical.descriptor.format as GPUTextureFormat],
          depthView: captureDepth.value,
          passKind: 'forward',
          clearColor: [0, 0, 0, 1],
        });
      },
    });
    if (!added.ok) return added;
  }
  return ok(undefined);
}

export function addReflectionProbeGraphPasses(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  state: ReflectionProbeGraphState,
): Result<readonly import('@forgeax/engine-render-graph').GraphAccess[], RenderGraphError> {
  const accesses: import('@forgeax/engine-render-graph').GraphAccess[] = [];
  for (const work of state.work) {
    const raw = builder.importTexture(
      `reflection-probe.${work.probeIndex}.raw`,
      {
        format: work.outputFormat,
        size: { width: work.rawSize, height: work.rawSize, depthOrArrayLayers: 6 },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        usage: 0x10 | 0x04 | 0x01,
      },
      () => work.rawTexture,
    );
    if (!raw.ok) return raw;
    const rawCube = builder.importView(
      raw.value,
      {
        label: `reflection-probe.${work.probeIndex}.raw-cube`,
        dimension: 'cube',
        arrayLayerCount: 6,
      },
      () => work.rawCubeView,
    );
    if (!rawCube.ok) return rawCube;
    const filtered = builder.importTexture(
      `reflection-probe.${work.probeIndex}.filtered`,
      {
        format: work.outputFormat,
        size: { width: work.filteredSize, height: work.filteredSize, depthOrArrayLayers: 6 },
        mipLevelCount: work.filteredFaceViewsByMip.length,
        sampleCount: 1,
        dimension: '2d',
        usage: 0x10 | 0x04 | 0x01,
      },
      () => work.filteredTexture,
    );
    if (!filtered.ok) return filtered;
    const filteredCube = builder.importView(
      filtered.value,
      {
        label: `reflection-probe.${work.probeIndex}.filtered-cube`,
        dimension: 'cube',
        baseMipLevel: 0,
        mipLevelCount: work.filteredFaceViewsByMip.length,
        arrayLayerCount: 6,
      },
      () => work.filteredCubeView,
    );
    if (!filteredCube.ok) return filteredCube;
    if (work.rawCaptureFace !== undefined) {
      const face = work.rawCaptureFace;
      const view = builder.importView(
        raw.value,
        {
          label: `reflection-probe.${work.probeIndex}.capture-face-${face}`,
          dimension: '2d',
          baseArrayLayer: face,
          arrayLayerCount: 1,
        },
        () => work.rawFaceViews[face] as TextureView,
      );
      if (!view.ok) return view;
      const depthTexture = builder.importTexture(
        `reflection-probe.${work.probeIndex}.capture-depth`,
        {
          format: 'depth24plus-stencil8',
          size: { width: work.rawSize, height: work.rawSize, depthOrArrayLayers: 1 },
          mipLevelCount: 1,
          sampleCount: 1,
          dimension: '2d',
          usage: 0x10,
        },
        () => work.rawDepthTexture,
      );
      if (!depthTexture.ok) return depthTexture;
      const depth = builder.importView(
        depthTexture.value,
        { label: `reflection-probe.${work.probeIndex}.capture-depth-view`, dimension: '2d' },
        () => work.rawDepthView,
      );
      if (!depth.ok) return depth;
      const added = builder.addRasterPass(`reflection-probe.${work.probeIndex}.capture.${face}`, {
        accesses: [
          { resource: view.value, usage: 'color-attachment' },
          { resource: depth.value, usage: 'depth-stencil-write' },
        ],
        colorAttachments: [
          {
            view: view.value,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
        depthStencilAttachment: {
          view: depth.value,
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          stencilClearValue: 0,
          stencilLoadOp: 'clear',
          stencilStoreOp: 'store',
        },
        encode: ({ pass, frame, resources }) => {
          const internal = frame as _InternalRenderPipelineContext;
          const captureColor = resources.textureView(view.value);
          const captureDepth = resources.textureView(depth.value);
          if (!captureColor.ok || !captureDepth.ok) return;
          if (work.faceCamera === undefined || work.viewBindGroupDynamicOffset === undefined)
            return;
          encodeMainPass(
            {
              ...internal,
              camera: work.faceCamera,
              viewBindGroupDynamicOffset: work.viewBindGroupDynamicOffset,
              geometryColorView: captureColor.value,
              geometryDepthView: captureDepth.value,
              geometryColorResolveView: null,
              transparentColorFormat: work.outputFormat as GPUTextureFormat,
              msaaActive: false,
              splitLdrSprite: false,
              ldrSpritePassView: null,
            },
            pass,
            undefined,
            {
              colorViews: [captureColor.value],
              colorFormats: [work.outputFormat as GPUTextureFormat],
              depthView: captureDepth.value,
              passKind: 'forward',
              clearColor: [0, 0, 0, 1],
            },
          );
        },
      });
      if (!added.ok) return added;
    }
    const step = work.step;
    if (step !== undefined) {
      const mipViews = work.filteredFaceViewsByMip[step.mipLevel];
      const outputView = mipViews?.[step.faceIndex];
      if (outputView === undefined) {
        return err(
          new RenderGraphError({
            code: 'resource-resolution-failed',
            expected: 'every scheduled probe mip has a filtered face view',
            hint: 'rebuild the renderer-owned probe output before compiling the Standard graph',
            detail: {
              resourceLabel: `reflection-probe.${work.probeIndex}.filtered`,
              passName: 'pmrem',
            },
          }),
        );
      }
      const output = builder.importView(
        filtered.value,
        {
          label: `reflection-probe.${work.probeIndex}.filtered-mip${step.mipLevel}-face${step.faceIndex}`,
          dimension: '2d',
          baseMipLevel: step.mipLevel,
          mipLevelCount: 1,
          baseArrayLayer: step.faceIndex,
          arrayLayerCount: 1,
        },
        () => outputView,
      );
      if (!output.ok) return output;
      const added = builder.addRasterPass(
        `reflection-probe.${work.probeIndex}.pmrem.${step.mipLevel}.${step.faceIndex}`,
        {
          accesses: [
            { resource: rawCube.value, usage: 'sampled-read' },
            { resource: output.value, usage: 'color-attachment' },
          ],
          colorAttachments: [
            {
              view: output.value,
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
          encode: ({ pass }) => {
            if (work.filterGroup0 === undefined) return;
            pass.setPipeline(work.filterPipeline);
            pass.setBindGroup(0, work.filterGroup0);
            pass.setBindGroup(1, work.filterGroup1);
            pass.setVertexBuffer(0, work.cubeVertexBuffer);
            pass.draw(6, 1, step.faceIndex * 6, 0);
          },
        },
      );
      if (!added.ok) return added;
    }
    accesses.push({ resource: filteredCube.value, usage: 'sampled-read' });
  }
  return ok(accesses);
}

export {
  projectRenderTargetGraph,
  type RenderTargetGraphInput,
  type RenderTargetGraphProjection,
  type RenderTargetGraphSubresource,
} from '../targets/graph-projection';

export interface RenderFeatureGraphRuntimeState {
  plans: readonly RenderFeaturePlannedFrame[];
  fullscreenEffects: ReadonlyMap<
    string,
    import('../fullscreen-post-process-pass').PostProcessShaderEntry
  >;
}

/** A frame-local graph candidate that is committed only after compilation. */
export interface RenderFeatureGraphCandidate {
  readonly plans: readonly RenderFeaturePlannedFrame[];
  readonly fullscreenEffects: ReadonlyMap<
    string,
    import('../fullscreen-post-process-pass').PostProcessShaderEntry
  >;
  /**
   * Physical prepared resources are imported into the compiled graph. A new
   * prepared batch therefore needs a new graph even when the declarative plan
   * signature is unchanged; otherwise queue retirement can destroy the buffer
   * still referenced by the memoized graph.
   */
  readonly preparedResourceKey?: string;
  /** Release candidate-owned prepared resources when graph promotion fails. */
  readonly onRejected?: () => void;
  /** Publish candidate-owned runtime declarations only after graph promotion. */
  readonly onAccepted?: () => void;
  /** Discard candidate-only resources when a base graph is kept as fallback. */
  readonly onAbandoned?: () => void;
}

const featureGraphStates = new WeakMap<RenderSystemInternals, RenderFeatureGraphRuntimeState>();
const graphDeviceGenerations = new WeakMap<object, number>();

interface TimingInstrumentationState {
  readonly instrumentation: RenderGraphPassInstrumentation<RenderPipelineFrame>;
  setCapture(capture: GpuPassTimingCapture | undefined): void;
}

const timingInstrumentationStates = new WeakMap<
  RenderSystemInternals,
  TimingInstrumentationState
>();

type CompiledGraphTargetAccess = CompiledRenderGraph<RenderPipelineFrame> & {
  readonly getColorTargetDescriptor: (
    name: string,
  ) => import('@forgeax/engine-render-graph').ResolvedColorTargetDescriptor | undefined;
  readonly getColorTargetView: (name: string) => TextureView | undefined;
  readonly getColorTargetTexture: (name: string) => Texture | undefined;
};

export function getRenderFeatureGraphState(
  internals: RenderSystemInternals,
): RenderFeatureGraphRuntimeState {
  const existing = featureGraphStates.get(internals);
  if (existing !== undefined) return existing;
  const created: RenderFeatureGraphRuntimeState = {
    plans: [],
    fullscreenEffects: new Map(),
  };
  featureGraphStates.set(internals, created);
  return created;
}

export function resetRenderFeatureGraphState(internals: RenderSystemInternals): void {
  const state = getRenderFeatureGraphState(internals);
  state.plans = [];
  state.fullscreenEffects = new Map();
}

export function reportRenderFeatureGraphError(
  internals: RenderSystemInternals,
  error: RenderError,
): void {
  if (internals.featureHost !== undefined && 'detail' in error) {
    const detail = error.detail;
    if (detail !== undefined && 'featureIdentity' in detail && 'order' in detail) {
      const owned = internals.featureHost.recordError(detail.featureIdentity, error);
      internals.errorRegistry.fire(owned);
      return;
    }
  }
  internals.errorRegistry.fire(error);
}

export function renderFeatureGraphPlanSignature(
  plans: readonly RenderFeaturePlannedFrame[],
): string {
  return JSON.stringify(
    plans.map((planned) => [planned.featureIdentity, planned.generation, planned.signature]),
  );
}

/**
 * Admit fullscreen post-processes as one chain, never as independent passes.
 * A pass whose shader module is still compiling cannot clear a graph target and
 * leave the remainder of the chain sampling an undefined intermediate. The
 * renderer therefore keeps the base output-transform graph until every
 * requested effect is ready, then admits the complete ordered chain together.
 */
export function resolvePostProcessChainAdmission(
  effects: readonly string[],
  isReady: (identity: string) => boolean,
): { readonly admitted: readonly string[]; readonly pending: boolean } {
  // Probe every declaration even after the first miss.  A single frame may
  // introduce several effects; evaluating all of them lets the shared cache
  // start every independent compile together instead of serialising warmup on
  // array order.
  let ready = true;
  for (const identity of effects) {
    if (!isReady(identity)) ready = false;
  }
  return {
    admitted: ready ? effects : [],
    pending: !ready,
  };
}

function validateRenderFeaturePlans(
  plans: readonly RenderFeaturePlannedFrame[],
): Result<readonly RenderFeaturePlanExecution[], RenderError> {
  const identities = new Set<string>();
  const projected: RenderFeaturePlanExecution[] = [];
  let previousOrder = -1;
  for (const [order, planned] of plans.entries()) {
    const execution = getRenderFeaturePlanExecutionProjection(planned);
    if (
      identities.has(planned.featureIdentity) ||
      planned.signature !== renderFeaturePlanSignature(planned.plan) ||
      execution === undefined ||
      execution.featureIdentity !== planned.featureIdentity ||
      execution.order <= previousOrder
    ) {
      return err(
        new RenderFeatureStageFailedError(planned.featureIdentity, order, 'plan', 'next-frame'),
      );
    }
    identities.add(planned.featureIdentity);
    previousOrder = execution.order;
    projected.push(execution);
  }
  return ok(Object.freeze(projected));
}

function commitFeatureCandidate(
  internals: RenderSystemInternals,
  candidate: RenderFeatureGraphCandidate,
): void {
  // Publish renderer-owned declarations only after their device resources have
  // been admitted.  If the acceptance hook throws, the previously accepted
  // graph/state pair remains visible to the caller.
  candidate.onAccepted?.();
  const state = getRenderFeatureGraphState(internals);
  state.plans = candidate.plans;
  state.fullscreenEffects = candidate.fullscreenEffects;
}

function topologyOf(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  camera: CameraSnapshot,
  clearOnly: boolean,
  lights: ExtractedLights,
  width: number,
  height: number,
  shadowMapSize: number | undefined,
  gpuDriven: PreparedGpuDrivenFrame | undefined,
  featureGraphCandidate: RenderFeatureGraphCandidate | undefined,
  cubeCaptureState: CubeCaptureGraphState | undefined,
  transmissionDemand: TransmissionDemand | undefined,
  volumetricFog: ExtractedVolumetricFog | undefined,
  standardLighting: StandardTopologyInputValue | undefined,
): Result<RenderPipelineTopology, RhiError> {
  const cascadeCount = Math.max(1, Math.min(4, Math.round(lights.cascadeCount ?? 1))) as
    | 1
    | 2
    | 3
    | 4;
  const surfaceFormats = resolveSurfaceFormatPair(
    internals.device.caps.backendKind,
    pipelineState.format as GPUTextureFormat,
    pipelineState.colorAttachmentFormat as GPUTextureFormat,
  );
  const internal = internals.device as unknown as { readonly surfaceViewFormats?: boolean };
  const surfaceProfile = resolveSurfaceProfile(surfaceFormats.storage, surfaceFormats.view, {
    surfaceViewFormats:
      internal.surfaceViewFormats ?? internals.device.caps.backendKind !== 'wgpu-webgl2',
    rawAttachment:
      surfaceFormats.storage === 'rgba8unorm' || surfaceFormats.storage === 'bgra8unorm',
    floatRenderAttachment: internals.device.caps.rgba16floatRenderable,
  });
  if (!surfaceProfile.ok) return surfaceProfile;
  const featurePostEffects = [
    ...(featureGraphCandidate?.fullscreenEffects ??
      getRenderFeatureGraphState(internals).fullscreenEffects),
  ].map(([id]) => id);
  const featurePostEffectDeclarations = [
    ...(featureGraphCandidate?.fullscreenEffects ??
      getRenderFeatureGraphState(internals).fullscreenEffects),
  ].map(([id, entry]) => [id, postProcessShaderEntrySignature(entry)] as const);
  const config =
    featurePostEffects.length === 0
      ? frameState.installedPipelineConfig
      : {
          ...(frameState.installedPipelineConfig ?? {}),
          postEffects: [
            ...new Set([
              ...(frameState.installedPipelineConfig?.postEffects ?? []),
              ...featurePostEffects,
            ]),
          ],
        };
  const volumeCapability = hasVolumetricFogCapability(
    internals.device.caps,
    internals.volumetricFogShaders,
  );
  const selectedVolumeLight =
    volumetricFog?.lightKind === 'spot'
      ? lights.spot.find((light) => light.entity === volumetricFog.lightEntity)
      : volumetricFog?.lightKind === 'point'
        ? lights.point.find((light) => light.entity === volumetricFog.lightEntity)
        : volumetricFog?.lightKind === 'directional' &&
            lights.directional?.entity === volumetricFog.lightEntity
          ? lights.directional
          : volumetricFog?.lightKind === undefined
            ? lights.directional
            : undefined;
  return ok({
    pipelineId: STANDARD_PIPELINE_ID,
    standardProfile: internals.standardProfile,
    config,
    clearOnly,
    reflectionFallback: { enabled: frameState.reflectionFallbackDemand === true },
    surface: {
      width,
      height,
      storageFormat: surfaceFormats.storage as TextureFormat,
      viewFormat: surfaceProfile.value.viewFormat as TextureFormat,
      profile: surfaceProfile.value,
    },
    camera: {
      tonemap: camera.tonemap,
      antialias: camera.antialias,
      bloom: camera.bloom,
    },
    temporal: {
      taa: camera.antialias === 'taa',
      motionBlur: isMotionBlurTemporalDemand(camera.motionBlur),
    },
    shadow: {
      directional:
        shadowMapSize === undefined || lights.cascadeCount === undefined
          ? 'disabled'
          : { mapSize: shadowMapSize, cascadeCount },
      spotMapSize: shadowMapSize ?? 1024,
      pointCount: Math.min(SHADOW_ATLAS_DEFAULT_LAYERS, lights.pointShadow.length),
      pointFaceSize: lights.pointShadow[0]?.mapSize ?? SHADOW_ATLAS_DEFAULT_FACE_SIZE,
      spotCount: Math.min(
        4,
        lights.spot.filter(
          (light) => light.shadowAtlasTile >= 0 && light.lightViewProj !== undefined,
        ).length,
      ),
    },
    volumetricFog:
      volumetricFog?.status === 'available' &&
      volumetricFog.densityAsset?.shape.viewDimension === '3d' &&
      camera.tonemap !== 'none' &&
      selectedVolumeLight !== undefined &&
      volumeCapability
        ? (() => {
            const volumeProfile = resolveVolumetricFogProfile(internals.standardProfile ?? {});
            return {
              enabled: true,
              format: volumetricFog.densityAsset.format,
              extent: {
                width: volumetricFog.densityAsset.shape.extent.width,
                height: volumetricFog.densityAsset.shape.extent.height,
                depth: volumetricFog.densityAsset.shape.extent.depth,
              },
              froxelExtent: deriveVolumetricFogExtent(
                { width, height },
                volumeProfile.depth,
                volumeProfile.tileSize,
              ),
              resolvedExtent: deriveVolumetricFogResolvedExtent(
                { width, height },
                volumeProfile.tileSize,
              ),
              lightKind: volumetricFog.lightKind,
              lightEntity: volumetricFog.lightEntity,
              pointLightEntity: volumetricFog.pointLightEntity,
              spotLightEntity: volumetricFog.spotLightEntity,
              ...(volumetricFog.projector === undefined
                ? {}
                : {
                    projector: {
                      guid: volumetricFog.projector.guid,
                      generation: volumetricFog.projector.generation,
                      revision: volumetricFog.projector.revision,
                    },
                  }),
            };
          })()
        : { enabled: false },
    lane: {
      compute: internals.device.caps.compute,
      storageBuffer: internals.device.caps.storageBuffer,
      multisample: internals.device.caps.backendKind !== 'wgpu-webgl2',
      maxColorAttachments: internals.device.caps.maxColorAttachments,
    },
    featureTopologySignature: JSON.stringify({
      plans: renderFeatureGraphPlanSignature(
        featureGraphCandidate?.plans ?? getRenderFeatureGraphState(internals).plans,
      ),
      fullscreenEffects: featurePostEffectDeclarations,
      preparedResourceKey: featureGraphCandidate?.preparedResourceKey ?? '',
      cubeCaptureSlots: cubeCaptureState?.work.length ?? 0,
    }),
    gpuDrivenTopologySignature: gpuDriven?.topologySignature ?? '',
    standardLightingTopologySignature: standardLightingTopologySignature(standardLighting),
    transmissionDemand: transmissionDemand ?? {
      activeCount: 0,
      needsRoughMips: false,
    },
  });
}

function targetResolver(
  targets: readonly RenderPipelineFeatureTarget[],
  semanticTargets: readonly import('../render-pipeline').RenderPipelineTarget[] = [],
  namedTargets: Readonly<Record<string, import('../render-pipeline').RenderPipelineTarget>> = {},
): RenderFeatureGraphTargetResolver {
  return (resource) => {
    const namedKey =
      typeof resource === 'string'
        ? resource
        : isRenderFeatureTargetHandle(resource)
          ? resource.name
          : undefined;
    if (namedKey !== undefined) {
      const named = namedTargets[namedKey];
      if (named !== undefined) {
        return {
          texture: named.texture,
          view: named.view,
          ...(named.resolveTarget === undefined ? {} : { resolveTarget: named.resolveTarget }),
        };
      }
    }
    if (isSceneDataTarget(resource)) {
      const semantic = semanticTargets.find(
        (candidate) =>
          candidate.format === resource.format && candidate.sampleCount === resource.sampleCount,
      );
      return semantic === undefined
        ? undefined
        : { texture: semantic.texture, view: semantic.view };
    }
    if (!isRenderFeatureTargetHandle(resource)) return undefined;
    const target = targets.find(
      (candidate) =>
        candidate.kind === resource.kind &&
        candidate.format === resource.format &&
        candidate.sampleCount === resource.sampleCount,
    );
    return target === undefined
      ? undefined
      : {
          texture: target.texture,
          view: target.view,
          ...(target.resolveTarget === undefined ? {} : { resolveTarget: target.resolveTarget }),
        };
  };
}

function resolveTargetBindings(
  input: {
    readonly frame: RenderPipelineFrame;
    readonly binding: import('../prepare/prepared-graphics-resolver').PreparedGraphicsResolvedResource & {
      readonly kind: 'bindings';
    };
    readonly resources: GraphResourceResolver;
    readonly resolveTarget: RenderFeatureGraphTargetResolver;
  },
  featurePostProcessEntries?: ReadonlyMap<string, PostProcessShaderEntry>,
): RenderFeatureGraphBindingsResolution | undefined {
  const frame = input.frame as import('./render-context')._InternalRenderPipelineContext;
  const descriptor = input.binding.descriptor;
  const pipeline = input.binding.pipeline as
    | (RenderPipeline & { getBindGroupLayout?: (index: number) => BindGroupLayout })
    | undefined;
  const sceneDepth = descriptor?.values.sceneDepth;
  const sceneDepthBinding = descriptor?.values.sceneDepthBinding;
  if (pipeline === undefined) return undefined;
  if (descriptor?.values.fullscreen === true && isTemporalFullscreenBinding(descriptor.values)) {
    const shader = descriptor.values.shader;
    if (typeof shader !== 'string') return undefined;
    const entry =
      featurePostProcessEntries?.get(shader) ?? frame.runtime.lookupPostProcess?.(shader);
    if (entry === undefined) return undefined;
    const fullscreen = buildFullscreenPostProcessPass(
      { device: frame.runtime.device, errorRegistry: frame.runtime.errorRegistry },
      entry,
      isRenderFeatureTargetHandle(descriptor.values.depth) &&
        descriptor.values.depth.sampleCount === 4,
    );
    if (fullscreen === null || fullscreen.sampler === null) return undefined;
    const inputTarget = input.resolveTarget(descriptor.values.input as never);
    const temporalTarget = input.resolveTarget(descriptor.values.temporal as never);
    if (inputTarget === undefined || temporalTarget === undefined) return undefined;
    const inputView = input.resources.textureView(inputTarget.view);
    const temporalView = input.resources.textureView(temporalTarget.view);
    if (!inputView.ok || !temporalView.ok) return undefined;
    const layout = pipeline.getBindGroupLayout?.(1);
    if (layout === undefined) return undefined;
    const depth = input.resolveTarget(descriptor.values.depth as never);
    const depthView =
      depth === undefined
        ? undefined
        : (() => {
            const depthTexture = input.resources.texture(depth.texture);
            if (!depthTexture.ok) return undefined;
            const created = frame.runtime.device.createTextureView(depthTexture.value as Texture, {
              aspect: 'depth-only',
              dimension: '2d',
            });
            return created.ok ? created.value : undefined;
          })();
    if (depth !== undefined && (depthView === undefined || fullscreen.depthSampler === null)) {
      return undefined;
    }
    return (
      createFullscreenBindGroup(
        frame.runtime.device,
        layout,
        inputView.value,
        fullscreen.sampler,
        frame.runtime.getPostProcessParamsBuffer?.(shader),
        depthView ?? null,
        fullscreen.depthSampler,
        [{ binding: fullscreen.extraColorBindings[0] ?? 5, view: temporalView.value }],
      ) ?? undefined
    );
  }
  if (sceneDepthBinding === 1) {
    const target = sceneDepth === undefined ? undefined : input.resolveTarget(sceneDepth);
    const depthView =
      target === undefined
        ? frame.pipelineState.shadowFallbackTextureView
        : (() => {
            const texture = input.resources.texture(target.texture);
            if (!texture.ok) throw texture.error;
            const created = frame.runtime.device.createTextureView(texture.value as Texture, {
              aspect: 'depth-only',
              dimension: '2d',
            });
            if (!created.ok) throw created.error;
            return created.value;
          })();
    const layout = pipeline.getBindGroupLayout?.(0);
    if (layout === undefined) return undefined;
    const created = frame.runtime.device.createBindGroup({
      layout,
      entries: [
        {
          binding: 0,
          resource: {
            kind: 'buffer',
            value: { buffer: frame.pipelineState.viewUniformBuffer },
          },
        },
        { binding: 1, resource: { kind: 'textureView', value: depthView } },
      ],
    });
    if (!created.ok) throw created.error;
    return created.value;
  }
  if (sceneDepth === undefined) {
    const viewBindGroup = buildPerFrameBindGroups(
      frame.runtime as RenderSystemInternals,
      frame.frameState,
      frame.pipelineState,
      frame.validated.length > 0,
      frame.bindGroupCounts,
      {
        directionalShadow: frame.frameState.currentDirectionalShadowView ?? undefined,
        spotShadow: frame.frameState.currentSpotShadowView ?? undefined,
      },
      true,
      frame.standardLighting,
    ).viewBindGroup;
    return viewBindGroup === null ? undefined : { handle: viewBindGroup, dynamicOffsets: [0, 0] };
  }
  const target = input.resolveTarget(sceneDepth);
  if (target === undefined) return undefined;
  const texture = input.resources.texture(target.texture);
  if (!texture.ok) throw texture.error;
  const depthView = frame.runtime.device.createTextureView(texture.value as Texture, {
    aspect: 'depth-only',
    dimension: '2d',
  });
  if (!depthView.ok) throw depthView.error;
  const group = descriptor?.values.group === 1 ? 1 : 0;
  const layout = pipeline.getBindGroupLayout?.(group);
  if (layout === undefined) return undefined;
  const created = frame.runtime.device.createBindGroup({
    layout,
    entries: [{ binding: 0, resource: { kind: 'textureView', value: depthView.value } }],
  });
  if (!created.ok) throw created.error;
  return created.value;
}

function retire(
  frameState: RenderFrameState,
  graph: CompiledRenderGraph<RenderPipelineFrame>,
): void {
  frameState.retiredCompiledFrameGraphs.add(graph);
  graph
    .retire()
    .finally(() => frameState.retiredCompiledFrameGraphs.delete(graph))
    .catch(() => undefined);
}

/**
 * Settle a volume topology candidate after the command buffer outcome is
 * known. A graph that failed to encode, finish, or submit must never become
 * the next frame's accepted graph: retire it and restore the prior graph (or
 * leave the renderer without a graph when this was the first attempt).
 */
export function settleVolumetricFogGraphCandidate(
  frameState: RenderFrameState,
  submitted: boolean,
): void {
  const candidate = frameState.volumetricFogCandidateGraph ?? null;
  if (candidate === null) return;
  const previous = frameState.volumetricFogPreviousGraph ?? null;
  const previousKey = frameState.volumetricFogPreviousGraphKey ?? null;
  if (submitted) {
    if (previous !== null && previous !== candidate) retire(frameState, previous);
  } else {
    if (candidate !== previous) retire(frameState, candidate);
    frameState.compiledFrameGraph = previous;
    frameState.compiledFrameGraphTopologyKey = previousKey;
  }
  frameState.volumetricFogPreviousGraph = null;
  frameState.volumetricFogPreviousGraphKey = null;
  frameState.volumetricFogCandidateGraph = null;
}

export function ensureCompiledFrameGraph(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  camera: CameraSnapshot,
  lights: ExtractedLights,
  width: number,
  height: number,
  shadowMapSize: number | undefined,
  gpuDriven?: PreparedGpuDrivenFrame,
  featureGraphCandidate?: RenderFeatureGraphCandidate,
  cubeCaptureState?: CubeCaptureGraphState,
  clearOnly = false,
  transmissionDemand?: TransmissionDemand,
  occlusion?: import('../scene/visibility/occlusion-runtime').OcclusionFrameProjection,
  volumetricFog?: ExtractedVolumetricFog,
  volumeTopologyCandidate = false,
  standardLighting?: StandardTopologyInputValue,
  onRecoveryError?: (error: unknown) => void,
): CompiledRenderGraph<RenderPipelineFrame> | null {
  const requestedStandardLightingSignature = standardLightingTopologySignature(standardLighting);
  const lastKnownGood = (): CompiledRenderGraph<RenderPipelineFrame> | null =>
    frameState.compiledFrameGraph !== null &&
    frameState.standardLightingGraphSignature === requestedStandardLightingSignature
      ? frameState.compiledFrameGraph
      : null;
  const surfaceWidth = Math.max(1, width);
  const surfaceHeight = Math.max(1, height);
  const featurePlans = featureGraphCandidate?.plans ?? getRenderFeatureGraphState(internals).plans;
  const projectedFeaturePlans = validateRenderFeaturePlans(featurePlans);
  if (!projectedFeaturePlans.ok) {
    onRecoveryError?.(projectedFeaturePlans.error);
    reportRenderFeatureGraphError(internals, projectedFeaturePlans.error);
    featureGraphCandidate?.onRejected?.();
    return volumeTopologyCandidate ? null : lastKnownGood();
  }
  const topologyResult = topologyOf(
    internals,
    frameState,
    pipelineState,
    camera,
    clearOnly,
    lights,
    surfaceWidth,
    surfaceHeight,
    shadowMapSize,
    gpuDriven,
    featureGraphCandidate,
    cubeCaptureState,
    transmissionDemand,
    volumetricFog,
    standardLighting,
  );
  if (!topologyResult.ok) {
    onRecoveryError?.(topologyResult.error);
    internals.errorRegistry.fire(topologyResult.error);
    featureGraphCandidate?.onRejected?.();
    return volumeTopologyCandidate ? null : lastKnownGood();
  }
  const requestedPostEffects = topologyResult.value.config?.postEffects ?? [];
  const featurePostProcessEntries =
    featureGraphCandidate?.fullscreenEffects ??
    getRenderFeatureGraphState(internals).fullscreenEffects;
  const postProcessAdmission = resolvePostProcessChainAdmission(
    requestedPostEffects,
    (identity) => {
      const entry =
        featurePostProcessEntries.get(identity) ?? internals.lookupPostProcess?.(identity);
      // Preserve the existing missing-entry failure contract. The graph will
      // report post-process-not-found during record instead of silently
      // removing an authored id from the topology.
      if (entry === undefined) return true;
      const buildPipeline = internals.buildPostProcessPipeline;
      const getPipeline = internals.getPostProcessPipeline;
      if (buildPipeline === undefined || getPipeline === undefined) return true;
      const built = buildFullscreenPostProcessPass(
        { device: internals.device, errorRegistry: internals.errorRegistry },
        entry,
        camera.antialias === 'msaa' && topologyResult.value.lane.multisample,
      );
      if (built === null) return false;
      return (
        getPipeline(
          identity,
          built.bindGroupLayout,
          topologyResult.value.surface.storageFormat as GPUTextureFormat,
          entry,
        ) !== null
      );
    },
  );
  const acceptedLkg = lastKnownGood();
  if (postProcessAdmission.pending && acceptedLkg !== null) {
    // Do not publish a candidate whose fullscreen chain is only partially
    // ready. Keep the accepted graph (including its prior post-effect chain)
    // and retry the same feature candidate on the next frame.
    featureGraphCandidate?.onRejected?.();
    return acceptedLkg;
  }
  const topology = postProcessAdmission.pending
    ? {
        ...topologyResult.value,
        config: {
          ...(topologyResult.value.config ?? {}),
          postEffects: [],
        },
      }
    : topologyResult.value;
  const key = JSON.stringify({
    topology,
    // GPU-driven residency can become available after the first record pass
    // (custom mesh handles are resolved into the per-frame projection).  The
    // topology signature alone is intentionally stable across that lifecycle,
    // so include the prepared projection's presence to invalidate a cached
    // CPU-only graph when the GPU owner becomes ready, and vice versa.
    gpuDrivenProjectionActive: gpuDriven !== undefined,
    // Query reservations are frame-local transport state. The projection is
    // renderer-owned and read dynamically by the compiled pass, so a page
    // rotation must not invalidate the graph or its cached bind groups.
    occlusionQuery:
      occlusion === undefined ? undefined : { active: true, sampleCount: occlusion.sampleCount },
    cubeCaptureSlots: cubeCaptureState?.work.length ?? 0,
    reflectionProbeSlots: cubeCaptureState?.reflectionProbes?.work.map((work) => [
      work.probeIndex,
      work.rawCaptureFace ?? -1,
      work.step?.faceIndex ?? -1,
      work.step?.mipLevel ?? -1,
    ]),
  });
  if (frameState.compiledFrameGraph !== null && frameState.compiledFrameGraphTopologyKey === key) {
    frameState.standardLightingGraphSignature = requestedStandardLightingSignature;
    if (featureGraphCandidate !== undefined && !postProcessAdmission.pending) {
      commitFeatureCandidate(internals, featureGraphCandidate);
    } else if (featureGraphCandidate !== undefined) {
      featureGraphCandidate.onAbandoned?.();
    }
    // A candidate flag only describes a possible topology replacement. When
    // the derived key is unchanged there is no replacement to stage: reuse the
    // accepted graph so dynamic volume history/imported views can advance and
    // a queue-submit failure can still publish the LKG diagnostic.
    return frameState.compiledFrameGraph;
  }

  const builder = new RenderGraphBuilder<RenderPipelineFrame>();
  const taaHistory = camera.antialias === 'taa' ? importTemporalHistoryTargets(builder) : undefined;
  let projectedFeatures = false;
  let projectedGpuDriven = false;
  const built = frameState.activePipeline.build(
    {
      graph: builder,
      ...(standardLighting === undefined ? {} : { standardLighting }),
      capabilities: { rgba16floatRenderable: internals.device.caps.rgba16floatRenderable },
      ...(occlusion === undefined ? {} : { occlusion }),
      ...(taaHistory === undefined ? {} : { taaHistory }),
      encodeTransmissionMip: ({ pass, resources, source }) => {
        const sourceView = resources.textureView(source);
        if (!sourceView.ok) throw sourceView.error;
        const encoded = encodeMipmapLevel(internals.device, pass, sourceView.value, 'rgba16float');
        if (!encoded.ok) throw encoded.error;
      },
      projectGpuDriven: (target) => {
        if (projectedGpuDriven || gpuDriven === undefined) return ok(undefined);
        projectedGpuDriven = true;
        return gpuDriven.project(builder, target.format, target.sampleCount);
      },
      contributeFeatures: (targets, semanticTargets = [], namedTargets = {}) => {
        if (projectedFeatures) return ok(undefined);
        projectedFeatures = true;
        if (projectedFeaturePlans.value.length === 0) return ok(undefined);
        const resolveTarget = targetResolver(targets, semanticTargets, namedTargets);
        const projected = projectPlanExecutions(builder, projectedFeaturePlans.value, {
          resolveTarget,
          resolveBindings: (input) => resolveTargetBindings(input, featurePostProcessEntries),
          reportError: (error) => reportRenderFeatureGraphError(internals, error),
        });
        return projected.ok ? ok(undefined) : projected;
      },
      contributeCubeCaptures: () => {
        const reflectionProbes = addReflectionProbeGraphPasses(
          builder,
          cubeCaptureState?.reflectionProbes ?? { work: [] },
        );
        if (!reflectionProbes.ok) return reflectionProbes;
        return cubeCaptureState === undefined
          ? ok(undefined)
          : addCubeCaptureGraphPasses(builder, cubeCaptureState);
      },
      hasFeature: (identity) =>
        projectedFeaturePlans.value.some((execution) => execution.featureIdentity === identity),
    },
    topology,
  );
  if (!built.ok) {
    onRecoveryError?.(built.error);
    internals.errorRegistry.fire(built.error);
    featureGraphCandidate?.onRejected?.();
    return volumeTopologyCandidate ? null : lastKnownGood();
  }
  const compiled = builder.compile({
    device: internals.device,
    surfaceSize: { width: surfaceWidth, height: surfaceHeight },
  });
  if (!compiled.ok) {
    onRecoveryError?.(compiled.error);
    internals.errorRegistry.fire(compiled.error);
    featureGraphCandidate?.onRejected?.();
    return lastKnownGood();
  }
  const previous = frameState.compiledFrameGraph;
  if (volumeTopologyCandidate) {
    frameState.volumetricFogPreviousGraph = previous;
    frameState.volumetricFogPreviousGraphKey = frameState.compiledFrameGraphTopologyKey;
    frameState.volumetricFogCandidateGraph = compiled.value;
  }
  frameState.compiledFrameGraph = compiled.value;
  frameState.compiledFrameGraphTopologyKey = key;
  frameState.standardLightingGraphSignature = requestedStandardLightingSignature;
  frameState.compiledFrameGraphGeneration += 1;
  const compiledTargets = compiled.value as CompiledGraphTargetAccess;
  frameState.graphGeneration += 1;
  frameState.perFrameGraph = {
    getColorTargetDescriptor: (name) => compiledTargets.getColorTargetDescriptor(name),
    getColorTargetView: (name) => compiledTargets.getColorTargetView(name),
    getColorTargetTexture: (name) => compiledTargets.getColorTargetTexture(name),
    graphGeneration: frameState.graphGeneration,
  };
  const deviceGeneration = internals.deviceScope?.generation;
  if (deviceGeneration !== undefined) {
    graphDeviceGenerations.set(compiled.value, deviceGeneration);
  }
  gpuDriven?._commitResourceReplacement();
  if (featureGraphCandidate !== undefined && !postProcessAdmission.pending) {
    commitFeatureCandidate(internals, featureGraphCandidate);
  } else if (featureGraphCandidate !== undefined) {
    featureGraphCandidate.onAbandoned?.();
  }
  if (!volumeTopologyCandidate && previous !== null) retire(frameState, previous);
  return compiled.value;
}

export function executeCompiledFrameGraph(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  frame: RenderPipelineFrame,
  encoder: RhiCommandEncoder,
  runPass?: import('@forgeax/engine-render-graph').RenderGraphPassRunner,
  frameHooks?: {
    readonly afterGraphExecute?: () => Result<void, RhiError>;
    readonly onSubmitted?: () => void;
    readonly onAborted?: () => void;
  },
  readbackFaces?: readonly number[],
  onSubmitted?: (completed: Promise<unknown>) => void,
  timingCapture?: GpuTimingCapture,
): boolean {
  const graph = frameState.compiledFrameGraph;
  const rejectTemporalFrame = (): void => {
    if (frameState.temporalFrameInput === undefined) return;
    frameState.temporalFrameTransaction.commit({ accepted: false });
    frameState.temporalFrameInput = undefined;
  };
  if (graph === null) {
    timingCapture?.discard();
    settleVolumetricFogGraphCandidate(frameState, false);
    rejectTemporalFrame();
    return false;
  }
  const legacyTimingInstrumentation =
    timingCapture === undefined ? undefined : createTimingInstrumentation(timingCapture);
  const timingHost = internals as RenderSystemInternals & {
    gpuPassTimingSession?: GpuPassTimingSession | undefined;
    gpuPassTimingCapture?: GpuPassTimingCapture | undefined;
    gpuPassTimingSubmittedWork?: Promise<void> | undefined;
    gpuPassTimingFrameIdentity?:
      | import('./gpu-pass-timing/session.js').GpuPassTimingFrameIdentity
      | undefined;
    gpuPassTimingBeginReason?:
      | import('./gpu-pass-timing/errors.js').GpuPassTimingReason
      | undefined;
  };
  timingHost.gpuPassTimingCapture = undefined;
  timingHost.gpuPassTimingSubmittedWork = undefined;
  timingHost.gpuPassTimingBeginReason = undefined;
  const timingIdentity = timingHost.gpuPassTimingFrameIdentity;
  const passTimingResult =
    timingIdentity === undefined
      ? undefined
      : timingHost.gpuPassTimingSession?.beginFrame({
          ...timingIdentity,
          graphGeneration: frameState.compiledFrameGraphGeneration,
        });
  const capture = passTimingResult?.ok === true ? passTimingResult.value : undefined;
  if (passTimingResult?.ok === false) timingHost.gpuPassTimingBeginReason = passTimingResult.error;
  const passTimingCapture = capture;
  timingHost.gpuPassTimingCapture = passTimingCapture;
  const timingInstrumentationState =
    passTimingCapture !== undefined
      ? getTimingInstrumentationState(internals, passTimingCapture)
      : timingCapture === undefined
        ? undefined
        : undefined;
  const graphInstrumentation =
    passTimingCapture !== undefined
      ? timingInstrumentationState?.instrumentation
      : legacyTimingInstrumentation;
  type PreparedCommand = { readonly command: CommandBuffer };
  let preparedCommand: PreparedCommand = { command: undefined as never };
  const deviceScope = internals.deviceScope;
  const graphDeviceGeneration = graphDeviceGenerations.get(graph);
  if (
    graphDeviceGeneration !== undefined &&
    deviceScope !== undefined &&
    graphDeviceGeneration !== deviceScope.generation
  ) {
    internals.errorRegistry.fire(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'the compiled frame graph belongs to the active device generation',
        hint: 'discard the stale graph and rebuild it from the retained logical frame plan',
        detail: {
          error: {
            code: 'stale-frame-graph-generation',
            message: `graph=${graphDeviceGeneration}; current=${deviceScope.generation}`,
          },
        },
      }),
    );
    return false;
  }
  const capturedGeneration = deviceScope?.generation;
  const transaction = executeRendererFrameTransaction<PreparedCommand>({
    build: () => ({ ok: true, value: { command: undefined as never } }),
    execute: () => {
      const executed = graph.execute(frame, runPass, graphInstrumentation);
      timingInstrumentationState?.setCapture(undefined);
      if (!executed.ok) {
        passTimingCapture?.abort({ code: executed.error.code });
        internals.errorRegistry.fire(executed.error);
        return { ok: false, stage: 'execute' };
      }
      const afterGraphExecute = frameHooks?.afterGraphExecute;
      if (afterGraphExecute !== undefined) {
        const recorded = afterGraphExecute();
        if (!recorded.ok) {
          internals.errorRegistry.fire(recorded.error);
          return { ok: false, stage: 'execute' };
        }
      }
      return { ok: true, value: undefined };
    },
    finish: () => {
      const graphCapture = frameState.graphTargetCapture;
      frameState.graphTargetCapture = undefined;
      if (graphCapture !== undefined) {
        const graphAccess = frameState.perFrameGraph;
        const graphTexture = graphAccess?.getColorTargetTexture(graphCapture.name);
        const descriptor = graphAccess?.getColorTargetDescriptor(graphCapture.name);
        const frameId = frameState.frameNumber;
        const captureFailure = (message: string): void => {
          internals.errorRegistry.fire(
            new RhiError({
              code: 'webgpu-runtime-error',
              expected:
                'the requested graph target is present in the current graph with a matching copy-readable descriptor',
              hint: 'inspect the target name, graph generation/frame, texture identity, format, extent, and COPY_SRC usage',
              detail: {
                error: {
                  code: 'graph-target-capture-failed',
                  message,
                },
              },
            }),
          );
        };
        if (
          graphAccess === undefined ||
          graphAccess === null ||
          graphTexture === undefined ||
          descriptor === undefined
        ) {
          captureFailure(
            JSON.stringify({
              target: graphCapture.name,
              graphGeneration: graphAccess?.graphGeneration,
              frameId,
              textureIdentity:
                graphTexture === undefined ? undefined : getTextureIdentity(graphTexture),
              reason: 'target-not-present-in-current-graph',
            }),
          );
        } else if (
          descriptor.size.width !== graphCapture.width ||
          descriptor.size.height !== graphCapture.height
        ) {
          captureFailure(
            JSON.stringify({
              target: graphCapture.name,
              graphGeneration: graphAccess.graphGeneration,
              frameId,
              textureIdentity: getTextureIdentity(graphTexture),
              expectedFormat: graphCapture.expected.format,
              actualFormat: descriptor.format,
              expectedExtent: { width: graphCapture.width, height: graphCapture.height },
              actualExtent: descriptor.size,
              reason: 'extent-mismatch',
            }),
          );
        } else if ((descriptor.usage & GPU_TEXTURE_USAGE_COPY_SRC) === 0) {
          captureFailure(
            JSON.stringify({
              target: graphCapture.name,
              graphGeneration: graphAccess.graphGeneration,
              frameId,
              textureIdentity: getTextureIdentity(graphTexture),
              format: descriptor.format,
              extent: descriptor.size,
              usage: descriptor.usage,
              reason: 'copy-src-usage-missing',
            }),
          );
        } else if (
          descriptor.format !== graphCapture.expected.format ||
          descriptor.size.width !== graphCapture.expected.width ||
          descriptor.size.height !== graphCapture.expected.height ||
          (descriptor.usage & graphCapture.expected.usage) !== graphCapture.expected.usage
        ) {
          captureFailure(
            JSON.stringify({
              target: graphCapture.name,
              graphGeneration: graphAccess.graphGeneration,
              frameId,
              textureIdentity: getTextureIdentity(graphTexture),
              expected: graphCapture.expected,
              actual: {
                format: descriptor.format,
                width: descriptor.size.width,
                height: descriptor.size.height,
                usage: descriptor.usage,
              },
              reason: 'descriptor-mismatch',
            }),
          );
        } else if (
          graphCapture.expected.identity !== undefined &&
          (graphAccess.graphGeneration !== graphCapture.expected.identity.graphGeneration ||
            graphCapture.expected.identity.frameId !== frameId ||
            graphCapture.expected.identity.textureIdentity !== getTextureIdentity(graphTexture))
        ) {
          captureFailure(
            JSON.stringify({
              target: graphCapture.name,
              graphGeneration: graphAccess.graphGeneration,
              frameId,
              textureIdentity: getTextureIdentity(graphTexture),
              expectedIdentity: graphCapture.expected.identity,
              reason: 'identity-mismatch',
            }),
          );
        } else {
          encoder.copyTextureToBuffer(
            { texture: graphTexture as never },
            {
              buffer: graphCapture.buffer as never,
              bytesPerRow: graphCapture.bytesPerRow,
              rowsPerImage: graphCapture.height,
            },
            {
              width: graphCapture.width,
              height: graphCapture.height,
              depthOrArrayLayers: 1,
            },
          );
        }
      }
      const fallbackReadback = frameState.reflectionFallbackReadback;
      frameState.reflectionFallbackReadback = undefined;
      if (fallbackReadback !== undefined) {
        const graphAccess = frameState.perFrameGraph;
        const graphTexture = graphAccess?.getColorTargetTexture(fallbackReadback.name);
        const descriptor = graphAccess?.getColorTargetDescriptor(fallbackReadback.name);
        const matches =
          graphAccess !== undefined &&
          graphAccess !== null &&
          graphTexture !== undefined &&
          descriptor !== undefined &&
          descriptor.format === fallbackReadback.expected.format &&
          descriptor.size.width === fallbackReadback.expected.width &&
          descriptor.size.height === fallbackReadback.expected.height &&
          descriptor.sample === 1 &&
          (descriptor.usage & fallbackReadback.expected.usage) ===
            fallbackReadback.expected.usage &&
          graphAccess.graphGeneration === fallbackReadback.expected.graphGeneration &&
          frameState.frameNumber === fallbackReadback.expected.frameId &&
          getTextureIdentity(graphTexture) === fallbackReadback.expected.textureIdentity;
        if (matches && graphTexture !== undefined) {
          encoder.copyTextureToBuffer(
            { texture: graphTexture },
            {
              buffer: fallbackReadback.buffer,
              bytesPerRow: fallbackReadback.bytesPerRow,
              rowsPerImage: fallbackReadback.height,
            },
            {
              width: fallbackReadback.width,
              height: fallbackReadback.height,
              depthOrArrayLayers: 1,
            },
          );
          fallbackReadback.encoded = true;
        }
      }
      internals.encodeRenderTargetReadbacks?.(encoder, readbackFaces);
      const stagedGpuState = frameState.temporalGpuState;
      if (stagedGpuState !== undefined && !hasPendingTemporalGpuSubmit(stagedGpuState)) {
        internals.errorRegistry.fire(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'TAA resolve stages a history write before submit',
            hint: 'retry the frame after the temporal resolve pass has encoded successfully',
          }),
        );
        return { ok: false, stage: 'finish' };
      }
      if (passTimingCapture !== undefined) {
        const tail = passTimingCapture.encodeTail(encoder);
        if (!tail.ok) passTimingCapture.abort({ code: tail.error.code });
      }
      const resolved = timingCapture?.resolve(encoder);
      if (resolved !== undefined && !resolved.ok) {
        timingCapture?.discard();
        return { ok: false, stage: 'finish' };
      }
      const finished = encoder.finish();
      if (!finished.ok) {
        passTimingCapture?.abort({ code: finished.error.code });
        timingCapture?.discard();
        internals.errorRegistry.fire(finished.error);
        return { ok: false, stage: 'finish' };
      }
      preparedCommand = { command: finished.value };
      return { ok: true, value: undefined };
    },
    submit: () => {
      const injectedFailure = internals.beforeSubmit?.(internals.device);
      if (injectedFailure !== undefined) {
        passTimingCapture?.abort({ code: injectedFailure.code });
        timingCapture?.discard();
        internals.errorRegistry.fire(injectedFailure);
        return { ok: false, stage: 'submit' };
      }
      const submitted = internals.device.queue.submit([preparedCommand.command]);
      if (!submitted.ok) {
        passTimingCapture?.abort({ code: submitted.error.code });
        timingCapture?.discard();
        internals.errorRegistry.fire(submitted.error);
        return { ok: false, stage: 'submit' };
      }
      timingCapture?.markSubmitted();
      return { ok: true, value: undefined };
    },
    ...(capturedGeneration === undefined || deviceScope === undefined
      ? {}
      : {
          generationFence: {
            capturedGeneration,
            // Read the owner at submit time. Recovery publishes a replacement
            // scope synchronously between finish and submit; retaining the
            // entry scope here would make that race invisible to the fence.
            currentGeneration: () => internals.deviceScope?.generation ?? -1,
          },
        }),
    commit: () => {
      frameHooks?.onSubmitted?.();
      if (frameState.temporalFrameInput !== undefined) {
        const temporal = frameState.temporalFrameTransaction.commit({ accepted: true });
        if (temporal.ok) {
          frameState.temporalFrame = temporal.value;
        } else {
          internals.errorRegistry.fire(
            new RhiError({
              code: 'webgpu-runtime-error',
              expected: 'the staged temporal frame to commit after queue submission',
              hint: 'discard the temporal candidate and retry the next frame',
              detail: { error: temporal.error },
            }),
          );
        }
        frameState.temporalFrameInput = undefined;
      }
      if (passTimingCapture !== undefined) {
        const completion = internals.device.queue.onSubmittedWorkDone();
        timingHost.gpuPassTimingSubmittedWork = completion;
        passTimingCapture.markSubmitted(completion);
      }
      if (frameState.bloomFrameReceipts !== undefined) {
        internals
          .getPipelineState()
          ?.perPassResources.commitBloomFrameReceipts?.(frameState.bloomFrameReceipts);
        frameState.bloomFrameReceipts = undefined;
      }
      const stagedGpuState = frameState.temporalGpuState;
      if (stagedGpuState !== undefined) {
        if (commitTemporalGpuSubmit(stagedGpuState)) {
          const previousGpuState = frameState.activeTemporalGpuState;
          frameState.activeTemporalGpuState = stagedGpuState;
          if (previousGpuState !== undefined && previousGpuState !== stagedGpuState) {
            internals.clearPostProcessPipelineCache?.('forgeax.taa-resolve');
            retireTemporalGpuStateAfterFence(
              previousGpuState,
              internals.device.queue,
              frameState.retiringTemporalGpuStates,
              (cause) => {
                internals.errorRegistry.fire(
                  new RhiError({
                    code: 'webgpu-runtime-error',
                    expected: 'submitted temporal resources remain valid until queue completion',
                    hint: `temporal resource retirement failed: ${String(cause)}`,
                  }),
                );
              },
            );
          }
          frameState.temporalGpuState = undefined;
        }
      }
      const stagedTemporalCommit = frameState.pendingTemporalCommit ?? { kind: 'none' as const };
      if (stagedTemporalCommit.kind !== 'none') {
        frameState.lastSuccessfulTemporalView = stagedTemporalCommit.view;
      }
      if (stagedTemporalCommit.kind === 'taa') {
        frameState.successfulTemporalFrameIndex = stagedTemporalCommit.view.temporalFrameIndex + 1;
      } else if (stagedTemporalCommit.kind === 'off') {
        frameState.successfulTemporalFrameIndex = 0;
      }
      if (stagedTemporalCommit.kind === 'off') {
        internals.clearPostProcessPipelineCache?.('forgeax.taa-resolve');
        // Retire frame-sized resources, not the device-owned prewarmed
        // shader. The next TAA frame must not start an async cold compile.
        const activeGpuState = frameState.activeTemporalGpuState;
        if (activeGpuState !== undefined) {
          retireTemporalGpuStateAfterFence(
            activeGpuState,
            internals.device.queue,
            frameState.retiringTemporalGpuStates,
            (cause) => {
              internals.errorRegistry.fire(
                new RhiError({
                  code: 'webgpu-runtime-error',
                  expected: 'submitted temporal resources remain valid until queue completion',
                  hint: `temporal resource retirement failed: ${String(cause)}`,
                }),
              );
            },
          );
          frameState.activeTemporalGpuState = undefined;
        }
      }
      frameState.pendingTemporalCommit = { kind: 'none' };
      if (frameState.environmentGeneration !== undefined) {
        frameState.environmentLifecycle?.publish(frameState.environmentGeneration);
        frameState.environmentGeneration = undefined;
      }
      onSubmitted?.(internals.device.queue.onSubmittedWorkDone());
    },
    abort: (failure) => {
      frameHooks?.onAborted?.();
      passTimingCapture?.abort({ code: failure.stage });
      timingHost.gpuPassTimingCapture = undefined;
      timingHost.gpuPassTimingSubmittedWork = undefined;
      timingCapture?.discard();
      frameState.bloomFrameReceipts = undefined;
      if (frameState.environmentGeneration !== undefined) {
        frameState.environmentLifecycle?.recordStageFailure(
          failure.stage,
          frameState.environmentGeneration,
        );
      }
      if (frameState.temporalGpuState !== undefined) {
        const stagedGpuState = frameState.temporalGpuState;
        abortTemporalGpuSubmit(stagedGpuState);
        if (stagedGpuState !== frameState.activeTemporalGpuState) {
          retireTemporalGpuState(stagedGpuState);
        }
        frameState.temporalGpuState = undefined;
      }
      frameState.pendingTemporalCommit = { kind: 'none' };
      if (frameState.environmentGeneration !== undefined) {
        frameState.environmentLifecycle?.discard(frameState.environmentGeneration);
        frameState.environmentGeneration = undefined;
      }
    },
  });
  settleVolumetricFogGraphCandidate(frameState, transaction.ok);
  if (!transaction.ok) rejectTemporalFrame();
  return transaction.ok;
}

function createTimingInstrumentation(
  capture: GpuTimingCapture,
): RenderGraphPassInstrumentation<RenderPipelineFrame> {
  return {
    begin: (pass): RenderGraphPassInstrumentationScope | undefined => {
      // WebGPU has no portable timestamp boundary for a copy pass. Do not
      // pretend a command-encoder marker exists; frame timing remains valid
      // when at least one raster/compute pass is present.
      if (pass.kind === 'copy') return undefined;
      const writes = capture.beginPass(pass.name, pass.kind, pass.executionIndex);
      if (writes === undefined) return undefined;
      if (pass.kind === 'raster') {
        return {
          renderPassDescriptor: (descriptor) => {
            if (descriptor.timestampWrites !== undefined) {
              capture.markOwnerConflict(pass.name);
              return descriptor;
            }
            return { ...descriptor, timestampWrites: writes };
          },
        };
      }
      return {
        computePassDescriptor: (descriptor) => {
          if (descriptor.timestampWrites !== undefined) {
            capture.markOwnerConflict(pass.name);
            return descriptor;
          }
          return { ...descriptor, timestampWrites: writes };
        },
      };
    },
  };
}

function getTimingInstrumentationState(
  internals: RenderSystemInternals,
  capture: GpuPassTimingCapture,
): TimingInstrumentationState {
  const existing = timingInstrumentationStates.get(internals);
  if (existing !== undefined) {
    existing.setCapture(capture);
    return existing;
  }
  type TimestampWrites = NonNullable<ReturnType<GpuPassTimingCapture['timestampWrites']>>;
  const activeIdentity: {
    passName: string;
    passKind: GpuPassTimingPassIdentity['passKind'];
    executionIndex: number;
  } = {
    passName: '',
    passKind: 'raster',
    executionIndex: 0,
  };
  let activeWrites: TimestampWrites | undefined;
  let activeCapture: GpuPassTimingCapture | undefined = capture;
  const rasterScope: RenderGraphPassInstrumentationScope = {
    renderPassDescriptor: (descriptor) => {
      const capture = activeCapture;
      const identity = activeIdentity;
      const writes = activeWrites;
      if (capture === undefined || identity === undefined || writes === undefined) {
        return descriptor;
      }
      if (descriptor.timestampWrites !== undefined) {
        capture.markOwnerConflict(identity);
        return descriptor;
      }
      (descriptor as { timestampWrites?: TimestampWrites }).timestampWrites = writes;
      return descriptor;
    },
  };
  const computeScope: RenderGraphPassInstrumentationScope = {
    computePassDescriptor: (descriptor) => {
      const capture = activeCapture;
      const identity = activeIdentity;
      const writes = activeWrites;
      if (capture === undefined || identity === undefined || writes === undefined) {
        return descriptor;
      }
      if (descriptor.timestampWrites !== undefined) {
        capture.markOwnerConflict(identity);
        return descriptor;
      }
      (descriptor as { timestampWrites?: TimestampWrites }).timestampWrites = writes;
      return descriptor;
    },
  };
  const copyScope: RenderGraphPassInstrumentationScope = {
    beforeCopy: (encoder) => {
      const capture = activeCapture;
      const identity = activeIdentity;
      if (capture === undefined || identity === undefined) return;
      capture.copyBoundaryBefore(identity, encoder);
    },
    afterCopy: (encoder) => {
      const capture = activeCapture;
      const identity = activeIdentity;
      if (capture === undefined || identity === undefined) return;
      capture.copyBoundaryAfter(identity, encoder);
    },
  };
  const instrumentation: RenderGraphPassInstrumentation<RenderPipelineFrame> = {
    begin: (pass) => {
      const capture = activeCapture;
      if (capture === undefined) return undefined;
      activeIdentity.passName = pass.name;
      activeIdentity.passKind = pass.kind;
      activeIdentity.executionIndex = pass.executionIndex;
      activeWrites = capture.recordPass(activeIdentity);
      if (activeWrites === undefined) return undefined;
      switch (pass.kind) {
        case 'raster':
          return rasterScope;
        case 'compute':
          return computeScope;
        case 'copy':
          return copyScope;
      }
    },
  };
  const state: TimingInstrumentationState = {
    instrumentation,
    setCapture: (capture) => {
      activeCapture = capture;
      if (capture === undefined) {
        activeWrites = undefined;
      }
    },
  };
  timingInstrumentationStates.set(internals, state);
  return state;
}
