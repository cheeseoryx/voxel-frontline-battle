import type { MaterialCookProgramContext } from '@forgeax/engine-pack/material-cook';
// Shared render-extract snapshot contracts.
//
// The extract orchestrator owns traversal and policy; this leaf owns the
// immutable POD vocabulary shared by extract, record, and temporal projection.

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { Vec3 } from '@forgeax/engine-math';
import type { SceneHierarchySnapshot } from '@forgeax/engine-scene';
import type {
  Handle,
  MaterialAsset,
  MaterialPass,
  MaterialRenderState,
  MaterialTextureCoordinates,
  MeshLodLevel,
  ParamSchemaEntry,
  PrimitiveTopology,
  TextureAsset,
} from '@forgeax/engine-types';
import type { DirectionalShadowQuality } from '../components/directional-shadow-filter';
import type { LightValidationError } from '../components/light-helpers';
import type {
  RenderFeatureHiddenEntityReport,
  RenderFeatureWorldVisibilitySnapshot,
} from '../features/types';
import type {
  MeshMaterialBindingDiagnostic,
  MeshMaterialBindingSource,
} from '../mesh-material-bindings';
import type { PointsLinesRetainedSnapshot } from '../points-lines/snapshot';
import type { ReflectionProbeFact } from '../reflection/projection';
import type { CameraSnapshot, CubeCameraSnapshot } from '../render-contract';
import type { SkinPaletteAllocator } from '../systems/skin-palette-allocator';
import type { SkinPaletteSlice } from '../systems/skin-palette-types';
import type { RenderTargetTextureSource } from '../targets/contracts';
import type { ValidatedVolumetricFog } from '../volume/component';
import type { VolumeProjectorTuple } from '../volume/temporal';
import type { EnvironmentFrame, FogFrame, FogSelectionFailure } from './environment';
import type { VisibilitySnapshot } from './visibility';

export interface DirectionalLightSnapshot {
  readonly kind: 'directional';
  readonly entity?: EntityHandle;
  readonly direction: Vec3;
  readonly color: Vec3;
  readonly intensity: number;
}

/**
 * PointLightSnapshot — omnidirectional point variant. `position` from the
 * companion Transform; `invRangeSquared = 1 / range^2` host-folded via
 * `computeInvRangeSquared` (range = +Infinity -> 0; range = 0 -> 1e8 NaN
 * protection per D-S5).
 */
export interface PointLightSnapshot {
  readonly kind: 'point';
  readonly entity?: EntityHandle | number;
  readonly position: Vec3;
  readonly color: Vec3;
  readonly intensity: number;
  readonly invRangeSquared: number;
  /**
   * feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-8 + M4 / T-M4-4:
   * cube_array atlas layer index for this light's shadow map (0..3 for shadow
   * casters; sentinel `-1` for non-shadow lights). Default `-1` per
   * plan-strategy §D-2 — record stage / shader skips shadow sampling when the
   * lane equals the sentinel. Joined with `pointShadow[]` by entity at the
   * end of extract; HDRP record stage threads `shadowAtlasLayer + shadowNear +
   * shadowFar` through `packLightSlot` as the §D-8 pad-lane payload.
   */
  readonly shadowAtlasLayer?: number;
  /**
   * Per-face perspective near plane (matches `PointLightShadow.nearPlane`).
   * Used by HDRP `evalPointShadowed` for depth-ref reconstruction; rides
   * `LightSlot.kind_and_pad.z` (byte 56..60) on the std430 std layout.
   */
  readonly shadowNear?: number;
  /**
   * Per-face perspective far plane (matches `PointLightShadow.farPlane`).
   * Rides `LightSlot.kind_and_pad.w` (byte 60..64).
   */
  readonly shadowFar?: number;
}

/**
 * PointShadowSnapshot — extract-stage view of one shadow-casting point light
 * (feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-7).
 *
 * `entity` is the spawning entity (joins PointLight + PointLightShadow on the
 * same archetype); `position` is the light world-space position resolved from
 * the companion Transform (mirrors PointLightSnapshot.position).
 * `shadowMatrices` is the 96-float packed mat4[6] table (column-major,
 * 6 mat4 * 16 floats = 384 bytes) ready for UBO upload.
 *
 * Plan-strategy §D-3: the record stage allocates a dynamic-offset uniform
 * buffer (384 B per-light, aligned to minUniformBufferOffsetAlignment, WebGPU
 * min 256 -> 512 B stride). Extract owns the host-side `Float32Array(96)`;
 * record owns the GPU `RhiBuffer` lifetime.
 *
 * `mapSize` / `nearPlane` / `farPlane` ride here so record stage can size the
 * cube atlas faces and feed shader the proj constants without re-querying ECS.
 * `shadowAtlasLayer` is assigned by extract in spawn order (0 .. cap-1) so the
 * downstream LightSlot / packPointLight packers carry the layer index in
 * pointPadW (T-M1-8 will rename to shadowAtlasLayer).
 */
export interface PointShadowSnapshot {
  /** Spawning entity index (joins PointLight + PointLightShadow + Transform). */
  readonly entity: number;
  /** World-space light position (sourced from companion Transform). */
  readonly position: Vec3;
  /** PointLightShadow.mapSize (per-face cube square dimension; 512 default). */
  readonly mapSize: number;
  readonly nearPlane: number;
  readonly farPlane: number;
  /**
   * Atlas layer assigned by extract in spawn order (0..cap-1, where cap=4
   * matches PointLightShadow cardinality). Sentinel -1 is reserved by the
   * shader-side LightSlot for no-shadow lights (T-M1-8).
   */
  readonly shadowAtlasLayer: number;
  /**
   * 6 view-proj mat4 in face order [+X, -X, +Y, -Y, +Z, -Z] packed into one
   * Float32Array(96). 16 floats per face = 64 B; 6 * 64 = 384 B raw. The
   * record stage pads each slot to 512 B (256 alignment) when packing into
   * the per-light dynamic-offset UBO (plan-strategy §D-3).
   */
  readonly shadowMatrices: Float32Array;
}

