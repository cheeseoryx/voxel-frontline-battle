// @forgeax/engine-render — concrete Renderer lifecycle and frame interpreter.
//
// The Runtime host selects one typed backend pack before this assembly runs.
//
// **D-P4 three-channel error propagation** (RK-04 + plan-strategy §7.3):
//   (a) Construction-time → `createRenderer(...)` rejects with
//       `EngineEnvironmentError` whose `detail.webgpuError` is the Channel 2
//       `RhiError` and `detail.wgpuError` is the Channel 3 failure (when both
//       channels fail; AI users `try { await createRenderer(...) } catch (e) {
//       switch (e.detail.webgpuError?.code) { ... } }`).
//   (b) Run-time pipeline build → `renderer.initialization` rejects with the
//       structured `RhiError` (`shader-compile-failed` / `limit-exceeded` /
//       `webgpu-runtime-error` / ...); AI users `await renderer.initialization`.
//   (c) error fan-out → `renderer.subscribe(listener)` captures the same
//       errors as a fallback observability channel (charter proposition 4
//       structured + proposition 9 graceful degradation).
//
// AC-15 source-level: this file uses `globalThis.navigator` rather than
// `navigator` directly; it never touches `window` or `document`.

import type { MipmapShaderModuleFactory } from '@forgeax/engine-assets-runtime';
import {
  AssetRegistry,
  adaptDynamicTextureDevice,
  DynamicTextureStore,
} from '@forgeax/engine-assets-runtime';
import { audioLoader } from '@forgeax/engine-audio-webaudio';
import { Update, type World } from '@forgeax/engine-ecs';
import { createRenderReadLease, type RenderReadLease } from '@forgeax/engine-ecs/projection';
import {
  deriveVertexBufferLayout,
  deriveVertexBufferLayoutFromProjection,
  type VertexLayoutProjection,
} from '@forgeax/engine-geometry';
import type {
  BindGroupLayout,
  PipelineLayout,
  RenderPipeline,
  Result,
  RhiCanvasContext,
  RhiDevice,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError, validateDrawArgs } from '@forgeax/engine-rhi';
import { registerPropagateTransforms } from '@forgeax/engine-scene';
import {
  findVariantByKey,
  type MaterialShaderEntry,
  type MaterialShaderManifestEntry,
  ShaderCatalog,
  standardPhysicalTextureFields,
} from '@forgeax/engine-shader';
import type {
  ImportTransport,
  MaterialRenderState,
  ParamSchemaEntry,
  PassKind,
  PrimitiveTopology,
  VertexAttributeMap,
} from '@forgeax/engine-types';
import { createDynamicGeometryLifecycle } from '../dynamic-geometry';

export type { MaterialShaderManifestEntry } from '@forgeax/engine-shader';

import { GpuResidencyCache } from '../device/gpu-residency';
import type { DeviceResourceKind } from '../device/resource-types';
import { createEngineMetrics } from '../engine-metrics';
import { createRecoveryFailedError, RecoverError, type RecoverFailure } from '../errors/recover';
import {
  FrameReceiptStaleError,
  type RenderError,
  RendererContractFailureError,
  type RendererOperationCause,
  RendererOperationError,
  RenderFeatureCapabilityMissingError,
  RenderFeatureStageFailedError,
} from '../errors/render';
import { createRenderFeatureHost, type RenderFeatureHost } from '../features/host';
import { RENDER_FEATURE_VERTEX_LAYOUTS } from '../features/prepared-graphics';
import type { RenderFeature, RenderFeatureShaderModuleMode } from '../features/types';
import {
  type PostProcessShaderEntry,
  postProcessShaderModuleLabel,
} from '../fullscreen-post-process-pass';
import { glyphTextLayoutSystem } from '../glyph-text-layout-system';
import { GPU_SHADER_STAGE_FRAGMENT, GPU_SHADER_STAGE_VERTEX } from '../gpu-stage';
import type { BloomInspection } from '../inspection-types';
import {
  DeviceScope,
  HealthListenerRegistry,
  LostListenerRegistry,
  RhiErrorListenerRegistry,
} from '../lifecycle';
import {
  isCanonicalStandardPbrMaterialShader,
  isStandardPbrMaterialShader,
  type PipelineGroup2Contract,
  resolvePipelineGroup2Contract,
  SKIN_MATERIAL_SHADER_ID,
} from '../pbr-pipeline';
import { standardPipeline } from '../pipeline/standard-pipeline';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import { buildPipelineForMaterialShader } from '../pipeline-builder';
import {
  buildBindGroupLayoutDescriptor,
  cacheKeyOf,
  colorFormatsForPassKind,
  type PipelineSpec,
  passKindPolicyTable,
} from '../pipeline-spec';
import type { ExtendedLightingResourceCandidate } from '../prepare/extended-lighting/resources';
import {
  COOKIE_MATRIX_BYTES,
  COOKIE_SLICE_SIZE,
  deriveExtendedLightingCapability,
  EXTENDED_LIGHTING_TOPOLOGY,
  IES_SLICE_HEIGHT,
  IES_SLICE_WIDTH,
} from '../prepare/extended-lighting/resources';
import {
  createExtendedLightingState,
  projectExtendedLightingInspection,
  promoteExtendedLightingCandidate,
} from '../prepare/extended-lighting/state';
import type { FrameObservationOptions } from '../record/frame';
import type { GpuPassTimingReason } from '../record/gpu-pass-timing/errors.js';
import {
  createGpuPassTimingSession,
  DEFAULT_GPU_PASS_TIMING_OPTIONS,
  type GpuPassTimingCapture,
  type GpuPassTimingObservation,
  type GpuPassTimingSession,
} from '../record/gpu-pass-timing/index.js';
import { GpuTimingCapture, type VolumeTimingObservation } from '../record/gpu-timing';
import type { RecoveryColdWorkGuard } from '../record/render-context';
import type {
  DrawOwnerOptions,
  FrameObservationRequest,
  FrameReceipt,
  FrameReceiptObservation,
  HealthSnapshot,
  RenderDebugOverlay,
  RendererErrorListener,
  RendererLostListener,
  RendererOptions,
  RenderFrameInput,
  RenderInspection,
  RenderProfile,
  RenderResult,
  RenderWorldLease,
  VolumetricFogShaderSources,
} from '../render-contract';
import { FXAA_POST_PROCESS_ID, STANDARD_OUTPUT_TRANSFORM_FEATURE_ID } from '../render-contract';
import {
  attachGpuPassTimingSession,
  createRenderSystem,
  type PipelineState,
  type RecoveryGraphCandidate,
  type RecoveryPostProcessResources,
  type RecoveryRootBundle,
  type RenderSystem,
} from '../render-system';
import { createGpuPassTimingObservationStore, observeGpuPassTimingDisabled } from '../renderer.js';
import { postSpawnResolveJoints } from '../scene-instances/post-spawn-resolve-joints';
import type { RenderTarget } from '../targets/contracts';
import { tilemapChunkExtractSystem } from '../tilemap-chunk-extract-system';
import type { RhiBackendPack } from './backend-contract';
import type { BundlerOptions } from './bundler-contract';
import { deviceOptionsForAdapter } from './device-feature-admission';
import { createDynamicGeometryHost } from './dynamic-geometry-host';
import type { RendererAssemblyImplementation } from './host-contract';
import {
  allowsUnlitPreparedFallback,
  invokeDeviceCreateShaderModule,
  isSharedMaterialUserRegionCompatible,
  type LayoutKind,
  type MaterialShaderBindingContract,
  makeShaderDeviceAdapter,
  normalizeMaterialShaderVariantSet,
  prepareMaterialShaders,
  resolveMaterialShaderBackendArtifactKey,
  resolveMaterialShaderBindingContract,
  resolveMaterialShaderUvSetCount,
  resolveMaterialShaderVariantSet,
  resolveMaterialShaderVertexInputContract,
  type ShaderDeviceAdapterInternal,
  selectNoColorPbrVariant,
  selectPipelineLayoutForVariant,
  shouldDeferMissingPreparedMaterialShader,
} from './material-shader-policy';
import type { MeshSsboGrowResult, MeshSsboState } from './mesh-ssbo-grow';
import { attachDeviceLostFanout } from './recovery/device-loss-fanout';
import {
  type GenerationAggregate,
  type GenerationPublication,
  publishGeneration,
} from './recovery/generation';
import { createRendererRecovery, type RendererRecovery } from './recovery/renderer-recover';
import { createRenderTargetHost } from './render-target-host';
import {
  freezeRenderProfile,
  structuredRendererCause,
  validateRenderProfile,
} from './renderer-facade';
import {
  type ContinuationTerminator,
  createContinuationTerminator,
} from './renderer-frame-transaction';
import { ensureContextConfigured, wrapDisposeError } from './renderer-helpers';
import { projectRendererOutputInspection } from './renderer-inspection';
import {
  createRecoveryContinuation,
  createRecoveryDeadline,
  createSingleFlight,
  type RecoveryGuidance,
  type RecoveryPhase,
} from './renderer-lifecycle';
import { STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES } from './shader-prewarm-policy';
import { buildReadyWebGPU } from './webgpu-ready';
import { DEPTH_TEXTURE_FORMAT, HDR_COLOR_ATTACHMENT_FORMAT } from './webgpu-ready-contract';
import {
  BILLBOARD_MATERIAL_INSTANCE_VERTEX_BUFFERS,
  DEFAULT_VERTEX_ATTRS,
  MESH_GEOMETRY_MATERIAL_INSTANCE_VERTEX_BUFFERS,
  PBR_SKIN_SENTINEL_ATTR_BUFFER,
  POSITION_SIZE_COLOR_INSTANCE_VERTEX_BUFFERS,
  PREPARED_INSTANCE_VERTEX_ATTRS,
  PREPARED_MATERIAL_INSTANCE_VERTEX_ATTRS,
  TOPOLOGY_SEGMENT_INSTANCE_VERTEX_BUFFERS,
  toGpuVertexBufferLayouts,
} from './webgpu-vertex-layouts';

export type { BundlerOptions } from './bundler-contract';
export { assembleMaterialProjection } from './material/assembly';
export type {
  LayoutKind,
  MaterialShaderBindingContract,
  MaterialShaderVertexInputContract,
} from './material-shader-policy';
export {
  allowsUnlitPreparedFallback,
  isSharedMaterialUserRegionCompatible,
  normalizeMaterialShaderVariantSet,
  resolveMaterialShaderBackendArtifactKey,
  resolveMaterialShaderBindingContract,
  resolveMaterialShaderUvSetCount,
  resolveMaterialShaderVariantSet,
  resolveMaterialShaderVertexInputContract,
  selectNoColorPbrVariant,
  selectPipelineLayoutForVariant,
  shouldDeferMissingPreparedMaterialShader,
} from './material-shader-policy';
export type {
  MeshSsboBufferWrapper,
  MeshSsboGrowController,
  MeshSsboGrowControllerInit,
  MeshSsboGrowDevice,
  MeshSsboGrowErrorRegistry,
  MeshSsboGrowResult,
  MeshSsboState,
} from './mesh-ssbo-grow';
export {
  createMeshSsboGrowController,
  deriveStorageBufferCeiling,
  INITIAL_MESH_SSBO_SLOT_COUNT,
  requireMeshSsboBuffer,
} from './mesh-ssbo-grow';
export { exposeRenderer } from './renderer-facade';
export {
  selectHdrpPbrPrewarmVariants,
  selectProbePrewarmVariants,
  selectSkinPrewarmVariants,
  selectStandardPbrTransmissionPrewarmVariants,
} from './shader-prewarm-policy';

function adaptMipmapShaderModuleFactory(
  factory: RhiBackendPack['createShaderModule'],
): MipmapShaderModuleFactory | undefined {
  if (factory === undefined) return undefined;
  return (device, descriptor) => factory(device as RhiDevice, descriptor);
}

// Re-export registerAdvanceAnimationPlayer so consumers can wire it.
// Re-export registerPropagateTransforms so consumers can wire the
// Transform.world mat4 derivation (audio listener sync + picking read the
// derived Transform.world from scripts).

/**
 * Bundler-layer injection accepted by `createRenderer` (and proxied by
 * `createApp`) as the optional third argument.
 *
 * feat-20260608-create-app-param-surface-trim / M2 / D-3: aggregates the two
 * host-injected build-tool channels:
 *
 *   - shaderManifestUrl: the URL the host's vite-plugin-shader emit step
 *     wrote `manifest.json` to. When this field is omitted (or `bundler`
 *     itself is omitted), createRenderer falls back to
 *     '/shaders/manifest.json' (D-2 q5-A) so the LO 1.1 zero-config takeoff
 *     path keeps working without explicit injection. Tests can inject via a
 *     `data:application/json,...` URL to bypass fetch.
 *
 *   - importTransport: dev-only ImportTransport forwarded verbatim to the
 *     AssetRegistry third ctor slot so DDC-miss assets can lazy-import.
 *     Absent => shipped form (a DDC miss fails fast with `asset-not-imported`).
 *
 * The interface is structurally shared with `@forgeax/engine-app` while this
 * package keeps the renderer independent from the host package.
 */
// ─── Backend pack — M3 auto-select internal shape ───────────────────────────

// ─── WebGPU branch ──────────────────────────────────────────────────────────

/**
 * Wire the spec `device.lost` Promise into the lost / error / health channels
 * (research §F-4 / R2). A genuine device loss fans out through `errorRegistry`
 * so the public `renderer.subscribe` error event triggers, and
 * through `healthRegistry` so `health().reason` flips to `'device-lost'`
 * (feat-20260622-s5 M1/M2). Explicit renderer teardown is observable through
 * `onLost`, but is not a runtime error and must not manufacture an RhiError.
 *
 * Extracted to a single helper (SSOT) so the createRenderer assembly path AND
 * the recover() rebuild path attach byte-identical fan-out to whichever device
 * is current — recover() mints a fresh device whose own `lost` Promise must be
 * re-wired to the SAME registries the host already subscribed to.
 */
// Device loss wiring lives in the recovery assembly seam so boot and recovery
// cannot drift into separate lifecycle event paths.

/**
 * tryCreateWebGPURenderer returns three kinds of outcome (fix-f1 / w16):
 * - `ok`           → Renderer created successfully
 * - `rhi-err`      → RHI Result.err path (preserves the original RhiError
 *                    for AI consumers to read; now includes context acquisition
 *                    failures via pack.rhi.acquireCanvasContext)
 * - `throw`        → exception path (caught and wrapped by the caller as
 *                    an Error)
 */
export type WebGPUOutcome =
  | { kind: 'ok'; renderer: RendererAssemblyImplementation }
  | { kind: 'rhi-err'; error: RhiError }
  | { kind: 'throw'; error: Error };

/**
 * Goes through the strict two-step path exposed by the injected backend pack:
 *   `rhi.requestAdapter()` -> `adapter.requestDevice()`
 * (M6 fix-up [w51] retires the legacy single-step factory per plan-strategy
 * §6 M3 break-point #2 + AGENTS.md break-point list 2026-05-10 #2). Returns
 * `Result<RhiAdapter, RhiError>` then `Result<RhiDevice, RhiError>`; each
 * failure / failure to acquire the canvas WebGPU context returns a
 * structured outcome so the caller can decide on fallback and error-
 * preservation strategy (plan-strategy §7.3).
 *
 * fix-f1: on either Result.err path the original `RhiError` is preserved
 * via the `rhi-err` outcome — when fallback also fails, AI consumers read
 * it via `EngineEnvironmentError.detail.webgpuError.code`.
 *
 * w19 / M4: context acquisition goes through `pack.rhi.acquireCanvasContext(canvas)`
 * — a polymorphic entry owned by the selected backend adapter.
 * The backend pack is selected BEFORE this call (in `loadBackendPack` /
 * the Channel 2→3 fallback in `createRenderer`), so the canvas context
 * is never type-locked by a wrong backend's acquisition attempt.
 */
let nextDerivedSystemId = 0;

export async function tryCreateWebGPURenderer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options: RendererOptions | undefined,
  pack: RhiBackendPack,
  // feat-20260608 M2 / D-3: BundlerOptions threaded verbatim. Carries
  // shaderManifestUrl (consumed in getShader fallback ~30 lines below) and
  // importTransport (forwarded to the AssetRegistry third ctor slot;
  // undefined keeps the shipped form, AC-08).
  bundler: BundlerOptions | undefined,
): Promise<WebGPUOutcome> {
  const importTransport = bundler?.importTransport;
  // M6 fix-up [w51]: spec-aligned two-step path. Step 1 - requestAdapter()
  // surfaces adapter.features / adapter.limits (capability pre-screen,
  // charter proposition 4 forward-reachable). Step 2 - adapter.requestDevice()
  // requests the actual device. M3 D-P4: `pack.rhi` is the auto-selected
  // backend singleton (rhi-webgpu / rhi-wgpu / explicit escape hatch).
  // w19: thread canvas as compatibleSurface so the wgpu GL backend can
  // enumerate adapters against it (escape hatch, capability-gated).
  const adapterResult = await pack.rhi.requestAdapter(undefined, canvas);
  if (!adapterResult.ok) {
    return { kind: 'rhi-err', error: adapterResult.error };
  }
  const adapter = adapterResult.value;
  // M4 w28: filter compression features from adapter.features (AC-07). The
  // same helper is used by recover() below so both paths share one profile.
  const deviceOpts = deviceOptionsForAdapter(adapter, options);
  const result = await adapter.requestDevice(deviceOpts);
  if (!result.ok) {
    return { kind: 'rhi-err', error: result.error };
  }
  const device: RhiDevice = result.value;

  // Acquire the canvas context through the backend pack (M3 / w16).
  // rhi-webgpu: internally calls canvas.getContext('webgpu') + branded wrap.
  // rhi-wgpu: internally calls wasm createSurface(canvas) + configure.
  // When context acquisition fails (null from canvas.getContext or wasm
  // createSurface throws), the pack returns Result.err(RhiError).
  const ctxResult = pack.rhi.acquireCanvasContext(canvas);
  if (!ctxResult.ok) {
    return { kind: 'rhi-err', error: ctxResult.error };
  }
  const context: RhiCanvasContext = ctxResult.value;

  const lostRegistry = new LostListenerRegistry();
  const errorRegistry = new RhiErrorListenerRegistry();
  const healthRegistry = new HealthListenerRegistry();
  const lossObserver: {
    current?: (detail: string) => void;
  } = {};
  const generationState: {
    current: number;
    onStaleLoss?: () => void;
  } = { current: 0 };
  // device.lost dual-track (research §F-4 / R2 countermeasure): the spec
  // Promise is passed through to the lost-fan-out registry (extracted to
  // attachDeviceLostFanout so the recover() rebuild path re-attaches the
  // SAME wiring to the freshly-minted device — SSOT, one fan-out shape).
  attachDeviceLostFanout(device, pack, {
    lostRegistry,
    errorRegistry,
    healthRegistry,
    generation: 0,
    currentGeneration: () => generationState.current,
    onStaleLoss: () => generationState.onStaleLoss?.(),
    onDeviceLost: (detail) => lossObserver.current?.(detail),
  });

  // D-VD2 Round 2 wire-up part 2: register the spec `onuncapturederror`
  // listener on the raw GPUDevice so GPUUncapturedErrorEvent (validation /
  // oom / internal) is translated to the 17-member RhiErrorCode union +
  // dispatched through the public Renderer event subscription. When the pack does not expose a
  // raw-device escape hatch (rhi-wgpu wasm path, custom escape hatch), the
  // listener registration is skipped — the device.lost dual-channel above
  // still fires through `RhiDevice.lost` Promise on every path (graceful
  // degradation per charter proposition 9; per-path coverage matrix in
  // packages/engine/README.md `## Error model`).
  if (pack._internal_getRawDevice && pack.translateErrorEventToRhiError) {
    const backendDevice = pack._internal_getRawDevice(device);
    if (backendDevice && typeof backendDevice === 'object') {
      const target = backendDevice as {
        onuncapturederror?: ((event: unknown) => void) | null;
      };
      // Spec form: `device.onuncapturederror = (event) => ...`. The listener
      // sets a property handler (spec normative GPUDevice extends EventTarget
      // and exposes `onuncapturederror` as a settable callback property);
      // engine writes through the property so each pre-existing handler that
      // an AI user assigned would be replaced (last-write-wins; spec lifetime
      // is device-scoped so engine ownership is OK — AI users observe via
      // the Renderer event subscription, not the raw property).
      target.onuncapturederror = (event: unknown): void => {
        const translated = pack.translateErrorEventToRhiError?.(event);
        if (translated && !translated.ok) {
          errorRegistry.fire(translated.error);
        }
      };
    }
  }
  return {
    kind: 'ok',
    renderer: await makeWebGPURenderer({
      canvas,
      device,
      context,
      options,
      bundler,
      lostRegistry,
      errorRegistry,
      healthRegistry,
      pack,
      importTransport,
      lossObserver,
      generationState,
    }),
  };
}

