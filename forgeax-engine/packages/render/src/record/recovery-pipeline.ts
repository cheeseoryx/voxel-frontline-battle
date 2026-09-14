import {
  deriveVertexLayoutProjection,
  type VertexLayoutProjection,
} from '@forgeax/engine-geometry';
import type {
  MaterialRenderState,
  PassKind,
  PrimitiveTopology,
  VertexAttributeMap,
} from '@forgeax/engine-types';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '../materials';
import {
  isStandardPbrMaterialShader,
  SHADOW_CASTER_SHADER_ID,
  SKIN_MATERIAL_SHADER_ID,
  SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET,
  shadowCasterVariantSet,
} from '../pbr-pipeline';
import type { StandardTopologyInputValue } from '../pipeline/standard-lighting/topology';
import {
  cacheKeyOf,
  colorFormatsForPassKind,
  type PipelineSpec,
  PipelineSpecError,
  standardStorageVariantSet,
  standardTopologyVariantSet,
  variantSetFromVertexLayoutProjection,
} from '../pipeline-spec';
import { POINTS_LINES_MATERIAL_SHADER_ID } from '../points-lines/record';
import type { CameraSnapshot } from '../render-contract';
import type { DispatchEntry, MaterialSnapshot } from '../render-system-extract';
import type { ValidatedRenderable } from './frame-snapshot';
import { geometryRenderStateForPass } from './main-pass-geometry';
import { geometryRenderStateForTopology } from './main-pass-material';
import type {
  MaterialShaderPipelineEntry,
  PipelineState,
  RecoveryColdWorkGuard,
  RenderSystemInternals,
} from './render-context';

export interface RecoveryPipelineReadiness {
  readonly pipelineSpecs: readonly PipelineSpec[];
  /** Re-resolve every candidate request and assert a stable cache hit. */
  readonly assertFirstRecoveryFrame: () => void;
}

/**
 * Create the one-shot assertion used by the first frame after publication.
 * Recording a miss is a failure at the owner seam; the draw path never gets a
 * chance to submit a frame that hides a shader/pipeline or static-residency
 * cold build behind an apparently successful receipt.
 */
export function createRecoveryColdWorkGuard(): RecoveryColdWorkGuard {
  let armed = false;
  let finished = false;
  let pipelineColdWork = 0;
  let uploadColdWork = 0;
  const fail = (kind: 'pipeline' | 'upload'): never => {
    if (kind === 'pipeline') pipelineColdWork += 1;
    else uploadColdWork += 1;
    throw new Error(
      `recovery first frame performed cold ${kind} work ` +
        `(pipeline=${pipelineColdWork}, upload=${uploadColdWork})`,
    );
  };
  return {
    arm(): void {
      armed = true;
      finished = false;
      pipelineColdWork = 0;
      uploadColdWork = 0;
    },
    notePipelineColdWork(): void {
      if (armed && !finished) fail('pipeline');
    },
    noteUploadColdWork(): void {
      if (armed && !finished) fail('upload');
    },
    finish(): void {
      if (!armed || finished) return;
      finished = true;
      armed = false;
      if (pipelineColdWork !== 0 || uploadColdWork !== 0) {
        throw new Error(
          `recovery first frame cold-work assertion failed ` +
            `(pipeline=${pipelineColdWork}, upload=${uploadColdWork})`,
        );
      }
    },
  };
}

interface RecoveryPipelineRequest {
  readonly spec: PipelineSpec;
  readonly resolve: () => MaterialShaderPipelineEntry | null;
}

const DEFAULT_VERTEX_ATTRIBUTES: VertexAttributeMap = {
  position: new Float32Array(0),
  normal: new Float32Array(0),
  uv: new Float32Array(0),
  tangent: new Float32Array(0),
};

function optionalRenderState(
  state: MaterialRenderState | undefined,
): { readonly renderState: MaterialRenderState } | Record<string, never> {
  return state === undefined ? {} : { renderState: state };
}

function optionalVariant(
  variant: string | undefined,
): { readonly variantSet: string } | Record<string, never> {
  return variant === undefined ? {} : { variantSet: variant };
}

function optionalColorFormat(
  format: GPUTextureFormat | undefined,
): { readonly colorFormatOverride: GPUTextureFormat } | Record<string, never> {
  return format === undefined ? {} : { colorFormatOverride: format };
}

