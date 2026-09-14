import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { stageEngineDesktopCommon } from '../stage-desktop-runtime.mjs';

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe('Engine desktop common producer', () => {
  test('stages templates, common assets, and exact WASM payloads', () => {
    const root = mkdtempSync(join(tmpdir(), 'engine-common-source-'));
    const output = `${root}-output`;
    roots.push(root, output);
    mkdirSync(join(root, 'templates/sample'), { recursive: true });
    writeFileSync(join(root, 'templates/sample/forge.json'), JSON.stringify({ entry: 'main.ts' }));
    writeFileSync(join(root, 'templates/sample/main.ts'), 'export {};');
    for (const asset of ['demo-assets/template-game-default', 'sfx', 'collectathon-audio']) {
      mkdirSync(join(root, 'forgeax-engine-assets', asset), { recursive: true });
      writeFileSync(join(root, 'forgeax-engine-assets', asset, 'asset.txt'), asset);
    }
    for (const [directory, files] of [
      ['wgpu-wasm', ['wgpu_wasm.js', 'wgpu_wasm_bg.wasm']],
      ['fbx', ['fbx-wasm.mjs', 'fbx-wasm.wasm']],
      ['codec', ['basis_transcoder.mjs', 'basis_transcoder.wasm']],
    ] as const) {
      mkdirSync(join(root, 'packages', directory, 'pkg'), { recursive: true });
      for (const file of files) {
        const path = join(root, 'packages', directory, 'pkg', file);
        writeFileSync(path, file);
        if (file.endsWith('.wasm')) chmodSync(path, 0o755);
      }
    }
    mkdirSync(join(root, 'packages/codec/pkg/encode'), { recursive: true });
    const encoderWasm = join(root, 'packages/codec/pkg/encode/basis_encoder.wasm');
    writeFileSync(encoderWasm, 'basis_encoder.wasm');
    chmodSync(encoderWasm, 0o755);
    stageEngineDesktopCommon(root, output);
    expect(existsSync(join(output, 'editor/packages/engine/templates/sample/main.ts'))).toBe(true);
    expect(
      existsSync(
        join(output, 'engine/node_modules/@forgeax/engine-wgpu-wasm/pkg/wgpu_wasm_bg.wasm'),
      ),
    ).toBe(true);
    for (const path of [
      'engine/node_modules/@forgeax/engine-wgpu-wasm/pkg/wgpu_wasm_bg.wasm',
      'engine/node_modules/@forgeax/engine-fbx/pkg/fbx-wasm.wasm',
      'engine/node_modules/@forgeax/engine-codec/pkg/basis_transcoder.wasm',
      'engine/node_modules/@forgeax/engine-codec/pkg/encode/basis_encoder.wasm',
    ]) {
      expect(statSync(join(output, path)).mode & 0o777).toBe(0o644);
    }
  });
});
