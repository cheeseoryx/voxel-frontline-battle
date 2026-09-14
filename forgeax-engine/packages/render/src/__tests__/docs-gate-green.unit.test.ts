import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

const renderReadme = read('../../README.md');
const assetsReadme = read('../../../assets-runtime/README.md');
const instancesSource = read('../components/instances.ts');

describe('M4 material and Instances documentation contract', () => {
  it('keeps resident observation and derived-bounds recovery discoverable', () => {
    for (const token of [
      'renderer.inspect().meshMaterialBindings[]',
      '`ready`, `pending`, `failed`, or `last-known-good`',
      'nearest structured preparation',
      'does not keep a second readiness ledger',
      '`Instances` remains author data',
      'renderer derives a CPU union bound',
      'conservative no-cull result',
      'GPU path keeps the mesh-local AABB',
    ]) {
      expect(renderReadme).toContain(token);
    }
    for (const token of [
      'producer lifecycle observations',
      '`inspect -> rebuild/recook or refresh LKG -> loadByGuid`',
      'parallel readiness ledger',
    ]) {
      expect(assetsReadme).toContain(token);
    }
  });

  it('keeps bounds out of the public Instances author schema', () => {
    expect(instancesSource).not.toMatch(/\bbounds\s*:/);
  });
});
