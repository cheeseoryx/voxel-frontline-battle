import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/nightly.yml'), 'utf8');
const shadowFieldsObservable = readFileSync(
  resolve('packages/runtime/src/__tests__/shadow-fields-observable.dawn.test.ts'),
  'utf8',
);
const spriteNinesliceSection = readFileSync(
  resolve('packages/runtime/src/__tests__/dawn/hello-sprite-nineslice-section.dawn.test.ts'),
  'utf8',
);

function jobSection(name) {
  const start = workflow.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing ${name}`);
  const remaining = workflow.slice(start);
  const nextJob = remaining.slice(1).search(/\n {2}[a-z][\w-]+:/);
  return remaining.slice(0, nextJob === -1 ? undefined : nextJob + 1);
}

test('nightly failure issue records failed jobs and deduplicates reruns', () => {
  const section = jobSection('notify-failure');
  assert.match(section, /if: failure\(\)/);
  assert.match(section, /issues: write/);
  assert.match(section, /actions: read/);
  assert.match(section, /retries: 3/);
  assert.match(section, /github\.rest\.actions\.listJobsForWorkflowRun/);
  assert.match(section, /\*\*failed jobs \/ steps\*\*:/);
  assert.match(section, /\*\*nightly run id\*\*:/);
  assert.match(section, /process\.env\.GITHUB_RUN_ATTEMPT/);
  assert.doesNotMatch(section, /context\.runAttempt/);
  assert.match(section, /github\.rest\.issues\.listForRepo/);
  assert.match(section, /updated existing nightly issue/);
  assert.match(section, /github\.rest\.issues\.create/);
});

test('nightly coverage checkout keeps the historical sibling-gate baseline', () => {
  const checkout = workflow.slice(
    workflow.indexOf('      - name: Checkout\n'),
    workflow.indexOf('      - name: Setup Node.js for WASM hydration\n'),
  );
  assert.match(
    checkout,
    /fetch-depth: 0/,
    'nightly must retain the historical commit used by the sibling ancestry gate',
  );
});

test('nightly provisions Node before the wgpu-wasm provenance step', () => {
  const section = jobSection('smoke-browser-dawn');
  const node = section.indexOf('      - name: Setup Node.js for WASM hydration');
  const wgpu = section.indexOf('      - name: Build wgpu-wasm');
  assert.ok(node >= 0, 'missing shared Node setup');
  assert.ok(wgpu >= 0, 'missing wgpu-wasm build');
  assert.ok(node < wgpu, 'Node setup must precede build.sh');
});

test('nightly uses the canonical package graph and declaration preflight', () => {
  const section = jobSection('smoke-browser-dawn');
  const start = section.indexOf(
    '      - name: Build (.mjs + .d.ts, packages only — apps tested from source)',
  );
  assert.notEqual(start, -1, 'missing nightly package build step');
  const end = section.indexOf('\n      - name:', start + 1);
  const build = section.slice(start, end === -1 ? undefined : end);
  assert.match(build, /FORGEAX_BUILD_NO_TASK_CACHE: ['"]1['"]/);
  assert.match(build, /node scripts\/build-packages\.mjs/);
  assert.match(build, /node scripts\/typecheck-output-preflight\.mjs/);
  assert.match(build, /pnpm exec tsc -b/);
  assert.ok(
    build.indexOf('typecheck-output-preflight') < build.indexOf('pnpm exec tsc -b'),
    'declaration preflight must run before the final typecheck',
  );
  assert.doesNotMatch(build, /pnpm -r --filter=/);
});

test('nightly bounds hosted platform probes and keeps the complete roster on Linux', () => {
  const section = jobSection('smoke-browser-dawn');
  assert.match(
    section,
    /timeout-minutes: \$\{\{ matrix\.timeout \}\}/,
    'nightly timeout must come from the per-platform budget',
  );
  assert.match(
    section,
    /hostedPlatform: true[\s\S]*?timeout: 15[\s\S]*?hostedPlatform: true[\s\S]*?timeout: 15/,
    'hosted macOS and Windows must be hard-bounded at 15 minutes',
  );
  assert.match(
    section,
    /- name: Vitest Dawn platform probe \(hosted macOS\/Windows\)\n\s+if: matrix\.hostedPlatform[\s\S]*?--maxWorkers=1/,
    'hosted platforms must use the bounded serial probe',
  );
  assert.match(
    section,
    /- name: Vitest dawn project \(real GPU command capture\)\n\s+if: matrix\.ubuntu/,
    'the complete Dawn roster must remain Linux-owned',
  );
  assert.match(
    section,
    /- name: Isolated Dawn shadow-field observability \(fresh process\)[\s\S]*?FORGEAX_DAWN_ISOLATED: ['"]1['"][\s\S]*?shadow-fields-observable\.dawn\.test\.ts/,
    'the high-cost shadow-field carrier must remain in the complete nightly roster',
  );
  assert.match(
    section,
    /- name: Prepare XDG runtime directory[\s\S]*?uses: \.\/\.github\/actions\/prepare-xdg-runtime/,
    'the Linux nightly Dawn lane must provide a private XDG runtime directory',
  );
});

test('nightly Linux Mesa provisioning isolates host apt sources', () => {
  const section = jobSection('smoke-browser-dawn');
  const installStart = section.indexOf('      - name: Install Mesa Vulkan (Linux only)');
  assert.notEqual(installStart, -1, 'missing nightly Mesa provisioning step');
  const installEnd = section.indexOf('\n      - name:', installStart + 1);
  const install = section.slice(installStart, installEnd === -1 ? undefined : installEnd);
  assert.match(
    install,
    /apt_wrapper="\$GITHUB_WORKSPACE\/scripts\/ci\/with-apt-ubuntu-sources\.sh"/,
  );
  assert.match(install, /"\$apt_wrapper" sudo apt-get update/);
  assert.match(install, /"\$apt_wrapper" sudo apt-get install -y mesa-vulkan-drivers vulkan-tools/);
  assert.doesNotMatch(install, /\n\s+sudo apt-get update/);
});

test('nightly isolates the GPU pass timing Dawn carrier', () => {
  const section = jobSection('smoke-browser-dawn');
  assert.match(
    section,
    /Isolated Dawn renderer carriers \(fresh process\)[\s\S]*?FORGEAX_DAWN_ISOLATED: ['"]1['"][\s\S]*?packages\/render\/bench\/gpu-pass-timing\/__tests__\/gpu-pass-timing\.dawn\.test\.ts/,
  );
});

test('shadow-field Dawn falsifiers keep a bounded Windows cold-start budget', () => {
  assert.match(
    shadowFieldsObservable,
    /const SHADOW_FIELDS_FALSIFIER_TIMEOUT_MS = 300_000;/,
    'shadow-field falsifiers need a five-minute bound for the Windows Dawn prebuild',
  );
  assert.equal(
    (shadowFieldsObservable.match(/SHADOW_FIELDS_FALSIFIER_TIMEOUT_MS/g) ?? []).length,
    4,
    'the declaration plus all three per-field falsifiers must use the bounded timeout',
  );
});

test('sprite nineslice Dawn falsifier keeps a bounded Windows cold-start budget', () => {
  assert.match(
    spriteNinesliceSection,
    /const SPRITE_NINESLICE_DAWN_TEST_TIMEOUT_MS = 120_000;/,
    'sprite nineslice falsifier needs a bounded timeout for the Windows Dawn cold start',
  );
  assert.equal(
    (spriteNinesliceSection.match(/SPRITE_NINESLICE_DAWN_TEST_TIMEOUT_MS/g) ?? []).length,
    3,
    'the sprite nineslice declaration must be applied to both falsifiers',
  );
});

test('nightly materializes the cold tree-shake bundles before coverage', () => {
  const section = jobSection('smoke-browser-dawn');
  const coverage = section.indexOf(
    '      - name: Vitest unit + coverage (nightly fallback for AC-33)',
  );
  assert.notEqual(coverage, -1, 'missing nightly coverage step');
  const packageBuildStart = section.indexOf(
    '      - name: Build (.mjs + .d.ts, packages only — apps tested from source)',
  );
  assert.notEqual(packageBuildStart, -1, 'missing nightly package build step');
  const packageBuildEnd = section.indexOf('\n      - name:', packageBuildStart + 1);
  const packageBuild = section.slice(
    packageBuildStart,
    packageBuildEnd === -1 ? coverage : packageBuildEnd,
  );
  assert.match(
    section.slice(coverage),
    /pnpm --filter @forgeax\/hello-cube build[\s\S]*pnpm test:unit -- --coverage/,
    'coverage must materialize the consumer bundle required by tree-shake tests',
  );
  assert.doesNotMatch(
    packageBuild,
    /pnpm --filter @forgeax\/hello-cube build/,
    'cold app builds belong to the coverage consumer, not the shared package build',
  );
});

test('nightly success closes only machine-tracked issues with proof', () => {
  const section = jobSection('notify-success');
  assert.match(section, /needs: \[smoke-browser-dawn, native-ray-query-metal-build\]/);
  assert.match(
    section,
    /needs\.smoke-browser-dawn\.result == 'success'.*needs\.native-ray-query-metal-build\.result == 'success'/s,
  );
  assert.match(section, /issues: write/);
  assert.match(section, /\*\*nightly run id\*\*:/);
  assert.match(section, /legacyNightlyFailure/);
  assert.match(section, /nightly run failed — see/);
  assert.match(section, /actions\\\/runs\\\/\\d+/);
  assert.match(section, /includes\('\*\*nightly run id\*\*:'\) \|\| legacyNightlyFailure/);
  assert.match(section, /state: 'closed'/);
  assert.match(section, /\*\*scenario\*\*: nightly-green/);
});
