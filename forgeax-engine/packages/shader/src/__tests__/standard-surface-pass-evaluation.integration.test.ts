import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
}

function entryBody(sourceText: string, entry: string): string {
  const start = sourceText.indexOf(`fn ${entry}`);
  const end = sourceText.indexOf('\n@fragment', start + 1);
  return sourceText.slice(start, end < 0 ? sourceText.length : end);
}

describe('Standard Surface pass evaluation', () => {
  it('evaluates the selected Surface once in every rigid and skinned material pass', () => {
    for (const name of ['default-standard-pbr.wgsl', 'default-standard-pbr-skin.wgsl']) {
      const shader = source(name);
      // ShadowCaster is a shared `shadow_caster.wgsl` material entry, while
      // each Standard material template owns the forward and deferred entries.
      for (const entry of ['fs_main', 'fs_gbuffer']) {
        const body = entryBody(shader, entry);
        expect(body, `${name}:${entry} must exist`).toContain(`fn ${entry}`);
        expect(body, `${name}:${entry}`).toMatch(
          /(?:evaluateStandardSurface|evaluate_surface|forgeax_evaluate_surface_from_fragments)\s*\(/,
        );
        expect(body).toContain('alphaTestSurface(surface)');
        if (entry === 'fs_main') expect(body).toContain('surface.opacity');
        expect(body).toContain('surface.baseColor');
        expect(body).toContain('surface.normalWS');
        expect(body).toContain('surface.metallic');
        expect(body).toContain('surface.roughness');
        expect(body).toContain('surface.emissive');
        expect(body).toContain('surface.occlusion');
      }
    }
  });
});
