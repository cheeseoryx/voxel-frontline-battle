import type { MaterialAsset, MaterialParameter, MaterialPass } from '@forgeax/engine-types';
import {
  deriveStandardLayerPlan,
  STANDARD_MATERIAL_PARAM_SCHEMA,
  standardMaterialParameters,
  standardSurfaceParameters,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker.js';
import { projectMaterial } from '../project.js';

const parameters: readonly MaterialParameter[] = standardSurfaceParameters([
  { name: 'baseColor', type: 'color' },
  { name: 'metallic', type: 'f32' },
  { name: 'roughness', type: 'f32' },
  { name: 'clearcoat', type: 'f32' },
  { name: 'clearcoatRoughness', type: 'f32' },
]);

const passes: [MaterialPass, ...MaterialPass[]] = [
  { name: 'forward', program: { module: 'forgeax_material::standard' } },
  { name: 'shadow-caster', program: { module: 'forgeax::default-shadow-caster' } },
];

describe('standard material cook integration', () => {
  it('uses one layer identity across compiler and renderer projections', () => {
    const compilerPlan = deriveStandardLayerPlan(parameters, passes);
    const material: MaterialAsset = { kind: 'material', parameters, passes };
    const projection = projectMaterial(material, { material: 'standard', mode: 'development' });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    expect(projection.value.layerPlan).toEqual(compilerPlan);
    expect(projection.value.layerPlan.identity).toContain('standard-layer-plan-v1:physical');
  });

  it('rejects a physical deferred pass before publication', () => {
    try {
      deriveStandardLayerPlan(parameters, [
        ...passes,
        {
          name: 'deferred',
          program: { module: 'forgeax_material::standard' },
          renderState: { tags: { LightMode: 'Deferred' } },
        },
      ]);
      throw new Error('expected physical Deferred admission to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'material-physical-contract-invalid' });
    }
  });

  it('cooks anisotropy with an identity direction fallback and an RG/B texture path', async () => {
    const baseParameters: readonly MaterialParameter[] = [
      { name: 'baseColor', type: 'color' },
      { name: 'metallic', type: 'f32' },
      { name: 'roughness', type: 'f32' },
      { name: 'metallicChannel', type: 'f32' },
      { name: 'roughnessChannel', type: 'f32' },
      { name: 'aoChannel', type: 'f32' },
      { name: 'extraChannel', type: 'f32' },
      { name: 'emissive', type: 'vec3' },
      { name: 'emissiveIntensity', type: 'f32' },
      { name: 'occlusionStrength', type: 'f32' },
      { name: 'alphaCutoff', type: 'f32' },
      { name: 'normalScale', type: 'f32' },
      { name: 'specular', type: 'f32' },
      { name: 'specularColor', type: 'vec3' },
      { name: 'ior', type: 'f32' },
      { name: 'baseColorTexture', type: 'texture' },
      { name: 'metallicRoughnessTexture', type: 'texture' },
      { name: 'normalTexture', type: 'texture' },
      { name: 'emissiveTexture', type: 'texture' },
      { name: 'occlusionTexture', type: 'texture' },
      { name: 'anisotropyStrength', type: 'f32' },
      { name: 'anisotropyRotation', type: 'f32' },
    ];
    const cooker = createMaterialPackCooker();
    const cook = async (parameters: readonly MaterialParameter[]) =>
      cooker.cook({
        guid: `anisotropy-${parameters.some((parameter) => parameter.name === 'anisotropyTexture') ? 'map' : 'scalar'}`,
        source: {
          kind: 'material',
          parameters,
          passes: [{ name: 'Forward', program: { module: 'forgeax_material::standard' } }],
        },
      });

    const scalar = await cook(baseParameters);
    const mapped = await cook([...baseParameters, { name: 'anisotropyTexture', type: 'texture' }]);
    const scalarArtifact = Object.values(scalar.artifacts)[0];
    const mappedArtifact = Object.values(mapped.artifacts)[0];
    expect(scalarArtifact).toBeDefined();
    expect(mappedArtifact).toBeDefined();
    if (scalarArtifact === undefined || mappedArtifact === undefined) return;
    const scalarWgsl = new TextDecoder().decode(scalarArtifact.bytes);
    const mappedWgsl = new TextDecoder().decode(mappedArtifact.bytes);
    const scalarPayload = scalar.payload as {
      readonly cooked?: {
        readonly receipt?: { readonly derivedInterface?: { readonly layerPlanIdentity?: string } };
      };
    };
    const mappedPayload = mapped.payload as {
      readonly cooked?: {
        readonly receipt?: { readonly derivedInterface?: { readonly layerPlanIdentity?: string } };
      };
    };
    expect(scalarPayload.cooked?.receipt?.derivedInterface?.layerPlanIdentity).toContain(
      'physical:anisotropy',
    );
    expect(mappedPayload.cooked?.receipt?.derivedInterface?.layerPlanIdentity).toBe(
      scalarPayload.cooked?.receipt?.derivedInterface?.layerPlanIdentity,
    );
    expect(scalarWgsl).not.toContain('anisotropyTexture');
    expect(mappedWgsl).toContain('encodedAnisotropyDirection');
    expect(mappedWgsl).toContain('tangent.w');
  });

  it('keeps a base-only root free of second-stage texture declarations and samples', async () => {
    const baseOnly: readonly MaterialParameter[] = [
      { name: 'baseColor', type: 'color' },
      { name: 'metallic', type: 'f32' },
      { name: 'roughness', type: 'f32' },
      { name: 'metallicChannel', type: 'f32' },
      { name: 'roughnessChannel', type: 'f32' },
      { name: 'aoChannel', type: 'f32' },
      { name: 'extraChannel', type: 'f32' },
      { name: 'emissive', type: 'vec3' },
      { name: 'emissiveIntensity', type: 'f32' },
      { name: 'occlusionStrength', type: 'f32' },
      { name: 'alphaCutoff', type: 'f32' },
      { name: 'normalScale', type: 'f32' },
      { name: 'specular', type: 'f32' },
      { name: 'specularColor', type: 'vec3' },
      { name: 'ior', type: 'f32' },
      { name: 'baseColorTexture', type: 'texture' },
      { name: 'metallicRoughnessTexture', type: 'texture' },
      { name: 'normalTexture', type: 'texture' },
      { name: 'emissiveTexture', type: 'texture' },
      { name: 'occlusionTexture', type: 'texture' },
    ];
    const cooked = await createMaterialPackCooker().cook({
      guid: 'base-only',
      source: {
        kind: 'material',
        parameters: baseOnly,
        passes: [{ name: 'Forward', program: { module: 'forgeax_material::standard' } }],
      },
    });
    const artifact = Object.values(cooked.artifacts)[0];
    expect(artifact).toBeDefined();
    if (artifact === undefined) return;
    const wgsl = new TextDecoder().decode(artifact.bytes);
    const payload = cooked.payload as {
      readonly cooked?: {
        readonly receipt?: { readonly derivedInterface?: { readonly layerPlanIdentity?: string } };
      };
    };
    expect(payload.cooked?.receipt?.derivedInterface?.layerPlanIdentity).toContain('base-only');
    for (const field of [
      'clearcoatTexture',
      'clearcoatRoughnessTexture',
      'clearcoatNormalTexture',
      'anisotropyTexture',
      'sheenColorTexture',
      'sheenRoughnessTexture',
      'iridescenceTexture',
      'iridescenceThicknessTexture',
      'specularTexture',
      'specularColorTexture',
    ]) {
      expect(wgsl).not.toMatch(new RegExp(`\\b${field}\\b`));
    }
  });

  it('treats a specular color map as a physical Forward-only declaration', async () => {
    const baseOnly: readonly MaterialParameter[] = [
      { name: 'baseColor', type: 'color' },
      { name: 'metallic', type: 'f32' },
      { name: 'roughness', type: 'f32' },
      { name: 'metallicChannel', type: 'f32' },
      { name: 'roughnessChannel', type: 'f32' },
      { name: 'aoChannel', type: 'f32' },
      { name: 'extraChannel', type: 'f32' },
      { name: 'emissive', type: 'vec3' },
      { name: 'emissiveIntensity', type: 'f32' },
      { name: 'occlusionStrength', type: 'f32' },
      { name: 'alphaCutoff', type: 'f32' },
      { name: 'normalScale', type: 'f32' },
      { name: 'specular', type: 'f32' },
      { name: 'specularColor', type: 'vec3' },
      { name: 'ior', type: 'f32' },
      { name: 'baseColorTexture', type: 'texture' },
      { name: 'metallicRoughnessTexture', type: 'texture' },
      { name: 'normalTexture', type: 'texture' },
      { name: 'emissiveTexture', type: 'texture' },
      { name: 'occlusionTexture', type: 'texture' },
    ];
    const cooked = await createMaterialPackCooker().cook({
      guid: 'specular-color-map',
      source: {
        kind: 'material',
        parameters: [...baseOnly, { name: 'specularColorTexture', type: 'texture' }],
        passes: [{ name: 'Forward', program: { module: 'forgeax_material::standard' } }],
      },
    });
    const artifact = Object.values(cooked.artifacts)[0];
    expect(artifact).toBeDefined();
    if (artifact === undefined) return;
    const wgsl = new TextDecoder().decode(artifact.bytes);
    const payload = cooked.payload as {
      readonly cooked?: {
        readonly receipt?: { readonly derivedInterface?: { readonly layerPlanIdentity?: string } };
      };
    };
    expect(payload.cooked?.receipt?.derivedInterface?.layerPlanIdentity).toContain('physical');
    expect(wgsl).toContain('specularColorTexture');
  });

  it('cooks the complete physical root with compact injected bindings', async () => {
    const parameters = standardMaterialParameters(
      new Set(STANDARD_MATERIAL_PARAM_SCHEMA.map((entry) => entry.name)),
    );
    const cooked = await createMaterialPackCooker().cook({
      guid: 'physical-all-layers',
      source: {
        kind: 'material',
        parameters,
        passes: [{ name: 'Forward', program: { module: 'forgeax_material::standard' } }],
      },
    });
    const artifact = Object.values(cooked.artifacts)[0];
    expect(artifact).toBeDefined();
    if (artifact === undefined) return;
    const wgsl = new TextDecoder().decode(artifact.bytes);
    for (const field of [
      'clearcoatTexture',
      'clearcoatRoughnessTexture',
      'clearcoatNormalTexture',
      'anisotropyTexture',
      'sheenColorTexture',
      'sheenRoughnessTexture',
      'iridescenceTexture',
      'iridescenceThicknessTexture',
      'specularTexture',
      'specularColorTexture',
    ]) {
      expect(wgsl).toContain(field);
    }
    expect(wgsl).toMatch(/@binding\(15\)\s+var irradianceMap/);
    expect(wgsl).toMatch(/@binding\(24\)\s+var clearcoatSampler/);
    expect(wgsl).toMatch(/@binding\(43\)\s+var specularColorTexture/);
  });

  it('publishes complete Standard and shadow programs for a multi-pass root', async () => {
    const cooked = await createMaterialPackCooker().cook({
      guid: 'multi-pass-standard',
      source: {
        kind: 'material',
        parameters,
        passes,
      },
    });
    const artifact = Object.values(cooked.artifacts)[0];
    expect(artifact).toBeDefined();
    if (artifact === undefined) return;
    const wgsl = new TextDecoder().decode(artifact.bytes);
    expect(wgsl.match(/\bstruct\s+SurfaceInput\b/g)).toHaveLength(1);
    expect(wgsl.match(/\bfn\s+fs_main\s*\(/g)).toHaveLength(1);
    expect(wgsl.match(/\bfn\s+fs_gbuffer\s*\(/g)).toHaveLength(1);
    const sources = Object.values(cooked.artifacts).map((value) =>
      new TextDecoder().decode(value.bytes),
    );
    expect(sources.some((value) => /\bfn\s+fs_shadow\s*\(/.test(value))).toBe(true);
  });
});
