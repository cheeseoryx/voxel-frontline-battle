import { createApp } from '@forgeax/engine-app';
import { Time, Update } from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import {
  Camera,
  BLOOM_ENABLED,
  DirectionalLight,
  ANTIALIAS_TAA,
  Materials,
  MeshFilter,
  MeshRenderer,
  MotionBlur,
  TONEMAP_ACES_FILMIC,
  perspective,
} from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
const inspection = document.querySelector<HTMLElement>('#inspection');
const pauseToggle = document.querySelector<HTMLButtonElement>('#pause-toggle');
const motionBlurToggle = document.querySelector<HTMLButtonElement>('#motion-blur-toggle');
const shutterAngleInput = document.querySelector<HTMLInputElement>('#shutter-angle');
const shutterAngleValue = document.querySelector<HTMLOutputElement>('#shutter-angle-value');
const controlStatus = document.querySelector<HTMLElement>('#control-status');
const visualCase = new URLSearchParams(location.search).get('taa-case') ?? 'moving-rigid';
const lightweightSmoke = new URLSearchParams(location.search).get('taa-profile') === 'ci';
const isStaticCase = visualCase === 'static' || visualCase === 'reactive';
const isCameraPanCase = visualCase === 'camera-pan';
if (
  canvas === null ||
  inspection === null ||
  pauseToggle === null ||
  motionBlurToggle === null ||
  shutterAngleInput === null ||
  shutterAngleValue === null ||
  controlStatus === null
)
  throw new Error('TAA carrier elements are missing');

if (lightweightSmoke) {
  // The CI falsifier only needs a visible compositor witness. Keep the normal
  // 1920x1080 canvas for the standalone browser smoke and real demo path.
  canvas.width = 256;
  canvas.height = 144;
  canvas.style.width = '256px';
  canvas.style.height = '144px';
}

const created = await createApp(canvas, {}, forgeaxBundlerAdapter());
if (!created.ok) throw created.error;
const app = created.value;

// The upper row is a sharp, stationary reference. The lower row is the same
// high-contrast pattern with renderer-owned motion blur. Keeping both rows in
// one frame makes the blur readable without changing the production effect.
const cameraPanBarLayout = [
  { offset: -1.2, color: [0.95, 0.95, 0.95, 1] as const, scaleX: 0.12 },
  { offset: -0.9, color: [0.04, 0.04, 0.04, 1] as const, scaleX: 0.12 },
  { offset: -0.6, color: [0.95, 0.95, 0.95, 1] as const, scaleX: 0.12 },
  { offset: -0.3, color: [0.04, 0.04, 0.04, 1] as const, scaleX: 0.12 },
  { offset: 0, color: [0.95, 0.95, 0.95, 1] as const, scaleX: 0.12 },
  { offset: 0.3, color: [0.04, 0.04, 0.04, 1] as const, scaleX: 0.12 },
  { offset: 0.6, color: [0.95, 0.95, 0.95, 1] as const, scaleX: 0.12 },
  { offset: 0.9, color: [0.04, 0.04, 0.04, 1] as const, scaleX: 0.12 },
  { offset: 1.2, color: [0.95, 0.95, 0.95, 1] as const, scaleX: 0.12 },
] as const;
const barLayout = isCameraPanCase
  ? cameraPanBarLayout
  : [
  { offset: -0.5, color: [0.95, 0.12, 0.1, 1] as const },
  { offset: 0, color: [0.1, 0.85, 0.2, 1] as const },
  { offset: 0.5, color: [0.1, 0.25, 0.95, 1] as const },
] as const;
const caseColor = (color: readonly [number, number, number, number]) =>
  [color[0], color[1], color[2], visualCase === 'reactive' ? 0.6 : color[3]] as const;

const spawnBar = (
  offset: number,
  y: number,
  color: readonly [number, number, number, number],
  z = 0,
  scaleX = 0.5,
) => {
  const material = app.world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit(color),
  );
  const entity = app.world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [offset, y, z],
          quat: [0, 0, 0, 1],
          // The three half-unit faces touch edge-to-edge. A temporal sample
          // can therefore cross the high-contrast colour boundaries without
          // being rejected as a background-depth sample.
          scale: [scaleX, 0.45, 1],
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  return entity;
};

