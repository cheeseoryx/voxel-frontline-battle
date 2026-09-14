// @forgeax/engine-runtime - RenderSystem record stage: main-pass geometry draws.
// feat-20260704 M5/w31: further-split from main-pass.ts (AC-05 <=1500 lines/file).
// recordGeometryDraws + resolveGeometryInstanceBuffer, moved verbatim.

import type { World } from '@forgeax/engine-ecs';
import {
  type BindGroup,
  type Buffer,
  type RenderPipeline,
  RhiError,
  type RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import type { ParamSchemaEntry, PassKind, PrimitiveTopology } from '@forgeax/engine-types';
import { GpuBuffer } from '../gpu-resource';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { createHdrpSkinUnifiedBindGroup, getOrCreateHdrpBuffers } from '../hdrp-buffers';
import type { InstanceBufferCacheEntry } from '../instance-buffer-cache';
import {
  type InstanceCollectionFailureCode,
  recordInstanceFailure,
  recordInstanceResidency,
} from '../instances';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '../materials';
import {
  createPbrSkinMeshBindGroupEntries,
  isCanonicalStandardPbrMaterialShader,
  isStandardPbrMaterialShader,
  isStandardPbrSkinMaterialShader,
  materialBindGroupLayoutIdentity,
  pbrSkinMeshDynamicOffsets,
  physicalTextureFields,
  SKIN_MATERIAL_SHADER_ID,
} from '../pbr-pipeline';
import {
  renderStateHash,
  standardStorageVariantSet,
  standardTopologyVariantSet,
  variantSetFromVertexLayoutProjection,
} from '../pipeline-spec';
import type { PointsLinesRecordPlan } from '../points-lines/record';
import { POINTS_LINES_MATERIAL_SHADER_ID } from '../points-lines/record';
import type { RenderRecordPhase } from '../render-contract';
import type { DispatchEntry, MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import {
  PROBE_BLEND_RECORD_BYTE_SIZE,
  PROBE_BLEND_RECORD_STRIDE,
  probeBlendRecordOffset,
} from '../scene/probe-blend-record';
import {
  getOpaqueResourceIdentity,
  instanceCollectionCacheKey,
  worldEntityKey,
} from './frame-snapshot';
import {
  geometryRenderStateForTopology,
  isEntityFullyTransparent,
  selectGeometryPipeline,
  selectMaterialGroup2,
} from './main-pass-material';
import {
  getOrCreateFromChain,
  INSTANCE_STORAGE_STRIDE_FLOATS,
  INSTANCE_UBO_FULL_ARRAY_BYTES,
  MAX_UNIFORM_INSTANCES,
  MESH_PER_ENTITY_STRIDE,
  MESH_SSBO_BYTES,
  MESH_UBO_FULL_ARRAY_BYTES,
  packInstanceStorageBuffer,
} from './mesh-ssbo';
import type { _InternalRenderPipelineContext, MaterialShaderPipelineEntry } from './render-context';
import { MATERIAL_PER_ENTITY_STRIDE } from './render-context';
import { POINTS_LINES_VIEW_SLOT_STRIDE, writePointsLinesViewUbo } from './view-ubo';

type GeometryInstanceDraw = {
  readonly instanceBuffer: Buffer;
  readonly instanceBindGroup: BindGroup;
  /** -1 means the no-probe layout and therefore no dynamic offset. */
  readonly probeOffset: number;
  readonly instanceCount: number;
};

type InstanceUploadResult =
  | {
      readonly ok: true;
      readonly ranges: readonly { readonly start: number; readonly end: number }[];
      readonly bytes: number;
    }
  | {
      readonly ok: false;
      readonly ranges: readonly { readonly start: number; readonly end: number }[];
      readonly bytes: number;
    };

type GeometryBindingState = {
  pipeline: RenderPipeline | null;
  instancesBuffer: Buffer | null;
  probeOffset: number;
};

function materialDiagnosticsEnabled(): boolean {
  if (typeof globalThis !== 'object' || globalThis === null || !('process' in globalThis)) {
    return false;
  }
  const processValue = (
    globalThis as {
      readonly process?: { readonly env?: Record<string, string | undefined> };
    }
  ).process;
  return processValue?.env?.FORGEAX_MATERIAL_DIAGNOSTICS === '1';
}

type MaterialPipelineLookup = {
  readonly materialShaderId: string;
  readonly isHdrTarget: boolean;
  readonly renderStateKey: string;
  readonly topology: PrimitiveTopology;
  readonly indexFormat: 'uint16' | 'uint32';
  readonly variantSet: string | undefined;
  readonly vertexEntry: string | undefined;
  readonly fragmentEntry: string | undefined;
  readonly passKind: PassKind;
  readonly layoutProjection: import('@forgeax/engine-geometry').VertexLayoutProjection;
  readonly sampleCount: number;
  readonly colorFormatOverride: GPUTextureFormat | undefined;
  readonly additionalColorFormats: readonly GPUTextureFormat[] | undefined;
  readonly handle: MaterialShaderPipelineEntry | null;
};

type GeometryRecordProfileSegment = 'material-bind-groups' | 'pipeline-selection' | 'draw-submit';

type GeometryRenderState = ReturnType<typeof geometryRenderStateForTopology>;

/**
 * Select the transmission shader axis from authored material data, not the
 * canonical boot schema.  The latter reserves transmission fields for the
 * shared Standard ABI even when a material remains base-only.
 */
export function requestsStandardTransmissionVariant(
  material: Pick<MaterialSnapshot, 'materialShaderId' | 'paramSnapshot'>,
): boolean {
  return (
    material.materialShaderId === 'forgeax::default-standard-pbr' &&
    material.paramSnapshot?.transmission !== undefined
  );
}

function recordIblPipelineBinding(
  c: _InternalRenderPipelineContext,
  material: MaterialSnapshot,
  pipeline: RenderPipeline,
  materialGroup: BindGroup,
): void {
  const receipt = c.frameState.iblBindingInspection;
  if (receipt === undefined || !isStandardPbrMaterialShader(material.materialShaderId)) return;
  const materialBgl =
    c.runtime.getMaterialBindGroupLayout?.(
      material.materialShaderId ?? 'forgeax::default-standard-pbr',
    ) ?? c.pipelineState.materialBindGroupLayout;
  c.frameState.iblBindingInspection = {
    ...receipt,
    pipeline: {
      pipelineIdentity: getOpaqueResourceIdentity(pipeline as object),
      effectiveMaterialLayoutIdentity: effectiveMaterialLayoutIdentity(
        material.materialShaderId ?? 'forgeax::default-standard-pbr',
        material.materialParamSchema,
      ),
      materialBglIdentity: getOpaqueResourceIdentity(materialBgl as object),
      bindGroupIdentity: getOpaqueResourceIdentity(materialGroup as object),
      drawFrameId: c.frameState.frameNumber,
    },
  };
  const materialReceipt = c.frameState.iblBindingInspection.material;
  const errors: string[] = [];
  if (
    materialReceipt !== undefined &&
    materialReceipt.materialBglIdentity !== getOpaqueResourceIdentity(materialBgl as object)
  ) {
    errors.push('material-pipeline-bgl-identity-mismatch');
  }
  if (
    materialReceipt !== undefined &&
    materialReceipt.bindGroupIdentity !== getOpaqueResourceIdentity(materialGroup as object)
  ) {
    errors.push('material-bind-group-identity-mismatch');
  }
  if (materialReceipt !== undefined) {
    const expectedResourceIdentities = [
      receipt.resources.irradiance.viewIdentity,
      receipt.resources.irradiance.samplerIdentity,
      receipt.resources.prefilter.viewIdentity,
      receipt.resources.prefilter.samplerIdentity,
      receipt.resources.brdfLut.viewIdentity,
      receipt.resources.brdfLut.samplerIdentity,
      receipt.resources.intensityBufferIdentity,
    ];
    const actualResourceIdentities = materialReceipt.entries
      .filter((entry) => entry.binding >= materialReceipt.skylightBindingStart)
      .slice(0, expectedResourceIdentities.length)
      .map((entry) => entry.resourceIdentity);
    if (
      actualResourceIdentities.length !== expectedResourceIdentities.length ||
      actualResourceIdentities.some(
        (identity, index) => identity !== expectedResourceIdentities[index],
      )
    ) {
      errors.push('material-ibl-resource-identity-mismatch');
    }
  }
  c.frameState.iblBindingInspection = {
    ...c.frameState.iblBindingInspection,
    status: errors.length === 0 ? 'binding-chain-consistent' : 'binding-chain-mismatch',
    errors,
  };
}

const SHARED_BOOT_MATERIAL_SHADER_IDS = new Set([
  'forgeax::default-unlit',
  'forgeax::default-shadow-caster',
  'forgeax::sprite',
  'forgeax::sprite-lit',
  'forgeax::default-sprite',
  'forgeax::msdf-text',
  'forgeax::default-standard-pbr',
  'forgeax::pbr-skin',
  'forgeax::default-standard-pbr-skin',
]);

/**
 * Returns the layout identity that can distinguish a material PSO in the
 * record cache. Shared boot shaders keep the boot layout identity even when a
 * manifest exposes a schema; Standard PBR only opts into a schema-derived
 * identity when authored clearcoat texture bindings extend that layout.
 */
export function effectiveMaterialLayoutIdentity(
  materialShaderId: string,
  materialParamSchema?: readonly ParamSchemaEntry[],
): string | undefined {
  if (materialParamSchema === undefined) return undefined;
  const hasStandardPhysicalMaps =
    isStandardPbrMaterialShader(materialShaderId) &&
    physicalTextureFields(materialParamSchema).length > 0;
  if (SHARED_BOOT_MATERIAL_SHADER_IDS.has(materialShaderId) && !hasStandardPhysicalMaps) {
    return undefined;
  }
  return materialBindGroupLayoutIdentity(materialShaderId, materialParamSchema);
}

/**
 * Resolve the depth contract for a geometry pass without changing the base
 * material state. Temporal scene-data shares the main pass depth attachment:
 * it is read-only and accepts the equal depth produced by the unjittered
 * temporal projection, while still rejecting fragments behind the visible
 * surface.
 */
export function geometryRenderStateForPass(
  base: GeometryRenderState,
  passKind: PassKind,
): GeometryRenderState {
  if (passKind !== 'temporal') return base;
  return {
    ...base,
    depthWriteEnabled: false,
    depthCompare: 'less-equal' as const,
  };
}

function geometryRecordPhase(
  passKind: PassKind,
  segment: GeometryRecordProfileSegment,
): RenderRecordPhase {
  const pass = passKind === 'deferred' ? 'g-buffer' : 'forward';
  return `record/graph-execute/${pass}/${segment}` as RenderRecordPhase;
}

function profileGeometrySegment<T>(
  c: _InternalRenderPipelineContext,
  passKind: PassKind,
  segment: GeometryRecordProfileSegment,
  action: () => T,
): T {
  const profilePhase = c.profilePhase;
  return profilePhase === undefined
    ? action()
    : profilePhase(geometryRecordPhase(passKind, segment), action);
}

function submitSubmeshDraws(
  pass: RhiRenderPassEncoder,
  state: GeometryBindingState,
  pipeline: RenderPipeline,
  instanceDraws: readonly GeometryInstanceDraw[],
  indexed: boolean,
  indexCount: number,
  vertexCount: number,
  indexOffset: number,
  onDraw?: () => void,
): void {
  if (state.pipeline !== pipeline) {
    pass.setPipeline(pipeline);
    state.pipeline = pipeline;
  }
  for (const instanceDraw of instanceDraws) {
    if (
      instanceDraw.instanceBuffer !== state.instancesBuffer ||
      instanceDraw.probeOffset !== state.probeOffset
    ) {
      if (instanceDraw.probeOffset < 0) {
        pass.setBindGroup(3, instanceDraw.instanceBindGroup);
      } else {
        pass.setBindGroup(3, instanceDraw.instanceBindGroup, [instanceDraw.probeOffset]);
      }
      state.instancesBuffer = instanceDraw.instanceBuffer;
      state.probeOffset = instanceDraw.probeOffset;
    }
    if (indexed) {
      pass.drawIndexed(indexCount, instanceDraw.instanceCount, indexOffset, 0, 0);
    } else {
      pass.draw(vertexCount, instanceDraw.instanceCount, 0, 0);
    }
    onDraw?.();
  }
}

/**
 * Issues a prepared Points/Lines draw into the already-open geometry pass.
 * Pass lifetime, attachments, bind groups, and submission remain owned by the
 * existing main-pass interpreter.
 */
export function recordPointsLinesDraw(
  pass: RhiRenderPassEncoder,
  plan: PointsLinesRecordPlan,
): void {
  if (plan.drawCount === 0) return;
  if (plan.indexCount > 0) {
    pass.drawIndexed(plan.indexCount, 1, 0, 0, 0);
    return;
  }
  pass.draw(plan.vertexCount, 1, 0, 0);
}

/**
 * feat-20260704 M3/w19: per-entity geometry (main colour) draw loop, extracted
 * verbatim from recordMainPass. Walks `c.validatedOrdered`, selects the
 * per-entity / per-submesh PBR / unlit / skin pipeline, uploads the per-submesh
 * material UBO slices, binds view / material / mesh / instances bind groups, and
 * issues the per-submesh draws into the already-begun geometry `pass`. Fully-
 * transparent entities are skipped here (drawn in the LDR blend sub-pass);
 * mixed meshes draw their opaque submeshes here and skip transparent submeshes.
 * The pass-selector match set, per-entity material-slot start table, MSAA sample
 * count, Standard group(2) bind group, fallback mesh group(2) bind group, and
 * the shared per-submesh material BG builder are threaded in explicitly.
 *
 * @internal
 */
export function recordGeometryDraws(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  matchedMaterials: ReadonlyMap<number, ReadonlySet<number>> | null,
  materialSlotIndices: readonly (readonly number[])[],
  sampleCount: number,
  meshGroup2: BindGroup | null,
  meshBindGroup: BindGroup | null,
  resolveMaterialBindGroup: (
    materialSlot: number,
    submeshMaterial: MaterialSnapshot,
    entityKey: number,
    materialWorld: World,
    materialShaderId?: string,
  ) => BindGroup,
  passKind: PassKind = 'forward',
  selectedDispatch?: readonly DispatchEntry[],
): void {
  const {
    runtime,
    pipelineState,
    frameState,
    bindGroupCounts,
    dispatchCounts,
    tonemapActive,
    msaaActive,
    validatedOrdered,
    splitLdrSprite,
    viewBindGroup,
    viewBindGroupDynamicOffset = 0,
  } = c;
  const materialPasses = new Map<number, Map<number, DispatchEntry[]>>();
  for (const dispatch of selectedDispatch ?? []) {
    let byMaterial = materialPasses.get(dispatch.renderableIndex);
    if (byMaterial === undefined) {
      byMaterial = new Map();
      materialPasses.set(dispatch.renderableIndex, byMaterial);
    }
    const passes = byMaterial.get(dispatch.materialHandle);
    if (passes === undefined) byMaterial.set(dispatch.materialHandle, [dispatch]);
    else passes.push(dispatch);
  }
  const diagnosticsEnabled = materialDiagnosticsEnabled();
  const colorFormatOverride = c.transparentColorFormat as GPUTextureFormat | undefined;
  // The prepared Standard topology is the frame authority. A bind-group
  // identity is only a resource result; using it to infer the shader lane
  // would silently fall back to URP when the clustered resource is missing.
  const clusteredLighting = c.standardLighting?.kind === 'clustered';
  // A no-tone frame may still render into the graph-owned rgba16float target
  // (the linear-LDR route). Shader variants must follow the attachment's
  // numeric domain rather than the camera's tone-map switch, otherwise the
  // LDR/OETF fragment entry point is encoded once here and again by the
  // output transform.
  const isHdrTarget = tonemapActive || colorFormatOverride === 'rgba16float';
  let lastVertexBuffer: GpuBuffer | null = null;
  let lastIndexBuffer: GpuBuffer | null = null;
  const bindingState: GeometryBindingState = {
    pipeline: null,
    instancesBuffer: null,
    probeOffset: -1,
  };
  const identityInstanceBuffer = pipelineState.identityInstanceBuffer;
  const identityInstanceDraws: readonly GeometryInstanceDraw[] = [
    {
      instanceBuffer: identityInstanceBuffer,
      instanceBindGroup: resolveGeometryInstancesBindGroup(c, identityInstanceBuffer, undefined),
      probeOffset: -1,
      instanceCount: 1,
    },
  ];
  const profilePhase = c.profilePhase;
  const materialGroup1DynamicOffsets = new Uint32Array(1);
  const meshGroup2DynamicOffsets = [0];
  let lastStencilReference: number | null = null;
  // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w14 (D-7):
  // sprite PSO selection no longer maintains a dedicated tag — the
  // generic materialShaderId path covers sprite via the same per-
  // MaterialShader pipeline cache PBR / unlit use. The 4-placeholder
  // BG bindings (D-1 candidate b) still apply via the generic per-
  // submesh BG construction below; sprite's `forgeax::sprite` shader
  // module ships through the same cache key formula.
  // Pipeline identity does not include material parameters or the material
  // asset handle. Keying this cache by material handle therefore misses for
  // every distinct asset even when all assets use the same PSO. The nested
  // table keeps lookup O(1) by shader and immutable render-state identity; the
  // renderer's authoritative cache still owns lifetime/invalidation, while
  // this frame-local table removes the hot call/lookup overhead.
  const materialPipelineLookupCache = new Map<string, Map<string, MaterialPipelineLookup[]>>();
  const recordOcclusionCandidate = (draw: () => void): void => {
    draw();
  };
  const resolveMaterialPipeline = (
    materialShaderId: string,
    renderState: MaterialSnapshot['renderState'],
    topology: PrimitiveTopology,
    indexFormat: 'uint16' | 'uint32',
    variantSet: string | undefined,
    colorFormat: GPUTextureFormat | undefined,
    layoutProjection: import('@forgeax/engine-geometry').VertexLayoutProjection,
    vertexEntry?: string,
    fragmentEntry?: string,
  ): MaterialShaderPipelineEntry | null => {
    // The fallback MRT is an extension of the built-in Standard PBR output
    // contract only.  The render pass may carry a second attachment whenever
    // another renderable needs S_fallback, but shaders such as unlit, sprite,
    // and the skin PBR variant still expose only @location(0).  Passing that
    // attachment into their PSO would make WebGPU reject the pipeline before
    // the first draw ("Color target has no corresponding fragment stage
    // output").  Keep the graph attachment shared while deriving pipeline
    // targets from the shader's actual output contract.
    const reflectionFallbackFormats =
      materialShaderId === 'forgeax::default-standard-pbr' &&
      c.reflectionFallbackColorFormat !== undefined
        ? [c.reflectionFallbackColorFormat]
        : undefined;
    const renderStateKey = renderStateHash(renderState);
    const shaderLookupCache = materialPipelineLookupCache.get(materialShaderId);
    const cachedLookups = shaderLookupCache?.get(renderStateKey);
    if (cachedLookups !== undefined) {
      for (const cached of cachedLookups) {
        if (
          cached.isHdrTarget === isHdrTarget &&
          cached.renderStateKey === renderStateKey &&
          cached.topology === topology &&
          cached.indexFormat === indexFormat &&
          cached.variantSet === variantSet &&
          cached.vertexEntry === vertexEntry &&
          cached.fragmentEntry === fragmentEntry &&
          cached.passKind === passKind &&
          cached.layoutProjection.digest === layoutProjection.digest &&
          cached.sampleCount === sampleCount &&
          cached.colorFormatOverride === colorFormat &&
          cached.additionalColorFormats?.join(',') === reflectionFallbackFormats?.join(',')
        ) {
          return cached.handle;
        }
      }
    }
    const resolvedVariantSetResult =
      runtime.getMaterialArtifact?.(materialShaderId) !== undefined
        ? ({ ok: true, value: undefined } as const)
        : variantSet === undefined &&
            (materialShaderId === 'forgeax::sprite' || materialShaderId === 'forgeax::sprite-lit')
          ? ({ ok: true, value: undefined } as const)
          : variantSetFromVertexLayoutProjection(layoutProjection, variantSet);
    if (!resolvedVariantSetResult.ok) {
      runtime.errorRegistry.fire(resolvedVariantSetResult.error);
      return null;
    }
    const resolvedVariantSet = resolvedVariantSetResult.value;
    const fallbackVariantSet =
      materialShaderId !== 'forgeax::default-standard-pbr'
        ? resolvedVariantSet
        : c.reflectionFallbackColorFormat !== undefined && resolvedVariantSet === ''
          ? ''
          : `${resolvedVariantSet === undefined || resolvedVariantSet === '' ? '' : `${resolvedVariantSet}+`}REFLECTION_FALLBACK_AVAILABLE=${c.reflectionFallbackColorFormat !== undefined}`;
    const resolvePipeline = () =>
      runtime.getMaterialShaderPipelineEntry?.(
        materialShaderId,
        isHdrTarget,
        renderState,
        topology,
        indexFormat,
        fallbackVariantSet,
        passKind,
        undefined,
        sampleCount,
        colorFormat,
        undefined,
        undefined,
        undefined,
        layoutProjection,
        undefined,
        undefined,
        reflectionFallbackFormats,
        vertexEntry,
        fragmentEntry,
      ) ?? null;
    const handle =
      profilePhase === undefined
        ? resolvePipeline()
        : profileGeometrySegment(c, passKind, 'pipeline-selection', resolvePipeline);
    // A null handle is a transient async-build signal (`rhi-not-available`),
    // not a stable pipeline result. Do not memoize it in this frame's lookup:
    // caching the first pending lookup would turn a one-frame shader warm-up
    // into a permanent skip for every later frame in a tight smoke loop. The
    // owning runtime cache remains the SSOT; retrying here is bounded by the
    // existing per-frame draw path and preserves the explicit skip-draw
    // recovery while the pipeline becomes ready.
    if (handle !== null) {
      const nextLookup: MaterialPipelineLookup = {
        materialShaderId,
        isHdrTarget,
        renderStateKey,
        topology,
        indexFormat,
        variantSet,
        vertexEntry,
        fragmentEntry,
        passKind,
        layoutProjection,
        sampleCount,
        colorFormatOverride: colorFormat,
        additionalColorFormats: reflectionFallbackFormats,
        handle,
      };
      if (shaderLookupCache === undefined) {
        materialPipelineLookupCache.set(
          materialShaderId,
          new Map([[renderStateKey, [nextLookup]]]),
        );
      } else if (cachedLookups === undefined) {
        shaderLookupCache.set(renderStateKey, [nextLookup]);
      } else {
        cachedLookups.push(nextLookup);
      }
    }
    return handle;
  };

  for (let i = 0; i < validatedOrdered.length; i++) {
    const entry = validatedOrdered[i];
    if (entry === undefined) continue;

    // Points/Lines share the Standard geometry pass. Their retained source
    // is prepared once by the renderer owner, while this loop remains the
    // sole pass/draw submission owner and preserves the authored topology.
    const pointsLinesSubmission = c.pointsLines?.prepare(entry, clusteredLighting);
    if (entry.source.pointsLines !== undefined && pointsLinesSubmission?.plan.drawCount !== 1)
      continue;

    if (
      passKind === 'forward' &&
      c.gpuDrivenEntityKeys.has(
        worldEntityKey(
          c.gpuDrivenWorldKeys?.[entry.source.worldId] ?? entry.source.worldId,
          entry.source.entityKey,
        ),
      )
    ) {
      continue;
    }

    // feat-20260609 M2: skip entities that don't match the pass selector.
    if (matchedMaterials !== null && !matchedMaterials.has(entry.renderableIndex)) continue;

    // D-2 generalised feat-20260625 M2 / w7: transparent entities are
    // dispatched in the separate sub-pass (bgra8unorm unorm view,
    // loadOp=load) so they must NOT be drawn here in the geometry pass
    // (bgra8unorm-srgb sRGB view, loadOp=clear). In the HDR path
    // (tonemapActive=true) or when there are no transparent entries,
    // splitLdrSprite=false and this guard is a no-op. Post-w13 the
    // legacy shadingModel arm is gone; transparent is the single SSOT
    // mirrored on `computeSplitLdrSprite`.
    //
    // feat-city-glb Bug 5 (per-submesh transparency): only skip the WHOLE
    // entity here when EVERY submesh is transparent (the sprite / fully-
    // transparent-mesh fast path, byte-identical to the pre-fix behavior for
    // single-material entities). A mixed mesh (opaque road submesh + BLEND
    // decal submesh) is NOT skipped at the entity level; its opaque submeshes
    // draw here and the per-submesh loop below skips the transparent ones
    // (they are drawn in the blend sub-pass instead).
    if (selectedDispatch === undefined && splitLdrSprite && isEntityFullyTransparent(entry.source))
      continue;

    const pipelineTag: 'unlit' = 'unlit';

    // w10: setStencilReference per draw when the dispatch entry carries
    // a stencil reference value (plan-strategy D-3: draw-call dynamic
    // state after setPipeline). Defaults to 0 when no reference is set
    // (WebGPU stencil reference default, semantically a no-op).
    const stencilReference = entry.stencilReference ?? 0;
    if (stencilReference !== lastStencilReference) {
      pass.setStencilReference(stencilReference);
      lastStencilReference = stencilReference;
    }

    if (pointsLinesSubmission !== undefined && entry.source.pointsLines !== undefined) {
      const pointsLinesMaterial: MaterialSnapshot = {
        ...entry.source.material,
        materialShaderId: POINTS_LINES_MATERIAL_SHADER_ID,
        materialParamSchema:
          runtime.getParamSchema?.(POINTS_LINES_MATERIAL_SHADER_ID) ??
          entry.source.material.materialParamSchema,
      };
      const materialSlot = materialSlotIndices[i]?.[0] ?? 0;
      const pointsLinesBindGroup = resolveMaterialBindGroup(
        materialSlot,
        pointsLinesMaterial,
        entry.source.entityKey,
        entry.world ?? c.world,
      );
      const pointsLinesPipelineEntry = resolveMaterialPipeline(
        POINTS_LINES_MATERIAL_SHADER_ID,
        {
          ...pointsLinesMaterial.renderState,
          cullMode: 'none',
        },
        'triangle-list',
        'uint32',
        undefined,
        colorFormatOverride,
        pointsLinesSubmission.layoutProjection,
      );
      if (pointsLinesPipelineEntry === null) continue;
      const pointsLinesPipeline = pointsLinesPipelineEntry.pipeline;
      if (pipelineState.pointsLinesViewBuffer === undefined) continue;
      writePointsLinesViewUbo(
        runtime.device.queue,
        pipelineState.pointsLinesViewBuffer,
        c.camera,
        c.targetW,
        c.targetH,
        entry.source.transform.world,
        entry.source.pointsLines.style,
        i * POINTS_LINES_VIEW_SLOT_STRIDE,
      );
      pass.setBindGroup(
        0,
        viewBindGroup as BindGroup,
        new Uint32Array([0, i * POINTS_LINES_VIEW_SLOT_STRIDE]),
        0,
        2,
      );
      pass.setPipeline(pointsLinesPipeline);
      pass.setVertexBuffer(0, pointsLinesSubmission.vertexBuffer);
      pass.setIndexBuffer(pointsLinesSubmission.indexBuffer, 'uint32');
      materialGroup1DynamicOffsets[0] = materialSlot * MATERIAL_PER_ENTITY_STRIDE;
      pass.setBindGroup(1, pointsLinesBindGroup, materialGroup1DynamicOffsets, 0, 1);
      const pointsLinesMeshGroup = meshBindGroup ?? meshGroup2;
      if (pointsLinesMeshGroup === null) continue;
      pass.setBindGroup(2, pointsLinesMeshGroup, meshGroup2DynamicOffsets);
      const pointsLinesInstancesBg =
        identityInstanceDraws[0]?.instanceBindGroup ??
        resolveGeometryInstancesBindGroup(c, identityInstanceBuffer, undefined);
      pass.setBindGroup(3, pointsLinesInstancesBg);
      recordOcclusionCandidate(() => recordPointsLinesDraw(pass, pointsLinesSubmission.plan));
      c.onRenderableDraw?.(entry);
      pass.setBindGroup(0, viewBindGroup as BindGroup, [viewBindGroupDynamicOffset, 0]);
      continue;
    }

    if (entry.mesh.vertexBuffer !== lastVertexBuffer) {
      pass.setVertexBuffer(0, entry.mesh.vertexBuffer.handle);
      lastVertexBuffer = entry.mesh.vertexBuffer;
    }
    // feat-20260604 M4 / w11: vertex-only meshes (indexed === false) carry no
    // index buffer; skip setIndexBuffer entirely and dispatch via pass.draw
    // below. Indexed meshes keep the existing setIndexBuffer path unchanged.
    if (entry.mesh.indexed && entry.mesh.indexBuffer !== lastIndexBuffer) {
      if (entry.mesh.indexBuffer !== null) {
        pass.setIndexBuffer(entry.mesh.indexBuffer.handle, entry.mesh.indexFormat);
        lastIndexBuffer = entry.mesh.indexBuffer;
      }
    }

    // Dispatch counter bump — sprite folds into the same 2-bucket
    // surface for now (`pipelineDispatchCounts.{unlit, standard}`
    // mirror the original 2-pipeline scope; sprite-bucket counters
    // can land in a follow-up if AI users need them separately).
    // sprite entries do not bump either counter — the bench (M-4)
    // can read sprite render counts via the transparent bucket
    // length instead.
    if (pipelineTag === 'unlit') dispatchCounts.unlit += 1;

    const instanceDraws = resolveGeometryInstanceBuffer(c, entry, identityInstanceDraws, false);
    if (instanceDraws === null) continue;

    // feat-20260611 R2 / M8 / w28 (IS-14): skin entries need a 3-binding
    // group(2) BG matching `pbr-skin-pl` (binding 0 mesh-array UBO +
    // binding 1 current palette UBO + binding 2 previous palette UBO).
    // Building this here -- not in the
    // `meshBindGroup` factory above -- because the binding-shape
    // (1-entry vs 3-entry) is per-entry, not per-frame. URP / HDRP
    // entries keep using `meshGroup2` (1-entry mesh-array or HDRP
    // unified). The skin-variant cache key includes both buffer
    // identities so a future allocator-driven palette buffer rotation
    // invalidates the BG without manual eviction.
    //
    // PSO-availability gate: only swap to the skin BG when (a) the
    // skin pipeline layout itself was built (charter P3 fail-stop on
    // BGL-build failure), AND (b) the skin PSO cache returns a non-null
    // pipeline for this entry. Without (b), the per-submesh selector
    // below falls back to URP `standardPipeline` (`pbr-pl` layout,
    // 1-entry mesh-array BGL); binding the 3-entry skin BG against
    // that pipeline reproduces the exact `pbr-mesh-array-bgl ... does
    // not match layout pbr-skin-mesh-array-bgl` device error R1
    // captured. Mirrors the uniform null skip-draw pattern (M6-T1).
    let group2BindGroup: BindGroup = meshGroup2 as BindGroup;
    // feat-20260612-skin-palette-per-frame-upload M3 / m3-2: dyn-offset
    // tuple follows the skin group2 offset contract. Defaults to the
    // length-1 non-skin shape; the skin branch below re-computes with the
    // per-entity `entry.source.skin.byteOffset` cursor.
    meshGroup2DynamicOffsets[0] = i * MESH_PER_ENTITY_STRIDE;
    let group2DynamicOffsets: readonly number[] = meshGroup2DynamicOffsets;
    const isSkinEntry = entry.source.skin !== undefined;
    const probeBlendRecordAvailable =
      runtime.device.caps.storageBuffer && entry.source.probeBlendRecord !== undefined;
    // feat-20260612-skin-palette-per-frame-upload M1 / m1-3 + M6: the
    // record stage reads the GPU buffer reference through
    // `entry.source.skin.buffer` (per-slice carrier set at extract time
    // by allocateSlice). On the storage path every slice carries the
    // same shared buffer pointer, so the BG cache key collapses to one
    // entry per frame (miss=1 + hit=N-1). On the uniform fallback path
    // each slice carries its own per-entity 16320 B UBO, so the BG
    // cache key naturally splits per entity (one BG per buffer pointer)
    // -- there is no shared-buffer assumption to break under
    // 16 KiB UBO cap. Charter P3 explicit failure preserved: skin
    // entries skip when the pipeline layout is missing OR the slice
    // failed to allocate (no buffer field). dynOffset[1] = byteOffset
    // is 0 on the uniform path (entry already covers the full buffer)
    // and walks 0, 1536, 3072, ... on the storage path.
    const skinAllocator = pipelineState.skinPaletteAllocator;
    const skinSlice = entry.source.skin;
    // Authored Standard skin aliases deliberately publish the physical root
    // with only their STORAGE_BUFFER capability axis. Their composed WGSL is
    // the direct-lighting/palette (`skin`) ABI, even when the frame's
    // canonical Standard lane uses clustered lighting. Only the canonical
    // engine skin artifact can consume the HDRP unified skin group(2) layout;
    // selecting it from the frame topology alone would bind
    // `hdrp-skin-unified-bg-group2` to a three-entry URP skin PSO.
    const clusteredSkin =
      clusteredLighting &&
      entry.source.materials.every((material) => {
        const shaderId = material.materialShaderId;
        return (
          !isStandardPbrSkinMaterialShader(shaderId) ||
          isCanonicalStandardPbrMaterialShader(shaderId)
        );
      });
    const skinMeshBindGroupLayout = clusteredSkin
      ? pipelineState.hdrpSkinMeshBindGroupLayout
      : pipelineState.pbrSkinMeshBindGroupLayout;
    const hdrpSkinBuffers =
      isSkinEntry && clusteredSkin
        ? getOrCreateHdrpBuffers(runtime, frameState.installedPipelineConfig?.clusterGrid)
        : null;
    const skinResources =
      isSkinEntry &&
      skinMeshBindGroupLayout !== null &&
      skinAllocator !== null &&
      skinSlice !== undefined &&
      (!clusteredSkin || hdrpSkinBuffers !== null)
        ? {
            meshArrayBgl: skinMeshBindGroupLayout,
            paletteBuffer: skinSlice.buffer,
            paletteBindingWindowBytes: skinAllocator.bindingWindowBytes,
            hdrpBuffers: hdrpSkinBuffers,
          }
        : null;
    // Probe the skin PSO cache up front so we can decide whether to swap
    // to the skin BG. The same probe + selector is repeated in
    // the per-submesh loop below (the loop's variantSet derivation is
    // identical -- skin shader registers a single all-true variant so
    // the canonical empty-key rule applies on HDRP and the URP key is
    // the explicit expanded form, mirroring the standard PBR path).
    const skinVariantSetResult = variantSetFromVertexLayoutProjection(
      entry.mesh.layoutProjection,
      standardTopologyVariantSet(
        c.standardLighting,
        runtime.device.caps.storageBuffer,
        entry.mesh.layoutProjection.attributes.some((attribute) => attribute.key === 'color'),
        probeBlendRecordAvailable,
      ),
    );
    if (!skinVariantSetResult.ok) runtime.errorRegistry.fire(skinVariantSetResult.error);
    const skinVariantSet = skinVariantSetResult.ok ? skinVariantSetResult.value : undefined;
    const skinPsoProbe =
      skinResources !== null && skinVariantSetResult.ok
        ? (runtime.getMaterialShaderPipeline?.(
            SKIN_MATERIAL_SHADER_ID,
            isHdrTarget,
            entry.source.material.renderState,
            entry.mesh.submeshes[0]?.topology ?? 'triangle-list',
            entry.mesh.indexFormat,
            skinVariantSet,
            passKind,
            undefined, // meshAttributes — skin probe uses first submesh, derive from entry
            sampleCount,
            colorFormatOverride,
            undefined,
            undefined,
            undefined,
            entry.mesh.layoutProjection,
            undefined,
            undefined,
            undefined,
          ) ?? null)
        : null;
    if (skinResources !== null && skinPsoProbe !== null) {
      const meshBindSize = runtime.device.caps.storageBuffer
        ? MESH_SSBO_BYTES
        : MESH_UBO_FULL_ARRAY_BYTES;
      // m3-2 / D-8: skin BG cache miss / hit instrumentation. The chain
      // walk no longer exposes a string key to `.has()`, so we derive
      // hit/miss from the w7 `bindGroupCounts.createBindGroup` accounting:
      // snapshot the counter, run `getOrCreateFromChain`, and compare. A
      // delta of 1 means the factory ran (miss); 0 means a chain hit. This
      // publishes the per-frame counter the m3-1 acceptanceCheck reads
      // (miss=1 + hit=N-1 across N skin entries sharing one allocator
      // buffer + mesh SSBO). Field is optional + opt-in (read via
      // structural cast so prod paths that omit the counter pay nothing).
      const skinStats = (pipelineState as { _skinBgCacheStats?: { miss: number; hit: number } })
        ._skinBgCacheStats;
      const skinMissesBefore = bindGroupCounts.createBindGroup;
      const skinBindGroup: BindGroup = getOrCreateFromChain(
        frameState.meshBindGroupCache,
        [
          pipelineState.meshStorageBuffer.buffer,
          skinResources.paletteBuffer,
          ...(skinResources.hdrpBuffers === null
            ? []
            : [
                skinResources.hdrpBuffers.lightDataBuffer,
                skinResources.hdrpBuffers.clusterGridBuffer,
                skinResources.hdrpBuffers.lightIndexListBuffer,
                skinResources.hdrpBuffers.clusterUniformBuffer,
              ]),
        ],
        'pbr-skin-mesh',
        () => {
          if (skinResources.hdrpBuffers !== null) {
            const result = createHdrpSkinUnifiedBindGroup(
              runtime,
              skinResources.hdrpBuffers,
              skinResources.meshArrayBgl,
              pipelineState.meshStorageBuffer.buffer,
              skinResources.paletteBuffer,
              skinResources.paletteBindingWindowBytes,
            );
            if (result === null) {
              throw new RhiError({
                code: 'webgpu-runtime-error',
                expected: 'HDRP clustered skin BindGroup creation succeeds',
                hint: 'inspect prior errorRegistry events for createBindGroup failure detail',
              });
            }
            return result;
          }
          const result = runtime.device.createBindGroup({
            label: 'pbr-skin-mesh-bg',
            layout: skinResources.meshArrayBgl,
            entries: createPbrSkinMeshBindGroupEntries(
              pipelineState.meshStorageBuffer.buffer,
              meshBindSize,
              skinResources.paletteBuffer,
              skinResources.paletteBindingWindowBytes,
            ),
          });
          if (!result.ok) throw result.error;
          return result.value;
        },
        bindGroupCounts,
      );
      if (skinStats !== undefined) {
        if (bindGroupCounts.createBindGroup > skinMissesBefore) skinStats.miss += 1;
        else skinStats.hit += 1;
      }
      group2BindGroup = skinBindGroup;
      // m3-2: dyn-offset tuple uses the per-entity palette cursor M2 m2-6
      // wrote at the extract stage.
      // Replaces the prior PR #353 hard-coded `0` second slot -- every
      // skin entry now points the palette window at its own slice while
      // sharing the worst-case BG entry size above.
      group2DynamicOffsets = pbrSkinMeshDynamicOffsets(
        i * MESH_PER_ENTITY_STRIDE,
        entry.source.skin?.byteOffset ?? 0,
      );
    } else if (isSkinEntry) {
      // Skin entry but skin PSO not ready (cache miss / async build pending,
      // or skin pipeline layout failed at boot). Skip the draw rather than
      // fall back to URP `pbr-pl` against the 6-attribute skin VBO -- that
      // path produced the layer-3 / layer-4 device errors R1 captured. Once
      // the async PSO compile resolves the cache hits and the next frame
      // routes the skin BG + skin pipeline together. Mirrors the uniform
      // null skip-draw shape (M6-T1, charter P3 explicit failure).
      if (diagnosticsEnabled) {
        console.error(
          `[render-material] skin draw skipped: ${JSON.stringify({
            entityKey: entry.source.entityKey,
            materialHandle: entry.source.material.materialHandle,
            reason: 'skin-pipeline-unavailable',
            skinResourcesReady: skinResources !== null,
            skinPsoReady: skinPsoProbe !== null,
            paletteBufferReady: skinSlice?.buffer !== undefined,
            paletteByteOffset: skinSlice?.byteOffset,
          })}`,
        );
      }
      continue;
    }
    // feat-20260520-2d-sprite-layer-mvp M-3 / w25 (@fallback sprite
    // bucket): sprite entries get a per-entity material BindGroup so
    // each sprite carries its own texture binding at @group(1) @binding(2).
    // Bindings 3..6 (metallicRoughness sampler/texture + normal
    // sampler/texture) bind `pipelineState.defaultSampler` +
    // `pipelineState.defaultWhiteTextureView` placeholders (D-1
    // candidate b — zero new GPU resource; the 1x1 white view was
    // already provisioned for unlit / standard fallback so the sprite
    // path adds 4 binding references, no new resource code).
    //
    // Missing-texture fallback (AC-18 path 4 + R7 isolation): when the
    // sprite texture has no GPU view, the binding uses
    // `defaultWhiteTextureView` as the fallback texture and the
    // material UBO upload above wrote debug-pink colorTint so the
    // sprite is visually distinct. The warn-once + RhiError surface
    // fires inside the upload loop. R7 isolation: this does NOT change
    // the existing unlit / standard bucket missing-texture handling —
    // those keep their silent-white fallback (a future
    // `feat-future-pbr-missing-texture-fallback-explicit` will retrofit).
    // bug-20260610 layer 7d: BG is per-submesh — each iteration of
    // the submesh draw loop below builds (or cache-hits) a BG with
    // matsForRebind[smIdx]'s 5 textureViews (baseColor / MR / normal /
    // emissive / occlusion). Cache key is 14-handle-id only (entityKey
    // dropped) so identical-material submeshes / entities dedup
    // globally. Sprite path is unchanged (single spriteBg, sprite
    // per-submesh OOS-1). The non-sprite branch leaves perSubmeshBg
    // declared but null; the submesh loop reassigns it per iteration
    // and the source-grep gate in skylight-fallback-path.test.ts /
    // systems.unit.test.ts continues to match
    // `setBindGroup\s*\(\s*1\s*,\s*perSubmeshBg\b` on the in-loop call.
    // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w13 (D-1
    // candidate b): the sprite-specific BG construction is gone — sprite
    // materials reuse the same per-submesh BG path PBR / unlit use. The
    // 7-entry BGL is byte-for-byte shared (binding 0 = Material UBO,
    // 1 = baseColorSampler, 2 = baseColorTexture, 3-6 = filler samplers /
    // textureViews). Sprite's "no metallic/normal/emissive/occlusion
    // texture" simply falls through to `defaultWhite` / `defaultNormal`
    // — the same placeholders the unlit path already used. The generic
    // branch below builds the per-submesh BG.
    let perSubmeshBg: BindGroup | null = null;
    // feat-20260608 M4 / w16: per-submesh pipeline selection + draw loop.
    // Each submesh carries its own topology, so pipeline selection is per-submesh.
    // Vertex/index buffers and bind groups are set once (shared across all submeshes).
    // feat-20260608 M5 amend / w16-a: the material UBO bind (group=1)
    // ALSO moves into the loop -- the j-th submesh sees the j-th
    // material slot via dynamic offset (entitySlotStart + j) * 256.
    const matsForRebind = entry.source.materials;
    for (let smIdx = 0; smIdx < entry.mesh.submeshes.length; smIdx++) {
      const sm = entry.mesh.submeshes[smIdx];
      if (sm === undefined) continue;
      const matSlotIdx = sm.materialSlot;
      const submeshMaterial = matsForRebind[matSlotIdx] ?? entry.source.material;
      if (matchedMaterials !== null) {
        const materialHandles = matchedMaterials.get(entry.renderableIndex);
        const materialHandle = submeshMaterial.materialHandle ?? 0;
        if (materialHandles === undefined || !materialHandles.has(materialHandle)) continue;
      }
      const draws: readonly (DispatchEntry | undefined)[] =
        selectedDispatch === undefined
          ? [undefined]
          : (materialPasses.get(entry.renderableIndex)?.get(submeshMaterial.materialHandle ?? 0) ??
            []);
      for (const selectedPass of draws) {
        // Temporal projects the selected material's alpha/motion contract,
        // not its authored Forward entry points or color outputs.
        const vertexEntry = passKind === 'temporal' ? undefined : selectedPass?.vertexEntry;
        const fragmentEntry = passKind === 'temporal' ? undefined : selectedPass?.fragmentEntry;
        const selectedShaderId =
          selectedPass === undefined
            ? submeshMaterial.materialShaderId
            : selectedPass.materialShaderId;
        const selectedRenderState =
          selectedPass === undefined ? submeshMaterial.renderState : selectedPass.renderState;
        const selectedStencil =
          (selectedPass === undefined ? entry.stencilReference : selectedPass.stencilReference) ??
          0;
        if (selectedStencil !== lastStencilReference) {
          pass.setStencilReference(selectedStencil);
          lastStencilReference = selectedStencil;
        }
        // feat-city-glb Bug 5 (per-submesh transparency): in the LDR split, a
        // transparent submesh is drawn in the blend sub-pass (non-sRGB view),
        // NOT here in the sRGB geometry pass. Skip it. Opaque submeshes of the
        // same (mixed) mesh still draw here. Single-material / fully-opaque
        // meshes are unaffected (their submesh materials are not transparent).
        if (
          splitLdrSprite &&
          (selectedPass === undefined
            ? submeshMaterial.transparent === true
            : selectedRenderState?.blend !== undefined)
        ) {
          continue;
        }
        // bug-20260610 layer 7d: per-submesh BG construction. Texture
        // views resolve from `matsForRebind[smIdx]` so the j-th submesh
        // sees its own materials[j] textures (baseColor / MR / normal /
        // emissive / occlusion). Pick slot j when materials.length covers
        // smIdx; otherwise fall back to slot 0 (count-mismatch already
        // filtered by extract; this guard handles the materials.length=1
        // single-material path mapped over multi-submesh meshes safely).
        // This BG drops entityKey: identical-texture-set submeshes
        // (whether on the same entity or different ones) share one BG via
        // the shaderId-outer `materialBgShared` cache. The 14 handle
        // objects form the WeakMap chain and fully discriminate the
        // binding state since sampler/textureView/buffer handle identities
        // are stable across frames.
        //
        // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w13:
        // sprite materials now use the same per-submesh BG construction
        // (the sprite-specific BG branch above is deleted; sprite per-
        // submesh single-slot is still enforced via materialSlotIndices
        // and the sprite-shaped paramSnapshot fills the PBR-shaped BGL
        // bindings via fallback textures for the 4 unused slots).
        // feat-city-glb Bug 5: per-submesh material BG assembly extracted to
        // the shared `buildPerSubmeshMaterialBg` closure (also called by the
        // LDR blend sub-pass). Resolves the shader's user-region textures
        // (baseColor/MR/normal + a custom Nth texture), emissive/occlusion
        // injection, and Skylight merge; deduped cross-entity via the
        // shaderId-outer `materialBgShared` cache.
        const materialSlot =
          materialSlotIndices[i]?.[matSlotIdx] ?? materialSlotIndices[i]?.[0] ?? 0;
        const processValue = (
          globalThis as {
            process?: { env?: Record<string, string | undefined> };
          }
        ).process;
        if (
          processValue?.env?.FORGEAX_MATERIAL_PIPELINE_DIAGNOSTICS === '1' &&
          (submeshMaterial.materialShaderId === 'forgeax::default-standard-pbr' ||
            submeshMaterial.materialShaderId === 'forgeax::pbr-skin')
        ) {
          console.error(
            `[render-material] draw receipt: ${JSON.stringify({
              entityIndex: entry.renderableIndex,
              materialSlot,
              materialHandle: submeshMaterial.materialHandle,
              clearcoat: submeshMaterial.paramSnapshot?.clearcoat,
              shader: submeshMaterial.materialShaderId,
            })}`,
          );
        }
        perSubmeshBg =
          profilePhase === undefined
            ? resolveMaterialBindGroup(
                materialSlot,
                submeshMaterial,
                entry.source.entityKey,
                entry.world ?? c.world,
                selectedShaderId,
              )
            : profileGeometrySegment(c, passKind, 'material-bind-groups', () =>
                resolveMaterialBindGroup(
                  materialSlot,
                  submeshMaterial,
                  entry.source.entityKey,
                  entry.world ?? c.world,
                  selectedShaderId,
                ),
              );
        materialGroup1DynamicOffsets[0] = materialSlot * MATERIAL_PER_ENTITY_STRIDE;
        pass.setBindGroup(1, perSubmeshBg, materialGroup1DynamicOffsets, 0, 1);
        const smTopology = sm.topology;
        const smMaterialShaderId =
          selectedPass !== undefined
            ? selectedShaderId
            : entry.source.skin !== undefined
              ? isStandardPbrSkinMaterialShader(submeshMaterial.materialShaderId)
                ? submeshMaterial.materialShaderId
                : SKIN_MATERIAL_SHADER_ID
              : submeshMaterial.materialShaderId;
        const probeBlendAvailable =
          probeBlendRecordAvailable && isStandardPbrMaterialShader(smMaterialShaderId);
        const isSpriteShader =
          smMaterialShaderId === 'forgeax::sprite' || smMaterialShaderId === 'forgeax::sprite-lit';
        // Preserve the dedicated sprite-pass state when the linear-LDR graph
        // routes a sprite through this generic geometry path. Negative scale
        // flips winding, so back-face culling would erase the quad.
        const basePipelineRenderState = isSpriteShader
          ? {
              ...selectedRenderState,
              depthWriteEnabled: false,
              depthCompare: 'less-equal' as const,
              cullMode: 'none' as const,
              blend: selectedRenderState?.blend ?? SPRITE_PREMULTIPLIED_ALPHA_BLEND,
            }
          : geometryRenderStateForTopology(smTopology, selectedRenderState);
        const pipelineRenderState = geometryRenderStateForPass(basePipelineRenderState, passKind);
        let smPipelineHandle: typeof pipelineState.unlitPipeline;
        let materialGroup2Contract: 'mesh' | 'skin' | 'cluster' | 'skin-cluster' | undefined;
        let materialPipelineEntry: MaterialShaderPipelineEntry | null = null;
        if (smMaterialShaderId === undefined || smMaterialShaderId === 'forgeax::default-unlit') {
          const unlitShaderId = smMaterialShaderId ?? 'forgeax::default-unlit';
          const unlitProjectionVariantResult = variantSetFromVertexLayoutProjection(
            entry.mesh.layoutProjection,
            undefined,
          );
          if (!unlitProjectionVariantResult.ok) {
            runtime.errorRegistry.fire(unlitProjectionVariantResult.error);
            continue;
          }
          const unlitHasColor =
            unlitProjectionVariantResult.value === 'VERTEX_COLOR_AVAILABLE=true';
          const unlitVariantSet = standardStorageVariantSet(
            runtime.device.caps.storageBuffer,
            unlitHasColor,
          );
          const unlitRsp = resolveMaterialPipeline(
            unlitShaderId,
            pipelineRenderState,
            smTopology,
            entry.mesh.indexFormat,
            unlitVariantSet,
            colorFormatOverride,
            entry.mesh.layoutProjection,
            vertexEntry,
            fragmentEntry,
          );
          materialPipelineEntry = unlitRsp;
          smPipelineHandle =
            unlitRsp?.pipeline ??
            (colorFormatOverride === undefined
              ? selectGeometryPipeline(pipelineState, isHdrTarget, msaaActive)
              : null);
        } else if (smMaterialShaderId !== undefined) {
          // feat-20260609 M4.5 / w38 (D-11): the variantSet handed to
          // getMaterialShaderPipeline MUST mirror the boot-time
          // `definesKey` rule at createRenderer.ts:2483-2485 (sortedEntries
          // .every(v=>v===true) ? '' : 'A=v+...'). manifest variant.definesKey
          // is `''` for the all-true variant, so HDRP (both axes true) must
          // pass the canonical empty key to hit that variant via
          // findVariantByKey. Passing the expanded form would produce a
          // miss and silently fall back to the registered default WGSL,
          // creating a layout/binding mismatch under HDRP.
          //
          // URP path passes the explicit expanded form because the URP
          // variant's manifest definesKey IS that exact non-empty string
          // (CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true)
          // -- the canonical-empty rule only applies to the all-true case.
          const hasVertexColor = entry.mesh.layoutProjection.attributes.some(
            (attribute) => attribute.key === 'color',
          );
          // The all-true HDRP variant uses the canonical empty key only when
          // every variant axis is true. A plain mesh adds the geometry-owned
          // VERTEX_COLOR_AVAILABLE=false axis, so retain the two capability
          // axes explicitly or the selector would silently choose the URP
          // group(2) layout for an HDRP cluster bind group.
          const capabilityVariantSet = standardTopologyVariantSet(
            c.standardLighting,
            runtime.device.caps.storageBuffer,
            hasVertexColor,
            probeBlendAvailable,
          );
          const transmissionAvailable = requestsStandardTransmissionVariant(submeshMaterial);
          const materialCapabilityVariantSet =
            transmissionAvailable && !capabilityVariantSet.includes('TRANSMISSION_AVAILABLE=')
              ? `${capabilityVariantSet === '' ? '' : `${capabilityVariantSet}+`}TRANSMISSION_AVAILABLE=true`
              : capabilityVariantSet;
          // Sprite's base request must retain the boot-selected artifact. Only
          // SpriteInstances uses the explicit empty key for the
          // PER_INSTANCE_REGION=true variant; synthesizing the generic PBR
          // capability axes for a base sprite would invent a lazy module label
          // that has no boot seed and skip the first HDR draw.
          const variantSet = isSpriteShader
            ? smMaterialShaderId === 'forgeax::sprite' && entry.source.spriteInstances !== undefined
              ? ''
              : undefined
            : entry.variantSet === undefined
              ? materialCapabilityVariantSet
              : capabilityVariantSet === ''
                ? entry.variantSet
                : `${capabilityVariantSet}+${entry.variantSet}`;
          const cachedPipeline = resolveMaterialPipeline(
            smMaterialShaderId,
            pipelineRenderState,
            smTopology,
            entry.mesh.indexFormat,
            variantSet,
            colorFormatOverride,
            entry.mesh.layoutProjection,
            vertexEntry,
            fragmentEntry,
          );
          // feat-20260615-pipeline-spec-ssot M6-T1: cache miss resolves to
          // null uniformly across URP / HDRP / skin shaders. Charter P3
          // explicit failure: the pre-M6 URP-path silent fallback to the
          // boot-time `pipelineState.standardPipeline*` (M4.5-followup w43)
          // masked real PipelineSpecError build failures behind a
          // layout-compatible-but-wrong PSO. The per-submesh
          // `if (smPipelineHandle === null) continue` skip-draw (which
          // already covered HDRP-active and skin miss paths) is now the
          // single uniform recovery shape -- one frame of skip-draw on
          // first-touch, then the cached PSO flows in once the async
          // build resolves. The pre-loop skin-PSO probe still skips the
          // entire entry on first-submesh probe miss; this site only
          // fires on per-submesh topology variance miss.
          materialPipelineEntry = cachedPipeline;
          smPipelineHandle = cachedPipeline?.pipeline ?? null;
        } else {
          smPipelineHandle = selectGeometryPipeline(pipelineState, isHdrTarget, msaaActive);
        }

        if (smPipelineHandle === null) {
          if (diagnosticsEnabled) {
            console.error(
              `[render-material] draw skipped: ${JSON.stringify({
                entityKey: entry.source.entityKey,
                materialHandle: submeshMaterial.materialHandle,
                shader: smMaterialShaderId,
                reason: 'pipeline-unavailable',
              })}`,
            );
          }
          continue;
        }
        // The probe record is an ABI extension of the built-in Standard PBR
        // shaders only. RenderScene may retain a record on every projected
        // renderable, but unlit/custom shaders still use the one-binding
        // instances BGL and must never receive the probe bind group. Resolve
        // this per submesh so mixed-material meshes cannot cross the layouts.
        const instanceDraws = resolveGeometryInstanceBuffer(
          c,
          entry,
          identityInstanceDraws,
          probeBlendAvailable,
        );
        if (instanceDraws === null) continue;
        // Standard clustered PBR variants declare the unified cluster/SSAO
        // group(2) layout. Unlit and other URP-layout materials must bind the
        // ordinary mesh group instead; choosing one group for the whole pass
        // makes Dawn reject an otherwise valid unlit pipeline and invalidates
        // the command buffer before it reaches the surface.
        if (!isSkinEntry) {
          materialGroup2Contract = materialPipelineEntry?.group2Contract;
          if (materialGroup2Contract === undefined) continue;
          const selectedGroup = selectMaterialGroup2(
            meshGroup2,
            meshBindGroup,
            materialGroup2Contract,
          );
          if (selectedGroup === null) continue;
          group2BindGroup = selectedGroup;
        }
        if (diagnosticsEnabled && submeshMaterial.textureHandles !== undefined) {
          console.error(
            `[render-material] draw submitted: ${JSON.stringify({
              entityKey: entry.source.entityKey,
              materialHandle: submeshMaterial.materialHandle,
              shader: smMaterialShaderId,
              textureHandles: [...submeshMaterial.textureHandles.entries()].map(
                ([field, handle]) => ({
                  field,
                  handle,
                }),
              ),
              skin: isSkinEntry
                ? {
                    resourcesReady: skinResources !== null,
                    psoReady: skinPsoProbe !== null,
                    paletteBufferReady: skinSlice?.buffer !== undefined,
                    paletteByteOffset: skinSlice?.byteOffset,
                    dynamicOffsets: [...group2DynamicOffsets],
                  }
                : undefined,
              pipelineReady: true,
            })}`,
          );
        }
        pass.setBindGroup(2, group2BindGroup, group2DynamicOffsets);

        if (profilePhase === undefined) {
          recordOcclusionCandidate(() =>
            submitSubmeshDraws(
              pass,
              bindingState,
              smPipelineHandle,
              instanceDraws,
              entry.mesh.indexed,
              sm.indexCount,
              sm.vertexCount,
              sm.indexOffset,
              () => c.onRenderableDraw?.(entry),
            ),
          );
        } else {
          profileGeometrySegment(c, passKind, 'draw-submit', () =>
            recordOcclusionCandidate(() =>
              submitSubmeshDraws(
                pass,
                bindingState,
                smPipelineHandle,
                instanceDraws,
                entry.mesh.indexed,
                sm.indexCount,
                sm.vertexCount,
                sm.indexOffset,
                () => c.onRenderableDraw?.(entry),
              ),
            ),
          );
        }
        if (diagnosticsEnabled && perSubmeshBg !== null) {
          recordIblPipelineBinding(c, submeshMaterial, smPipelineHandle, perSubmeshBg);
        }
      }
    }
  }
}

/**
 * Resolve the per-entity @group(3) instance buffers for the geometry pass.
 *
 * @internal
 */
function uploadInstanceRanges(
  c: Pick<
    _InternalRenderPipelineContext,
    'runtime' | 'pipelineState' | 'frameState' | 'bindGroupCounts'
  >,
  inst: NonNullable<RenderableSnapshot['instances']>,
  buffer: Buffer,
  ranges: readonly { readonly start: number; readonly end: number }[],
  storageBacked: boolean,
  sourceOffsetInstances = 0,
): InstanceUploadResult {
  const strideBytes =
    (storageBacked ? INSTANCE_STORAGE_STRIDE_FLOATS : 16) * Float32Array.BYTES_PER_ELEMENT;
  const uploadedRanges: { start: number; end: number }[] = [];
  let uploadedBytes = 0;
  for (const range of ranges) {
    const start = Math.max(0, Math.min(inst.instanceCount, range.start));
    const end = Math.max(start, Math.min(inst.instanceCount, range.end));
    if (end <= start) continue;
    const source = inst.transforms.subarray(
      (sourceOffsetInstances + start) * 16,
      (sourceOffsetInstances + end) * 16,
    );
    const payload = storageBacked ? packInstanceStorageBuffer(source) : source;
    const written = c.runtime.device.queue.writeBuffer(buffer, start * strideBytes, payload);
    if (!written.ok) {
      c.runtime.errorRegistry.fire(written.error);
      return { ok: false, ranges: uploadedRanges, bytes: uploadedBytes };
    }
    uploadedRanges.push({ start, end });
    uploadedBytes += payload.byteLength;
  }
  return { ok: true, ranges: uploadedRanges, bytes: uploadedBytes };
}

export function reportInstanceResidency(
  c: Pick<
    _InternalRenderPipelineContext,
    'runtime' | 'pipelineState' | 'frameState' | 'bindGroupCounts'
  >,
  inst: NonNullable<RenderableSnapshot['instances']>,
  input: {
    readonly lane: 'direct-storage' | 'chunked-storage' | 'direct-uniform' | 'chunked-uniform';
    readonly requestedBytes: number;
    readonly supportedBytes: number | undefined;
    readonly uploadRanges: readonly { readonly start: number; readonly end: number }[];
    readonly uploadedBytes: number;
  },
): void {
  if (inst.collectionId === undefined || c.frameState.instanceResidency === undefined) return;
  recordInstanceResidency(c.frameState.instanceResidency, {
    collectionId: inst.collectionId,
    frameNumber: c.frameState.frameNumber,
    residentGeneration: c.runtime.deviceScope.generation,
    lane: input.lane,
    requestedBytes: input.requestedBytes,
    supportedBytes: input.supportedBytes,
    uploadRanges: input.uploadRanges,
    uploadedBytes: input.uploadedBytes,
    backend: c.runtime.device.caps.backendKind,
  });
}

function reportInstanceFailure(
  c: Pick<
    _InternalRenderPipelineContext,
    'runtime' | 'pipelineState' | 'frameState' | 'bindGroupCounts'
  >,
  inst: NonNullable<RenderableSnapshot['instances']>,
  error: {
    readonly code: InstanceCollectionFailureCode;
    readonly expected: string;
    readonly hint: string;
  },
  requestedBytes: number,
  supportedBytes: number | undefined,
): void {
  if (inst.collectionId === undefined || c.frameState.instanceResidency === undefined) return;
  recordInstanceFailure(c.frameState.instanceResidency, {
    collectionId: inst.collectionId,
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    facts: {
      requestedBytes,
      supportedBytes,
      backend: c.runtime.device.caps.backendKind,
      owner: 'renderer.instances',
      cause: error.code,
      recovery: error.hint,
    },
  });
}

function clearInstanceChunksForOwner(
  c: Pick<
    _InternalRenderPipelineContext,
    'runtime' | 'pipelineState' | 'frameState' | 'bindGroupCounts'
  >,
  ownerKey: number,
): void {
  const chunks = c.frameState.instanceBufferChunks;
  if (chunks === undefined) return;
  const prefix = `${ownerKey}:`;
  for (const [key, entry] of chunks.entries()) {
    if (!key.startsWith(prefix)) continue;
    if (!entry.buffer.isDestroyed) {
      const destroyed = entry.buffer.destroy();
      if (!destroyed.ok) c.runtime.errorRegistry.fire(destroyed.error);
    }
    chunks.delete(key);
  }
}

export function resolveStorageInstanceChunks(
  c: Pick<
    _InternalRenderPipelineContext,
    'runtime' | 'pipelineState' | 'frameState' | 'bindGroupCounts'
  >,
  entry: _InternalRenderPipelineContext['validatedOrdered'][number],
  inst: NonNullable<RenderableSnapshot['instances']>,
  cap: number,
  probeBuffer: Buffer | undefined,
  probeOffset: number,
): readonly GeometryInstanceDraw[] | null {
  const { runtime, frameState } = c;
  const strideBytes = INSTANCE_STORAGE_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
  const chunkCapacity = Math.floor(cap / strideBytes);
  if (chunkCapacity < 1) {
    reportInstanceFailure(
      c,
      inst,
      {
        code: 'limit-exceeded',
        expected: `maxStorageBufferBindingSize (${cap}) >= ${strideBytes}`,
        hint: 'use a backend with storage-buffer bindings large enough for one InstanceData record',
      },
      inst.instanceCount * strideBytes,
      cap,
    );
    runtime.errorRegistry.fire(
      new RhiError({
        code: 'limit-exceeded',
        expected: `maxStorageBufferBindingSize (${cap}) >= ${strideBytes}`,
        hint: 'use a backend with storage-buffer bindings large enough for one InstanceData record',
        detail: { maxStorageBufferBindingSize: cap, requestedBytes: strideBytes },
      }),
    );
    return null;
  }
  const ownerKey = instanceCollectionCacheKey(entry.source.worldId, inst);
  const chunks = frameState.instanceBufferChunks;
  const activeKeys = new Set<string>();
  const draws: GeometryInstanceDraw[] = [];
  const uploadedRanges: { start: number; end: number }[] = [];
  let uploadedBytes = 0;
  for (let start = 0; start < inst.instanceCount; start += chunkCapacity) {
    const end = Math.min(inst.instanceCount, start + chunkCapacity);
    const count = end - start;
    const chunkKey = `${ownerKey}:${start}`;
    activeKeys.add(chunkKey);
    // Keep stable-resident checks arithmetic-only; packing is deferred to the
    // upload path below, where a new or dirty range actually needs payload.
    const payloadBytes = count * strideBytes;
    const previous = chunks?.get(chunkKey);
    let active =
      previous !== undefined &&
      previous.uploadedArchVersion === inst.archVersion &&
      previous.uploadedByteLength === payloadBytes
        ? previous
        : undefined;
    let activeIsNew = false;
    if (active === undefined) {
      const created = runtime.device.createBuffer({
        size: payloadBytes,
        usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
        mappedAtCreation: false,
      });
      if (!created.ok) {
        runtime.errorRegistry.fire(created.error);
        reportInstanceFailure(c, inst, created.error, inst.instanceCount * strideBytes, cap);
        return null;
      }
      if (previous !== undefined && !previous.buffer.isDestroyed) {
        const destroyed = previous.buffer.destroy();
        if (!destroyed.ok) runtime.errorRegistry.fire(destroyed.error);
      }
      active = {
        buffer: new GpuBuffer(runtime.device, created.value),
        uploadedArchVersion: inst.archVersion,
        uploadedByteLength: payloadBytes,
      };
      activeIsNew = true;
      chunks?.set(chunkKey, active);
      if (chunks === undefined) frameState.transientInstanceBuffers.push(active);
    }
    if (active === undefined) return null;
    const needsUpload =
      activeIsNew || active.uploadedRevision !== (inst.revision ?? inst.archVersion);
    const rangesToUpload = [
      {
        start: 0,
        end: count,
      },
    ];
    if (needsUpload && rangesToUpload.length > 0) {
      const upload = uploadInstanceRanges(
        c,
        inst,
        active.buffer.handle,
        rangesToUpload,
        true,
        start,
      );
      for (const range of upload.ranges) {
        uploadedRanges.push({ start: range.start + start, end: range.end + start });
      }
      uploadedBytes += upload.bytes;
      if (!upload.ok) {
        reportInstanceFailure(
          c,
          inst,
          {
            code: 'queue-write-buffer-failed',
            expected:
              'the renderer-owned instance storage buffer accepts the complete instance payload',
            hint: 'retry after the active device is healthy or recover the renderer',
          },
          inst.instanceCount * strideBytes,
          cap,
        );
        return null;
      }
    }
    if (needsUpload) {
      {
        const published = { ...active, uploadedRevision: inst.revision ?? inst.archVersion };
        active = published;
        chunks?.set(chunkKey, published);
      }
    }
    const activeBuffer = active;
    draws.push({
      instanceBuffer: activeBuffer.buffer.handle,
      instanceBindGroup: resolveGeometryInstancesBindGroup(
        c,
        activeBuffer.buffer.handle,
        probeBuffer,
      ),
      probeOffset,
      instanceCount: count,
    });
  }
  if (chunks !== undefined) {
    const prefix = `${ownerKey}:`;
    for (const [key, stale] of chunks.entries()) {
      if (!key.startsWith(prefix) || activeKeys.has(key)) continue;
      if (!stale.buffer.isDestroyed) {
        const destroyed = stale.buffer.destroy();
        if (!destroyed.ok) runtime.errorRegistry.fire(destroyed.error);
      }
      chunks.delete(key);
    }
  }
  reportInstanceResidency(c, inst, {
    lane: 'chunked-storage',
    requestedBytes: inst.instanceCount * strideBytes,
    supportedBytes: cap,
    uploadRanges: uploadedRanges,
    uploadedBytes,
  });
  return draws;
}

export function resolveGeometryInstanceBuffer(
  c: Pick<
    _InternalRenderPipelineContext,
    'runtime' | 'pipelineState' | 'frameState' | 'bindGroupCounts'
  >,
  entry: _InternalRenderPipelineContext['validatedOrdered'][number],
  identityInstanceDraws: readonly GeometryInstanceDraw[],
  useProbeBlend: boolean,
): readonly GeometryInstanceDraw[] | null {
  const { runtime, pipelineState, frameState } = c;
  const inst = entry.source.instances;
  const probeBinding =
    !useProbeBlend ||
    !runtime.device.caps.storageBuffer ||
    entry.source.probeBlendRecord === undefined
      ? undefined
      : resolveProbeBlendBuffer(
          c,
          entry.source.probeBlendRecord,
          worldEntityKey(entry.source.worldId, entry.source.entityKey),
        );
  if (inst === undefined) {
    const identity = identityInstanceDraws[0];
    if (identity === undefined) return null;
    return [
      {
        ...identity,
        instanceBindGroup: resolveGeometryInstancesBindGroup(
          c,
          pipelineState.identityInstanceBuffer,
          probeBinding?.buffer,
        ),
        probeOffset: probeBinding?.offset ?? -1,
      },
    ];
  }
  // A present, empty Instances array means zero draws. Do not fall back to
  // the shared identity buffer, which would silently render one instance.
  if (inst.instanceCount === 0) return [];
  const entityCacheKey = instanceCollectionCacheKey(entry.source.worldId, inst);
  const revision = inst.revision ?? inst.archVersion;
  const sameRevision = (cached: InstanceBufferCacheEntry): boolean =>
    cached.uploadedRevision === revision;
  const fullRange = [{ start: 0, end: inst.instanceCount }] as const;
  let instanceBuffer: Buffer = pipelineState.identityInstanceBuffer;
  let instanceCount = 1;
  {
    // feat-20260526-pbr-uniform-fallback-no-storage-buffer M3 / w13:
    // caps.storageBuffer===false -> uniform fallback with 128-instance
    // cap (128 * 64B = 8192B < WebGL2 min 16384B UBO limit).
    // caps.storageBuffer===true -> existing storage buffer path unchanged.
    const uniformFallback = runtime.device.caps.storageBuffer === false;
    let instanceBufferUsage = GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST;

    if (uniformFallback && inst.instanceCount > MAX_UNIFORM_INSTANCES) {
      const ownerKey = instanceCollectionCacheKey(entry.source.worldId, inst);
      const chunks = frameState.instanceBufferChunks;
      const activeKeys = new Set<string>();
      const draws: GeometryInstanceDraw[] = [];
      const uniformStrideBytes = 16 * Float32Array.BYTES_PER_ELEMENT;
      const uploadedRanges: { start: number; end: number }[] = [];
      let uploadedBytes = 0;
      for (let start = 0; start < inst.instanceCount; start += MAX_UNIFORM_INSTANCES) {
        const count = Math.min(MAX_UNIFORM_INSTANCES, inst.instanceCount - start);
        const chunkKey = `${ownerKey}:${start}`;
        activeKeys.add(chunkKey);
        const payloadBytes = count * uniformStrideBytes;
        const previous = chunks?.get(chunkKey);
        let active =
          previous !== undefined &&
          previous.uploadedArchVersion === inst.archVersion &&
          previous.uploadedByteLength === payloadBytes
            ? previous
            : undefined;
        let activeIsNew = false;
        if (active === undefined) {
          const created = runtime.device.createBuffer({
            size: INSTANCE_UBO_FULL_ARRAY_BYTES,
            usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
          });
          if (!created.ok) {
            runtime.errorRegistry.fire(created.error);
            reportInstanceFailure(
              c,
              inst,
              created.error,
              inst.instanceCount * uniformStrideBytes,
              MAX_UNIFORM_INSTANCES * uniformStrideBytes,
            );
            return null;
          }
          if (previous !== undefined && !previous.buffer.isDestroyed) {
            const destroyed = previous.buffer.destroy();
            if (!destroyed.ok) runtime.errorRegistry.fire(destroyed.error);
          }
          active = {
            buffer: new GpuBuffer(runtime.device, created.value),
            uploadedArchVersion: inst.archVersion,
            uploadedByteLength: payloadBytes,
          };
          activeIsNew = true;
          chunks?.set(chunkKey, active);
          if (chunks === undefined) frameState.transientInstanceBuffers.push(active);
        }
        const needsUpload = activeIsNew || !sameRevision(active);
        const rangesToUpload = [
          {
            start: 0,
            end: count,
          },
        ];
        if (needsUpload && rangesToUpload.length > 0) {
          const upload = uploadInstanceRanges(
            c,
            inst,
            active.buffer.handle,
            rangesToUpload,
            false,
            start,
          );
          for (const range of upload.ranges) {
            uploadedRanges.push({ start: range.start + start, end: range.end + start });
          }
          uploadedBytes += upload.bytes;
          if (!upload.ok) {
            reportInstanceFailure(
              c,
              inst,
              {
                code: 'queue-write-buffer-failed',
                expected:
                  'the renderer-owned instance uniform buffer accepts the complete instance payload',
                hint: 'retry after the active device is healthy or recover the renderer',
              },
              inst.instanceCount * uniformStrideBytes,
              MAX_UNIFORM_INSTANCES * uniformStrideBytes,
            );
            return null;
          }
        }
        if (needsUpload) {
          const published = { ...active, uploadedRevision: revision };
          active = published;
          chunks?.set(chunkKey, published);
        }
        draws.push({
          instanceBuffer: active.buffer.handle,
          instanceBindGroup: resolveGeometryInstancesBindGroup(
            c,
            active.buffer.handle,
            probeBinding?.buffer,
          ),
          probeOffset: probeBinding?.offset ?? -1,
          instanceCount: count,
        });
      }
      if (chunks !== undefined) {
        const prefix = `${ownerKey}:`;
        for (const [key, stale] of chunks.entries()) {
          if (!key.startsWith(prefix) || activeKeys.has(key)) continue;
          if (!stale.buffer.isDestroyed) {
            const destroyed = stale.buffer.destroy();
            if (!destroyed.ok) runtime.errorRegistry.fire(destroyed.error);
          }
          chunks.delete(key);
        }
      }
      reportInstanceResidency(c, inst, {
        lane: 'chunked-uniform',
        requestedBytes: inst.instanceCount * uniformStrideBytes,
        supportedBytes: MAX_UNIFORM_INSTANCES * uniformStrideBytes,
        uploadRanges: uploadedRanges,
        uploadedBytes,
      });
      return draws;
    }
    if (uniformFallback) {
      instanceBufferUsage = GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST;
    }

    {
      // Cap-gate (LimitExceededDetail single emit point — feat-20260514
      // M3 / w15 anchor): `requestedBytes <= maxStorageBufferBindingSize`.
      // Derive the size from the authoring count; storage packing is deferred
      // until uploadInstanceRanges confirms a new or dirty resident.
      const requestedBytes =
        inst.instanceCount *
        (uniformFallback ? 16 : INSTANCE_STORAGE_STRIDE_FLOATS) *
        Float32Array.BYTES_PER_ELEMENT;
      const cap = runtime.device.limits.maxStorageBufferBindingSize;
      if (!uniformFallback && typeof cap === 'number' && cap > 0 && requestedBytes > cap) {
        const chunked = resolveStorageInstanceChunks(
          c,
          entry,
          inst,
          cap,
          probeBinding?.buffer,
          probeBinding?.offset ?? -1,
        );
        return chunked;
      } else {
        // Look up the cached GPU buffer or create a fresh one when the
        // archetype version bumped or the byte length changed.
        // entityCacheKey is the worldEntityKey + collectionId namespace.
        const cached = frameState.instanceBuffers.get(entityCacheKey);
        let active: InstanceBufferCacheEntry | null = null;
        let activeIsNew = false;
        if (
          cached !== undefined &&
          cached.uploadedArchVersion === inst.archVersion &&
          cached.uploadedByteLength === requestedBytes
        ) {
          active = cached;
        } else if (requestedBytes > 0) {
          const bufRes = runtime.device.createBuffer({
            size: uniformFallback ? INSTANCE_UBO_FULL_ARRAY_BYTES : requestedBytes,
            usage: instanceBufferUsage,
            mappedAtCreation: false,
          });
          if (!bufRes.ok) {
            runtime.errorRegistry.fire(bufRes.error);
            reportInstanceFailure(c, inst, bufRes.error, requestedBytes, cap);
            return null;
          } else {
            // feat-20260619 M4 / F12: destroy the old cached buffer
            // before replacing it with the new one (D-6).
            if (cached !== undefined && !cached.buffer.isDestroyed) {
              const r = cached.buffer.destroy();
              if (!r.ok) runtime.errorRegistry.fire(r.error);
            }
            const newBuffer = new GpuBuffer(runtime.device, bufRes.value);
            active = {
              buffer: newBuffer,
              uploadedArchVersion: inst.archVersion,
              uploadedByteLength: requestedBytes,
            };
            activeIsNew = true;
            if (active !== null) {
              // Keep the collection identity in the worldEntityKey namespace.
              frameState.instanceBuffers.set(entityCacheKey, active);
            }
          }
        }
        if (active !== null) {
          const needsUpload = activeIsNew || !sameRevision(active);
          const ranges = [fullRange[0]];
          let uploadRanges: readonly { readonly start: number; readonly end: number }[] = [];
          let uploadedBytes = 0;
          if (needsUpload && ranges.length > 0) {
            const upload = uploadInstanceRanges(
              c,
              inst,
              active.buffer.handle,
              ranges,
              !uniformFallback,
            );
            uploadRanges = upload.ranges;
            uploadedBytes = upload.bytes;
            if (!upload.ok) {
              reportInstanceFailure(
                c,
                inst,
                {
                  code: 'queue-write-buffer-failed',
                  expected:
                    'the renderer-owned instance buffer accepts the complete instance payloads',
                  hint: 'retry after the active device is healthy or recover the renderer',
                },
                requestedBytes,
                uniformFallback
                  ? MAX_UNIFORM_INSTANCES * Float32Array.BYTES_PER_ELEMENT * 16
                  : typeof cap === 'number'
                    ? cap
                    : undefined,
              );
              return null;
            }
          }
          if (needsUpload) {
            const published = { ...active, uploadedRevision: revision };
            frameState.instanceBuffers.set(entityCacheKey, published);
            active = published;
          }
          instanceBuffer = active.buffer.handle;
          instanceCount = Math.max(1, inst.instanceCount);
          reportInstanceResidency(c, inst, {
            lane: uniformFallback ? 'direct-uniform' : 'direct-storage',
            requestedBytes,
            supportedBytes: uniformFallback
              ? MAX_UNIFORM_INSTANCES * Float32Array.BYTES_PER_ELEMENT * 16
              : typeof cap === 'number'
                ? cap
                : undefined,
            uploadRanges,
            uploadedBytes,
          });
          clearInstanceChunksForOwner(c, entityCacheKey);
        }
      }
      // The cache write above is keyed by worldEntityKey(worldId, cacheKey)
      // so separate worlds cannot alias their instance buffers.
    }
  }
  return [
    {
      instanceBuffer,
      instanceBindGroup: resolveGeometryInstancesBindGroup(c, instanceBuffer, probeBinding?.buffer),
      probeOffset: probeBinding?.offset ?? -1,
      instanceCount,
    },
  ];
}

export function resolveProbeBlendBuffer(
  c: Pick<
    _InternalRenderPipelineContext,
    'runtime' | 'pipelineState' | 'frameState' | 'bindGroupCounts'
  >,
  record: import('../scene/probe-blend-record').ProbeBlendRecord | undefined,
  entityKey?: number,
): { readonly buffer: Buffer; readonly offset: number } {
  const { runtime, frameState } = c;
  const usage = runtime.device.caps.storageBuffer
    ? GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST
    : GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST;
  if (record === undefined) throw new Error('probe blend record is required for probe allocation');
  if (entityKey === undefined) throw new Error('probe blend record requires an entity key');
  const offset = probeBlendRecordOffset(record.objectKey);
  const requiredCapacity = record.objectKey + 2;
  let buffer = frameState.probeBlendRecordBuffer;
  if (buffer === undefined || frameState.probeBlendRecordBufferCapacity < requiredCapacity) {
    const created = runtime.device.createBuffer({
      label: 'probe-blend-records',
      size: requiredCapacity * PROBE_BLEND_RECORD_STRIDE,
      usage,
      mappedAtCreation: false,
    });
    if (!created.ok) throw created.error;
    buffer = new GpuBuffer(runtime.device, created.value);
    frameState.probeBlendRecordBuffer = buffer;
    frameState.probeBlendRecordBufferCapacity = requiredCapacity;
    // The cache is tied to the previous backing allocation. A new buffer has
    // no valid record contents, so every later object must upload its full
    // 160B payload even when generation/bytes match the old allocation.
    frameState.probeBlendBuffers.clear();
  }
  const cached = frameState.probeBlendBuffers.get(entityKey);
  const unchanged =
    cached !== undefined &&
    cached.generation === record.generation &&
    cached.bytes.length === record.bytes.length &&
    cached.bytes.every((value, index) => value === record.bytes[index]);
  if (!unchanged) {
    const uploaded = runtime.device.queue.writeBuffer(buffer.handle, offset, record.bytes);
    if (!uploaded.ok) throw uploaded.error;
    // Publish the generation only after the complete 160B queue write succeeds.
    frameState.probeBlendBuffers.set(entityKey, {
      generation: record.generation,
      bytes: new Uint8Array(record.bytes),
    });
  }
  return { buffer: buffer.handle, offset };
}

export function resolveGeometryInstancesBindGroup(
  c: Pick<
    _InternalRenderPipelineContext,
    'runtime' | 'pipelineState' | 'frameState' | 'bindGroupCounts'
  >,
  instanceBuffer: Buffer,
  probeBuffer?: Buffer,
): BindGroup {
  const { runtime, pipelineState, frameState, bindGroupCounts } = c;
  const layout =
    probeBuffer === undefined
      ? pipelineState.instancesBindGroupLayout
      : pipelineState.probeInstancesBindGroupLayout;
  if (layout === undefined) throw new Error('probe instances bind-group layout is unavailable');
  return getOrCreateFromChain(
    frameState.instancesBgShared,
    probeBuffer === undefined ? [layout, instanceBuffer] : [layout, instanceBuffer, probeBuffer],
    probeBuffer === undefined ? 'instances-no-probe' : 'instances-probe',
    () => {
      const result = runtime.device.createBindGroup({
        label: 'pbr-instances-bg',
        layout,
        entries: [
          {
            binding: 0,
            resource: {
              kind: 'buffer',
              value: { buffer: instanceBuffer },
            },
          },
          ...(probeBuffer === undefined
            ? []
            : [
                {
                  binding: 1,
                  resource: {
                    kind: 'buffer' as const,
                    value: { buffer: probeBuffer, offset: 0, size: PROBE_BLEND_RECORD_BYTE_SIZE },
                  },
                },
              ]),
        ],
      });
      if (!result.ok) throw result.error;
      return result.value;
    },
    bindGroupCounts,
  );
}
