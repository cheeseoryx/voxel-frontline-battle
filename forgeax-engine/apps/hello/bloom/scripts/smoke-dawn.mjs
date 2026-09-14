#!/usr/bin/env node
// hello-bloom headless smoke (feat-20260531-bloom-first-declarative-render-graph-pass / M4 / w19).
//
// Strategy: createApp, spawn emissive sphere + cube scene with
// bloom-enabled Camera, start the app, run N frames, and assert the
// bloom pipeline compiled and drew without errors.
//
// This smoke verifies the full createApp -> bloom pipeline chain:
//   1. createApp(canvas, opts) succeeds.
//   2. host initialization succeeds (bloom shaders compiled as part of manifest).
//   3. app.start() + N-frame loop + app.stop() succeeds.
//   4. app.onError fires 0 times (covers pipeline compile + draw errors).
//   5. console.error fires 0 times.
//   6. frames >= SMOKE_MIN_FRAMES.
//   7. The per-frame render graph contains the 4 declarative bloom
//      passes (bloom-bright / bloom-blur-h / bloom-blur-v / bloom-composite)
//      — proves the bloom chain is wired in the compiled graph.
//   8. Camera bloom off -> on -> off transitions prove exact-zero roster
//      removal and re-admission without a second Standard post topology.
//   9. bug-20260622 resize guard (AC-01/AC-02/AC-07): after the original
//      frames, shrink the swap-chain texture and drive more frames without
//      settling. The recompile drains the old-size bloom transient pool while
//      a prior command buffer may still be in flight. Asserts zero NEW
//      app.onError during the resize phase — the immediate-destroy regression
//      raises "Destroyed texture used in a submit" through onuncapturederror.
//      This is the only smoke that walks the resize-then-render bug path.
//
// The carrier verdict combines the structural graph contract with a real
// copyTextureToBuffer readback. RGB hashes from the on/off stages prove the
// Bloom contribution reaches the same swap-chain surface; the falsifier
// removes only the emissive contribution and must fail that predicate.
//
// Charter P3 explicit failure: on fail, output structured diagnostic with
// actual error codes and frame count so AI users can self-diagnose.

import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const FALSIFY_BLOOM = process.env.FORGEAX_BLOOM_FALSIFY === '1';

// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const WIDTH = 200;
// feat-20260615-ci-smoke-time-budget: 800x600 → 200x150 (lavapipe fragment-bound)
const HEIGHT = 150;

const consoleErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  originalConsoleError(...args);
};

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  originalConsoleError(`[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try {
  gpu = create([]);
} catch (err) {
  originalConsoleError(`[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let rafQueue = [];
let rafCounter = 1;
globalThis.requestAnimationFrame = (cb) => {
  const id = rafCounter++;
  rafQueue.push({ id, cb });
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafQueue = rafQueue.filter((f) => f.id !== id);
};
const realPerformanceNow = globalThis.performance?.now?.bind(globalThis.performance) ?? (() => Date.now());
globalThis.performance = globalThis.performance ?? { now: () => Date.now() };

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return adapter;
};

// bug-20260622: the swap-chain texture dimensions drive recordFrame's
// targetW/targetH (read off getCurrentTexture().width/height). Switching the
// returned texture to a smaller one mid-run makes the render-graph
// setSwapChainSize() report needsRecompile -> recompile -> drainTransient(),
// which retires the old-size bloom transient pool textures. The deferred-
// destroy fix (pendingDestroy + reclaimRetiredTransients) must keep those
// textures alive until the in-flight command buffer retires; the old buggy
// path destroyed them immediately and the next queue.submit raised
// "Destroyed texture used in a submit", surfaced via onuncapturederror ->
// app.onError. This resize step is the only smoke that walks that path.
let renderTarget;
let renderTargetW = WIDTH;
let renderTargetH = HEIGHT;
let renderTargetFormat = 'rgba8unorm';
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  renderTargetFormat = format;
  renderTarget = device.createTexture({
    size: { width: renderTargetW, height: renderTargetH, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
}
function resizeRenderTarget(device, width, height) {
  renderTargetW = width;
  renderTargetH = height;
  const next = device.createTexture({
    size: { width, height, depthOrArrayLayers: 1 },
    format: renderTargetFormat,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  renderTarget = next;
  return next;
}
const mockCanvas = {
  tagName: 'CANVAS',
  isConnected: true,
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
      },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) {
          if (!sharedDevice) throw new Error('no shared device captured');
          ensureRenderTarget(sharedDevice, 'rgba8unorm');
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const enginePkg = await import('@forgeax/engine-app');
const { createApp } = enginePkg;

const renderPkg = await import('@forgeax/engine-render');
const scenePkg = await import('@forgeax/engine-scene');
const {
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
  TONEMAP_REINHARD_EXTENDED,
} = renderPkg;
const { Transform } = scenePkg;
const {
  HANDLE_CUBE,
  HANDLE_SPHERE,
} = await import('@forgeax/engine-assets-runtime');

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

const appResult = await createApp(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL }).catch((err) => {
  originalConsoleError(`[smoke] FAIL - createApp threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appResult.ok) {
  originalConsoleError(`[smoke] FAIL - createApp returned err: ${JSON.stringify({ code: appResult.error.code, hint: appResult.error.hint })}`);
  process.exit(1);
}
const app = appResult.value;
console.log(`[hello-bloom] backend=${app.renderer.inspect().capabilities.backendKind}`);

// Register standard PBR material (non-emissive).
const assets = app.assets;
if (assets === null) {
  originalConsoleError('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

const matHandle = app.world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-standard-pbr' },
      renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
    },
  ],
  values: {
    baseColor: [0.7, 0.7, 0.7],
    metallic: 0.0,
    roughness: 0.4,
  },
});

// Mint emissive material (emissiveIntensity > 1.0 feeds bloom).
const emissiveHandle = app.world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-standard-pbr' },
      renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
    },
  ],
  values: {
    baseColor: [1.0, 0.85, 0.55],
    metallic: 0.0,
    roughness: 0.3,
    emissive: [1.0, 0.7, 0.3],
    emissiveIntensity: FALSIFY_BLOOM ? 0.0 : 2.0,
  },
});

// Spawn emissive sphere (left) and non-emissive cube (right).
app.world.spawn(
  {
    component: Transform,
    data: { pos: [-0.6, 0.2, 0], quat: [0, 0, 0, 1], scale: [0.6, 0.6, 0.6]},
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
  { component: MeshRenderer, data: { materials: [emissiveHandle] } },
);

app.world.spawn(
  {
    component: Transform,
    data: { pos: [0.6, 0, 0], quat: [0, 0, 0, 1], scale: [0.4, 0.4, 0.4]},
  },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [matHandle] } },
);

// Directional light.
app.world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.4, -0.6, -0.7], color: [1, 1, 1], intensity: 1.5 },
});

// Camera with bloom ENABLED.
const cameraEntity = app.world.spawn(
  { component: Transform, data: { pos: [0, 0, 5]} },
  {
    component: Camera,
    data: {
      ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
      tonemap: TONEMAP_REINHARD_EXTENDED,
      bloom: BLOOM_ENABLED,
      bloomThreshold: 1.0,
      bloomIntensity: 1.0,
      bloomBlurRadius: 4.0,
    },
  },
).unwrap();

const onErrorEvents = [];
app.onError((err) => onErrorEvents.push({ code: err.code, hint: err.hint, detail: err.detail }));
const submittedFrameEvents = [];
const unsubscribeRenderer = app.renderer.subscribe((event) => {
  if (event.kind === 'frame-submitted') submittedFrameEvents.push(event);
});


// Override performance.now for deterministic frame timing.
let fakeNow = 0;
globalThis.performance.now = () => fakeNow;

const startResult = app.start();
if (!startResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.start() returned err: ${startResult.error.code}`);
  process.exit(1);
}

const frameCreditTimeoutMs = Number.parseInt(
  process.env.FORGEAX_SMOKE_FRAME_CREDIT_TIMEOUT_MS ?? '5000',
  10,
);
const FRAME_CREDIT_TIMEOUT_MS =
  Number.isFinite(frameCreditTimeoutMs) && frameCreditTimeoutMs > 0 ? frameCreditTimeoutMs : 5_000;

async function waitForFrameCredit() {
  const deadline = Date.now() + FRAME_CREDIT_TIMEOUT_MS;
  while (app.execution.report().frame.inFlight >= 2) {
    if (Date.now() >= deadline) {
      originalConsoleError(
        `[smoke] frame credit did not settle within ${FRAME_CREDIT_TIMEOUT_MS}ms (inFlight=${app.execution.report().frame.inFlight})`,
      );
      return false;
    }
    // Dawn receipts settle asynchronously. Yield briefly so the completion
    // callback can release the App's two-frame credit before the next tick.
    await delay(1);
  }
  return true;
}

async function driveFrames(count) {
  let driven = 0;
  for (let i = 0; i < count; i++) {
    if (!(await waitForFrameCredit())) break;
    const due = rafQueue.shift();
    if (!due) break;
    fakeNow += 16.67;
    due.cb(fakeNow);
    driven++;
    // The callback starts an async submit. Yield once before checking the
    // next credit so the renderer can publish its receipt synchronously and
    // the smoke does not mistake queued callbacks for successful submits.
    await delay(1);
  }
  return driven;
}

function bloomPassNames() {
  return app.renderer.inspect().perFramePassNames.filter((name) => name.startsWith('bloom-'));
}

const transitionFailures = [];
function assertBloomRoster(label, expected) {
  const actual = bloomPassNames();
  const expectedNames = expected
    ? ['bloom-bright', 'bloom-blur-h', 'bloom-blur-v', 'bloom-composite']
    : [];
  if (JSON.stringify(actual) !== JSON.stringify(expectedNames)) {
    transitionFailures.push(`${label}: expected ${JSON.stringify(expectedNames)}, got ${JSON.stringify(actual)}`);
  }
  console.log(`[smoke] bloom=${label} roster=${JSON.stringify(actual)}`);
}

async function readbackSurface(device, texture, width, height) {
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const readback = device.createBuffer({
    label: 'hello-bloom-readback',
    size: bytesPerRow * height,
    usage: 0x01 | 0x08,
  });
  const encoder = device.createCommandEncoder({ label: 'hello-bloom-readback-encoder' });
  encoder.copyTextureToBuffer(
    { texture },
    { buffer: readback, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(0x01);
  const bytes = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();
  let nonBlackPixels = 0;
  let maxLuma = 0;
  let totalLuma = 0;
  const rgbBytes = new Uint8Array(width * height * 3);
  let rgbOffset = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * bytesPerRow + x * 4;
      const r = bytes[offset] ?? 0;
      const g = bytes[offset + 1] ?? 0;
      const b = bytes[offset + 2] ?? 0;
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      if (luma > 0.02) nonBlackPixels += 1;
      maxLuma = Math.max(maxLuma, luma);
      totalLuma += luma;
      rgbBytes[rgbOffset++] = r;
      rgbBytes[rgbOffset++] = g;
      rgbBytes[rgbOffset++] = b;
    }
  }
  const centerOffset = Math.floor(height / 2) * bytesPerRow + Math.floor(width / 2) * 4;
  return {
    width,
    height,
    nonBlackPixels,
    maxLuma,
    meanLuma: totalLuma / (width * height),
    pixelHash: createHash('sha256').update(bytes).digest('hex'),
    rgbHash: createHash('sha256').update(rgbBytes).digest('hex'),
    center: [
      (bytes[centerOffset] ?? 0) / 255,
      (bytes[centerOffset + 1] ?? 0) / 255,
      (bytes[centerOffset + 2] ?? 0) / 255,
      (bytes[centerOffset + 3] ?? 0) / 255,
    ],
  };
}

const evidenceStages = [];
async function captureStage(label, width, height, extra = {}) {
  await sharedDevice?.queue.onSubmittedWorkDone();
  const inspection = app.renderer.inspect();
  let readback;
  let readbackError;
  try {
    readback = await readbackSurface(sharedDevice, renderTarget, width, height);
  } catch (error) {
    readbackError = {
      code: 'readback-failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const stage = {
    label,
    submittedFrames: submittedFrameEvents.length,
    roster: [...bloomPassNames()],
    bloom: inspection.bloom,
    readback,
    structuredErrors: [...onErrorEvents],
    ...(readbackError === undefined ? {} : { readbackError }),
    ...extra,
  };
  evidenceStages.push(stage);
  console.log(`[smoke] stage=${label} evidence=${JSON.stringify(stage)}`);
  return stage;
}

// Run frames at the original size and verify the exact on -> off -> on roster.
let totalFrames = await driveFrames(SMOKE_MIN_FRAMES);
assertBloomRoster('on', true);
await captureStage('on', WIDTH, HEIGHT);

const offResult = app.world.set(cameraEntity, Camera, { bloom: BLOOM_DISABLED });
if (!offResult.ok) transitionFailures.push(`off toggle failed: ${offResult.error.code}`);
totalFrames += await driveFrames(3);
assertBloomRoster('off', false);
await captureStage('off', WIDTH, HEIGHT);

const onResult = app.world.set(cameraEntity, Camera, { bloom: BLOOM_ENABLED });
if (!onResult.ok) transitionFailures.push(`on toggle failed: ${onResult.error.code}`);
totalFrames += await driveFrames(3);
assertBloomRoster('on-recovered', true);
await captureStage('re-enabled', WIDTH, HEIGHT);

// bug-20260622 resize step (AC-01/AC-02/AC-07): shrink the swap-chain texture
// and immediately drive more frames WITHOUT settling. The first post-resize
// frame recompiles the render graph (setSwapChainSize -> drainTransient) while
// the prior frame's command buffer may still be in flight on the GPU. The
// deferred-destroy fix must keep the retired transient textures alive until
// reclaimRetiredTransients() observes onSubmittedWorkDone; the old buggy path
// destroyed them synchronously and the next queue.submit raised
// "Destroyed texture used in a submit", caught here via app.onError.
const RESIZE_W = Math.max(1, Math.floor(WIDTH / 2));
const RESIZE_H = Math.max(1, Math.floor(HEIGHT / 2));
const onErrorBeforeResize = onErrorEvents.length;
if (sharedDevice) {
  resizeRenderTarget(sharedDevice, RESIZE_W, RESIZE_H);
  mockCanvas.width = RESIZE_W;
  mockCanvas.height = RESIZE_H;
}
console.log(`[smoke] resize ${WIDTH}x${HEIGHT} -> ${RESIZE_W}x${RESIZE_H}`);
const RESIZE_FRAMES = 60;
const resizeFrames = await driveFrames(RESIZE_FRAMES);
totalFrames += resizeFrames;
await captureStage('resize', RESIZE_W, RESIZE_H, { resizeFrames });

const releaseResult = app.renderer.releaseSurface();
const restoreResult = app.renderer.restoreSurface();
if (!releaseResult.ok) transitionFailures.push(`releaseSurface failed: ${releaseResult.error.code}`);
if (!restoreResult.ok) transitionFailures.push(`restoreSurface failed: ${restoreResult.error.code}`);
totalFrames += await driveFrames(3);
assertBloomRoster('recovery', true);
await captureStage('recovery', RESIZE_W, RESIZE_H, {
  release: releaseResult.ok ? 'ok' : releaseResult.error,
  restore: restoreResult.ok ? 'ok' : restoreResult.error,
});

// Restore real performance.now and wait for any pending GPU work to settle.
globalThis.performance.now = realPerformanceNow;
await delay(2000);

const onErrorAfterResize = onErrorEvents.length;
console.log(
  `[smoke] frames observed=${totalFrames} (resize phase=${resizeFrames}, onError pre-resize=${onErrorBeforeResize}, post-resize=${onErrorAfterResize})`,
);

const stopResult = app.stop();
if (!stopResult.ok) {
  originalConsoleError(`[smoke] FAIL - app.stop() returned err: ${stopResult.error.code}`);
  process.exit(1);
}

const failures = [];
failures.push(...transitionFailures);
if (onErrorEvents.length > 0) {
  failures.push(`(a) app.onError fired ${onErrorEvents.length} times: ${JSON.stringify(onErrorEvents)}`);
}

// Filter out known smoke-expected noise: the '[smoke]' prefix on our own logs.
const unexpectedConsoleErrors = consoleErrors.filter((e) => !e.includes('[smoke]'));
if (unexpectedConsoleErrors.length > 0) {
  failures.push(`(b) console.error fired ${unexpectedConsoleErrors.length} times: ${JSON.stringify(unexpectedConsoleErrors.slice(0, 3))}`);
}

if (totalFrames < SMOKE_MIN_FRAMES) {
  failures.push(`(c) total frames=${totalFrames} < ${SMOKE_MIN_FRAMES}`);
}
if (submittedFrameEvents.length < SMOKE_MIN_FRAMES) {
  failures.push(
    `(f) successful Renderer submits=${submittedFrameEvents.length} < ${SMOKE_MIN_FRAMES}`,
  );
}

// bug-20260622 (e): the resize phase must not surface any new GPU validation
// error. A "Destroyed texture used in a submit" (immediate-destroy regression)
// fans out through onuncapturederror -> app.onError, incrementing onErrorEvents
// during the post-resize frames. onErrorBeforeResize === onErrorAfterResize
// proves the deferred-destroy fix keeps retired transients alive across the
// in-flight command buffer. resizeFrames > 0 guards against the resize phase
// silently skipping (an empty rafQueue would make this assertion vacuous).
if (resizeFrames === 0) {
  failures.push('(e) resize phase ran 0 frames; resize smoke is vacuous (rafQueue drained early)');
} else if (onErrorAfterResize !== onErrorBeforeResize) {
  const resizeErrors = onErrorEvents.slice(onErrorBeforeResize);
  failures.push(
    `(e) resize introduced ${onErrorAfterResize - onErrorBeforeResize} app.onError event(s) (destroyed-texture-in-submit regression?): ${JSON.stringify(resizeErrors)}`,
  );
}
const onStage = evidenceStages.find((stage) => stage.label === 'on');
const offStage = evidenceStages.find((stage) => stage.label === 'off');
if (onStage?.readback === undefined || offStage?.readback === undefined) {
  failures.push('(g) Bloom on/off stages did not produce GPU readback');
} else if (onStage.readback.rgbHash === offStage.readback.rgbHash) {
  failures.push(
    '(g) Bloom contribution falsifier: on/off readback is identical; emissive contribution did not reach the Bloom graph',
  );
}
if (onStage?.bloom?.graphStatus !== 'valid' || onStage?.bloom?.passCount !== 4) {
  failures.push(`(h) Bloom inspection did not report a valid four-pass graph: ${JSON.stringify(onStage?.bloom)}`);
}
if (evidenceStages.length !== 5) {
  failures.push(`(i) expected five lifecycle evidence stages, got ${evidenceStages.length}`);
}

const repoRoot = resolve(here, '..', '..', '..', '..');
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
const evidencePath = resolve(here, '..', 'evidence', 'dawn-result.json');
mkdirSync(resolve(here, '..', 'evidence'), { recursive: true });
writeFileSync(
  evidencePath,
  `${JSON.stringify(
    {
      schemaVersion: 'hello-bloom-evidence/1',
      sourceRevision,
      source: {
        path: 'apps/hello/bloom/scripts/smoke-dawn.mjs',
        sha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
      },
      backend: app.renderer.inspect().capabilities.backendKind,
      runner: { kind: 'dawn-node', id: 'webgpu' },
      successfulSubmittedFrames: submittedFrameEvents.length,
      stages: evidenceStages,
      structuredErrors: onErrorEvents,
      verdict: failures.length === 0 ? 'pass' : 'fail',
    },
    null,
    2,
  )}\n`,
);
console.log(`[smoke] evidence=${evidencePath}`);

if (failures.length > 0) {
  originalConsoleError(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) originalConsoleError(`  ${f}`);
  await delay(0);
  if (sharedDevice) sharedDevice.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - frames=${totalFrames}, app.onError=0, resize=${WIDTH}x${HEIGHT}->${RESIZE_W}x${RESIZE_H} (${resizeFrames}f, 0 new onError), backend=${app.renderer.inspect().capabilities.backendKind}`);

if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
