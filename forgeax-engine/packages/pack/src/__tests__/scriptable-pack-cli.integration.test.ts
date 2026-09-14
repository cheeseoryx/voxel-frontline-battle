// @perf-budget-skip: intentional ScriptablePack CLI integration gate.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCliAsset } from '../cli-asset.js';

describe('ScriptablePack CLI Meta inspection', () => {
  it('loads the definition without invoking build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-pack-'));
    try {
      const source = join(root, 'house.pack.mjs');
      await writeFile(
        source,
        `
        export default {
          schemaVersion: '2.0.0',
          packageId: new Uint8Array([1, 159, 250, 151, 139, 57, 122, 210, 132, 204, 39, 50, 104, 89, 26, 180]),
          build() { throw new Error('META_MUST_NOT_BUILD'); }
        };
      `,
      );
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCliAsset(['meta', source, '--json'], {
        stdoutWrite: (line) => stdout.push(line),
        stderrWrite: (line) => stderr.push(line),
        cwd: root,
      });
      expect(code).toBe(0);
      expect(stderr).toEqual([]);
      expect(JSON.parse(stdout[0] ?? '{}')).toMatchObject({
        kind: 'scriptable-pack-source',
        source,
        packageId: '019ffa97-8b39-7ad2-84cc-273268591ab4',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
