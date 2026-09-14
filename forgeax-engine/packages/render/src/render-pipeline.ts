// @forgeax/engine-render - typed render-pipeline topology contract.
//
// `RenderPipeline` is the typed topology contribution used by the Standard host.
// The host owns the single active pipeline identity and its lifecycle; producers
// contribute graph declarations through this interface instead of publishing a
// second renderer authority.
//
// Naming note (requirements line 155): `RenderPipeline` here is the forgeax engine
// concept name. The RHI GPU `RenderPipeline` handle (`@forgeax/engine-rhi`) is a
// separate, internal opaque-handle type distinguished by module path (AGENTS.md RHI
// form rules - "opaque handles distinguished by module path"); it is not exposed to
// AI users. Files importing both alias the RHI one locally.
//
// Pipelines declare topology once through a typed builder. The renderer compiles,
// executes, retires, finishes, and submits the resulting graph.

import type {
  ColorValueDomain,
  GraphAccess,
  GraphResourceResolver,
  GraphTexture,
  GraphTextureDescriptor,
  GraphTextureView,
  GraphTextureViewDescriptor,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  RhiCaps,
  RhiError,
  RhiRenderPassEncoder,
  TextureFormat,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { Tonemap } from './components/camera';
import type { DirectionalShadowFilterLabel } from './components/directional-shadow-filter';
import type { RenderError } from './errors/render';
import type { RenderFeatureTargetKind } from './features/targets';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
} from './gpu-texture-usage';
import type { StandardTopologyInputValue } from './pipeline/standard-lighting/topology';
import { STANDARD_POST_STAGE_NAMES, type StandardProfile } from './pipeline/standard-profile';
import type { SurfaceProfile } from './record/render-context';
import type { RenderPipelineContext } from './render-contract';
import type { OcclusionFrameProjection } from './scene/visibility/occlusion-runtime';
import type { TransmissionDemand } from './transmission/projection';

export type { RenderPipelineContext } from './render-contract';

export type RenderColorDomain = 'linearHdr' | 'linearLdr' | 'displayEncoded';

/** Backend admission inputs used by the existing Render candidate owner. */
export interface DirectionalShadowBackendAdmissionInput {
  readonly backendKind: 'webgpu' | 'wgpu-webgl2' | 'null';
  readonly requested: 'off' | DirectionalShadowFilterLabel;
  readonly candidate: 'accepted' | 'failed';
  readonly lastKnownGood?: DirectionalShadowFilterLabel | undefined;
}

/** Bounded, truthful Directional effective-profile projection. */
export interface DirectionalShadowBackendAdmission {
  readonly requested: 'off' | DirectionalShadowFilterLabel;
  readonly effective: 'off' | DirectionalShadowFilterLabel | 'rhi-null-structural';
  readonly status: 'accepted' | 'fallback' | 'rejected';
  readonly fallbackReason?: 'webgl2-unsupported' | 'rhi-null-structural' | 'candidate-failed';
  readonly lastKnownGood: boolean;
  readonly pixelEvidence: 'available' | 'not-available';
}

/**
 * Resolve a Directional profile only after the selected production candidate
 * has been admitted. WebGL2 and RhiNull are the sole declared fallbacks;
 * capable candidate failure retains a compatible LKG and never silently maps
 * a failed PCSS request to PCF.
 */
export function resolveDirectionalShadowBackendAdmission(
  input: DirectionalShadowBackendAdmissionInput,
): DirectionalShadowBackendAdmission {
  if (input.requested === 'off') {
    return {
      requested: 'off',
      effective: 'off',
      status: 'accepted',
      lastKnownGood: false,
      pixelEvidence: 'not-available',
    };
  }
  if (input.backendKind === 'null') {
    return {
      requested: input.requested,
      effective: 'rhi-null-structural',
      status: 'fallback',
      fallbackReason: 'rhi-null-structural',
      lastKnownGood: false,
      pixelEvidence: 'not-available',
    };
  }
  if (input.backendKind === 'wgpu-webgl2') {
    const effective =
      input.requested === 'pcssMedium'
        ? 'pcf3'
        : input.requested === 'pcssHigh'
          ? 'pcf5'
          : input.requested;
    return {
      requested: input.requested,
      effective,
      status: effective === input.requested ? 'accepted' : 'fallback',
      ...(effective === input.requested ? {} : { fallbackReason: 'webgl2-unsupported' as const }),
      lastKnownGood: false,
      pixelEvidence: 'available',
    };
  }
  if (input.candidate === 'accepted') {
    return {
      requested: input.requested,
      effective: input.requested,
      status: 'accepted',
      lastKnownGood: false,
      pixelEvidence: 'available',
    };
  }
  if (input.lastKnownGood !== undefined) {
    return {
      requested: input.requested,
      effective: input.lastKnownGood,
      status: 'rejected',
      fallbackReason: 'candidate-failed',
      lastKnownGood: true,
      pixelEvidence: 'available',
    };
  }
  return {
    requested: input.requested,
    effective: input.requested,
    status: 'rejected',
    fallbackReason: 'candidate-failed',
    lastKnownGood: false,
    pixelEvidence: 'available',
  };
}