function projectionVariant(
  projection: VertexLayoutProjection,
  requested: string | undefined,
  preserveUndefined = false,
): string | undefined {
  if (preserveUndefined && requested === undefined) return undefined;
  const resolved = variantSetFromVertexLayoutProjection(projection, requested);
  if (!resolved.ok) {
    throw new PipelineSpecError({
      code: 'spec-inconsistent',
      detail: { reason: resolved.error.message },
      hint: 'recovery candidate variant must agree with the LKG vertex layout projection',
    });
  }
  return resolved.value;
}

function recoveryRenderState(
  materialShaderId: string,
  material: MaterialSnapshot,
  topology: PrimitiveTopology,
): MaterialRenderState | undefined {
  const sprite =
    materialShaderId === 'forgeax::sprite' || materialShaderId === 'forgeax::sprite-lit';
  if (sprite) {
    return {
      ...material.renderState,
      depthWriteEnabled: false,
      depthCompare: 'less-equal',
      cullMode: 'none',
      blend: material.renderState?.blend ?? SPRITE_PREMULTIPLIED_ALPHA_BLEND,
    };
  }
  return geometryRenderStateForTopology(topology, material.renderState);
}

function addRequest(input: {
  readonly requests: RecoveryPipelineRequest[];
  readonly requestKeys: Set<string>;
  readonly internals: RenderSystemInternals;
  readonly pipelineState: PipelineState;
  readonly materialShaderId: string;
  readonly isHdrTarget: boolean;
  readonly renderState?: MaterialRenderState;
  readonly topology?: PrimitiveTopology;
  readonly indexFormat?: 'uint16' | 'uint32';
  readonly variantSet?: string;
  readonly passKind?: PassKind;
  readonly sampleCount?: number;
  readonly colorFormatOverride?: GPUTextureFormat;
  readonly additionalColorFormats?: readonly GPUTextureFormat[];
  readonly depthFormatOverride?: GPUTextureFormat | null;
  readonly vertexLayoutProjection?: VertexLayoutProjection;
  readonly preserveUndefinedVariant?: boolean;
  readonly variantAlreadyResolved?: boolean;
}): void {
  const passKind = input.passKind ?? 'forward';
  const projection = input.vertexLayoutProjection;
  const resolvedVariantSet =
    input.variantAlreadyResolved === true
      ? input.variantSet
      : projection === undefined
        ? input.variantSet
        : projectionVariant(projection, input.variantSet, input.preserveUndefinedVariant === true);
  const colorFormat = input.isHdrTarget
    ? 'rgba16float'
    : (input.colorFormatOverride ?? input.pipelineState.colorAttachmentFormat);
  const colorFormats =
    input.additionalColorFormats === undefined
      ? colorFormatsForPassKind(passKind, colorFormat)
      : [colorFormat, ...input.additionalColorFormats];
  const depthFormat =
    passKind === 'shadow-caster' || passKind === 'point-shadow-caster'
      ? 'depth32float'
      : input.depthFormatOverride === null
        ? undefined
        : (input.depthFormatOverride ?? 'depth24plus-stencil8');
  const shaderUvSetCount = input.internals.getMaterialShaderUvSetCount?.(input.materialShaderId);
  const spec: PipelineSpec = Object.freeze({
    shader: Object.freeze({
      id: input.materialShaderId,
      passKind,
      variantSet: resolvedVariantSet,
    }),
    attachments: Object.freeze({
      colorFormats: Object.freeze([...colorFormats]),
      depthFormat,
      sampleCount: (input.sampleCount === 4 ? 4 : 1) as 1 | 4,
    }),
    geometry: Object.freeze({
      topology: input.topology ?? 'triangle-list',
      stripIndexFormat: input.indexFormat,
      vertexLayout: DEFAULT_VERTEX_ATTRIBUTES,
      ...(projection === undefined ? {} : { vertexLayoutProjection: projection }),
      ...(shaderUvSetCount !== undefined && shaderUvSetCount > 1
        ? {
            shaderUvSetCount,
          }
        : {}),
    }),
    renderState: input.renderState,
  });
  const key = cacheKeyOf(spec);
  if (input.requestKeys.has(key)) return;
  input.requestKeys.add(key);
  const resolve = (): MaterialShaderPipelineEntry | null =>
    input.internals.getMaterialShaderPipelineEntry?.(
      input.materialShaderId,
      input.isHdrTarget,
      input.renderState,
      input.topology,
      input.indexFormat,
      resolvedVariantSet,
      passKind,
      undefined,
      input.sampleCount,
      input.colorFormatOverride,
      undefined,
      undefined,
      undefined,
      projection,
      undefined,
      undefined,
      input.additionalColorFormats,
    ) ?? null;
  input.requests.push({ spec, resolve });
}

