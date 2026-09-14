import { type EntityHandle, Update, type World } from '@forgeax/engine-ecs';
import {
  FRAME_START_SCAN_SYSTEM_NAME,
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputSnapshot,
} from '@forgeax/engine-input';
import { quat } from '@forgeax/engine-math';
import { Camera, getActiveCamera, type Renderer, setActiveCamera } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

export interface AppObservation {
  readonly worldIdentity: string;
  readonly executionReport: () => unknown;
  readonly camera: { readonly get: () => unknown; readonly set: (value: unknown) => unknown };
  readonly focus: (value: unknown) => unknown;
  /** Re-assert the observation camera after all World systems and before draw. */
  readonly prepareFrame: () => void;
  /** Return control to the game camera and remove the transient observation camera. */
  readonly release: () => void;
}

function finiteVector(value: unknown, length: number): number[] | undefined {
  if (!Array.isArray(value) || value.length < length) return undefined;
  const vector = value.slice(0, length).map(Number);
  return vector.every(Number.isFinite) ? vector : undefined;
}

function jsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? String(value) : value;
  }
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, seen));
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const next = jsonValue(entry, seen);
      return next === undefined || typeof next === 'function' ? [] : [[key, next]];
    }),
  );
}

export function createAppObservation(
  world: World,
  renderer: Renderer,
  execution: { readonly report: () => unknown },
): AppObservation {
  void renderer;
  const observationSystem = 'app-observation-camera-ownership';
  const firstCameraEntity = (): EntityHandle | undefined => {
    const cameras = world.query({ with: [Camera, Transform] }).unwrap();
    for (const row of cameras) return row.entity as EntityHandle;
    return undefined;
  };
  const resolveGameCameraEntity = (): EntityHandle | undefined => {
    const active = getActiveCamera(world)?.entity as EntityHandle | undefined;
    if (active !== undefined && world.get(active, Camera).ok && world.get(active, Transform).ok) {
      return active;
    }
    // Rendering already falls back to the first camera when ActiveCamera is
    // absent. Observation must use the same rule so authored scene cameras
    // remain inspectable without a separate runtime selection resource.
    return firstCameraEntity();
  };
  let observationEntity: EntityHandle | undefined;
  let gameCameraEntity: EntityHandle | undefined = resolveGameCameraEntity();
  let ownershipInstalled = false;

  const cameraValue = (entity: EntityHandle): Record<string, unknown> => {
    const value = world.get(entity, Camera);
    if (!value.ok) throw new Error('live-camera-invalid-entity: entity has no Camera');
    const json = jsonValue(value.value);
    if (json === null || typeof json !== 'object' || Array.isArray(json))
      throw new Error('live-camera-invalid-entity: Camera data is not serializable');
    return json as Record<string, unknown>;
  };

  const transformValue = (entity: EntityHandle): Record<string, unknown> => {
    const value = world.get(entity, Transform);
    if (!value.ok) throw new Error('live-camera-invalid-entity: entity has no Transform');
    return {
      pos: Array.from(value.value.pos),
      quat: Array.from(value.value.quat),
      scale: Array.from(value.value.scale),
    };
  };

  /**
   * Observation owns a runtime-only camera entity. Game camera entities are
   * never written by CLI or pointer controls; the last active game camera is
   * restored when the observation lease is released.
   */
  const acquire = (source: EntityHandle): EntityHandle => {
    installOwnershipSystem();
    if (!world.get(source, Camera).ok || !world.get(source, Transform).ok) {
      throw new Error('live-camera-invalid-entity: entity does not carry Camera and Transform');
    }
    gameCameraEntity ??= source;
    if (observationEntity !== undefined) {
      if (observationEntity !== source) {
        world.set(observationEntity, Camera, cameraValue(source) as never).unwrap();
        world.set(observationEntity, Transform, transformValue(source) as never).unwrap();
      }
      setActiveCamera(world, observationEntity);
      return observationEntity;
    }
    observationEntity = world
      .spawn(
        { component: Camera, data: cameraValue(source) as never },
        { component: Transform, data: transformValue(source) as never },
      )
      .unwrap();
    setActiveCamera(world, observationEntity);
    return observationEntity;
  };

  const release = (): void => {
    const current = observationEntity;
    observationEntity = undefined;
    if (current !== undefined) world.despawn(current).unwrap();
    gameCameraEntity ??= resolveGameCameraEntity();
    if (gameCameraEntity !== undefined && world.get(gameCameraEntity, Camera).ok) {
      setActiveCamera(world, gameCameraEntity);
    }
    if (ownershipInstalled) {
      world.removeSystem(Update, observationSystem);
      ownershipInstalled = false;
    }
  };

  // A game camera system may select its own camera every frame. Re-assert the
  // explicit observation handoff after the frozen input snapshot is produced,
  // and remove this lease-owned system when control returns to the game.
  function installOwnershipSystem(): void {
    if (ownershipInstalled) return;
    world
      .addSystem(Update, {
        name: observationSystem,
        queries: [],
        after: [FRAME_START_SCAN_SYSTEM_NAME],
        fn: () => {
          const active = observationEntity;
          if (active === undefined) return;
          const snapshot = world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)
            ? world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)
            : undefined;
          if (snapshot?.mouse.pointerLocked) {
            const transform = world.get(active, Transform);
            if (transform.ok) {
              const { x, y } = snapshot.mouse.movementDelta;
              const orientation = quat.rotateAxis(
                quat.create(),
                transform.value.quat,
                [0, 1, 0],
                -x * 0.003,
              );
              quat.rotateAxis(orientation, orientation, [1, 0, 0], -y * 0.003);
              world.set(active, Transform, { quat: orientation }).unwrap();
            }
          }
          setActiveCamera(world, active);
        },
      })
      .unwrap();
    ownershipInstalled = true;
  }

  installOwnershipSystem();

  const cameraState = (): {
    readonly entity: number;
    readonly transform: unknown;
    readonly camera: unknown;
  } => {
    const active = resolveGameCameraEntity();
    if (active === undefined)
      throw new Error('live-camera-unavailable: no active camera is selected');
    const entity = active as EntityHandle;
    const camera = world.get(entity, Camera);
    const transform = world.get(entity, Transform);
    if (!camera.ok || !transform.ok)
      throw new Error('live-camera-unavailable: active entity is not a camera');
    return {
      entity: active,
      camera: jsonValue(camera.value),
      transform: {
        pos: Array.from(transform.value.pos),
        quat: Array.from(transform.value.quat),
        scale: Array.from(transform.value.scale),
      },
    };
  };
  const setCamera = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object')
      throw new TypeError('camera.set expects an object');
    const candidate = value as {
      readonly entity?: unknown;
      readonly position?: unknown;
      readonly target?: unknown;
      readonly up?: unknown;
    };
    if (!Number.isSafeInteger(candidate.entity))
      throw new TypeError('camera.set expects an integer entity');
    const entity = candidate.entity as EntityHandle;
    if (!world.get(entity, Camera).ok || !world.get(entity, Transform).ok) {
      throw new Error('live-camera-invalid-entity: entity does not carry Camera and Transform');
    }
    const observed = acquire(entity);
    const position = finiteVector(candidate.position, 3);
    const target = finiteVector(candidate.target, 3);
    const up = finiteVector(candidate.up, 3);
    const orientation =
      position !== undefined && target !== undefined
        ? quat.fromLookAt(
            quat.create(),
            position as [number, number, number],
            target as [number, number, number],
            (up ?? [0, 1, 0]) as [number, number, number],
          )
        : undefined;
    if (position !== undefined || orientation !== undefined) {
      world
        .set(observed, Transform, {
          ...(position === undefined ? {} : { pos: position as [number, number, number] }),
          ...(orientation === undefined ? {} : { quat: orientation }),
        })
        .unwrap();
    }
    return cameraState();
  };
  return {
    worldIdentity: world.identity,
    executionReport: () => execution.report(),
    camera: { get: cameraState, set: setCamera },
    prepareFrame() {
      if (observationEntity !== undefined) setActiveCamera(world, observationEntity);
    },
    focus(value) {
      if (value === null || typeof value !== 'object')
        throw new TypeError('focus expects an object');
      const candidate = value as {
        readonly entity?: unknown;
        readonly camera?: unknown;
        readonly distance?: unknown;
        readonly target?: unknown;
        readonly up?: unknown;
        readonly position?: unknown;
      };
      if (!Number.isSafeInteger(candidate.entity))
        throw new TypeError('focus expects an integer entity');
      const target = world.get(candidate.entity as EntityHandle, Transform);
      if (!target.ok) throw new Error('live-focus-invalid-entity: target has no Transform');
      const cameraEntity = Number.isSafeInteger(candidate.camera)
        ? (candidate.camera as EntityHandle)
        : resolveGameCameraEntity();
      if (cameraEntity === undefined)
        throw new Error('live-camera-unavailable: no active camera is selected');
      if (!world.get(cameraEntity, Camera).ok || !world.get(cameraEntity, Transform).ok)
        throw new Error('live-camera-invalid-entity: selected entity has no Camera');
      const observed = acquire(cameraEntity);
      const distance =
        typeof candidate.distance === 'number' && Number.isFinite(candidate.distance)
          ? Math.max(0.01, candidate.distance)
          : 5;
      const targetPosition =
        finiteVector(candidate.target, 3) ?? Array.from(target.value.pos).slice(0, 3);
      const position =
        finiteVector(candidate.position, 3) ??
        ([targetPosition[0] ?? 0, targetPosition[1] ?? 0, (targetPosition[2] ?? 0) + distance] as [
          number,
          number,
          number,
        ]);
      const up = finiteVector(candidate.up, 3) ?? [0, 1, 0];
      const orientation = quat.fromLookAt(
        quat.create(),
        position,
        targetPosition as [number, number, number],
        up as [number, number, number],
      );
      world.set(observed, Transform, { pos: position, quat: orientation }).unwrap();
      return cameraState();
    },
    release,
  };
}
