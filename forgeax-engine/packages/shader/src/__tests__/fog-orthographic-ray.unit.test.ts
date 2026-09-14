import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shaderFiles = [
  'default-standard-pbr.wgsl',
  'default-standard-pbr-skin.wgsl',
  'unlit.wgsl',
  'sprite.wgsl',
  'sprite-lit.wgsl',
  'msdf-text.wgsl',
  'skybox.wgsl',
] as const;

function source(name: (typeof shaderFiles)[number]): string {
  return readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
}

describe('Built-in fragment volume handoff', () => {
  it('does not reconstruct or apply a private analytic fog ray', () => {
    for (const name of shaderFiles) {
      const shader = source(name);
      expect(shader, name).not.toContain('applySceneFog(');
      expect(shader, name).not.toContain('apply_fog(');
      expect(shader, name).not.toContain('forgeax_view::fog');
    }
  });

  it('keeps the volume composite as the shared post-lighting owner', () => {
    const volume = readFileSync(
      fileURLToPath(new URL('../volume/volume-composite.wgsl', import.meta.url)),
      'utf8',
    );
    expect(volume).toContain('resolved_volume');
    expect(volume).toContain('composite_resolved_volume');
  });
});
