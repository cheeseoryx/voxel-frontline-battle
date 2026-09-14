import type { MaterialCookProgramContext } from '@forgeax/engine-pack/material-cook';
// @forgeax/engine-runtime - RenderSystem Extract stage (D-S2 + plan-strategy R-15
// fallback split). Pure ECS query phase: walks Camera / DirectionalLight /
// the merged-MeshRenderer renderable archetype and produces SoA-free snapshot
// arrays consumed by the Record stage.
//
// Carve-out from render-system.ts (review round 1 finding #3 - 505 line cap
// fallback split into 3 files; main + extract + record). The public API remains
// limited to the renderer contract; this module is an owner-local
// implementation seam consumed through relative imports.
//
// w15 (feat-20260511-asset-system-v1 M5 / plan-strategy D-P4) +
// feat-20260513-component-naming-bevy-align M3 / D-2 (merged) +
// feat-20260517-merge-mesh-renderer-material-renderer M2 / w5 (rename) +
// M3 / w9 (single-query convergence; this commit):
//   The previous 4-query alpha split (one full-archetype query gating on
//   Transform + MeshFilter + MeshRenderer without Instances; one direct
//   archetype-graph walk for the instanced variant; two fallback queries
//   on Transform+MeshFilter without MeshRenderer / MeshFilter without
//   Transform; one trailing dispatch query gating on MeshRenderer alone)
//   collapses into ONE archetype-graph walk gated on `MeshRenderer`
//   component presence (plan-strategy section 2.2 case A archetype-
//   natural-absence + section 3.2 sequence diagram "with: [MeshRenderer]
//   (sole)"). Inside the loop
//   the four D-Q7 dispositions land:
//     - case A (no MeshRenderer)  : not in domain; archetype absent. No
//                                   fire; no renderable; no dispatch.
//     - case B (material === 0)   : missing-spec sentinel; defaultMaterial
//                                   Snapshot fills the slot. No fire.
//     - case C (handle unresolved): assets.get(handle).err with the entity
//                                   carrying the full T+MF+MR renderable
//                                   archetype -> structured RhiError(
//                                   `asset-not-registered`) routed through
//                                   the World Layer-3 ErrorHandler + entity
//                                   skipped from RenderableSnapshot[] +
//                                   from MaterialDispatchSnapshot[]; with a
//                                   non-renderable archetype (MeshRenderer
//                                   only / lacking T or MF) the dangling
//                                   handle stays a silent skip (charter F1
//                                   surface minimization: AI users without
//                                   render intent should not see render
//                                   errors).
//     - resolved                  : populated MaterialSnapshot (5 fields)
//                                   + MaterialDispatchSnapshot dispatch
//                                   entry (regardless of T+MF presence,
//                                   preserving the dispatch-only counter
//                                   semantics).
//
// D-Q7 three-tier subtable (SSOT mirrored in `packages/runtime/README.md`
// §ECS render bridge D-Q7 `MeshRenderer` three-tier subtable +
// `components/mesh-renderer.ts` head JSDoc; AGENTS.md §Component naming
// + §Breaking changes 2026-05-17 row references this surface):
//   - case A archetype absent : silent skip; no onError; not in
//                               RenderableSnapshot[]; hint literal N/A
//                               (charter "ergonomic omission, not a
//                               misuse"; AC-09).
//   - case B missing-spec     : `material === undefined` ->
//                               `defaultMaterialSnapshot()` mid-grey
//                               unlit; no onError; entity present in
//                               RenderableSnapshot[] with default
//                               material; hint literal: `'pass
//                               undefined or omit field to request
//                               default material'` (AC-10).
//   - case C dangling-ref     : `assets.get(handle).err` (strict path,
//                               isRenderable === true) ->
//                               `RhiError({ code: 'asset-not-
//                               registered', detail: { assetHandle },
//                               hint: 'register material via
//                               assetRegistry.register(asset) before
//                               spawn, or remove the material field
//                               to fall back to default' })` routed
//                               through World Layer-3 ErrorHandler;
//                               entity skipped from
//                               RenderableSnapshot[] +
//                               MaterialDispatchSnapshot[]; mirrors
//                               `MeshFilter.assetHandle` dangling path
//                               (charter proposition 5; AC-11).
//
// World owns explicit Instances transforms. Extraction makes a detached
// per-renderer projection; GPU residents acknowledge complete snapshots only
// after successful uploads. Reading a snapshot never changes author state.

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  materialParametersToParamSchema as projectMaterialParametersToParamSchema,
  resolveAssetHandle,
  selectMaterialPassProgram,
  walkMaterialPassesOverSharedRefs,
} from '@forgeax/engine-assets-runtime';
import type { Component, ComponentSchema, EntityHandle, Query, World } from '@forgeax/engine-ecs';
import { readRenderArrayView, routeWorldError } from '@forgeax/engine-ecs/projection';
import { type Mat4, mat4, type Vec3, vec3 } from '@forgeax/engine-math';
import { AssetGuid, type AssetGuid as AssetGuidBytes } from '@forgeax/engine-pack/guid';
import { RhiError } from '@forgeax/engine-rhi';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import {
  DEFAULT_STANDARD_SURFACE_MODULE,
  type MaterialShaderArtifact,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import type {
  Asset,
  Handle,
  MaterialAsset,
  MaterialColorParameterSchema,
  MaterialParameter,
  MaterialPass,
  MaterialRenderState,
  MaterialTextureCoordinates,
  MaterialTextureValue,
  MeshLodLevel,
  ParamSchemaEntry,
  PrimitiveTopology,
  TextureAsset,
} from '@forgeax/engine-types';
import {
  derive,
  materialGuidText,
  materialValuesToLinearRuntime,
  toShared,
} from '@forgeax/engine-types';
import {
  antialiasFromF32,
  bloomEnabledFromF32,
  Camera,
  CubeCamera,
  cameraProjectionFromF32,
  cubeCameraUpdateIntentFromF32,
  Fog,
  MotionBlur,
  ReflectionProbe,
  reflectionProbeUpdateIntentFromF32,
  tonemapFromF32,
  tonemapToU32,
} from './components';
import type { DirectionalShadowQuality } from './components/directional-shadow-filter';
import type { LightValidationError } from './components/light-helpers';
import { selectEnvironment } from './environment/frame';
import { ShadowInvalidConfigError } from './errors/render';
import {
  type DirectionalShadowCascadeFit,
  projectDirectionalShadow,
} from './extract/directional-shadow-projection';
import type {
  EnvironmentFrame,
  FogCandidate,
  FogFrame,
  FogSelectionFailure,
} from './extract/environment';
import { resolveVisibility, type VisibilitySnapshot } from './extract/visibility';
import type {
  RenderFeatureHiddenEntityReport,
  RenderFeatureWorldVisibilitySnapshot,
} from './features/types';
import type { InstanceCollectionId, InstanceProjectionStore } from './instances';
import type {
  MeshMaterialBindingDiagnostic,
  MeshMaterialBindingSource,
} from './mesh-material-bindings';
import { isCanonicalStandardPbrMaterialShader, isStandardPbrMaterialShader } from './pbr-pipeline';
import type { PointsLinesRetainedSnapshot } from './points-lines/snapshot';
import type { ReflectionProbeFact } from './reflection/projection';
import type { CameraSnapshot, CubeCameraSnapshot } from './render-contract';
import { defaultMaterialSnapshot } from './render-system-extract-tail';
import { getActiveCamera, selectActiveCameraIndex } from './systems/active-camera';
import { selectPasses } from './systems/pass-selector';
import type { SkinPaletteAllocator } from './systems/skin-palette-allocator';
import type { SkinPaletteSlice } from './systems/skin-palette-types';
import type { RenderTarget, RenderTargetTextureSource } from './targets/contracts';
import { resolveRenderTargetMaterialSource } from './targets/material-source';
import { resolveSelectedVolumetricLight } from './volume/capability';
import {
  type ValidatedVolumetricFog,
  type VolumeDensityBinding,
  VolumetricFog,
  type VolumetricFogAuthoring,
} from './volume/component';
import { extractVolumetricFog } from './volume/extract';
import type { VolumeProjectorTuple } from './volume/temporal';

/**
 * DirectionalLightSnapshot — sun-like infinite light variant of the
 * `LightSnapshot` discriminated union (M2 / w16 / AC-03). Host pre-multiplies
 * `color * intensity` so the shader sees the radiance term directly (charter
 * P4 host-side parity); `direction` stays in raw outgoing-vector form so the
 * shader can negate it once for BRDF (`let l = normalize(-light.direction)`).
 *
 * Plan-strategy D-S1 (3) (LightSnapshot to GPU buffer bucket 1:1 mapping).
 */
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
   * cube_array atlas layer index for this light's shadow map (0..capacity-1
   * for admitted shadow casters; sentinel `-1` for non-admitted lights).
   * Default `-1` per
   * plan-strategy §D-2 — record stage / shader skips shadow sampling when the
   * lane equals the sentinel. Joined with `pointShadow[]` by entity at the
   * end of extract; HDRP record stage threads `shadowAtlasLayer + shadowNear +
   * shadowFar` through the unified direct-light metadata payload.
   */
  readonly shadowAtlasLayer?: number;
  /**
   * Per-face perspective near plane (matches `PointLightShadow.nearPlane`).
   * Used by HDRP `evalPointShadowed` for depth-ref reconstruction; URP keeps
   * the projection constants in its dedicated shadow-parameter buffer.
   */
  readonly shadowNear?: number;
  /**
   * Per-face perspective far plane (matches `PointLightShadow.farPlane`).
   * It is consumed with the shadow atlas layer through the shared
   * shadow-parameter buffer; DirectLightSlot carries only the layer identity.
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
 * `shadowAtlasLayer` is assigned by extract in spawn order up to the renderer
 * atlas capacity; over-budget requests retain the sentinel `-1` so the
 * downstream DirectLightSlot packing carries no invalid layer identity.
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
   * Atlas layer assigned by extract in spawn order while capacity remains.
   * Sentinel -1 is used for a request that cannot be admitted and is
   * reserved by the shader-side DirectLightSlot metadata for no-shadow lights.
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
 * component shadow parameters carried through to the record stage. The
 * author-facing `shadowIntensity` remains in [0,1] and is copied unchanged;
 * shader consumers apply it only to shadow visibility, never to candela
 * radiance.
 */
export interface SpotLightSnapshot {
  readonly kind: 'spot';
  /** Entity identity is branded in extracted frames; numeric fixtures remain compatible. */
  readonly entity?: EntityHandle | number;
  readonly position: Vec3;
  readonly direction: Vec3;
  readonly color: Vec3;
  readonly intensity: number;
  readonly invRangeSquared: number;
  readonly cosInner: number;
  readonly cosOuter: number;
  /** Shared asset identities projected from the authored modifier fields. */
  readonly iesProfileHandle?: number;
  readonly cookieHandle?: number;
  /** Resource-array slice identities; absent means the modifier falls back. */
  readonly iesProfileSlice?: number;
  readonly cookieSlice?: number;
  /** Resolved authored payloads; absent means the renderer keeps identity LKG. */
  readonly iesProfileData?: Uint8Array;
  readonly cookieData?: Uint8Array;
  /** Aspect-only UV matrix paired with `cookieSlice`; upload is dirty-ranged. */
  readonly cookieMatrix?: Float32Array;
  /**
   * Legacy projector payload projected into the shared Cookie array lane when
   * the adapter exposes the extended-lighting topology. The projector keeps
   * its lightViewProj sampling semantics; only the texture transport is
   * shared with authored Cookie resources.
   */
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
  /** Fraction of sampled shadow visibility to retain; 1 = fully opaque shadow. */
  readonly shadowIntensity?: number;
  readonly depthBias?: number;
  readonly normalBias?: number;
  readonly pcfKernelSize?: number;
  /** Authoritative TextureAsset projector resolved from the SpotLight handle. */
  readonly projectorHandle?: Handle<'TextureAsset', 'shared'>;
  readonly projectorAsset?: TextureAsset;
  readonly projectorGuid?: string;
  readonly projectorGeneration?: number;
  readonly projectorRevision?: number;
}

