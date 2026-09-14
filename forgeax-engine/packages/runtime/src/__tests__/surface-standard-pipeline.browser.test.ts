import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createRuntimeAssetImportTransport, runtimeBinding } from 'virtual:forgeax/pack-runtime';
import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
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

const evidenceEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
const EVIDENCE_SOURCE_SHA = evidenceEnv?.VITE_FORGEAX_EVIDENCE_SOURCE_SHA ?? 'unavailable';
const EVIDENCE_BUILD_ID = evidenceEnv?.VITE_FORGEAX_EVIDENCE_BUILD_ID ?? 'unavailable';

type SurfaceReadback = {
  pixels: Uint8Array;
  width: number;
  height: number;
  bytesPerRow: number;
  format: string;
};

async function readScreenshotPixels(canvas: HTMLCanvasElement): Promise<{
  pixels: Uint8Array;
  width: number;
  height: number;
  bytesPerRow: number;
  format: string;
}> {
  let latest: Uint8Array | undefined;
  let width = canvas.width;
  let height = canvas.height;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const shot = await page.elementLocator(canvas).screenshot({ base64: true, save: false });
    const b64 = typeof shot === 'string' ? shot : shot.base64;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    width = bitmap.width;
    height = bitmap.height;
    const offscreen = new OffscreenCanvas(width, height);
    const context = offscreen.getContext('2d', { willReadFrequently: true });
    if (context === null) {
      bitmap.close();
      throw new Error('surface-standard: OffscreenCanvas 2D context unavailable for screenshot');
    }
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, width, height);
    bitmap.close();
    latest = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    if (latest.some((value, index) => index % 4 !== 3 && value !== 0)) break;
  }
  return {
    pixels: latest ?? new Uint8Array(width * height * 4),
    width,
    height,
    bytesPerRow: width * 4,
    format: 'rgba8unorm',
  };
}

function hasPixelSignal(readback: SurfaceReadback): boolean {
  for (let offset = 0; offset < readback.pixels.length; offset += 4) {
    if (
      (readback.pixels[offset] ?? 0) !== 0 ||
      (readback.pixels[offset + 1] ?? 0) !== 0 ||
      (readback.pixels[offset + 2] ?? 0) !== 0
    ) {
      return true;
    }
  }
  return false;
}

function samplePresentedPixel(
  readback: SurfaceReadback,
  index: number,
): readonly [number, number, number, number] {
  const startX = Math.floor((index * readback.width) / SURFACE_CASES.length);
  const endX = Math.floor(((index + 1) * readback.width) / SURFACE_CASES.length);
  const candidates: Array<readonly [number, number, number, number]> = [];
  for (let y = 0; y < readback.height; y += 8) {
    for (let x = startX; x < endX; x += 8) {
      const offset = y * readback.bytesPerRow + x * 4;
      const raw = [
        readback.pixels[offset] ?? 0,
        readback.pixels[offset + 1] ?? 0,
        readback.pixels[offset + 2] ?? 0,
        readback.pixels[offset + 3] ?? 0,
      ] as const;
      const rgb = readback.format.startsWith('bgra') ? [raw[2], raw[1], raw[0]] : raw;
      const brightness = rgb[0] + rgb[1] + rgb[2];
      // The screenshot fallback is composited over a white page. Sample the
      // median lit/non-white texel in each cell so a center point landing on
      // that compositor background cannot hide a real Surface difference.
      if (brightness > 0 && brightness < 750) {
        candidates.push([rgb[0], rgb[1], rgb[2], raw[3]]);
      }
    }
  }
  candidates.sort((left, right) => left[0] + left[1] + left[2] - (right[0] + right[1] + right[2]));
  const selected = candidates[Math.floor(candidates.length / 2)];
  if (selected !== undefined) return selected;
  const x = Math.min(
    readback.width - 1,
    Math.max(0, Math.floor(((index + 0.5) * readback.width) / SURFACE_CASES.length)),
  );
  const offset = Math.floor(readback.height / 2) * readback.bytesPerRow + x * 4;
  const raw = [
    readback.pixels[offset] ?? 0,
    readback.pixels[offset + 1] ?? 0,
    readback.pixels[offset + 2] ?? 0,
    readback.pixels[offset + 3] ?? 0,
  ] as const;
  return readback.format.startsWith('bgra') ? [raw[2], raw[1], raw[0], raw[3]] : raw;
}

async function refreshSurfaceCatalog(
  assets: { refreshCatalog(): Promise<boolean>; listCatalog(): readonly unknown[] },
  expectedGuids: readonly string[],
): Promise<readonly unknown[]> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await assets.refreshCatalog();
    const catalog = assets.listCatalog();
    const observed = new Set(
      catalog
        .filter((entry): entry is { guid: string } => {
          return (
            typeof entry === 'object' &&
            entry !== null &&
            'guid' in entry &&
            typeof entry.guid === 'string'
          );
        })
        .map((entry) => entry.guid.toLowerCase()),
    );
    if (expectedGuids.every((guid) => observed.has(guid.toLowerCase()))) return catalog;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return assets.listCatalog();
}

