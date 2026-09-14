import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shaderRoot = resolve(import.meta.dirname, '..');
const probe = readFileSync(resolve(shaderRoot, 'lighting-probe.wgsl'), 'utf8');
const standard = readFileSync(resolve(shaderRoot, 'default-standard-pbr.wgsl'), 'utf8');
const skin = readFileSync(resolve(shaderRoot, 'default-standard-pbr-skin.wgsl'), 'utf8');

describe('Probe diffuse shader composition', () => {
  it('evaluates one SH9 record and derives Sky as the residual', () => {
    expect(probe).toContain('array<vec4<f32>, 9>');
    expect(probe).toContain('sh9');
    expect(probe).toContain('1.0 - localBlendFraction');
    expect(probe).toContain('max(');
    expect(standard).toContain('#ifdef PROBE_BLEND_AVAILABLE');
    expect(standard).toContain('@group(3) @binding(1) var<storage, read> probeBlendRecords');
    expect(standard).not.toContain('@group(2) @binding(1) var<storage, read> probeBlendRecords');
    expect(standard).toContain('fn composeProbeDiffuse(');
    expect(skin).toContain('fn composeProbeDiffuse(');
    expect(probe).toContain('fn evaluateProbeDiffuse(');
    expect(skin).toContain('@group(3) @binding(1) var<storage, read> probeBlendRecords');
  });

  it('keeps Sky out of probe admission and preserves the existing specular owner', () => {
    expect(probe).not.toContain('q_sky');
    expect(probe).not.toContain('for (var probe');
    expect(standard).toContain('sampleIblSpecular');
    expect(skin).toContain('sampleIblSpecular');
    expect(standard).not.toContain('sampleProbeSpecular');
    expect(skin).not.toContain('sampleProbeSpecular');
  });

  it('suppresses probe diffuse for metal while retaining Skylight IBL inputs', () => {
    expect(probe).toContain('(1.0 - metallic)');
    expect(standard).toContain('sampleIblDiffuse');
    expect(skin).toContain('sampleIblDiffuse');
  });
});
