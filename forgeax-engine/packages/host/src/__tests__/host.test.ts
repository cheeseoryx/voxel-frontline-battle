import { once } from 'node:events';
import { Context, definePluginGroup, type Plugin, usePlugin } from '@forgeax/engine-plugin';
import { describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import {
  attachHostWebSocketServer,
  createBackendHost,
  createFrontendHost,
  createHostAssembly,
  createHostTransport,
  createHostWebSocketClient,
  HostAssemblyError,
} from '../index';

function catalogFor(plugin: Plugin) {
  return new Map([
    [
      '@fixture/plugin',
      {
        realm: 'engine' as const,
        version: 'fixture-1',
        load: async () => ({ default: plugin }),
      },
    ],
  ]);
}

describe('Engine host pair', () => {
  it('activates a static frontend assembly through native Cordis Loader and unloads it', async () => {
    const events: string[] = [];
    const plugin: Plugin = {
      name: 'fixture',
      apply(ctx) {
        events.push('apply');
        ctx.effect(() => () => events.push('dispose'));
      },
    };
    const catalog = catalogFor(plugin);
    const host = await createFrontendHost({
      catalog,
      entries: [{ id: 'fixture', name: '@fixture/plugin' }],
    });
    expect(host.status.state).toBe('active');
    expect(events).toEqual(['apply']);
    await host.dispose();
    expect(events).toEqual(['apply', 'dispose']);
  });

  it('keeps backend assembly authoritative while preserving repeated Entry identity', async () => {
    const plugin: Plugin = { name: 'fixture', apply() {} };
    const catalog = catalogFor(plugin);
    const backend = await createBackendHost({
      catalog,
      entries: [
        { id: 'one', name: '@fixture/plugin', config: { value: 1 } },
        { id: 'two', name: '@fixture/plugin', config: { value: 2 } },
      ],
      modules: [{ name: '@fixture/plugin', realm: 'engine', version: 'fixture-1' }],
    });
    expect(backend.assembly.current.entries.map((entry) => entry.id)).toEqual(['one', 'two']);
    expect('set' in backend.assembly).toBe(false);
    const first = backend.assembly.current;
    const next = await backend.update({
      entries: [{ id: 'one', name: '@fixture/plugin', config: { value: 3 } }],
      modules: first.modules,
      config: { safe: true },
    });
    expect(next.revision).not.toBe(first.revision);
    expect(next.config).toEqual({ safe: true });
    await backend.dispose();
  });

  it('rejects a static Catalog whose code identity is older than the assembly', async () => {
    const plugin: Plugin = { name: 'stale-catalog', apply() {} };
    await expect(
      createFrontendHost({
        catalog: catalogFor(plugin),
        assembly: createHostAssembly({
          entries: [{ id: 'stale', name: '@fixture/plugin' }],
          modules: [{ name: '@fixture/plugin', realm: 'engine', version: 'fixture-2' }],
        }),
      }),
    ).rejects.toMatchObject({
      code: 'host-assembly-module-version-mismatch',
      detail: { actual: 'fixture-1', expected: 'fixture-2' },
    });
  });

  it('rejects a Catalog with no code identity for a versioned assembly', async () => {
    const plugin: Plugin = { name: 'unidentified-catalog', apply() {} };
    await expect(
      createFrontendHost({
        catalog: new Map([
          [
            '@fixture/plugin',
            { realm: 'engine' as const, load: async () => ({ default: plugin }) },
          ],
        ]),
        assembly: createHostAssembly({
          entries: [{ id: 'unidentified', name: '@fixture/plugin' }],
          modules: [{ name: '@fixture/plugin', realm: 'engine', version: 'fixture-2' }],
        }),
      }),
    ).rejects.toMatchObject({
      code: 'host-assembly-module-version-mismatch',
      detail: { actual: 'unknown', expected: 'fixture-2' },
    });
  });

  it('rejects a Catalog digest that is not named by the assembly', async () => {
    const plugin: Plugin = { name: 'orphan-digest', apply() {} };
    await expect(
      createFrontendHost({
        catalog: new Map([
          [
            '@fixture/plugin',
            {
              realm: 'engine' as const,
              digest: 'old-code',
              load: async () => ({ default: plugin }),
            },
          ],
        ]),
        assembly: createHostAssembly({
          entries: [{ id: 'orphan-digest', name: '@fixture/plugin' }],
          modules: [{ name: '@fixture/plugin', realm: 'engine', version: 'fixture-2' }],
        }),
      }),
    ).rejects.toMatchObject({
      code: 'host-assembly-module-version-mismatch',
      detail: { actual: 'old-code', expected: 'fixture-2' },
    });
  });

  it('rejects a backend Catalog that is older than its paired declaration', async () => {
    const plugin: Plugin = { name: 'backend-stale-catalog', apply() {} };
    await expect(
      createBackendHost({
        catalog: catalogFor(plugin),
        pairs: [
          {
            id: 'backend-stale',
            backend: {
              entry: { id: 'backend-stale-entry', name: '@fixture/plugin' },
              module: { name: '@fixture/plugin', realm: 'engine', version: 'fixture-2' },
            },
            frontend: {
              entry: { id: 'frontend-stale-entry', name: '@fixture/plugin' },
              module: { name: '@fixture/plugin', realm: 'engine', version: 'fixture-2' },
            },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'host-assembly-module-version-mismatch',
      detail: { actual: 'fixture-1', expected: 'fixture-2' },
    });
  });

  it('rejects a backend update whose Catalog is older than its paired declaration', async () => {
    const plugin: Plugin = { name: 'backend-update-stale-catalog', apply() {} };
    const pair = {
      id: 'backend-update-stale',
      backend: {
        entry: { id: 'backend-update-entry', name: '@fixture/plugin' },
        module: { name: '@fixture/plugin', realm: 'engine' as const, version: 'fixture-1' },
      },
      frontend: {
        entry: { id: 'frontend-update-entry', name: '@fixture/plugin' },
        module: { name: '@fixture/plugin', realm: 'engine' as const, version: 'fixture-1' },
      },
    };
    const backend = await createBackendHost({ catalog: catalogFor(plugin), pairs: [pair] });
    await expect(
      backend.update({
        pairs: [
          {
            ...pair,
            backend: {
              ...pair.backend,
              module: { ...pair.backend.module, version: 'fixture-2' },
            },
            frontend: {
              ...pair.frontend,
              module: { ...pair.frontend.module, version: 'fixture-2' },
            },
          },
        ],
        modules: [{ ...pair.frontend.module, version: 'fixture-2' }],
      }),
    ).rejects.toMatchObject({
      code: 'host-assembly-module-version-mismatch',
      detail: { actual: 'fixture-1', expected: 'fixture-2' },
    });
    await backend.dispose();
  });

  it('fetches backend assembly and reports actual frontend activation', async () => {
    const reports: string[] = [];
    const plugin: Plugin = { name: 'paired-fixture', apply() {} };
    const pair = {
      id: 'paired-fixture',
      backend: {
        entry: { id: 'paired-backend', name: '@fixture/plugin' },
        module: { name: '@fixture/plugin', realm: 'engine' as const, version: 'fixture-1' },
      },
      frontend: {
        entry: { id: 'paired-frontend', name: '@fixture/plugin' },
        module: { name: '@fixture/plugin', realm: 'engine' as const, version: 'fixture-1' },
      },
    };
    const backend = await createBackendHost({
      catalog: catalogFor(plugin),
      pairs: [pair],
      onActivationReport: (report) => {
        reports.push(`${report.state}:${report.revision}`);
      },
    });
    const client = backend.transport.connect();
    const frontend = await createFrontendHost({ catalog: catalogFor(plugin), transport: client });
    expect(frontend.assembly.current.pairs[0]?.id).toBe('paired-fixture');
    expect(frontend.status.state).toBe('active');
    expect(reports.some((report) => report.startsWith('active:'))).toBe(true);
    await frontend.dispose();
    client.close();
    await backend.dispose();
  });

  it('stages an explicit bootstrap assembly when a promoted backend reconnects', async () => {
    const provider: Plugin = {
      name: 'staged-provider',
      provide: 'physics',
      apply(ctx) {
        ctx.provide('physics', {});
      },
    };
    const gameChild: Plugin = {
      name: 'staged-game-child',
      inject: ['gameHost'],
      apply() {},
    };
    const game = definePluginGroup({
      name: 'staged-game',
      children: () => [usePlugin(gameChild, undefined, { key: 'child' })],
    });
    const modules = [
      { name: '@fixture/staged-provider', realm: 'engine' as const, version: 'fixture-1' },
      { name: '@fixture/staged-game', realm: 'engine' as const, version: 'fixture-1' },
    ];
    const catalog = new Map([
      [
        '@fixture/staged-provider',
        {
          realm: 'engine' as const,
          version: 'fixture-1',
          load: async () => ({ default: provider }),
        },
      ],
      [
        '@fixture/staged-game',
        { realm: 'engine' as const, version: 'fixture-1', load: async () => ({ default: game }) },
      ],
    ]);
    const bootstrap = createHostAssembly({
      entries: [{ id: 'provider', name: '@fixture/staged-provider' }],
      modules,
    });
    const full = createHostAssembly({
      entries: [
        { id: 'provider', name: '@fixture/staged-provider' },
        { id: 'game', name: '@fixture/staged-game' },
      ],
      modules,
    });
    const backend = await createBackendHost({ catalog, assembly: bootstrap });
    await backend.update({ entries: full.entries, modules: full.modules, backendEntries: [] });
    const client = backend.transport.connect();
    const frontend = await createFrontendHost({ catalog, transport: client, assembly: bootstrap });
    await frontend.context.plugin({
      name: 'staged-game-host',
      provide: 'gameHost',
      apply(ctx) {
        ctx.provide('gameHost', {});
      },
    });
    await frontend.update(full);
    expect(frontend.assembly.current.revision).toBe(full.revision);
    await frontend.dispose();
    client.close();
    await backend.dispose();
  });

  it('rejects a module code revision until the frontend Loader is reloaded', async () => {
    const plugin: Plugin = { name: 'reload-fixture', apply() {} };
    const initial = createHostAssembly({
      entries: [{ id: 'reload-entry', name: '@fixture/plugin' }],
      modules: [{ name: '@fixture/plugin', realm: 'engine', version: 'fixture-1' }],
    });
    const host = await createFrontendHost({ assembly: initial, catalog: catalogFor(plugin) });
    const next = createHostAssembly({
      entries: initial.entries,
      modules: [{ name: '@fixture/plugin', realm: 'engine', version: 'fixture-2' }],
    });

    await expect(host.update(next)).rejects.toMatchObject({
      code: 'host-assembly-reload-required',
      detail: {
        module: '@fixture/plugin',
        actual: 'fixture-1@<catalog>',
        expected: 'fixture-2@<catalog>',
      },
    });
    expect(host.assembly.current.revision).toBe(initial.revision);
    expect(host.status).toMatchObject({ state: 'active', revision: initial.revision });
    await host.dispose();
  });

  it('delivers a backend module URL across the real WebSocket boundary', async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('WebSocket port missing');
    const moduleUrl = `data:text/javascript,${encodeURIComponent(
      "export default { name: 'dynamic-fixture', apply() {} };",
    )}`;
    const pair = {
      id: 'dynamic-fixture',
      frontend: {
        entry: { id: 'dynamic-frontend', name: 'fixture:dynamic' },
        module: {
          name: 'fixture:dynamic',
          realm: 'engine' as const,
          version: 'fixture-1',
          url: moduleUrl,
        },
      },
    };
    const transport = createHostTransport();
    const reports: string[] = [];
    const backend = await createBackendHost({
      pairs: [pair],
      transport,
      onActivationReport: (report) => {
        reports.push(report.state);
      },
    });
    server.on('connection', (socket) => attachHostWebSocketServer(socket, transport));
    const client = await createHostWebSocketClient(new WebSocket(`ws://127.0.0.1:${address.port}`));
    const frontend = await createFrontendHost({ transport: client });
    expect(frontend.assembly.current.modules[0]?.url).toBe(moduleUrl);
    expect(frontend.status.state).toBe('active');
    expect(reports).toContain('active');
    await frontend.dispose();
    client.close();
    await backend.dispose();
    transport.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('withdraws the frontend capability when its backend connection closes', async () => {
    const plugin: Plugin = { name: 'disconnect-fixture', apply() {} };
    const pair = {
      id: 'disconnect-fixture',
      backend: {
        entry: { id: 'disconnect-backend', name: '@fixture/plugin' },
        module: { name: '@fixture/plugin', realm: 'engine' as const, version: 'fixture-1' },
      },
      frontend: {
        entry: { id: 'disconnect-frontend', name: '@fixture/plugin' },
        module: { name: '@fixture/plugin', realm: 'engine' as const, version: 'fixture-1' },
      },
    };
    const reports: string[] = [];
    const backend = await createBackendHost({
      catalog: catalogFor(plugin),
      pairs: [pair],
    });
    const client = backend.transport.connect();
    const frontend = await createFrontendHost({
      catalog: catalogFor(plugin),
      transport: client,
      reportStatus: (status) => {
        reports.push(status.state);
      },
    });
    backend.transport.close('backend stopped');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(client.connected).toBe(false);
    expect(frontend.status).toMatchObject({
      state: 'failed',
      revision: frontend.assembly.current.revision,
      error: { code: 'host-transport-failure' },
    });
    expect(reports).toContain('failed');
    await frontend.dispose();
    await backend.dispose();
  });

  it('rejects stale calls and withdraws pending services on invalidation', async () => {
    const transport = createHostTransport();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    transport.register('fixture', async ({ signal }) => {
      await Promise.race([
        pending,
        new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        ),
      ]);
      return 'done';
    });
    const client = transport.connect();
    const generation = transport.snapshot('fixture')?.generation;
    expect(generation).toBe(1);
    if (generation === undefined) throw new Error('fixture service generation is missing');
    const request = client.request('fixture', undefined, { generation });
    transport.invalidate('fixture');
    await expect(request).rejects.toBeDefined();
    await expect(client.request('fixture', undefined, { generation })).rejects.toMatchObject({
      code: 'host-assembly-stale-request',
    });
    release();
    client.close();
    transport.close();
  });

  it('keeps service generations monotonic across replacement and disposer races', async () => {
    const transport = createHostTransport();
    const handler = () => 'same-handler';
    const first = transport.register('fixture', handler);
    const client = transport.connect();
    const firstGeneration = transport.snapshot('fixture')?.generation;
    expect(firstGeneration).toBe(1);
    const second = transport.register('fixture', handler);
    first();
    expect(transport.snapshot('fixture')?.generation).toBe(2);
    if (firstGeneration === undefined) throw new Error('fixture generation is missing');
    await expect(
      client.request('fixture', undefined, { generation: firstGeneration }),
    ).rejects.toMatchObject({
      code: 'host-assembly-stale-request',
    });
    await expect(client.request('fixture', undefined)).resolves.toBe('same-handler');
    second();
    client.close();
    transport.close();
  });

  it('rejects a tampered assembly before plugin activation', async () => {
    const assembly = createHostAssembly({ entries: [], modules: [] });
    const host = await createFrontendHost({
      autoActivate: false,
      assembly: { ...assembly, revision: 'tampered' },
    }).catch((error) => error);
    expect(host).toBeInstanceOf(HostAssemblyError);
    expect((host as HostAssemblyError).code).toBe('host-assembly-revision-mismatch');
    const context = new Context();
    await context.fiber.dispose();
  });

  it('exercises the WebSocket host boundary with request, cancellation, and close', async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('WebSocket port missing');
    const transport = createHostTransport();
    let cancelled = false;
    let resolveCancellation: (() => void) | undefined;
    const cancellationObserved = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    transport.register('echo', ({ payload }) => payload);
    transport.register(
      'pending',
      ({ signal }) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => {
            cancelled = true;
            resolveCancellation?.();
            reject(new Error('cancelled'));
          });
        }),
    );
    server.on('connection', (socket) => attachHostWebSocketServer(socket, transport));
    const client = await createHostWebSocketClient(new WebSocket(`ws://127.0.0.1:${address.port}`));
    await expect(client.request('echo', { ok: true })).resolves.toEqual({ ok: true });
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      client.request('echo', undefined, { signal: preAborted.signal }),
    ).rejects.toMatchObject({ code: 'host-assembly-request-aborted' });
    const controller = new AbortController();
    const pending = client.request('pending', undefined, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'host-assembly-request-aborted' });
    await cancellationObserved;
    expect(cancelled).toBe(true);
    client.close();
    const closeClient = await createHostWebSocketClient(
      new WebSocket(`ws://127.0.0.1:${address.port}`),
    );
    const pendingOnClose = closeClient.request('pending', undefined);
    closeClient.close('test close');
    await expect(pendingOnClose).rejects.toMatchObject({ code: 'host-transport-failure' });
    transport.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
