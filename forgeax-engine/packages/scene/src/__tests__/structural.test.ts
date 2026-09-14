// @ts-expect-error The package test tsconfig intentionally omits Node globals.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('SceneInstance structure characterization', () => {
  it('records the current instance state surface', async () => {
    const source = readFileSync(
      new URL('../instances/scene-instances.ts', import.meta.url),
      'utf8',
    );
    const snapshot = {
      lines: source.split('\n').length - 1,
      exportedFunctions: (source.match(/^export function\b/gm) ?? []).length,
      hasStatePayload: source.includes('export interface SceneInstanceStatePayload'),
      hasWorldStateWeakMap: source.includes('const sceneWorldStates = new WeakMap'),
    };

    expect(snapshot.lines).toBeLessThan(1564);
    expect(snapshot.exportedFunctions).toBe(27);
    expect(snapshot.hasStatePayload).toBe(false);
    expect(snapshot.hasWorldStateWeakMap).toBe(false);
  });
});