/** RectArea direct-light snapshot carried by the unified slot contract. */
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

/** Normalized world-space frame used by Rect extraction, culling, and BRDF. */
export interface RectAreaWorldFrame {
  readonly center: Vec3;
  readonly axisX: Vec3;
  readonly axisY: Vec3;
  readonly normal: Vec3;
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/** Build the single normalized Rect frame shared by direct and cluster paths. */
export function buildRectAreaWorldFrame(input: {
  readonly center: ArrayLike<number>;
  readonly axisX: ArrayLike<number>;
  readonly axisY: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}): RectAreaWorldFrame {
  const center = vec3.create(input.center[0] ?? 0, input.center[1] ?? 0, input.center[2] ?? 0);
  const axisX = vec3.normalize(
    vec3.create(),
    vec3.create(input.axisX[0] ?? 0, input.axisX[1] ?? 0, input.axisX[2] ?? 0),
  );
  const axisY = vec3.normalize(
    vec3.create(),
    vec3.create(input.axisY[0] ?? 0, input.axisY[1] ?? 0, input.axisY[2] ?? 0),
  );
  const normal = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), axisX, axisY));
  normal[0] = normal[0] === 0 ? 0 : (normal[0] ?? 0);
  normal[1] = normal[1] === 0 ? 0 : (normal[1] ?? 0);
  normal[2] = normal[2] === 0 ? 0 : (normal[2] ?? 0);
  return {
    center,
    axisX,
    axisY,
    normal,
    halfWidth: Math.max(0, input.width * 0.5),
    halfHeight: Math.max(0, input.height * 0.5),
  };
}

/** Return true only on the authored front side of a one-sided Rect. */
export function rectAreaFacesPoint(frame: RectAreaWorldFrame, point: ArrayLike<number>): boolean {
  const toPoint = vec3.create(
    (point[0] ?? 0) - (frame.center[0] ?? 0),
    (point[1] ?? 0) - (frame.center[1] ?? 0),
    (point[2] ?? 0) - (frame.center[2] ?? 0),
  );
  return vec3.dot(frame.normal, toPoint) > 0;
}

/** Project a world point onto the finite authored Rect boundary. */
export function closestPointOnRectArea(frame: RectAreaWorldFrame, point: ArrayLike<number>): Vec3 {
  const toPoint = vec3.create(
    (point[0] ?? 0) - (frame.center[0] ?? 0),
    (point[1] ?? 0) - (frame.center[1] ?? 0),
    (point[2] ?? 0) - (frame.center[2] ?? 0),
  );
  const localX = Math.min(
    frame.halfWidth,
    Math.max(-frame.halfWidth, vec3.dot(toPoint, frame.axisX)),
  );
  const localY = Math.min(
    frame.halfHeight,
    Math.max(-frame.halfHeight, vec3.dot(toPoint, frame.axisY)),
  );
  return vec3.create(
    (frame.center[0] ?? 0) + (frame.axisX[0] ?? 0) * localX + (frame.axisY[0] ?? 0) * localY,
    (frame.center[1] ?? 0) + (frame.axisX[1] ?? 0) * localX + (frame.axisY[1] ?? 0) * localY,
    (frame.center[2] ?? 0) + (frame.axisX[2] ?? 0) * localX + (frame.axisY[2] ?? 0) * localY,
  );
}