function addStandardMaterialRequests(input: {
  readonly requests: RecoveryPipelineRequest[];
  readonly requestKeys: Set<string>;
  readonly internals: RenderSystemInternals;
  readonly pipelineState: PipelineState;
  readonly validated: readonly ValidatedRenderable[];
  readonly standardLighting: StandardTopologyInputValue | undefined;
  readonly sampleCount: number;
  readonly isHdrTarget: boolean;
  readonly colorFormatOverride?: GPUTextureFormat;
  readonly reflectionFallbackAvailable: boolean;
}): void {
  const pointsLinesProjection = deriveVertexLayoutProjection({
    position: new Float32Array(0),
    normal: new Float32Array(0),
    uv: new Float32Array(0),
    tangent: new Float32Array(0),
  });
  for (const entry of input.validated) {
    if (entry.source.pointsLines !== undefined) {
      const pointsLinesMaterial = entry.source.material;
      addRequest({
        requests: input.requests,
        requestKeys: input.requestKeys,
        internals: input.internals,
        pipelineState: input.pipelineState,
        materialShaderId: POINTS_LINES_MATERIAL_SHADER_ID,
        isHdrTarget: input.isHdrTarget,
        renderState: {
          ...pointsLinesMaterial.renderState,
          cullMode: 'none',
        },
        topology: 'triangle-list',
        indexFormat: 'uint32',
        sampleCount: input.sampleCount,
        ...optionalColorFormat(input.colorFormatOverride),
        vertexLayoutProjection: pointsLinesProjection,
      });
      continue;
    }
    const meshProjection = entry.mesh.layoutProjection;
    const hasVertexColor = meshProjection.attributes.some((attribute) => attribute.key === 'color');
    const capabilityVariantSet = standardTopologyVariantSet(
      input.standardLighting,
      input.internals.device.caps.storageBuffer,
      hasVertexColor,
    );
    // The probe record is an object-level ABI extension of the built-in
    // Standard PBR family. Recovery must request the same variant that the
    // live record path will select, otherwise the first post-recovery draw
    // discovers a cold PSO and the cold-work guard correctly rejects it.
    const probeBlendRecordAvailable =
      input.internals.device.caps.storageBuffer && entry.source.probeBlendRecord !== undefined;
    const standardPbrCapabilityVariantSet = standardTopologyVariantSet(
      input.standardLighting,
      input.internals.device.caps.storageBuffer,
      hasVertexColor,
      probeBlendRecordAvailable,
    );
    const unlitProjection = projectionVariant(meshProjection, undefined);
    const unlitHasColor = unlitProjection === 'VERTEX_COLOR_AVAILABLE=true';
    for (const submesh of entry.mesh.submeshes) {
      const material = entry.source.materials[submesh.materialSlot] ?? entry.source.material;
      const materialShaderId =
        entry.source.skin === undefined
          ? (material.materialShaderId ?? 'forgeax::default-unlit')
          : SKIN_MATERIAL_SHADER_ID;
      const renderState = geometryRenderStateForPass(
        recoveryRenderState(materialShaderId, material, submesh.topology) as ReturnType<
          typeof geometryRenderStateForTopology
        >,
        'forward',
      );
      if (entry.source.skin !== undefined && submesh === entry.mesh.submeshes[0]) {
        const skinProbeVariant = projectionVariant(meshProjection, standardPbrCapabilityVariantSet);
        addRequest({
          requests: input.requests,
          requestKeys: input.requestKeys,
          internals: input.internals,
          pipelineState: input.pipelineState,
          materialShaderId: SKIN_MATERIAL_SHADER_ID,
          isHdrTarget: input.isHdrTarget,
          ...optionalRenderState(entry.source.material.renderState),
          topology: entry.mesh.submeshes[0]?.topology ?? 'triangle-list',
          indexFormat: entry.mesh.indexFormat,
          ...optionalVariant(skinProbeVariant),
          sampleCount: input.sampleCount,
          ...optionalColorFormat(input.colorFormatOverride),
          vertexLayoutProjection: meshProjection,
          variantAlreadyResolved: true,
        });
      }
      if (
        materialShaderId === 'forgeax::default-unlit' ||
        materialShaderId === 'forgeax::default-standard-unlit'
      ) {
        addRequest({
          requests: input.requests,
          requestKeys: input.requestKeys,
          internals: input.internals,
          pipelineState: input.pipelineState,
          materialShaderId,
          isHdrTarget: input.isHdrTarget,
          ...optionalRenderState(renderState),
          topology: submesh.topology,
          indexFormat: entry.mesh.indexFormat,
          variantSet: standardStorageVariantSet(
            input.internals.device.caps.storageBuffer,
            unlitHasColor,
          ),
          sampleCount: input.sampleCount,
          ...optionalColorFormat(input.colorFormatOverride),
          vertexLayoutProjection: meshProjection,
        });
        continue;
      }
      const isSprite =
        materialShaderId === 'forgeax::sprite' || materialShaderId === 'forgeax::sprite-lit';
      const materialCapabilityVariantSet = isStandardPbrMaterialShader(materialShaderId)
        ? standardPbrCapabilityVariantSet
        : capabilityVariantSet;
      const requestedVariant = isSprite
        ? materialShaderId === 'forgeax::sprite' && entry.source.spriteInstances !== undefined
          ? SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET
          : undefined
        : entry.variantSet === undefined
          ? materialCapabilityVariantSet
          : materialCapabilityVariantSet === ''
            ? entry.variantSet
            : `${materialCapabilityVariantSet}+${entry.variantSet}`;
      const reflectionFallbackVariant =
        input.reflectionFallbackAvailable && materialShaderId === 'forgeax::default-standard-pbr'
          ? (() => {
              const projected = projectionVariant(meshProjection, requestedVariant);
              return projected === ''
                ? projected
                : `${projected}+REFLECTION_FALLBACK_AVAILABLE=true`;
            })()
          : requestedVariant;
      addRequest({
        requests: input.requests,
        requestKeys: input.requestKeys,
        internals: input.internals,
        pipelineState: input.pipelineState,
        materialShaderId,
        isHdrTarget: input.isHdrTarget,
        ...optionalRenderState(renderState),
        topology: submesh.topology,
        indexFormat: entry.mesh.indexFormat,
        ...optionalVariant(reflectionFallbackVariant),
        passKind: 'forward',
        sampleCount: input.sampleCount,
        ...optionalColorFormat(input.colorFormatOverride),
        ...(input.reflectionFallbackAvailable &&
        materialShaderId === 'forgeax::default-standard-pbr'
          ? { additionalColorFormats: ['rgba16float'] as const }
          : {}),
        vertexLayoutProjection: meshProjection,
        preserveUndefinedVariant: isSprite && requestedVariant === undefined,
        variantAlreadyResolved:
          isSprite ||
          (input.reflectionFallbackAvailable &&
            materialShaderId === 'forgeax::default-standard-pbr'),
      });
    }
  }
}

