#!/usr/bin/env node

// Browser companion to smoke-dawn.mjs. Dawn owns the numerical Motion Blur
// falsifier; this carrier owns the dev-server pack path, WebGPU validation,
// compositor readback, and deterministic controls. Device-loss recovery is a
// separate provider-dependent lane and is not inferred from a browser crash.

import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { emitRequiredUnavailable } from './required-evidence.mjs';
import { compareDecodedRgb, validateMotionBlurTrace } from './smoke-browser-observations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const FRAME_FLOOR = 300;
const FALSIFIER_FRAME_FLOOR = 60;
const falsifierLightweight = process.env.FORGEAX_TAA_FALSIFIER_PROFILE === 'ci';
const MAX_VITE_READINESS_TIMEOUT_MS = 180_000;
const VITE_READINESS_TIMEOUT_MS = Math.min(
  Math.max(Number.parseInt(process.env.FORGEAX_TAA_VITE_READINESS_TIMEOUT_MS ?? '90000', 10) || 90_000, 1),
  MAX_VITE_READINESS_TIMEOUT_MS,
);
const frameFloor = falsifierLightweight ? FALSIFIER_FRAME_FLOOR : FRAME_FLOOR;
const requestedFrames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? `${frameFloor}`, 10);
const requiredFrames = Math.max(Number.isFinite(requestedFrames) ? requestedFrames : frameFloor, frameFloor);
const waitMs = Number.parseInt(process.env.SMOKE_BROWSER_WAIT_MS ?? '180000', 10);
const channel = process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome';
const headless = process.env.FORGEAX_BROWSER_HEADLESS !== '0';
const evidenceDir = process.env.SMOKE_EVIDENCE_DIR;
const visualCase = process.env.SMOKE_CASE ?? 'moving-rigid';
const evidencePrefix = process.env.SMOKE_EVIDENCE_PREFIX ?? visualCase;
const viewport = falsifierLightweight ? { width: 320, height: 180 } : { width: 960, height: 720 };
const captureLabel = (label) => `${evidencePrefix}-${label}`;
const expectMotionDifference = [
  'moving-rigid',
  'camera-pan',
  'depth-edge',
  'cut-reset',
  'taa-motion-blur-bloom',
].includes(visualCase);

class GateFailure extends Error {}

const execFileAsync = promisify(execFile);

const fail = (message) => {
  throw new GateFailure(message);
};

const vite = spawn('pnpm', ['--filter', '@forgeax/hello-taa', 'dev', '--', '--host', '127.0.0.1', '--port', '0'], {
  cwd: REPO_ROOT,
  env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '0' },
  // pnpm owns the Vite child. On POSIX, isolate the complete dev-server
  // tree so teardown cannot leave a grandchild holding this smoke open.
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteClosed = false;
let viteSpawnError;
const viteClose = new Promise((resolve) =>
  vite.once('close', (code, signal) => {
    viteClosed = true;
    resolve({ code, signal });
  }),
);
vite.once('error', (error) => {
  viteSpawnError = error;
});
let appUrl;
let serverOutput = '';
const observeServer = (chunk) => {
  serverOutput += String(chunk);
  const plain = serverOutput.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  appUrl ??= plain.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]?.replace(/\/$/, '');
};
vite.stdout.on('data', (chunk) => observeServer(chunk));
vite.stderr.on('data', (chunk) => observeServer(chunk));

let browser;
let context;
let page;
const pageErrors = [];
const consoleErrors = [];
const requestFailures = [];
const screenshots = [];

const frameIdOf = (state) =>
  typeof state?.frame === 'number' ? state.frame : state?.frame?.frameId;

const readInspection = async () => {
  const state = await page.evaluate(() => {
    const text = document.querySelector('#inspection')?.textContent ?? '';
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  });
  if (state === undefined) fail('TAA inspection never published valid JSON');
  return state;
};

