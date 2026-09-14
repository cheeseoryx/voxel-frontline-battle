import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../capability-matrix.plugin.ts');

describe('capability lab owner', () => {
  it('declares capabilities through one plugin group', async () => {
    const text = await readFile(source, 'utf8');
    expect(text).toContain('definePluginGroup');
    expect(text).toContain('usePlugin');
    expect(text).toContain('capability');
  });
});
