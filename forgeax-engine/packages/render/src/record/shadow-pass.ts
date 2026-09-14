import { probeVideoHighPerfUpload } from '@forgeax/engine-graphics-extras';
import {
  type BindGroup,
  type BindGroupEntry,
  type Buffer,
  type RenderPipeline,
  RhiError,
  type RhiQueue,
  type RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import type { MaterialRenderState, PassSelector } from '@forgeax/engine-types';
import type { GpuBuffer } from '../gpu-resource';
import { assembleMaterialWithSkylightEntries } from '../ibl/skylight-bind-group';
import {
  buildPbrMaterialUserRegionEntries,
  createPbrSkinMeshBindGroupEntries,
  pbrSkinMeshDynamicOffsets,
  SHADOW_CASTER_SHADER_ID,
  shadowCasterVariantSet,
} from '../pbr-pipeline';
import { COOKIE_MATRIX_BYTES } from '../prepare/extended-lighting/resources';
import type { DispatchEntry, ExtractedLights } from '../render-system-extract';
import { matchPass } from '../systems/pass-selector';
import {
  resolveGeometryInstanceBuffer,
  resolveGeometryInstancesBindGroup,
} from './main-pass-geometry';
import {
  buildPerSubmeshMaterialBg,
  type PerSubmeshMaterialBgDeps,
  prepareMaterialSkylight,
} from './main-pass-material';
import {
  getOrCreateFromChain,
  MESH_PER_ENTITY_STRIDE,
  MESH_SSBO_BYTES,
  MESH_UBO_FULL_ARRAY_BYTES,
} from './mesh-ssbo';
import type { _InternalRenderPipelineContext } from './render-context';
import { MATERIAL_PER_ENTITY_STRIDE, STANDARD_PBR_UBO_SIZE } from './render-context';
import { POINTS_LINES_VIEW_BYTES, pointShadowViewOffset, VIEW_UNIFORM_BYTES } from './view-ubo';

export const SHADOW_CASTER_SLOT_STRIDE = 256;
export const SHADOW_CASTER_BUFFER_SIZE = SHADOW_CASTER_SLOT_STRIDE * 8;

export function directionalShadowCasterOffset(cascadeIndex: number): number {
  return SHADOW_CASTER_SLOT_STRIDE * cascadeIndex;
}

export function spotShadowCasterOffset(tile: number): number {
  return SHADOW_CASTER_SLOT_STRIDE * (4 + tile);
}

export function writeShadowCasterUniforms(
  queue: RhiQueue,
  buffer: Buffer,
  lights: ExtractedLights,
): void {
  for (let cascade = 0; cascade < 4; cascade += 1) {
    const written = queue.writeBuffer(
      buffer,
      directionalShadowCasterOffset(cascade),
      new Uint32Array([cascade, 0, 0, 0]),
    );
    if (!written.ok) throw written.error;
  }
  for (const snapshot of lights.spot) {
    const tile = snapshot.shadowAtlasTile;
    if (tile < 0 || tile >= 4 || snapshot.lightViewProj === undefined) continue;
    const offset = spotShadowCasterOffset(tile);
    const header = queue.writeBuffer(buffer, offset, new Uint32Array([0, 1, 0, 0]));
    if (!header.ok) throw header.error;
    const matrix = queue.writeBuffer(buffer, offset + 16, snapshot.lightViewProj);
    if (!matrix.ok) throw matrix.error;
  }
}

function ensureTypedShadowViewBg(
  c: _InternalRenderPipelineContext,
  viewOffset: number,
  cascadeOffset: number,
  variant: string,
): BindGroup | null {
  const { runtime, frameState, pipelineState } = c;
  const shadowSampler = pipelineState.perPassResources.shadowSampler;
  if (shadowSampler === null) return null;
  const extendedLighting = pipelineState.extendedLightingAvailable ?? false;
  const iesProfileTextureView = pipelineState.iesProfileTextureView;
  const cookieTextureView = pipelineState.cookieTextureView;
  const cookieMatrixBuffer = pipelineState.cookieMatrixBuffer;
  const ltcLambertTextureView = pipelineState.ltcLambertTextureView;
  const ltcGgxTextureView = pipelineState.ltcGgxTextureView;
  const extendedLightingCacheKeys: object[] = [];
  const extendedLightingEntries: BindGroupEntry[] = [];
  if (extendedLighting) {
    if (
      iesProfileTextureView === undefined ||
      cookieTextureView === undefined ||
      cookieMatrixBuffer === undefined ||
      ltcLambertTextureView === undefined ||
      ltcGgxTextureView === undefined
    ) {
      return null;
    }
    extendedLightingCacheKeys.push(
      pipelineState.defaultSampler,
      iesProfileTextureView,
      cookieTextureView,
      ltcLambertTextureView,
      ltcGgxTextureView,
      cookieMatrixBuffer,
    );
    extendedLightingEntries.push(
      {
        binding: 9,
        resource: { kind: 'sampler', value: pipelineState.defaultSampler },
      },
      {
        binding: 11,
        resource: { kind: 'textureView', value: iesProfileTextureView },
      },
      {
        binding: 12,
        resource: { kind: 'textureView', value: cookieTextureView },
      },
      {
        binding: 13,
        resource: { kind: 'textureView', value: ltcLambertTextureView },
      },
      {
        binding: 14,
        resource: { kind: 'textureView', value: ltcGgxTextureView },
      },
      {
        binding: 15,
        resource: {
          kind: 'buffer',
          value: { buffer: cookieMatrixBuffer, size: COOKIE_MATRIX_BYTES },
        },
      },
    );
  }
  const projectorAvailable = pipelineState.projectorAvailable !== false;
  try {
    return getOrCreateFromChain(
      frameState.viewBindGroupCache,
      [
        pipelineState.viewUniformBuffer,
        pipelineState.shadowFallbackTextureView,
        shadowSampler,
        pipelineState.shadowAtlasFallbackTextureView,
        pipelineState.shadowParamsBuffer,
        pipelineState.shadowCasterCascadeBuffer,
        pipelineState.shadowFallbackTextureView,
        ...(extendedLighting
          ? extendedLightingCacheKeys
          : projectorAvailable
            ? [pipelineState.defaultWhiteTextureView, pipelineState.defaultSampler]
            : []),
        pipelineState.pointsLinesViewBuffer ?? pipelineState.viewUniformBuffer,
      ],
      variant,
      () => {
        const created = runtime.device.createBindGroup({
          label: variant,
          layout: pipelineState.viewBindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'buffer',
                value: {
                  buffer: pipelineState.viewUniformBuffer,
                  offset: viewOffset,
                  size: VIEW_UNIFORM_BYTES,
                },
              },
            },
            {
              binding: 3,
              resource: { kind: 'textureView', value: pipelineState.shadowFallbackTextureView },
            },
            {
              binding: 4,
              resource: { kind: 'sampler', value: shadowSampler },
            },
            {
              binding: 5,
              resource: {
                kind: 'textureView',
                value: pipelineState.shadowAtlasFallbackTextureView,
              },
            },
            {
              binding: 6,
              resource: { kind: 'buffer', value: { buffer: pipelineState.shadowParamsBuffer } },
            },
            {
              binding: 7,
              resource: {
                kind: 'buffer',
                value: {
                  buffer: pipelineState.shadowCasterCascadeBuffer,
                  offset: cascadeOffset,
                  size: POINTS_LINES_VIEW_BYTES,
                },
              },
            },
            {
              binding: 8,
              resource: { kind: 'textureView', value: pipelineState.shadowFallbackTextureView },
            },
            ...extendedLightingEntries,
            {
              binding: 10,
              resource: {
                kind: 'buffer',
                value: {
                  buffer: pipelineState.pointsLinesViewBuffer ?? pipelineState.viewUniformBuffer,
                  size: 80,
                },
              },
            },
            ...(!extendedLighting && projectorAvailable
              ? [
                  {
                    binding: 11,
                    resource: {
                      kind: 'textureView' as const,
                      value: pipelineState.defaultWhiteTextureView,
                    },
                  },
                  {
                    binding: 12,
                    resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
                  },
                ]
              : []),
          ],
        });
        if (!created.ok) throw created.error;
        return created.value;
      },
      c.bindGroupCounts,
    );
  } catch (error) {
    if (error instanceof RhiError) {
      runtime.errorRegistry.fire(error);
      return null;
    }
    throw error;
  }
}

