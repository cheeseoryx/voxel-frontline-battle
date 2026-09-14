import type { AssetRuntimeError } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import type { Vec3 } from '@forgeax/engine-math';
import type { ProfileFrameToken, Profiler } from '@forgeax/engine-profiler';
import type { ColorValueDomain, RenderGraphError } from '@forgeax/engine-render-graph';
import type {
  BindGroupLayout,
  Buffer,
  Result,
  RhiCanvasSurfacePresentationProof,
  RhiCaps,
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  RhiInstance,
  RhiRenderPassEncoder,
  RenderPipeline as RhiRenderPipeline,
  Sampler,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import type { SkinError } from '@forgeax/engine-skinning';
import type { ImageError } from '@forgeax/engine-types';
import type { RhiBackendInstrumentation } from './assembly/backend-contract';
import type { Antialias, BloomEnabled, Tonemap } from './components/camera';
import type { EnvironmentInspection } from './environment/inspection';
import type { RecoveryOutcome, RecoveryPhase } from './errors/recover';
import type { RenderError } from './errors/render';
import type { RenderFeature, RenderFeatureDiagnostics } from './features/types';
import type { PostProcessShaderEntry } from './fullscreen-post-process-pass';
import type {
  BloomInspection,
  DirectionalShadowInspection,
  LightInspection,
  LodOcclusionInspection,
  MotionBlurInspection,
  ReflectionProbeInspection,
  RenderSceneInspection,
  SsrDependenciesInspection,
  TemporalTargetInspection,
  TransmissionInspection,
} from './inspection-types';
import type { InstanceCollectionInspection } from './instances';
import type { SsrAdmissionIdentity } from './ssr/identity';
import type {
  RenderTarget,
  RenderTargetDescriptor,
  RenderTargetReadbackData,
  RenderTargetReadbackRequest,
  RenderTargetReadbackTicket,
  RenderTargetTextureSource,
  RenderTargetTextureSourceOptions,
} from './targets/contracts';
import type { TemporalInspection } from './temporal/inspection';

export type { TransmissionInspection } from './inspection-types';
export type { PointsLinesInspection } from './points-lines/inspection';

import type {
  DynamicGeometryCandidate,
  DynamicGeometryError,
  DynamicGeometryInspection,
  DynamicGeometryOrdering,
  DynamicGeometryPrepareInput,
  DynamicGeometryReceipt,
} from './dynamic-geometry';
import type {
  IblBindingInspection,
  MeshMaterialBindingObservation,
} from './mesh-material-bindings';
import type { StandardLightingInspection } from './pipeline/standard-lighting/inspection';
import type { StandardProfile } from './pipeline/standard-profile';
import type { PointShadowInspection } from './point-shadow-inspection';
import type { PostProcessError } from './post-process-errors';
import type {
  GpuPassTimingObservation,
  GpuPassTimingOptions,
} from './record/gpu-pass-timing/index.js';
import type { VolumeTimingObservation } from './record/gpu-timing';
import type { TemporalView } from './temporal/view';
import type { VolumetricFogInspection } from './volume/inspection';

export type {
  CubeCameraFace,
  CubeCameraUpdateIntent,
} from './components/cube-camera';

export interface CubeCameraSnapshot {
  readonly entityKey?: number;
  readonly target: RenderTarget;
  readonly position: readonly [number, number, number];
  readonly near: number;
  readonly far: number;
  readonly updateIntent: import('./components/cube-camera').CubeCameraUpdateIntent;
  readonly requestVersion: number;
  readonly faceBudget: number;
}

export type RenderResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** The only World data boundary accepted by the M6 renderer contract. */
export type RenderWorldLease = RenderReadLease;

/**
 * Camera facts shared by extract, record, and scene owners.
 *
 * The extract stage resolves ECS camera state once and publishes this closed
 * POD contract. Keeping it beside the render lifecycle contracts prevents
 * extract from depending on the record implementation owner.
 */
export interface CameraSnapshot {
  /** Stable ECS identity used by the frame plan's camera authority fact. */
  readonly entityKey?: number;
  /** Auxiliary logical target; physical views remain renderer-owned. */
  readonly target?: RenderTarget;
  /** World index supplied by the multi-world extract merge. */
  readonly worldId?: number;
  /** Camera-owned history generation forwarded into the frame plan. */
  readonly historyVersion?: number;
  /** World-space camera translation (mat4.getTranslation of GlobalTransform.world). */
  readonly position: Vec3;
  /** Resolved world-space camera mat4, copied from GlobalTransform.world. */
  readonly world: Float32Array;
  readonly fov: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
  /** Camera projection variant used by view and shadow matrix builders. */
  readonly projection: 'perspective' | 'orthographic';
  readonly orthoLeft: number;
  readonly orthoRight: number;
  readonly orthoBottom: number;
  readonly orthoTop: number;
  readonly tonemap: Tonemap;
  readonly exposure: number;
  readonly whitePoint: number;
  readonly antialias: Antialias;
  readonly bloom: BloomEnabled;
  readonly bloomThreshold: number;
  readonly bloomIntensity: number;
  readonly bloomBlurRadius: number;
  readonly clearColor: readonly [number, number, number, number];
  /** Renderer-owned temporal projection used by Standard's TAA producer. */
  readonly temporal?: TemporalView;
  /** Active-camera motion blur parameters, present only when demanded. */
  readonly motionBlur?: {
    readonly shutterAngle: number;
    readonly maxRadiusPixels: number;
    readonly sampleCount: number;
  };
}

/** Stable identity owned by the Standard feature host for output transform. */
export const STANDARD_OUTPUT_TRANSFORM_FEATURE_ID = 'forgeax::standard::output-transform';

/** Stable identity for the special FXAA pass' per-frame output policy UBO. */
export const FXAA_POST_PROCESS_ID = 'forgeax::post::fxaa';

export type {
  EnvironmentFrame,
  EnvironmentSource,
  FogFrame,
  FramePlan,
} from './extract/environment';
export type { TemporalView } from './temporal/view';

/**
 * Render-graph state exposed to pipeline declarations. Concrete pipeline
 * caches stay in the assembly owner; graph code only needs the two target
 * formats that affect fullscreen descriptors.
 */
interface RenderPipelineStateView {
  readonly format: TextureFormat;
  readonly colorAttachmentFormat: TextureFormat;
  /** Renderer-owned View UBO shared by Standard lighting, shadows, and fog. */
  readonly viewUniformBuffer: Buffer;
  /** Fallback resources keep the shared view layout valid when no projector is authored. */
  readonly defaultWhiteTextureView: TextureView;
  readonly defaultSampler: Sampler;
}

/**
 * Narrow runtime capability consumed by typed graph primitives. The concrete
 * RenderSystemRuntime structurally satisfies this contract, but the public
 * frame surface does not depend on that assembly owner.
 */
interface RenderPipelineRuntime {
  readonly device: RhiDevice;
  /** Runtime-owned shader module factory used by built-in graph producers. */
  readonly shaderModuleFactory?: {
    createShaderModule(input: {
      readonly code: string;
      readonly label?: string | undefined;
    }): import('@forgeax/engine-types').Result<
      import('@forgeax/engine-rhi').ShaderModule,
      RhiError
    >;
  };
  readonly errorRegistry: { fire(error: RendererError): void };
  readonly debugOverlay?: RenderDebugOverlay | undefined;
  readonly lookupPostProcess?: (id: string) => PostProcessShaderEntry | undefined;
  readonly getPostProcessParamsBuffer?: (id: string) => Buffer | undefined;
  readonly getPostProcessPipeline?: (
    id: string,
    bgl: BindGroupLayout,
    colorFormat: GPUTextureFormat,
    entry?: PostProcessShaderEntry,
  ) => RhiRenderPipeline | null;
}

/**
 * Render-owned declaration for an app-provided debug overlay. App owns the
 * concrete DebugDraw instance and its GPU lifecycle; Render only records this
 * capability in the typed graph.
 */
export interface RenderDebugOverlay {
  encode(
    pass: RhiRenderPassEncoder,
    viewProj: import('@forgeax/engine-math').Mat4,
  ): Result<void, unknown>;
}

/**
 * The leaf frame context consumed by RenderPipeline and graph primitives.
 * Concrete assembly data is added only by the internal record extension in
 * render-system.ts, so this contract never imports the RenderSystem owner.
 */
export interface RenderPipelineContext {
  readonly pipelineState: RenderPipelineStateView;
  readonly runtime: RenderPipelineRuntime;
  readonly encoder: RhiCommandEncoder;
  readonly view: TextureView;
  readonly clear: readonly [number, number, number, number] | number[];
  readonly targetW: number;
  readonly targetH: number;
  readonly currentTexture: Texture;
  readonly camera: CameraSnapshot;
  /** Per-frame post-process parameter bytes keyed by shader id. */
  readonly postProcessParams: ReadonlyMap<string, Uint8Array>;
  readonly msaaActive: boolean;
  readonly geometryColorResolveView: TextureView | null;
  readonly ldrSpriteColorView: TextureView | null;
  /** Renderer-owned volume resources prepared from the authored ECS snapshot. */
  readonly volumetricFog?: VolumetricFogFrameContext;
  /** Renderer-owned SpotLight projector resources, independent of fog. */
  readonly spotLightProjector?: SpotLightProjectorFrameContext;
  /** Build-time composed utility sources for the renderer-owned volume passes. */
  readonly volumetricFogShaders?: VolumetricFogShaderSources;
}

/** Stable utility entry-point sources emitted by the shader manifest. */
export interface VolumetricFogShaderSources {
  readonly inject: string;
  readonly temporal: string;
  readonly integrate: string;
  readonly composite: string;
}

/**
 * GPU resources for one validated volumetric-fog candidate.  The record stage
 * owns residency and parameter uploads; graph passes consume this narrow view
 * and never reach into AssetRegistry or World.
 */
export interface VolumetricFogFrameContext {
  readonly densityTexture: Texture;
  readonly densityView: TextureView;
  readonly paramsBuffer: Buffer;
  readonly densityGeneration: number;
  /** Accepted graph-owned history slot; null means first frame/reset. */
  readonly historyReadSlot: 0 | 1 | null;
  /** Pending graph-owned history slot; promoted only after queue.submit succeeds. */
  readonly historyWriteSlot: 0 | 1;
  readonly historyValid: boolean;
  /** Accepted SpotLight projector resources resolved by the GPU residency owner. */
  readonly projectorTexture?: Texture;
  readonly projectorView?: TextureView;
  readonly projectorSampler?: Sampler;
}

/**
 * GPU resources for the single surface SpotLight projector binding. The
 * projector is a SpotLight-owned cookie and therefore remains available when
 * volumetric fog is disabled; volume integration may reuse the same tuple.
 */
export interface SpotLightProjectorFrameContext {
  readonly texture: Texture;
  readonly view: TextureView;
  readonly sampler: Sampler;
  /** Spot-light index in ExtractedLights.spot for the accepted texture. */
  readonly spotIndex?: number;
  /** Unified Standard Cluster slot index (points precede spots). */
  readonly lightSlotIndex?: number;
}

/**
 * The sole public renderer contract. Consume it in this order:
 * `state()` -> `inspect()` -> `recover()` when degraded -> `draw()` and its
 * `FrameReceipt`. Concrete assembly stays behind the host; callers retain only
 * leases, receipts, inspection PODs, and recovery Result values.
 */
export interface Renderer {
  /** Renderer-owned authoring and update path for large instance collections. */
  attach(world: World): RenderResult<RenderWorldLease, RenderError>;
  /** Prepare a standard MeshAsset for the active device generation. */
  prepareDynamicGeometry(
    input: DynamicGeometryPrepareInput,
  ): Result<DynamicGeometryCandidate, DynamicGeometryError>;
  /** Admit a prepared candidate; publication is tied to the next FrameReceipt. */
  acceptDynamicGeometry(
    candidate: DynamicGeometryCandidate,
    ordering: DynamicGeometryOrdering,
  ): Result<DynamicGeometryCandidate, DynamicGeometryError>;
  dynamicGeometryReceipt(candidate: DynamicGeometryCandidate): DynamicGeometryReceipt | undefined;
  cancelDynamicGeometry(candidate: DynamicGeometryCandidate): Result<void, DynamicGeometryError>;
  retireDynamicGeometry(candidate: DynamicGeometryCandidate): Result<void, DynamicGeometryError>;
  draw(input: RenderFrameInput): RenderResult<FrameReceipt, RenderError>;
  createRenderTarget(descriptor: RenderTargetDescriptor): RenderResult<RenderTarget, RenderError>;
  resizeRenderTarget(
    target: RenderTarget,
    descriptor: RenderTargetDescriptor,
  ): RenderResult<void, RenderError>;
  createRenderTargetTextureSource(
    target: RenderTarget,
    options: RenderTargetTextureSourceOptions,
  ): RenderResult<RenderTargetTextureSource, RenderError>;
  requestTargetReadback(
    target: RenderTarget,
    request: RenderTargetReadbackRequest,
  ): RenderResult<RenderTargetReadbackTicket, RenderError>;
  destroyRenderTarget(target: RenderTarget): RenderResult<void, RenderError>;
  setProfile(profile: RenderProfile): RenderResult<void, RenderError>;
  state(): RendererState;
  inspect(): RenderInspection;
  observe(
    receipt: FrameReceipt,
    request: FrameObservationRequest,
  ): Promise<RenderResult<FrameReceiptObservation, RenderError>>;
  subscribe(listener: (event: RendererEvent) => void): () => void;
  releaseSurface(): RenderResult<void, RenderError>;
  restoreSurface(): RenderResult<void, RenderError>;
  /** Recover only from device-lost; a healthy renderer returns a guard error. */
  recover(): Promise<RenderResult<void, RenderError>>;
  dispose(): Promise<RenderResult<void, RenderError>>;
}

/**
 * The single public renderer lifecycle authority. This closed union is the
 * frame gate: only `alive` admits World update and draw; `device-lost` and
 * `recovering` are explicit recovery states; `faulted` requires recreation;
 * `disposed` is terminal.
 */
export type RendererState = 'alive' | 'device-lost' | 'recovering' | 'faulted' | 'disposed';

/** Immutable, inspectable quality and budget policy for the Standard pipeline. */
export type RenderProfile = StandardProfile;

/** Ordered events projected from renderer state and expected-operation failures. */
export type RendererEvent =
  | {
      readonly kind: 'state-changed';
      readonly previous: RendererState;
      readonly current: RendererState;
    }
  | { readonly kind: 'error'; readonly error: RenderError }
  /** Emitted only after the renderer's sole submit path returns a receipt. */
  | {
      readonly kind: 'frame-submitted';
      readonly frameId: number;
      readonly deviceGeneration: number;
    };

/** Package-local listener alias used by the renderer assembly implementation. */
export type RendererEventListener = (event: RendererEvent) => void;

/**
 * Camera authority supplied for one frame; Render owns the lease contract and
 * the host releases it with the frame lifecycle. It is intentionally bound to
 * the attached scene lease and never accepts a backend object.
 */
export interface FrameCamera {
  readonly lease: RenderWorldLease;
  readonly entityKey?: number;
}

/**
 * Environment authority supplied for one frame. The scene/environment owner
 * supplies the identity; the host validates it against the attached lease.
 */
export interface FrameEnvironment {
  readonly lease: RenderWorldLease;
  readonly identity?: string;
}

/**
 * Receipt-bound observation selection. The request is consumed by `observe`
 * only with the matching FrameReceipt after `receipt.completed` and returns a
 * structured Result error when the generation or frame identity is stale.
 */
export interface FrameObservationRequest {
  readonly include: readonly ('timings' | 'draws' | 'bindings' | 'target-readbacks')[];
  readonly targetReadbacks?: readonly RenderTargetReadbackTicket[];
}

/**
 * Immutable synchronous proof that the sole host-owned submit reached the
 * queue. It is the only successful synchronous draw signal. Its
 * `deviceGeneration` fences stale work, and every observation request must use
 * this exact receipt; a recovery retry must obtain a new one.
 */
export interface FrameReceipt {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly completed: Promise<RenderResult<void, RenderError>>;
}

/**
 * The sole public draw input; World objects never cross this boundary. Render
 * owns extraction and graph interpretation, while the host owns encoding,
 * finish, submit, and recovery of the attached lease generation.
 */
export interface RenderFrameInput {
  readonly leases: readonly RenderWorldLease[];
  readonly camera: FrameCamera;
  readonly environment: FrameEnvironment;
  /** Fixed-step publication consumed by dynamic geometry candidates. */
  readonly fixedStep?: number;
  /** Optional profiler correlation token owned by App and consumed by Render. */
  readonly profileFrame?: ProfileFrameToken;
}

/** Detached, bounded observation metadata tied to one FrameReceipt and request. */
export interface FrameReceiptObservation {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly include: readonly ('timings' | 'draws' | 'bindings' | 'target-readbacks')[];
  /** Receipt-bound Render-owned GPU pass facts; absent when not requested. */
  readonly timings?: GpuPassTimingObservation | undefined;
  /** Receipt-bound volume GPU timing facts; absent when not requested. */
  readonly volumeTimings?: VolumeTimingObservation | undefined;
  readonly targetReadbacks?: readonly RenderTargetReadbackData[];
}

/** Stable backend facts for the Standard output transform projection. */
export interface RenderOutputInspection {
  readonly outputTransform?: typeof STANDARD_OUTPUT_TRANSFORM_FEATURE_ID;
  readonly displayEncoded: boolean;
  readonly intermediateFormat?: TextureFormat;
  /** Concrete surface route committed by configureSurface. */
  readonly surfaceProfile?: 'dual-view' | 'raw-only';
  /** Pass names from the same committed graph as the output facts. */
  readonly graphPassNames: readonly string[];
  /** Detached descriptor for the graph-owned output target, when present. */
  readonly standardOutputColor?: RenderStandardOutputColorInspection;
  readonly surfaceStorage: TextureFormat;
  readonly surfaceDisplay: TextureFormat;
  readonly endpoint: 'surface.storage.raw';
  readonly capability: 'rgba16float-renderable' | 'surface-raw-endpoint' | 'unavailable';
  readonly presentationProof?: RhiCanvasSurfacePresentationProof;
  readonly error:
    | {
        readonly code: string;
        readonly expected: string;
        readonly hint: string;
        readonly detail?: unknown;
      }
    | undefined;
}

/** Detached descriptor for the graph-owned display-encoded intermediate. */
export interface RenderStandardOutputColorInspection {
  readonly format: TextureFormat;
  readonly domain?: ColorValueDomain;
  readonly width: number;
  readonly height: number;
  readonly sampleCount: number;
  readonly usage: number;
}

/** Stable identity refs for a renderer-owned frame observation. */
export interface RenderObservationInspection {
  readonly observationId: string;
  readonly frameId: number;
  /** Camera antialias mode used by the frame carrying this observation. */
  readonly antialias?: Antialias;
  /** Surface route committed for the same frame graph. */
  readonly surfaceProfile?: 'dual-view' | 'raw-only';
  /** Capability fact used when resolving a raw-only float target. */
  readonly rgba16floatRenderable?: boolean;
  /** Exact pass names and target descriptor from the committed graph. */
  readonly passNames: readonly string[];
  readonly standardOutputColor?: RenderStandardOutputColorInspection;
}

/**
 * Detached renderer facts for host diagnostics and capability selection.
 *
 * The snapshot contains only POD values. It never exposes a device, queue,
 * registry, encoder, or live renderer-owned collection. Read `state` and the
 * bounded `recovery` detail before choosing to wait, retry, repair an owner,
 * or recreate the Renderer; this projection is not a proof of Browser/Dawn
 * execution.
 */
export interface RenderInspection {
  readonly state: RendererState;
  /** Bounded detached facts for the current or last recovery attempt. */
  readonly recovery: {
    readonly phase: RecoveryPhase | null;
    readonly fromGeneration: number;
    readonly candidateGeneration: number;
    readonly attempt: number;
    readonly elapsedMs: number;
    readonly lastOutcome: RecoveryOutcome;
    readonly failedOwner?: string;
    readonly failedResourceKind?: string;
    readonly rehydratedRoots: number;
    readonly staleLossEvents: number;
  };
  readonly surface: 'available' | 'released';
  readonly profile: RenderProfile;
  readonly capabilities: Readonly<RhiCaps>;
  readonly frame: {
    readonly frameId: number;
    readonly deviceGeneration: number;
  };
  /** Renderer-owned authored volume projection and submit/LKG state. */
  readonly volumetricFog?: VolumetricFogInspection;
  readonly features: readonly string[];
  /** Truthful lifecycle facts for every registered declarative feature. */
  readonly featureDiagnostics: readonly RenderFeatureDiagnostics[];
  readonly frustumStats: { readonly culled: number; readonly total: number };
  readonly visibilityStats: { readonly explicitlyHidden: number };
  /** Renderer-owned large-instance residency and upload facts. */
  readonly instanceCollections: readonly InstanceCollectionInspection[];
  /** Standard MeshAsset dynamic-candidate lifecycle facts. */
  readonly dynamicGeometry?: DynamicGeometryInspection;
  readonly renderScene: RenderSceneInspection;
  readonly reflectionProbes: ReflectionProbeInspection;
  /** Renderer-owned SSR dependency seam; consumer facts are projected from live owners. */
  readonly ssrDependencies: SsrDependenciesInspection;
  /** Last completed transmission candidate facts, detached from GPU handles. */
  readonly transmission?: TransmissionInspection;
  /** Last prepared Standard transport facts, detached from GPU handles. */
  readonly standardLighting?: StandardLightingInspection;
  /** Renderer-owned point-shadow atlas budget facts from the last frame. */
  readonly pointShadow?: PointShadowInspection;
  readonly meshMaterialBindings: readonly MeshMaterialBindingObservation[];
  /** Final-submit Standard IBL binding-chain receipt, when diagnostics ran. */
  readonly iblBinding?: IblBindingInspection;
  readonly perFramePassNames: readonly string[];
  readonly bindGroupCounts: {
    readonly createBindGroup: number;
    readonly keys: readonly string[];
  };
  /**
   * Recovery evidence projected from production owners. Graph, residency,
   * submit, and receipt fields are observations, not recovery test fixtures.
   */
  readonly recoveryEvidence: {
    readonly producerRoots: readonly {
      readonly kind: string;
      readonly owner: string;
      readonly candidateScope: 'device-scope';
      readonly visibility: 'visible-workset' | 'non-visible-lazy';
      readonly disabledWork: 'zero' | 'lazy';
    }[];
    readonly graph: {
      readonly ready: boolean;
      readonly generation: number;
      readonly passCount: number;
      readonly resourceCount: number;
    };
    readonly residency: { readonly meshResidencyEpoch: number };
    readonly submissions: {
      readonly count: number;
      readonly lastGeneration: number | undefined;
    };
    readonly receipts: {
      readonly count: number;
      readonly lastGeneration: number | undefined;
    };
  };
  /** Output transform facts; never includes fixture metrics or pixel bytes. */
  readonly outputTransform?: typeof STANDARD_OUTPUT_TRANSFORM_FEATURE_ID;
  readonly displayEncoded: boolean;
  readonly intermediateFormat?: TextureFormat;
  readonly surfaceStorage: TextureFormat;
  readonly surfaceDisplay: TextureFormat;
  readonly endpoint: 'surface.storage.raw';
  readonly capability: RenderOutputInspection['capability'];
  readonly presentationProof?: RhiCanvasSurfacePresentationProof;
  readonly error: RenderOutputInspection['error'];
  readonly observation: RenderObservationInspection;
  readonly environment: EnvironmentInspection;
  readonly temporal: TemporalInspection;
  readonly bloom: BloomInspection;
  /** Candidate/accepted/LKG facts for the single extendedLighting topology. */
  readonly extendedLighting: LightInspection;
  readonly directionalShadow: DirectionalShadowInspection;
  /** Semantic Standard temporal target metadata; no graph or RHI handles. */
  readonly temporalTarget?: TemporalTargetInspection;
  /** Renderer-owned Motion Blur facts; absent when no component is active. */
  readonly motionBlur?: MotionBlurInspection;
  /** Bounded renderer-owned LOD/occlusion facts; absent before a candidate frame. */
  readonly lodOcclusion?: LodOcclusionInspection;
}

/** Backend marker — single-element union preserved for future extensibility (D-2). */
/**
 * `renderer.draw(worlds, options)` owner options
 * (feat-20260709-editor-world-partition M1 / w6, plan-strategy §2 D-3).
 *
 * The single `owner` index that previously served BOTH the surfaced cameras
 * and the singleton render resources (skylight / skybox / postProcessParams) is
 * split into two independent indices:
 *   - `cameraOwner`   — the world whose cameras are surfaced.
 *   - `resourceOwner` — the world whose skylight / skybox / postProcessParams
 *                       are surfaced.
 *
 * Both owners are always explicit. Single-world callers pass zero for both;
 * composite callers may select different worlds.
 */
export type DrawOwnerOptions = {
  readonly cameraOwner: number;
  readonly resourceOwner: number;
  readonly profileFrame?: ProfileFrameToken;
};

/** Information attached to a device-loss notification. */
export interface RendererLostInfo {
  /** Concise machine-readable cause, mapped to a single vocabulary. */
  reason: string;
  /** Free-form description (UA / extension / driver text). */
  message: string;
}

/** Listener registered through `Renderer.onLost`. */
export type RendererLostListener = (info: RendererLostInfo) => void;

/**
 * Composite error type retained for package-local renderer diagnostics. The
 * public Renderer projects expected operation failures through the single
 * `subscribe` event stream and its `error` event; this type does NOT define a
 * error; it only references the cluster unions whose members can arrive here.
 * As such it is an external wire alias (AGENTS.md Change stance add-only wire
 * exception), NOT the eliminated cross-cluster `RuntimeError` SSOT (D-3).
 *
 * Composition = `RhiError | RenderError | AssetRuntimeError | SkinError |
 * PostProcessError`. This equals the pre-decomposition
 * `RhiError | RuntimeError | PostProcessError` exactly: `RuntimeError` was
 * `RenderError | AssetRuntimeError | SkinError` (27 classes). `RecoverError`
 * and `EngineEnvironmentError` are intentionally excluded — neither is ever
 * emitted through the Renderer event stream (`RecoverError` returns from `recover()`,
 * `EngineEnvironmentError` throws at construction), matching the original
 * `RuntimeError` union which excluded both (OOS-3 behavior equivalence).
 *
 * AI consumers do `switch (err.code)` over the union: the disjoint
 * `RhiErrorCode` / `RenderErrorCode` / `AssetRuntimeErrorCode` / `SkinErrorCode`
 * / `PostProcessErrorCode` literal sets let TS narrow each arm to the concrete
 * class (charter P3 union discoverability — every fan-out member is reachable
 * in an exhaustive switch, no untyped escape). Example:
 *
 * ```ts
 * renderer.subscribe((event) => {
 *   if (event.kind !== 'error') return;
 *   switch (event.error.code) {
 *     case 'asset-not-registered': // AssetRuntimeError arm, err narrowed here
 *       return report(err.hint);
 *     // ...one arm per RhiErrorCode | RenderErrorCode | AssetRuntimeErrorCode
 *     //    | SkinErrorCode | PostProcessErrorCode member; no default needed,
 *     //    TS flags every unhandled code at compile time.
 *   }
 * });
 * ```
 */
export type RendererError =
  | RhiError
  | RenderGraphError
  | ImageError
  | RenderError
  | AssetRuntimeError
  | SkinError
  | PostProcessError;

/**
 * Package-local error listener retained for host assembly. Public consumers
 * use `Renderer.subscribe` and receive `RendererEvent` instead.
 */
export type RendererErrorListener = (error: RendererError) => void;

/**
 * Built-in graph pass owners used as nested children of `record/graph-execute`.
 * Unknown extension pass names use the explicit `other` bucket so custom
 * pipelines retain a bounded catalog while the default render workload gets
 * actionable owner attribution.
 */
export const RENDER_GRAPH_EXECUTION_PHASE_CATALOG = [
  'record/graph-execute/point-shadow',
  'record/graph-execute/cluster-binner-upload',
  'record/graph-execute/g-buffer',
  'record/graph-execute/g-buffer/geometry-loop',
  'record/graph-execute/g-buffer/material-bind-groups',
  'record/graph-execute/g-buffer/pipeline-selection',
  'record/graph-execute/g-buffer/draw-submit',
  'record/graph-execute/ssao-calc',
  'record/graph-execute/ssao-blur',
  'record/graph-execute/lighting',
  'record/graph-execute/forward',
  'record/graph-execute/forward/geometry-loop',
  'record/graph-execute/forward/material-bind-groups',
  'record/graph-execute/forward/pipeline-selection',
  'record/graph-execute/forward/draw-submit',
  'record/graph-execute/output-transform',
  'record/graph-execute/present',
  'record/graph-execute/debug-overlay',
  'record/graph-execute/shadow',
  'record/graph-execute/spot-shadow',
  'record/graph-execute/skybox',
  'record/graph-execute/main',
  'record/graph-execute/fxaa',
  'record/graph-execute/bloom-bright',
  'record/graph-execute/bloom-blur-h',
  'record/graph-execute/bloom-blur-v',
  'record/graph-execute/bloom-composite',
  'record/graph-execute/other',
] as const;

export type RenderGraphExecutionPhase = (typeof RENDER_GRAPH_EXECUTION_PHASE_CATALOG)[number];

/** Bounded producer-owned children of the scene-state record owner. */
export const RENDER_HDRP_BINNER_PHASE_CATALOG = [
  'record/scene-state/hdrp-cluster/binner/light-bounds-and-occupancy',
  'record/scene-state/hdrp-cluster/binner/light-bounds-and-occupancy/light-aabb',
  'record/scene-state/hdrp-cluster/binner/light-bounds-and-occupancy/cluster-occupancy',
  'record/scene-state/hdrp-cluster/binner/cluster-reserve',
  'record/scene-state/hdrp-cluster/binner/input-preparation',
  'record/scene-state/hdrp-cluster/binner/bin-core',
  'record/scene-state/hdrp-cluster/binner/light-index-write',
  'record/scene-state/hdrp-cluster/binner/light-index-write/bounds-read',
  'record/scene-state/hdrp-cluster/binner/light-index-write/cluster-write',
] as const;

export const RENDER_HDRP_CLUSTER_PHASE_CATALOG = [
  'record/scene-state/hdrp-cluster/binner',
  ...RENDER_HDRP_BINNER_PHASE_CATALOG,
  'record/scene-state/hdrp-cluster/payload-packing',
  'record/scene-state/hdrp-cluster/buffer-upload',
] as const;

export type RenderHdrpClusterPhase = (typeof RENDER_HDRP_CLUSTER_PHASE_CATALOG)[number];

export const RENDER_SCENE_STATE_PHASE_CATALOG = [
  'record/scene-state/fold-buckets',
  'record/scene-state/lighting-prep',
  'record/scene-state/ambient-resolution',
  'record/scene-state/directional-shadow-cache',
  'record/scene-state/hdrp-cluster',
  ...RENDER_HDRP_CLUSTER_PHASE_CATALOG,
] as const;

/**
 * Opt-in boundaries inside one `Renderer.draw` call. The observer is a
 * diagnostics seam only: it receives wall-time boundaries and must never be
 * required for rendering correctness. The stage names mirror the existing
 * engine-owned Extract / Prepare / Record orchestration so a host can measure
 * attribution without guessing from RHI command counts.
 */
export const RENDER_RECORD_PHASE_CATALOG = [
  'record/occlusion-query-submit',
  'record/occlusion-global-advance',
  'record/scene-state',
  ...RENDER_SCENE_STATE_PHASE_CATALOG,
  'record/swapchain',
  'record/render-graph',
  'record/target-views',
  'record/validation',
  'record/dispatch-plan',
  'record/uploads',
  'record/bind-groups',
  'record/graph-execute',
  ...RENDER_GRAPH_EXECUTION_PHASE_CATALOG,
] as const;

export type RenderRecordPhase = (typeof RENDER_RECORD_PHASE_CATALOG)[number];

export const RENDER_PHASE_CATALOG = [
  'extract',
  'occlusion-prepare',
  'bind-groups',
  'features',
  'sort',
  'record',
  ...RENDER_RECORD_PHASE_CATALOG,
] as const;

export type RenderPhase = (typeof RENDER_PHASE_CATALOG)[number];

export type RenderPhaseSkipReason =
  | 'feature-host-unavailable'
  | 'feature-host-empty'
  | 'pipeline-state-unavailable'
  | 'camera-unavailable';

/** First-version options bag (intentionally empty; reserved for v0.1). */
export interface RendererOptions {
  /** Producer-owned features installed by the renderer host. */
  readonly features?: readonly RenderFeature<unknown>[] | undefined;
  /** Standard profile consumed by the single renderer-owned pipeline. */
  readonly standardProfile?: RenderProfile | undefined;
  /** Explicit profiler capability shared by App and Render. */
  readonly profiler?: Profiler | undefined;
  /** Explicitly request timestamp-query for receipt-bound GPU profiling. */
  readonly captureGpuTimings?: boolean | undefined;
  /** Optional host-owned RHI lifecycle instrumentation, such as recording. */
  readonly rhiInstrumentation?: RhiBackendInstrumentation | undefined;
  /** Optional bounded GPU pass timing facts; this is not frame latency. */
  readonly gpuPassTiming?: GpuPassTimingOptions | undefined;
  /** Exact source/tree/lock/build identity binding for the renderer-owned SSR seam. */
  readonly ssrIdentity?: SsrAdmissionIdentity | undefined;
  // feat-20260608-create-app-param-surface-trim / M1 / AC-02: `clearColor`
  // was deleted as a one-cut breaking change (AGENTS.md Change stance +
  // requirements constraint #1: no deprecation window, no shim). Scene
  // clear color now lives on the Camera entity (`clearColor`, an inline
  // array<f32,4> column as of feat-20260709 M3); zero-Camera fallback uses
  // `ZERO_CAMERA_CLEAR_FALLBACK = [0, 0, 0, 1]` from
  // `render-system-record`. AI users that pass `{ clearColor: [...] }` on
  // RendererOptions still get a TS2353 excess-property error at compile time.
  //
  // feat-20260608-create-app-param-surface-trim / M2 / AC-06 + D-3:
  // `shaderManifestUrl` was deleted from RendererOptions and moved to
  // the third-arg `BundlerOptions` (build-tool injection channel). The
  // fallback literal '/shaders/manifest.json' stays at the createRenderer
  // body site (D-2 q5-A) so the LO 1.1 zero-config takeoff path keeps
  // working without explicit injection. AI users that pass
  // `{ shaderManifestUrl: '...' }` to RendererOptions get a TS2353
  // excess-property error at compile time pointing them to the third
  // arg (charter P1 progressive disclosure -- the message names
  // BundlerOptions, not a free-form string).
  /**
   * M3 D-P4 escape hatch (feat-20260511-rhi-wgpu-impl): explicit
   * `RhiInstance` injection bypasses the dynamic-import auto-select
   * facade. When set, `createRenderer` uses this instance verbatim and
   * neither concrete backend adapter is imported dynamically (charter
   * proposition 5 discoverable opt-in /
   * plan-strategy §6 M3 + §7.4 escape hatch + Bevy
   * `RenderCreation::Manual` partial equivalent).
   *
   * Typical use cases:
   *   - Testing / debugging — inject a deterministic stub.
   *   - Pinning a specific backend even when the browser adapter is present,
   *     for cross-shim regression tests.
   *   - Advanced AI users implementing their own `RhiInstance` shim.
   *
   * AI users who want the default behaviour leave this field omitted;
   * `navigator.gpu` presence/absence drives the dynamic import (see the
   * `createRenderer` JSDoc for the full auto-select decision tree).
   */
  readonly rhi?: RhiInstance | undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Renderer health / recover surface (feat-20260621-renderer-health-recover-skeleton M1)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Closed union of renderer health states.
 *
 * 3 members per plan-strategy D-1:
 *   - `'alive'` — healthy baseline (registry not yet fired)
 *   - `'device-lost'` — device loss detected
 *   - `'internal-fault'` — internal renderer fault
 *
 * AI users exhaustively switch on `HealthReason` without default; TS guards
 * completeness.
 */
export type HealthReason = 'alive' | 'device-lost' | 'internal-fault';

/** Detail for `HealthReason 'device-lost'`. */
export interface HealthDetailDeviceLost {
  readonly lostReason: 'unknown' | 'destroyed';
  readonly message: string;
}

/** Detail for `HealthReason 'internal-fault'`. */
export interface HealthDetailInternalFault {
  readonly message: string;
}

/**
 * Pull-style health snapshot — discriminated union by `reason`.
 *
 * Per plan-strategy D-2: `switch(snap.reason)` narrows `snap.detail` to the
 * per-reason detail type automatically, with zero `as` casts. `alive` has no
 * `.detail` field; `device-lost` / `internal-fault` have a required `.detail`
 * of the respective variant.
 *
 *   - `recoverable` — explicit snapshot data owned by the lifecycle authority
 */
export type HealthSnapshot =
  | { readonly reason: 'alive'; readonly recoverable: boolean }
  | {
      readonly reason: 'device-lost';
      readonly detail: HealthDetailDeviceLost;
      readonly recoverable: boolean;
    }
  | {
      readonly reason: 'internal-fault';
      readonly detail: HealthDetailInternalFault;
      readonly recoverable: boolean;
    };

/**
 * Maps `HealthReason` to recoverable boolean per the derive table
 * (requirements section "range"):
 *
 *   | reason         | recoverable |
 *   |:---------------|:-----------|
 *   | `'alive'`      | false       |
 *   | `'device-lost'`| true        |
 *   | `'internal-fault'` | false   |
 */
/** Callback type for `Renderer.onHealthChange`. */
export type HealthChangeListener = (snapshot: HealthSnapshot) => void;
