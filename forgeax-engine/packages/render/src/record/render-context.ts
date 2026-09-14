import type { AssetRegistry, DynamicTextureStore } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { VertexLayoutProjection } from '@forgeax/engine-geometry';
import type { Profiler } from '@forgeax/engine-profiler';
import type { CompiledRenderGraphInfo } from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  ComputePipeline,
  PipelineLayout,
  Result,
  RhiCanvasContext,
  RhiCommandEncoder,
  RhiDevice,
  RenderPipeline as RhiRenderPipeline,
  Sampler,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import {
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  type MaterialRuntimeArtifact,
  type MaterialShaderArtifact,
} from '@forgeax/engine-shader';
import type {
  MaterialAsset,
  MaterialRenderState,
  ParamSchemaEntry,
  PassKind,
  PrimitiveTopology,
  VertexAttributeMap,
} from '@forgeax/engine-types';
import { derive } from '@forgeax/engine-types';
import type { MaterialRenderProjection } from '../assembly/material/assembly';
import type { DeviceScope } from '../device/device-scope';
import type { MeshGpuHandles } from '../device/gpu-residency';
import type { EngineMetrics } from '../engine-metrics';
import type { RenderFeatureHost } from '../features/host';
import type { RenderFeatureShaderModuleMode } from '../features/types';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import type { SkylightFallback } from '../ibl/skylight-bind-group';
import type { BloomInspection } from '../inspection-types';
import type { HealthListenerRegistry, RhiErrorListenerRegistry } from '../lifecycle';
import type { PipelineGroup2Contract } from '../pbr-pipeline';
import type { StandardTopologyInputValue } from '../pipeline/standard-lighting/topology';
import type { StandardProfile } from '../pipeline/standard-profile';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import type { PointsLinesInspection } from '../points-lines/inspection';
import type { PointsLinesRecordPlan } from '../points-lines/record';
import type { ReflectionProbeTable } from '../reflection/gpu-table';
import type { ReflectionProbeSelectionResult } from '../reflection/projection';
import type { SsrAdmissionIdentity } from '../ssr/identity';
import type { GpuPassTimingReason } from './gpu-pass-timing/errors';
import type {
  GpuPassTimingCapture,
  GpuPassTimingFrameIdentity,
  GpuPassTimingSession,
} from './gpu-pass-timing/session';

export interface PointsLinesRecordSubmission {
  readonly plan: PointsLinesRecordPlan;
  readonly vertexBuffer: Buffer;
  readonly indexBuffer: Buffer;
  readonly layoutProjection: VertexLayoutProjection;
}

export interface ReflectionProbeRecordState {
  readonly table: ReflectionProbeTable;
  readonly selections: ReadonlyMap<string, ReflectionProbeSelectionResult>;
  readonly graph: import('./typed-frame-graph').ReflectionProbeGraphState;
  /** Detached committed fallback projections joined by main-pass renderable key. */
  readonly fallbackProjections?: ReadonlyMap<
    string,
    import('../inspection-types').ReflectionFallbackReceipt
  >;
  /** Demand is derived from this frame's renderable/source selection. */
  readonly fallbackDemand?: boolean;
  /** True when at least one selected row must prove a non-zero readback. */
  readonly fallbackHasNonNeutral?: boolean;
  readonly completeSubmission: (
    submitted: boolean,
    completed?: Promise<unknown>,
    fallbackOutput?: {
      readonly format: TextureFormat;
      readonly size: { readonly width: number; readonly height: number };
      readonly frameId: number;
      readonly graphGeneration: number;
      readonly textureIdentity: number;
      readonly readback?: Promise<{
        readonly linearHdr: readonly [number, number, number, number];
        readonly hash: string;
        readonly graphGeneration: number;
        readonly textureIdentity: number;
      }>;
    },
    fallbackRequested?: boolean,
  ) => Promise<void>;
}

export interface MaterialShaderPipelineEntry {
  readonly pipeline: RhiRenderPipeline;
  readonly group2Contract: PipelineGroup2Contract;
}

/**
 * Armed only for the first published recovery frame. Candidate preparation
 * must make every pipeline and static residency lookup a cache hit before this
 * guard is armed; a miss is a hard failure before queue submission.
 */
