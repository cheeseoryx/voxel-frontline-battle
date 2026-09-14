# hello-bloom

> Bloom post-processing opt-in exemplar. Press Space to toggle the 4-pass declarative bloom pipeline at runtime.

(feat-20260531-bloom-first-declarative-render-graph-pass / M4 / w18)

## What is demonstrated

- **4-pass declarative render graph chain**: bloom-bright -> bloom-blur-h -> bloom-blur-v -> bloom-composite -- the engine's first post-processing chain built on `RenderGraph.addPass({reads,writes,execute})`.
- **Camera bloom columns**: 4 new f32 columns (`bloom`/`bloomThreshold`/`bloomIntensity`/`bloomBlurRadius`) configured per-Camera alongside `tonemap`/`antialias`.
- **Zero-overhead default**: bloom=0 (BLOOM_DISABLED) allocates no textures, binds no pipelines -- full early-return in the 4 execute closures.
- **Runtime toggle**: Space-key press-edge system swaps Camera.bloom between BLOOM_ENABLED and BLOOM_DISABLED via world.set. DOM HUD overlay mirrors state as text; the carrier smoke verifies on -> off -> on -> off recovery.
- **HDR+Reinhard pipeline**: Camera.tonemap=Reinhard-Extended enables the HDR path required by bloom; the bright-pass extracts pixels > bloomThreshold (1.0) from the HDR target.

## Run

```bash
pnpm dev                        # vite dev server -> localhost:5173
pnpm build                      # production bundle -> dist/
pnpm --filter @forgeax/hello-bloom smoke   # Dawn 300-frame lifecycle + readback
pnpm --filter @forgeax/hello-bloom smoke:browser # Browser WebGPU lifecycle + PNG readback
pnpm --filter @forgeax/hello-bloom smoke:falsify # expected red Bloom contribution control
```

## Scene

An emissive sphere (baseColor=[1.0,0.85,0.55], emissive=[1.0,0.7,0.3], emissiveIntensity=2.0) on the left and a non-emissive reference cube on the right, under a slant directional light. The sphere's > 1.0 HDR pixels feed the bloom bright-pass; the cube stays below the threshold as a visual anchor.

## Keybind

| Key | Action |
|:--|:--|
| <kbd>Space</kbd> | Toggle bloom on/off |

## Smoke gate

`scripts/smoke-dawn.mjs` runs a real dawn-node headless smoke with at least 300
successful Renderer submits. It records the on -> off -> resize -> re-enabled
-> recovery phases, detached Bloom inspection, graph roster, structured errors,
and `copyTextureToBuffer` readback. The on/off RGB readback hashes are the
Bloom contribution predicate; `smoke:falsify` removes the emissive contribution
with the same camera, graph, and frame schedule and must fail that predicate.

`scripts/smoke-browser.mjs` runs the same lifecycle on a real Browser WebGPU
canvas, waits for 300 submitted-frame events, captures PNGs, decodes their
pixels, and stores the inspection/readback contract in `evidence/`.

## Recovery and evidence

Bloom is authored by `Camera.bloom` and remains inside the Standard post
graph. The disabled value is an exact zero-overhead path: no bloom resources,
passes, uploads, or counters are created. Call `renderer.inspect()` after a
failure, branch on the structured error `code` and typed `detail`, repair the
named owner, and retry the same draw request. The carrier never owns a second
post topology or accesses device handles.

The smoke manifest records current source/build provenance, backend, runner,
frame identity, and the on -> off -> resize -> re-enabled -> recovery receipt sequence. Structural
roster evidence and real PNG/readback evidence are distinct; a historical
oracle cannot substitute for either one.
