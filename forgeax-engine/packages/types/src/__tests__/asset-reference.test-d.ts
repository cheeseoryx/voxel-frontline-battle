import { describe, expectTypeOf, it } from 'vitest';
import type { AssetRef, SceneEntityRef } from '../asset-reference.js';
import type { SceneEntity } from '../index.js';

describe('generated asset and scene reference vocabulary', () => {
  it('narrows an AssetRef by its author kind', () => {
    expectTypeOf<AssetRef<'mesh'>['kind']>().toEqualTypeOf<'mesh'>();
    expectTypeOf<AssetRef<'mesh'>['sourceKey']>().toEqualTypeOf<string>();
    expectTypeOf<AssetRef<'mesh'>['guid']>().toEqualTypeOf<string>();
  });

  it('keeps SceneEntityRef in the scene-instance identity domain', () => {
    expectTypeOf<SceneEntityRef['sceneSourceKey']>().toEqualTypeOf<string>();
    expectTypeOf<SceneEntityRef['bindingKey']>().toEqualTypeOf<string>();
  });

  it('requires a stable bindingKey on authored scene entities', () => {
    expectTypeOf<NonNullable<SceneEntity['bindingKey']>>().toEqualTypeOf<string>();
  });

  it('does not expose path or display-name identity', () => {
    expectTypeOf<AssetRef<'mesh'>>().not.toHaveProperty('path');
    expectTypeOf<AssetRef<'mesh'>>().not.toHaveProperty('name');
    expectTypeOf<SceneEntityRef>().not.toHaveProperty('name');
  });
});