export interface RecoveryColdWorkGuard {
  arm(): void;
  notePipelineColdWork(): void;
  noteUploadColdWork(): void;
  finish(): void;
}

import type {
  RenderDebugOverlay,
  RenderPipelineContext,
  RenderRecordPhase,
  VolumetricFogShaderSources,
} from '../render-contract';
import type {
  DispatchEntry,
  MaterialSnapshot,
  SkyboxSnapshot,
  SkylightSnapshot,
} from '../render-system-extract';
import type { SkinPaletteAllocator } from '../systems/skin-palette-allocator';
import type { RenderTarget } from '../targets/contracts';
import type { RenderTargetPhysical } from '../targets/physical';
import type {
  BindGroupCounts,
  BloomFrameReceipts,
  DispatchCounts,
  MaterialBgAssemblyCacheEntry,
  RenderFrameState,
  ValidatedRenderable,
} from './frame-snapshot';
import type { FoldDispatchPlan } from './mesh-ssbo';

export interface RenderSystemRuntime {
  readonly device: RhiDevice;
  /** Internal backend-fixture hook evaluated at the submit transaction edge. */
  readonly beforeSubmit?: ((device: RhiDevice) => RhiError | undefined) | undefined;
  readonly deviceScope: DeviceScope;
  /** Resolve a recorder/backend wrapper before configuring the native surface. */
  readonly resolveSurfaceDevice?: (device: RhiDevice) => Result<RhiDevice, RhiError>;
  readonly errorRegistry: RhiErrorListenerRegistry;
  readonly debugOverlay?: RenderDebugOverlay | undefined;
  readonly healthRegistry: HealthListenerRegistry;
  readonly getMaterialProjectionForPayload?: (
    material: MaterialAsset,
  ) => MaterialRenderProjection | undefined;
  readonly getMaterialProjection?: (materialGuid: string) => MaterialRenderProjection | undefined;
  readonly getMaterialArtifact?: (specializationKey: string) => MaterialRuntimeArtifact | undefined;
  /** Producer-owned cooked Standard PBR artifact used by GPU-driven projection. */
  readonly getMaterialShaderArtifact?: (
    materialShaderId: string,
  ) => MaterialShaderArtifact | undefined;
  readonly getMaterialShaderPipeline?: (
    materialShaderId: string,
    isHdr: boolean,
    renderState?: MaterialRenderState,
    topology?: PrimitiveTopology,
    indexFormat?: 'uint16' | 'uint32',
    variantSet?: string,
    passKind?: PassKind,
    meshAttributes?: VertexAttributeMap,
    sampleCount?: number,
    colorFormatOverride?: GPUTextureFormat,
    shaderUvSetCount?: number,
    depthFormatOverride?: GPUTextureFormat | null,
    vertexLayout?: string,
    vertexLayoutProjection?: VertexLayoutProjection,
    shaderModuleMode?: RenderFeatureShaderModuleMode,
    layoutKindOverride?: 'pbr' | 'pbr-skin',
    additionalColorFormats?: readonly GPUTextureFormat[],
    vertexEntry?: string,
    fragmentEntry?: string,
  ) => RhiRenderPipeline | null;
  readonly getMaterialShaderPipelineEntry?: (
    materialShaderId: string,
    isHdr: boolean,
    renderState?: MaterialRenderState,
    topology?: PrimitiveTopology,
    indexFormat?: 'uint16' | 'uint32',
    variantSet?: string,
    passKind?: PassKind,
    meshAttributes?: VertexAttributeMap,
    sampleCount?: number,
    colorFormatOverride?: GPUTextureFormat,
    shaderUvSetCount?: number,
    depthFormatOverride?: GPUTextureFormat | null,
    vertexLayout?: string,
    vertexLayoutProjection?: VertexLayoutProjection,
    shaderModuleMode?: RenderFeatureShaderModuleMode,
    layoutKindOverride?: 'pbr' | 'pbr-skin',
    additionalColorFormats?: readonly GPUTextureFormat[],
    vertexEntry?: string,
    fragmentEntry?: string,
  ) => MaterialShaderPipelineEntry | null;
  /** Reflection-derived UV count included in the material PipelineSpec cache key. */
  readonly getMaterialShaderUvSetCount?: (materialShaderId: string) => number | undefined;
  readonly getMaterialShaderBindingContract?: (
    materialShaderId: string,
  ) => 'group-0' | 'group-0-resource' | 'view-only' | 'view-and-scene-depth' | 'render-material';
  readonly getParamSchema?: (materialShaderId: string) => readonly ParamSchemaEntry[] | undefined;
  readonly getMaterialBindGroupLayout?: (
    materialShaderId: string,
    materialParamSchema?: readonly ParamSchemaEntry[],
  ) => BindGroupLayout | undefined;
  recoveryColdWorkGuard?: RecoveryColdWorkGuard | undefined;
  readonly metrics: EngineMetrics;
  readonly lookupPostProcess?: (
    id: string,
  ) => import('../fullscreen-post-process-pass').PostProcessShaderEntry | undefined;
  readonly getPostProcessParamsBuffer?: (id: string) => Buffer | undefined;
  readonly getPostProcessPipeline?: (
    id: string,
    bgl: BindGroupLayout,
    colorFormat: GPUTextureFormat,
    entry?: import('../fullscreen-post-process-pass').PostProcessShaderEntry,
  ) => RhiRenderPipeline | null;
  /** Candidate-owned post-process pipelines transferred at publication. */
  readonly getRecoveryPostProcessPipelines?: () => ReadonlyMap<string, RhiRenderPipeline>;
  readonly clearPostProcessPipelineCache?: (id: string) => void;
  readonly invalidateShaderModule?: (label: string) => void;
  readonly dynamicTextureStore?: DynamicTextureStore | undefined;
  /** Resolves a render-target source to the active generation-owned GPU view. */
  readonly resolveRenderTargetTextureSource?: (
    source: import('../targets/contracts').RenderTargetTextureSource,
  ) => import('../targets/material-source').RenderTargetMaterialSourceBinding | undefined;
}