interface ShadowDispatch {
  readonly vertexEntry: string | undefined;
  readonly fragmentEntry: string | undefined;
  readonly materialShaderId: string;
  readonly renderState: MaterialRenderState | undefined;
}

type ShadowDispatchMap = ReadonlyMap<number, ReadonlyMap<number, ShadowDispatch>>;

export function shadowShaderMap(c: _InternalRenderPipelineContext): ShadowDispatchMap {
  const shaders = new Map<number, Map<number, ShadowDispatch>>();
  for (const entry of c.dispatch) {
    if (entry.tags.LightMode === 'ShadowCaster' && entry.materialShaderId !== undefined) {
      let byMaterial = shaders.get(entry.renderableIndex);
      if (byMaterial === undefined) {
        byMaterial = new Map<number, ShadowDispatch>();
        shaders.set(entry.renderableIndex, byMaterial);
      }
      byMaterial.set(entry.materialHandle, {
        vertexEntry: entry.vertexEntry,
        fragmentEntry: entry.fragmentEntry,
        materialShaderId:
          entry.materialShaderId === 'forgeax::default-standard-pbr'
            ? SHADOW_CASTER_SHADER_ID
            : entry.materialShaderId,
        renderState: entry.renderState,
      });
    }
  }
  return shaders;
}

