#!/usr/bin/env node

// The TAA carrier owns a real Dawn smoke instead of a provider-shaped placeholder.
// Keep the loop deliberately synchronous: the regression this catches only appears
// when a consumer submits frames without yielding between draws.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootRenderer, runFrameLoopAndReadback, setupGpuShim } from '../../triangle/scripts/smoke-helpers.mjs';
import {
  activePassCountersFromInspection,
  performanceAdmissionUnavailable,
  qualifiedNativeFromAttestation,
  performanceIdentityFromEnv,
  cpuAffinityFromEnv,
  runnerProvenanceFromEnv,
} from './performance-contract.mjs';
import {
  MAC_METAL_PROBE_SOURCE,
  parseMacIoregAdapterFacts,
  parseMacMetalProbeOutput,
  parseMacSystemProfilerAdapterFacts,
  parseMacSystemProfilerText,
  deriveAppleParavirtualAttestation,
} from './host-adapter-facts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const performanceAdmissionMode = process.argv.includes('--native-performance-admission') || process.env.SMOKE_PERFORMANCE_ADMISSION === '1';
const falsifierLightweight = process.env.FORGEAX_TAA_FALSIFIER_PROFILE === 'ci';
const width = performanceAdmissionMode ? 1920 : falsifierLightweight ? 128 : 200;
const height = performanceAdmissionMode ? 1080 : falsifierLightweight ? 72 : 150;
const motionBlurMaxRadiusPixels = falsifierLightweight ? 8 : 32;
const motionBlurSampleCount = falsifierLightweight ? 4 : 8;
const performanceIdentity = performanceIdentityFromEnv();
const runnerProvenance = runnerProvenanceFromEnv(process.env);
const cpuAffinity = cpuAffinityFromEnv(process.env);
if (performanceAdmissionMode && !performanceIdentity.testedRevisionMatchesCheckout) {
  console.log(`[hello-taa] dawnSummary=${JSON.stringify({
    ...performanceAdmissionUnavailable('testedRevision does not match checkout HEAD'),
    testedRevision: performanceIdentity.testedRevision,
    sourceRevision: performanceIdentity.sourceRevision,
  })}`);
  console.error('[smoke] FAIL - testedRevision does not match checkout HEAD');
  process.exit(1);
}
if (performanceAdmissionMode && (!runnerProvenance.ok || !cpuAffinity.ok)) {
  const reason = !runnerProvenance.ok ? runnerProvenance.reason : cpuAffinity.reason;
  console.log(`[hello-taa] dawnSummary=${JSON.stringify({
    ...performanceAdmissionUnavailable(reason),
    testedRevision: performanceIdentity.testedRevision,
    sourceRevision: performanceIdentity.sourceRevision,
    runnerName: runnerProvenance.runnerName,
    runnerFacts: runnerProvenance.runnerFacts,
    cpuAffinity: cpuAffinity.ok ? cpuAffinity.cpuAffinity : null,
  })}`);
  console.error(`[smoke] FAIL - ${reason}`);
  process.exit(1);
}
const requestedFrames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const visualCase = process.env.SMOKE_CASE ?? 'moving-rigid';
const isolatedCaptureMode = process.env.SMOKE_DAWN_CAPTURE_MODE;
if (isolatedCaptureMode !== undefined && !['on', 'off'].includes(isolatedCaptureMode)) {
  throw new Error(`SMOKE_DAWN_CAPTURE_MODE must be on or off, got ${isolatedCaptureMode}`);
}
if (!Number.isInteger(requestedFrames) || requestedFrames < 1) {
  throw new Error(`SMOKE_MIN_FRAMES must be a positive integer, got ${requestedFrames}`);
}
// TAA history and motion-vector evidence are only meaningful after the full
// hello-* contract window. The explicit CI falsifier profile is a smaller
// representative witness; standalone smoke and performance admission retain
// the 300-frame contract.
const frames = Math.max(requestedFrames, performanceAdmissionMode ? 300 : falsifierLightweight ? 60 : 300);
const rerunCmd = 'pnpm --filter @forgeax/hello-taa smoke';
const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const hashVitePayload = (root) => {
  const hash = createHash('sha256');
  const add = (path, relative) => {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      for (const name of readdirSync(path).sort()) add(resolve(path, name), `${relative}/${name}`);
      return;
    }
    hash.update(relative).update('\0').update(readFileSync(path));
  };
  add(resolve(root, 'index.html'), 'index.html');
  add(resolve(root, 'src'), 'src');
  add(resolve(root, 'dist', 'index.html'), 'dist/index.html');
  add(resolve(root, 'dist', 'shaders', 'manifest.json'), 'dist/shaders/manifest.json');
  return hash.digest('hex');
};