/**
 * SpotLightSnapshot — cone-restricted variant. `position` from companion
 * Transform; `direction` raw outgoing-vector; `cosInner` / `cosOuter` host
 * pre-converted via `degToCos` so the shader sees only cosines (D-S2).
 *
 * feat-20260625-spot-light-shadow-mapping M1 w5: added shadow fields.
 * castShadow (bool) gates shadow projection; lightViewProj is the perspective
 * light-view-projection matrix computed in extract (undefined when castShadow
 * is false, dir degenerates, or the light is clipped). shadowAtlasTile
 * (i32 sentinel -1) is the allocated tile index 0..3 or -1 for unassigned
 * (plan-strategy D-4). mapSize / nearPlane / farPlane are the source
 * component shadow parameters carried through to the record stage.
 */
export interface SpotLightSnapshot {
  readonly kind: 'spot';
  readonly entity?: EntityHandle | number;
  readonly position: Vec3;
  readonly direction: Vec3;
  readonly color: Vec3;
  readonly intensity: number;
  readonly invRangeSquared: number;
  readonly cosInner: number;
  readonly cosOuter: number;
  readonly iesProfileHandle?: number;
  readonly cookieHandle?: number;
  readonly iesProfileSlice?: number;
  readonly cookieSlice?: number;
  readonly iesProfileData?: Uint8Array;
  readonly cookieData?: Uint8Array;
  readonly cookieMatrix?: Float32Array;
  readonly projectorSlice?: number;
  readonly projectorData?: Uint8Array;
  readonly projectorMatrix?: Float32Array;
  readonly rollDeg?: number;
  // ── shadow fields (feat-20260625-spot-light-shadow-mapping M1) ──
  readonly castShadow: boolean;
  readonly lightViewProj: Float32Array | undefined;
  readonly mapSize: number;
  readonly nearPlane: number;
  readonly farPlane: number;
  readonly shadowAtlasTile: number;
  readonly shadowIntensity?: number;
  readonly depthBias?: number;
  readonly normalBias?: number;
  readonly pcfKernelSize?: number;
  readonly projectorHandle?: Handle<'TextureAsset', 'shared'>;
  readonly projectorAsset?: TextureAsset;
  readonly projectorGuid?: string;
  readonly projectorGeneration?: number;
  readonly projectorRevision?: number;
}

export interface RectAreaDirectLightSnapshot {
  readonly kind: 'rect-area';
  readonly position: Vec3;
  readonly color: Vec3;
  readonly intensity: number;
  readonly invRangeSquared: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly axisX: Vec3;
  readonly axisY: Vec3;
  readonly shadowAtlasTile?: number;
}

