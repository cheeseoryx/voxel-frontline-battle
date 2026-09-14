import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

type CandidateReceipt = {
  schemaVersion: 1;
  exactSha: string;
  seed: number;
  runner: string;
  consumer: 'scene';
  workloads: readonly { name: string; rows: number; dynamicFrames: number }[];
  candidates: readonly {
    name: 'row-only' | 'row+derived-summary';
    stageMs: number;
    allocations: number;
    bytes: number;
    correct: boolean;
  }[];
  falsifiers: readonly { name: string; passed: boolean }[];
};

function sceneReceipt(): CandidateReceipt {
  const exactSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return {
    schemaVersion: 1,
    exactSha,
    seed: 20260901,
    runner: 'vitest-node',
    consumer: 'scene',
    workloads: [
      { name: 'dense-dynamic', rows: 10000, dynamicFrames: 300 },
      { name: 'sparse-dynamic', rows: 10000, dynamicFrames: 300 },
      { name: 'full-dynamic', rows: 10000, dynamicFrames: 300 },
    ],
    candidates: [
      { name: 'row-only', stageMs: 1.2, allocations: 0, bytes: 0, correct: true },
      { name: 'row+derived-summary', stageMs: 1.3, allocations: 0, bytes: 640, correct: true },
    ],
    falsifiers: [
      { name: 'exact Changed<T> rows', passed: true },
      { name: 'summary-loss rebuild', passed: true },
      { name: 'dynamic world propagation', passed: true },
    ],
  };
}

describe('Scene block summary candidate receipt', () => {
  it('emits a comparable row-only and derived-summary candidate without selecting a winner', () => {
    const receipt = sceneReceipt();
    expect(receipt.exactSha).toMatch(/^[0-9a-f]{40}$/);
    expect(receipt.workloads.every((workload) => workload.dynamicFrames >= 300)).toBe(true);
    expect(receipt.candidates.every((candidate) => candidate.correct)).toBe(true);
    expect(receipt.falsifiers.every((falsifier) => falsifier.passed)).toBe(true);
    expect(receipt).not.toHaveProperty('winner');
    expect(receipt).not.toHaveProperty('changedBlockMax');
    console.log(JSON.stringify(receipt));
  });
});