barLayout.forEach(({ offset, color, ...layout }) => {
  spawnBar(offset, 0.8, caseColor(color), 0, 'scaleX' in layout ? layout.scaleX : 0.5);
});
const motionBars = barLayout.map(({ offset, color }) => ({
  entity: spawnBar(
    offset,
    -0.8,
    caseColor(color),
    visualCase === 'depth-edge' && offset === 0.5 ? 0.65 : 0,
    'scaleX' in barLayout[0] ? 0.12 : 0.5,
  ),
  offset,
}));

app.world
  .spawn({
    component: DirectionalLight,
    data: {
      direction: [-0.4, -0.6, -0.7],
      color: [1, 1, 1],
      intensity: 1.2,
      castShadow: true,
      ...(lightweightSmoke ? { cascadeCount: 1, mapSize: 64 } : {}),
    },
  })
  .unwrap();

const cameraEntity = app.world
  .spawn(
    { component: Transform, data: { pos: [0, 0, 2.5], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 3, aspect: 16 / 9 }),
        antialias: ANTIALIAS_TAA,
        ...(visualCase === 'taa-motion-blur-bloom'
          ? {
              tonemap: TONEMAP_ACES_FILMIC,
              bloom: BLOOM_ENABLED,
              bloomThreshold: 0.7,
              bloomIntensity: 0.35,
              bloomBlurRadius: 4,
            }
          : {}),
      },
    },
    {
      component: MotionBlur,
      data: {
        shutterAngle: 180,
        maxRadiusPixels: lightweightSmoke ? 8 : 24,
        sampleCount: lightweightSmoke ? 4 : 12,
      },
    },
  )
  .unwrap();

let appPaused = false;
let motionBlurEnabled = true;
let shutterAngle = Number(shutterAngleInput.value);
const maxRadiusPixels = lightweightSmoke ? 8 : 24;
const sampleCount = lightweightSmoke ? 4 : 12;

const motionBlurData = () => ({ shutterAngle, maxRadiusPixels, sampleCount });

const readMotionBlurParams = () => {
  const result = app.world.get(cameraEntity, MotionBlur);
  if (!result.ok) return undefined;
  return result.value;
};

const updateControlLabels = () => {
  pauseToggle.textContent = appPaused ? 'Resume' : 'Pause';
  pauseToggle.setAttribute('aria-pressed', String(appPaused));
  motionBlurToggle.textContent = `Motion Blur: ${motionBlurEnabled ? 'On' : 'Off'}`;
  motionBlurToggle.setAttribute('aria-pressed', String(motionBlurEnabled));
  shutterAngleValue.textContent = `${shutterAngle}°`;
  controlStatus.textContent = `${appPaused ? 'Paused' : 'Running'} | Motion Blur ${motionBlurEnabled ? 'On' : 'Off'} | Shutter ${shutterAngle}°`;
};

pauseToggle.addEventListener('click', () => {
  const result = appPaused ? app.resume() : app.pause();
  if (!result.ok) {
    console.error(`[hello-taa] could not ${appPaused ? 'resume' : 'pause'} App: ${result.error.code}`);
    return;
  }
  appPaused = !appPaused;
  updateControlLabels();
  updateInspection();
});

motionBlurToggle.addEventListener('click', () => {
  const nextEnabled = !motionBlurEnabled;
  const result = nextEnabled
    ? app.world.addComponent(cameraEntity, {
        component: MotionBlur,
        data: motionBlurData(),
      })
    : app.world.removeComponent(cameraEntity, MotionBlur);
  if (!result.ok) {
    console.error(`[hello-taa] could not toggle Motion Blur: ${result.error.code}`);
    return;
  }
  motionBlurEnabled = nextEnabled;
  updateControlLabels();
  updateInspection();
});

shutterAngleInput.addEventListener('input', () => {
  shutterAngle = Number(shutterAngleInput.value);
  if (motionBlurEnabled) {
    const result = app.world.set(cameraEntity, MotionBlur, motionBlurData());
    if (!result.ok) {
      console.error(`[hello-taa] could not update Motion Blur: ${result.error.code}`);
      return;
    }
  }
  updateControlLabels();
  updateInspection();
});

