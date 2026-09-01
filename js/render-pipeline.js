/**
 * render-pipeline.js — Handwritten post-processing Composer.
 *
 * No three/examples/jsm/postprocessing (project has no build step / module
 * loader). Ping-pong WebGLRenderTargets + a shared fullscreen triangle +
 * plain ShaderMaterial passes, in the same constructor/prototype style as
 * the rest of js/.
 *
 * COLOR SPACE (important):
 *   three.js only injects its linear->sRGB encode into its OWN materials. A
 *   hand-written ShaderMaterial gets no encode, so a pass writing to the
 *   canvas must do it itself or the image comes out far too dark (measured:
 *   linear 0.216 written raw shows up as 55/255 instead of 128/255).
 *   Therefore: the scene and every intermediate buffer stay LINEAR, and
 *   OutputPass — always last, never skippable — does exposure + tonemap +
 *   sRGB encode. Passes after OutputPass would be in display space; none are.
 *
 * Pass order (mirrors UE: fog and bloom in HDR, grading after the tonemapper):
 *   scene -> VolumetricFog -> Bloom -> Output(exposure/tonemap/encode)
 *         -> ColorGrade -> Vignette -> Film -> screen
 *
 * BUFFERS: the scene renders into its own _sceneRT (which owns the depth
 * texture) and post passes ping-pong between _rtA/_rtB. The scene buffer is
 * deliberately never a ping-pong target: a pass rendering into it would let
 * autoClear wipe the depth texture that VolumetricFog reconstructs from.
 *
 * Pass contract (duck-typed, no base class):
 *   {
 *     configKey: string | null,   // RenderConfig section gating `enabled`
 *     alwaysOn: boolean,          // ignores configKey, cannot be skipped
 *     setSize(w, h),
 *     render(renderer, readBuffer, writeBuffer, dt, ctx)
 *   }
 * ctx = { depthTexture, camera } for passes that need scene depth.
 * writeBuffer is null when the pass is the last active one — it must then
 * render straight to the screen (renderer.setRenderTarget(null)).
 */
