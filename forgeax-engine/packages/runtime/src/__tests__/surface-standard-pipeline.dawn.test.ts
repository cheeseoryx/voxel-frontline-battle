import { execFileSync } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-types';
import {
  createStandaloneRuntimeAssetBinding,
  type RuntimeAssetBinding,
} from '@forgeax/engine-types';
import { createServer, loadConfigFromFile } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { createDevImportTransport } from '../dev-import-transport';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  assertMaterialPayload,
  assertSurfacePixelFalsification,
  parseSurfaceGuid,
  populateSurfaceWorld,
  SURFACE_CASES,
  SURFACE_CLOSURE,
  SURFACE_HEIGHT,
  SURFACE_WIDTH,
} from './surface-standard-pipeline.runtime-fixture';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const EVIDENCE_SOURCE_SHA = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: rootDir,
  encoding: 'utf8',
}).trim();
const EVIDENCE_BUILD_ID = `vitest-dawn-${EVIDENCE_SOURCE_SHA.slice(0, 12)}`;

async function loadPreviewConfig() {
  const previousSurfaceOnly = process.env.FORGEAX_SURFACE_ONLY;
  process.env.FORGEAX_SURFACE_ONLY = '1';
  try {
    const loaded = await loadConfigFromFile(
      { command: 'serve', mode: 'test', isSsrBuild: false, isPreview: false },
      resolve(rootDir, 'apps/preview/vite.config.ts'),
      rootDir,
    );
    if (loaded === null) throw new Error('surface-standard: Preview Vite config unavailable');
    return loaded.config;
  } finally {
    if (previousSurfaceOnly === undefined) delete process.env.FORGEAX_SURFACE_ONLY;
    else process.env.FORGEAX_SURFACE_ONLY = previousSurfaceOnly;
  }
}

async function allocateLoopbackPort(): Promise<number> {
  const probe = createTcpServer();
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error): void => {
        probe.off('listening', onListening);
        rejectListen(error);
      };
      const onListening = (): void => {
        probe.off('error', onError);
        resolveListen();
      };
      probe.once('error', onError);
      probe.once('listening', onListening);
      probe.listen(0, '127.0.0.1');
    });
    const address = probe.address();
    if (address === null || typeof address === 'string') {
      throw new Error('surface-standard: loopback port probe did not expose a TCP address');
    }
    expect(address.port).toBeGreaterThan(0);
    return address.port;
  } finally {
    if (probe.listening) {
      await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
    }
  }
}

const BYTES_PER_ROW = Math.ceil((SURFACE_WIDTH * 4) / 256) * 256;
const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;
const DAWN_TEARDOWN_TIMEOUT_MS = 60_000;

type DawnCanvas = HTMLCanvasElement & { target?: GPUTexture };

function absoluteBinding(binding: RuntimeAssetBinding, baseUrl: string): RuntimeAssetBinding {
  return {
    ...binding,
    catalogUrl: new URL(binding.catalogUrl, baseUrl).href,
    importUrlBase: new URL(binding.importUrlBase, baseUrl).href,
    packageUrlBase: new URL(binding.packageUrlBase, baseUrl).href,
  };
}

