import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const DEFINE_IMPORT_PATH_RE = /^\s*#define_import_path\s+([A-Za-z0-9_.:-]+)/m;

export interface EngineShaderFile {
  readonly id: string;
  readonly source: string;
  readonly reservedIdentifier?: string | undefined;
}

export interface EngineShaderEntries {
  readonly defaultStandardPbr: EngineShaderFile;
  readonly defaultStandardPbrSkin: EngineShaderFile;
  readonly unlit: EngineShaderFile;
  readonly pointsLines: EngineShaderFile;
  readonly tonemap: EngineShaderFile;
  readonly taaResolve: EngineShaderFile;
  readonly motionBlur: EngineShaderFile;
  readonly shadowCaster: EngineShaderFile;
  readonly sprite: EngineShaderFile;
  readonly spriteLit: EngineShaderFile;
  readonly msdfText: EngineShaderFile;
  readonly iblEquirectToCube: EngineShaderFile;
  readonly iblIrradiance: EngineShaderFile;
  readonly iblPrefilter: EngineShaderFile;
  readonly iblBrdfLut: EngineShaderFile;
  readonly fxaa: EngineShaderFile;
  readonly bloomBright: EngineShaderFile;
  readonly bloomBlur: EngineShaderFile;
  readonly bloomComposite: EngineShaderFile;
  /** Renderer-owned volumetric-fog utility entry points. */
  readonly volumeInject: EngineShaderFile;
  readonly volumeTemporal: EngineShaderFile;
  readonly volumeIntegrate: EngineShaderFile;
  readonly volumeComposite: EngineShaderFile;
  readonly skybox: EngineShaderFile;
  readonly hdrpSsao: EngineShaderFile;
  readonly imports: Record<string, string>;
}

export function extractDefineImportPath(source: string): string | undefined {
  return DEFINE_IMPORT_PATH_RE.exec(source)?.[1];
}

export const SURFACE_SLOT_MODULE = 'forgeax_material::slot::surface' as const;

/** Project the engine default Surface into the Standard slot identity. */
export function projectSurfaceSlotSource(source: string): string {
  return source.replace(
    /^\s*#define_import_path\s+[^\n]+/m,
    `#define_import_path ${SURFACE_SLOT_MODULE}`,
  );
}

function readEntry(
  srcDir: string,
  fileName: string,
  reservedIdentifier?: string,
): Promise<EngineShaderFile> {
  const id = resolve(srcDir, fileName);
  return readFile(id, 'utf8').then((source) => ({
    id,
    source,
    ...(reservedIdentifier === undefined ? {} : { reservedIdentifier }),
  }));
}

