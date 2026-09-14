import { describe, expect, it } from 'vitest';
import {
  runGpuDrivenViewGpuEvidence,
  runGpuDrivenViewLifecycleEvidence,
} from './gpu-driven-view-gpu-evidence';

const browserReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;
const lifecycleFrames =
  (
    import.meta as ImportMeta & {
      readonly env?: { readonly FORGEAX_BROWSER_CI_LIGHTWEIGHT?: string };
    }
  ).env?.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1'
    ? 60
    : 300;

describe.skipIf(!browserReady)('GPU-driven View Browser WebGPU', () => {
  it('produces compact visible IDs and portable indirect args on the real browser device', async () => {
    await expect(runGpuDrivenViewGpuEvidence()).resolves.toEqual({
      visibleInstance: 0,
      indexCount: 12,
      instanceCount: 1,
      firstIndex: 9,
      baseVertex: 4,
      firstInstance: 0,
      overflow: 0,
      persistentTranslationX: 0,
    });
  });

  it(`survives ${lifecycleFrames} frames of spawn/despawn capacity crossings without stale buffers`, async () => {
    await expect(runGpuDrivenViewLifecycleEvidence(lifecycleFrames)).resolves.toEqual({
      frames: lifecycleFrames,
      bufferRebuilds: 4,
      candidateCapacity: 8,
    });
  }, 30_000);
});