function createDawnCanvas(onDevice: (device: GPUDevice) => void): DawnCanvas {
  const canvas = {
    width: SURFACE_WIDTH,
    height: SURFACE_HEIGHT,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(descriptor: { device: GPUDevice; format?: GPUTextureFormat }) {
          onDevice(descriptor.device);
          canvas.target = descriptor.device.createTexture({
            size: { width: SURFACE_WIDTH, height: SURFACE_HEIGHT, depthOrArrayLayers: 1 },
            format: descriptor.format ?? 'rgba8unorm',
            usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
            viewFormats: ['rgba8unorm-srgb'],
          });
        },
        unconfigure() {},
        getCurrentTexture() {
          if (canvas.target === undefined)
            throw new Error('surface-standard: target not configured');
          return canvas.target;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as DawnCanvas;
  return canvas;
}

async function readPresentedPixels(device: GPUDevice, texture: GPUTexture): Promise<Uint8Array> {
  const buffer = device.createBuffer({
    size: BYTES_PER_ROW * SURFACE_HEIGHT,
    usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow: BYTES_PER_ROW, rowsPerImage: SURFACE_HEIGHT },
    { width: SURFACE_WIDTH, height: SURFACE_HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await buffer.mapAsync(MAP_MODE_READ);
  const pixels = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  return pixels;
}

function samplePresentedPixel(
  pixels: Uint8Array,
  index: number,
): readonly [number, number, number, number] {
  const x = Math.min(
    SURFACE_WIDTH - 1,
    Math.max(0, Math.floor(((index + 0.5) * SURFACE_WIDTH) / SURFACE_CASES.length)),
  );
  const offset = Math.floor(SURFACE_HEIGHT / 2) * BYTES_PER_ROW + x * 4;
  return [
    pixels[offset] ?? 0,
    pixels[offset + 1] ?? 0,
    pixels[offset + 2] ?? 0,
    pixels[offset + 3] ?? 0,
  ];
}

describe('Standard Surface runtime Dawn publication', () => {
  let renderer: Renderer | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let canvas: DawnCanvas | undefined;
  let device: GPUDevice | undefined;

  afterEach(async () => {
    await renderer?.dispose();
    if (canvas?.target !== undefined) canvas.target.destroy();
    device?.destroy();
    await server?.close();
    renderer = undefined;
    canvas = undefined;
    device = undefined;
    server = undefined;
  }, DAWN_TEARDOWN_TIMEOUT_MS);

  it('publishes and renders the same four cooked GUIDs through Dawn Runtime Renderer', async () => {
    const binding = createStandaloneRuntimeAssetBinding('preview');
    const previewInlineConfig = await loadPreviewConfig();
    const previewServer = {
      host: '127.0.0.1',
      port: await allocateLoopbackPort(),
      strictPort: true,
      ...(previewInlineConfig.server?.fs === undefined
        ? {}
        : { fs: previewInlineConfig.server.fs }),
    };
    server = await createServer({
      ...previewInlineConfig,
      configFile: false,
      root: resolve(rootDir, 'apps/preview'),
      logLevel: 'error',
      server: previewServer,
    });
    await server.listen();
    const baseUrl = server.resolvedUrls?.local[0];
    if (baseUrl === undefined)
      throw new Error('surface-standard: Dawn publication server URL unavailable');
    const liveBinding = absoluteBinding(binding, baseUrl);
    const shaderManifestUrl = new URL('shaders/manifest.json', baseUrl).href;
    canvas = createDawnCanvas((created) => {
      device ??= created;
    });
    const constructed = await constructRuntimeRendererHost(
      canvas,
      {},
      {
        shaderManifestUrl,
        importTransport: createDevImportTransport(liveBinding),
      },
    );
    expect(constructed.ok).toBe(true);
    if (!constructed.ok) throw constructed.error;
    renderer = constructed.value.renderer;
    const assets = constructed.value.assets;
    assets.configureRuntimeBinding(liveBinding);
    const catalogDeadline = Date.now() + 180_000;
    while (!(await assets.refreshCatalog())) {
      if (Date.now() >= catalogDeadline) {
        throw new Error(
          `surface-standard: timed out waiting for catalog ${liveBinding.catalogUrl}`,
        );
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
    }
    const catalog = assets.listCatalog();
    const materials: MaterialAsset[] = [];
    const publications = [];
    for (const surfaceCase of SURFACE_CASES) {
      const row = catalog.find((entry) => entry.guid.toLowerCase() === surfaceCase.guid);
      expect(row?.sourceKey).toBe(surfaceCase.sourceKey);
      expect(row?.packageUrl).toMatch(/^http/);
      const publicationResponse = await fetch(row?.packageUrl ?? '');
      expect(publicationResponse.ok).toBe(true);
      const publication = (await publicationResponse.json()) as {
        generation?: unknown;
        digest?: unknown;
      };
      expect(Number.isSafeInteger(publication.generation)).toBe(true);
      expect(typeof publication.digest).toBe('string');
      const loaded = await assets.loadByGuid<MaterialAsset>(parseSurfaceGuid(surfaceCase.guid));
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) throw loaded.error;
      const material = assertMaterialPayload(surfaceCase, loaded.value);
      materials.push(material);
      publications.push({ surfaceCase, row, publication, material });
    }
    const world = new World();
    populateSurfaceWorld(world, materials);
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) throw attached.error;
    // Standard material pipelines are compiled lazily on first use. Submit
    // enough frames for the authored Surface artifacts to publish their PSOs
    // before taking the Dawn readback, matching the browser evidence lane.
    for (let frame = 0; frame < 6; frame += 1) {
      world.update(1 / 60).unwrap();
      const drawn = renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      });
      expect(drawn.ok).toBe(true);
      if (!drawn.ok) throw drawn.error;
      const completion = await drawn.value.completed;
      expect(completion.ok).toBe(true);
      if (!completion.ok) throw completion.error;
    }
    if (device === undefined || canvas.target === undefined)
      throw new Error('surface-standard: Dawn target unavailable');
    const pixels = await readPresentedPixels(device, canvas.target);
    const observed = renderer.inspect();
    expect(observed.perFramePassNames.some((name) => name.toLowerCase().includes('shadow'))).toBe(
      true,
    );
    expect(observed.perFramePassNames).toContain('main');
    const records = publications.map(({ surfaceCase, row, publication, material }, index) => {
      const samples = samplePresentedPixel(pixels, index);
      const program = material.passes?.[0]?.program;
      expect(samples[3]).toBe(255);
      expect(samples[0] + samples[1] + samples[2]).toBeGreaterThan(0);
      return {
        id: surfaceCase.id,
        materialGuid: surfaceCase.guid,
        sourceKey: row?.sourceKey,
        publicationGeneration: publication.generation,
        publicationDigest: publication.digest,
        closure: SURFACE_CLOSURE,
        rootPlan: surfaceCase.rootPlan,
        pass: surfaceCase.pass,
        actualPasses: material.passes?.map((entry) => entry.name),
        selectedEntries: material.passes?.map((entry) => ({
          name: entry.name,
          fragmentEntry: entry.program.fragmentEntry,
          lightMode: (entry.renderState?.tags as Record<string, string> | undefined)?.LightMode,
        })),
        cookIdentity: publication.digest,
        programIdentity: program?.module ?? 'unavailable',
        pipelineIdentity: `${surfaceCase.pass}:${surfaceCase.rootPlan}:${program?.module ?? 'unavailable'}`,
        sourceClosure: surfaceCase.sourceClosure,
        backend: 'dawn-native',
        backendKind: observed.capabilities.backendKind,
        frameId: observed.observation.frameId,
        samples,
        artifact: row?.packageUrl,
        provenance: {
          sourceSha: EVIDENCE_SOURCE_SHA,
          buildId: EVIDENCE_BUILD_ID,
          frameId: observed.observation.frameId,
          artifact: row?.packageUrl,
          readbackKind: 'gpu-texture-copy',
          readbackFormat: 'rgba8unorm',
          readbackWidth: SURFACE_WIDTH,
          readbackHeight: SURFACE_HEIGHT,
          clearColor: [0, 0, 0, 1],
          closure: SURFACE_CLOSURE,
          rootPlan: surfaceCase.rootPlan,
          pass: surfaceCase.pass,
          actualPasses: material.passes?.map((entry) => entry.name),
          selectedEntries: material.passes?.map((entry) => ({
            name: entry.name,
            fragmentEntry: entry.program.fragmentEntry,
            lightMode: (entry.renderState?.tags as Record<string, string> | undefined)?.LightMode,
          })),
          cookIdentity: publication.digest,
          programIdentity: program?.module ?? 'unavailable',
          pipelineIdentity: `${surfaceCase.pass}:${surfaceCase.rootPlan}:${program?.module ?? 'unavailable'}`,
          sourceClosure: surfaceCase.sourceClosure,
          lane: 'dawn-native',
        },
      };
    });
    assertSurfacePixelFalsification(records);
    expect(new Set(records.map((record) => record.materialGuid))).toHaveLength(4);
    expect(records.every((record) => record.backend === 'dawn-native')).toBe(true);
    expect(records.every((record) => record.backendKind === 'webgpu')).toBe(true);
    // biome-ignore lint/suspicious/noConsole: runtime provenance is the test artifact.
    console.log(JSON.stringify({ backend: 'dawn-native', lane: 'runtime', records }));
  }, 120000);
});
