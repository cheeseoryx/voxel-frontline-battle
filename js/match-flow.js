/**
 * match-flow.js — Conquest warmup/live/post phases, combat area and HQ protection.
 */
(function (global) {
  'use strict';

  function MatchFlow() {
    this.phase = 'idle';
    this.warmupRemaining = 0;
    this.postRemaining = 0;
    this.outOfBounds = 0;
    this.hqIntrusion = 0;
    this.rotation = ['rift-ridge'];
    this.rotationIndex = 0;
    this._lastWarnAt = 0;
    this._roundUnsub = null;
    this._bind();
  }

  MatchFlow.prototype._bind = function () {
    const C = global.VF && global.VF.Conquest;
    const self = this;
    if (C && C.on) {
      this._roundUnsub = C.on('round-ended', function () {
        self.phase = 'post';
        self.postRemaining = 12;
      });
    }
  };

  MatchFlow.prototype.start = function (game) {
    this.phase = 'warmup';
    this.warmupRemaining = 8;
    this.postRemaining = 0;
    this.outOfBounds = 0;
    this.hqIntrusion = 0;
    const C = global.VF && global.VF.Conquest;
    if (C) C.phase = 'warmup';
    const validation = this.validateLayout(game && game.world, C && C.flags);
    if (!validation.ok) {
      console.warn('[VF] conquest layout validation', validation.errors);
    }
    if (global.VF.UI && global.VF.UI.setObjective) {
      global.VF.UI.setObjective('战备阶段 · 等待交战开始');
    }
  };

  MatchFlow.prototype.stop = function () {
    this.phase = 'idle';
    this.warmupRemaining = 0;
    this.postRemaining = 0;
    this.outOfBounds = 0;
    this.hqIntrusion = 0;
  };

  MatchFlow.prototype.canRunRules = function (game) {
    if (!game || !global.VF.Conquest || !global.VF.Conquest.active) return false;
    if (global.VF.NetSimulation && !global.VF.NetSimulation.isAuthority(game)) return false;
    return this.phase === 'live';
  };

  MatchFlow.prototype._teamBase = function (world, team) {
    if (!world) return null;
    return team === 'enemy' ? world._enemyBasePos : world._allyBasePos;
  };

  MatchFlow.prototype._insideHq = function (world, position, team, radius) {
    const base = this._teamBase(world, team);
    if (!base || !position) return false;
    const dx = position.x - base.x;
    const dz = position.z - base.z;
    const r = radius || 42;
    return dx * dx + dz * dz <= r * r;
  };

  MatchFlow.prototype.canDamage = function (target, sourceTeam) {
    const g = global.VF && global.VF.game;
    if (!g || !g.world || !target) return true;
    if (this.phase === 'warmup' || this.phase === 'post') return false;
    const targetTeam =
      target.team || (target === g.player ? g.world._playerTeam || 'ally' : 'ally');
    if (!sourceTeam || sourceTeam === targetTeam) return true;
    const pos = target.object ? target.object.position : target.mesh && target.mesh.position;
    if (this._insideHq(g.world, pos, targetTeam, 34)) return false;
    return true;
  };

  MatchFlow.prototype._insideCombatArea = function (world, position) {
    if (!world || !position) return true;
    const margin = 3;
    return (
      position.x >= margin &&
      position.z >= margin &&
      position.x <= world.worldSize - margin &&
      position.z <= world.worldSize - margin
    );
  };

  MatchFlow.prototype._warn = function (text) {
    const t = performance.now();
    if (t - this._lastWarnAt < 1200) return;
    this._lastWarnAt = t;
    if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast(text);
  };

  MatchFlow.prototype._tickBoundary = function (dt, game) {
    const player = game.player;
    if (!player || player.dead || !player.object) {
      this.outOfBounds = 0;
      this.hqIntrusion = 0;
      return;
    }
    if (!this._insideCombatArea(game.world, player.object.position)) {
      this.outOfBounds += dt;
      const left = Math.max(0, Math.ceil(10 - this.outOfBounds));
      this._warn('返回战区 · ' + left + 's');
      if (this.outOfBounds >= 10 && player.takeDamage) {
        player.takeDamage(35 * dt, null, { id: 'combat-area', team: player.team === 'enemy' ? 'ally' : 'enemy' });
      }
    } else {
      this.outOfBounds = 0;
    }

    const team = player.team || game.world._playerTeam || 'ally';
    const enemyHq = team === 'enemy' ? 'ally' : 'enemy';
    if (this._insideHq(game.world, player.object.position, enemyHq, 30)) {
      this.hqIntrusion += dt;
      const left = Math.max(0, Math.ceil(6 - this.hqIntrusion));
      this._warn('敌方主基地保护区 · 撤离 ' + left + 's');
      if (this.hqIntrusion >= 6 && player.takeDamage) {
        player.takeDamage(45 * dt, null, { id: 'hq-security', team: enemyHq });
      }
    } else {
      this.hqIntrusion = 0;
    }
  };

  MatchFlow.prototype.update = function (dt, game) {
    if (!game || !global.VF.Conquest || !global.VF.Conquest.active) return;
    const C = global.VF.Conquest;
    if (this.phase === 'warmup') {
      this.warmupRemaining = Math.max(0, this.warmupRemaining - dt);
      if (global.VF.UI && global.VF.UI.setObjective) {
        global.VF.UI.setObjective('战备阶段 · ' + Math.ceil(this.warmupRemaining) + ' 秒');
      }
      if (this.warmupRemaining <= 0) {
        this.phase = 'live';
        C.phase = 'running';
        C._emit('round-live', C.getStateSnapshot());
        if (global.VF.UI && global.VF.UI.setObjective) {
          global.VF.UI.setObjective('占领旗帜 · 耗尽敌方增援');
        }
        if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast('交战开始');
      }
    } else if (this.phase === 'live') {
      this._tickBoundary(dt, game);
    } else if (this.phase === 'post') {
      this.postRemaining = Math.max(0, this.postRemaining - dt);
    }
  };

  MatchFlow.prototype.validateLayout = function (world, flags) {
    const errors = [];
    if (!world) return { ok: false, errors: ['missing-world'] };
    const list = flags || [];
    if (list.length < 3 || list.length > 7) errors.push('flag-count');
    for (let i = 0; i < list.length; i++) {
      const flag = list[i];
      if (!this._insideCombatArea(world, flag)) errors.push('flag-outside:' + flag.letter);
      for (let j = i + 1; j < list.length; j++) {
        if (Math.hypot(flag.x - list[j].x, flag.z - list[j].z) < 60) {
          errors.push('flags-too-close:' + flag.letter + list[j].letter);
        }
      }
      const ally = this._teamBase(world, 'ally');
      const enemy = this._teamBase(world, 'enemy');
      if (ally && Math.hypot(flag.x - ally.x, flag.z - ally.z) < 45) {
        errors.push('flag-near-ally-hq:' + flag.letter);
      }
      if (enemy && Math.hypot(flag.x - enemy.x, flag.z - enemy.z) < 45) {
        errors.push('flag-near-enemy-hq:' + flag.letter);
      }
    }
    return { ok: errors.length === 0, errors: errors };
  };

  MatchFlow.prototype.nextMap = function () {
    this.rotationIndex = (this.rotationIndex + 1) % this.rotation.length;
    return this.rotation[this.rotationIndex];
  };

  MatchFlow.prototype.getState = function () {
    return {
      phase: this.phase,
      warmupRemaining: this.warmupRemaining,
      postRemaining: this.postRemaining,
      outOfBounds: this.outOfBounds,
      hqIntrusion: this.hqIntrusion,
      mapId: this.rotation[this.rotationIndex],
      nextMapId: this.rotation[(this.rotationIndex + 1) % this.rotation.length],
    };
  };

  global.VF = global.VF || {};
  global.VF.MatchFlow = new MatchFlow();
})(typeof window !== 'undefined' ? window : this);