/** Renderer-owned bridge from retained Points/Lines facts into main geometry. */
export interface PointsLinesRecordOwner {
  prepare(entry: ValidatedRenderable, clustered: boolean): PointsLinesRecordSubmission | undefined;
  beginFrame(): void;
  resetForDeviceLoss(): void;
  inspections(): readonly PointsLinesInspection[];
}

export interface PerPassResources {
  depthTexture: Texture | null;
  depthTextureView: TextureView | null;
  depthTextureWidth: number;
  depthTextureHeight: number;
  configured: boolean;
  hdrColorTexture: Texture | null;
  hdrColorView: TextureView | null;
  hdrDepthTexture: Texture | null;
  hdrDepthView: TextureView | null;
  hdrTextureWidth: number;
  hdrTextureHeight: number;
  hdrDepthSampleCount: number;
  readonly fxaaPipeline: RhiRenderPipeline | null;
  readonly fxaaBindGroupLayout: BindGroupLayout | null;
  readonly fxaaSampler: Sampler | null;
  msaaColorTexture: Texture | null;
  msaaColorView: TextureView | null;
  msaaSpriteColorTexture: Texture | null;
  msaaSpriteColorView: TextureView | null;
  msaaDepthTexture: Texture | null;
  msaaDepthView: TextureView | null;
  msaaTextureWidth: number;
  msaaTextureHeight: number;
  hdrColorMsaaTexture: Texture | null;
  hdrColorMsaaView: TextureView | null;
  readonly skyboxPipeline: RhiRenderPipeline | null;
  readonly skyboxPipelineMsaa: RhiRenderPipeline | null;
  readonly skyboxBindGroupLayout: BindGroupLayout | null;
  readonly skyboxSampler: Sampler | null;
  readonly skyboxRotationBuffer: Buffer | null;
  bloomBrightPipeline: RhiRenderPipeline | null;
  bloomBlurHPipeline: RhiRenderPipeline | null;
  bloomBlurVPipeline: RhiRenderPipeline | null;
  bloomCompositePipeline: RhiRenderPipeline | null;
  bloomBrightBindGroupLayout: BindGroupLayout | null;
  bloomBlurBindGroupLayout: BindGroupLayout | null;
  bloomCompositeBindGroupLayout: BindGroupLayout | null;
  bloomSampler: Sampler | null;
  bloomBrightParamsBuffer: Buffer | null;
  bloomBlurHParamsBuffer: Buffer | null;
  bloomBlurVParamsBuffer: Buffer | null;
  bloomCompositeParamsBuffer: Buffer | null;
  ensureBloomResources?: () => void;
  getBloomResources?: () => BloomPersistentBundle | null;
  commitBloomResources?: () => void;
  commitBloomFrameReceipts?: (receipts: BloomFrameReceipts) => void;
  discardBloomResources?: () => void;
  retireBloomResources?: (completion: Promise<unknown>) => void;
  /** Drain candidate, active, and fence-retiring Bloom generations. */
  drainBloomResources?: () => void;
  inspectBloomResources?: (graph?: CompiledRenderGraphInfo) => BloomInspection;
  bloomBrightTexture: Texture | null;
  bloomBrightView: TextureView | null;
  bloomBrightWidth: number;
  bloomBrightHeight: number;
  bloomBlurHTexture: Texture | null;
  bloomBlurHView: TextureView | null;
  bloomBlurHWidth: number;
  bloomBlurHHeight: number;
  bloomBlurVTexture: Texture | null;
  bloomBlurVView: TextureView | null;
  bloomBlurVWidth: number;
  bloomBlurVHeight: number;
  ssaoCalcPipeline: RhiRenderPipeline | null;
  ssaoBlurPipeline: RhiRenderPipeline | null;
  ssaoBgl: BindGroupLayout | null;
  ssaoFilteringSampler: Sampler | null;
  ssaoDepthSampler: Sampler | null;
  ssaoFallbackRawView: TextureView | null;
  shadowTexture: Texture | null;
  shadowMapSize: number;
  shadowCascadeCount: number;
  shadowSampler: Sampler | null;
  shadowLightSpaceMatrix: Float32Array | null;
  shadowCsmLightViewProj: Float32Array | null;
  shadowCsmSelection: {
    readonly viewMatrix: Float32Array;
    readonly splitPlanes: Float32Array;
  } | null;
}