function shadowPipeline(c: _InternalRenderPipelineContext): RenderPipeline | null {
  return (
    c.runtime.getMaterialShaderPipeline?.(
      SHADOW_CASTER_SHADER_ID,
      false,
      undefined,
      'triangle-list',
      undefined,
      shadowCasterVariantSet(c.runtime.device.caps.storageBuffer, false),
      'shadow-caster',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'pbr',
    ) ?? null
  );
}

function skinnedShadowPipeline(
  c: _InternalRenderPipelineContext,
  entry: _InternalRenderPipelineContext['validatedOrdered'][number],
): RenderPipeline | null {
  return (
    c.runtime.getMaterialShaderPipeline?.(
      SHADOW_CASTER_SHADER_ID,
      false,
      undefined,
      entry.mesh.submeshes[0]?.topology ?? 'triangle-list',
      entry.mesh.indexFormat,
      shadowCasterVariantSet(c.runtime.device.caps.storageBuffer, true),
      'shadow-caster',
      undefined,
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      entry.mesh.layoutProjection,
      undefined,
      'pbr-skin',
    ) ?? null
  );
}

function skinnedShadowMeshBindGroup(
  c: _InternalRenderPipelineContext,
  entry: _InternalRenderPipelineContext['validatedOrdered'][number],
): BindGroup | null {
  const skin = entry.source.skin;
  const layout = c.pipelineState.pbrSkinMeshBindGroupLayout;
  const allocator = c.pipelineState.skinPaletteAllocator;
  if (skin === undefined || layout === null || allocator === null) return null;
  return getOrCreateFromChain(
    c.frameState.meshBindGroupCache,
    [c.pipelineState.meshStorageBuffer.buffer, skin.buffer],
    'shadow-pbr-skin-mesh',
    () => {
      const created = c.runtime.device.createBindGroup({
        label: 'shadow-pbr-skin-mesh-bg',
        layout,
        entries: createPbrSkinMeshBindGroupEntries(
          c.pipelineState.meshStorageBuffer.buffer,
          c.runtime.device.caps.storageBuffer ? MESH_SSBO_BYTES : MESH_UBO_FULL_ARRAY_BYTES,
          skin.buffer,
          allocator.bindingWindowBytes,
        ),
      });
      if (!created.ok) throw created.error;
      return created.value;
    },
    c.bindGroupCounts,
  );
}