/**
 * LightSnapshot — discriminated union of the directional and punctual
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
  /** Four vec4 lanes: split, worldUnitsPerTexel, lightDepthWorldSpan, reserved. */
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
  /** Accepted closed Directional filter projected from the first query result. */
  readonly directionalShadowQuality: DirectionalShadowQuality | undefined;
  /** Structured author-config failure; the candidate is withheld from record. */
  readonly directionalShadowError: LightValidationError | undefined;
  /**
   * feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-7:
   * shadow-casting point lights (PointLight + PointLightShadow + Transform
   * archetype join). Each entry carries the per-light 6-face VP matrices and
   * the assigned cube_array atlas layer (0..3 in spawn order; sentinel -1 is
   * reserved by the shader-side DirectLightSlot metadata for no-shadow point
   * lights).
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

/** Local diffuse probe facts; specular remains owned by Skylight/ReflectionProbe. */
export interface LightProbeSnapshot {
  readonly identity: string;
  readonly position: readonly [number, number, number];
  readonly radius: number;
  readonly irradiance: Float32Array;
  readonly admitted: boolean;
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

/**
 * Resource-owner projection for the single ECS VolumetricFog singleton.
 *
 * The renderer carries the validated authoring facts and the source POD all
 * the way to the record stage.  No profile flag or source/catalog byte is
 * allowed to enable the graph: `status: 'available'` is produced only after
 * the ECS component, its shared TextureAsset, and the volume validator all
 * agree on one linear 3D density owner.
 */
export interface ExtractedVolumetricFog {
  readonly status: 'off' | 'available' | 'degraded';
  readonly fog?: ValidatedVolumetricFog;
  readonly densityHandle?: Handle<'TextureAsset', 'shared'>;
  readonly densityAsset?: TextureAsset;
  readonly guid?: string;
  readonly generation?: number;
  readonly digest?: string;
  readonly worldId?: number;
  /** Required same-World light selected by the authoring component. */
  readonly lightEntity?: EntityHandle;
  readonly lightKind?: 'directional' | 'point' | 'spot';
  /** Optional Point+Spot pair identities consumed by the volume integrator. */
  readonly pointLightEntity?: EntityHandle;
  readonly spotLightEntity?: EntityHandle;
  /** Accepted projector tuple shared by surface and volume when authored. */
  readonly projector?: VolumeProjectorTuple;
  /** The resolved projector payload shared with the surface light snapshot. */
  readonly projectorHandle?: Handle<'TextureAsset', 'shared'>;
  readonly projectorAsset?: TextureAsset;
}

export interface RenderableSnapshot {
  readonly assetHandle: number;
  readonly transform: TransformSnapshot;
  /** Producer-authored lower-detail references projected from MeshAsset. */
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
  /** Effective authored visibility retained by the persistent scene owner. */
  readonly authorVisible?: boolean;
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
  /** Joint entity identities used by the persistent skin dependency index. */
  readonly skinJointEntities?: readonly number[];
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
  /** Renderer-owned per-object probe record uploaded at group(3) binding(1). */
  readonly probeBlendRecord?: import('./scene/probe-blend-record').ProbeBlendRecord;
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
  /** Producer-owned prepared ABI facts used by the Standard PBR GPU lane. */
  readonly prepared?: import('./gpu-driven/prepared-draw').PreparedGpuDrivenDraw;
  /** Optional projected height supplied by direct GPU-view evidence/tests. */
  readonly projectedHeight?: number;
  /** Root plus lower-detail index/vertex ranges, in LOD order. */
  readonly lodRanges?: readonly {
    readonly first: number;
    readonly count: number;
    readonly baseVertex: number;
  }[];
}

export interface InstancesSnapshot {
  /** Renderer-owned collection identity. */
  readonly collectionId?: InstanceCollectionId;
  /** Packed column-major mat4 transforms (16 f32 per instance). */
  readonly transforms: Float32Array;
  /** Number of instances (transforms.length / 16). */
  readonly instanceCount: number;
  /** Collection revision captured by this detached frame snapshot. */
  readonly revision?: number;
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
 * 16 floats, copied from the entity's `GlobalTransform.world` view written by
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
  /** Authored Standard PBR specular color in linear runtime color space. */
  readonly specularColor?: readonly [number, number, number] | undefined;
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
  /** Renderer-local target sources; never projected as TextureAsset handles. */
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

export function gpuDrivenMaterialResourceClass(material: MaterialSnapshot): string {
  const textures = [...(material.textureHandles?.entries() ?? [])]
    .map(([name, handle]) => [name, Number(handle)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const samplers = [...(material.samplerHandles?.entries() ?? [])]
    .map(([name, handle]) => [name, Number(handle)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify({
    textures,
    samplers,
    video: [...(material.videoTextureFields?.keys() ?? [])].sort(),
  });
}

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

/**
 * Stable-sort dispatch entries by `queue` value ascending.
 * Returns a new sorted array (does not mutate the input).
 * Same-queue entries preserve insertion order (AC-11 stable-order guarantee).
 */
export function sortDispatchByQueue<E extends { readonly queue: number }>(
  entries: readonly E[],
): E[] {
  // Array.prototype.sort is stable per ES2019 spec (V8 7.0+ / Node 12+).
  return entries.slice().sort((a, b) => a.queue - b.queue);
}

export const DEFAULT_FORWARD_PASS: MaterialPass = {
  name: 'forward',
  program: { module: 'forgeax::default-unlit', vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
  renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
};

export function appendMaterialDispatchEntries(
  pendingDispatch: DispatchEntry[],
  passes: readonly MaterialPass[],
  entity: EntityHandle,
  materialHandle: number,
  renderableIndex: number,
  layer: number,
  paramSnapshot: Readonly<Record<string, number | number[] | string>> | undefined,
  passIndexOffset = 0,
  materialProgramKeys?: Readonly<Record<string, string>>,
): void {
  const matchedPasses = selectPasses(passes, {});
  for (let pIdx = 0; pIdx < matchedPasses.length; pIdx++) {
    const pass = matchedPasses[pIdx];
    if (pass === undefined) continue;
    const passState = (pass.renderState ?? {}) as MaterialRenderState & {
      readonly tags?: Record<string, string>;
      readonly queue?: number;
      readonly stencilReference?: number;
    };
    const authoredShaderId = runtimeMaterialShaderId(pass.program.module, pass.name);
    const dispatchShaderId =
      materialProgramKeys === undefined ? authoredShaderId : materialProgramKeys[pass.name];
    if (materialProgramKeys !== undefined && dispatchShaderId === undefined)
      throw new Error(`Missing published material program for Pass ${pass.name}`);
    pendingDispatch.push({
      entityIndex: entity,
      materialHandle,
      renderableIndex,
      passIndex: passIndexOffset + pIdx,
      queue: passState.queue ?? 2000,
      layer,
      tags: passState.tags ?? {},
      renderState: pipelineRenderState(passState),
      // Material module identity is already closed in the cooked program.
      // It must never become a draw-time define map.
      defines: undefined,
      vertexEntry: pass.program.vertexEntry,
      fragmentEntry: pass.program.fragmentEntry,
      materialShaderId: dispatchShaderId,
      paramSnapshot,
      ...(passState.stencilReference !== undefined && {
        stencilReference: passState.stencilReference,
      }),
    });
  }
}

export interface ExtractedFrame {
  readonly cameras: CameraSnapshot[];
  /** Auxiliary target cameras selected after the display camera is fixed. */
  readonly auxiliaryCameras: readonly CameraSnapshot[];
  /** Cube capture intents extracted beside the display camera in one pass. */
  readonly cubeCameras: readonly CubeCameraSnapshot[];
  /** Reflection probe facts projected from the same World extraction. */
  readonly reflectionProbes?: readonly ReflectionProbeFact[];
  readonly lights: ExtractedLights;
  /** Resource-owner environment facts selected once at the extract boundary. */
  readonly environment: EnvironmentFrame | undefined;
  /** False when the resource-owner world failed environment/fog selection. */
  readonly environmentReady: boolean;
  /** One resource-owner volume projection; absent means no authored fog. */
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
  /** World-local diffuse probe candidates; never a direct-light slot. */
  readonly lightProbes?: readonly LightProbeSnapshot[];
  readonly skybox: SkyboxSnapshot | undefined;
  readonly skyboxCount: number;
  /** Resource-owner Fog facts selected once at the frame boundary. */
  readonly fog: FogFrame | undefined;
  /** Last invalid Fog update retained alongside the current valid/LKG frame. */
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

export type CameraTargetUpdate = 'once' | 'on-demand' | 'continuous';

export interface CameraTargetCandidate {
  readonly worldId: number;
  readonly entityKey: number;
  readonly target?: RenderTarget;
  readonly requestVersion: number;
  readonly update: CameraTargetUpdate;
}

export interface CameraTargetRejection {
  readonly entityKey: number;
  readonly reason: 'budget' | 'display-target' | 'duplicate-target';
}

export interface CameraTargetSelection {
  readonly display: CameraTargetCandidate | undefined;
  readonly auxiliary: readonly CameraTargetCandidate[];
  readonly rejected: readonly CameraTargetRejection[];
}

export function selectCameraTargetViews(
  candidates: readonly CameraTargetCandidate[],
  options: { readonly displayEntityKey?: number; readonly budget: number },
): CameraTargetSelection {
  const display = candidates.find(
    (candidate) =>
      candidate.entityKey === options.displayEntityKey && candidate.target === undefined,
  );
  const rejected: CameraTargetRejection[] = [];
  const ordered = candidates
    .filter((candidate) => candidate.target !== undefined)
    .sort((left, right) => left.worldId - right.worldId || left.entityKey - right.entityKey);
  const auxiliary: CameraTargetCandidate[] = [];
  const seenTargets = new Set<RenderTarget>();
  for (const candidate of ordered) {
    const duplicate = candidate.target !== undefined && seenTargets.has(candidate.target);
    if (candidate.target !== undefined) seenTargets.add(candidate.target);
    if (candidate.entityKey === options.displayEntityKey) {
      rejected.push({ entityKey: candidate.entityKey, reason: 'display-target' });
      continue;
    }
    if (candidate.target === undefined || duplicate) {
      rejected.push({ entityKey: candidate.entityKey, reason: 'duplicate-target' });
      continue;
    }
    if (auxiliary.length >= Math.max(0, options.budget)) {
      rejected.push({ entityKey: candidate.entityKey, reason: 'budget' });
      continue;
    }
    auxiliary.push(candidate);
  }
  return {
    display,
    auxiliary: Object.freeze(auxiliary),
    rejected: Object.freeze(rejected),
  };
}

/**
 * Internal world surface used by extract for archetype-graph traversal and
 * error routing. The packed `Entity` handle for a row is read directly from
 * the essential id=0 `Entity` column (`arch.columns.get(Entity.id).get('self')`)
 * -- no generation lookup / encodeEntity rebuild (feat-20260602 M2).
 */
type RenderErrorContext = {
  readonly systemName: string;
  /** Retained as diagnostic metadata for legacy render call sites. */
  readonly severity?: 'error' | 'warning';
};

type ArrayFieldView = ArrayLike<number>;

/**
 * Render's old zero-copy ECS calls now use the explicit public projection
 * boundary. The optimized ECS owner keeps storage behind `World`; render
 * receives a detached array snapshot and routes failures through the same
 * projection owner.
 */
export type WorldInternalView = {
  _routeError(error: unknown, ctx: RenderErrorContext): void;
  _getArrayView<N extends string, S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<N, S>,
    fieldName: string,
  ): ArrayFieldView | undefined;
};

export const Severity = Object.freeze({ Error: 'error', Warning: 'warning' } as const);

export function createWorldInternalView(world: World): WorldInternalView {
  return {
    _routeError(error, ctx) {
      routeWorldError(world, error, { systemName: ctx.systemName });
    },
    _getArrayView(entity, component, fieldName) {
      return readRenderArrayView(world, entity, component, fieldName) as ArrayFieldView | undefined;
    },
  };
}

export function resolveCameraTarget(
  world: World,
  raw: number | undefined,
): RenderTarget | undefined {
  if (raw === undefined || raw <= 0) return undefined;
  const resolved = world.sharedRefs.resolve<'RenderTarget', RenderTarget>(
    toShared<'RenderTarget'>(Math.round(raw)),
  );
  return resolved.ok ? resolved.value : undefined;
}

/**
 * The user-region texture fields the built-in standard-PBR material declares.
 * Used as the fallback texture-field set when the shader id is not registered
 * (cross-worktree shader-late-register, plan R-4) so a built-in material still
 * resolves its user-region textures. Mirrors `derive(default-standard-pbr).textureFieldNames`.
 */
export const BUILTIN_USER_REGION_TEXTURE_FIELDS: readonly string[] = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
  'specularColorTexture',
  'emissiveTexture',
  'occlusionTexture',
  'transmissionTexture',
  'thicknessTexture',
];
const BUILTIN_USER_REGION_TEXTURE_FIELD_SET = new Set(BUILTIN_USER_REGION_TEXTURE_FIELDS);
const BUILTIN_BASE_COLOR_TEXTURE_FIELD_SET = new Set(['baseColorTexture']);

export function materialTextureFields(
  shaderId: string | undefined,
  fields: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  if (fields !== undefined && fields.size > 0) return fields;
  if (
    shaderId === 'forgeax::default-standard-pbr' ||
    shaderId === 'forgeax::default-standard-pbr-skin' ||
    shaderId === 'forgeax::pbr-skin'
  ) {
    return BUILTIN_USER_REGION_TEXTURE_FIELD_SET;
  }
  if (
    shaderId === 'forgeax::default-unlit' ||
    shaderId === 'forgeax::sprite' ||
    shaderId === 'forgeax::sprite-lit'
  ) {
    return BUILTIN_BASE_COLOR_TEXTURE_FIELD_SET;
  }
  return fields;
}

/**
 * The authored material surface uses the module IDs declared by built-in WGSL
 * sources. Runtime pipeline caches still use the existing engine registration
 * IDs, so this small projection keeps authored identity and renderer lookup
 * identity in one place during the migration.
 */
export function runtimeMaterialShaderId(
  module: string | undefined,
  passName?: string,
): string | undefined {
  if (
    passName === 'shadow-caster' &&
    (module === 'forgeax_material::standard' ||
      module === 'forgeax_material::unlit' ||
      module === 'forgeax::default-standard-pbr' ||
      module === 'forgeax::default-unlit')
  ) {
    return 'forgeax::default-shadow-caster';
  }
  switch (module) {
    case 'forgeax_material::standard':
      return 'forgeax::default-standard-pbr';
    case 'forgeax_material::unlit':
      return 'forgeax::default-unlit';
    case 'forgeax_material::sprite':
      return 'forgeax::sprite';
    case 'forgeax_material::sprite-lit':
      return 'forgeax::sprite-lit';
    default:
      return module;
  }
}

/**
 * Select the runtime identity for one resolved material. A cooked publication
 * owns the composed material artifact identity; the authored pass module is
 * the built-in fallback used before that publication is ready.
 */
export function materialProgramKeysForMaterial(
  material: MaterialAsset,
  assets: AssetRegistry,
  context: MaterialCookProgramContext | undefined,
): Readonly<Record<string, string>> | undefined {
  const projection = assets.getMaterialProjectionForPayload(material);
  if (projection === undefined) return undefined;
  if (context === undefined)
    throw new Error('Published material selection requires renderer-owned compiler context');
  return Object.fromEntries(
    projection.passes.map((pass) => {
      const mode = String(
        (pass.renderState?.tags as Record<string, unknown> | undefined)?.LightMode ?? pass.name,
      );
      const selectedContext: MaterialCookProgramContext = {
        ...context,
        pass: /shadow/i.test(mode) ? 'shadow' : /depth/i.test(mode) ? 'depth' : 'forward',
        pipeline: /deferred|gbuffer/i.test(mode) ? 'deferred' : context.pipeline,
      };
      return [
        pass.name,
        selectMaterialPassProgram(projection, pass.name, selectedContext).specializationKey,
      ];
    }),
  );
}

export function runtimeMaterialShaderIdForMaterial(
  passes: readonly MaterialPass[],
  programs: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const pass =
    passes.find(
      (pass) =>
        !/shadow|depth/i.test(
          String(
            (pass.renderState?.tags as Record<string, unknown> | undefined)?.LightMode ?? pass.name,
          ),
        ),
    ) ?? passes[0];
  if (pass === undefined) return undefined;
  return programs === undefined
    ? runtimeMaterialShaderId(pass.program.module, pass.name)
    : programs[pass.name];
}

export function pipelineRenderState(
  renderState:
    | (MaterialRenderState & {
        readonly tags?: Readonly<Record<string, string>>;
        readonly queue?: number;
        readonly stencilReference?: number;
      })
    | undefined,
): MaterialRenderState | undefined {
  if (renderState === undefined) return undefined;
  const {
    cullMode,
    depthCompare,
    depthWriteEnabled,
    blend,
    alphaToCoverageEnabled,
    stencil,
    stencilReadMask,
    stencilWriteMask,
    frontFace,
  } = renderState;
  if (
    cullMode === undefined &&
    depthCompare === undefined &&
    depthWriteEnabled === undefined &&
    blend === undefined &&
    alphaToCoverageEnabled === undefined &&
    stencil === undefined &&
    stencilReadMask === undefined &&
    stencilWriteMask === undefined &&
    frontFace === undefined
  ) {
    return undefined;
  }
  return {
    ...(cullMode !== undefined && { cullMode }),
    ...(depthCompare !== undefined && { depthCompare }),
    ...(depthWriteEnabled !== undefined && { depthWriteEnabled }),
    ...(blend !== undefined && { blend }),
    ...(alphaToCoverageEnabled !== undefined && { alphaToCoverageEnabled }),
    ...(stencil !== undefined && { stencil }),
    ...(stencilReadMask !== undefined && { stencilReadMask }),
    ...(stencilWriteMask !== undefined && { stencilWriteMask }),
    ...(frontFace !== undefined && { frontFace }),
  };
}

/**
 * tweak-20260627-model-loading-smoke-build-perf M4: per-World intern cache for
 * the loadByGuid texture/sampler resolution path. A MaterialAsset's
 * texture/sampler values remain embedded GUID strings (dash-form) after
 * loadByGuid; the extract stage re-resolves each GUID to a column handle every
 * frame. Before this cache each resolution called `world.allocSharedRef`, which
 * mints a NEW monotonically-increasing slot id per call. Because the GPU
 * residency cache (`GpuResidencyCache.textureGpuHandles`) is keyed on
 * `handleSlot(handle)`, a fresh slot every frame meant the residency check
 * ALWAYS missed -> all textures re-uploaded to the GPU every frame, old GPU
 * textures never freed (refcount never hits 0). Unbounded GPU memory +
 * unbounded per-frame upload cost (628ms -> 2764ms over 12 frames, SIGKILL).
 *
 * The fix interns the GUID-string -> column-handle resolution: each unique
 * `(guid, brand)` pair mints EXACTLY ONE stable shared handle per World, reused
 * across frames (architecture-principle §6 idempotency: same GUID resolved N
 * times yields the same handle). The handle is intentionally long-lived -- it
 * lives as long as the World references the material, which is exactly the
 * desired lifetime; the `onLastRelease` -> `gpuStore.evictTexture` wiring stays
 * coherent because the handle is no longer churned per frame.
 *
 * Invariant boundary (asset-registry.ts:1958-1962): the AssetRegistry is a
 * GUID -> payload catalogue with NO handle/World concept -- it cannot mint a
 * column handle. So this intern cache lives in the extract/render layer, keyed
 * per-World via a WeakMap (the World owns the SharedRefStore that mints slots).
 *
 * Inner key is `${lowercasedGuid}\u0000${brand}` -- a GUID catalogues to a
 * single asset kind in practice, but the brand keeps the key correct if the
 * same GUID is ever resolved under two brands.
 *
 * Cache hits are validated against the registry's current payload identity.
 * Re-cataloguing the same GUID therefore retires the cache's allocation grant
 * and mints a handle for the replacement payload. An invalidated GUID retires
 * the entry immediately instead of keeping a stale payload alive.
 */
interface GuidHandleInternEntry {
  readonly handle: number;
  readonly payload: Asset;
}

const guidHandleInternByWorld = new WeakMap<World, Map<string, GuidHandleInternEntry>>();

export function internSharedRefFromGuid<B extends string>(
  world: World,
  assetsRef: AssetRegistry,
  guid: string,
  brand: B,
): Handle<B, 'shared'> | undefined {
  let perWorld = guidHandleInternByWorld.get(world);
  if (perWorld === undefined) {
    perWorld = new Map<string, GuidHandleInternEntry>();
    guidHandleInternByWorld.set(world, perWorld);
  }
  const key = `${guid.toLowerCase()}\u0000${brand}`;
  const cached = perWorld.get(key);
  const payload = assetsRef.lookup(guid);
  if (cached !== undefined && cached.payload === payload) {
    const cachedHandle = toShared<B>(cached.handle);
    if (world.sharedRefs.resolve(cachedHandle).ok) return cachedHandle;
  }
  if (cached !== undefined) {
    world.sharedRefs.release(toShared<B>(cached.handle));
    perWorld.delete(key);
  }
  if (payload === undefined) return undefined;
  // Mint exactly once per (world, guid, brand). ECS owns the allocation grant
  // and publishes release evidence through SharedRefStore; render does not
  // attach a second deleter lifecycle to the World.
  const handle = world.internSharedRef(brand, payload);
  perWorld.set(key, { handle, payload });
  return handle;
}

/**
 * feat-20260623-world-space-video-asset M4 / w14 (D-5): if a user-region
 * texture field's paramValue is an embedded GUID string that catalogues to a
 * VideoAsset (`kind === 'video'`), mint a `VideoAsset`-branded column handle for
 * it and return that handle; otherwise return undefined (the field is a static
 * texture / sampler / scalar and flows through the normal TextureAsset path).
 *
 * The video GUID occupies the same texture2d values slot a static texture
 * would (P4: identical binding shape) — extract just routes it to a different
 * GPU lifecycle (the transient DynamicTextureStore, D-3) instead of the static
 * `ensureResident` cache, whose switch has no `video` arm (AC-08). Minting a
 * brand-`VideoAsset` handle keeps the snapshot self-describing: the record stage
 * sees a video handle and resolves the per-frame view without reaching back into
 * the asset (charter P5).
 *
 * A `number` paramValue (already a minted column handle) is not a GUID string so
 * it cannot be a freshly-catalogued video; it passes through as undefined here.
 */
export function resolveVideoFieldHandle(
  value: unknown,
  world: World,
  assetsRef: AssetRegistry,
): Handle<'VideoAsset', 'shared'> | undefined {
  const texture = materialTextureValue(value);
  const textureGuid = assetReferenceText(texture?.texture ?? value);
  if (textureGuid === undefined) return undefined;
  const payload = assetsRef.lookup(textureGuid);
  if (payload === undefined || payload.kind !== 'video') return undefined;
  // M4: intern so a video GUID mints one stable VideoAsset handle per World
  // instead of a fresh slot every frame. The transient per-frame view is
  // resolved downstream by this handle (DynamicTextureStore); minting the
  // handle once does not freeze the view (P5: handle != frame data).
  return internSharedRefFromGuid(world, assetsRef, textureGuid, 'VideoAsset');
}

export function materialTextureValue(value: unknown): MaterialTextureValue | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const textureValue = value as Partial<MaterialTextureValue>;
  return typeof textureValue.texture === 'number' ||
    typeof textureValue.texture === 'string' ||
    textureValue.texture instanceof Uint8Array
    ? (textureValue as MaterialTextureValue)
    : undefined;
}

export function assetReferenceText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array && isAssetGuidBytes(value)) return AssetGuid.format(value);
  return undefined;
}

export function isAssetGuidBytes(value: Uint8Array): value is AssetGuidBytes {
  return value.byteLength === 16;
}

export function materialNormalScale(values: Readonly<Record<string, unknown>>): number {
  for (const [field, value] of Object.entries(values)) {
    if (field !== 'normalTexture') continue;
    const scale = materialTextureValue(value)?.normalScale;
    return typeof scale === 'number' && Number.isFinite(scale) ? scale : 1;
  }
  return 1;
}

export function materialTextureRef(value: unknown): unknown {
  return materialTextureValue(value)?.texture ?? value;
}

export function collectMaterialTextureCoordinates(
  values: Readonly<Record<string, unknown>>,
): Map<string, MaterialTextureCoordinates> {
  const out = new Map<string, MaterialTextureCoordinates>();
  // Texture transforms belong to the value itself. Walking every authored
  // value keeps the route closed when Standard gains another physical map
  // without adding another renderer-side field inventory.
  for (const [field, value] of Object.entries(values)) {
    if (!field.endsWith('Texture')) continue;
    const coordinates = materialTextureValue(value)?.coordinates;
    if (coordinates !== undefined) out.set(field, coordinates);
  }
  return out;
}

export function collectMaterialTextureSources(
  values: Readonly<Record<string, unknown>>,
  world: World,
): Map<string, RenderTargetTextureSource> {
  const out = new Map<string, RenderTargetTextureSource>();
  for (const [field, value] of Object.entries(values)) {
    const reference = materialTextureRef(value);
    if (typeof reference !== 'number') continue;
    const resolved = world.sharedRefs.resolve<
      'RenderTargetTextureSource',
      RenderTargetTextureSource
    >(toShared<'RenderTargetTextureSource'>(reference));
    if (!resolved.ok || resolveRenderTargetMaterialSource(resolved.value) === undefined) continue;
    out.set(field, resolved.value);
  }
  return out;
}

export function collectMaterialTextureSamplers(
  values: Readonly<Record<string, unknown>>,
  resolveSampler: (value: unknown) => Handle<'SamplerAsset', 'shared'> | undefined,
): Map<string, Handle<'SamplerAsset', 'shared'>> {
  const out = new Map<string, Handle<'SamplerAsset', 'shared'>>();
  for (const [field, value] of Object.entries(values)) {
    const sampler = resolveSampler(materialTextureValue(value)?.sampler);
    if (sampler !== undefined) out.set(field, sampler);
  }
  const legacySampler = resolveSampler(values.sampler);
  if (legacySampler !== undefined && !out.has('baseColorTexture')) {
    out.set('baseColorTexture', legacySampler);
  }
  return out;
}

/**
 * feat-20260621-learn-render-5-5-parallax M2 / w7 (D-3): collect the
 * user-region texture handles for a material by iterating the shader's
 * `derive(paramSchema).textureFieldNames` SSOT (via
 * `AssetRegistry.materialShaderTextureFieldNames`). Each declared texture
 * field whose paramValue resolves to a handle lands in the returned map keyed
 * by field name; this is the single path through which an arbitrary number of user-region
 * textures (8 Standard or 9+ custom, e.g. parallax `heightTexture`) flow.
 *
 * When the shader is not registered the built-in Standard field set is used
 * so standard materials still resolve. Emissive and occlusion are ordinary
 * schema-driven user-region textures in that set.
 *
 * feat-20260623-world-space-video-asset M4 / w14 (D-5): a field whose paramValue
 * catalogues to a VideoAsset is routed into `videoOut` (a VideoAsset-branded
 * handle) instead of the TextureAsset map, so the record stage pulls its view
 * from the transient DynamicTextureStore (D-3) rather than the static
 * ensureResident cache (AC-08). The video GUID still has to be in this
 * `textureFieldNames` traversal set or it is never inspected (R-7) — that
 * membership is asserted in w13.
 */
export function collectUserRegionTextureHandles(
  pv: Readonly<Record<string, unknown>>,
  shaderId: string | undefined,
  paramSchema: readonly ParamSchemaEntry[] | undefined,
  assetsRef: AssetRegistry,
  world: World,
  resolveTex: (
    value: unknown,
    brand: 'TextureAsset',
  ) => Handle<'TextureAsset', 'shared'> | undefined,
  videoOut: Map<string, Handle<'VideoAsset', 'shared'>>,
): Map<string, Handle<'TextureAsset', 'shared'>> {
  const fields =
    materialTextureFields(
      shaderId,
      paramSchema !== undefined
        ? derive(paramSchema).textureFieldNames
        : shaderId !== undefined
          ? assetsRef.materialShaderTextureFieldNames(shaderId)
          : undefined,
    ) ?? BUILTIN_USER_REGION_TEXTURE_FIELDS;
  const out = new Map<string, Handle<'TextureAsset', 'shared'>>();
  for (const field of fields) {
    // D-5: a video-kind paramValue is routed to the transient path (videoOut),
    // NOT minted as a TextureAsset (which would crash the record-stage
    // ensureResident, AC-08). A static field falls through to resolveTex.
    const videoHandle = resolveVideoFieldHandle(pv[field], world, assetsRef);
    if (videoHandle !== undefined) {
      videoOut.set(field, videoHandle);
      continue;
    }
    const handle = resolveTex(materialTextureRef(pv[field]), 'TextureAsset');
    if (handle !== undefined) out.set(field, handle);
  }
  return out;
}

const ENGINE_INJECTED_TEXTURE_FIELDS = new Set(['emissiveTexture', 'occlusionTexture']);

export function isEngineInjectedTextureField(
  shaderId: string | undefined,
  fieldName: string,
): boolean {
  return isStandardPbrMaterialShader(shaderId) && ENGINE_INJECTED_TEXTURE_FIELDS.has(fieldName);
}

/**
 * Project one material's authoring parameters into the runtime ABI.
 *
 * Engine-owned Standard roots are compiled against the canonical superset
 * schema even when the authoring asset omits optional physical fields. A
 * compact authored schema would move later UBO members (for example `ior`)
 * into the wrong slots. Custom material roots keep their own published
 * parameter projection.
 */
export function materialParametersToParamSchema(
  parameters: readonly MaterialParameter[],
  shaderId?: string,
): readonly ParamSchemaEntry[] {
  if (isCanonicalStandardPbrMaterialShader(shaderId)) return STANDARD_PIPELINE_PARAM_SCHEMA;
  return projectMaterialParametersToParamSchema(parameters);
}

/**
 * Select the parameter ABI for one resolved material. The canonical Standard
 * schema is valid only for the engine-owned default Surface; a Standard root
 * with a project Surface keeps the custom fields that its cooked WGSL reads.
 */
export function materialParamSchemaForMaterial(
  parameters: readonly MaterialParameter[],
  authoredShaderId: string | undefined,
  passes: readonly MaterialPass[],
): readonly ParamSchemaEntry[] {
  const firstPass =
    passes.find(
      (pass) =>
        !/shadow|depth/i.test(
          String(
            (pass.renderState?.tags as Record<string, unknown> | undefined)?.LightMode ?? pass.name,
          ),
        ),
    ) ?? passes[0];
  const surfaceModule = firstPass?.program.moduleSlots?.surface;
  const schemaShaderId =
    surfaceModule === undefined || surfaceModule === DEFAULT_STANDARD_SURFACE_MODULE
      ? authoredShaderId
      : undefined;
  return materialParametersToParamSchema(parameters, schemaShaderId);
}

/**
 * Resolve color semantics from the material asset first and the shader schema
 * for fields the asset does not redeclare. Generated and historical pack
 * materials commonly omit `parameters`, while the shader registry still owns
 * the complete parameter contract.
 */
export function materialColorParameterSchema(
  parameters: readonly MaterialParameter[],
  shaderId: string | undefined,
  assets: AssetRegistry,
): readonly MaterialColorParameterSchema[] {
  if (shaderId === undefined) return parameters;
  const shader = assets.shaderRegistry.findMaterialArtifact(shaderId);
  if (!shader.ok) return parameters;

  const byName = new Map<string, MaterialColorParameterSchema>(
    shader.value.paramSchema.map((parameter) => [parameter.name, parameter]),
  );
  for (const parameter of parameters) byName.set(parameter.name, parameter);
  return [...byName.values()];
}

const MATERIAL_PARENT_CHAIN_LIMIT = 128;

export function isDeepFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== 'object' || value === null) return true;
  if (seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  for (const child of Object.values(value)) {
    if (!isDeepFrozen(child, seen)) return false;
  }
  return true;
}

/**
 * Capture the object identities that make a resolved material stable. The
 * renderer owns this cache, but the AssetRegistry owns parent GUID lookup, so
 * validation must walk the same chain on every cross-frame read. A malformed
 * or cyclic chain is deliberately not cacheable.
 */
export function captureMaterialCacheChain(
  root: MaterialAsset,
  assets: AssetRegistry,
): readonly MaterialCacheChainIdentity[] | undefined {
  const chain: MaterialCacheChainIdentity[] = [];
  const visitedParentGuids = new Set<string>();
  let current = root;
  for (let depth = 0; depth < MATERIAL_PARENT_CHAIN_LIMIT; depth += 1) {
    const parentRef = current.parent;
    const parentGuid = parentRef === undefined ? undefined : materialGuidText(parentRef);
    chain.push({ asset: current, parentGuid });
    if (parentGuid === undefined) return chain;
    if (parentRef === undefined) return undefined;
    if (visitedParentGuids.has(parentGuid)) return undefined;
    visitedParentGuids.add(parentGuid);
    const parent = assets.lookup<Asset>(parentRef);
    if (parent?.kind !== 'material') return undefined;
    current = parent;
  }
  return undefined;
}

export function readPersistentMaterialSnapshot(
  cache: MaterialSnapshotCache | undefined,
  handleRaw: number,
  assets: AssetRegistry,
): MaterialSnapshotCacheEntry | undefined {
  const entry = cache?.get(handleRaw);
  if (entry === undefined) return undefined;
  if (
    entry.crossFrameSafe &&
    entry.chain !== undefined &&
    entry.catalogEpoch === assets.catalogEpoch
  )
    return entry;
  // The snapshot contains resolved texture and sampler handles as well as the
  // material parent chain. Any registry mutation can replace one of those
  // referenced payloads, so an epoch mismatch is a hard miss even when the
  // material objects themselves are unchanged.
  cache?.delete(handleRaw);
  return undefined;
}

/**
 * Fast path for a cache entry whose chain was already validated at the
 * current registry epoch. The full reader needs the root asset only when an
 * epoch changed; asking ECS to resolve that root before checking the epoch
 * defeats the cross-frame cache on the ordinary stable frame.
 */
export function readStablePersistentMaterialSnapshot(
  cache: MaterialSnapshotCache | undefined,
  handleRaw: number,
  assets: AssetRegistry,
): MaterialSnapshotCacheEntry | undefined {
  const entry = cache?.get(handleRaw);
  return entry?.crossFrameSafe === true &&
    entry.chain !== undefined &&
    entry.catalogEpoch === assets.catalogEpoch
    ? entry
    : undefined;
}

export function storeMaterialSnapshot(
  cache: MaterialSnapshotCache,
  handleRaw: number,
  snapshot: MaterialSnapshot,
  passes: readonly MaterialPass[],
  root: MaterialAsset,
  assets: AssetRegistry,
): MaterialSnapshotCacheEntry {
  const chain = captureMaterialCacheChain(root, assets);
  const entry: MaterialSnapshotCacheEntry = {
    snapshot,
    passes,
    crossFrameSafe: chain?.every(({ asset }) => isDeepFrozen(asset)) === true,
    ...(chain === undefined ? {} : { chain }),
    ...(chain === undefined ? {} : { catalogEpoch: assets.catalogEpoch }),
  };
  cache.set(handleRaw, entry);
  return entry;
}

/**
 * feat-20260608 M5 amend / w11-a: resolve a single MaterialAsset handle into
 * a per-submesh MaterialSnapshot. Used by the extractFrame archetype loop to
 * build `RenderableSnapshot.materials[]` for indices >= 1 (the entity-level
 * snapshot at index 0 is built inline because it also drives multi-pass
 * DispatchEntry creation + sprite-region overrides; per-submesh secondary
 * materials are non-sprite + single-pass-equivalent for the record stage's
 * UBO upload, so this helper produces a plain MaterialSnapshot only).
 *
 * Returns `defaultMaterialSnapshot()` (mid-grey unlit) for handle=0 (case-B
 * sentinel, mirroring the inline path) and on each unresolved / non-material
 * asset (so a partially-mis-registered multi-material entity still renders
 * the resolvable submeshes; the count-mismatch validator already filtered
 * the count-disagreement case earlier).
 */
export function resolveMaterialSnapshot(
  handleRaw: number,
  world: World,
  assetsRef: AssetRegistry,
  materialSnapshotCache?: MaterialSnapshotCache,
  persistentMaterialSnapshotCache?: MaterialSnapshotCache,
  materialContext?: MaterialCookProgramContext,
): MaterialSnapshot {
  if (handleRaw === 0) return defaultMaterialSnapshot(handleRaw);
  const cached = materialSnapshotCache?.get(handleRaw);
  if (cached !== undefined) return cached.snapshot;
  const stablePersistentCached = readStablePersistentMaterialSnapshot(
    persistentMaterialSnapshotCache,
    handleRaw,
    assetsRef,
  );
  if (stablePersistentCached !== undefined) {
    materialSnapshotCache?.set(handleRaw, stablePersistentCached);
    return stablePersistentCached.snapshot;
  }
  const tagged = toShared<'MaterialAsset'>(handleRaw);
  const res = resolveAssetHandle(world, tagged);
  if (!res.ok) return defaultMaterialSnapshot(handleRaw);
  const asset = res.value;
  if (asset.kind !== 'material') return defaultMaterialSnapshot(handleRaw);
  const persistentCached = readPersistentMaterialSnapshot(
    persistentMaterialSnapshotCache,
    handleRaw,
    assetsRef,
  );
  if (persistentCached !== undefined) {
    materialSnapshotCache?.set(handleRaw, persistentCached);
    return persistentCached.snapshot;
  }
  const resolvedResult = walkMaterialPassesOverSharedRefs(world, tagged, assetsRef);
  if (!resolvedResult.ok) return defaultMaterialSnapshot(handleRaw);
  const resolved = resolvedResult.value;
  const allPasses = resolved.passes;
  const materialProgramKeys = materialProgramKeysForMaterial(asset, assetsRef, materialContext);
  const authoredFirstPassShader = runtimeMaterialShaderIdForMaterial(allPasses, undefined);
  const firstPassShader = runtimeMaterialShaderIdForMaterial(allPasses, materialProgramKeys);
  const pv = materialValuesToLinearRuntime(
    resolved.values,
    materialColorParameterSchema(resolved.parameters ?? [], firstPassShader, assetsRef),
    resolved.colorSpace,
  ) as Readonly<Record<string, unknown>>;
  const baseColorPv = pv.baseColor as readonly number[] | undefined;
  const baseColor = vec3.create(
    baseColorPv?.[0] ?? 1,
    baseColorPv?.[1] ?? 1,
    baseColorPv?.[2] ?? 1,
  );
  const metallicPv = typeof pv.metallic === 'number' ? pv.metallic : 0;
  const roughnessPv = typeof pv.roughness === 'number' ? pv.roughness : 0.5;
  const specularColorPv = pv.specularColor as readonly number[] | undefined;
  const normalScalePv = materialNormalScale(pv);

  const paramSnap: Record<string, number | number[] | string> = {};
  for (const [k, v] of Object.entries(pv)) {
    if (typeof v === 'number') paramSnap[k] = v;
    else if (typeof v === 'string') paramSnap[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'number')) {
      paramSnap[k] = v as number[];
    }
  }
  const materialParamSchema = materialParamSchemaForMaterial(
    resolved.parameters ?? [],
    authoredFirstPassShader,
    allPasses,
  );
  // feat-20260614 M8 (D-19): texture / sampler values are embedded GUIDs
  // (dash-form strings) after loadByGuid. Resolve each to a user-tier column
  // handle by looking up the catalogued payload and minting via
  // world.allocSharedRef; a numeric value (already a column handle from a
  // directly-minted material) passes through unchanged.
  const resolveTexLike = <B extends string>(
    value: unknown,
    brand: B,
  ): Handle<B, 'shared'> | undefined => {
    if (typeof value === 'number') return toShared<B>(value);
    if (typeof value === 'string') {
      // M4: intern the GUID -> column-handle resolution so each unique
      // (world, guid, brand) mints exactly ONE stable handle reused across
      // frames (stops the per-frame slot churn that defeated the GPU
      // residency cache). feat-20260619 M2 / w8: TextureAsset brand wires
      // onLastRelease -> gpuStore.evictTexture; other brands (SamplerAsset)
      // bypass (releaseUnreferenced-fallback lifecycle).
      return internSharedRefFromGuid(world, assetsRef, value, brand);
    }
    return undefined;
  };
  // feat-20260621-learn-render-5-5-parallax M2 / w7 (D-3): iterate the
  // shader's derive(paramSchema).textureFieldNames SSOT instead of a hardcoded
  // user-region field list, so an Nth texture (e.g. parallax heightTexture)
  // resolves through the same path, including emissive/occlusion fields.
  const videoTextureFields = new Map<string, Handle<'VideoAsset', 'shared'>>();
  const textureHandles = collectUserRegionTextureHandles(
    pv,
    firstPassShader,
    materialParamSchema.length > 0 ? materialParamSchema : undefined,
    assetsRef,
    world,
    resolveTexLike,
    videoTextureFields,
  );
  const samplerHandles = collectMaterialTextureSamplers(pv, (value) =>
    resolveTexLike(materialTextureRef(value), 'SamplerAsset'),
  );
  const textureSources = collectMaterialTextureSources(pv, world);
  const emissiveTextureHandle = resolveTexLike(
    materialTextureRef(pv.emissiveTexture),
    'TextureAsset',
  );
  const occlusionTextureHandle = resolveTexLike(
    materialTextureRef(pv.occlusionTexture),
    'TextureAsset',
  );
  const textureCoordinates = collectMaterialTextureCoordinates(pv);
  // Named user-region fields are derived from the map (sprite + legacy reads).
  const baseColorTextureHandle = textureHandles.get('baseColorTexture');
  const metallicRoughnessTextureHandle = textureHandles.get('metallicRoughnessTexture');
  const normalTextureHandle = textureHandles.get('normalTexture');
  const emissivePv = pv.emissive as readonly number[] | undefined;
  const snapshot: MaterialSnapshot = {
    baseColor,
    metallic: metallicPv,
    roughness: roughnessPv,
    ...(specularColorPv !== undefined && {
      specularColor: [
        specularColorPv[0] ?? 1,
        specularColorPv[1] ?? 1,
        specularColorPv[2] ?? 1,
      ] as readonly [number, number, number],
    }),
    normalScale: normalScalePv,
    materialShaderId: firstPassShader,
    materialProgramKeys,
    materialHandle: handleRaw,
    renderState: pipelineRenderState(allPasses[0]?.renderState),
    paramSnapshot: paramSnap,
    ...(materialParamSchema.length > 0 && { materialParamSchema }),
    ...(textureCoordinates.size > 0 && { textureCoordinates }),
    ...(textureHandles.size > 0 && { textureHandles }),
    ...(textureSources.size > 0 && { textureSources }),
    ...(videoTextureFields.size > 0 && { videoTextureFields }),
    ...(samplerHandles.size > 0 && { samplerHandles }),
    ...(baseColorTextureHandle !== undefined && { baseColorTexture: baseColorTextureHandle }),
    ...(metallicRoughnessTextureHandle !== undefined && {
      metallicRoughnessTexture: metallicRoughnessTextureHandle,
    }),
    ...(normalTextureHandle !== undefined && { normalTexture: normalTextureHandle }),
    ...(emissivePv !== undefined && {
      emissive: [emissivePv[0] ?? 0, emissivePv[1] ?? 0, emissivePv[2] ?? 0] as readonly [
        number,
        number,
        number,
      ],
    }),
    ...(typeof pv.emissiveIntensity === 'number' && { emissiveIntensity: pv.emissiveIntensity }),
    ...(emissiveTextureHandle !== undefined && { emissiveTexture: emissiveTextureHandle }),
    ...(occlusionTextureHandle !== undefined && { occlusionTexture: occlusionTextureHandle }),
    ...(typeof pv.occlusionStrength === 'number' && { occlusionStrength: pv.occlusionStrength }),
    // feat-city-glb Bug 5 (per-submesh transparency): derive `transparent`
    // from the first pass's `renderState.blend` presence, identical to the
    // entity-level snapshot builder (extractFrame archetype loop). Without
    // this, per-submesh materials (materials[i>=1], e.g. a glTF BLEND decal
    // submesh on a multi-material mesh) never carry the transparent flag, so
    // the record stage's LDR split + blend routing treats them as opaque and
    // their alpha=0 texels composite as black.
    transparent: allPasses[0]?.renderState?.blend !== undefined,
  };
  const stored =
    materialSnapshotCache !== undefined
      ? storeMaterialSnapshot(
          materialSnapshotCache,
          handleRaw,
          snapshot,
          allPasses,
          asset,
          assetsRef,
        )
      : undefined;
  const cacheEntry =
    stored ??
    (persistentMaterialSnapshotCache !== undefined
      ? storeMaterialSnapshot(
          persistentMaterialSnapshotCache,
          handleRaw,
          snapshot,
          allPasses,
          asset,
          assetsRef,
        )
      : undefined);
  if (cacheEntry?.crossFrameSafe === true) {
    persistentMaterialSnapshotCache?.set(handleRaw, cacheEntry);
  }
  return snapshot;
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
 * PSSM (Parallel-Split Shadow Maps) split plane computation.
 *
 * Formula (plan-strategy D-8, research F1):
 *   C_i = λ·n·(f/n)^(i/m) + (1-λ)·(n + i/m·(f-n))
 *   where i = 1..m, n = near, f = far, m = cascadeCount
 *
 * The coverage range is [camera near, DirectionalLight.shadowDistance] — the
 * near end derives from the active camera, the far end is the shadowDistance
 * knob. Returns strictly monotonic view-space z depths (positive).
 *
 * When `far <= near + ε` (ε=1e-6), throws ShadowInvalidConfigError
 * (charter P3 explicit failure — research F2 guarantees formula stability
 * but degenerate configuration must be surfaced to the caller).
 *
 * @param nearPlane - near of the shadow casting range (from the camera near)
 * @param farPlane - far of the shadow casting range (DirectionalLight.shadowDistance)
 * @param cascadeCount - number of cascades (1..4)
 * @param splitLambda - PSSM split weight (0 = pure uniform, 1 = pure log)
 * @returns Array of m split depths (view-space z); length = cascadeCount,
 *   guaranteed strictly monotonic, last element = far.
 *
 * @internal exported for w6/w7 testing only; production callers route through
 *   extractFrame which validates cascadeCount/splitLambda via component schema.
 */
/**
 * Compute the 8 world-space corner points of a camera frustum slice.
 *
 * Uses mat4.unproject to map NDC cube corners back to world space.
 * The slice is defined by view-space nearZ and farZ depths.
 *
 * For a WebGPU perspective matrix, ndcZ(viewZ) = camFar * (viewZ - camNear) /
 * (viewZ * (camFar - camNear)). We compute the ndcZ for each slice boundary
 * and unproject directly.
 *
 * @param vp - camera view-projection matrix (column-major 16 floats)
 * @param camNear - camera near plane (used to derive NDC mapping)
 * @param camFar - camera far plane (used to derive NDC mapping)
 * @param nearZ - near depth of the frustum slice (view-space, positive)
 * @param farZ - far depth of the frustum slice (view-space, positive)
 * @returns Array of 8 Vec3 world-space corner positions.
 */
function computeFrustumCorners(
  vp: Mat4,
  camNear: number,
  camFar: number,
  nearZ: number,
  farZ: number,
  projection: 'perspective' | 'orthographic',
): Vec3[] {
  const invVP = mat4.create();
  mat4.invert(invVP, vp);
  const corners: Vec3[] = [];

  // NDC z mapping is projection-dependent (WebGPU clip-space z in [0,1]):
  //   perspective:  ndc(z) = camFar * (z - camNear) / (z * (camFar - camNear))
  //   orthographic: ndc(z) = (z - camNear) / (camFar - camNear)
  // feat-20260613-csm M6 / w22: orthographic cameras silently produced
  // garbage NDC z (perspective formula divides by viewZ, but ortho NDC is
  // linear), which mapped the cascade slab back to a degenerate world-space
  // corner set and the AABB-fit collapsed to near zero -- shadow_caster
  // wrote its triangles outside the [-1,1] clip volume so the depth
  // attachment stayed at clear=1.0 (root cause for shadow-m2 / shadow-m3 /
  // shadow-opt-out dawn red surfaced after w20's host-side ortho fix).
  const span = camFar - camNear;
  const ndcNear =
    projection === 'orthographic'
      ? (nearZ - camNear) / span
      : (camFar * (nearZ - camNear)) / (nearZ * span);
  const ndcFar =
    projection === 'orthographic'
      ? (farZ - camNear) / span
      : (camFar * (farZ - camNear)) / (farZ * span);

  const signs = [-1, 1];
  for (const sx of signs) {
    for (const sy of signs) {
      corners.push(unprojectNDC(invVP, sx, sy, ndcNear));
    }
  }
  for (const sx of signs) {
    for (const sy of signs) {
      corners.push(unprojectNDC(invVP, sx, sy, ndcFar));
    }
  }

  return corners;
}

/**
 * Unproject a single NDC point to world space.
 */
function unprojectNDC(invVP: Mat4, ndcX: number, ndcY: number, ndcZ: number): Vec3 {
  const ndc = vec3.create(ndcX, ndcY, ndcZ);
  const ws = vec3.create();
  mat4.unproject(ws, ndc, invVP);
  return ws;
}

export function pssmSplit(
  nearPlane: number,
  farPlane: number,
  cascadeCount: number,
  splitLambda: number,
): Float32Array {
  const EPS = 1e-6;
  if (farPlane <= nearPlane + EPS) {
    throw new ShadowInvalidConfigError('shadowDistance', farPlane, nearPlane + EPS);
  }

  const result = new Float32Array(cascadeCount);
  const m = cascadeCount;
  const n = nearPlane;
  const f = farPlane;
  const ratio = f / n;

  for (let i = 1; i <= m; i++) {
    const t = i / m;
    const logPart = n * ratio ** t;
    const uniformPart = n + t * (f - n);
    result[i - 1] = splitLambda * logPart + (1 - splitLambda) * uniformPart;
  }

  return result;
}

// feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-5 (plan-strategy §D-3,
// requirements §5.3): 6-face view-proj matrix table for one omnidirectional
// shadow caster.
//
// Face order matches WebGPU cube layer convention (also LearnOpenGL 5.3.2):
//   0 (+X) | look=(+1, 0, 0) | up=(0, -1, 0)
//   1 (-X) | look=(-1, 0, 0) | up=(0, -1, 0)
//   2 (+Y) | look=(0, +1, 0) | up=(0,  0, +1)
//   3 (-Y) | look=(0, -1, 0) | up=(0,  0, -1)
//   4 (+Z) | look=(0, 0, +1) | up=(0, -1, 0)
//   5 (-Z) | look=(0, 0, -1) | up=(0, -1, 0)
//
// Projection: WebGPU [0, 1] NDC perspective (mat4.perspective short name).
// fov=90deg, aspect=1, near/far from PointLightShadow component.
const POINT_SHADOW_FACE_LOOK: readonly Vec3[] = [
  vec3.create(1, 0, 0),
  vec3.create(-1, 0, 0),
  vec3.create(0, 1, 0),
  vec3.create(0, -1, 0),
  vec3.create(0, 0, 1),
  vec3.create(0, 0, -1),
];
const POINT_SHADOW_FACE_UP: readonly Vec3[] = [
  vec3.create(0, -1, 0),
  vec3.create(0, -1, 0),
  vec3.create(0, 0, 1),
  vec3.create(0, 0, -1),
  vec3.create(0, -1, 0),
  vec3.create(0, -1, 0),
];

/**
 * Build 6 face view-proj matrices for an omnidirectional shadow caster
 * (point-light cube map). Returns 6 mat4 (column-major 16-float each) in face
 * order [+X, -X, +Y, -Y, +Z, -Z] matching WebGPU cube layer convention.
 *
 * Each matrix is `proj * view` where:
 *   - `view = lookAt(lightPos, lightPos + faceLook[i], faceUp[i])`
 *   - `proj = perspective(PI/2, 1, near, far)` (WebGPU [0, 1] NDC short name)
 *
 * The returned `Mat4[]` length is always exactly 6. Caller can flatten into a
 * 96-float (6 mat4) Float32Array for UBO upload (T-M1-7).
 *
 * @param lightPos world-space position of the point light (from companion Transform)
 * @param near near plane distance (PointLightShadow.nearPlane)
 * @param far  far plane distance  (PointLightShadow.farPlane)
 */
export function buildPointShadowMatrices(lightPos: Vec3, near: number, far: number): Mat4[] {
  const fovY = Math.PI / 2; // 90 deg
  const aspect = 1;
  const proj = mat4.create();
  mat4.perspective(proj, fovY, aspect, near, far);

  const out: Mat4[] = [];
  for (let i = 0; i < 6; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i in [0..6) and arrays are length-6 const
    const look = POINT_SHADOW_FACE_LOOK[i]!;
    // biome-ignore lint/style/noNonNullAssertion: i in [0..6) and arrays are length-6 const
    const up = POINT_SHADOW_FACE_UP[i]!;
    const target = vec3.create(
      (lightPos[0] ?? 0) + (look[0] ?? 0),
      (lightPos[1] ?? 0) + (look[1] ?? 0),
      (lightPos[2] ?? 0) + (look[2] ?? 0),
    );
    const view = mat4.create();
    mat4.lookAt(view, lightPos, target, up);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    out.push(vp);
  }
  return out;
}

/**
 * bug-20260710-editor-cross-world-shadow: the camera-frustum subset of
 * {@link CameraSnapshot} that the directional-CSM matrix builder consumes.
 * Extracted so the builder can run both inside {@link extractFrame} (single
 * world) AND at the {@link extractFrames} merge layer, where the camera and the
 * directional light may originate in DIFFERENT worlds (the editor
 * editorWorld/sceneWorld super-composite). A cameraless world produces zero
 * lightViewProj matrices, so the merge layer MUST recompute using the surfaced
 * camera — see {@link computeDirectionalCsm}.
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
 * bug-20260710-editor-cross-world-shadow: pure directional-CSM matrix builder,
 * extracted verbatim from the former inline block in {@link extractFrame} (the
 * PSSM split + per-cascade frustum-slice AABB fit + orthographic light
 * projection). It is now a free function so BOTH the per-world extract and the
 * cross-world merge layer can call it — the merge layer is the only place that
 * pairs the first-hit directional light of one world with the surfaced camera
 * of another (editor super-composite). Returns `null` when there is no camera
 * to fit against (a cameraless world's directional light yields no matrices —
 * the caller leaves lightViewProj undefined rather than emitting zero matrices
 * that the WGSL reader would sample as NaN → "fully lit").
 *
 * Byte-identical to the prior inline computation for the single-world case
 * (same PSSM lambda, same toward-light Z reach RC-2 fix, same clip-space
 * matrix / tile-placement-in-shader split).
 */
export function computeDirectionalCsm(
  direction: Vec3,
  config: DirectionalCsmConfig,
  cameraData: CsmCameraData | undefined,
): DirectionalCsmResult | null {
  const cascadeCount = Math.round(config.cascadeCount);
  // Coverage range: near from the active camera near (no separate near knob);
  // far is the component's shadowDistance. Fallback near (0.1) only when no
  // camera exists — but matrices are gated on cameraData below anyway.
  const sNear = cameraData?.near ?? 0.1;
  const sFar = config.shadowDistance;

  // PSSM split planes: [camera near, shadowDistance], not the camera far.
  const splits = pssmSplit(sNear, sFar, cascadeCount, config.splitLambda);
  // Light view matrix: camera at origin, looking along the light direction.
  const lightDirN = vec3.normalize(vec3.create(), direction);
  const lightTarget = vec3.create(lightDirN[0] ?? 0, lightDirN[1] ?? 0, lightDirN[2] ?? 0);
  const lightView = mat4.create();
  mat4.lookAt(lightView, vec3.create(0, 0, 0), lightTarget, vec3.create(0, 1, 0));

  // Camera view-projection for frustum-corner computation. Without a camera the
  // frustum cannot be fit — bail so the caller emits no matrices (undefined),
  // NOT zero matrices (which read as NaN in the shadow shader → no shadow).
  if (cameraData === undefined) return null;
  const camProj = mat4.create();
  if (cameraData.projection === 'orthographic') {
    mat4.orthographic(
      camProj,
      cameraData.orthoLeft,
      cameraData.orthoRight,
      cameraData.orthoTop,
      cameraData.orthoBottom,
      cameraData.near,
      cameraData.far,
    );
  } else {
    mat4.perspective(camProj, cameraData.fov, cameraData.aspect, cameraData.near, cameraData.far);
  }
  const camView = mat4.create();
  mat4.invert(camView, cameraData.world);
  const cameraVP = mat4.create();
  mat4.multiply(cameraVP, camProj, camView);

  const resultLightViewProjs: Float32Array[] = [];
  const cascadeFits: DirectionalShadowCascadeFit[] = [];

  // bug-20260619 RC-2 (AC-05): toward-light Z reach. Extend the near (toward-
  // light) bound of EVERY cascade to the toward-light extreme of the WHOLE
  // shadow frustum (sNear..sFar) so casters between the light and a slice are
  // admitted; X/Y stays per-cascade tight. Larger light-space z == closer to
  // the light (lookAt forward = eye-target), so the full-frustum max-z is the
  // toward-light reach used as -maxZ (the ortho near plane) per cascade.
  let lightSpaceMaxZFull = -Infinity;
  const fullCorners = computeFrustumCorners(
    cameraVP,
    cameraData.near,
    cameraData.far,
    sNear,
    sFar,
    cameraData.projection,
  );
  for (const ws of fullCorners) {
    const ls = vec3.create();
    mat4.transformVec3(ls, lightView, ws);
    if ((ls[2] ?? 0) > lightSpaceMaxZFull) lightSpaceMaxZFull = ls[2] ?? 0;
  }

  // Pre-allocate 4-cascade array; fill in the effective cascades.
  for (let cIdx = 0; cIdx < 4; cIdx++) {
    if (cIdx >= cascadeCount) {
      resultLightViewProjs.push(new Float32Array(16));
      continue;
    }
    const cascadeNear = cIdx === 0 ? sNear : (splits[cIdx - 1] ?? sFar);
    const cascadeFar = splits[cIdx] ?? sFar;
    const corners = computeFrustumCorners(
      cameraVP,
      cameraData.near,
      cameraData.far,
      cascadeNear,
      cascadeFar,
      cameraData.projection,
    );
    const lightMVP = mat4.clone(lightView);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const ws of corners) {
      const ls = vec3.create();
      mat4.transformVec3(ls, lightMVP, ws);
      if ((ls[0] ?? 0) < minX) minX = ls[0] ?? 0;
      if ((ls[0] ?? 0) > maxX) maxX = ls[0] ?? 0;
      if ((ls[1] ?? 0) < minY) minY = ls[1] ?? 0;
      if ((ls[1] ?? 0) > maxY) maxY = ls[1] ?? 0;
      if ((ls[2] ?? 0) < minZ) minZ = ls[2] ?? 0;
      if ((ls[2] ?? 0) > maxZ) maxZ = ls[2] ?? 0;
    }
    // Orthographic projection from light-space AABB. RC-2: whole-frustum
    // toward-light extreme for the near bound; per-cascade far (minZ) + X/Y.
    const nearZ = Math.max(maxZ, lightSpaceMaxZFull);
    const orthoProj = mat4.create();
    mat4.orthographic(orthoProj, minX, maxX, maxY, minY, -nearZ, -minZ);
    // lightViewProj = orthoProj * lightView — pure clip-space [-1,1]. Atlas
    // tile placement is handled by the per-cascade viewport + fragment-side UV
    // math (evalDirectional), so shadow_caster.gl_Position stays clip-space.
    cascadeFits.push({
      split: splits[cIdx] ?? sFar,
      minX,
      maxX,
      minY,
      maxY,
      minZ,
      maxZ,
    });
    resultLightViewProjs.push(new Float32Array(mat4.multiply(mat4.create(), orthoProj, lightView)));
  }

