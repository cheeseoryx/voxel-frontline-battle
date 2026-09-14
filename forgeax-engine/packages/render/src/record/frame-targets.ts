import type { RhiCanvasContext, Texture, TextureView } from '@forgeax/engine-rhi';
import type { RenderGraphExecutionPhase } from '../render-contract';
import type { ExtractedLights } from '../render-system-extract';
import type { RenderTargetDescriptor } from '../targets/contracts';
import { resolveDirectionalShadowAtlasGrid } from '../typed-shadow-atlas';
import { configureSurface, type PipelineState, type RenderSystemInternals } from './render-context';

export function graphExecutionPhase(passName: string): RenderGraphExecutionPhase {
  if (passName.startsWith('shadowCascade')) return 'record/graph-execute/shadow';
  if (passName.startsWith('point-shadow')) return 'record/graph-execute/point-shadow';
  if (passName.startsWith('spot-shadow')) return 'record/graph-execute/spot-shadow';
  switch (passName) {
    case 'cluster-binner-upload':
    case 'cluster-membership-producer':
      return 'record/graph-execute/cluster-binner-upload';
    case 'g-buffer':
      return 'record/graph-execute/g-buffer';
    case 'ssao-calc':
      return 'record/graph-execute/ssao-calc';
    case 'ssao-blur':
      return 'record/graph-execute/ssao-blur';
    case 'lighting':
      return 'record/graph-execute/lighting';
    case 'forward':
    case 'transmission-forward':
      return 'record/graph-execute/forward';
    case 'output-transform':
      return 'record/graph-execute/output-transform';
    case 'present':
      return 'record/graph-execute/present';
    case 'debug-overlay':
      return 'record/graph-execute/debug-overlay';
    case 'shadow':
      return 'record/graph-execute/shadow';
    case 'skybox':
      return 'record/graph-execute/skybox';
    case 'main':
      return 'record/graph-execute/main';
    case 'fxaa':
      return 'record/graph-execute/fxaa';
    case 'bloom-bright':
      return 'record/graph-execute/bloom-bright';
    case 'bloom-blur-h':
      return 'record/graph-execute/bloom-blur-h';
    case 'bloom-blur-v':
      return 'record/graph-execute/bloom-blur-v';
    case 'bloom-composite':
      return 'record/graph-execute/bloom-composite';
    default:
      return 'record/graph-execute/other';
  }
}

export function resolveRenderTargetMipExtent(
  descriptor: RenderTargetDescriptor,
  mipLevel: number,
): { readonly width: number; readonly height: number } {
  const mipCount =
    descriptor.mipLevels === 1
      ? 1
      : Math.floor(Math.log2(Math.max(descriptor.width, descriptor.height))) + 1;
  const level = Math.max(0, Math.min(mipLevel, mipCount - 1));
  return {
    width: Math.max(1, descriptor.width >> level),
    height: Math.max(1, descriptor.height >> level),
  };
}

export function acquireSwapChainTarget(
  internals: RenderSystemInternals,
  pipelineState: PipelineState,
): { currentTexture: Texture; view: TextureView; targetW: number; targetH: number } | null {
  const canvasContext: RhiCanvasContext | null = internals.context;
  if (canvasContext === null) return null;

  let currentTextureResult = canvasContext.getCurrentTexture();
  if (!currentTextureResult.ok) {
    const configuredDevice = internals.resolveSurfaceDevice?.(internals.device);
    if (configuredDevice !== undefined && !configuredDevice.ok) {
      internals.errorRegistry.fire(configuredDevice.error);
      internals.healthRegistry.fire({
        reason: 'internal-fault',
        detail: { message: 'surface device resolution failed; current frame skipped' },
        recoverable: true,
      });
      return null;
    }
    const configured = configureSurface(
      canvasContext,
      configuredDevice?.value ?? internals.device,
      pipelineState.format,
      pipelineState.colorAttachmentFormat,
    );
    if (!configured.ok) {
      internals.errorRegistry.fire(configured.error);
      internals.healthRegistry.fire({
        reason: 'internal-fault',
        detail: { message: 'surface configure candidate failed; current frame skipped' },
        recoverable: true,
      });
      return null;
    }
    pipelineState.perPassResources.configured = true;
    (globalThis as Record<string, unknown>).__forgeaxSwapChainFormat = pipelineState.format;
    const retry = canvasContext.getCurrentTexture();
    if (!retry.ok) {
      internals.errorRegistry.fire(retry.error);
      internals.healthRegistry.fire({
        reason: 'internal-fault',
        detail: {
          message:
            'surface-configure-failed after retry: getCurrentTexture failed twice consecutively',
        },
        recoverable: false,
      });
      return null;
    }
    currentTextureResult = retry;
  }
  const viewDescriptor =
    pipelineState.colorAttachmentFormat === pipelineState.format
      ? {}
      : { format: pipelineState.colorAttachmentFormat as GPUTextureFormat };
  const viewResult = internals.device.createTextureView(currentTextureResult.value, viewDescriptor);
  if (!viewResult.ok) {
    internals.errorRegistry.fire(viewResult.error);
    return null;
  }
  return {
    currentTexture: currentTextureResult.value,
    view: viewResult.value,
    targetW: internals.canvas.width | 0,
    targetH: internals.canvas.height | 0,
  };
}

export function resolveShadowMapSize(
  internals: RenderSystemInternals,
  lights: ExtractedLights,
): number | undefined {
  if (lights.cascadeCount === undefined) return undefined;
  const requested = lights.shadowMapSize;
  if (!(requested !== undefined && requested > 0)) return requested;
  const cascades = Math.max(1, Math.min(4, Math.round(lights.cascadeCount ?? 1)));
  const atlasGrid = resolveDirectionalShadowAtlasGrid(cascades);
  const maxDimension = internals.device.limits.maxTextureDimension2D;
  if (!(maxDimension > 0)) return Math.floor(requested);
  const depthTextureDimension =
    internals.device.caps?.backendKind === 'wgpu-webgl2'
      ? Math.max(1, Math.floor(maxDimension / 2))
      : maxDimension;
  const maxPerTile = Math.max(
    1,
    Math.floor(depthTextureDimension / Math.max(atlasGrid.columns, atlasGrid.rows)),
  );
  return Math.max(1, Math.min(Math.floor(requested), maxPerTile));
}

/**
 * Resolve the per-tile size for the graph-owned spot atlas when a frame has
 * no directional shadow map. The typed spot pass still needs a non-zero
 * viewport in a spot-only world; the directional resolver cannot provide
 * that because it intentionally follows only the directional shadow lane.
 */
export function resolveSpotShadowMapSize(
  internals: RenderSystemInternals,
  lights: ExtractedLights,
): number | undefined {
  const requested = lights.spot.find(
    (spot) => spot.shadowAtlasTile >= 0 && spot.lightViewProj !== undefined,
  )?.mapSize;
  if (!(requested !== undefined && requested > 0)) return requested;
  const maxDimension = internals.device.limits.maxTextureDimension2D;
  if (!(maxDimension > 0)) return Math.floor(requested);
  const maxPerTile = Math.max(1, Math.floor(maxDimension / 2));
  return Math.max(1, Math.min(Math.floor(requested), maxPerTile));
}
