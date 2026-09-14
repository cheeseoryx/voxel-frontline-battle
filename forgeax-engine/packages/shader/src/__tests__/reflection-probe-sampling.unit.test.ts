import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const samplingSource = readFileSync(new URL('../ibl-sampling.wgsl', import.meta.url), 'utf8');
const standardSource = readFileSync(
  new URL('../default-standard-pbr.wgsl', import.meta.url),
  'utf8',
);

describe('Standard reflection probe sampling contract', () => {
  it('keeps global IBL helpers and adds a bounded local probe sampling helper', () => {
    expect(samplingSource).toMatch(/fn\s+sampleIblDiffuse\s*\(/);
    expect(samplingSource).toMatch(/fn\s+sampleIblSpecular\s*\(/);
    expect(samplingSource).toMatch(/fn\s+sampleReflectionProbeSpecular\s*\(/);
  });

  it('uses box projection and explicit Skylight fallback in the Standard shader', () => {
    expect(samplingSource).toMatch(/box_project/);
    expect(standardSource).toMatch(/sampleReflectionProbeSpecular/);
    expect(standardSource).toContain('skylight.intensity < 0.0');
    expect(standardSource).toMatch(/sampleIblSpecular/);
    expect(standardSource).toMatch(/skylight/);
  });

  it('projects only the environment specular lobe for c=1 without removing diffuse light', () => {
    expect(standardSource).toContain(
      'var reflectionFallback = specularIbl * (vec3<f32>(1.0) - coatF);',
    );
    expect(standardSource).toContain('kD * irradiance * diffuseAlbedo');
    expect(standardSource).toContain(
      'output.reflectionFallback = vec4<f32>(reflectionFallback, 1.0);',
    );
    expect(standardSource).not.toContain('output.reflectionFallback = vec4<f32>(ambient, 1.0);');
  });

  it('keeps probe clearcoat on the selected probe source', () => {
    expect(standardSource).toMatch(
      /if \(skylight\.intensity < 0\.0\) \{[\s\S]*?clearcoatIbl = sampleReflectionProbeSpecular\(/,
    );
  });

  it('keeps zero-intensity probes distinguishable from an absent Skylight', () => {
    expect(standardSource).toContain('max(-skylight.intensity - 1.0, 0.0) * ao');
  });
});
