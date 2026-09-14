import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SHADER_FILES = [
  'default-standard-pbr.wgsl',
  'default-standard-pbr-skin.wgsl',
  'unlit.wgsl',
  'sprite.wgsl',
  'sprite-lit.wgsl',
  'msdf-text.wgsl',
  'skybox.wgsl',
  'hdrp-deferred-lighting.wgsl',
] as const;

const shaderSource = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');

describe('Built-in volume producer matrix', () => {
  it('removes every analytic fog producer from built-in outputs', () => {
    for (const file of SHADER_FILES) {
      const source = shaderSource(file);
      expect(source, file).not.toContain('apply_fog');
      expect(source, file).not.toContain('applySceneFog');
      expect(source, file).not.toContain('forgeax_view::fog');
      expect(source, file).not.toContain('FogRay');
    }
  });

  it('keeps the volume module as the sole optical integration owner', () => {
    const composite = shaderSource('volume/volume-composite.wgsl');
    expect(shaderSource('volume/volume-integrate.wgsl')).toContain('fn hg');
    expect(shaderSource('volume/volume-integrate.wgsl')).toContain('FOUR_PI');
    expect(composite).toContain('resolved_volume');
  });

  it('keeps a single producer matrix without fallback fog entry points', () => {
    const sources = SHADER_FILES.map(shaderSource).join('\n');
    expect(sources.match(/apply_fog|applySceneFog|FogRay/g)).toBeNull();
    expect(shaderSource('volume/volume-integrate.wgsl')).toContain('local_scatter');
  });
});
