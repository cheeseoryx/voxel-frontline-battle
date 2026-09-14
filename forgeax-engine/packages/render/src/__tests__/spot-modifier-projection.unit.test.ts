import { describe, expect, it } from 'vitest';
import {
  prepareCookieProjection,
  projectCookieUv,
  projectIesCoordinates,
  spotModifierProduct,
} from '../prepare/extended-lighting/spot-modifiers';

describe('Spot modifier projection', () => {
  it('keeps the shared multiplication order and unit identities', () => {
    expect(
      spotModifierProduct({ brdf: 2, range: 0.8, cone: 0.5, ies: 0.25, cookie: 0.4, shadow: 0.75 }),
    ).toBe(2 * 0.8 * 0.5 * 0.25 * 0.4 * 0.75);
    expect(spotModifierProduct({ brdf: 1, range: 1, cone: 1, shadow: 1 })).toBe(1);
  });

  it('projects roll and non-square cookie dimensions into stable coordinates', () => {
    const coords = projectIesCoordinates([0, 0, -1], 90);
    expect(coords).toMatchObject({ azimuth: expect.any(Number), elevation: expect.any(Number) });
    expect(projectCookieUv([0, 0, -1], 90, 2)).toMatchObject({
      u: expect.any(Number),
      v: expect.any(Number),
    });
  });

  it('returns black behind the light and outside the projected cone', () => {
    expect(projectIesCoordinates([0, 0, 1], 0)).toBeUndefined();
    expect(projectCookieUv([0, 2, -1], 0, 1)).toBeUndefined();
  });

  it('projects non-square sRGB RGBA data once into linear fixed-size slices', () => {
    const asset = {
      kind: 'texture' as const,
      shape: { viewDimension: '2d' as const, extent: { width: 2, height: 1 } },
      format: 'rgba8unorm-srgb' as const,
      colorSpace: 'srgb' as const,
      mipmap: false,
      mips: { kind: 'none' as const },
      data: new Uint8Array([128, 0, 0, 128, 0, 255, 0, 255]),
    };
    const projection = prepareCookieProjection(asset);

    expect(projection).toBeDefined();
    expect(projection?.data.byteLength).toBe(256 * 256 * 4);
    expect(projection?.aspect).toBe(2);
    expect(projection?.matrix[0]).toBeCloseTo(0.5, 6);
    expect(projection?.matrix[5]).toBe(1);
    // The first source texel is sampled near its center. 128 sRGB is not
    // copied as 128 linear; it is converted to roughly 55 linear bytes.
    expect(projection?.data[0]).toBeLessThan(70);
    expect(projection?.data[1]).toBe(0);
    expect(projection?.data[3]).toBe(128);
    const right = 256 * 4 - 4;
    expect(projection?.data[right + 1]).toBeGreaterThan(240);
    expect(projection).toBe(prepareCookieProjection(asset));
  });

  it('rejects a non-RGBA8 source instead of silently binding raw bytes', () => {
    const asset = {
      kind: 'texture' as const,
      shape: { viewDimension: '2d' as const, extent: { width: 1, height: 1 } },
      format: 'rgba16float' as const,
      colorSpace: 'linear' as const,
      mipmap: false,
      mips: { kind: 'none' as const },
      data: new Uint8Array(8),
    };
    expect(prepareCookieProjection(asset)).toBeUndefined();
  });
});
