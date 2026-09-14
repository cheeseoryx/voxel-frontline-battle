import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../smoke-rhinull.mjs', import.meta.url));
const cwd = fileURLToPath(new URL('../..', import.meta.url));

function run(env = {}) {
  return spawnSync(process.execPath, [script], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('admits the default carrier as a structural-only 300-frame matrix', () => {
  const result = run();
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.structuralOnly, true);
  assert.equal(report.acceptance, 'structural-only');
  assert.equal(report.pixel, 'not-applicable');
  assert.equal(report.framesObserved, 300);
  assert.equal(report.matrix.topology.targetCount, 1);
  assert.equal(report.matrix.zeroWork.byteLength, 0);
  assert.equal(report.matrix.failureRecovery.recovered, true);
  assert.equal(report.capabilityUnavailable.reason, 'capability-missing');
  assert.equal(report.capabilityUnavailable.requiredVisualFailure, false);
});

test('required evidence mode preserves the structural-only result', () => {
  const result = run({ FORGEAX_REQUIRED_EVIDENCE: '1' });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.structuralOnly, true);
  assert.equal(report.acceptance, 'structural-only');
  assert.equal(report.pixel, 'not-applicable');
  assert.equal(report.framesObserved, 300);
});