export interface RectAreaWorldFrame {
  readonly center: Vec3;
  readonly axisX: Vec3;
  readonly axisY: Vec3;
  readonly normal: Vec3;
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/**
 * LightSnapshot — discriminated union of the three KHR_lights_punctual
 * variants. AI users + the record stage perform an exhaustive switch on
 * `kind`; missing arms are caught at compile time (no `default`,
 * `assertNever`-style guards). Plan-strategy R-10.
 */
export type LightSnapshot =
  | DirectionalLightSnapshot
  | PointLightSnapshot
  | SpotLightSnapshot
  | RectAreaDirectLightSnapshot;

/**
 * ExtractedLights — three-bucket output of the extractFrame three-query
 * union (M2 / w16 / AC-03). Plan-strategy section 3.1 EXT node:
 *   - `directional` — at most one (record-stage N>1 fail-fast lands in M3)
 *   - `point[]` — first-slice cap of 4 enforced at record stage (M3)
 *   - `spot[]`  — first-slice cap of 4 enforced at record stage (M3)
 * `directionalCount` exposes the raw count of DirectionalLight entities the
 * extract observed (so the record stage can fire `render-system-multi-light`
 * when N>1 without re-running the query). M3 / w19 will widen this with
 * pointCount / spotCount fields once the matching record-time fail-fast
 * lands; for M2 the field stays directional-only to keep AC-06 (a) intact.
 */
export interface ExtractedLights {
  readonly directional: DirectionalLightSnapshot | undefined;
  readonly directionalCount: number;
  readonly point: readonly PointLightSnapshot[];
  readonly spot: readonly SpotLightSnapshot[];
  readonly rect: readonly RectAreaDirectLightSnapshot[];
  /**
   * feat-20260613-csm-cascaded-shadow-maps M2 / w9: per-cascade light-view-
   * projection matrices (one per cascade, length 4 pre-allocated). Each matrix
   * is a column-major 16-float mat4 with atlas tile UV inset baked in
   * (plan-strategy D-3). cascadeCount < 4: unused slots are zero matrices.
   * Undefined when castShadow=false or no directional light.
   */
  readonly lightViewProj: readonly Float32Array[] | undefined;
  /**
   * feat-20260613-csm-cascaded-shadow-maps M2 / w9: view-space z depths
   * of the PSSM split planes (length 4, Float32Array). cascadeCount < 4:
   * unused slots are 0.0f. Undefined when castShadow=false or no directional
   * light.
   */
  readonly splitPlanes: Float32Array | undefined;
  /**
   * feat-20260613-csm-cascaded-shadow-maps M2 / w9: effective cascade count
   * from the DirectionalLight component (1..4). Undefined when castShadow=false
   * or no directional light.
   */
  readonly cascadeCount: number | undefined;
  /**
   * feat-20260613-csm-cascaded-shadow-maps M2 / w9: cascade blend width
   * from the DirectionalLight component (0..0.5). Undefined when castShadow=false
   * or no directional light.
   */
  readonly cascadeBlend: number | undefined;
  /**
   * feat-20260520-directional-light-shadow-mapping M1c / w8:
   * shadowMapSize from DirectionalLight.mapSize. Drives shadow RT
   * lazy-allocate (idempotency: same size -> no rebuild). Undefined when
   * castShadow=false or no directional light.
   */
  readonly shadowMapSize: number | undefined;
  /**
   * feat-20260621-merge-directionallightshadow-into-directionallight M2:
   * depthBias from the merged DirectionalLight (constant shadow-bias floor).
   * Populated when castShadow=true on the first-hit directional light;
   * undefined otherwise.
   */
  readonly depthBias: number | undefined;
  /**
   * feat-20260621-merge-directionallightshadow-into-directionallight M2:
   * normalBias from the merged DirectionalLight (slope-based shadow-bias
   * coefficient).
   * Populated when castShadow=true on the first-hit directional light;
   * undefined otherwise.
   */
  readonly normalBias: number | undefined;
  /**
   * feat-20260621-merge-directionallightshadow-into-directionallight M2:
   * pcfKernelSize from the merged DirectionalLight (PCF kernel width, odd>=1).
   * Populated when castShadow=true on the first-hit directional light;
   * undefined otherwise.
   */
  readonly directionalShadowQuality: DirectionalShadowQuality | undefined;
  readonly directionalShadowError: LightValidationError | undefined;
  /**
   * feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-7:
   * shadow-casting point lights (PointLight + PointLightShadow + Transform
   * archetype join). Each entry carries the per-light 6-face VP matrices and
   * the assigned cube_array atlas layer (0..3 in spawn order; sentinel -1 is
   * reserved by the shader-side LightSlot for no-shadow point lights).
   *
   * Empty array when no PointLightShadow components exist (zero-cost gate per
   * AC-09; record stage skips atlas allocation + shadow pass dispatch).
   */
  readonly pointShadow: readonly PointShadowSnapshot[];
  /**
   * bug-20260710-editor-cross-world-shadow: the RAW directional-shadow config
   * (cascadeCount / splitLambda / cascadeBlend / mapSize / shadowDistance) of
   * the first-hit castShadow DirectionalLight, carried unconditionally of
   * whether this world had a camera. The {@link extractFrames} merge layer
   * re-runs {@link computeDirectionalCsm} with this config + the surfaced
   * camera so directional shadows work when the light and camera live in
   * DIFFERENT worlds (editor editorWorld/sceneWorld super-composite). Undefined
   * when castShadow=false or no directional light. The `lightViewProj` /
   * `splitPlanes` fields above remain the *computed* per-world outputs (correct
   * for single-world; recomputed at merge for cross-world).
   */
  readonly directionalCsmConfig: DirectionalCsmConfig | undefined;
  /**
   * bug-20260710-editor-cross-world-shadow: the light-direction of the
   * first-hit castShadow DirectionalLight, carried so the merge layer can
   * rebuild the light-view matrix. Redundant with `directional.direction` but
   * kept explicit so the CSM recompute reads a single config bundle. Undefined
   * when castShadow=false or no directional light.
   */
  readonly directionalCsmDirection: Vec3 | undefined;
}

/**
 * SkylightSnapshot -- extract-stage view of one Skylight entity
 * (feat-20260520-skylight-ibl-cubemap M4 / t26).
 *
 * `equirectHandle` carries the packed u32 handle for
 * `Handle<EquirectAsset, 'shared'>`; the record stage drives the internal
 * lazy cubemap projection from it and resolves the projected GPU cubemap via
 * `GpuResidencyCache.getCubemapGpuView(...)` and related helpers
 * (feat-20260630 M3 / w16-w18). The snapshot carries NO projection status
 * field: the status truth lives in the store's CubemapGpuEntry (D-3 SSOT);
 * record queries it once per frame.
 *
 * `intensity` defaults to 1.0 via the Skylight component token defaults
 * (plan-strategy D-6: Skylight data flows through existing extract->record
 * pipeline; no independent ECS system).
 */
export interface SkylightSnapshot {
  // 0 = no equirect supplied -> solid-color ambient via the white fallback
  // cube (record falls to fallback resources when no IBL views are cached).
  readonly equirectHandle: number;
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  /** Environment-space quaternion [x, y, z, w], identity by default. */
  readonly rotation: readonly [number, number, number, number];
  // feat-20260630 M3 / w19: the WINNING Skylight entity's packed handle (first
  // archetype hit). Carried so the multi-Skylight once-warn can name which
  // entity is used and which is ignored (F-8: warn carries conflicting entity
  // info). 0 only if the bundle had no live entity (never happens for a hit).
  readonly entityHandle: number;
}

/**
 * SkyboxSnapshot -- extract-stage view of one SkyboxBackground entity
 * (feat-20260531-skybox-env-background M2 / w5).
 *
 * `equirectHandle` carries the packed u32 handle for
 * `Handle<EquirectAsset, 'shared'>`; the record stage resolves the projected
 * GPU cubemap via `GpuResidencyCache.getCubemapGpuView(...)`.
 *
 * `mode` carries the raw `f32` column value (`SKYBOX_MODE_CUBEMAP = 0`).
 * First hit wins per plan-strategy D-6; multi-entity once-warn in record stage.
 */
export interface SkyboxSnapshot {
  readonly equirectHandle: number;
  readonly mode: number;
  /** Environment-space quaternion [x, y, z, w], identity by default. */
  readonly rotation: readonly [number, number, number, number];
  // feat-20260630 M3 / w19: the WINNING SkyboxBackground entity's packed handle
  // (first archetype hit), so the multi-SkyboxBackground once-warn can name the
  // used entity (F-8 parity with the Skylight warn).
  readonly entityHandle: number;
}

export interface LightProbeSnapshot {
  readonly identity: string;
  readonly position: readonly [number, number, number];
  readonly radius: number;
  readonly irradiance: Float32Array;
  readonly admitted: boolean;
}

export interface ExtractedVolumetricFog {
  readonly status: 'off' | 'available' | 'degraded';
  readonly fog?: ValidatedVolumetricFog;
  readonly densityHandle?: Handle<'TextureAsset', 'shared'>;
  readonly densityAsset?: TextureAsset;
  readonly guid?: string;
  readonly generation?: number;
  readonly digest?: string;
  readonly worldId?: number;
  readonly lightEntity?: EntityHandle;
  readonly lightKind?: 'directional' | 'point' | 'spot';
  readonly pointLightEntity?: EntityHandle;
  readonly spotLightEntity?: EntityHandle;
  readonly projector?: VolumeProjectorTuple;
  readonly projectorHandle?: Handle<'TextureAsset', 'shared'>;
  readonly projectorAsset?: TextureAsset;
}

export interface RenderableSnapshot {
  readonly assetHandle: number;
  readonly transform: TransformSnapshot;
  readonly lods?: readonly MeshLodLevel[];
  readonly lodHysteresis?: number;
  /** Finite producer-owned local bounds retained for persistent CPU view work. */
  readonly localAabb?: Float32Array;
  /** Indexed single-submesh facts consumed by the first GPU-driven rigid lane. */
  readonly gpuDrivenDraws?: readonly GpuDrivenDrawSnapshot[];
  /**
   * feat-20260608 M5 amend / w11-a: the entity's representative (first)
   * material snapshot, kept as a same-name shorthand for `materials[0]`.
   * Per-entity dispatch (shading model routing, sprite-vs-mesh split, the
   * D-1/D-3 pipeline-tag pick) is uniform across the entity's submeshes
   * today, so the existing 20+ `entry.source.material.X` consumers in the
   * record stage stay unchanged. Per-submesh material data (baseColor /
   * UBO payload / paramSnapshot) lives in `materials[i]`.
   */
  readonly material: MaterialSnapshot;
  /**
   * feat-20260608 M5 amend / w11-a: per-submesh MaterialSnapshot[]
   * positionally aligned with `MeshAsset.submeshes[]` (plan §3.2 sequence
   * step 6 + AC-08). Length always equals the entity's submesh count once
   * the extract stage's count-mismatch validator (M2 / w12) has filtered
   * misaligned spawns. The record stage reads `materials[i]` to upload the
   * i-th material UBO slot before drawing the i-th submesh.
   *
   * Backward-compat: `materials[0] === material` (the legacy mid-grey
   * default-material case-B path also routes through `materials = [default]`,
   * keeping the legacy single-mesh-no-material spawn shape working without
   * a special branch in record).
   */
  readonly materials: readonly MaterialSnapshot[];
  /** Per-slot provenance trace from the shared mesh-material resolver. */
  readonly materialBindingSources: readonly MeshMaterialBindingSource[];
  /** Active structured override diagnostics for this renderable. */
  readonly materialBindingDiagnostics?: readonly MeshMaterialBindingDiagnostic[];
  /**
   * feat-20260708-composited-multi-world-rendering M1 / D-1: the worldId
   * of the world this renderable was extracted from. Defaults to 0 in
   * single-world path (extractFrame always assigns 0). The merge layer
   * (extractFrames in M2) stamps the correct worldId per world before
   * the record stage consumes it. Combined with `entityKey` via
   * `worldEntityKey(worldId, entityKey)` to form per-entity cache keys.
   *
   * Never rewrite `entityKey` itself — consumers that need the real
   * entity handle (video provider, etc.) read the bare `entityKey`.
   */
  readonly worldId: number;
  /**
   * feat-20260531-per-frame-bind-group-cache M1 / w3: packed Entity u32
   * (encodeEntity(indexSlot, generation)) surface'd from the extract
   * stage. Stable per-entity identity for the record stage cache keys
   * (material / instances / per-frame clean-up) without re-querying the
   * World (charter P5 Pipeline Isolation: record stage only consumes
   * snapshot POD). Reuses the encodeEntity calculation already performed
   * at :1293 for the Instances path, and now also computed for plain
   * (non-Instances) renderables.
   *
   * Never rewrite this field — cache keys use `worldEntityKey(worldId, entityKey)`,
   * not the bare entityKey alone (D-1).
   */
  readonly entityKey: number;
  /**
   * feat-20260514 M3 (w15): when the entity carries an `Instances` component
   * the extract stage materialises a fresh `Float32Array` snapshot of the
   * packed mat4 transforms (16 f32 per instance, stride 16) plus a stable
   * `cacheKey` (the entity's packed u32) and the `archVersion` (used by the
   * record stage to invalidate its per-entity GPU buffer cache when the
   * archetype storage grew). Absent (`undefined`) means the record stage
   * falls back to the shared 1-element identity-mat4 storage buffer +
   * `drawIndexed(.., 1, ..)`.
   */
  readonly instances?: InstancesSnapshot;
  /**
   * feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M3 / w10
   * (plan-strategy D-1 + D-9): when the entity carries a `SpriteInstances`
   * component the extract stage materialises a paired snapshot — packed mat4
   * `transforms` (16 f32, stride 16) + per-instance UV `regions` (4 f32,
   * stride 4) — plus the same cache fingerprint pair (`cacheKey` = entity
   * packed u32, `archVersion` = archetype version stamp at snapshot time).
   * The record stage interleaves the two arrays into an 80B-per-instance
   * single GPU buffer routed through `@group(3) @binding(0)` (BGL unchanged,
   * D-1). Absent (`undefined`) means the entity is not a `SpriteInstances`
   * carrier; the record stage falls back to its existing sprite path
   * (material UBO region + identity-instance buffer).
   *
   * Three structured `EcsError` codes fire at extract entry and skip the
   * renderable on violation (charter P3 explicit failure):
   *   - `'sprite-instances-mutually-exclusive-with-instances'`
   *   - `'sprite-instances-requires-sprite-shading-model'`
   *   - `'sprite-instances-count-mismatch'`
   */
  readonly spriteInstances?: SpriteInstancesSnapshot;
  /**
   * feat-20260523-skin-skeleton-animation M2 / T-21: when the entity carries
   * a `Skin` component the extract stage populates this field with the
   * skin palette slice metadata. The record stage uses this to route the
   * draw to `forgeax::pbr-skin` pipeline + set the palette dynamic offset.
   * Absent (`undefined`) means the entity is not skinned.
   */
  readonly skin?: SkinPaletteSlice;
  /**
   * ECS-owned morph weights. Presence selects the Standard Pipeline CPU
   * specialized deformation lane; the asset remains the source of target
   * deltas and the record stage only receives this frozen POD snapshot.
   */
  readonly morph?: MorphSnapshot;
  /** Renderer-owned previous-frame facts attached during temporal projection. */
  readonly temporal?: RenderableTemporalSnapshot;
  /** Detached M2 authoring facts for the optional Points/Lines projection. */
  readonly pointsLines?: PointsLinesRetainedSnapshot;
  readonly probeBlendRecord?: import('../scene/probe-blend-record').ProbeBlendRecord;
}

export type RenderablePreviousSource = 'last-submitted' | 'current-seed';
export type RenderableReactiveReason =
  | 'new-slot'
  | 'generation-reuse'
  | 'reentered'
  | 'geometry-revision'
  | 'material-revision'
  | 'skinning-deformation'
  | 'morph-deformation';
export interface RenderableTemporalSnapshot {
  readonly previousEpoch: number | undefined;
  readonly previousSource: RenderablePreviousSource;
  readonly reactive: boolean;
  readonly reactiveReasons: readonly RenderableReactiveReason[];
  readonly previousTransform: TransformSnapshot;
  readonly previousInstances: InstancesSnapshot | undefined;
  readonly previousSkin: SkinPaletteSlice | undefined;
  readonly previousMorphWeights: Float32Array | undefined;
}

export interface MorphSnapshot {
  readonly weights: Float32Array;
  readonly targetCount: number;
}

export interface GpuDrivenDrawSnapshot {
  readonly kind: 'indexed' | 'non-indexed';
  readonly first: number;
  readonly count: number;
  readonly baseVertex: number;
  readonly materialSlot: number;
  readonly topology: PrimitiveTopology;
  readonly pipelineClass: string;
  readonly materialResourceClass: string;
  readonly projectedHeight?: number;
  readonly lodRanges?: readonly {
    readonly first: number;
    readonly count: number;
    readonly baseVertex: number;
  }[];
}

export interface InstancesSnapshot {
  /** Packed column-major mat4 transforms (16 f32 per instance). */
  readonly transforms: Float32Array;
  /** Number of instances (transforms.length / 16). */
  readonly instanceCount: number;
  /** Stable per-entity GPU buffer cache key (the packed Entity u32). */
  readonly cacheKey: number;
  /**
   * Archetype version stamp at snapshot time. The record stage compares this
   * against its cached version per cacheKey; a bump means the underlying
   * BufferPool slot may have grown / been reallocated, forcing a fresh
   * `device.createBuffer + queue.writeBuffer` round.
   */
  readonly archVersion: number;
}

/**
 * feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M3 / w10:
 * extract-stage view of a `SpriteInstances` carrier (2D peer of
 * `InstancesSnapshot`).
 *
 * Field shapes mirror `InstancesSnapshot` so the record-stage cache protocol
 * (`(cacheKey, archVersion, byteLength)` fingerprint triple) is reused
 * verbatim. The byte length consumed at upload time is the sum
 * `transforms.byteLength + regions.byteLength` (= 80*N for N instances,
 * plan-strategy D-1 interleaved single-buffer); the record stage builds the
 * 80B/instance interleaved buffer once per (entity, archVersion, byteLength)
 * fingerprint change.
 */
export interface SpriteInstancesSnapshot {
  /** Packed column-major mat4 transforms (16 f32 per instance, stride 16). */
  readonly transforms: Float32Array;
  /** Per-instance UV vec4 regions (4 f32 per instance, stride 4). */
  readonly regions: Float32Array;
  /**
   * Number of instances. Derived from `transforms.length / 16` (equivalently
   * `regions.length / 4`); the extract-entry validator guarantees the two
   * derivations agree, otherwise it fires
   * `'sprite-instances-count-mismatch'` and skips the renderable.
   */
  readonly instanceCount: number;
  /** Stable per-entity GPU buffer cache key (the packed Entity u32, D-9). */
  readonly cacheKey: number;
  /** Archetype version stamp at snapshot time (cache invalidation fingerprint). */
  readonly archVersion: number;
}

/**
 * TransformSnapshot: extract-stage view of one entity's resolved world
 * transform (feat-20260601 D-3). Holds the single `world` mat4 (column-major
 * 16 floats, copied from the entity's `Transform.world` view written by
 * propagateTransforms). The record stage copies these 16 floats straight into
 * the mesh SSBO slot (zero `mat4.compose`); position / scale consumers derive
 * from the mat4 via `mat4.getTranslation` / basis-column lengths.
 */
export interface TransformSnapshot {
  readonly world: Float32Array;
}

/**
 * MaterialSnapshot: extract-stage view of one entity's material asset (M2 / w6
 * of feat-20260517-merge-mesh-renderer-material-renderer; plan-strategy section 2.3).
 *
 * Adds optional `baseColorTexture` + `sampler` slots (consumed by the record
 * stage's textured-material code path; M3 / w10 dropped the cast-over-firstMaterial
 * pattern in favour of direct snapshot field reads).
 *
 * feat-20260522-learn-render-3-1-sponza-model-loading-with-multi-l M4 extends
 * the snapshot with `metallicRoughnessTexture` and `normalTexture`
 * so the record stage can wire PBR texture bindings 4 and 6
 * from real GPU views instead of placeholder 1x1 white / flat-normal views.
 *
 * Bounded scope: the snapshot tracks only what the record stage actually
 * consumes today (charter proposition 5 consistent abstraction; YAGNI for
 * future-proof field bloat). Future MaterialAsset extensions (emissive / etc)
 * drive snapshot extensions when the record stage starts consuming them, not
 * vice-versa.
 *
 * tweak-20260701 M1: `shadingModel` field removed — shader identity via
 * {@link materialShaderId} is the single source of truth for material dispatch.
 */
export interface MaterialSnapshot {
  readonly baseColor: Vec3;
  readonly metallic: number;
  readonly roughness: number;
  readonly clearcoat?: number | undefined;
  readonly clearcoatRoughness?: number | undefined;
  /** Authored Standard PBR specular tint in linear runtime color space. */
  readonly specularTint?: readonly [number, number, number] | undefined;
  /**
   * Schema-driven material shader identifier (feat-20260523 M4-T05).
   * Populated when the material asset uses the schema-driven path
   * (payload.materialShader set). Undefined for unlit/sprite legacy
   * materials and for case-B defaultMaterialSnapshot.
   *
   * The record stage uses this as the pipeline cache key first-level
   * discriminator (M4-T06).
   */
  readonly materialShaderId?: string | undefined;
  readonly materialProgramKeys?: Readonly<Record<string, string>> | undefined;
  /**
   * Stable source handle for the material asset. Record uses this only for
   * same-frame assembly reuse; GPU bind-group validity still comes from the
   * resource-identity cache.
   */
  readonly materialHandle?: number | undefined;
  /**
   * The selected forward-pass state for this exact material. A mesh can bind
   * different materials to its submeshes, so pipeline selection must read the
   * state from the submesh snapshot rather than the entity's first material.
   */
  readonly renderState?: MaterialRenderState | undefined;
  /**
   * Schema-driven parameter snapshot (feat-20260523 M4-T05).
   * Populated alongside materialShaderId. Maps param name to its
   * runtime-resolved value: number for scalar params, number[] for
   * vec/color params, string (GUID) for texture2d/sampler params.
   */
  readonly paramSnapshot?: Readonly<Record<string, number | number[] | string>> | undefined;
  /** Effective MaterialAsset parameter contract used to lay out this snapshot. */
  readonly materialParamSchema?: readonly ParamSchemaEntry[] | undefined;
  /** Authored per-slot UV set and KHR texture transform metadata. */
  readonly textureCoordinates?: ReadonlyMap<string, MaterialTextureCoordinates> | undefined;
  /**
   * User-region texture handles keyed by paramSchema field name
   * (feat-20260621-learn-render-5-5-parallax M2 / w7). The SSOT carrier for
   * EVERY texture the shader's `derive(paramSchema).textureFieldNames`
   * declares — `baseColorTexture` / `metallicRoughnessTexture` /
   * `normalTexture` for built-in standard-PBR, plus each custom field such as
   * `heightTexture` (LO 5.5 parallax). The record stage iterates this map to
   * assemble the user-region bind group per the per-shader BGL (w8), so a 4th
   * (or Nth) texture flows end-to-end without a hardcoded field list.
   *
   * Populated by iterating `textureFieldNames`; absent keys mean the
   * paramValue was missing / mis-typed (record falls back to default white).
   * `emissiveTexture` / `occlusionTexture` are included here as ordinary
   * Standard user-region fields; the production layout does not duplicate
   * them in a lightmap injection region.
   */
  readonly textureHandles?: ReadonlyMap<string, Handle<'TextureAsset', 'shared'>> | undefined;
  readonly textureSources?: ReadonlyMap<string, RenderTargetTextureSource> | undefined;
  /**
   * User-region texture field names whose paramValue resolved to a VideoAsset
   * (kind `'video'`) rather than a static TextureAsset
   * (feat-20260623-world-space-video-asset M4 / w14, D-5). The video GUID
   * occupies the same texture2d values slot a static texture would (P4:
   * one binding shape), but extract routes it here instead of `textureHandles`
   * so the record stage pulls the current-frame view from the transient
   * DynamicTextureStore (D-3) instead of `GpuResidencyCache.ensureResident`
   * (which has no `video` arm; AC-08). Each entry also carries the resolved
   * clip handle so the record stage can key the per-frame upload.
   *
   * Producer/consumer split (charter P5 / AC-07 gate): extract owns the
   * asset->snapshot translation; record consumes this POD field only — it never
   * reaches back into the MaterialAsset to learn a field is video-sourced.
   */
  readonly videoTextureFields?: ReadonlyMap<string, Handle<'VideoAsset', 'shared'>> | undefined;
  /** Authored sampler handles keyed by their matching texture parameter. */
  readonly samplerHandles?: ReadonlyMap<string, Handle<'SamplerAsset', 'shared'>> | undefined;
  readonly baseColorTexture?: Handle<'TextureAsset', 'shared'> | undefined;
  /**
   * PBR metallic-roughness texture handle (present for PBR/sprite/skin
   * shaders). Undefined for the default-unlit shader
   * (materialShaderId === 'forgeax::default-unlit'). The record stage reads
   * this to write GPU view at material bind-group binding 4, falling
   * back to a 1x1 white placeholder when undefined.
   *
   * feat-20260522-learn-render-3-1-sponza-model-loading-with-multi-l M4:
   * field added so the record stage can wire real metallic-roughness
   * textures from Sponza glTF materials (M3 writes the handle into
   * SchemaDrivenMaterialAsset values; M4 extract carries it through to the snapshot).
   */
  readonly metallicRoughnessTexture?: Handle<'TextureAsset', 'shared'> | undefined;
  /**
   * PBR tangent-space normal texture handle (present for PBR/sprite/skin
   * shaders). Undefined for the default-unlit shader
   * (materialShaderId === 'forgeax::default-unlit'). The record stage reads
   * this to write GPU view at material bind-group binding 6, falling
   * back to a (0.5,0.5,1.0) flat-normal placeholder when undefined.
   *
   * feat-20260522-learn-render-3-1-sponza-model-loading-with-multi-l M4:
   * field added symmetrically with metallicRoughnessTexture so the record
   * stage can wire real normal textures from Sponza glTF materials.
   */
  readonly normalTexture?: Handle<'TextureAsset', 'shared'> | undefined;
  /** Scalar applied to tangent-space normal XY after the normal texture sample. */
  readonly normalScale?: number | undefined;
  readonly emissive?: readonly [number, number, number] | undefined;
  readonly emissiveIntensity?: number | undefined;
  readonly emissiveTexture?: Handle<'TextureAsset', 'shared'> | undefined;
  readonly occlusionTexture?: Handle<'TextureAsset', 'shared'> | undefined;
  readonly occlusionStrength?: number | undefined;
  /**
   * Transparent composition flag derived from the first pass's
   * `renderState.blend` presence on the underlying
   * {@link MaterialPass} (feat-20260626-collapse M2: blend
   * presence is the SSOT after `MaterialPass.transparent` was
   * dropped in M1).
   *
   * The record stage reads this to drive both the LDR split-pass
   * decision and the premultiplied-alpha blend resolution on the
   * generic materialShaderId pipeline path — shader-agnostic, decoupled
   * from the legacy `shadingModel` discriminant (feat-20260625 M2 D-3,
   * finalised in w15; `shadingModel` field removed in tweak-20260701 M1).
   *
   * This describes the primary-pass snapshot for consumers that need a
   * material summary. Actual draw routing and the LDR split read the selected
   * DispatchEntry.renderState, so mixed opaque/transparent Passes remain valid.
   *
   * Type is `boolean | undefined` (derived): `undefined` means "no
   * passes / unknown"; consumers must read `=== true` / `!== true` to
   * stay correct under both populated and absent cases.
   */
  readonly transparent?: boolean | undefined;
}

export interface MaterialCacheChainIdentity {
  readonly asset: MaterialAsset;
  readonly parentGuid: string | undefined;
}

export interface MaterialSnapshotCacheEntry {
  readonly snapshot: MaterialSnapshot;
  readonly passes: readonly MaterialPass[];
  /** Root/chain identities are present only on cross-frame-safe entries. */
  readonly chain?: readonly MaterialCacheChainIdentity[];
  /** AssetRegistry epoch at which the root/parent chain was last validated. */
  readonly catalogEpoch?: number;
  /** True only when every object reachable from the authored chain is frozen. */
  readonly crossFrameSafe: boolean;
}

export type MaterialSnapshotCache = Map<number, MaterialSnapshotCacheEntry>;
export type MaterialSnapshotCachesByWorld = WeakMap<World, MaterialSnapshotCache>;

// === DispatchEntry — M3 / w26 single dispatch list (feat-20260526-material-asset-multipass-renderstate) ===
//
// Plan-strategy D-3: single dispatch list sorted by queue value,
// replacing the old three-bucket opaque/transparent/overlay dispatch.
// Each entry carries the per-pass render-state and entry-point
// data from the resolved MaterialPass so the record stage
// reads them without re-resolving the material.

export interface DispatchEntry {
  readonly entityIndex: number;
  readonly materialHandle: number;
  readonly renderableIndex: number;
  readonly passIndex: number;
  readonly queue: number;
  /**
   * Signed i32 from the entity's {@link Layer} component value (default 0 for
   * entities without a Layer). Primary sort key for the transparent-dispatch
   * sort in {@link render-system.ts}: lower value = drawn first (behind).
   */
  readonly layer: number;
  readonly tags: Record<string, string>;
  readonly renderState: MaterialRenderState | undefined;
  readonly defines: Record<string, string> | undefined;
  readonly vertexEntry: string | undefined;
  readonly fragmentEntry: string | undefined;
  readonly materialShaderId: string | undefined;
  readonly paramSnapshot: Readonly<Record<string, number | number[] | string>> | undefined;
  /**
   * Stencil reference value from {@link MaterialPass.stencilReference}
   * (draw-call dynamic state). Folded during extract for per-draw consumption
   * in the record stage. `undefined` when the pass does not set a reference
   * value (record stage falls back to WebGPU default 0).
   */
  readonly stencilReference?: number;
}

export interface ExtractedFrame {
  readonly cameras: CameraSnapshot[];
  readonly auxiliaryCameras: readonly CameraSnapshot[];
  readonly cubeCameras: readonly CubeCameraSnapshot[];
  readonly reflectionProbes?: readonly ReflectionProbeFact[];
  readonly lights: ExtractedLights;
  /** Resource-owner environment facts selected once at the extract boundary. */
  readonly environment: EnvironmentFrame | undefined;
  /** False when the resource-owner world failed environment/fog selection. */
  readonly environmentReady: boolean;
  readonly volumetricFog?: ExtractedVolumetricFog;
  readonly renderables: RenderableSnapshot[];
  /**
   * Single dispatch list sorted by queue value (ascending, stable sort).
   * Replaces the old opaqueDispatch / transparentDispatch / overlayDispatch
   * three-bucket model per plan-strategy D-3.
   */
  readonly dispatch: DispatchEntry[];
  readonly skylight: SkylightSnapshot | undefined;
  readonly skylightCount: number;
  readonly lightProbes?: readonly LightProbeSnapshot[];
  readonly skybox: SkyboxSnapshot | undefined;
  readonly skyboxCount: number;
  /** Resource-owner Fog facts selected once at the frame boundary. */
  readonly fog: FogFrame | undefined;
  readonly fogFailure?: FogSelectionFailure;
  /**
   * feat-20260528-frustum-culling M3 / w11: frustum culling statistics
   * collected during the extract phase. `total` is the count of entities
   * that reached the culling decision point; `culled` is the count of
   * those that were removed from renderables by frustum culling.
   */
  readonly frustumStats: { readonly culled: number; readonly total: number };
  /** Candidate entities rejected by author visibility before resource parsing. */
  readonly visibilityStats: { readonly explicitlyHidden: number };
  /**
   * Per-frame post-process params snapshot collected from PostProcessParams
   * entities (D-1: data-driven params channel). Maps shader id to the
   * raw data bytes (Uint8Array = FieldValueType<'buffer'>). Last-one-wins
   * when multiple entities bear the same shader id.
   * Empty map when no PostProcessParams entities exist.
   */
  readonly postProcessParams: ReadonlyMap<string, Uint8Array>;
  /** Visibility snapshots prepared for each contributing World. */
  readonly visibilitySnapshots: readonly VisibilitySnapshot[];
  /** World-labelled snapshots passed to generic RenderFeature extraction. */
  readonly featureVisibilitySnapshots: readonly RenderFeatureWorldVisibilitySnapshot[];
  /** Built-in hidden candidates, retained for host-side producer deduplication. */
  readonly hiddenEntityReports: readonly RenderFeatureHiddenEntityReport[];
}

/**
 * feat-20260612-skin-palette-per-frame-upload M2 / m2-6: narrow per-frame
 * pipeline surface consumed by `extractFrame`. Today only `skinPaletteAllocator`
 * crosses the seam (the allocator owns the per-frame palette buffer + cursor;
 * extract calls `resetForFrame` at frame entry then `allocateSlice` +
 * `writeJointPalette` per skinned entity). Kept narrow on purpose — extract
 * does NOT see the rest of `PipelineState` to avoid a circular import via
 * `render-system.ts`.
 */
export interface ExtractPipelineSurface {
  readonly skinPaletteAllocator: SkinPaletteAllocator | null;
}

/**
 * bug-20260710-editor-cross-world-shadow: the camera-frustum subset of
 * {@link CameraSnapshot} that the directional-CSM matrix builder consumes.
 */
export interface CsmCameraData {
  readonly world: Float32Array;
  readonly fov: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
  readonly projection: 'perspective' | 'orthographic';
  readonly orthoLeft: number;
  readonly orthoRight: number;
  readonly orthoBottom: number;
  readonly orthoTop: number;
}

/**
 * bug-20260710-editor-cross-world-shadow: the raw directional-shadow config a
 * DirectionalLight carries, threaded onto {@link ExtractedLights} so the merge
 * layer can recompute CSM matrices against the surfaced camera. Distinct from
 * the *computed* outputs (lightViewProj / splitPlanes) also on ExtractedLights.
 */
export interface DirectionalCsmConfig {
  readonly cascadeCount: number;
  readonly splitLambda: number;
  readonly cascadeBlend: number;
  readonly mapSize: number;
  readonly shadowDistance: number;
  readonly shadowFilter: number;
  readonly shadowAngularRadius: number;
  readonly maxPenumbraTexels: number;
}

/**
 * bug-20260710-editor-cross-world-shadow: computed directional-CSM output —
 * the per-cascade light-view-projection matrices plus the derived cascade
 * metadata. Returned by {@link computeDirectionalCsm}; `undefined` when the
 * config or camera is missing (caller leaves the fields undefined).
 */
export interface DirectionalCsmResult {
  readonly lightViewProj: Float32Array[];
  readonly splitPlanes: Float32Array;
  readonly cascadeCount: number;
  readonly cascadeBlend: number;
  readonly shadowMapSize: number;
  readonly directionalShadowQuality: DirectionalShadowQuality;
}

/**
 * feat-20260709-editor-world-partition M1 / w4 (AC-08, plan-strategy §2 D-3):
 * the owner index that previously served BOTH cameras and singleton render
 * resources (skylight / skybox / postProcessParams) is split into two
 * independent indices. `cameraOwner` selects the world whose cameras are
 * surfaced; `resourceOwner` selects the world whose singleton resources are
 * surfaced. A single number is accepted as the backward-compatible legacy form
 * where `cameraOwner === resourceOwner === owner` (single-world callers +
 * frame-loop stay byte-identical; the hard `{ owner }` cutover lands in M2).
 */
export interface ExtractFramesOwner {
  readonly cameraOwner: number;
  readonly resourceOwner: number;
}

export interface PreparedExtractContext {
  readonly materialContext?: MaterialCookProgramContext | undefined;
  readonly assets: AssetRegistry | null | undefined;
  readonly pipelineState: ExtractPipelineSurface | null | undefined;
  readonly materialSnapshotCache: MaterialSnapshotCache | undefined;
  /** `undefined` keeps direct extractFrame's local Fog semantics; `null` means
   * the frame owner already selected that no Fog is present for this world. */
  readonly resourceOwnerFog: FogFrame | null | undefined;
  readonly cull: 'self' | 'none' | 'external';
  readonly cullCameras: readonly CameraSnapshot[] | undefined;
  readonly hierarchy: SceneHierarchySnapshot;
  readonly visibility: VisibilitySnapshot;
}
