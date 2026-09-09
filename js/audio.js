/**
 * audio.js — Sample manifest router with spatial Web Audio and procedural fallback.
 */
(function (global) {
  'use strict';

  const MANIFEST_URL = 'assets/sfx/manifest.json?v=sfx4';
  const MAX_ACTIVE = 32;
  const LEGACY_IDS = {
    shoot_ar: 'weapon.ak74.fire',
    shoot_sg: 'weapon.profile.rifle762.fire',
    shoot_sr: 'weapon.profile.sniperheavy.fire',
    empty: 'weapon.mechanic.empty',
    reload_start: 'weapon.mechanic.reload_start',
    reload_mag: 'weapon.mechanic.reload_mag',
    reload_rack: 'weapon.mechanic.reload_rack',
    footstep: 'character.footstep.walk',
    jump: 'character.jump',
    land: 'character.land.soft',
    hurt: 'character.hurt',
    death: 'character.death',
    explosion: 'throwable.frag.detonate',
    tank_cannon_fire: 'vehicle.weapon.tank_cannon',
    tank_cannon_distant: 'vehicle.weapon.tank_cannon_far',
    tank_breech: 'vehicle.weapon.tank_breech',
    tank_armor_hit: 'vehicle.impact.armor',
    tank_ground_impact: 'vehicle.impact.ground',
    tank_structure_impact: 'vehicle.impact.structure',
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
  }

  function positionOf(value) {
    if (!value) return null;
    if (value.position) value = value.position;
    if (value.x == null || value.y == null || value.z == null) return null;
    return { x: Number(value.x) || 0, y: Number(value.y) || 0, z: Number(value.z) || 0 };
  }

  const AudioSys = {
    ctx: null,
    master: null,
    sfx: null,
    music: null,
    buses: null,
    enabled: true,
    musicAllowed: true,
    unlocked: false,
    manifest: null,
    manifestError: null,
    _manifestPromise: null,
    _buffers: null,
    _loads: null,
    _active: null,
    _loops: null,
    _loopPending: null,
    _vehicleStates: null,
    _listenerPosition: { x: 0, y: 0, z: 0 },
    _ambientNodes: null,
    _stepCd: 0,
    _lastLanded: true,
    _fallSpeed: 0,
    _uiClickCd: 0,
    _rumbleCd: 3,

    init() {
      try {
        if (localStorage.getItem('vf_audio_muted') === '1') this.enabled = false;
      } catch (_) {}
      this._buffers = new Map();
      this._loads = new Map();
      this._active = [];
      this._loops = new Map();
      this._loopPending = new Map();
      this._vehicleStates = new Map();
      this._loadManifest();
      const unlock = () => this.unlock();
      ['pointerdown', 'keydown', 'touchstart'].forEach((event) => {
        window.addEventListener(event, unlock, { once: true, passive: true });
      });
      this._syncMuteUi();
      this.bindUiClicks();
    },

    _loadManifest() {
      if (this._manifestPromise) return this._manifestPromise;
      this._manifestPromise = fetch(MANIFEST_URL, { cache: 'no-cache' })
        .then((response) => {
          if (!response.ok) throw new Error('manifest HTTP ' + response.status);
          return response.json();
        })
        .then((manifest) => {
          if (!manifest || !manifest.sounds) throw new Error('invalid manifest');
          this.manifest = manifest;
          this.manifestError = null;
          this._applyBusLevels();
          return manifest;
        })
        .catch((error) => {
          this.manifestError = error;
          console.warn('[Audio] sample manifest unavailable; using procedural fallback', error);
          return null;
        });
      return this._manifestPromise;
    },

    /** Resume AudioContext after a user gesture (required by Chrome/Edge). */
    unlock() {
      const ctx = this._ensure();
      if (!ctx) return Promise.resolve(false);
      const start = () => {
        this.unlocked = true;
        if (this.enabled) this._startMusic();
        this._flushQueue();
        return true;
      };
      if (ctx.state === 'suspended') return ctx.resume().then(start).catch(() => false);
      return Promise.resolve(start());
    },

    _ensure() {
      if (this.ctx) return this.ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      const ctx = (this.ctx = new AC());
      this.master = ctx.createGain();
      this.master.gain.value = this.enabled ? 1 : 0;
      this.master.connect(ctx.destination);

      this.sfx = ctx.createGain();
      this.sfx.gain.value = 0.9;
      this.sfx.connect(this.master);
      this.music = ctx.createGain();
      this.music.gain.value = 0.32;
      this.music.connect(this.master);

      this.buses = {};
      ['ui', 'weapons', 'characters', 'explosives', 'vehicles'].forEach((name) => {
        const bus = ctx.createGain();
        bus.gain.value = 1;
        bus.connect(this.sfx);
        this.buses[name] = bus;
      });
      this._applyBusLevels();
      return ctx;
    },

    _applyBusLevels() {
      if (!this.buses || !this.manifest || !this.manifest.buses) return;
      Object.keys(this.buses).forEach((name) => {
        if (this.manifest.buses[name] != null) {
          this.buses[name].gain.value = clamp(this.manifest.buses[name], 0, 1.5);
        }
      });
    },

    setEnabled(on) {
      this.enabled = !!on;
      this._ensure();
      if (this.master) {
        const now = this.ctx.currentTime;
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setTargetAtTime(this.enabled ? 1 : 0, now, 0.05);
      }
      try {
        localStorage.setItem('vf_audio_muted', this.enabled ? '0' : '1');
      } catch (_) {}
      if (this.enabled) this._startMusic();
      else {
        this._stopMusic();
        this.stopAllLoops();
      }
      this._syncMuteUi();
    },

    setMusicAllowed(on) {
      this.musicAllowed = on !== false;
      if (!this.musicAllowed) this._stopMusic();
      else if (this.enabled && this.unlocked) this._startMusic();
    },

    toggle() {
      this.setEnabled(!this.enabled);
      return this.enabled;
    },

    _syncMuteUi() {
      const button = document.getElementById('audio-toggle');
      if (!button) return;
      button.classList.toggle('muted', !this.enabled);
      button.setAttribute('aria-pressed', this.enabled ? 'false' : 'true');
      button.title = this.enabled ? '静音' : '开启声音';
    },

    _resolveEntry(id) {
      if (!this.manifest || !this.manifest.sounds) return null;
      let key = LEGACY_IDS[id] || id;
      let entry = this.manifest.sounds[key];
      let guard = 0;
      while (entry && entry.alias && guard++ < 8) {
        key = entry.alias;
        entry = this.manifest.sounds[key];
      }
      return entry ? { id: key, entry } : null;
    },

    _distance(position) {
      if (!position) return 0;
      const listener = this._listenerPosition;
      return Math.hypot(position.x - listener.x, position.y - listener.y, position.z - listener.z);
    },

    _chooseFile(id, entry, opts) {
      const position = positionOf(opts.position);
      const distance = opts.distance != null ? Number(opts.distance) : this._distance(position);
      const far = !!(
        entry.distantFiles &&
        entry.distantFiles.length &&
        distance >= (entry.distantThreshold || 70)
      );
      const choices = far ? entry.distantFiles : entry.files;
      if (!choices || !choices.length) return null;
      if (typeof opts.variant === 'string' && choices.indexOf(opts.variant) >= 0) {
        return { file: opts.variant, far };
      }
      let index;
      if (typeof opts.variant === 'number') index = Math.abs(Math.floor(opts.variant)) % choices.length;
      else {
        index = Math.floor(Math.random() * choices.length);
        if (choices.length > 1 && this._lastVariant && this._lastVariant[id] === index) {
          index = (index + 1) % choices.length;
        }
      }
      this._lastVariant = this._lastVariant || Object.create(null);
      this._lastVariant[id] = index;
      return { file: choices[index], far };
    },

    _loadBuffer(file) {
      const cached = this._buffers.get(file);
      if (cached) return Promise.resolve(cached);
      const pending = this._loads.get(file);
      if (pending) return pending;
      const base = (this.manifest && this.manifest.basePath) || 'assets/sfx/';
      const promise = fetch(base + file)
        .then((response) => {
          if (!response.ok) throw new Error(file + ' HTTP ' + response.status);
          return response.arrayBuffer();
        })
        .then((bytes) => this.ctx.decodeAudioData(bytes.slice(0)))
        .then((decoded) => {
          this._loads.delete(file);
          this._buffers.set(file, decoded);
          return decoded;
        })
        .catch((error) => {
          this._loads.delete(file);
          throw error;
        });
      this._loads.set(file, promise);
      return promise;
    },

    preload(ids) {
      const ctx = this._ensure();
      if (!ctx) return Promise.resolve([]);
      return this._loadManifest().then(() => {
        const requests = [];
        (ids || []).forEach((id) => {
          const resolved = this._resolveEntry(id);
          if (!resolved || !resolved.entry.files) return;
          resolved.entry.files.concat(resolved.entry.distantFiles || []).forEach((file) => {
            requests.push(this._loadBuffer(file).catch(() => null));
          });
        });
        return Promise.all(requests);
      });
    },

    playExplosionAt(position, kind, opts) {
      const id =
        kind === 'cannon' ? 'vehicle.explosion.cannon' : kind === 'he' ? 'vehicle.explosion.he' : 'throwable.frag.detonate';
      return this.play(
        id,
        Object.assign(
          {
            position: position,
            maxDistance: 450,
            priority: 10,
            gain: kind === 'cannon' ? 1.65 : 1.55,
          },
          opts || {}
        )
      );
    },

    play(id, opts) {
      opts = opts || {};
      if (!this.enabled) return null;
      const ctx = this._ensure();
      if (!ctx) return null;
      const request = { id, opts: Object.assign({}, opts), requestedAt: performance.now() };
      if (ctx.state === 'suspended' || !this.unlocked) {
        this._queue = this._queue || [];
        if (this._queue.length < 24) this._queue.push(() => this._dispatch(request));
        return null;
      }
      this._dispatch(request);
      return request;
    },

    _dispatch(request) {
      const resolved = this._resolveEntry(request.id);
      if (resolved) {
        this._playEntry(resolved.id, resolved.entry, request.opts, request.requestedAt);
        return;
      }
      if (!this.manifest && !this.manifestError) {
        this._loadManifest().then((manifest) => {
          const late = this._resolveEntry(request.id);
          if (manifest && late) this._playEntry(late.id, late.entry, request.opts, request.requestedAt);
          else this._playFallback(request.id, request.opts);
        });
        return;
      }
      this._playFallback(request.id, request.opts);
    },

    _playEntry(id, entry, opts, requestedAt) {
      const chosen = this._chooseFile(id, entry, opts);
      if (!chosen) {
        this._playFallback(id, opts);
        return;
      }
      const maxDistance = opts.maxDistance != null ? opts.maxDistance : entry.maxDistance;
      const position = positionOf(opts.position);
      if (!opts.local && position && maxDistance > 0 && this._distance(position) > maxDistance) return;
      this._loadBuffer(chosen.file)
        .then((decoded) => {
          if (!this.enabled || !this.unlocked) return;
          const age = performance.now() - requestedAt;
          const priority = opts.priority != null ? opts.priority : entry.priority || 0;
          if (age > (priority >= 8 ? 900 : 420)) return;
          this._startBuffer(id, entry, decoded, opts, chosen.far, false);
        })
        .catch(() => this._playFallback(id, opts));
    },

    _categoryLimit(category) {
      const limits = this.manifest && this.manifest.concurrency;
      return (limits && limits[category]) || (category === 'weapons' ? 12 : 8);
    },

    _admit(category, priority) {
      this._active = this._active.filter((item) => !item.ended);
      const same = this._active.filter((item) => item.category === category);
      const globalLimit =
        (this.manifest && this.manifest.concurrency && this.manifest.concurrency.global) ||
        MAX_ACTIVE;
      const overCategory = same.length >= this._categoryLimit(category);
      const overGlobal = this._active.length >= globalLimit;
      if (!overCategory && !overGlobal) return true;
      const candidates = overCategory ? same : this._active;
      let victim = null;
      candidates.forEach((item) => {
        if (!victim || item.priority < victim.priority || (item.priority === victim.priority && item.started < victim.started)) {
          victim = item;
        }
      });
      if (!victim || victim.priority > priority) return false;
      try {
        victim.source.stop();
      } catch (_) {}
      victim.ended = true;
      return true;
    },

    _localOccupiedVehicle() {
      const game = global.VF && global.VF.game;
      const player = game && game.player;
      if (!player || player.dead || !player.vehicleId) return null;
      const vehicles = game.vehicles;
      const vehicle = vehicles && vehicles.getById ? vehicles.getById(player.vehicleId) : null;
      return vehicle && vehicle.alive && vehicle.position ? { player, vehicle } : null;
    },

    _isOccupantSource(position, opts) {
      if (opts && opts.occupant === false) return false;
      if (opts && opts.occupant === true) return true;
      const occupied = this._localOccupiedVehicle();
      if (!occupied) return false;
      const origin = position || occupied.vehicle.position;
      if (!origin) return false;
      return (
        Math.hypot(
          origin.x - occupied.vehicle.position.x,
          (origin.y || 0) - occupied.vehicle.position.y,
          origin.z - occupied.vehicle.position.z
        ) <= 16
      );
    },

    _makeRoute(entry, opts) {
      const ctx = this.ctx;
      const gain = ctx.createGain();
      const category = (entry && (entry.bus || entry.category)) || opts.category || 'characters';
      const position = positionOf(opts.position);
      const occupied = this._localOccupiedVehicle();
      const thirdPerson = !!(occupied && occupied.player.vehicleCameraMode !== 1);
      const occupantSource = this._isOccupantSource(position, opts);
      let amount =
        clamp(entry && entry.gain != null ? entry.gain : 1, 0, 2) *
        clamp(opts.gain != null ? opts.gain : 1, 0, 2);
      if (occupantSource) {
        const mounted = category === 'vehicles' || category === 'weapons';
        amount *= thirdPerson ? (mounted ? 1.9 : 1.45) : mounted ? 1.28 : 1.12;
      } else if (category === 'explosives') {
        amount *= 1.12;
      }
      gain.gain.value = Math.max(0.0001, clamp(amount, 0, 2.6));
      const destination = (this.buses && this.buses[category]) || this.sfx;
      let panner = null;
      if (position && !opts.local && ctx.createPanner) {
        panner = ctx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        let refDistance = Number(opts.refDistance);
        if (!(refDistance > 0)) refDistance = category === 'explosives' ? 10 : 2.5;
        let rolloff = Number(opts.rolloff);
        if (!(rolloff > 0)) rolloff = category === 'explosives' ? 0.62 : 1.15;
        if (occupantSource && thirdPerson) {
          refDistance = Math.max(refDistance, 24);
          rolloff = Math.min(rolloff, 0.26);
        } else if (occupantSource) {
          refDistance = Math.max(refDistance, 9);
          rolloff = Math.min(rolloff, 0.5);
        }
        panner.refDistance = Math.max(1, refDistance);
        panner.maxDistance = Math.max(
          panner.refDistance + 1,
          Number(opts.maxDistance != null ? opts.maxDistance : entry && entry.maxDistance) || 280
        );
        panner.rolloffFactor = rolloff;
        this._setPannerPosition(panner, position);
        gain.connect(panner);
        panner.connect(destination);
      } else {
        gain.connect(destination);
      }
      return { input: gain, gain, panner, category };
    },

    _startBuffer(id, entry, decoded, opts, far, looping, loopKey) {
      const category = entry.category || entry.bus || 'characters';
      const priority = opts.priority != null ? opts.priority : entry.priority || 0;
      if (!this._admit(category, priority)) return null;
      const ctx = this.ctx;
      const source = ctx.createBufferSource();
      source.buffer = decoded;
      source.loop = !!looping;
      source.playbackRate.value = clamp(opts.rate != null ? opts.rate : 1, 0.35, 2.5);
      const route = this._makeRoute(entry, opts);
      let first = route.input;
      let filter = null;
      if (far) {
        filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = clamp(opts.lowpass || 1800, 350, 8000);
        filter.connect(route.input);
        first = filter;
      }
      source.connect(first);
      const active = {
        id,
        source,
        category,
        priority,
        started: performance.now(),
        ended: false,
        gain: route.gain,
        panner: route.panner,
        filter,
        loopKey: loopKey || null,
      };
      source.onended = () => {
        active.ended = true;
        if (active.loopKey && this._loops.get(active.loopKey) === active) {
          this._loops.delete(active.loopKey);
        }
      };
      this._active.push(active);
      const when = ctx.currentTime + Math.max(0, Number(opts.delay) || 0);
      source.start(when);
      if (category === 'explosives' && priority >= 8) this._duck();
      return active;
    },

    _duck() {
      if (!this.sfx || !this.ctx) return;
      const gain = this.sfx.gain;
      const now = this.ctx.currentTime;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(Math.min(gain.value, 0.9), now);
      gain.setTargetAtTime(0.68, now, 0.018);
      gain.setTargetAtTime(0.9, now + 0.12, 0.18);
    },

    _flushQueue() {
      const queue = this._queue || [];
      this._queue = [];
      queue.forEach((run) => {
        try {
          run();
        } catch (_) {}
      });
    },

    playLoop(id, key, opts) {
      opts = opts || {};
      if (!key || !this.enabled || !this.unlocked) return null;
      const current = this._loops.get(key);
      if (current && !current.ended) {
        this.updateLoop(key, opts);
        return current;
      }
      if (this._loopPending.has(key)) return null;
      const resolved = this._resolveEntry(id);
      if (!resolved) return null;
      const chosen = this._chooseFile(resolved.id, resolved.entry, opts);
      if (!chosen) return null;
      this._loopPending.set(key, true);
      this._loadBuffer(chosen.file)
        .then((decoded) => {
          this._loopPending.delete(key);
          if (!this.enabled || this._loops.has(key)) return;
          const active = this._startBuffer(resolved.id, resolved.entry, decoded, opts, false, true, key);
          if (active) this._loops.set(key, active);
        })
        .catch(() => this._loopPending.delete(key));
      return null;
    },

    updateLoop(key, opts) {
      const item = this._loops.get(key);
      if (!item || item.ended || !this.ctx) return false;
      opts = opts || {};
      const now = this.ctx.currentTime;
      if (opts.gain != null) item.gain.gain.setTargetAtTime(Math.max(0.0001, opts.gain), now, 0.08);
      if (opts.rate != null) item.source.playbackRate.setTargetAtTime(clamp(opts.rate, 0.35, 2.5), now, 0.08);
      const position = positionOf(opts.position);
      if (position && item.panner) {
        this._setPannerPosition(item.panner, position);
        if (this._isOccupantSource(position, opts)) {
          const occupied = this._localOccupiedVehicle();
          const thirdPerson = !!(occupied && occupied.player.vehicleCameraMode !== 1);
          item.panner.refDistance = thirdPerson ? 24 : 9;
          item.panner.rolloffFactor = thirdPerson ? 0.26 : 0.5;
        }
      }
      item.touched = performance.now();
      return true;
    },

    stopLoop(key, fade) {
      const item = this._loops.get(key);
      this._loopPending.delete(key);
      if (!item) return false;
      this._loops.delete(key);
      try {
        const now = this.ctx.currentTime;
        const duration = fade == null ? 0.1 : Math.max(0, fade);
        item.gain.gain.cancelScheduledValues(now);
        item.gain.gain.setTargetAtTime(0.0001, now, Math.max(0.01, duration * 0.35));
        item.source.stop(now + duration);
      } catch (_) {}
      return true;
    },

    stopAllLoops(prefix) {
      if (!this._loops) return;
      Array.from(this._loops.keys()).forEach((key) => {
        if (!prefix || key.indexOf(prefix) === 0) this.stopLoop(key, 0.08);
      });
    },

    _setPannerPosition(panner, position) {
      const now = this.ctx.currentTime;
      if (panner.positionX) {
        panner.positionX.setValueAtTime(position.x, now);
        panner.positionY.setValueAtTime(position.y, now);
        panner.positionZ.setValueAtTime(position.z, now);
      } else if (panner.setPosition) {
        panner.setPosition(position.x, position.y, position.z);
      }
    },

    updateListener(camera) {
      if (!camera || !this.ctx) return;
      const position = positionOf(camera);
      if (!position) return;
      this._listenerPosition = position;
      const listener = this.ctx.listener;
      const now = this.ctx.currentTime;
      let forward = { x: 0, y: 0, z: -1 };
      let up = { x: 0, y: 1, z: 0 };
      if (camera.getWorldDirection && global.THREE) {
        const vector = new global.THREE.Vector3();
        camera.getWorldDirection(vector);
        forward = vector;
        if (camera.up) up = camera.up;
      }
      if (listener.positionX) {
        listener.positionX.setValueAtTime(position.x, now);
        listener.positionY.setValueAtTime(position.y, now);
        listener.positionZ.setValueAtTime(position.z, now);
        listener.forwardX.setValueAtTime(forward.x, now);
        listener.forwardY.setValueAtTime(forward.y, now);
        listener.forwardZ.setValueAtTime(forward.z, now);
        listener.upX.setValueAtTime(up.x, now);
        listener.upY.setValueAtTime(up.y, now);
        listener.upZ.setValueAtTime(up.z, now);
      } else {
        listener.setPosition(position.x, position.y, position.z);
        listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
      }
    },

    /** Called once per frame for 3C, listener and nearby vehicle loops. */
    update(dt, player, camera, vehicles) {
      if (
        this.musicAllowed !== false &&
        global.VF &&
        global.VF.game &&
        global.VF.game.running
      ) {
        this.setMusicAllowed(false);
      }
      if (!this.enabled) return;
      this.updateListener(camera || (player && player.camera));
      this._syncVehicleAudio(dt, vehicles);
      if (!player || player.dead) return;
      this._stepCd = Math.max(0, this._stepCd - dt);
      this._rumbleCd = Math.max(0, this._rumbleCd - dt);
      if (!this._musicSrc && this._rumbleCd <= 0) {
        this.play('distant_rumble', { priority: 0 });
        this._rumbleCd = 2.2 + Math.random() * 3.2;
      }
      const moving =
        player.onGround &&
        player.direction &&
        player.direction.lengthSq() > 0.01 &&
        player._heldMode !== 'build';
      if (moving && this._stepCd <= 0) {
        const sprint = !!(player.keys && (player.keys.ShiftLeft || player.keys.ShiftRight));
        const crouch = !!(player.crouching || player.prone || player.stealthed);
        const id = crouch
          ? 'character.footstep.crouch'
          : sprint
            ? 'character.footstep.run'
            : 'character.footstep.walk';
        this.play(id, { local: true, gain: player.stealthed ? 0.45 : 1, priority: 2 });
        this._stepCd = sprint ? 0.28 : crouch ? 0.48 : 0.36;
      }
      if (!player.onGround) this._fallSpeed = Math.max(this._fallSpeed, -(player.velocity.y || 0));
      if (player.onGround && !this._lastLanded) {
        this.play(this._fallSpeed >= 7.5 ? 'character.land.hard' : 'character.land.soft', {
          local: true,
          priority: this._fallSpeed >= 7.5 ? 6 : 3,
        });
        this._fallSpeed = 0;
      }
      this._lastLanded = !!player.onGround;
    },

    _syncVehicleAudio(dt, vehicles) {
      if (!vehicles || !vehicles.getAll || !this.unlocked) return;
      const now = performance.now();
      const liveKeys = new Set();
      const list = vehicles.getAll() || [];
      for (let i = 0; i < list.length; i++) {
        const vehicle = list[i];
        if (!vehicle || !vehicle.alive || !vehicle.position) continue;
        const distance = this._distance(vehicle.position);
        if (distance > 205) continue;
        const prefix = 'vehicle:' + vehicle.id + ':';
        const engineKey = prefix + 'engine';
        const movementKey = prefix + 'movement';
        liveKeys.add(engineKey);
        liveKeys.add(movementKey);
        const ratio = clamp(Math.abs(vehicle.speed || 0) / Math.max(1, vehicle.def.maxSpeed || 1), 0, 1);
        const local = !!(
          global.VF &&
          global.VF.game &&
          global.VF.game.player &&
          global.VF.game.player.vehicleId === vehicle.id
        );
        const common = {
          position: vehicle.position,
          maxDistance: 205,
          priority: local ? 5 : 2,
          occupant: local,
        };
        const engineGain = (local ? 0.82 : 0.24) + ratio * 0.32;
        const moveGain = (local ? 0.55 : 0.14) + ratio * 0.34;
        this.playLoop('vehicle.' + vehicle.type + '.engine', engineKey, Object.assign({}, common, {
          gain: engineGain,
          rate: 0.72 + ratio * 0.72,
        }));
        this.updateLoop(engineKey, {
          position: vehicle.position,
          gain: engineGain,
          rate: 0.72 + ratio * 0.72,
        });
        if (ratio > 0.035) {
          this.playLoop('vehicle.' + vehicle.type + '.movement', movementKey, Object.assign({}, common, {
            gain: moveGain,
            rate: 0.65 + ratio * 0.9,
          }));
          this.updateLoop(movementKey, {
            position: vehicle.position,
            gain: moveGain,
            rate: 0.65 + ratio * 0.9,
          });
        } else {
          this.stopLoop(movementKey, 0.15);
        }
        const state = this._vehicleStates.get(vehicle.id) || { throttle: 0, brake: 0, band: 0 };
        const throttle = Math.abs((vehicle.driverInput && vehicle.driverInput.throttle) || 0);
        const brake = (vehicle.driverInput && vehicle.driverInput.brake) || 0;
        const band = ratio >= 0.67 ? 2 : ratio >= 0.32 ? 1 : 0;
        if (throttle > 0.65 && state.throttle <= 0.65) {
          this.play('vehicle.' + vehicle.type + '.rev', Object.assign({}, common, { gain: local ? 1.05 : 0.38 }));
        }
        if (brake > 0.45 && state.brake <= 0.45 && ratio > 0.16) {
          this.play('vehicle.' + vehicle.type + '.brake', Object.assign({}, common, { gain: local ? 1.1 : 0.42 }));
        }
        if (band !== state.band && ratio > 0.18) {
          this.play('vehicle.' + vehicle.type + '.shift', Object.assign({}, common, { gain: local ? 0.92 : 0.3 }));
        }
        this._vehicleStates.set(vehicle.id, { throttle, brake, band, touched: now });
      }
      Array.from(this._loops.keys()).forEach((key) => {
        if (key.indexOf('vehicle:') === 0 && !liveKeys.has(key)) this.stopLoop(key, 0.18);
      });
      this._vehicleStates.forEach((state, key) => {
        if (!state.touched || now - state.touched > Math.max(500, dt * 4000)) this._vehicleStates.delete(key);
      });
    },

    _noiseBuffer(seconds) {
      const length = Math.max(1, Math.floor(this.ctx.sampleRate * seconds));
      const out = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = out.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      return out;
    },

    _env(gainNode, t0, attack, peak, decay, sustain, release) {
      const gain = gainNode.gain;
      gain.cancelScheduledValues(t0);
      gain.setValueAtTime(0.0001, t0);
      gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t0 + attack);
      gain.exponentialRampToValueAtTime(Math.max(0.0001, sustain), t0 + attack + decay);
      gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay + release);
    },

    tone(frequency, duration, type, volume, destination) {
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type || 'square';
      osc.frequency.setValueAtTime(frequency, ctx.currentTime);
      this._env(gain, ctx.currentTime, 0.005, volume || 0.2, duration * 0.25, (volume || 0.2) * 0.35, duration * 0.7);
      osc.connect(gain);
      gain.connect(destination || this._fallbackDest || this.sfx);
      osc.start();
      osc.stop(ctx.currentTime + duration + 0.05);
      return osc;
    },

    noiseBurst(duration, volume, highpass, lowpass, destination) {
      const ctx = this.ctx;
      const source = ctx.createBufferSource();
      source.buffer = this._noiseBuffer(Math.max(duration + 0.05, 0.08));
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = highpass != null ? highpass : 800;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = lowpass != null ? lowpass : 4000;
      const gain = ctx.createGain();
      this._env(gain, ctx.currentTime, 0.001, volume || 0.3, duration * 0.2, (volume || 0.3) * 0.2, duration * 0.75);
      source.connect(hp);
      hp.connect(lp);
      lp.connect(gain);
      gain.connect(destination || this._fallbackDest || this.sfx);
      source.start();
      source.stop(ctx.currentTime + duration + 0.05);
    },

    _playFallback(id, opts) {
      const name = fallbackName(id);
      const effect = SOUNDS[name];
      if (!effect) return;
      const route = this._makeRoute({ category: fallbackCategory(name), gain: 1 }, opts || {});
      this._fallbackDest = route.input;
      try {
        effect(this, opts || {});
      } finally {
        this._fallbackDest = null;
      }
    },

    _startMusic() {
      if (!this.enabled || this.musicAllowed === false) return;
      const ctx = this._ensure();
      if (!ctx) return;
      this._stopAmbient();
      if (this._musicSrc) return;
      const start = (decoded) => {
        if (!this.enabled || this.musicAllowed === false || this._musicSrc) return;
        try {
          const source = ctx.createBufferSource();
          source.buffer = decoded;
          source.loop = true;
          source.connect(this.music);
          source.start();
          this._musicSrc = source;
          this._musicBuf = decoded;
        } catch (_) {}
      };
      if (this._musicBuf) return start(this._musicBuf);
      if (this._musicLoading) return;
      this._musicLoading = true;
      const paths = ['assets/music/theme.mp3', 'assets/music/theme.wav'];
      const load = (index) => {
        if (index >= paths.length) {
          this._musicLoading = false;
          this._startAmbient();
          return;
        }
        fetch(paths[index])
          .then((response) => (response.ok ? response.arrayBuffer() : null))
          .then((bytes) => (bytes ? ctx.decodeAudioData(bytes.slice(0)) : null))
          .then((decoded) => {
            this._musicLoading = false;
            if (decoded) {
              this._musicBuf = decoded;
              start(decoded);
            } else load(index + 1);
          })
          .catch(() => {
            this._musicLoading = false;
            load(index + 1);
          });
      };
      load(0);
    },

    _stopMusic() {
      if (this._musicSrc) {
        try {
          this._musicSrc.stop();
          this._musicSrc.disconnect();
        } catch (_) {}
        this._musicSrc = null;
      }
      this._stopAmbient();
    },

    _startAmbient() {
      if (
        this._ambientNodes ||
        !this.enabled ||
        this.musicAllowed === false ||
        this._musicSrc
      ) {
        return;
      }
      const ctx = this._ensure();
      if (!ctx) return;
      const nodes = [];
      [55, 82.5, 110].forEach((frequency, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = index ? 'triangle' : 'sawtooth';
        osc.frequency.value = frequency;
        gain.gain.value = 0.035 - index * 0.007;
        osc.connect(gain);
        gain.connect(this.music);
        osc.start();
        nodes.push(osc, gain);
      });
      this._ambientNodes = nodes;
    },

    _stopAmbient() {
      if (!this._ambientNodes) return;
      this._ambientNodes.forEach((node) => {
        try {
          if (node.stop) node.stop();
          node.disconnect();
        } catch (_) {}
      });
      this._ambientNodes = null;
    },

    bindUiClicks() {
      if (this._uiBound) return;
      this._uiBound = true;
      document.addEventListener('click', (event) => {
        if (!this.enabled) return;
        const target = event.target.closest(
          'button, .cover-btn, .hub-action, .class-card, .lobby-mode, .lobby-dock-item, .lobby-avatar-btn, .lobby-currency, .lobby-settings, [data-lobby-action], .me-tool, .me-btn, .sheet-close, a.menu-link, .mode-card, .mode-quit, .mode-tab, .deploy-class, .deploy-rect, .deploy-back'
        );
        if (!target || target.id === 'audio-toggle' || target.disabled) return;
        this.play('ui', { local: true, priority: 5 });
      }, true);
    },
  };

  function fallbackCategory(name) {
    if (/shoot|tank|vehicle/.test(name)) return 'weapons';
    if (/explosion/.test(name)) return 'explosives';
    if (/ui|confirm|warn|victory|defeat|kill|hit/.test(name)) return 'ui';
    return 'characters';
  }

  function fallbackName(id) {
    const reverse = {
      'character.jump': 'jump',
      'character.land.soft': 'land',
      'character.land.hard': 'land_hard',
      'character.hurt': 'hurt',
      'character.death': 'death',
      'throwable.frag.detonate': 'explosion',
      'throwable.frag.distant': 'distant_rumble',
      'throwable.flash.detonate': 'flash',
      'throwable.flash.ring': 'ring',
      'throwable.smoke.ignite': 'smoke',
      'vehicle.weapon.tank_cannon': 'tank_cannon_fire',
      'vehicle.weapon.tank_cannon_far': 'tank_cannon_distant',
      'vehicle.explosion.cannon': 'tank_cannon_distant',
      'vehicle.explosion.he': 'explosion',
      'vehicle.weapon.tank_breech': 'tank_breech',
      'vehicle.impact.armor': 'tank_armor_hit',
      'vehicle.impact.ground': 'tank_ground_impact',
      'vehicle.impact.structure': 'tank_structure_impact',
    };
    if (reverse[id]) return reverse[id];
    if (/^character\.footstep/.test(id)) return 'footstep';
    if (/^weapon\..+\.fire$/.test(id) || /^weapon\.profile\..+\.fire$/.test(id)) {
      return /m200|sniper|dmr|scarh|rifle762/.test(id) ? 'shoot_sr' : 'shoot_ar';
    }
    if (/\.empty$/.test(id)) return 'empty';
    if (/\.reload_start$/.test(id)) return 'reload_start';
    if (/\.reload_mag$/.test(id)) return 'reload_mag';
    if (/\.reload_rack$/.test(id)) return 'reload_rack';
    if (/^throwable\..+\.pin$/.test(id)) return 'reload_start';
    if (/^throwable\..+\.throw$/.test(id)) return 'dash';
    if (/^throwable\..+\.bounce$/.test(id)) return 'impact';
    if (/^vehicle\.weapon/.test(id)) return 'shoot_sg';
    return id;
  }

  const SOUNDS = {
    shoot_ar(A) {
      A.noiseBurst(0.075, 0.36, 520, 6800);
      A.tone(175 + Math.random() * 35, 0.08, 'sawtooth', 0.2);
      A.tone(82, 0.12, 'triangle', 0.14);
    },
    shoot_sg(A) {
      A.noiseBurst(0.17, 0.48, 170, 5200);
      A.tone(68, 0.18, 'sawtooth', 0.28);
    },
    shoot_sr(A) {
      A.noiseBurst(0.22, 0.44, 350, 8200);
      A.tone(105, 0.24, 'sawtooth', 0.3);
      A.tone(48, 0.36, 'triangle', 0.2);
    },
    tank_cannon_fire(A) {
      A.noiseBurst(0.24, 0.62, 45, 6800);
      A.tone(52, 0.52, 'sawtooth', 0.42);
      A.tone(30, 0.7, 'sine', 0.3);
    },
    tank_cannon_distant(A) {
      A.noiseBurst(0.4, 0.28, 25, 900);
      A.tone(38, 0.62, 'sine', 0.22);
    },
    tank_breech(A) {
      A.noiseBurst(0.08, 0.22, 600, 5200);
      A.tone(180, 0.12, 'square', 0.15);
    },
    tank_armor_hit(A) {
      A.noiseBurst(0.16, 0.42, 220, 6500);
      A.tone(190, 0.2, 'square', 0.2);
    },
    tank_ground_impact(A) {
      A.noiseBurst(0.38, 0.48, 30, 2400);
      A.tone(46, 0.5, 'triangle', 0.3);
    },
    tank_structure_impact(A) {
      A.noiseBurst(0.34, 0.5, 60, 3800);
      A.tone(58, 0.44, 'triangle', 0.28);
    },
    empty(A) {
      A.tone(240, 0.05, 'square', 0.09);
      A.noiseBurst(0.035, 0.1, 1800, 7000);
    },
    reload_start(A) {
      A.noiseBurst(0.06, 0.13, 1300, 5600);
      A.tone(340, 0.07, 'triangle', 0.1);
    },
    reload_mag(A) {
      A.tone(185, 0.07, 'square', 0.14);
      A.noiseBurst(0.06, 0.16, 700, 3800);
    },
    reload_rack(A) {
      A.noiseBurst(0.1, 0.22, 900, 7200);
      A.tone(250, 0.09, 'sawtooth', 0.12);
    },
    hit(A) {
      A.tone(980, 0.05, 'square', 0.16);
      A.tone(1480, 0.04, 'triangle', 0.1);
    },
    hit_heavy(A) {
      A.tone(680, 0.07, 'square', 0.2);
      A.noiseBurst(0.08, 0.2, 550, 7600);
    },
    melee_swing(A) {
      A.noiseBurst(0.08, 0.16, 1600, 9200);
    },
    melee_hit(A) {
      A.noiseBurst(0.08, 0.28, 350, 5200);
      A.tone(190, 0.09, 'sawtooth', 0.17);
    },
    melee_backstab(A) {
      SOUNDS.melee_hit(A);
      A.tone(760, 0.08, 'triangle', 0.13);
    },
    kill(A, opts) {
      const pitch = opts.pitch || 1;
      [990, 1320, 1760].forEach((frequency, index) => A.tone(frequency * pitch, 0.05 + index * 0.02, index ? 'triangle' : 'square', 0.16 - index * 0.02));
    },
    impact(A) {
      A.noiseBurst(0.08, 0.2, 180, 3000);
      A.tone(80, 0.07, 'triangle', 0.1);
    },
    break_block(A) {
      A.noiseBurst(0.12, 0.27, 90, 2400);
      A.tone(70, 0.1, 'triangle', 0.12);
    },
    distant_rumble(A) {
      A.noiseBurst(0.24, 0.055, 25, 420);
      A.tone(40 + Math.random() * 16, 0.3, 'triangle', 0.045);
    },
    hurt(A) {
      A.noiseBurst(0.18, 0.38, 100, 3200);
      A.tone(130, 0.16, 'sawtooth', 0.2);
    },
    death(A) {
      A.noiseBurst(0.38, 0.34, 65, 1800);
      A.tone(72, 0.55, 'sawtooth', 0.24);
    },
    footstep(A, opts) {
      const volume = opts.crouch ? 0.06 : opts.sprint ? 0.16 : 0.11;
      A.noiseBurst(0.05, volume, 70, opts.crouch ? 700 : 1600);
      A.tone(72 + Math.random() * 28, 0.04, 'triangle', volume * 0.5);
    },
    land(A) {
      A.noiseBurst(0.1, 0.2, 50, 950);
      A.tone(55, 0.1, 'triangle', 0.12);
    },
    land_hard(A) {
      A.noiseBurst(0.16, 0.38, 40, 1500);
      A.tone(44, 0.2, 'triangle', 0.25);
    },
    jump(A) {
      A.tone(180, 0.09, 'triangle', 0.08);
      A.noiseBurst(0.05, 0.08, 350, 2200);
    },
    pickup(A) {
      A.tone(520, 0.06, 'square', 0.1);
      A.tone(780, 0.08, 'triangle', 0.09);
    },
    build(A) {
      A.noiseBurst(0.12, 0.22, 180, 2700);
      A.tone(160, 0.08, 'square', 0.12);
    },
    ui(A) {
      const now = performance.now();
      if (A._uiClickAt && now - A._uiClickAt < 45) return;
      A._uiClickAt = now;
      A.tone(740, 0.04, 'triangle', 0.1);
      A.tone(980, 0.03, 'sine', 0.06);
    },
    confirm(A) {
      [392, 523, 659].forEach((frequency, index) => A.tone(frequency, 0.06 + index * 0.02, 'triangle', 0.1));
    },
    warn(A) {
      A.tone(480, 0.1, 'square', 0.12);
      A.tone(360, 0.13, 'square', 0.1);
    },
    victory(A) {
      [523, 659, 784, 1046].forEach((frequency, index) => setTimeout(() => A.enabled && A.tone(frequency, 0.18, 'triangle', 0.12), index * 110));
    },
    defeat(A) {
      [392, 330, 262].forEach((frequency, index) => setTimeout(() => A.enabled && A.tone(frequency, 0.22, 'sawtooth', 0.1), index * 140));
    },
    dash(A) {
      A.noiseBurst(0.13, 0.28, 180, 4700);
      A.tone(175, 0.12, 'sawtooth', 0.14);
    },
    stealth_on(A) {
      A.tone(520, 0.14, 'sine', 0.1);
      A.tone(780, 0.2, 'triangle', 0.08);
    },
    stealth_off(A) {
      A.tone(420, 0.1, 'triangle', 0.1);
      A.noiseBurst(0.07, 0.15, 350, 3600);
    },
    shield_on(A) {
      A.tone(240, 0.12, 'triangle', 0.12);
      A.tone(480, 0.16, 'sine', 0.1);
    },
    shield_hit(A) {
      A.tone(520, 0.05, 'square', 0.08);
      A.noiseBurst(0.05, 0.12, 1100, 5200);
    },
    shield_break(A) {
      A.noiseBurst(0.2, 0.34, 180, 4700);
      A.tone(90, 0.18, 'triangle', 0.1);
    },
    emp(A) {
      A.noiseBurst(0.22, 0.28, 550, 8200);
      A.tone(220, 0.2, 'sawtooth', 0.16);
    },
    c4_plant(A) {
      A.tone(200, 0.07, 'square', 0.12);
      A.noiseBurst(0.06, 0.14, 550, 3200);
    },
    explosion(A) {
      A.noiseBurst(0.38, 0.55, 35, 2300);
      A.tone(65, 0.34, 'sawtooth', 0.32);
      A.tone(38, 0.48, 'triangle', 0.22);
    },
    flash(A) {
      A.noiseBurst(0.18, 0.48, 900, 9000);
      A.tone(2400, 0.18, 'square', 0.18);
    },
    ring(A) {
      A.tone(4600, 1.1, 'sine', 0.16);
      A.tone(3100, 0.9, 'sine', 0.1);
    },
    smoke(A) {
      A.noiseBurst(0.45, 0.3, 900, 9000);
    },
  };

  const Voice = {
    speak() {},
    preload() {
      return Promise.resolve();
    },
  };
  AudioSys.voice = Voice;

  global.VF = global.VF || {};
  global.VF.Audio = AudioSys;
})(typeof window !== 'undefined' ? window : this);
