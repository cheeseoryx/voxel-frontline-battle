# 10k cubes + punctual lights admission

This is one parameterized `engine-performance` pressure consumer. Its no-argument run is the canonical admission point.

| Fact | Fixed contract |
|:--|:--|
| Cubes | `10,000` individually queryable entities, each with `Transform`, `MeshFilter`, and `MeshRenderer` |
| Shared assets | Built-in `HANDLE_CUBE` and one shared standard `MaterialAsset` handle |
| Distribution | Uniform PRNG samples in `[-24,24] x [-16,16] x [-24,24]` |
| Seed | `0x010c0b35` (`PERF_WORKLOAD_SEED`, version `1`) |
| Camera | Transform at the exact volume center `[0,0,0]`, rotating continuously in place |
| ECS work | Named `perf-10k-cubes-rotate` Update system writes every cube quaternion every measured frame |
| Lights | Defaults `16 PointLight + 16 SpotLight`; total is fail-fast bounded to the HDRP `256` light contract |

Scale parameters are query-string values (`cubes`, `pointLights`, `spotLights`) and are included in the workload fingerprint. They change counts only; seed, volume, mesh, material, camera law, pipeline, viewport, and rotation laws remain fixed.

```text
http://127.0.0.1:5207/?cubes=1000&pointLights=8&spotLights=8
```

`smoke` drives the same built app contract through Dawn-node and records the post-spawn query oracle, frame progress, processed-cube count, renderer errors, raw frame samples, and a complete CPU `ProfileCapture`. `smoke:browser` drives the Vite dev-server front door and records screenshot/readback plus browser errors. Neither smoke is an optimization claim.

## Three.js object-path comparison

Build the consumer and run the explicit local comparison:

```bash
pnpm --filter @forgeax/perf-10k-cubes-lights compare:browser
```

The command serves the production Vite bundle and runs Three.js `0.184.0`
(`WebGPURenderer`) beside the ForgeaX page in fresh Chrome contexts. Both pages
use the same seed, bounds, camera law, `BoxGeometry`/`HANDLE_CUBE` dimensions,
standard-PBR material parameters, `32` clustered punctual lights, viewport,
warm-up, and measured frame count. The default distribution is `16 PointLight
+ 16 SpotLight` only to preserve light-kind parity with Three.js; ForgeaX
routes both kinds through the same Cluster light-data, binning, and shading
path. The comparison deliberately uses 10,000 independent objects; it does
not compare Three.js `InstancedMesh` to ForgeaX entities.

Frame intervals are measured from browser
`requestAnimationFrame` (therefore a Three.js result near 60 FPS can be a
display-vsync ceiling, not proof of unused headroom), while render samples are
the Three.js CPU command-encoding interval and do not wait for GPU completion.

The JSON report is written to `artifacts/three-forgeax-comparison.json` (or
`PERF_COMPARE_OUTPUT`). It contains every run, validation errors, frame-time
percentiles, FPS lower-tail (`p05`), cube-update timing, and the exact Engine
commit / Three.js revision. This is an explicitly invoked experiment, not a CI
performance budget. Use `PERF_RUNS`, `PERF_WARMUP_FRAMES`,
`PERF_MEASURE_FRAMES`, `PERF_CUBES`, `PERF_POINT_LIGHTS`, and
`PERF_SPOT_LIGHTS` to scale it; keep both implementations on the same values
when comparing results.