/** Renderer-private Bloom bundle selected for one record transaction. */
export interface BloomPersistentBundle {
  readonly scope: DeviceScope;
  readonly generation: number;
  readonly bloomBrightPipeline: RhiRenderPipeline | null;
  readonly bloomBlurHPipeline: RhiRenderPipeline | null;
  readonly bloomBlurVPipeline: RhiRenderPipeline | null;
  readonly bloomCompositePipeline: RhiRenderPipeline | null;
  readonly bloomBrightBindGroupLayout: BindGroupLayout | null;
  readonly bloomBlurBindGroupLayout: BindGroupLayout | null;
  readonly bloomCompositeBindGroupLayout: BindGroupLayout | null;
  readonly bloomSampler: Sampler | null;
  readonly bloomBrightParamsBuffer: Buffer | null;
  readonly bloomBlurHParamsBuffer: Buffer | null;
  readonly bloomBlurVParamsBuffer: Buffer | null;
  readonly bloomCompositeParamsBuffer: Buffer | null;
}

export interface PipelineState {
  /** Device that owns every opaque handle in this pipeline state. */
  readonly device: RhiDevice;
  readonly meshes: ReadonlyMap<number, MeshGpuHandles>;
  readonly format: TextureFormat;
  readonly colorAttachmentFormat: TextureFormat;
  /** Surface route committed by configureSurface for inspection provenance. */
  readonly surfaceProfile?: 'dual-view' | 'raw-only';
  readonly viewBindGroupLayout: BindGroupLayout;
  /** Device capability gate for the optional SpotLight projector binding. */
  readonly projectorAvailable?: boolean;
  readonly materialBindGroupLayout: BindGroupLayout;
  readonly meshBindGroupLayout: BindGroupLayout;
  readonly viewUniformBuffer: Buffer;
  readonly pointsLinesViewBuffer?: Buffer;
  readonly shadowCasterCascadeBuffer: Buffer;
  readonly materialUniformBuffer: { readonly buffer: Buffer; readonly sizeInBytes: number };
  readonly meshStorageBuffer: { readonly buffer: Buffer; readonly sizeInBytes: number };
  readonly instancesBindGroupLayout: BindGroupLayout;
  /** Probe-enabled slot-3 layout; omitted from no-probe bind groups. */
  readonly probeInstancesBindGroupLayout?: BindGroupLayout;
  readonly identityInstanceBuffer: Buffer;
  readonly defaultSampler: Sampler;
  readonly nearestSampler: Sampler;
  readonly fallbackTextureView: TextureView;
  readonly unlitPipeline: RhiRenderPipeline | null;
  readonly standardPipeline: RhiRenderPipeline | null;
  readonly unlitPipelineMsaa: RhiRenderPipeline | null;
  readonly unlitPipelineHdrMsaa: RhiRenderPipeline | null;
  readonly pbrPipelineLayout: PipelineLayout | null;
  readonly pbrProbePipelineLayout?: PipelineLayout | null;
  readonly hdrpPbrPipelineLayout: PipelineLayout | null;
  readonly hdrpProbePbrPipelineLayout?: PipelineLayout | null;
  readonly hdrpClusterMembershipPipeline: ComputePipeline | null;
  readonly hdrpClusterMembershipBindGroupLayout: BindGroupLayout | null;
  readonly pbrSkinPipelineLayout: PipelineLayout | null;
  readonly pbrSkinProbePipelineLayout?: PipelineLayout | null;
  readonly pbrSkinMeshBindGroupLayout: BindGroupLayout | null;
  readonly hdrpSkinPipelineLayout: PipelineLayout | null;
  readonly hdrpSkinMeshBindGroupLayout: BindGroupLayout | null;
  readonly skinPaletteAllocator: SkinPaletteAllocator | null;
  readonly defaultWhiteTextureView: TextureView;
  readonly defaultNormalTextureView: TextureView;
  /** Missing anisotropy maps encode a neutral direction and unit strength. */
  readonly defaultAnisotropyTextureView?: TextureView;
  readonly unlitPipelineHdr: RhiRenderPipeline | null;
  readonly shadowFallbackTextureView: TextureView;
  readonly shadowAtlasFallbackTextureView: TextureView;
  readonly extendedLightingAvailable?: boolean;
  readonly iesProfileTexture?: Texture;
  readonly cookieTexture?: Texture;
  readonly cookieMatrixBuffer?: Buffer;
  spotModifierUploadState?: {
    readonly ies: Map<number, number>;
    readonly cookie: Map<number, number>;
    readonly cookieMatrix: Map<number, number>;
  };
  readonly iesProfileTextureView?: TextureView;
  readonly cookieTextureView?: TextureView;
  readonly ltcLambertTextureView?: TextureView;
  readonly ltcGgxTextureView?: TextureView;
  readonly shadowParamsBuffer: Buffer;
  readonly skylightFallback: SkylightFallback | null;
  readonly perPassResources: PerPassResources;
}

