import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { attachRecorder, openReplay } from '../index';
import { decodeTape } from '../protocol/codec';

describe('RecorderSession real RHI consumer', () => {
  it('captures one steady frame into a strict v7 artifact', async () => {
    const attached = attachRecorder({ rhi, createShaderModule });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const adapter = await attached.value.backend.rhi.requestAdapter();
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) return;
    const device = await adapter.value.requestDevice();
    expect(device.ok).toBe(true);
    if (!device.ok) return;

    const capture = attached.value.captureFrame();
    expect((await attached.value.frameBoundary()).ok).toBe(true);
    expect((await attached.value.frameBoundary()).ok).toBe(true);
    const result = await capture;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decoded = decodeTape(result.value.bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.header.formatVersion).toBe(7);
    expect(decoded.value.header.eventCount).toBe(1);
    expect(decoded.value.events[0]?.kind).toBe('frameMark');
  });

  it('records the empty compute compound as exactly one existing begin/end pair', async () => {
    const attached = attachRecorder({ rhi, createShaderModule });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const adapter = await attached.value.backend.rhi.requestAdapter();
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) return;
    const device = await adapter.value.requestDevice();
    expect(device.ok).toBe(true);
    if (!device.ok) return;

    const capture = attached.value.captureFrame();
    expect((await attached.value.frameBoundary()).ok).toBe(true);
    const encoder = device.value.createCommandEncoder({}).unwrap();
    encoder.encodeEmptyComputePass({ label: 'timing-marker' });
    const commandBuffer = encoder.finish().unwrap();
    expect(device.value.queue.submit([commandBuffer]).ok).toBe(true);
    expect((await attached.value.frameBoundary()).ok).toBe(true);

    const result = await capture;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decoded = decodeTape(result.value.bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const passEvents = decoded.value.events.filter(
      (event) => event.kind === 'beginComputePass' || event.kind === 'endComputePass',
    );
    expect(passEvents).toHaveLength(2);
    expect(passEvents.map((event) => event.kind)).toEqual(['beginComputePass', 'endComputePass']);
    expect(decoded.value.events.map((event) => event.kind)).not.toContain('encodeEmptyComputePass');
    expect(passEvents[0]).toMatchObject({
      kind: 'beginComputePass',
      desc: { label: 'timing-marker' },
    });

    const replayAdapter = await rhi.requestAdapter();
    expect(replayAdapter.ok).toBe(true);
    if (!replayAdapter.ok) return;
    const replayDevice = await replayAdapter.value.requestDevice();
    expect(replayDevice.ok).toBe(true);
    if (!replayDevice.ok) return;
    const replayed = await openReplay(decoded.value, {
      device: replayDevice.value,
      createShaderModule,
    });
    expect(replayed.ok).toBe(true);
  });
});
