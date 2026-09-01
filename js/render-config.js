/**
 * render-config.js — Baked render defaults (KEEP on production).
 *
 * Every section mirrors a Pass in render-pipeline.js or a scene object in
 * render-scene.js. `enabled: false` on a section skips that effect entirely;
 * the top-level `enabled: false` bypasses the whole post chain.
 *
 * toneMapping has no `enabled` flag on purpose — OutputPass also performs the
 * sRGB encode, so it can never be switched off without breaking the image.
 *
 * Edit with the F9 tuner and use its Export button to regenerate this file.
 */
(function (global) {
  'use strict';
  global.VF = global.VF || {};

  global.VF.RenderConfig = {
    enabled: true,

    // --- post chain (linear HDR) ---
    // Raymarched height fog with sun in-scattering. Reads the scene depth
    // texture, so it runs before bloom (fog shafts then bloom).
    // density is deliberately light: this is a shooter, and fog thick enough
    // to look cinematic also hides enemies at mid range. Crank it per-map.
    volumetricFog: {
      enabled: true,
      density: 0.006,
      heightFalloff: 0.035,
      baseHeight: 6,
      maxDistance: 620,
      steps: 24,
      color: '#9fb8cc',
      anisotropy: 0.68,
      sunStrength: 5.5,
      noiseScale: 0.012,
      noiseStrength: 0.35,
      windSpeed: 0.6,
    },

    bloom: {
      enabled: true,
      threshold: 1.0,
      softKnee: 0.5,
      intensity: 0.45,
      radius: 0.7,
    },

    // --- tonemapper + sRGB encode (always on) ---
    toneMapping: {
      exposure: 1.0,
      mode: 'aces', // 'none' | 'reinhard' | 'aces'
    },

    // --- post chain (display space) ---
    colorGrade: {
      enabled: true,
      saturation: 1.06,
      contrast: 1.03,
      temperature: 0.0,
      tint: 0.0,
      lift: 0.0,
      gain: 1.0,
    },
    vignette: {
      enabled: true,
      intensity: 0.28,
      radius: 0.72,
      smoothness: 0.5,
    },
    film: {
      enabled: true,
      aberration: 0.0018,
      grain: 0.022,
    },

    // --- scene lighting ---
    lighting: {
      sunAzimuth: 135,
      sunElevation: 42,
      sunColor: '#fff2cc',
      sunIntensity: 1.05,
      ambientSkyColor: '#bcd6ea',
      ambientGroundColor: '#36342f',
      ambientIntensity: 0.6,
      fillColor: '#5a8ac8',
      fillIntensity: 0.25,
    },

    // --- sky: procedural dome, or an imported HDRI ---
    // Set hdriUrl to an .exr / .hdr / .jpg equirectangular panorama to replace
    // the procedural dome. Empty/null = procedural. While the file loads (or
    // if it fails) the dome keeps drawing, so the sky is never black.
    sky: {
      enabled: true,
      hdriUrl: '',
      hdriIntensity: 1.0,
      hdriRotation: 0,
      hdriAsEnvironment: true,
      hdriEnvIntensity: 1.0,
      zenithColor: '#2f6ba8',
      horizonColor: '#bcd6ea',
      groundColor: '#36342f',
      horizonSharpness: 0.55,
      sunSize: 2.5,
      sunIntensity: 1.0,
      haloFalloff: 24,
    },

    // --- linear distance fog (cheap; complements volumetricFog) ---
    fog: {
      enabled: true,
      near: 220,
      far: 920,
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
