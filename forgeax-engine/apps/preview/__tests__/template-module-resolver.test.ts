import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import {
  resolveTemplateModule,
  TemplateModuleResolutionError,
  type TemplateManifest,
} from '../src/template-module-resolver';

const game3dManifestUrl = new URL('../../../templates/game-3d/forge.json', import.meta.url);

async function readGame3dManifest(): Promise<TemplateManifest> {
  return JSON.parse(await readFile(game3dManifestUrl, 'utf8')) as TemplateManifest;
}

describe('template module resolver', () => {
  it('keeps an authored-scene manifest with no plugins out of gameplay module loading', async () => {
    const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');

    expect(source).toContain("'../../../templates/*/assets/plugin.ts'");
    expect(source).toContain("'../../../apps/game-capability-lab/assets/capability-matrix.plugin.ts'");
    expect(source).toContain("'../../../apps/showcase/brotato-3d/assets/gameplay.plugin.ts'");
    expect(source).toContain("'../../game-capability-lab/forge.json'");
    expect(source).toContain("'../../showcase/brotato-3d/forge.json'");
    expect(source).not.toContain("'../../../templates/*/src/main.ts'");
    expect(source).toContain('manifest.plugins.length === 0');
    expect(source).toContain('if (loaded !== undefined) await app.pluginContext.plugin(loaded.value);');
    expect(source).toContain('defaultSceneRoot = instantiated.value;');
  });

  it.each([
    [
      'game-3d',
      './assets/plugin.ts',
      '../../../templates/game-3d/assets/plugin.ts',
    ],
    [
      'game-capability-lab',
      './assets/capability-matrix.plugin.ts',
      '../../game-capability-lab/assets/capability-matrix.plugin.ts',
    ],
    [
      'brotato-3d',
      './assets/gameplay.plugin.ts',
      '../../showcase/brotato-3d/assets/gameplay.plugin.ts',
    ],
  ])('selects the local authored plugin for %s', async (slug, pluginName, catalogKey) => {
    const gameplay = vi.fn(async () => ({ default: { apply() {} } }));
    const manifest =
      slug === 'game-3d'
        ? await readGame3dManifest()
        : { plugins: [{ name: pluginName, realm: 'engine' }] };
    const loader = resolveTemplateModule(slug, manifest, { [catalogKey]: gameplay });

    await loader();

    expect(gameplay).toHaveBeenCalledOnce();
  });

  it('treats an omitted realm as an Engine entry', async () => {
    const gameplay = vi.fn(async () => ({ default: { apply() {} } }));
    const loader = resolveTemplateModule(
      'omitted-realm',
      { plugins: [{ name: './assets/plugin.ts' }] },
      { '../../../templates/omitted-realm/assets/plugin.ts': gameplay },
    );

    await loader();

    expect(gameplay).toHaveBeenCalledOnce();
  });

  it('fails explicitly when a manifest has no catalog-backed local Engine module', () => {
    expect(() =>
      resolveTemplateModule(
        'package-only',
        {
          plugins: [{ name: '@forgeax/engine/physics/rapier3d', realm: 'engine' }],
        },
        {},
      ),
    ).toThrowError(TemplateModuleResolutionError);

    try {
      resolveTemplateModule(
        'package-only',
        {
          plugins: [{ name: '@forgeax/engine/physics/rapier3d', realm: 'engine' }],
        },
        {},
      );
    } catch (error: unknown) {
      expect(error).toMatchObject({
        code: 'no-local-engine-module',
        detail: { slug: 'package-only', candidates: [] },
      });
    }
  });

  it('fails explicitly when multiple local Engine modules match the catalog', () => {
    let caught: unknown;
    try {
      resolveTemplateModule(
        'ambiguous',
        {
          plugins: [
            { name: './assets/one.ts', realm: 'engine' },
            { name: './assets/two.ts', realm: 'engine' },
          ],
        },
        {
          '../../../templates/ambiguous/assets/one.ts': async () => ({ default: {} }),
          '../../../templates/ambiguous/assets/two.ts': async () => ({ default: {} }),
        },
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'ambiguous-local-engine-module',
      detail: {
        slug: 'ambiguous',
        matchedKeys: [
          '../../../templates/ambiguous/assets/one.ts',
          '../../../templates/ambiguous/assets/two.ts',
        ],
      },
    });
  });
});
