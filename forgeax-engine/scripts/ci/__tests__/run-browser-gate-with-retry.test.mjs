import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectRunnerPause } from '../../../apps/hello/multithreaded-execution/scripts/benchmark-statistics.mjs';
import { isRetryableOutput, runBrowserCommand } from '../run-browser-gate-with-retry.mjs';
import { withBrowserHeapLimit } from '../run-split-vitest-browser.mjs';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('browser child defaults to a 4 GiB heap without overriding a caller limit', () => {
  assert.equal(
    withBrowserHeapLimit({ NODE_OPTIONS: '--trace-warnings' }).NODE_OPTIONS,
    '--trace-warnings --max-old-space-size=4096',
  );
  assert.equal(
    withBrowserHeapLimit({ NODE_OPTIONS: '--max-old-space-size=8192 --trace-warnings' })
      .NODE_OPTIONS,
    '--max-old-space-size=8192 --trace-warnings',
  );
  assert.equal(withBrowserHeapLimit({}).NODE_OPTIONS, '--max-old-space-size=4096');
});

test('timed-out browser child reclaims its descendant without signalling the parent', {
  skip: process.platform === 'win32',
}, async () => {
  const childScript = [
    "const { spawn } = require('node:child_process');",
    "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'process.stdout.write(String(descendant.pid));',
    'setInterval(() => {}, 1000);',
  ].join('');
  const result = await runBrowserCommand([process.execPath, '-e', childScript], {
    timeoutMs: 100,
    timeoutGraceMs: 100,
    label: 'contract-descendant-cleanup',
  });
  const descendantPid = Number(result.output.match(/\d+/)?.[0]);

  assert.equal(result.status, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.pid > 0, true);
  assert.equal(result.elapsedMs >= 100, true);
  assert.match(result.output, /timeout label=contract-descendant-cleanup/);
  assert.equal(Number.isInteger(descendantPid) && descendantPid > 0, true);
  await wait(100);
  assert.equal(processIsAlive(descendantPid), false);
});

