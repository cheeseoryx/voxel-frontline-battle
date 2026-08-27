/**
 * audio.js — Procedural SFX + light ambient via Web Audio API (no asset files).
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
    _ambientNodes: null,
    _stepCd: 0,
    _lastLanded: true,
    _uiClickCd: 0,
    _rumbleCd: 3,

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
        if (this.enabled) this._startMusic();
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
      if (this.enabled) this._startMusic();
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

    play(name, opts) {
      if (!this.enabled) return;
      const ctx = this._ensure();
      if (!ctx) return;
      const run = () => {
        const fn = SOUNDS[name];
        if (fn) fn(this, opts || {});
      };
      // Browsers drop scheduled nodes while suspended — wait for resume.
      if (ctx.state === 'suspended') {
        this._queue = this._queue || [];
        if (this._queue.length < 24) this._queue.push(run);
        ctx.resume().then(() => {
          this.unlocked = true;
          this._flushQueue();
          if (this.enabled) this._startMusic();
        }).catch(function () {});
        return;
      }
      run();
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
      this._rumbleCd = Math.max(0, (this._rumbleCd || 0) - dt);

      // Soft battlefield bed only when no theme track is looping
      if (!this._musicSrc && this._rumbleCd <= 0) {
        this.play('distant_rumble');
        this._rumbleCd = 2.2 + Math.random() * 3.2;
      }

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
      osc.type = type || 'square';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      this._env(g, ctx.currentTime, 0.005, vol || 0.2, dur * 0.25, (vol || 0.2) * 0.35, dur * 0.7);
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
      this._env(g, ctx.currentTime, 0.001, vol || 0.3, dur * 0.2, (vol || 0.3) * 0.2, dur * 0.75);
      src.connect(hp);
      hp.connect(lp);
      lp.connect(g);
      g.connect(dest || this.sfx);
      src.start();
      src.stop(ctx.currentTime + dur + 0.05);
    },

    _startMusic() {
      if (!this.enabled) return;
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
      const paths = ['assets/music/theme.mp3', 'assets/music/theme.wav'];
      const tryLoad = (i) => {
        if (i >= paths.length) {
          this._musicLoading = false;
          this._startAmbient(); // soft pad fallback only if no file
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
            'button, .cover-btn, .hub-action, .class-card, .lobby-mode, .lobby-dock-item, .lobby-avatar-btn, .lobby-currency, .lobby-settings, [data-lobby-action], .me-tool, .me-btn, .sheet-close, a.menu-link, .mode-card, .mode-quit, .mode-tab, .deploy-class, .deploy-rect, .deploy-back'
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
      setTimeout(() => {
        if (!A.enabled) return;
        A.noiseBurst(0.12, 0.12, 1500, 6000);
      }, 40);
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
      setTimeout(function () {
        if (!A.enabled) return;
        A.tone(1480 * p, 0.05, 'triangle', 0.12);
      }, 35);
    },
    impact(A) {
      A.noiseBurst(0.07, 0.2, 200, 2800);
      A.tone(80, 0.06, 'triangle', 0.1);
      A.noiseBurst(0.04, 0.12, 80, 900);
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
        setTimeout(() => {
          if (!A.enabled) return;
          A.tone(f, 0.18, 'triangle', 0.12);
        }, i * 110);
      });
    },
    defeat(A) {
      [392, 330, 262].forEach((f, i) => {
        setTimeout(() => {
          if (!A.enabled) return;
          A.tone(f, 0.22, 'sawtooth', 0.1);
        }, i * 140);
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
      setTimeout(function () {
        if (!A.enabled) return;
        A.noiseBurst(0.12, 0.18, 400, 5000);
      }, 40);
    },
    c4_plant(A) {
      A.tone(200, 0.06, 'square', 0.12);
      A.noiseBurst(0.05, 0.14, 600, 3000);
      A.tone(140, 0.08, 'triangle', 0.08);
    },
    explosion(A) {
      A.noiseBurst(0.35, 0.55, 40, 2200);
      A.tone(70, 0.28, 'sawtooth', 0.32);
      A.tone(40, 0.4, 'triangle', 0.22);
      setTimeout(function () {
        if (!A.enabled) return;
        A.noiseBurst(0.2, 0.22, 80, 1600);
      }, 50);
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
