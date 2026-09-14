import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readProjectFacts } from '../project.js';

async function project(forge: unknown, manifest: unknown): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-project-'));
  await Promise.all([
    writeFile(resolve(root, 'forge.json'), `${JSON.stringify(forge)}\n`),
    writeFile(resolve(root, 'package.json'), `${JSON.stringify(manifest)}\n`),
    writeFile(resolve(root, 'main.ts'), 'export async function bootstrap() {}\n'),
  ]);
  return root;
}

describe('readProjectFacts', () => {
  it('keeps the game-3d physics backend as a manifest-owned plugin', async () => {
    const templateRoot = resolve(import.meta.dirname, '../../../../templates/game-3d');
    const result = await readProjectFacts(templateRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.plugins).toEqual([
      { id: 'rapier3d', name: '@forgeax/engine/physics/rapier3d', realm: 'engine' },
      { id: 'game', name: './assets/plugin.ts', inject: ['physics'], realm: 'engine' },
    ]);
    expect(result.value).not.toHaveProperty('physics');
    const module = await import('@forgeax/engine-physics/rapier3d');
    expect(module.default).toMatchObject({ name: 'physics', provide: 'physics' });
  });

  it('derives defaults from the manifest plugin tree', async () => {
    const root = await project(
      {
        id: 'game',
        name: 'Game',
        schemaVersion: '2.0.0',
        plugins: [{ id: 'gameplay', name: './main.ts', realm: 'engine' }],
        defaultScene: 'c5def54a-ed2b-4fa1-9535-8e1b18cb9f5b',
      },
      { name: 'game', forgeax: {} },
    );
    const result = await readProjectFacts(root);
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        root,
        id: 'game',
        name: 'Game',
        plugins: [{ id: 'gameplay', name: './main.ts', realm: 'engine' }],
        defaultScene: 'c5def54a-ed2b-4fa1-9535-8e1b18cb9f5b',
        assetRoots: ['assets'],
      }),
    });
  });

  it('fails when a local plugin module is missing', async () => {
    const root = await project(
      {
        id: 'game',
        name: 'Game',
        schemaVersion: '2.0.0',
        plugins: [{ id: 'gameplay', name: './missing.ts', realm: 'engine' }],
      },
      { name: 'game' },
    );
    const result = await readProjectFacts(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('project-plugin-missing');
  });

  it('accepts an empty plugin tree without a bootstrap module', async () => {
    const root = await project(
      {
        id: 'game',
        name: 'Game',
        schemaVersion: '2.0.0',
        plugins: [],
      },
      { name: 'game' },
    );
    const result = await readProjectFacts(root);
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        plugins: [],
      }),
    });
  });

  it('uses the fixed assets content root', async () => {
    const root = await project(
      {
        id: 'game',
        name: 'Game',
        schemaVersion: '2.0.0',
        plugins: [{ id: 'gameplay', name: './main.ts', realm: 'engine' }],
      },
      {
        name: 'game',
        forgeax: {},
      },
    );
    const result = await readProjectFacts(root);
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        assetRoots: ['assets'],
      }),
    });
  });

  it('rejects realm Entries the standalone host cannot activate', async () => {
    const root = await project(
      {
        id: 'game',
        name: 'Game',
        schemaVersion: '2.0.0',
        plugins: [{ id: 'host-tools', name: './main.ts', realm: 'host' }],
      },
      { name: 'game' },
    );
    const result = await readProjectFacts(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('project-plugin-realm-unsupported');
  });
});
