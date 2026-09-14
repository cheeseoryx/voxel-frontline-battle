import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertNoRetiredPackageFiles,
  mapConcurrent,
  normalizeLicenseReport,
  normalizePackageArchive,
  normalizePnpmStore,
  prepareWasmPackageForPack,
  waitForNpmPublications,
} from '../sdk-lib.mjs';

it('mapConcurrent bounds work while preserving input order', async () => {
  let active = 0;
  let highWater = 0;
  const values = await mapConcurrent(
    [1, 2, 3, 4, 5],
    async (value) => {
      active += 1;
      highWater = Math.max(highWater, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return value * 2;
    },
    2,
  );

  expect(values).toEqual([2, 4, 6, 8, 10]);
  expect(highWater).toBe(2);
});

it('normalizes workspace-specific license report paths', () => {
  const root = '/runner/work/forgeax-engine/forgeax-engine';
  expect(
    normalizeLicenseReport(
      {
        MIT: [
          {
            name: 'example',
            paths: [`${root}/node_modules/.pnpm/example@1.0.0/node_modules/example`],
          },
        ],
      },
      root,
    ),
  ).toEqual({
    MIT: [
      {
        name: 'example',
        paths: ['node_modules/.pnpm/example@1.0.0/node_modules/example'],
      },
    ],
  });
  expect(() => normalizeLicenseReport({ paths: ['/other/example'] }, root)).toThrow(
    'sdk-license-path-outside-workspace',
  );
});

it('stages a self-contained WASM package for npm pack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-wasm-stage-test-'));
  tempRoots.push(root);
  const packageRoot = join(root, 'package');
  await mkdir(join(packageRoot, 'scripts'), { recursive: true });
  await mkdir(join(packageRoot, 'pkg'), { recursive: true });
  await writeFile(join(packageRoot, '.gitignore'), 'pkg\n');
  await writeFile(join(packageRoot, '.npmignore'), 'src\n');
  await writeFile(
    join(packageRoot, 'scripts', 'ensure-wasm.mjs'),
    "import '../../../scripts/lib/ensure-wasm-lib.mjs';\n",
  );
  await writeFile(join(packageRoot, 'pkg', 'module.wasm'), 'wasm\n');
  const helperSource = join(root, 'ensure-wasm-lib.mjs');
  await writeFile(helperSource, 'export const ready = true;\n');

  const staged = await prepareWasmPackageForPack({
    packageRoot,
    helperSource,
    postinstallScripts: ['scripts/ensure-wasm.mjs'],
    wasmFiles: ['pkg/module.wasm'],
  });
  tempRoots.push(staged.root);

  await expect(readFile(join(staged.packageRoot, '.gitignore'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(readFile(join(staged.packageRoot, '.npmignore'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(
    readFile(join(staged.packageRoot, 'scripts', 'ensure-wasm.mjs'), 'utf8'),
  ).resolves.toBe("import './ensure-wasm-lib.mjs';\n");
  await expect(
    readFile(join(staged.packageRoot, 'scripts', 'ensure-wasm-lib.mjs'), 'utf8'),
  ).resolves.toBe('export const ready = true;\n');
  await expect(readFile(join(staged.packageRoot, 'pkg', 'module.wasm'), 'utf8')).resolves.toBe(
    'wasm\n',
  );
});

const tempRoots = [];
const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), '../../..');

async function writeIndex(name, value) {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-lib-'));
  tempRoots.push(root);
  const indexRoot = join(root, 'v11', 'index', 'aa');
  await mkdir(indexRoot, { recursive: true });
  const path = join(indexRoot, name);
  await writeFile(path, JSON.stringify(value));
  return { root, path };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('normalizePnpmStore', () => {
  it('removes empty sideEffects metadata whose deps key is not reproducible', async () => {
    const { root, path } = await writeIndex('empty.json', {
      checkedAt: 123,
      name: '@forgeax/engine-fbx',
      sideEffects: { 'darwin;arm64;node26;deps=volatile': {} },
    });

    await normalizePnpmStore(root);

    await expect(readFile(path, 'utf8')).resolves.toBe(
      '{"checkedAt":0,"name":"@forgeax/engine-fbx"}\n',
    );
  });

  it('keeps sideEffects metadata when it carries installed files', async () => {
    const { root, path } = await writeIndex('non-empty.json', {
      name: 'esbuild',
      sideEffects: {
        'darwin;arm64;node26;deps=stable': {
          added: { 'bin/esbuild': { checkedAt: 123, mode: 493 } },
        },
      },
    });

    await normalizePnpmStore(root);

    await expect(readFile(path, 'utf8')).resolves.toBe(
      '{"name":"esbuild","sideEffects":{"darwin;arm64;node26;deps=stable":{"added":{"bin/esbuild":{"checkedAt":0,"mode":493}}}}}\n',
    );
  });
});

describe('normalizePackageArchive', () => {
  it('projects one release version into package identity and internal dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-package-test-'));
    tempRoots.push(root);
    await mkdir(join(root, 'package'));
    await writeFile(
      join(root, 'package', 'package.json'),
      `${JSON.stringify({
        name: '@forgeax/engine-example',
        version: '0.0.0',
        dependencies: { '@forgeax/engine-types': '0.0.0', zod: '4.3.6' },
      })}\n`,
    );
    const archive = join(root, 'example.tgz');
    await execFileAsync('tar', ['-czf', archive, '-C', root, 'package']);

    await normalizePackageArchive(archive, execFileAsync, { releaseVersion: '1.2.3' });

    const { stdout } = await execFileAsync('tar', ['-xOf', archive, 'package/package.json']);
    expect(JSON.parse(stdout)).toMatchObject({
      version: '1.2.3',
      dependencies: { '@forgeax/engine-types': '1.2.3', zod: '4.3.6' },
    });
  });

  it('does not publish TypeScript incremental build caches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-package-cache-test-'));
    tempRoots.push(root);
    await mkdir(join(root, 'package', 'dist'), { recursive: true });
    await writeFile(
      join(root, 'package', 'package.json'),
      '{"name":"@forgeax/engine-example","version":"0.0.0"}\n',
    );
    await writeFile(join(root, 'package', 'dist', 'index.mjs'), 'export {}\n');
    await writeFile(join(root, 'package', 'dist', '.tsbuildinfo'), '{"version":"local"}\n');
    const archive = join(root, 'example.tgz');
    await execFileAsync('tar', ['-czf', archive, '-C', root, 'package']);

    await normalizePackageArchive(archive, execFileAsync);

    const { stdout } = await execFileAsync('tar', ['-tzf', archive]);
    expect(stdout).toContain('package/dist/index.mjs');
    expect(stdout).not.toContain('package/dist/.tsbuildinfo');
  });

  it('preserves a pnpm content-addressed path that needs a PAX header', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-package-pax-test-'));
    tempRoots.push(root);
    await mkdir(join(root, 'package'));
    await writeFile(
      join(root, 'package', 'package.json'),
      '{"name":"@forgeax/engine-sdk","version":"1.2.3"}\n',
    );
    const hash = 'a'.repeat(128);
    const content = join(root, 'package', 'sdk', 'store', 'pnpm', 'v11', 'files', '00', hash);
    await mkdir(join(content, '..'), { recursive: true });
    await writeFile(content, 'content\n');
    const archive = join(root, 'sdk.tgz');
    await execFileAsync('tar', ['-czf', archive, '-C', root, 'package']);

    await normalizePackageArchive(archive, execFileAsync);

    const { stdout } = await execFileAsync('tar', [
      '-xOf',
      archive,
      `package/sdk/store/pnpm/v11/files/00/${hash}`,
    ]);
    expect(stdout).toBe('content\n');
  });
});

