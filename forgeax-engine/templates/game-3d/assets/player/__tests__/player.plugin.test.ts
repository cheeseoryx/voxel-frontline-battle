import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../player.plugin.ts');

describe('game-3d player owner', () => {
  it('uses the fixed-step world and the physics provider', async () => {
    const text = await readFile(source, 'utf8');
    expect(text).toContain("name: 'game-3d/player'");
    expect(text).toContain("provide: 'game3dPlayer'");
    expect(text).toContain("inject: ['world', 'physics', 'gameHost']");
    expect(text).toContain("'game-3d/player'");
  });
});
