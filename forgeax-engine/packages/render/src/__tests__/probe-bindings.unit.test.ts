import { describe, expect, it } from 'vitest';
import {
  buildBindGroupLayoutDescriptor,
  buildPbrPipelineLayouts,
  buildPbrSkinLayouts,
  buildPbrViewBglEntries,
} from '../pbr-pipeline';
import {
  resolveGeometryInstancesBindGroup,
  resolveProbeBlendBuffer,
} from '../record/main-pass-geometry';
import type { ProbeBlendRecord } from '../scene/probe-blend-record';
import { PROBE_BLEND_RECORD_STRIDE, probeBlendRecordOffset } from '../scene/probe-blend-record';

describe('ProbeBlendRecord renderer lane', () => {
  it('does not construct probe pipeline layouts on the uniform fallback route', () => {
    const pipelineLabels: string[] = [];
    let handle = 0;
    const device = {
      createBindGroupLayout: () => ({ ok: true, value: { id: ++handle } }),
      createPipelineLayout: (descriptor: { label?: string }) => {
        pipelineLabels.push(descriptor.label ?? '');
        return { ok: true, value: { id: ++handle } };
      },
    };

    const pbr = buildPbrPipelineLayouts(device as never, {
      storageBuffer: false,
      extendedLighting: false,
    });
    const skin = buildPbrSkinLayouts(device as never, { storageBuffer: false }, pbr);

    expect(pipelineLabels).toEqual(['pbr-pl', 'pbr-skin-pl']);
    expect(pbr.probePipelineLayout).toBeNull();
    expect(pbr.probeInstancesBgl).toBe(pbr.instancesBgl);
    expect(skin.probePipelineLayout).toBeNull();
    expect(skin.probeInstancesBgl).toBe(pbr.instancesBgl);
  });

  it('keeps the optional extended-lighting view topology out of the base variant', () => {
    const base = buildPbrViewBglEntries({
      storageBuffer: true,
      extendedLighting: false,
      projectorAvailable: false,
    });
    const extended = buildPbrViewBglEntries({ storageBuffer: true, extendedLighting: true });

    expect(base.map((entry) => entry.binding)).toEqual([0, 3, 4, 5, 6, 7, 8, 10]);
    expect(base.some((entry) => [9, 11, 12, 13, 14].includes(entry.binding))).toBe(false);
    expect(extended.map((entry) => entry.binding)).toEqual(
      expect.arrayContaining([9, 11, 12, 13, 14, 15]),
    );
    expect(extended).toHaveLength(14);
  });

  it('keeps no-probe instances at binding(0) and adds binding(1) only for probe variants', () => {
    const base = buildBindGroupLayoutDescriptor({} as never, {
      kind: 'pbr-instances',
      caps: { storageBuffer: true },
    });
    expect(base.entries).toEqual([
      {
        binding: 0,
        visibility: 3,
        buffer: { type: 'read-only-storage', hasDynamicOffset: false },
      },
    ]);
    const probe = buildBindGroupLayoutDescriptor({} as never, {
      kind: 'pbr-instances',
      caps: { storageBuffer: true, probeBlend: true },
    });
    expect(probe.entries).toEqual([
      {
        binding: 0,
        visibility: 3,
        buffer: { type: 'read-only-storage', hasDynamicOffset: false },
      },
      {
        binding: 1,
        visibility: 2,
        buffer: { type: 'read-only-storage', hasDynamicOffset: true },
      },
    ]);
  });

  it('creates mixed no-probe/probe bind groups without crossing layouts', () => {
    const noProbeLayout = { id: 'no-probe-layout' };
    const probeLayout = { id: 'probe-layout' };
    const instanceBuffer = { id: 'instance-128b' };
    const probeBuffer = { id: 'probe-160b' };
    const groups: Array<{ layout: object; entries: readonly unknown[] }> = [];
    const context = {
      runtime: {
        device: {
          createBindGroup: (input: { layout: object; entries: readonly unknown[] }) => {
            groups.push(input);
            return { ok: true, value: { id: groups.length } };
          },
        },
      },
      pipelineState: {
        instancesBindGroupLayout: noProbeLayout,
        probeInstancesBindGroupLayout: probeLayout,
      },
      frameState: { instancesBgShared: new WeakMap<object, unknown>() },
      bindGroupCounts: { createBindGroup: 0, keys: [] },
    } as never;

    resolveGeometryInstancesBindGroup(context, instanceBuffer as never);
    resolveGeometryInstancesBindGroup(context, instanceBuffer as never, probeBuffer as never);
    expect(groups[0]).toMatchObject({ layout: noProbeLayout, entries: [{ binding: 0 }] });
    expect(groups[0]?.entries).toHaveLength(1);
    expect(groups[1]).toMatchObject({
      layout: probeLayout,
      entries: [{ binding: 0 }, { binding: 1 }],
    });
    expect(groups[1]?.entries).toHaveLength(2);
    expect(groups[1]?.entries[1]).toMatchObject({
      binding: 1,
      resource: { value: { buffer: probeBuffer, offset: 0, size: 160 } },
    });
  });

  it('does not allocate a probe sentinel for a no-probe frame', () => {
    const creates: unknown[] = [];
    const context = {
      runtime: {
        device: {
          caps: { storageBuffer: true },
          createBuffer: (descriptor: unknown) => {
            creates.push(descriptor);
            return { ok: true, value: {} };
          },
        },
      },
      frameState: { probeBlendRecordBufferCapacity: 0, probeBlendBuffers: new Map() },
    } as never;
    expect(() => resolveProbeBlendBuffer(context, undefined)).toThrow(
      'probe blend record is required for probe allocation',
    );
    expect(creates).toHaveLength(0);
  });

  it('maps the retained RenderScene slot to a distinct aligned record lane', () => {
    expect(probeBlendRecordOffset(0)).toBe(PROBE_BLEND_RECORD_STRIDE);
    expect(probeBlendRecordOffset(7)).toBe(8 * PROBE_BLEND_RECORD_STRIDE);
    expect(() => probeBlendRecordOffset(-1)).toThrow();
  });

  it('reuploads after backing-buffer growth or recovery instead of trusting stale cache bytes', () => {
    let nextBuffer = 0;
    const writes: Array<{ buffer: object; offset: number; bytes: Uint8Array }> = [];
    const device = {
      caps: { storageBuffer: true },
      createBuffer: () => ({ ok: true, value: { id: ++nextBuffer } }),
      queue: {
        writeBuffer: (buffer: object, offset: number, bytes: Uint8Array) => {
          writes.push({ buffer, offset, bytes: new Uint8Array(bytes) });
          return { ok: true };
        },
      },
    };
    const frameState: {
      probeBlendBuffers: Map<number, { generation: number; bytes: Uint8Array }>;
      probeBlendRecordBuffer?: object;
      probeBlendRecordBufferCapacity: number;
    } = {
      probeBlendBuffers: new Map(),
      probeBlendRecordBufferCapacity: 0,
    };
    const context = { runtime: { device }, frameState } as never;
    const record: ProbeBlendRecord = {
      objectKey: 0,
      generation: 1,
      localBlendFraction: 0,
      shPreblend: [],
      bytes: new Uint8Array(160).fill(7),
      byteLength: 160,
      candidate: true,
      accepted: true,
      lastKnownGood: true,
    };

    const first = resolveProbeBlendBuffer(context, record, 11);
    resolveProbeBlendBuffer(context, record, 11);
    expect(writes).toHaveLength(1);
    expect(first.offset).toBe(PROBE_BLEND_RECORD_STRIDE);

    const grown: ProbeBlendRecord = { ...record, objectKey: 4 };
    resolveProbeBlendBuffer(context, grown, 12);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.offset).toBe(5 * PROBE_BLEND_RECORD_STRIDE);

    delete frameState.probeBlendRecordBuffer;
    frameState.probeBlendRecordBufferCapacity = 0;
    resolveProbeBlendBuffer(context, record, 11);
    expect(writes).toHaveLength(3);
    expect(writes[2]?.offset).toBe(PROBE_BLEND_RECORD_STRIDE);
  });
});