// A dt-based speed keeps the comparison stable across refresh rates. At 60 Hz
// this is about 0.12 world units (roughly 14–18 canvas pixels) per frame: a
// readable streak rather than a full-frame jump. The motion is deliberately
// authored in the scene so the renderer's temporal producer is the only
// history owner.
let horizontalPosition = 0;
let horizontalDirection = 1;
const motionSpeedUnitsPerSecond = 7.2;
let visualFrame = 0;
app.world
  .addSystem(Update, {
    name: 'taa-carrier-horizontal-motion',
    queries: [],
    fn: (world) => {
      const deltaSeconds = Math.min(world.getResource(Time).delta, 1 / 20);
      visualFrame += 1;
      if (visualCase === 'cut-reset' && visualFrame === 90) horizontalPosition = -1.1;
      if (!isStaticCase) {
        horizontalPosition += horizontalDirection * motionSpeedUnitsPerSecond * deltaSeconds;
      }
      if (horizontalPosition >= 1.25 || horizontalPosition <= -1.25) {
        horizontalDirection *= -1;
        horizontalPosition = Math.max(-1.25, Math.min(1.25, horizontalPosition));
      }
      if (isCameraPanCase) {
        app.world.set(cameraEntity, Transform, {
          pos: [horizontalPosition * 0.35, 0, 2.5],
        });
      } else {
        for (const { entity, offset } of motionBars) {
          app.world.set(entity, Transform, {
            pos: [horizontalPosition + offset, -0.8, visualCase === 'depth-edge' && offset === 0.5 ? 0.65 : 0],
          });
        }
      }
    },
  })
  .unwrap();

const updateInspection = () => {
  const renderInspection = app.renderer.inspect();
  const motionBlurParams = readMotionBlurParams();
  inspection.textContent = JSON.stringify({
    paused: appPaused,
    antialias: 'taa',
    backend: renderInspection.capabilities.backendKind,
    capabilities: {
      compute: renderInspection.capabilities.compute,
      storageBuffer: renderInspection.capabilities.storageBuffer,
      rgba16floatRenderable: renderInspection.capabilities.rgba16floatRenderable,
    },
    frame: renderInspection.frame,
    temporal:
      renderInspection.temporal === undefined
        ? null
        : {
            status: renderInspection.temporal.status,
            historyValid: renderInspection.temporal.historyValid,
            historyAttempt: renderInspection.temporal.historyAttempt,
            epoch: renderInspection.temporal.epoch,
          },
    temporalTarget: renderInspection.temporalTarget ?? null,
    motionBlur: {
      enabled: motionBlurParams !== undefined && motionBlurParams.shutterAngle > 0,
      shutterAngle: motionBlurParams?.shutterAngle ?? 0,
      maxRadiusPixels: motionBlurParams?.maxRadiusPixels ?? 0,
      sampleCount: motionBlurParams?.sampleCount ?? 0,
      demoMotionSpeed: `${motionSpeedUnitsPerSecond} world units/s (dt-based)`,
      status: motionBlurEnabled ? (renderInspection.motionBlur?.status ?? null) : 'off',
      temporalDemand: motionBlurEnabled
        ? (renderInspection.motionBlur?.temporalDemand ?? null)
        : null,
      historyWrites: renderInspection.motionBlur?.historyWrites ?? 0,
    },
    scene: {
      fullRebuilds: renderInspection.renderScene.fullRebuilds,
      deltaFrames: renderInspection.renderScene.deltaFrames,
      transformUpdates: renderInspection.renderScene.transformUpdates,
      projectionRecords: renderInspection.renderScene.projectionRecords,
      lastResyncReason: renderInspection.renderScene.lastResyncReason ?? null,
    },
    passes: renderInspection.perFramePassNames,
  });
};

app.renderer.subscribe((event) => {
  if (event.kind === 'error') {
    const detail = 'detail' in event.error ? event.error.detail : undefined;
    const detailText = detail === undefined ? '' : ` ${JSON.stringify(detail)}`;
    console.error(`[hello-taa] renderer error ${event.error.code}${detailText}`);
  }
  if (event.kind === 'frame-submitted') updateInspection();
});

// The initial snapshot is intentionally allowed to have no frame passes; the
// frame-submitted listener above replaces it with the first real trace.
updateInspection();
updateControlLabels();
app.start().unwrap();
