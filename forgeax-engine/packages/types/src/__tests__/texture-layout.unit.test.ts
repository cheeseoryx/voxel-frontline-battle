import { describe, expect, it } from 'vitest';
import { deriveTextureLayout } from '../texture/layout.js';

describe('canonical texture layout', () => {
  it.each([
    ['2d', { viewDimension: '2d', extent: { width: 3, height: 5 } }, 1],
    ['2d-array', { viewDimension: '2d-array', extent: { width: 3, height: 5, layers: 3 } }, 3],
    ['3d', { viewDimension: '3d', extent: { width: 3, height: 5, depth: 5 } }, 5],
  ] as const)('%s is mip-major and image-major', (_name, shape, baseImages) => {
    const result = deriveTextureLayout({
      shape,
      format: 'r8unorm',
      mips: { kind: 'packed', levelCount: 3 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.levels).toHaveLength(3);
    expect(result.value.levels[0]?.imagesPerMip).toBe(baseImages);
    expect(result.value.levels[1]?.imagesPerMip).toBe(
      shape.viewDimension === '2d-array' ? 3 : shape.viewDimension === '3d' ? 2 : 1,
    );
    expect(result.value.levels[0]?.byteOffset).toBe(0);
    expect(result.value.levels[1]?.byteOffset).toBe(result.value.levels[0]?.byteLength);
    expect(result.value.byteLength).toBe(
      result.value.levels.reduce((sum, level) => sum + level.byteLength, 0),
    );
  });

  it('keeps array layers but shrinks 3d depth at odd mip extents', () => {
    const array = deriveTextureLayout({
      shape: { viewDimension: '2d-array', extent: { width: 5, height: 3, layers: 3 } },
      format: 'r8unorm',
      mips: { kind: 'packed', levelCount: 3 },
    });
    const volume = deriveTextureLayout({
      shape: { viewDimension: '3d', extent: { width: 5, height: 3, depth: 5 } },
      format: 'r8unorm',
      mips: { kind: 'packed', levelCount: 3 },
    });

    expect(array.ok && array.value.levels.map((level) => level.imagesPerMip)).toEqual([3, 3, 3]);
    expect(volume.ok && volume.value.levels.map((level) => level.imagesPerMip)).toEqual([5, 2, 1]);
  });

  it('rejects wrong canonical byte length and order', () => {
    const result = deriveTextureLayout({
      shape: { viewDimension: '2d-array', extent: { width: 3, height: 5, layers: 2 } },
      format: 'r8unorm',
      mips: { kind: 'packed', levelCount: 2 },
      actualByteLength: 1,
      order: 'layer-major-before-mip',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'texture-packing-invalid' },
    });
  });
});
