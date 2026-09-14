import { describe, expect, it, vi } from 'vitest';

const runBrowserResourcePreviewHost = vi.hoisted(() => vi.fn());

vi.mock('../tools/browser-host.js', () => ({
  publishPreviewArtifacts: vi.fn(),
  runBrowserResourcePreviewHost,
}));

import { runNativePreviewTool } from '../tools/native-preview.js';
import { nativePreviewTools } from '../tools/preview-catalog.js';

describe('native preview subject evidence', () => {
  it('rejects a material capture containing only canonical presentation draws', async () => {
    runBrowserResourcePreviewHost.mockResolvedValue({
      ok: true,
      value: {
        actualCarrier: 'headless-private',
        artifacts: [],
        drawCalls: 2,
        nonBlackPixels: 512 * 512,
        resource: {
          asset: { kind: 'material' },
          guid: '019fb7ce-3200-7000-8000-00000000000d',
          kind: 'material',
          ownerFacts: { subjectDigest: 'sha256:subject' },
        },
        trace: { events: ['renderer-created', 'world-updated'] },
      },
    });
    const materialPreview = nativePreviewTools.find(
      (candidate) => candidate.descriptor.id === 'material.preview',
    );
    expect(materialPreview).toBeDefined();
    if (materialPreview === undefined) return;

    await expect(
      runNativePreviewTool(
        materialPreview,
        { guid: '019fb7ce-3200-7000-8000-00000000000d', size: 512 },
        {},
        '/tmp/forgeax-preview-subject-draw',
      ),
    ).resolves.toMatchObject({
      outcome: 'failed',
      failure: {
        code: 'tool-domain-failed',
        detail: {
          code: 'tool-preview-subject-not-rendered',
          payload: { kind: 'material', drawCalls: 2 },
        },
      },
    });
  });
});
