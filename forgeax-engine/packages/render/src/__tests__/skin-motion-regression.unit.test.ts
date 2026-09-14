import type { Mat4 } from '@forgeax/engine-math';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import {
  selectHdrpPbrPrewarmVariants,
  selectPipelineLayoutForVariant,
  selectSkinPrewarmVariants,
} from '../assembly/factory';
import { resolvePipelineGroup2Contract } from '../pbr-pipeline';
import { createSkinPaletteAllocator } from '../systems/skin-palette-allocator';

describe('custom skinned mesh motion consumer contract', () => {
  it('keeps two animated palette payloads observable at the skin consumer', () => {
    const writes: Array<{ buffer: Buffer; offset: number; data: Float32Array }> = [];
    const device = {
      limits: { maxStorageBufferBindingSize: 65536 },
      createBuffer: () => ok({} as Buffer),
      queue: {
        writeBuffer(buffer: Buffer, offset: number, data: Float32Array) {
          writes.push({ buffer, offset, data: new Float32Array(data) });
          return ok(undefined);
        },
      },
    } as unknown as RhiDevice;
    const allocator = createSkinPaletteAllocator(device, 65536, true);
    const ibm = new Float32Array(16);
    ibm[0] = 1;
    ibm[5] = 1;
    ibm[10] = 1;
    ibm[15] = 1;
    const poseA = new Float32Array(ibm) as unknown as Mat4;
    const poseB = new Float32Array(ibm) as unknown as Mat4;
    poseB[12] = 0.5;
    const first = allocator.allocateSlice(1);
    allocator.writeJointPalette(first, [ibm], [poseA]);
    allocator.resetForFrame();
    const second = allocator.allocateSlice(1);
    allocator.writeJointPalette(second, [ibm], [poseB]);

    expect(writes).toHaveLength(2);
    expect(writes[0]?.buffer).toBe(writes[1]?.buffer);
    expect(writes[0]?.offset).toBe(writes[1]?.offset);
    expect(writes[0]?.data).not.toEqual(writes[1]?.data);
    expect(writes[1]?.data[12]).toBe(0.5);
  });

  it('keeps stable uniform palette slices isolated across frame-pool resets', () => {
    const device = {
      limits: { maxUniformBufferBindingSize: 65536 },
      createBuffer: () => ok({} as Buffer),
      destroyBuffer: () => undefined,
      queue: { writeBuffer: () => ok(undefined) },
    } as unknown as RhiDevice;
    const allocator = createSkinPaletteAllocator(device, 65536, false);
    const first = allocator.allocateSliceFor('world:1', 1);
    allocator.resetForFrame();
    const second = allocator.allocateSliceFor('world:2', 1);

    expect(second.buffer).not.toBe(first.buffer);
  });

  it('does not reuse a split storage range beyond its binding window', () => {
    let bufferId = 0;
    const device = {
      limits: { maxStorageBufferBindingSize: 65536 },
      createBuffer: () => ok({ id: bufferId++ } as unknown as Buffer),
      queue: { writeBuffer: () => ok(undefined) },
    } as unknown as RhiDevice;
    const allocator = createSkinPaletteAllocator(device, 65536, true);

    const full = allocator.allocateSliceFor('world:full', 255);
    allocator.releaseSliceFor('world:full');
    const firstSmall = allocator.allocateSliceFor('world:first', 1);
    const secondSmall = allocator.allocateSliceFor('world:second', 1);

    expect(firstSmall.buffer).toBe(full.buffer);
    expect(secondSmall.buffer).not.toBe(full.buffer);
  });

  it('prepares both URP and HDRP pbr-skin consumers with the skin-cluster contract', () => {
    const variants = selectSkinPrewarmVariants(
      {
        identifier: 'forgeax::pbr-skin',
        sourcePath: 'default-standard-pbr-skin.wgsl',
        composedWgsl: '@group(2) @binding(1) var<storage> palette: array<u32>;',
        paramSchema: '[]',
        variants: [
          {
            definesKey:
              'CLUSTER_FORWARD_AVAILABLE=false+PROBE_BLEND_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
            defines: {
              CLUSTER_FORWARD_AVAILABLE: false,
              PROBE_BLEND_AVAILABLE: true,
              STORAGE_BUFFER_AVAILABLE: true,
              VERTEX_COLOR_AVAILABLE: false,
            },
            composedWgsl: 'probe-urp',
          },
          {
            definesKey:
              'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
            defines: {
              CLUSTER_FORWARD_AVAILABLE: false,
              STORAGE_BUFFER_AVAILABLE: true,
              VERTEX_COLOR_AVAILABLE: false,
            },
            composedWgsl: '@group(2) @binding(1) var<storage> palette: array<u32>;',
          },
          {
            definesKey:
              'CLUSTER_FORWARD_AVAILABLE=true+PROBE_BLEND_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
            defines: {
              CLUSTER_FORWARD_AVAILABLE: true,
              PROBE_BLEND_AVAILABLE: true,
              STORAGE_BUFFER_AVAILABLE: true,
              VERTEX_COLOR_AVAILABLE: false,
            },
            composedWgsl: 'probe-hdrp',
          },
          {
            definesKey:
              'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
            defines: {
              CLUSTER_FORWARD_AVAILABLE: true,
              STORAGE_BUFFER_AVAILABLE: true,
              VERTEX_COLOR_AVAILABLE: false,
            },
            composedWgsl:
              '@group(2) @binding(1) var<storage> palette: array<u32>; @group(2) @binding(4) var<storage> lights: array<u32>;',
          },
        ],
      },
      true,
    );
    expect(variants.map((variant) => variant.definesKey)).toEqual([
      'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
      'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
    ]);
    expect(resolvePipelineGroup2Contract(variants[1]?.composedWgsl ?? '')).toBe('skin-cluster');
    expect(
      selectPipelineLayoutForVariant(
        {
          pbrPipelineLayout: 'urp' as never,
          hdrpPbrPipelineLayout: 'hdrp' as never,
          pbrSkinPipelineLayout: 'skin-urp' as never,
          hdrpSkinPipelineLayout: 'skin-hdrp' as never,
        },
        variants[1]?.definesKey,
        'hdrp-skin',
      ),
    ).toBe('skin-hdrp');
  });

  it('does not expose clustered skin or HDRP PBR prewarm variants on WebGL2', () => {
    const variants = [
      {
        definesKey: 'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=false',
        defines: {
          CLUSTER_FORWARD_AVAILABLE: false,
          STORAGE_BUFFER_AVAILABLE: false,
        },
        composedWgsl: 'urp-uniform',
      },
      {
        definesKey: 'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=false',
        defines: {
          CLUSTER_FORWARD_AVAILABLE: true,
          STORAGE_BUFFER_AVAILABLE: false,
        },
        composedWgsl: 'hdrp-uniform',
      },
    ];
    const entry = {
      identifier: 'forgeax::default-standard-pbr-skin',
      sourcePath: 'default-standard-pbr-skin.wgsl',
      composedWgsl: 'default',
      paramSchema: '[]',
      variants,
    };

    expect(selectSkinPrewarmVariants(entry, false).map((variant) => variant.definesKey)).toEqual([
      'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=false',
    ]);
    expect(selectHdrpPbrPrewarmVariants(entry, false, true)).toEqual([]);
  });
});
