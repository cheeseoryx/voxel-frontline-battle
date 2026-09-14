import type { EntityHandle, World } from '@forgeax/engine/ecs';
import { sceneEntity, worldResolveSceneEntity } from '@forgeax/engine/scene';

type SceneHost = NonNullable<import('@forgeax/engine/app').GameHost>;
type GameBindingKey =
  | 'camera'
  | 'player'
  | 'point-light'
  | 'skylight'
  | 'sky-background'
  | 'sun'
  | `player/joint/${string}`;

const GAME_SCENE_SOURCE_KEY = 'scene/showcase' as const;

/** Resolve an instance-relative authored binding without consulting display names. */
export function resolveGameEntity(world: World, host: SceneHost, bindingKey: GameBindingKey): EntityHandle {
  if (host.defaultSceneRoot === undefined) {
    throw new Error(`game-3d default scene is unavailable for binding ${bindingKey}`);
  }
  const resolved = worldResolveSceneEntity(
    world,
    host.defaultSceneRoot,
    sceneEntity(GAME_SCENE_SOURCE_KEY, bindingKey),
  );
  if (!resolved.ok) throw resolved.error;
  return resolved.value;
}
