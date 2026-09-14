import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../ui.plugin.ts');

describe('game-3d UI owner', () => {
  it('owns UI mounting and disposal in a plugin effect', async () => {
    const text = await readFile(source, 'utf8');
    expect(text).toContain("name: 'game-3d/ui'");
    expect(text).toContain("inject: ['world', 'gameHost']");
    expect(text).toContain("'game-3d/ui'");
  });
});
