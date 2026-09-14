import type { World } from '@forgeax/engine-ecs';
import { probeVideoHighPerfUpload } from '@forgeax/engine-graphics-extras';
import {
  type BindGroup,
  RhiError,
  type RhiRenderPassEncoder,
  type TextureView,
} from '@forgeax/engine-rhi';
import type { PassKind, PassSelector } from '@forgeax/engine-types';
import { createHdrpUnifiedBindGroup, getOrCreateHdrpBuffers } from '../hdrp-buffers';
import { getOrCreateIblCache } from '../ibl/IblPipelineCache';
import type { SkylightBindGroupResources } from '../ibl/skylight-bind-group';
import { buildBeginRenderPassDescriptor, standardTopologyBindGroupReady } from '../pipeline-spec';
import { POINTS_LINES_MATERIAL_SHADER_ID } from '../points-lines/record';
import type { ReflectionProbeSelectionResult } from '../reflection/projection';
import type { RenderRecordPhase } from '../render-contract';
import type { MaterialSnapshot } from '../render-system-extract';
import { resolveReflectionProbeBinding } from './frame-lighting';
import { getOpaqueResourceIdentity } from './frame-snapshot';
import { recordGeometryDraws } from './main-pass-geometry';
import {
  buildPerSubmeshMaterialBg as buildPerSubmeshMaterialBgImpl,
  type PerSubmeshMaterialBgDeps,
  prepareMaterialSkylight,
} from './main-pass-material';
import { recordSpritePass } from './main-pass-sprite-draws';
import type { _InternalRenderPipelineContext } from './render-context';
import { STANDARD_PBR_UBO_SIZE } from './render-context';
import {
  buildMatchedMaterialHandlesByRenderable,
  buildMatchedRenderableIndices,
  filterDispatchBySelector,
} from './shadow-pass';

export function standardReflectionProbeIndex(
  selection: ReflectionProbeSelectionResult,
): number | undefined {
  return resolveReflectionProbeBinding(selection).probeIndex;
}

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

export type MainPassOptions = {
  readonly colorViews?: readonly (TextureView | null)[];
  readonly colorFormats?: readonly GPUTextureFormat[];
  readonly depthView?: TextureView | null;
  readonly passKind?: PassKind;
  readonly clearColor?: readonly [number, number, number, number];
  readonly recordMode?: 'opaque' | 'transmission' | 'transparent';
  readonly transmissionBackdropView?: TextureView | null;
};

function isTransmissionMaterial(material: MaterialSnapshot): boolean {
  return (
    material.materialShaderId === 'forgeax::default-standard-pbr' &&
    typeof material.paramSnapshot?.transmission === 'number' &&
    material.paramSnapshot.transmission > 0
  );
}

function matchesRecordMode(
  material: MaterialSnapshot,
  mode: 'opaque' | 'transmission' | 'transparent',
): boolean {
  const transmission = isTransmissionMaterial(material);
  if (mode === 'transmission') return transmission;
  if (mode === 'transparent') return material.transparent === true && !transmission;
  return !transmission && material.transparent !== true;
}

function matchedMaterialsForRecordMode(
  c: _InternalRenderPipelineContext,
  matchedMaterials: ReadonlyMap<number, ReadonlySet<number>> | null,
  mode: 'opaque' | 'transmission' | 'transparent' | undefined,
): ReadonlyMap<number, ReadonlySet<number>> | null {
  if (mode === undefined) return matchedMaterials;
  const filtered = new Map<number, ReadonlySet<number>>();
  for (const entry of c.validatedOrdered) {
    const dispatchHandles = matchedMaterials?.get(entry.renderableIndex);
    if (matchedMaterials !== null && dispatchHandles === undefined) continue;
    const candidateHandles =
      dispatchHandles ??
      (mode === 'transmission'
        ? []
        : entry.source.materials.map((material) => material.materialHandle ?? 0));
    const handles = new Set<number>();
    for (const handle of candidateHandles) {
      const material =
        entry.source.materials.find((candidate) => (candidate.materialHandle ?? 0) === handle) ??
        entry.source.material;
      if (matchesRecordMode(material, mode)) handles.add(handle);
    }
    if (handles.size > 0) filtered.set(entry.renderableIndex, handles);
  }
  return filtered;
}