describe('assertNoRetiredPackageFiles', () => {
  it('rejects a deleted entry left behind by an incremental package build', () => {
    expect(() =>
      assertNoRetiredPackageFiles('@forgeax/engine-vite-plugin-pack', [
        'package/dist/index.mjs',
        'package/dist/runtime.mjs',
      ]),
    ).toThrow('sdk-retired-package-file: @forgeax/engine-vite-plugin-pack: dist/runtime.mjs');
  });

  it('accepts the clean package output inventory', () => {
    expect(() =>
      assertNoRetiredPackageFiles('@forgeax/engine-vite-plugin-pack', [
        'dist/index.mjs',
        'dist/runtime-diagnostics.d.ts',
      ]),
    ).not.toThrow();
  });
});

describe('waitForNpmPublications', () => {
  it('waits for exact metadata, dist-tag, and tarball availability', async () => {
    let round = 0;
    let clock = 0;
    const item = {
      name: '@forgeax/engine-sdk',
      version: '1.2.3',
      integrity: 'sha512-exact',
    };
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('/%40forgeax%2Fengine-sdk/1.2.3')) {
        if (round === 0) return new Response(null, { status: 404 });
        return Response.json({
          dist: {
            integrity: item.integrity,
            tarball: 'https://registry.npmjs.org/@forgeax/engine-sdk/-/engine-sdk-1.2.3.tgz',
          },
        });
      }
      if (url.endsWith('/dist-tags')) return Response.json({ latest: item.version });
      if (init.method === 'HEAD') {
        return new Response(null, { status: round === 1 ? 404 : 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    await expect(
      waitForNpmPublications([item], {
        tag: 'latest',
        fetchImpl,
        timeoutMs: 100,
        intervalMs: 10,
        now: () => clock,
        sleep: async (duration) => {
          clock += duration;
          round += 1;
        },
      }),
    ).resolves.toEqual({ verified: 1, tag: 'latest' });
    expect(round).toBe(2);
  });

  it('rejects immutable registry bytes that differ from the staged archive', async () => {
    const item = {
      name: '@forgeax/engine-sdk',
      version: '1.2.3',
      integrity: 'sha512-exact',
    };
    const fetchImpl = async () =>
      Response.json({
        dist: {
          integrity: 'sha512-other',
          tarball: 'https://registry.npmjs.org/archive.tgz',
        },
      });

    await expect(waitForNpmPublications([item], { tag: 'latest', fetchImpl })).rejects.toThrow(
      'npm-published-integrity-mismatch: @forgeax/engine-sdk',
    );
  });
});

describe('canonical kit output override', () => {
  it('keeps the package-owned receipt unchanged when an SDK build uses a staging output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-canonical-kit-test-'));
    tempRoots.push(root);
    const packageKit = join(repositoryRoot, 'packages/preview/assets/canonical-kit');
    const receipt = join(packageKit, 'cook-receipt.json');
    const before = await readFile(receipt, 'utf8');
    const source = join(root, 'sky.hdr');
    const meta = join(root, 'sky.hdr.meta.json');
    await writeFile(source, Buffer.from('deterministic-canonical-kit-fixture\n'));
    await writeFile(meta, `${JSON.stringify({ guid: 'fixture-canonical-kit-guid' })}\n`);
    const output = join(root, 'canonical-kit');

    await execFileAsync(
      process.execPath,
      [join(repositoryRoot, 'packages/preview/scripts/build-canonical-kit.mjs'), source, meta],
      {
        cwd: repositoryRoot,
        env: { ...process.env, FORGEAX_CANONICAL_KIT_OUTPUT: output },
      },
    );

    await expect(readFile(receipt, 'utf8')).resolves.toBe(before);
    await expect(readFile(join(output, 'cook-receipt.json'), 'utf8')).resolves.toContain(
      'packages/preview/scripts/build-canonical-kit.mjs',
    );
  });
});

