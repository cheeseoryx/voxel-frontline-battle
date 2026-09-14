import type { TextureFormat } from '@forgeax/engine-rhi';

/** Render-owned logical targets exposed to producer-owned RenderFeatures. */

export type RenderFeatureTargetKind = 'scene-color' | 'scene-depth';

/**
 * A logical attachment supplied by the active RenderPipeline.
 *
 * The semantic kind plus attachment facts identify the target. The active
 * pipeline supplies the graph resource, so feature authors never name an
 * internal graph key.
 */
export interface RenderFeatureTargetHandle {
  /** Stable alias used when a pipeline exposes more than one color role. */
  readonly name?: string;
  readonly kind: RenderFeatureTargetKind;
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
  readonly __renderFeatureTarget: unique symbol;
}

export interface RenderFeatureTargetInput {
  readonly name?: string;
  readonly kind: RenderFeatureTargetKind;
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
}

export function createRenderFeatureTarget(
  input: RenderFeatureTargetInput,
): RenderFeatureTargetHandle {
  return Object.freeze({ ...input }) as RenderFeatureTargetHandle;
}

export function isRenderFeatureTargetHandle(value: unknown): value is RenderFeatureTargetHandle {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<RenderFeatureTargetInput>;
  return (
    (candidate.kind === 'scene-color' || candidate.kind === 'scene-depth') &&
    typeof candidate.format === 'string' &&
    (candidate.sampleCount === 1 || candidate.sampleCount === 4)
  );
}

export function renderFeatureAttachmentResource(
  resource: string | RenderFeatureTargetHandle,
): string {
  return isRenderFeatureTargetHandle(resource) ? resource.kind : resource;
}

export function resolveStandardRenderFeatureTargets(input: {
  readonly tonemap: string;
  readonly antialias: string;
  readonly storageBuffer: boolean;
  readonly multisample: boolean;
  readonly colorAttachmentFormat: TextureFormat;
}): readonly RenderFeatureTargetHandle[] {
  const sampleCount: 1 | 4 = input.antialias === 'msaa' && input.multisample ? 4 : 1;
  // Standard always exposes the scene to features as a linear float target;
  // the shared Output Transform owns the eventual RGBA8 write for every
  // antialias mode, including no-AA/WebGL2.
  const linearLdr =
    input.tonemap === 'none' ||
    input.antialias === 'fxaa' ||
    (input.antialias === 'msaa' && input.multisample);
  const colorFormat =
    input.tonemap !== 'none' || linearLdr ? 'rgba16float' : input.colorAttachmentFormat;
  return [
    createRenderFeatureTarget({
      name: 'color',
      kind: 'scene-color',
      format: colorFormat,
      sampleCount,
    }),
    createRenderFeatureTarget({
      name: 'depth',
      kind: 'scene-depth',
      format: 'depth24plus-stencil8',
      sampleCount,
    }),
    createRenderFeatureTarget({
      name: 'motion-input',
      kind: 'scene-color',
      format: colorFormat,
      sampleCount,
    }),
    createRenderFeatureTarget({
      name: 'motion-output',
      kind: 'scene-color',
      format: colorFormat,
      sampleCount: 1,
    }),
  ];
}