export interface RenderSystemInternals extends RenderSystemRuntime {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Build identity injected by the host's build-tool adapter. */
  readonly build?: string | undefined;
  /** Host identity binding for the renderer-owned SSR dependency seam. */
  readonly ssrIdentity?: SsrAdmissionIdentity | undefined;
  readonly standardProfile?: StandardProfile | undefined;
  readonly standardPipeline: RenderFrameState['activePipeline'];
  readonly featureHost?: RenderFeatureHost | undefined;
  /** Install a detached feature host only at the recovery publication boundary. */
  readonly setFeatureHost?: ((host: RenderFeatureHost) => void) | undefined;
  readonly shaderModuleFactory?: PipelineBuilderShaderModuleFactory;
  readonly createShaderModule?: (
    device: import('@forgeax/engine-rhi').RhiDevice,
    descriptor: { readonly code: string; readonly label?: string },
  ) => Promise<
    Result<import('@forgeax/engine-rhi').ShaderModule, import('@forgeax/engine-rhi').RhiError>
  >;
  /** Optional handle-first factory for feature-owned generated shader programs. */
  readonly immediateShaderModuleFactory?: PipelineBuilderShaderModuleFactory;
  readonly profiler?: Profiler | undefined;
  readonly context: RhiCanvasContext | null;
  readonly getPipelineState: () => PipelineState | null;
  readonly assets: AssetRegistry;
  readonly gpuStore: import('../device/gpu-residency').GpuResidencyCache;
  readonly growMeshSsbo?:
    | ((neededSlots: number) =>
        | { readonly ok: true }
        | {
            readonly ok: false;
            readonly code: 'mesh-ssbo-ceiling-reached' | 'mesh-ssbo-capacity-exceeded';
            readonly degradedToSlotCount: number;
          })
    | undefined;
  readonly meshSsboState?: { readonly slotCount: number } | undefined;
  readonly buildPostProcessPipeline?:
    | ((
        entry: import('../fullscreen-post-process-pass').PostProcessShaderEntry,
        bgl: BindGroupLayout,
        colorFormat: GPUTextureFormat,
        label: string,
      ) => RhiRenderPipeline | null)
    | undefined;
  gpuPassTimingSession?: GpuPassTimingSession | undefined;
  gpuPassTimingCapture?: GpuPassTimingCapture | undefined;
  gpuPassTimingSubmittedWork?: Promise<void> | undefined;
  gpuPassTimingFrameIdentity?: GpuPassTimingFrameIdentity | undefined;
  gpuPassTimingBeginReason?: GpuPassTimingReason | undefined;
  readonly getRenderTargetPhysical?: (target: RenderTarget) => RenderTargetPhysical | undefined;
  readonly encodeRenderTargetReadbacks?: (
    encoder: RhiCommandEncoder,
    faces?: readonly number[],
  ) => void;
  /** Composed renderer utility sources installed atomically at build-ready. */
  volumetricFogShaders?: VolumetricFogShaderSources | undefined;
}

