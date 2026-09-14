import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APP_SHADER_MANIFEST_DELTA,
  mergeAppShaderManifest,
  projectAppShaderManifest,
} from '../app-shader-manifest.mjs';

const sharedEntry = { hash: 'engine-hash', wgsl: 'engine', bindings: '{}', glsl: '' };
const customEntry = { hash: 'custom-hash', wgsl: 'custom', bindings: '{}', glsl: '' };
const sharedMaterial = {
  identifier: 'forgeax::default-standard-pbr',
  sourcePath: 'engine/default-standard-pbr.wgsl',
  composedWgsl: 'engine',
  paramSchema: '{}',
  variants: [],
};
const customMaterial = {
  identifier: 'demo::custom',
  sourcePath: 'apps/demo/src/custom.wgsl',
  composedWgsl: 'custom',
  paramSchema: '{}',
  variants: [],
};

test('projects only app-owned shader rows for shard transport', () => {
  const delta = projectAppShaderManifest(
    {
      entries: [sharedEntry, customEntry],
      materialShaders: [sharedMaterial, customMaterial],
    },
    { entries: [sharedEntry], materialShaders: [sharedMaterial] },
  );

  assert.equal(delta.forgeaxTransport, APP_SHADER_MANIFEST_DELTA);
  assert.deepEqual(delta.entries, [customEntry]);
  assert.deepEqual(delta.materialShaders, [customMaterial]);
});

test('merges an app delta back into one runtime manifest', () => {
  const merged = mergeAppShaderManifest(
    { schemaVersion: '1.0.0', entries: [sharedEntry], materialShaders: [sharedMaterial] },
    {
      forgeaxTransport: APP_SHADER_MANIFEST_DELTA,
      entries: [customEntry],
      materialShaders: [customMaterial],
    },
  );

  assert.equal(merged.schemaVersion, '1.0.0');
  assert.deepEqual(merged.entries, [sharedEntry, customEntry]);
  assert.deepEqual(merged.materialShaders, [sharedMaterial, customMaterial]);
});

test('app-owned rows replace a same-identity shared material row', () => {
  const replacement = { ...sharedMaterial, composedWgsl: 'replacement' };
  const merged = mergeAppShaderManifest(
    { entries: [sharedEntry], materialShaders: [sharedMaterial] },
    {
      forgeaxTransport: APP_SHADER_MANIFEST_DELTA,
      entries: [],
      materialShaders: [replacement],
    },
  );

  assert.deepEqual(merged.materialShaders, [replacement]);
});
