import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RhiError } from '@forgeax/engine-rhi';
import type { MaterialShaderManifestVariant } from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import { deviceOptionsForAdapter } from '../assembly/device-feature-admission';
import {
  allowsUnlitPreparedFallback,
  isSharedMaterialUserRegionCompatible,
  normalizeMaterialShaderVariantSet,
  resolveMaterialShaderBackendArtifactKey,
  resolveMaterialShaderBindingContract,
  resolveMaterialShaderUvSetCount,
  resolveMaterialShaderVariantSet,
  resolveMaterialShaderVertexInputContract,
  selectNoColorPbrVariant,
  selectPipelineLayoutForVariant,
  shouldDeferMissingPreparedMaterialShader,
} from '../assembly/factory';
import {
  buildPipelineForMaterialShader,
  type PipelineBuilderContext,
  validateTemporalPipelineContract,
} from '../pipeline-builder';
import { effectiveMaterialLayoutIdentity } from '../record/main-pass-geometry';
import { userRegionTextureFieldOrder } from '../record/main-pass-material';

const hdrpVariantKey =
  'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false';
const urpVariantKey =
  'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false';

function noColorVariant(
  definesKey: string,
  clusterForward: boolean,
): MaterialShaderManifestVariant {
  return {
    definesKey,
    defines: {
      STORAGE_BUFFER_AVAILABLE: true,
      VERTEX_COLOR_AVAILABLE: false,
      CLUSTER_FORWARD_AVAILABLE: clusterForward,
    },
    composedWgsl: definesKey,
  };
}

function noColorManifest() {
  return {
    identifier: 'forgeax::default-standard-pbr',
    sourcePath: 'default-standard-pbr.wgsl',
    composedWgsl: 'shader',
    paramSchema: '{}',
    variants: [noColorVariant(hdrpVariantKey, true), noColorVariant(urpVariantKey, false)],
  };
}

