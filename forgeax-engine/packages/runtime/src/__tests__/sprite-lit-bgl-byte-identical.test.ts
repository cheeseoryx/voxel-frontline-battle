// @forgeax/engine-runtime / __tests__ / sprite-lit-bgl-byte-identical.test.ts
//
// feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / w2.
//
// Red-stage tests for the AC-07 BindGroupLayout byte-identical contract:
// sprite-lit reuses the pbr-view / pbr-material-merged / pbr-mesh-array /
// pbr-instances BGL builders the same way sprite does. The runtime BGL
// construction is parameterized purely on `caps.storageBuffer` (and the
// kind enum), so sprite-lit hitting `kind: 'pbr-view'` produces a JSON
// byte-identical result to sprite hitting the same kind.
//
// SSOTs:
//   - research.md F-2 (d) (4 BGL byte-identical layout congruence)
//   - plan-strategy D-6 (4 PBR-unused slots reuse default sampler + default
//     white texture; BGL JSON unchanged across sprite vs sprite-lit)
//   - requirements AC-07

import { describe, expect, it } from 'vitest';
import { mergeSkylightIntoMaterialBgl } from '../../../render/src/ibl/skylight-bind-group';
import {
  appendInjection,
  buildPbrMaterialUserRegionEntries,
  buildPbrViewBglEntries,
} from '../../../render/src/pbr-pipeline';
import type { PipelineSpec } from '../../../render/src/pipeline-spec';
import { buildBindGroupLayoutDescriptor } from '../../../render/src/pipeline-spec';

function makeSpec(shaderId: string): PipelineSpec {
  return {
    shader: {
      id: shaderId,
      passKind: 'forward',
      variantSet: undefined,
    },
    attachments: {
      colorFormats: ['rgba8unorm-srgb'],
      depthFormat: 'depth24plus-stencil8',
      sampleCount: 1,
    },
    geometry: {
      topology: 'triangle-list',
      vertexLayout: {},
    },
    renderState: undefined,
  };
}

describe('sprite-lit BGL byte-identical to sprite (AC-07, w4/w5 close)', () => {
  describe('pbr-view BGL (Cluster lights live in group(2))', () => {
    it('sprite-lit vs sprite share the same 10-entry pbr-view BGL under storage-buffer caps', () => {
      const spriteSpec = makeSpec('forgeax::sprite');
      const spriteLitSpec = makeSpec('forgeax::sprite-lit');
      const sprite = buildBindGroupLayoutDescriptor(spriteSpec, {
        kind: 'pbr-view',
        caps: { storageBuffer: true, extendedLighting: false },
      });
      const spriteLit = buildBindGroupLayoutDescriptor(spriteLitSpec, {
        kind: 'pbr-view',
        caps: { storageBuffer: true, extendedLighting: false },
      });
      expect(JSON.stringify(spriteLit)).toBe(JSON.stringify(sprite));
      // binding 10 is the shared Points/Lines view UBO; bindings 11/12 are the
      // optional SpotLight projector texture and sampler on capable devices.
      expect(spriteLit.entries.length).toBe(10);
    });

    it('sprite-lit vs sprite share the same 10-entry pbr-view BGL under uniform fallback caps (AC-10)', () => {
      const spriteSpec = makeSpec('forgeax::sprite');
      const spriteLitSpec = makeSpec('forgeax::sprite-lit');
      const sprite = buildBindGroupLayoutDescriptor(spriteSpec, {
        kind: 'pbr-view',
        caps: { storageBuffer: false, extendedLighting: false },
      });
      const spriteLit = buildBindGroupLayoutDescriptor(spriteLitSpec, {
        kind: 'pbr-view',
        caps: { storageBuffer: false, extendedLighting: false },
      });
      expect(JSON.stringify(spriteLit)).toBe(JSON.stringify(sprite));
    });

    it('does not expose point/spot light bindings on storageBuffer=true', () => {
      const entries = buildPbrViewBglEntries({ storageBuffer: true });
      expect(entries.some((entry) => entry.binding === 1 || entry.binding === 2)).toBe(false);
    });

    it('does not expose point/spot light bindings on storageBuffer=false', () => {
      const entries = buildPbrViewBglEntries({ storageBuffer: false });
      expect(entries.some((entry) => entry.binding === 1 || entry.binding === 2)).toBe(false);
    });
  });

  describe('pbr-mesh-array BGL (binding 0)', () => {
    it('sprite-lit vs sprite share same mesh-array BGL (binding 0 storage dyn offset)', () => {
      const sprite = buildBindGroupLayoutDescriptor(makeSpec('forgeax::sprite'), {
        kind: 'pbr-mesh-array',
        caps: { storageBuffer: true },
      });
      const spriteLit = buildBindGroupLayoutDescriptor(makeSpec('forgeax::sprite-lit'), {
        kind: 'pbr-mesh-array',
        caps: { storageBuffer: true },
      });
      expect(JSON.stringify(spriteLit)).toBe(JSON.stringify(sprite));
    });
  });

  describe('pbr-instances BGL (binding 0, no dyn offset)', () => {
    it('sprite-lit vs sprite share same instances BGL (AC-11 instances path day-1)', () => {
      const sprite = buildBindGroupLayoutDescriptor(makeSpec('forgeax::sprite'), {
        kind: 'pbr-instances',
        caps: { storageBuffer: true },
      });
      const spriteLit = buildBindGroupLayoutDescriptor(makeSpec('forgeax::sprite-lit'), {
        kind: 'pbr-instances',
        caps: { storageBuffer: true },
      });
      expect(JSON.stringify(spriteLit)).toBe(JSON.stringify(sprite));
    });
  });

  describe('material BGL congruence (pbr-material-merged / unlit-material)', () => {
    it('pbr-material-user-region entries are 15 (PBR layout reused by sprite & sprite-lit)', () => {
      // sprite + sprite-lit use the default standard-PBR user-region
      // schema (20 value fields + 7 user-region texture fields produce 15 BGL entries).
      // Both share the same userRegion shape and therefore the same BGL.
      const base = buildPbrMaterialUserRegionEntries();
      expect(base.length).toBe(15);
    });

    it('pbr-material-merged stays 24 entries (sprite/sprite-lit do not change material BGL shape)', () => {
      const merged = buildBindGroupLayoutDescriptor(makeSpec('forgeax::sprite-lit'), {
        kind: 'pbr-material-merged',
      });
      expect(merged.entries.length).toBe(24);
      // mergeSkylightIntoMaterialBgl + transmission injection must stay
      // append-only against the 7-entry PBR base.
      const base = buildPbrMaterialUserRegionEntries();
      const afterSky = mergeSkylightIntoMaterialBgl(base);
      const expected = [...afterSky, ...appendInjection(afterSky, 'transmission')];
      expect(merged.entries).toEqual(expected);
    });
  });
});