export interface WebGPURendererInternals {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  device: RhiDevice;
  // M6 / w41 (feat-20260510-rhi-resource-creation): forgeax RhiCanvasContext
  // brand; RenderSystem + ensureContextConfigured both go through the RHI
  // surface (charter proposition 5 consistent abstraction red line).
  context: RhiCanvasContext;
  options: RendererOptions | undefined;
  /**
   * feat-20260608-create-app-param-surface-trim / M2 / D-3: BundlerOptions
   * forwarded verbatim from createRenderer's third arg. Carries
   * shaderManifestUrl (host-injected vite-plugin-shader emit URL; absent =>
   * createRenderer falls back to '/shaders/manifest.json') and the
   * importTransport that previously rode a dedicated internal slot.
   */
  bundler: BundlerOptions | undefined;
  lostRegistry: LostListenerRegistry;
  errorRegistry: RhiErrorListenerRegistry;
  healthRegistry: HealthListenerRegistry;
  /** M3 D-P4 auto-select pack — carries the dynamic-imported rhi-webgpu / rhi-wgpu singleton + optional async shader factory. */
  pack: RhiBackendPack;
  /**
   * feat-20260604-hdr-equirect-cube-importer-loader M4 / w16 (D-3): the
   * dev-only ImportTransport, forwarded verbatim from createRenderer to the
   * AssetRegistry third ctor slot. `undefined` keeps the shipped form (DDC
   * miss fails fast with `asset-not-imported`, AC-08).
   */
  importTransport?: ImportTransport | undefined;
  /**
   * feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M2 / T-M2-05:
   * mesh-SSBO grow hook surfaced by `makeWebGPURenderer` after the controller
   * is constructed. Undefined before `makeWebGPURenderer` runs; populated by
   * the time the renderer is returned to the caller. M3's record stage reads
   * this field via the runtime path that bridges into render-system-record.ts
   * (the bridging plumbing is in M3's targetFiles).
   *
   * Returns `{ ok: true }` when the grow completed (or short-circuited
   * idempotently); `{ ok: false, code }` with a fired structured error
   * (`MeshSsboCeilingReachedError` or `MeshSsboCapacityExceededError`) when
   * the request cannot be satisfied. Never throws (D-5).
   */
  growMeshSsbo?: (neededSlots: number) => MeshSsboGrowResult;
  /**
   * feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M3 / T-M3-04:
   * read-only handle to the grow controller's state (slotCount + wrapper
   * refs), surfaced alongside `growMeshSsbo` so `ensureMeshSsboCapacity`
   * (record-stage wiring) can short-circuit when slotCount already covers the
   * frame's renderable count and so the dev-mode info log can report the
   * before/after slot count transition. Undefined until buildReadyWebGPU
   * has wired the controller; identity stable across grow events.
   */
  meshSsboState?: MeshSsboState;
  /** Host-owned producer features; created before device-bound assembly starts. */
  featureHost?: RenderFeatureHost;
  /** App-owned overlay capability read by the typed graph at frame time. */
  debugOverlay?: RenderDebugOverlay;
  /** Composed renderer utility sources installed atomically at build-ready. */
  volumetricFogShaders?: VolumetricFogShaderSources | undefined;
  gpuPassTimingSubmittedWork?: Promise<void> | undefined;
  lossObserver: { current?: (detail: string) => void };
  generationState: {
    current: number;
    onStaleLoss?: () => void;
  };
  recoveryColdWorkGuard?: RecoveryColdWorkGuard | undefined;
  getMaterialShaderUvSetCount?: (materialShaderId: string) => number | undefined;
}

export interface RecoveryFailureLocation {
  readonly phase: RecoveryPhase;
  readonly retryable: boolean;
  readonly guidance: RecoveryGuidance;
  readonly owner: string;
  readonly resourceKind: DeviceResourceKind;
  readonly cause: unknown;
}

function recoveryCauseCode(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const directCode = (cause as { readonly code?: unknown }).code;
  if (typeof directCode === 'string') return directCode;
  const detail = (cause as { readonly detail?: unknown }).detail;
  if (typeof detail !== 'object' || detail === null) return undefined;
  const detailCode = (detail as { readonly code?: unknown }).code;
  if (typeof detailCode === 'string') return detailCode;
  return recoveryCauseCode((detail as { readonly cause?: unknown }).cause);
}

function createRecoveryFailureLocation(
  phase: RecoveryPhase,
  cause: unknown,
  overrides: Partial<Omit<RecoveryFailureLocation, 'phase' | 'cause'>> = {},
): RecoveryFailureLocation {
  const code = recoveryCauseCode(cause) ?? '';
  const resourceKind: DeviceResourceKind = code.includes('shader')
    ? 'shader'
    : code.includes('buffer')
      ? 'buffer'
      : code.includes('texture')
        ? 'texture'
        : code.includes('binding')
          ? 'binding'
          : phase === 'rehydrate'
            ? 'shader'
            : phase === 'acquire-adapter' || phase === 'acquire-device'
              ? 'surface'
              : phase === 'publish' || phase === 'cleanup'
                ? 'surface'
                : 'pipeline';
  const owner =
    code.includes('shader') || phase === 'rehydrate'
      ? 'shader'
      : phase === 'acquire-adapter' || phase === 'acquire-device'
        ? 'backend'
        : phase === 'compile-graph'
          ? 'pipeline'
          : 'renderer';
  return {
    phase,
    retryable: false,
    guidance: 'repair-owner',
    owner,
    resourceKind,
    cause,
    ...overrides,
  };
}

