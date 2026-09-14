import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('RectAreaLight LTC BRDF shader contract', () => {
  it('provides one-sided Lambert and GGX LTC polygon evaluators', async () => {
    const source = await readFile(new URL('../lighting-rect-area.wgsl', import.meta.url), 'utf8');

    expect(source).toContain('fn evalRectAreaLtcLambert(');
    expect(source).toContain('fn evalRectAreaLtcGgx(');
    expect(source).toContain('fn ltcUv(');
    expect(source).toContain('fn ltcEdgeVectorFormFactor(');
    expect(source).toContain('fn ltcClippedSphereFormFactor(');
    expect(source).toContain('fn ltcEvaluate(');
    expect(source).toContain('ltcLambertTexture');
    expect(source).toContain('ltcGgxTexture');
    expect(source).not.toContain('LTC_LAMBERT');
    expect(source).not.toContain('LTC_GGX');
    expect(source).toContain('let rect0 = lightPos - halfX - halfY;');
    expect(source).toContain(
      'let transform = mInv * transpose(mat3x3<f32>(tangent, bitangent, n));',
    );
    expect(source).toContain('sqrt(1.0 - nDotV)');
    expect(source).toContain('let diffuse = baseColor * (1.0 - metallic);');
    expect(source).not.toContain('viewWeight');
    expect(source).not.toContain('rectAreaSolidAngle');
  });

  it('does not route Rect through punctual inverse-square or shadow sampling', async () => {
    const source = await readFile(new URL('../lighting-rect-area.wgsl', import.meta.url), 'utf8');

    expect(source).not.toContain('/ distanceSquared');
    expect(source).not.toContain('shadowAtlas');
    expect(source).not.toContain('evalPoint(');
    expect(source).not.toContain('evalSpot(');
  });
});