export function encodeDirectionalShadowPass(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  cascadeIndex: number,
  viewport: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
): void {
  if (c.directionalShadowCacheReuse || c.meshBindGroup === null) return;
  const pipeline = shadowPipeline(c);
  const viewBg = ensureTypedShadowViewBg(
    c,
    0,
    directionalShadowCasterOffset(cascadeIndex),
    `view-shadow-directional-${cascadeIndex}`,
  );
  const materialBg = ensureSpotShadowMaterialBg(c);
  if (pipeline === null || viewBg === null || materialBg === null) {
    c.frameState.directionalShadowCacheRecorded = false;
    return;
  }
  pass.setViewport(viewport.x, viewport.y, viewport.w, viewport.h, 0, 1);
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, viewBg, [0, 0]);
  pass.setBindGroup(1, materialBg, [0]);
  const complete = recordShadowCasterDraws(
    c,
    pass,
    pipeline,
    c.meshBindGroup,
    buildMatchedRenderableIndices(c.dispatch, { LightMode: ['ShadowCaster'] }),
    shadowShaderMap(c),
  );
  c.frameState.directionalShadowCacheRecorded =
    cascadeIndex === 0 ? complete : c.frameState.directionalShadowCacheRecorded && complete;
}

export function encodePointShadowPass(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  snapshotIndex: number,
  face: number,
): void {
  const snapshot = c.frameState.pointShadowSnapshots[snapshotIndex];
  if (snapshot === undefined || c.meshBindGroup === null) return;
  const pipeline = shadowPipeline(c);
  const viewBg = ensureTypedShadowViewBg(
    c,
    pointShadowViewOffset(snapshot.shadowAtlasLayer, face),
    0,
    `view-shadow-point-${snapshot.shadowAtlasLayer}-${face}`,
  );
  const materialBg = ensureSpotShadowMaterialBg(c);
  if (pipeline === null || viewBg === null || materialBg === null) return;
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, viewBg, [0, 0]);
  pass.setBindGroup(1, materialBg, [0]);
  recordShadowCasterDraws(
    c,
    pass,
    pipeline,
    c.meshBindGroup,
    buildMatchedRenderableIndices(c.dispatch, { LightMode: ['ShadowCaster'] }),
    shadowShaderMap(c),
  );
}

export function encodeSpotShadowPass(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  snapshotIndex: number,
): void {
  const snapshot = c.frameState.spotShadowSnapshots.filter(
    (candidate) => candidate.shadowAtlasTile >= 0 && candidate.lightViewProj !== undefined,
  )[snapshotIndex];
  if (
    snapshot === undefined ||
    snapshot.shadowAtlasTile < 0 ||
    snapshot.lightViewProj === undefined ||
    c.meshBindGroup === null
  ) {
    return;
  }
  const pipeline = shadowPipeline(c);
  const viewBg = ensureTypedShadowViewBg(
    c,
    0,
    spotShadowCasterOffset(snapshot.shadowAtlasTile),
    `view-shadow-spot-${snapshot.shadowAtlasTile}`,
  );
  const materialBg = ensureSpotShadowMaterialBg(c);
  if (pipeline === null || viewBg === null || materialBg === null) return;
  const tileSize = c.pipelineState.perPassResources.shadowMapSize;
  const tile = snapshot.shadowAtlasTile;
  pass.setViewport(
    (tile % 2) * tileSize,
    Math.floor(tile / 2) * tileSize,
    tileSize,
    tileSize,
    0,
    1,
  );
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, viewBg, [0, 0]);
  pass.setBindGroup(1, materialBg, [0]);
  // Reuse the shared caster recorder. The compact spot-only loop used to
  // depend on instance bindings created by a directional pass, so a scene
  // containing only a SpotLight opened the atlas pass but emitted no caster
  // draws.
  recordShadowCasterDraws(
    c,
    pass,
    pipeline,
    c.meshBindGroup,
    buildMatchedRenderableIndices(c.dispatch, { LightMode: ['ShadowCaster'] }),
    shadowShaderMap(c),
  );
}

