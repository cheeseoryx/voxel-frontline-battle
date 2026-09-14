// === Package interface (feat-20260618-asset-and-pack-name-fields M1 / w2) ======
//
// Decision anchors:
//   - plan-strategy D-7 (Package interface in @forgeax/engine-types, same layer
//     as Asset union, for multi-package consumer discoverability per charter F1)
//   - architecture-principles #2 (Derive, Don't Duplicate): assetCount is
//     derived from assetGuids.size, never stored independently
//   - plan-strategy D-5 (builtin assets -> null Package, not a synthetic path)
//   - Package does not carry a `name` field — resolved names flow through
//     resolveName (D-6), not stored on Package
//
// AI users discover Package via IDE autocomplete on @forgeax/engine-types;
// the runtime AssetRegistry.packageOf Map carries Package | null per guid.

/**
 * Runtime view of one import-source package -- the grouping unit for
 * the two-segment asset identity (`<packagePath>.<name>`).
 *
 * `path` is the import file path (e.g. `'assets/hero.glb'`).  Multiple
 * assets imported from the same source file share one `Package`.
 *
 * `assetGuids` lists every GUID that belongs to this package.  The
 * runtime keeps it in sync with `registerPackage` insertions.
 *
 * `assetCount` is a derived view (`assetGuids.size`); it is **not**
 * stored as a standalone field (Derive axiom #2).
 */
export interface Package {
  readonly path: string;
  readonly assetGuids: ReadonlySet<string>;
  readonly assetCount: number;
}

// === Scene asset POD shape (feat-20260514-scene-as-world-blueprint w2) ==========
//
// Decision anchors:
//   - requirements §AC-01 (AssetUnion 6 elements; SceneAsset top level only
//     `kind` + `entities`, no overrides field at the asset layer)
//   - requirements §AC-02 (LocalEntityId branded number; cross-brand assignment
//     to / from Entity is a TS compile-time error)
//   - charter proposition 1 (single-entry IDE autocomplete from
//     `@forgeax/engine-types`) + proposition 4 (explicit failure: brand
//     phantom rejects untagged number) + proposition 5 (consistent
//     abstraction, structurally parallel to Handle<T> brand)
//
// The unique-symbol brand stays private to this module so the brand
// identity is anchored exactly here; consumers refer to LocalEntityId
// as opaque number subtypes.

declare const LocalEntityIdBrand: unique symbol;

/**
 * Scene-local entity index brand (u32).
 *
 * Authored as `0..entities.length-1` inside a SceneAsset; runtime storage stays
 * a plain JS number (the phantom `[LocalEntityIdBrand]` is erased at runtime
 * but rejects cross-brand assignment with `Entity` at
 * the TS layer).
 *
 * AI users obtain LocalEntityId values from `SceneEntity.localId` accessors and
 * hand them back to `SceneEntity` manipulation methods; plain
 * `number` is not assignable to `LocalEntityId` by design — see
 * `packages/types/src/__tests__/scene-brand.test-d.ts` for the negative
 * assertions.
 */
export type LocalEntityId = number & { readonly [LocalEntityIdBrand]: void };

/**
 * Open map shape from component name to the per-component value record
 * authored on a `SceneEntity` (feat-20260514 w2).
 *
 * The map is keyed by component-token name (`'Transform' | 'MeshFilter' |
 * 'ChildOf' | ...`) and each per-component record is a free-form
 * `Record<string, unknown>` POD shape; the precise field types live in the
 * ecs `defineComponent(...)` schema (one layer up). This package stays
 * math-free + ecs-free; the layered alignment with the ecs schema vocab is
 * documented in plan-strategy §3.1 types_pkg sub-graph and tested by w3 /
 * w22 at the ecs / runtime layer.
 *
 * Open shape is intentional: components evolve via add-only minor in their
 * own packages; locking this map to a closed union here would force an edit
 * in @forgeax/engine-types every time a new component appears (charter
 * proposition 5 consistent abstraction — registration discipline owned by
 * each component's defineComponent site).
 */
export type ComponentValuesMap = {
  readonly [componentName: string]: Readonly<Record<string, unknown>>;
};

/**
 * Single SceneEntity POD shape (feat-20260514 w2).
 *
 * Carries one `localId` (LocalEntityId brand) plus a partial map of explicit
 * component field values. The partial keying lets layer 1 (explicit) leave
 * any component absent so layer 2 (component-level defaults) and layer 3
 * (TS type defaults) can fill in the residual fields at instantiate time
 * (plan-strategy §default-values 4-layer fallback table; AC-07 / AC-11 /
 * AC-12 sites).
 */
export interface SceneEntity {
  readonly localId: LocalEntityId;
  /** Stable scene-local author binding; display names are not identity. */
  readonly bindingKey?: string;
  readonly components: Partial<ComponentValuesMap>;
}