describe('SDK verifier template contract', () => {
  it('keeps the generated template typecheck script in the SDK gates', async () => {
    const builder = await readFile(join(repositoryRoot, 'scripts/forgeax/build-sdk.mjs'), 'utf8');
    const verifier = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    const carrierVerifier = await readFile(
      join(repositoryRoot, 'scripts/forgeax/publish-sdk-npm.mjs'),
      'utf8',
    );
    expect(builder).toContain("typecheck: 'pnpm exec tsc --noEmit'");
    expect(verifier).toContain("const templateTypecheckScript = 'pnpm exec tsc --noEmit'");
    expect(verifier).toContain("['run', 'typecheck', '--pretty', 'false']");
    expect(verifier).toContain("['exec', 'forgeax', 'package', '--output'");
    expect(carrierVerifier).toContain("'run', 'typecheck', '--pretty', 'false'");
    expect(carrierVerifier).toContain("'exec', 'forgeax', 'package', '--output'");
  });

  it('ships the feedback document into both generated game templates', async () => {
    const agents = await readFile(join(repositoryRoot, 'templates/AGENTS.md'), 'utf8');
    expect(agents).toContain('docs/feedback.md');
    for (const template of ['empty', 'game-3d']) {
      await expect(
        readFile(join(repositoryRoot, `templates/${template}/README.md`), 'utf8'),
      ).resolves.toContain('docs/feedback.md');
      await expect(
        readFile(join(repositoryRoot, `templates/${template}/docs/feedback.md`), 'utf8'),
      ).resolves.toContain('Web ZIP');
    }
  });

  it('keeps game-3d UI authoring as readable sources in the default build path', async () => {
    const manifest = JSON.parse(
      await readFile(join(repositoryRoot, 'templates/game-3d/package.json'), 'utf8'),
    );
    expect(manifest.forgeax).not.toHaveProperty('assets');
    const host = await readFile(join(repositoryRoot, 'packages/devkit/src/host.ts'), 'utf8');
    expect(host).toContain("import { createUiImporter } from '@forgeax/engine-ui/importer';");
    expect(host).toContain('  createUiImporter(),');
    const html = await readFile(
      join(repositoryRoot, 'templates/game-3d/assets/guide.ui.html'),
      'utf8',
    );
    const css = await readFile(
      join(repositoryRoot, 'templates/game-3d/assets/guide.ui.css'),
      'utf8',
    );
    const meta = JSON.parse(
      await readFile(
        join(repositoryRoot, 'templates/game-3d/assets/guide.ui.html.meta.json'),
        'utf8',
      ),
    );
    expect(html).toContain('WASD move');
    expect(html).toContain('\n');
    expect(css).toContain(':host {');
    expect(css).toContain('\n');
    expect(meta).toMatchObject({ importer: 'ui', source: 'guide.ui.html' });
    expect(meta.subAssets).toEqual([
      expect.objectContaining({ sourceKey: 'ui/guide', kind: 'ui' }),
    ]);
    await expect(
      readFile(join(repositoryRoot, 'templates/game-3d/assets/ui/ui.plugin.ts'), 'utf8'),
    ).resolves.toContain("authoredGuid('ui/guide')");
  });

  it('uses the bounded source-distribution collision exception and validates its exact evidence', async () => {
    const source = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    expect(source).toContain("FORGEAX_TEMPLATE_SMOKE_GAME3D_COLLISION_MODE: 'omit-sdk-source'");
    expect(source).toContain("sourceGame3dCollision?.status !== 'omitted'");
    expect(source).toContain("sourceGame3dCollision.reason !== 'sdk-source-distribution'");
    expect(source).toContain(
      "Object.keys(sourceGame3dCollision).sort().join(',') !== 'reason,status'",
    );
    expect(source).toContain('sdk-source-template-collision-contract');
    expect(source).toContain("sourceTemplateEvidence.status !== 'passed-with-omissions'");
    expect(source).toContain("sourceHostGpuInstanceLoss?.status !== 'omitted'");
    expect(source).toContain("sourceHostGpuInstanceLoss?.status !== 'not-observed'");
    expect(source).toContain("sourceHostGpuInstanceLoss.eventPhase !== 'interaction'");
    expect(source).toContain('sourceHostGpuInstanceLoss.eventSequence >=');
    expect(source).toContain('sourceHostGpuInstanceLoss.journeyCompleteSequence');
    expect(source).toContain("sourceJourneyRendererHealth?.reason !== 'device-lost'");
    expect(source).toContain("sourceFreshProcessRendererHealth?.reason !== 'alive'");
    expect(source).toContain('sourceHostGpuInstanceLoss.freshProcessFrameId <= 0');
    expect(source).toContain('sdk-source-host-gpu-instance-loss-contract');
  });

  it('selects the empty template when creating the offline project', async () => {
    const source = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    const createdProject = source.slice(
      source.indexOf('const createdProject ='),
      source.indexOf('const createdProjectEnvelope ='),
    );
    expect(createdProject).toContain("'--template', 'empty'");
  });

  it('validates the final plugin-based empty project layout', async () => {
    const source = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    const template = JSON.parse(
      await readFile(join(repositoryRoot, 'templates/empty/forge.json'), 'utf8'),
    );
    const layoutCheck = source.slice(
      source.indexOf('const projectManifestPath ='),
      source.indexOf(
        "await readFile(resolve(project, 'assets', 'world', 'world.scene.pack.json'))",
      ),
    );
    expect(template).toMatchObject({ schemaVersion: '2.0.0', plugins: [] });
    expect(template).not.toHaveProperty('entry');
    expect(source).toContain("'templates/empty/.gitignore'");
    expect(source).toContain("'templates/empty/tsconfig.json'");
    expect(source).toContain("'templates/empty/vitest.config.ts'");
    expect(layoutCheck).toContain('projectManifest.entry !== undefined');
    expect(layoutCheck).toContain('projectManifest.plugins.length !== 0');
    expect(layoutCheck).not.toContain("entry.id === 'gameplay'");
    expect(layoutCheck).not.toContain("entry.name === './src/main.ts'");
    expect(source).toContain("resolve(project, 'assets', '__tests__', 'empty-project.test.ts')");
    expect(source).not.toContain("resolve(project, 'src', '__tests__', 'starter.test.ts')");
    const projectLayout = source.slice(
      source.indexOf('projectLayout: {'),
      source.indexOf("starterTest: 'assets/__tests__/empty-project.test.ts'") +
        "starterTest: 'assets/__tests__/empty-project.test.ts'".length,
    );
    expect(projectLayout).toContain('plugins: projectManifest.plugins');
    expect(projectLayout).toContain("starterTest: 'assets/__tests__/empty-project.test.ts'");
    expect(projectLayout).not.toContain('entry: projectManifest.entry');
    expect(source).toContain('sdk-empty-authored-camera-missing');
    expect(source).toContain("retiredPath of ['src', 'src/main.ts', 'src/__tests__']");
  });

  it('uses a real center-canvas gesture for the game-3d browser check', async () => {
    const source = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    const interaction = source.slice(
      source.indexOf('const before ='),
      source.indexOf("await page.keyboard.down('KeyW')"),
    );
    expect(interaction).toContain("const canvas = page.locator('canvas').first();");
    expect(interaction).toContain('const canvasBox = await canvas.boundingBox();');
    expect(interaction).toContain('await page.mouse.click(centerX, centerY);');
  });

  it('waits for the game-3d guide mount before taking the gameplay baseline', async () => {
    const source = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    const readiness = source.slice(
      source.indexOf('async function openReadyProjectPage'),
      source.indexOf('async function readSelectedPlayerProjection'),
    );
    expect(readiness).toContain("document.querySelector('#game-ui')?.childElementCount");
    expect(readiness).toContain('sdk-selected-game-not-ready:');
    expect(readiness).toContain("reads.includes('game-3d.player')");
    expect(readiness).toContain('sdk-selected-game-projection-not-ready:');
  });

  it('isolates the source-distribution browser journey after closing the SDK browser', async () => {
    const source = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    const browserClose = source.slice(
      source.indexOf('async function closeSelectedBrowser'),
      source.indexOf('async function launchSelectedBrowser'),
    );
    expect(browserClose).toContain('for (const context of browser.contexts())');
    expect(browserClose).toContain('context.close()');
    expect(browserClose).toContain('const errors = []');
    expect(browserClose).toContain('browser.close()');
    expect(source).toContain('const cleanupErrors = []');
    expect(source).toContain("await attemptCleanup('server signal'");
    expect(source).toContain("await attemptCleanup('server exit'");
    expect(source).toContain('new AggregateError([operationError, cleanupFailure]');
    const sourceSmoke = source.slice(
      source.indexOf('const sourceSmokeArgs ='),
      source.indexOf('return JSON.parse(await readFile(resolve(sourceSmokeDir'),
    );
    expect(sourceSmoke).toContain("'xvfb-run'");
    expect(sourceSmoke).toContain("FORGEAX_BROWSER_HEADLESS === '0'");
    expect(sourceSmoke).toContain('sourcePackageManager');
  });

  it('exposes game-owned read projections from the generated Dev host', async () => {
    const source = await readFile(join(repositoryRoot, 'packages/devkit/src/host.ts'), 'utf8');
    expect(source).toContain('const gameProjectionDefinitions = new Map();');
    expect(source).toContain('globalThis.__forgeaxGameInspection = {');
    expect(source).toContain('import.meta.env.DEV ? { gameProjection } : {}');
    expect(source).toContain('if (import.meta.env.DEV) exposeGameInspection(app);');
  });

  it('holds gameplay input until the game-owned projection proves movement', async () => {
    const source = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    const journey = source.slice(
      source.indexOf("await page.keyboard.down('KeyW');"),
      source.indexOf('const movementDelta ='),
    );
    expect(journey).toContain('const movementDeadline = Date.now() + 120_000');
    expect(journey).toContain('readSelectedPlayerProjection(page)');
    expect(journey).toContain('candidate.position[2] < before.position[2] - 0.01');
    expect(journey).toContain('candidate.fixedTick > before.fixedTick');
    expect(journey).toContain('sdk-selected-third-person-movement-timeout');
    expect(journey).not.toContain('submittedFrameId >=');
    expect(journey).not.toContain('inputStartFrameId');
    expect(journey).not.toContain('waitForFunction(\n        async');
    expect(journey).toContain('finally');
    expect(journey).toContain("await page.keyboard.up('KeyW');");
  });

  it('keeps frame timeout diagnostics bounded and runtime-specific', async () => {
    const source = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    const frameDiagnostics = source.slice(
      source.indexOf('const MAX_DIAGNOSTIC_ITEMS'),
      source.indexOf('async function openReadyProjectPage'),
    );
    expect(frameDiagnostics).toContain('MAX_DIAGNOSTIC_ITEMS = 32');
    expect(frameDiagnostics).toContain('DIAGNOSTIC_TEXT_LIMIT = 4_000');
    expect(frameDiagnostics).toContain('values.length < MAX_DIAGNOSTIC_ITEMS');
    expect(frameDiagnostics).toContain('value.slice(-DIAGNOSTIC_TEXT_LIMIT)');
    expect(frameDiagnostics).toContain("document.querySelector('#forgeax-fatal')");
    expect(frameDiagnostics).toContain('forgeaxFrameSubmitted');
    expect(frameDiagnostics).toContain('__forgeaxGameInspection');
    expect(frameDiagnostics).toContain('serverOutput: diagnostics.serverOutput()');
    expect(source).toContain(
      'serverOutput: () => ({ stdout: boundedTail(stdout), stderr: boundedTail(stderr) })',
    );
    expect(source).toContain('sdk-selected-render-frame-not-submitted:');
    expect(source).toContain('JSON.stringify(evidence)');
    expect(source).toContain('{ timeout: 120_000, polling: 100 }');
  });

  it('separates sealed candidate gates from idempotent promotion', async () => {
    const candidateWorkflow = await readFile(
      join(repositoryRoot, '.github/workflows/sdk-release-candidate.yml'),
      'utf8',
    );
    const promotionWorkflow = await readFile(
      join(repositoryRoot, '.github/workflows/sdk-release-promote.yml'),
      'utf8',
    );
    expect(candidateWorkflow).toContain('workflow_dispatch:');
    expect(candidateWorkflow).toContain('SDK candidates must verify current origin/main');
    expect(candidateWorkflow).toContain('--workflow ci.yml');
    expect(candidateWorkflow).toContain('--commit "$sha"');
    expect(candidateWorkflow).toContain('SDK candidates require successful same-commit CI');
    expect(candidateWorkflow).toContain('Build exact SDK candidate seed once');
    expect(candidateWorkflow).toContain('npm-consumer:');
    expect(candidateWorkflow).toContain('archive-browser:');
    expect(candidateWorkflow).toContain('reproducibility:');
    expect(candidateWorkflow).toContain('collision:');
    expect(candidateWorkflow).toContain('sdk-candidate.mjs seal');
    expect(candidateWorkflow).toContain('npm-consumer.log');
    expect(candidateWorkflow).toContain('tail -n 1 artifacts/gates/npm-consumer.log');
    expect(candidateWorkflow).not.toContain('quick');
    expect(promotionWorkflow).toContain('candidate_run_id:');
    expect(promotionWorkflow).toContain('sdk-candidate.mjs verify');
    expect(promotionWorkflow).toContain('--candidate "$RUNNER_TEMP/sdk-candidate"');
    expect(promotionWorkflow).toContain('finalize-sdk-release.mjs');
    expect(promotionWorkflow).toContain(
      '--asset "$RUNNER_TEMP/sdk-candidate/sdk-verify-result.json"',
    );
    expect(promotionWorkflow).not.toContain('pnpm sdk:build');
    expect(promotionWorkflow).not.toContain('pnpm sdk:verify');
  });

  it('uses semantic movement and renderer health without a lavapipe screenshot', async () => {
    const source = await readFile(join(repositoryRoot, 'scripts/forgeax/verify-sdk.mjs'), 'utf8');
    const browserCheck = source.slice(
      source.indexOf('async function verifyProjectBrowser'),
      source.indexOf('const selectedTemplateEvidence ='),
    );
    expect(browserCheck).toContain('movementDistance');
    expect(browserCheck).toContain("renderer?.state !== 'alive'");
    expect(browserCheck).not.toContain('page.screenshot');
    expect(browserCheck).not.toContain('toDataURL');
  });
});