export interface _StandardForwardSceneView {
  readonly assets: AssetRegistry;
  readonly store: import('../device/gpu-residency').GpuResidencyCache;
  readonly pipelineState: PipelineState;
  readonly bloomResources?: BloomPersistentBundle | null;
  readonly runtime: RenderSystemRuntime;
  readonly validated: readonly ValidatedRenderable[];
  readonly validatedOrdered: readonly ValidatedRenderable[];
  readonly viewBindGroup: BindGroup | null;
  /** Dynamic View-UBO slot used by auxiliary cube/probe face cameras. */
  readonly viewBindGroupDynamicOffset?: number;
  readonly meshBindGroup: BindGroup | null;
  readonly frameState: RenderFrameState;
  readonly dispatchCounts: DispatchCounts;
  readonly bindGroupCounts: BindGroupCounts;
  readonly skylight: SkylightSnapshot | undefined;
  readonly skylightCount: number;
  readonly skybox: SkyboxSnapshot | undefined;
  readonly profilePhase?: <T>(phase: RenderRecordPhase, action: () => T) => T;
  readonly directionalShadowCacheReuse: boolean;
  readonly world: World;
  readonly gpuDrivenEntityKeys: ReadonlySet<number>;
  /** Renderer-local world namespace paired with gpuDrivenEntityKeys. */
  readonly gpuDrivenWorldKeys?: readonly number[];
  readonly tonemapActive: boolean;
  readonly geometryColorView: TextureView | null;
  readonly geometryDepthView: TextureView | null;
  readonly geometryDepthKey: string | null;
  readonly skyboxActive: boolean;
  readonly splitLdrSprite: boolean;
  readonly ldrSpritePassView: TextureView | null;
  readonly transparentColorFormat?: GPUTextureFormat;
  /** Second Standard main-pass attachment used by the fallback producer. */
  readonly reflectionFallbackColorFormat?: GPUTextureFormat;
  readonly dispatch: readonly DispatchEntry[];
  readonly hdrpClusterBindGroup: BindGroup | null;
  readonly hdrpClusterMembershipBindGroup: BindGroup | null;
  /** Prepared Standard lighting declaration accepted by this graph frame. */
  readonly standardLighting?: StandardTopologyInputValue;
  readonly foldDispatchPlan: FoldDispatchPlan | null;
  readonly materialSlotIndices: readonly (readonly number[])[];
  readonly materialSlots: readonly MaterialSnapshot[];
  readonly materialSlotOwners: readonly number[];
  readonly materialSlotCount: number;
  readonly pointsLines: PointsLinesRecordOwner | undefined;
  readonly materialBgAssemblyCache: Map<string, MaterialBgAssemblyCacheEntry>;
  /** Record-stage proof callback; invoked only after a real draw command is encoded. */
  readonly onRenderableDraw?: (entry: ValidatedRenderable) => void;
  readonly reflectionProbes?: ReflectionProbeRecordState;
  materialUboPayloadCache?: {
    readonly materialSlots: readonly MaterialSnapshot[];
    readonly materialSlotCount: number;
    readonly payload: Uint8Array;
  };
  hdrpSsaoBlurredView?: TextureView;
  readonly occlusion?: import('../scene/visibility/occlusion-runtime').OcclusionFrameProjection;
}

