import type { CompiledRenderGraphInfo, GraphTextureDescriptor } from '@forgeax/engine-render-graph';
import { RenderGraphError } from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import { addTypedDebugOverlayPass } from '../debug-draw-glue';
import { SceneDataUnavailableError } from '../errors/render';
import { addMotionBlurPass } from '../features/motion-blur/motion-blur-feature';
import { GPU_TEXTURE_USAGE_COPY_SRC } from '../gpu-texture-usage';
import type {
  RenderPipelineBuildContext,
  RenderPipelineBuildError,
  RenderPipelineFrame,
  RenderPipelineTopology,
} from '../render-pipeline';
import {
  createRenderPipelineTarget,
  type RenderPipelineTarget,
  resolveOutputDither,
} from '../render-pipeline';
import {
  addTypedBloomPasses,
  addTypedCompositePostEffects,
  addTypedFullscreenPass,
  addTypedOutputTransformPass,
  addTypedTemporalResolvePass,
  TYPED_BLOOM_PASS_NAMES,
  type TypedTemporalResolveTargets,
} from '../typed-render-graph-primitives';

interface StandardPostSurface {
  readonly display?: RenderPipelineTarget;
  readonly storage: RenderPipelineTarget;
}

/** One authored Bloom contract drives declaration and compiled-graph validation. */
export const STANDARD_BLOOM_TARGET_SPEC = {
  composited: { label: 'bloom-composited', format: 'rgba16float', size: 'surface' },
  bright: { label: 'bloom-bright', format: 'rgba16float', size: 'half-surface' },
  blurH: { label: 'bloom-blur-h', format: 'rgba16float', size: 'half-surface' },
  blurV: { label: 'bloom-blur-v', format: 'rgba16float', size: 'half-surface' },
} as const satisfies Record<
  'composited' | 'bright' | 'blurH' | 'blurV',
  Pick<GraphTextureDescriptor, 'format' | 'size'> & { readonly label: string }
>;

export interface StandardBloomGraphInspection {
  readonly status: 'empty' | 'valid' | 'invalid';
  readonly targetCount: number;
  readonly targetBytes: number;
  readonly passCount: number;
}

const emptyBloomGraphInspection = (): StandardBloomGraphInspection => ({
  status: 'empty',
  targetCount: 0,
  targetBytes: 0,
  passCount: 0,
});

const invalidBloomGraphInspection = (): StandardBloomGraphInspection => ({
  status: 'invalid',
  targetCount: 0,
  targetBytes: 0,
  passCount: 0,
});

function textureBytes(
  resource: CompiledRenderGraphInfo['resources'][number],
  expected: (typeof STANDARD_BLOOM_TARGET_SPEC)[keyof typeof STANDARD_BLOOM_TARGET_SPEC],
): number {
  const descriptor = resource.descriptor;
  if (
    descriptor === undefined ||
    descriptor.kind !== 'texture' ||
    descriptor.format !== expected.format ||
    !('size' in descriptor) ||
    descriptor.size !== expected.size
  )
    return 0;
  const texelBytes = 8;
  let bytes = 0;
  for (let level = 0; level < descriptor.mipLevelCount; level += 1) {
    bytes +=
      Math.max(1, descriptor.width >> level) *
      Math.max(1, descriptor.height >> level) *
      descriptor.depthOrArrayLayers *
      texelBytes;
  }
  return bytes * descriptor.sampleCount;
}

/** Derive Bloom target/pass facts solely from the compiled Standard graph. */
export function inspectStandardBloomGraph(
  graph: CompiledRenderGraphInfo | undefined,
): StandardBloomGraphInspection {
  if (graph === undefined) return emptyBloomGraphInspection();
  type BloomTargetSpec =
    (typeof STANDARD_BLOOM_TARGET_SPEC)[keyof typeof STANDARD_BLOOM_TARGET_SPEC];
  const targetSpec = new Map<string, BloomTargetSpec>(
    Object.values(STANDARD_BLOOM_TARGET_SPEC).map((entry) => [entry.label, entry] as const),
  );
  const targets = graph.resources.flatMap((resource) => {
    const expected = targetSpec.get(resource.label);
    return expected === undefined ? [] : [{ resource, expected }];
  });
  const passNames = new Set<string>(Object.values(TYPED_BLOOM_PASS_NAMES));
  const passes = graph.passes.filter((pass) => passNames.has(pass.name));
  if (targets.length === 0 && passes.length === 0) return emptyBloomGraphInspection();
  const completeTargetSet =
    targets.length === Object.values(STANDARD_BLOOM_TARGET_SPEC).length &&
    targets.every(({ resource, expected }) => textureBytes(resource, expected) > 0);
  const completePassSet = passes.length === Object.values(TYPED_BLOOM_PASS_NAMES).length;
  if (!completeTargetSet || !completePassSet) {
    return invalidBloomGraphInspection();
  }
  return {
    status: 'valid',
    targetCount: targets.length,
    targetBytes: targets.reduce(
      (bytes, target) => bytes + textureBytes(target.resource, target.expected),
      0,
    ),
    passCount: passes.length,
  };
}

