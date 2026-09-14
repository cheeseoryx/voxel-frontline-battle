import type { EntityHandle } from '@forgeax/engine-ecs';
import type { MaterialPass } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { appendMaterialDispatchEntries, type DispatchEntry } from '../render-system-extract.js';

it('dispatches each Pass with its published program, including an Engine-authored shadow', () => {
  const passes: MaterialPass[] = [
    {
      name: 'Forward',
      program: { module: 'game::toon', vertexEntry: 'vs_main', fragmentEntry: 'fs_toon' },
    },
    {
      name: 'ShadowCaster',
      program: { module: 'forgeax::default-shadow-caster', vertexEntry: 'vs_shadow' },
      renderState: { tags: { LightMode: 'ShadowCaster' } },
    },
  ];
  const dispatch: DispatchEntry[] = [];
  appendMaterialDispatchEntries(dispatch, passes, 1 as EntityHandle, 7, 0, 0, { amount: 0 }, 0, {
    Forward: 'cooked-toon',
    ShadowCaster: 'cooked-shadow',
  });
  expect(
    dispatch.map((entry) => [entry.materialShaderId, entry.vertexEntry, entry.fragmentEntry]),
  ).toEqual([
    ['cooked-toon', 'vs_main', 'fs_toon'],
    ['cooked-shadow', 'vs_shadow', undefined],
  ]);
  expect(
    dispatch.every((entry) => entry.materialHandle === 7 && entry.paramSnapshot?.amount === 0),
  ).toBe(true);
});

it('refuses an incomplete published Pass map instead of using an authored shader', () => {
  expect(() =>
    appendMaterialDispatchEntries(
      [],
      [{ name: 'ShadowCaster', program: { module: 'forgeax::default-shadow-caster' } }],
      1 as EntityHandle,
      7,
      0,
      0,
      {},
      0,
      { Forward: 'cooked-toon' },
    ),
  ).toThrow('Missing published material program');
});
