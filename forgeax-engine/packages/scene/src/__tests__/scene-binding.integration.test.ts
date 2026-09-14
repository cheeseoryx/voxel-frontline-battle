import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { sceneAssetDecoder } from '../assets/scene-decoder.js';
import {
  resolveSceneEntity,
  type SceneEntityRef,
  sceneEntity,
  validateSceneBindings,
} from '../instances/binding.js';
import { externalizeSceneAsset } from '../instances/externalization.js';

describe('SceneEntityRef instance binding', () => {
  it('resolves by scene sourceKey and bindingKey, not display name', () => {
    const ref: SceneEntityRef = sceneEntity('level/main', 'player');
    const first = resolveSceneEntity(ref, {
      sceneSourceKey: 'level/main',
      bindings: new Map([['player', 11]]),
    });
    const second = resolveSceneEntity(ref, {
      sceneSourceKey: 'level/main',
      bindings: new Map([['player', 22]]),
    });

    expect(first).toEqual({ ok: true, value: 11 });
    expect(second).toEqual({ ok: true, value: 22 });
  });

  it('rejects a missing or cross-instance binding with a closed error', () => {
    const result = resolveSceneEntity(sceneEntity('level/main', 'camera'), {
      sceneSourceKey: 'level/main',
      bindings: new Map([['player', 11]]),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'scene-binding-missing',
        expected: expect.stringContaining('bindingKey'),
        hint: expect.stringContaining('declare'),
        detail: { sceneSourceKey: 'level/main', bindingKey: 'camera' },
      },
    });
  });

  it('rejects a reference from another concrete SceneInstance', () => {
    const ref = sceneEntity('level/other', 'player');
    const result = resolveSceneEntity(ref, {
      sceneSourceKey: 'level/main',
      bindings: new Map([['player', 11]]),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'scene-binding-wrong-instance',
        detail: { sceneSourceKey: 'level/other', bindingKey: 'player' },
      },
    });
  });

  it('rejects duplicate declarations before an instance can publish bindings', () => {
    const result = validateSceneBindings('level/main', ['player', 'player']);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'scene-binding-duplicate',
        expected: expect.stringContaining('unique'),
        hint: expect.stringContaining('rename'),
        detail: { sceneSourceKey: 'level/main', bindingKey: 'player' },
      },
    });
  });

  it('keeps binding identity stable when the display name or source path changes', () => {
    const ref = sceneEntity('level/main', 'player');
    const result = resolveSceneEntity(ref, {
      sceneSourceKey: 'level/main',
      bindings: new Map([['player', 11]]),
    });

    expect(result).toEqual({ ok: true, value: 11 });
    expect(ref).not.toHaveProperty('name');
    expect(ref).not.toHaveProperty('path');
  });

  it('preserves scene source and binding metadata through decode and externalization', async () => {
    const envelope = {
      guid: '00000000-0000-0000-0000-000000000021',
      kind: 'scene',
      payload: {
        kind: 'scene' as const,
        sourceKey: 'world/main',
        entities: [{ localId: 0, bindingKey: 'player', components: {} }],
      },
      refs: [],
      artifacts: {},
    } as unknown as Parameters<typeof sceneAssetDecoder.decode>[0]['envelope'];
    const decoded = await sceneAssetDecoder.decode({
      envelope,
      artifacts: { read: async () => ok(new Uint8Array()) },
      signal: new AbortController().signal,
    });
    expect(decoded).toMatchObject({
      ok: true,
      value: {
        sourceKey: 'world/main',
        entities: [{ bindingKey: 'player' }],
      },
    });
    if (!decoded.ok) return;

    const externalized = externalizeSceneAsset(decoded.value, () => ({}));
    expect(externalized).toMatchObject({
      ok: true,
      value: {
        payload: {
          sourceKey: 'world/main',
          entities: [{ bindingKey: 'player' }],
        },
      },
    });
  });
});
