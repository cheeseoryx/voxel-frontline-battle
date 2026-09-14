import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, '../taa-resolve.wgsl'), 'utf8');
const pbrTemporal = readFileSync(resolve(import.meta.dirname, '../pbr-temporal.wgsl'), 'utf8');
const sceneTemporal = readFileSync(resolve(import.meta.dirname, '../scene-temporal.wgsl'), 'utf8');

describe('taa-resolve.wgsl', () => {
  it('keeps the fixed packed temporal and two-attachment ABI', () => {
    expect(source).toContain('struct TaaResolveParams');
    expect(source).toContain('@location(0) color');
    expect(source).toContain('@location(1) temporal');
    expect(source).toContain('return TaaResolveOutput(');
    expect(source).toContain('temporal,');
    expect(source).toContain('current.a');
    expect(source).toContain('1.0 - clamp(temporal.w');
    expect(source).not.toContain('1.0 - clamp(current.a');
  });

  it('contains every v1 rejection and adaptive weighting term', () => {
    expect(source).toContain('in.uv + params.currentJitterUv');
    expect(source).toContain('in.uv - temporal.xy');
    expect(source).toContain('closestCurrentTemporal(pixel, dimensions)');
    expect(source).toContain('historyInBounds');
    expect(source).toContain('depthDelta > depthThreshold');
    expect(source).toContain('neighborhoodSquareMean');
    expect(source).toContain('clamp(rgbToYCoCg(history.rgb), clipMin, clipMax)');
    expect(source).toContain('reactiveFactor');
    expect(source).toContain('velocityFactor');
    expect(source).toContain('depthFactor');
    expect(source).toContain('lumaFactor');
    expect(source).toContain('mix(0.88, 0.97, lumaFactor)');
    expect(source).toContain('params.temporalFrameIndex < 8u');
    expect(source).toContain('progressiveWeight');
    expect(source).toContain('let dimensions = vec2<i32>(textureDimensions(currentColor, 0));');
    expect(source).toContain('closestCurrentTemporal(pixel, dimensions)');
    expect(source).toContain('vec2<f32>(dimensions)');
  });

  it('compiles the PBR temporal seam with coverage-aware reactive output', async () => {
    const compilerPath = resolve(import.meta.dirname, '../../../shader-compiler/dist/index.mjs');
    const { compileShader } = await import(/* @vite-ignore */ compilerPath);
    const common = `
fn sampleMaterialTexture(
  texture : texture_2d<f32>,
  textureSampler : sampler,
  uv : vec2<f32>,
  uvScale : vec2<f32>,
) -> vec4<f32> {
  return textureSample(texture, textureSampler, uv * uvScale);
}

`;
    const sceneTemporalBody = sceneTemporal
      .replace(/^#define_import_path.*$/gm, '')
      .replace(/^#import.*$/gm, '');
    const entry = `${common}
${sceneTemporalBody}
${pbrTemporal.replace(/^#define_import_path.*$/gm, '').replace(/^#import.*$/gm, '')}
@group(0) @binding(0) var colorTexture : texture_2d<f32>;
@group(0) @binding(1) var colorSampler : sampler;
@fragment
fn fs_temporal_probe() -> @location(0) vec4<f32> {
  return projectPbrSceneTemporal(
    0.75, 0.5, colorTexture, colorSampler,
    vec4<f32>(0.0, 0.0, 1.0, 1.0), vec4<f32>(0.0),
    vec4<f32>(0.0, 0.0, 1.0, 1.0), vec4<f32>(0.0),
    vec4<f32>(0.0, 0.0, 0.0, 0.0), 0.0,
    vec2<f32>(0.5), vec2<f32>(0.5), vec2<f32>(0.5), vec2<f32>(0.5),
    vec2<f32>(0.5), vec2<f32>(0.5), vec2<f32>(0.5), vec2<f32>(0.5),
  );
}
`;
    const compiled = await compileShader(entry, {
      id: 'test::pbr-temporal-reactive',
      defines: { PER_INSTANCE_REGION: false, STORAGE_BUFFER_AVAILABLE: true },
    });
    expect(compiled.ok, compiled.ok ? undefined : String(compiled.error)).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.wgsl).toContain('resolvePbrTemporalReactive');
    expect(compiled.value.wgsl).toContain('max(clamp(reactive');
    const discardIndex = pbrTemporal.indexOf('discard;');
    const reactiveIndex = pbrTemporal.indexOf('let reactiveCoverage');
    expect(discardIndex).toBeGreaterThanOrEqual(0);
    expect(discardIndex).toBeLessThan(reactiveIndex);
  });

  it('rejects a dev-only forced-reactive-zero falsifier', () => {
    const reactiveCoverageLine =
      'let reactiveCoverage = resolvePbrTemporalReactive(reactive, baseColorAlpha, baseSample.a);';
    const falsified = pbrTemporal.replace(reactiveCoverageLine, 'let reactiveCoverage = 0.0;');
    expect(() => {
      expect(falsified).toContain(reactiveCoverageLine);
      expect(falsified).toContain('let reactiveCoverage = 0.0;');
    }).toThrow();
  });

  it('keeps the reactive coverage contract explicit', () => {
    expect(pbrTemporal).toContain('resolvePbrTemporalReactive');
    expect(pbrTemporal).toContain('coverageReactive');
    expect(pbrTemporal).not.toContain('return packSceneTemporal(currentClip, previousClip, 0.0)');
  });
});