function target(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  label: string,
  descriptor: GraphTextureDescriptor,
): Result<RenderPipelineTarget, RenderGraphError> {
  return createRenderPipelineTarget(context.graph, label, descriptor);
}

function missingTemporalContributor(
  topology: RenderPipelineTopology,
  contributorId: string,
): SceneDataUnavailableError {
  return new SceneDataUnavailableError({
    featureIdentity: 'forgeax::standard',
    schema: 'forgeax::scene-data::temporal-v1',
    lane: topology.lane.compute ? 'clustered' : 'cpu-webgl2',
    reason: 'producer-missing',
    missingContributorIds: [contributorId],
    omittedMissingContributorCount: 0,
    recovery: 'renderer-recover',
  });
}

/**
 * Build the one Standard post chain shared by direct and clustered lighting.
 * Bloom is admitted before any Bloom target is declared, keeping the disabled
 * path exact-zero while preserving the existing half-resolution four-pass
 * implementation for the enabled path.
 */
export function addStandardPost(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  scene: RenderPipelineTarget,
  depth: RenderPipelineTarget,
  surface: StandardPostSurface,
  sceneTemporal?: RenderPipelineTarget,
): Result<void, RenderPipelineBuildError> {
  const clearOnly = topology.clearOnly === true;
  const hdr =
    !clearOnly && (topology.camera.tonemap !== 'none' || topology.camera.antialias === 'taa');
  // Bloom is an HDR-domain effect and its recorders intentionally no-op when
  // tone mapping is disabled. Keep the graph in the same no-op state for the
  // TAA + tonemap:none combination; otherwise the declared Bloom composite is
  // left clear and the following Output Transform presents a black frame.
  const bloomActive = hdr && topology.camera.bloom === 'on' && topology.camera.tonemap !== 'none';
  const fxaa = !clearOnly && topology.camera.antialias === 'fxaa';
  // All non-clear Standard frames use the graph-owned float scene target and
  // the shared Output Transform, even when AA is disabled or the backend has
  // no storage buffers.  This keeps the final dither at one owner-level
  // surface boundary instead of making no-AA/WebGL2 a silent bypass.
  const linearLdr = !clearOnly && !hdr;
  const rawOnly = !clearOnly && topology.surface.profile?.kind === 'raw-only';
  const outputDither = resolveOutputDither(topology.config);
  const motionBlur = !clearOnly && topology.temporal?.motionBlur === true;
  const postEffects = clearOnly ? [] : (topology.config?.postEffects ?? []);
  const rawOnlyPostInput =
    rawOnly && topology.lane.storageBuffer && postEffects.length > 0
      ? target(context, 'standard-post-effects-input', {
          format: 'rgba16float',
          size: 'surface',
          usage: GPU_TEXTURE_USAGE_COPY_SRC,
          domain: 'display-encoded',
        })
      : undefined;
  if (rawOnlyPostInput !== undefined && !rawOnlyPostInput.ok) return rawOnlyPostInput;
  // Every Standard route terminates at the same encoded raw storage endpoint.
  // The raw-only profile has no alternate display view, so its debug overlay
  // and optional post effects are kept in graph-owned float targets until the
  // single Output Transform performs the first 8-bit quantization.
  const finalPresent = surface.storage;
  let postInput = scene;

  if (topology.camera.antialias === 'taa') {
    if (sceneTemporal === undefined) {
      return err(missingTemporalContributor(topology, 'forgeax::standard::scene-data'));
    }
    const history = context.taaHistory;
    if (history === undefined) {
      return err(missingTemporalContributor(topology, 'forgeax::standard::taa-history'));
    }
    const resolveTargets: TypedTemporalResolveTargets = {
      scene,
      depth,
      currentTemporal: sceneTemporal,
      historyColor: history.previousColor,
      historyTemporal: history.previousTemporal,
      writeColor: history.currentColor,
      writeTemporal: history.currentTemporal,
    };
    const resolve = addTypedTemporalResolvePass(context.graph, resolveTargets);
    if (!resolve.ok) return resolve;
    postInput = history.currentColor;
  }

  // Feature projection and the built-in fallback share one target contract.
  // The projection runs after TAA so Motion Blur consumes the resolved color,
  // then both paths feed the same linear float target into Bloom/Output.
  if (!clearOnly) {
    const featureTargets = [
      {
        kind: 'scene-color' as const,
        texture: scene.texture,
        view: scene.view,
        format: scene.format,
        sampleCount: scene.sampleCount,
      },
      {
        kind: 'scene-depth' as const,
        texture: depth.texture,
        view: depth.view,
        format: depth.format,
        sampleCount: depth.sampleCount,
      },
    ];
    if (motionBlur) {
      if (sceneTemporal === undefined) {
        return err(
          new Error('Motion Blur requires the Standard scene-data producer') as RenderGraphError,
        );
      }
      const blurred = target(context, 'motion-blurred-color', {
        format: 'rgba16float',
        size: 'surface',
        domain: hdr ? 'linear-hdr' : 'linear-ldr',
      });
      if (!blurred.ok) return blurred;
      const features = context.contributeFeatures(featureTargets, [sceneTemporal], {
        'motion-input': postInput,
        'motion-output': blurred.value,
      });
      if (!features.ok) return features;
      if (context.hasFeature?.('forgeax.motion-blur') === true) {
        postInput = blurred.value;
      } else {
        const fallback = addMotionBlurPass(context.graph, postInput, sceneTemporal, blurred.value);
        if (!fallback.ok) return fallback;
        postInput = blurred.value;
      }
    } else {
      const features = context.contributeFeatures(
        featureTargets,
        sceneTemporal === undefined ? [] : [sceneTemporal],
      );
      if (!features.ok) return features;
    }
  }

  if (bloomActive) {
    const composited = target(
      context,
      STANDARD_BLOOM_TARGET_SPEC.composited.label,
      STANDARD_BLOOM_TARGET_SPEC.composited,
    );
    if (!composited.ok) return composited;
    const bright = target(
      context,
      STANDARD_BLOOM_TARGET_SPEC.bright.label,
      STANDARD_BLOOM_TARGET_SPEC.bright,
    );
    if (!bright.ok) return bright;
    const blurH = target(
      context,
      STANDARD_BLOOM_TARGET_SPEC.blurH.label,
      STANDARD_BLOOM_TARGET_SPEC.blurH,
    );
    if (!blurH.ok) return blurH;
    const blurV = target(
      context,
      STANDARD_BLOOM_TARGET_SPEC.blurV.label,
      STANDARD_BLOOM_TARGET_SPEC.blurV,
    );
    if (!blurV.ok) return blurV;
    const bloom = addTypedBloomPasses(context.graph, {
      scene: postInput,
      composited: composited.value,
      bright: bright.value,
      blurH: blurH.value,
      blurV: blurV.value,
    });
    if (!bloom.ok) return bloom;
    postInput = composited.value;
  }

  if (rawOnly) {
    const overlay = addTypedDebugOverlayPass(context.graph, postInput);
    if (!overlay.ok) return overlay;
  }

  if (hdr || linearLdr || fxaa || rawOnly || motionBlur) {
    if (fxaa) {
      const output = target(context, 'standard-output-color', {
        format: 'rgba16float',
        size: 'surface',
        usage: GPU_TEXTURE_USAGE_COPY_SRC,
        domain: 'display-encoded',
      });
      if (!output.ok) return output;
      // FXAA samples this display-encoded intermediate; leave dither to the
      // final FXAA writer so the same pixel is not dithered twice.
      const outputTransform = addTypedOutputTransformPass(context.graph, postInput, output.value, {
        dither: false,
      });
      if (!outputTransform.ok) return outputTransform;
      const aa = addTypedFullscreenPass(context.graph, {
        name: 'fxaa',
        shader: 'fxaa',
        input: output.value,
        output: rawOnlyPostInput !== undefined ? rawOnlyPostInput.value : finalPresent,
      });
      if (!aa.ok) return aa;
    } else if (rawOnlyPostInput !== undefined) {
      const transformed = addTypedOutputTransformPass(
        context.graph,
        postInput,
        rawOnlyPostInput.value,
        {
          dither: outputDither && postEffects.length === 0,
        },
      );
      if (!transformed.ok) return transformed;
    } else if (rawOnly || linearLdr) {
      const transformed = addTypedOutputTransformPass(context.graph, postInput, finalPresent, {
        dither: outputDither,
      });
      if (!transformed.ok) return transformed;
    } else {
      const outputTransform = addTypedOutputTransformPass(context.graph, postInput, finalPresent, {
        dither: outputDither,
      });
      if (!outputTransform.ok) return outputTransform;
    }
  }

  if (topology.lane.storageBuffer && postEffects.length > 0) {
    const postInputTarget = rawOnly
      ? rawOnlyPostInput?.value
      : (surface.display ?? surface.storage);
    if (postInputTarget === undefined) {
      return err(
        new RenderGraphError({
          code: 'resource-descriptor-invalid',
          expected: 'raw-only post effects have a graph-owned encoded input target',
          hint: 'retain the candidate LKG when the post-effect input target cannot be declared',
          detail: {
            resourceLabel: 'standard-post-effects-input',
            field: 'descriptor',
            expected: 'rgba16float display-encoded target',
            actual: 'absent',
          },
        }),
      );
    }
    const effects = addTypedCompositePostEffects(
      context.graph,
      postEffects,
      postInputTarget,
      surface.storage,
      depth,
      topology.surface,
    );
    if (!effects.ok) return effects;
  }

  return rawOnly
    ? ok(undefined)
    : addTypedDebugOverlayPass(context.graph, surface.display ?? surface.storage);
}
