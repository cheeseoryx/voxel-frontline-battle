// @perf-budget-skip: intentional real Vite server integration gate.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { createServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';

const GUID = '01900000-0000-7000-8000-aaaaaaaaaaaa';

describe('DevSession through a real Vite server', () => {
  let root: string | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('serves one accepted scope, preserves it across failed rebind, and closes with 410', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-dev-session-vite-'));
    await mkdir(join(root, 'assets'));
    await writeFile(
      join(root, 'assets', 'effect.pack.json'),
      JSON.stringify({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: GUID,
            kind: 'test-effect',
            execution: 'direct',
            payload: { schemaVersion: 1 },
            refs: [],
            artifacts: {},
          },
        ],
      }),
    );
    const binding = createStandaloneRuntimeAssetBinding('vite-session');
    const plugin = pluginPack({
      roots: [join(root, 'assets')],
      runtimeBinding: binding,
    });
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();

    const baseUrl = server.resolvedUrls?.local[0];
    if (baseUrl === undefined) throw new Error('Vite did not expose a local URL');
    const catalogUrl = new URL(binding.catalogUrl, baseUrl).href;
    const catalog = await fetch(catalogUrl);
    expect(catalog.status).toBe(200);
    expect((await catalog.json()).entries).toHaveLength(1);

    await mkdir(join(root, 'broken-assets'));
    await writeFile(join(root, 'broken-assets', 'broken.pack.json'), '{broken');
    const failed = await plugin.rebind({ ...binding, generation: binding.generation + 1 }, [
      join(root, 'broken-assets'),
    ]);
    expect(failed.status).toBe('degraded');
    const retained = await fetch(catalogUrl);
    expect(retained.status).toBe(200);

    await plugin.closeBundle();
    const closed = await fetch(catalogUrl);
    expect(closed.status).toBe(410);
  }, 20_000);

  it('reopens the same plugin after Vite closes a sequential server', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-dev-session-vite-reopen-'));
    await mkdir(join(root, 'assets'));
    const binding = createStandaloneRuntimeAssetBinding('vite-session-reopen');
    const plugin = pluginPack({
      roots: [join(root, 'assets')],
      runtimeBinding: binding,
    });
    let first: Awaited<ReturnType<typeof createServer>> | undefined;
    let second: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      first = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [plugin],
        server: { host: '127.0.0.1', port: 0 },
      });
      await first.listen();
      const firstUrl = first.resolvedUrls?.local[0];
      if (firstUrl === undefined) throw new Error('first Vite server did not expose a local URL');
      expect((await fetch(new URL(binding.catalogUrl, firstUrl))).status).toBe(200);
      await first.close();
      first = undefined;

      second = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [plugin],
        server: { host: '127.0.0.1', port: 0 },
      });
      await second.listen();
      const secondUrl = second.resolvedUrls?.local[0];
      if (secondUrl === undefined) throw new Error('second Vite server did not expose a local URL');
      expect((await fetch(new URL(binding.catalogUrl, secondUrl))).status).toBe(200);
    } finally {
      await second?.close();
      await first?.close();
    }
  }, 20_000);
});
