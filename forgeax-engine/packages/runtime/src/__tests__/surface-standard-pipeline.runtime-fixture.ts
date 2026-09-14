import type { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { surfaceEvidenceGuid } from '../../../../apps/preview/src/surface-standard-evidence-identity';
import {
  assetGuid,
  PACKAGE_IDS,
  RUSTED_IRON_MATERIAL_GUID,
} from '../../../../templates/game-3d/assets/shared/asset-refs';

export const SURFACE_CLOSURE = 'forgeax_material::surface_v1';
export const SURFACE_WIDTH = 960;
export const SURFACE_HEIGHT = 540;
export const SURFACE_PIXEL_EPSILON = 0.05;

export const SURFACE_CASES = [
  {
    id: 'default-base',
    guid: AssetGuid.format(assetGuid(PACKAGE_IDS.materials, 'material/ground')),
    sourceKey: 'material/ground',
    sourceClosure: ['templates/game-3d/assets/materials.pack.ts'],
    pass: 'deferred',
    rootPlan: 'base-deferred',
  },
  {
    id: 'custom-base',
    guid: AssetGuid.format(RUSTED_IRON_MATERIAL_GUID),
    sourceKey: 'material/rusted-iron',
    sourceClosure: [
      'templates/game-3d/assets/materials.pack.ts',
      'templates/game-3d/assets/shaders/rusted-iron.wgsl',
    ],
    pass: 'deferred',
    rootPlan: 'base-deferred',
  },
  {
    id: 'default-physical',
    guid: surfaceEvidenceGuid('material/painted-evidence'),
    sourceKey: 'material/painted-evidence',
    sourceClosure: ['apps/preview/assets/surface-standard-evidence.pack.ts'],
    pass: 'forward',
    rootPlan: 'physical-forward',
  },
  {
    id: 'custom-physical',
    guid: surfaceEvidenceGuid('material/rusted-iron-custom-physical'),
    sourceKey: 'material/rusted-iron-custom-physical',
    sourceClosure: [
      'apps/preview/assets/surface-standard-evidence.pack.ts',
      'templates/game-3d/assets/shaders/rusted-iron.wgsl',
    ],
    pass: 'forward',
    rootPlan: 'physical-forward',
  },
] as const;

export type SurfaceCase = (typeof SURFACE_CASES)[number];

export function parseSurfaceGuid(guid: string): AssetGuid {
  const parsed = AssetGuid.parse(guid);
  if (!parsed.ok) throw new Error(`surface-standard: invalid fixture GUID ${guid}`);
  return parsed.value;
}

export function assertMaterialPayload(
  surfaceCase: SurfaceCase,
  material: MaterialAsset,
): MaterialAsset {
  if (material.passes === undefined || material.passes.length === 0) {
    throw new Error(`surface-standard: ${surfaceCase.id} has no cooked passes`);
  }
  const expectedSurfaceModule = surfaceCase.id.includes('custom')
    ? 'game_3d::rusted_iron_surface'
    : 'forgeax_material::default_standard_surface';
  const firstPass = material.passes[0];
  if (firstPass?.program.module !== 'forgeax_material::standard') {
    throw new Error(`surface-standard: ${surfaceCase.id} selected a non-Standard program`);
  }
  if (firstPass.program.moduleSlots?.surface !== expectedSurfaceModule) {
    throw new Error(
      `surface-standard: ${surfaceCase.id} Surface module mismatch; expected ${expectedSurfaceModule} observed ${firstPass.program.moduleSlots?.surface ?? '<missing>'}`,
    );
  }
  const passNames = material.passes.map((pass) => pass.name);
  const expectedPasses =
    surfaceCase.pass === 'deferred'
      ? ['forward', 'deferred', 'shadow-caster']
      : ['forward', 'shadow-caster'];
  if (
    passNames.length !== expectedPasses.length ||
    expectedPasses.some((name, index) => passNames[index] !== name)
  ) {
    throw new Error(
      `surface-standard: ${surfaceCase.id} pass policy mismatch; expected ${expectedPasses.join(',')} observed ${passNames.join(',')}`,
    );
  }
  const expectedEntries = expectedPasses.map((name) => ({
    name,
    fragmentEntry:
      name === 'forward' ? 'fs_main' : name === 'deferred' ? 'fs_gbuffer' : 'fs_shadow',
    lightMode: name === 'forward' ? 'Forward' : name === 'deferred' ? 'Deferred' : 'ShadowCaster',
  }));
  for (const [index, expected] of expectedEntries.entries()) {
    const actual = material.passes[index];
    const actualLightMode = (actual?.renderState?.tags as Record<string, string> | undefined)
      ?.LightMode;
    if (
      actual?.program.fragmentEntry !== expected.fragmentEntry ||
      actualLightMode !== expected.lightMode
    ) {
      throw new Error(
        `surface-standard: ${surfaceCase.id} entry mismatch at ${expected.name}; expected ${expected.fragmentEntry}/${expected.lightMode}`,
      );
    }
  }
  return material;
}

export function assertSurfacePixelFalsification(
  records: readonly {
    readonly id: string;
    readonly samples: readonly [number, number, number, number];
  }[],
): void {
  const byId = new Map(records.map((record) => [record.id, record.samples]));
  const distance = (left: readonly number[], right: readonly number[]) =>
    Math.max(...left.slice(0, 3).map((value, index) => Math.abs(value - (right[index] ?? 0)))) /
    255;
  for (const [customId, defaultId] of [
    ['custom-base', 'default-base'],
    ['custom-physical', 'default-physical'],
  ] as const) {
    const custom = byId.get(customId);
    const baseline = byId.get(defaultId);
    if (custom === undefined || baseline === undefined) {
      throw new Error(
        `surface-standard: pixel falsification pair missing (${defaultId}, ${customId})`,
      );
    }
    if (distance(custom, baseline) <= SURFACE_PIXEL_EPSILON) {
      throw new Error(
        `surface-standard: ${customId} is pixel-identical to ${defaultId}; custom Surface was not observed`,
      );
    }
  }
}

export function populateSurfaceWorld(world: World, materials: readonly MaterialAsset[]): void {
  const plane = createPlaneGeometry(1.3, 1.3);
  if (!plane.ok) throw new Error(`surface-standard: plane geometry failed: ${plane.error.code}`);
  const mesh = world.allocSharedRef('MeshAsset', plane.value);
  for (const [index, material] of materials.entries()) {
    const handle = world.allocSharedRef('MaterialAsset', material);
    world.spawn(
      { component: Transform, data: { pos: [(index - 1.5) * 1.45, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [handle] } },
    );
  }
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 4] } },
    {
      component: Camera,
      data: {
        fov: Math.PI / 4,
        aspect: SURFACE_WIDTH / SURFACE_HEIGHT,
        near: 0.1,
        far: 20,
        clearColor: [0, 0, 0, 1],
      },
    },
  );
  world.spawn({
    component: DirectionalLight,
    data: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 1, castShadow: true },
  });
  // The standalone renderer host does not install scenePlugin for this
  // fixture. Publish the authored local transforms before extract so the
  // camera and four cells reach the real render path with their world poses.
  propagateTransforms(world).unwrap();
}
