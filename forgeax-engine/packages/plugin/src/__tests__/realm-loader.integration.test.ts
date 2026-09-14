import { Context, type Plugin } from '@forgeax/engine-plugin';
import { describe, expect, it } from 'vitest';
import {
  installCatalogLoader,
  type PluginCatalog,
  type PluginRealm,
  projectPluginEntries,
} from '../loader.js';

function catalogOf(realm: PluginRealm, plugin: Plugin): PluginCatalog {
  return new Map([[`@game/${realm}`, { realm, load: async () => ({ default: plugin }) }]]);
}

describe('realm loader integration', () => {
  it('installs and cleans each physical realm from the same Catalog shape', async () => {
    const events: string[] = [];
    const plugin: Plugin = {
      apply(ctx) {
        events.push('apply');
        ctx.effect(() => () => events.push('dispose'));
      },
    };

    for (const realm of ['host', 'engine', 'build'] as const) {
      const context = new Context();
      const { loader } = await installCatalogLoader(context, catalogOf(realm, plugin), realm);
      await loader.root.update([{ id: `${realm}-plugin`, name: `@game/${realm}` }]);
      await loader.await();
      expect([...loader.entries()]).toHaveLength(1);
      await context.fiber.dispose();
    }

    expect(events).toEqual(['apply', 'dispose', 'apply', 'dispose', 'apply', 'dispose']);
  });

  it('rejects an entry that crosses a physical realm before activation', async () => {
    expect(() =>
      projectPluginEntries(
        [
          {
            id: 'root',
            name: 'cordis:group',
            group: true,
            realm: 'engine',
            config: [{ id: 'host', name: '@game/host', realm: 'host' }],
          },
        ],
        'engine',
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'plugin-entry-realm-mixed',
      }),
    );
  });
});
