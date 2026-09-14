import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { readRenderArrayView } from '@forgeax/engine-ecs/projection';
import { mat4, vec3 } from '@forgeax/engine-math';
import { GlobalTransform } from '@forgeax/engine-scene';
import {
  antialiasFromF32,
  bloomEnabledFromF32,
  Camera,
  cameraProjectionFromF32,
  tonemapFromF32,
} from '../components/camera';
import { MotionBlur } from '../components/motion-blur';
import type { CameraSnapshot } from '../render-contract';
import { getActiveCamera, selectActiveCameraIndex } from '../systems/active-camera';

function readWorldMatrix(world: World, entity: EntityHandle): Float32Array | undefined {
  const view = readRenderArrayView(world, entity, GlobalTransform, 'world');
  return view === undefined ? undefined : new Float32Array(view);
}

/** Extract the selected camera once at the frame boundary. */
export function extractCameraSnapshots(world: World): CameraSnapshot[] {
  const cameras: CameraSnapshot[] = [];
  const cameraEntities: number[] = [];
  const cameraQuery = world
    .query({ read: [Camera], optional: [MotionBlur], with: [GlobalTransform] })
    .unwrap();
  for (const row of cameraQuery) {
    const cam = row.get(Camera);
    const motionBlur = row.get(MotionBlur);
    const entity = row.entity as EntityHandle;
    const worldMat = readWorldMatrix(world, entity);
    if (worldMat === undefined) continue;
    cameras.push({
      entityKey: entity as number,
      historyVersion: cam.historyVersion,
      position: mat4.getTranslation(vec3.create(), worldMat),
      world: worldMat,
      fov: cam.fov,
      aspect: cam.aspect,
      near: cam.near,
      far: cam.far,
      projection: cameraProjectionFromF32(cam.projection),
      orthoLeft: cam.left,
      orthoRight: cam.right,
      orthoBottom: cam.bottom,
      orthoTop: cam.top,
      tonemap: tonemapFromF32(cam.tonemap),
      exposure: cam.exposure,
      whitePoint: cam.whitePoint,
      antialias: antialiasFromF32(cam.antialias),
      bloom: bloomEnabledFromF32(cam.bloom),
      bloomThreshold: cam.bloomThreshold,
      bloomIntensity: cam.bloomIntensity,
      bloomBlurRadius: cam.bloomBlurRadius,
      clearColor: [
        cam.clearColor[0] ?? 0,
        cam.clearColor[1] ?? 0,
        cam.clearColor[2] ?? 0,
        cam.clearColor[3] ?? 1,
      ],
      ...(motionBlur === undefined
        ? {}
        : {
            motionBlur: {
              shutterAngle: motionBlur.shutterAngle,
              maxRadiusPixels: motionBlur.maxRadiusPixels,
              sampleCount: motionBlur.sampleCount,
            },
          }),
    });
    cameraEntities.push(entity as number);
  }
  const selected = selectActiveCameraIndex(cameraEntities, getActiveCamera(world)?.entity);
  if (selected < 0) return cameras;
  const camera = cameras[selected];
  return camera === undefined ? cameras : [camera];
}
