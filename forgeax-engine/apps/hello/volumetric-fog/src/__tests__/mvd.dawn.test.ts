import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('volumetric fog Dawn MVD probe', () => {
  it('publishes a fresh-head artifact with capability, sample, memory and recovery facts', async () => {
    const result = await execFileAsync(
      process.execPath,
      [`${import.meta.dirname}/../../scripts/smoke-dawn.mjs`, '--json'],
      { env: { ...process.env, FORGEAX_DAWN_CHILD: '1' } },
    );
    const artifact = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(artifact.backend).toBe('dawn');
    expect(['pass', 'unavailable', 'mismatch']).toContain(artifact.oracle?.status);
    if (artifact.oracle?.status === 'pass') {
      expect(artifact.pass).toBe(true);
      expect(artifact.readback?.supported).toBe(true);
    } else {
      expect(artifact.pass).toBe(false);
    }
    expect(artifact.sample).toMatchObject({ generation: 1 });
    expect(artifact.recovery).toMatchObject({ status: 'not-needed' });
    expect(typeof artifact.head).toBe('string');
    expect((artifact.head as string).length).toBeGreaterThan(0);
    expect(artifact.memoryBytes).toBeGreaterThan(0);
  });
});
