import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const read = (path) => readFileSync(resolve(path), 'utf8');
const ci = read('.github/workflows/ci.yml');
const candidate = read('.github/workflows/sdk-release-candidate.yml');
const promotion = read('.github/workflows/sdk-release-promote.yml');
const cleanup = read('.github/workflows/actions-artifact-cleanup.yml');
const nativeRayQuery = read('.github/workflows/native-ray-query.yml');
const upload = read('.github/actions/upload-artifact-with-retry/action.yml');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing section: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing section end: ${endMarker}`);
  return source.slice(start, end);
}

test('artifact retry stays idempotent and never creates a retry-named full copy', () => {
  assert.match(upload, /description: .*without creating duplicate artifacts/);
  assert.match(upload, /name: \$\{\{ inputs\.name \}\}[\s\S]*?overwrite: true/);
  assert.doesNotMatch(upload, /-retry-[12]-a/);
  assert.doesNotMatch(upload, /retry_2/);
  assert.match(upload, /Fail after exhausted artifact transfer/);
});

test('daily CI uploads only artifacts with an actual downstream consumer', () => {
  const webkit = section(ci, '  webkit-fallback:\n', '  portability-bun:\n');
  const browser = section(ci, '  metrics-validate-browser:\n', '  metrics-validate-runtime:\n');
  const runtime = section(ci, '  metrics-validate-runtime:\n', '  metrics-validate:\n');
  const metrics = section(ci, '  metrics-validate:\n', '  collectathon-boot-e2e:\n');
  const smoke = section(ci, '  smoke-fleet:\n', '  smoke-fleet-required-context:\n');

  assert.match(webkit, /chromium-fallback-color-lighting-status[\s\S]*?retention-days: 1/);
  assert.match(
    webkit,
    /Upload Chromium fallback lifecycle evidence[\s\S]*?if: failure\(\)[\s\S]*?retention-days: 1/,
  );
  assert.match(browser, /Stage browser metrics evidence\n\s+if: success\(\)/);
  assert.match(
    browser,
    /Upload browser metrics evidence\n\s+id: upload-metrics-browser-evidence\n\s+if: success\(\)/,
  );
  assert.match(runtime, /Stage runtime metrics evidence\n\s+if: success\(\)/);
  assert.match(
    runtime,
    /Upload runtime metrics evidence\n\s+id: upload-metrics-runtime-evidence\n\s+if: success\(\)/,
  );
  assert.match(
    metrics,
    /id: render-metrics-report[\s\S]*?id: upload-metrics-report[\s\S]*?github\.event_name == 'pull_request'[\s\S]*?steps\.render-metrics-report\.outcome == 'success'[\s\S]*?path: report\/sticky-comment\.md/,
  );
  assert.doesNotMatch(metrics, /path: report\/\n/);
  assert.match(
    smoke,
    /Upload Directional CSM MVD evidence \(deferred-to-PR\)[\s\S]*?if: github\.event_name == 'pull_request' && matrix\.group == 1[\s\S]*?retention-days: 1/,
  );
});

test('failed CI runs retain producer artifacts for failed-job reruns', () => {
  const cleanup = ci.slice(ci.indexOf('  cleanup-transient-artifacts:\n'));
  assert.match(
    cleanup,
    /if: >-\n\s+always\(\) && !contains\(needs\.\*\.result, 'failure'\) &&\n\s+!contains\(needs\.\*\.result, 'cancelled'\)/,
  );
});

test('SDK candidate keeps one payload plus small seal metadata until promotion', () => {
  const build = section(candidate, '  build-sdk:\n', '  npm-consumer:\n');
  const seedToSeal = candidate.slice(
    candidate.indexOf('  build-sdk:\n'),
    candidate.indexOf('  seal:\n'),
  );
  assert.match(build, /name: sdk-candidate-\$\{\{ github\.run_id \}\}/);
  assert.match(build, /artifacts\/sdk\/forgeax-sdk-v\$\{\{ env\.SDK_VERSION \}\}\.zip/);
  assert.match(build, /artifacts\/sdk\/sdk-build-result\.json/);
  assert.match(build, /artifacts\/sdk\/npm/);
  assert.doesNotMatch(build, /path: artifacts\/sdk\n/);
  assert.match(build, /compression-level: 0/);
  assert.match(build, /retention-days: 14/);
  assert.equal((seedToSeal.match(/retention-days: 1\b/g) ?? []).length, 4);
  const seal = section(candidate, '  seal:\n', '  cleanup-transient-artifacts:\n');
  assert.match(seal, /name: sdk-candidate-\$\{\{ github\.run_id \}\}-seal/);
  assert.match(seal, /artifacts\/sdk\/sdk-candidate\.json[\s\S]*?artifacts\/sdk\/gates/);
  assert.match(seal, /retention-days: 14/);
  assert.match(candidate, /KEEP_CANDIDATE_PAYLOAD/);
  assert.match(candidate, /KEEP_CANDIDATE_SEAL/);
  assert.match(candidate, /--preserve-name/);
  assert.match(promotion, /retention-days: 14/);
  assert.match(promotion, /cleanup-promoted-candidate:/);
  assert.match(promotion, /--run-id "\$CANDIDATE_RUN_ID"/);
});

test('workflow_run backstop cleans cancelled source runs without touching a valid seal', () => {
  assert.match(cleanup, /workflow_run:/);
  assert.match(cleanup, /- CI\n\s+- emscripten-no-xz-evidence\n\s+- SDK Release Candidate/);
  assert.match(cleanup, /SOURCE_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(cleanup, /SOURCE_EVENT: \$\{\{ github\.event\.workflow_run\.event \}\}/);
  assert.match(cleanup, /SOURCE_RUN_ATTEMPT: \$\{\{ github\.event\.workflow_run\.run_attempt \}\}/);
  assert.match(cleanup, /SOURCE_CONCLUSION/);
  assert.match(
    cleanup,
    /SOURCE_WORKFLOW.*CI.*SOURCE_EVENT.*workflow_dispatch[\s\S]*?--preserve-name "core-build-a\$\{source_attempt\}"[\s\S]*?--preserve-name "shared-app-inputs-a\$\{source_attempt\}"/,
  );
  assert.match(cleanup, /--preserve-name "sdk-candidate-\$\{SOURCE_RUN_ID\}"/);
  assert.match(cleanup, /--preserve-name "sdk-candidate-\$\{SOURCE_RUN_ID\}-seal"/);
  assert.match(cleanup, /actions: write/);
});

test('diagnostic-only native evidence cannot fail a passing gate when quota is full', () => {
  assert.match(
    nativeRayQuery,
    /Upload native evidence[\s\S]*?uses: \.\/\.github\/actions\/upload-optional-artifact/,
  );
  assert.match(
    nativeRayQuery,
    /Upload upstream evidence[\s\S]*?uses: \.\/\.github\/actions\/upload-optional-artifact/,
  );
});
