import { describe, expect, it } from 'vitest';
import { runBrowserGpuPassTiming } from './gpu-pass-timing-browser-runner.js';

const browserReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

describe.skipIf(!browserReady)('GPU pass timing Browser dev-server runner', () => {
  it('keeps receipt facts and unsupported timing structured without stopping draw', async () => {
    const result = await runBrowserGpuPassTiming();
    expect(result.frames).toBe(3);
    if (result.supported) {
      expect(result.unavailable).toBe(false);
      expect(result.measuredPasses).toBeGreaterThan(0);
    } else {
      expect(result.unavailable).toBe(true);
      expect(result.measuredPasses).toBe(0);
    }
    expect(result.visible).toBe(true);
  });

  it('keeps raster suppression as a test-only falsifier, never timing evidence', async () => {
    const result = await runBrowserGpuPassTiming({ suppressRaster: true });
    expect(result.rasterSuppressed).toBe(true);
    expect(result.frames).toBe(3);
    if (result.supported) expect(result.measuredPasses).toBeGreaterThan(0);
  });
});