describe('material shader variant identity', () => {
  it('requests the extended-lighting sampled-texture limit when the adapter supports it', () => {
    const features = new Set<GPUFeatureName>();
    expect(
      deviceOptionsForAdapter({
        features,
        limits: { maxSampledTexturesPerShaderStage: 48 },
      } as never),
    ).toEqual({
      requiredFeatures: [],
      requiredLimits: { maxSampledTexturesPerShaderStage: 21 },
    });
    expect(
      deviceOptionsForAdapter({
        features,
        limits: { maxSampledTexturesPerShaderStage: 16 },
      } as never),
    ).toBeUndefined();
  });

  it('preserves the distinction between absent, canonical, and explicit requests', () => {
    const manifest = noColorManifest();

    expect(selectNoColorPbrVariant(manifest, true, undefined)?.definesKey).toBe(urpVariantKey);
    expect(selectNoColorPbrVariant(manifest, true, '')?.definesKey).toBe(hdrpVariantKey);
    expect(
      selectNoColorPbrVariant(manifest, true, 'CLUSTER_FORWARD_AVAILABLE=true')?.definesKey,
    ).toBe(hdrpVariantKey);
    expect(
      selectNoColorPbrVariant(manifest, true, 'CLUSTER_FORWARD_AVAILABLE=false')?.definesKey,
    ).toBe(urpVariantKey);
  });

  it('keeps physical root declarations out of capability variant selection', () => {
    const manifest = noColorManifest();
    expect(
      selectNoColorPbrVariant(
        manifest,
        true,
        `${hdrpVariantKey}+CLEARCOAT_TEXTURE_AVAILABLE=true+TRANSMISSION_AVAILABLE=true`,
      )?.definesKey,
    ).toBe(hdrpVariantKey);
  });

  it('closes the WebGL2 colored PBR axes on the URP variant and layout', () => {
    const variants = [
      {
        defines: {
          CLUSTER_FORWARD_AVAILABLE: false,
          STORAGE_BUFFER_AVAILABLE: false,
          VERTEX_COLOR_AVAILABLE: true,
        },
      },
      {
        defines: {
          CLUSTER_FORWARD_AVAILABLE: true,
          STORAGE_BUFFER_AVAILABLE: true,
          VERTEX_COLOR_AVAILABLE: true,
        },
      },
    ];
    const resolved = resolveMaterialShaderVariantSet(
      'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=true',
      variants,
      'wgpu-webgl2',
      false,
    );

    expect(resolved).toBe(
      'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=true',
    );
    expect(
      selectPipelineLayoutForVariant(
        {
          pbrPipelineLayout: 'urp' as never,
          hdrpPbrPipelineLayout: 'hdrp' as never,
          pbrSkinPipelineLayout: null,
        },
        resolved,
      ),
    ).toBe('urp');
  });

  it('rewrites directional PCSS to the backend-owned WebGL2 shader variant', () => {
    const variants = [
      {
        defines: {
          STORAGE_BUFFER_AVAILABLE: false,
          DIRECTIONAL_PCSS_AVAILABLE: false,
        },
      },
      {
        defines: {
          STORAGE_BUFFER_AVAILABLE: true,
          DIRECTIONAL_PCSS_AVAILABLE: true,
        },
      },
    ];

    expect(
      resolveMaterialShaderVariantSet(
        'DIRECTIONAL_PCSS_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true',
        variants,
        'wgpu-webgl2',
        false,
      ),
    ).toBe('DIRECTIONAL_PCSS_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=false');
    expect(
      resolveMaterialShaderVariantSet(
        'DIRECTIONAL_PCSS_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true',
        variants,
        'webgpu',
        true,
      ),
    ).toBe('');
  });

  it('fails closed when a clustered layout is unavailable', () => {
    expect(
      selectPipelineLayoutForVariant(
        {
          pbrPipelineLayout: 'urp' as never,
          hdrpPbrPipelineLayout: null,
          pbrSkinPipelineLayout: null,
        },
        '',
        'hdrp-pbr',
      ),
    ).toBeNull();
  });

  it('does not promote an omitted semantic axis to true', () => {
    const resolved = resolveMaterialShaderVariantSet(
      'VERTEX_COLOR_AVAILABLE=true',
      [
        {
          defines: {
            CLUSTER_FORWARD_AVAILABLE: false,
            STORAGE_BUFFER_AVAILABLE: false,
            VERTEX_COLOR_AVAILABLE: true,
          },
        },
      ],
      'wgpu-webgl2',
      false,
    );

    expect(resolved).toBe(
      'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=true',
    );
  });

  it('keeps the negative skinning axis disabled when a shadow request omits it', () => {
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

    expect(resolveMaterialShaderVariantSet(undefined, variants, 'wgpu-webgl2', false)).toBe(
      'SKINNING_DISABLED=true+STORAGE_BUFFER_AVAILABLE=false',
    );
    expect(resolveMaterialShaderVariantSet('', variants, 'wgpu-webgl2', false)).toBe(
      'SKINNING_DISABLED=true+STORAGE_BUFFER_AVAILABLE=false',
    );
    expect(
      resolveMaterialShaderVariantSet(
        'SKINNING_DISABLED=false+STORAGE_BUFFER_AVAILABLE=false',
        variants,
        'wgpu-webgl2',
        false,
      ),
    ).toBe('SKINNING_DISABLED=false+STORAGE_BUFFER_AVAILABLE=false');
  });

  it('disables extended lighting when the device cannot sample its shared layout topology', () => {
    const variants = [
      { defines: { EXTENDED_LIGHTING_AVAILABLE: false } },
      { defines: { EXTENDED_LIGHTING_AVAILABLE: true } },
    ];

    expect(
      resolveMaterialShaderVariantSet(
        'EXTENDED_LIGHTING_AVAILABLE=true',
        variants,
        'webgpu',
        true,
        16,
      ),
    ).toBe('EXTENDED_LIGHTING_AVAILABLE=false');
    expect(
      resolveMaterialShaderVariantSet(
        'EXTENDED_LIGHTING_AVAILABLE=true',
        variants,
        'webgpu',
        true,
        19,
      ),
    ).toBe('EXTENDED_LIGHTING_AVAILABLE=false');
    expect(
      resolveMaterialShaderVariantSet(
        'EXTENDED_LIGHTING_AVAILABLE=true',
        variants,
        'webgpu',
        true,
        20,
      ),
    ).toBe('');
    expect(
      resolveMaterialShaderVariantSet(undefined, variants, 'webgpu', true, 20),
    ).toBeUndefined();
    expect(
      resolveMaterialShaderVariantSet(
        'EXTENDED_LIGHTING_AVAILABLE=false',
        variants,
        'webgpu',
        true,
        20,
      ),
    ).toBe('');
    expect(
      resolveMaterialShaderVariantSet(
        'EXTENDED_LIGHTING_AVAILABLE=true',
        variants,
        'webgpu',
        false,
        19,
      ),
    ).toBe('EXTENDED_LIGHTING_AVAILABLE=false');
  });

  it('keeps sprite region variants on the explicit empty-key contract', () => {
    const variants = [
      {
        defines: { PER_INSTANCE_REGION: true, STORAGE_BUFFER_AVAILABLE: true },
      },
      {
        defines: { PER_INSTANCE_REGION: false, STORAGE_BUFFER_AVAILABLE: true },
      },
    ];

    expect(resolveMaterialShaderVariantSet(undefined, variants, 'webgpu', true)).toBe(
      'PER_INSTANCE_REGION=false+STORAGE_BUFFER_AVAILABLE=true',
    );
    expect(resolveMaterialShaderVariantSet('', variants, 'webgpu', true)).toBe('');
  });

  it('keeps an explicit empty key colored while omitted and explicit-false stay plain', () => {
    const variants = [
      {
        defines: { STORAGE_BUFFER_AVAILABLE: true, VERTEX_COLOR_AVAILABLE: true },
      },
      {
        defines: { STORAGE_BUFFER_AVAILABLE: true, VERTEX_COLOR_AVAILABLE: false },
      },
    ];

    expect(resolveMaterialShaderVariantSet('', variants, 'webgpu', true)).toBe('');
    expect(resolveMaterialShaderVariantSet(undefined, variants, 'webgpu', true)).toBe(
      'STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
    );
    expect(
      resolveMaterialShaderVariantSet('VERTEX_COLOR_AVAILABLE=false', variants, 'webgpu', true),
    ).toBe('STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false');
  });

  it('selects the projector-disabled PBR variant when the device exposes only 16 sampled textures', () => {
    const variants = [
      {
        defines: {
          CLUSTER_FORWARD_AVAILABLE: false,
          PROJECTOR_AVAILABLE: false,
          STORAGE_BUFFER_AVAILABLE: true,
          VERTEX_COLOR_AVAILABLE: false,
        },
      },
      {
        defines: {
          CLUSTER_FORWARD_AVAILABLE: false,
          PROJECTOR_AVAILABLE: true,
          STORAGE_BUFFER_AVAILABLE: true,
          VERTEX_COLOR_AVAILABLE: false,
        },
      },
    ];

    expect(resolveMaterialShaderVariantSet(undefined, variants, 'webgpu', true, false)).toBe(
      'CLUSTER_FORWARD_AVAILABLE=false+PROJECTOR_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
    );
    expect(resolveMaterialShaderVariantSet(undefined, variants, 'webgpu', true, true)).toBe(
      'CLUSTER_FORWARD_AVAILABLE=false+PROJECTOR_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
    );
  });

  it('keeps single-source manifests on the canonical module key', () => {
    const singleSourceManifest = {
      identifier: 'forgeax::points-lines',
      sourcePath: 'points-lines.wgsl',
      composedWgsl: 'shader',
      paramSchema: '{}',
      variants: [],
    };

    expect(
      normalizeMaterialShaderVariantSet('VERTEX_COLOR_AVAILABLE=false', singleSourceManifest),
    ).toBeUndefined();
  });

  it('preserves variant requests for manifests that actually declare variants', () => {
    const variantManifest = {
      identifier: 'forgeax::default-standard-pbr',
      sourcePath: 'standard-pbr.wgsl',
      composedWgsl: 'shader',
      paramSchema: '{}',
      variants: [
        {
          definesKey: 'STORAGE_BUFFER_AVAILABLE=true',
          defines: { STORAGE_BUFFER_AVAILABLE: true },
          composedWgsl: 'shader',
        },
      ],
    };

    expect(
      normalizeMaterialShaderVariantSet('STORAGE_BUFFER_AVAILABLE=true', variantManifest),
    ).toBe('STORAGE_BUFFER_AVAILABLE=true');
    expect(normalizeMaterialShaderVariantSet('CUSTOM=true', undefined)).toBe('CUSTOM=true');
  });

  it('projects a published Surface artifact to its WebGL2 capability alias', () => {
    const base = 'surface-specialization';
    const webgl2 = 'forgeax::surface-variant::surface-specialization::webgl2::uniform-fallback';
    const artifact = {
      metadata: {
        variants: [
          {
            backend: 'webgpu',
            capability: 'storage-buffer',
            specializationKey: base,
          },
          {
            backend: 'webgl2',
            capability: 'uniform-fallback',
            specializationKey: webgl2,
          },
        ],
      },
    };

    expect(resolveMaterialShaderBackendArtifactKey(base, 'wgpu-webgl2', artifact)).toBe(webgl2);
    expect(resolveMaterialShaderBackendArtifactKey(base, 'webgpu', artifact)).toBe(base);
    expect(resolveMaterialShaderBackendArtifactKey(base, 'wgpu-webgl2', undefined)).toBe(base);
  });
});

