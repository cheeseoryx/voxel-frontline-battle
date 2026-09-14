import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const integrateWgsl = readFileSync(
  fileURLToPath(new URL('../volume/volume-integrate.wgsl', import.meta.url)),
  'utf8',
);
const compositeWgsl = readFileSync(
  fileURLToPath(new URL('../volume/volume-composite.wgsl', import.meta.url)),
  'utf8',
);
const temporalWgsl = readFileSync(
  fileURLToPath(new URL('../volume/volume-temporal.wgsl', import.meta.url)),
  'utf8',
);
const injectWgsl = readFileSync(
  fileURLToPath(new URL('../volume/volume-inject.wgsl', import.meta.url)),
  'utf8',
);

function hash32(value: number): number {
  let hash = value >>> 0;
  hash = (hash ^ 61 ^ (hash >>> 16)) >>> 0;
  hash = (hash + (hash << 3)) >>> 0;
  hash = (hash ^ (hash >>> 4)) >>> 0;
  hash = Math.imul(hash, 668265261) >>> 0;
  return (hash ^ (hash >>> 15)) >>> 0;
}

function stratified32(seed: number, frame: number, stride: number): number {
  const bin = (hash32(seed) + (frame & 31) * stride) & 31;
  return (bin + 0.5) / 32;
}

function ditheredByte(value: number, noise: number): number {
  return Math.round(Math.min(1, Math.max(0, value + (noise - 0.5) / 255)) * 255);
}

describe('Volumetric optics shader ownership', () => {
  it('uses filterable history with exact reprojection and deterministic source jitter', () => {
    expect(temporalWgsl).toContain('var accepted : texture_2d<f32>');
    expect(temporalWgsl).toContain('fn bilinear');
    expect(temporalWgsl).toContain('textureLoad(accepted');
    expect(temporalWgsl).toContain('0.875');
    expect(temporalWgsl).not.toContain('temporal_jitter');
    expect(temporalWgsl).toContain('let prior = bilinear(previous_uv, size);');
  });

  it('weights equal-alpha neighborhood samples by relative radiance', () => {
    expect(compositeWgsl).toContain('radiance_luma_weight');
    expect(compositeWgsl).toContain('relative_luma');
    const center = 1;
    const darkNeighbor = 0.02;
    const equalAlpha = 0.5;
    const relativeLuma = Math.abs(darkNeighbor - center) / Math.max(center, darkNeighbor, 1e-4);
    const weight = Math.exp(-relativeLuma * 8) * Math.exp(-Math.abs(equalAlpha - equalAlpha) * 24);
    expect(weight).toBeLessThan(0.01);
  });

  it('keeps optical depth and phase in the volume integration module', () => {
    expect(integrateWgsl).toContain('#define_import_path forgeax_view::volume_integrate');
    expect(integrateWgsl).toContain('fn hg');
    expect(integrateWgsl).toContain('FOUR_PI');
    expect(integrateWgsl).toContain('textureStore(resolved');
    expect(integrateWgsl).not.toContain('apply_fog');
    expect(integrateWgsl).toContain('full_step');
    expect(integrateWgsl).toContain('let segment_start');
    expect(integrateWgsl).toContain('let segment_length');
    expect(integrateWgsl).toContain('sigma_scale * density_value * segment_length');
    expect(integrateWgsl).toContain('scene_distance');
    expect(injectWgsl).not.toContain('scene_depth');
    expect(injectWgsl).not.toContain('textureStore(volume_history');
    expect(injectWgsl).not.toContain('textureStore(volume_temporal');
  });

  it('composites the prepared integrated volume exactly once', () => {
    expect(compositeWgsl).toContain('#define_import_path forgeax_view::volume_composite');
    expect(compositeWgsl).toContain('resolved_volume');
    expect(compositeWgsl).not.toContain('apply_fog');
  });

  it('maps the fullscreen composite UV into the view-space Y convention', () => {
    expect(compositeWgsl).toContain('positions[index].x * 0.5 + 0.5');
    expect(compositeWgsl).toContain('0.5 - positions[index].y * 0.5');
  });

  it('selects volume cascades from the uploaded camera view-depth contract', () => {
    expect(injectWgsl).toContain('view.temporalCurrentViewProj');
    expect(injectWgsl).toContain('view.temporalProjection');
    expect(injectWgsl).not.toContain('distance(world_position, view.cameraPos)');
  });

  it('uses bounded 32-phase stratification and unbiased unorm dithering', () => {
    expect(injectWgsl).toContain('fn hash32');
    expect(injectWgsl).toContain('fn stratified32');
    expect(injectWgsl).toContain('fn dither_unorm8');
    expect(injectWgsl).not.toContain('interleaved_gradient_noise');
    expect(injectWgsl).toContain('frame_index & 31u');

    const seeds = Array.from({ length: 4096 }, (_, index) => hash32(index + 17));
    for (const value of [0.1, 0.25, 0.5, 0.9]) {
      for (let frame = 0; frame < 32; frame += 1) {
        const mean =
          seeds.reduce(
            (sum, seed) => sum + ditheredByte(value, stratified32(seed, frame, 5)) / 255,
            0,
          ) / seeds.length;
        expect(Math.abs(mean - value)).toBeLessThanOrEqual(1 / (32 * 255));
      }
    }

    for (let frame = 0; frame < 32; frame += 1) {
      expect(seeds.every((seed) => ditheredByte(0, stratified32(seed, frame, 5)) === 0)).toBe(true);
      expect(seeds.every((seed) => ditheredByte(1, stratified32(seed, frame, 5)) === 255)).toBe(
        true,
      );
      expect(
        seeds.every((seed) => ditheredByte(96 / 255, stratified32(seed, frame, 5)) === 96),
      ).toBe(true);
    }

    const changed = seeds.filter(
      (seed) => stratified32(seed, 0, 5) !== stratified32(seed, 1, 5),
    ).length;
    expect(changed / seeds.length).toBeGreaterThanOrEqual(0.5);
  });
});
