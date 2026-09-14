// @perf-budget-skip: intentional real file:// browser integration gate covering the full runtime closure.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { DistManifest } from '../dist.js';
import { bundleSingleHtmlEntry, writeSingleHtml } from '../single-html.js';

const MINIMAL_WASM = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);

function browserExecutable(): string | undefined {
  const candidates = [
    process.env.FORGEAX_BROWSER_EXECUTABLE,
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/opt/google/chrome-beta/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    typeof chromium.executablePath === 'function' ? chromium.executablePath() : undefined,
  ];
  return candidates.find(
    (candidate): candidate is string => candidate !== undefined && existsSync(candidate),
  );
}

describe('single HTML runtime closure', () => {
  it('runs dynamic import, module worker, nested worker, WASM, JSON, and WGSL from file://', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-single-html-runtime-e2e-'));
    const dist = resolve(root, 'dist');
    const output = resolve(root, 'release', 'runtime.html');
    await mkdir(resolve(dist, 'assets'), { recursive: true });
    try {
      await Promise.all([
        writeFile(
          resolve(dist, 'index.html'),
          '<!doctype html><html data-preserve="a > b"><head><link rel="modulepreload" href="./main.js"><style>.fixture{color:red}</style></head><body><canvas id="canvas" width="64" height="64"></canvas><script type="module" src="./main.js"></script></body></html>',
        ),
        writeFile(
          resolve(dist, 'main.js'),
          `const lazy = await import('./lazy.js');
const canvas = document.querySelector('#canvas');
const context = canvas.getContext('2d');
context.fillStyle = '#14283d'; context.fillRect(0, 0, 64, 64);
context.fillStyle = '#f4c542'; context.fillRect(8, 8, 48, 48);
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.onmessage = (event) => {
  if (event.data?.kind !== 'worker-ready') return;
  document.documentElement.dataset.workerReady = JSON.stringify(event.data);
  document.documentElement.dataset.forgeaxFrameSubmitted = '1';
};
worker.postMessage({ run: true });
document.documentElement.dataset.lazyValue = String(lazy.value);
document.documentElement.dataset.forgeaxGameReady = 'true';
document.documentElement.dataset.forgeaxFrameSubmitted = '1';
`,
        ),
        writeFile(resolve(dist, 'lazy.js'), 'export const value = 42;\n'),
        writeFile(
          resolve(dist, 'worker.js'),
          `self.onmessage = async () => {
  const data = await fetch(new URL('./data.json', import.meta.url)).then((response) => response.json());
  const shader = await fetch(new URL('./shader.wgsl', import.meta.url)).then((response) => response.text());
  const wasm = await WebAssembly.instantiate(await fetch(new URL('./sample.wasm', import.meta.url)).then((response) => response.arrayBuffer()));
  const nested = new Worker(new URL('./nested-worker.js', import.meta.url), { type: 'module' });
  nested.onmessage = (event) => postMessage({ kind: 'worker-ready', data: data.value, shader: shader.trim(), wasm: Object.keys(wasm.instance.exports).length, nested: event.data.value });
  nested.postMessage({ run: true });
};
`,
        ),
        writeFile(
          resolve(dist, 'nested-worker.js'),
          `self.onmessage = async () => {
  const data = await fetch(new URL('./data.json', import.meta.url)).then((response) => response.json());
  postMessage({ value: data.value });
};
`,
        ),
        writeFile(resolve(dist, 'data.json'), '{"value":"pack-ready"}\n'),
        writeFile(
          resolve(dist, 'shader.wgsl'),
          '@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }\n',
        ),
        writeFile(resolve(dist, 'sample.wasm'), MINIMAL_WASM),
        writeFile(resolve(dist, 'forgeax-dist.json'), '{}\n'),
      ]);
      const artifacts: DistManifest['artifacts'] = [
        { path: 'main.js', mediaType: 'text/javascript', bytes: 0, sha256: '' },
        { path: 'lazy.js', mediaType: 'text/javascript', bytes: 0, sha256: '' },
        { path: 'worker.js', mediaType: 'text/javascript', bytes: 0, sha256: '' },
        { path: 'nested-worker.js', mediaType: 'text/javascript', bytes: 0, sha256: '' },
        { path: 'data.json', mediaType: 'application/json', bytes: 0, sha256: '' },
        { path: 'shader.wgsl', mediaType: 'text/plain', bytes: 0, sha256: '' },
        {
          path: 'sample.wasm',
          mediaType: 'application/wasm',
          bytes: MINIMAL_WASM.byteLength,
          sha256: '',
        },
      ];
      const manifest: DistManifest = {
        schemaVersion: '1.0.0',
        project: { id: 'single-html-runtime-e2e', name: 'Single HTML Runtime E2E' },
        base: './',
        runtime: { packIndexUrl: 'data.json', shaderManifestUrl: 'shader.wgsl' },
        artifacts,
      };
      const indexHtml = await readFile(resolve(dist, 'index.html'), 'utf8');
      const bundle = await bundleSingleHtmlEntry(dist, indexHtml);
      expect(bundle.ok).toBe(true);
      if (!bundle.ok) return;
      const packaged = await writeSingleHtml({
        distRoot: dist,
        output,
        manifest,
        bundle: bundle.value,
      });
      expect(packaged.ok).toBe(true);
      if (!packaged.ok) return;

      const executablePath = browserExecutable();
      const browser = await chromium.launch({
        headless: true,
        ...(executablePath === undefined ? {} : { executablePath }),
        args: ['--force-color-profile=srgb', '--force-device-scale-factor=1'],
      });
      const page = await browser.newPage({
        serviceWorkers: 'block',
        viewport: { width: 640, height: 480 },
      });
      const requests: string[] = [];
      const failed: string[] = [];
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on('request', (request) => requests.push(request.url()));
      page.on('requestfailed', (request) =>
        failed.push(`${request.url()}: ${request.failure()?.errorText ?? 'failed'}`),
      );
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));
      try {
        await page.goto(pathToFileURL(output).href, { waitUntil: 'load', timeout: 120_000 });
        try {
          await page.waitForFunction(
            () => document.documentElement.dataset.workerReady !== undefined,
            undefined,
            { timeout: 15_000 },
          );
        } catch (cause) {
          const state = await page.evaluate(() => ({
            dataset: { ...document.documentElement.dataset },
            singleHtml: (
              globalThis as typeof globalThis & {
                __forgeaxSingleHtml?: { witness?: () => unknown };
              }
            ).__forgeaxSingleHtml?.witness?.(),
          }));
          throw new Error(
            `worker fixture did not become ready: ${cause instanceof Error ? cause.message : String(cause)}; state=${JSON.stringify(state)}; consoleErrors=${JSON.stringify(consoleErrors)}; pageErrors=${JSON.stringify(pageErrors)}`,
          );
        }
        const witness = await page.evaluate(() => ({
          lazy: document.documentElement.dataset.lazyValue,
          ready: document.documentElement.dataset.forgeaxSingleHtmlReady,
          gameReady: document.documentElement.dataset.forgeaxGameReady,
          worker: JSON.parse(document.documentElement.dataset.workerReady ?? '{}'),
          canvas: (() => {
            const canvas = document.querySelector('canvas');
            const context = canvas?.getContext('2d');
            const pixels =
              context?.getImageData(0, 0, canvas?.width ?? 0, canvas?.height ?? 0).data ??
              new Uint8ClampedArray();
            return {
              width: canvas?.width ?? 0,
              height: canvas?.height ?? 0,
              varying: new Set([...pixels].filter((_, index) => index % 4 !== 3)).size,
            };
          })(),
          singleHtml: (
            globalThis as typeof globalThis & {
              __forgeaxSingleHtml?: { witness?: () => Readonly<Record<string, unknown>> };
            }
          ).__forgeaxSingleHtml?.witness?.(),
        }));
        expect(witness.lazy).toBe('42');
        expect(witness.ready).toBe('true');
        expect(witness.gameReady).toBe('true');
        expect(witness.worker).toMatchObject({
          data: 'pack-ready',
          shader: expect.stringContaining('@fragment'),
          wasm: 0,
          nested: 'pack-ready',
        });
        expect(witness.canvas).toMatchObject({ width: 64, height: 64 });
        expect(witness.canvas.varying).toBeGreaterThan(2);
        expect(witness.singleHtml).toMatchObject({
          ready: true,
          resourceMisses: [],
          externalRequests: [],
        });
        expect(witness.singleHtml?.resourceHits).toBeGreaterThan(0);
        expect(requests.filter((url) => /^https?:/i.test(url))).toEqual([]);
        expect(failed).toEqual([]);
        expect(consoleErrors).toEqual([]);
        expect(requests).toEqual([pathToFileURL(output).href]);
      } finally {
        await page.close();
        await browser.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
