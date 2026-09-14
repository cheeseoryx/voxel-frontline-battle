import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shaderNames = ['billboard', 'mesh', 'ribbon', 'trail', 'beam'] as const;

function shaderSource(name: (typeof shaderNames)[number]): string {
  return readFileSync(fileURLToPath(new URL(`../shaders/${name}.wgsl`, import.meta.url)), 'utf8');
}

describe('VFX volumetric-fog boundary contract', () => {
  it('keeps analytic fog out of every particle topology', () => {
    for (const name of shaderNames) {
      const source = shaderSource(name);
      expect(source, name).not.toMatch(/\bFogViewParams\b|\bFogRay\b|\bapply_fog\s*\(/);
      expect(source, name).not.toMatch(/texture_3d|raymarch/i);
    }
  });

  it('keeps VFX coverage on the current graphics feature lane', () => {
    const feature = readFileSync(
      fileURLToPath(new URL('../feature/gpu-particle-feature.ts', import.meta.url)),
      'utf8',
    );
    const camera = readFileSync(
      fileURLToPath(new URL('../feature/camera.ts', import.meta.url)),
      'utf8',
    );
    expect(feature).toContain('requiredCapabilities');
    expect(feature).toContain('identity: IDENTITY');
    expect(feature).not.toMatch(/fog(?:History|Texture|Registry)/i);
    expect(feature).toContain('worldCenter');
    expect(camera).toContain('position');
    expect(camera).toContain('viewProjection');
  });

  it('keeps billboard scene-depth soft-particle alpha in the final color', () => {
    const billboard = shaderSource('billboard');
    const depthLoad = billboard.indexOf('textureLoad(scene_depth');
    const softParticleCall = billboard.indexOf('softParticle(input.position');
    const finalColor = billboard.indexOf('return vec4<f32>(rgb * alpha, alpha);');

    expect(depthLoad).toBeGreaterThanOrEqual(0);
    expect(softParticleCall).toBeGreaterThan(depthLoad);
    expect(finalColor).toBeGreaterThan(softParticleCall);
    expect(billboard).toContain('input.color.a * edge, input.fade_distance');
    expect(billboard).not.toContain('apply_fog(');
  });
});
