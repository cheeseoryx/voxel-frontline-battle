import { describe, expect, it } from 'vitest';
import { selectPipelineLayoutForVariant } from '../../assembly/factory';
import { resolvePipelineGroup2Contract } from '../../pbr-pipeline';
import { projectDeviceOwnedBindGroup } from '../frame-lighting';
import { selectMaterialGroup2 } from '../main-pass-material';

const meshGroup = { label: 'pbr-mesh-bg' } as never;
const clusterGroup = { label: 'hdrp-unified-bg-group2' } as never;

describe('transparent material group 2 selection', () => {
  it('uses the shared cluster layout only for standard materials', () => {
    expect(selectMaterialGroup2(clusterGroup, meshGroup, 'cluster')).toBe(clusterGroup);
    expect(selectMaterialGroup2(clusterGroup, meshGroup, 'mesh')).toBe(meshGroup);
  });

  it('returns null when a non-standard material lacks its ordinary mesh group', () => {
    expect(selectMaterialGroup2(clusterGroup, null, 'mesh')).toBeNull();
  });

  it('resolves mesh, skin, and clustered skin from the composed shader artifact', () => {
    expect(
      resolvePipelineGroup2Contract('@group(2) @binding(0) var<storage> mesh: array<u32>;'),
    ).toBe('mesh');
    expect(
      resolvePipelineGroup2Contract(
        '@group(2) @binding(0) var<storage> mesh: array<u32>; @group(2) @binding(1) var<uniform> palette: mat4x4<f32>;',
      ),
    ).toBe('skin');
    expect(
      resolvePipelineGroup2Contract(
        '@group(2) @binding(0) var<storage> mesh: array<u32>; @group(2) @binding(1) var<storage> palette: array<u32>; @group(2) @binding(4) var<storage> lights: array<u32>;',
      ),
    ).toBe('skin-cluster');
  });

  it('lets the resolved clustered contract select the unified group', () => {
    expect(selectMaterialGroup2(clusterGroup, meshGroup, 'cluster')).toBe(clusterGroup);
    expect(selectMaterialGroup2(clusterGroup, meshGroup, 'skin')).toBeNull();
    // A skin-cluster PSO cannot consume the ordinary HDRP group. The caller
    // must provide the dedicated skin bind group through the skin path; when
    // it is absent, fail-stop instead of submitting a layout-invalid draw.
    expect(selectMaterialGroup2(clusterGroup, meshGroup, 'skin-cluster')).toBeNull();
  });

  it('keeps a mesh contract on the mesh pipeline despite the HDRP variant key', () => {
    const pbrPipelineLayout = { label: 'pbr-pl' } as never;
    const hdrpPipelineLayout = { label: 'hdrp-pbr-pl' } as never;
    expect(
      selectPipelineLayoutForVariant(
        {
          pbrPipelineLayout,
          hdrpPbrPipelineLayout: hdrpPipelineLayout,
          pbrSkinPipelineLayout: null,
          hdrpSkinPipelineLayout: null,
        },
        '',
        'pbr',
      ),
    ).toBe(pbrPipelineLayout);
  });

  it('rejects membership bindings from a retired device or layout', () => {
    const deviceA = {} as never;
    const deviceB = {} as never;
    const layoutA = {} as never;
    const layoutB = {} as never;
    const bindGroup = {} as never;
    const state = { device: deviceA, layout: layoutA, bindGroup };
    expect(projectDeviceOwnedBindGroup(state, deviceA, layoutA)).toBe(bindGroup);
    expect(projectDeviceOwnedBindGroup(state, deviceB, layoutA)).toBeNull();
    expect(projectDeviceOwnedBindGroup(state, deviceA, layoutB)).toBeNull();
  });
});