export interface ToneOutputContract {
  readonly input: RenderColorDomain;
  readonly toneMapped: boolean;
  readonly mapped: 'linearLdr';
  readonly finalCapture: 'displayEncoded';
  readonly exposureStage: 'linearHdr' | 'none';
}

export type RenderPostStageName = (typeof STANDARD_POST_STAGE_NAMES)[number];
export type RenderPostDomainStage = readonly [
  RenderPostStageName,
  ColorValueDomain,
  ColorValueDomain,
];

/**
 * Single post-stage domain contract shared by the Standard lighting lanes.
 * The selected scene domain for transparent geometry is explicit; every later
 * stage follows the same linear blend, output-transform, anti-alias, post-effect, and present sequence.
 */
export function resolvePostColorDomainContract(
  sceneDomain: 'linear-ldr' | 'linear-hdr',
): readonly RenderPostDomainStage[] {
  const scene: ColorValueDomain = sceneDomain;
  const [transparentBlend, bloom, outputTransform, fxaa, postEffect, present] =
    STANDARD_POST_STAGE_NAMES;
  return [
    [transparentBlend, scene, scene],
    [bloom, 'linear-hdr', 'linear-hdr'],
    [outputTransform, scene, 'display-encoded'],
    [fxaa, 'display-encoded', 'display-encoded'],
    [postEffect, 'display-encoded', 'display-encoded'],
    [present, 'display-encoded', 'display-encoded'],
  ];
}

/**
 * Describe the built-in output stages without moving color-domain policy into
 * a mode name. Tone-enabled cameras render HDR, apply exposure and the
 * selected curve in the fullscreen pass, then reach the encoded surface.
 */
export function resolveToneOutputContract(tonemap: Tonemap): ToneOutputContract {
  if (tonemap === 'none') {
    return {
      input: 'linearLdr',
      toneMapped: false,
      mapped: 'linearLdr',
      finalCapture: 'displayEncoded',
      exposureStage: 'none',
    };
  }
  return {
    input: 'linearHdr',
    toneMapped: true,
    mapped: 'linearLdr',
    finalCapture: 'displayEncoded',
    exposureStage: 'linearHdr',
  };
}

