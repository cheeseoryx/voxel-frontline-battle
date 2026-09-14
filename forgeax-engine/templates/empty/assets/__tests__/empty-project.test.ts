import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('empty template authoring contract', () => {
  it('has a strict project manifest and authored scene source', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8')) as {
      schemaVersion?: string;
      plugins?: unknown[];
      defaultScene?: string;
    };
    expect(manifest.schemaVersion).toBe('2.0.0');
    expect(manifest.plugins).toEqual([]);
    expect(manifest.defaultScene).toEqual(expect.any(String));
    const scene = JSON.parse(await readFile(resolve(root, 'assets/world/world.scene.pack.json'), 'utf8')) as {
      readonly assets: readonly {
        readonly sourceKey: string;
        readonly payload: { readonly entities: readonly { readonly components: Record<string, unknown> }[] };
      }[];
    };
    expect(scene.assets[0]?.payload.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          components: expect.objectContaining({ Transform: expect.any(Object), Camera: expect.any(Object) }),
        }),
        expect.objectContaining({
          components: expect.objectContaining({ MeshFilter: expect.any(Object), MeshRenderer: expect.any(Object) }),
        }),
        expect.objectContaining({
          components: expect.objectContaining({ DirectionalLight: expect.any(Object) }),
        }),
      ]),
    );
    expect(scene.assets.map((asset) => asset.sourceKey)).toEqual([
      'world/empty',
      'world/empty-subject',
      'world/empty-subject-material',
    ]);
    await access(resolve(root, 'assets/world/world.scene.pack.json'));
    await expect(access(resolve(root, 'src'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
