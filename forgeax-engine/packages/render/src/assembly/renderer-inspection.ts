import type { CompiledRenderGraphInfo } from '@forgeax/engine-render-graph';
import type { RhiCanvasSurfacePresentationProof, TextureFormat } from '@forgeax/engine-rhi';
import {
  type RenderOutputInspection,
  type RenderStandardOutputColorInspection,
  STANDARD_OUTPUT_TRANSFORM_FEATURE_ID,
} from '../render-contract';

/** Inputs owned by the renderer assembly for one detached output projection. */
export interface RendererOutputInspectionInput {
  readonly graph: CompiledRenderGraphInfo | undefined;
  readonly surfaceAvailable: boolean;
  readonly surfaceStorage: TextureFormat;
  readonly surfaceDisplay: TextureFormat;
  readonly surfaceProfile?: 'dual-view' | 'raw-only';
  readonly rgba16floatRenderable: boolean;
  readonly presentationProof?: RhiCanvasSurfacePresentationProof | undefined;
}

function isSrgbFormat(format: TextureFormat): boolean {
  return format === 'rgba8unorm-srgb' || format === 'bgra8unorm-srgb';
}

function writesSurface(pass: CompiledRenderGraphInfo['passes'][number]): boolean {
  return pass.accesses.some(
    (access) =>
      (access.resource === 'surface' || access.resource.startsWith('surface.')) &&
      access.usage === 'color-attachment',
  );
}

/**
 * Project output facts from the committed graph and physical surface only.
 * Profile fields are deliberately not consulted: a transform pass, a real
 * intermediate target, and the final endpoint/domain are graph facts.
 */
export function projectRendererOutputInspection(
  input: RendererOutputInspectionInput,
): RenderOutputInspection {
  const graph = input.graph;
  const outputTransformPass = graph?.passes.find(
    (pass) => pass.name === 'output-transform' || pass.name === 'present',
  );
  const surfaceResource = graph?.resources.find(
    (resource) => resource.kind === 'texture' && resource.label === 'surface',
  );
  const writesFinalSurface = graph?.passes.some(writesSurface) === true;
  const surfaceDomain =
    surfaceResource?.descriptor?.kind === 'texture' ? surfaceResource.descriptor.domain : undefined;
  const directEncodedSurface =
    writesFinalSurface && surfaceDomain === 'display-encoded' && isSrgbFormat(input.surfaceDisplay);
  const displayEncoded =
    input.surfaceAvailable &&
    writesFinalSurface &&
    (outputTransformPass !== undefined || directEncodedSurface);
  const intermediate = graph?.resources.find(
    (resource) =>
      resource.kind === 'texture' &&
      resource.label === 'standard-output-color' &&
      resource.descriptor?.kind === 'texture',
  );
  const standardOutputColor: RenderStandardOutputColorInspection | undefined =
    intermediate?.descriptor?.kind === 'texture'
      ? {
          format: intermediate.descriptor.format,
          ...(intermediate.descriptor.domain === undefined
            ? {}
            : { domain: intermediate.descriptor.domain }),
          width: intermediate.descriptor.width,
          height: intermediate.descriptor.height,
          sampleCount: intermediate.descriptor.sampleCount,
          usage: intermediate.derivedUsage,
        }
      : undefined;
  const outputReady = input.surfaceAvailable && displayEncoded;

  return {
    ...(outputTransformPass === undefined
      ? {}
      : { outputTransform: STANDARD_OUTPUT_TRANSFORM_FEATURE_ID }),
    displayEncoded,
    ...(intermediate?.descriptor?.kind === 'texture'
      ? { intermediateFormat: intermediate.descriptor.format }
      : {}),
    ...(input.surfaceProfile === undefined ? {} : { surfaceProfile: input.surfaceProfile }),
    graphPassNames: graph?.passes.map((pass) => pass.name) ?? [],
    ...(standardOutputColor === undefined ? {} : { standardOutputColor }),
    surfaceStorage: input.surfaceStorage,
    surfaceDisplay: input.surfaceDisplay,
    endpoint: 'surface.storage.raw',
    capability: outputReady
      ? input.rgba16floatRenderable
        ? 'rgba16float-renderable'
        : 'surface-raw-endpoint'
      : 'unavailable',
    ...(input.presentationProof === undefined
      ? {}
      : { presentationProof: input.presentationProof }),
    error: outputReady
      ? undefined
      : {
          code: 'inspection-facts-unavailable',
          expected: 'a committed graph writes an encoded surface endpoint',
          hint: 'draw a frame before consuming output inspection facts',
        },
  };
}

/** Detached inspection projection helper; live renderer objects never cross this boundary. */
export function detachRendererInspection<T extends object>(inspection: T): Readonly<T> {
  return Object.freeze({ ...inspection });
}
