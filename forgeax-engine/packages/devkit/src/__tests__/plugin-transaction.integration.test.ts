import { Context, type Plugin } from '@forgeax/engine-plugin';
import { installCatalogLoader, type PluginCatalog } from '@forgeax/engine-plugin/loader';
import { describe, expect, it } from 'vitest';

type PluginTransaction = {
  readonly inspect: () => Promise<unknown>;
  readonly configure: (id: string, config: unknown) => Promise<unknown>;
  readonly disable: (id: string) => Promise<unknown>;
  readonly enable: (id: string) => Promise<unknown>;
  readonly uninstall: (id: string) => Promise<unknown>;
  readonly install: (entry: unknown) => Promise<unknown>;
  readonly disconnect: () => Promise<unknown>;
};

async function loadTransactionFactory(): Promise<
  (input: Record<string, unknown>) => PluginTransaction
> {
  const modulePath = '../plugin/transaction.js';
  const module = (await import(modulePath)) as unknown as {
    readonly createPluginTransaction: (input: Record<string, unknown>) => PluginTransaction;
  };
  return module.createPluginTransaction;
}

function catalogOf(plugin: Plugin): PluginCatalog {
  return new Map([
    ['@game/feature', { realm: 'engine' as const, load: async () => ({ default: plugin }) }],
  ]);
}

describe('plugin authoring transaction', () => {
  it('commits all five mutations against one live Loader and preserves LKG on failure', async () => {
    const events: string[] = [];
    const feature: Plugin = {
      name: 'feature',
      apply(ctx: Context, config: { readonly value: number }) {
        events.push(`apply:${config.value}`);
        ctx.effect(() => () => events.push(`dispose:${config.value}`));
      },
    };
    const ctx = new Context();
    const { loader } = await installCatalogLoader(ctx, catalogOf(feature), 'engine');
    await loader.root.update([{ id: 'feature', name: '@game/feature', config: { value: 1 } }]);
    await loader.await();

    const createPluginTransaction = await loadTransactionFactory();
    let manifestText = JSON.stringify({
      id: 'fixture',
      name: 'Fixture',
      schemaVersion: '2.0.0',
      plugins: [{ id: 'feature', name: '@game/feature', realm: 'engine', config: { value: 1 } }],
    });
    const transaction = createPluginTransaction({
      root: '/tmp/forgeax-plugin-transaction',
      loader,
      readManifest: async () => manifestText,
      writeManifest: async (value: unknown) => {
        manifestText = JSON.stringify(value);
      },
    });

    await expect(transaction.inspect()).resolves.toMatchObject({
      desired: expect.any(Array),
      live: expect.any(Array),
    });
    await expect(transaction.configure('feature', { value: 2 })).resolves.toMatchObject({
      ok: true,
    });
    await expect(transaction.disable('feature')).resolves.toMatchObject({ ok: true });
    await expect(transaction.enable('feature')).resolves.toMatchObject({ ok: true });
    await expect(transaction.uninstall('feature')).resolves.toMatchObject({ ok: true });
    await expect(
      transaction.install({
        id: 'feature',
        name: '@game/feature',
        realm: 'engine',
        config: { value: 2 },
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(events).toEqual([
      'apply:1',
      'dispose:1',
      'apply:2',
      'dispose:2',
      'apply:2',
      'dispose:2',
      'apply:2',
    ]);
    await loader.root.update([]);
    await loader.await();
    await ctx.fiber.dispose();
  });

  it('projects Fiber state, service ownership, and a stable config digest', async () => {
    const provider: Plugin = {
      name: 'provider',
      provide: 'feature-service',
      apply(ctx: Context) {
        ctx.provide('feature-service', { ready: true });
      },
    };
    const ctx = new Context();
    const { loader } = await installCatalogLoader(ctx, catalogOf(provider), 'engine');
    await loader.root.update([
      {
        id: 'provider',
        name: '@game/feature',
        config: { enabled: true },
      },
    ]);
    await loader.await();

    const createPluginTransaction = await loadTransactionFactory();
    const transaction = createPluginTransaction({
      root: '/tmp/forgeax-plugin-transaction-inspect',
      loader,
      readManifest: async () =>
        JSON.stringify({
          id: 'fixture',
          name: 'Fixture',
          schemaVersion: '2.0.0',
          plugins: [
            {
              id: 'provider',
              name: '@game/feature',
              realm: 'engine',
              config: { enabled: true },
            },
          ],
        }),
      writeManifest: async () => undefined,
    });

    await expect(transaction.inspect()).resolves.toMatchObject({
      live: [
        {
          entryId: 'provider',
          module: '@game/feature',
          realm: 'engine',
          desiredState: 'enabled',
          fiberState: 'active',
          requiredServices: [],
          providedServices: ['feature-service'],
          configDigest: expect.stringMatching(/^fnv1a:/),
        },
      ],
    });
    await loader.root.update([]);
    await loader.await();
    await ctx.fiber.dispose();
  });

  it('returns a disconnect failure without replacing the live LKG', async () => {
    const ctx = new Context();
    const { loader } = await installCatalogLoader(ctx, catalogOf({ apply() {} }), 'engine');
    const createPluginTransaction = await loadTransactionFactory();
    const transaction = createPluginTransaction({
      root: '/tmp/forgeax-plugin-transaction',
      loader,
      readManifest: async () => '{}',
      writeManifest: async () => undefined,
    });

    await expect(transaction.disconnect()).rejects.toMatchObject({
      code: 'plugin-transaction-disconnected',
      detail: { live: 'last-known-good' },
    });
    await loader.root.update([]);
    await loader.await();
    await ctx.fiber.dispose();
  });

  it('keeps the manifest and live Fiber at LKG when persistence fails', async () => {
    const events: string[] = [];
    const feature: Plugin = {
      name: 'feature',
      apply(ctx: Context, config: { readonly value: number }) {
        events.push(`apply:${config.value}`);
        ctx.effect(() => () => events.push(`dispose:${config.value}`));
      },
    };
    const ctx = new Context();
    const { loader } = await installCatalogLoader(ctx, catalogOf(feature), 'engine');
    await loader.root.update([{ id: 'feature', name: '@game/feature', config: { value: 1 } }]);
    await loader.await();
    const originalManifest = JSON.stringify({
      id: 'fixture',
      name: 'Fixture',
      schemaVersion: '2.0.0',
      plugins: [{ id: 'feature', name: '@game/feature', realm: 'engine', config: { value: 1 } }],
    });
    const manifestText = originalManifest;
    const createPluginTransaction = await loadTransactionFactory();
    const transaction = createPluginTransaction({
      root: '/tmp/forgeax-plugin-transaction-lkg',
      loader,
      readManifest: async () => manifestText,
      writeManifest: async () => {
        throw new Error('disk-full');
      },
    });

    await expect(transaction.configure('feature', { value: 2 })).rejects.toThrow('disk-full');
    expect(manifestText).toBe(originalManifest);
    expect([...loader.entries()].map((entry) => entry.options.config)).toEqual([{ value: 1 }]);
    expect(events).toEqual(['apply:1', 'dispose:1', 'apply:2', 'dispose:2', 'apply:1']);
    await loader.root.update([]);
    await loader.await();
    await ctx.fiber.dispose();
  });
});
