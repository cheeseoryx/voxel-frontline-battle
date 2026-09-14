# hello-taa

This carrier exercises the smallest temporal path: attach `Camera` with TAA
and `MotionBlur` to one active camera, then inspect the renderer receipt. The
Motion Blur component is presence-enabled and uses bounded
`shutterAngle`, `maxRadiusPixels`, and `sampleCount` values.

The carrier smoke scripts retain separate Dawn, Browser serialization,
CPU-WebGL2 raster, and RhiNull structural-only checks. RhiNull does not make a
pixel claim. `evidence/visual-cases.json` is the bounded visual case and
falsifier manifest; this checkout records no fabricated screenshot result.

The `smoke:performance` report runs the real Dawn carrier for 300 frames on the
lavapipe correctness lane. It records the single `rgba16float` temporal target
as `8 * width * height` bytes at 1080p, 1440p, and 4K, plus producer/Motion Blur
pass counts, stable creation counters, pass trace, and source/build identity.
This lane is correctness-only and explicitly reports `gpuTimestamp: false`; it
does not qualify timing.

PR CI keeps this carrier on the self-hosted Linux heavy pool and exercises the
simulation/software-GPU paths through Dawn/lavapipe, browser WebGL2, and the
RhiNull structural smoke. These are correctness and raster/falsifier checks;
native 1080p timing is intentionally not a required CI gate because the
self-hosted fleet has no physical-GPU provider. The former physical-GPU
admission test and its artifact were removed rather than weakening the result
or claiming that simulated GPU timing is native timing.

The manifest declares all five ForgeaX metric kinds. Bundle-size, FPS, bench,
and spike-report are intentionally disabled here because their evidence owners
are the package build, carrier smoke, render benchmark, and spike workflow;
the gate metric remains enabled and invokes the exact Dawn smoke command.

Inspection is detached bounded POD only: `motionBlur` reports status, validated
parameters, demand, pass identity, and zero history writes. It never serializes
a graph node, RHI handle, raw key, epoch, or a second history. Invalid params
and unavailable scene data remain structured failures; repair the named source
or capability and retry the same frame.