function addTransparentSpriteRequests(input: {
  readonly requests: RecoveryPipelineRequest[];
  readonly requestKeys: Set<string>;
  readonly internals: RenderSystemInternals;
  readonly pipelineState: PipelineState;
  readonly validated: readonly ValidatedRenderable[];
  readonly standardLighting: StandardTopologyInputValue | undefined;
  readonly sampleCount: number;
  readonly isHdrTarget: boolean;
  readonly colorFormat: GPUTextureFormat;
}): void {
  const spriteRenderState: MaterialRenderState = {
    depthWriteEnabled: false,
    depthCompare: 'less-equal',
    cullMode: 'none',
    blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND,
  };
  // recordSpritePass resolves all three built-in sprite pipelines before it
  // walks the visible entities. A generic transparent material is enough to
  // enter that pass, so candidate preparation must warm the same complete
  // request set even when the LKG contains no sprite entity. These calls also
  // intentionally omit vertexLayoutProjection: the record path omits that
  // argument and the factory's default sprite layout is the cache identity.
  for (const request of [
    {
      materialShaderId: 'forgeax::sprite',
      variantSet: undefined,
      preserveUndefinedVariant: true,
    },
    {
      materialShaderId: 'forgeax::sprite',
      variantSet: SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET,
      preserveUndefinedVariant: false,
    },
    {
      materialShaderId: 'forgeax::sprite-lit',
      variantSet: standardTopologyVariantSet(
        input.standardLighting,
        input.internals.device.caps.storageBuffer,
        false,
      ),
      preserveUndefinedVariant: false,
    },
  ] as const) {
    addRequest({
      requests: input.requests,
      requestKeys: input.requestKeys,
      internals: input.internals,
      pipelineState: input.pipelineState,
      materialShaderId: request.materialShaderId,
      isHdrTarget: input.isHdrTarget,
      renderState: spriteRenderState,
      topology: 'triangle-list',
      ...optionalVariant(request.variantSet),
      sampleCount: input.sampleCount,
      colorFormatOverride: input.colorFormat,
      preserveUndefinedVariant: request.preserveUndefinedVariant,
      variantAlreadyResolved: true,
    });
  }

  for (const entry of input.validated) {
    const entityShaderId = entry.source.material.materialShaderId;
    if (
      entityShaderId === 'forgeax::sprite' ||
      entityShaderId === 'forgeax::sprite-lit' ||
      entry.source.skin !== undefined ||
      entry.source.instances !== undefined
    ) {
      continue;
    }
    const projectedVariant = projectionVariant(
      entry.mesh.layoutProjection,
      standardTopologyVariantSet(
        input.standardLighting,
        input.internals.device.caps.storageBuffer,
        entry.mesh.layoutProjection.attributes.some((attribute) => attribute.key === 'color'),
      ),
    );
    for (const submesh of entry.mesh.submeshes) {
      const material = entry.source.materials[submesh.materialSlot] ?? entry.source.material;
      if (material.transparent !== true || material.materialShaderId === undefined) continue;
      addRequest({
        requests: input.requests,
        requestKeys: input.requestKeys,
        internals: input.internals,
        pipelineState: input.pipelineState,
        materialShaderId: material.materialShaderId,
        isHdrTarget: input.isHdrTarget,
        ...optionalRenderState(material.renderState),
        topology: submesh.topology,
        indexFormat: entry.mesh.indexFormat,
        ...optionalVariant(projectedVariant),
        sampleCount: input.sampleCount,
        colorFormatOverride: input.colorFormat,
        vertexLayoutProjection: entry.mesh.layoutProjection,
        variantAlreadyResolved: true,
      });
    }
  }
}