/**
 * feat-20260529-rendergraph-pass-abstraction M4 / w13b: main forward
 * (geometry) pass recording, extracted verbatim from recordFrame. Uses the
 * SHARED frame encoder (c.encoder); the geometry + optional LDR sprite-split
 * sub-pass write into geometryColorView (HDR target or swap-chain view).
 * Driven by the render-graph 'main' pass execute closure.
 */
export function recordMainPass(
  c: _InternalRenderPipelineContext,
  selector?: PassSelector,
  options?: MainPassOptions,
  graphPass?: RhiRenderPassEncoder,
): void {
  const {
    runtime,
    world,
    store,
    pipelineState,
    encoder,
    clear,
    geometryColorView,
    geometryDepthView,
    validatedOrdered,
    viewBindGroup,
    viewBindGroupDynamicOffset = 0,
    meshBindGroup,
    frameState,
    bindGroupCounts,
    skyboxActive,
    splitLdrSprite,
    msaaActive,
    geometryColorResolveView,
    dispatch,
    hdrpClusterBindGroup,
    materialSlotIndices,
    materialSlots,
    materialSlotOwners,
    materialSlotCount,
  } = c;
  // bug-20260615 M3 / m3-1: sampleCount is threaded through every
  // getMaterialShaderPipeline call site so the cache key / builder
  // disambiguate count=1 vs count=4 PSOs. Derived from the per-camera
  // msaaActive boolean (already on the context).
  const sampleCount = msaaActive ? 4 : 1;
  const passKind = options?.passKind ?? 'forward';
  const recordMode = options?.recordMode;
  const transmissionBackdropView = options?.transmissionBackdropView;
  if (recordMode === 'transmission' && transmissionBackdropView == null) {
    throw new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'transmissionBackdropView != null for transmission record mode',
      hint: 'the typed Standard transmission pass must resolve its private backdrop view',
    });
  }
  const colorViews = options?.colorViews ?? [geometryColorView];
  const colorFormats = options?.colorFormats ?? [
    (c.tonemapActive || c.transparentColorFormat === 'rgba16float'
      ? 'rgba16float'
      : pipelineState.colorAttachmentFormat) as GPUTextureFormat,
  ];
  const targetDepthView = options?.depthView ?? geometryDepthView;
  const clearColor = options?.clearColor ?? clear;
  // feat-20260623-world-space-video-asset M4 / w17 (D-2 / AC-09): high-perf
  // GPUExternalTexture upload availability for video sources, resolved by the
  // explicit RhiCaps-based capability probe. The probe checks
  // backendKind==='webgpu' AND `importExternalTexture` method presence; the
  // latter is absent today (OOS-5), so this is false and the general
  // copyExternalImageToTexture path (w16) is the sole route. The branch exists
  // so the AC-09 two-path reserved hook is code-review-verifiable, not a TODO.
  const videoHighPerfAvailable = probeVideoHighPerfUpload(runtime.device);
  // The prepared Standard topology is the frame authority. Do not infer the
  // shader lane from a resource that may be absent after a failed rebuild: a
  // clustered frame with no unified group must fail closed, never fall back to
  // a direct-lighting shader with an incompatible group(2) contract.
  const clusteredLighting = c.standardLighting?.kind === 'clustered';
  // A clustered topology still needs the unified group for every actual
  // material draw.  A camera-only/clear frame has no group(2) consumer yet;
  // treating that harmless absence as a frame error would make the full
  // clustered ABI incompatible with valid zero-renderable frames.
  const clusteredBindGroupMissing =
    validatedOrdered.length > 0 &&
    !standardTopologyBindGroupReady(c.standardLighting, hdrpClusterBindGroup);
  // Standard clustered lighting swaps the
  // group(2) bindGroup for the unified 7-entry layout (mesh SSBO at binding 0
  // + cluster 4 buffer at bindings 3..6). The dynamic offset
  // (`i * MESH_PER_ENTITY_STRIDE`) stays valid because the unified BGL binds
  // the SAME mesh SSBO at binding 0; the cluster-forward shader reads the
  // cluster bindings off the rest of the layout. Plan D-1 (URP path zero
  // change) is preserved — when clustered lighting is not selected the
  // ordinary mesh bind group path runs verbatim.
  // feat-20260612-hdrp-ssao wiring fix: when the HDRP forward pass resolved a
  // real `ssaoBlurred` view (stashed on ctx by the pass execute closure), build
  // the unified group(2) bind group with that view at binding 7 so fs_main reads
  // the actual occlusion factor instead of the 1x1 white fallback. The default
  // `hdrpClusterBindGroup` (built ahead of graph.execute) always carries the
  // fallback because the transient SSAO texture does not exist that early.
  // Built per frame (the SSAO target is a graph transient, so no cross-frame
  // cache); HDRP-only and SSAO-only, so URP and SSAO-off paths are untouched.
  let hdrpSsaoBindGroup: BindGroup | null = null;
  if (clusteredLighting && hdrpClusterBindGroup !== null && c.hdrpSsaoBlurredView !== undefined) {
    const hdrpBuffers = getOrCreateHdrpBuffers(
      runtime,
      frameState.installedPipelineConfig?.clusterGrid,
    );
    if (hdrpBuffers !== null) {
      hdrpSsaoBindGroup = createHdrpUnifiedBindGroup(
        runtime,
        hdrpBuffers,
        pipelineState.meshStorageBuffer.buffer,
        { enabled: true, ssaoBlurredView: c.hdrpSsaoBlurredView },
      );
    }
  }
  const meshGroup2: BindGroup | null = clusteredLighting
    ? (hdrpSsaoBindGroup ?? hdrpClusterBindGroup)
    : meshBindGroup;
  // ── Geometry (main colour) pass ──────────────────────────────────
  // D-2: tracks whether the geometry pass was explicitly ended inside
  // the `if (validatedOrdered.length > 0)` block (sprite split path),
  // to avoid a double-end at the unconditional `pass.end()` below.
  let geometryPassEnded = false;
  // feat-20260531-skybox-env-background M2 / w8: condition main colour
  // loadOp on skyboxActive (AC-05). When skybox is active, the skybox
  // pass writes the far plane + cubemap colour to hdrColor before main;
  // main must load (not clear) to composite geometry on top. Depth
  // loadOp stays 'clear' -- skybox does not write depth, so main's
  // depth test naturally covers skybox pixels with foreground geometry.
  const mainColorLoadOp = skyboxActive ? 'load' : 'clear';
  // feat-20260604 M2 / w9-w10: MSAA resolve placement. When MSAA is active the
  // geometry pass writes a count=4 multisample target. The resolve to the
  // single-sample output (LDR swap-chain view / HDR hdrColor) happens at the
  // LAST pass that writes that multisample target: the main pass itself when
  // there is no LDR sprite split, or the sprite sub-pass end when there is
  // (F-1 -- geometry + sprites share one multisample texture; resolving at the
  // main pass would drop the sprites drawn after). The sprite sub-pass is
  // LDR-only, so under HDR the main pass always resolves.
  const mainPassResolves =
    passKind === 'forward' && msaaActive && geometryColorResolveView !== null && !splitLdrSprite;
  // forward main pass: depth24plus-stencil8 auto-emits stencil ops via the
  // helper's stencil-op gate (plan-strategy M4 R3/R5 stencil-op SSOT).
  // mainColorLoadOp toggles between 'clear' and 'load' (skyboxActive case).
  const pass: RhiRenderPassEncoder =
    graphPass ??
    encoder.beginRenderPass(
      buildBeginRenderPassDescriptor(
        {
          colorFormats,
          depthFormat: 'depth24plus-stencil8',
          sampleCount: msaaActive ? 4 : 1,
        },
        {
          colorViews,
          depthView: targetDepthView,
          ...(mainPassResolves ? { resolveTargets: [geometryColorResolveView] } : {}),
        },
        passKind,
        {
          colorLoadOp: mainColorLoadOp,
          clearColor: {
            r: clearColor[0] ?? 0,
            g: clearColor[1] ?? 0,
            b: clearColor[2] ?? 0,
            a: clearColor[3] ?? 1,
          },
        },
      ) as never,
    );

  // Geometry submission block: setPipeline + 4 bind groups + per-entity
  // material uploads + drawIndexed.

  // feat-20260609 M2: filter entities by pass selector.
  const matchedIndices =
    selector !== undefined ? buildMatchedRenderableIndices(dispatch, selector) : null;
  const selectorMatchedMaterials =
    selector !== undefined ? buildMatchedMaterialHandlesByRenderable(dispatch, selector) : null;
  const matchedMaterials = matchedMaterialsForRecordMode(c, selectorMatchedMaterials, recordMode);
  const selectedDispatch =
    dispatch.length === 0
      ? undefined
      : filterDispatchBySelector(
          dispatch,
          selector ?? { LightMode: [passKind === 'deferred' ? 'Deferred' : 'Forward'] },
        );
  const recordContext =
    recordMode === undefined
      ? c
      : {
          ...c,
          splitLdrSprite: recordMode === 'transparent' ? false : c.splitLdrSprite,
        };

  if (clusteredBindGroupMissing) {
    runtime.errorRegistry.fire(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'clustered Standard frame has a unified group(2) BindGroup',
        hint: 'repair the clustered buffer/layout admission before retrying the frame; direct URP fallback is unsafe',
      }),
    );
  }

  if (validatedOrdered.length > 0 && !clusteredBindGroupMissing) {
    // feat-20260518-pbr-direct-lighting-mvp M5 / w22.10 (D-4 + D-9 +
    // AC-07 std140): per-entity material slice grew from 32 B (legacy
    // baseColor:vec4 + metallic + roughness + 8B padding) to 48 B
    // mirroring the post-w22.10 `Material` WGSL struct field-for-field
    // (see STANDARD_PBR_UBO_SIZE JSDoc in render-system.ts). The dynamic-
    // offset stride is MATERIAL_PER_ENTITY_STRIDE; the BindGroup entry's
    // `size` remains the derived material payload size.
    const MATERIAL_SLICE = STANDARD_PBR_UBO_SIZE;
    // feat-20260515 M3 / T-M3-05 (research F-6 fix): materialBindGroup now
    // carries 3 entries -- the per-entity material UBO (binding 0,
    // dynamic-offset retained from D-P9), the default sampler (binding 1,
    // pipelineState.defaultSampler from createRenderer; research F-5
    // linear min/mag/mipmap + repeat addressMode), and the texture-view
    // (binding 2, resolved from MaterialSnapshot.baseColorTexture via
    // AssetRegistry.getTextureGpuView when present, falling back to the
    // pipelineState.fallbackTextureView 1x1 white pixel).
    //
    // The first validated renderable's material is sampled to choose the
    // texture-view (M3 milestone simplification; M5 lifts this to
    // per-entity slot writes once UV-driven sampling lands).
    //
    // feat-20260517-merge-mesh-renderer-material-renderer M3 / w10
    // (this commit): the prior structural cast over `firstMaterial`
    // (used to reach `baseColorTexture` before the snapshot carried
    // it as a first-class field) is removed in favour of direct
    // snapshot field access. `MaterialSnapshot` (extract-stage SSOT)
    // already declares `baseColorTexture` (M2 / w6); record reads it
    // directly with no asset registry round-trip and no cast --
    // Pipeline Isolation: extract owns the asset to snapshot
    // translation; record consumes the snapshot POD only (charter
    // proposition 5 consistent abstraction; AC-07 reverse-grep gate
    // `scripts/forgeax/check-render-record-no-material-asset-get.mjs`
    // forbids both the cast pattern and a direct material asset
    // typed-lookup regrowth in this file).
    // bug-20260522-per-entity-material-texture-binding D-1/D-2:
    // the pre-loop `firstMaterial` / `materialTextureView` / `
    // baseMaterialEntries` / single shared `materialBindGroup` are
    // removed. Each entity now creates its own per-entity material BG
    // inside the draw loop, resolving binding=2 from its own
    // `entry.source.material.baseColorTexture` (mirroring sprite path).
    //
    // feat-20260520-skylight-ibl-cubemap M3 round-4 / t48 amend: the
    // 14-entry merged BG (7 material + 7 Skylight) is now assembled per
    // entity inside the draw loop. The Skylight part stays scene-level
    // (single `skylightResources` resolved once below); only the first 7
    // material entries are rebuilt per-entity with the correct
    // per-entity textureView at binding=2.
    const { skylightResources, activeViews } = prepareMaterialSkylight(c);
    if (materialDiagnosticsEnabled()) {
      const activeCache =
        activeViews === undefined ? undefined : getOrCreateIblCache(runtime.deviceScope);
      const prefilterViewMipCount =
        activeCache?.prefilterFaceViewsByMip?.length ?? (activeViews === undefined ? 1 : 0);
      frameState.iblBindingInspection = {
        status: 'binding-chain-consistent',
        frameId: frameState.frameNumber,
        deviceGeneration: runtime.deviceScope.generation,
        active: activeViews === undefined ? 'fallback' : 'active',
        cache: {
          identity: getOpaqueResourceIdentity(
            (activeCache ?? pipelineState.skylightFallback) as object,
          ),
          generation: runtime.deviceScope.generation,
          prefilterMipCount: prefilterViewMipCount,
          prefilterViewMipCount,
        },
        sampler: {
          expected: {
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
            addressModeW: 'clamp-to-edge',
          },
          identities: [
            getOpaqueResourceIdentity(skylightResources.irradianceSampler as object),
            getOpaqueResourceIdentity(skylightResources.prefilterSampler as object),
            getOpaqueResourceIdentity(skylightResources.brdfLutSampler as object),
          ],
        },
        resources: {
          irradiance: {
            viewIdentity: getOpaqueResourceIdentity(skylightResources.irradianceView as object),
            samplerIdentity: getOpaqueResourceIdentity(
              skylightResources.irradianceSampler as object,
            ),
            deviceGeneration: runtime.deviceScope.generation,
          },
          prefilter: {
            viewIdentity: getOpaqueResourceIdentity(skylightResources.prefilterView as object),
            samplerIdentity: getOpaqueResourceIdentity(
              skylightResources.prefilterSampler as object,
            ),
            deviceGeneration: runtime.deviceScope.generation,
          },
          brdfLut: {
            viewIdentity: getOpaqueResourceIdentity(skylightResources.brdfLutView as object),
            samplerIdentity: getOpaqueResourceIdentity(skylightResources.brdfLutSampler as object),
            deviceGeneration: runtime.deviceScope.generation,
          },
          intensityBufferIdentity: getOpaqueResourceIdentity(
            skylightResources.intensityBuffer as object,
          ),
        },
        errors: [],
      };
    }
    // Per-entity material uploads (D-P9 retained path).
    // feat-20260613 fix-issue-1 (D-8 channelMap split): the payload mirrors
    // the post-split sidecar paramSchema for default-standard-pbr (14 entries
    // packed std140 across a 96 B schema tail):
    //   [0..3]   baseColor          vec4<f32>     (offset 0)
    //   [4]      metallic           f32           (offset 16)
    //   [5]      roughness          f32           (offset 20)
    //   [6]      metallicChannel    f32           (offset 24)
    //   [7]      roughnessChannel   f32           (offset 28)
    //   [8]      aoChannel          f32           (offset 32)
    //   [9]      extraChannel       f32           (offset 36)
    //   [12..14] emissive           vec3<f32>     (offset 48, vec3 align=16)
    //   [15]     emissiveIntensity  f32           (offset 60)
    //   [16]     occlusionStrength  f32           (offset 64)
    // Channel selectors default to (B,G,R,_) = (2,1,0,0) per glTF 2.0
    // KHR_materials_pbrSpecularGlossiness ARM packing; the fragment casts
    // each f32 to u32 at the pick_channel call site. The full 128 B bind window is
    // overwritten per-entity so unlit entities still produce a deterministic
    // payload (charter P3 explicit failure: zero-init via fresh ArrayBuffer).
    //
    // Material snapshots are interned by extract-owned identity before this
    // pass. Repeated scene instances therefore share one 256-byte UBO slot;
    // materialSlotIndices maps each authored submesh material to that slot.
    // feat-city-glb Bug 5 (per-submesh transparency): shared per-submesh
    // material bind-group assembly, called by BOTH the geometry pass and the
    // LDR blend sub-pass so a transparent PBR submesh binds the identical
    // metallic/roughness/normal/emissive/occlusion + Skylight layout
    // the geometry pass uses (the sub-pass previously bound a sprite-only BG,
    // which cannot render a PBR decal). Captures only frame-stable closure
    // state; the caller passes the per-submesh material snapshot + entityKey
    // (for video texture routing) and sets the dynamic UBO offset itself.
    const perSubmeshMaterialBgDeps: PerSubmeshMaterialBgDeps = {
      runtime,
      pipelineState,
      world,
      store,
      materialSlice: MATERIAL_SLICE,
      videoHighPerfAvailable,
      skylightResources,
      resolveRenderTargetTextureSource: runtime.resolveRenderTargetTextureSource,
      resolveReflectionProbeResources: (materialWorld, entityKey) => {
        const reflectionProbes = c.reflectionProbes;
        if (reflectionProbes === undefined) return undefined;
        const selection = reflectionProbes.selections.get(`${materialWorld.identity}:${entityKey}`);
        if (selection === undefined) return undefined;
        const binding = resolveReflectionProbeBinding(selection, reflectionProbes.table);
        if (binding.useSkylight || binding.probeIndex === undefined) return undefined;
        const row = reflectionProbes.table.rows.find(
          (candidate) => candidate.index === binding.probeIndex,
        );
        if (
          row?.filteredView === undefined ||
          row.sampler === undefined ||
          row.uniformBuffer === undefined
        ) {
          return undefined;
        }
        const probeResources: SkylightBindGroupResources = {
          irradianceView: skylightResources.irradianceView,
          irradianceSampler: skylightResources.irradianceSampler,
          prefilterView: row.filteredView,
          prefilterSampler: row.sampler,
          brdfLutView: skylightResources.brdfLutView,
          brdfLutSampler: skylightResources.brdfLutSampler,
          intensityBuffer: row.uniformBuffer,
        };
        return probeResources;
      },
      materialBgShared: frameState.materialBgShared,
      materialBgAssemblyCache: c.materialBgAssemblyCache,
      frameState,
      bindGroupCounts,
      ...(transmissionBackdropView === undefined ? {} : { transmissionBackdropView }),
    };
    const buildPerSubmeshMaterialBg = (
      submeshMaterial: MaterialSnapshot,
      entityKey: number,
      materialWorld: World = world,
      materialShaderId: string | undefined = submeshMaterial.materialShaderId,
    ): BindGroup =>
      buildPerSubmeshMaterialBgImpl(
        perSubmeshMaterialBgDeps,
        submeshMaterial,
        entityKey,
        materialWorld,
        materialShaderId,
      );

    // Static material resources are a property of the frame-local material
    // slot, not of each submesh draw. Resolve them once here so the geometry
    // loop only selects a prepared binding. Video fields remain entity-bound:
    // their current frame view is keyed by entityKey and must be resolved at
    // the draw site.
    const preparedMaterialBindGroups = new Array<BindGroup | undefined>(materialSlotCount);
    for (let materialSlot = 0; materialSlot < materialSlotCount; materialSlot += 1) {
      const material = materialSlots[materialSlot];
      if (material === undefined || (material.videoTextureFields?.size ?? 0) > 0) continue;
      const owner = validatedOrdered[materialSlotOwners[materialSlot] ?? -1];
      if (owner === undefined) continue;
      preparedMaterialBindGroups[materialSlot] = buildPerSubmeshMaterialBg(
        material,
        owner.source.entityKey,
        owner.world ?? world,
      );
    }
    const resolveMaterialBindGroup = (
      materialSlot: number,
      material: MaterialSnapshot,
      entityKey: number,
      materialWorld: World = world,
      materialShaderId: string | undefined = material.materialShaderId,
    ): BindGroup =>
      materialShaderId === material.materialShaderId &&
      materialShaderId !== POINTS_LINES_MATERIAL_SHADER_ID
        ? (preparedMaterialBindGroups[materialSlot] ??
          buildPerSubmeshMaterialBg(material, entityKey, materialWorld, materialShaderId))
        : buildPerSubmeshMaterialBg(material, entityKey, materialWorld, materialShaderId);

    pass.setBindGroup(0, viewBindGroup as BindGroup, [viewBindGroupDynamicOffset, 0]);

    // Track which (mesh-vertex-buffer, mesh-index-buffer, pipeline) combo
    // was last bound so consecutive entities sharing the same combo skip
    // the redundant rebinds (cheap GPU cost; net wins on workloads where
    // most entities share BUILTIN_CUBE + unlit). Initial nulls force the
    // first iteration to bind unconditionally.
    // M-3 / w12: vertexBuffer/indexBuffer state locals migrate to GpuBuffer.
    const recordGeometry = (): void => {
      recordGeometryDraws(
        recordContext,
        pass,
        matchedMaterials,
        materialSlotIndices,
        sampleCount,
        meshGroup2,
        meshBindGroup,
        resolveMaterialBindGroup,
        passKind,
        selectedDispatch,
      );
    };
    if (c.profilePhase === undefined) {
      recordGeometry();
    } else {
      const passName = passKind === 'deferred' ? 'g-buffer' : 'forward';
      c.profilePhase(
        `record/graph-execute/${passName}/geometry-loop` as RenderRecordPhase,
        recordGeometry,
      );
    }

    // D-2: LDR sprite pass. Runs after the geometry pass when there are
    // sprite entities in the draw list and the LDR path is active.
    // The geometry pass used the bgra8unorm-srgb sRGB view (hardware sRGB
    // encoding for unlit/standard/pbr output). The sprite pass uses the
    // bgra8unorm storage view (loadOp=load) so the sprite LDR pipeline
    // (target=bgra8unorm, blend=premultiplied-alpha) can write over the
    // already-encoded geometry pixels. Depth is loaded from the geometry
    // pass so sprite-vs-mesh occlusion (depthCompare=less-equal) is
    // preserved (plan-strategy §2 D-2 + §4 R-4).
    if (passKind === 'forward' && recordMode === undefined) {
      geometryPassEnded = recordSpritePass(
        c,
        pass,
        matchedIndices,
        materialSlotIndices,
        sampleCount,
        resolveMaterialBindGroup,
        skylightResources,
        graphPass,
        selectedDispatch,
      );
    }
  } // end if (validatedOrdered.length > 0) -- Case E falls through to pass.end()

  if (!geometryPassEnded && graphPass === undefined) {
    pass.end();
  }
}

export function encodeMainPass(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  selector?: PassSelector,
  options?: MainPassOptions,
): void {
  recordMainPass(c, selector, options, pass);
}
