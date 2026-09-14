import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareDecodedRgb, validateMotionBlurTrace } from '../smoke-browser-observations.mjs';

const script = readFileSync(fileURLToPath(new URL('../smoke-browser.mjs', import.meta.url)), 'utf8');
const dawnScript = readFileSync(fileURLToPath(new URL('../smoke-dawn.mjs', import.meta.url)), 'utf8');
const mainScript = readFileSync(fileURLToPath(new URL('../../src/main.ts', import.meta.url)), 'utf8');

test('browser smoke keeps the 300-frame floor and bounded 180-second wait', () => {
  assert.match(script, /const FRAME_FLOOR = 300;/);
  assert.match(script, /const FALSIFIER_FRAME_FLOOR = 60;/);
  assert.match(script, /SMOKE_BROWSER_WAIT_MS \?\? '180000'/);
});

test('CI falsifier browser carrier lowers its viewport and opts into the app profile', () => {
  assert.match(script, /FORGEAX_TAA_FALSIFIER_PROFILE === 'ci'/);
  assert.match(script, /const viewport = falsifierLightweight \? \{ width: 320, height: 180 \}/);
  assert.match(script, /taa-profile=ci/);
  assert.match(script, /requiredFrames}-frame inspection/);
  assert.match(mainScript, /taa-profile/);
  assert.match(mainScript, /canvas\.width = 256/);
  assert.match(mainScript, /canvas\.height = 144/);
  assert.match(mainScript, /castShadow: true/);
  assert.match(mainScript, /cascadeCount: 1, mapSize: 64/);
  assert.match(mainScript, /sampleCount: lightweightSmoke \? 4 : 12/);
});

test('camera-pan requires a real on/off ROI difference in both carriers', () => {
  assert.match(script, /'camera-pan'/);
  assert.match(dawnScript, /\['moving-rigid', 'camera-pan'\]\.includes\(visualCase\)/);
});

test('camera-pan uses dense static stripes and moves only the camera transform', () => {
  assert.match(mainScript, /const cameraPanBarLayout = \[/);
  assert.match(mainScript, /scaleX: 0\.12/);
  assert.match(mainScript, /const barLayout = isCameraPanCase\s*\?\s*cameraPanBarLayout/);
  assert.match(mainScript, /if \(isCameraPanCase\) \{[\s\S]*app\.world\.set\(cameraEntity, Transform/);
});

test('motion difference compares decoded RGB when coarse aggregates collide', () => {
  const left = {
    sha256: 'png-left',
    pixels: { width: 2, height: 2, rgbHash: 'rgb-left', nonBlack: 4, bottomStddevLuma: 0.5 },
  };
  const right = {
    sha256: 'png-right',
    pixels: { width: 2, height: 2, rgbHash: 'rgb-right', nonBlack: 4, bottomStddevLuma: 0.5 },
  };
  assert.equal(compareDecodedRgb(left, right).ok, true);
});

test('metadata-only PNG differences do not pass a decoded RGB comparison', () => {
  const left = { sha256: 'png-metadata-left', pixels: { width: 2, height: 2, rgbHash: 'same-rgb' } };
  const right = { sha256: 'png-metadata-right', pixels: { width: 2, height: 2, rgbHash: 'same-rgb' } };
  assert.deepEqual(compareDecodedRgb(left, right), {
    ok: false,
    reason: 'decoded-rgb-identical',
    dimensionsMatch: true,
    hashesPresent: true,
    decodedRgbEqual: true,
    pngHashesEqual: false,
  });
});

test('motion blur trace requires on semantics and accepts either legal off pass shape', () => {
  const onState = {
    motionBlur: { enabled: true, status: 'active', temporalDemand: 'scene-data-temporal-v1' },
    passes: ['motion-blur', 'output-transform'],
  };
  const offState = { motionBlur: { enabled: false, status: 'off', temporalDemand: null }, passes: ['output-transform'] };
  const offStateWithStablePassIdentity = {
    ...offState,
    passes: ['motion-blur', 'output-transform'],
  };
  assert.equal(validateMotionBlurTrace(onState, 'on').ok, true);
  assert.equal(validateMotionBlurTrace({ ...onState, passes: ['output-transform'] }, 'on').ok, false);
  assert.equal(validateMotionBlurTrace(offState, 'off').ok, true);
  assert.equal(validateMotionBlurTrace(offStateWithStablePassIdentity, 'off').ok, true);
  assert.equal(
    validateMotionBlurTrace(
      { ...offState, motionBlur: { ...offState.motionBlur, temporalDemand: 'scene-data-temporal-v1' } },
      'off',
    ).ok,
    false,
  );
});
