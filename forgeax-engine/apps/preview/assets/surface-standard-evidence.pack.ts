import { definePack } from '@forgeax/engine/pack/source';
import { Materials } from '@forgeax/engine/render';
import { ok, type MaterialAsset } from '@forgeax/engine/types';
import {
  SURFACE_EVIDENCE_PACKAGE_NAMESPACE,
  surfaceEvidenceGuid,
} from '../src/surface-standard-evidence-identity';

const packageId = SURFACE_EVIDENCE_PACKAGE_NAMESPACE;

const defaultPhysical: MaterialAsset = Materials.standard({
  baseColor: [0.28, 0.035, 0.075, 1],
  metallic: 0.12,
  roughness: 0.18,
  clearcoat: 0.82,
  clearcoatRoughness: 0.08,
});
const customPhysical: MaterialAsset = Materials.standard({
  surfaceModule: 'game_3d::rusted_iron_surface',
  parameters: [
    { name: 'ironColor', type: 'color' },
    { name: 'rustDark', type: 'color' },
    { name: 'rustBright', type: 'color' },
    { name: 'noiseScale', type: 'f32' },
    { name: 'clearcoat', type: 'f32' },
    { name: 'clearcoatRoughness', type: 'f32' },
  ],
  values: {
    ironColor: [0.07, 0.08, 0.09, 1],
    rustDark: [0.02, 0.003, 0.001, 1],
    rustBright: [0.18, 0.025, 0.004, 1],
    noiseScale: 1.85,
    clearcoat: 0.05,
    clearcoatRoughness: 0.35,
  },
});

export const SURFACE_EVIDENCE_CUSTOM_PHYSICAL_GUID = surfaceEvidenceGuid(
  'material/rusted-iron-custom-physical',
);
export const SURFACE_EVIDENCE_DEFAULT_PHYSICAL_GUID = surfaceEvidenceGuid(
  'material/painted-evidence',
);
export const SURFACE_EVIDENCE_CUSTOM_PHYSICAL_SOURCE_KEY =
  'preview-surface-standard-evidence:material/rusted-iron-custom-physical';

export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  name: 'Preview Surface Evidence',
  build: () =>
    ok({
      'material/painted-evidence': defaultPhysical,
      'material/rusted-iron-custom-physical': customPhysical,
    }),
});