describe('temporal material PSO creation contract', () => {
  const source = `
    struct VsIn { @location(0) position: vec3<f32> }
    @vertex fn vs_temporal(input: VsIn) -> @builtin(position) vec4<f32> {
      return vec4<f32>(input.position, 1.0);
    }
    @fragment fn fs_temporal() -> @location(0) vec4<f32> {
      return vec4<f32>(1.0);
    }
  `;
  const capabilities = { storageBuffer: false, rgba16floatRenderable: true };
  const context = {
    colorFormat: 'rgba16float' as GPUTextureFormat,
    depthFormat: 'depth24plus-stencil8' as GPUTextureFormat,
    capabilities,
  } satisfies Pick<PipelineBuilderContext, 'colorFormat' | 'depthFormat' | 'capabilities'>;

  it('accepts the WebGL2 temporal source/layout/attachment contract', () => {
    expect(validateTemporalPipelineContract(source, context).ok).toBe(true);
    const createRenderPipeline = vi.fn((_descriptor: unknown) => ({ ok: true, value: {} }));
    const result = buildPipelineForMaterialShader(
      'default-unlit-temporal',
      { source, paramSchema: [] },
      {
        ...context,
        device: {
          createRenderPipeline,
        },
        shaderModuleFactory: {
          createShaderModule: () => ({ ok: true, value: {} }),
        },
        pipelineLayout: {},
        vertexBuffers: [],
        label: 'pbr-pipeline-default-unlit-temporal',
      } as unknown as PipelineBuilderContext,
      { depthWriteEnabled: false, depthCompare: 'less-equal' },
      undefined,
      'vs_temporal',
      'fs_temporal',
      undefined,
      'temporal',
    );
    expect(result.ok).toBe(true);
    expect(createRenderPipeline).toHaveBeenCalledTimes(1);
    expect(createRenderPipeline.mock.calls[0]?.[0]).toMatchObject({
      vertex: { entryPoint: 'vs_temporal' },
      fragment: { entryPoint: 'fs_temporal', targets: [{ format: 'rgba16float' }] },
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthWriteEnabled: false,
        depthCompare: 'less-equal',
      },
    });
  });

  it('rejects a storage variant mismatch before caching or device creation', () => {
    const createRenderPipeline = vi.fn((_descriptor: unknown) => ({ ok: true, value: {} }));
    const result = buildPipelineForMaterialShader(
      'default-unlit-temporal',
      {
        source: source.replace(
          'struct VsIn',
          `@group(2) var<storage> meshes: array<u32>;
    struct VsIn`,
        ),
        paramSchema: [],
      },
      {
        ...context,
        device: { createRenderPipeline },
        shaderModuleFactory: { createShaderModule: () => ({ ok: true, value: {} }) },
        pipelineLayout: {},
        vertexBuffers: [],
      } as unknown as PipelineBuilderContext,
      undefined,
      undefined,
      'vs_temporal',
      'fs_temporal',
      undefined,
      'temporal',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('shader-compile-failed');
    expect(createRenderPipeline).not.toHaveBeenCalled();
  });

  it('preserves the underlying pipeline error hint and raw sentinel', () => {
    const createRenderPipeline = vi.fn((_descriptor: unknown) => ({
      ok: false,
      error: new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'pipeline validates at creation',
        hint: 'raw shader validation sentinel',
      }),
    }));
    const result = buildPipelineForMaterialShader(
      'default-unlit-temporal',
      { source, paramSchema: [] },
      {
        ...context,
        device: { createRenderPipeline },
        shaderModuleFactory: { createShaderModule: () => ({ ok: true, value: {} }) },
        pipelineLayout: {},
        vertexBuffers: [],
      } as unknown as PipelineBuilderContext,
      undefined,
      undefined,
      'vs_temporal',
      'fs_temporal',
      undefined,
      'temporal',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('shader-compile-failed');
      expect(result.error.hint).toContain('raw shader validation sentinel');
      expect(result.error.hint).toContain('[RhiError webgpu-runtime-error]');
    }
  });
});

