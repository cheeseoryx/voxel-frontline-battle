import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../world.plugin.ts');

describe('game-3d world owner', () => {
  it('owns scene and physics setup through a plugin group', async () => {
    const text = await readFile(source, 'utf8');
    expect(text).toContain("name: 'game-3d/world'");
    expect(text).toContain("inject: ['world']");
    expect(text).toContain('game-3d/world-owner');
  });
});
