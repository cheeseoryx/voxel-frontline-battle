import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
const realGpuWorkflow = readFileSync(
  resolve('.github/workflows/gpu-pass-timing-real-gpu.yml'),
  'utf8',
);
const benchWorkflow = readFileSync(resolve('.github/workflows/bench.yml'), 'utf8');
const packageManifest = readFileSync(resolve('package.json'), 'utf8');
const vitestConfig = readFileSync(resolve('vitest.config.ts'), 'utf8');
const entityVisibilityDawnTest = readFileSync(
  resolve('apps/hello/entity-visibility/__tests__/visibility.dawn.test.ts'),
  'utf8',
);
const pointLightShadowDawnTest = readFileSync(
  resolve('packages/runtime/src/__tests__/point-light-shadow.dawn.test.ts'),
  'utf8',
);
const dawnCompactRoster = readFileSync(resolve('scripts/ci/dawn-compact-roster.mjs'), 'utf8');
const shaderPluginSource = readFileSync(
  resolve('packages/vite-plugin-shader/src/index.ts'),
  'utf8',
);
const pixelParityBench = readFileSync(resolve('scripts/bench/pixel-parity.mjs'), 'utf8');
const colorLightingBench = readFileSync(resolve('scripts/bench/color-lighting-parity.mjs'), 'utf8');
const shadowFieldsObservable = readFileSync(
  resolve('packages/runtime/src/__tests__/shadow-fields-observable.dawn.test.ts'),
  'utf8',
);
const browserVitestConfig = readFileSync(resolve('vitest-browser-project.ts'), 'utf8');
const browserOnerrorGate = readFileSync(resolve('apps/shared/src/onerror-gate.ts'), 'utf8');
const browserInstancingAcceptance = readFileSync(
  resolve('apps/parity/instancing-static/src/__tests__/instances.browser.test.ts'),
  'utf8',
);
const browserGpuDrivenView = readFileSync(
  resolve('packages/render/src/__tests__/gpu-driven-view.browser.test.ts'),
  'utf8',
);
const browserDirectLight = readFileSync(
  resolve('apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.browser.test.ts'),
  'utf8',
);
const browserProvider = readFileSync(resolve('vitest-browser-provider.ts'), 'utf8');
const uploadWithRetry = readFileSync(
  resolve('.github/actions/upload-artifact-with-retry/action.yml'),
  'utf8',
);
const uploadOptionalArtifact = readFileSync(
  resolve('.github/actions/upload-optional-artifact/action.yml'),
  'utf8',
);
const mesaVulkanAction = readFileSync(
  resolve('.github/actions/install-mesa-vulkan-drivers/action.yml'),
  'utf8',
);
const dawnPrepareAction = readFileSync(
  resolve('.github/actions/prepare-dawn-device-limits/action.yml'),
  'utf8',
);
test('coverage-pnpm splits Vitest coverage into bounded fresh processes', () => {
  const coverageStart = workflow.indexOf('  coverage-pnpm:\n');
  const coverage = workflow.slice(
    coverageStart,
    workflow.indexOf('  coverage-perf:\n', coverageStart),
  );
  assert.match(coverage, /timeout-minutes: 45/);
  assert.match(coverage, /node scripts\/ci\/run-split-vitest-coverage\.mjs/);
  assert.match(
    coverage,
    /--group-size=8[\s\S]*?--group-concurrency=auto[\s\S]*?--max-workers=1[\s\S]*?--skip-typecheck/,
  );
  const coverageRunner = readFileSync(resolve('scripts/ci/run-split-vitest-coverage.mjs'), 'utf8');
  assert.match(coverageRunner, /--typecheck\.only/);
  assert.match(coverageRunner, /options\.coverage && options\.typecheck/);
  assert.match(coverageRunner, /--typecheck\.enabled=false[\s\S]*?--coverage/);
  assert.doesNotMatch(workflow, /heavy-(?:32g|256g)/i);
});

test('Bun package build uses the dependency graph instead of workspace enumeration order', () => {
  const portabilityStart = workflow.indexOf('  portability-bun:\n');
  assert.notEqual(portabilityStart, -1);
  const portability = workflow.slice(portabilityStart);
  assert.match(portability, /FORGEAX_PACKAGE_BUILD_RUNNER: bun/);
  assert.match(portability, /FORGEAX_BUILD_NO_TASK_CACHE: '1'/);
  assert.match(portability, /run: node scripts\/build-packages\.mjs/);
  assert.doesNotMatch(portability, /bun run --filter '\.\/packages\/\*'/);
});

