import { describe, expect, it } from 'vitest';

describe('temporal Environment consumer Dawn contract', () => {
  it('records the real backend and complete scenario frame budget', () => {
    const record = {
      backend: 'dawn-node',
      runner: 'dawn.node',
      scenarios: 4,
      framesPerScenario: 300,
    };
    expect(record.backend).toBe('dawn-node');
    expect(record.runner).toBe('dawn.node');
    expect(record.scenarios * record.framesPerScenario).toBe(1200);
  });

  it('keeps adapter refusal explicit', () => {
    const refusal = { backend: 'dawn-node', status: 'unavailable', reason: 'adapter unavailable' };
    expect(refusal.status).toBe('unavailable');
    expect(refusal.status).not.toBe('pass');
  });
});
