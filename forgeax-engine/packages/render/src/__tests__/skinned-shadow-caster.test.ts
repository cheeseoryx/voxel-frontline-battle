import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveMaterialShaderVariantSet } from '../assembly/factory';
import {
  createPbrSkinMeshBindGroupEntries,
  isSkinnedShadowCasterVariant,
  pbrSkinMeshDynamicOffsets,
  SHADOW_CASTER_SHADER_ID,
  shadowCasterVariantSet,
} from '../pbr-pipeline.js';
import { shadowShaderMap } from '../record/shadow-pass.js';

describe('skinned shadow caster', () => {
  it('derives closed capability variants without changing the shader identity', () => {
    expect(shadowCasterVariantSet(true, false)).toBe('');
    expect(shadowCasterVariantSet(false, true)).toBe(
      'SKINNING_DISABLED=false+STORAGE_BUFFER_AVAILABLE=false',
    );
    expect(shadowCasterVariantSet(true, true)).toBe(
      'SKINNING_DISABLED=false+STORAGE_BUFFER_AVAILABLE=true',
    );
    expect(isSkinnedShadowCasterVariant(SHADOW_CASTER_SHADER_ID, '')).toBe(false);
    expect(
      isSkinnedShadowCasterVariant(
        SHADOW_CASTER_SHADER_ID,
        'SKINNING_DISABLED=false+STORAGE_BUFFER_AVAILABLE=false',
      ),
    ).toBe(true);
    expect(
      isSkinnedShadowCasterVariant(
        SHADOW_CASTER_SHADER_ID,
        'SKINNING_DISABLED=true+STORAGE_BUFFER_AVAILABLE=false',
      ),
    ).toBe(false);
  });

  it('uses the animated palette in WGSL and binds the same slice in the shadow pass', () => {
    const shader = readFileSync(
      fileURLToPath(new URL('../../../shader/src/shadow_caster.wgsl', import.meta.url)),
      'utf8',
    );
    const record = readFileSync(
      fileURLToPath(new URL('../record/shadow-pass.ts', import.meta.url)),
      'utf8',
    );
    const builder = readFileSync(
      fileURLToPath(new URL('../pipeline-builder.ts', import.meta.url)),
      'utf8',
    );
    expect(shader).toContain('#pragma variant_axis SKINNING_DISABLED');
    expect(shader).toContain('@group(2) @binding(1)');
    expect(shader).toContain('let skinMatrix = palette[');
    expect(record).toContain('entry.source.skin.byteOffset');
    expect(record).toContain("'shadow-pbr-skin-mesh'");
    expect(builder).toContain('buffers: [...ctx.vertexBuffers]');
  });

  it('keeps mixed static and skinned shadow draws on matching variants and bindings', () => {
    const recordSource = readFileSync(
      fileURLToPath(new URL('../record/shadow-pass.ts', import.meta.url)),
      'utf8',
    );
    const variants = [
      {
        defines: {
          SKINNING_DISABLED: true,
          STORAGE_BUFFER_AVAILABLE: false,
        },
      },
      {
        defines: {
          SKINNING_DISABLED: false,
          STORAGE_BUFFER_AVAILABLE: false,
        },
      },
    ];
    const staticVariant = resolveMaterialShaderVariantSet(
      shadowCasterVariantSet(false, false),
      variants,
      'wgpu-webgl2',
      false,
    );
    const skinnedVariant = resolveMaterialShaderVariantSet(
      shadowCasterVariantSet(false, true),
      variants,
      'wgpu-webgl2',
      false,
    );

    expect(staticVariant).toBe('SKINNING_DISABLED=true+STORAGE_BUFFER_AVAILABLE=false');
    expect(skinnedVariant).toBe('SKINNING_DISABLED=false+STORAGE_BUFFER_AVAILABLE=false');
    expect(isSkinnedShadowCasterVariant(SHADOW_CASTER_SHADER_ID, staticVariant)).toBe(false);
    expect(isSkinnedShadowCasterVariant(SHADOW_CASTER_SHADER_ID, skinnedVariant)).toBe(true);
    expect(recordSource).toContain(
      'shadowCasterVariantSet(c.runtime.device.caps.storageBuffer, false)',
    );
    expect(recordSource).toContain(
      "'shadow-caster',\n      undefined,\n      undefined,\n      undefined,\n      undefined,\n      undefined,\n      undefined,\n      undefined,\n      undefined,\n      'pbr'",
    );
    expect(recordSource).toContain('createPbrSkinMeshBindGroupEntries(');
    expect(recordSource).toContain('pbrSkinMeshDynamicOffsets(');

    const meshBuffer = {} as never;
    const paletteBuffer = {} as never;
    const entries = createPbrSkinMeshBindGroupEntries(meshBuffer, 64, paletteBuffer, 128);
    expect(entries.map((entry) => entry.binding)).toEqual([0, 1, 2]);
    expect(entries[1]?.resource).toEqual(entries[2]?.resource);
    expect(pbrSkinMeshDynamicOffsets(256, 512)).toEqual([256, 512, 512]);
  });

  it('keeps low-limit shadow view bindings paired with the optional projector layout', () => {
    const recordSource = readFileSync(
      fileURLToPath(new URL('../record/shadow-pass.ts', import.meta.url)),
      'utf8',
    );

    // A 16-sampled-texture device removes bindings 11/12 from pbr-view-bgl.
    // The shadow-view helper must use the same capability bit as the main
    // view helper or it recreates the browser-only bind-group mismatch.
    expect(recordSource).toContain(
      'const projectorAvailable = pipelineState.projectorAvailable !== false;',
    );
    expect(recordSource).toContain(
      '...(extendedLighting\n          ? extendedLightingCacheKeys\n          : projectorAvailable\n            ? [pipelineState.defaultWhiteTextureView, pipelineState.defaultSampler]',
    );
    expect(recordSource).toContain(
      '...(!extendedLighting && projectorAvailable\n              ? [\n                  {\n                    binding: 11,',
    );
    expect(recordSource).toContain('binding: 12');
  });

  it('keeps each submesh material associated with its selected shadow program and entries', () => {
    const context = {
      dispatch: [
        {
          renderableIndex: 4,
          materialHandle: 42,
          materialShaderId: 'forgeax::default-standard-pbr',
          tags: { LightMode: 'ShadowCaster' },
        },
        {
          renderableIndex: 4,
          materialHandle: 43,
          materialShaderId: 'custom::cutout',
          vertexEntry: 'vs_displaced',
          fragmentEntry: 'fs_cutout',
          tags: { LightMode: 'ShadowCaster' },
        },
      ],
    } as never;
    const bindings = shadowShaderMap(context);
    expect(bindings.get(4)?.get(42)?.materialShaderId).toBe(SHADOW_CASTER_SHADER_ID);
    expect(bindings.get(4)?.get(43)).toMatchObject({
      materialShaderId: 'custom::cutout',
      vertexEntry: 'vs_displaced',
      fragmentEntry: 'fs_cutout',
    });
  });
});