test('vitest-browser splits the full browser suite into bounded fresh processes', () => {
  assert.match(packageManifest, /run-split-vitest-browser\.mjs --group-size=8 --max-workers=1/);
  const browserRunner = readFileSync(resolve('scripts/ci/run-split-vitest-browser.mjs'), 'utf8');
  assert.match(browserRunner, /--project=browser/);
  assert.match(browserRunner, /--maxWorkers=\$\{maxWorkers\}/);
  assert.match(browserRunner, /--shard-count/);
  assert.match(browserRunner, /selectedGroups/);
  assert.match(browserRunner, /runBrowserCommand/);
  assert.match(browserRunner, /browserGroupTimeoutMs = 300_000/);
  assert.match(browserRunner, /timeoutMs: groupTimeoutMs/);
  assert.match(browserRunner, /directLightBrowserGroupTimeoutMs = 420_000/);
  assert.match(browserRunner, /instancingStaticBrowserGroupTimeoutMs = 900_000/);
  assert.match(browserRunner, /instancingStaticBrowserFile/);
  assert.match(
    browserRunner,
    /group\.includes\(instancingStaticBrowserFile\)[\s\S]*?instancingStaticBrowserGroupTimeoutMs/,
  );
  assert.match(browserRunner, /withBrowserHeapLimit/);
  assert.match(browserRunner, /max-old-space-size=4096/);
  assert.match(browserRunner, /isRetryableOutput\('vitest', first\.output\)/);
  assert.equal(
    existsSync(
      resolve(
        'apps/learn-render/4.advanced-opengl/9.instancing/src/__tests__/onerror-gate.browser.test.ts',
      ),
    ),
    false,
  );
  assert.match(
    workflow,
    /Run authoritative Dawn roster shard[\s\S]*?--shard-index \$\{\{ matrix\.group \}\}/,
  );
  assert.doesNotMatch(workflow, /run-hello-learn-render-smoke-roster\.mjs/);
  assert.match(browserRunner, /const preview = files\.filter/);
  assert.match(browserRunner, /FORGEAX_BROWSER_ENTITY_VISIBILITY: '0'/);
  assert.match(browserRunner, /file\.startsWith\('apps\/preview\/'\)/);
  assert.match(browserRunner, /FORGEAX_BROWSER_PACK_READINESS: producerReadiness/);
  assert.match(browserRunner, /excludedDirectories = new Set\(\[.*artifacts/);
  assert.match(
    browserVitestConfig,
    /process\.env\.FORGEAX_BROWSER_PACK_READINESS === 'before-consume'[\s\S]*'on-demand'/,
  );
  assert.match(browserVitestConfig, /'\*\*\/artifacts\/\*\*'/);
  assert.doesNotMatch(workflow, /heavy-(?:32g|256g)/i);
  const browserShardStart = workflow.indexOf('  vitest-browser-shard:\n');
  const browserShard = workflow.slice(
    browserShardStart,
    workflow.indexOf('  vitest-browser:\n', browserShardStart),
  );
  assert.match(browserShard, /NODE_OPTIONS: --max-old-space-size=4096/);
  assert.match(browserShard, /--group-size=16/);
  assert.match(browserShard, /matrix:\n(?:\s*#.*\n)*\s+shard: \[0, 1, 2, 3\]/);
  assert.match(browserShard, /--shard-index=\$\{\{ matrix\.shard \}\}/);
  assert.match(browserShard, /--shard-count=4/);
  assert.match(browserShard, /FORGEAX_BROWSER_CI_LIGHTWEIGHT: '1'/);
  assert.match(browserShard, /FORGEAX_BROWSER_FIXED_SMOKE: '1'/);
  assert.match(browserShard, /if: matrix\.shard == 0/);
});

test('browser CI lightweight mode reduces redundant waits while Dawn keeps long evidence windows', () => {
  assert.match(browserOnerrorGate, /FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' \? 300 : 500/);
  assert.match(browserInstancingAcceptance, /FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' \? 120 : 600/);
  assert.match(
    browserGpuDrivenView,
    /FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1'[\s\S]*\?\s*60\s*:\s*300/,
  );
  assert.match(browserDirectLight, /FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' \? 24 : 60/);

  const gpuDrivenDawn = readFileSync(
    resolve('packages/render/src/__tests__/gpu-driven-view.dawn.test.ts'),
    'utf8',
  );
  assert.match(gpuDrivenDawn, /runGpuDrivenViewLifecycleEvidence\(\)[\s\S]*frames: 300/);
  const directLightDawn = readFileSync(
    resolve('apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.dawn.test.ts'),
    'utf8',
  );
  assert.match(directLightDawn, /FORGEAX_DAWN_LIGHTWEIGHT === '1' \? 8 : 300/);
});

test('directional CSM browser smoke is an isolated producer with an explicit retry contract', () => {
  const csmStart = workflow.indexOf('  directional-csm-browser:\n');
  const csm = workflow.slice(csmStart, workflow.indexOf('  vitest-browser-shard:\n', csmStart));
  assert.notEqual(csmStart, -1);
  assert.match(csm, /needs: \[build-artifacts, shared-app-inputs, post-merge-gate\]/);
  assert.match(csm, /timeout-minutes: 30/);
  assert.match(csm, /--consumer directional-csm-browser --root \./);
  assert.match(csm, /needs\.shared-app-inputs\.outputs\.shared_artifact_id/);
  assert.match(csm, /unpack-shared-app-inputs\.mjs/);
  assert.match(csm, /FORGEAX_SHARED_APP_INPUTS_MANIFEST:/);
  assert.match(csm, /--shared-input-manifest shared-app-inputs\/manifest\.json/);
  assert.match(csm, /--input-fingerprint .*needs\.shared-app-inputs\.outputs\.input_fingerprint/);
  assert.match(csm, /run-browser-gate-with-retry\.mjs[\s\S]*?--mode=rhi-debug/);
  assert.match(
    csm,
    /pnpm --filter '@forgeax\/app-learn-render-5-advanced-lighting-3-3-csm'[\s\S]*?smoke:browser/,
  );
  assert.match(csm, /FORGEAX_CHROME_CHANNEL: chrome-beta/);
  assert.match(csm, /xvfb-run -a env FORGEAX_BROWSER_HEADLESS=0/);

  const shardStart = workflow.indexOf('  vitest-browser-shard:\n');
  const shard = workflow.slice(shardStart, workflow.indexOf('  vitest-browser:\n', shardStart));
  assert.doesNotMatch(shard, /app-learn-render-5-advanced-lighting-3-3-csm/);

  const aggregateStart = workflow.indexOf('  vitest-browser:\n');
  const aggregate = workflow.slice(
    aggregateStart,
    workflow.indexOf('  shared-inputs-browser:\n', aggregateStart),
  );
  assert.match(aggregate, /vitest-browser-shard, directional-csm-browser/);
  assert.match(aggregate, /needs\.vitest-browser-shard\.result.*success/);
  assert.match(aggregate, /needs\.directional-csm-browser\.result.*success/);
});

test('headed Vitest Chromium pages use a background target on every host without changing headless policy', () => {
  assert.match(browserVitestConfig, /playwrightWithBackgroundPages/);
  assert.match(vitestConfig, /playwrightWithBackgroundPages/);
  assert.match(browserProvider, /Target\.createTarget/);
  assert.match(browserProvider, /background: true/);
  assert.doesNotMatch(browserProvider, /process\.platform/);
  assert.match(browserProvider, /project\.config\.browser\.headless === false/);
  assert.match(browserProvider, /FORGEAX_BROWSER_BACKGROUND/);
  assert.match(
    browserVitestConfig,
    /headless: process\.env\.FORGEAX_BROWSER_HEADLESS !== '0' && !!process\.env\.CI/,
  );
  assert.match(vitestConfig, /headless: !!process\.env\.CI/);
});

test('Dawn direct-light matrix is excluded from the named project and opted in by its partition runner', () => {
  assert.match(
    vitestConfig,
    /const DIRECT_LIGHT_DAWN_TEST_FILE[\s\S]*apps\/parity\/color-lighting\/cases\/direct-light\/__tests__\/direct-light\.dawn\.test\.ts/,
  );
  assert.match(vitestConfig, /FORGEAX_DAWN_PARTITION/);
  assert.match(
    vitestConfig,
    /\.\.\.\(RUNNING_DIRECT_LIGHT_PARTITION \? \[\] : \[DIRECT_LIGHT_DAWN_TEST_FILE\]\)/,
  );
  const directLightRunner = readFileSync(resolve('scripts/ci/run-direct-light-dawn.mjs'), 'utf8');
  assert.match(directLightRunner, /FORGEAX_DAWN_PARTITION: partition\.id/);
  const directLightTest = readFileSync(
    resolve('apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.dawn.test.ts'),
    'utf8',
  );
  assert.match(
    directLightTest,
    /const SPOT_SHADOW_CAPTURE_FRAMES = process\.env\.FORGEAX_DAWN_LIGHTWEIGHT === ['"]1['"] \? 8 : 300;/,
    'fresh direct-light partitions must use the bounded 8-frame producer warmup',
  );
  assert.match(directLightTest, /SPOT_SHADOW_HEAVY_TEST_TIMEOUT_MS[\s\S]*600_000/);
  assert.match(
    directLightTest,
    /captures independent HDRP producer evidence for every required case[\s\S]*\}, SPOT_SHADOW_HEAVY_TEST_TIMEOUT_MS\);/,
    'the HDRP producer roster must use the partition-aware heavy-test timeout',
  );
  assert.equal(
    (directLightTest.match(/\}, SPOT_SHADOW_HEAVY_TEST_TIMEOUT_MS\);/g) ?? []).length,
    4,
  );
});

test('Dawn device-limit preload is installed only after checkout', () => {
  assert.match(dawnPrepareAction, /GITHUB_WORKSPACE.*patch-dawn-device-limits\.mjs/);
  assert.match(dawnPrepareAction, /GITHUB_PATH/);
  assert.match(dawnPrepareAction, /printf 'PATH=%s\\n'/);
  assert.match(dawnPrepareAction, /BASH_ENV/);
  assert.match(dawnPrepareAction, /GITHUB_ENV/);
  assert.match(dawnPrepareAction, /NODE_OPTIONS/);
  assert.match(dawnPrepareAction, /exec "\$real_node" "\$@"/);
  assert.match(dawnPrepareAction, /filter_dawn_limit_warnings/);
  assert.match(
    dawnPrepareAction,
    /maxDynamicUniformBuffersPerPipelineLayout artificially reduced from \[0-9\]\+ to \[0-9\]\+/,
  );
  assert.match(
    dawnPrepareAction,
    /maxDynamicStorageBuffersPerPipelineLayout artificially reduced from \[0-9\]\+ to \[0-9\]\+/,
  );
  assert.match(dawnPrepareAction, /FORGEAX_DAWN_FILTER_LIMIT_WARNINGS/);
  for (const jobName of [
    'primary-pnpm',
    'directional-csm-browser',
    'smoke-fleet',
    'bevy-smoke-fleet',
    'vitest-dawn',
    'metrics-validate-browser',
    'metrics-validate-runtime',
  ]) {
    const start = workflow.indexOf(`  ${jobName}:\n`);
    assert.notEqual(start, -1, `missing ${jobName}`);
    const nextJobOffset = workflow.slice(start + 3).search(/\n {2}[A-Za-z][A-Za-z0-9-]*:\n/);
    const nextJob = nextJobOffset === -1 ? -1 : start + 3 + nextJobOffset;
    const job = workflow.slice(start, nextJob === -1 ? workflow.length : nextJob);
    const install = job.indexOf('Install (frozen)');
    const prepare = job.indexOf('prepare-dawn-device-limits');
    assert.ok(install >= 0 && prepare > install, `${jobName} must prepare after install`);
    assert.doesNotMatch(job.slice(0, install), /patch-dawn-device-limits/);
  }
});

test('Dawn heavy renderer lanes keep only lifecycle work fresh', () => {
  assert.match(
    entityVisibilityDawnTest,
    /const ENTITY_VISIBILITY_DAWN_TEST_TIMEOUT_MS = 120_000;/,
    'the entity-visibility Dawn smoke needs a bounded cold-start budget',
  );
  assert.equal(
    (entityVisibilityDawnTest.match(/ENTITY_VISIBILITY_DAWN_TEST_TIMEOUT_MS/g) ?? []).length,
    2,
    'the entity-visibility timeout must be applied to exactly one real Dawn smoke',
  );
  assert.match(
    pointLightShadowDawnTest,
    /const POINT_LIGHT_SHADOW_DAWN_TEST_TIMEOUT_MS = 120_000;/,
    'the point-light-shadow Dawn e2e needs a bounded cold-start budget',
  );
  assert.equal(
    (pointLightShadowDawnTest.match(/POINT_LIGHT_SHADOW_DAWN_TEST_TIMEOUT_MS/g) ?? []).length,
    2,
    'the point-light-shadow timeout must be applied to exactly one real Dawn smoke',
  );
  assert.match(
    vitestConfig,
    /const DAWN_ISOLATED_TEST_FILES = \[[\s\S]*?point-light-shadow\.dawn\.test\.ts[\s\S]*?instances-uniform-fallback\.dawn\.test\.ts[\s\S]*?shadow-fields-observable\.dawn\.test\.ts[\s\S]*?gpu-pass-timing-lifecycle\.dawn\.test\.ts[\s\S]*?gpu-pass-timing\.dawn\.test\.ts[\s\S]*?volumetric-fog\/src\/__tests__\/mvd\.dawn\.test\.ts[\s\S]*?extended-lighting\/__tests__\/recovery\.dawn\.test\.ts/,
  );
  assert.match(vitestConfig, /FORGEAX_DAWN_ISOLATED/);
  assert.match(vitestConfig, /\.\.\.\(RUNNING_DAWN_ISOLATED \? \[\] : DAWN_ISOLATED_TEST_FILES\)/);
  assert.match(vitestConfig, /DAWN_COMPACT_TEST_FILES/);
  assert.match(vitestConfig, /\.\.\.\(RUNNING_DAWN_COMPACT \? \[\] : DAWN_COMPACT_TEST_FILES\)/);
  assert.match(
    dawnCompactRoster,
    /packages\/rhi-debug\/src\/__tests__\/copy-src-usage-validity\.dawn\.test\.ts/,
  );
  assert.match(
    dawnCompactRoster,
    /packages\/render\/src\/__tests__\/render-graph-hzb\.dawn\.test\.ts/,
  );
  for (const sharedDawnFile of [
    'apps/hello/entity-visibility/__tests__/visibility.dawn.test.ts',
    'packages/runtime/src/__tests__/fxaa-pixel-diff.dawn.test.ts',
    'packages/runtime/src/__tests__/stencil-outline-pixel.dawn.test.ts',
    'packages/render/src/__tests__/volumetric-fog-stage-readback.dawn.test.ts',
  ]) {
    assert.match(
      dawnCompactRoster,
      new RegExp(sharedDawnFile.replaceAll('/', '\\/')),
      `${sharedDawnFile} must use the shared Dawn module graph`,
    );
  }
  assert.match(shaderPluginSource, /engineShaderManifestCache/);
  assert.match(shaderPluginSource, /buildEngineShaderManifestUncached/);
  const dawnStart = workflow.indexOf('  vitest-dawn:\n');
  const dawnJob = workflow.slice(dawnStart, workflow.indexOf('  webkit-fallback:\n', dawnStart));
  assert.match(dawnJob, /timeout-minutes: 35/);
  assert.match(
    dawnJob,
    /- name: Isolated Dawn renderer integrations \(fresh process\)[\s\S]*?FORGEAX_DAWN_ISOLATED: ['"]1['"][\s\S]*?packages\/runtime\/src\/__tests__\/point-light-shadow\.dawn\.test\.ts[\s\S]*?packages\/runtime\/src\/__tests__\/dawn\/instances-uniform-fallback\.dawn\.test\.ts/,
  );
  assert.match(
    dawnJob,
    /- name: Isolated Dawn lifecycle carrier \(fresh process\)[\s\S]*?FORGEAX_DAWN_ISOLATED: ['"]1['"][\s\S]*?gpu-pass-timing-lifecycle\.dawn\.test\.ts/,
  );
  for (const heavyParityFile of [
    'packages/render/src/transmission/__tests__/standard-transmission.dawn.test.ts',
    'packages/runtime/src/__tests__/dawn/material-alpha.dawn.test.ts',
    'apps/parity/color-lighting/cases/tone/__tests__/tone-ramp.dawn.test.ts',
    'apps/parity/color-lighting/cases/extended-lighting/__tests__/rect-area.dawn.test.ts',
    'apps/parity/color-lighting/cases/extended-lighting/__tests__/spot-modifiers.dawn.test.ts',
    'apps/parity/color-lighting/cases/extended-lighting/__tests__/probe.dawn.test.ts',
    'packages/runtime/src/__tests__/fullscreen-post-process-pass.dawn.test.ts',
    'packages/runtime/src/__tests__/shadow-csm-runtime-vary.dawn.test.ts',
  ]) {
    assert.match(
      vitestConfig,
      new RegExp(`DAWN_ISOLATED_TEST_FILES[\\s\\S]*${heavyParityFile.replaceAll('/', '\\/')}`),
    );
    assert.match(
      dawnJob,
      new RegExp(
        `Shared Dawn heavy carriers \\(bounded module graph\\)[\\s\\S]*?--no-isolate[\\s\\S]*${heavyParityFile.replaceAll('/', '\\/')}`,
      ),
    );
  }
  assert.match(
    dawnJob,
    /- name: Prepare XDG runtime directory[\s\S]*?uses: \.\/\.github\/actions\/prepare-xdg-runtime/,
    'Linux Dawn jobs must provide a private XDG runtime directory before native processes start',
  );
  assert.match(
    dawnJob,
    /- name: Isolated Dawn shadow-field observability \(fresh process\)[\s\S]*?FORGEAX_DAWN_ISOLATED: ['"]1['"][\s\S]*?FORGEAX_DAWN_LIGHTWEIGHT: ['"]1['"][\s\S]*?shadow-fields-observable\.dawn\.test\.ts/,
  );
  assert.match(
    dawnJob,
    /- name: Vitest dawn project \(real GPU — \*\.dawn\.test\.ts\)[\s\S]*?FORGEAX_DAWN_LIGHTWEIGHT: ['"]1['"][\s\S]*?--project=dawn/,
    'the ordinary Dawn roster must use its bounded frame profile on overloaded runners',
  );
  assert.match(
    dawnJob,
    /- name: Shared Dawn module-graph lane[\s\S]*?FORGEAX_DAWN_COMPACT: ['"]1['"][\s\S]*?run: node scripts\/ci\/run-compact-vitest-dawn\.mjs/,
    'validated low/medium-density Dawn files must use one shared module graph on overloaded runners',
  );
  assert.match(
    readFileSync(
      resolve('packages/render/bench/gpu-pass-timing/__tests__/gpu-pass-timing.dawn.test.ts'),
      'utf8',
    ),
    /const frameCount = process\.env\.FORGEAX_DAWN_LIGHTWEIGHT === ['"]1['"] \? 12 : 300;/,
    'GPU pass timing retains the full local window and a bounded CI window',
  );
  assert.match(
    readFileSync(resolve('apps/hello/entity-visibility/__tests__/visibility.dawn.test.ts'), 'utf8'),
    /const frameCount = process\.env\.FORGEAX_DAWN_LIGHTWEIGHT === ['"]1['"] \? 12 : 300;/,
    'entity visibility retains the full local window and a bounded CI window',
  );
  assert.match(
    readFileSync(resolve('apps/hello/scene-nesting/__tests__/scene-nesting.dawn.test.ts'), 'utf8'),
    /const TARGET_FRAMES = process\.env\.FORGEAX_DAWN_LIGHTWEIGHT === ['"]1['"] \? 24 : 300;/,
    'scene nesting retains the full local window and a bounded CI window',
  );
  const extendedCaseCarrier = readFileSync(
    resolve('apps/parity/color-lighting/src/compare/extended-case-carrier.ts'),
    'utf8',
  );
  assert.match(
    extendedCaseCarrier,
    /const DAWN_LIGHTWEIGHT = \([\s\S]*?globalThis[\s\S]*?FORGEAX_DAWN_LIGHTWEIGHT === ['"]1['"];/,
    'browser-loaded parity carriers must read the optional Node flag through globalThis',
  );
  assert.match(
    extendedCaseCarrier,
    /frameCount: DAWN_LIGHTWEIGHT \? 4 : 12,/,
    'extended-lighting carriers must keep the bounded CI frame window without a browser process global',
  );
  assert.match(
    dawnJob,
    /- name: Direct-light Dawn partitions \(real GPU — complete roster\)[\s\S]*?FORGEAX_DAWN_LIGHTWEIGHT: ['"]1['"][\s\S]*?run: node scripts\/ci\/run-direct-light-dawn\.mjs/,
  );
  assert.match(
    shadowFieldsObservable,
    /const SHADOW_FIELDS_RENDER_FRAMES = LIGHTWEIGHT_DAWN \? 12 : 300;/,
    'the isolated shadow-field lane must retain a bounded CI frame window',
  );
  assert.match(
    shadowFieldsObservable,
    /const WIDTH = LIGHTWEIGHT_DAWN \? 128 : 256;[\s\S]*?const HEIGHT = LIGHTWEIGHT_DAWN \? 128 : 256;/,
    'the isolated shadow-field lane must lower its readback target only under the explicit CI flag',
  );
  assert.match(
    shadowFieldsObservable,
    /if \(i % 16 === 15\) await dev\.queue\.onSubmittedWorkDone\(\);/,
    'shadow-field frames must periodically drain native Dawn work',
  );
  assert.match(
    packageManifest,
    /test:dawn[\s\S]*run-compact-vitest-dawn\.mjs[\s\S]*gpu-pass-timing-lifecycle\.dawn\.test\.ts[\s\S]*--no-isolate[\s\S]*volumetric-fog\/src\/__tests__\/mvd\.dawn\.test\.ts[\s\S]*extended-lighting\/__tests__\/recovery\.dawn\.test\.ts[\s\S]*shadow-fields-observable\.dawn\.test\.ts/,
  );
});

test('heavy browser gates rely on workflow cancellation and retry only declared instability', () => {
  const vitestStart = workflow.indexOf('  vitest-browser-shard:\n');
  const vitestBrowser = workflow.slice(
    vitestStart,
    workflow.indexOf('  vitest-browser:\n', vitestStart),
  );
  const sharedStart = workflow.indexOf('  shared-inputs-browser:\n');
  const sharedInputs = workflow.slice(
    sharedStart,
    workflow.indexOf('  multithread-browser-benchmark:\n', sharedStart),
  );
  const benchmarkStart = workflow.indexOf('  multithread-browser-benchmark:\n');
  const benchmark = workflow.slice(
    benchmarkStart,
    workflow.indexOf('  smoke-fleet:\n', benchmarkStart),
  );
  for (const block of [vitestBrowser, sharedInputs, benchmark])
    assert.doesNotMatch(block, /\n\s+concurrency:/);
  assert.doesNotMatch(vitestBrowser, /run-browser-gate-with-retry\.mjs\s+--mode=vitest/);
  assert.match(vitestBrowser, /node scripts\/ci\/run-split-vitest-browser\.mjs/);
  assert.match(benchmark, /run-browser-gate-with-retry\.mjs\s+\\\n\s+--mode=benchmark\s+\\\n\s+--/);
  assert.match(
    benchmark,
    /run-browser-gate-with-retry\.mjs\s+\\\n\s+--mode=multithread-smoke\s+\\\n\s+--/,
  );
  assert.match(benchmark, /run-with-runner-cpu-affinity\.mjs/);
  assert.doesNotMatch(sharedInputs, /multithreaded-execution|--mode=benchmark/);
  const benchmarkScript = readFileSync(
    resolve('apps/hello/multithreaded-execution/scripts/bench-browser.mjs'),
    'utf8',
  );
  assert.match(benchmarkScript, /\[multithreaded benchmark\] performance verdict failed/);
  assert.match(
    benchmarkScript,
    /diagnostic\.report\?\.fault\?\.code === 'app-execution-deadline-exceeded'/,
  );
  assert.match(benchmarkScript, /diagnostic\.report\?\.fault\?\.detail\?\.phase === 'frame'/);
  assert.match(benchmarkScript, /reason: 'transient-frame-deadline-after-healthy-progress'/);
});

test('FXAA owned dev server allows the cold Vite startup budget', () => {
  const shardStart = workflow.indexOf('  vitest-browser-shard:\n');
  const shard = workflow.slice(shardStart, workflow.indexOf('  vitest-browser:\n', shardStart));
  const serverStart = shard.indexOf('- name: Start hello-fxaa dev server (owned background)');
  const server = shard.slice(
    serverStart,
    shard.indexOf('- name: Hello FXAA dark-gradient Browser WebGPU smoke (direct)', serverStart),
  );
  assert.match(server, /--timeout-ms 180000/);

  const fallbackStart = workflow.indexOf('  webkit-fallback:\n');
  const fallback = workflow.slice(
    fallbackStart,
    workflow.indexOf('  portability-bun:\n', fallbackStart),
  );
  const fallbackServerStart = fallback.indexOf(
    '- name: Start hello-fxaa dev server (owned background)',
  );
  const fallbackServer = fallback.slice(
    fallbackServerStart,
    fallback.indexOf(
      '- name: Hello FXAA dark-gradient Chromium WebGL2 smoke (direct)',
      fallbackServerStart,
    ),
  );
  assert.match(fallbackServer, /--timeout-ms 180000/);
});

test('Chromium fallback reuses the immutable shader projection before Vite startup', () => {
  const fallbackStart = workflow.indexOf('  webkit-fallback:\n');
  const fallback = workflow.slice(
    fallbackStart,
    workflow.indexOf('  portability-bun:\n', fallbackStart),
  );
  assert.match(fallback, /needs: \[core-build, shared-app-inputs, post-merge-gate\]/);
  assert.match(fallback, /needs\.core-build\.outputs\.core_artifact_id/);
  assert.match(fallback, /needs\.shared-app-inputs\.outputs\.shared_artifact_id/);
  assert.match(fallback, /unpack-shared-app-inputs\.mjs/);
  assert.match(fallback, /FORGEAX_SHARED_APP_INPUTS_MANIFEST:/);
  assert.match(fallback, /--shared-input-manifest shared-app-inputs\/manifest\.json/);
  assert.match(
    fallback,
    /--input-fingerprint .*needs\.shared-app-inputs\.outputs\.input_fingerprint/,
  );
  const contract = JSON.parse(readFileSync(resolve('scripts/ci/build-artifact-contract.json')));
  assert.deepEqual(contract.consumers['webkit-fallback'].requiredArtifactClasses, [
    'engine-dist',
    'wasm-runtime',
    'shared-engine-shaders',
  ]);
  assert.ok(contract.sharedInputs.readOnlyConsumers.includes('webkit-fallback'));
});

test('Vitest browser shard reuses the immutable shader projection before M16 startup', () => {
  const shardStart = workflow.indexOf('  vitest-browser-shard:\n');
  const shard = workflow.slice(shardStart, workflow.indexOf('  vitest-browser:\n', shardStart));
  assert.match(shard, /needs: \[build-artifacts, shared-app-inputs, post-merge-gate\]/);
  assert.match(shard, /needs\.build-artifacts\.outputs\.artifact_ids_vitest_browser/);
  assert.match(shard, /needs\.shared-app-inputs\.outputs\.shared_artifact_id/);
  assert.match(shard, /unpack-shared-app-inputs\.mjs/);
  assert.match(shard, /FORGEAX_SHARED_APP_INPUTS_MANIFEST:/);
  assert.match(shard, /--shared-input-manifest shared-app-inputs\/manifest\.json/);
  assert.match(shard, /--input-fingerprint .*needs\.shared-app-inputs\.outputs\.input_fingerprint/);
  const contract = JSON.parse(readFileSync(resolve('scripts/ci/build-artifact-contract.json')));
  assert.deepEqual(contract.consumers['vitest-browser'].requiredArtifactClasses, [
    'engine-dist',
    'wasm-runtime',
    'shared-engine-shaders',
  ]);
  assert.ok(contract.sharedInputs.readOnlyConsumers.includes('vitest-browser'));
});

test('metrics producers have enough bounded wall-clock budget for full evidence', () => {
  const browserStart = workflow.indexOf('  metrics-validate-browser:\n');
  const browser = workflow.slice(
    browserStart,
    workflow.indexOf('  metrics-validate-runtime:\n', browserStart),
  );
  assert.match(browser, /timeout-minutes: 45/);
  assert.match(browser, /Run color-lighting parity matrix/);
  assert.match(
    browser,
    /- name: Prepare XDG runtime directory[\s\S]*?uses: \.\/\.github\/actions\/prepare-xdg-runtime/,
    'the metrics browser producer must provide a private XDG runtime directory before Dawn children start',
  );
  assert.match(
    browser,
    /- name: Run pixel parity benches \(all fixtures\)[\s\S]*?BENCH_TARGET: all[\s\S]*?pnpm bench:pixel-parity/,
    'both pixel parity reports must be produced by one all-target runner invocation',
  );
  assert.match(
    browser,
    /- name: Run color-lighting parity matrix[\s\S]*?FORGEAX_DAWN_LIGHTWEIGHT: ['"]1['"][\s\S]*?pnpm bench:color-lighting-parity/,
    'the metrics color-lighting producer must opt into the bounded Dawn warmup',
  );
  assert.doesNotMatch(
    browser,
    /Run pixel parity bench \(parity-standard-lanes\)/,
    'the standard-lanes pixel bench must not be a second workflow step',
  );
  assert.match(pixelParityBench, /const BENCH_TARGET_ALL = ['"]all['"];/);
  assert.match(pixelParityBench, /for \(const targetName of BENCH_TARGET_NAMES\)/);
  assert.match(pixelParityBench, /writeReport\(result, targetConfig\)/);
  assert.match(colorLightingBench, /--project=parity/);
  assert.match(colorLightingBench, /--typecheck\.enabled=false/);
  assert.match(colorLightingBench, /timedStage\('direct-light-dawn'/);
  assert.match(colorLightingBench, /FORGEAX_DAWN_PARTITION_SCOPE: ['"]producer['"]/);
  assert.match(
    colorLightingBench,
    /FORGEAX_DAWN_COMPACT: ['"]1['"][\s\S]*?FORGEAX_PARITY_TRANSPARENCY_ARTIFACT/,
    'the auxiliary Dawn command must opt back into its explicitly selected compact transparency carrier',
  );
  assert.match(colorLightingBench, /timedStage\('m4-closure'/);
  assert.match(
    colorLightingBench,
    /spawn\(\s*process\.execPath,[\s\S]*node_modules\/vite\/bin\/vite\.js[\s\S]*'preview',[\s\S]*'127\.0\.0\.1'/,
    'the parity bench must terminate Vite directly so pnpm does not convert normal cleanup SIGTERM into a failure',
  );
  assert.doesNotMatch(
    colorLightingBench,
    /spawn\(\s*['"]pnpm['"],[\s\S]*['"]preview['"]/,
    'the preview carrier must not be a nested pnpm process',
  );

  const runtimeStart = workflow.indexOf('  metrics-validate-runtime:\n');
  const runtime = workflow.slice(
    runtimeStart,
    workflow.indexOf('  metrics-validate:\n', runtimeStart),
  );
  assert.match(runtime, /timeout-minutes: 90/);
  assert.match(runtime, /Run hello-lod-occlusion GPU frame samples producer/);
  assert.match(
    runtime,
    /run-with-runner-cpu-affinity\.mjs --\s+node scripts\/ci\/run-lod-performance-with-retry\.mjs --\s+pnpm --filter @forgeax\/hello-lod-occlusion bench:json/,
    'the runtime metrics producer must bind to the declared cgroup CPU budget before sampling',
  );
});

test('GPU timing keeps default CI on the no-GPU contract and isolates real-GPU evidence', () => {
  const contractStart = workflow.indexOf('  gpu-pass-timing-contract:\n');
  const contract = workflow.slice(
    contractStart,
    workflow.indexOf('  cost-reporter:\n', contractStart),
  );

  assert.notEqual(contractStart, -1);
  assert.match(contract, /name: gpu-pass-timing-contract/);
  assert.match(
    contract,
    /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64", "standard"\]'\) \}\}/,
  );
  assert.match(contract, /Verify standard runner capacity[\s\S]*--pool standard/);
  assert.match(contract, /gpu-pass-timing\.rhi-null\.unit\.test\.ts/);
  assert.match(contract, /gpu-pass-timing-contract\.unit\.test\.ts/);
  assert.match(contract, /artifact-validator\.unit\.test\.ts/);
  assert.match(contract, /run-gpu-pass-timing-with-runner-admission\.test\.mjs/);
  assert.doesNotMatch(contract, /gpu-pass-timing:bench|Install Mesa Vulkan/);
  assert.doesNotMatch(workflow, /run_gpu_pass_timing/);
  assert.doesNotMatch(workflow, / {2}gpu-pass-timing-benchmark:\n/);
  assert.doesNotMatch(workflow, / {2}gpu-pass-timing-final:\n/);

  assert.match(realGpuWorkflow, /workflow_dispatch:/);
  assert.match(realGpuWorkflow, /ci_run_id:/);
  assert.match(realGpuWorkflow, /ci_run_attempt:/);
  assert.match(
    realGpuWorkflow,
    /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64", "gpu", "standard"\]'\) \}\}/,
  );
  assert.match(realGpuWorkflow, /Verify standard runner capacity[\s\S]*--pool standard/);
  assert.match(realGpuWorkflow, /Require a physical GPU device/);
  assert.match(realGpuWorkflow, /core-build-a\$\{\{ inputs\.ci_run_attempt \}\}\*/);
  assert.match(realGpuWorkflow, /shared-app-inputs-a\$\{\{ inputs\.ci_run_attempt \}\}\*/);
  assert.match(realGpuWorkflow, /engine-prerequisite-build-manifest\.json/);
  assert.match(realGpuWorkflow, /run-gpu-pass-timing-with-runner-admission\.mjs/);
  assert.match(realGpuWorkflow, /needs: \[gpu-pass-timing-benchmark\]/);
  assert.match(realGpuWorkflow, /if: always\(\)/);
  assert.match(realGpuWorkflow, /report\.backend\?\.kind !== 'webgpu'/);
  assert.match(realGpuWorkflow, /report\.backend\?\.realGpu !== true/);
  assert.match(realGpuWorkflow, /zeroCgroupThrottledTimeDelta/);
  assert.match(realGpuWorkflow, /thresholdPercent !== 10/);
  assert.match(realGpuWorkflow, /thresholdPercent !== 20/);
  assert.match(realGpuWorkflow, /report\.offPath/);
  assert.doesNotMatch(realGpuWorkflow, /Install Mesa Vulkan|continue-on-error/);
  assert.doesNotMatch(realGpuWorkflow, /pnpm test:browser|pnpm test:dawn|smoke-fleet/);
});

test('every heavy job verifies its actual cgroup capacity before doing work', () => {
  const jobStarts = [...workflow.matchAll(/^ {2}([a-z0-9-]+):\n/gm)];
  const heavyJobs = [];
  for (let index = 0; index < jobStarts.length; index++) {
    const start = jobStarts[index];
    const block = workflow.slice(start.index, jobStarts[index + 1]?.index ?? workflow.length);
    if (!block.includes('self-hosted", "Linux", "X64", "heavy')) continue;
    heavyJobs.push(start[1]);
    assert.match(
      block,
      /node scripts\/ci\/verify-runner-pool-capacity\.mjs --pool heavy/,
      `${start[1]} must reject a mislabeled undersized runner`,
    );
    const setupNode = block.indexOf('- name: Setup Node.js');
    const capacityGuard = block.indexOf('Verify heavy runner capacity');
    const install = Math.min(
      ...['- name: Install (frozen)', '- name: Install dependencies']
        .map((marker) => block.indexOf(marker))
        .filter((index) => index >= 0),
    );
    assert.ok(
      setupNode >= 0 && capacityGuard > setupNode && capacityGuard < install,
      `${start[1]} must check capacity after Node setup and before dependency installation`,
    );
  }
  assert.equal(heavyJobs.length, 18);
  assert.ok(heavyJobs.includes('vitest-browser-shard'));
});

test('hello-taa PR CI uses simulation lanes and does not require physical GPU admission', () => {
  assert.doesNotMatch(workflow, /hello-taa-performance-admission/);
  assert.doesNotMatch(workflow, /smoke:performance:admission|native-performance-admission/);
  assert.doesNotMatch(workflow, /macos-15-xlarge/);
  const start = workflow.indexOf('  smoke-fleet:\n');
  const end = workflow.indexOf('  smoke-fleet-required-context:\n', start);
  const block = workflow.slice(start, end);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(block, /Hello-taa headless smoke \(dawn-node \+ lavapipe WebGPU\)/);
  assert.doesNotMatch(block, /Hello-taa browser serialization and raster smoke/);
  assert.match(block, /Hello-taa CPU-WebGL2 static admission contract/);
  assert.match(block, /Hello-taa Motion Blur falsifier evidence/);
  assert.match(
    block,
    /Hello-taa Motion Blur falsifier evidence[\s\S]*?FORGEAX_TAA_FALSIFIER_PROFILE: ci[\s\S]*?SMOKE_FALSIFY_CONCURRENCY: 1/,
    'PR smoke-fleet must use the bounded TAA falsifier profile without GPU oversubscription',
  );
  assert.match(block, /Hello-taa temporal Motion Blur correctness evidence/);
  assert.match(block, /pnpm --filter @forgeax\/hello-taa smoke:performance/);
});

test('smoke-fleet builds hello-taa before its performance consumer runs', () => {
  const start = workflow.indexOf('  smoke-fleet:\n');
  const end = workflow.indexOf('  smoke-fleet-required-context:\n', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = workflow.slice(start, end);
  const build = block.indexOf('name: Build hello-taa smoke consumer');
  const smoke = block.indexOf('pnpm --filter @forgeax/hello-taa smoke');
  const performance = block.indexOf('pnpm --filter @forgeax/hello-taa smoke:performance');
  assert.ok(build >= 0, 'smoke-fleet must materialize a complete hello-taa dist');
  assert.ok(smoke >= 0 && build < smoke, 'hello-taa build must precede Dawn smoke');
  assert.ok(
    performance >= 0 && build < performance,
    'hello-taa build must precede smoke:performance',
  );
});

test('shared-inputs browser reuses the immutable producer instead of recooking the corpus', () => {
  const buildArtifacts = workflow.slice(
    workflow.indexOf('  build-artifacts:\n'),
    workflow.indexOf('  cache-warm:\n'),
  );
  const sharedInputs = workflow.slice(
    workflow.indexOf('  shared-inputs-browser:\n'),
    workflow.indexOf('  multithread-browser-benchmark:\n'),
  );
  assert.match(
    buildArtifacts,
    /shared_artifact_id: \$\{\{ needs\.shared-app-inputs\.outputs\.shared_artifact_id \}\}/,
  );
  assert.doesNotMatch(buildArtifacts, /full_shared_artifact_id/);
  assert.match(
    buildArtifacts,
    /shared_input_fingerprint: \$\{\{ needs\.shared-app-inputs\.outputs\.input_fingerprint \}\}/,
  );
  assert.match(sharedInputs, /--path shared-app-inputs-transfer/);
  assert.match(sharedInputs, /unpack-shared-app-inputs\.mjs/);
  assert.match(sharedInputs, /--shared-input-manifest shared-app-inputs\/manifest\.json/);
  assert.match(sharedInputs, /--shared-input-mode catalog-only/);
  assert.match(sharedInputs, /needs\.build-artifacts\.outputs\.shared_artifact_id/);
  assert.doesNotMatch(sharedInputs, /full_shared_artifact_id/);
  const contract = JSON.parse(readFileSync(resolve('scripts/ci/build-artifact-contract.json')));
  assert.deepEqual(contract.consumers['shared-inputs-browser'].requiredArtifactClasses, [
    'engine-dist',
    'wasm-runtime',
  ]);
});

test('read-only shader consumers unpack the compact shared projection before materializing it', () => {
  for (const [job, nextJob] of [
    ['primary-pnpm', 'coverage-pnpm'],
    ['coverage-pnpm', 'coverage-perf'],
    ['multithread-browser-benchmark', 'smoke-fleet'],
    ['smoke-fleet', 'smoke-fleet-required-context'],
    ['bevy-smoke-fleet', 'bevy-smoke-fleet-required-context'],
    ['gpu-pass-timing-contract', 'cost-reporter'],
  ]) {
    const start = workflow.indexOf(`  ${job}:\n`);
    const end = workflow.indexOf(`  ${nextJob}:\n`, start);
    const block = workflow.slice(start, end);
    const unpack = block.indexOf('unpack-shared-app-inputs.mjs');
    const materialize = block.indexOf('materialize-app-shader-manifests.mjs');
    assert.ok(start >= 0 && end > start, `${job} must have a bounded workflow block`);
    assert.ok(unpack >= 0 && unpack < materialize, `${job} must unpack before materializing`);
    assert.match(block, /--path shared-app-inputs-transfer/);
    assert.match(block, /unpack-shared-app-inputs\.mjs/);
  }
  const realGpuUnpack = realGpuWorkflow.indexOf('unpack-shared-app-inputs.mjs');
  const realGpuMaterialize = realGpuWorkflow.indexOf('materialize-app-shader-manifests.mjs');
  assert.ok(realGpuUnpack >= 0 && realGpuUnpack < realGpuMaterialize);
  assert.match(realGpuWorkflow, /--archive shared-app-inputs\.tar\.gz/);
});

test('CI harness materialization uses a blob-filtered docs-only clone', () => {
  const materializeSteps = workflow.match(
    /- name: Materialize harness documentation[\s\S]*?FORGEAX_HARNESS_SPARSE_DOCS: '1'/g,
  );
  assert.equal(materializeSteps?.length, 2);
  assert.equal(
    (workflow.match(/node scripts\/ci\/materialize-harness-docs\.mjs/g) ?? []).length,
    2,
  );
  const syncHarness = readFileSync(resolve('scripts/sync-harness.mjs'), 'utf8');
  assert.match(syncHarness, /--filter=blob:none[\s\S]*--sparse/);
  assert.match(syncHarness, /\['fetch', '--quiet', '--depth=1', 'origin', 'main'\]/);
});

test('browser WebGPU project bounds workers to protect the shared device', () => {
  assert.match(browserVitestConfig, /maxWorkers: 1/);
});

test('Dawn project uses one worker to protect the shared software Vulkan backend', () => {
  const dawnProject = vitestConfig.slice(vitestConfig.indexOf("name: 'dawn'"));
  assert.match(dawnProject, /maxWorkers: 1/);
});

test('ECS performance project keeps benchmark contention inside a bounded timeout', () => {
  const ecsPerfProject = vitestConfig.slice(vitestConfig.indexOf("name: 'ecs-perf'"));
  assert.match(ecsPerfProject, /testTimeout: 30000/);
});

test('cold Ubuntu smoke and browser jobs keep their real runtime budget', () => {
  const smokeStart = workflow.indexOf('  smoke-fleet:\n');
  const smokeFleet = workflow.slice(
    smokeStart,
    workflow.indexOf('  smoke-fleet-required-context:\n', smokeStart),
  );
  assert.match(smokeFleet, /timeout-minutes: 60/);
  assert.match(smokeFleet, /- name: Hydrate immutable build artifacts\n\s+timeout-minutes: 50/);
  assert.match(smokeFleet, /- name: Run authoritative Dawn roster shard\n\s+timeout-minutes: 45/);
  assert.match(smokeFleet, /DAWN_SMOKE_ENTRY_TIMEOUT_MS: 300000/);
  assert.match(
    smokeFleet,
    /Learn-render framebuffers Dawn smoke[\s\S]*?pnpm --filter @forgeax\/app-learn-render-4-advanced-opengl-5-framebuffers smoke\n/,
  );
  assert.match(
    smokeFleet,
    /Learn-render framebuffers M4 reentry_m4_t2 browser evidence[\s\S]*?xvfb-run -a env FORGEAX_BROWSER_HEADLESS=0[\s\S]*?run-browser-gate-with-retry\.mjs[\s\S]*?--mode=rhi-debug[\s\S]*?smoke:browser/,
  );
  assert.match(
    smokeFleet,
    /Learn-render framebuffers M4 reentry_m4_t3 live evidence[\s\S]*?xvfb-run -a env FORGEAX_BROWSER_HEADLESS=0[\s\S]*?run-browser-gate-with-retry\.mjs[\s\S]*?--mode=rhi-debug[\s\S]*?smoke:browser-live/,
  );
  assert.match(
    smokeFleet,
    /Learn-render framebuffers M4 reentry_m4_t3 live evidence[\s\S]*?if: matrix\.group == 1 && github\.event_name == 'workflow_dispatch' && inputs\.run_m4_live_evidence == true/,
  );
  assert.match(smokeFleet, /Upload M4 browser diagnostics[\s\S]*?if: always\(\)/);
  assert.doesNotMatch(smokeFleet, /run-hello-learn-render-smoke-roster\.mjs/);

  const sharedStart = workflow.indexOf('  shared-inputs-browser:\n');
  const sharedInputs = workflow.slice(
    sharedStart,
    workflow.indexOf('  multithread-browser-benchmark:\n', sharedStart),
  );
  assert.match(sharedInputs, /timeout-minutes: 45/);
  assert.doesNotMatch(sharedInputs, /Cache Playwright browsers/);

  const vitestShardStart = workflow.indexOf('  vitest-browser-shard:\n');
  const vitestBrowserShard = workflow.slice(
    vitestShardStart,
    workflow.indexOf('  vitest-browser:\n', vitestShardStart),
  );
  assert.doesNotMatch(vitestBrowserShard, /Cache Playwright browsers/);
  assert.match(vitestBrowserShard, /timeout-minutes: 45/);
});

test('the VFX GPU benchmark has one owner after the smoke fleet releases the device', () => {
  const smokeStart = workflow.indexOf('  smoke-fleet:\n');
  const smokeFleet = workflow.slice(
    smokeStart,
    workflow.indexOf('  smoke-fleet-required-context:\n', smokeStart),
  );
  assert.doesNotMatch(smokeFleet, /VFX Batch B performance protocol|vfx-batch-b\.mjs/);

  const metricsStart = workflow.indexOf('  metrics-validate:\n');
  const metrics = workflow.slice(
    metricsStart,
    workflow.indexOf('  collectathon-boot-e2e:\n', metricsStart),
  );
  assert.match(metrics, /needs: \[[^\]]*smoke-fleet[^\]]*\]/);
  assert.match(metrics, /needs\.smoke-fleet\.result == 'success'/);
  assert.match(metrics, /run: pnpm metrics:run/);

  const artifactContract = JSON.parse(
    readFileSync(resolve('scripts/ci/build-artifact-contract.json'), 'utf8'),
  );
  const metricsTiming = artifactContract.timingRoster.find(
    (entry) => entry.jobIdentity === 'metrics-validate',
  );
  assert.ok(metricsTiming);
  assert.ok(metricsTiming.allowedNonArtifactPrerequisites.includes('smoke-fleet'));
});

test('self-hosted setup-node steps do not transfer the pnpm store archive', () => {
  const setupNodeSteps = workflow.match(/uses: actions\/setup-node@v5/g) ?? [];
  const disabledStoreCaches = workflow.match(/^\s+package-manager-cache: false$/gm) ?? [];
  assert.equal(disabledStoreCaches.length, setupNodeSteps.length);
  assert.doesNotMatch(workflow, /package-manager-cache:\s*true/);
});

test('the self-hosted bench setup-node also avoids the pnpm store archive', () => {
  const setupNodeSteps = benchWorkflow.match(/uses: actions\/setup-node@v5/g) ?? [];
  const disabledStoreCaches = benchWorkflow.match(/^\s+package-manager-cache: false$/gm) ?? [];
  assert.equal(setupNodeSteps.length, 1);
  assert.equal(disabledStoreCaches.length, setupNodeSteps.length);
  assert.doesNotMatch(benchWorkflow, /package-manager-cache:\s*true/);
});

test('informational math bench keeps its result in the summary without an artifact upload', () => {
  assert.match(benchWorkflow, /Run vitest bench \(math\)/);
  assert.match(benchWorkflow, /GITHUB_STEP_SUMMARY/);
  assert.doesNotMatch(benchWorkflow, /upload-artifact/);
});

test('Mesa installation supports root self-hosted runners without sudo', () => {
  assert.match(mesaVulkanAction, /command -v sudo/);
  assert.match(mesaVulkanAction, /\[ "\$\(id -u\)" -eq 0 \]/);
  assert.match(mesaVulkanAction, /run_privileged\(\) \{ "\$@"; \}/);
  assert.doesNotMatch(mesaVulkanAction, /sudo (?:dpkg|apt-get)/);
});

test('coverage-pnpm uploads diagnostics only after a failed test run', () => {
  assert.match(
    workflow,
    /- name: Upload coverage diagnostics on failure[\s\S]*?if: failure\(\)[\s\S]*?uses: \.\/\.github\/actions\/upload-optional-artifact/,
  );
  assert.doesNotMatch(workflow, /^\s+continue-on-error: true$/m);
  assert.match(
    uploadOptionalArtifact,
    /continue-on-error: true[\s\S]*?uses: actions\/upload-artifact@v6/,
  );
  assert.match(
    uploadWithRetry,
    /id: upload[\s\S]*?continue-on-error: true[\s\S]*?if: steps\.upload\.outcome == 'failure'/,
  );
  assert.equal(uploadWithRetry.match(/continue-on-error: true/g)?.length, 2);
  assert.equal(uploadWithRetry.match(/ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS: '60000'/g)?.length, 2);
  assert.equal(
    (workflow.match(/uses: \.\/\.github\/actions\/upload-optional-artifact/g) ?? []).length,
    6,
  );
  assert.equal(
    (
      workflow.match(
        /uses: \.\/\.github\/actions\/upload-optional-artifact\n\s+timeout-minutes: 2/g,
      ) ?? []
    ).length,
    6,
  );
  assert.equal(
    uploadOptionalArtifact.match(/ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS: '60000'/g)?.length,
    1,
  );
});

test('every CI checkout uses the producer product commit', () => {
  const checkouts = workflow.split(/uses: actions\/checkout@v5\n/).slice(1);
  assert.ok(checkouts.length > 0);
  for (const checkout of checkouts) {
    const inputs = checkout.split(/\n {6}-|\n {2}\S/)[0];
    assert.match(
      inputs,
      /ref: \$\{\{ env\.EXPECTED_PRODUCT_SHA \}\}/,
      'artifact consumers must not combine the implicit PR merge ref with head-SHA producer outputs',
    );
  }
});
