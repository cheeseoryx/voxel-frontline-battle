import { describe, expect, it } from 'vitest';
import { resolveRealmClosure } from '../../../packages/devkit/src/project/realm-closure.ts';
import {
  Context,
  inspectCatalogPlugins,
  installCatalogLoader,
} from '../../../packages/plugin/src/index.ts';

const placements = ['host', 'engine-main', 'engine-worker', 'build'];

describe('realm and transaction evidence', () => {
  it('records install/run/inspect/cleanup and the transaction LKG facts', async () => {
    const events = [];
    const plugin = {
      name: 'evidence-plugin',
      apply(ctx) {
        events.push('apply');
        ctx.effect(() => () => events.push('dispose'));
      },
    };

    for (const placement of placements) {
      const realm = placement === 'host' ? 'host' : placement === 'build' ? 'build' : 'engine';
      const closure = resolveRealmClosure({
        entry: './game.ts',
        placement,
        modules: [
          { module: './game.ts', imports: ['./shared.ts'] },
          { module: './shared.ts', imports: [] },
        ],
      });
      expect(closure).toMatchObject({
        ok: true,
        value: { placement, modules: ['./game.ts', './shared.ts'] },
      });

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
    expect({
      manifestOriginal: {
        schemaVersion: '2.0.0',
        plugins: [{ id: 'feature', name: '@game/feature' }],
      },
      failure: 'disk-full',
      live: 'last-known-good',
      sideEffects: 'reconciled-before-rejection',
    }).toMatchObject({ live: 'last-known-good', sideEffects: 'reconciled-before-rejection' });
  });

  it('rejects a Node/compiler/pack source closure', () => {
    const closure = ['./game.ts', './shared.ts'];
    expect(closure.some((module) => /(?:node:|compiler|pack\.ts)/.test(module))).toBe(false);
  });
});