/** Load canonical Engine shader entries and their import closure. */
export async function loadEngineShaderEntries(): Promise<EngineShaderEntries> {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve('@forgeax/engine-shader/package.json');
  const srcDir = resolve(dirname(packageJsonPath), 'src');
  const entries = await Promise.all([
    readEntry(srcDir, 'default-standard-pbr.wgsl', 'forgeax::default-standard-pbr'),
    readEntry(srcDir, 'default-standard-pbr-skin.wgsl', 'forgeax::pbr-skin'),
    readEntry(srcDir, 'unlit.wgsl', 'forgeax::default-unlit'),
    readEntry(srcDir, 'points-lines.wgsl', 'forgeax::points-lines'),
    readEntry(srcDir, 'tonemap.wgsl'),
    readEntry(srcDir, 'taa-resolve.wgsl'),
    readEntry(srcDir, 'motion-blur.wgsl'),
    readEntry(srcDir, 'shadow_caster.wgsl', 'forgeax::default-shadow-caster'),
    readEntry(srcDir, 'sprite.wgsl', 'forgeax::sprite'),
    readEntry(srcDir, 'sprite-lit.wgsl', 'forgeax::sprite-lit'),
    readEntry(srcDir, 'msdf-text.wgsl', 'forgeax::msdf-text'),
    readEntry(srcDir, 'ibl-equirect-to-cube.wgsl'),
    readEntry(srcDir, 'ibl-irradiance.wgsl'),
    readEntry(srcDir, 'ibl-prefilter.wgsl'),
    readEntry(srcDir, 'ibl-brdf-lut.wgsl'),
    readEntry(srcDir, 'fxaa.wgsl'),
    readEntry(srcDir, 'bloom-bright.wgsl'),
    readEntry(srcDir, 'bloom-blur.wgsl'),
    readEntry(srcDir, 'bloom-composite.wgsl'),
    readEntry(srcDir, 'volume/volume-inject.wgsl'),
    readEntry(srcDir, 'volume/volume-temporal.wgsl'),
    readEntry(srcDir, 'volume/volume-integrate.wgsl'),
    readEntry(srcDir, 'volume/volume-composite.wgsl'),
    readEntry(srcDir, 'skybox.wgsl'),
    readEntry(srcDir, 'hdrp-ssao.wgsl'),
    readFile(resolve(srcDir, 'common.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'brdf.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'pbr-temporal.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'scene-temporal.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'fog.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'standard-cluster.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'ibl-shared.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'ibl-equirect-to-cube.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'ibl-irradiance.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'ibl-prefilter.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'ibl-brdf-lut.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'ibl-sampling.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'tbn.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'lighting-directional.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'lighting-punctual.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'lighting-spot-modifiers.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'lighting-rect-area.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'lighting-probe.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'lighting-attenuation.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'lighting-spot-projector.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'fxaa.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'bloom-bright.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'bloom-blur.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'bloom-composite.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'skybox.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'hdrp-ssao.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'shadow-pcf.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'material/physical/clearcoat.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'material/physical/anisotropy.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'material/physical/sheen.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'material/physical/iridescence.wgsl'), 'utf8'),
  ]);
  const [surfaceV1, defaultStandardSurface] = await Promise.all([
    readFile(resolve(srcDir, 'surface_v1.wgsl'), 'utf8'),
    readFile(resolve(srcDir, 'default_standard_surface.wgsl'), 'utf8'),
  ]);
  const [
    defaultStandardPbr,
    defaultStandardPbrSkin,
    unlit,
    pointsLines,
    tonemap,
    taaResolve,
    motionBlur,
    shadowCaster,
    sprite,
    spriteLit,
    msdfText,
    iblEquirectToCube,
    iblIrradiance,
    iblPrefilter,
    iblBrdfLut,
    fxaa,
    bloomBright,
    bloomBlur,
    bloomComposite,
    volumeInject,
    volumeTemporal,
    volumeIntegrate,
    volumeComposite,
    skybox,
    hdrpSsao,
    common,
    brdf,
    temporal,
    sceneTemporal,
    fog,
    standardCluster,
    iblShared,
    iblEquirectToCubeImport,
    iblIrradianceImport,
    iblPrefilterImport,
    iblBrdfLutImport,
    iblSampling,
    tbn,
    lightingDirectional,
    lightingPunctual,
    lightingSpotModifiers,
    lightingRectArea,
    lightingProbe,
    lightingAttenuation,
    lightingSpotProjector,
    fxaaImport,
    bloomBrightImport,
    bloomBlurImport,
    bloomCompositeImport,
    skyboxImport,
    hdrpSsaoImport,
    shadowPcf,
    clearcoat,
    anisotropy,
    sheen,
    iridescence,
  ] = entries;
  return {
    defaultStandardPbr,
    defaultStandardPbrSkin,
    unlit,
    pointsLines,
    tonemap,
    taaResolve,
    motionBlur,
    shadowCaster,
    sprite,
    spriteLit,
    msdfText,
    iblEquirectToCube,
    iblIrradiance,
    iblPrefilter,
    iblBrdfLut,
    fxaa,
    bloomBright,
    bloomBlur,
    bloomComposite,
    volumeInject,
    volumeTemporal,
    volumeIntegrate,
    volumeComposite,
    skybox,
    hdrpSsao,
    imports: {
      'forgeax_view::common': common,
      'forgeax_pbr::brdf': brdf,
      'forgeax_pbr::temporal': temporal,
      forgeax_scene_temporal: sceneTemporal,
      'forgeax_view::fog': fog,
      'forgeax_standard::cluster': standardCluster,
      'forgeax_pbr::ibl_shared': iblShared,
      'forgeax_pbr::ibl_equirect_to_cube': iblEquirectToCubeImport,
      'forgeax_pbr::ibl_irradiance': iblIrradianceImport,
      'forgeax_pbr::ibl_prefilter': iblPrefilterImport,
      'forgeax_pbr::ibl_brdf_lut': iblBrdfLutImport,
      'forgeax_pbr::ibl_sampling': iblSampling,
      'forgeax_pbr::tbn': tbn,
      'forgeax_pbr::lighting_directional': lightingDirectional,
      'forgeax_pbr::lighting_punctual': lightingPunctual,
      'forgeax_pbr::lighting_spot_modifiers': lightingSpotModifiers,
      'forgeax_pbr::lighting_rect_area': lightingRectArea,
      'forgeax_pbr::lighting_probe': lightingProbe,
      'forgeax_pbr::lighting_attenuation': lightingAttenuation,
      'forgeax_pbr::lighting_spot_projector': lightingSpotProjector,
      'forgeax_view::fxaa': fxaaImport,
      'forgeax_view::bloom_bright': bloomBrightImport,
      'forgeax_view::bloom_blur': bloomBlurImport,
      'forgeax_view::bloom_composite': bloomCompositeImport,
      'forgeax_view::skybox': skyboxImport,
      'forgeax_hdrp::ssao': hdrpSsaoImport,
      'forgeax_pbr::shadow_pcf': shadowPcf,
      'forgeax_pbr::clearcoat': clearcoat,
      'forgeax_pbr::anisotropy': anisotropy,
      'forgeax_pbr::sheen': sheen,
      'forgeax_pbr::iridescence': iridescence,
      'forgeax_material::surface_v1': surfaceV1,
      'forgeax_material::default_standard_surface': defaultStandardSurface,
      [SURFACE_SLOT_MODULE]: projectSurfaceSlotSource(defaultStandardSurface),
    },
  };
}

/** Load package-owned shader entries into the shared Engine input shape. */
export async function loadPackageMaterialShaderEntries(
  packageName: string,
): Promise<EngineShaderFile[]> {
  const require = createRequire(import.meta.url);
  let packageRoot: string;
  try {
    packageRoot = dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    const prefix = '@forgeax/engine-';
    if (!packageName.startsWith(prefix)) return [];
    const workspaceName = packageName.slice(prefix.length);
    let current = process.cwd();
    while (true) {
      const candidate = resolve(current, 'packages', workspaceName);
      if (existsSync(resolve(candidate, 'package.json'))) {
        packageRoot = candidate;
        break;
      }
      const parent = dirname(current);
      if (parent === current) return [];
      current = parent;
    }
  }
  const shaderRoot = resolve(packageRoot, 'src', 'shaders');
  let names: string[];
  try {
    names = await readdir(shaderRoot);
  } catch {
    return [];
  }
  const result: EngineShaderFile[] = [];
  for (const name of names.filter((value) => value.endsWith('.wgsl')).sort()) {
    const id = resolve(shaderRoot, name);
    const source = await readFile(id, 'utf8');
    const identifier = extractDefineImportPath(source);
    if (identifier === undefined) continue;
    result.push({ id, source, reservedIdentifier: identifier });
  }
  return result;
}