export type _InternalRenderPipelineContext = RenderPipelineContext & _StandardForwardSceneView;

export type RecordProfileRunner = <T>(phase: RenderRecordPhase, action: () => T) => T;

export const STANDARD_PBR_UBO_SIZE = derive(DEFAULT_STANDARD_PBR_PARAM_SCHEMA).uboLayout.totalBytes;
export const MATERIAL_PER_ENTITY_STRIDE = Math.ceil(STANDARD_PBR_UBO_SIZE / 256) * 256;

export type SwapChainFormatPair = {
  readonly storage: GPUTextureFormat;
  readonly view: GPUTextureFormat;
  readonly fallbackReason?: 'preferred-canvas-format-missing';
};

/** Internal closed projection of the concrete surface route. */
export type SurfaceProfile =
  | {
      readonly kind: 'dual-view';
      readonly storageFormat: GPUTextureFormat;
      readonly viewFormat: GPUTextureFormat;
      readonly viewFormats: readonly [GPUTextureFormat];
      readonly hasDisplayEndpoint: true;
    }
  | {
      readonly kind: 'raw-only';
      readonly storageFormat: GPUTextureFormat;
      readonly viewFormat: GPUTextureFormat;
      readonly viewFormats: readonly [];
      readonly hasDisplayEndpoint: false;
    };

export interface SurfaceCapabilityFacts {
  /** Concrete wgpu downlevel `SURFACE_VIEW_FORMATS` flag. */
  readonly surfaceViewFormats: boolean;
  readonly rawAttachment: boolean;
  readonly floatRenderAttachment: boolean;
}

export function resolveSurfaceProfile(
  storageFormat: GPUTextureFormat,
  viewFormat: GPUTextureFormat,
  facts: SurfaceCapabilityFacts,
): Result<SurfaceProfile, RhiError> {
  if (facts.surfaceViewFormats) {
    return ok({
      kind: 'dual-view',
      storageFormat,
      viewFormat,
      viewFormats: [viewFormat],
      hasDisplayEndpoint: true,
    });
  }
  if (!facts.rawAttachment || !facts.floatRenderAttachment) {
    return err(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'raw surface attachment and rgba16float render attachment capabilities',
        hint: 'surface profile cannot establish a raw-only linear output route',
        detail: {
          error: {
            code: 'surface-raw-endpoint-failed',
            message: 'raw-only surface capabilities are incomplete',
          },
        },
      }),
    );
  }
  return ok({
    kind: 'raw-only',
    storageFormat,
    viewFormat: storageFormat,
    viewFormats: [],
    hasDisplayEndpoint: false,
  });
}

export type SurfaceBackendKind = 'webgpu' | 'wgpu-native' | 'wgpu-webgl2' | 'null';

export function resolveSurfaceFormatPair(
  _backendKind: SurfaceBackendKind,
  storage: GPUTextureFormat,
  view: GPUTextureFormat,
): SwapChainFormatPair {
  return { storage, view };
}

function surfaceCapabilityFacts(
  device: RhiDevice,
  storageFormat: GPUTextureFormat,
): SurfaceCapabilityFacts {
  const internal = device as unknown as { readonly surfaceViewFormats?: boolean };
  return {
    surfaceViewFormats: internal.surfaceViewFormats ?? device.caps?.backendKind !== 'wgpu-webgl2',
    rawAttachment: storageFormat === 'rgba8unorm' || storageFormat === 'bgra8unorm',
    floatRenderAttachment: device.caps?.rgba16floatRenderable ?? true,
  };
}

