import { describe, expect, it, vi } from 'vitest';
import { startEngineWorker } from '../execution/engine-worker';
import type { EngineToHostMessage, HostToEngineMessage } from '../execution/protocol';

class PluginWorker {
  onmessage: ((event: MessageEvent<EngineToHostMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posts: Array<{
    readonly message: HostToEngineMessage;
    readonly transfer: readonly Transferable[];
  }> = [];
  readonly terminate = vi.fn();

  postMessage(message: HostToEngineMessage, transfer: Transferable[] = []): void {
    this.posts.push({ message, transfer });
    if (message.kind !== 'init') return;
    queueMicrotask(() => {
      this.onmessage?.({
        data: { kind: 'ready', worldIdentity: 'world-plugin', realm: 'worker', workerWebGpu: true },
      } as MessageEvent<EngineToHostMessage>);
    });
  }
}

describe('Engine Worker plugin realm', () => {
  it('transfers the engine catalog and waits for plugin readiness in the Worker realm', async () => {
    const worker = new PluginWorker();
    const offscreen = {} as OffscreenCanvas;
    const started = await startEngineWorker({
      canvas: {
        transferControlToOffscreen: vi.fn(() => offscreen),
      } as unknown as HTMLCanvasElement,
      bootstrapUrl: 'https://example.test/engine-worker.js',
      bootstrapData: { gameId: 'plugin-fixture' },
      assetCatalog: {
        url: '/__pack/scopes/plugin-fixture/3/catalog.json',
        expectedScope: { scopeId: 'plugin-fixture', generation: 3 },
      },
      pluginBootstrap: {
        realm: 'engine',
        catalogDigest: 'sha256:plugin-catalog',
        entries: [{ id: 'root', name: '@game/root', realm: 'engine' }],
      },
      timeoutMs: 100,
      tier: 'engine-worker',
      workerFactory: () => worker as unknown as Worker,
    });

    expect(started.ok).toBe(true);
    expect(worker.posts[0]?.message).toMatchObject({
      kind: 'init',
      pluginBootstrap: {
        realm: 'engine',
        catalogDigest: 'sha256:plugin-catalog',
        entries: [{ id: 'root', name: '@game/root', realm: 'engine' }],
      },
    });
    started.ok && started.value.dispose();
  });
});
