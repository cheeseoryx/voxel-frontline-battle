import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { createRenderTargetHost } from '../assembly/render-target-host';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const factorySourcePath = resolve(testDirectory, '../assembly/factory.ts');
const hostSourcePath = resolve(testDirectory, '../assembly/render-target-host.ts');
const renderGraphSourcePath = resolve(testDirectory, '../../../render-graph/src');

describe('RenderTarget owner placement', () => {
  it('places the lifecycle seam under the existing Renderer assembly owner', () => {
    expect(existsSync(hostSourcePath)).toBe(true);
    const factorySource = readFileSync(factorySourcePath, 'utf8');
    const hostSource = readFileSync(hostSourcePath, 'utf8');

    expect(factorySource).toContain('createRenderTargetHost()');
    expect(factorySource).toContain('const renderTargetHost =');
    expect(hostSource).toContain("owner: 'renderer'");
    expect(hostSource).not.toContain('@forgeax/engine-render-graph');
    expect(hostSource).toContain('@forgeax/engine-rhi');
    expect(hostSource).not.toContain('@forgeax/engine-assets-runtime');
    expect(existsSync(renderGraphSourcePath)).toBe(true);
  });

  it('keeps one frame submission and one recovery entrypoint', () => {
    const factorySource = readFileSync(factorySourcePath, 'utf8');
    const drawBoundary = factorySource.slice(
      factorySource.indexOf('drawFrame(request'),
      factorySource.indexOf('observe(', factorySource.indexOf('drawFrame(request')),
    );

    expect(drawBoundary.match(/^\s+const submitted = renderSystem\.draw\(/m)).not.toBeNull();
    expect(drawBoundary).toContain('renderTargetHost.beginFrame()');
    expect(drawBoundary).toContain('renderTargetHost.onFrameSubmitted(completed)');
    expect(factorySource.match(/recover\(\): Promise/g)).toHaveLength(1);
    expect(factorySource.match(/renderTargetHost\.recover\(\)/g)).toHaveLength(1);
  });

  it('keeps the off path free of target allocation and graph submission', () => {
    const factorySource = readFileSync(factorySourcePath, 'utf8');
    const hostSource = readFileSync(hostSourcePath, 'utf8');

    expect(factorySource).not.toContain('new RenderTarget');
    expect(factorySource).not.toContain('CubeCamera');
    expect(factorySource).not.toContain('ReflectionProbe');
    expect(hostSource).toContain('createTexture');
    expect(hostSource).toContain('RhiCommandEncoder');
    expect(hostSource).not.toMatch(/queue\.submit|finish\(/);
    expect(hostSource).not.toMatch(/RenderGraph|AssetRegistry/);
  });

  it('keeps host lifecycle calls idempotent after renderer disposal', () => {
    const host = createRenderTargetHost();

    expect(host.owner).toBe('renderer');
    host.beginFrame();
    host.onFrameSubmitted();
    host.recover();
    host.dispose();
    host.beginFrame();
    host.onFrameSubmitted();
    host.recover();
    host.dispose();
  });

  it('binds only the active physical view after the completion receipt settles', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const host = createRenderTargetHost({ getDevice: () => device });
    const targetResult = host.createRenderTarget({
      shape: 'cube',
      width: 2,
      height: 2,
      format: 'rgba8unorm',
      mipLevels: 1,
      sampleCount: 1,
      sampled: true,
      readback: false,
    });
    expect(targetResult.ok).toBe(true);
    if (!targetResult.ok) return;
    const sourceResult = host.createRenderTargetTextureSource(targetResult.value, {
      aspect: 'color',
      dimension: 'cube',
      mipLevel: 0,
    });
    expect(sourceResult.ok).toBe(true);
    if (!sourceResult.ok) return;
    const target = targetResult.value;
    const source = sourceResult.value;
    host.beginFrame();
    const before = host.resolveRenderTargetTextureSource(source);
    expect(before?.textureView).toBeUndefined();
    let resolveCompletion:
      | ((value: { readonly ok: true; readonly value: undefined }) => void)
      | undefined;
    const completion = new Promise<{ readonly ok: true; readonly value: undefined }>((resolve) => {
      resolveCompletion = resolve;
    });
    host.onFrameSubmitted(completion);
    resolveCompletion?.({ ok: true, value: undefined });
    await completion;
    await Promise.resolve();
    const after = host.resolveRenderTargetTextureSource(source);
    expect(after?.textureView).toBeDefined();
    host.dispose();
    expect(host.getPhysicalTarget(target)).toBeUndefined();
  });

  it('holds a progressive cube candidate until the renderer promotion gate opens', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    let canPromote = false;
    const host = createRenderTargetHost({
      getDevice: () => device,
      canPromoteTarget: () => canPromote,
    });
    const targetResult = host.createRenderTarget({
      shape: 'cube',
      width: 2,
      height: 2,
      format: 'rgba8unorm',
      mipLevels: 1,
      sampleCount: 1,
      sampled: true,
      readback: false,
    });
    expect(targetResult.ok).toBe(true);
    if (!targetResult.ok) return;
    const sourceResult = host.createRenderTargetTextureSource(targetResult.value, {
      aspect: 'color',
      dimension: 'cube',
      mipLevel: 0,
    });
    expect(sourceResult.ok).toBe(true);
    if (!sourceResult.ok) return;

    host.beginFrame();
    const completion = Promise.resolve({ ok: true, value: undefined } as const);
    host.onFrameSubmitted(completion);
    await completion;
    await Promise.resolve();
    expect(host.resolveRenderTargetTextureSource(sourceResult.value)?.textureView).toBeUndefined();

    canPromote = true;
    host.onFrameSubmitted(Promise.resolve({ ok: true, value: undefined } as const));
    await Promise.resolve();
    await Promise.resolve();
    expect(host.resolveRenderTargetTextureSource(sourceResult.value)?.textureView).toBeDefined();
    host.dispose();
  });

  it('retires physical generations and readback tickets across recovery', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    let generation = 0;
    const host = createRenderTargetHost({
      getDevice: () => device,
      getGeneration: () => generation,
    });
    const targetResult = host.createRenderTarget({
      shape: '2d',
      width: 2,
      height: 2,
      format: 'rgba8unorm',
      mipLevels: 1,
      sampleCount: 1,
      sampled: true,
      readback: true,
    });
    expect(targetResult.ok).toBe(true);
    if (!targetResult.ok) return;
    const target = targetResult.value;
    host.beginFrame();
    host.onFrameSubmitted();
    await Promise.resolve();
    expect(host.getPhysicalTarget(target)).toBeDefined();
    const ticket = host.requestTargetReadback(target, {
      mipLevel: 0,
    });
    expect(ticket.ok).toBe(true);

    generation = 1;
    host.recover();
    expect(host.getPhysicalTarget(target)).toBeUndefined();
    if (ticket.ok) {
      const stale = await host.observeTargetReadbacks({ frameId: 1, deviceGeneration: 0 }, [
        ticket.value,
      ]);
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.code).toBe('render-target-state-invalid');
    }

    host.beginFrame();
    host.onFrameSubmitted();
    await Promise.resolve();
    expect(host.getPhysicalTarget(target)).toBeDefined();
    host.dispose();
  });
});
