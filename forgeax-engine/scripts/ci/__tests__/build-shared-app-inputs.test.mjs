import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const script = join(repoRoot, 'scripts', 'ci', 'build-shared-app-inputs.mjs');
const unpackScript = join(repoRoot, 'scripts', 'ci', 'unpack-shared-app-inputs.mjs');

test('shared inputs preserve both raw source paths and Vite-emitted asset paths', () => {
  const output = mkdtempSync(join(tmpdir(), 'forgeax-shared-inputs-'));
  const projection = `${output}-projection`;
  try {
    const result = spawnSync(
      process.execPath,
      [script, '--root', repoRoot, '--out', output, '--projection-out', projection],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const catalog = JSON.parse(readFileSync(join(output, 'assets', 'catalog.json'), 'utf8'));
    assert.equal(
      catalog.some((entry) => entry.sourcePath.endsWith('meshes/cube-mesh.stub')),
      false,
      'runtime-generated procedural mesh stubs are not shared Pack inputs',
    );
    const bleep = catalog.find((entry) => entry.sourcePath.endsWith('audio/bleep.mp3'));
    assert.ok(bleep, 'shared catalog includes the raw audio entry');
    const packagePath = bleep.packageUrl?.replace(/^\/+/, '');
    assert.ok(packagePath, 'shared catalog includes the cooked package URL');
    assert.ok(existsSync(join(output, 'assets', 'payload', packagePath)));
    assert.ok(existsSync(join(output, 'assets', 'payload', 'assets')));
    const projectedManifest = JSON.parse(readFileSync(join(projection, 'manifest.json'), 'utf8'));
    assert.deepEqual(projectedManifest.payload, {
      assetCatalog: 'shared-app-inputs/assets/catalog.json',
      engineShaderManifest: 'shared-app-inputs/shaders/manifest.json',
    });
    assert.equal(existsSync(join(projection, 'assets', 'payload')), false);
    assert.ok(existsSync(join(projection, 'assets', 'catalog.json')));
    assert.ok(existsSync(join(projection, 'shaders', 'manifest.json')));
  } finally {
    rmSync(output, { recursive: true, force: true });
    rmSync(projection, { recursive: true, force: true });
  }
});

test('catalog-only shared inputs do not stage or publish serialized payload bytes', () => {
  const output = mkdtempSync(join(tmpdir(), 'forgeax-shared-catalog-only-'));
  try {
    const result = spawnSync(
      process.execPath,
      [script, '--root', repoRoot, '--out', output, '--catalog-only'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
    const facts = JSON.parse(readFileSync(join(output, 'production-facts.json'), 'utf8'));
    assert.deepEqual(manifest.payload, {
      assetCatalog: 'shared-app-inputs/assets/catalog.json',
      engineShaderManifest: 'shared-app-inputs/shaders/manifest.json',
    });
    assert.equal(facts.payloadMode, 'catalog-only');
    assert.equal(facts.payloadEmitCount, 0);
    assert.equal(existsSync(join(output, 'assets', 'payload')), false);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('shared input transfer is a compact tarball and unpacking is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-shared-input-archive-'));
  const source = join(root, 'shared-app-inputs');
  const transfer = join(root, 'shared-app-inputs-transfer');
  try {
    mkdirSync(join(source, 'assets'), { recursive: true });
    mkdirSync(join(source, 'shaders'), { recursive: true });
    mkdirSync(transfer, { recursive: true });
    writeFileSync(join(source, 'manifest.json'), '{"schemaVersion":1}\n');
    writeFileSync(join(source, 'assets', 'catalog.json'), '[]\n');
    writeFileSync(join(source, 'shaders', 'manifest.json'), '{}\n');
    writeFileSync(join(source, 'shaders', 'engine.wgsl'), 'shader\n');
    const archive = join(transfer, 'shared-app-inputs.tar.gz');
    const packed = spawnSync(
      'tar',
      ['-czf', archive, '-C', source, 'assets', 'shaders', 'manifest.json'],
      { encoding: 'utf8' },
    );
    assert.equal(packed.status, 0, packed.stderr);

    const unpacked = spawnSync(process.execPath, [unpackScript, '--root', root], {
      encoding: 'utf8',
    });
    assert.equal(unpacked.status, 0, unpacked.stderr);
    assert.equal(existsSync(archive), false);
    assert.equal(readFileSync(join(source, 'shaders', 'engine.wgsl'), 'utf8'), 'shader\n');
    assert.equal(existsSync(join(source, 'assets', 'payload')), false);

    const second = spawnSync(process.execPath, [unpackScript, '--root', root], {
      encoding: 'utf8',
    });
    assert.equal(second.status, 0, second.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
