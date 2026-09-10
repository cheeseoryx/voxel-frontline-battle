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
    kickCeil: 0.5,
    equipRate: 3.2,
    equipDip: 0.32,
    equipPitch: 0.9
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
    adsFov: 52,
    mouseSens: 0.0022,
    adsSens: 0.0011,
    adsFovIn: 16,
    adsFovOut: 8,
    adsBlendIn: 14,
    adsBlendOut: 10,
    camRoll: 0.022,
    stairSmooth: 18
  },
  weapons: {
    ar: {
      recoil: 0.062,
      spread: 0.032,
      adsSpread: 0.01,
      fireRate: 0.1
    },
    sg: {
      recoil: 0.17,
      spread: 0.1,
      adsSpread: 0.06,
      fireRate: 0.8
    },
    sr: {
      recoil: 0.15,
      spread: 0.035,
      adsSpread: 0.001,
      fireRate: 0.95
    }
  },
  crosshair: {
    fireMs: 160,
    hitMs: 170,
    killMs: 280
  },
  ai: {
    teamSize: 25,
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
    adsMul: 0.55,
    slideMul: 1.35,
    slideDur: 0.45
  },
  airStrike: {
    size: 2.1,
    sizeVar: 0.65,
    stemH: 17,
    capR: 2.5,
    ringR: 3.4,
    life: 2.8,
    dust: 1,
    dustSize: 1,
    smoke: 1,
    carveR: 4.5,
    breakMax: 8,
    damageR: 6.2,
    shake: 0.05,
    shakeReach: 42
  }
};

  global.VF.FeelDefaults = JSON.parse(JSON.stringify(global.VF.Feel));
})(typeof window !== 'undefined' ? window : globalThis);