function addShadowRequests(input: {
  readonly requests: RecoveryPipelineRequest[];
  readonly requestKeys: Set<string>;
  readonly internals: RenderSystemInternals;
  readonly pipelineState: PipelineState;
  readonly validated: readonly ValidatedRenderable[];
  readonly dispatch: readonly DispatchEntry[];
}): void {
  addRequest({
    requests: input.requests,
    requestKeys: input.requestKeys,
    internals: input.internals,
    pipelineState: input.pipelineState,
    materialShaderId: SHADOW_CASTER_SHADER_ID,
    isHdrTarget: false,
    topology: 'triangle-list',
    variantSet: shadowCasterVariantSet(input.internals.device.caps.storageBuffer, false),
    passKind: 'shadow-caster',
    sampleCount: 1,
    variantAlreadyResolved: true,
  });
  const customByRenderable = new Map<
    number,
    Map<number, { id: string; state: MaterialRenderState | undefined }>
  >();
  for (const dispatch of input.dispatch) {
    if (dispatch.tags.LightMode !== 'ShadowCaster' || dispatch.materialShaderId === undefined)
      continue;
    let materials = customByRenderable.get(dispatch.renderableIndex);
    if (materials === undefined) {
      materials = new Map();
      customByRenderable.set(dispatch.renderableIndex, materials);
    }
    materials.set(dispatch.materialHandle, {
      id: dispatch.materialShaderId,
      state: dispatch.renderState,
    });
  }
  for (const entry of input.validated) {
    const triangles = entry.mesh.submeshes.filter(
      (submesh) => submesh.topology === 'triangle-list' || submesh.topology === 'triangle-strip',
    );
    if (triangles.length === 0) continue;
    if (entry.source.skin !== undefined) {
      addRequest({
        requests: input.requests,
        requestKeys: input.requestKeys,
        internals: input.internals,
        pipelineState: input.pipelineState,
        materialShaderId: SHADOW_CASTER_SHADER_ID,
        isHdrTarget: false,
        topology: entry.mesh.submeshes[0]?.topology ?? 'triangle-list',
        indexFormat: entry.mesh.indexFormat,
        variantSet: shadowCasterVariantSet(input.internals.device.caps.storageBuffer, true),
        passKind: 'shadow-caster',
        sampleCount: 1,
        vertexLayoutProjection: entry.mesh.layoutProjection,
        variantAlreadyResolved: true,
      });
    }
    for (const submesh of triangles) {
      const material = entry.source.materials[submesh.materialSlot] ?? entry.source.material;
      const custom = customByRenderable
        .get(entry.renderableIndex)
        ?.get(material.materialHandle ?? 0);
      if (
        entry.source.skin === undefined &&
        custom !== undefined &&
        (custom.id !== 'forgeax::default-shadow-caster' || custom.state !== undefined)
      ) {
        addRequest({
          requests: input.requests,
          requestKeys: input.requestKeys,
          internals: input.internals,
          pipelineState: input.pipelineState,
          materialShaderId: custom.id,
          isHdrTarget: false,
          ...optionalRenderState(custom.state),
          topology: 'triangle-list',
          passKind: 'shadow-caster',
          sampleCount: 1,
          preserveUndefinedVariant: true,
          variantAlreadyResolved: true,
        });
      }
    }
  }
}