/** Stable facts that may change graph topology and therefore its compiled identity. */
export interface RenderPipelineTopology {
  readonly pipelineId: string;
  readonly standardProfile?: StandardProfile | undefined;
  readonly config: import('@forgeax/engine-types').RenderPipelineAsset['config'];
  /**
   * The record stage had no Camera and injected the synthetic clear-only
   * snapshot.  Keep that fact explicit so a normal no-tone Camera still uses
   * the float Output Transform while the empty-scene contract can write its
   * clear directly to the surface.
   */
  readonly clearOnly?: boolean | undefined;
  /** Whether Standard main draws carry the producer-owned fallback MRT. */
  readonly reflectionFallback?: { readonly enabled: boolean } | undefined;
  readonly surface: {
    readonly width: number;
    readonly height: number;
    readonly storageFormat: import('@forgeax/engine-rhi').TextureFormat;
    readonly viewFormat: import('@forgeax/engine-rhi').TextureFormat;
    readonly profile?: SurfaceProfile | undefined;
  };
  readonly camera: Pick<RenderPipelineContext['camera'], 'tonemap' | 'antialias' | 'bloom'>;
  readonly temporal?: {
    readonly taa: boolean;
    readonly motionBlur: boolean;
  };
  readonly shadow: {
    readonly directional:
      | 'disabled'
      | {
          readonly mapSize: number;
          readonly cascadeCount: 1 | 2 | 3 | 4;
        };
    readonly spotMapSize: number;
    readonly pointCount: number;
    readonly pointFaceSize: number;
    readonly spotCount: number;
  };
  /**
   * Authored volume topology facts.  Identity/generation/digest are runtime
   * residency facts and deliberately do not participate in graph topology.
   */
  readonly volumetricFog?: {
    readonly enabled: boolean;
    readonly lightKind?: 'directional' | 'point' | 'spot' | undefined;
    readonly lightEntity?: number | undefined;
    readonly pointLightEntity?: number | undefined;
    readonly spotLightEntity?: number | undefined;
    readonly projector?:
      | {
          readonly guid: string;
          readonly generation: number;
          readonly revision: number;
        }
      | undefined;
    readonly format?: TextureFormat | undefined;
    readonly extent?:
      | {
          readonly width: number;
          readonly height: number;
          readonly depth: number;
        }
      | undefined;
    /** Renderer-owned froxel grid derived from the compiled surface extent. */
    readonly froxelExtent?:
      | {
          readonly width: number;
          readonly height: number;
          readonly depth: number;
        }
      | undefined;
    /** Renderer-owned 2D resolve/history extent derived from the same profile. */
    readonly resolvedExtent?:
      | {
          readonly width: number;
          readonly height: number;
          readonly depth: number;
        }
      | undefined;
  };
  readonly lane: {
    readonly compute: boolean;
    readonly storageBuffer: boolean;
    readonly multisample: boolean;
    readonly maxColorAttachments: number;
  };
  readonly featureTopologySignature: string;
  readonly gpuDrivenTopologySignature: string;
  /** Stable Cluster transport/layout facts; excludes per-frame light payloads. */
  readonly standardLightingTopologySignature?: string | undefined;
  /** Internal graph fact; renderer callers do not configure transmission demand. */
  readonly transmissionDemand?: TransmissionDemand | undefined;
}

/** Resolve the built-in final-output dither policy from the pipeline asset. */
export function resolveOutputDither(
  config: import('@forgeax/engine-types').RenderPipelineAsset['config'],
): boolean {
  return config?.outputDither ?? true;
}

export interface RenderPipelineFrame extends RenderPipelineContext, RenderGraphFrame {}

export interface RenderPipelineTarget {
  readonly texture: GraphTexture;
  readonly view: GraphTextureView;
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
  readonly domain?: ColorValueDomain | undefined;
  readonly resolveTarget?: GraphTextureView | undefined;
}

export function createRenderPipelineTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  descriptor: GraphTextureDescriptor,
  viewDescriptor: GraphTextureViewDescriptor = {},
): Result<RenderPipelineTarget, RenderGraphError> {
  const texture = graph.createTexture(label, descriptor);
  if (!texture.ok) return texture;
  const view = graph.view(texture.value, { label: `${label}.view`, ...viewDescriptor });
  if (!view.ok) return view;
  return ok({
    texture: texture.value,
    view: view.value,
    format: viewDescriptor.format ?? descriptor.format,
    sampleCount: descriptor.sampleCount === 4 ? 4 : 1,
    ...(descriptor.domain === undefined ? {} : { domain: descriptor.domain }),
  });
}

export function importRenderPipelineSurface(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
): Result<
  { readonly display?: RenderPipelineTarget; readonly storage: RenderPipelineTarget },
  RenderGraphError
> {
  const texture = graph.importTexture(
    'surface',
    {
      format: topology.surface.storageFormat,
      size: 'surface',
      // The imported surface is the final encoded endpoint.  Keeping this
      // semantic fact on the graph resource lets detached inspection project
      // from the compiled graph instead of re-inferring it from format names.
      domain: 'display-encoded',
      usage:
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
        (topology.surface.profile?.kind === 'raw-only' ? 0 : GPU_TEXTURE_USAGE_COPY_SRC),
      viewFormats: [
        ...(topology.surface.profile?.viewFormats ??
          (topology.surface.storageFormat === topology.surface.viewFormat
            ? []
            : [topology.surface.viewFormat])),
      ],
    },
    (frame) => frame.currentTexture,
  );
  if (!texture.ok) return texture;
  const display =
    topology.surface.profile?.hasDisplayEndpoint === false
      ? undefined
      : graph.importView(
          texture.value,
          { label: 'surface.display', format: topology.surface.viewFormat },
          (frame) => frame.view,
        );
  if (display !== undefined && !display.ok) return display;
  const storage = graph.importView(
    texture.value,
    { label: 'surface.storage', format: topology.surface.storageFormat },
    (frame) => {
      if (topology.surface.storageFormat === topology.surface.viewFormat) return frame.view;
      const resolved = frame.runtime.device.createTextureView(frame.currentTexture, {
        format: topology.surface.storageFormat,
      });
      if (!resolved.ok) throw resolved.error;
      return resolved.value;
    },
  );
  if (!storage.ok) return storage;
  return ok({
    ...(display === undefined
      ? {}
      : {
          display: {
            texture: texture.value,
            view: display.value,
            format: topology.surface.viewFormat,
            sampleCount: 1 as const,
            domain: 'display-encoded' as const,
          },
        }),
    storage: {
      texture: texture.value,
      view: storage.value,
      format: topology.surface.storageFormat,
      sampleCount: 1,
      domain: 'display-encoded',
    },
  });
}

