#!/usr/bin/env node

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

const ENGINE_ROOT = resolve(import.meta.dirname, '..');
const EXCLUDES = new Set([
  '.git',
  '.forgeax-harness',
  'node_modules',
  'target',
  '__tests__',
  'test',
  'tests',
]);
const WASM_ARTIFACTS = [
  {
    packageName: '@forgeax/engine-wgpu-wasm',
    directory: 'wgpu-wasm',
    files: ['wgpu_wasm.js', 'wgpu_wasm_bg.wasm'],
  },
  {
    packageName: '@forgeax/engine-fbx',
    directory: 'fbx',
    files: ['fbx-wasm.mjs', 'fbx-wasm.wasm'],
  },
  {
    packageName: '@forgeax/engine-codec',
    directory: 'codec',
    files: ['basis_transcoder.mjs', 'basis_transcoder.wasm'],
  },
];

function fail(message) {
  throw new Error(`[engine-desktop-runtime] ${message}`);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function copyTree(source, destination) {
  if (!existsSync(source)) fail(`required source is missing: ${source}`);
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    force: false,
    errorOnExist: true,
    filter: (path) => !EXCLUDES.has(basename(path)),
  });
}

function normalizeWasmFileModes(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      normalizeWasmFileModes(path);
    } else if (entry.isFile() && entry.name.endsWith('.wasm')) {
      chmodSync(path, 0o644);
    }
  }
}

function validateTemplates(output) {
  const templates = join(output, 'editor/packages/engine/templates');
  let count = 0;
  for (const entry of readdirSync(templates, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const root = join(templates, entry.name);
    const manifestPath = join(root, 'forge.json');
    if (!existsSync(manifestPath)) fail(`template manifest is missing: ${entry.name}/forge.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const templateEntry = manifest.entry;
    if (
      typeof templateEntry !== 'string' ||
      !templateEntry ||
      templateEntry !== templateEntry.trim() ||
      templateEntry.includes('\\') ||
      isAbsolute(templateEntry) ||
      templateEntry.split('/').includes('..')
    ) {
      fail(`template has an invalid entry: ${entry.name}/forge.json`);
    }
    const entryPath = resolve(root, templateEntry);
    const rel = relative(root, entryPath);
    if (
      !rel ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel) ||
      !existsSync(entryPath) ||
      !statSync(entryPath).isFile()
    )
      fail(`template entry is missing: ${entry.name}/${templateEntry}`);
    count += 1;
  }
  if (count === 0) fail('no game templates were staged');
}

export function stageEngineDesktopCommon(engineRoot, output) {
  const root = resolve(engineRoot);
  const destination = resolve(output);
  if (existsSync(destination)) fail(`output already exists: ${destination}`);
  mkdirSync(destination, { recursive: true });
  copyTree(join(root, 'templates'), join(destination, 'editor/packages/engine/templates'));
  for (const relativePath of ['demo-assets/template-game-default', 'sfx', 'collectathon-audio']) {
    copyTree(
      join(root, 'forgeax-engine-assets', relativePath),
      join(destination, 'engine/forgeax-engine-assets', relativePath),
    );
  }
  for (const artifact of WASM_ARTIFACTS) {
    for (const file of artifact.files) {
      const source = join(root, 'packages', artifact.directory, 'pkg', file);
      if (!existsSync(source)) fail(`required WASM artifact is missing: ${source}`);
    }
    copyTree(
      join(root, 'packages', artifact.directory, 'pkg'),
      join(destination, 'engine/node_modules', artifact.packageName, 'pkg'),
    );
    normalizeWasmFileModes(join(destination, 'engine/node_modules', artifact.packageName, 'pkg'));
  }
  validateTemplates(destination);
}

if (import.meta.main) {
  const output = argument('--output');
  if (!output) fail('--output is required');
  stageEngineDesktopCommon(ENGINE_ROOT, output);
  console.log(
    JSON.stringify({ code: 'ENGINE_DESKTOP_RUNTIME_COMMON_STAGED', output: resolve(output) }),
  );
}
