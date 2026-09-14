import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PluginTransaction } from '../plugin-authoring.js';
import {
  pluginConfigureCommand,
  pluginDisableCommand,
  pluginEnableCommand,
  pluginInspectCommand,
  pluginInstallCommand,
  pluginUninstallCommand,
} from '../plugin-authoring.js';

async function project(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-plugin-authoring-'));
  await Promise.all([
    writeFile(
      resolve(root, 'forge.json'),
      `${JSON.stringify({
        id: 'game',
        name: 'Game',
        schemaVersion: '2.0.0',
        plugins: [{ id: 'base', name: './main.ts', realm: 'engine' }],
      })}\n`,
    ),
    writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
    writeFile(resolve(root, 'feature.ts'), 'export default () => undefined;\n'),
  ]);
  return root;
}

describe('plugin authoring transaction', () => {
  it('installs and uninstalls a local module through forge.json Entry identity', async () => {
    const root = await project();
    const installed = await pluginInstallCommand({
      root,
      id: 'feature',
      module: './feature.ts',
      realm: 'engine',
    });
    expect(installed.ok).toBe(true);
    let manifest = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8')) as {
      plugins: Array<{ id: string; name: string }>;
    };
    expect(manifest.plugins).toContainEqual(
      expect.objectContaining({ id: 'feature', name: './feature.ts' }),
    );

    const uninstalled = await pluginUninstallCommand({ root, id: 'feature' });
    expect(uninstalled.ok).toBe(true);
    manifest = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8')) as typeof manifest;
    expect(manifest.plugins.map((entry) => entry.id)).toEqual(['base']);
  });

  it('does not mutate the manifest when the Entry id conflicts', async () => {
    const root = await project();
    const before = await readFile(resolve(root, 'forge.json'), 'utf8');
    const result = await pluginInstallCommand({ root, id: 'base', module: './other.ts' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('plugin-entry-id-conflict');
    expect(await readFile(resolve(root, 'forge.json'), 'utf8')).toBe(before);
  });

  it('rejects an unresolved candidate before manifest mutation', async () => {
    const root = await project();
    const before = await readFile(resolve(root, 'forge.json'), 'utf8');
    const result = await pluginInstallCommand({
      root,
      id: 'missing',
      module: './does-not-exist.ts',
      realm: 'engine',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('plugin-module-missing');
    expect(await readFile(resolve(root, 'forge.json'), 'utf8')).toBe(before);
  });

  it('exposes inspect and offline lifecycle mutations with explicit liveState', async () => {
    const root = await project();
    const inspected = await pluginInspectCommand({ root });
    expect(inspected).toMatchObject({ ok: true, value: { liveState: 'unavailable' } });
    const configured = await pluginConfigureCommand({
      root,
      id: 'base',
      config: { enabled: true },
    });
    expect(configured).toMatchObject({ ok: true, value: { operation: 'configure' } });
    const disabled = await pluginDisableCommand({ root, id: 'base' });
    expect(disabled).toMatchObject({ ok: true, value: { operation: 'disable' } });
    const enabled = await pluginEnableCommand({ root, id: 'base' });
    expect(enabled).toMatchObject({ ok: true, value: { operation: 'enable' } });
    const manifest = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8')) as {
      plugins: Array<{ id: string; disabled?: boolean; config?: unknown }>;
    };
    expect(manifest.plugins[0]).toMatchObject({
      id: 'base',
      disabled: false,
      config: { enabled: true },
    });
  });

  it('inspects the canonical game-3d ESM and Vite-backed group entries', async () => {
    const root = resolve(import.meta.dirname, '../../../../templates/game-3d');
    const inspected = await pluginInspectCommand({ root });
    expect(inspected).toMatchObject({
      ok: true,
      value: {
        desired: expect.arrayContaining([
          expect.objectContaining({ id: 'rapier3d', module: '@forgeax/engine/physics/rapier3d' }),
          expect.objectContaining({ id: 'game', module: './assets/plugin.ts' }),
        ]),
      },
    });
  }, 30_000);

  it('rejects Plugin.Config failures before changing the manifest', async () => {
    const root = await project();
    await writeFile(
      resolve(root, 'schema.ts'),
      `const plugin = () => undefined;
plugin.Config = {
  '~standard': {
    version: 1,
    vendor: 'fixture',
    validate(value) {
      return value !== null && typeof value === 'object' && typeof value.enabled === 'boolean'
        ? { value }
        : { issues: [{ message: 'enabled must be boolean' }] };
    },
  },
};
export default plugin;
`,
    );
    await writeFile(
      resolve(root, 'forge.json'),
      `${JSON.stringify({
        id: 'game',
        name: 'Game',
        schemaVersion: '2.0.0',
        plugins: [
          { id: 'schema', name: './schema.ts', realm: 'engine', config: { enabled: true } },
        ],
      })}\n`,
    );
    const before = await readFile(resolve(root, 'forge.json'), 'utf8');
    const result = await pluginConfigureCommand({
      root,
      id: 'schema',
      config: { enabled: 'yes' },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'plugin-config-invalid' } });
    expect(await readFile(resolve(root, 'forge.json'), 'utf8')).toBe(before);
  });

  it('rejects dependency mutation when a live transaction is attached', async () => {
    const root = await project();
    const before = await readFile(resolve(root, 'forge.json'), 'utf8');
    let called = false;
    const transaction = {
      install: async () => {
        called = true;
        return { ok: true as const };
      },
      uninstall: async () => ({ ok: true as const }),
      configure: async () => ({ ok: true as const }),
      disable: async () => ({ ok: true as const }),
      enable: async () => ({ ok: true as const }),
      inspect: async () => ({ desired: [], live: [], entries: [] }),
      disconnect: async () => {
        throw new Error('disconnected');
      },
    } as unknown as PluginTransaction;

    const installed = await pluginInstallCommand({
      root,
      id: 'dependency-install',
      module: './feature.ts',
      dependency: '@example/weather',
      transaction,
    });
    expect(installed).toMatchObject({
      ok: false,
      error: { code: 'plugin-dependency-transaction-unsupported' },
    });
    expect(called).toBe(false);
    expect(await readFile(resolve(root, 'forge.json'), 'utf8')).toBe(before);

    const uninstalled = await pluginUninstallCommand({
      root,
      id: 'base',
      dependency: '@example/weather',
      transaction,
    });
    expect(uninstalled).toMatchObject({
      ok: false,
      error: { code: 'plugin-dependency-transaction-unsupported' },
    });
    expect(await readFile(resolve(root, 'forge.json'), 'utf8')).toBe(before);
  });
});