/**
 * feat-20260609 M2: filter dispatch entries by a {@link PassSelector}.
 *
 * Each dispatch entry carries `tags` (a free key-value map) sourced from the
 * material's per-pass tags.  The selector is matched entry-by-entry via
 * {@link matchPass}; entries whose tags satisfy the selector are returned.
 * An empty selector returns the input array unchanged (match-all semantics).
 *
 * @param dispatch Per-frame dispatch entries (from the extract stage).
 * @param selector Pipeline-specific pass selector (e.g. `{ LightMode: ['Forward'] }`).
 * @returns Dispatch entries whose tags match the selector.
 */
export function filterDispatchBySelector(
  dispatch: readonly DispatchEntry[],
  selector: PassSelector,
): readonly DispatchEntry[] {
  if (Object.keys(selector).length === 0) return dispatch;
  return dispatch.filter((e) => matchPass(e.tags, selector));
}

/**
 * feat-20260609 M2: build a set of renderable indices whose dispatch entries
 * match the given selector.  Used by the record pass closures to skip entities
 * that do not belong to the current pass.
 *
 * Returns null when the dispatch array is empty (no dispatch-based filtering
 * to apply — draw all entities).  Returns an empty set when dispatch is
 * non-empty but no entries matched (draw nothing).  Returns a populated set
 * when at least one dispatch entry matched.
 */
export function buildMatchedRenderableIndices(
  dispatch: readonly DispatchEntry[],
  selector: PassSelector,
): Set<number> | null {
  // PRODUCTION INVARIANT: in real frames extractFrame always populates
  // dispatch[] for every visible renderable (Forward + ShadowCaster tags
  // emitted per validated entity, including the default-material handle=0
  // path — see render-system-extract.ts default-material dispatch emission).
  // The empty-dispatch null fallback below exists ONLY for unit-test
  // fixtures that mock dispatch out (early w-* tests written before
  // dispatch existed). Returning null causes the downstream loop to skip
  // selector filtering, preserving back-compat for those fixtures. If a
  // future refactor moves dispatch population earlier or makes it
  // conditional, the test fixtures should be updated rather than this
  // fallback widened to production.
  if (dispatch.length === 0) return null;
  const filtered = filterDispatchBySelector(dispatch, selector);
  const set = new Set<number>();
  for (const e of filtered) {
    set.add(e.renderableIndex);
  }
  return set;
}

/**
 * Build the material handles whose dispatch entries match a graph pass.
 *
 * A renderable can own more than one material pass, so renderable-level
 * filtering is insufficient for geometry recording: a Deferred graph pass
 * must not draw the same renderable's Forward-only material.  Keep the
 * renderable key in the result so mixed-material meshes retain their
 * per-submesh routing.
 */
export function buildMatchedMaterialHandlesByRenderable(
  dispatch: readonly DispatchEntry[],
  selector: PassSelector,
): ReadonlyMap<number, ReadonlySet<number>> | null {
  if (dispatch.length === 0) return null;
  const matched = filterDispatchBySelector(dispatch, selector);
  const handlesByRenderable = new Map<number, Set<number>>();
  for (const entry of matched) {
    const handles = handlesByRenderable.get(entry.renderableIndex);
    if (handles === undefined) {
      handlesByRenderable.set(entry.renderableIndex, new Set([entry.materialHandle]));
    } else {
      handles.add(entry.materialHandle);
    }
  }
  return handlesByRenderable;
}

/**
 * feat-20260704 M3/w20: per-entity directional shadow-caster draw loop,
 * extracted verbatim from {@link encodeDirectionalShadowPass}. Walks `c.validatedOrdered`,
 * selects the per-entity shadow PSO (default vertex-only caster or a custom
 * cutout caster), binds the per-entity mesh dynamic-offset + instance buffer,
 * and issues the per-submesh depth draws. `shadowPass` view/material bind
 * groups (@group 0/1) are already set by the caller; this loop owns @group
 * 2/3 + the vertex/index/pipeline de-dup state. Receives the explicit
 * `_InternalRenderPipelineContext` (`c`) plus the caller-resolved shadow
 * pipeline, mesh bind group, pass-selector match set, and per-material
 * ShadowCaster dispatch map so no cross-function mutable state is introduced.
 */