async function makeWebGPURenderer(
  internals: WebGPURendererInternals,
): Promise<RendererAssemblyImplementation> {
  let disposed = false;
  const frameContinuations = new Set<ContinuationTerminator>();
  type RecoveryInspection = RenderInspection['recovery'];
  let recoveryAttempt = 0;
  let recoveryStaleLossEvents = 0;
  let recoveryInspection: RecoveryInspection = Object.freeze({
    phase: null,
    fromGeneration: 0,
    candidateGeneration: 0,
    attempt: 0,
    elapsedMs: 0,
    lastOutcome: 'none',
    rehydratedRoots: 0,
    staleLossEvents: 0,
  });
  const updateRecoveryInspection = (
    patch: Partial<RecoveryInspection>,
    clearFailureLocation = false,
  ): void => {
    const next = { ...recoveryInspection, ...patch, staleLossEvents: recoveryStaleLossEvents };
    if (clearFailureLocation) {
      delete next.failedOwner;
      delete next.failedResourceKind;
    }
    recoveryInspection = Object.freeze(next);
  };
  internals.generationState.onStaleLoss = () => {
    recoveryStaleLossEvents = Math.min(Number.MAX_SAFE_INTEGER, recoveryStaleLossEvents + 1);
    updateRecoveryInspection({});
  };
  internals.lossObserver.current = (detail) => {
    const code = detail.includes('destroyed') ? 'disposed' : 'device-lost';
    for (const continuation of frameContinuations) continuation.terminate({ code });
  };
  let renderTargetDevice = internals.device;
  let renderTargetGeneration = 0;
  let renderSystemForTargetPromotion: RenderSystem | undefined;
  const featureHostResult = createRenderFeatureHost(internals.options?.features ?? []);
  if (!featureHostResult.ok) throw featureHostResult.error;
  internals.featureHost = featureHostResult.value;
  let rendererRecovery: RendererRecovery | undefined;
  const recoveryFlight = createSingleFlight<Result<void, RecoverFailure>>(async () => {
    if (disposed) return err(new RecoverError('recover-not-needed'));
    if (internals.healthRegistry.getLastSnapshot().reason !== 'device-lost') {
      return err(new RecoverError('recover-not-needed'));
    }
    const attempt = ++recoveryAttempt;
    const deadline = createRecoveryDeadline(Date.now());
    const fromGeneration = activeDeviceScope.generation;
    const candidateGeneration = fromGeneration + 1;
    let recoveryFailurePhase: RecoveryPhase = 'quiesce';
    updateRecoveryInspection(
      {
        phase: 'quiesce',
        fromGeneration,
        candidateGeneration,
        attempt,
        elapsedMs: 0,
        lastOutcome: 'none',
        rehydratedRoots: 0,
      },
      true,
    );
    const setRecoveryPhase = (phase: RecoveryPhase): void => {
      if (phase !== 'cleanup') recoveryFailurePhase = phase;
      updateRecoveryInspection({ phase, elapsedMs: deadline.elapsed(Date.now()) });
    };
    let candidateCleanup = (): void => undefined;
    const continuation = createRecoveryContinuation(deadline, () => candidateCleanup());
    const deadlineExpired = (phase: RecoveryPhase): boolean => {
      if (continuation.isValid(phase, Date.now())) return false;
      continuation.abandon(Date.now());
      continuation.cleanupOnce();
      return true;
    };
    let recoveryFailureLocation: RecoveryFailureLocation | undefined;
    let result: Result<void, RecoverFailure>;
    try {
      const recovery = rendererRecovery;
      if (recovery === undefined) {
        return err(new RecoverError('recover-device-unavailable'));
      }
      result = await recovery.recoverOnce(
        deadline,
        deadlineExpired,
        (cleanup) => {
          candidateCleanup = cleanup;
        },
        continuation,
        setRecoveryPhase,
        (count) => updateRecoveryInspection({ rehydratedRoots: count }),
        (failure) => {
          recoveryFailureLocation = failure;
        },
      );
    } catch (cause) {
      recoveryFailureLocation ??= createRecoveryFailureLocation('compile-graph', cause);
      candidateCleanup();
      result = err(new RecoverError('recover-device-unavailable'));
    }
    if (result.ok) {
      updateRecoveryInspection(
        {
          phase: null,
          fromGeneration,
          candidateGeneration: activeDeviceScope.generation,
          elapsedMs: deadline.elapsed(Date.now()),
          lastOutcome: 'succeeded',
        },
        true,
      );
      return result;
    }
    if (result.error.code === 'recover-not-needed' && !disposed) {
      updateRecoveryInspection(
        { phase: null, elapsedMs: deadline.elapsed(Date.now()), lastOutcome: 'none' },
        true,
      );
      return result;
    }
    const outcome = disposed ? 'disposed' : 'failed';
    const failureLocation = outcome === 'disposed' ? undefined : recoveryFailureLocation;
    const failurePhase =
      outcome === 'disposed' ? 'cleanup' : (failureLocation?.phase ?? recoveryFailurePhase);
    const isAcquisitionPhase = (phase: RecoveryPhase): boolean =>
      phase === 'acquire-adapter' || phase === 'acquire-device';
    const retryable =
      outcome === 'failed' && (failureLocation?.retryable ?? isAcquisitionPhase(failurePhase));
    const failure = createRecoveryFailedError({
      phase: failurePhase,
      oldGeneration: fromGeneration,
      candidateGeneration,
      attempt,
      elapsedMs: deadline.elapsed(Date.now()),
      retryable,
      guidance:
        outcome === 'disposed'
          ? 'rebuild-renderer'
          : (failureLocation?.guidance ?? (retryable ? 'retry' : 'repair-owner')),
      owner: outcome === 'disposed' ? 'renderer' : (failureLocation?.owner ?? 'renderer'),
      resourceKind:
        outcome === 'disposed' ? 'surface' : (failureLocation?.resourceKind ?? 'pipeline'),
      lastOutcome: outcome,
      rehydratedRoots: recoveryInspection.rehydratedRoots,
      staleLossEvents: recoveryStaleLossEvents,
      cause: outcome === 'disposed' ? result.error : (failureLocation?.cause ?? result.error),
      cleanupFailures: [],
      receipt: activeDeviceScope._receipt(),
    });
    updateRecoveryInspection(
      {
        phase: null,
        elapsedMs: failure.detail.elapsedMs,
        lastOutcome: outcome,
        rehydratedRoots: 0,
      },
      false,
    );
    return err(failure);
  });
  // Keep producer-declared shader identities live across the renderer
  // lifetime. Features can be installed after boot (the public late-install
  // seam used by asset-driven hosts), so a recovery rebuild must include their
  // modules in the same prewarm set as boot. A boot-only snapshot would let the
  // first recovered frame observe a cold async shader adapter and emit a
  // spurious prepared-pipeline failure before the next-frame retry succeeds.
  const requiredMaterialShaderSet = new Set(
    featureHostResult.value.features.flatMap((feature) => feature.requiredMaterialShaders ?? []),
  );
  let requiredMaterialShaders = Object.freeze([...requiredMaterialShaderSet]);
  const collectRequiredFullscreenPostProcesses = (
    features: readonly RenderFeature<unknown>[],
  ): readonly { readonly identity: string; readonly source: string }[] => {
    const entries = new Map<string, { readonly identity: string; readonly source: string }>();
    for (const feature of features) {
      for (const entry of feature.requiredFullscreenPostProcesses ?? []) {
        const existing = entries.get(entry.identity);
        if (existing !== undefined && existing.source !== entry.source) {
          throw new RhiError({
            code: 'internal-error',
            expected: `fullscreen identity '${entry.identity}' has one source across render features`,
            hint: 'rename the conflicting fullscreen identity or make its WGSL source identical',
          });
        }
        entries.set(entry.identity, entry);
      }
    }
    return Object.freeze([...entries.values()]);
  };
  let requiredFullscreenPostProcesses = collectRequiredFullscreenPostProcesses(
    featureHostResult.value.features,
  );
  // Lazy ShaderCatalog instance (plan-strategy section S-10 / D-R10 / OQ-5
  // close): constructed on first access; subsequent accesses return the
  // same instance. Recovery owns a second, candidate-only state object while
  // the active state continues serving frames. The two states are swapped
  // only by the synchronous generation publication boundary below; no
  // recovery await can expose a partially rebuilt adapter or catalog.
  type RendererShaderState = {
    readonly device: RhiDevice;
    shaderInstance: ShaderCatalog | null;
    sharedShaderModuleAdapter: ShaderDeviceAdapterInternal | null;
    sharedImmediateShaderModuleAdapter: ShaderDeviceAdapterInternal | null;
  };
  let activeShaderState: RendererShaderState = {
    device: internals.device,
    shaderInstance: null,
    sharedShaderModuleAdapter: null,
    sharedImmediateShaderModuleAdapter: null,
  };
  let candidateShaderState: RendererShaderState | undefined;
  const getShaderModuleAdapter = (): ShaderDeviceAdapterInternal => {
    const state = candidateShaderState ?? activeShaderState;
    if (state.sharedShaderModuleAdapter === null) {
      state.sharedShaderModuleAdapter = makeShaderDeviceAdapter(
        state.device,
        internals.errorRegistry,
        internals.pack.createShaderModule,
        internals.pack.createShaderModuleImmediate,
      );
    }
    return state.sharedShaderModuleAdapter;
  };
  const getImmediateShaderModuleAdapter = (): ShaderDeviceAdapterInternal => {
    const state = candidateShaderState ?? activeShaderState;
    if (state.sharedImmediateShaderModuleAdapter === null) {
      state.sharedImmediateShaderModuleAdapter = makeShaderDeviceAdapter(
        state.device,
        internals.errorRegistry,
        internals.pack.createShaderModule,
        internals.pack.createShaderModuleImmediate,
        'immediate',
      );
    }
    return state.sharedImmediateShaderModuleAdapter;
  };
  const prewarmFullscreenFeatureModules = async (
    feature: RenderFeature<unknown>,
  ): Promise<Result<void, RhiError>> => {
    for (const postProcess of feature.requiredFullscreenPostProcesses ?? []) {
      const label = postProcessShaderModuleLabel(postProcess.identity, postProcess.source);
      const shaderResult = internals.pack.createShaderModule
        ? await internals.pack.createShaderModule(internals.device, {
            code: postProcess.source,
            label,
          })
        : await invokeDeviceCreateShaderModule(internals.device, {
            code: postProcess.source,
            label,
          });
      if (!shaderResult.ok) {
        internals.errorRegistry.fire(shaderResult.error);
        return err(shaderResult.error);
      }
      getShaderModuleAdapter().seedModule(label, shaderResult.value);
    }
    return ok(undefined);
  };
  const getShader = (): ShaderCatalog => {
    const state = candidateShaderState ?? activeShaderState;
    if (state.shaderInstance === null) {
      // feat-20260608-create-app-param-surface-trim / M2 / D-2 q5-A:
      // shaderManifestUrl moved to BundlerOptions (third arg). The fallback
      // literal '/shaders/manifest.json' stays here so the LO 1.1
      // hello-window zero-config takeoff path keeps working without an
      // bundler injection. The 'shaderManifestUrl' in (...) check preserves
      // the zero-entry opt-in: explicitly passing
      // `bundler: { shaderManifestUrl: undefined }` retains the
      // old "no manifest fetched" mode used by tests / camera-only worlds.
      const bundler = internals.bundler;
      const explicitUrl = bundler?.shaderManifestUrl;
      state.shaderInstance = new ShaderCatalog({
        device: getShaderModuleAdapter(),
        manifestUrl:
          bundler !== undefined && 'shaderManifestUrl' in bundler
            ? explicitUrl
            : '/shaders/manifest.json',
      });
    }
    return state.shaderInstance;
  };
  // D-S9: AssetRegistry instance shared with RenderSystem. RenderSystem
  // looks up MeshFilter.assetHandle here per frame; buildReadyWebGPU step 3
  // uploads the registry's builtin mesh geometry to GPU buffers so the
  // RenderSystem can route MeshFilter.assetHandle to a real (vbo, ibo) pair.
  //
  // feat-20260527 M1 / w1: ShaderCatalog is now eager-constructed and
  // constructor-injected into AssetRegistry (plan-strategy D-1). The
  // ShaderCatalogDevice adapter (shared between the catalog and per-MaterialShader
  // pipeline cache) is already available at this point.
  const shaderCatalog = getShader();

  // feat-20260528-material-shader-registration-unification M3 / w14:
  // placeholder hardcoded installMaterialArtifact calls deleted.
  //
  // bug-20260601-hello-tonemap-material-register M1 (plan-strategy D-1):
  // All material-shader entries are now registered from the manifest
  // BEFORE the renderer is returned, so `register<MaterialAsset>` referencing
  // an engine shader succeeds without waiting for `renderer.initialization`.

  // feat-20260623-asset-payload-generic-open-registry M3 / w10: host apps
  // that need custom loaders register them on `assets.loaders.register(...)`.
  // feat-20260604-hdr-equirect-cube-importer-loader M4 / w16 (D-3 / AC-05):
  // the host-injected ImportTransport (or undefined for the shipped form) is
  // threaded into the AssetRegistry ctor -- the construction-time-
  // only single injection point (no setter, no illegal intermediate state).
  // feat-20260705-runtime-tier2-decomposition M1 / w10 (D-1 / D-2): the sole
  // production assembly point injects (a) the post-spawn hook
  // `postSpawnResolveJoints` (auto-wire Skin.joints; D-1) and the audio
  // catalog-entry loader. The latter stays at this assembly boundary so
  // assets-runtime remains independent of the concrete Web Audio backend.
  // videoLoader is wired internally from graphics-extras; the full registry has
  // 11 engine kinds. This is the only `new AssetRegistry(...)` call in the repo.
  const assets = new AssetRegistry(
    shaderCatalog,
    internals.importTransport,
    [audioLoader],
    postSpawnResolveJoints,
  );
  // feat-20260601-device/gpu-residency-extraction M1: the GPU residency layer
  // lives in a standalone store; `assets` keeps the CPU POD registry only.
  let gpuStore = new GpuResidencyCache();
  let activeDeviceScope = DeviceScope.create(0, 'renderer');
  // feat-20260623-world-space-video-asset M4 / w16 (D-3): transient per-frame
  // video texture store, fully independent of gpuStore (AC-08). Configured with
  // the device alongside gpuStore below; threaded into the record stage via the
  // RenderSystemRuntime so a `videoTextureFields` material field uploads its
  // frame here instead of entering the static ensureResident cache.
  let dynamicTextureStore = new DynamicTextureStore();
  const renderTargetHost = createRenderTargetHost({
    rendererId: Symbol('renderer'),
    getGeneration: () => renderTargetGeneration,
    getDevice: () => renderTargetDevice,
    canPromoteTarget: (target: RenderTarget) =>
      renderSystemForTargetPromotion?.isCubeCapturePending(target) !== true,
  });
  // feat-20260527-sprite-nineslice M4 / w16 (D-5): detached host-owned
  // EngineMetrics counter, threaded to the record
  // stage via `RenderSystemRuntime.metrics` so soft-warns
  // (`nineslice.scale-too-small`, `nineslice.tile-needs-repeat-sampler`) bump
  // counters through the owning service (charter P3 machine-readable signals
  // over a per-frame console.warn flood). Each renderer assembly owns its own
  // counter Map (D-5 candidate 1 isolation); Renderer does not expose it.
  const metrics = createEngineMetrics();
  let extendedLightingState = createExtendedLightingState(activeDeviceScope.generation);
  const gpuPassTimingOptions = internals.options?.gpuPassTiming;
  const timingRetentionFrames =
    gpuPassTimingOptions?.retentionFrames !== undefined &&
    Number.isInteger(gpuPassTimingOptions.retentionFrames) &&
    gpuPassTimingOptions.retentionFrames >= 1 &&
    gpuPassTimingOptions.retentionFrames <= 8
      ? gpuPassTimingOptions.retentionFrames
      : DEFAULT_GPU_PASS_TIMING_OPTIONS.retentionFrames;
  let gpuPassTimingSession: GpuPassTimingSession | undefined;
  let gpuPassTimingUnavailable: GpuPassTimingObservation | undefined;
  const timingObservationStore =
    gpuPassTimingOptions === undefined
      ? undefined
      : createGpuPassTimingObservationStore({
          retentionFrames: timingRetentionFrames,
          currentDeviceGeneration: () => activeDeviceScope.generation,
        });
  const retireGpuPassTimingSession = (): void => {
    const retired = gpuPassTimingSession;
    gpuPassTimingSession = undefined;
    retired?.dispose();
  };
  const failedGpuPassTimingObservation = (error: GpuPassTimingReason): GpuPassTimingObservation => {
    const latestKnownGood = timingObservationStore?.inspect().latestKnownGood;
    return {
      status: 'failed',
      error,
      ...(latestKnownGood === undefined ? {} : { latestKnownGood }),
    };
  };
  const establishGpuPassTimingSession = (): void => {
    retireGpuPassTimingSession();
    gpuPassTimingUnavailable = undefined;
    if (gpuPassTimingOptions === undefined) return;
    const created = createGpuPassTimingSession(internals.device, gpuPassTimingOptions);
    if (created.ok) {
      gpuPassTimingSession = created.value;
      return;
    }
    gpuPassTimingUnavailable = {
      status: 'unavailable',
      reason: created.error,
      capability: {
        timestampQuery: internals.device.caps.timestampQuery,
        timestampPeriodNanoseconds: internals.device.caps.timestampPeriodNanoseconds,
      },
    };
  };
  establishGpuPassTimingSession();
  // feat-20260629 M4: per-material-shader UV set count from naga vertex
  // @location reflection. Populated during prepareMaterialShaders from
  // MaterialShaderManifestEntry.uvSetCount. Read by getMaterialShaderPipeline
  // to auto-fill shaderUvSetCount for clamp-to-last alias.
  let materialShaderUvSetCounts = new Map<string, number>();
  // feat-20260527-sprite-nineslice M4 / w18 prep (D-9): hand the same
  // EngineMetrics instance to AssetRegistry so register-time soft-warns
  // (sliceMode=1 + sampler.addressMode !== 'repeat') bump
  // 'nineslice.tile-needs-repeat-sampler' on the SAME counter the runtime
  // reads.
  assets.setMetrics(metrics);
  // feat-20260707 M5 / w33 (D-11 + D-8): project the RhiCaps three-way
  // compression triple into the codec-facing `TranscodeCaps` and wire it into
  // the registry so the texture / equirect Basis arms can pick a transcode
  // target. One-line projection; the loader stays a pure consumer of the
  // declared ctx input (Pipeline Isolation).
  assets.setTranscodeCaps({
    bc: internals.device.caps.textureCompressionBc,
    etc2: internals.device.caps.textureCompressionEtc2,
    astc: internals.device.caps.textureCompressionAstc,
  });

  // M1 (bug-20260601-hello-tonemap-material-register D-1/D-2): prepare
  // engine-shipped material shaders (cap gate + manifest load + registration)
  // so they are available in ShaderCatalog before `register<MaterialAsset>`.
  // Failures throw structured RhiError / ShaderError through `createRenderer`.
  await prepareMaterialShaders(internals.device, getShader, assets, materialShaderUvSetCounts);
  // MaterialAsset per-slot texCoord: the built-in standard PBR + skin shaders
  // unconditionally declare all eight supported UV sets so they can honor
  // per-slot coordinate selection. Their vertex layout must therefore always
  // carry the declared UV slots or CreateRenderPipeline rejects the module.
  // in VertexState"). `materialShaderUvSetCounts` is the SSOT both PSO paths read
  // (buildPipelineContext + getMaterialShaderPipeline) to drive the clamp-to-last
  // alias; naga reflection can be stale for engine-shipped modules, so the
  // count is asserted explicitly. Missing mesh sets are clamp-to-last aliases.
  materialShaderUvSetCounts.set('forgeax::default-standard-pbr', 8);
  materialShaderUvSetCounts.set(SKIN_MATERIAL_SHADER_ID, 8);
  // M5 wiring (feat-20260517-vite-plugin-image-build-time-cook w14b): hand
  // the RhiDevice to the AssetRegistry so `loadByGuid<TextureAsset>` ->
  // `loadTextureFromEntry` -> `uploadTexture` actually runs the GPU
  // upload step plan-strategy section 3.2 sequence specifies. Without
  // this call uploadTexture step 3 short-circuits with `Result.ok(undefined)`
  // and the render-system materialBindGroup falls through to the 1x1
  // white fallback view (charter P3 violation: silent loss of texture).
  // bug-20260518 D-1: configureGpuDevice gains a 2nd parameter --
  // `pack.createShaderModule`, the top-level async shader-module factory
  // (rhi-webgpu / rhi-wgpu both expose it). The runtime mipmap utility uses
  // this factory inside `generateMipmaps` instead of the (now-deleted)
  // synchronous `device.createShaderModule` member. The parameter is
  // structurally optional at this call-site so the explicit-rhi escape
  // hatch (D-R5) without a top-level factory still routes through the
  // existing `invokeDeviceCreateShaderModule` fallback in
  // buildReadyWebGPU; AssetRegistry.uploadTexture's mipmap branch surfaces
  // the missing-factory case as a structured `rhi-not-available` error
  // (charter P3 explicit failure) rather than throwing here.
  //
  const packShaderFactory = adaptMipmapShaderModuleFactory(internals.pack.createShaderModule);
  // The RhiDevice surface satisfies `MipmapBlitDevice` (createTexture +
  // createTextureView + createCommandEncoder + createBindGroup +
  // queue.submit + queue.writeTexture all live on RhiDevice).
  // feat-20260601-device/gpu-residency-extraction M1 (D-3 / D-8): device +
  // shader-module factory + cube-POD register relay are wired onto the store
  // together. feat-20260614 M8 (D-15 / D-17): `registerCube` is the wire-layer
  // closure `(world, pod) => world.allocSharedRef('EquirectAsset', pod)` --
  // the runtime-minted cube POD lands in the draw-time world's user-tier
  // SharedRefStore (the AssetRegistry owns no handles). feat-20260630 M2 / w11:
  // the retired cube-texture asset kind is gone; the relay mints an EquirectAsset
  // shared ref as the cubemap GPU residency's identity token.
  gpuStore.configureGpuDevice(
    internals.device,
    packShaderFactory,
    (world, pod) => {
      const handle = world.allocSharedRef('EquirectAsset', pod);
      return ok(handle);
    },
    internals.device.caps,
  );
  gpuStore.configureIblDevice(
    internals.device,
    internals.pack.createShaderModule === undefined
      ? undefined
      : (
          (createShaderModule) => (device, descriptor) =>
            createShaderModule(device, descriptor)
        )(internals.pack.createShaderModule),
  );
  gpuStore.bindDeviceScope(activeDeviceScope);
  // feat-20260623-world-space-video-asset M4 / w16 (D-3): wire the same device
  // into the transient video texture store (createTexture / createTextureView /
  // destroyTexture / queue.copyExternalImageToTexture all live on RhiDevice).
  dynamicTextureStore.configureGpuDevice(adaptDynamicTextureDevice(internals.device));
  // D-S3: Renderer.initialization three-step strict-serial Promise. Kicked off
  // synchronously here so `await renderer.initialization` is the AI-user-facing
  // barrier; failure is structured and goes through Promise reject (no
  // throw, no silent skip — charter proposition 4 explicit failure).
  let pipelineState: PipelineState | null = null;
  type RendererGeneration = GenerationAggregate<
    RhiDevice,
    RhiCanvasContext,
    PipelineState,
    RendererGenerationBindings,
    undefined
  >;
  const generationPublication: GenerationPublication<RendererGeneration | undefined> = {
    current: undefined,
  };
  const publishRendererGeneration = (candidate: RendererGeneration): void => {
    publishGeneration(generationPublication, candidate, (value) => value.scope.isAlive());
    activeDeviceScope = candidate.scope;
    dynamicGeometry.invalidateGeneration(activeDeviceScope.generation);
    internals.generationState.current = activeDeviceScope.generation;
    pipelineState = candidate.pipeline;
    const bindings = candidate.producerBindings;
    gpuStore = bindings.gpuStore;
    dynamicTextureStore = bindings.dynamicTextureStore;
    activeShaderState = bindings.shaderState;
    activePipelineCacheState = bindings.pipelineCacheState;
    materialShaderUvSetCounts = bindings.materialShaderUvSetCounts;
    emptyPostProcessBgl = bindings.emptyPostProcessBgl;
    if (bindings.growMeshSsbo === undefined) delete internals.growMeshSsbo;
    else internals.growMeshSsbo = bindings.growMeshSsbo;
    if (bindings.meshSsboState === undefined) delete internals.meshSsboState;
    else internals.meshSsboState = bindings.meshSsboState;
    gpuStore.bindDeviceScope(activeDeviceScope);
  };
  let readySettled = false;
  // w24 — Renderer.initialization returns Promise<Result<void, RhiError>>: resolve
  // ok(undefined) on success / resolve err(RhiError) on failure. The legacy
  // reject path is converted by a `.then() / .catch()` wrap so the inner
  // factory (`buildReadyWebGPU`) keeps its reject-on-error shape (research
  // F-3 internal contract preserved) while the public surface settles
  // strictly resolve-only (charter proposition 4 explicit failure - AI
  // users branch on `.ok` instead of try/catch).
  // feat-20260523-shader-template-instance-split M9-T03 (D-PipelineBuilder):
  // per-MaterialShader pipeline cache (LDR + HDR variants keyed by
  // `${materialShaderId}:${ldr|hdr}`). Map is owned by the renderer (lifetime
  // = Renderer) so cache hits persist across draw calls but reset between
  // renderers. Map.get / .set are sync; the underlying shader-module compile
  // is async-cached inside `makeShaderDeviceAdapter` (1-frame warmup -- first
  // miss returns Result.err('rhi-not-available'); after the async build
  // resolves the adapter caches the module, the next miss-then-build returns
  // Ok and lands in this Map).
  //
  // M6 fix-up: declared BEFORE `buildReadyWebGPU` so the boot-time SPEC_CONST
  // prewarm step inside that promise can seed URP-variant entries directly
  // (the seeding closure captures this Map by reference; ordering is safe
  // because the prewarm step runs strictly before the first frame's
  // `getMaterialShaderPipeline` lookup that would consume it).
  const materialShaderPipelineCache = new Map<string, RenderPipeline>();
  const materialShaderPipelineGroup2Contracts = new WeakMap<object, PipelineGroup2Contract>();
  const materialShaderManifestEntryCache = new Map<string, MaterialShaderManifestEntry>();
  // Variant resolution only depends on the requested axes, device capability
  // axes, and the manifest entry that owns the declarations. Cache it by the
  // manifest's variants-array identity so hot replacement naturally gets a
  // fresh result without adding a global strong reference to shader metadata.
  const materialShaderVariantResolutionCache = new WeakMap<
    object,
    Map<string, string | undefined>
  >();
  const group0MaterialLayout: {
    materialBgl: BindGroupLayout;
    pipelineLayout: PipelineLayout;
  } | null = null;
  const viewOnlyMaterialPipelineLayout: PipelineLayout | null = null;
  const viewAndSceneDepthMaterialPipelineLayout: PipelineLayout | null = null;
  const group0ResourceLayouts = new Map<
    string,
    { materialBgl: BindGroupLayout; pipelineLayout: PipelineLayout }
  >();
  const preparedMaterialPipelineLayoutCache = new Map<string, PipelineLayout>();
  // feat-20260621-learn-render-5-5-parallax M2 / w6 (D-1): per-shader material
  // BGL + pipeline layout cache. Every authored material shader owns the
  // user-region binding order emitted by its paramSchema, plus the shared
  // engine-injection suffix. A custom shader with four-or-fewer textures can
  // still differ from the standard PBR order (for example, baseColorTexture
  // followed directly by normalTexture), so it cannot safely reuse the
  // standard material BGL. Built lazily on first request and cached by
  // shaderId; built-in shader IDs continue to use the boot-time shared layout.
  type PerShaderMaterialLayout = {
    materialBgl: BindGroupLayout;
    pipelineLayout: PipelineLayout;
  };
  type PerShaderMaterialLayoutCacheEntry = {
    readonly source: string;
    readonly paramSchema: readonly ParamSchemaEntry[];
    readonly layoutKind: LayoutKind;
    readonly layout: PerShaderMaterialLayout | null;
  };
  const perShaderMaterialLayoutCache = new Map<string, PerShaderMaterialLayoutCacheEntry>();
  const isEngineOwnedMaterialShader = (materialShaderId: string): boolean =>
    materialShaderId === 'forgeax::default-unlit' ||
    materialShaderId === 'forgeax::default-shadow-caster' ||
    materialShaderId === 'forgeax::sprite' ||
    materialShaderId === 'forgeax::sprite-lit' ||
    materialShaderId === 'forgeax::default-sprite' ||
    materialShaderId === 'forgeax::msdf-text' ||
    materialShaderId === 'forgeax::default-standard-pbr' ||
    materialShaderId === 'forgeax::pbr-skin' ||
    materialShaderId === 'forgeax::default-standard-pbr-skin';
  // Material binding contracts are derived from WGSL source, but the lookup
  // is also used by the per-submesh bind-group path. Cache the derived value
  // per renderer so a frame does not re-run the comment stripping and regex
  // scan for every visible submesh. Keep the source alongside the result so
  // shader hot-replacement invalidates the entry naturally.
  const materialShaderBindingContractCache = new Map<
    string,
    { source: string; contract: MaterialShaderBindingContract }
  >();
  type RendererPipelineCacheState = {
    materialShaderPipelineCache: typeof materialShaderPipelineCache;
    materialShaderManifestEntryCache: typeof materialShaderManifestEntryCache;
    materialShaderVariantResolutionCache: typeof materialShaderVariantResolutionCache;
    group0MaterialLayout: {
      materialBgl: BindGroupLayout;
      pipelineLayout: PipelineLayout;
    } | null;
    viewOnlyMaterialPipelineLayout: PipelineLayout | null;
    viewAndSceneDepthMaterialPipelineLayout: PipelineLayout | null;
    group0ResourceLayouts: typeof group0ResourceLayouts;
    preparedMaterialPipelineLayoutCache: typeof preparedMaterialPipelineLayoutCache;
    perShaderMaterialLayoutCache: typeof perShaderMaterialLayoutCache;
    materialShaderBindingContractCache: typeof materialShaderBindingContractCache;
  };
  const createRendererPipelineCacheState = (): RendererPipelineCacheState => ({
    materialShaderPipelineCache: new Map(),
    materialShaderManifestEntryCache: new Map(),
    materialShaderVariantResolutionCache: new WeakMap(),
    group0MaterialLayout: null,
    viewOnlyMaterialPipelineLayout: null,
    viewAndSceneDepthMaterialPipelineLayout: null,
    group0ResourceLayouts: new Map(),
    preparedMaterialPipelineLayoutCache: new Map(),
    perShaderMaterialLayoutCache: new Map(),
    materialShaderBindingContractCache: new Map(),
  });
  let activePipelineCacheState: RendererPipelineCacheState = {
    materialShaderPipelineCache,
    materialShaderManifestEntryCache,
    materialShaderVariantResolutionCache,
    group0MaterialLayout,
    viewOnlyMaterialPipelineLayout,
    viewAndSceneDepthMaterialPipelineLayout,
    group0ResourceLayouts,
    preparedMaterialPipelineLayoutCache,
    perShaderMaterialLayoutCache,
    materialShaderBindingContractCache,
  };
  let candidatePipelineCacheState: RendererPipelineCacheState | undefined;
  let candidateMaterialShaderUvSetCounts: Map<string, number> | undefined;
  let emptyPostProcessBgl: BindGroupLayout | null = null;
  let candidateEmptyPostProcessBgl: BindGroupLayout | null | undefined;
  type RendererCandidateState = {
    readonly device: RhiDevice;
    readonly context: RhiCanvasContext;
    readonly scope: DeviceScope;
    readonly gpuStore: GpuResidencyCache;
    readonly dynamicTextureStore: DynamicTextureStore;
    readonly shaderState: RendererShaderState;
    readonly pipelineCacheState: RendererPipelineCacheState;
    readonly materialShaderUvSetCounts: Map<string, number>;
    pipelineState: PipelineState | null;
    emptyPostProcessBgl: BindGroupLayout | null;
    growMeshSsbo: ((neededSlots: number) => MeshSsboGrowResult) | undefined;
    meshSsboState: MeshSsboState | undefined;
  };
  type RendererGenerationBindings = {
    readonly gpuStore: GpuResidencyCache;
    readonly dynamicTextureStore: DynamicTextureStore;
    readonly shaderState: RendererShaderState;
    readonly pipelineCacheState: RendererPipelineCacheState;
    readonly materialShaderUvSetCounts: Map<string, number>;
    readonly emptyPostProcessBgl: BindGroupLayout | null;
    readonly growMeshSsbo: ((neededSlots: number) => MeshSsboGrowResult) | undefined;
    readonly meshSsboState: MeshSsboState | undefined;
  };
  let candidateBuildState: RendererCandidateState | undefined;
  const currentPipelineCacheState = (): RendererPipelineCacheState =>
    candidatePipelineCacheState ?? activePipelineCacheState;
  const currentPipelineState = (): PipelineState | null =>
    candidateBuildState === undefined ? pipelineState : candidateBuildState.pipelineState;
  const currentBuildDevice = (): RhiDevice => candidateBuildState?.device ?? internals.device;
  const currentMaterialShaderUvSetCounts = (): Map<string, number> =>
    candidateMaterialShaderUvSetCounts ?? materialShaderUvSetCounts;
  const currentEmptyPostProcessBgl = (): BindGroupLayout | null =>
    candidateEmptyPostProcessBgl === undefined ? emptyPostProcessBgl : candidateEmptyPostProcessBgl;
  const getCachedMaterialShaderBindingContract = (
    materialShaderId: string,
  ): MaterialShaderBindingContract => {
    const cacheState = currentPipelineCacheState();
    const lookup = getShader().findMaterialArtifact(materialShaderId);
    if (!lookup.ok) return 'render-material';
    const cached = cacheState.materialShaderBindingContractCache.get(materialShaderId);
    if (cached?.source === lookup.value.source) return cached.contract;
    const contract = resolveMaterialShaderBindingContract(lookup.value.source);
    cacheState.materialShaderBindingContractCache.set(materialShaderId, {
      source: lookup.value.source,
      contract,
    });
    return contract;
  };
  const getOrBuildGroup0MaterialLayout = (): {
    materialBgl: BindGroupLayout;
    pipelineLayout: PipelineLayout;
  } | null => {
    const cacheState = currentPipelineCacheState();
    if (cacheState.group0MaterialLayout !== null) return cacheState.group0MaterialLayout;
    if (currentPipelineState() === null) return null;
    const bglRes = currentBuildDevice().createBindGroupLayout({ entries: [] });
    if (!bglRes.ok) {
      internals.errorRegistry.fire(bglRes.error);
      return null;
    }
    const plRes = currentBuildDevice().createPipelineLayout({
      label: 'material-group-0-pipeline-layout',
      bindGroupLayouts: [bglRes.value],
    });
    if (!plRes.ok) {
      internals.errorRegistry.fire(plRes.error);
      return null;
    }
    cacheState.group0MaterialLayout = { materialBgl: bglRes.value, pipelineLayout: plRes.value };
    return cacheState.group0MaterialLayout;
  };
  const getOrBuildViewOnlyMaterialPipelineLayout = (): PipelineLayout | null => {
    const cacheState = currentPipelineCacheState();
    if (cacheState.viewOnlyMaterialPipelineLayout !== null) {
      return cacheState.viewOnlyMaterialPipelineLayout;
    }
    const currentState = currentPipelineState();
    if (currentState === null) return null;
    const plRes = currentBuildDevice().createPipelineLayout({
      label: 'material-view-only-pipeline-layout',
      bindGroupLayouts: [currentState.viewBindGroupLayout],
    });
    if (!plRes.ok) {
      internals.errorRegistry.fire(plRes.error);
      return null;
    }
    cacheState.viewOnlyMaterialPipelineLayout = plRes.value;
    return cacheState.viewOnlyMaterialPipelineLayout;
  };
  const getOrBuildViewAndSceneDepthMaterialPipelineLayout = (): PipelineLayout | null => {
    const cacheState = currentPipelineCacheState();
    if (cacheState.viewAndSceneDepthMaterialPipelineLayout !== null) {
      return cacheState.viewAndSceneDepthMaterialPipelineLayout;
    }
    const bglRes = currentBuildDevice().createBindGroupLayout({
      label: 'material-view-scene-depth-bgl',
      entries: [
        {
          binding: 0,
          visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          texture: { sampleType: 'depth', viewDimension: '2d', multisampled: false },
        },
      ],
    });
    if (!bglRes.ok) {
      internals.errorRegistry.fire(bglRes.error);
      return null;
    }
    const plRes = currentBuildDevice().createPipelineLayout({
      label: 'material-view-scene-depth-pipeline-layout',
      bindGroupLayouts: [bglRes.value],
    });
    if (!plRes.ok) {
      internals.errorRegistry.fire(plRes.error);
      return null;
    }
    cacheState.viewAndSceneDepthMaterialPipelineLayout = plRes.value;
    return cacheState.viewAndSceneDepthMaterialPipelineLayout;
  };
  const getOrBuildGroup0ResourceLayout = (
    materialShaderId: string,
  ): { materialBgl: BindGroupLayout; pipelineLayout: PipelineLayout } | null => {
    const cacheState = currentPipelineCacheState();
    const cached = cacheState.group0ResourceLayouts.get(materialShaderId);
    if (cached !== undefined) return cached;
    const lookup = getShader().findMaterialArtifact(materialShaderId);
    if (
      !lookup.ok ||
      !/@group\s*\(\s*0\s*\)\s*@binding\s*\(\s*0\s*\)[^;]*texture_depth_2d/u.test(
        lookup.value.source,
      )
    ) {
      return null;
    }
    const bgl = currentBuildDevice().createBindGroupLayout({
      label: `material-group-0-resource-${materialShaderId}`,
      entries: [
        {
          binding: 0,
          visibility: 2,
          texture: { sampleType: 'depth', viewDimension: '2d', multisampled: false },
        },
      ],
    });
    if (!bgl.ok) return null;
    const pipelineLayout = currentBuildDevice().createPipelineLayout({
      label: `material-group-0-resource-pl-${materialShaderId}`,
      bindGroupLayouts: [bgl.value],
    });
    if (!pipelineLayout.ok) return null;
    const built = { materialBgl: bgl.value, pipelineLayout: pipelineLayout.value };
    cacheState.group0ResourceLayouts.set(materialShaderId, built);
    return built;
  };
  const getOrBuildPreparedMaterialPipelineLayout = (
    materialShaderId: string,
  ): PipelineLayout | null => {
    const cacheState = currentPipelineCacheState();
    const cached = cacheState.preparedMaterialPipelineLayoutCache.get(materialShaderId);
    if (cached !== undefined) return cached;
    const currentState = currentPipelineState();
    if (currentState === null) return null;
    const materialBgl =
      (isEngineOwnedMaterialShader(materialShaderId)
        ? undefined
        : getOrBuildPerShaderMaterialLayout(materialShaderId)?.materialBgl) ??
      currentState.materialBindGroupLayout;
    const result = currentBuildDevice().createPipelineLayout({
      label: `prepared-material-pl-${materialShaderId}`,
      bindGroupLayouts: [currentState.viewBindGroupLayout, materialBgl],
    });
    if (!result.ok) {
      internals.errorRegistry.fire(result.error);
      return null;
    }
    cacheState.preparedMaterialPipelineLayoutCache.set(materialShaderId, result.value);
    return result.value;
  };
  const getOrBuildPerShaderMaterialLayout = (
    materialShaderId: string,
    explicitParamSchema?: readonly ParamSchemaEntry[],
    layoutKind: LayoutKind = 'pbr',
  ): PerShaderMaterialLayout | null => {
    const cacheState = currentPipelineCacheState();
    const currentState = currentPipelineState();
    if (currentState === null) return null;
    if (isEngineOwnedMaterialShader(materialShaderId)) return null;
    const lookup = getShader().findMaterialArtifact(materialShaderId);
    const source = lookup.ok ? lookup.value.source : '';
    const paramSchema = lookup.ok ? lookup.value.paramSchema : explicitParamSchema;
    if (paramSchema === undefined) return null;
    const cached = cacheState.perShaderMaterialLayoutCache.get(materialShaderId);
    if (
      cached?.source === source &&
      cached.paramSchema === paramSchema &&
      cached.layoutKind === layoutKind
    ) {
      return cached.layout;
    }
    // A custom schema may reuse the shared PBR layout only when every derived
    // binding is an identical canonical prefix. Otherwise build its own layout
    // so texture dimensions and sampler/storage shapes cannot drift.
    const requiresStandardMapLayout =
      isCanonicalStandardPbrMaterialShader(materialShaderId) ||
      isStandardPbrMaterialShader(materialShaderId) ||
      standardPhysicalTextureFields(paramSchema).length > 0;
    const isStandardMapLayout = requiresStandardMapLayout;
    if (!isStandardMapLayout && isSharedMaterialUserRegionCompatible(paramSchema)) {
      cacheState.perShaderMaterialLayoutCache.set(materialShaderId, {
        source,
        paramSchema,
        layoutKind,
        layout: null,
      });
      return null;
    }
    const spec: PipelineSpec = {
      shader: { id: materialShaderId, passKind: 'forward', variantSet: undefined },
      attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
      geometry: { topology: 'triangle-list', vertexLayout: {} },
      renderState: undefined,
    };
    const desc = buildBindGroupLayoutDescriptor(spec, {
      kind: 'pbr-material-merged',
      materialParamSchema: paramSchema,
    });
    const bglRes = currentBuildDevice().createBindGroupLayout(desc);
    if (!bglRes.ok) {
      internals.errorRegistry.fire(bglRes.error);
      return null;
    }
    const meshLayout =
      layoutKind === 'pbr-skin'
        ? currentState.pbrSkinMeshBindGroupLayout
        : layoutKind === 'hdrp-skin'
          ? currentState.hdrpSkinMeshBindGroupLayout
          : currentState.meshBindGroupLayout;
    if (meshLayout === null) return null;
    const plRes = currentBuildDevice().createPipelineLayout({
      label: `pbr-pl-${materialShaderId}`,
      bindGroupLayouts: [
        currentState.viewBindGroupLayout,
        bglRes.value,
        meshLayout,
        currentState.instancesBindGroupLayout,
      ],
    });
    if (!plRes.ok) {
      internals.errorRegistry.fire(plRes.error);
      return null;
    }
    const built = { materialBgl: bglRes.value, pipelineLayout: plRes.value };
    cacheState.perShaderMaterialLayoutCache.set(materialShaderId, {
      source,
      paramSchema,
      layoutKind,
      layout: built,
    });
    return built;
  };
  const resolveCachedMaterialShaderVariantSet = (
    requestedVariantSet: string | undefined,
    manifestEntry: import('@forgeax/engine-shader').MaterialShaderManifestEntry | undefined,
  ): string | undefined => {
    // Keep lazy PSO resolution aligned with buildReadyWebGPU's sampled-texture gate.
    const device = currentBuildDevice();
    const sampledTextureLimit = device.limits.maxSampledTexturesPerShaderStage;
    if (manifestEntry === undefined) {
      return resolveMaterialShaderVariantSet(
        requestedVariantSet,
        [],
        device.caps.backendKind,
        device.caps.storageBuffer,
        sampledTextureLimit,
      );
    }
    const variants = manifestEntry.variants;
    let byRequest = materialShaderVariantResolutionCache.get(variants);
    if (byRequest === undefined) {
      byRequest = new Map();
      materialShaderVariantResolutionCache.set(variants, byRequest);
    }
    const cacheKey = `${requestedVariantSet ?? '\u0000'}|${device.caps.backendKind}|${device.caps.storageBuffer ? '1' : '0'}|${sampledTextureLimit ?? '\u0000'}`;
    if (byRequest.has(cacheKey)) return byRequest.get(cacheKey);
    const resolved = resolveMaterialShaderVariantSet(
      requestedVariantSet,
      variants,
      device.caps.backendKind,
      device.caps.storageBuffer,
      sampledTextureLimit,
    );
    byRequest.set(cacheKey, resolved);
    return resolved;
  };
  const findMaterialShaderManifestEntry = (
    materialShaderId: string,
  ): MaterialShaderManifestEntry | undefined => {
    const cacheState = currentPipelineCacheState();
    const cached = cacheState.materialShaderManifestEntryCache.get(materialShaderId);
    if (cached !== undefined) return cached;
    for (const candidate of getShader().materialShaderManifestEntries()) {
      if (candidate.identifier === materialShaderId) {
        cacheState.materialShaderManifestEntryCache.set(materialShaderId, candidate);
        return candidate;
      }
    }
    return undefined;
  };
  // feat-20260622-s5 M3 / w17: the pipeline build is factored into a closure so
  // the recover() rebuild can re-run the SAME three-step assembly against the
  // freshly-acquired device (SSOT — one build path, one set of seed callbacks).
  // All captured references (getShader / gpuStore / getShaderModuleAdapter /
  // materialShaderPipelineCache / renderSystem) are stable across recover; only
  // `internals.device` / `internals.pack` are read live, so a rebuild after a
  // device swap compiles against the new device.
  const promotePipelineExtendedLighting = (state: PipelineState, scope: DeviceScope): void => {
    if (
      state.extendedLightingAvailable !== true ||
      state.iesProfileTexture === undefined ||
      state.cookieTexture === undefined ||
      state.cookieMatrixBuffer === undefined ||
      state.iesProfileTextureView === undefined ||
      state.cookieTextureView === undefined ||
      state.ltcLambertTextureView === undefined ||
      state.ltcGgxTextureView === undefined
    ) {
      return;
    }
    const candidate: ExtendedLightingResourceCandidate = {
      topology: EXTENDED_LIGHTING_TOPOLOGY,
      generation: scope.generation,
      scope,
      iesSliceCount: 0,
      cookieSliceCount: 0,
      cookieMatrices: 0,
      sampler: state.defaultSampler,
      iesTexture: state.iesProfileTexture,
      cookieTexture: state.cookieTexture,
      cookieMatrixBuffer: state.cookieMatrixBuffer,
      descriptorBytes:
        IES_SLICE_WIDTH * IES_SLICE_HEIGHT * 2 * 32 +
        COOKIE_SLICE_SIZE * COOKIE_SLICE_SIZE * 4 * 32 +
        COOKIE_MATRIX_BYTES,
      uploadCount: 5,
    };
    extendedLightingState = promoteExtendedLightingCandidate(extendedLightingState, candidate);
  };
  let tonemapRegistered = false;
  let fxaaRegistered = false;
  let temporalPostProcessesRegistered = false;
  const buildPipeline = (
    scope: DeviceScope = activeDeviceScope,
    device: RhiDevice = currentBuildDevice(),
    residencyStore: GpuResidencyCache = gpuStore,
  ): Promise<PipelineState> =>
    buildReadyWebGPU(
      device,
      scope,
      getShader,
      residencyStore,
      internals.pack.createShaderModule,
      internals.errorRegistry,
      requiredMaterialShaders,
      requiredFullscreenPostProcesses,
      // feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M2 /
      // T-M2-05 + M3 / T-M3-04: callback set by buildReadyWebGPU once
      // meshSsboController is wired. Both the grow hook AND the read-only
      // state ref land on `internals` so the record stage (M3
      // ensureMeshSsboCapacity) can read slotCount + call grow through
      // RenderSystemInternals.
      (hook, state) => {
        if (candidateBuildState !== undefined) {
          candidateBuildState.growMeshSsbo = hook;
          candidateBuildState.meshSsboState = state;
        } else {
          internals.growMeshSsbo = hook;
          internals.meshSsboState = state;
        }
      },
      // feat-20260609 R3-fixup: seed the lazy adapter cache with the
      // eagerly-compiled shadow_caster module.
      (label, module) => {
        getShaderModuleAdapter().seedModule(label, module);
      },
      // M6 fix-up: seed the active or candidate material pipeline cache from
      // the boot-time SPEC_CONST prewarm. Recovery builds must never put a
      // candidate-device PSO into the retired generation's cache.
      (key, pso, group2Contract) => {
        const pipelineCache = currentPipelineCacheState().materialShaderPipelineCache;
        if (!pipelineCache.has(key)) {
          pipelineCache.set(key, pso);
        }
        materialShaderPipelineGroup2Contracts.set(pso as object, group2Contract);
      },
      // feat-20260621 M-A3 (D-5): register the built-in tonemap on the unified
      // post-process channel once buildReadyWebGPU resolves the tonemap manifest
      // entry's composed WGSL. Fires after the manifest-load await, by which point
      // `renderSystem` (declared synchronously below) is defined. The 16 B params
      // schema mirrors the prior dedicated UBO: [exposure(f32), whitePoint(f32),
      // mode(u32), pad(f32)]; the extract stage bridges Camera.exposure/whitePoint/
      // tonemap into this channel each frame (render-system-extract.ts w13).
      (source: string) => {
        if (candidateBuildState !== undefined || tonemapRegistered) return;
        renderSystem.registerBuiltinPostProcess(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID, {
          source,
          params: { byteSize: 16, defaultValue: new Uint8Array(16) },
          reads: ['hdrColor'],
        });
        tonemapRegistered = true;
      },
      (source: string) => {
        if (fxaaRegistered) return;
        renderSystem.registerBuiltinPostProcess(FXAA_POST_PROCESS_ID, {
          source,
          params: { byteSize: 16, defaultValue: new Uint8Array(16) },
          reads: ['ldrColor'],
        });
        fxaaRegistered = true;
      },
      (entries: { readonly motionBlur?: string; readonly taaResolve?: string }) => {
        if (candidateBuildState !== undefined || temporalPostProcessesRegistered) return;
        if (entries.motionBlur !== undefined) {
          renderSystem.registerBuiltinPostProcess('forgeax.motion-blur', {
            source: entries.motionBlur,
            params: { byteSize: 16, defaultValue: new Uint8Array(16) },
            reads: ['scene-color', 'scene-temporal'],
          });
        }
        if (entries.taaResolve !== undefined) {
          renderSystem.registerBuiltinPostProcess('forgeax.taa-resolve', {
            source: entries.taaResolve,
            params: { byteSize: 16, defaultValue: new Uint8Array(16) },
            reads: ['scene-color', 'scene-temporal', 'taa-history-color', 'taa-history-temporal'],
          });
        }
        temporalPostProcessesRegistered = true;
      },
      (sources: VolumetricFogShaderSources) => {
        internals.volumetricFogShaders = sources;
      },
    );
  const ready: Promise<Result<void, RhiError>> = buildPipeline().then(
    (state): Result<void, RhiError> => {
      pipelineState = state;
      promotePipelineExtendedLighting(state, activeDeviceScope);
      readySettled = true;
      return ok(undefined);
    },
    (e: unknown): Result<void, RhiError> => {
      readySettled = true;
      if (e instanceof RhiError) return err(e);
      const message = e instanceof Error ? e.message : String(e);
      return err(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'Renderer.initialization three-step strict-serial succeeds',
          hint: `pipeline build raised: ${message}`,
        }),
      );
    },
  );
  /**
   * bug-20260527-renderstate-pipeline-dispatch-gap D-3:
   * finds the engine-shipped PBR manifest entry from the shader registry
   * by content marker (f_schlick BRDF helper call, same marker
   * buildReadyWebGPU uses). Returns undefined when the manifest is
   * empty (Camera-only path) or the pbr entry is not found.
   */
  const findStandardPbrEntry = (
    variantSet?: string,
  ): import('@forgeax/engine-types').ManifestEntry | undefined => {
    const device = currentBuildDevice();
    let standardEntry: import('@forgeax/engine-types').ManifestEntry | undefined;
    for (const entry of getShader().entries()) {
      if (entry.wgsl.includes('f_schlick')) {
        standardEntry = entry;
        break;
      }
    }
    if (standardEntry === undefined) return undefined;
    const pbrManifestEntry = [...getShader().materialShaderManifestEntries()].find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    const noColorVariant = selectNoColorPbrVariant(
      pbrManifestEntry,
      device.caps.storageBuffer,
      variantSet,
      deriveExtendedLightingCapability(device).admitted,
      device.caps.backendKind === 'webgpu' || device.caps.backendKind === 'wgpu-native',
      (device.limits.maxSampledTexturesPerShaderStage ?? 0) >=
        STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES,
    );
    if (noColorVariant !== undefined && noColorVariant.composedWgsl !== standardEntry.wgsl) {
      return { ...standardEntry, wgsl: noColorVariant.composedWgsl };
    }
    const runtimePbr = getShader().findMaterialArtifact('forgeax::default-standard-pbr');
    if (runtimePbr.ok && runtimePbr.value.source !== standardEntry.wgsl) {
      return { ...standardEntry, wgsl: runtimePbr.value.source };
    }
    return standardEntry;
  };
  // Shared builder context for the per-MaterialShader pipeline cache.
  // Built once; reused for both registered shader IDs and fallback
  // paths (D-3). Null when manifest is empty (Camera-only path).
  //
  // feat-20260609-hdrp-cluster-fragment-ggx M4.5 / w37 (D-10 option A):
  // `variantSet` parameter selects between URP `pbrPipelineLayout` (1-slot
  // group(2) BGL) and HDRP `hdrpPbrPipelineLayout` (7-slot group(2) BGL)
  // via `selectPipelineLayoutForVariant`. When undefined (legacy callers
  // / fallback path) the URP layout is used preserving prior behaviour.
  const buildPipelineContext = (
    variantSet?: string,
    materialShaderId?: string,
    group2Contract: PipelineGroup2Contract = 'mesh',
    // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4):
    // when layoutKind === 'pbr-skin' the SSOT for the vertex buffer layout
    // is `deriveVertexBufferLayout` (vertex-attribute-layout.ts) — the same
    // function that the WGSL @location(N) declarations / naga reflect tests
    // consume. A caller passing a real `MeshAsset.attributes` produces the
    // exact 6-attribute / 72-byte layout the skin shader expects; passing
    // undefined falls into the synthetic 6-key sentinel below (the skin
    // path is fully determined by layoutKind, so key-presence is the only
    // signal `deriveVertexBufferLayout` reads — values never matter).
    meshAttributes?: VertexAttributeMap,
    vertexLayout?: string,
    vertexLayoutProjection?: VertexLayoutProjection,
    shaderModuleMode?: RenderFeatureShaderModuleMode,
    layoutKindOverride?: LayoutKind,
  ) => {
    const contractLayoutKind: LayoutKind =
      group2Contract === 'cluster'
        ? 'hdrp-pbr'
        : group2Contract === 'skin-cluster'
          ? 'hdrp-skin'
          : group2Contract === 'skin'
            ? 'pbr-skin'
            : 'pbr';
    const layoutKind = layoutKindOverride ?? contractLayoutKind;
    const usesSharedBootMaterialLayout =
      materialShaderId !== undefined && isEngineOwnedMaterialShader(materialShaderId);
    // Built-in PBR/unlit/skin layouts are assembled at boot. Re-deriving a
    // per-shader layout from the expanded PBR schema would bypass the HDRP
    // group(2) selector and bind the URP mesh BGL to the cluster pipeline.
    const perShaderLayout =
      !usesSharedBootMaterialLayout && materialShaderId !== undefined
        ? getOrBuildPerShaderMaterialLayout(materialShaderId, undefined, layoutKind)
        : null;
    // feat-20260621-learn-render-5-5-parallax M2 / w6 (D-1): an authored
    // shader owns a per-shader pipeline layout derived from its paramSchema,
    // because its compact texture order may differ from standard PBR even
    // when it declares only a few textures. Skin / HDRP keep their dedicated
    // layouts; built-in material IDs remain on the shared boot-time layout.
    const bindingContract =
      materialShaderId === undefined
        ? 'render-material'
        : getCachedMaterialShaderBindingContract(materialShaderId);
    const group0Layout = bindingContract === 'group-0' ? getOrBuildGroup0MaterialLayout() : null;
    const group0ResourceLayout =
      bindingContract === 'group-0-resource' && materialShaderId !== undefined
        ? getOrBuildGroup0ResourceLayout(materialShaderId)
        : null;
    const viewOnlyLayout =
      bindingContract === 'view-only' ? getOrBuildViewOnlyMaterialPipelineLayout() : null;
    const viewAndSceneDepthLayout =
      bindingContract === 'view-and-scene-depth'
        ? getOrBuildViewAndSceneDepthMaterialPipelineLayout()
        : null;
    const preparedMaterialLayout =
      bindingContract === 'render-material' &&
      materialShaderId !== undefined &&
      (vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInstance ||
        vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInstance)
        ? getOrBuildPreparedMaterialPipelineLayout(materialShaderId)
        : null;
    const materialShaderLookup =
      materialShaderId === undefined
        ? undefined
        : getShader().findMaterialArtifact(materialShaderId);
    const materialShaderSource = materialShaderLookup?.ok
      ? materialShaderLookup.value.source
      : undefined;
    const vertexInputContract =
      materialShaderId === undefined
        ? 'render-material'
        : materialShaderSource !== undefined
          ? resolveMaterialShaderVertexInputContract(materialShaderSource)
          : 'render-material';
    const currentState = currentPipelineState();
    const pipelineLayout =
      group0Layout !== null
        ? group0Layout.pipelineLayout
        : group0ResourceLayout !== null
          ? group0ResourceLayout.pipelineLayout
          : viewOnlyLayout !== null
            ? viewOnlyLayout
            : viewAndSceneDepthLayout !== null
              ? viewAndSceneDepthLayout
              : preparedMaterialLayout !== null
                ? preparedMaterialLayout
                : perShaderLayout !== null
                  ? perShaderLayout.pipelineLayout
                  : selectPipelineLayoutForVariant(currentState, variantSet, layoutKind);
    if (pipelineLayout === null) return null;
    const currentMaterialUvSetCounts = currentMaterialShaderUvSetCounts();
    const resolvedUvSetCount =
      materialShaderId !== undefined
        ? (currentMaterialUvSetCounts.get(materialShaderId) ??
          (materialShaderSource !== undefined
            ? resolveMaterialShaderUvSetCount(
                materialShaderSource,
                currentMaterialUvSetCounts.get(materialShaderId),
              )
            : undefined))
        : undefined;
    const vertexBuffers: readonly GPUVertexBufferLayout[] =
      vertexInputContract === 'none'
        ? []
        : vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.positionSizeColorInstance
          ? POSITION_SIZE_COLOR_INSTANCE_VERTEX_BUFFERS
          : vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInstance
            ? BILLBOARD_MATERIAL_INSTANCE_VERTEX_BUFFERS
            : vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.topologySegmentInstance
              ? TOPOLOGY_SEGMENT_INSTANCE_VERTEX_BUFFERS
              : vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInstance
                ? MESH_GEOMETRY_MATERIAL_INSTANCE_VERTEX_BUFFERS
                : vertexLayoutProjection !== undefined
                  ? toGpuVertexBufferLayouts(
                      deriveVertexBufferLayoutFromProjection(
                        vertexLayoutProjection,
                        resolvedUvSetCount !== undefined
                          ? { shaderUvSetCount: resolvedUvSetCount }
                          : undefined,
                      ),
                    )
                  : layoutKind === 'pbr-skin'
                    ? toGpuVertexBufferLayouts(
                        deriveVertexBufferLayout(
                          meshAttributes ??
                            ({
                              position: PBR_SKIN_SENTINEL_ATTR_BUFFER,
                              normal: PBR_SKIN_SENTINEL_ATTR_BUFFER,
                              uv: PBR_SKIN_SENTINEL_ATTR_BUFFER,
                              tangent: PBR_SKIN_SENTINEL_ATTR_BUFFER,
                              skinIndex: PBR_SKIN_SENTINEL_ATTR_BUFFER,
                              skinWeight: PBR_SKIN_SENTINEL_ATTR_BUFFER,
                            } satisfies VertexAttributeMap),
                          resolvedUvSetCount !== undefined
                            ? { shaderUvSetCount: resolvedUvSetCount }
                            : undefined,
                        ),
                      )
                    : meshAttributes !== undefined ||
                        (resolvedUvSetCount !== undefined && resolvedUvSetCount > 1)
                      ? toGpuVertexBufferLayouts(
                          deriveVertexBufferLayout(
                            meshAttributes ?? DEFAULT_VERTEX_ATTRS,
                            resolvedUvSetCount !== undefined && resolvedUvSetCount > 1
                              ? { shaderUvSetCount: resolvedUvSetCount }
                              : undefined,
                          ),
                        )
                      : ([
                          {
                            arrayStride: 12 * 4,
                            attributes: [
                              { shaderLocation: 0, offset: 0, format: 'float32x3' as const },
                              { shaderLocation: 1, offset: 3 * 4, format: 'float32x3' as const },
                              { shaderLocation: 2, offset: 6 * 4, format: 'float32x2' as const },
                              { shaderLocation: 3, offset: 8 * 4, format: 'float32x4' as const },
                            ],
                          },
                        ] satisfies readonly GPUVertexBufferLayout[]);
    return {
      device: currentBuildDevice(),
      shaderModuleFactory:
        shaderModuleMode === 'immediate'
          ? getImmediateShaderModuleAdapter()
          : getShaderModuleAdapter(),
      pipelineLayout,
      vertexBuffers,
      ...(layoutKind === 'pbr-skin' ? { layoutKind } : {}),
    };
  };
  /**
   * Builds a pipeline for the given entry, caches it keyed by cacheKey,
   * and returns it. Returns null on build failure (firing errorRegistry
   * for non-transient errors).
   */
  const buildAndCachePipeline = (
    cacheKey: string,
    entry: MaterialShaderEntry,
    label: string,
    moduleLabel: string,
    isHdr: boolean,
    renderState: MaterialRenderState | undefined,
    topology: PrimitiveTopology | undefined,
    stripIndexFormat: 'uint16' | 'uint32' | undefined,
    // feat-20260609 M4.5 / w37 (D-10): thread variantSet to the layout selector
    // so HDRP-variant PSOs build with `hdrpPbrPipelineLayout` (7-slot group(2))
    // and URP-variant PSOs build with `pbrPipelineLayout` (1-slot group(2)).
    variantSet?: string,
    passKind: PassKind = 'forward',
    // bug-20260611-skin-pipeline-layout: thread materialShaderId so
    // buildPipelineContext can derive `LayoutKind === 'pbr-skin'` and pick
    // the 2-entry mesh-array BGL chain.
    materialShaderId?: string,
    // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4):
    // pass the per-mesh `VertexAttributeMap` so the pbr-skin path's
    // vertex buffer layout flows from the SSOT `deriveVertexBufferLayout`
    // (vertex-attribute-layout.ts) instead of a parallel hardcoded copy.
    // Undefined falls into the synthetic 6-key sentinel inside
    // `buildPipelineContext` (key-presence-only); non-skin layoutKinds
    // ignore this parameter entirely.
    meshAttributes?: VertexAttributeMap,
    // bug-20260615 M2 / m2-1: sampleCount drives the multisample descriptor
    // field in buildPipelineForMaterialShader — it is a CAMERA fact (per-frame
    // antialias setting), not a material renderState value. Default 1 preserves
    // byte-identity of every existing pre-M2 cache slot + descriptor.
    sampleCount: number = 1,
    // feat-20260625-refactor-sprite-as-transparent-mesh R2 fix-up: LDR-color
    // override for sub-passes that write to a non-default attachment view.
    // Pre-feat the dedicated `forgeax::default-sprite` SPEC_CONST entries
    // (SPRITE_ATTACHMENTS_LDR_S1/S4) targeted the swap-chain STORAGE format
    // (non-sRGB) directly. Post-w14 sprite falls into the generic lazy build
    // path which defaults to `pipelineState.colorAttachmentFormat` (the sRGB
    // VIEW format used by the geometry pass) — incompatible with the sprite
    // sub-pass's non-sRGB attachment view (bgra8unorm / rgba8unorm), firing
    // a per-frame "Attachment state ... not compatible" validation error.
    // The sprite sub-pass call site passes `pipelineState.format` (storage,
    // non-sRGB) here so the resulting PSO matches the encoder's attachment
    // state. Undefined preserves the default (sRGB view) path used by every
    // pre-fix-up caller. Ignored when `isHdr=true` or `passKind='shadow-caster'`.
    colorFormatOverride?: GPUTextureFormat,
    // Prepared graphics passes use `null` to request an explicit color-only
    // pipeline; omitted preserves the material forward depth default.
    depthFormatOverride?: GPUTextureFormat | null,
    vertexLayout?: string,
    vertexLayoutProjection?: VertexLayoutProjection,
    shaderModuleMode?: RenderFeatureShaderModuleMode,
    layoutKindOverride?: LayoutKind,
    additionalColorFormats?: readonly GPUTextureFormat[],
    vertexEntry?: string,
    authoredFragmentEntry?: string,
  ): RenderPipeline | null => {
    const group2Contract = resolvePipelineGroup2Contract(entry.source);
    const ctx = buildPipelineContext(
      variantSet,
      materialShaderId,
      group2Contract,
      meshAttributes,
      vertexLayout,
      vertexLayoutProjection,
      shaderModuleMode,
      layoutKindOverride,
    );
    if (ctx === null) return null;
    // bug-20260612: route the LDR color format through pipelineState so the
    // backend-aware swap-chain format chosen at buildReadyWebGPU flows here.
    // Callers gate on pipelineState !== null before reaching this lambda
    // (search "buildAndCachePipeline" call sites — every one is preceded by
    // the explicit null check).
    const currentState = currentPipelineState();
    if (currentState === null) return null;
    const ldrColorFormat = colorFormatOverride ?? currentState.colorAttachmentFormat;
    const fragmentEntry =
      authoredFragmentEntry ??
      (isHdr &&
      passKind === 'forward' &&
      (materialShaderId === 'forgeax::sprite' || materialShaderId === 'forgeax::sprite-lit')
        ? 'fs_main_hdr'
        : undefined);
    const built = buildPipelineForMaterialShader(
      cacheKey,
      // The catalog entry is projected into the material-shader entry shape.
      entry,
      {
        ...ctx,
        colorFormat: isHdr ? HDR_COLOR_ATTACHMENT_FORMAT : ldrColorFormat,
        colorFormats:
          additionalColorFormats === undefined
            ? undefined
            : [isHdr ? HDR_COLOR_ATTACHMENT_FORMAT : ldrColorFormat, ...additionalColorFormats],
        depthFormat:
          depthFormatOverride === null ? undefined : (depthFormatOverride ?? DEPTH_TEXTURE_FORMAT),
        label,
        // feat-20260604 w16-b: the shader-MODULE cache identity. Stable across
        // topology / renderState / isHdr / indexFormat (all baked into the PSO,
        // not the module), so every pipeline variant of the same shader source
        // reuses one compiled module instead of forcing a fresh async compile
        // per variant. See PipelineBuilderContext.moduleLabel.
        moduleLabel,
      },
      renderState,
      // w8/w15: pack topology (+ stripIndexFormat) into the builder's geometry
      // param. Strip topologies bake stripIndexFormat into the immutable PSO
      // (WebGPU spec: only valid for line-strip / triangle-strip). The record
      // stage (w9 + w15) threads each mesh's topology + indexFormat here; when
      // the caller omits stripIndexFormat we fall back to 'uint32' (the engine
      // procedural index width: createBoxGeometry etc. emit Uint32 indices).
      topology !== undefined
        ? {
            topology,
            ...(topology === 'line-strip' || topology === 'triangle-strip'
              ? { stripIndexFormat: stripIndexFormat ?? ('uint32' as const) }
              : {}),
          }
        : undefined,
      vertexEntry,
      fragmentEntry,
      undefined, // defines — none
      passKind,
      sampleCount,
    );
    if (!built.ok) {
      if (built.error.code !== 'rhi-not-available') {
        internals.errorRegistry.fire(built.error);
      }
      return null;
    }
    currentPipelineCacheState().materialShaderPipelineCache.set(cacheKey, built.value);
    materialShaderPipelineGroup2Contracts.set(
      built.value as object,
      resolvePipelineGroup2Contract(entry.source),
    );
    return built.value;
  };
  const getMaterialShaderPipeline = (
    materialShaderId: string,
    isHdr: boolean,
    renderState?: MaterialRenderState,
    topology?: PrimitiveTopology,
    indexFormat?: 'uint16' | 'uint32',
    variantSet?: string,
    passKind: PassKind = 'forward',
    // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4):
    // forwarded to `buildAndCachePipeline -> buildPipelineContext` so the
    // pbr-skin layout chain reads from the `deriveVertexBufferLayout` SSOT.
    // Optional: existing callers (URP / HDRP / shadow-depth) pass undefined
    // and the hardcoded 4-attribute layout is preserved (AC-04 zero-regression).
    meshAttributes?: VertexAttributeMap,
    // bug-20260615 M2 / m2-1: sampleCount is threaded through to the cache key,
    // buildAndCachePipeline, and ultimately buildPipelineForMaterialShader which
    // sets the multisample descriptor field. Default 1 preserves byte-identity
    // of every pre-M2 caller.
    sampleCount: number = 1,
    // feat-20260625-refactor-sprite-as-transparent-mesh R2 fix-up: LDR-color
    // override for sub-passes that write to a non-default attachment view.
    // The LDR sprite split sub-pass writes through the storage (non-sRGB)
    // view of the swap-chain texture; the encoder's beginRenderPass
    // colorFormats uses `pipelineState.format` (storage), so the PSO must
    // build with the same non-sRGB format or WebGPU rejects SetPipeline
    // with "Attachment state ... not compatible". Pre-w14 the dedicated
    // `forgeax::default-sprite` SPEC_CONST entries (deleted) baked this
    // mapping into SPRITE_ATTACHMENTS_LDR_S1/S4; the generic lazy build
    // path that replaced them defaults to `colorAttachmentFormat` (the
    // sRGB view used by the geometry pass), so transparent-split callers
    // must override. Threaded into both the cache key (via the spec's
    // `attachments.colorFormats`) and the actual PSO descriptor. Ignored
    // for `isHdr=true` (HDR sub-pass uses rgba16float) and
    // `passKind='shadow-caster'` (depth-only, no color attachment).
    colorFormatOverride?: GPUTextureFormat,
    // feat-20260629-multi-uv-set-support m3-w5: shader-declared UV set count,
    // forwarded to PipelineSpec.geometry.shaderUvSetCount for clamp-to-last
    // alias. Undefined = fallback to mesh-provided count (no clamping).
    // m4-w3: auto-filled from naga reflection when caller passes undefined.
    shaderUvSetCount?: number,
    // Prepared graphics passes use `null` to request an explicit color-only
    // pipeline; omitted preserves the material forward depth default.
    depthFormatOverride?: GPUTextureFormat | null,
    vertexLayout?: string,
    vertexLayoutProjection?: VertexLayoutProjection,
    shaderModuleMode: RenderFeatureShaderModuleMode = 'validated',
    layoutKindOverride?: LayoutKind,
    additionalColorFormats?: readonly GPUTextureFormat[],
    vertexEntry?: string,
    fragmentEntry?: string,
  ): RenderPipeline | null => {
    // WebGL2 is a downlevel backend even when the record stage asks for the
    // native-capability variant string. Resolve the variant axes at this
    // shared PSO seam so the shader source, BGL layout, and cache key agree on
    // the actual device capabilities. Without this, WebGL2 can build a
    // storage-buffer PSO around a uniform-buffer shader and only reject it at
    // queue submit as an invalid RenderPipeline.
    const currentState = currentPipelineState();
    const ldrColorFormat: GPUTextureFormat =
      colorFormatOverride ??
      (currentState !== null ? currentState.colorAttachmentFormat : 'bgra8unorm-srgb');
    // feat-20260629 M4: auto-fill shaderUvSetCount from naga reflection
    // (stored in materialShaderUvSetCounts during prepareMaterialShaders).
    const pipelineShaderId = resolveMaterialShaderBackendArtifactKey(
      materialShaderId,
      internals.device.caps.backendKind,
      assets.getMaterialArtifact(materialShaderId),
    );
    const materialShaderLookup = getShader().findMaterialArtifact(pipelineShaderId);
    const materialShaderSource = materialShaderLookup.ok
      ? materialShaderLookup.value.source
      : undefined;
    const currentMaterialUvSetCounts = currentMaterialShaderUvSetCounts();
    const materialUvSetCount = resolveMaterialShaderUvSetCount(
      materialShaderSource,
      currentMaterialUvSetCounts.get(pipelineShaderId),
    );
    if (materialUvSetCount !== undefined) {
      currentMaterialUvSetCounts.set(pipelineShaderId, materialUvSetCount);
    }
    const resolvedUvSetCount = shaderUvSetCount ?? materialUvSetCount;
    const manifestEntry = findMaterialShaderManifestEntry(pipelineShaderId);
    // Sprite's omitted request is the boot-selected default artifact. The
    // explicit empty key remains the PER_INSTANCE_REGION=true request used by
    // SpriteInstances, so only that path is capability-rewritten here.
    const resolvedVariantSet =
      variantSet === undefined &&
      (pipelineShaderId === 'forgeax::sprite' || pipelineShaderId === 'forgeax::sprite-lit')
        ? undefined
        : resolveCachedMaterialShaderVariantSet(variantSet, manifestEntry);
    // The record stage also composes engine capability axes for user shaders.
    // Keep only manifest-declared axes for non-engine material IDs: a plain
    // custom shader must not collapse that request to '' because '' is the
    // canonical HDRP variant key and would pair an HDRP PSO with the URP mesh
    // bind group. Builtin forgeax:: shaders keep the compatibility request
    // when a reduced test/legacy manifest omits variant metadata.
    // A single-source manifest entry must stay on its canonical module key;
    // otherwise a synthesized capability axis races the prewarmed module.
    let effectiveVariantSet = normalizeMaterialShaderVariantSet(resolvedVariantSet, manifestEntry);
    // Runtime-published authored materials are installed from their immutable
    // cooked artifact, not from the build-time material-shader manifest. The
    // published artifact identity already selects the backend-specific bytes;
    // an absent manifest therefore means the source itself is the canonical
    // pipeline module and must not carry a synthesized capability key.
    if (manifestEntry === undefined) effectiveVariantSet = undefined;
    if (
      vertexLayoutProjection === undefined &&
      manifestEntry?.variants.some((variant) => 'VERTEX_COLOR_AVAILABLE' in variant.defines)
    ) {
      if (effectiveVariantSet === '') {
        const noColorVariant = manifestEntry.variants.find(
          (variant) =>
            variant.defines.VERTEX_COLOR_AVAILABLE === false &&
            Object.entries(variant.defines).every(
              ([axis, value]) => axis === 'VERTEX_COLOR_AVAILABLE' || value === true,
            ),
        );
        effectiveVariantSet = noColorVariant?.definesKey ?? 'VERTEX_COLOR_AVAILABLE=false';
      } else {
        effectiveVariantSet = effectiveVariantSet?.replace(
          'VERTEX_COLOR_AVAILABLE=true',
          'VERTEX_COLOR_AVAILABLE=false',
        );
      }
    }
    if (
      manifestEntry !== undefined &&
      !pipelineShaderId.startsWith('forgeax::') &&
      effectiveVariantSet !== undefined &&
      effectiveVariantSet !== ''
    ) {
      const declaredAxes = new Set<string>();
      for (const variant of manifestEntry.variants) {
        for (const axis of Object.keys(variant.defines)) declaredAxes.add(axis);
      }
      const filteredVariantParts = effectiveVariantSet
        .split('+')
        .filter((part) => declaredAxes.has(part.slice(0, part.indexOf('='))))
        .sort();
      effectiveVariantSet =
        filteredVariantParts.length === 0 ? undefined : filteredVariantParts.join('+');
    }
    // feat-20260615-pipeline-spec-ssot M2-T2: cache key derived from PipelineSpec
    // 4-axis SSOT via cacheKeyOf(spec). The spec carries all 4 axes (shader /
    // attachments / geometry / renderState), replacing the legacy 8-segment string
    // construction. vertexLayout is now included in the cache key (was previously
    // threaded but not hashed — research F1 R-VertexLayout-Cache). sampleCount is
    // cast to 1 | 4 for the closed spec axis.
    // M2-fixup follow-up: LDR color format SSOT is `pipelineState.colorAttachmentFormat`
    // (set in buildReadyWebGPU from selectSwapChainFormat). Hardcoding 'bgra8unorm-srgb'
    // here let the cache key drift from the prewarm key on backends where
    // getPreferredCanvasFormat returns rgba8unorm (dawn-node, lavapipe, wgpu-wasm GLES),
    // forcing a redundant second PSO build on first-frame URP record path.
    const colorFormat: GPUTextureFormat = isHdr ? 'rgba16float' : ldrColorFormat;
    const isDepthOnlyPass = passKindPolicyTable[passKind]?.shape === 'depth-only';
    const spec: PipelineSpec = {
      shader: {
        id: pipelineShaderId,
        passKind,
        variantSet: effectiveVariantSet,
        ...(vertexEntry === undefined ? {} : { vertexEntry }),
        ...(fragmentEntry === undefined ? {} : { fragmentEntry }),
      },
      attachments: {
        colorFormats:
          additionalColorFormats === undefined
            ? colorFormatsForPassKind(passKind, colorFormat)
            : [colorFormat, ...additionalColorFormats],
        depthFormat: isDepthOnlyPass
          ? 'depth32float'
          : depthFormatOverride === null
            ? undefined
            : (depthFormatOverride ?? 'depth24plus-stencil8'),
        sampleCount: (sampleCount === 4 ? 4 : 1) as 1 | 4,
      },
      geometry: {
        topology: topology ?? 'triangle-list',
        stripIndexFormat: indexFormat,
        vertexLayout:
          meshAttributes ??
          (vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.positionSizeColorInstance
            ? PREPARED_INSTANCE_VERTEX_ATTRS
            : vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInstance ||
                vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.topologySegmentInstance ||
                vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInstance
              ? PREPARED_MATERIAL_INSTANCE_VERTEX_ATTRS
              : DEFAULT_VERTEX_ATTRS),
        // Thread the shader-declared count whenever it is greater than one.
        // Built-in PBR reserves all eight supported UV inputs; single-UV meshes
        // remain byte-stable because missing sets are clamp-to-last aliases.
        ...(resolvedUvSetCount !== undefined && resolvedUvSetCount > 1
          ? { shaderUvSetCount: resolvedUvSetCount }
          : {}),
        ...(vertexLayoutProjection === undefined ? {} : { vertexLayoutProjection }),
      },
      renderState,
    };
    const cacheKey = cacheKeyOf(spec);
    const cached = currentPipelineCacheState().materialShaderPipelineCache.get(cacheKey);
    if (cached !== undefined) return cached;
    if (pipelineState === null) return null;
    const lookup = getShader().findMaterialArtifact(pipelineShaderId);
    if (!lookup.ok) {
      if (shouldDeferMissingPreparedMaterialShader(vertexLayout)) {
        // Prepared VFX draws bind only their feature-owned groups. The
        // built-in PBR fallback declares mesh/instance groups 2/3 and would
        // consequently emit an invalid pipeline before the authored shader
        // becomes available. Let the feature retry on the next frame.
        return null;
      }
      // bug-20260527-renderstate-pipeline-dispatch-gap D-3:
      // fallback path parity -- when renderState is defined and the
      // shader id is not registered, build a renderState-variant of
      // the standard pipeline from the engine-shipped PBR entry.
      if (
        renderState === undefined &&
        !allowsUnlitPreparedFallback(depthFormatOverride, vertexLayout, pipelineShaderId)
      ) {
        // A prepared feature declares the vertex layout it owns. Falling back
        // to default-unlit here would pair that data with the unlit shader's
        // position/normal/uv/tangent inputs and let WebGPU reject the
        // pipeline at validation time. Keep the missing shader retryable and
        // preserve the declared input contract instead.
        return null;
      }
      if (renderState === undefined) {
        const unlitLookup = getShader().findMaterialArtifact('forgeax::default-unlit');
        if (!unlitLookup.ok) return null;
        return buildAndCachePipeline(
          cacheKey,
          unlitLookup.value,
          `pbr-pipeline-prepared-${pipelineShaderId}`,
          // Reuse the eagerly compiled engine unlit module. The adapter cache
          // is seeded under this label during renderer readiness; a new label
          // would keep color-only prepared passes in perpetual warm-up.
          'unlit',
          isHdr,
          undefined,
          topology,
          indexFormat,
          effectiveVariantSet,
          passKind,
          'forgeax::default-unlit',
          meshAttributes,
          sampleCount,
          colorFormatOverride,
          depthFormatOverride,
          vertexLayout,
          vertexLayoutProjection,
          shaderModuleMode,
          layoutKindOverride,
          additionalColorFormats,
        );
      }
      const pbrEntry = findStandardPbrEntry(effectiveVariantSet);
      if (pbrEntry === undefined) return null;
      return buildAndCachePipeline(
        cacheKey,
        { source: pbrEntry.wgsl, paramSchema: [] },
        `pbr-pipeline-fallback-${pipelineShaderId}${isHdr ? '-hdr' : ''}`,
        // w16-b: module identity is the fallback PBR source, stable across
        // topology / renderState / HDR (all baked into the PSO) so every
        // variant reuses one compiled module.
        'module-fallback-pbr',
        isHdr,
        renderState,
        topology,
        indexFormat,
        // M4.5 / w37 (D-10): the fallback path also threads variantSet so the
        // layout selector picks HDRP layout when an HDRP caller falls into
        // this branch (registered shader id missing).
        effectiveVariantSet,
        // feat-20260609 / T-002: passKind threaded through the fallback path
        // for parity with the main path; default 'forward' keeps every prior
        // fallback caller byte-identical.
        passKind,
        // bug-20260611-skin-pipeline-layout: passing materialShaderId here is
        // intentional even on the fallback (registered-id-missing) branch --
        // a missing skin shader registration should not silently pick the
        // wrong BGL chain. With LayoutKind='pbr-skin' the selector returns
        // null when pbrSkinPipelineLayout is null (charter P3 explicit fail).
        //
        // MaterialAsset per-slot texCoord: this branch always compiles the
        // built-in PBR module (`pbrEntry.wgsl` / 'module-fallback-pbr'), whose
        // vertex stage declares all eight UV inputs. The vertex-buffer layout
        // therefore has to be the PBR layout with all declared slots present,
        // not the caller shader's -- e.g. a transparent sprite / sprite-lit
        // material lands here with meshAttributes carrying only uv0, so the
        // sprite id would resolve a 48-byte 4-attribute layout and the PBR
        // module would reject a missing UV slot. Pass the built-in PBR id for
        // layout resolution so buildPipelineContext derives the layout that
        // matches the compiled module. Skin keeps its
        // own id so the pbr-skin fail-fast (null layout) is preserved.
        pipelineShaderId === SKIN_MATERIAL_SHADER_ID
          ? pipelineShaderId
          : 'forgeax::default-standard-pbr',
        // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4):
        // forward meshAttributes through the fallback path so the pbr-skin
        // layout chain reads from the deriveVertexBufferLayout SSOT here too.
        meshAttributes,
        sampleCount,
        colorFormatOverride,
        depthFormatOverride,
        vertexLayout,
        vertexLayoutProjection,
        shaderModuleMode,
        layoutKindOverride,
        additionalColorFormats,
      );
    }
    // feat-20260609 M4 / w31: resolve variant WGSL from manifest when
    // variantSet is non-empty. The boot-time registered shader (from
    // `installMaterialArtifact` at line ~2473) carries the default (all-true)
    // variant's WGSL. For URP callers that want a different variant
    // (e.g. STORAGE_BUFFER_AVAILABLE=true without CLUSTER_FORWARD_AVAILABLE),
    // we look up the manifest entry, find the matching variant, and
    // substitute its composedWgsl into the PSO build path. The pipeline
    // layout itself is built by buildPbrPipelineLayouts (M3 / w12).
    // When variantSet is empty/undefined, the boot-time registered entry
    // (which is the all-true default) is used verbatim — backward compat.
    let shaderEntry = lookup.value;
    // M4.5 / w38 (D-11): `variantSet === ''` is canonical all-true (HDRP
    // path) and MUST hit the manifest variant lookup -- treat it as a
    // first-class variant request, not a falsy "no variant" signal.
    // Use `!== undefined` so the empty-string case enters the lookup.
    if (effectiveVariantSet !== undefined) {
      const registry = getShader();
      for (const msEntry of registry.materialShaderManifestEntries()) {
        if (msEntry.identifier === pipelineShaderId) {
          const variant = findVariantByKey(msEntry, effectiveVariantSet);
          if (variant) {
            // M3 / w12-w13: variant substitution carries the same source +
            // paramSchema as the boot-registered entry; the binding layout
            // is no longer carried on MaterialShaderEntry (deleted in
            // w13) — buildPbrPipelineLayouts is the BGL SSOT and reads
            // derive(paramSchema).bglEntries on demand.
            shaderEntry = {
              source: variant.composedWgsl,
              paramSchema: lookup.value.paramSchema,
              paramSchemaProjection: lookup.value.paramSchemaProjection,
            };
          }
          break;
        }
      }
    }
    // feat-20260609 M4 / R3-fixup: append `-${passKind}` to the PSO label so
    // GPU debug captures (and the shadow-caster branch in the builder)
    // make the cache variant visible. The fallback path above keeps the
    // pre-existing fallback-* label shape (no shadow-caster fallback
    // exists today; the only shadow caller registers shadowCaster directly).
    const passKindLabelSegment = passKind === 'forward' ? '' : `-${passKind}`;
    return buildAndCachePipeline(
      cacheKey,
      shaderEntry,
      `pbr-pipeline-${pipelineShaderId}${isHdr ? '-hdr' : ''}${passKindLabelSegment}`,
      // feat-20260609 M4 / w31: when variantSet is non-empty, the module identity
      // includes the variant key so URP (STORAGE_BUFFER_AVAILABLE=true) and HDRP
      // (CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true) variants
      // compile as separate shader modules (they have different WGSL sources).
      // When variantSet is empty/undefined, the module identity stays pre-M4
      // backward-compatible for all PSOs of the default variant.
      // M4.5 / w38 (D-11): same `!== undefined` discipline as the cache
      // key -- `''` (canonical all-true) gets its own module-label slot,
      // distinct from the no-variant path. Trailing `#` for the empty
      // case is intentional (parallel to the cache key's `:variant:`
      // empty-tail segment); module identity stays a function of the
      // exact variantSet string.
      effectiveVariantSet !== undefined
        ? `module-${pipelineShaderId}#${effectiveVariantSet}`
        : `module-${pipelineShaderId}`,
      isHdr,
      renderState,
      topology,
      indexFormat,
      // M4.5 / w37 (D-10): main path threads variantSet so HDRP-variant PSO
      // builds against `hdrpPbrPipelineLayout` (7-slot group(2) BGL) and URP
      // builds against `pbrPipelineLayout` (1-slot group(2) BGL).
      effectiveVariantSet,
      // feat-20260609 / T-002: passKind selects createRenderPipeline
      // attachment shape (forward color+DS vs shadow-caster depth32float
      // no-color). Orthogonal to variantSet (which selects the BGL chain).
      passKind,
      // bug-20260611-skin-pipeline-layout: thread the registered materialShaderId
      // so buildPipelineContext can resolve LayoutKind='pbr-skin' for the skin
      // shader (2-entry mesh-array BGL).
      pipelineShaderId,
      // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4):
      // forward meshAttributes so the pbr-skin path's vertex buffer layout
      // is derived via the SSOT (deriveVertexBufferLayout). For URP/HDRP
      // callers (and for a caller passing undefined) the synthetic 6-key
      // sentinel inside buildPipelineContext keeps the layout deterministic.
      meshAttributes,
      sampleCount,
      colorFormatOverride,
      depthFormatOverride,
      vertexLayout,
      vertexLayoutProjection,
      shaderModuleMode,
      layoutKindOverride,
      additionalColorFormats,
      vertexEntry,
      fragmentEntry,
    );
  };
  const getMaterialShaderPipelineEntry = (
    ...args: Parameters<typeof getMaterialShaderPipeline>
  ) => {
    const pipeline = getMaterialShaderPipeline(...args);
    if (pipeline === null) return null;
    return {
      pipeline,
      group2Contract:
        materialShaderPipelineGroup2Contracts.get(pipeline as object) ?? ('mesh' as const),
    };
  };
  const getParamSchema = (materialShaderId: string) => {
    const lookup = getShader().findMaterialArtifact(materialShaderId);
    return lookup.ok ? lookup.value.paramSchema : undefined;
  };
  // feat-20260621-learn-render-5-5-parallax M2 / w6 (D-1): expose the per-shader
  // material BGL so the record stage creates the material bind group against
  // the matching paramSchema-derived layout. Returns undefined only for
  // group-0 / view-only contracts or an unavailable shader layout; built-in
  // material IDs continue to resolve through the shared layout path.
  const getMaterialBindGroupLayout = (
    materialShaderId: string,
    materialParamSchema?: readonly ParamSchemaEntry[],
  ): BindGroupLayout | undefined => {
    if (isEngineOwnedMaterialShader(materialShaderId)) return undefined;
    const contract = getCachedMaterialShaderBindingContract(materialShaderId);
    if (contract === 'group-0') {
      return getOrBuildGroup0MaterialLayout()?.materialBgl;
    }
    if (contract === 'group-0-resource') {
      return getOrBuildGroup0ResourceLayout(materialShaderId)?.materialBgl;
    }
    if (contract === 'view-and-scene-depth') return undefined;
    return (
      getOrBuildPerShaderMaterialLayout(materialShaderId, materialParamSchema)?.materialBgl ??
      undefined
    );
  };
  // feat-20260609 M4 / T-10-a: post-process pipeline factory backing
  // RenderSystemRuntime.getPostProcessPipeline. Solves M1 CONCERN-1: previously
  // the dispatcher in render-graph-primitives.ts passed `pipeline=null` to
  // built.createHandle because per-frame execute closures cannot await
  // device.createShaderModule (async). This factory uses the same shared
  // makeShaderDeviceAdapter the material-shader pipeline cache uses (sync
  // wrapper + 1-frame warmup); first-call returns null while the async compile
  // is in flight; second frame onward returns the built pipeline.
  //
  // The pipeline layout is fixed:
  //   group(0) = empty BGL (reserved per render-graph-primitives.ts convention
  //              for view bind groups; populated by future post-process passes
  //              that need view UBOs)
  //   group(1) = the input-texture BGL the dispatcher already composed via
  //              buildFullscreenPostProcessPass (texture + sampler)
  // Vertex stage: vs_main (no vertex buffers); fragment stage: fs_main targeting
  // `colorFormat`. Topology: triangle-list with cullMode='none' (3-vertex
  // fullscreen draw via the canonical fullscreen_triangle pattern).
  const buildPostProcessPipeline = (
    entry: PostProcessShaderEntry,
    bgl: BindGroupLayout,
    colorFormat: GPUTextureFormat,
    label: string,
  ): RenderPipeline | null => {
    const moduleFactory = getShaderModuleAdapter();
    const moduleResult = moduleFactory.createShaderModule({
      code: entry.source,
      label: `${label}-module`,
    });
    if (!moduleResult.ok) {
      // 'rhi-not-available' = async compile in flight: caller falls back one frame.
      // Other codes are real failures: surface through the error registry so AI
      // users see a structured RhiError instead of a silent black screen (charter P3).
      if (moduleResult.error.code !== 'rhi-not-available') {
        internals.errorRegistry.fire(moduleResult.error);
      }
      return null;
    }
    if (currentEmptyPostProcessBgl() === null) {
      const bglRes = currentBuildDevice().createBindGroupLayout({ entries: [] });
      if (!bglRes.ok) {
        internals.errorRegistry.fire(bglRes.error);
        return null;
      }
      if (candidateBuildState !== undefined) {
        candidateBuildState.emptyPostProcessBgl = bglRes.value;
        candidateEmptyPostProcessBgl = bglRes.value;
      } else {
        emptyPostProcessBgl = bglRes.value;
      }
    }
    const layoutRes = currentBuildDevice().createPipelineLayout({
      label: `${label}-layout`,
      bindGroupLayouts: [currentEmptyPostProcessBgl() as BindGroupLayout, bgl],
    });
    if (!layoutRes.ok) {
      internals.errorRegistry.fire(layoutRes.error);
      return null;
    }
    const pipelineRes = currentBuildDevice().createRenderPipeline({
      label,
      layout: layoutRes.value,
      vertex: {
        module: moduleResult.value,
        entryPoint: 'vs_main',
        buffers: [],
      },
      fragment: {
        module: moduleResult.value,
        entryPoint: 'fs_main',
        targets:
          entry.source.includes('@location(1) temporal') &&
          entry.source.includes('TaaResolveOutput')
            ? [{ format: colorFormat }, { format: colorFormat }]
            : [{ format: colorFormat }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: undefined,
      multisample: undefined,
    });
    if (!pipelineRes.ok) {
      internals.errorRegistry.fire(pipelineRes.error);
      return null;
    }
    return pipelineRes.value;
  };
  let activeProfile = freezeRenderProfile(
    internals.options?.standardProfile ?? DEFAULT_STANDARD_PROFILE,
  );
  const renderSystem: RenderSystem = createRenderSystem({
    canvas: internals.canvas,
    get build() {
      return internals.bundler?.build;
    },
    ssrIdentity: internals.options?.ssrIdentity,
    get standardProfile() {
      return activeProfile;
    },
    standardPipeline,
    get featureHost() {
      return internals.featureHost;
    },
    setFeatureHost: (host) => {
      internals.featureHost = host;
    },
    // Keep the feature-facing factory stable while resolving the adapter at
    // call time. Renderer recovery swaps the device and invalidates the
    // per-device adapter; a boot-time snapshot would feed recovered VFX
    // programs shader modules owned by the lost device.
    shaderModuleFactory: {
      createShaderModule: (descriptor) => getShaderModuleAdapter().createShaderModule(descriptor),
    },
    immediateShaderModuleFactory: {
      createShaderModule: (descriptor) =>
        getImmediateShaderModuleAdapter().createShaderModule(descriptor),
    },
    profiler: internals.options?.profiler,
    // feat-20260622-s5 M3 / w17: device + context read live off `internals` via
    // getters so the recover() rebuild (which swaps internals.device /
    // internals.context for a freshly-acquired pair) is observed by the record
    // stage without reconstructing the RenderSystem (RenderSystemRuntime.device
    // / RenderSystemInternals.context are read at frame time, not cached).
    get device() {
      return internals.device;
    },
    get beforeSubmit() {
      return internals.pack.instrumentation?.beforeSubmit;
    },
    createShaderModule: (device, descriptor) =>
      internals.pack.createShaderModule === undefined
        ? Promise.resolve(invokeDeviceCreateShaderModule(device, descriptor))
        : internals.pack.createShaderModule(device, descriptor),
    get deviceScope() {
      return activeDeviceScope;
    },
    ...(internals.pack.instrumentation?.resolveSurfaceDevice === undefined
      ? {}
      : { resolveSurfaceDevice: internals.pack.instrumentation.resolveSurfaceDevice }),
    invalidateShaderModule: (label: string) => {
      activeShaderState.sharedShaderModuleAdapter?.invalidateModule(label);
    },
    get context() {
      return internals.context;
    },
    get debugOverlay() {
      return internals.debugOverlay;
    },
    // feat-20260608-create-app-param-surface-trim / M1 / AC-02: clearColor
    // is no longer threaded through createRenderSystem; the record stage
    // reads `camera.clearColor` straight from the Camera SoA column
    // (array<f32,4>, feat-20260709 M3).
    getPipelineState: () => pipelineState,
    assets,
    get gpuStore() {
      return gpuStore;
    },
    get dynamicTextureStore() {
      return dynamicTextureStore;
    },
    errorRegistry: internals.errorRegistry,
    healthRegistry: internals.healthRegistry,
    getMaterialShaderPipeline,
    getMaterialShaderPipelineEntry,
    getMaterialShaderBindingContract: getCachedMaterialShaderBindingContract,
    getParamSchema,
    getMaterialBindGroupLayout,
    metrics,
    // feat-20260609 M4 / T-10-a: post-process pipeline factory (CONCERN-1 fix).
    // createRenderSystem wraps this in a per-RenderSystem cache + the public
    // getPostProcessPipeline lookup the dispatcher reads at frame time.
    buildPostProcessPipeline,
    // feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M3 / T-M3-04:
    // forward the grow hook + state via getter closures — buildReadyWebGPU
    // sets `internals.growMeshSsbo` / `internals.meshSsboState` after this
    // factory call, so the record stage reads them through the closures
    // (read at frame time, when ready has already settled).
    get growMeshSsbo() {
      return internals.growMeshSsbo;
    },
    get meshSsboState() {
      return internals.meshSsboState;
    },
    get gpuPassTimingSession() {
      return (
        internals as WebGPURendererInternals & {
          gpuPassTimingSession?: GpuPassTimingSession | undefined;
        }
      ).gpuPassTimingSession;
    },
    set gpuPassTimingSession(session: GpuPassTimingSession | undefined) {
      (
        internals as WebGPURendererInternals & {
          gpuPassTimingSession?: GpuPassTimingSession | undefined;
        }
      ).gpuPassTimingSession = session;
    },
    get gpuPassTimingCapture() {
      return (
        internals as WebGPURendererInternals & {
          gpuPassTimingCapture?: GpuPassTimingCapture | undefined;
        }
      ).gpuPassTimingCapture;
    },
    set gpuPassTimingCapture(capture: GpuPassTimingCapture | undefined) {
      (
        internals as WebGPURendererInternals & {
          gpuPassTimingCapture?: GpuPassTimingCapture | undefined;
        }
      ).gpuPassTimingCapture = capture;
    },
    get gpuPassTimingSubmittedWork() {
      return internals.gpuPassTimingSubmittedWork;
    },
    set gpuPassTimingSubmittedWork(completion: Promise<void> | undefined) {
      internals.gpuPassTimingSubmittedWork = completion;
    },
    get gpuPassTimingFrameIdentity() {
      return (
        internals as WebGPURendererInternals & {
          gpuPassTimingFrameIdentity?:
            | import('../record/gpu-pass-timing/session.js').GpuPassTimingFrameIdentity
            | undefined;
        }
      ).gpuPassTimingFrameIdentity;
    },
    set gpuPassTimingFrameIdentity(identity:
      | import('../record/gpu-pass-timing/session.js').GpuPassTimingFrameIdentity
      | undefined,) {
      (
        internals as WebGPURendererInternals & {
          gpuPassTimingFrameIdentity?:
            | import('../record/gpu-pass-timing/session.js').GpuPassTimingFrameIdentity
            | undefined;
        }
      ).gpuPassTimingFrameIdentity = identity;
    },
    get gpuPassTimingBeginReason() {
      return (
        internals as WebGPURendererInternals & {
          gpuPassTimingBeginReason?: GpuPassTimingReason | undefined;
        }
      ).gpuPassTimingBeginReason;
    },
    set gpuPassTimingBeginReason(reason: GpuPassTimingReason | undefined) {
      (
        internals as WebGPURendererInternals & {
          gpuPassTimingBeginReason?: GpuPassTimingReason | undefined;
        }
      ).gpuPassTimingBeginReason = reason;
    },
    getRenderTargetPhysical: (target) => renderTargetHost.getPhysicalTarget(target),
    resolveRenderTargetTextureSource: (source) =>
      renderTargetHost.resolveRenderTargetTextureSource(source),
    encodeRenderTargetReadbacks: (encoder, faces) =>
      renderTargetHost.encodePendingReadbacks(encoder, faces),
    get volumetricFogShaders() {
      return internals.volumetricFogShaders;
    },
  });
  attachGpuPassTimingSession(internals, gpuPassTimingSession);
  renderSystemForTargetPromotion = renderSystem;
  if (
    internals.device.caps.backendKind === 'null' &&
    Array.from(getShader().entries()).length === 0
  ) {
    // RhiNull validates graph topology only; keep the built-in identity
    // registered so structural frames do not fail before graph inspection.
    renderSystem.registerBuiltinPostProcess(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID, {
      source: '',
      params: { byteSize: 16, defaultValue: new Uint8Array(16) },
      reads: ['hdrColor'],
    });
  }
  // The Standard pipeline is the sole built-in graph owner. Feature plans are
  // projected into that graph directly; no second post-process registry is
  // installed for fullscreen producers.
  renderSystem.configureStandard(undefined);
  renderSystem.restorePostProcessResources();
  const attachedWorlds = new Set<World>();
  const attachedLeases = new Map<RenderReadLease, World>();
  const leasesByWorld = new Map<World, RenderReadLease>();
  const dynamicGeometry = createDynamicGeometryLifecycle();
  const dynamicGeometryHost = createDynamicGeometryHost({
    lifecycle: dynamicGeometry,
    attachedWorlds,
    getGpuStore: () => gpuStore,
    currentGeneration: () => activeDeviceScope.generation,
    onTopologyChanged: () => renderSystem.invalidateGeometryHistory(),
    isConsumedByRenderFrame: (candidate) =>
      renderSystem.isDynamicGeometryConsumed(
        candidate.world as World,
        candidate.entity ?? -1,
        candidate.meshHandle,
      ),
  });
  const derivedSystemNames = new Map<World, string>();
  const transformReleases = new Map<World, () => void>();
  const attachmentOwner = {};
  let frameId = 0;
  // Receipts remain observable until their device generation is retired. A
  // registry avoids invalidating a still-valid frame merely because another
  // submission completed in the meantime.
  const currentReceipts = new Set<FrameReceipt>();
  const issuedReceipts = new WeakSet<FrameReceipt>();
  const receiptTimings = new WeakMap<FrameReceipt, Promise<VolumeTimingObservation>>();
  let latestReceipt: FrameReceipt | undefined;
  let surfaceReleased = false;
  const renderer: RendererAssemblyImplementation = {
    attach(world: World): RenderResult<RenderWorldLease, RenderError> {
      const attached = this.attachScene(world);
      if (!attached.ok) {
        return err(new RendererContractFailureError('attach', attached.error.hint));
      }
      const lease = createRenderReadLease(world, attachmentOwner);
      attachedLeases.set(lease, world);
      leasesByWorld.set(world, lease);
      return ok(lease);
    },
    ...dynamicGeometryHost,
    createRenderTarget: (descriptor) => renderTargetHost.createRenderTarget(descriptor),
    resizeRenderTarget: (target, descriptor) =>
      renderTargetHost.resizeRenderTarget(target, descriptor),
    createRenderTargetTextureSource: (target, options) =>
      renderTargetHost.createRenderTargetTextureSource(target, options),
    requestTargetReadback: (target, request) =>
      renderTargetHost.requestTargetReadback(target, request),
    destroyRenderTarget: (target) => renderTargetHost.destroyRenderTarget(target),
    setProfile(profile: RenderProfile): RenderResult<void, RenderError> {
      const invalid = validateRenderProfile(profile);
      if (invalid !== undefined) {
        return err(
          new RendererOperationError('frame-input-invalid', {
            operation: 'set-profile',
            cause: new RendererContractFailureError('draw', invalid),
          }),
        );
      }
      const previous = activeProfile;
      activeProfile = freezeRenderProfile(profile);
      try {
        renderSystem.configureStandard(undefined);
        return ok(undefined);
      } catch (cause) {
        activeProfile = previous;
        return err(
          new RendererOperationError('graph-build-failed', {
            operation: 'set-profile',
            cause: structuredRendererCause(cause, 'set-profile'),
          }),
        );
      }
    },
    inspectLodOcclusion() {
      return {
        lodOcclusion: renderSystem.lodOcclusionInspection,
        gpuDriven: renderSystem.gpuDrivenInspection,
      };
    },
    inspect(): RenderInspection {
      const health = internals.healthRegistry.getLastSnapshot();
      const deviceLost = health.reason === 'device-lost';
      const state = disposed
        ? 'disposed'
        : deviceLost
          ? 'device-lost'
          : health.reason === 'internal-fault' || !readySettled
            ? 'faulted'
            : 'alive';
      const graph = deviceLost ? undefined : renderSystem.perFrameGraphInfo;
      const standardLighting = deviceLost ? undefined : renderSystem.standardLightingInspection;
      const bloom: BloomInspection = deviceLost
        ? {
            graphStatus: 'empty',
            enabled: false,
            targetCount: 0,
            targetBytes: 0,
            resourceCount: 0,
            passCount: 0,
            encodeCount: 0,
            bindGroupCount: 0,
            uploadCount: 0,
            residentChildBytes: 0,
            generation: 0,
            state: 'off',
          }
        : renderSystem.bloom;
      const surfaceStorage = pipelineState?.format ?? 'rgba8unorm';
      const surfaceDisplay = pipelineState?.colorAttachmentFormat ?? 'rgba8unorm';
      const observationId = `${STANDARD_OUTPUT_TRANSFORM_FEATURE_ID}:frame-${frameId}`;
      const outputInspection = projectRendererOutputInspection({
        graph,
        surfaceAvailable: !surfaceReleased && pipelineState !== null,
        surfaceStorage,
        surfaceDisplay,
        ...(pipelineState?.surfaceProfile === undefined
          ? {}
          : { surfaceProfile: pipelineState.surfaceProfile }),
        rgba16floatRenderable: internals.device.caps.rgba16floatRenderable,
        ...(internals.context?.presentationProof === undefined
          ? {}
          : { presentationProof: internals.context.presentationProof }),
      });
      const volumetricFog = renderSystem.volumetricFog;
      const directionalShadow = renderSystem.directionalShadow;
      const recoveryEvidence = renderSystem.recoveryEvidence;
      return Object.freeze({
        state,
        recovery: recoveryInspection,
        surface: surfaceReleased ? 'released' : 'available',
        profile: activeProfile,
        capabilities: Object.freeze({ ...internals.device.caps }),
        frame: Object.freeze({
          frameId,
          deviceGeneration: activeDeviceScope.generation,
        }),
        features: Object.freeze(
          (internals.featureHost?.features ?? []).map((feature) => feature.identity),
        ),
        featureDiagnostics: internals.featureHost?.diagnostics() ?? Object.freeze([]),
        frustumStats: Object.freeze({ ...renderSystem.frustumStats }),
        visibilityStats: Object.freeze({ ...renderSystem.visibilityStats }),
        instanceCollections: Object.freeze(
          renderSystem.instanceCollectionsInspection.map((collection) =>
            Object.freeze({
              ...collection,
              uploadRanges: Object.freeze(
                collection.uploadRanges.map((range) => Object.freeze({ ...range })),
              ),
              ...(collection.error === undefined
                ? {}
                : {
                    error: Object.freeze({
                      ...collection.error,
                      detail: Object.freeze({ ...collection.error.detail }),
                    }),
                  }),
            }),
          ),
        ),
        dynamicGeometry: dynamicGeometry.inspect(),
        renderScene: renderSystem.renderScene,
        reflectionProbes: renderSystem.reflectionProbes,
        ssrDependencies: renderSystem.ssrDependencies,
        volumetricFog,
        environment: renderSystem.environment,
        temporal: renderSystem.temporal,
        bloom,
        extendedLighting: projectExtendedLightingInspection(extendedLightingState),
        directionalShadow,
        ...(renderSystem.temporalTargetInspection === undefined
          ? {}
          : { temporalTarget: Object.freeze(renderSystem.temporalTargetInspection) }),
        ...(renderSystem.motionBlurInspection === undefined
          ? {}
          : { motionBlur: Object.freeze(renderSystem.motionBlurInspection) }),
        ...(renderSystem.lodOcclusionInspection === undefined
          ? {}
          : { lodOcclusion: Object.freeze(renderSystem.lodOcclusionInspection) }),
        ...(renderSystem.transmission === undefined
          ? {}
          : { transmission: renderSystem.transmission }),
        ...(standardLighting === undefined
          ? {}
          : { standardLighting: Object.freeze({ ...standardLighting }) }),
        ...(renderSystem.pointShadowInspection === undefined
          ? {}
          : { pointShadow: Object.freeze({ ...renderSystem.pointShadowInspection }) }),
        meshMaterialBindings: Object.freeze(
          renderSystem.meshMaterialBindings.map((observation) =>
            Object.freeze({
              ...observation,
              bindings: Object.freeze(
                observation.bindings.map((binding) => Object.freeze({ ...binding })),
              ),
              diagnostics: Object.freeze(
                observation.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })),
              ),
            }),
          ),
        ),
        perFramePassNames: Object.freeze(graph?.passes.map((pass) => pass.name) ?? []),
        bindGroupCounts: Object.freeze({
          createBindGroup: renderSystem.bindGroupCounts.createBindGroup,
          keys: Object.freeze([...renderSystem.bindGroupCounts.keys]),
        }),
        recoveryEvidence: Object.freeze({
          ...recoveryEvidence,
          graph: deviceLost
            ? { ready: false, generation: 0, passCount: 0, resourceCount: 0 }
            : recoveryEvidence.graph,
          producerRoots: Object.freeze([...recoveryEvidence.producerRoots]),
          receipts: Object.freeze({
            count: frameId,
            lastGeneration: latestReceipt?.deviceGeneration,
          }),
        }),
        ...outputInspection,
        observation: Object.freeze({
          observationId,
          frameId,
          ...(renderSystem.lastSuccessfulCameraAntialias === undefined
            ? {}
            : { antialias: renderSystem.lastSuccessfulCameraAntialias }),
          ...(outputInspection.surfaceProfile === undefined
            ? {}
            : { surfaceProfile: outputInspection.surfaceProfile }),
          rgba16floatRenderable: internals.device.caps.rgba16floatRenderable,
          passNames: Object.freeze([...outputInspection.graphPassNames]),
          ...(outputInspection.standardOutputColor === undefined
            ? {}
            : { standardOutputColor: Object.freeze({ ...outputInspection.standardOutputColor }) }),
        }),
      });
    },
    get device(): RhiDevice {
      return internals.device;
    },
    // Keep engine-owned shader consumers on the exact backend pack selected
    // for this renderer. Importing a backend adapter again from a
    // feature glue module can produce a second bundled module instance whose
    // RAW_DEVICE_MAP does not contain this opaque RhiDevice handle.
    _internal_createShaderModule:
      internals.pack.createShaderModule ??
      ((device, desc) => invokeDeviceCreateShaderModule(device, desc)),
    _internal_setRenderOverlay(overlay) {
      if (overlay === undefined) {
        delete internals.debugOverlay;
      } else {
        internals.debugOverlay = overlay;
      }
    },
    assetRegistry: assets,
    initialization: ready,
    attachScene(world: World): Result<void, RhiError> {
      if (disposed) {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'renderer not disposed before attaching a World',
            hint: 'rebuild the renderer before attaching another World',
          }),
        );
      }
      if (attachedWorlds.has(world)) return ok(undefined);
      try {
        const releaseTransforms = registerPropagateTransforms(world);
        const derivedSystemName = `renderDerived:${++nextDerivedSystemId}`;
        const derived = world.addSystem(Update, {
          name: derivedSystemName,
          queries: [],
          fn: (world) => {
            tilemapChunkExtractSystem(world, (guid) => assets.lookup(guid));
            const glyphResult = glyphTextLayoutSystem(world, gpuStore);
            if (!glyphResult.ok) throw glyphResult.error;
          },
        });
        if (!derived.ok) {
          releaseTransforms();
          throw new Error(`failed to register ${derivedSystemName}: ${derived.error.code}`);
        }
        transformReleases.set(world, releaseTransforms);
        derivedSystemNames.set(world, derivedSystemName);
        attachedWorlds.add(world);
        return ok(undefined);
      } catch (cause) {
        const error = new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'renderer.attach(world) installs derived-state systems once',
          hint: 'inspect the World schedule registration or derived-state system failure',
          detail: {
            error: {
              code: 'unknown',
              message: cause instanceof Error ? cause.message : String(cause),
              ...(cause instanceof Error ? { name: cause.name } : {}),
            },
          },
        });
        internals.errorRegistry.fire(error);
        return err(error);
      }
    },
    detachScene(world: World): void {
      if (!attachedWorlds.delete(world)) return;
      dynamicGeometryHost.invalidateDynamicGeometryWorld(world);
      for (const [lease, leaseWorld] of attachedLeases) {
        if (leaseWorld === world) {
          lease.dispose();
          attachedLeases.delete(lease);
          leasesByWorld.delete(world);
        }
      }
      renderSystem.detachScene(world);
      const derivedSystemName = derivedSystemNames.get(world);
      if (derivedSystemName !== undefined) {
        world.removeSystem(Update, derivedSystemName);
        derivedSystemNames.delete(world);
      }
      transformReleases.get(world)?.();
      transformReleases.delete(world);
    },
    observeCurrentFrame(options: FrameObservationOptions) {
      return renderSystem.observeCurrentFrame(options);
    },
    getCurrentGraphTarget(name: string) {
      return renderSystem.getCurrentGraphTarget(name);
    },
    requestGraphTargetCapture(request) {
      renderSystem.requestGraphTargetCapture(request);
    },
    get frustumStats() {
      return renderSystem.frustumStats;
    },
    get visibilityStats() {
      return renderSystem.visibilityStats;
    },
    get renderScene() {
      return renderSystem.renderScene;
    },
    get meshMaterialBindings() {
      return renderSystem.meshMaterialBindings;
    },
    get perFramePassNames() {
      return renderSystem.perFramePassNames;
    },
    get bindGroupCounts() {
      return renderSystem.bindGroupCounts;
    },
    configureStandard(config) {
      renderSystem.configureStandard(config);
    },
    renderFeatureDiagnostics() {
      return internals.featureHost?.diagnostics() ?? [];
    },
    async installRenderFeature(
      feature: RenderFeature<unknown>,
    ): Promise<RenderResult<void, RenderError>> {
      if (disposed) {
        return err(
          new RenderFeatureStageFailedError(feature.identity, -1, 'extract', 'registration'),
        );
      }
      const host = internals.featureHost;
      if (host === undefined) {
        return err(
          new RenderFeatureStageFailedError(feature.identity, -1, 'extract', 'registration'),
        );
      }
      const missingCapability = feature.requiredCapabilities?.find(
        (capability) => internals.device.caps[capability] !== true,
      );
      if (missingCapability !== undefined) {
        return err(
          new RenderFeatureCapabilityMissingError(feature.identity, host.size, missingCapability),
        );
      }
      let nextRequiredFullscreenPostProcesses: readonly {
        readonly identity: string;
        readonly source: string;
      }[];
      try {
        nextRequiredFullscreenPostProcesses = collectRequiredFullscreenPostProcesses([
          ...host.features,
          feature,
        ]);
      } catch (cause) {
        const conflict =
          cause instanceof RhiError
            ? cause
            : new RhiError({
                code: 'internal-error',
                expected: 'fullscreen feature declarations are internally consistent',
                hint: 'repair the conflicting fullscreen identity/source declarations',
              });
        internals.errorRegistry.fire(conflict);
        return err(
          new RenderFeatureStageFailedError(feature.identity, -1, 'prepare', 'registration'),
        );
      }
      const fullscreenPrewarm = await prewarmFullscreenFeatureModules(feature);
      if (!fullscreenPrewarm.ok) {
        return err(
          new RenderFeatureStageFailedError(feature.identity, -1, 'prepare', 'registration'),
        );
      }
      for (const materialShaderId of feature.requiredMaterialShaders ?? []) {
        const lookup = getShader().findMaterialArtifact(materialShaderId);
        if (!lookup.ok) {
          const error = new RhiError({
            code: 'shader-compile-failed',
            expected: `declared render feature material shader '${materialShaderId}' is present in the loaded manifest`,
            hint: `add material shader '${materialShaderId}' to the shader manifest or remove it from the feature declaration`,
          });
          internals.errorRegistry.fire(error);
          return err(
            new RenderFeatureStageFailedError(feature.identity, -1, 'prepare', 'registration'),
          );
        }
        const label = `module-${materialShaderId}`;
        const moduleResult = internals.pack.createShaderModule
          ? await internals.pack.createShaderModule(internals.device, {
              code: lookup.value.source,
              label,
            })
          : await invokeDeviceCreateShaderModule(internals.device, {
              code: lookup.value.source,
              label,
            });
        if (!moduleResult.ok) {
          internals.errorRegistry.fire(moduleResult.error);
          return err(
            new RenderFeatureStageFailedError(feature.identity, -1, 'prepare', 'registration'),
          );
        }
        getShaderModuleAdapter().seedModule(label, moduleResult.value);
      }
      const installed = host.install(feature);
      if (!installed.ok) return installed;
      if (installed.ok) {
        for (const materialShaderId of feature.requiredMaterialShaders ?? []) {
          requiredMaterialShaderSet.add(materialShaderId);
        }
        requiredMaterialShaders = Object.freeze([...requiredMaterialShaderSet]);
        requiredFullscreenPostProcesses = nextRequiredFullscreenPostProcesses;
      }
      return installed;
    },
    async uninstallRenderFeature(
      feature: RenderFeature<unknown>,
    ): Promise<RenderResult<void, RenderError>> {
      const host = internals.featureHost;
      if (disposed || host === undefined) {
        return err(
          new RenderFeatureStageFailedError(feature.identity, -1, 'dispose', 'registration'),
        );
      }
      try {
        await internals.device.queue.onSubmittedWorkDone();
      } catch {
        return err(
          new RenderFeatureStageFailedError(feature.identity, -1, 'dispose', 'registration'),
        );
      }
      const removed = host.uninstall(feature);
      if (removed.ok) {
        requiredMaterialShaderSet.clear();
        for (const remaining of host.features) {
          for (const materialShaderId of remaining.requiredMaterialShaders ?? []) {
            requiredMaterialShaderSet.add(materialShaderId);
          }
        }
        requiredMaterialShaders = Object.freeze([...requiredMaterialShaderSet]);
        requiredFullscreenPostProcesses = collectRequiredFullscreenPostProcesses(host.features);
      }
      return removed;
    },
    drawFrame(request: RenderFrameInput): RenderResult<FrameReceipt, RhiError | RenderError> {
      const result = this.draw(request);
      if (!result.ok) return result;
      return result.value === undefined
        ? err(
            new RendererContractFailureError(
              'draw',
              'the lease-bound draw path must return a FrameReceipt after submit',
            ),
          )
        : ok(result.value);
    },
    draw(
      worldsOrRequest: readonly World[] | RenderFrameInput,
      options?: DrawOwnerOptions,
    ): Result<void | FrameReceipt, RhiError | RenderError> {
      const isFrameRequest = !Array.isArray(worldsOrRequest);
      const frameRequest = isFrameRequest ? (worldsOrRequest as RenderFrameInput) : undefined;
      const worlds: readonly World[] =
        frameRequest !== undefined
          ? frameRequest.leases
              .map((lease) => attachedLeases.get(lease))
              .filter((world): world is World => world !== undefined)
          : (worldsOrRequest as readonly World[]);
      const readLeases: readonly RenderReadLease[] | undefined =
        frameRequest !== undefined
          ? frameRequest.leases
          : worlds.map((world) => leasesByWorld.get(world)).every((lease) => lease !== undefined)
            ? worlds.map((world) => leasesByWorld.get(world) as RenderReadLease)
            : undefined;
      for (const world of worlds) {
        if (!world.hasResource('PhysicsWorld')) continue;
        const physics = world.getResource<{
          readonly getDerivedAdmission?: () => unknown;
          readonly getDerivedRecoveryState?: () => string;
        }>('PhysicsWorld');
        if (
          physics?.getDerivedAdmission?.() !== undefined ||
          physics?.getDerivedRecoveryState?.() === 'rebuild-required'
        ) {
          return err(
            new RendererOperationError('frame-input-invalid', {
              operation: 'draw',
              cause: new RendererContractFailureError(
                'draw',
                'paired geometry admission must finish physics step and writeback in a healthy World before draw',
              ),
            }),
          );
        }
      }
      if (frameRequest !== undefined && worlds.length !== frameRequest.leases.length) {
        return err(
          new RendererOperationError('world-lease-invalid', {
            operation: 'draw',
            cause: new RendererContractFailureError(
              'draw',
              'every RenderFrameInput lease must be attached to this Renderer',
            ),
          }),
        );
      }
      const cameraOwner =
        frameRequest === undefined ? -1 : frameRequest.leases.indexOf(frameRequest.camera.lease);
      const resourceOwner =
        frameRequest === undefined
          ? -1
          : frameRequest.leases.indexOf(frameRequest.environment.lease);
      if (frameRequest !== undefined && (cameraOwner < 0 || resourceOwner < 0)) {
        return err(
          new RendererOperationError('frame-input-invalid', {
            operation: 'draw',
            cause: new RendererContractFailureError(
              'draw',
              cameraOwner < 0
                ? 'camera lease must be present in RenderFrameInput.leases'
                : 'environment lease must be present in RenderFrameInput.leases',
            ),
          }),
        );
      }
      const drawOptions: DrawOwnerOptions =
        frameRequest !== undefined
          ? {
              cameraOwner,
              resourceOwner,
              ...(frameRequest.profileFrame === undefined
                ? {}
                : { profileFrame: frameRequest.profileFrame }),
            }
          : (options ?? { cameraOwner: 0, resourceOwner: 0 });
      // feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M5 / w21
      // (plan-strategy D-1, D-8): post-dispose the renderer is dead. AI
      // users observing `result.ok === false && err.code === 'rhi-not-
      // available'` know to rebuild the renderer (mirrors the "ready not
      // settled" + "pipelineState null" fail-fast paths below; reuses the
      // existing closed-union member, no new ErrorCode introduced).
      if (disposed) {
        const e = new RhiError({
          code: 'rhi-not-available',
          expected:
            'renderer not disposed before calling renderer.draw(worlds, { cameraOwner, resourceOwner })',
          hint: 'renderer.dispose() flipped the lifecycle latch; rebuild via createRenderer / Engine.create',
        });
        internals.errorRegistry.fire(e);
        return err(e);
      }
      if (surfaceReleased) {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'renderer surface restored before drawing',
            hint: 'call renderer.restoreSurface() after the temporary surface owner stops',
          }),
        );
      }
      // M2 / w9 (A-IN-5): device-lost guard — draw() silently returns err
      // without firing onError each frame. The device-lost channel fires once
      // through the dual-channel fan-out (:750-797); draw() does not repeat it
      // (canvas holds previous frame). Host observes health().reason ===
      // 'device-lost' and calls recover() when ready.
      if (internals.healthRegistry.getLastSnapshot().reason === 'device-lost') {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'GPUDevice is lost; recover() to rebuild and resume rendering',
            hint: 'call renderer.recover() after a host-chosen delay; camera holds previous frame',
          }),
        );
      }
      // D-S4: ready not settled => fire onError + skip frame. Uses
      // 'rhi-not-available' (closed union placeholder semantics; charter
      // proposition 4 explicit failure - AI users observe through onError
      // and decide whether to retry).
      if (!readySettled) {
        const e = new RhiError({
          code: 'rhi-not-available',
          expected:
            'await renderer.initialization before calling renderer.draw(worlds, { cameraOwner, resourceOwner })',
          hint: 'await renderer.initialization resolves once the manifest / pipeline / asset upload chain completes',
        });
        internals.errorRegistry.fire(e);
        return err(e);
      }
      // pipeline build rejected: ready Promise has already surfaced the
      // structured error to AI users through `await renderer.initialization`. Skip
      // to keep draw(world) idempotent; a transient retry next frame is
      // the responsibility of the AI user (charter proposition 9).
      if (pipelineState === null) {
        const e = new RhiError({
          code: 'rhi-not-available',
          expected: 'pipelineState built during Renderer.initialization',
          hint: 'await renderer.initialization resolved successfully; rebuild renderer or fix the upstream RhiError',
        });
        internals.errorRegistry.fire(e);
        return err(e);
      }
      // feat-20260708-composited-multi-world-rendering M3 / D-5: draw-args
      // entry validation runs before each extract or context configuration.
      // Empty worlds / owner out of range returns a structured Result.err
      // (never silent, charter P3) without touching GPU state. The two codes
      // are non-exclusive: an empty array short-circuits to empty-worlds. The
      // check is defensive against JS callers passing a non-array despite the
      // compile-time World[] type (red-window migration safety).
      const worldCount = Array.isArray(worlds) ? worlds.length : 0;
      if (worldCount === 0 && internals.device.caps.backendKind === 'null') {
        return ok(undefined);
      }
      // Validate both owner indices (cameraOwner before resourceOwner, first
      // offender wins). The empty object only protects the JS boundary; it is
      // rejected by the same validation and never becomes another draw shape.
      const drawOwners = drawOptions;
      const argsCheck = validateDrawArgs(worldCount, drawOwners);
      if (!argsCheck.ok) {
        internals.errorRegistry.fire(argsCheck.error);
        return argsCheck;
      }
      // Configure context lazily on first draw (D-S1 single-point
      // exemption): GPUCanvasContext.configure({device}) needs a raw
      // The canvas context is configured through the RHI device scope.
      const contextConfigured = ensureContextConfigured(
        internals,
        pipelineState,
        internals.errorRegistry,
      );
      if (!contextConfigured.ok) return contextConfigured;
      renderTargetHost.beginFrame();
      // w24 — facade-level try/catch produces Result.err on unexpected throw
      // (D-P6 dual-channel preserved: per-stage RhiError continues to fan out
      // through onError separately; the facade Result is the synchronous
      // summary AI users can ignore or branch on).
      try {
        const timingHost = internals as WebGPURendererInternals & {
          gpuPassTimingFrameIdentity?:
            | {
                readonly frameId: number;
                readonly deviceGeneration: number;
                readonly graphGeneration: number;
              }
            | undefined;
          gpuPassTimingCapture?: GpuPassTimingCapture | undefined;
          gpuPassTimingSubmittedWork?: Promise<void> | undefined;
          gpuPassTimingBeginReason?: GpuPassTimingReason | undefined;
        };
        const timingRequested =
          isFrameRequest &&
          (frameRequest?.profileFrame !== undefined ||
            internals.options?.captureGpuTimings === true);
        let volumeTimingCapture: GpuTimingCapture | undefined;
        const volumeTimingUnavailableReason = timingRequested
          ? 'timestamp capture is unavailable on this device'
          : 'timestamp capture was not requested for this frame';
        if (timingRequested && gpuPassTimingOptions === undefined) {
          const createdTiming = GpuTimingCapture.create(internals.device);
          if (createdTiming.ok) volumeTimingCapture = createdTiming.value;
        }
        if (isFrameRequest) {
          timingHost.gpuPassTimingFrameIdentity = {
            frameId: frameId + 1,
            deviceGeneration: activeDeviceScope.generation,
            graphGeneration: 0,
          };
        }
        const submitted = renderSystem.draw(worlds, drawOptions, readLeases, volumeTimingCapture);
        timingHost.gpuPassTimingFrameIdentity = undefined;
        if (!submitted) {
          volumeTimingCapture?.discard();
          return err(
            new RendererContractFailureError(
              'draw',
              'the Standard render owner did not submit a command buffer; inspect Renderer error events and recover the owning frame path',
            ),
          );
        }
        const timingCompletion = timingHost.gpuPassTimingSubmittedWork;
        timingHost.gpuPassTimingSubmittedWork = undefined;
        const reflectionFallbackCompletion = renderSystem.reflectionFallbackCompletion;
        const queueCompletion = timingCompletion ?? internals.device.queue.onSubmittedWorkDone();
        gpuStore.trackMeshSubmission(queueCompletion);
        internals.pack.instrumentation?.onFrameBoundary?.();
        if (!isFrameRequest) {
          renderTargetHost.onFrameSubmitted();
          return ok(undefined);
        }
        const receiptFrameId = ++frameId;
        const receiptGeneration = activeDeviceScope.generation;
        const completion: FrameReceipt['completed'] = Promise.all([
          queueCompletion,
          reflectionFallbackCompletion ?? Promise.resolve(),
        ])
          .then(() => ok(undefined))
          .catch((cause: unknown) =>
            err(
              new RendererOperationError('device-operation-failed', {
                operation: 'complete-frame',
                frameId: receiptFrameId,
                deviceGeneration: receiptGeneration,
                cause: structuredRendererCause(cause, 'complete-frame'),
              }),
            ),
          );
        const continuation = createContinuationTerminator();
        frameContinuations.add(continuation);
        const guardedCompletion = completion.then(
          () =>
            continuation.guard('queue-completion')
              ? ok(undefined)
              : err(
                  new RendererOperationError('device-operation-failed', {
                    operation: 'complete-frame',
                    frameId: receiptFrameId,
                    deviceGeneration: receiptGeneration,
                    cause: structuredRendererCause(
                      {
                        code: 'stale-generation',
                        expected: 'frame completion belongs to its device generation',
                        hint: 'discard the stale receipt',
                      },
                      'complete-frame',
                    ),
                  }),
                ),
          (cause: unknown) =>
            err(
              new RendererOperationError('device-operation-failed', {
                operation: 'complete-frame',
                frameId: receiptFrameId,
                deviceGeneration: receiptGeneration,
                cause: structuredRendererCause(cause, 'complete-frame'),
              }),
            ),
        );
        const terminated = continuation.promise().then((reason) =>
          err(
            new RendererOperationError('device-operation-failed', {
              operation: 'complete-frame',
              frameId: receiptFrameId,
              deviceGeneration: receiptGeneration,
              cause: structuredRendererCause(
                {
                  code: reason.code,
                  expected: 'a frame continuation completes before device loss or disposal',
                  hint: 'discard the stale receipt and inspect the current renderer generation',
                  detail: reason,
                },
                'complete-frame',
              ),
            }),
          ),
        );
        const completed: FrameReceipt['completed'] = Promise.race([
          guardedCompletion,
          terminated,
        ]).finally(() => {
          frameContinuations.delete(continuation);
        });
        const receipt = Object.freeze({
          frameId: receiptFrameId,
          deviceGeneration: receiptGeneration,
          completed,
        });
        renderTargetHost.onFrameSubmitted(completed);
        latestReceipt = receipt;
        const passTimingCapture = timingHost.gpuPassTimingCapture;
        const timingBeginReason = timingHost.gpuPassTimingBeginReason;
        const timingSource =
          passTimingCapture === undefined
            ? gpuPassTimingUnavailable === undefined && timingBeginReason === undefined
              ? undefined
              : async (): Promise<GpuPassTimingObservation> =>
                  gpuPassTimingUnavailable ??
                  failedGpuPassTimingObservation(timingBeginReason as GpuPassTimingReason)
            : async (): Promise<GpuPassTimingObservation> => {
                const observed = await passTimingCapture.observe();
                if (!observed.ok) return failedGpuPassTimingObservation(observed.error);
                const frame = observed.value;
                const unmeasured = frame.passes.find((pass) => pass.status === 'unmeasured');
                if (unmeasured !== undefined) {
                  return { status: 'partial', frame, reason: unmeasured.reason };
                }
                if (frame.droppedPassCount > 0) {
                  return {
                    status: 'partial',
                    frame,
                    reason: {
                      code: 'query-budget-exceeded',
                      expected: 'all executed passes fit within the bounded query budget',
                      hint: 'increase maxPassesPerFrame or simplify the pass graph',
                      detail: { droppedPassCount: frame.droppedPassCount },
                    },
                  };
                }
                return { status: 'complete', frame };
              };
        timingObservationStore?.register(receipt, timingSource);
        currentReceipts.add(receipt);
        if (timingRequested && gpuPassTimingOptions === undefined) {
          receiptTimings.set(
            receipt,
            volumeTimingCapture?.observation() ??
              Promise.resolve({
                status: 'unavailable',
                reason: volumeTimingUnavailableReason,
              }),
          );
        }
        issuedReceipts.add(receipt);
        dynamicGeometryHost.publishDynamicGeometry(receipt, worlds, frameRequest?.fixedStep);
        return ok(receipt);
      } catch (cause) {
        const error =
          cause instanceof Error
            ? { code: 'unknown' as const, message: cause.message, name: cause.name }
            : { code: 'unknown' as const, message: String(cause) };
        const e = new RhiError({
          code: 'webgpu-runtime-error',
          expected:
            'renderSystem.draw(worlds, { cameraOwner, resourceOwner }) completes without throwing',
          hint: `RenderSystem internal error: ${error.message}`,
          detail: { error },
        });
        internals.errorRegistry.fire(e);
        return err(e);
      }
    },
    async observe(
      receipt: FrameReceipt,
      request: FrameObservationRequest,
    ): Promise<RenderResult<FrameReceiptObservation, RenderError>> {
      if (gpuPassTimingOptions !== undefined) {
        return timingObservationStore === undefined
          ? observeGpuPassTimingDisabled(receipt, request, () => activeDeviceScope.generation)
          : timingObservationStore.observe(receipt, request);
      }
      if (
        !currentReceipts.has(receipt) ||
        !issuedReceipts.has(receipt) ||
        receipt.deviceGeneration !== activeDeviceScope.generation
      ) {
        const currentGeneration = activeDeviceScope.generation;
        return err(
          new FrameReceiptStaleError({
            frameId: receipt.frameId,
            receiptGeneration: receipt.deviceGeneration,
            currentGeneration,
          }),
        );
      }
      const completed = await receipt.completed;
      if (!completed.ok) return completed;
      const currentGeneration = activeDeviceScope.generation;
      if (receipt.deviceGeneration !== currentGeneration) {
        return err(
          new FrameReceiptStaleError({
            frameId: receipt.frameId,
            receiptGeneration: receipt.deviceGeneration,
            currentGeneration,
          }),
        );
      }
      await renderSystem.observeLodOcclusion();
      const targetReadbacks =
        request.targetReadbacks === undefined || request.targetReadbacks.length === 0
          ? undefined
          : await renderTargetHost.observeTargetReadbacks(receipt, request.targetReadbacks);
      if (targetReadbacks !== undefined && !targetReadbacks.ok) return targetReadbacks;
      const volumeTimings = request.include.includes('timings')
        ? await (receiptTimings.get(receipt) ??
            Promise.resolve<VolumeTimingObservation>({
              status: 'unavailable',
              reason: 'timestamp capture was not requested for this frame',
            }))
        : undefined;
      return ok(
        Object.freeze({
          frameId: receipt.frameId,
          deviceGeneration: receipt.deviceGeneration,
          include: Object.freeze([...request.include]),
          ...(targetReadbacks === undefined
            ? {}
            : { targetReadbacks: Object.freeze(targetReadbacks.value) }),
          ...(volumeTimings === undefined ? {} : { volumeTimings }),
        }),
      );
    },
    releaseSurface(): Result<void, RhiError> {
      if (surfaceReleased) return ok(undefined);
      if (disposed) {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'live renderer before releasing its surface',
            hint: 'create a new Renderer; disposed renderers are terminal',
          }),
        );
      }
      try {
        internals.context.unconfigure();
        if (pipelineState !== null) pipelineState.perPassResources.configured = false;
        surfaceReleased = true;
        return ok(undefined);
      } catch (cause) {
        return err(wrapDisposeError(cause, 'context.unconfigure'));
      }
    },
    restoreSurface(): Result<void, RhiError> {
      if (!surfaceReleased) return ok(undefined);
      if (disposed) {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'live renderer before restoring its surface',
            hint: 'create a new Renderer; disposed renderers are terminal',
          }),
        );
      }
      surfaceReleased = false;
      return ok(undefined);
    },
    /**
     * Release every GPU resource the renderer owns + detach the listener
     * registries; flip the `disposed` latch so subsequent `draw(world)`
     * calls fail-fast with `'rhi-not-available'`.
     *
     * feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M5 / w21
     * 6-step cascade (plan-strategy D-2 ordering):
     *   1. `context.unconfigure()`           -- release the current surface image
     *   2. `gpuStore.destroyAll()`           -- texture / cubemap / mesh maps
     *   3. `renderSystem.disposeFrameState()` -- graph.drain() + instanceBuffers
     *   4. `featureHost.dispose()`           -- feature resources + lifecycle
     *   5. DeviceScope retirement -- generation-keyed IBL state becomes stale
     *   6. `lostRegistry.clear() / errorRegistry.clear()`
     *
     * Each step runs inside its own try/catch (D-3 method A): a sub-step
     * failure DOES NOT halt the cascade; the structured RhiError (or wrapped
     * runtime exception) fans out through `errorRegistry.fire` so AI users
     * observing Renderer error events see every dispose-time fault. The
     * `disposed` latch flips up-front so a re-entrant dispose (or a draw
     * that races with the cascade) short-circuits.
     *
     * NOT calling `device.destroy()` on the raw GPUDevice (w25 lesson from
     * feat-20260517-vite-plugin-image-build-time-cook CI-fix v4): w23
     * attempted to evict stale devices from the chromium WebGPU adapter
     * pool via `_internal_getRawDevice`, but the explicit destroy
     * accelerated pool poisoning -- after the first `dispose()` the
     * chromium adapter pool started recycling the just-destroyed device
     * into the next `requestDevice` so the NEXT test's `Engine.create`
     * resolved with `ready.error.code: 'device-lost'`. Cross-test isolation
     * moved to the vitest infra layer (`browser.isolate: true`) instead of
     * test code self-managing device lifecycle.
     *
     * Stays in sync with the `Renderer.dispose` row of the README "API index".
     */
    dispose(): RenderResult<void, RenderError> {
      if (disposed) return ok(undefined);
      disposed = true;
      for (const world of attachedWorlds) {
        dynamicGeometryHost.invalidateDynamicGeometryWorld(world);
      }
      dynamicGeometry.dispose();
      for (const continuation of frameContinuations) {
        continuation.terminate({ code: 'disposed' });
      }
      currentReceipts.clear();
      const cleanupFailures: RendererOperationCause[] = [];
      for (const world of attachedWorlds) {
        try {
          const derivedSystemName = derivedSystemNames.get(world);
          if (derivedSystemName !== undefined) {
            world.removeSystem(Update, derivedSystemName);
            derivedSystemNames.delete(world);
          }
          transformReleases.get(world)?.();
          transformReleases.delete(world);
        } catch (cause) {
          const error = wrapDisposeError(cause, 'world.removeSystem(renderDerived)');
          cleanupFailures.push(error);
          internals.errorRegistry.fire(error);
        }
      }
      attachedWorlds.clear();
      for (const lease of attachedLeases.keys()) {
        try {
          lease.dispose();
        } catch (cause) {
          const error = wrapDisposeError(cause, 'read-lease.dispose');
          cleanupFailures.push(error);
          internals.errorRegistry.fire(error);
        }
      }
      attachedLeases.clear();
      leasesByWorld.clear();
      // Release the current swap-chain image before destroying a resource
      // wrappers that may share its underlying device allocation. The wgpu
      // WebGL2 surface owns an explicit SurfaceTexture; leaving this until
      // after the resource sweep lets wasm drop it against a dead Surface.
      if (!surfaceReleased) {
        try {
          internals.context.unconfigure();
        } catch (cause) {
          const error = wrapDisposeError(cause, 'context.unconfigure');
          cleanupFailures.push(error);
          internals.errorRegistry.fire(error);
        }
      }
      try {
        renderTargetHost.dispose();
      } catch (cause) {
        const error = wrapDisposeError(cause, 'renderTargetHost.dispose');
        cleanupFailures.push(error);
        internals.errorRegistry.fire(error);
      }
      // Step 2: release every Buffer / Texture handle owned by the runtime
      // GPU residency layer (feat-20260601-device/gpu-residency-extraction).
      try {
        gpuStore.destroyAll();
      } catch (cause) {
        const error = wrapDisposeError(cause, 'gpuStore.destroyAll');
        cleanupFailures.push(error);
        internals.errorRegistry.fire(error);
      }
      // Step 3: drain the per-frame render-graph pool + the per-entity
      // instanceBuffers GPU storage cache. Both walks live on the
      // RenderSystem closure (frameState is closure-private).
      try {
        renderSystem.disposeFrameState();
      } catch (cause) {
        const error = wrapDisposeError(cause, 'renderSystem.disposeFrameState');
        cleanupFailures.push(error);
        internals.errorRegistry.fire(error);
      }
      try {
        renderSystem.releaseProfilerCatalog();
      } catch (cause) {
        const error = wrapDisposeError(cause, 'renderSystem.releaseProfilerCatalog');
        cleanupFailures.push(error);
        internals.errorRegistry.fire(error);
      }
      // Step 4: release feature-owned resources and invoke feature disposal
      // hooks after render-graph state has been drained. The host is already
      // idempotent, and its structured cleanup detail is preserved by the
      // error registry when a feature cleanup fails.
      try {
        const featureDispose = internals.featureHost?.dispose();
        if (featureDispose !== undefined && !featureDispose.ok) {
          cleanupFailures.push(featureDispose.error);
          internals.errorRegistry.fire(featureDispose.error);
        }
      } catch (cause) {
        const error = wrapDisposeError(cause, 'featureHost.dispose');
        cleanupFailures.push(error);
        internals.errorRegistry.fire(error);
      }
      // Retire assembly-owned device resources only after the surface and
      // renderer-owned GPU pools have been released. The wgpu WebGL2 surface
      // still needs a live device while `unconfigure()` presents its pending
      // image; disposing the scope first lets wasm finalizers race that
      // presentation and can surface a parking_lot panic in WebKit.
      try {
        activeDeviceScope.dispose();
      } catch (cause) {
        const error = wrapDisposeError(cause, 'activeDeviceScope.dispose');
        cleanupFailures.push(error);
        internals.errorRegistry.fire(error);
      }
      // Step 5: the IBL cache is keyed by the retired DeviceScope generation.
      // It is no longer reachable through the active renderer scope, while
      // the device teardown owns the child GPU handles.
      // Step 6: detach the listener registries so a post-dispose error
      // event (race with the spec layer) does not fan out to user-supplied
      // listeners (charter P3 explicit failure: post-dispose the renderer
      // is dead, no observable side-effects). Performed last so steps 1-5
      // can still surface failures through `errorRegistry.fire`.
      try {
        internals.lostRegistry.clear();
        internals.errorRegistry.clear();
      } catch (cause) {
        cleanupFailures.push(structuredRendererCause(cause, 'listenerRegistry.clear'));
      }
      return cleanupFailures.length === 0
        ? ok(undefined)
        : err(
            new RendererOperationError('cleanup-failed', {
              operation: 'dispose',
              causes: Object.freeze(cleanupFailures),
            }),
          );
    },
    onError(listener: RendererErrorListener): () => void {
      return internals.errorRegistry.add(listener);
    },
    subscribeHostEvents(listener) {
      const offError = internals.errorRegistry.add((error) => {
        listener(Object.freeze({ kind: 'error', error }));
      });
      const offHealth = internals.healthRegistry.add((health) => {
        listener(Object.freeze({ kind: 'health', health }));
      });
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        offError();
        offHealth();
      };
    },
    onLost(listener: RendererLostListener): () => void {
      return internals.lostRegistry.add(listener);
    },
    health(): HealthSnapshot {
      return internals.healthRegistry.getLastSnapshot();
    },
    recover(): Promise<Result<void, RecoverFailure>> {
      return recoveryFlight.run();
    },
  };
  /**
   * Publish a fully prepared generation and retire the previous owner set.
   *
   * This is deliberately synchronous: all candidate state is complete before
   * entering the function, and no callback or await is allowed between the
   * active-reference swap and the old-generation retirement. The candidate
   * carries its own shader adapters, pipeline caches, stores, hooks, and
   * post-process handles; a failed build never reaches this boundary.
   */
  const publishAndRetireRendererGeneration = (
    candidate: RendererGeneration,
    candidatePostProcessResources: RecoveryPostProcessResources,
    recoveryRootBundle: RecoveryRootBundle,
    recoveryGraphCandidate: RecoveryGraphCandidate | undefined,
    recoveryColdWorkGuard: RecoveryColdWorkGuard,
  ): void => {
    if (!candidate.scope.isAlive()) {
      throw new Error('Renderer generation candidate is not publishable.');
    }
    const previous = generationPublication.current;
    const previousBindings = previous?.producerBindings;
    const previousGpuStore = previousBindings?.gpuStore ?? gpuStore;
    const previousDynamicTextureStore =
      previousBindings?.dynamicTextureStore ?? dynamicTextureStore;
    const previousScope = previous?.scope ?? activeDeviceScope;
    // This is the first line of the synchronous publication boundary. The
    // candidate was already compiled and its setup work completed; now shed
    // lost-device RenderSystem owners before installing the candidate state.
    renderSystem.resetForRecover(previous?.pipeline, candidate.device);
    // Candidate readiness is the first point where the target owner may shed
    // old physical handles. Keep its device getter pinned to the old device,
    // but advance its generation so active targets enter their rebuild state;
    // this call is inside the same synchronous publication boundary.
    renderTargetGeneration = candidate.scope.generation;
    renderTargetHost.recover();
    // GPUCanvasContext is canvas-owned rather than generation-owned: the
    // candidate and previous RHI wrappers address the same underlying
    // context. Detach the previous configuration first, then configure the
    // candidate again after that detach. Otherwise the old wrapper's
    // unconfigure() can silently revoke the candidate's configuration while
    // candidate.perPassResources.configured still says true, producing a
    // submitted-but-black recovery frame.
    const previousContext = previous?.context ?? internals.context;
    candidate.pipeline.perPassResources.configured = false;
    previousContext.unconfigure();
    const configured = ensureContextConfigured(
      internals,
      candidate.pipeline,
      internals.errorRegistry,
      candidate.context,
      candidate.device,
    );
    if (!configured.ok) throw configured.error;
    internals.device = candidate.device;
    internals.context = candidate.context;
    publishRendererGeneration(candidate);
    renderTargetDevice = candidate.device;
    // Arm the first-frame guard before any publication code can resolve a
    // fallback pipeline or residency entry. Candidate preparation populated
    // these caches already; a miss here is a hard recovery failure, not an
    // opportunity to hide cold work inside the first visible frame.
    candidate.producerBindings.gpuStore.setRecoveryColdWorkGuard(recoveryColdWorkGuard);
    internals.recoveryColdWorkGuard = recoveryColdWorkGuard;
    if (recoveryGraphCandidate !== undefined) recoveryColdWorkGuard.arm();
    renderSystem.publishRecoveryPostProcessResources(candidatePostProcessResources);
    if (recoveryGraphCandidate !== undefined) {
      renderSystem.publishRecoveryGraphCandidate(recoveryGraphCandidate);
    }
    candidate.pipeline.perPassResources.commitBloomResources?.();
    recoveryRootBundle.publish();
    recoveryGraphCandidate?.markPublished();
    // RenderSystem owns frame/feature GPU state; the generation bindings own
    // residency stores; DeviceScope owns the remaining lifecycle roots. Their
    // retirement is intentionally centralized and ordered after publication.
    previousGpuStore.destroyAll();
    previousDynamicTextureStore.destroyAll();
    previousScope.retire();
  };
  rendererRecovery = createRendererRecovery({
    isDisposed: () => disposed,
    internals,
    getActiveDeviceScope: () => activeDeviceScope,
    getActiveShaderState: () => activeShaderState,
    getMaterialShaderUvSetCounts: () => materialShaderUvSetCounts,
    createRendererPipelineCacheState,
    getCandidateBuildState: () => candidateBuildState,
    setCandidateBuildState(state) {
      candidateBuildState = state;
    },
    getCandidateShaderState: () => candidateShaderState,
    setCandidateShaderState(state) {
      candidateShaderState = state;
    },
    getCandidatePipelineCacheState: () => candidatePipelineCacheState,
    setCandidatePipelineCacheState(state) {
      candidatePipelineCacheState = state;
    },
    getCandidateMaterialShaderUvSetCounts: () => candidateMaterialShaderUvSetCounts,
    setCandidateMaterialShaderUvSetCounts(state) {
      candidateMaterialShaderUvSetCounts = state;
    },
    setCandidateEmptyPostProcessBgl(layout) {
      candidateEmptyPostProcessBgl = layout;
    },
    getShader,
    assets,
    adaptMipmapShaderModuleFactory,
    buildPipeline,
    getMaterialShaderPipeline,
    getMaterialShaderPipelineEntry,
    getCachedMaterialShaderBindingContract,
    getParamSchema,
    getMaterialBindGroupLayout,
    metrics,
    buildPostProcessPipeline,
    renderSystem,
    createRecoveryFailureLocation,
    publishAndRetireRendererGeneration,
  });
  return renderer;
}