export interface RenderPipelineFeatureTarget {
  /** Optional semantic alias when a pipeline exposes multiple color roles. */
  readonly name?: string;
  readonly kind: RenderFeatureTargetKind;
  readonly texture: GraphTexture;
  readonly view: GraphTextureView;
  readonly resolveTarget?: GraphTextureView | undefined;
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
}

export interface RenderPipelineGpuDrivenProjection {
  readonly accesses: readonly GraphAccess[];
  encode(
    viewBindGroup: BindGroup,
    pass: RhiRenderPassEncoder,
    resources: GraphResourceResolver,
  ): void;
}

export interface RenderPipelineBuildContext<FrameCtx extends RenderPipelineFrame> {
  readonly graph: RenderGraphBuilder<FrameCtx>;
  /**
   * The single prepared Standard lighting projection for this frame.  The
   * Forward and Deferred adapters consume this value; they never inspect raw
   * light snapshots, cluster config, or capability facts themselves.
   */
  readonly standardLighting?: StandardTopologyInputValue;
  /**
   * Renderer-owned capability facts needed for admission decisions. The
   * Standard temporal producer must use the live device probe rather than
   * inferring rgba16float support from the selected surface format.
   */
  readonly capabilities?: Pick<RhiCaps, 'rgba16floatRenderable'>;
  /**
   * Renderer-owned TAA history targets. The graph sees only imported typed
   * targets; opaque RHI handles remain inside RenderFrameState.
   */
  readonly taaHistory?: {
    readonly currentColor: RenderPipelineTarget;
    readonly previousColor: RenderPipelineTarget;
    readonly currentTemporal: RenderPipelineTarget;
    readonly previousTemporal: RenderPipelineTarget;
  };
  /** Renderer-owned, prewarmed encoder for one graph mip level. */
  readonly encodeTransmissionMip?: (input: {
    readonly pass: RhiRenderPassEncoder;
    readonly frame: FrameCtx;
    readonly resources: GraphResourceResolver;
    readonly source: GraphTextureView;
    readonly destination: GraphTextureView;
    readonly level: number;
  }) => void;
  /** Renderer-owned occlusion query state for the primary scene pass. */
  readonly occlusion?: OcclusionFrameProjection;
  projectGpuDriven(target: {
    readonly format: TextureFormat;
    readonly sampleCount: 1 | 4;
  }): Result<RenderPipelineGpuDrivenProjection | undefined, RenderPipelineBuildError>;
  contributeFeatures(
    targets: readonly RenderPipelineFeatureTarget[],
    semanticTargets?: readonly RenderPipelineTarget[],
    namedTargets?: Readonly<Record<string, RenderPipelineTarget>>,
  ): Result<void, RenderPipelineBuildError>;
  /** Add renderer-owned cube capture work to the active pipeline graph. */
  contributeCubeCaptures?(): Result<void, RenderPipelineBuildError>;
  /** Whether a producer-owned feature is installed for this graph build. */
  hasFeature?(identity: string): boolean;
}

export type RenderPipelineBuildError = RenderGraphError | RenderError | RhiError;

/**
 * Registrable, installable, hot-swappable render topology.
 *
 * `build` declares resources and passes only. The renderer owns compilation,
 * last-known-good replacement, execution, retirement, and the single frame submit.
 * Feature contributions enter through `contributeFeatures`, so compute-produced
 * buffers and later raster reads remain inside the same typed dependency graph.
 */
export interface RenderPipeline<FrameCtx extends RenderPipelineFrame = RenderPipelineFrame> {
  build(
    context: RenderPipelineBuildContext<FrameCtx>,
    topology: RenderPipelineTopology,
  ): Result<void, RenderPipelineBuildError>;
}