describe('material shader capability variant resolution', () => {
  it('rewrites only backend capability axes', () => {
    const variants = [
      {
        defines: {
          CLUSTER_FORWARD_AVAILABLE: false,
          STORAGE_BUFFER_AVAILABLE: false,
          VERTEX_COLOR_AVAILABLE: false,
        },
      },
      {
        defines: {
          CLUSTER_FORWARD_AVAILABLE: false,
          STORAGE_BUFFER_AVAILABLE: false,
          VERTEX_COLOR_AVAILABLE: false,
        },
      },
    ];
    expect(
      resolveMaterialShaderVariantSet(
        'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
        variants,
        'wgpu-webgl2',
        false,
      ),
    ).toBe(
      'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=false',
    );
  });

  it('resolves a custom WebGL2 material to its capability-specific boot variant', () => {
    const variants = [
      {
        defines: { STORAGE_BUFFER_AVAILABLE: true, WEBGL2_COMPAT: true },
      },
      {
        defines: { STORAGE_BUFFER_AVAILABLE: false, WEBGL2_COMPAT: true },
      },
      {
        defines: { STORAGE_BUFFER_AVAILABLE: true, WEBGL2_COMPAT: false },
      },
      {
        defines: { STORAGE_BUFFER_AVAILABLE: false, WEBGL2_COMPAT: false },
      },
    ];
    expect(resolveMaterialShaderVariantSet(undefined, variants, 'wgpu-webgl2', false)).toBe(
      'STORAGE_BUFFER_AVAILABLE=false+WEBGL2_COMPAT=true',
    );
  });
});