function recordShadowCasterDraws(
  c: _InternalRenderPipelineContext,
  shadowPass: RhiRenderPassEncoder,
  shadowPipeline: RenderPipeline,
  shadowMeshBindGroup: BindGroup,
  matchedIndices: Set<number> | null,
  shadowDispatchByRenderableIdx: ShadowDispatchMap,
): boolean {
  const { runtime, pipelineState, validatedOrdered } = c;
  // M-3 / w12: vertexBuffer/indexBuffer state locals migrate to GpuBuffer
  // (the wrapper) -- the de-dup compare uses wrapper identity (one wrapper
  // per RHI handle from gpuStore), and `.handle` is passed to the RHI
  // setVertexBuffer / setIndexBuffer call.
  let shadowLastVertexBuffer: GpuBuffer | null = null;
  let shadowLastIndexBuffer: GpuBuffer | null = null;
  // bug-20260619-csm RC-3 (D-3): track the currently-bound shadow PSO so
  // per-entity setPipeline only fires on change (same de-dup discipline as
  // vertex/index buffers above). The default-shadow-caster PSO is already
  // bound by the setPipeline call above; the loop switches to a custom
  // ShadowCaster PSO when a material supplies one.
  let shadowLastPipeline: RenderPipeline = shadowPipeline;
  let materialDeps: PerSubmeshMaterialBgDeps | undefined;
  let complete = true;

  for (let i = 0; i < validatedOrdered.length; i++) {
    const entry = validatedOrdered[i];
    if (entry === undefined) continue;

    // feat-20260609 M2: skip entities that don't match the pass selector.
    if (matchedIndices !== null && !matchedIndices.has(entry.renderableIndex)) continue;

    if (entry.source.skin !== undefined) {
      const skinPipeline = skinnedShadowPipeline(c, entry);
      if (skinPipeline === null) {
        complete = false;
        continue;
      }
      if (skinPipeline !== shadowLastPipeline) {
        shadowPass.setPipeline(skinPipeline);
        shadowLastPipeline = skinPipeline;
      }
    }
    // feat-20260604-mesh-topology-debug-draw M5 / w14 (AC-09, D-A6): the
    // shadow caster PSO is triangle-list; it only projects triangle faces.
    // line-list / line-strip / point-list meshes have no surface to cast a
    // shadow, so skip them here. triangle-strip is still a face topology
    // and projects (the shadow PSO's fixed triangle-list rasterizes its
    // expanded triangles correctly enough for the depth pass).
    //
    // feat-20260608 M4 / w16: per-submesh shadow draw — iterate submeshes
    // and skip non-triangle submeshes individually (each submesh may differ).
    const shadowSubmeshes = entry.mesh.submeshes;
    const hasAnyShadowSubmesh = shadowSubmeshes.some(
      (sm) => sm.topology === 'triangle-list' || sm.topology === 'triangle-strip',
    );
    if (!hasAnyShadowSubmesh) {
      continue;
    }

    if (entry.mesh.vertexBuffer !== shadowLastVertexBuffer) {
      shadowPass.setVertexBuffer(0, entry.mesh.vertexBuffer.handle);
      shadowLastVertexBuffer = entry.mesh.vertexBuffer;
    }
    if (entry.mesh.indexed && entry.mesh.indexBuffer !== shadowLastIndexBuffer) {
      // indexed=true implies indexBuffer is non-null GpuBuffer.
      if (entry.mesh.indexBuffer !== null) {
        shadowPass.setIndexBuffer(entry.mesh.indexBuffer.handle, entry.mesh.indexFormat);
        shadowLastIndexBuffer = entry.mesh.indexBuffer;
      }
    }

    if (entry.source.skin !== undefined) {
      const skinMeshBindGroup = skinnedShadowMeshBindGroup(c, entry);
      if (skinMeshBindGroup === null) continue;
      shadowPass.setBindGroup(
        2,
        skinMeshBindGroup,
        pbrSkinMeshDynamicOffsets(i * MESH_PER_ENTITY_STRIDE, entry.source.skin.byteOffset),
      );
    } else {
      shadowPass.setBindGroup(2, shadowMeshBindGroup, [i * MESH_PER_ENTITY_STRIDE]);
    }

    // Main and shadow passes share one instance residency owner and upload receipt.
    const shadowInstanceDraws = resolveGeometryInstanceBuffer(
      c,
      entry,
      [
        {
          instanceBuffer: pipelineState.identityInstanceBuffer,
          instanceBindGroup: resolveGeometryInstancesBindGroup(
            c,
            pipelineState.identityInstanceBuffer,
          ),
          instanceCount: 1,
          probeOffset: -1,
        },
      ],
      false,
    );
    if (shadowInstanceDraws === null) continue;

    // feat-20260608 M4 / w16: per-submesh shadow draw loop.
    // Only draw submeshes whose topology is triangle-list or triangle-strip
    // (line-list / point-list submeshes cast no shadow and are skipped).
    for (const sm of shadowSubmeshes) {
      if (sm.topology !== 'triangle-list' && sm.topology !== 'triangle-strip') {
        continue;
      }

      // Resolve the ShadowCaster PSO for the material bound to this submesh.
      // Built-in materials normally use the shared vertex-only caster, but an
      // authored `cullMode:'none'`/`frontFace` must still reach that PSO so
      // two-sided casters (such as the Three.js teapot) populate the atlas
      // from both faces. Custom ShadowCaster shaders retain their own path.
      const submeshMaterial = entry.source.materials[sm.materialSlot] ?? entry.source.material;
      const shadowDispatch = shadowDispatchByRenderableIdx
        .get(entry.renderableIndex)
        ?.get(submeshMaterial.materialHandle ?? 0);
      const entryShadowShaderId = shadowDispatch?.materialShaderId;
      const entryShadowRenderState = shadowDispatch?.renderState;
      // Canonical skin casters retain their palette layout. Authored casters
      // select their own program below with the same geometry layout.
      let entryShadowPipeline: RenderPipeline | null =
        entry.source.skin !== undefined ? shadowLastPipeline : shadowPipeline;
      if (
        entryShadowShaderId !== undefined &&
        (entryShadowShaderId !== 'forgeax::default-shadow-caster' ||
          (entryShadowRenderState !== undefined && entry.source.skin === undefined))
      ) {
        // Pending or failed authored programs must not draw using a different
        // caster. Retry preparation on the next frame with the same program.
        entryShadowPipeline =
          runtime.getMaterialShaderPipeline?.(
            entryShadowShaderId,
            false, // isHdr — shadow depth pass is always LDR
            entryShadowRenderState,
            'triangle-list', // topology — shadow PSO targets triangle-list
            undefined, // indexFormat
            undefined, // variantSet — shadow caster has no variant axes
            'shadow-caster', // passKind
            undefined, // meshAttributes
            1,
            undefined, // colorFormatOverride
            undefined, // shaderUvSetCount
            undefined, // depthFormatOverride
            undefined, // vertexLayout
            entry.mesh.layoutProjection,
            undefined, // shaderModuleMode
            entry.source.skin === undefined ? 'pbr' : 'pbr-skin',
            undefined, // additionalColorFormats
            shadowDispatch?.vertexEntry,
            shadowDispatch?.fragmentEntry,
          ) ?? null;
      }
      if (entryShadowPipeline === null) {
        complete = false;
        continue;
      }
      if (entryShadowPipeline !== shadowLastPipeline && entryShadowPipeline !== null) {
        shadowPass.setPipeline(entryShadowPipeline);
        shadowLastPipeline = entryShadowPipeline;
      }
      if (entryShadowShaderId !== undefined && entryShadowShaderId !== SHADOW_CASTER_SHADER_ID) {
        materialDeps ??= {
          runtime,
          pipelineState,
          world: c.world,
          store: c.store,
          materialSlice: STANDARD_PBR_UBO_SIZE,
          videoHighPerfAvailable: probeVideoHighPerfUpload(runtime.device),
          skylightResources: prepareMaterialSkylight(c).skylightResources,
          resolveRenderTargetTextureSource: runtime.resolveRenderTargetTextureSource,
          materialBgShared: c.frameState.materialBgShared,
          materialBgAssemblyCache: c.materialBgAssemblyCache,
          frameState: c.frameState,
          bindGroupCounts: c.bindGroupCounts,
        };
        const materialSlot =
          c.materialSlotIndices[i]?.[sm.materialSlot] ?? c.materialSlotIndices[i]?.[0];
        if (materialSlot === undefined) {
          throw new RhiError({
            code: 'rhi-descriptor-invalid',
            expected: 'a prepared material slot for each shadow submesh',
            hint: 'repair material slot preparation before recording shadows',
          });
        }
        const materialGroup = buildPerSubmeshMaterialBg(
          materialDeps,
          submeshMaterial,
          entry.source.entityKey,
          entry.world ?? c.world,
          entryShadowShaderId,
        );
        shadowPass.setBindGroup(1, materialGroup, [materialSlot * MATERIAL_PER_ENTITY_STRIDE]);
      } else {
        const materialGroup = ensureSpotShadowMaterialBg(c);
        if (materialGroup === null) continue;
        shadowPass.setBindGroup(1, materialGroup, [0]);
      }
      for (const instanceDraw of shadowInstanceDraws) {
        shadowPass.setBindGroup(3, instanceDraw.instanceBindGroup);
        if (entry.mesh.indexed) {
          shadowPass.drawIndexed(sm.indexCount, instanceDraw.instanceCount, sm.indexOffset, 0, 0);
        } else {
          shadowPass.draw(sm.vertexCount, instanceDraw.instanceCount, 0, 0);
        }
      }
    }
  }
  return complete;
}