// Read a bounded area rather than betting the falsifier on one pixel. The
// moving cube can legitimately be between fixed probes at the final frame;
// this grid covers its authored path while keeping the black corner as a
// background falsifier.
const motionSamplePoints = [
  { name: 'ndcCenter', x: 0.5, y: 0.5 },
  { name: 'corner', x: 0.05, y: 0.05 },
  ...Array.from({ length: 7 }, (_, row) =>
    Array.from({ length: 9 }, (_, column) => ({
      name: `motion-${column}-${row}`,
      x: 0.2 + column * 0.075,
      y: 0.25 + row * 0.0833333333,
    })),
  ).flat(),
  // Edge probes make a solid-color cube falsify correctly: its interior is
  // intentionally unchanged by blur, while these pixels straddle the moving
  // silhouette against the black background.
  ...[0.35, 0.37, 0.39, 0.41, 0.52, 0.54, 0.56, 0.58].flatMap((x) =>
    [0.4, 0.5, 0.6].map((y) => ({ name: `edge-${x}-${y}`, x, y })),
  ),
];
const motionSampleNames = motionSamplePoints
  .map(({ name }) => name)
  .filter((name) => name !== 'corner');
const sampleEnergy = (sample) =>
  (sample ?? []).reduce((sum, channel) => sum + channel, 0);
const roiEnergy = (samples) =>
  motionSampleNames.reduce((sum, name) => sum + sampleEnergy(samples[name]), 0);
const nonBlackSampleCount = (samples) =>
  motionSampleNames.filter((name) => sampleEnergy(samples[name]) > 0.01).length;

const shaderManifestPath = resolve(appRoot, 'dist', 'shaders', 'manifest.json');
const shaderManifest = readFileSync(shaderManifestPath, 'utf8');
const shaderManifestUrl = `data:application/json,${encodeURIComponent(shaderManifest)}`;

// Dawn's adapter.info is intentionally small on several platforms. Native
// performance admission therefore records an independent host GPU fact and
// rejects CPU/software Vulkan devices (for example llvmpipe) before a timing
// verdict can be assembled. This is provenance, never a substitute for the
// real Dawn render/receipt path below. Avoid probing the host on ordinary
// correctness smokes so the provider check remains scoped to admission.
const physicalAdapterFacts = performanceAdmissionMode
  ? (() => {
    try {
      if (process.platform === 'darwin') {
        const provider = process.env.FORGEAX_GPU_PROVIDER ?? '';
        let metalFacts;
        try {
          const metalOutput = execFileSync('xcrun', ['swift', '-'], {
            input: MAC_METAL_PROBE_SOURCE,
            encoding: 'utf8',
            timeout: 30_000,
            stdio: ['pipe', 'pipe', 'ignore'],
          });
          metalFacts = parseMacMetalProbeOutput(metalOutput);
        } catch (error) {
          metalFacts = parseMacMetalProbeOutput('');
          metalFacts.reason = error instanceof Error ? error.message : String(error);
        }

        // Keep the inventory providers as diagnostics for headless sessions,
        // but never promote them when the direct Metal command failed. A
        // provider label without a live MTLDevice registry ID remains false.
        let fallbackFacts;
        try {
          const payload = JSON.parse(
            execFileSync('system_profiler', ['SPDisplaysDataType', '-json'], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            }),
          );
          const jsonFacts = parseMacSystemProfilerAdapterFacts(payload);
          const textFacts = parseMacSystemProfilerText(
            execFileSync('system_profiler', ['SPDisplaysDataType'], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            }),
          );
          const ioregFacts = parseMacIoregAdapterFacts(
            execFileSync('ioreg', ['-r', '-c', 'IOAccelerator', '-l'], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            }),
          );
          fallbackFacts = jsonFacts.physicalGpu
            ? jsonFacts
            : textFacts.physicalGpu
              ? textFacts
              : ioregFacts;
        } catch (error) {
          fallbackFacts = {
            source: 'host-probe',
            vendor: '',
            device: '',
            driver: '',
            deviceType: '',
            physicalGpu: false,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
        const directMetal = {
          ...metalFacts,
          provider,
          fallback: fallbackFacts,
          ...(metalFacts.physicalGpu !== true
            ? { reason: metalFacts.reason ?? 'Metal probe returned no physical device' }
            : {}),
        };
        return directMetal;
      }
      if (process.platform === 'linux') {
        const summary = execFileSync('vulkaninfo', ['--summary'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const read = (name) => summary.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, 'm'))?.[1]?.trim() ?? '';
        const vendor = read('vendorID');
        const device = read('deviceName');
        const driver = read('driverName');
        const deviceType = read('deviceType');
        const identity = `${vendor} ${device} ${driver} ${deviceType}`;
        const physicalGpu = Boolean(
          device &&
            driver &&
            /gpu/i.test(deviceType) &&
            !/(cpu|llvmpipe|swiftshader|software)/i.test(identity),
        );
        return {
          source: 'vulkaninfo',
          vendor,
          device,
          driver,
          deviceType,
          physicalGpu,
          ...(physicalGpu ? { accelerationAttestation: { kind: 'direct-device' } } : {}),
        };
      }
    } catch (error) {
      return {
        source: 'host-probe',
        vendor: '',
        device: '',
        driver: '',
        deviceType: '',
        physicalGpu: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      source: 'host-probe',
      vendor: '',
      device: '',
      driver: '',
      deviceType: '',
      physicalGpu: false,
      reason: `unsupported host platform: ${process.platform}`,
    };
    })()
  : {
      source: 'not-requested',
      vendor: '',
      device: '',
      driver: '',
      deviceType: '',
      physicalGpu: false,
    };