describe('material shader binding contract', () => {
  it('does not reuse the shared PBR layout when compact texture names shift semantics', () => {
    expect(
      isSharedMaterialUserRegionCompatible([
        { name: 'baseColor', type: 'color' },
        { name: 'baseColorTexture', type: 'texture2d' },
        { name: 'normalTexture', type: 'texture2d' },
      ]),
    ).toBe(false);
  });

  it('preserves compact authored texture order for custom material schemas', () => {
    expect(
      userRegionTextureFieldOrder([
        { name: 'baseColor', type: 'color' },
        { name: 'baseColorTexture', type: 'texture2d' },
        { name: 'normalTexture', type: 'texture2d' },
      ]),
    ).toEqual(['baseColorTexture', 'normalTexture']);
    expect(userRegionTextureFieldOrder([])).toEqual([]);
    expect(userRegionTextureFieldOrder(undefined)).toEqual([
      'baseColorTexture',
      'metallicRoughnessTexture',
      'normalTexture',
      'emissiveTexture',
      'occlusionTexture',
      'transmissionTexture',
      'thicknessTexture',
    ]);
  });

  it('keeps record binding on the cooked projection contract', () => {
    const recordSource = readFileSync(
      resolve(import.meta.dirname, '../record/main-pass-material.ts'),
      'utf8',
    );
    const projectionSource = readFileSync(
      resolve(import.meta.dirname, '../assembly/material/assembly.ts'),
      'utf8',
    );
    expect(projectionSource).toContain('projectMaterialRecord');
    expect(recordSource).not.toMatch(/internals\.assets\.get<MaterialAsset>/);
    expect(recordSource).not.toMatch(/firstMaterial as \{/);
    expect(recordSource).not.toContain('baseColorHandle');
  });

  it('recognizes a world-space shader that reads only the canonical view uniform', () => {
    const source = `
      struct View { worldViewProj: mat4x4<f32> }
      @group(0) @binding(0) var<uniform> view: View;
      @vertex fn vs_main() -> @builtin(position) vec4<f32> { return view.worldViewProj[0]; }
    `;

    expect(resolveMaterialShaderBindingContract(source)).toBe('view-only');
  });

  it('recognizes the canonical view name after naga-oil import mangling', () => {
    const source = `
      @group(0) @binding(0)
      var<uniform> viewX_naga_oil_mod_XMZXXEZ3FMF4F65TJMV3TUOTDN5WW233OX: View;
    `;

    expect(resolveMaterialShaderBindingContract(source)).toBe('view-only');
  });

  it('recognizes the VFX view plus sampled scene-depth contract', () => {
    const source = `
      struct View { worldViewProj: mat4x4<f32> }
      @group(0) @binding(0) var<uniform> view: View;
      @group(0) @binding(1) var scene_depth: texture_depth_2d;
      @fragment fn fs_main() -> @location(0) vec4<f32> {
        return vec4<f32>(textureLoad(scene_depth, vec2<i32>(0, 0), 0));
      }
    `;

    expect(resolveMaterialShaderBindingContract(source)).toBe('view-and-scene-depth');
  });

  it('keeps shaders with material groups on the full render-material layout', () => {
    const source = `
      @group(0) @binding(0) var<uniform> view: mat4x4<f32>;
      @group(1) @binding(0) var<uniform> material: vec4<f32>;
    `;

    expect(resolveMaterialShaderBindingContract(source)).toBe('render-material');
  });

  it('recognizes a group-zero sampled depth resource without inventing a view uniform', () => {
    const source = `
      @group(0) @binding(0) var sceneDepth: texture_depth_2d;
      @fragment fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
        return vec4<f32>(textureLoad(sceneDepth, vec2<i32>(position.xy), 0));
      }
    `;

    expect(resolveMaterialShaderBindingContract(source)).toBe('group-0-resource');
  });
});

describe('material shader color-domain contract', () => {
  it('keeps shared sprite layouts stable while splitting standard clearcoat maps', () => {
    const sharedSpriteSchema = [{ name: 'tint', type: 'color' as const }];
    const standardClearcoatSchema = [
      { name: 'clearcoat', type: 'f32' as const },
      { name: 'clearcoatTexture', type: 'texture2d' as const },
    ];

    expect(effectiveMaterialLayoutIdentity('forgeax::sprite', sharedSpriteSchema)).toBeUndefined();
    expect(
      effectiveMaterialLayoutIdentity('forgeax::default-standard-pbr', standardClearcoatSchema),
    ).toBeTypeOf('string');
    expect(
      effectiveMaterialLayoutIdentity('forgeax::default-standard-pbr', [
        { name: 'clearcoat', type: 'f32' as const },
      ]),
    ).toBeUndefined();
  });

  it('routes HDR sprite targets to fs_main_hdr while unorm targets use fs_main', () => {
    const source = [
      readFileSync(resolve(import.meta.dirname, '../assembly/webgpu-renderer.ts'), 'utf8'),
      readFileSync(resolve(import.meta.dirname, '../assembly/webgpu-ready.ts'), 'utf8'),
    ].join('\n');
    expect(source).toContain(
      "isHdr &&\n      passKind === 'forward' &&\n      (materialShaderId === 'forgeax::sprite' || materialShaderId === 'forgeax::sprite-lit')",
    );
    expect(source).toContain("? 'fs_main_hdr'");
    expect(source).toContain('colorFormat: isHdr ? HDR_COLOR_ATTACHMENT_FORMAT : ldrColorFormat');
    expect(source).toContain("entryPoint = 'fs_main_hdr'");
  });

  it('keeps physical map layout derivation in the shared pipeline owner', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../assembly/webgpu-renderer.ts'),
      'utf8',
    );
    expect(source).toContain('isCanonicalStandardPbrMaterialShader(materialShaderId)');
    expect(source).toContain('requiresStandardMapLayout');
  });

  it('does not reuse the scalar shared BGL for authored clearcoat maps', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../assembly/webgpu-renderer.ts'),
      'utf8',
    );
    expect(source).toMatch(
      /if \(\s*!isStandardMapLayout\s*&&\s*isSharedMaterialUserRegionCompatible\(/u,
    );
  });

  it('keeps the fixed standard texture ABI before authored clearcoat slots', () => {
    const pipelineSource = readFileSync(resolve(import.meta.dirname, '../pbr-pipeline.ts'), 'utf8');
    const recordSource = readFileSync(
      resolve(import.meta.dirname, '../record/main-pass-material.ts'),
      'utf8',
    );
    expect(pipelineSource).toContain(
      'const physicalFields = physicalTextureFields(effectiveSchema)',
    );
    expect(pipelineSource).toContain('appendTextureInjection(afterTransmission, physicalFields)');
    expect(recordSource).toContain('BUILTIN_USER_REGION_TEXTURE_FIELDS');
  });
});