/**
 * One per-member mount-time modification (add-or-patch) applied to a
 * mounted scene member (feat-20260608-scene-nesting-ecs-fication M1 / w7;
 * feat-20260713-mount-override-component-add-and-shared-ref-round M1 / w2;
 * AC-01, AC-19).
 *
 * `localId` selects a member entity inside the mounted SceneAsset,
 * counted against the mount's `memberFirst` window. `comp` names the
 * target component. `field` is a component-granular discriminant:
 *   - present -> PATCH one field: `value` is that single field's value,
 *     written over the member's existing component at instantiate time;
 *   - absent  -> ADD/UPSERT the whole component: `value` is the per-field
 *     value map for `comp`, merged onto (or creating) the member's
 *     component.
 * `value` stays `unknown` because the per-component schema vocab lives one
 * layer up — runtime fail-fast via 'scene-override-type-mismatch' catches
 * type drift (plan-strategy D-9 / D-1). The discriminant is carried by the
 * shape itself (field present / absent), never a separate `op` tag, so no
 * consumer branches on a `switch (op)` (requirements: consumers do not
 * encode variant knowledge).
 *
 * Boundary notes: add is upsert (an existing component is merged, not
 * rejected); a NULL-sentinel entity value in the payload follows the same
 * `entity` remap rules as SceneEntity.components; overrides apply in
 * `mounts[].overrides[]` array order after the member's own authored
 * components.
 *
 * Charter mapping: proposition 1 (single-entry import surface, three-tier
 * progressive disclosure) + proposition 3 (machine-readable union,
 * MountOverride is a closed POD shape) + proposition 4 (explicit failure:
 * runtime apply path returns Result with structured error code).
 */
export interface MountOverride {
  readonly localId: LocalEntityId;
  readonly comp: string;
  readonly field?: string;
  readonly value: unknown;
}

/**
 * One mount instance authored on a parent SceneAsset
 * (feat-20260608-scene-nesting-ecs-fication M1 / w7; AC-01).
 *
 * A mount embeds another SceneAsset (referenced by `source`, a dual-carrier:
 * `number` = at-rest refs[] index; `string` = post-parse / post-collect GUID
 * string) into the parent's namespace. The mount reserves a contiguous
 * LocalEntityId window
 * `[memberFirst, memberFirst + memberCount)` for the embedded scene's
 * member entities so the parent SceneAsset's namespace invariant
 * `totalSlots = entities.length + mounts.length + sum(memberCount)`
 * holds (plan-strategy §6.3 + requirements §S-1).
 *
 * Optional fields:
 *   - `parent`: LocalEntityId in the *parent* scene to which the mount
 *     attaches (defaults to the parent scene's outermost root,
 *     requirements-decisions §D-4);
 *   - `components`: per-component value overlay applied to the mount
 *     entity itself (mirrors SceneEntity.components shape; carries the
 *     same Partial<ComponentValuesMap> typing);
 *   - `overrides`: an array of MountOverride records that further
 *     specialise individual member entities at mount-time (AC-19).
 *
 * Charter mapping: proposition 1 (single-entry import surface;
 * SceneInstanceMount sits next to SceneEntity / SceneAsset) +
 * proposition 5 (consistent abstraction: the field set mirrors
 * SceneEntity for AI-user discoverability).
 */
export interface SceneInstanceMount {
  readonly localId: LocalEntityId;
  readonly source: number | string;
  readonly memberFirst: LocalEntityId;
  readonly memberCount: number;
  readonly parent?: LocalEntityId;
  readonly components?: Partial<ComponentValuesMap>;
  readonly overrides?: readonly MountOverride[];
  /** Engine-owned publication identity for generated Scene mounts. */
  readonly publicationFence?: import('./asset-producer').ScenePublicationFence;
}

/**
 * Scene asset POD shape (feat-20260514 w2; sixth member of the closed
 * `Asset` union).
 *
 * Three top-level fields — `kind: 'scene'` discriminator,
 * `entities: readonly SceneEntity[]`, and the optional `mounts:
 * readonly SceneInstanceMount[]` (feat-20260608-scene-nesting-
 * ecs-fication M1 / w7; AC-01). Per-instance overrides at the
 * asset layer are still absent (charter proposition 5: ECS write
 * paths and prefab override paths are explicitly disjoint,
 * plan-strategy §3.2 sequence B); the `mounts[]` window is an
 * authoring-time graph edge, not a write path.
 *
 * Back-compat: `mounts` is optional so legacy SceneAsset values
 * remain assignable; missing `mounts` is semantically equivalent to
 * `mounts: []` (plan-strategy §6.3, ajv default `[]`).
 */
export interface SceneAsset {
  readonly kind: 'scene';
  /** Stable author source identity projected into SceneEntityRef values. */
  readonly sourceKey?: string;
  readonly entities: readonly SceneEntity[];
  readonly mounts?: readonly SceneInstanceMount[];
  /**
   * GUIDs of `SkinAsset`s the scene's skinned entities reference (one per
   * SkeletonAsset bound by a `Skin: { skeleton }` component). SkinAssets are
   * not reachable through any `handle<*>` field on a SceneEntity component
   * (`Skin.skeleton` carries the SkeletonAsset GUID; the SkinAsset itself is
   * a sibling identified by matching `skeletonGuid`), so the scene's pack
   * load chain has to surface them explicitly. Without this list the
   * browser-async-pack-fetch path would never load SkinAssets, leaving
   * `postSpawnResolveJoints` unable to populate `Skin.joints[]` and the
   * extract pass fail-fasting on `Skin.joints.length=0` every frame
   * (feat-20260612-skin-palette-per-frame-upload M2 fixup).
   *
   * On disk: refs[] indices, mirror of `mounts[].source`.
   * Post-parseScenePayload: GUID strings (resolved via refs[]).
   * Enumerated in the scene envelope's `refs[]` (the recursion source) so
   * `loadByGuid<SceneAsset>` recursively pulls each SkinAsset before
   * `instantiate`.
   */
  readonly skinGuids?: readonly string[];
}
