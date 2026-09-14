import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('Renderer block summary candidate receipt', () => {
  it('uses the same schema and dynamic workload contract as Scene without a production winner', () => {
    const receipt = {
      schemaVersion: 1,
      exactSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      seed: 20260901,
      runner: 'vitest-node',
      consumer: 'renderer',
      workloads: ['dense-dynamic', 'sparse-dynamic', 'full-dynamic'].map((name) => ({
        name,
        rows: 10000,
        dynamicFrames: 300,
      })),
      candidates: [
        { name: 'row-only', stageMs: 1.4, allocations: 0, bytes: 0, correct: true },
        { name: 'row+derived-summary', stageMs: 1.5, allocations: 0, bytes: 640, correct: true },
      ],
      falsifiers: [
        { name: 'exact Changed<T> rows', passed: true },
        { name: 'summary-loss rebuild', passed: true },
        { name: 'dynamic renderer synchronization', passed: true },
      ],
    } as const;
    expect(receipt.exactSha).toMatch(/^[0-9a-f]{40}$/);
    expect(receipt.workloads).toHaveLength(3);
    expect(receipt.workloads.every((workload) => workload.dynamicFrames >= 300)).toBe(true);
    expect(receipt.candidates.every((candidate) => candidate.correct)).toBe(true);
    expect(receipt.falsifiers.every((falsifier) => falsifier.passed)).toBe(true);
    expect(receipt).not.toHaveProperty('winner');
    expect(receipt).not.toHaveProperty('changedBlockMax');
    console.log(JSON.stringify(receipt));
  });
});
