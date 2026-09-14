import type { EntityHandle } from '@forgeax/engine-ecs';
import type { SceneEntityRef } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';

export type { SceneEntityRef } from '@forgeax/engine-types';

export type SceneBindingError = {
  readonly code: 'scene-binding-missing' | 'scene-binding-wrong-instance';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly sceneSourceKey: string; readonly bindingKey: string };
};

export type SceneBindingDeclarationError = {
  readonly code: 'scene-binding-duplicate' | 'scene-binding-source-missing';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly sceneSourceKey?: string; readonly bindingKey?: string };
};

export function validateSceneBindings(
  sceneSourceKey: string,
  bindingKeys: readonly string[],
): Result<readonly string[], SceneBindingDeclarationError> {
  if (sceneSourceKey.length === 0) {
    return err({
      code: 'scene-binding-source-missing',
      expected: 'a non-empty scene sourceKey',
      hint: 'declare the scene sourceKey in the author inventory',
      detail: {},
    });
  }
  const seen = new Set<string>();
  for (const bindingKey of bindingKeys) {
    if (bindingKey.length === 0 || seen.has(bindingKey)) {
      return err({
        code: 'scene-binding-duplicate',
        expected: 'unique non-empty bindingKey values within one scene',
        hint: 'rename the duplicate bindingKey in the scene producer',
        detail: { sceneSourceKey, bindingKey },
      });
    }
    seen.add(bindingKey);
  }
  return ok([...bindingKeys]);
}

export function sceneEntity(sceneSourceKey: string, bindingKey: string): SceneEntityRef {
  return { sceneSourceKey, bindingKey };
}

export function resolveSceneEntity(
  ref: SceneEntityRef,
  instance: {
    readonly sceneSourceKey: string;
    readonly bindings: ReadonlyMap<string, EntityHandle | number>;
  },
): Result<EntityHandle | number, SceneBindingError> {
  if (ref.sceneSourceKey !== instance.sceneSourceKey) {
    return err({
      code: 'scene-binding-wrong-instance',
      expected: `scene instance ${ref.sceneSourceKey}`,
      hint: 'resolve the SceneEntityRef against its owning SceneInstance',
      detail: { sceneSourceKey: ref.sceneSourceKey, bindingKey: ref.bindingKey },
    });
  }
  const value = instance.bindings.get(ref.bindingKey);
  if (value === undefined) {
    return err({
      code: 'scene-binding-missing',
      expected: 'bindingKey declared by the scene producer',
      hint: 'declare the bindingKey in the scene producer before consuming it',
      detail: { sceneSourceKey: ref.sceneSourceKey, bindingKey: ref.bindingKey },
    });
  }
  return ok(value);
}