export function configureSurface(
  context: RhiCanvasContext,
  device: RhiDevice,
  format: TextureFormat,
  colorAttachmentFormat: TextureFormat,
): Result<void, RhiError> {
  const backendKind = device.caps?.backendKind ?? 'webgpu';
  const isWebGl2 = backendKind === 'wgpu-webgl2';
  const surfaceFormats = resolveSurfaceFormatPair(
    backendKind,
    format as GPUTextureFormat,
    colorAttachmentFormat as GPUTextureFormat,
  );
  const profile = resolveSurfaceProfile(
    surfaceFormats.storage,
    surfaceFormats.view,
    surfaceCapabilityFacts(device, surfaceFormats.storage),
  );
  if (!profile.ok) return profile;
  // WebGL2 surface pixels are proven by the compositor fixture, so it has no
  // surface consumer for optional TEXTURE_BINDING/COPY_SRC usage. The concrete
  // wgpu surface derives supported usages from SurfaceCapabilities and rejects
  // unsupported requests; this path requests only the guaranteed attachment
  // usage. Raw-only deliberately has no alternate view.
  const supportsTextureBinding =
    backendKind !== 'wgpu-webgl2' && (device.caps?.storageBuffer ?? true);
  const configured = context.configure({
    device,
    format: surfaceFormats.storage,
    alphaMode: isWebGl2 ? 'opaque' : 'premultiplied',
    usage:
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
      (supportsTextureBinding ? GPU_TEXTURE_USAGE_TEXTURE_BINDING : 0) |
      (isWebGl2 ? 0 : GPU_TEXTURE_USAGE_COPY_SRC),
    viewFormats: [...profile.value.viewFormats],
  });
  if (!configured.ok) return configured;
  if (
    isWebGl2 &&
    (context.presentationProof === undefined ||
      !context.presentationProof.descriptor ||
      !context.presentationProof.acquisition ||
      !context.presentationProof.validation ||
      typeof context.presentationProof.surfaceIdentity !== 'string' ||
      context.presentationProof.surfaceIdentity.length === 0 ||
      context.presentationProof.requested === undefined ||
      context.presentationProof.validated === undefined ||
      JSON.stringify(context.presentationProof.requested) !==
        JSON.stringify(context.presentationProof.validated))
  ) {
    return err(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'WebGL2 surface storage has descriptor, acquisition, and validation proof',
        hint: 'run the concrete presentation probe and retain the last-known-good graph when proof is absent',
        detail: {
          error: {
            code: 'surface-raw-endpoint-failed',
            message: 'surface storage raw endpoint proof is incomplete',
          },
        },
      }),
    );
  }
  return ok(undefined);
}

export function selectSwapChainFormat(
  storageBufferCapable: boolean,
  surfaceViewFormats = true,
): SwapChainFormatPair {
  if (!storageBufferCapable) {
    return {
      storage: 'rgba8unorm',
      view: surfaceViewFormats ? 'rgba8unorm-srgb' : 'rgba8unorm',
    };
  }
  const nav = (
    globalThis as { navigator?: { gpu?: { getPreferredCanvasFormat?: () => GPUTextureFormat } } }
  ).navigator;
  const gpu = nav?.gpu;
  const getPreferred = gpu?.getPreferredCanvasFormat;
  if (gpu !== undefined && typeof getPreferred === 'function') {
    const storage = getPreferred.call(gpu);
    const view =
      storage === 'rgba8unorm'
        ? 'rgba8unorm-srgb'
        : storage === 'bgra8unorm'
          ? 'bgra8unorm-srgb'
          : storage;
    return {
      storage,
      view: surfaceViewFormats ? view : storage,
    };
  }
  return {
    storage: 'rgba8unorm',
    view: surfaceViewFormats ? 'rgba8unorm-srgb' : 'rgba8unorm',
    fallbackReason: 'preferred-canvas-format-missing',
  };
}
