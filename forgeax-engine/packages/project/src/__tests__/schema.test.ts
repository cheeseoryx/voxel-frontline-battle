import { describe, expect, it } from 'vitest';
import { GameProjectSchema, GuidString } from '../schema.js';

const base = {
  id: 'test-game',
  name: 'Test Game',
  schemaVersion: '2.0.0',
  plugins: [],
};

describe('GameProjectSchema schema 2.0', () => {
  it('accepts a minimal strict manifest', () => {
    expect(GameProjectSchema.safeParse(base).success).toBe(true);
  });

  it('accepts defaultScene and a nested native Entry tree', () => {
    const result = GameProjectSchema.safeParse({
      ...base,
      defaultScene: '15acc839-d847-527c-8284-bfb36d7c50de',
      plugins: [
        {
          id: 'engine-features',
          name: 'cordis:group',
          group: true,
          realm: 'engine',
          config: [
            {
              id: 'gameplay',
              name: './main.ts',
              config: { difficulty: 'hard' },
              inject: ['world', 'renderer'],
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects every schema version except 2.0.0', () => {
    for (const schemaVersion of ['1.0.0', '2.1.0', 'v2']) {
      expect(GameProjectSchema.safeParse({ ...base, schemaVersion }).success).toBe(false);
    }
  });

  it('requires plugins and rejects nullable entry controls', () => {
    const { plugins: _plugins, ...withoutPlugins } = base;
    expect(GameProjectSchema.safeParse(withoutPlugins).success).toBe(false);
    expect(GameProjectSchema.safeParse({ ...base, disabled: null }).success).toBe(false);
    expect(
      GameProjectSchema.safeParse({
        ...base,
        plugins: [{ id: 'nullable', name: './x', disabled: null }],
      }).success,
    ).toBe(false);
  });

  it('rejects every legacy root field without a compatibility parser', () => {
    for (const field of [
      'entry',
      'executionEntry',
      'physics',
      'pointerLock',
      'input',
      'preview',
      'npc',
    ]) {
      expect(GameProjectSchema.safeParse({ ...base, [field]: 'legacy' }).success).toBe(false);
    }
  });

  it('rejects unknown top-level fields', () => {
    const result = GameProjectSchema.safeParse({ ...base, scenes: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('rejects duplicate plugin ids across one Entry tree', () => {
    const result = GameProjectSchema.safeParse({
      ...base,
      plugins: [
        { id: 'same', name: './one.ts' },
        {
          id: 'group',
          name: 'cordis:group',
          group: true,
          config: [{ id: 'same', name: './two.ts' }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('GuidString', () => {
  it('accepts UUID values used by scene assets', () => {
    expect(GuidString.safeParse('d953a1db-483a-4b7d-8b71-b8f144488c48').success).toBe(true);
    expect(GuidString.safeParse('15acc839-d847-527c-8284-bfb36d7c50de').success).toBe(true);
    expect(GuidString.safeParse('7B4D43D4-5B19-5903-8966-F89671D21565').success).toBe(true);
  });

  it('rejects malformed or non-UUID strings', () => {
    for (const value of ['', 'not-a-guid', 'rogue-encampment']) {
      expect(GuidString.safeParse(value).success).toBe(false);
    }
  });
});
