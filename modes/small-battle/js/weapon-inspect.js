/**
 * weapon-inspect.js — match-end first-person inspect cam
 *
 * On win/lose, hold a short weapon-check pose before the scoreboard so the
 * cut to the result overlay is less abrupt. Always plays in full — the click
 * that ends the match would otherwise eat the whole cinematic.
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});

  const DURATION = 2.4;
  const HINT_ID = 'weapon-inspect-hint';

  const Inspect = {
    DURATION: DURATION,
    active: false,
    lastDurationMs: 0,
    _t: 0,
    _onDone: null,
    _hint: null,

    isActive: function () {
      return !!this.active;
    },

    play: function (onDone) {
      if (typeof onDone !== 'function') onDone = function () {};
      if (this.active) {
        this._onDone = onDone;
        return;
      }

      const g = VF.game;
      const player = g && g.player;
      if (!player || !player.camera) {
        this.lastDurationMs = 0;
        onDone();
        return;
      }

      this.active = true;
      this._t = 0;
      this.lastDurationMs = 0;
      this._onDone = onDone;

      if (player.beginWeaponInspect) player.beginWeaponInspect();
      document.body.classList.add('weapon-inspect');
      this._ensureHint();
    },

    update: function (dt) {
      if (!this.active) return;
      this._t += dt > 0 ? dt : 0;
      const g = VF.game;
      const player = g && g.player;
      if (player && player.updateWeaponInspect) player.updateWeaponInspect(dt);
      if (this._t >= DURATION) this._finish();
    },

    /** Leave the match without revealing the scoreboard. */
    cancel: function () {
      if (!this.active) return;
      this.lastDurationMs = Math.round(this._t * 1000);
      this._onDone = null;
      this._teardown();
    },

    _finish: function () {
      if (!this.active) return;
      this.lastDurationMs = Math.round(this._t * 1000);
      const cb = this._onDone;
      this._onDone = null;
      this._teardown();
      if (cb) cb();
    },

    _teardown: function () {
      this.active = false;
      document.body.classList.remove('weapon-inspect');
      const g = VF.game;
      const player = g && g.player;
      if (player && player.endWeaponInspect) player.endWeaponInspect();
      if (this._hint) this._hint.classList.add('hidden');
    },

    _ensureHint: function () {
      let el = document.getElementById(HINT_ID);
      if (!el) {
        el = document.createElement('div');
        el.id = HINT_ID;
        document.body.appendChild(el);
      }
      el.textContent = '检查武器';
      el.classList.remove('hidden');
      this._hint = el;
    },
  };

  VF.WeaponInspect = Inspect;
})(typeof window !== 'undefined' ? window : globalThis);
