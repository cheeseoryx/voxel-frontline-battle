import { Context, inspectCatalogPlugins, installCatalogLoader } from '@forgeax/engine-plugin';
import { describe, expect, it } from 'vitest';
import { resolveRealmClosure } from '../project/realm-closure.js';

const placements = ['host', 'engine-main', 'engine-worker', 'build'] as const;

function moduleGraph() {
  return [
    { module: './root.ts', imports: ['./feature.ts'] },
    { module: './feature.ts', imports: ['./shared.ts'] },
    { module: './shared.ts', imports: [] },
  ];
}

describe('realm closure', () => {
  it('installs, inspects, and cleans the same catalog in every placement', async () => {
    const events: string[] = [];
    const plugin = {
      name: 'placement-probe',
      apply(ctx: Context) {
        events.push('apply');
        ctx.effect(() => () => events.push('dispose'));
      },
    };

    for (const placement of placements) {
      const realm = placement === 'host' ? 'host' : placement === 'build' ? 'build' : 'engine';
      const context = new Context();
      const { loader } = await installCatalogLoader(
        context,
        new Map([[`./${placement}.ts`, { realm, load: async () => ({ default: plugin }) }]]),
        realm,
      );
      await loader.root.update([{ id: placement, name: `./${placement}.ts` }]);
      await loader.await();
      expect(inspectCatalogPlugins(loader)).toMatchObject({
        live: [
          expect.objectContaining({
            id: placement,
            name: `./${placement}.ts`,
            entryId: placement,
            module: `./${placement}.ts`,
            realm,
            desiredState: 'enabled',
            fiberState: 'active',
            requiredServices: [],
            providedServices: [],
            configDigest: expect.stringMatching(/^fnv1a:/),
          }),
        ],
      });
      await loader.root.update([]);
      await loader.await();
      await context.fiber.dispose();
    }

    expect(events).toEqual([
      'apply',
      'dispose',
      'apply',
      'dispose',
      'apply',
      'dispose',
      'apply',
      'dispose',
    ]);
  });

  it('accepts one normalized graph in each physical placement', () => {
    for (const placement of placements) {
      const closure = resolveRealmClosure({
        entry: './root.ts',
        placement,
        modules: moduleGraph(),
      });

      expect(closure).toMatchObject({
        ok: true,
        value: {
          placement,
          modules: ['./root.ts', './feature.ts', './shared.ts'],
        },
      });
    }
  });

  it('returns the shortest chain for a multi-hop forbidden edge', () => {
    const closure = resolveRealmClosure({
      entry: './root.ts',
      placement: 'host',
      modules: [
        { module: './root.ts', imports: ['./feature.ts'] },
        { module: './feature.ts', imports: ['./renderer.ts'] },
        { module: './renderer.ts', imports: ['@forgeax/engine/app'] },
      ],
      realms: { '@forgeax/engine/app': 'engine' },
    });

    expect(closure).toMatchObject({
      ok: false,
      error: {
        code: 'realm-import-forbidden',
        detail: {
          chain: ['./root.ts', './feature.ts', './renderer.ts', '@forgeax/engine/app'],
          from: 'host',
          to: 'engine',
        },
      },
    });
  });

  it('fails closed for an unresolved import without evaluating project code', () => {
    const closure = resolveRealmClosure({
      entry: './root.ts',
      placement: 'engine-main',
      modules: [{ module: './root.ts', imports: ['./missing.ts'] }],
    });

    expect(closure).toMatchObject({
      ok: false,
      error: {
        code: 'realm-import-unresolved',
        detail: { chain: ['./root.ts', './missing.ts'] },
      },
    });
  });
});
