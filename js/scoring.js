/**
 * scoring.js — Event-driven individual, squad and team conquest scoring.
 */
(function (global) {
  'use strict';

  const SCORE = {
    kill: 100,
    assist: 50,
    revive: 75,
    capture: 300,
    defend: 80,
    heal: 10,
    resupply: 10,
    spot: 5,
    gadget: 40,
    order: 200,
  };

  function ScoringSystem() {
    this.players = Object.create(null);
    this.damage = Object.create(null);
    this.processed = Object.create(null);
    this.cooldowns = Object.create(null);
    this.events = [];
    this.team = { ally: { score: 0 }, enemy: { score: 0 } };
    this._unsubscribe = null;
    this._bind();
  }

  ScoringSystem.prototype._bind = function () {
    const C = global.VF && global.VF.Conquest;
    if (!C || !C.on || this._unsubscribe) return;
    const self = this;
    this._unsubscribe = C.on('*', function (event) {
      self._onConquestEvent(event);
    });
  };

  ScoringSystem.prototype.reset = function () {
    this.players = Object.create(null);
    this.damage = Object.create(null);
    this.processed = Object.create(null);
    this.cooldowns = Object.create(null);
    this.events = [];
    this.team = { ally: { score: 0 }, enemy: { score: 0 } };
    this._seedRoster();
  };

  ScoringSystem.prototype._seedRoster = function () {
    const squads = global.VF && global.VF.Squads;
    if (!squads || !squads.squads) return;
    const teams = ['ally', 'enemy'];
    for (let t = 0; t < teams.length; t++) {
      const list = squads.squads[teams[t]] || [];
      for (let i = 0; i < list.length; i++) {
        for (let m = 0; m < list[i].memberIds.length; m++) {
          this._profile(list[i].memberIds[m], teams[t], list[i].id);
        }
      }
    }
  };

  ScoringSystem.prototype._profile = function (id, team, squadId) {
    id = id || 'system-' + (team || 'neutral');
    let profile = this.players[id];
    if (!profile) {
      profile = this.players[id] = {
        id: id,
        team: team === 'enemy' ? 'enemy' : 'ally',
        squadId: squadId || null,
        score: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        revives: 0,
        heals: 0,
        resupplies: 0,
        captures: 0,
        defends: 0,
        spots: 0,
        ribbons: [],
      };
    }
    if (team) profile.team = team === 'enemy' ? 'enemy' : 'ally';
    if (squadId) profile.squadId = squadId;
    return profile;
  };

  ScoringSystem.prototype._entityMeta = function (id) {
    const g = global.VF && global.VF.game;
    const squads = global.VF && global.VF.Squads;
    const entity = squads && squads.getEntity ? squads.getEntity(id, g) : null;
    return {
      team:
        (entity && entity.team) ||
        (id === 'player-local' && g && g.world && g.world._playerTeam) ||
        'ally',
      squadId: (entity && entity.squadId) || (squads && squads.memberIndex && squads.memberIndex[id]) || null,
    };
  };

  ScoringSystem.prototype._add = function (id, points, reason, meta) {
    if (!id || !(points > 0)) return null;
    const info = this._entityMeta(id);
    const profile = this._profile(id, info.team, info.squadId);
    profile.score += Math.round(points);
    this.team[profile.team].score += Math.round(points);
    const entry = {
      id:
        ((global.VF.Conquest && global.VF.Conquest.matchId) || 'local') +
        ':score:' +
        (this.events.length + 1),
      actorId: id,
      team: profile.team,
      squadId: profile.squadId,
      value: Math.round(points),
      reason: reason,
      elapsed: global.VF.Conquest ? global.VF.Conquest.elapsed : 0,
      meta: meta || null,
    };
    this.events.push(entry);
    if (this.events.length > 2048) this.events.shift();
    this._checkRibbons(profile);
    return entry;
  };

  ScoringSystem.prototype._checkRibbons = function (profile) {
    const checks = [
      ['combat', profile.kills >= 5],
      ['objective', profile.captures + profile.defends >= 3],
      ['support', profile.revives + profile.heals + profile.resupplies >= 8],
      ['squad', profile.score >= 1500],
    ];
    for (let i = 0; i < checks.length; i++) {
      if (checks[i][1] && profile.ribbons.indexOf(checks[i][0]) < 0) {
        profile.ribbons.push(checks[i][0]);
      }
    }
  };

  ScoringSystem.prototype.recordDamage = function (
    attackerId,
    targetId,
    amount,
    attackerTeam,
    targetTeam
  ) {
    if (!attackerId || !targetId || attackerId === targetId || !(amount > 0)) return;
    const key = targetId;
    const list = this.damage[key] || (this.damage[key] = []);
    list.push({
      attackerId: attackerId,
      amount: amount,
      at: performance.now(),
      attackerTeam: attackerTeam,
      targetTeam: targetTeam,
    });
    const cutoff = performance.now() - 12000;
    this.damage[key] = list.filter(function (entry) {
      return entry.at >= cutoff;
    });
  };

  ScoringSystem.prototype.confirmKill = function (
    killerId,
    targetId,
    killerTeam,
    targetTeam,
    lifeId
  ) {
    const eventId = lifeId || 'kill:' + targetId + ':' + Math.floor(performance.now() / 250);
    if (this.processed[eventId]) return false;
    this.processed[eventId] = true;
    if (killerId) {
      const killer = this._profile(killerId, killerTeam, null);
      killer.kills++;
      this._add(killerId, SCORE.kill, 'kill', { targetId: targetId });
    }
    const victim = this._profile(targetId, targetTeam, null);
    victim.deaths++;
    const list = this.damage[targetId] || [];
    const totals = Object.create(null);
    const cutoff = performance.now() - 10000;
    for (let i = 0; i < list.length; i++) {
      const hit = list[i];
      if (hit.at < cutoff || hit.attackerId === killerId) continue;
      totals[hit.attackerId] = (totals[hit.attackerId] || 0) + hit.amount;
    }
    for (const assisterId in totals) {
      if (totals[assisterId] < 15) continue;
      const assister = this._profile(assisterId, null, null);
      assister.assists++;
      this._add(assisterId, SCORE.assist, 'assist', {
        targetId: targetId,
        damage: Math.round(totals[assisterId]),
      });
    }
    delete this.damage[targetId];
    return true;
  };

  ScoringSystem.prototype._cooldownScore = function (key, intervalMs) {
    const t = performance.now();
    if (this.cooldowns[key] && t - this.cooldowns[key] < intervalMs) return false;
    this.cooldowns[key] = t;
    return true;
  };

  ScoringSystem.prototype._onConquestEvent = function (event) {
    if (!event || !event.type) return;
    const data = event.data || {};
    if (event.type === 'round-start') {
      this.reset();
      return;
    }
    if (this.processed[event.id]) return;
    this.processed[event.id] = true;
    if (event.type === 'casualty-revived' && data.reviverId) {
      const p = this._profile(data.reviverId, null, null);
      p.revives++;
      this._add(data.reviverId, SCORE.revive, 'revive', { targetId: data.subjectId });
    } else if (event.type === 'objective-player-capture' && data.actorId) {
      const p = this._profile(data.actorId, data.team, data.squadId);
      p.captures++;
      this._add(data.actorId, SCORE.capture, 'capture', { letter: data.letter });
    } else if (event.type === 'objective-player-defend' && data.actorId) {
      const p = this._profile(data.actorId, data.team, data.squadId);
      p.defends++;
      this._add(data.actorId, SCORE.defend, 'defend', { letter: data.letter });
    } else if (event.type === 'soldier-healed' && data.actorId) {
      const key = 'heal:' + data.actorId + ':' + data.targetId;
      if (this._cooldownScore(key, 2500)) {
        const p = this._profile(data.actorId, null, null);
        p.heals++;
        this._add(data.actorId, SCORE.heal, 'heal', data);
      }
    } else if (event.type === 'soldier-resupplied' && data.actorId) {
      const key = 'ammo:' + data.actorId + ':' + data.targetId;
      if (this._cooldownScore(key, 4000)) {
        const p = this._profile(data.actorId, null, null);
        p.resupplies++;
        this._add(data.actorId, SCORE.resupply, 'resupply', data);
      }
    } else if (event.type === 'soldier-spotted' && data.actorId) {
      const key = 'spot:' + data.actorId + ':' + data.targetId;
      if (this._cooldownScore(key, 6000)) {
        const p = this._profile(data.actorId, null, null);
        p.spots++;
        this._add(data.actorId, SCORE.spot, 'spot', data);
      }
    } else if (event.type === 'gadget-destroyed' && data.actorId) {
      this._add(data.actorId, SCORE.gadget, 'gadget-destroyed', data);
    } else if (event.type === 'squad-order-completed' && data.squadId) {
      const squads = global.VF && global.VF.Squads;
      const squad = squads && squads.getSquad ? squads.getSquad(data.squadId) : null;
      if (squad) {
        for (let i = 0; i < squad.memberIds.length; i++) {
          this._add(squad.memberIds[i], SCORE.order, 'squad-order', {
            squadId: squad.id,
            order: data.order,
          });
        }
      }
    }
  };

  ScoringSystem.prototype.getSnapshot = function () {
    const players = [];
    for (const id in this.players) players.push(Object.assign({}, this.players[id]));
    players.sort(function (a, b) {
      return b.score - a.score || b.kills - a.kills || a.id.localeCompare(b.id);
    });
    return {
      team: {
        ally: Object.assign({}, this.team.ally),
        enemy: Object.assign({}, this.team.enemy),
      },
      players: players,
      events: this.events.slice(),
    };
  };

  global.VF = global.VF || {};
  global.VF.Scoring = new ScoringSystem();
  global.VF.SCORE_VALUES = SCORE;
})(typeof window !== 'undefined' ? window : this);
