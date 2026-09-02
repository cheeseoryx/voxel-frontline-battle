/**
 * feel-config.js — Baked feel defaults (KEEP on production).
 *
 * Workflow:
 *   1. Open game, press F10 (feel-tuner.js must be loaded)
 *   2. Tweak sliders → Export → overwrite this file
 *   3. Ship: delete feel-tuner.js + its <script> in index.html
 *      Keep this file. Game never reads localStorage for feel without tuner.
 *
 * Saved from local tuner draft (Edge vf_feel_draft).
 */
(function (global) {
  'use strict';
  global.VF = global.VF || {};

  global.VF.Feel = {
  view: {
    pitchMul: 0.55,
    velMul: 22,
    yawMul: 0.34,
    adsRecoilMul: 0.4,
    settleRemain: 0.25,
    idleDelay: 0.15,
    fireSpring: 10,
    fireDamp: 8,
    recoverSpring: 40,
    recoverDamp: 13,
    pitchCap: 0.16,
    pitchFloor: -0.02,
    yawCap: 0.06
  },
  gun: {
    kickMul: 3.4,
    kickMax: 0.85,
    velMul: 38,
    spring: 180,
    damp: 11,
    posePitch: 1.65,
    poseRoll: 0.12,
    poseY: 0.05,
    poseZ: 0.06,
    kickFloor: -0.04,
    kickCeil: 0.5
  },
  shake: {
    max: 0.48,
    decay: 16,
    fireBase: 0.01,
    fireRecoilMul: 0.12,
    axisY: 0.7,
    axisZ: 0.5
  },
  hit: {
    shake: 0.05,
    shakeDmg: 0.0018,
    shakeDmgCap: 0.07,
    heavyExtra: 0.04,
    pitch: 0.004,
    heavyPitch: 0.009,
    fov: -1.5,
    heavyFov: -2.5
  },
  kill: {
    shake: 0.14,
    pitch: 0.016,
    fov: -2.5
  },
  hurt: {
    shakeBase: 0.008,
    shakeDmg: 0.0003,
    shakeMax: 0.016,
    fovBase: 0.15,
    fovDmg: 0.004,
    fovMax: 0.3,
    pitchBase: 0.0006,
    pitchDmg: 0.00004,
    pitchDmgCap: 0.001,
    yawBase: 0.0008,
    yawDmg: 0.00004,
    yawDmgCap: 0.0012,
    yawRandom: 0.0015,
    flashMs: 180
  },
  camera: {
    hipFov: 70,
    adsFov: 48,
    mouseSens: 0.0022,
    adsSens: 0.0011
  },
  weapons: {
    ar: {
      verticalRecoil: 1.29,
      horizontalRecoil: 0.7,
      accuracy: 73.33,
      fireRate: 600
    },
    sg: {
      verticalRecoil: 3.54,
      horizontalRecoil: 1.9,
      accuracy: 16.67,
      fireRate: 75
    }
  },
  crosshair: {
    fireMs: 160,
    hitMs: 170,
    killMs: 280
  },
  ai: {
    teamSize: 32,
    speedMul: 1,
    hpMul: 1,
    damageMul: 0.85,
    fireRateMul: 1,
    accuracyMul: 1.15
  },
  playerMove: {
    moveSpeed: 8.5,
    sprintMul: 1.5,
    crouchMul: 0.48,
    adsMul: 0.55
  },
  conquest: {
    tickets: 1000,
    roundSec: 2700,
    bleedInterval: 3,
    sweepSec: 60,
    neutralizeSec: 18,
    captureSec: 18,
    captureMaxPlayers: 4,
    captureExtraSpeed: 0.28,
    emptyRecoveryMul: 0.35,
    deployCombatLockSec: 8,
    deployEnemyRadius: 20,
    spawnProtectionSec: 1.5
  },
  revive: {
    bleedSec: 28,
    squadReviveSec: 4.5,
    supportReviveSec: 2.6,
    reviveHealth: 35,
    reviveRange: 2.5,
    protectionSec: 1.5,
    dragRange: 2.2
  }
};

  global.VF.FeelDefaults = JSON.parse(JSON.stringify(global.VF.Feel));
})(typeof window !== 'undefined' ? window : globalThis);