// Install dawn.node before importing engine modules. This is the same native
// adapter path used by hello-triangle; no CPU raster or RhiNull substitute is
// accepted as a visual result here.
const dawnBackendArgs = performanceAdmissionMode && process.platform === 'darwin' ? ['backend=metal'] : [];
const shim = await setupGpuShim({ width, height, rerunCmd, backendArgs: dawnBackendArgs });
const accelerationAttestation = deriveAppleParavirtualAttestation({
  provider: process.env.FORGEAX_GPU_PROVIDER ?? '',
  runnerFacts: runnerProvenance.runnerFacts,
  requestedBackend: shim.requestedBackend,
  isFallbackAdapter: shim.isFallbackAdapter,
  ioregFacts: physicalAdapterFacts.fallback,
});
const adapterFacts = {
  ...physicalAdapterFacts,
  requestedBackend: shim.requestedBackend,
  isFallbackAdapter: shim.isFallbackAdapter,
  ...(accelerationAttestation === undefined ? {} : { accelerationAttestation }),
};
const { World } = await import('@forgeax/engine-ecs');
await import('@forgeax/engine-runtime');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const assets = await import('@forgeax/engine-assets-runtime');
const render = await import('@forgeax/engine-render');
const scene = await import('@forgeax/engine-scene');

