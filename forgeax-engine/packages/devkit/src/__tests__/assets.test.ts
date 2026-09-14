import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assetAddCommand,
  assetInspectCommand,
  assetListCommand,
  assetVerifyCommand,
} from '../assets.js';

async function fixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-assets-'));
  await Promise.all([
    writeFile(
      resolve(root, 'forge.json'),
      `${JSON.stringify({ id: 'game', name: 'Game', schemaVersion: '2.0.0', plugins: [{ id: 'gameplay', name: './main.ts', realm: 'engine' }] })}\n`,
    ),
    writeFile(resolve(root, 'package.json'), '{"name":"game"}\n'),
    writeFile(resolve(root, 'main.ts'), 'export async function bootstrap() {}\n'),
  ]);
  await (await import('node:fs/promises')).mkdir(resolve(root, 'assets'));
  await writeFile(resolve(root, 'assets', 'hero.png'), new Uint8Array([1, 2, 3]));
  return root;
}

describe('asset commands', () => {
  it('adds an image once and reuses its GUID', async () => {
    const root = await fixture();
    const first = await assetAddCommand({ root, path: 'assets/hero.png' });
    expect(first.ok).toBe(true);
    const before = await readFile(resolve(root, 'assets', 'hero.png.meta.json'), 'utf8');
    const second = await assetAddCommand({ root, path: 'assets/hero.png' });
    expect(second.ok).toBe(true);
    expect(await readFile(resolve(root, 'assets', 'hero.png.meta.json'), 'utf8')).toBe(before);
    const listed = await assetListCommand({ root });
    expect(listed).toEqual({
      ok: true,
      value: [expect.objectContaining({ kind: 'texture', name: 'texture' })],
    });
  });

  it('does not write a sidecar during dry-run', async () => {
    const root = await fixture();
    const result = await assetAddCommand({ root, path: 'assets/hero.png', dryRun: true });
    expect(result.ok).toBe(true);
    await expect(readFile(resolve(root, 'assets', 'hero.png.meta.json'))).rejects.toThrow();
  });

  it('routes v3 Pack queries through the Pack authoring operation envelope', async () => {
    const root = await fixture();
    const packageId = '01900000-0000-7000-8000-000000000080';
    await writeFile(
      resolve(root, 'assets', 'direct.pack.json'),
      `${JSON.stringify({
        schemaVersion: '3.0.0',
        packageId,
        assets: { 'scene/main': { kind: 'scene', payload: {}, refs: [] } },
      })}\n`,
    );

    const listed = await assetListCommand({ root });
    expect(listed).toMatchObject({
      ok: true,
      value: {
        sources: [{ packageId, format: 'direct' }],
        assets: [{ packageId, sourceKey: 'scene/main', status: 'identity' }],
      },
    });
    const inspected = await assetInspectCommand({ root, subject: packageId });
    expect(inspected).toMatchObject({ ok: true, value: { packageId, format: 'direct' } });
    const verified = await assetVerifyCommand({ root });
    expect(verified).toMatchObject({ ok: true, value: { snapshot: { sourceCount: 1 } } });
  });
});
