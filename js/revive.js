/**
 * revive.js — Conquest downed, bleed-out, drag and revive lifecycle.
 */
(function (global) {
  'use strict';

  function config() {
    const F = global.VF && global.VF.Feel && global.VF.Feel.revive;
    return {
      bleedSec: F && F.bleedSec != null ? F.bleedSec : 28,
      squadReviveSec: F && F.squadReviveSec != null ? F.squadReviveSec : 4.5,
      supportReviveSec: F && F.supportReviveSec != null ? F.supportReviveSec : 2.6,
      reviveHealth: F && F.reviveHealth != null ? F.reviveHealth : 35,
      reviveRange: F && F.reviveRange != null ? F.reviveRange : 2.5,
      protectionSec: F && F.protectionSec != null ? F.protectionSec : 1.5,
      dragRange: F && F.dragRange != null ? F.dragRange : 2.2,
      skipHoldSec: F && F.skipHoldSec != null ? F.skipHoldSec : 1.2,
      medicListRange: F && F.medicListRange != null ? F.medicListRange : 180,
      bleedSlowMul: F && F.bleedSlowMul != null ? F.bleedSlowMul : 0.5,
    };
  }

  function teamOf(entity) {
    return entity && entity.team === 'enemy' ? 'enemy' : 'ally';
  }

  function positionOf(entity) {
    if (!entity) return null;
    if (entity.object && entity.object.position) return entity.object.position;
    if (entity.mesh && entity.mesh.position) return entity.mesh.position;
    return null;
  }

  function distanceSq(a, b) {
    const pa = positionOf(a);
    const pb = positionOf(b);
    if (!pa || !pb) return Infinity;
    const dx = pa.x - pb.x;
    const dy = pa.y - pb.y;
    const dz = pa.z - pb.z;
    return dx * dx + dy * dy + dz * dz;
  }

  function CLASS_ZH(classId) {
    if (classId === 'engineer') return '工程兵';
    if (classId === 'support' || classId === 'medic') return '支援兵';
    if (classId === 'recon') return '侦察兵';
    return '突击兵';
  }

  function entityName(entityOrId) {
    const game = global.VF && global.VF.game;
    let entity = entityOrId;
    if (typeof entityOrId === 'string') {
      const squads = global.VF && global.VF.Squads;
      entity = squads && squads.getEntity ? squads.getEntity(entityOrId, game) : null;
      if (!entity && entityOrId === 'remote-player') return '敌方玩家';
      if (!entity && entityOrId === 'combat-area') return '作战区域';
      if (!entity && entityOrId === 'hq-security') return '总部防卫';
      if (!entity) return entityOrId || '未知';
    }
    if (!entity) return '未知';
    if (entity.displayName || entity.name) return entity.displayName || entity.name;
    if (game && game.player && entity === game.player) return '你';
    if (!entity.isAI && entity.object && !entity.mesh) return '你';
    const tag = CLASS_ZH(entity.classId);
    const digits = String(entity.entityId || '').replace(/\D/g, '');
    return tag + (digits ? '-' + digits.slice(-2) : '');
  }

  function rankFromId(id) {
    const s = String(id || 'x');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0;
    return 40 + Math.abs(h) % 360;
  }

  function ReviveSystem() {
    this._seq = 0;
    this._aiDowned = [];
    this._playerState = null;
    this._lastUiAt = 0;
  }

  ReviveSystem.prototype.reset = function () {
    this._seq = 0;
    this._playerState = null;
    this._aiDowned.length = 0;
    const g = global.VF && global.VF.game;
    if (g && g.player) {
      g.player.downed = false;
      g.player.downState = null;
      g.player.draggingTarget = null;
    }
  };

  ReviveSystem.prototype._lifeId = function (kind, subjectId) {
    const C = global.VF && global.VF.Conquest;
    const matchId = (C && C.matchId) || 'local';
    return matchId + ':' + kind + ':' + subjectId + ':' + ++this._seq;
  };

  ReviveSystem.prototype._isConquest = function () {
    const g = global.VF && global.VF.game;
    const C = global.VF && global.VF.Conquest;
    return !!(
      g &&
      (g.mode !== 'pvp' || (g.pvp && g.pvp.conquest)) &&
      C &&
      C.active &&
      !C._ended
    );
  };

  ReviveSystem.prototype.downPlayer = function (player) {
    if (!player || player.downState || !this._isConquest()) return false;
    const cfg = config();
    const lifeId = this._lifeId('player', 'local');
    const C = global.VF.Conquest;
    const casualtyId = C.onPlayerDown(teamOf(player), {
      defer: true,
      lifeId: lifeId,
      subjectId: 'player-local',
      reason: 'combat',
    });
    const state = {
      kind: 'player',
      entity: player,
      lifeId: lifeId,
      casualtyId: casualtyId,
      remaining: cfg.bleedSec,
      duration: cfg.bleedSec,
      reviveProgress: 0,
      reviverId: null,
      called: false,
      status: 'pending',
      killerId: player._lastDamagerId || null,
      killerTeam: player._lastDamagerTeam || null,
      killerWeaponId: player._lastDamagerWeaponId || null,
      skipHold: 0,
      bleedMul: 1,
      _eWas: true,
      _fWas: true,
      _spaceArmed: false,
    };
    player.downed = true;
    player.downState = state;
    player._cqTicketPending = false;
    this._playerState = state;
    if (global.VF.UI && global.VF.UI.showDowned) {
      global.VF.UI.showDowned(state.remaining, this._downedUiPayload(state));
    }
    if (C && C._emit) C._emit('soldier-downed', { subjectId: 'player-local', team: teamOf(player) });
    return true;
  };

  ReviveSystem.prototype.toggleBleedSlow = function () {
    const state = this._playerState;
    if (!state || state.status !== 'pending') return false;
    const cfg = config();
    const slow = cfg.bleedSlowMul != null ? cfg.bleedSlowMul : 0.5;
    const slowed = (state.bleedMul || 1) <= slow + 0.001;
    state.bleedMul = slowed ? 1 : slow;
    if (!slowed) this.callForHelp();
    else if (global.VF.UI && global.VF.UI.updateDowned) {
      global.VF.UI.updateDowned(this._downedUiPayload(state));
    }
    return true;
  };

  ReviveSystem.prototype.callForHelp = function () {
    const state = this._playerState;
    if (!state || state.status !== 'pending') return false;
    state.called = true;
    const C = global.VF && global.VF.Conquest;
    if (C && C._emit) {
      C._emit('revive-callout', {
        subjectId: 'player-local',
        team: teamOf(state.entity),
        position: positionOf(state.entity),
      });
    }
    if (global.VF.UI && global.VF.UI.updateDowned) {
      global.VF.UI.updateDowned(this._downedUiPayload(state));
    }
    return true;
  };

  ReviveSystem.prototype.giveUpPlayer = function () {
    const state = this._playerState;
    if (!state || state.status !== 'pending') return false;
    this._finalizePlayer(state, 'give-up');
    return true;
  };

  ReviveSystem.prototype._finalizePlayer = function (state, reason) {
    if (!state || state.status !== 'pending') return false;
    state.status = 'finalized';
    const net = global.VF && global.VF.NetSimulation;
    const game = global.VF && global.VF.game;
    const authoritative =
      !net || !net.isNetworkConquest(game) || net.isAuthority(game);
    if (authoritative && global.VF.Scoring && global.VF.Scoring.confirmKill) {
      global.VF.Scoring.confirmKill(
        state.killerId,
        'player-local',
        state.killerTeam,
        teamOf(state.entity),
        state.lifeId
      );
    }
    const player = state.entity;
    if (player) {
      player.downed = false;
      player.downState = null;
      player._cqTicketPending = {
        casualtyId: state.casualtyId,
        lifeId: state.lifeId,
        reason: reason,
        killerId: state.killerId || null,
        killerTeam: state.killerTeam || null,
        victimTeam: teamOf(state.entity),
      };
    }
    this._playerState = null;
    if (global.VF.UI && global.VF.UI.hideDeath) global.VF.UI.hideDeath();
    if (global.VF.openRedeployFromDeath) global.VF.openRedeployFromDeath();
    return true;
  };

  ReviveSystem.prototype.revivePlayer = function (reviver) {
    const state = this._playerState;
    if (!state || state.status !== 'pending') return false;
    state.status = 'revived';
    const C = global.VF && global.VF.Conquest;
    if (C && C.reviveCasualty) {
      C.reviveCasualty(state.casualtyId, {
        reviverId: (reviver && (reviver.entityId || reviver.id)) || 'ally-ai',
      });
    }
    const player = state.entity;
    player.downed = false;
    player.downState = null;
    player.dead = false;
    player.alive = true;
    player.health = Math.max(1, Math.round((player.maxHealth || 100) * (config().reviveHealth / 100)));
    player._reviveProtection = config().protectionSec;
    player.velocity.set(0, 0, 0);
    if (player._hideViewModels) player._hideViewModels(false);
    this._playerState = null;
    if (global.VF.UI) {
      if (global.VF.UI.hideDeath) global.VF.UI.hideDeath();
      if (global.VF.UI.updateVitals) global.VF.UI.updateVitals(player.health, player.armor);
      if (global.VF.UI.toast) global.VF.UI.toast('队友已将你救起');
    }
    return true;
  };

  ReviveSystem.prototype.downAI = function (unit, ai, opts) {
    if (!unit || unit.downed || !this._isConquest()) return false;
    opts = opts || {};
    const cfg = config();
    unit.lifeSerial = (unit.lifeSerial || 0) + 1;
    const subjectId = unit.entityId || 'ai-' + this._seq;
    const lifeId = this._lifeId('ai', subjectId + '-' + unit.lifeSerial);
    const C = global.VF.Conquest;
    const casualtyId = C.onDeath(teamOf(unit), {
      defer: true,
      lifeId: lifeId,
      subjectId: subjectId,
      reason: 'combat',
    });
    const state = {
      kind: 'ai',
      entity: unit,
      ai: ai,
      lifeId: lifeId,
      casualtyId: casualtyId,
      remaining: cfg.bleedSec,
      duration: cfg.bleedSec,
      reviveProgress: 0,
      reviverId: null,
      called: false,
      status: 'pending',
      hitDir: opts.hitDir || null,
      killedByPlayer: !!opts.fromPlayer,
      killerId: opts.attackerId || (opts.fromPlayer ? 'player-local' : null),
      killerTeam: opts.attackerTeam || null,
    };
    unit.alive = false;
    unit.downed = true;
    unit.downState = state;
    unit.hp = 0;
    unit.target = null;
    unit.state = 'downed';
    unit._reviveProtection = 0;
    if (unit.mesh) {
      unit.mesh.userData.downed = true;
      unit.mesh.rotation.z = -Math.PI * 0.5;
      unit.mesh.position.y = Math.max(0.1, unit.mesh.position.y + 0.25);
    }
    this._aiDowned.push(state);
    if (C && C._emit) C._emit('soldier-downed', { subjectId: subjectId, team: teamOf(unit) });
    return true;
  };

  ReviveSystem.prototype._finishAIVisuals = function (state) {
    const unit = state.entity;
    const ai = state.ai;
    if (!unit || !ai) return;
    const deathPos = unit.mesh ? unit.mesh.position.clone() : null;
    unit.downed = false;
    unit.downState = null;
    unit.alive = false;
    if (unit.mesh) {
      unit.mesh.userData.downed = false;
      unit.mesh.rotation.z = 0;
    }
    if (ai._playVoxelDeath) ai._playVoxelDeath(unit, state.hitDir);
    if (deathPos && ai.world && ai.world.stampDeathStain) {
      ai.world.stampDeathStain(deathPos.x, deathPos.y + 1, deathPos.z, unit.team, state.hitDir);
    }
    const playerTeam = ai.world && ai.world._playerTeam ? ai.world._playerTeam : 'ally';
    if (unit.team !== playerTeam && state.killedByPlayer && ai._registerPlayerKill) {
      ai._registerPlayerKill();
    }
    if (global.VF.Scoring && global.VF.Scoring.confirmKill) {
      global.VF.Scoring.confirmKill(
        state.killerId,
        unit.entityId,
        state.killerTeam,
        unit.team,
        state.lifeId
      );
    }
    const C = global.VF && global.VF.Conquest;
    if (C && C.flags && state.killerId && deathPos) {
      for (let i = 0; i < C.flags.length; i++) {
        const flag = C.flags[i];
        const dx = deathPos.x - flag.x;
        const dz = deathPos.z - flag.z;
        if (
          dx * dx + dz * dz <= flag.radius * flag.radius &&
          flag.owner === state.killerTeam &&
          C._isFullyHeld(flag, state.killerTeam)
        ) {
          C._emit('objective-player-defend', {
            actorId: state.killerId,
            team: state.killerTeam,
            letter: flag.letter,
          });
          break;
        }
      }
    }
    if (ai._queueConquestRespawn) ai._queueConquestRespawn(unit, { casualtySettled: true });
  };

  ReviveSystem.prototype.finalizeAI = function (state, reason) {
    if (!state || state.status !== 'pending') return false;
    state.status = 'finalized';
    const C = global.VF && global.VF.Conquest;
    if (C && C.finalizeCasualty) C.finalizeCasualty(state.casualtyId, { reason: reason || 'bleed-out' });
    this._finishAIVisuals(state);
    return true;
  };

  ReviveSystem.prototype.reviveAI = function (state, reviver) {
    if (!state || state.status !== 'pending') return false;
    state.status = 'revived';
    const unit = state.entity;
    const C = global.VF && global.VF.Conquest;
    if (C && C.reviveCasualty) {
      C.reviveCasualty(state.casualtyId, {
        reviverId: (reviver && (reviver.entityId || reviver.id)) || 'player-local',
      });
    }
    unit.downed = false;
    unit.downState = null;
    unit.alive = true;
    unit.hp = Math.max(1, Math.round((unit.maxHp || 100) * (config().reviveHealth / 100)));
    unit.state = 'patrol';
    unit._reviveProtection = config().protectionSec;
    if (unit.mesh) {
      unit.mesh.visible = true;
      unit.mesh.userData.downed = false;
      unit.mesh.rotation.z = 0;
    }
    if (global.VF.UI && global.VF.UI.toast && reviver && reviver.object) {
      global.VF.UI.toast('队友已复活');
    }
    return true;
  };

  ReviveSystem.prototype._isSupport = function (entity) {
    return !!(
      entity &&
      (entity.classId === 'support' || entity.classId === 'medic' || entity.roleClass === 'support')
    );
  };

  ReviveSystem.prototype._canRevive = function (reviver, target) {
    if (!reviver || !target || teamOf(reviver) !== teamOf(target)) return false;
    if (this._isSupport(reviver)) return true;
    const squads = global.VF && global.VF.Squads;
    if (squads && squads.areSquadmates) {
      return squads.areSquadmates(reviver.entityId || 'player-local', target.entityId || 'player-local');
    }
    return true;
  };

  ReviveSystem.prototype._nearestLivingAI = function (game, target, maxRange) {
    const ai = game && game.ai;
    if (!ai) return null;
    const list = teamOf(target) === 'enemy' ? ai.red : ai.blue;
    const maxSq = maxRange * maxRange;
    let best = null;
    let bestSq = maxSq;
    for (let i = 0; i < list.length; i++) {
      const unit = list[i];
      if (!unit || !unit.alive || unit.downed || !this._canRevive(unit, target)) continue;
      const d2 = distanceSq(unit, target);
      if (d2 < bestSq) {
        bestSq = d2;
        best = unit;
      }
    }
    return best;
  };

  ReviveSystem.prototype._reviveDuration = function (reviver) {
    const cfg = config();
    return this._isSupport(reviver) ? cfg.supportReviveSec : cfg.squadReviveSec;
  };

  ReviveSystem.prototype._tickPlayer = function (dt, game) {
    const state = this._playerState;
    if (!state || state.status !== 'pending') return;
    const cfg = config();
    const player = state.entity;
    const keys = (player && player.keys) || {};
    const ui = global.VF && global.VF.UI;
    const eDown = !!keys['KeyE'];
    if (eDown && !state._eWas) this.toggleBleedSlow();
    state._eWas = eDown;
    const fDown = !!keys['KeyF'];
    if (fDown && !state._fWas && ui && ui.toggleDownedDamageLog) ui.toggleDownedDamageLog();
    state._fWas = fDown;
    const holdingKey = !!(keys['Space'] || (ui && ui._skipMouseHold));
    if (!state._spaceArmed) {
      if (!holdingKey) state._spaceArmed = true;
    } else {
      if (holdingKey) state.skipHold = (state.skipHold || 0) + dt;
      else state.skipHold = 0;
    }
    if ((state.skipHold || 0) >= cfg.skipHoldSec) {
      this.giveUpPlayer();
      return;
    }
    const bleedMul = state.bleedMul == null ? 1 : state.bleedMul;
    state.remaining = Math.max(0, state.remaining - dt * bleedMul);
    const reviver = this._nearestLivingAI(game, state.entity, cfg.reviveRange);
    if (reviver) {
      state.reviverId = reviver.entityId;
      state.reviveProgress += dt / this._reviveDuration(reviver);
    } else {
      state.reviverId = null;
      state.reviveProgress = Math.max(0, state.reviveProgress - dt * 0.35);
    }
    if (state.reviveProgress >= 1) {
      this.revivePlayer(reviver);
      return;
    }
    if (state.remaining <= 0) {
      this._finalizePlayer(state, 'bleed-out');
      return;
    }
    const now = performance.now();
    if (!this._lastUiAt || now - this._lastUiAt > 80) {
      this._lastUiAt = now;
      if (ui && ui.updateDowned) ui.updateDowned(this._downedUiPayload(state));
    }
  };

  ReviveSystem.prototype.entityName = function (entityOrId) {
    return entityName(entityOrId);
  };

  ReviveSystem.prototype.listNearbyMedics = function (player, limit) {
    const game = global.VF && global.VF.game;
    const cfg = config();
    const maxRange = cfg.medicListRange || 180;
    const maxSq = maxRange * maxRange;
    const out = [];
    if (!player || !game || !game.ai) return out;
    const list = teamOf(player) === 'enemy' ? game.ai.red : game.ai.blue;
    for (let i = 0; i < list.length; i++) {
      const unit = list[i];
      if (!unit || !unit.alive || unit.downed || !this._canRevive(unit, player)) continue;
      const d2 = distanceSq(unit, player);
      if (d2 > maxSq) continue;
      out.push({
        id: unit.entityId,
        name: entityName(unit),
        dist: Math.sqrt(d2),
        classId: unit.classId,
        isSupport: this._isSupport(unit),
      });
    }
    out.sort(function (a, b) {
      return a.dist - b.dist;
    });
    return out.slice(0, limit || 5);
  };

  ReviveSystem.prototype._killerCard = function (state) {
    const id = state && state.killerId;
    return {
      id: id || null,
      name: id ? entityName(id) : '未知',
      rank: id ? rankFromId(id) : '—',
      weaponId: (state && state.killerWeaponId) || null,
    };
  };

  ReviveSystem.prototype._downedUiPayload = function (state) {
    const cfg = config();
    return {
      remaining: state.remaining,
      duration: state.duration || cfg.bleedSec,
      reviveProgress: state.reviveProgress,
      called: state.called,
      bleedMul: state.bleedMul == null ? 1 : state.bleedMul,
      skipHold: state.skipHold || 0,
      skipNeed: cfg.skipHoldSec,
      medics: this.listNearbyMedics(state.entity, 5),
      killer: this._killerCard(state),
    };
  };

  ReviveSystem.prototype._tickAIState = function (state, dt, game) {
    if (!state || state.status !== 'pending') return;
    const unit = state.entity;
    state.remaining = Math.max(0, state.remaining - dt);
    let reviver = null;
    const player = game && game.player;
    const cfg = config();
    const playerCan =
      player &&
      player.alive &&
      !player.dead &&
      !player.vehicleId &&
      this._canRevive(player, unit) &&
      distanceSq(player, unit) <= cfg.reviveRange * cfg.reviveRange;
    if (playerCan && player.keys && player.keys['KeyE']) {
      reviver = player;
    } else {
      reviver = this._nearestLivingAI(game, unit, cfg.reviveRange);
    }
    if (reviver) {
      state.reviverId = reviver.entityId || 'player-local';
      state.reviveProgress += dt / this._reviveDuration(reviver);
    } else {
      state.reviverId = null;
      state.reviveProgress = Math.max(0, state.reviveProgress - dt * 0.35);
    }
    if (state.reviveProgress >= 1) {
      this.reviveAI(state, reviver);
      return;
    }
    if (state.remaining <= 0) this.finalizeAI(state, 'bleed-out');
  };

  ReviveSystem.prototype._tickDrag = function (game) {
    const player = game && game.player;
    if (!player || !player.alive || player.dead || player.vehicleId || !player.keys) return;
    player.draggingTarget = null;
    if (!player.keys['KeyF'] || player.keys['KeyE']) return;
    const cfg = config();
    let target = null;
    let best = cfg.dragRange * cfg.dragRange;
    for (let i = 0; i < this._aiDowned.length; i++) {
      const state = this._aiDowned[i];
      if (!state || state.status !== 'pending' || teamOf(state.entity) !== teamOf(player)) continue;
      const d2 = distanceSq(player, state.entity);
      if (d2 < best) {
        best = d2;
        target = state.entity;
      }
    }
    if (!target || !target.mesh) return;
    const p = player.object.position;
    target.mesh.position.x = p.x + Math.sin(player.yaw) * 1.15;
    target.mesh.position.z = p.z + Math.cos(player.yaw) * 1.15;
    const world = game.world;
    if (world && world.getWalkHeight) {
      target.mesh.position.y = world.getWalkHeight(target.mesh.position.x, target.mesh.position.z) + 0.3;
    }
    player.draggingTarget = target;
  };

  ReviveSystem.prototype.update = function (dt, game) {
    if (!game || !this._isConquest()) return;
    const player = game.player;
    if (player && player._reviveProtection > 0) {
      player._reviveProtection = Math.max(0, player._reviveProtection - dt);
    }
    this._tickPlayer(dt, game);
    this._tickDrag(game);
    for (let i = 0; i < this._aiDowned.length; i++) {
      const state = this._aiDowned[i];
      if (!state || state.status !== 'pending') continue;
      const unit = state.entity;
      if (unit && unit._reviveProtection > 0) {
        unit._reviveProtection = Math.max(0, unit._reviveProtection - dt);
      }
      this._tickAIState(state, dt, game);
    }
    this._aiDowned = this._aiDowned.filter(function (state) {
      return state && state.status === 'pending';
    });
  };

  ReviveSystem.prototype.getDowned = function (team) {
    const t = team === 'enemy' ? 'enemy' : 'ally';
    const out = [];
    if (this._playerState && this._playerState.status === 'pending' && teamOf(this._playerState.entity) === t) {
      out.push(this._playerState);
    }
    for (let i = 0; i < this._aiDowned.length; i++) {
      const state = this._aiDowned[i];
      if (state.status === 'pending' && teamOf(state.entity) === t) out.push(state);
    }
    return out;
  };

  global.VF = global.VF || {};
  global.VF.Revive = new ReviveSystem();
})(typeof window !== 'undefined' ? window : this);