test('Vitest retries only declared browser-runner instability markers', () => {
  assert.equal(
    isRetryableOutput(
      'vitest',
      '[learn-render] bootstrap inconclusive within 60s (no SUT error, not complete); -> runner instability, rerun',
    ),
    true,
  );
  assert.equal(isRetryableOutput('vitest', 'AssertionError: expected 1 to be 2'), false);
  assert.equal(isRetryableOutput('vitest', 'Browser connection was closed'), true);
  assert.equal(
    isRetryableOutput(
      'vitest',
      'ForgeaX linear HDR observation failed: readback-failed (A valid external Instance reference no longer exists.)',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'Error: ForgeaX linear HDR observation failed: observation-unavailable',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'apps/learn-render/5.advanced-lighting/6.hdr/src/__tests__/onerror-gate.browser.test.ts\n' +
        'Error: Test timed out in 60000ms.',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'apps/learn-render/5.advanced-lighting/6.hdr/src/__tests__/onerror-gate.browser.test.ts\n' +
        'Error: [learn-render bootstrap] timed out after 55000ms; ' +
        'stage=hdr.assets.catalog.resolve.start; stageElapsedMs=52070',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'apps/learn-render/5.advanced-lighting/6.hdr/src/__tests__/onerror-gate.browser.test.ts\n' +
        'Error: [learn-render bootstrap] timed out after 55000ms; ' +
        'stage=hdr.assets.loadByGuid; stageElapsedMs=52070',
    ),
    false,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'apps/learn-render/5.advanced-lighting/7.bloom/src/__tests__/onerror-gate.browser.test.ts\n' +
        'Error: [learn-render bootstrap] timed out after 55000ms; ' +
        'stage=waitForLearnRenderTestBootstrap; stageElapsedMs=55001',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'apps/learn-render/5.advanced-lighting/7.bloom/src/__tests__/onerror-gate.browser.test.ts\n' +
        'Error: [learn-render bootstrap] timed out after 55000ms; ' +
        'stage=bloom.assets.catalog.resolve.start; stageElapsedMs=55001',
    ),
    false,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'apps/learn-render/6.pbr/4.render-target-reflection/src/__tests__/onerror-gate.browser.test.ts\n' +
        'Error: [learn-render bootstrap] timed out after 25000ms; ' +
        'stage=waitForLearnRenderTestBootstrap; stageElapsedMs=25001',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'apps/learn-render/6.pbr/4.render-target-reflection/src/__tests__/onerror-gate.browser.test.ts\n' +
        'Error: [learn-render bootstrap] timed out after 25000ms; ' +
        'stage=render-target-reflection.assets.load; stageElapsedMs=25001',
    ),
    false,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'apps/learn-render/5.advanced-lighting/8.deferred-shading/src/__tests__/onerror-gate.browser.test.ts\n' +
        'Error: [learn-render bootstrap] timed out after 55000ms; ' +
        'stage=waitForLearnRenderTestBootstrap; stageElapsedMs=55001',
    ),
    false,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'apps/learn-render/5.advanced-lighting/9.ssao/src/__tests__/onerror-gate.browser.test.ts\n' +
        '[forgeax] import failed for backpack (HTTP 503): import-failed -  | hint: retry\n' +
        'loadByGuid<SceneAsset>(backpack) failed: asset-not-imported',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'apps/learn-render/5.advanced-lighting/9.ssao/src/__tests__/onerror-gate.browser.test.ts\n' +
        'Error: Test timed out in 60000ms.',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'apps/learn-render/5.advanced-lighting/9.ssao/src/__tests__/onerror-gate.browser.test.ts\n' +
        '[forgeax] import failed for backpack (HTTP 422): import-failed\n' +
        'loadByGuid<SceneAsset>(backpack) failed: asset-not-imported',
    ),
    false,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'apps/learn-render/5.advanced-lighting/9.ssao/src/__tests__/onerror-gate.browser.test.ts\n' +
        'Error: Test timed out in 60001ms.',
    ),
    false,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'apps/learn-render/5.advanced-lighting/8.deferred-shading/src/__tests__/onerror-gate.browser.test.ts\n' +
        '[forgeax] import failed for backpack (HTTP 503): import-failed\n' +
        'loadByGuid<SceneAsset>(backpack) failed: asset-not-imported',
    ),
    false,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'apps/learn-render/6.pbr/2.ibl-irradiance/src/__tests__/onerror-gate.browser.test.ts\n' +
        'Error: Test timed out in 60000ms.',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'apps/learn-render/6.pbr/3.ibl-specular/src/__tests__/onerror-gate.browser.test.ts\n' +
        'Error: [learn-render bootstrap] timed out after 85000ms; ' +
        'stage=waitForLearnRenderTestBootstrap; stageElapsedMs=85000',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'apps/learn-render/5.advanced-lighting/5.parallax-mapping/src/__tests__/onerror-gate.browser.test.ts\n' +
        'Error: Test timed out in 60000ms.',
    ),
    false,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'packages/app/__tests__/worker-resize.browser.test.ts\n' +
        'AssertionError: app-execution-deadline-exceeded: phase=handshake; expected false to be true',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'packages/app/__tests__/worker-resize.browser.test.ts\n' +
        'AssertionError: app-execution-deadline-exceeded: phase=frame; expected false to be true',
    ),
    false,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'packages/app/__tests__/worker-resize.browser.test.ts\n' +
        'AssertionError: expected false to be true',
    ),
    false,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'packages/net-websocket/__tests__/endpoint-contract.browser.test.ts\n' +
        '× browser WebSocket endpoint > Endpoint behavior contract > emits peer-disconnected event on close\n' +
        'Error: Timed out waiting for 1 peer-disconnected event(s)',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'packages/net-websocket/__tests__/endpoint-contract.browser.test.ts\n' +
        '× browser WebSocket endpoint > Endpoint behavior contract > sends to disconnected peer returns connection-closed\n' +
        'Error: Timed out waiting for 1 peer-disconnected event(s)',
    ),
    false,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'packages/net-websocket/__tests__/endpoint-contract.browser.test.ts\n' +
        '× browser WebSocket endpoint > Endpoint behavior contract > emits peer-disconnected event on close\n' +
        'Error: Timed out waiting for 1 peer-connected event(s)',
    ),
    false,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'packages/net-websocket/__tests__/browser-endpoint.browser.test.ts\n' +
        '× emits peer-disconnected event on close\n' +
        'Error: Timed out waiting for 1 peer-disconnected event(s)',
    ),
    false,
  );
});

test('RHI-debug retries only bounded external capture instability markers', () => {
  assert.equal(
    isRetryableOutput(
      'rhi-debug',
      'capture off failed before materializing v7 tape: {"ok":false,"error":{"code":"capture-timeout"}}',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'rhi-debug',
      '[learn-render 5.3.3 csm] RED -- capture/live-readback threw: ' +
        'captureFrame failed: {"code":"capture-snapshot-failed","detail":{"stage":"snapshot",' +
        '"cause":"OperationError: A valid external Instance reference no longer exists."}}',
    ),
    true,
  );
  assert.equal(isRetryableOutput('rhi-debug', 'AssertionError: paired captures differ'), false);
});

