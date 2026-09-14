import { describe, expect, it } from 'vitest';
import {
  createContinuationTerminator,
  executeRendererFrameTransaction,
} from '../assembly/renderer-frame-transaction';

describe('renderer frame generation fence', () => {
  it('rejects a generation that changes between finish and submit', () => {
    const activeOwner = { scope: { generation: 3 } };
    const submitted: string[] = [];
    const result = executeRendererFrameTransaction({
      build: () => ({ ok: true, value: 'command' }),
      execute: () => ({ ok: true, value: undefined }),
      finish: () => {
        activeOwner.scope = { generation: 4 };
        return { ok: true, value: undefined };
      },
      submit: () => {
        submitted.push('stale-command');
        return { ok: true, value: undefined };
      },
      commit: () => undefined,
      generationFence: {
        capturedGeneration: 3,
        currentGeneration: () => activeOwner.scope.generation,
      },
    });

    expect(result).toEqual({ ok: false, error: { stage: 'submit' } });
    expect(submitted).toEqual([]);
  });

  it('terminates completion and all async continuations exactly once', async () => {
    const terminator = createContinuationTerminator();
    const completion = terminator.promise();

    expect(terminator.terminate({ code: 'device-lost' })).toBe(true);
    expect(terminator.terminate({ code: 'disposed' })).toBe(false);
    expect(terminator.isTerminated()).toBe(true);
    await expect(completion).resolves.toEqual({ code: 'device-lost' });

    expect(terminator.guard('readback')).toBe(false);
    expect(terminator.guard('query')).toBe(false);
    expect(terminator.guard('mapAsync')).toBe(false);
    expect(terminator.guard('queue-completion')).toBe(false);
  });
});
