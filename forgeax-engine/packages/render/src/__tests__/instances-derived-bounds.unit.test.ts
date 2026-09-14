import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveInstancesUnionBounds, InstanceBoundsCache } from '../instances-derived-bounds';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function translated(x: number, y = 0, z = 0): Float32Array {
  const matrix = new Float32Array(IDENTITY);
  matrix[12] = x;
  matrix[13] = y;
  matrix[14] = z;
  return matrix;
}

const meshAabb = new Float32Array([-1, -1, -1, 1, 1, 1]);
const entityWorld = new Float32Array(IDENTITY);

describe('Instances renderer-derived union bounds', () => {
  it('unions every transformed mesh corner in entity world space', () => {
    expect(
      deriveInstancesUnionBounds({
        meshAabb,
        entityWorld,
        transforms: new Float32Array([...IDENTITY, ...translated(5, 2, -3)]),
      }),
    ).toEqual(new Float32Array([-1, -1, -4, 6, 3, 1]));
  });

  it('does not manufacture a visible bound for empty or malformed input', () => {
    expect(
      deriveInstancesUnionBounds({ meshAabb, entityWorld, transforms: new Float32Array() }),
    ).toBeUndefined();
    expect(
      deriveInstancesUnionBounds({
        meshAabb,
        entityWorld,
        transforms: new Float32Array([...IDENTITY, 1, 2]),
      }),
    ).toBeUndefined();
    expect(
      deriveInstancesUnionBounds({
        meshAabb,
        entityWorld,
        transforms: new Float32Array([...IDENTITY.slice(0, 15), Number.NaN]),
      }),
    ).toBeUndefined();
  });

  it('invalidates one cached projection when mesh, entity, or matrix generation changes', () => {
    const cache = new InstanceBoundsCache();
    const input = {
      entityKey: 7,
      meshGeneration: 1,
      transformGeneration: 1,
      matrixGeneration: 1,
      meshAabb,
      entityWorld,
      transforms: new Float32Array(IDENTITY),
    };
    const first = cache.get(input);
    expect(first).toEqual(meshAabb);
    expect(cache.get(input)).toBe(first);

    const matrixChanged = cache.get({ ...input, matrixGeneration: 2, transforms: translated(9) });
    expect(matrixChanged).not.toBe(first);
    expect(matrixChanged?.[0]).toBe(8);

    const entityChanged = cache.get({
      ...input,
      transformGeneration: 2,
      entityWorld: translated(10),
    });
    expect(entityChanged).not.toBe(first);
    expect(entityChanged?.[0]).toBe(9);

    const meshChanged = cache.get({
      ...input,
      meshGeneration: 2,
      meshAabb: new Float32Array([-2, -1, -1, 2, 1, 1]),
    });
    expect(meshChanged).not.toBe(first);
    expect(meshChanged).toEqual(new Float32Array([-2, -1, -1, 2, 1, 1]));

    const reused = cache.get({ ...input, meshGeneration: 3 });
    expect(reused).not.toBe(first);
  });

  it('does not alias equal entity keys from different worlds in one composite scene', () => {
    const cache = new InstanceBoundsCache();
    const first = cache.get({
      worldId: 1,
      entityKey: 7,
      meshGeneration: 1,
      transformGeneration: 1,
      matrixGeneration: 1,
      meshAabb,
      entityWorld,
      transforms: new Float32Array(IDENTITY),
    });
    const second = cache.get({
      worldId: 2,
      entityKey: 7,
      meshGeneration: 1,
      transformGeneration: 1,
      matrixGeneration: 1,
      meshAabb,
      entityWorld: translated(20),
      transforms: new Float32Array(IDENTITY),
    });
    expect(second).not.toBe(first);
    expect(second?.[0]).toBe(19);
  });

  it('keeps bounds renderer-derived; the public Instances schema has no bounds field', () => {
    const source = readFileSync(new URL('../components/instances.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bbounds\s*:/);
  });
});