const world = new World();
// Keep the Dawn camera-pan carrier visually falsifiable. A single solid cube
// can move by a valid sub-pixel amount while every fixed probe remains in its
// unchanged interior. Alternating static bars put high-contrast boundaries
// across the same camera motion, matching the browser carrier's evidence
// shape without changing the renderer or falsifier threshold.
const cameraPanBarLayout = [
  { offset: -1.2, color: [0.95, 0.95, 0.95, 1], scaleX: 0.12 },
  { offset: -0.9, color: [0.04, 0.04, 0.04, 1], scaleX: 0.12 },
  { offset: -0.6, color: [0.95, 0.95, 0.95, 1], scaleX: 0.12 },
  { offset: -0.3, color: [0.04, 0.04, 0.04, 1], scaleX: 0.12 },
  { offset: 0, color: [0.95, 0.95, 0.95, 1], scaleX: 0.12 },
  { offset: 0.3, color: [0.04, 0.04, 0.04, 1], scaleX: 0.12 },
  { offset: 0.6, color: [0.95, 0.95, 0.95, 1], scaleX: 0.12 },
  { offset: 0.9, color: [0.04, 0.04, 0.04, 1], scaleX: 0.12 },
  { offset: 1.2, color: [0.95, 0.95, 0.95, 1], scaleX: 0.12 },
];
const carrierObjects = (visualCase === 'camera-pan' ? cameraPanBarLayout : [
  { offset: 0, color: [0.9, 0.3, 0.25, 1], scaleX: 1 },
]).map(({ offset, color, scaleX }) => {
  const material = world.allocSharedRef(
    'MaterialAsset',
    render.Materials.unlit([color[0], color[1], color[2], visualCase === 'reactive' ? 0.6 : color[3]]),
  );
  return world
    .spawn(
      {
        component: scene.Transform,
        data: { pos: [offset, 0, 0], quat: [0, 0, 0, 1], scale: [scaleX, 0.8, 1] },
      },
      { component: render.MeshFilter, data: { assetHandle: assets.HANDLE_CUBE } },
      { component: render.MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
});
const cube = carrierObjects[0];
world
  .spawn({
    component: render.DirectionalLight,
    data: {
      direction: [-0.4, -0.6, -0.7],
      color: [1, 1, 1],
      intensity: 1.2,
      // Keep the CI shadow graph alive but tiny: the falsifier uses unlit
      // bars, so one 64² cascade is enough to preserve the live light path
      // without the default 4096² software-GPU workload.
      castShadow: true,
      ...(falsifierLightweight ? { cascadeCount: 1, mapSize: 64 } : {}),
    },
  })
  .unwrap();
const camera = world
  .spawn(
    { component: scene.Transform, data: { pos: [0, 0, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    {
      component: render.Camera,
      data: {
        ...render.perspective({ fov: Math.PI / 3, aspect: width / height }),
        antialias: render.ANTIALIAS_TAA,
        ...(visualCase === 'taa-motion-blur-bloom'
          ? {
              tonemap: render.TONEMAP_ACES_FILMIC,
              bloom: render.BLOOM_ENABLED,
              bloomThreshold: 0.7,
              bloomIntensity: 0.35,
              bloomBlurRadius: 4,
            }
          : {}),
      },
    },
    {
      component: render.MotionBlur,
      data: {
        shutterAngle: 180,
        maxRadiusPixels: motionBlurMaxRadiusPixels,
        sampleCount: motionBlurSampleCount,
      },
    },
  )
  .unwrap();

const { renderer, errors } = await bootRenderer({
  createRenderer: constructRuntimeRendererHost,
  mockCanvas: shim.mockCanvas,
  shaderManifestUrl,
});
const resourceEvents = [];
const firstFrameResourceEvents = [];
const stableFrameResourceEvents = [];
const trackedDevice = shim.sharedDevice;
const restoreDeviceMethods = [];
if (trackedDevice !== undefined) {
  for (const [kind, method] of [
    ['texture', 'createTexture'],
    ['buffer', 'createBuffer'],
    ['pipeline', 'createRenderPipeline'],
  ]) {
    const original = trackedDevice[method];
    if (typeof original !== 'function') continue;
    restoreDeviceMethods.push([method, original]);
    trackedDevice[method] = (...args) => {
      resourceEvents.push({ kind, descriptor: args[0] });
      return original.apply(trackedDevice, args);
    };
  }
}
const attachment = renderer.attach(world);
if (!attachment.ok) throw attachment.error;
if (isolatedCaptureMode === 'off') {
  const removed = world.removeComponent(camera, render.MotionBlur);
  if (!removed.ok) throw removed.error;
}

const drawErrors = [];
const collectTiming = process.env.SMOKE_PERF_TIMING === '1' && !performanceAdmissionMode;
const onWallSamples = [];
const offWallSamples = [];
let captureMode = 'on';
let frame = 0;
const drawFrame = () => {
  const motionEnabled = !['static', 'reactive'].includes(visualCase);
  const position = motionEnabled ? Math.sin(frame * 0.08) * 0.8 + 0.5 : 0;
  const cubePosition = visualCase === 'cut-reset' && frame >= 90 ? -0.8 : position;
  const depth = visualCase === 'depth-edge' ? 0.6 : 0;
  if (visualCase !== 'camera-pan') {
    const moved = world.set(cube, scene.Transform, {
      pos: [cubePosition, 0, depth],
    });
    if (!moved.ok) throw moved.error;
  }
  if (visualCase === 'camera-pan') {
    const cameraMoved = world.set(camera, scene.Transform, {
      pos: [position * 0.35, 0, 4],
    });
    if (!cameraMoved.ok) throw cameraMoved.error;
  }
  const updated = world.update(1 / 60);
  if (!updated.ok) throw updated.error;
  frame += 1;
  const startedAt = collectTiming ? performance.now() : 0;
  const drawn = renderer.draw({
    leases: [attachment.value],
    camera: { lease: attachment.value },
    environment: { lease: attachment.value },
  });
  if (collectTiming) {
    (captureMode === 'on' ? onWallSamples : offWallSamples).push(performance.now() - startedAt);
  }
  const frameEvents = resourceEvents.slice(-resourceEvents.length);
  const newEvents = frameEvents.slice(drawFrame.lastEventCount ?? 0);
  drawFrame.lastEventCount = frameEvents.length;
  (frame === 1 ? firstFrameResourceEvents : stableFrameResourceEvents).push(...newEvents);
  if (!drawn.ok) drawErrors.push(drawn.error.code);
  return drawn;
};

const admissionSampleCount = 10;
const runAdmissionState = async () => {
  const samples = [];
  for (let index = 0; index < frames; index += 1) {
    const startedAt = performance.now();
    const drawn = drawFrame();
    if (!drawn.ok || drawn.value === undefined) {
      throw new Error(`performance-admission draw ${index} did not return a FrameReceipt`);
    }
    const completed = await drawn.value.completed;
    if (!completed.ok) throw completed.error;
    if (index >= frames - admissionSampleCount) samples.push(performance.now() - startedAt);
  }
  return { samples, inspection: renderer.inspect() };
};

if (performanceAdmissionMode) {
  const removed = world.removeComponent(camera, render.MotionBlur);
  if (!removed.ok) throw removed.error;
  frame = 0;
  captureMode = 'off';
  const off = await runAdmissionState();
  const added = world.addComponent(camera, {
    component: render.MotionBlur,
    data: {
      shutterAngle: 180,
      maxRadiusPixels: motionBlurMaxRadiusPixels,
      sampleCount: motionBlurSampleCount,
    },
  });
  if (!added.ok) throw added.error;
  frame = 0;
  captureMode = 'on';
  const on = await runAdmissionState();
  const passCounters = activePassCountersFromInspection;
  const buildDigest = process.env.SMOKE_BUILD_DIGEST ?? hashVitePayload(appRoot);
  const adapter = JSON.stringify(shim.adapterInfo ?? null);
  const performanceAdmissionAvailable =
    runnerProvenance.ok &&
    cpuAffinity.ok &&
    buildDigest !== undefined &&
    buildDigest.length > 0 &&
    adapter !== 'null' &&
    adapter !== '{}' &&
    off.inspection.capabilities.rgba16floatRenderable === true &&
    on.inspection.capabilities.rgba16floatRenderable === true &&
    off.inspection.capabilities.backendKind === 'webgpu' &&
    on.inspection.capabilities.backendKind === 'webgpu' &&
    frames >= 300 &&
    errors.length === 0 &&
    drawErrors.length === 0 &&
    qualifiedNativeFromAttestation(adapterFacts.accelerationAttestation, {
      physicalGpu: adapterFacts.physicalGpu,
      provider: adapterFacts.provider,
      requestedBackend: adapterFacts.requestedBackend,
      isFallbackAdapter: adapterFacts.isFallbackAdapter,
      runnerFacts: runnerProvenance.runnerFacts,
    });
  const report = {
    schemaVersion: 'hello-taa-dawn-smoke/1',
    testedRevision: performanceIdentity.testedRevision,
    sourceRevision: performanceIdentity.sourceRevision,
    source: {
      path: 'apps/hello/taa/src/main.ts',
      sha256: sha256File(resolve(appRoot, 'src', 'main.ts')),
    },
    visualCase,
    build: {
      command: 'pnpm --filter @forgeax/hello-taa build',
      packageSha256: sha256File(resolve(appRoot, 'package.json')),
    },
    buildDigest: buildDigest ?? null,
    buildArtifact: {
      root: 'apps/hello/taa/dist',
      indexSha256: sha256File(resolve(appRoot, 'dist', 'index.html')),
      shaderManifestSha256: sha256File(resolve(appRoot, 'dist', 'shaders', 'manifest.json')),
      sourcePayload: 'apps/hello/taa/index.html+src',
    },
    backend: on.inspection.capabilities.backendKind,
    resolution: { width, height },
    framesObserved: frames,
    performanceAdmission: performanceAdmissionAvailable
      ? {
          status: 'available',
          runnerName: runnerProvenance.runnerName,
          runnerClass: runnerProvenance.runnerClass,
          runnerFacts: runnerProvenance.runnerFacts,
          cpuAffinity: cpuAffinity.cpuAffinity,
          queue: runnerProvenance.runnerFacts.queue,
          execution: 'frame-receipt-complete',
          backend: 'webgpu',
          adapter,
          capabilities: {
            timestampQuery: on.inspection.capabilities.timestampQuery,
            rgba16floatRenderable: on.inspection.capabilities.rgba16floatRenderable,
          },
          adapterFacts,
          runtimeProbe: 'native-frame-receipt-v1',
        }
      : {
          status: 'unavailable',
          reason:
            !qualifiedNativeFromAttestation(adapterFacts.accelerationAttestation, {
              physicalGpu: adapterFacts.physicalGpu,
              provider: adapterFacts.provider,
              requestedBackend: adapterFacts.requestedBackend,
              isFallbackAdapter: adapterFacts.isFallbackAdapter,
              runnerFacts: runnerProvenance.runnerFacts,
            })
              ? 'performance-admission requires a direct device or an attested Apple paravirtual device'
              : 'performance-admission runtime probe did not receive a complete build or adapter identity',
        },
    timing: {
      source: 'wall-time',
      unit: 'ms',
      gpuTimestamp: false,
      warmupCount: frames - admissionSampleCount,
      sampleCount: admissionSampleCount,
      order: ['off', 'on'],
      offMs: off.samples,
      onMs: on.samples,
      passCounters: { off: passCounters(off.inspection), on: passCounters(on.inspection) },
    },
    temporalTarget: on.inspection.temporalTarget ?? null,
    adapterFacts,
    passes: [...on.inspection.perFramePassNames],
    errors,
    drawErrors,
    missingPasses: [],
  };
  const nativePerformanceOutput = process.env.FORGEAX_NATIVE_PERFORMANCE_OUTPUT;
  if (nativePerformanceOutput !== undefined) {
    writeFileSync(nativePerformanceOutput, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`[hello-taa] dawnSummary=${JSON.stringify(report)}`);
  try {
    await renderer.dispose();
  } finally {
    for (const [method, original] of restoreDeviceMethods) trackedDevice[method] = original;
    shim.sharedDevice?.destroy?.();
  }
  if (!performanceAdmissionAvailable) {
    console.error('[smoke] FAIL - performance-admission evidence is unavailable');
    process.exit(1);
  }
  console.log(`[smoke] PASS performance-admission Dawn, frames=${frames}, resolution=${width}x${height}`);
  process.exit(0);
}

if (isolatedCaptureMode !== undefined) {
  captureMode = isolatedCaptureMode;
  const isolatedCapture = await runFrameLoopAndReadback({
    draw: drawFrame,
    shim,
    width,
    height,
    smokeMinFrames: frames,
    smokeDurationMs: 0,
    rerunCmd,
    samplePoints: motionSamplePoints,
  });
  const isolatedInspection = renderer.inspect();
  const isolatedTemporal = isolatedInspection.temporal;
  const isolatedTarget = isolatedInspection.temporalTarget;
  const isolatedDescriptor = isolatedTarget?.descriptor;
  const isolatedStableCreation = {
    texture: stableFrameResourceEvents.filter((event) => event.kind === 'texture').length,
    buffer: stableFrameResourceEvents.filter((event) => event.kind === 'buffer').length,
    pipeline: stableFrameResourceEvents.filter((event) => event.kind === 'pipeline').length,
  };
  const isolatedRequiredPasses = ['standard-scene-data', 'taa-resolve', 'output-transform'];
  const isolatedMissingPasses = isolatedRequiredPasses.filter(
    (pass) => !isolatedInspection.perFramePassNames.includes(pass),
  );
  if (isolatedCaptureMode === 'on' && !isolatedInspection.perFramePassNames.includes('motion-blur')) {
    isolatedMissingPasses.push('motion-blur');
  }
  const isolatedReport = {
    schemaVersion: 'hello-taa-dawn-smoke/1',
    captureMode: isolatedCaptureMode,
    source: {
      path: 'apps/hello/taa/src/main.ts',
      sha256: sha256File(resolve(appRoot, 'src', 'main.ts')),
    },
    visualCase,
    build: {
      command: 'pnpm --filter @forgeax/hello-taa build',
      packageSha256: sha256File(resolve(appRoot, 'package.json')),
    },
    backend: isolatedInspection.capabilities.backendKind,
    resolution: { width, height },
    framesObserved: isolatedCapture.framesObserved,
    samplePointNames: Object.keys(isolatedCapture.pixelSamples).sort(),
    pixelSamples: isolatedCapture.pixelSamples,
    temporal: isolatedTemporal === undefined ? null : {
      status: isolatedTemporal.status,
      historyValid: isolatedTemporal.historyValid,
      historyAttempt: isolatedTemporal.historyAttempt,
      epoch: isolatedTemporal.epoch,
    },
    temporalTarget: isolatedTarget ?? null,
    creation: isolatedStableCreation,
    passes: [...isolatedInspection.perFramePassNames],
    errors,
    drawErrors,
    missingPasses: isolatedMissingPasses,
  };
  console.log(`[hello-taa] dawnSummary=${JSON.stringify(isolatedReport)}`);
  const isolatedFailed =
    isolatedReport.backend !== 'webgpu' ||
    isolatedReport.framesObserved !== frames ||
    nonBlackSampleCount(isolatedCapture.pixelSamples) === 0 ||
    errors.length > 0 ||
    drawErrors.length > 0 ||
    isolatedMissingPasses.length > 0 ||
    isolatedTemporal === undefined ||
    isolatedTemporal.status !== 'stable' ||
    isolatedTemporal.historyValid !== true ||
    isolatedDescriptor === undefined ||
    isolatedTarget?.identity !== 'standard-scene-temporal' ||
    isolatedTarget.producerId !== 'forgeax::standard::scene-data' ||
    isolatedTarget.targetCount !== 1 ||
    isolatedDescriptor.format !== 'rgba16float' ||
    isolatedDescriptor.width !== width ||
    isolatedDescriptor.height !== height ||
    isolatedDescriptor.sampleCount !== 1 ||
    isolatedStableCreation.texture !== 0 ||
    isolatedStableCreation.buffer !== 0 ||
    isolatedStableCreation.pipeline !== 0;
  try {
    await renderer.dispose();
  } finally {
    for (const [method, original] of restoreDeviceMethods) trackedDevice[method] = original;
    isolatedCapture.device.destroy?.();
  }
  delete globalThis.navigator.gpu;
  if (isolatedFailed) {
    console.error(`[smoke] FAIL - isolated ${isolatedCaptureMode} Dawn capture did not satisfy the temporal contract`);
    process.exit(1);
  }
  console.log(`[smoke] PASS isolated Dawn ${isolatedCaptureMode}, frames=${isolatedReport.framesObserved}`);
  process.exit(0);
}

const { framesObserved, pixelSamples, device } = await runFrameLoopAndReadback({
  draw: drawFrame,
  shim,
  width,
  height,
  smokeMinFrames: frames,
  smokeDurationMs: 0,
  rerunCmd,
  samplePoints: motionSamplePoints,
});
const onInspection = renderer.inspect();

// Re-render without MotionBlur so the same moving-rigid ROI proves a true
// on/off distinction on the real Dawn readback path.
const removed = world.removeComponent(camera, render.MotionBlur);
if (!removed.ok) throw removed.error;
// Reset the authored motion phase before the off capture. Otherwise the
// readbacks conflate the effect toggle with two different object positions.
frame = 0;
captureMode = 'off';
const { framesObserved: offFramesObserved, pixelSamples: offPixelSamples } = await runFrameLoopAndReadback({
  draw: drawFrame,
  shim,
  width,
  height,
  smokeMinFrames: frames,
  smokeDurationMs: 0,
  rerunCmd,
  samplePoints: motionSamplePoints,
});
const offInspection = renderer.inspect();
const onRoiEnergy = roiEnergy(pixelSamples);
const offRoiEnergy = roiEnergy(offPixelSamples);
const onNonBlackSamples = nonBlackSampleCount(pixelSamples);
const offNonBlackSamples = nonBlackSampleCount(offPixelSamples);
const offEnergy = offRoiEnergy + sampleEnergy(offPixelSamples.corner);
const roiDelta = motionSampleNames.reduce(
  (maxDelta, name) =>
    Math.max(
      maxDelta,
      (pixelSamples[name] ?? []).reduce(
        (sum, channel, index) =>
          sum + Math.abs(channel - (offPixelSamples[name]?.[index] ?? 0)),
        0,
      ),
    ),
  0,
);

const inspection = onInspection;
const semanticTemporalTarget = inspection.temporalTarget;
const temporalDescriptor = semanticTemporalTarget?.descriptor;
const stableCreation = {
  texture: stableFrameResourceEvents.filter((event) => event.kind === 'texture').length,
  buffer: stableFrameResourceEvents.filter((event) => event.kind === 'buffer').length,
  pipeline: stableFrameResourceEvents.filter((event) => event.kind === 'pipeline').length,
};
const temporal = inspection.temporal;
const requiredPasses = ['standard-scene-data', 'taa-resolve', 'motion-blur', 'output-transform'];
const missingPasses = requiredPasses.filter((pass) => !inspection.perFramePassNames.includes(pass));
const requiresRoiDifference = ['moving-rigid', 'camera-pan'].includes(visualCase);
const centerEnergy = onRoiEnergy;
const report = {
  schemaVersion: 'hello-taa-dawn-smoke/1',
  source: {
    path: 'apps/hello/taa/src/main.ts',
    sha256: sha256File(resolve(appRoot, 'src', 'main.ts')),
  },
  visualCase,
  build: {
    command: 'pnpm --filter @forgeax/hello-taa build',
    packageSha256: sha256File(resolve(appRoot, 'package.json')),
  },
  backend: inspection.capabilities.backendKind,
  framesObserved,
  pixelSamples,
  motionBlurFalsifier: {
    on: pixelSamples.ndcCenter,
    off: offPixelSamples.ndcCenter,
    onFramesObserved: framesObserved,
    offFramesObserved,
    samplePointCount: motionSampleNames.length,
    onRoiEnergy,
    offRoiEnergy,
    onNonBlackSamples,
    offNonBlackSamples,
    roiDelta,
    offEnergy,
    offOutputPass: offInspection.perFramePassNames.includes('output-transform'),
    threshold: 0.005,
    verdict: !requiresRoiDifference || (roiDelta > 0.005 && offEnergy > 0) ? 'pass' : 'fail',
  },
  temporal: temporal === undefined ? null : {
    status: temporal.status,
    historyValid: temporal.historyValid,
    historyAttempt: temporal.historyAttempt,
    epoch: temporal.epoch,
  },
  temporalTarget: semanticTemporalTarget ?? null,
  resourceProbe: {
    firstFrameTextures: firstFrameResourceEvents
      .filter((event) => event.kind === 'texture')
      .map((event) => ({
        format: event.descriptor?.format,
        width: event.descriptor?.size?.width,
        height: event.descriptor?.size?.height,
        sampleCount: event.descriptor?.sampleCount ?? 1,
        label: event.descriptor?.label ?? null,
      })),
  },
  creation: stableCreation,
  ...(collectTiming
    ? {
      timing: {
        source: 'wall-time',
        unit: 'ms',
        gpuTimestamp: false,
        onMs: onWallSamples,
        offMs: offWallSamples,
      },
      performanceAdmission: {
        status: 'unavailable',
        reason: 'Dawn correctness carrier is 200x150 and has no performance-admission adapter or pass timing producer',
      },
      }
    : {}),
  passes: [...inspection.perFramePassNames],
  errors,
  drawErrors,
  missingPasses,
};
console.log(`[hello-taa] dawnSummary=${JSON.stringify(report)}`);

const failed =
  inspection.capabilities.backendKind !== 'webgpu' ||
  framesObserved !== frames ||
  offFramesObserved !== frames ||
  onNonBlackSamples === 0 ||
  offNonBlackSamples === 0 ||
  errors.length > 0 ||
  drawErrors.length > 0 ||
  (requiresRoiDifference && roiDelta <= 0.005) ||
  offEnergy <= 0 ||
  missingPasses.length > 0 ||
  temporal === undefined ||
  temporal.status !== 'stable' ||
  temporal.historyValid !== true ||
  temporalDescriptor === undefined ||
  semanticTemporalTarget?.identity !== 'standard-scene-temporal' ||
  semanticTemporalTarget.producerId !== 'forgeax::standard::scene-data' ||
  semanticTemporalTarget.targetCount !== 1 ||
  temporalDescriptor.format !== 'rgba16float' ||
  temporalDescriptor.width !== width ||
  temporalDescriptor.height !== height ||
  temporalDescriptor.sampleCount !== 1 ||
  stableCreation.texture !== 0 ||
  stableCreation.buffer !== 0 ||
  stableCreation.pipeline !== 0;
try {
  await renderer.dispose();
} finally {
  for (const [method, original] of restoreDeviceMethods) trackedDevice[method] = original;
  device.destroy?.();
}
delete globalThis.navigator.gpu;
if (failed) {
  console.error(`[smoke] FAIL - TAA + MotionBlur Dawn readback did not satisfy the ${frames}-frame temporal contract`);
  console.error(`  rerun: ${rerunCmd}`);
  console.error('  hint: inspect renderer temporal status, pass trace, and Renderer.onError before changing the carrier');
  process.exit(1);
}
console.log(`[smoke] PASS Dawn TAA + MotionBlur, frames=${framesObserved}, roiEnergy=${centerEnergy.toFixed(6)}`);