(function (global) {
  'use strict';

  global.VF = global.VF || {};

  // ---- shared fullscreen triangle (avoids the diagonal seam of a quad) ----
  let _triGeo = null;
  let _triCam = null;
  function getFullscreenTriangle() {
    if (!_triGeo) {
      _triGeo = new THREE.BufferGeometry();
      _triGeo.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
      );
      _triGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
      _triCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }
    return { geo: _triGeo, cam: _triCam };
  }

  const PASS_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

  // sRGB transfer function — what three.js would have injected for us.
  const SRGB_ENCODE = `
vec3 vfLinearToSRGB(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}
`;

  function makePassMesh(fragmentShader, uniforms, blending) {
    const tri = getFullscreenTriangle();
    const mat = new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: PASS_VERT,
      fragmentShader: fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    if (blending != null) {
      mat.blending = blending;
      mat.transparent = true;
    }
    const mesh = new THREE.Mesh(tri.geo, mat);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    return { mesh: mesh, scene: scene, uniforms: mat.uniforms };
  }

  function drawPass(renderer, pass, target) {
    renderer.setRenderTarget(target || null);
    renderer.render(pass.scene, getFullscreenTriangle().cam);
  }

  // Scene + intermediates are linear HDR (half-float) so bloom thresholds
  // above 1.0 are meaningful instead of being clipped by an 8-bit buffer.
  function makeRenderTarget(w, h, type) {
    return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      format: THREE.RGBAFormat,
      type: type || THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
    });
  }

  function cfgOf(key, fallback) {
    const root = global.VF.RenderConfig || {};
    return (key ? root[key] : root) || fallback || {};
  }
  function num(v, d) {
    return typeof v === 'number' && isFinite(v) ? v : d;
  }

  // Scene buffer additionally owns a depth texture so depth-driven passes
  // (volumetric fog) can reconstruct world position per pixel.
  function makeSceneRenderTarget(w, h) {
    const rt = makeRenderTarget(w, h);
    rt.depthTexture = new THREE.DepthTexture(Math.max(1, w), Math.max(1, h));
    rt.depthTexture.format = THREE.DepthFormat;
    rt.depthTexture.type = THREE.UnsignedIntType;
    rt.depthTexture.minFilter = THREE.NearestFilter;
    rt.depthTexture.magFilter = THREE.NearestFilter;
    return rt;
  }

  // =====================================================================
  // VolumetricFogPass — raymarched exponential height fog with sun
  // in-scattering. Reconstructs world position from the scene depth
  // texture, then marches camera->surface accumulating scattering and
  // transmittance. Runs in linear HDR, before bloom, so fog shafts bloom.
  // =====================================================================
  const FOG_FRAG = `
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform mat4 invProjection;
uniform mat4 camWorld;
uniform vec3 camPos;
uniform float cameraNear;
uniform float cameraFar;
uniform float density;
uniform float heightFalloff;
uniform float baseHeight;
uniform float maxDistance;
uniform int steps;
uniform vec3 fogColor;
uniform vec3 sunColor;
uniform vec3 sunDir;
uniform float anisotropy;
uniform float sunStrength;
uniform float noiseScale;
uniform float noiseStrength;
uniform vec3 windOffset;
varying vec2 vUv;

float hash13(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

// Henyey-Greenstein: g>0 forward scatter (bright halo toward the sun)
float hgPhase(float c, float g) {
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * c;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(d, 1e-4), 1.5));
}

float densityAt(vec3 p) {
  float d = density * exp(-max(p.y - baseHeight, 0.0) * heightFalloff);
  if (noiseStrength > 0.0) {
    float n = vnoise(p * noiseScale + windOffset);
    d *= mix(1.0, n, clamp(noiseStrength, 0.0, 1.0));
  }
  return max(d, 0.0);
}

void main() {
  vec4 src = texture2D(tDiffuse, vUv);
  float dRaw = texture2D(tDepth, vUv).x;

  // depth -> world position via inverse projection
  vec4 clip = vec4(vUv * 2.0 - 1.0, dRaw * 2.0 - 1.0, 1.0);
  vec4 vpos = invProjection * clip;
  vpos /= vpos.w;
  vec3 world = (camWorld * vpos).xyz;

  vec3 ray = world - camPos;
  float sceneDist = length(ray);
  vec3 dir = sceneDist > 1e-5 ? ray / sceneDist : vec3(0.0, 0.0, -1.0);

  // no geometry (sky) -> march the full configured range instead of to the far plane
  bool isSky = dRaw >= 0.999999;
  float march = isSky ? maxDistance : min(sceneDist, maxDistance);
  if (march <= 0.0) {
    gl_FragColor = src;
    return;
  }

  int n = steps;
  if (n < 4) n = 4;
  float stepLen = march / float(n);

  // jittered start kills the banding a fixed step pattern produces
  float jitter = hash13(vec3(gl_FragCoord.xy, 0.0));
  float t = stepLen * jitter;

  float cosT = dot(dir, normalize(sunDir));
  float phase = hgPhase(cosT, clamp(anisotropy, -0.9, 0.9));
  vec3 inscatterLight = fogColor + sunColor * sunStrength * phase;

  vec3 scatter = vec3(0.0);
  float trans = 1.0;

  for (int i = 0; i < 128; i++) {
    if (i >= n) break;
    if (trans < 0.003) break;
    vec3 p = camPos + dir * t;
    float dd = densityAt(p) * stepLen;
    if (dd > 0.0) {
      scatter += trans * dd * inscatterLight;
      trans *= exp(-dd);
    }
    t += stepLen;
  }

  gl_FragColor = vec4(src.rgb * trans + scatter, src.a);
}
`;

  function VolumetricFogPass() {
    this.configKey = 'volumetricFog';
    this.alwaysOn = false;
    this._wind = new THREE.Vector3();
    this._sunDir = new THREE.Vector3(0, 1, 0);
    this._time = 0;
    this._p = makePassMesh(FOG_FRAG, {
      tDiffuse: { value: null },
      tDepth: { value: null },
      invProjection: { value: new THREE.Matrix4() },
      camWorld: { value: new THREE.Matrix4() },
      camPos: { value: new THREE.Vector3() },
      cameraNear: { value: 0.1 },
      cameraFar: { value: 1000 },
      density: { value: 0.012 },
      heightFalloff: { value: 0.035 },
      baseHeight: { value: 8 },
      maxDistance: { value: 600 },
      steps: { value: 24 },
      fogColor: { value: new THREE.Color(0x9fb8cc) },
      sunColor: { value: new THREE.Color(0xfff2cc) },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      anisotropy: { value: 0.6 },
      sunStrength: { value: 6 },
      noiseScale: { value: 0.012 },
      noiseStrength: { value: 0.35 },
      windOffset: { value: new THREE.Vector3() },
    });
  }
  VolumetricFogPass.prototype.setSize = function () {};
  VolumetricFogPass.prototype.render = function (renderer, readBuffer, writeBuffer, dt, ctx) {
    const c = cfgOf('volumetricFog');
    const L = cfgOf('lighting');
    const u = this._p.uniforms;
    const camera = ctx && ctx.camera;
    const depth = ctx && ctx.depthTexture;

    // Without depth we cannot reconstruct position — pass through untouched
    // rather than drawing garbage.
    if (!camera || !depth) {
      this._p.uniforms.tDiffuse.value = readBuffer.texture;
      copyThrough(renderer, readBuffer, writeBuffer);
      return;
    }

    this._time += num(dt, 0.016);
    const windSpeed = num(c.windSpeed, 0.6);
    this._wind.set(this._time * windSpeed, this._time * windSpeed * 0.15, this._time * windSpeed * 0.5);

    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = depth;
    u.invProjection.value.copy(camera.projectionMatrixInverse);
    u.camWorld.value.copy(camera.matrixWorld);
    u.camPos.value.setFromMatrixPosition(camera.matrixWorld);
    u.cameraNear.value = camera.near;
    u.cameraFar.value = camera.far;

    u.density.value = num(c.density, 0.012);
    u.heightFalloff.value = num(c.heightFalloff, 0.035);
    u.baseHeight.value = num(c.baseHeight, 8);
    u.maxDistance.value = num(c.maxDistance, 600);
    u.steps.value = Math.max(4, Math.min(128, Math.round(num(c.steps, 24))));
    u.anisotropy.value = num(c.anisotropy, 0.6);
    u.sunStrength.value = num(c.sunStrength, 6);
    u.noiseScale.value = num(c.noiseScale, 0.012);
    u.noiseStrength.value = num(c.noiseStrength, 0.35);
    u.windOffset.value.copy(this._wind);

    setColorUniform(u.fogColor.value, c.color, 0x9fb8cc);
    // sun colour/direction come from the lighting section so fog shafts stay
    // consistent with the sky and the DirectionalLight
    setColorUniform(u.sunColor.value, L.sunColor, 0xfff2cc);
    if (global.VF.sunDirectionFrom) {
      global.VF.sunDirectionFrom(
        typeof L.sunAzimuth === 'number' ? L.sunAzimuth : 135,
        typeof L.sunElevation === 'number' ? L.sunElevation : 42,
        this._sunDir
      );
    }
    u.sunDir.value.copy(this._sunDir);

    drawPass(renderer, this._p, writeBuffer);
  };
  global.VF.VolumetricFogPass = VolumetricFogPass;

  function setColorUniform(target, value, fallback) {
    try {
      target.set(value == null ? fallback : value);
    } catch (e) {
      target.set(fallback);
    }
  }

  // shared passthrough used when a pass has to bail out
  let _copyMesh = null;
  function copyThrough(renderer, readBuffer, writeBuffer) {
    if (!_copyMesh) {
      _copyMesh = makePassMesh(
        'uniform sampler2D tDiffuse;\nvarying vec2 vUv;\nvoid main(){ gl_FragColor = texture2D(tDiffuse, vUv); }\n',
        { tDiffuse: { value: null } }
      );
    }
    _copyMesh.uniforms.tDiffuse.value = readBuffer.texture;
    drawPass(renderer, _copyMesh, writeBuffer);
  }

  // =====================================================================
  // BloomPass — threshold + progressive down/upsample (tent filter) chain.
  // Same approach as modern engines: no separate blur pass, the mip chain
  // and a widening tent filter do the work. Operates in linear HDR.
  // =====================================================================
  const BLOOM_MIPS = 5;

  const BLOOM_PREFILTER_FRAG = `
uniform sampler2D tDiffuse;
uniform float threshold;
uniform float softKnee;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float br = max(c.r, max(c.g, c.b));
  // soft knee so highlights ramp in instead of popping at the threshold
  float knee = threshold * softKnee + 1e-5;
  float soft = clamp(br - threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float w = max(soft, br - threshold) / max(br, 1e-5);
  gl_FragColor = vec4(c * w, 1.0);
}
`;

  const BLOOM_DOWN_FRAG = `
uniform sampler2D tDiffuse;
uniform vec2 texel;
varying vec2 vUv;
void main() {
  // 4-tap bilinear box: each tap sits on a texel corner of the source level
  vec3 s = texture2D(tDiffuse, vUv + texel * vec2(-1.0, -1.0)).rgb;
  s += texture2D(tDiffuse, vUv + texel * vec2( 1.0, -1.0)).rgb;
  s += texture2D(tDiffuse, vUv + texel * vec2(-1.0,  1.0)).rgb;
  s += texture2D(tDiffuse, vUv + texel * vec2( 1.0,  1.0)).rgb;
  gl_FragColor = vec4(s * 0.25, 1.0);
}
`;

  const BLOOM_UP_FRAG = `
uniform sampler2D tDiffuse;
uniform vec2 texel;
uniform float radius;
varying vec2 vUv;
void main() {
  // 9-tap tent filter; radius widens the glow
  vec2 d = texel * radius;
  vec3 s = texture2D(tDiffuse, vUv + vec2(-d.x,  d.y)).rgb;
  s += texture2D(tDiffuse, vUv + vec2( 0.0,  d.y)).rgb * 2.0;
  s += texture2D(tDiffuse, vUv + vec2( d.x,  d.y)).rgb;
  s += texture2D(tDiffuse, vUv + vec2(-d.x,  0.0)).rgb * 2.0;
  s += texture2D(tDiffuse, vUv).rgb * 4.0;
  s += texture2D(tDiffuse, vUv + vec2( d.x,  0.0)).rgb * 2.0;
  s += texture2D(tDiffuse, vUv + vec2(-d.x, -d.y)).rgb;
  s += texture2D(tDiffuse, vUv + vec2( 0.0, -d.y)).rgb * 2.0;
  s += texture2D(tDiffuse, vUv + vec2( d.x, -d.y)).rgb;
  gl_FragColor = vec4(s * (1.0 / 16.0), 1.0);
}
`;

  const BLOOM_COMBINE_FRAG = `
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform float intensity;
varying vec2 vUv;
void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  gl_FragColor = vec4(base.rgb + bloom * intensity, base.a);
}
`;

  function BloomPass(w, h) {
    this.configKey = 'bloom';
    this.alwaysOn = false;
    this._mips = [];
    this._prefilter = makePassMesh(BLOOM_PREFILTER_FRAG, {
      tDiffuse: { value: null },
      threshold: { value: 1.0 },
      softKnee: { value: 0.5 },
    });
    this._down = makePassMesh(BLOOM_DOWN_FRAG, {
      tDiffuse: { value: null },
      texel: { value: new THREE.Vector2() },
    });
    // additive so the upsample accumulates onto the coarser level in place
    this._up = makePassMesh(
      BLOOM_UP_FRAG,
      {
        tDiffuse: { value: null },
        texel: { value: new THREE.Vector2() },
        radius: { value: 1.0 },
      },
      THREE.AdditiveBlending
    );
    this._combine = makePassMesh(BLOOM_COMBINE_FRAG, {
      tDiffuse: { value: null },
      tBloom: { value: null },
      intensity: { value: 0.6 },
    });
    this.setSize(w, h);
  }

  BloomPass.prototype.setSize = function (w, h) {
    for (let i = 0; i < BLOOM_MIPS; i++) {
      const s = Math.pow(2, i + 1);
      const mw = Math.max(1, Math.floor(w / s));
      const mh = Math.max(1, Math.floor(h / s));
      if (this._mips[i]) this._mips[i].setSize(mw, mh);
      else this._mips[i] = makeRenderTarget(mw, mh);
    }
  };

  BloomPass.prototype.render = function (renderer, readBuffer, writeBuffer) {
    const c = cfgOf('bloom');
    const mips = this._mips;

    this._prefilter.uniforms.tDiffuse.value = readBuffer.texture;
    this._prefilter.uniforms.threshold.value = num(c.threshold, 1.0);
    this._prefilter.uniforms.softKnee.value = num(c.softKnee, 0.5);
    drawPass(renderer, this._prefilter, mips[0]);

    for (let i = 1; i < mips.length; i++) {
      const src = mips[i - 1];
      this._down.uniforms.tDiffuse.value = src.texture;
      this._down.uniforms.texel.value.set(1 / src.width, 1 / src.height);
      drawPass(renderer, this._down, mips[i]);
    }

    // Additive upsample must not wipe the destination it is accumulating into.
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    this._up.uniforms.radius.value = num(c.radius, 0.6) * 2.0;
    for (let i = mips.length - 1; i > 0; i--) {
      const src = mips[i];
      this._up.uniforms.tDiffuse.value = src.texture;
      this._up.uniforms.texel.value.set(1 / src.width, 1 / src.height);
      drawPass(renderer, this._up, mips[i - 1]);
    }
    renderer.autoClear = prevAutoClear;

    this._combine.uniforms.tDiffuse.value = readBuffer.texture;
    this._combine.uniforms.tBloom.value = mips[0].texture;
    this._combine.uniforms.intensity.value = num(c.intensity, 0.6);
    drawPass(renderer, this._combine, writeBuffer);
  };
  global.VF.BloomPass = BloomPass;

  // =====================================================================
  // OutputPass — exposure + tonemap + sRGB encode. ALWAYS LAST, never off.
  // Everything upstream is linear; everything downstream is display space.
  // =====================================================================
  const OUTPUT_FRAG = `
uniform sampler2D tDiffuse;
uniform float exposure;
uniform int mode;
varying vec2 vUv;
${SRGB_ENCODE}
vec3 tmReinhard(vec3 x) { return x / (1.0 + x); }
vec3 tmACES(vec3 x) {
  // Narkowicz 2015 ACES filmic approximation
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
  vec4 src = texture2D(tDiffuse, vUv);
  vec3 c = src.rgb * exposure;
  if (mode == 1) c = tmReinhard(c);
  else if (mode == 2) c = tmACES(c);
  else c = clamp(c, 0.0, 1.0);
  gl_FragColor = vec4(vfLinearToSRGB(c), src.a);
}
`;

  const TONEMAP_MODES = { none: 0, reinhard: 1, aces: 2 };

  function OutputPass() {
    this.configKey = 'toneMapping';
    this.alwaysOn = true;
    const p = makePassMesh(OUTPUT_FRAG, {
      tDiffuse: { value: null },
      exposure: { value: 1.0 },
      mode: { value: 2 },
    });
    this._p = p;
  }
  OutputPass.prototype.setSize = function () {};
  OutputPass.prototype.render = function (renderer, readBuffer, writeBuffer) {
    const c = cfgOf('toneMapping');
    const u = this._p.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.exposure.value = num(c.exposure, 1.0);
    const m = TONEMAP_MODES[c.mode];
    u.mode.value = m == null ? 2 : m;
    drawPass(renderer, this._p, writeBuffer);
  };
  global.VF.OutputPass = OutputPass;

  // =====================================================================
  // ColorGradePass — display-space saturation / contrast / temperature.
  // =====================================================================
  const COLORGRADE_FRAG = `
uniform sampler2D tDiffuse;
uniform float saturation;
uniform float contrast;
uniform float temperature;
uniform float tint;
uniform float lift;
uniform float gain;
varying vec2 vUv;
void main() {
  vec4 src = texture2D(tDiffuse, vUv);
  vec3 c = src.rgb;

  // white balance: warm/cool on the R/B axis, green/magenta on tint
  c.r *= 1.0 + temperature;
  c.b *= 1.0 - temperature;
  c.g *= 1.0 + tint;

  c = c * gain + lift;

  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, saturation);
  c = (c - 0.5) * contrast + 0.5;

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), src.a);
}
`;

  function ColorGradePass() {
    this.configKey = 'colorGrade';
    this.alwaysOn = false;
    this._p = makePassMesh(COLORGRADE_FRAG, {
      tDiffuse: { value: null },
      saturation: { value: 1.0 },
      contrast: { value: 1.0 },
      temperature: { value: 0.0 },
      tint: { value: 0.0 },
      lift: { value: 0.0 },
      gain: { value: 1.0 },
    });
  }
  ColorGradePass.prototype.setSize = function () {};
  ColorGradePass.prototype.render = function (renderer, readBuffer, writeBuffer) {
    const c = cfgOf('colorGrade');
    const u = this._p.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.saturation.value = num(c.saturation, 1.0);
    u.contrast.value = num(c.contrast, 1.0);
    u.temperature.value = num(c.temperature, 0.0);
    u.tint.value = num(c.tint, 0.0);
    u.lift.value = num(c.lift, 0.0);
    u.gain.value = num(c.gain, 1.0);
    drawPass(renderer, this._p, writeBuffer);
  };
  global.VF.ColorGradePass = ColorGradePass;

  // =====================================================================
  // VignettePass — radial darkening toward the frame edges.
  // =====================================================================
  const VIGNETTE_FRAG = `
uniform sampler2D tDiffuse;
uniform float intensity;
uniform float radius;
uniform float smoothness;
uniform float aspect;
varying vec2 vUv;
void main() {
  vec4 src = texture2D(tDiffuse, vUv);
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
  float d = length(p);
  float v = 1.0 - smoothstep(radius, radius + max(smoothness, 1e-4), d);
  gl_FragColor = vec4(src.rgb * mix(1.0, v, clamp(intensity, 0.0, 1.0)), src.a);
}
`;

  function VignettePass(w, h) {
    this.configKey = 'vignette';
    this.alwaysOn = false;
    this._p = makePassMesh(VIGNETTE_FRAG, {
      tDiffuse: { value: null },
      intensity: { value: 0.35 },
      radius: { value: 0.75 },
      smoothness: { value: 0.45 },
      aspect: { value: 1.0 },
    });
    this.setSize(w, h);
  }
  VignettePass.prototype.setSize = function (w, h) {
    if (w && h) this._p.uniforms.aspect.value = w / h;
  };
  VignettePass.prototype.render = function (renderer, readBuffer, writeBuffer) {
    const c = cfgOf('vignette');
    const u = this._p.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.intensity.value = num(c.intensity, 0.35);
    u.radius.value = num(c.radius, 0.75);
    u.smoothness.value = num(c.smoothness, 0.45);
    drawPass(renderer, this._p, writeBuffer);
  };
  global.VF.VignettePass = VignettePass;

  // =====================================================================
  // FilmPass — chromatic aberration + animated grain.
  // =====================================================================
  const FILM_FRAG = `
uniform sampler2D tDiffuse;
uniform float aberration;
uniform float grain;
uniform float time;
varying vec2 vUv;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
void main() {
  vec2 dir = vUv - 0.5;
  // aberration scales with distance from center, like a real lens
  vec2 off = dir * aberration;
  vec4 src = texture2D(tDiffuse, vUv);
  float r = texture2D(tDiffuse, vUv + off).r;
  float b = texture2D(tDiffuse, vUv - off).b;
  vec3 c = vec3(r, src.g, b);

  float n = hash(vUv * vec2(1024.0, 1024.0) + fract(time) * 137.0) - 0.5;
  c += n * grain;

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), src.a);
}
`;

  function FilmPass() {
    this.configKey = 'film';
    this.alwaysOn = false;
    this._time = 0;
    this._p = makePassMesh(FILM_FRAG, {
      tDiffuse: { value: null },
      aberration: { value: 0.0025 },
      grain: { value: 0.03 },
      time: { value: 0 },
    });
  }
  FilmPass.prototype.setSize = function () {};
  FilmPass.prototype.render = function (renderer, readBuffer, writeBuffer, dt) {
    const c = cfgOf('film');
    this._time += num(dt, 0.016);
    const u = this._p.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.aberration.value = num(c.aberration, 0.0025);
    u.grain.value = num(c.grain, 0.03);
    u.time.value = this._time;
    drawPass(renderer, this._p, writeBuffer);
  };
  global.VF.FilmPass = FilmPass;

  // =====================================================================
  // Composer
  // =====================================================================
  function Composer(renderer, w, h) {
    this.renderer = renderer;
    this.passes = [];
    // Scene target owns the depth texture and is never a ping-pong target.
    this._sceneRT = makeSceneRenderTarget(w, h);
    this._rtA = makeRenderTarget(w, h);
    this._rtB = makeRenderTarget(w, h);

    // Order matters: fog and bloom need linear HDR and run before OutputPass;
    // grading/vignette/film are display-space and run after it.
    this.addPass(new VolumetricFogPass());
    this.addPass(new BloomPass(w, h));
    this.addPass(new OutputPass());
    this.addPass(new ColorGradePass());
    this.addPass(new VignettePass(w, h));
    this.addPass(new FilmPass());
  }

  Composer.prototype.addPass = function (pass) {
    this.passes.push(pass);
  };

  Composer.prototype.setSize = function (w, h) {
    this._sceneRT.setSize(w, h);
    if (this._sceneRT.depthTexture) {
      // DepthTexture does not resize with the target in r160
      this._sceneRT.depthTexture.image.width = Math.max(1, w);
      this._sceneRT.depthTexture.image.height = Math.max(1, h);
      this._sceneRT.depthTexture.needsUpdate = true;
    }
    this._rtA.setSize(w, h);
    this._rtB.setSize(w, h);
    this.passes.forEach(function (p) {
      if (p.setSize) p.setSize(w, h);
    });
  };

  Composer.prototype._activePasses = function () {
    const out = [];
    for (let i = 0; i < this.passes.length; i++) {
      const p = this.passes[i];
      if (p.alwaysOn) {
        out.push(p);
        continue;
      }
      const c = p.configKey ? cfgOf(p.configKey) : null;
      if (!c || c.enabled !== false) out.push(p);
    }
    return out;
  };

  Composer.prototype.render = function (scene, camera, dt) {
    const renderer = this.renderer;
    const active = this._activePasses();

    // OutputPass is alwaysOn, so this only trips if the chain was emptied.
    if (active.length === 0) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }

    renderer.setRenderTarget(this._sceneRT);
    renderer.render(scene, camera);

    const ctx = { depthTexture: this._sceneRT.depthTexture, camera: camera };

    // First pass reads the scene buffer; later passes ping-pong A<->B so the
    // scene depth texture is never cleared out from under the fog pass.
    let read = this._sceneRT;
    let write = this._rtA;
    for (let i = 0; i < active.length; i++) {
      const isLast = i === active.length - 1;
      active[i].render(renderer, read, isLast ? null : write, dt, ctx);
      if (!isLast) {
        read = write;
        write = write === this._rtA ? this._rtB : this._rtA;
      }
    }
    renderer.setRenderTarget(null);
  };

  Composer.prototype.dispose = function () {
    this._sceneRT.dispose();
    this._rtA.dispose();
    this._rtB.dispose();
  };

  global.VF.createRenderPipeline = function (renderer, width, height) {
    try {
      return new Composer(renderer, width, height);
    } catch (e) {
      console.warn('[VF] render pipeline init failed, falling back to direct render', e);
      global.VF.RenderConfig = global.VF.RenderConfig || {};
      global.VF.RenderConfig.enabled = false;
      return null;
    }
  };
})(typeof window !== 'undefined' ? window : this);
