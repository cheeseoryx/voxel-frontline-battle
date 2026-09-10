/**
 * audio.js — Procedural SFX + light ambient via Web Audio API.
 *
 * Every sound has a synthesized fallback, so the game is playable with no
 * asset files at all. Dropping real recordings into assets/sfx/ and listing
 * them in assets/sfx/index.json overrides the synth per sound name.
 */
(function (global) {
  'use strict';

  const AudioSys = {
    ctx: null,
    master: null,
    sfx: null,
    music: null,
    enabled: true,
    unlocked: false,
    inMatch: false,
    _ambientNodes: null,
    _stepCd: 0,
    _lastLanded: true,
    _uiClickCd: 0,
    _rumbleCd: 3,
    _stamp: 0,
    _queue: [],
    _volMul: 1,
    _worldShotAt: 0,
    _samples: null,
    _sampleGain: null,
    _bankState: 'idle',

    init() {
      try {
        const saved = localStorage.getItem('vf_audio_muted');
        if (saved === '1') this.enabled = false;
      } catch (e) { /* ignore */ }

      const unlock = () => {
        this.unlock();
      };
      ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => {
        window.addEventListener(ev, unlock, { once: true, passive: true });
      });

      this._syncMuteUi();
    },

    /** Resume AudioContext after a user gesture (required by browsers). */
    unlock() {
      const ctx = this._ensure();
      if (!ctx) return Promise.resolve(false);
      const start = () => {
        this.unlocked = true;
        this.loadSampleBank();
        if (this.enabled && !this.inMatch) this._startMusic();
        this._flushQueue();
        return true;
      };
      if (ctx.state === 'suspended') {
        return ctx.resume().then(start).catch(function () {
          return false;
        });
      }
      return Promise.resolve(start());
    },

    _ensure() {
      if (this.ctx) return this.ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.enabled ? 1 : 0;
      this.master.connect(this.ctx.destination);

      this.sfx = this.ctx.createGain();
      this.sfx.gain.value = 0.9;
      this.sfx.connect(this.master);

      this.music = this.ctx.createGain();
      this.music.gain.value = 0.32;
      this.music.connect(this.master);
      return this.ctx;
    },

    setEnabled(on) {
      this.enabled = !!on;
      this._ensure();
      if (this.master) {
        const g = this.master.gain;
        const now = this.ctx.currentTime;
        g.cancelScheduledValues(now);
        g.setTargetAtTime(this.enabled ? 1 : 0, now, 0.05);
      }
      try {
        localStorage.setItem('vf_audio_muted', this.enabled ? '0' : '1');
      } catch (e) { /* ignore */ }
      if (this.enabled && !this.inMatch) this._startMusic();
      else this._stopMusic();
      this._syncMuteUi();
    },

    toggle() {
      this.setEnabled(!this.enabled);
      return this.enabled;
    },

    _syncMuteUi() {
      const btn = document.getElementById('audio-toggle');
      if (!btn) return;
      btn.classList.toggle('muted', !this.enabled);
      btn.setAttribute('aria-pressed', this.enabled ? 'false' : 'true');
      btn.title = this.enabled ? '静音' : '开启声音';
    },

    /**
     * Drop queued / delayed combat SFX so a new match never replays the last
     * death, kill, or explosion from the previous one.
     */
    clearPending() {
      this._queue = [];
      this._stamp = (this._stamp || 0) + 1;
    },

    /** Menu / hub may loop a theme; a live match is SFX-only. */
    setInMatch(on) {
      this.inMatch = !!on;
      if (this.inMatch) this._stopMusic();
      else if (this.enabled && this.unlocked) this._startMusic();
    },

    /** setTimeout that no-ops after clearPending(). */
    later(ms, fn) {
      const stamp = this._stamp || 0;
      const vol = this._volMul == null ? 1 : this._volMul;
      const self = this;
      return setTimeout(function () {
        if ((self._stamp || 0) !== stamp || !self.enabled) return;
        const prev = self._volMul;
        self._volMul = vol;
        fn();
        self._volMul = prev;
      }, ms);
    },

    /**
     * Sample bank — assets/sfx/index.json maps a sound name to one or more
     * layers, so a recorded hit can keep the layered shape of the synth:
     *   "molotov": [
     *     { "file": "throwables/glass_smash.ogg", "gain": 0.9 },
     *     { "file": "throwables/fire_whoosh.ogg", "gain": 0.7, "delay": 0.04 }
     *   ]
     * A bare string or single object works too. Layers that fail to load are
     * dropped; a name with no surviving layer keeps its synthesized version.
     *
     * Per-layer shaping, so stock recordings can be re-voiced without an audio
     * editor: gain, delay, rate (playback speed = pitch), lowpass / highpass
     * corner in Hz, and dur to cut a long tail short with a fade.
     */
    loadSampleBank() {
      if (this._bankState !== 'idle') return;
      const ctx = this._ensure();
      if (!ctx) return;
      this._bankState = 'loading';
      this._samples = this._samples || {};

      const num = (v, dflt) => (v == null ? dflt : v);
      const decode = (spec) => {
        const file = typeof spec === 'string' ? spec : spec && spec.file;
        if (!file) return Promise.resolve(null);
        const L = {
          gain: num(spec && spec.gain, 1),
          delay: num(spec && spec.delay, 0),
          rate: num(spec && spec.rate, 1),
          lowpass: num(spec && spec.lowpass, 0),
          highpass: num(spec && spec.highpass, 0),
          dur: num(spec && spec.dur, 0),
        };
        return fetch('assets/sfx/' + file)
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .then((ab) => (ab ? ctx.decodeAudioData(ab.slice(0)) : null))
          .then((buf) => {
            if (!buf) return null;
            L.buf = buf;
            return L;
          })
          .catch(function () { return null; });
      };

      fetch('assets/sfx/index.json')
        .then((r) => (r.ok ? r.json() : null))
        .then((idx) => {
          this._bankState = 'ready';
          const map = (idx && idx.sfx) || {};
          Object.keys(map).forEach((name) => {
            const specs = Array.isArray(map[name]) ? map[name] : [map[name]];
            Promise.all(specs.map(decode)).then((layers) => {
              const ok = layers.filter(Boolean);
              if (ok.length) this._samples[name] = ok;
            });
          });
        })
        .catch(() => {
          this._bankState = 'ready';
        });
    },

    /** One-shot of a sampled sound, honoring the current distance/volume mix. */
    _playSample(name, volMul) {
      const ctx = this._ensure();
      const layers = this._samples && this._samples[name];
      if (!ctx || !layers || !layers.length) return false;
      const vol = volMul == null ? 1 : volMul;
      const now = ctx.currentTime;
      let played = 0;
      for (let i = 0; i < layers.length; i++) {
        const L = layers[i];
        try {
          const src = ctx.createBufferSource();
          src.buffer = L.buf;
          if (L.rate && L.rate !== 1) src.playbackRate.value = L.rate;

          let node = src;
          if (L.highpass > 0) {
            const hp = ctx.createBiquadFilter();
            hp.type = 'highpass';
            hp.frequency.value = L.highpass;
            node.connect(hp);
            node = hp;
          }
          if (L.lowpass > 0) {
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = L.lowpass;
            node.connect(lp);
            node = lp;
          }

          const g = ctx.createGain();
          const peak = L.gain * vol;
          g.gain.value = peak;
          node.connect(g);
          g.connect(this.sfx);

          const at = now + (L.delay || 0);
          src.start(at);
          if (L.dur > 0) {
            // Fade the tail instead of cutting it, so trimming never clicks.
            const fade = Math.min(0.08, L.dur * 0.35);
            g.gain.setValueAtTime(peak, at + L.dur - fade);
            g.gain.linearRampToValueAtTime(0.0001, at + L.dur);
            src.stop(at + L.dur + 0.01);
          }
          played++;
        } catch (e) { /* skip this layer */ }
      }
      return played > 0;
    },

    play(name, opts) {
      if (!this.enabled) return;
      const ctx = this._ensure();
      if (!ctx) return;
      const stamp = this._stamp || 0;
      const volMul = opts && opts.volMul != null ? opts.volMul : 1;
      const run = () => {
        if ((this._stamp || 0) !== stamp) return;
        if (this._playSample(name, volMul)) return;
        this._volMul = volMul;
        const fn = SOUNDS[name];
        if (fn) fn(this, opts || {});
        this._volMul = 1;
      };
      // Browsers drop scheduled nodes while suspended — wait for resume.
      // Only bank UI beeps; combat SFX dumped on the first click would replay
      // leftover deaths/explosions from the previous match.
      if (ctx.state === 'suspended') {
        if (name === 'ui' || name === 'confirm') {
          this._queue = this._queue || [];
          if (this._queue.length < 24) this._queue.push(run);
        }
        ctx.resume().then(() => {
          this.unlocked = true;
          this._flushQueue();
          if (this.enabled && !this.inMatch) this._startMusic();
        }).catch(function () {});
        return;
      }
      run();
    },

    /**
     * Combat SFX at a world point, faded by distance to the local player.
     * Close shots stay loud; far ones thin out instead of vanishing or stacking
     * into a wall of noise.
     */
    playAt(name, x, y, z, opts) {
      if (!this.enabled) return;
      opts = opts || {};
      const hear = opts.hear != null ? opts.hear : 82;
      const g = global.VF && global.VF.game;
      const player = g && g.player;
      let volMul = 1;
      if (player && player.object) {
        const p = player.object.position;
        const dx = x - p.x;
        const dy = (y || 0) - (p.y || 0);
        const dz = z - p.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > hear) return;
        volMul = Math.max(0.08, 1 / (1 + d * 0.042));
      }
      if (name.indexOf('shoot_') === 0) {
        const now = performance.now();
        if (now - (this._worldShotAt || 0) < 24 && volMul < 0.42) return;
        this._worldShotAt = now;
      }
      const extra = opts.volMul != null ? opts.volMul : 1;
      this.play(name, Object.assign({}, opts, { volMul: volMul * extra }));
    },

    _flushQueue() {
      const q = this._queue;
      this._queue = [];
      if (!q || !q.length) return;
      for (let i = 0; i < q.length; i++) {
        try { q[i](); } catch (e) { /* ignore */ }
      }
    },

    /** Call from game loop for footsteps / landing / distant battle bed */
    update(dt, player) {
      if (!this.enabled || !player || player.dead) return;
      this._stepCd = Math.max(0, this._stepCd - dt);
      this._uiClickCd = Math.max(0, this._uiClickCd - dt);

      const moving =
        player.onGround &&
        player.direction &&
        player.direction.lengthSq() > 0.01 &&
        player._heldMode !== 'build';
      if (moving && this._stepCd <= 0) {
        if (player.stealthed) {
          this._stepCd = 0.55;
        } else {
          const sprint = !!(player.keys && (player.keys['ShiftLeft'] || player.keys['ShiftRight']));
          this.play('footstep', { sprint: sprint, crouch: !!player.crouching });
          this._stepCd = sprint ? 0.28 : player.crouching ? 0.48 : 0.36;
        }
      }

      if (player.onGround && !this._lastLanded && (player.velocity.y || 0) <= 0.5) {
        this.play('land');
      }
      this._lastLanded = !!player.onGround;
    },

    _noiseBuffer(seconds) {
      const ctx = this.ctx;
      const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return buf;
    },

    _env(gainNode, t0, a, peak, d, sus, r) {
      const g = gainNode.gain;
      g.cancelScheduledValues(t0);
      g.setValueAtTime(0.0001, t0);
      g.exponentialRampToValueAtTime(Math.max(0.0001, peak), t0 + a);
      g.exponentialRampToValueAtTime(Math.max(0.0001, sus), t0 + a + d);
      g.exponentialRampToValueAtTime(0.0001, t0 + a + d + r);
    },

    tone(freq, dur, type, vol, dest) {
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const mul = this._volMul == null ? 1 : this._volMul;
      osc.type = type || 'square';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      this._env(g, ctx.currentTime, 0.005, (vol || 0.2) * mul, dur * 0.25, (vol || 0.2) * mul * 0.35, dur * 0.7);
      osc.connect(g);
      g.connect(dest || this.sfx);
      osc.start();
      osc.stop(ctx.currentTime + dur + 0.05);
      return osc;
    },

    noiseBurst(dur, vol, hpFreq, lpFreq, dest) {
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuffer(Math.max(dur + 0.05, 0.08));
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = hpFreq != null ? hpFreq : 800;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = lpFreq != null ? lpFreq : 4000;
      const g = ctx.createGain();
      const mul = this._volMul == null ? 1 : this._volMul;
      this._env(g, ctx.currentTime, 0.001, (vol || 0.3) * mul, dur * 0.2, (vol || 0.3) * mul * 0.2, dur * 0.75);
      src.connect(hp);
      hp.connect(lp);
      lp.connect(g);
      g.connect(dest || this.sfx);
      src.start();
      src.stop(ctx.currentTime + dur + 0.05);
    },

    /** Short air throw whoosh (COD grenade foley). */
    whoosh(dur, vol) {
      const ctx = this.ctx;
      const mul = this._volMul == null ? 1 : this._volMul;
      const t0 = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuffer(Math.max(dur + 0.05, 0.1));
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1400, t0);
      bp.frequency.exponentialRampToValueAtTime(280, t0 + dur);
      bp.Q.value = 0.85;
      const g = ctx.createGain();
      this._env(g, t0, 0.008, (vol || 0.2) * mul, dur * 0.25, (vol || 0.2) * mul * 0.15, dur * 0.7);
      src.connect(bp);
      bp.connect(g);
      g.connect(this.sfx);
      src.start();
      src.stop(t0 + dur + 0.04);
    },

    /** Decaying modal ping — grenade body rattle on bounce. */
    metalHit(vol) {
      const v = vol || 0.2;
      const jitter = 0.97 + Math.random() * 0.06;
      const freqs = [640, 980, 1420, 1960, 2680];
      for (let i = 0; i < freqs.length; i++) {
        this.tone(freqs[i] * jitter, 0.055 + i * 0.018, i < 2 ? 'triangle' : 'sine', v * (0.14 - i * 0.02));
      }
      this.noiseBurst(0.035, v * 0.28, 1600, 9000);
    },

    _startMusic() {
      if (!this.enabled || this.inMatch) return;
      const ctx = this._ensure();
      if (!ctx) return;
      this._stopAmbient();
      if (this._musicSrc) return;

      const startBuf = (buf) => {
        if (!this.enabled || this._musicSrc) return;
        try {
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          src.connect(this.music);
          src.start(0);
          this._musicSrc = src;
          this._musicBuf = buf;
        } catch (e) { /* ignore */ }
      };

      if (this._musicBuf) {
        startBuf(this._musicBuf);
        return;
      }
      if (this._musicLoading) return;
      this._musicLoading = true;
      // Menu/hub BGM: drop any one of these in and it loops automatically.
      const paths = [
        'assets/music/menu.ogg',
        '../../assets/music/theme.wav',
      ];
      const tryLoad = (i) => {
        if (i >= paths.length) {
          this._musicLoading = false;
          return;
        }
        fetch(paths[i])
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .then((ab) => (ab ? ctx.decodeAudioData(ab.slice(0)) : null))
          .then((buf) => {
            this._musicLoading = false;
            if (buf) {
              this._musicBuf = buf;
              startBuf(buf);
            } else {
              tryLoad(i + 1);
            }
          })
          .catch(() => {
            this._musicLoading = false;
            tryLoad(i + 1);
          });
      };
      tryLoad(0);
    },

    _stopMusic() {
      if (this._musicSrc) {
        try {
          this._musicSrc.stop();
          this._musicSrc.disconnect();
        } catch (e) { /* ignore */ }
        this._musicSrc = null;
      }
      this._stopAmbient();
    },

    _startAmbient() {
      if (this._ambientNodes || !this.enabled || this._musicSrc) return;
      const ctx = this._ensure();
      if (!ctx) return;

      const drones = [];
      const freqs = [55, 82.5, 110];
      freqs.forEach((f, i) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        const lfo = ctx.createOscillator();
        const lfoG = ctx.createGain();
        osc.type = i === 0 ? 'sawtooth' : 'triangle';
        osc.frequency.value = f;
        g.gain.value = 0.04 - i * 0.008;
        lfo.frequency.value = 0.07 + i * 0.03;
        lfoG.gain.value = 0.012;
        lfo.connect(lfoG);
        lfoG.connect(g.gain);
        osc.connect(g);
        g.connect(this.music);
        osc.start();
        lfo.start();
        drones.push(osc, lfo, g);
      });

      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuffer(2.5);
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 280;
      const g = ctx.createGain();
      g.gain.value = 0.035;
      src.connect(lp);
      lp.connect(g);
      g.connect(this.music);
      src.start();
      drones.push(src, lp, g);

      this._ambientNodes = drones;
      this._rumbleCd = 1.5 + Math.random() * 2;
    },

    _stopAmbient() {
      if (!this._ambientNodes) return;
      this._ambientNodes.forEach((n) => {
        try {
          if (n.stop) n.stop();
          if (n.disconnect) n.disconnect();
        } catch (e) { /* ignore */ }
      });
      this._ambientNodes = null;
    },

    /** Delegated UI click ticks for menus / lobby / hub */
    bindUiClicks() {
      if (this._uiBound) return;
      this._uiBound = true;
      const self = this;
      document.addEventListener(
        'click',
        function (e) {
          if (!self.enabled) return;
          const t = e.target.closest(
            'button, .cover-btn, .hub-action, .class-card, .lobby-mode, .lobby-dock-item, .lobby-avatar-btn, .lobby-currency, .lobby-settings, [data-lobby-action], .me-tool, .me-btn, .sheet-close, a.menu-link'
          );
          if (!t) return;
          if (t.id === 'audio-toggle') return;
          if (t.disabled) return;
          self.play('ui');
        },
        true
      );
    },
  };

  const SOUNDS = {
    shoot_ar(A) {
      A.noiseBurst(0.07, 0.38, 600, 6500);
      A.tone(180 + Math.random() * 40, 0.06, 'sawtooth', 0.22);
      A.tone(90, 0.09, 'square', 0.12);
    },
    shoot_sg(A) {
      A.noiseBurst(0.16, 0.48, 200, 5000);
      A.tone(70, 0.14, 'sawtooth', 0.28);
      A.tone(140, 0.08, 'square', 0.1);
    },
    shoot_sr(A) {
      A.noiseBurst(0.22, 0.42, 400, 8000);
      A.tone(120, 0.18, 'sawtooth', 0.3);
      A.tone(55, 0.28, 'triangle', 0.18);
      // Distant crack tail
      A.later(40, function () {
        A.noiseBurst(0.12, 0.12, 1500, 6000);
      });
    },
    empty(A) {
      A.tone(220, 0.04, 'square', 0.08);
      A.noiseBurst(0.03, 0.1, 2000, 6000);
    },
    reload_start(A) {
      A.noiseBurst(0.05, 0.12, 1500, 5000);
      A.tone(320, 0.06, 'triangle', 0.1);
    },
    reload_mag(A) {
      A.tone(180, 0.05, 'square', 0.14);
      A.noiseBurst(0.04, 0.16, 800, 3500);
    },
    reload_rack(A) {
      A.noiseBurst(0.08, 0.22, 1000, 7000);
      A.tone(260, 0.07, 'sawtooth', 0.12);
      A.tone(140, 0.05, 'triangle', 0.08);
    },
    hit(A) {
      A.tone(980, 0.05, 'square', 0.18);
      A.tone(1480, 0.035, 'triangle', 0.12);
      A.noiseBurst(0.04, 0.14, 2200, 10000);
    },
    hit_heavy(A) {
      A.tone(680, 0.055, 'square', 0.2);
      A.tone(1100, 0.045, 'triangle', 0.15);
      A.tone(140, 0.08, 'triangle', 0.14);
      A.noiseBurst(0.07, 0.22, 600, 7500);
    },
    kill(A, opts) {
      opts = opts || {};
      const p = opts.pitch != null ? opts.pitch : 1;
      A.tone(990 * p, 0.045, 'square', 0.18);
      A.tone(1320 * p, 0.06, 'triangle', 0.16);
      A.tone(1760 * p, 0.08, 'triangle', 0.14);
      A.tone(90 * Math.min(1.15, p), 0.1, 'triangle', 0.18);
      A.noiseBurst(0.08, 0.2, 400, 6000);
      A.later(35, function () {
        A.tone(1480 * p, 0.05, 'triangle', 0.12);
      });
    },
    impact(A) {
      A.noiseBurst(0.07, 0.2, 200, 2800);
      A.tone(80, 0.06, 'triangle', 0.1);
      A.noiseBurst(0.04, 0.12, 80, 900);
    },
    melee_swing(A) {
      A.noiseBurst(0.07, 0.16, 1800, 9000);
      A.tone(420, 0.05, 'triangle', 0.08);
    },
    melee_hit(A) {
      A.noiseBurst(0.06, 0.28, 400, 5000);
      A.tone(220, 0.07, 'sawtooth', 0.16);
      A.tone(90, 0.09, 'triangle', 0.14);
    },
    melee_backstab(A) {
      A.noiseBurst(0.09, 0.32, 300, 6500);
      A.tone(180, 0.1, 'sawtooth', 0.2);
      A.tone(720, 0.06, 'triangle', 0.14);
      A.tone(1100, 0.05, 'square', 0.1);
    },
    break_block(A) {
      A.noiseBurst(0.1, 0.26, 100, 2200);
      A.tone(70, 0.08, 'triangle', 0.12);
      A.tone(110, 0.05, 'square', 0.07);
      A.noiseBurst(0.06, 0.14, 400, 3500);
    },
    distant_rumble(A) {
      // Quiet far-off thump — battlefield bed, never overpowers gunfire
      A.noiseBurst(0.22, 0.055, 30, 400);
      A.tone(42 + Math.random() * 18, 0.28, 'triangle', 0.045);
      A.tone(28, 0.35, 'sine', 0.03);
    },
    hurt(A) {
      A.noiseBurst(0.16, 0.4, 120, 3200);
      A.tone(120, 0.12, 'sawtooth', 0.22);
      A.tone(55, 0.18, 'triangle', 0.16);
      A.tone(200, 0.06, 'square', 0.1);
    },
    death(A) {
      A.noiseBurst(0.35, 0.35, 80, 1800);
      const ctx = A.ctx;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.55);
      g.gain.setValueAtTime(0.25, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
      osc.connect(g);
      g.connect(A.sfx);
      osc.start();
      osc.stop(ctx.currentTime + 0.65);
    },
    footstep(A, opts) {
      const crouch = opts.crouch;
      const sprint = opts.sprint;
      const vol = crouch ? 0.06 : sprint ? 0.16 : 0.11;
      A.noiseBurst(0.04, vol, 80, crouch ? 600 : 1400);
      A.tone(70 + Math.random() * 30, 0.035, 'triangle', vol * 0.5);
    },
    land(A) {
      A.noiseBurst(0.08, 0.2, 60, 900);
      A.tone(55, 0.08, 'triangle', 0.12);
    },
    jump(A) {
      A.tone(180, 0.08, 'triangle', 0.08);
      A.noiseBurst(0.04, 0.08, 400, 2000);
    },
    pickup(A) {
      A.tone(520, 0.06, 'square', 0.1);
      A.tone(780, 0.08, 'triangle', 0.09);
    },
    build(A) {
      A.noiseBurst(0.1, 0.22, 200, 2500);
      A.tone(160, 0.07, 'square', 0.12);
      A.tone(240, 0.05, 'triangle', 0.08);
    },
    ui(A) {
      const now = performance.now();
      if (A._uiClickAt && now - A._uiClickAt < 45) return;
      A._uiClickAt = now;
      A.tone(720 + Math.random() * 40, 0.035, 'triangle', 0.1);
      A.tone(980, 0.025, 'sine', 0.06);
      A.noiseBurst(0.02, 0.05, 2000, 8000);
    },
    /** Doodle switchWeapon: short bandpass rustle on draw. */
    switchWeapon(A) {
      const ctx = A.ctx;
      if (!ctx) return;
      const t0 = ctx.currentTime;
      const dur = 0.05;
      const mul = A._volMul == null ? 1 : A._volMul;
      const src = ctx.createBufferSource();
      src.buffer = A._noiseBuffer(Math.max(dur + 0.05, 0.1));
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800;
      bp.Q.value = 1.5;
      const g = ctx.createGain();
      A._env(g, t0, 0.004, 0.25 * mul, dur * 0.25, 0.08 * mul, dur * 0.7);
      src.connect(bp);
      bp.connect(g);
      g.connect(A.sfx);
      src.start(t0);
      src.stop(t0 + dur + 0.03);
    },
    confirm(A) {
      A.tone(392, 0.05, 'triangle', 0.11);
      A.tone(523, 0.07, 'triangle', 0.1);
      A.tone(659, 0.09, 'sine', 0.08);
    },
    warn(A) {
      A.tone(480, 0.1, 'square', 0.12);
      A.tone(360, 0.12, 'square', 0.1);
    },
    victory(A) {
      [523, 659, 784, 1046].forEach((f, i) => {
        A.later(i * 110, function () {
          A.tone(f, 0.18, 'triangle', 0.12);
        });
      });
    },
    defeat(A) {
      [392, 330, 262].forEach((f, i) => {
        A.later(i * 140, function () {
          A.tone(f, 0.22, 'sawtooth', 0.1);
        });
      });
    },
    dash(A) {
      A.noiseBurst(0.12, 0.28, 200, 4500);
      A.tone(180, 0.1, 'sawtooth', 0.14);
      A.tone(90, 0.14, 'triangle', 0.1);
    },
    stealth_on(A) {
      A.tone(520, 0.12, 'sine', 0.1);
      A.tone(780, 0.18, 'triangle', 0.08);
      A.noiseBurst(0.08, 0.1, 2000, 7000);
    },
    stealth_off(A) {
      A.tone(420, 0.08, 'triangle', 0.1);
      A.tone(180, 0.12, 'sawtooth', 0.08);
      A.noiseBurst(0.06, 0.16, 400, 3500);
    },
    shield_on(A) {
      A.tone(240, 0.1, 'triangle', 0.12);
      A.tone(480, 0.14, 'sine', 0.1);
      A.noiseBurst(0.06, 0.12, 800, 4000);
    },
    shield_hit(A) {
      A.tone(520, 0.04, 'square', 0.08);
      A.noiseBurst(0.04, 0.12, 1200, 5000);
    },
    shield_break(A) {
      A.noiseBurst(0.18, 0.35, 200, 4500);
      A.tone(160, 0.12, 'sawtooth', 0.14);
      A.tone(90, 0.16, 'triangle', 0.1);
    },
    emp(A) {
      A.noiseBurst(0.2, 0.28, 600, 8000);
      A.tone(880, 0.08, 'sine', 0.12);
      A.tone(220, 0.18, 'sawtooth', 0.16);
      A.tone(110, 0.22, 'triangle', 0.12);
      A.later(40, function () {
        A.noiseBurst(0.12, 0.18, 400, 5000);
      });
    },
    c4_plant(A) {
      A.tone(200, 0.06, 'square', 0.12);
      A.noiseBurst(0.05, 0.14, 600, 3000);
      A.tone(140, 0.08, 'triangle', 0.08);
    },
    /** COD-style pin + spoon: scrape then a bright metal click. */
    nade_pin(A) {
      A.noiseBurst(0.055, 0.16, 2200, 9000);
      A.tone(2100, 0.03, 'square', 0.1);
      A.later(42, function () {
        A.tone(1450, 0.028, 'triangle', 0.14);
        A.tone(780, 0.04, 'square', 0.08);
        A.noiseBurst(0.03, 0.12, 1800, 7000);
      });
    },
    nade_throw(A) {
      A.whoosh(0.14, 0.22);
      A.noiseBurst(0.06, 0.1, 400, 2500);
    },
    nade_bounce(A) {
      A.metalHit(0.55);
    },
    semtex_stick(A) {
      A.noiseBurst(0.06, 0.28, 200, 1800);
      A.tone(90, 0.08, 'triangle', 0.16);
      A.tone(240, 0.05, 'sine', 0.08);
    },
    semtex_beep(A) {
      A.tone(1180, 0.045, 'square', 0.12);
      A.tone(1760, 0.03, 'sine', 0.06);
    },
    semtex(A) {
      // Tighter than a frag: crack + punch, less dirt rain
      A.noiseBurst(0.06, 0.95, 200, 5000);
      A.noiseBurst(0.28, 0.7, 30, 900);
      A.tone(62, 0.16, 'sawtooth', 0.48);
      A.tone(34, 0.4, 'triangle', 0.28);
      A.later(50, function () {
        A.noiseBurst(0.14, 0.28, 80, 1600);
      });
    },
    explosion(A) {
      // Frag: transient crack, chest punch, then debris (COD mix puts debris up)
      A.noiseBurst(0.045, 1.0, 600, 9000);
      A.noiseBurst(0.12, 0.85, 80, 2200);
      A.tone(52, 0.18, 'sawtooth', 0.55);
      A.tone(28, 0.5, 'triangle', 0.32);
      A.tone(140, 0.08, 'square', 0.18);
      A.later(40, function () {
        A.noiseBurst(0.16, 0.42, 400, 4500);
        A.noiseBurst(0.22, 0.28, 1200, 8000);
      });
      A.later(110, function () {
        A.noiseBurst(0.2, 0.18, 600, 3500);
        A.tone(40, 0.22, 'triangle', 0.1);
      });
    },
    molotov(A) {
      // Bottle smash (bright shards) then petrol ignition whoosh
      A.noiseBurst(0.04, 0.55, 3200, 16000);
      A.tone(2800, 0.03, 'square', 0.2);
      A.tone(1950, 0.045, 'triangle', 0.16);
      A.tone(4100 + Math.random() * 600, 0.025, 'square', 0.12);
      A.tone(1250, 0.04, 'sine', 0.08);
      A.later(32, function () {
        A.whoosh(0.16, 0.28);
        A.noiseBurst(0.12, 0.32, 500, 5500);
        A.tone(240, 0.1, 'sawtooth', 0.12);
      });
    },
    flashbang(A) {
      // Little bass, lots of crack — then a brief ear ring lives on flash_ring
      A.noiseBurst(0.05, 0.85, 1500, 14000);
      A.tone(2400, 0.04, 'square', 0.28);
      A.tone(1350, 0.07, 'triangle', 0.16);
      A.noiseBurst(0.1, 0.28, 400, 5000);
    },
    flash_ring(A) {
      A.tone(3200, 0.55, 'sine', 0.1);
      A.tone(3180, 0.7, 'sine', 0.06);
      A.later(80, function () {
        A.tone(1600, 0.4, 'sine', 0.04);
      });
    },
    stun(A) {
      // Concussion: body hit + flux, not a frag crack
      A.noiseBurst(0.16, 0.72, 60, 900);
      A.tone(48, 0.22, 'sawtooth', 0.42);
      A.tone(26, 0.38, 'triangle', 0.3);
      A.whoosh(0.2, 0.18);
      A.later(50, function () {
        A.noiseBurst(0.14, 0.28, 80, 1400);
      });
    },
    smoke(A) {
      A.noiseBurst(0.05, 0.32, 400, 2800);
      A.tone(170, 0.05, 'triangle', 0.1);
      A.later(30, function () {
        A.noiseBurst(0.55, 0.22, 80, 1100);
      });
      A.later(90, function () {
        A.noiseBurst(0.7, 0.14, 40, 700);
      });
    },
  };

  // Voice announcer disabled — music + SFX only
  const Voice = {
    speak() { /* no-op */ },
    preload() { return Promise.resolve(); },
  };

  AudioSys.voice = Voice;

  const _origInit = AudioSys.init.bind(AudioSys);
  AudioSys.init = function () {
    try {
      _origInit();
    } catch (e) {
      console.warn('[Audio] init failed', e);
    }
    try {
      AudioSys.bindUiClicks();
    } catch (e) { /* ignore */ }
  };

  global.VF = global.VF || {};
  global.VF.Audio = AudioSys;
})(typeof window !== 'undefined' ? window : this);