  const projection = projectDirectionalShadow(
    cascadeFits,
    config.mapSize,
    config.shadowFilter ?? 2,
    config.shadowAngularRadius ?? 0.00465,
    config.maxPenumbraTexels ?? 32,
  );
  if (projection === undefined) return null;

  return {
    lightViewProj: resultLightViewProjs,
    splitPlanes: projection.splitPlanes,
    cascadeCount,
    cascadeBlend: config.cascadeBlend,
    shadowMapSize: config.mapSize,
    directionalShadowQuality: projection.directionalShadowQuality,
  };
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
  readonly renderables: 'full' | 'none';
  /** Restrict renderable extraction to these entities while still reading frame resources. */
  readonly renderableEntities: ReadonlySet<number> | undefined;
  /** Keep authored-hidden renderables in the persistent source projection. */
  readonly retainHidden: boolean;
  readonly visibility: VisibilitySnapshot;
  /** Producer-owned artifact lookup; extraction only, never record-time asset reads. */
  readonly getMaterialShaderArtifact:
    | ((materialShaderId: string) => MaterialShaderArtifact | undefined)
    | undefined;
  /** Renderer-owned canonical source for explicit large instance collections. */
  readonly instanceCollections: InstanceProjectionStore | undefined;
}

const ALL_VISIBLE: VisibilitySnapshot = {
  diagnostics: [],
  hasAnyIntent: false,
  hasAnyHiddenIntent: false,
  get: () => undefined,
  effective: () => 'visible',
};

function collectCameraSnapshots(world: World): CameraSnapshot[] {
  const worldInternal = createWorldInternalView(world);
  const cameras: CameraSnapshot[] = [];
  const cameraQuery = world
    .query({ read: [Camera], optional: [MotionBlur], with: [Transform, GlobalTransform] })
    .unwrap();
  for (const row of cameraQuery) {
    const cam = row.get(Camera);
    const motionBlur = row.get(MotionBlur);
    const entity = row.entity;
    const view = worldInternal._getArrayView(entity, GlobalTransform, 'world');
    if (view === undefined) continue;
    const worldMat = new Float32Array(view);
    const target = resolveCameraTarget(world, cam.target);
    cameras.push({
      entityKey: entity as number,
      ...(target === undefined ? {} : { target }),
      historyVersion: cam.historyVersion,
      position: mat4.getTranslation(vec3.create(), worldMat),
      world: worldMat,
      fov: cam.fov,
      aspect: cam.aspect,
      near: cam.near,
      far: cam.far,
      projection: cameraProjectionFromF32(cam.projection),
      orthoLeft: cam.left,
      orthoRight: cam.right,
      orthoBottom: cam.bottom,
      orthoTop: cam.top,
      tonemap: tonemapFromF32(cam.tonemap),
      exposure: cam.exposure,
      whitePoint: cam.whitePoint,
      antialias: antialiasFromF32(cam.antialias),
      bloom: bloomEnabledFromF32(cam.bloom),
      bloomThreshold: cam.bloomThreshold,
      bloomIntensity: cam.bloomIntensity,
      bloomBlurRadius: cam.bloomBlurRadius,
      clearColor: [
        cam.clearColor[0] ?? 0,
        cam.clearColor[1] ?? 0,
        cam.clearColor[2] ?? 0,
        cam.clearColor[3] ?? 1,
      ],
      ...(motionBlur === undefined
        ? {}
        : {
            motionBlur: {
              shutterAngle: motionBlur.shutterAngle,
              maxRadiusPixels: motionBlur.maxRadiusPixels,
              sampleCount: motionBlur.sampleCount,
            },
          }),
    });
  }
  return cameras;
}

export function collectCubeCameraSnapshots(world: World): CubeCameraSnapshot[] {
  const worldInternal = createWorldInternalView(world);
  const snapshots: CubeCameraSnapshot[] = [];
  const query = world.query({ read: [CubeCamera], with: [Transform, GlobalTransform] }).unwrap();
  for (const row of query) {
    const camera = row.get(CubeCamera);
    const target = resolveCameraTarget(world, camera.target);
    if (target === undefined) continue;
    const view = worldInternal._getArrayView(row.entity, GlobalTransform, 'world');
    if (view === undefined) continue;
    snapshots.push({
      entityKey: row.entity as number,
      target,
      position: [view[12] ?? 0, view[13] ?? 0, view[14] ?? 0],
      near: camera.near,
      far: camera.far,
      updateIntent: cubeCameraUpdateIntentFromF32(camera.updateIntent),
      requestVersion: camera.requestVersion,
      faceBudget: camera.faceBudget,
    });
  }
  return snapshots;
}

export function collectReflectionProbeFacts(world: World): ReflectionProbeFact[] {
  const worldInternal = createWorldInternalView(world);
  const facts: ReflectionProbeFact[] = [];
  const query = world
    .query({ read: [ReflectionProbe], with: [Transform, GlobalTransform] })
    .unwrap();
  for (const row of query) {
    const probe = row.get(ReflectionProbe);
    const view = worldInternal._getArrayView(row.entity, GlobalTransform, 'world');
    if (view === undefined) {
      continue;
    }
    facts.push({
      worldId: 0,
      entityKey: row.entity as number,
      center: [view[12] ?? 0, view[13] ?? 0, view[14] ?? 0],
      halfExtents: [
        probe.halfExtents[0] ?? 0,
        probe.halfExtents[1] ?? 0,
        probe.halfExtents[2] ?? 0,
      ],
      priority: probe.priority,
      intensity: probe.intensity,
      resolution: probe.resolution,
      revision: probe.invalidationVersion,
      updateIntent: reflectionProbeUpdateIntentFromF32(probe.updateIntent),
      invalidationVersion: probe.invalidationVersion,
    });
  }
  return facts;
}

interface CameraRoleSelection {
  readonly display: readonly CameraSnapshot[];
  readonly auxiliary: readonly CameraSnapshot[];
}

export function selectCameraRoles(world: World): CameraRoleSelection {
  const cameras = collectCameraSnapshots(world);
  const displayEntities = cameras
    .filter((camera) => camera.target === undefined)
    .map((camera) => camera.entityKey ?? 0);
  const activeCameraIndex = selectActiveCameraIndex(
    displayEntities,
    getActiveCamera(world)?.entity,
  );
  const displayEntityKey = displayEntities[activeCameraIndex] ?? displayEntities[0];
  const display =
    displayEntityKey === undefined
      ? []
      : cameras.filter((camera) => camera.entityKey === displayEntityKey);
  const candidates: CameraTargetCandidate[] = cameras.map((camera) => ({
    worldId: 0,
    entityKey: camera.entityKey ?? 0,
    ...(camera.target === undefined ? {} : { target: camera.target }),
    requestVersion: 0,
    update: 'continuous',
  }));
  const selected = selectCameraTargetViews(candidates, {
    ...(displayEntityKey === undefined ? {} : { displayEntityKey }),
    budget: 1,
  });
  const auxiliary = selected.auxiliary.flatMap((candidate) =>
    cameras.filter((camera) => camera.entityKey === candidate.entityKey),
  );
  return { display, auxiliary };
}

export function extractCameraSnapshots(world: World): CameraSnapshot[] {
  return [...selectCameraRoles(world).display];
}

export function extractCameraTargetSnapshots(world: World): readonly CameraSnapshot[] {
  return selectCameraRoles(world).auxiliary;
}

export function tonemapParams(camera: CameraSnapshot): Uint8Array {
  const bytes = new ArrayBuffer(16);
  const floats = new Float32Array(bytes);
  const integers = new Uint32Array(bytes);
  floats[0] = camera.exposure;
  floats[1] = camera.whitePoint;
  integers[2] = tonemapToU32(camera.tonemap);
  return new Uint8Array(bytes);
}

export function prepareExtractContext(
  world: World,
  options: {
    readonly materialContext?: MaterialCookProgramContext;
    readonly assets?: AssetRegistry | null;
    readonly pipelineState?: ExtractPipelineSurface | null;
    readonly materialSnapshotCache?: MaterialSnapshotCache;
    readonly resourceOwnerFog?: FogFrame | null;
    readonly cull?: 'self' | 'none' | 'external';
    readonly cullCameras?: readonly CameraSnapshot[];
    readonly renderables?: 'full' | 'none';
    readonly renderableEntities?: ReadonlySet<number>;
    readonly retainHidden?: boolean;
    readonly getMaterialShaderArtifact?: (
      materialShaderId: string,
    ) => MaterialShaderArtifact | undefined;
    readonly instanceCollections?: InstanceProjectionStore;
  } = {},
): PreparedExtractContext {
  const renderables = options.renderables ?? 'full';
  return {
    materialContext: options.materialContext,
    assets: options.assets,
    pipelineState: options.pipelineState,
    materialSnapshotCache: options.materialSnapshotCache,
    resourceOwnerFog: options.resourceOwnerFog,
    cull: options.cull ?? 'self',
    cullCameras: options.cullCameras,
    renderables,
    renderableEntities: options.renderableEntities,
    retainHidden: options.retainHidden ?? false,
    visibility: renderables === 'none' ? ALL_VISIBLE : resolveVisibility(world),
    getMaterialShaderArtifact: options.getMaterialShaderArtifact,
    instanceCollections: options.instanceCollections,
  };
}

const fogQueries = new WeakMap<World, Query<readonly [typeof Fog]>>();
const fogLkgStates = new WeakMap<
  World,
  { lkg: FogFrame | undefined; failure: FogSelectionFailure | undefined }
>();

export function fogState(world: World): {
  lkg: FogFrame | undefined;
  failure: FogSelectionFailure | undefined;
} {
  const existing = fogLkgStates.get(world);
  if (existing !== undefined) return existing;
  const created = { lkg: undefined, failure: undefined };
  fogLkgStates.set(world, created);
  return created;
}

export function selectFogFrame(world: World): FogFrame | undefined {
  // Query compilation is owned once per World; Query refreshes its matched
  // tables when the ECS structure changes, while iteration reads current Fog
  // values. This keeps the frame boundary free of repeated descriptor work.
  const fogCandidates: FogCandidate[] = [];
  let fogQuery = fogQueries.get(world);
  if (fogQuery === undefined) {
    fogQuery = world.query({ read: [Fog] }).unwrap();
    fogQueries.set(world, fogQuery);
  }
  for (const row of fogQuery) {
    const value = row.get(Fog);
    fogCandidates.push({
      entityKey: row.entity,
      color: [value.color[0] ?? 0, value.color[1] ?? 0, value.color[2] ?? 0],
      density: value.density,
      heightFalloff: value.heightFalloff,
      maxOpacity: value.maxOpacity,
    });
  }
  const fogSelection = selectEnvironment({
    environments: [],
    fogs: fogCandidates,
    suns: [],
    lane: 'direct',
  });
  const state = fogState(world);
  if (fogSelection.ok) {
    state.lkg = fogSelection.value.fog;
    state.failure = undefined;
    return fogSelection.value.fog;
  }
  state.failure = {
    code: fogSelection.error.code,
    expected: fogSelection.error.expected,
    hint: fogSelection.error.hint,
    detail: Object.freeze({ ...fogSelection.error.detail }),
  };
  routeWorldError(world, fogSelection.error, {
    systemName: 'RenderSystem.extract (fog-selection)',
  });
  if (state.lkg !== undefined) return state.lkg;
  throw fogSelection.error;
}

export function textureDigest(texture: TextureAsset): string {
  // The render inspection needs a stable identity token, not a second byte
  // store.  FNV-1a is deterministic, synchronous, and deliberately labelled
  // as a non-cryptographic digest so it cannot be mistaken for Catalog proof.
  let hash = 2166136261;
  for (const byte of texture.data) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return `fnv1a:${hash.toString(16).padStart(8, '0')}`;
}

export function extractVolumeSnapshot(
  world: World,
  assets: AssetRegistry | null | undefined,
  worldInternal: WorldInternalView,
): ExtractedVolumetricFog | undefined {
  const query = world.query({ read: [VolumetricFog] }).unwrap();
  const authorings: VolumetricFogAuthoring[] = [];
  let selectedLight:
    | {
        readonly entity: EntityHandle;
        readonly kind: 'directional' | 'point' | 'spot';
        readonly pointLightEntity?: EntityHandle;
        readonly spotLightEntity?: EntityHandle;
      }
    | undefined;
  let first:
    | {
        readonly densityHandle: Handle<'TextureAsset', 'shared'>;
        readonly densityAsset: TextureAsset;
        readonly guid: string;
      }
    | undefined;

  for (const row of query) {
    const source = row.get(VolumetricFog);
    if (source.light === null) continue;
    const selected = resolveSelectedVolumetricLight(world, source.light);
    if (selected.status === 'available') {
      const pairSpot = source.spotLight === null ? undefined : source.spotLight;
      selectedLight ??= {
        entity: selected.entity,
        kind: selected.kind,
        ...(selected.kind === 'point' ? { pointLightEntity: selected.entity } : {}),
        ...(pairSpot === undefined ? {} : { spotLightEntity: pairSpot }),
      };
    }
    const densityHandle = toShared<'TextureAsset'>(Math.round(Number(source.density)));
    const resolved = resolveAssetHandle<TextureAsset>(world, densityHandle);
    if (!resolved.ok || resolved.value.kind !== 'texture') {
      worldInternal._routeError(
        resolved.ok
          ? new RhiError({
              code: 'asset-not-registered',
              expected: 'VolumetricFog.density resolves to a TextureAsset',
              hint: 'load a TextureAsset before assigning it to VolumetricFog.density',
              detail: { assetHandle: Number(densityHandle) },
            })
          : resolved.error,
        { severity: Severity.Error, systemName: 'RenderSystem.extract (volumetric-density)' },
      );
      return { status: 'degraded' };
    }
    const densityAsset = resolved.value;
    const guid = assets?.guidOf(densityAsset) ?? `handle:${Number(densityHandle)}`;
    const shape = densityAsset.shape;
    const density: VolumeDensityBinding =
      shape.viewDimension === '3d'
        ? {
            guid,
            generation: 1,
            shape: {
              viewDimension: '3d',
              extent: {
                width: shape.extent.width,
                height: shape.extent.height,
                depth: shape.extent.depth,
              },
            },
            format: densityAsset.format,
            colorSpace: densityAsset.colorSpace,
          }
        : {
            guid,
            generation: 1,
            shape: {
              viewDimension: shape.viewDimension,
              extent:
                shape.viewDimension === '2d-array'
                  ? {
                      width: shape.extent.width,
                      height: shape.extent.height,
                      layers: shape.extent.layers,
                    }
                  : { width: shape.extent.width, height: shape.extent.height },
            },
            format: densityAsset.format,
            colorSpace: densityAsset.colorSpace,
          };
    const authoring: VolumetricFogAuthoring = {
      light: source.light,
      density,
      bounds: {
        min: [source.boundsMin[0] ?? 0, source.boundsMin[1] ?? 0, source.boundsMin[2] ?? 0],
        max: [source.boundsMax[0] ?? 0, source.boundsMax[1] ?? 0, source.boundsMax[2] ?? 0],
      },
      extinction: [source.extinction[0] ?? 0, source.extinction[1] ?? 0, source.extinction[2] ?? 0],
      albedo: [source.albedo[0] ?? 0, source.albedo[1] ?? 0, source.albedo[2] ?? 0],
      emission: [source.emission[0] ?? 0, source.emission[1] ?? 0, source.emission[2] ?? 0],
      anisotropy: source.anisotropy,
      maxDistance: source.maxDistance,
    };
    authorings.push(authoring);
    first ??= { densityHandle, densityAsset, guid };
  }

  if (authorings.length === 0) return undefined;
  const extracted = extractVolumetricFog(authorings);
  if (!extracted.ok) {
    worldInternal._routeError(extracted.error, {
      severity: Severity.Error,
      systemName: 'RenderSystem.extract (volumetric-fog)',
    });
    return {
      status: 'degraded',
      ...(first === undefined
        ? {}
        : {
            densityHandle: first.densityHandle,
            densityAsset: first.densityAsset,
            guid: first.guid,
            generation: 1,
            digest: textureDigest(first.densityAsset),
            ...(selectedLight === undefined
              ? {}
              : {
                  lightEntity: selectedLight.entity,
                  lightKind: selectedLight.kind,
                  ...(selectedLight.pointLightEntity === undefined
                    ? {}
                    : { pointLightEntity: selectedLight.pointLightEntity }),
                  ...(selectedLight.spotLightEntity === undefined
                    ? {}
                    : { spotLightEntity: selectedLight.spotLightEntity }),
                }),
          }),
    };
  }
  if (extracted.value.status === 'off' || first === undefined) return { status: 'off' };
  const selectedLightFields =
    selectedLight === undefined
      ? {}
      : {
          lightEntity: selectedLight.entity,
          lightKind: selectedLight.kind,
          ...(selectedLight.pointLightEntity === undefined
            ? {}
            : { pointLightEntity: selectedLight.pointLightEntity }),
          ...(selectedLight.spotLightEntity === undefined
            ? {}
            : { spotLightEntity: selectedLight.spotLightEntity }),
        };
  return {
    status: 'available',
    fog: extracted.value.fog,
    densityHandle: first.densityHandle,
    densityAsset: first.densityAsset,
    guid: first.guid,
    generation: 1,
    digest: textureDigest(first.densityAsset),
    ...selectedLightFields,
  };
}

// Source contract anchor: the spot-light query remains single-source in this
// extraction boundary (`const spotLightQuery = world.query({ read: [SpotLight] })`)
// and snapshots retain the
// normalized `const dirN = vec3.create(` then `direction: dirN` fields; the implementation body lives in the
// tail module to keep this owner below the physical line budget. The tail keeps
// the extract integration bound to deriveInstancesUnionBounds, rather than
// introducing a second bounds ledger in this forwarding owner.

export { defaultMaterialSnapshot, extractFrame, extractFrames } from './render-system-extract-tail';
