# `@forgeax/engine-scene`

> [!IMPORTANT]
> Owner: scene identity, hierarchy, and world-space propagation. This package is the sole authority for `Transform`, `ChildOf`, `Children`, `Name`, and `scenePlugin`.

## Smallest useful example

```ts
import { scenePlugin, Transform } from '@forgeax/engine/scene';
import { createWorldContext, World } from '@forgeax/engine/ecs';

const world = new World();
const context = await createWorldContext(world, [scenePlugin()]);
const entity = world
  .spawn({ component: Transform, data: {} })
  .unwrap();
void entity;
await context.fiber.restart();
```

`scenePlugin()` is a native Cordis plugin. Its Fiber installs hierarchy
propagation and removes it when the realm unloads. The direct
`propagateTransforms(world)` entry point returns `Result<void, SceneError>`;
branch on `error.code` and repair a diagnosable stale edge, mirror mismatch, or
cycle through `World.set`/`World.removeComponent` (or the owning structural
command) before retrying while the World is healthy.

When the plugin runs from the scheduled path, `world.update(deltaSeconds)`
wraps a thrown Scene failure as `system-failed`; the wrapper's
`error.detail.cause` is the original `SceneError` (including its structured
`code`/`detail`). That post-write system failure poisons the World, so the next
use returns `world-poisoned`. Inspect `detail.cause`, stop using that World
identity, discard it, and ask the App execution owner to call
`app.execution.rebuild()` for a fresh World. Do not retry a poisoned or
partially-written World in place.

If an explicitly malformed internal fixture reports a `Children` mirror
mismatch, never write the target array directly. A same-target
`world.set(child, ChildOf, { parent })` intentionally records the source
evidence but skips mirror/index churn, so it cannot repair that mismatch. On a
healthy World, repair through the source owner by removing and re-adding
`ChildOf` (or reparenting through another target and then back to the intended
one); if the failure has poisoned the World, discard it and rebuild through the
App instead.

Transform propagation writes the exact recomputed frontier into
`GlobalTransform` and advances those rows' ordinary component versions only
after a successful pass. A no-change pass advances no `GlobalTransform` row.
Persistent consumers keep a `changed: [GlobalTransform]` Query, so a moved
subtree is exposed as contiguous spans without a parallel event journal.
`Transform` remains authored local TRS; `GlobalTransform` is the resolved
world-space authority.

For a valid hierarchy, propagation expands the ECS-maintained `Children`
buffer from each root in parent-first order. `ChildOf` is the writable source
fact; `Children` is a read-only materialized target, so source mutations and
their reverse lists converge before the frame pass. The numeric traversal
borrows ECS columns and uses only constant matrix scratch plus depth/row
markers; it does not build a Scene graph or per-node matrix cache.

Removing `ChildOf` is a structural root transition. Even when the authored
`Transform` is unchanged, the next propagation composes and publishes that
entity as a flat local root; ordinary same-value hierarchy recomputation still
does not publish an unchanged `GlobalTransform` row.

Flat propagation uses the same numeric kernel inline or through an installed
SharedKernel executor. It borrows the existing changed query, joins root
matrices before resolving the hierarchy, and leaves small or fragmented ranges
inline. Scene builds its self-contained kernel module into `pkg/` from the same
TypeScript source; no new Worker pool, component-name registry, or transform
change journal is introduced. Partial shared writes poison the owning World.

`Transform` declares the generic ECS requirement `GlobalTransform`. Therefore
ordinary `world.spawn`, `world.addComponent`, and deferred `Commands.spawn`
materialize the transient world column automatically at the structural
boundary; scene code does not need a special pair-completion helper and the
frame loop never scans entities to repair them. Explicit `GlobalTransform`
data remains valid when an importer or recovery path needs to provide it.

`ChildOf` declares `Transform` as a relationship-source requirement. A child
created with only `{ component: ChildOf, data: { parent } }` therefore receives
the full local/world pair transitively, while explicit `Transform` data still
wins. This keeps hierarchy authoring small without adding per-frame repair or
an additional scene-side component registry.

Deferred `Commands.spawn` uses the same `{ component, data }` entries as
`World.spawn`; the pending child is materialized and linked at command flush.
For an existing child, the generic reparent call is
`world.reparent(child, newParent, ChildOf, { parent: newParent })` and routes
through the same relationship owner.

`ChildOf` uses `linkedSpawn: true`: despawning a parent recursively despawns
its linked hierarchy. A generic relationship may opt out, but that is not the
Scene hierarchy lifecycle.

Removing the required component is still an explicit malformed-state escape
hatch, not an automatic cascade. Propagation reports that state as a
structured `SceneError`, preserving a clear owner and recovery path.

The authority also applies to dynamic loading: import `Transform`, `ChildOf`, and `scenePlugin` from `@forgeax/engine/scene` when a host resolves packages at runtime.

## Boundary

| This package owns | Excluded concepts |
|:--|:--|
| Identity, parent/child links, local/world transforms | Meshes, materials, cameras, skins, animation, GPU/RHI |

See [`src/index.ts`](src/index.ts) for the public roster and [`src/errors.ts`](src/errors.ts) for recovery details.

## Visibility hierarchy boundary

Quick start: create `ChildOf` links through the scene package, then let
`resolveVisibility(world)` consume the projected hierarchy when a render or
remote diagnostic asks for an effective state.

| Fact | Scene owns | Consumer owns |
|:--|:--|:--|
| Parent relation | `ChildOf`, `Children`, and hierarchy projection | Visibility intent and render filtering |
| Effective lookup | Valid parent traversal and hierarchy diagnostics | `Visibility` field values and renderer statistics |
| Recovery | Repair a stale/cyclic relation from `SceneHierarchyDiagnostic` | Do not reinterpret a hierarchy error as a camera or picking error |

Read `VisibilityResolution.source` to distinguish `self`, `parent`, and the
default root case. If diagnostics report an invalid hierarchy, fix the scene
relation and resolve again; do not add a render-only parent or bypass the
scene graph. Camera, picking, lifecycle, assets, and VFX shadow behavior are
out of scope for this package.
