// @perf-budget-skip: intentional filesystem-backed tool-composition integration gate.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runNativePreviewTool = vi.hoisted(() => vi.fn());

vi.mock('../tools/native-preview.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/native-preview.js')>()),
  runNativePreviewTool,
}));

import { createToolClient } from '../tools/client.js';
import { nativePreviewTools } from '../tools/preview-catalog.js';

const roots: string[] = [];

afterEach(async () => {
  runNativePreviewTool.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native resource preview dispatch', () => {
  it('routes a GUID request through the native preview owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-native-preview-dispatch-'));
    roots.push(root);
    await writeFile(
      join(root, 'forge.json'),
      JSON.stringify({ id: 'fixture', name: 'Fixture', schemaVersion: '1.0.0' }),
    );
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', type: 'module' }),
    );
    runNativePreviewTool.mockResolvedValue({
      outcome: 'succeeded',
      result: { subject: { kind: 'material', guid: 'asset-guid' } },
      artifacts: [],
    });

    const client = await createToolClient({
      projectRoot: root,
      baseContributions: nativePreviewTools,
      projectDiscovery: async () => [],
    });
    await expect(
      client.run('material.preview', { guid: 'asset-guid', size: 512 }),
    ).resolves.toMatchObject({
      outcome: 'succeeded',
      result: { subject: { guid: 'asset-guid' } },
    });
    expect(runNativePreviewTool).toHaveBeenCalledWith(
      expect.objectContaining({ descriptor: expect.objectContaining({ id: 'material.preview' }) }),
      { guid: 'asset-guid', size: 512 },
      {},
      root,
    );
  }, 15_000);
});
