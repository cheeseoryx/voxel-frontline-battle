import { describe, expect, it } from 'vitest';

import { GameProjectSchema } from '../schema.js';

const validProject = {
  id: 'schema-v2-game',
  name: 'Schema V2 Game',
  schemaVersion: '2.0.0',
  plugins: [],
};

describe('GameProjectSchema v2', () => {
  it('requires the strict schema 2.0 project shape and allows an empty EntryTree', () => {
    const result = GameProjectSchema.safeParse(validProject);

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.plugins).toEqual([]);
  });

  it('rejects every schema version other than 2.0.0', () => {
    for (const schemaVersion of ['1.0.0', '2.1.0', 'v2']) {
      const result = GameProjectSchema.safeParse({ ...validProject, schemaVersion });
      expect(result.success, schemaVersion).toBe(false);
    }
  });

  it('requires plugins as the only installable capability root', () => {
    const { plugins: _plugins, ...withoutPlugins } = validProject;
    const result = GameProjectSchema.safeParse(withoutPlugins);

    expect(result.success).toBe(false);
  });

  it('rejects legacy root fields instead of preserving a dual manifest path', () => {
    const legacyFields = [
      'entry',
      'executionEntry',
      'physics',
      'pointerLock',
      'input',
      'preview',
      'npc',
    ] as const;

    for (const field of legacyFields) {
      const result = GameProjectSchema.safeParse({
        ...validProject,
        [field]: field === 'pointerLock' ? true : './legacy.ts',
      });
      expect(result.success, field).toBe(false);
    }
  });

  it('accepts enabled, disabled, and realm-inherited Entry states', () => {
    const result = GameProjectSchema.safeParse({
      ...validProject,
      plugins: [
        { id: 'enabled', name: './enabled.plugin.ts', realm: 'engine' },
        { id: 'disabled', name: './disabled.plugin.ts', disabled: true, realm: 'engine' },
        { id: 'inherited', name: './inherited.plugin.ts' },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('rejects nullable disabled state because absence means enabled', () => {
    const result = GameProjectSchema.safeParse({
      ...validProject,
      plugins: [{ id: 'nullable', name: './nullable.plugin.ts', disabled: null }],
    });

    expect(result.success).toBe(false);
  });

  it('accepts a Group root with nested children and inherited realm', () => {
    const result = GameProjectSchema.safeParse({
      ...validProject,
      plugins: [
        {
          id: 'game',
          name: 'cordis:group',
          group: true,
          realm: 'engine',
          config: [
            { id: 'world', name: './world.plugin.ts' },
            { id: 'player', name: './player.plugin.ts', inject: ['world'] },
          ],
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('rejects a Group whose config is not an EntryTree', () => {
    const result = GameProjectSchema.safeParse({
      ...validProject,
      plugins: [{ id: 'invalid-group', name: 'cordis:group', group: true, config: {} }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate Entry ids across a Group ownership path', () => {
    const result = GameProjectSchema.safeParse({
      ...validProject,
      plugins: [
        { id: 'same', name: './root.plugin.ts' },
        {
          id: 'group',
          name: 'cordis:group',
          group: true,
          config: [{ id: 'same', name: './child.plugin.ts' }],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects an unknown physical realm before module activation', () => {
    const result = GameProjectSchema.safeParse({
      ...validProject,
      plugins: [{ id: 'unknown', name: './unknown.plugin.ts', realm: 'worker' }],
    });

    expect(result.success).toBe(false);
  });
});