describe('Standard Surface runtime Browser WebGPU provenance', () => {
  let renderer: Renderer | undefined;
  let canvas: HTMLCanvasElement | undefined;

  afterEach(async () => {
    await renderer?.dispose();
    canvas?.remove();
    renderer = undefined;
    canvas = undefined;
  });

  it('loads one published tuple per GUID and renders every cell through Runtime Renderer', {
    timeout: 120_000,
  }, async () => {
    if (runtimeBinding === undefined) {
      throw new Error('surface-standard: Pack runtime binding unavailable in Browser Vitest');
    }
    canvas = document.createElement('canvas');
    canvas.id = 'surface-standard-pipeline-test-canvas';
    canvas.width = SURFACE_WIDTH;
    canvas.height = SURFACE_HEIGHT;
    // Keep the full four-cell evidence surface inside the Browser Vitest
    // viewport. Playwright clips an oversized element screenshot to the
    // available viewport, which would otherwise turn the right two cells into
    // compositor-white pixels instead of a real Surface observation.
    const displayWidth = Math.min(SURFACE_WIDTH, Math.max(320, window.innerWidth - 32));
    const displayHeight = Math.round((displayWidth * SURFACE_HEIGHT) / SURFACE_WIDTH);
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;
    document.body.append(canvas);
    const webgpuContext = canvas.getContext('webgpu');
    if (webgpuContext === null) {
      throw new Error('surface-standard: WebGPU canvas context unavailable');
    }
    const bundler = forgeaxBundlerAdapter();
    const constructed = await constructRuntimeRendererHost(
      canvas,
      {},
      {
        ...bundler,
        importTransport: createRuntimeAssetImportTransport(runtimeBinding),
      },
    );
    expect(constructed.ok).toBe(true);
    if (!constructed.ok) throw constructed.error;
    const runtimeHost = constructed.value;
    renderer = runtimeHost.renderer;
    const assets = runtimeHost.assets;
    assets.configureRuntimeBinding(runtimeBinding);
    const catalog = (await refreshSurfaceCatalog(
      assets,
      SURFACE_CASES.map((surfaceCase) => surfaceCase.guid),
    )) as readonly {
      guid: string;
      sourceKey?: string;
      packageUrl?: string;
    }[];
    const seenGuids = new Set<string>();
    const materials: MaterialAsset[] = [];
    const publications = [];
    for (const surfaceCase of SURFACE_CASES) {
      const row = catalog.find((entry) => entry.guid.toLowerCase() === surfaceCase.guid);
      expect(row?.sourceKey).toBe(surfaceCase.sourceKey);
      expect(row?.packageUrl).toBeTruthy();
      const packageResponse = await fetch(row?.packageUrl ?? '');
      expect(packageResponse.ok).toBe(true);
      const packageBody = await packageResponse.json();
      const publication = packageBody as {
        generation?: unknown;
        digest?: unknown;
      };
      expect(Number.isSafeInteger(publication.generation)).toBe(true);
      expect(typeof publication.digest).toBe('string');
      const loaded = await assets.loadByGuid<MaterialAsset>(parseSurfaceGuid(surfaceCase.guid));
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) throw loaded.error;
      const material = assertMaterialPayload(surfaceCase, loaded.value);
      const projection = assets.getMaterialProjectionForPayload(material);
      if (surfaceCase.id.startsWith('custom-')) {
        expect(projection?.specializationKey).toBeTruthy();
        const programKeys =
          projection?.passes.flatMap((pass) =>
            pass.programs.map((program) => program.specializationKey),
          ) ?? [];
        expect(programKeys.length).toBeGreaterThan(0);
        for (const specializationKey of new Set(programKeys)) {
          expect(assets.getMaterialArtifact(specializationKey)).toBeDefined();
        }
      }
      materials.push(material);
      publications.push({ surfaceCase, row, publication, material });
      seenGuids.add(surfaceCase.guid);
    }
    const world = new World();
    populateSurfaceWorld(world, materials);
    const renderErrors: Array<{ code: string; detail?: unknown; hint?: string }> = [];
    const unsubscribeRenderErrors = renderer.subscribe((event) => {
      if (event.kind === 'error') {
        renderErrors.push({
          code: event.error.code,
          detail: event.error.detail,
          hint: event.error.hint,
        });
      }
    });
    const attached = renderer?.attach(world);
    if (attached === undefined) throw new Error('surface-standard: renderer unavailable');
    expect(attached.ok).toBe(true);
    if (!attached.ok) throw attached.error;
    // Standard material pipelines are compiled lazily on their first use. Keep
    // submitting frames until the renderer has had a chance to publish the
    // ready PSOs before inspecting the presented surface.
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
    const observed = renderer.inspect();
    expect(renderErrors).toHaveLength(0);
    expect(observed.perFramePassNames.some((name) => name.toLowerCase().includes('shadow'))).toBe(
      true,
    );
    expect(observed.perFramePassNames).toContain('main');
    const screenshotReadback = await readScreenshotPixels(canvas);
    expect(hasPixelSignal(screenshotReadback)).toBe(true);
    const readback = screenshotReadback;
    const records = publications.map(({ surfaceCase, row, publication, material }, index) => {
      const samples = samplePresentedPixel(readback, index);
      const program = material.passes?.[0]?.program;
      expect(samples[3]).toBeGreaterThan(0);
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
        samples,
        frameId: observed.observation.frameId,
        backend: observed.capabilities.backendKind,
        artifact: row?.packageUrl,
        provenance: {
          sourceSha: EVIDENCE_SOURCE_SHA,
          buildId: EVIDENCE_BUILD_ID,
          frameId: observed.observation.frameId,
          artifact: row?.packageUrl,
          readbackKind: 'compositor-screenshot',
          readbackFormat: readback.format,
          readbackWidth: readback.width,
          readbackHeight: readback.height,
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
          lane: 'browser-webgpu',
        },
      };
    });
    expect(seenGuids).toHaveLength(4);
    expect(records).toHaveLength(4);
    assertSurfacePixelFalsification(records);
    expect(records.every((record) => record.backend === 'webgpu')).toBe(true);
    // biome-ignore lint/suspicious/noConsole: runtime provenance is the test artifact.
    console.log(JSON.stringify({ backend: 'browser-webgpu', lane: 'runtime', records }));
    unsubscribeRenderErrors();
  });
});
