import { describe, expect, it } from 'vitest';
import {
  extractDefineImportPath,
  loadEngineShaderEntries,
} from '../engine-inputs/load-engine-shader-entries.js';
import * as publicSurface from '../index.js';
import { buildEngineShaderManifest, VIEW_ABI } from '../index.js';

describe('vite-plugin-shader public engine input surface', () => {
  it('keeps the plugin front door without a version mirror', () => {
    expect(typeof publicSurface.forgeaxShader).toBe('function');
    expect('VITE_PLUGIN_SHADER_PACKAGE_VERSION' in publicSurface).toBe(false);
  });

  it('publishes one typed View ABI without live GPU objects', () => {
    expect(VIEW_ABI.moduleId).toBe('forgeax_view::common');
    expect(VIEW_ABI.group).toBe(0);
    expect(VIEW_ABI.binding).toBe(0);
    expect(VIEW_ABI.byteLength).toBe(960);
    expect(VIEW_ABI.fields.map((field) => field.name)).toEqual([
      'worldViewProj',
      'inverseViewProj',
      'spotLightViewProj',
      'temporalProjection',
      'fog',
    ]);
    expect(VIEW_ABI.fields.at(-1)).toEqual({ name: 'fog', offsetBytes: 800, sizeBytes: 32 });
    expect(JSON.stringify(VIEW_ABI)).not.toMatch(/device|buffer|texture/i);
  });

  it('keeps engine entries and import-path extraction behind engine-inputs', async () => {
    expect(extractDefineImportPath('#define_import_path forgeax_view::common')).toBe(
      'forgeax_view::common',
    );
    const entries = await loadEngineShaderEntries();
    expect(entries.imports['forgeax_view::common']).toContain('struct View');
    expect(entries.imports['forgeax_pbr::lighting_probe']).toContain('evaluateProbeDiffuse');
    expect(entries.imports['forgeax_pbr::lighting_spot_projector']).toContain(
      'fn sampleStandardSpotProjector',
    );
    expect(entries.bloomBright.source).toContain('bloom');
  });

  it('publishes and compiles the scene-temporal import closure', async () => {
    const entries = await loadEngineShaderEntries();
    expect(entries.imports.forgeax_scene_temporal).toContain(
      '#define_import_path forgeax_scene_temporal',
    );
    const manifest = await buildEngineShaderManifest();
    for (const identifier of [
      'forgeax::default-standard-pbr',
      'forgeax::pbr-skin',
      'forgeax::default-unlit',
    ]) {
      const shader = manifest.materialShaders.find((entry) => entry.identifier === identifier);
      expect(shader, `${identifier} must compile through the engine manifest`).toBeDefined();
      expect(shader?.composedWgsl).toContain('packSceneTemporalV1');
    }
    expect(
      manifest.entries.some((entry) => entry.wgsl.includes('SceneTemporalV1')),
      'the temporal utility closure must survive manifest compilation',
    ).toBe(true);
  }, 60_000);

  it('routes point-shadow defines through the standalone manifest builder', async () => {
    const manifest = await buildEngineShaderManifest({ pointShadows: true });
    const skin = manifest.materialShaders.find((entry) => entry.identifier === 'forgeax::pbr-skin');
    expect(skin, 'the point-shadow manifest must compile the skinned Standard entry').toBeDefined();
    expect(
      skin?.variants.some((variant) => variant.composedWgsl.includes('evalPointShadowed')),
    ).toBe(true);
  }, 60_000);
});