test('RHI-debug retries only the dedicated CSM adapter-acquisition stall', () => {
  const csmStall =
    '[learn-render 5.3.3 csm] RED -- capture hook readiness timed out after 90000ms: ' +
    '__prepareCsmCapture, __captureCsm; diagnostics=' +
    '{"rendererBootstrap":{"name":"adapter-request-start"},"shaderManifest":null,' +
    '"captureHooks":{"__prepareCsmCapture":false,"__captureCsm":false}}';
  assert.equal(isRetryableOutput('rhi-debug', csmStall), true);
  assert.equal(
    isRetryableOutput(
      'rhi-debug',
      csmStall.replace('"shaderManifest":null', '"shaderManifest":{}'),
    ),
    false,
  );
  assert.equal(
    isRetryableOutput(
      'rhi-debug',
      csmStall.replace('"name":"adapter-request-start"', '"name":"adapter-request-end"'),
    ),
    false,
  );
  assert.equal(
    isRetryableOutput(
      'rhi-debug',
      csmStall.replace('[learn-render 5.3.3 csm]', '[learn-render other]'),
    ),
    false,
  );
  assert.equal(
    isRetryableOutput('rhi-debug', csmStall.replace('after 90000ms', 'after 60000ms')),
    false,
  );
  assert.equal(
    isRetryableOutput('rhi-debug', csmStall.replace('"__captureCsm":false', '"__captureCsm":true')),
    false,
  );
  assert.equal(
    isRetryableOutput(
      'rhi-debug',
      csmStall.replace('"name":"adapter-request-start"', '"name":"device-request-start"'),
    ),
    false,
  );
});

test('the production benchmark retries only declared runner instability', () => {
  assert.equal(
    isRetryableOutput(
      'benchmark',
      '[multithreaded benchmark] runner pause detected; runner instability: [{"tier":"shared"}]',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'benchmark',
      '[multithreaded benchmark] browser readiness timeout; runner instability: {"tier":"engine-worker"}',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'benchmark',
      '[multithreaded benchmark] browser readiness failed: {"diagnostic":{"report":{"fault":{"detail":{"phase":"frame"}}},"pageErrors":[]}}',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'benchmark',
      '[multithreaded benchmark] browser readiness failed: {"diagnostic":{"report":{"fault":{"detail":{"phase":"frame"}}},"pageErrors":["page error"]}}',
    ),
    false,
  );
  assert.equal(
    isRetryableOutput('benchmark', '[multithreaded benchmark] performance verdict failed'),
    false,
  );
  assert.equal(isRetryableOutput('benchmark', 'shared page errors: device lost'), false);
});

test('the multithread smoke retries only a clean shared frame deadline', () => {
  assert.equal(
    isRetryableOutput(
      'multithread-smoke',
      'apps/hello/multithreaded-execution/scripts/smoke-browser.mjs:77\n' +
        'Error: shared did not become ready: TimeoutError: page.waitForFunction: Timeout 30000ms exceeded.; ' +
        'output={"fault":{"code":"app-execution-deadline-exceeded","detail":{"phase":"frame","timeoutMs":5000}}}; ' +
        'errors=;',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'multithread-smoke',
      'apps/hello/multithreaded-execution/scripts/smoke-browser.mjs:77\n' +
        'output={"fault":{"code":"app-execution-deadline-exceeded","detail":{"phase":"frame","timeoutMs":5000}}}; ' +
        'errors=page error',
    ),
    false,
  );
  assert.equal(
    isRetryableOutput(
      'multithread-smoke',
      'apps/hello/multithreaded-execution/scripts/smoke-browser.mjs:77\n' +
        'output={"fault":{"code":"app-execution-deadline-exceeded","detail":{"phase":"handshake","timeoutMs":10000}}}; ' +
        'errors=;',
    ),
    false,
  );
});

test('runner pause detection isolates host spikes without masking sustained slowness', () => {
  const stable = detectRunnerPause(Array.from({ length: 240 }, () => 20));
  assert.equal(stable.detected, false);

  const isolated = detectRunnerPause([1000, ...Array.from({ length: 239 }, () => 20)]);
  assert.equal(isolated.detected, true);
  assert.equal(isolated.maximumMs, 1000);

  const sustained = detectRunnerPause(Array.from({ length: 240 }, () => 300));
  assert.equal(sustained.detected, false);
});
