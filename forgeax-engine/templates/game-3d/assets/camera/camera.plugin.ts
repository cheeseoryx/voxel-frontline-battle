import { Time, Update, type EntityHandle, type World } from '@forgeax/engine/ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { quat } from '@forgeax/engine/math';
import type { Plugin } from '@forgeax/engine/plugin';
import { Transform } from '@forgeax/engine/scene';
import type { Game3dPlayerService } from '../player/player.plugin.ts';
import {
  integratePointerLook,
  orbitPosition,
} from './third-person.ts';
import { resolveGameEntity } from '../shared/scene-refs.ts';

type SceneHost = NonNullable<import('@forgeax/engine/app').GameHost>;
const CAMERA_DISTANCE = 6.5;
const CAMERA_TARGET_HEIGHT = 0.5;
const CAMERA_FOLLOW = 10;

const cameraPlugin: Plugin = {
  name: 'game-3d/camera',
  inject: ['world', 'gameHost', 'game3dPlayer'],
  apply(ctx) {
    const host = ctx.gameHost;
    if (host === undefined) throw new Error('game-3d/camera requires the App-owned GameHost');
    const playerService = ctx.game3dPlayer as Game3dPlayerService | undefined;
    if (playerService === undefined) throw new Error('game-3d/camera requires the game-3d/player service');
    const player = playerService.entity;
    const camera = resolveGameEntity(ctx.world, host, 'camera');
    host.setPointerLockAllowed?.(true);
    ctx.world.addSystem(Update, {
      name: 'game-3d-camera',
      after: [],
      queries: [],
      fn: () => {
        const input = ctx.world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
        const dt = ctx.world.getResource(Time).delta;
        const playerTransform = ctx.world.get(player, Transform).unwrap();
        const rig = playerService.readRig();
        const look = input.mouse.pointerLocked
          ? integratePointerLook(rig.yaw, rig.pitch, input.mouse.movementDelta.x, input.mouse.movementDelta.y)
          : { yaw: rig.yaw, pitch: rig.pitch };
        const follow = 1 - Math.exp(-CAMERA_FOLLOW * dt);
        const focus = [
          rig.focusX + ((playerTransform.pos[0] ?? 0) - rig.focusX) * follow,
          rig.focusY + ((playerTransform.pos[1] ?? 0) + CAMERA_TARGET_HEIGHT - rig.focusY) * follow,
          rig.focusZ + ((playerTransform.pos[2] ?? 0) - rig.focusZ) * follow,
        ] as const;
        const position = orbitPosition(focus, look.yaw, look.pitch, CAMERA_DISTANCE);
        const rotation = quat.fromLookAt(quat.create(), position, focus, [0, 1, 0]);
        ctx.world.set(camera, Transform, {
          pos: position,
          quat: [rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0, rotation[3] ?? 1],
        }).unwrap();
        playerService.updateRig({
          yaw: look.yaw,
          pitch: look.pitch,
          focusX: focus[0],
          focusY: focus[1],
          focusZ: focus[2],
        });
      },
    }).unwrap();
    ctx.effect(function* () {
      yield () => host.setPointerLockAllowed?.(false);
      yield () => ctx.world.removeSystem(Update, 'game-3d-camera').unwrap();
    }, 'game-3d/camera');
  },
};

export default cameraPlugin;
