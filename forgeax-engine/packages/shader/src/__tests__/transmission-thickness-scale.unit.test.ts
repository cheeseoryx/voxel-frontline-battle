import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shader = readFileSync(resolve(import.meta.dirname, '../default-standard-pbr.wgsl'), 'utf8');

describe('standard transmission thickness scale contract', () => {
  it('converts local authored thickness through the combined local-to-world basis', () => {
    expect(shader).toContain('@location(4) @interpolate(flat) transmissionBasis0 : vec4<f32>');
    expect(shader).toContain('@location(13) @interpolate(flat) transmissionBasis1 : vec4<f32>');
    expect(shader).not.toContain('@location(15)');
    expect(shader).toContain('let localToWorld0 = in.transmissionBasis0.xyz;');
    expect(shader).toContain('let localToWorld1 = vec3<f32>(');
    expect(shader).toContain('let localToWorld2 = vec3<f32>(');
    expect(shader).toContain('let worldToLocal0 = vec3<f32>(');
    expect(shader).toContain('let worldRefractedDirection =');
    expect(shader).toMatch(
      /finiteScalar\(material\.thickness, 0\.0\) \* length\(worldRefractedDirection\) \*\s+finiteScalar\(thicknessSample, 1\.0\)/,
    );
  });
});
