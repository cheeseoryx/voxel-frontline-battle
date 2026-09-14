import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runUnifiedCli } from '../unified-cli.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-unified-cli-'));
  roots.push(root);
  await writeFile(join(root, 'package.json'), '{"name":"unified-cli-fixture","type":"module"}\n');
  await writeFile(
    join(root, 'forge.json'),
    JSON.stringify({
      id: 'unified-cli-fixture',
      name: 'Unified CLI fixture',
      schemaVersion: '2.0.0',
      plugins: [],
    }),
  );
  return root;
}

describe('unified CLI', () => {
  it('uses one registry for progressive and recursive help', async () => {
    const root = await fixtureRoot();
    const immediate = await runUnifiedCli(['help', '--root', root, '--json']);
    expect(immediate.ok).toBe(true);
    const nodes = (immediate.value as { readonly nodes: readonly { readonly name: string }[] })
      .nodes;
    expect(nodes.map(({ name }) => name)).toEqual([
      'asset',
      'debug',
      'dev',
      'help',
      'project',
      'sdk',
    ]);
    expect(nodes.every((node) => !('children' in node))).toBe(true);

    const tree = await runUnifiedCli(['help', 'dev', '--tree', '--root', root, '--json']);
    expect(tree.ok).toBe(true);
    expect(JSON.stringify(tree.value)).toContain('dev camera get');
    const leaf = await runUnifiedCli(['help', 'dev', 'focus', '--root', root, '--json']);
    expect(leaf.ok).toBe(true);
    expect(
      (leaf.value as { readonly leaf?: { readonly inputSchema?: unknown } }).leaf,
    ).toMatchObject({
      inputSchema: expect.any(Object),
    });
    const start = await runUnifiedCli(['help', 'dev', 'start', '--root', root, '--json']);
    expect(start.ok).toBe(true);
    expect(
      (
        start.value as {
          readonly leaf?: {
            readonly inputSchema?: { readonly properties?: Record<string, unknown> };
          };
        }
      ).leaf?.inputSchema?.properties?.tier,
    ).toMatchObject({ enum: ['main-serial', 'engine-worker'] });
  }, 60_000);

  it('keeps project plugin inspection JSON-safe and parses structured flags', async () => {
    const root = await fixtureRoot();
    const plugins = await runUnifiedCli(['project', 'plugin', 'list', '--root', root, '--json']);
    expect(plugins).toMatchObject({ ok: true, value: { entries: [] } });
    const camera = await runUnifiedCli([
      'dev',
      'camera',
      'set',
      '--root',
      root,
      '--instance',
      'missing',
      '--entity',
      '1',
      '--position',
      '[1,2,3]',
      '--json',
    ]);
    expect(camera.ok).toBe(false);
    expect(camera.error?.code).not.toBe('cli-parse-error');
  });

  it('rejects the removed exec entrance with a non-zero process result', async () => {
    const root = await fixtureRoot();
    const result = await runUnifiedCli(['exec', '--root', root, '--json']);
    expect(result).toMatchObject({ ok: false, error: { code: 'tool-command-not-found' } });
  });

  it('rejects unknown paths, flags, and malformed typed values before execution', async () => {
    const root = await fixtureRoot();
    await expect(runUnifiedCli(['help', 'dev', 'typo', '--root', root])).resolves.toMatchObject({
      ok: false,
      error: { code: 'tool-command-not-found' },
    });
    await expect(
      runUnifiedCli(['dev', 'status', '--unknown', '1', '--root', root]),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'cli-parse-error' },
    });
    await expect(
      runUnifiedCli(['dev', 'focus', '--entity', 'not-an-integer', '--root', root]),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'cli-parse-error' },
    });
  });
});
