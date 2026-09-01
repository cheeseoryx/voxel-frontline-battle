/**
 * render-scene.js — Config-driven sky, sun and ambient lighting.
 *
 * These are NOT post-processing passes: they are real scene objects, so they
 * must be synced BEFORE renderer.render(). Kept separate from
 * render-pipeline.js for that reason.
 *
 * The sky is a procedural gradient dome (handwritten shader, no HDRI asset):
 * zenith -> horizon -> ground, plus a sun disk and halo whose position is
 * driven by the same azimuth/elevation that aims the DirectionalLight, so
 * moving the sun moves both the light and the visible sun together.
 *
 * The dome renders with depthWrite off at a low renderOrder, so it always
 * sits behind the world without needing a huge radius.
 */
(function (global) {
  'use strict';

  global.VF = global.VF || {};

  const SKY_VERT = `
varying vec3 vWorld;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

  const SKY_FRAG = `
uniform vec3 zenithColor;
uniform vec3 horizonColor;
uniform vec3 groundColor;
uniform vec3 sunDirection;
uniform vec3 sunColor;
uniform float sunSize;
uniform float sunIntensity;
uniform float haloFalloff;
uniform float horizonSharpness;
uniform sampler2D hdri;
uniform float useHdri;
uniform float hdriIntensity;
uniform float hdriRotation;
varying vec3 vWorld;

#define VF_PI 3.14159265359

void main() {
  vec3 dir = normalize(vWorld);

  if (useHdri > 0.5) {
    // equirectangular lookup; hdriRotation (radians) spins the map around Y.
    // Done here rather than via scene.background because r160 has no
    // scene.backgroundRotation and its background shader ignores tex.offset.
    float u = atan(dir.z, dir.x) + hdriRotation;
    u = u / (2.0 * VF_PI) + 0.5;
    float v = asin(clamp(dir.y, -1.0, 1.0)) / VF_PI + 0.5;
    vec3 c = texture2D(hdri, vec2(fract(u), clamp(v, 0.0, 1.0))).rgb;
    gl_FragColor = vec4(c * hdriIntensity, 1.0);
    return;
  }

  // vertical gradient; h<0 is below the horizon
  float h = dir.y;
  vec3 sky = mix(horizonColor, zenithColor, pow(clamp(h, 0.0, 1.0), horizonSharpness));
  vec3 col = mix(sky, groundColor, smoothstep(0.0, -0.08, h));

  float cosA = dot(dir, normalize(sunDirection));

  // broad atmospheric halo around the sun
  float halo = pow(max(cosA, 0.0), max(haloFalloff, 1.0));
  col += sunColor * halo * 0.35 * sunIntensity;

  // sun disk — sunSize is an angular radius in degrees
  float cosR = cos(radians(max(sunSize, 0.01)));
  float disk = smoothstep(cosR - 0.0015, cosR + 0.0015, cosA);
  col += sunColor * disk * sunIntensity * 3.0;

  gl_FragColor = vec4(col, 1.0);
}
`;

  function toColor(hex, fallback) {
    try {
      return new THREE.Color(hex == null ? fallback : hex);
    } catch (e) {
      return new THREE.Color(fallback);
    }
  }

  // azimuth/elevation (degrees) -> unit direction pointing FROM origin TO sun
  function sunDirectionFrom(azimuthDeg, elevationDeg, out) {
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const cosEl = Math.cos(el);
    return out.set(cosEl * Math.sin(az), Math.sin(el), cosEl * Math.cos(az)).normalize();
  }
  // shared with VolumetricFogPass so fog shafts match the sky's sun exactly
  global.VF.sunDirectionFrom = sunDirectionFrom;

  function RenderScene(scene) {
    this.scene = scene;
    this._sunDir = new THREE.Vector3(0, 1, 0);

    // HDRI state — see loadSkyTexture()
    this._hdri = { url: null, texture: null, envMap: null, status: 'idle', error: null };
    this._pmrem = null;

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 20),
      new THREE.ShaderMaterial({
        uniforms: {
          zenithColor: { value: new THREE.Color(0x2f6ba8) },
          horizonColor: { value: new THREE.Color(0xbcd6ea) },
          groundColor: { value: new THREE.Color(0x36342f) },
          sunDirection: { value: new THREE.Vector3(0, 1, 0) },
          sunColor: { value: new THREE.Color(0xfff2cc) },
          sunSize: { value: 2.5 },
          sunIntensity: { value: 1.0 },
          haloFalloff: { value: 24 },
          horizonSharpness: { value: 0.55 },
          hdri: { value: null },
          useHdri: { value: 0 },
          hdriIntensity: { value: 1 },
          hdriRotation: { value: 0 },
        },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
      })
    );
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    // keeps the dome centered on the viewer so it can never be walked out of
    this.sky.onBeforeRender = function (renderer, scene, camera) {
      this.position.copy(camera.position);
      this.scale.setScalar(Math.max(1, camera.far * 0.5));
    };
    scene.add(this.sky);

    this.ambient = new THREE.HemisphereLight(0xbcd6ea, 0x36342f, 0.6);
    scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(0xfff2cc, 1.05);
    this.sun.castShadow = false;
    scene.add(this.sun);

    this.fill = new THREE.DirectionalLight(0x5a8ac8, 0.25);
    this.fill.position.set(40, 20, -30);
    scene.add(this.fill);
  }

  /**
   * Load an equirectangular HDRI as the skybox.
   *
   * Supported: .exr (EXRLoader), .hdr (RGBELoader), and LDR .jpg/.png/.webp
   * via TextureLoader. Async and idempotent — calling it again with the same
   * URL is a no-op, so sync() can call it every frame safely.
   *
   * `useAsEnvironment` also runs the texture through PMREMGenerator and sets
   * scene.environment, so PBR materials pick up image-based lighting.
   */
  RenderScene.prototype.loadSkyTexture = function (url, useAsEnvironment, force) {
    const self = this;
    if (!url) {
      this._disposeHdri();
      this._hdri.url = null;
      this._hdri.status = 'idle';
      this._hdri.error = null;
      return;
    }
    // Idempotent: sync() calls this every frame, so a URL we already resolved
    // (or already failed on) must not kick off another request. Without the
    // 'error' case here a bad path retries every frame and floods the console.
    // Pass force=true to deliberately re-attempt the same URL.
    if (this._hdri.url === url && !force) return;

    this._disposeHdri();
    this._hdri.url = url;
    this._hdri.status = 'loading';
    this._hdri.error = null;

    // Extension decides the loader. Split off query AND hash first — the
    // tuner's local-file preview appends "#.exr" to a blob: URL precisely so
    // the real format survives (blob URLs carry no filename).
    const clean = String(url).split('?')[0];
    const hash = clean.indexOf('#') >= 0 ? clean.slice(clean.indexOf('#') + 1) : '';
    const forExt = hash && hash.indexOf('.') >= 0 ? hash : clean.split('#')[0];
    const ext = forExt.split('.').pop().toLowerCase();
    let loader;
    if (ext === 'exr') {
      if (!THREE.EXRLoader) {
        this._failHdri('EXRLoader 不可用（需要重新构建 three bundle）');
        return;
      }
      loader = new THREE.EXRLoader();
    } else if (ext === 'hdr') {
      if (!THREE.RGBELoader) {
        this._failHdri('RGBELoader 不可用（需要重新构建 three bundle）');
        return;
      }
      loader = new THREE.RGBELoader();
    } else {
      loader = new THREE.TextureLoader();
    }

    loader.load(
      url,
      function (tex) {
        // Ignore a load that finished after the user switched files.
        if (self._hdri.url !== url) {
          tex.dispose();
          return;
        }
        tex.mapping = THREE.EquirectangularReflectionMapping;
        // EXR/HDR are already linear; LDR files need sRGB decode.
        tex.colorSpace = ext === 'exr' || ext === 'hdr' ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
        self._hdri.texture = tex;
        self._hdri.status = 'loaded';

        if (useAsEnvironment) self._buildEnvironment(tex);
        console.log('[VF] skybox loaded: ' + url);
      },
      undefined,
      function (err) {
        if (self._hdri.url !== url) return;
        self._failHdri((err && (err.message || err.type)) || '加载失败');
      }
    );
  };

  RenderScene.prototype._failHdri = function (msg) {
    this._hdri.status = 'error';
    this._hdri.error = String(msg);
    console.warn('[VF] skybox load failed: ' + this._hdri.error + ' — 回退到程序化天空');
  };

  RenderScene.prototype._buildEnvironment = function (tex) {
    try {
      if (!this._pmrem) {
        const renderer = global.VF.game && global.VF.game.renderer;
        if (!renderer) return;
        this._pmrem = new THREE.PMREMGenerator(renderer);
      }
      const env = this._pmrem.fromEquirectangular(tex);
      this._hdri.envMap = env.texture;
    } catch (e) {
      console.warn('[VF] environment map build failed', e);
    }
  };

  RenderScene.prototype._disposeHdri = function () {
    if (this._hdri.texture) {
      this._hdri.texture.dispose();
      this._hdri.texture = null;
    }
    if (this._hdri.envMap) {
      this._hdri.envMap.dispose();
      this._hdri.envMap = null;
    }
    if (this.scene.environment) this.scene.environment = null;
  };

  RenderScene.prototype.getSkyStatus = function () {
    return {
      url: this._hdri.url,
      status: this._hdri.status,
      error: this._hdri.error,
      active: !!this._hdri.texture,
    };
  };

  /** Push RenderConfig into the scene objects. Cheap enough to run per frame. */
  RenderScene.prototype.sync = function () {
    const root = global.VF.RenderConfig || {};
    const L = root.lighting || {};
    const S = root.sky || {};
    const F = root.fog || {};

    const azimuth = typeof L.sunAzimuth === 'number' ? L.sunAzimuth : 135;
    const elevation = typeof L.sunElevation === 'number' ? L.sunElevation : 42;
    const dir = sunDirectionFrom(azimuth, elevation, this._sunDir);

    const sunColor = toColor(L.sunColor, 0xfff2cc);
    const sunIntensity = typeof L.sunIntensity === 'number' ? L.sunIntensity : 1.05;

    // DirectionalLight shines from its position toward its target (origin).
    this.sun.position.copy(dir).multiplyScalar(400);
    this.sun.color.copy(sunColor);
    this.sun.intensity = sunIntensity;

    const skyTop = toColor(S.zenithColor, 0x2f6ba8);
    const skyHorizon = toColor(S.horizonColor, 0xbcd6ea);
    const skyGround = toColor(S.groundColor, 0x36342f);

    this.ambient.color.copy(toColor(L.ambientSkyColor, 0xbcd6ea));
    this.ambient.groundColor.copy(toColor(L.ambientGroundColor, 0x36342f));
    this.ambient.intensity = typeof L.ambientIntensity === 'number' ? L.ambientIntensity : 0.6;

    this.fill.color.copy(toColor(L.fillColor, 0x5a8ac8));
    this.fill.intensity = typeof L.fillIntensity === 'number' ? L.fillIntensity : 0.25;

    const su = this.sky.material.uniforms;
    su.zenithColor.value.copy(skyTop);
    su.horizonColor.value.copy(skyHorizon);
    su.groundColor.value.copy(skyGround);
    su.sunDirection.value.copy(dir);
    su.sunColor.value.copy(sunColor);
    su.sunSize.value = typeof S.sunSize === 'number' ? S.sunSize : 2.5;
    su.sunIntensity.value = typeof S.sunIntensity === 'number' ? S.sunIntensity : 1.0;
    su.haloFalloff.value = typeof S.haloFalloff === 'number' ? S.haloFalloff : 24;
    su.horizonSharpness.value =
      typeof S.horizonSharpness === 'number' ? S.horizonSharpness : 0.55;

    // ---- HDRI skybox ----
    // An imported EXR/HDR is drawn by our OWN dome shader rather than being
    // handed to scene.background: r160 has no scene.backgroundRotation and its
    // internal background shader ignores texture.offset, so routing it through
    // the dome is the only way to support rotation. While the file is still
    // loading (or if it failed) the dome falls back to the procedural gradient,
    // so the sky is never black.
    this.loadSkyTexture(S.hdriUrl || null, S.hdriAsEnvironment !== false);
    const hdriTex = this._hdri.texture;
    const useHdri = S.enabled !== false && !!hdriTex;

    this.sky.visible = S.enabled !== false;
    su.hdri.value = hdriTex || null;
    su.useHdri.value = useHdri ? 1 : 0;
    su.hdriIntensity.value = typeof S.hdriIntensity === 'number' ? S.hdriIntensity : 1.0;
    su.hdriRotation.value = THREE.MathUtils.degToRad(
      typeof S.hdriRotation === 'number' ? S.hdriRotation : 0
    );

    if (useHdri) {
      this.scene.environment = S.hdriAsEnvironment !== false ? this._hdri.envMap : null;
      this.scene.environmentIntensity =
        typeof S.hdriEnvIntensity === 'number' ? S.hdriEnvIntensity : 1.0;
    } else {
      this.scene.environment = null;
    }

    // The dome covers the whole view, so background colour is only a fallback
    // for the frame before the dome draws. Keep it matched to the horizon.
    if (this.scene.background && this.scene.background.isColor) {
      this.scene.background.copy(skyHorizon);
    } else {
      this.scene.background = skyHorizon.clone();
    }

    // Distance fog tinted to the horizon so it blends into the sky.
    if (F.enabled === false) {
      this.scene.fog = null;
    } else {
      const near = typeof F.near === 'number' ? F.near : 220;
      const far = typeof F.far === 'number' ? F.far : 920;
      const fogColor = F.color != null ? toColor(F.color, 0xbcd6ea) : skyHorizon;
      if (!this.scene.fog || !this.scene.fog.isFog) {
        this.scene.fog = new THREE.Fog(fogColor.getHex(), near, far);
      }
      this.scene.fog.color.copy(fogColor);
      this.scene.fog.near = near;
      this.scene.fog.far = Math.max(far, near + 1);
    }
  };

  global.VF.createRenderScene = function (scene) {
    try {
      const rs = new RenderScene(scene);
      rs.sync();
      return rs;
    } catch (e) {
      console.warn('[VF] render scene init failed', e);
      return null;
    }
  };
})(typeof window !== 'undefined' ? window : this);