describe('material shader vertex input contract', () => {
  it('recognizes VsIn-style vertex input structs', () => {
    const source = `
      struct VsIn { @location(0) position: vec3<f32> }
      struct VsOut { @builtin(position) position: vec4<f32> }
      @vertex fn vs_main(input: VsIn) -> VsOut { var out: VsOut; return out }
    `;

    expect(resolveMaterialShaderVertexInputContract(source)).toBe('render-material');
  });

  it('does not treat fullscreen output locations as vertex inputs', () => {
    const source = `
      struct FullscreenOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) uv: vec2<f32>,
      }
      @vertex fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> FullscreenOutput {
        var out: FullscreenOutput;
        return out;
      }
    `;

    expect(resolveMaterialShaderVertexInputContract(source)).toBe('none');
  });

  it('derives authored Standard UV aliases from the vertex input struct', () => {
    const source = `
      struct VsIn {
        @location(0) position: vec3<f32>,
        @location(2) uv: vec2<f32>,
        @location(6) uv1_: vec2<f32>,
        @location(12) uv7_: vec2<f32>,
      }
      struct VsOut { @builtin(position) position: vec4<f32> }
      @vertex fn vs_main(input: VsIn) -> VsOut { var out: VsOut; return out }
    `;

    expect(resolveMaterialShaderUvSetCount(source)).toBe(8);
  });

  it('keeps an explicit prepared vertex layout on a missing shader', () => {
    expect(allowsUnlitPreparedFallback(null, undefined)).toBe(true);
    expect(allowsUnlitPreparedFallback(null, 'position-size-color-instance', 'forward')).toBe(true);
    expect(
      allowsUnlitPreparedFallback(null, 'position-size-color-instance', 'forgeax::missing-shader'),
    ).toBe(false);
  });

  it('defers every VFX prepared layout when its material shader is missing', () => {
    expect(shouldDeferMissingPreparedMaterialShader('billboard-material-instance')).toBe(true);
    expect(shouldDeferMissingPreparedMaterialShader('topology-segment-instance')).toBe(true);
    expect(shouldDeferMissingPreparedMaterialShader('mesh-geometry-material-instance')).toBe(true);
    expect(shouldDeferMissingPreparedMaterialShader('position-size-color-instance')).toBe(false);
    expect(shouldDeferMissingPreparedMaterialShader(undefined)).toBe(false);
  });
});
