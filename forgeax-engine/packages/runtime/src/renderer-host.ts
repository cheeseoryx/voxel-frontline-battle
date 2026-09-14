import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { RenderError, RendererOptions, RenderResult } from '@forgeax/engine-render';
import type {
  BundlerOptions,
  RendererHostAssembly,
} from '@forgeax/engine-render/internal/construct-renderer';
import {
  constructRendererHost,
  EngineEnvironmentError,
} from '@forgeax/engine-render/internal/construct-renderer';
import { loadBackendPack } from './backend-selection';

export type {
  BundlerOptions,
  RendererHostAssembly,
} from '@forgeax/engine-render/internal/construct-renderer';

const FALLBACK_ERROR_CODES = new Set([
  'adapter-unavailable',
  'request-adapter-threw',
  'feature-not-enabled',
  'limit-exceeded',
  'rhi-not-available',
  'device-lost',
  'oom',
]);

function canFallbackToWgpu(error: unknown): boolean {
  if (!(error instanceof EngineEnvironmentError)) return false;
  const webgpuError = error.detail.webgpuError;
  if (webgpuError === undefined || typeof webgpuError !== 'object') return false;
  if (!('code' in webgpuError)) return false;
  const code = webgpuError.code;
  return typeof code === 'string' && FALLBACK_ERROR_CODES.has(code);
}

/** Assemble renderer plus asset services in the Runtime-owned backend host. */
export async function constructRuntimeRendererHost(
  canvas: unknown,
  options?: RendererOptions,
  bundler?: BundlerOptions,
): Promise<RenderResult<RendererHostAssembly, RenderError | EngineEnvironmentError>> {
  const first = await loadBackendPack(options);
  if (!first.ok) throw first.error;
  const constructed = await constructRendererHost(canvas, options, bundler, first.value);
  if (
    constructed.ok ||
    options?.rhi !== undefined ||
    typeof globalThis === 'undefined' ||
    !canFallbackToWgpu(constructed.error)
  ) {
    return constructed;
  }
  const fallback = await loadBackendPack(options, true);
  if (!fallback.ok) return constructed;
  return constructRendererHost(canvas, options, bundler, fallback.value);
}

export { loadRhiPack } from './backend-selection';
export type { AssetRegistry };
