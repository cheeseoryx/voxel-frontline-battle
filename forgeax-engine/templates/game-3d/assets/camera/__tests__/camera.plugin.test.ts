import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../camera.plugin.ts');

describe('game-3d camera owner', () => {
  it('owns pointer input and camera updates in one plugin', async () => {
    const text = await readFile(source, 'utf8');
    expect(text).toContain("name: 'game-3d/camera'");
    expect(text).toContain("inject: ['world', 'gameHost', 'game3dPlayer']");
    expect(text).toContain('playerService.readRig');
    expect(text).toContain("'game-3d/camera'");
  });
});