export function prepareRecoveryPipelineReadiness(input: {
  readonly internals: RenderSystemInternals;
  readonly pipelineState: PipelineState;
  readonly camera: CameraSnapshot;
  readonly standardLighting: StandardTopologyInputValue | undefined;
  readonly validated: readonly ValidatedRenderable[];
  readonly dispatch: readonly DispatchEntry[];
  readonly shadowCastersActive: boolean;
  readonly splitLdrSprite: boolean;
  readonly reflectionFallbackAvailable: boolean;
}): RecoveryPipelineReadiness {
  const requests: RecoveryPipelineRequest[] = [];
  const requestKeys = new Set<string>();
  const sampleCount =
    input.camera.antialias === 'msaa' && input.internals.device.caps.backendKind !== 'wgpu-webgl2'
      ? 4
      : 1;
  const isHdrTarget = input.camera.tonemap !== 'none' || input.reflectionFallbackAvailable;
  addStandardMaterialRequests({
    requests,
    requestKeys,
    internals: input.internals,
    pipelineState: input.pipelineState,
    validated: input.validated,
    standardLighting: input.standardLighting,
    sampleCount,
    isHdrTarget,
    reflectionFallbackAvailable: input.reflectionFallbackAvailable,
  });
  if (input.splitLdrSprite) {
    // The split pass is the non-tonemapped Standard scene target, not the
    // swap-chain storage/view format. StandardForwardLane keeps that target
    // rgba16float on every non-clear linear-LDR path; using the surface format
    // here would prepare a different PipelineSpec from the record seam and
    // force a first-frame PSO miss.
    const colorFormat = 'rgba16float' as GPUTextureFormat;
    addTransparentSpriteRequests({
      requests,
      requestKeys,
      internals: input.internals,
      pipelineState: input.pipelineState,
      validated: input.validated,
      standardLighting: input.standardLighting,
      sampleCount,
      isHdrTarget: isHdrTarget || colorFormat === 'rgba16float',
      colorFormat,
    });
  }
  const hasTriangleGeometry = input.validated.some((entry) =>
    entry.mesh.submeshes.some(
      (submesh) => submesh.topology === 'triangle-list' || submesh.topology === 'triangle-strip',
    ),
  );
  if (input.shadowCastersActive && hasTriangleGeometry) {
    addShadowRequests({
      requests,
      requestKeys,
      internals: input.internals,
      pipelineState: input.pipelineState,
      validated: input.validated,
      dispatch: input.dispatch,
    });
  }
  const assertFirstRecoveryFrame = (): void => {
    for (const request of requests) {
      const first = request.resolve();
      const second = request.resolve();
      if (first === null || second === null || first.pipeline !== second.pipeline) {
        throw new PipelineSpecError({
          code: 'pipeline-build-failed',
          detail: {
            spec: request.spec,
            stablePipeline: first !== null && second !== null && first.pipeline === second.pipeline,
          },
          hint: 'the recovery candidate must resolve every LKG pipeline twice from its prepared cache',
        });
      }
    }
  };
  assertFirstRecoveryFrame();
  return {
    pipelineSpecs: Object.freeze(requests.map((request) => request.spec)),
    assertFirstRecoveryFrame,
  };
}
