import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, '../motion-blur.wgsl'), 'utf8');

describe('motion-blur.wgsl', () => {
  it('declares the portable raster gather contract', () => {
    expect(source).toContain('@fragment');
    expect(source).toContain('symmetric');
    expect(source).toContain('maxRadiusPixels');
    expect(source).toContain('shutterAngle');
    expect(source).toContain('sampleCount');
    expect(source).toContain('textureSample');
  });

  it('samples scene temporal depth through the portable color path', () => {
    expect(source).toContain('@group(1) @binding(3) var sceneTemporal : texture_2d<f32>');
    expect(source).toContain('textureLoad(sceneTemporal, samplePixel, 0)');
    expect(source).not.toContain('texture_depth_2d');
    expect(source).not.toContain('sceneDepth');
    expect(source).not.toContain('depthSampler');
  });

  it('keeps depth, reactive, reset, and alpha guards in the shader owner', () => {
    expect(source).toContain('reactive');
    expect(source).toContain('invalidDepth');
    expect(source).toContain('depthReject');
    expect(source).toContain('reset');
    expect(source).toContain('output.a');
    expect(source).toContain('#import forgeax_scene_temporal::{unpackSceneTemporalV1}');
    expect(source).toContain('let blurWeight = (1.0 - reactive)');
    expect(source).toContain('for (var index = 0u; index < 16u; index += 1u)');
    expect(source).not.toContain('positiveUv');
    expect(source).not.toContain('negativeUv');
  });

  it('does not introduce compute, storage, or temporal history writes', () => {
    expect(source).not.toContain('@compute');
    expect(source).not.toContain('var<storage');
    expect(source).not.toContain('history');
    expect(source).not.toContain('atomic');
  });
});