const waitForFrame = async (minimum) => {
  await page.waitForFunction(
    (target) => {
      const text = document.querySelector('#inspection')?.textContent ?? '';
      try {
        const state = JSON.parse(text);
        const frameId = typeof state.frame === 'number' ? state.frame : state.frame?.frameId;
        return Number.isFinite(frameId) && frameId >= target;
      } catch {
        return false;
      }
    },
    minimum,
    { timeout: waitMs },
  );
  return readInspection();
};

const compositorReadback = async (label) => {
  const png = await page.locator('#app').screenshot({ type: 'png' });
  const sha256 = createHash('sha256').update(png).digest('hex');
  const pixels = await page.evaluate(async (encoded) => {
    const response = await fetch(`data:image/png;base64,${encoded}`);
    const bitmap = await createImageBitmap(await response.blob());
    const surface = document.createElement('canvas');
    surface.width = bitmap.width;
    surface.height = bitmap.height;
    const context = surface.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('Browser compositor PNG readback has no 2D decoder');
    context.drawImage(bitmap, 0, 0);
    const width = bitmap.width;
    const height = bitmap.height;
    const data = context.getImageData(0, 0, width, height).data;
    bitmap.close();
    const rgbBytes = new Uint8Array(width * height * 3);
    for (let sourceIndex = 0, targetIndex = 0; sourceIndex < data.length; sourceIndex += 4) {
      rgbBytes[targetIndex++] = data[sourceIndex] ?? 0;
      rgbBytes[targetIndex++] = data[sourceIndex + 1] ?? 0;
      rgbBytes[targetIndex++] = data[sourceIndex + 2] ?? 0;
    }
    const rgbDigest = await crypto.subtle.digest('SHA-256', rgbBytes);
    const rgbHash = Array.from(new Uint8Array(rgbDigest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    let nonBlack = 0;
    let sum = 0;
    let sumSquared = 0;
    let bottomSum = 0;
    let bottomSquared = 0;
    let bottomCount = 0;
    let alphaMin = 255;
    let alphaOpaque = 0;
    let sampledPixels = 0;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const index = (y * width + x) * 4;
        const alpha = data[index + 3] ?? 0;
        alphaMin = Math.min(alphaMin, alpha);
        if (alpha === 255) alphaOpaque += 1;
        sampledPixels += 1;
        const luma = (0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]) / 255;
        if (luma > 0.01) nonBlack += 1;
        sum += luma;
        sumSquared += luma * luma;
        if (y >= height * 0.5) {
          bottomSum += luma;
          bottomSquared += luma * luma;
          bottomCount += 1;
        }
      }
    }
    const count = Math.max(1, Math.ceil(width / 2) * Math.ceil(height / 2));
    const meanLuma = sum / count;
    const bottomMean = bottomSum / Math.max(1, bottomCount);
    return {
      width,
      height,
      rgbHash,
      nonBlack,
      meanLuma,
      stddevLuma: Math.sqrt(Math.max(0, sumSquared / count - meanLuma * meanLuma)),
      bottomMeanLuma: bottomMean,
      bottomStddevLuma: Math.sqrt(Math.max(0, bottomSquared / Math.max(1, bottomCount) - bottomMean * bottomMean)),
      alphaMin,
      alphaOpaque,
      sampledPixels,
    };
  }, png.toString('base64'));
  const evidence = {
    label,
    sha256,
    bytes: png.byteLength,
    ...(evidenceDir === undefined ? {} : { path: `${evidenceDir}/${label}.png` }),
    pixels,
  };
  if (evidenceDir !== undefined) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/${label}.png`, png);
  }
  screenshots.push(evidence);
  console.log(`[smoke-browser] ${label}: ${pixels.width}x${pixels.height} nonBlack=${pixels.nonBlack} luma=${pixels.meanLuma.toFixed(4)} bottomStddev=${pixels.bottomStddevLuma.toFixed(4)} pngSha256=${sha256} rgbSha256=${pixels.rgbHash}`);
  if (pixels.nonBlack === 0) fail(`${label} compositor readback is entirely black`);
  return evidence;
};

const assertOnState = (state, label) => {
  if (state.backend !== 'webgpu') fail(`${label}: backend=${state.backend ?? 'unknown'}, expected webgpu`);
  if (state.antialias !== 'taa') {
    fail(`${label}: antialias=${state.antialias ?? 'unknown'}, expected taa`);
  }
  if (state.temporal?.status !== 'stable' || state.temporal.historyValid !== true) {
    fail(`${label}: TAA history is not stable and valid: ${JSON.stringify(state.temporal)}`);
  }
  const motionBlurTrace = validateMotionBlurTrace(state, 'on');
  if (!motionBlurTrace.ok) fail(`${label}: Motion Blur trace is not active: ${JSON.stringify(motionBlurTrace)}`);
  const passes = state.passes ?? [];
  for (const pass of ['standard-scene-data', 'taa-resolve']) {
    if (!passes.includes(pass)) fail(`${label}: missing required pass ${pass}`);
  }
};

const assertNoUnexpectedErrors = () => {
  const unexpectedConsole = consoleErrors.filter(
    (message) => !message.includes('renderer error device-lost') && !message.includes('renderer error device-operation-failed'),
  );
  if (pageErrors.length > 0 || unexpectedConsole.length > 0 || requestFailures.length > 0) {
    fail(`browser errors: ${JSON.stringify({ pageErrors, consoleErrors: unexpectedConsole, requestFailures })}`);
  }
};

const unavailable = (reason, detail = {}) => {
  emitRequiredUnavailable({
    backend: 'browser',
    status: 'unavailable',
    reason,
    requiredProbe: `browser launch, ${requiredFrames} frames, compositor readback, validation, Motion Blur toggle, and pause/resume recovery`,
    ...detail,
  });
};

const signalVite = async (signal) => {
  if (vite.pid === undefined) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-vite.pid, signal);
    } else {
      const args = ['/PID', String(vite.pid), '/T'];
      if (signal === 'SIGKILL') args.push('/F');
      await execFileAsync('taskkill', args);
    }
  } catch (error) {
    if (error?.code !== 'ESRCH' && error?.code !== 128 && !viteClosed) throw error;
  }
};

const waitForViteClose = async (timeoutMs) => {
  return Promise.race([
    viteClose.then(() => true),
    sleep(timeoutMs).then(() => false),
  ]);
};

const stopVite = async () => {
  await signalVite('SIGTERM');
  if (await waitForViteClose(5_000)) return;
  console.error('[smoke-browser] vite process group did not close after SIGTERM; forcing SIGKILL');
  await signalVite('SIGKILL');
  if (!(await waitForViteClose(5_000))) {
    throw new Error('vite process-group cleanup incomplete after SIGKILL');
  }
};

const closeBrowser = async () => {
  if (browser === undefined) return;
  let cleanupError;
  const boundedClose = async (label, close) => {
    try {
      const closed = await Promise.race([
        Promise.resolve().then(close).then(() => true),
        sleep(10_000).then(() => false),
      ]);
      if (!closed) throw new Error(`${label} cleanup incomplete after 10s`);
    } catch (error) {
      cleanupError ??= error;
    }
  };
  // Close the page and context before Chromium. This drains page-owned
  // WebGPU resources explicitly; headed Chrome can otherwise keep its GPU
  // process alive after browser.close() and make the next smoke phase inherit
  // stale queue state.
  await boundedClose('page', () => page?.close());
  await boundedClose('context', () => context?.close());
  const currentBrowser = browser;
  await boundedClose('browser', () => currentBrowser.close());
  if (cleanupError !== undefined) {
    // Playwright exposes this connection only on its Node implementation. It
    // is a last-resort transport fence after the bounded public close path;
    // do not silently turn a real teardown failure into a green smoke.
    currentBrowser._connection?.close();
    await sleep(300);
    throw cleanupError;
  }
  page = undefined;
  context = undefined;
  browser = undefined;
};

let resultCode = 0;
let gatePassed = false;
try {
  const readinessStartedAt = Date.now();
  while (appUrl === undefined && viteSpawnError === undefined && !viteClosed && Date.now() - readinessStartedAt < VITE_READINESS_TIMEOUT_MS) await sleep(100);
  const readinessDiagnostics = JSON.stringify({
    elapsedMs: Date.now() - readinessStartedAt,
    pid: vite.pid ?? null,
    exitCode: vite.exitCode,
    signalCode: vite.signalCode,
    spawnError: viteSpawnError === undefined ? null : String(viteSpawnError),
    output: serverOutput.trim() || 'none',
  });
  if (viteSpawnError !== undefined) throw new Error(`Vite failed to start; diagnostics=${readinessDiagnostics}`);
  if (appUrl === undefined) throw new Error(`Vite did not publish a URL within ${VITE_READINESS_TIMEOUT_MS}ms; diagnostics=${readinessDiagnostics}`);
  console.log(`[smoke-browser] using ${appUrl} channel=${channel} headless=${headless}`);

  try {
    browser = await chromium.launch({
      headless,
      channel,
      args: [
        '--disable-features=MacAppCodeSignClone',
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
        '--use-vulkan=swiftshader',
        '--disable-vulkan-surface',
        '--ignore-gpu-blocklist',
        '--disable-gpu-driver-bug-workarounds',
        '--disable-dawn-features=disallow_unsafe_apis',
      ],
    });
  } catch (error) {
    unavailable(`chromium launch failed on channel ${channel}`, {
      detail: { error: error instanceof Error ? error.message : String(error) },
    });
    resultCode = 1;
  }

  if (browser !== undefined) {
    context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('favicon.ico')) consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
      if (!request.url().includes('/@vite/client')) requestFailures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`);
    });

    const profileQuery = falsifierLightweight ? '&taa-profile=ci' : '';
    await page.goto(`${appUrl}/?taa-smoke=1&taa-case=${encodeURIComponent(visualCase)}${profileQuery}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('#app', { timeout: 10_000 });
    const initial = await waitForFrame(requiredFrames);
    assertOnState(initial, `initial ${requiredFrames}-frame inspection`);
    const initialFrame = frameIdOf(initial);
    if (!Number.isFinite(initialFrame)) fail(`initial inspection has no numeric frame id: ${JSON.stringify(initial.frame)}`);
    const initialOn = await compositorReadback(captureLabel('motion-blur-on'));

    // Pause must freeze the frame counter, then resume must advance it again.
    // The feature toggle is exercised on a live frame because a paused App
    // intentionally does not submit a new render after a World mutation.
    await page.locator('#pause-toggle').click();
    await page.waitForFunction(() => document.querySelector('#control-status')?.textContent?.startsWith('Paused') === true, undefined, { timeout: 5000 });
    const paused = await readInspection();
    const pausedFrame = frameIdOf(paused);
    await sleep(300);
    const pausedAfterWait = await readInspection();
    if (paused.paused !== true || frameIdOf(pausedAfterWait) !== pausedFrame) {
      fail(`pause did not freeze the frame loop: before=${JSON.stringify(paused)} after=${JSON.stringify(pausedAfterWait)}`);
    }

    await page.locator('#pause-toggle').click();
    await page.waitForFunction(() => document.querySelector('#control-status')?.textContent?.startsWith('Running') === true, undefined, { timeout: 5000 });
    const resumedOnState = await waitForFrame(pausedFrame + 3);
    assertOnState(resumedOnState, 'post-resume inspection');
    const resumedOn = await compositorReadback(captureLabel('motion-blur-on-resumed'));

    // Toggle while running so the renderer submits a fresh frame with the
    // component removed. The Dawn lane owns the numerical same-motion-phase
    // falsifier; this browser lane proves the carrier's visible toggle path.
    await page.locator('#motion-blur-toggle').click();
    await page.waitForFunction(() => document.querySelector('#control-status')?.textContent?.includes('Motion Blur Off') === true, undefined, { timeout: 5000 });
    const offState = await waitForFrame(frameIdOf(resumedOnState) + 3);
    const offTrace = validateMotionBlurTrace(offState, 'off');
    if (!offTrace.ok) fail(`Motion Blur off frame published an invalid trace: ${JSON.stringify(offTrace)}`);
    const resumedOffFrame = frameIdOf(offState);
    const off = await compositorReadback(captureLabel('motion-blur-off'));

    await page.locator('#pause-toggle').click();
    await page.waitForFunction(() => document.querySelector('#control-status')?.textContent?.startsWith('Paused') === true, undefined, { timeout: 5000 });
    const pausedOff = await readInspection();
    const pausedOffFrame = frameIdOf(pausedOff);
    await sleep(300);
    if (frameIdOf(await readInspection()) !== pausedOffFrame) fail('pause after toggle did not freeze the frame loop');

    if (expectMotionDifference) {
      const decodedRgbComparison = compareDecodedRgb(resumedOn, off);
      if (!decodedRgbComparison.ok) {
        fail(`Motion Blur on/off decoded RGB is indistinguishable: ${JSON.stringify(decodedRgbComparison)}`);
      }
    }
    assertNoUnexpectedErrors();

    console.log(JSON.stringify({
      schemaVersion: 'hello-taa-browser-smoke/1',
      visualCase,
      backend: initial.backend,
      requiredFrames,
      recovery: { kind: 'pause-resume', pausedFrame, resumedFrame: resumedOffFrame, pausedOffFrame },
      controls: { pauseResume: true, motionBlurToggle: true, onOffDifferent: true },
      screenshots,
      temporal: initial.temporal,
      passes: initial.passes,
      initialState: {
        frame: initialFrame,
        antialias: initial.antialias,
        motionBlur: initial.motionBlur,
        temporal: initial.temporal,
        passes: initial.passes,
      },
      resumedState: {
        frame: frameIdOf(resumedOnState),
        antialias: resumedOnState.antialias,
        motionBlur: resumedOnState.motionBlur,
        temporal: resumedOnState.temporal,
        passes: resumedOnState.passes,
      },
      offState: {
        frame: frameIdOf(offState),
        motionBlur: offState.motionBlur,
        passes: offState.passes,
      },
      errors: { page: pageErrors, console: consoleErrors, requests: requestFailures },
      initialReadback: initialOn.pixels,
    }));
    gatePassed = true;
  }
} catch (error) {
  if (!(error instanceof GateFailure) && page !== undefined) {
    resultCode = 1;
    const diagnostic = await page
      .evaluate(() => ({
        url: location.href,
        gpu: typeof navigator.gpu,
        inspection: document.querySelector('#inspection')?.textContent ?? '',
        controls: document.querySelector('#control-status')?.textContent ?? '',
      }))
      .catch((diagnosticError) => ({ evaluateError: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError) }));
    console.error(`[smoke-browser] browser gate diagnostic: ${JSON.stringify({ diagnostic, pageErrors, consoleErrors, requestFailures })}`);
  } else {
    resultCode = error instanceof GateFailure ? 1 : 2;
  }
  console.error(`[smoke-browser] ${resultCode === 1 ? 'RED' : 'HARNESS ERROR'}: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  try {
    await closeBrowser();
  } catch (error) {
    resultCode = 2;
    console.error(`[smoke-browser] HARNESS ERROR: browser cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await stopVite();
  } catch (error) {
    resultCode = 2;
    console.error(`[smoke-browser] HARNESS ERROR: vite cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (gatePassed && resultCode === 0) {
  console.log(`[smoke-browser] PASS TAA browser WebGPU ${requiredFrames}-frame/readback/toggle/pause-resume gate`);
}
process.exitCode = resultCode;