/**
 * Build (or reuse) the dummy `shadow-material-singleton` @group(1) BG for the
 * spot shadow caster pass. The vertex-only shadow_caster shader never consumes
 * @group(1) but the PSO's BGL must validate. Reuses the same singleton Map
 * entry encodeDirectionalShadowPass / encodePointShadowPass write so the three paths share
 * one allocation per frame (D-6).
 */
function ensureSpotShadowMaterialBg(c: _InternalRenderPipelineContext): BindGroup | null {
  const { runtime, frameState, pipelineState } = c;
  const cached = frameState.singletonMaterialCache.get('shadow-material-singleton');
  if (cached !== undefined) return cached;
  const fb = pipelineState.skylightFallback;
  const fallbackEntries: BindGroupEntry[] = buildPbrMaterialUserRegionEntries().map((entry) => {
    if (entry.buffer !== undefined) {
      return {
        binding: entry.binding,
        resource: {
          kind: 'buffer' as const,
          value: {
            buffer: pipelineState.materialUniformBuffer.buffer,
            offset: 0,
            size: STANDARD_PBR_UBO_SIZE,
          },
        },
      };
    }
    if (entry.sampler !== undefined) {
      return {
        binding: entry.binding,
        resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
      };
    }
    return {
      binding: entry.binding,
      resource: {
        kind: 'textureView' as const,
        value:
          entry.binding === 6
            ? pipelineState.defaultNormalTextureView
            : pipelineState.fallbackTextureView,
      },
    };
  });
  const merged =
    fb !== null
      ? assembleMaterialWithSkylightEntries(fallbackEntries, {
          irradianceView: fb.irradianceView,
          irradianceSampler: fb.sampler,
          prefilterView: fb.prefilterView,
          prefilterSampler: fb.sampler,
          brdfLutView: fb.brdfLutView,
          brdfLutSampler: fb.sampler,
          intensityBuffer: fb.intensityBuffer,
        })
      : fallbackEntries;
  const r = runtime.device.createBindGroup({
    label: 'shadow-material-bg',
    layout: pipelineState.materialBindGroupLayout,
    entries: merged,
  });
  if (!r.ok) {
    runtime.errorRegistry.fire(r.error);
    return null;
  }
  c.bindGroupCounts.createBindGroup += 1;
  c.bindGroupCounts.keys.push('shadow-material-singleton');
  frameState.singletonMaterialCache.set('shadow-material-singleton', r.value);
  return r.value;
}
