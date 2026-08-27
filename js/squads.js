/**
 * squads.js — Four-person squads, leaders and objective orders.
 */
(function (global) {
  'use strict';

  const NAMES = ['阿尔法', '布拉沃', '查理', '德尔塔', '回声', '狐步', '高尔夫', '旅馆'];
  const SIZE = 4;

  function teamOf(entity) {
    return entity && entity.team === 'enemy' ? 'enemy' : 'ally';
  }

  function SquadManager() {
    this.squads = { ally: [], enemy: [] };
    this.memberIndex = Object.create(null);
    this.version = 0;
    this._orderSeq = 0;
  }

  SquadManager.prototype.reset = function () {
    this.squads = { ally: [], enemy: [] };
    this.memberIndex = Object.create(null);
    this.version++;
  };

  SquadManager.prototype._emit = function (type, data) {
    const C = global.VF && global.VF.Conquest;
    if (C && C._emit) C._emit(type, data);
  };

  SquadManager.prototype._membersForTeam = function (game, team) {
    const out = [];
    const player = game && game.player;
    const playerTeam =
      (player && player.team) || (game && game.world && game.world._playerTeam) || 'ally';
    if (player && playerTeam === team) {
      player.entityId = player.entityId || 'player-local';
      out.push(player);
    }
    const ai = game && game.ai;
    const list = ai ? (team === 'enemy' ? ai.red : ai.blue) : [];
    for (let i = 0; i < list.length; i++) {
      if (list[i]) out.push(list[i]);
    }
    return out;
  };

  SquadManager.prototype.buildRosters = function (game) {
    this.reset();
    const teams = ['ally', 'enemy'];
    for (let t = 0; t < teams.length; t++) {
      const team = teams[t];
      const entities = this._membersForTeam(game, team);
      for (let i = 0; i < entities.length; i += SIZE) {
        const index = Math.floor(i / SIZE);
        const id = team + '-squad-' + (index + 1);
        const squad = {
          id: id,
          team: team,
          index: index,
          name: NAMES[index] || '小队 ' + (index + 1),
          leaderId: null,
          memberIds: [],
          order: null,
          score: 0,
          locked: false,
          version: 1,
        };
        for (let k = i; k < Math.min(entities.length, i + SIZE); k++) {
          const entity = entities[k];
          if (!entity.entityId) entity.entityId = 'unit-' + team + '-' + k;
          entity.squadId = id;
          entity.isSquadLeader = false;
          squad.memberIds.push(entity.entityId);
          this.memberIndex[entity.entityId] = id;
        }
        if (squad.memberIds.length) {
          squad.leaderId = squad.memberIds[0];
          const leader = this.getEntity(squad.leaderId, game);
          if (leader) leader.isSquadLeader = true;
        }
        this.squads[team].push(squad);
      }
    }
    this.version++;
    this._emit('squads-built', this.getSnapshot());
    return this.squads;
  };

  SquadManager.prototype.getEntity = function (entityId, game) {
    if (!entityId) return null;
    const g = game || (global.VF && global.VF.game);
    if (!g) return null;
    if (g.player && (g.player.entityId || 'player-local') === entityId) return g.player;
    const ai = g.ai;
    const lists = ai ? [ai.blue || [], ai.red || []] : [];
    for (let L = 0; L < lists.length; L++) {
      for (let i = 0; i < lists[L].length; i++) {
        if (lists[L][i] && lists[L][i].entityId === entityId) return lists[L][i];
      }
    }
    return null;
  };

  SquadManager.prototype.getSquad = function (squadId) {
    if (!squadId) return null;
    const team = squadId.indexOf('enemy-') === 0 ? 'enemy' : 'ally';
    const list = this.squads[team] || [];
    for (let i = 0; i < list.length; i++) if (list[i].id === squadId) return list[i];
    return null;
  };

  SquadManager.prototype.getSquadFor = function (entityOrId) {
    const id = typeof entityOrId === 'string' ? entityOrId : entityOrId && entityOrId.entityId;
    return this.getSquad(this.memberIndex[id]);
  };

  SquadManager.prototype.areSquadmates = function (a, b) {
    const aid = typeof a === 'string' ? a : a && a.entityId;
    const bid = typeof b === 'string' ? b : b && b.entityId;
    return !!(aid && bid && this.memberIndex[aid] && this.memberIndex[aid] === this.memberIndex[bid]);
  };

  SquadManager.prototype.leaveSquad = function (entityId, game) {
    const squad = this.getSquadFor(entityId);
    if (!squad) return false;
    const at = squad.memberIds.indexOf(entityId);
    if (at >= 0) squad.memberIds.splice(at, 1);
    delete this.memberIndex[entityId];
    const entity = this.getEntity(entityId, game);
    if (entity) {
      entity.squadId = null;
      entity.isSquadLeader = false;
    }
    if (squad.leaderId === entityId) {
      squad.leaderId = squad.memberIds[0] || null;
      const next = this.getEntity(squad.leaderId, game);
      if (next) next.isSquadLeader = true;
    }
    squad.version++;
    this.version++;
    this._emit('squad-member-left', { squadId: squad.id, memberId: entityId });
    return true;
  };

  SquadManager.prototype.joinSquad = function (entityId, squadId, game) {
    const squad = this.getSquad(squadId);
    const entity = this.getEntity(entityId, game);
    if (
      !squad ||
      !entity ||
      squad.locked ||
      squad.memberIds.length >= SIZE ||
      teamOf(entity) !== squad.team
    ) {
      return false;
    }
    if (this.memberIndex[entityId] === squadId) return true;
    this.leaveSquad(entityId, game);
    squad.memberIds.push(entityId);
    this.memberIndex[entityId] = squad.id;
    entity.squadId = squad.id;
    entity.isSquadLeader = false;
    if (!squad.leaderId) {
      squad.leaderId = entityId;
      entity.isSquadLeader = true;
    }
    squad.version++;
    this.version++;
    this._emit('squad-member-joined', { squadId: squad.id, memberId: entityId });
    return true;
  };

  SquadManager.prototype.setLocked = function (squadId, locked, issuerId) {
    const squad = this.getSquad(squadId);
    if (!squad || (issuerId && issuerId !== squad.leaderId)) return false;
    squad.locked = !!locked;
    squad.version++;
    this.version++;
    this._emit('squad-lock-changed', { squadId: squad.id, locked: squad.locked });
    return true;
  };

  SquadManager.prototype.transferLeader = function (squadId, nextId, game) {
    const squad = this.getSquad(squadId);
    if (!squad || squad.memberIds.indexOf(nextId) < 0 || squad.leaderId === nextId) return false;
    const prev = this.getEntity(squad.leaderId, game);
    const next = this.getEntity(nextId, game);
    if (prev) prev.isSquadLeader = false;
    if (next) next.isSquadLeader = true;
    squad.leaderId = nextId;
    squad.version++;
    this.version++;
    this._emit('squad-leader-changed', { squadId: squad.id, leaderId: nextId });
    return true;
  };

  SquadManager.prototype.issueOrder = function (squadId, flagLetter, kind, issuerId) {
    const squad = this.getSquad(squadId);
    if (!squad || !flagLetter) return null;
    if (issuerId && issuerId !== squad.leaderId) return null;
    const C = global.VF && global.VF.Conquest;
    const flag =
      C &&
      C.flags &&
      C.flags.find(function (item) {
        return item.letter === flagLetter;
      });
    if (!flag) return null;
    const orderKind = kind === 'defend' ? 'defend' : 'attack';
    squad.order = {
      id: (C ? C.matchId : 'local') + ':order:' + ++this._orderSeq,
      kind: orderKind,
      flagLetter: flagLetter,
      issuedAt: C ? C.elapsed : 0,
      progress: 0,
      status: 'active',
      issuerId: issuerId || squad.leaderId,
    };
    squad.version++;
    this.version++;
    this._emit('squad-order-issued', { squadId: squad.id, order: squad.order });
    return squad.order;
  };

  SquadManager.prototype._completeOrder = function (squad, status) {
    if (!squad || !squad.order || squad.order.status !== 'active') return;
    squad.order.status = status;
    squad.order.completedAt =
      global.VF && global.VF.Conquest ? global.VF.Conquest.elapsed : squad.order.issuedAt;
    if (status === 'completed') squad.score += 200;
    squad.version++;
    this.version++;
    this._emit('squad-order-' + status, {
      squadId: squad.id,
      order: squad.order,
      score: status === 'completed' ? 200 : 0,
    });
  };

  SquadManager.prototype._tickOrder = function (squad, dt) {
    const order = squad && squad.order;
    const C = global.VF && global.VF.Conquest;
    if (!order || order.status !== 'active' || !C || !C.active) return;
    const flag = C.flags.find(function (item) {
      return item.letter === order.flagLetter;
    });
    if (!flag) {
      this._completeOrder(squad, 'failed');
      return;
    }
    const fullyHeld = C._isFullyHeld ? C._isFullyHeld(flag, squad.team) : flag.owner === squad.team;
    if (order.kind === 'attack') {
      if (fullyHeld) this._completeOrder(squad, 'completed');
      else order.progress = Math.max(order.progress, Math.abs(flag.capture || 0));
    } else {
      if (flag.owner !== squad.team && flag.owner !== 'neutral') {
        this._completeOrder(squad, 'failed');
      } else if (fullyHeld && !flag.contested) {
        order.progress += dt / 20;
        if (order.progress >= 1) this._completeOrder(squad, 'completed');
      } else {
        order.progress = Math.max(0, order.progress - dt * 0.05);
      }
    }
  };

  SquadManager.prototype._ensureLeader = function (squad, game) {
    if (!squad || !squad.memberIds.length) return;
    const leader = this.getEntity(squad.leaderId, game);
    if (leader) return;
    for (let i = 0; i < squad.memberIds.length; i++) {
      if (this.getEntity(squad.memberIds[i], game)) {
        this.transferLeader(squad.id, squad.memberIds[i], game);
        return;
      }
    }
  };

  SquadManager.prototype.update = function (dt, game) {
    const teams = ['ally', 'enemy'];
    for (let t = 0; t < teams.length; t++) {
      const list = this.squads[teams[t]] || [];
      for (let i = 0; i < list.length; i++) {
        this._ensureLeader(list[i], game);
        this._tickOrder(list[i], dt);
      }
    }
  };

  SquadManager.prototype.getLivingSquadmates = function (entityOrId, game) {
    const squad = this.getSquadFor(entityOrId);
    if (!squad) return [];
    const out = [];
    for (let i = 0; i < squad.memberIds.length; i++) {
      const entity = this.getEntity(squad.memberIds[i], game);
      if (entity && entity.alive && !entity.dead && !entity.downed) out.push(entity);
    }
    return out;
  };

  SquadManager.prototype.getSnapshot = function () {
    const copyTeam = function (list) {
      return list.map(function (squad) {
        return {
          id: squad.id,
          team: squad.team,
          index: squad.index,
          name: squad.name,
          leaderId: squad.leaderId,
          memberIds: squad.memberIds.slice(),
          order: squad.order ? Object.assign({}, squad.order) : null,
          score: squad.score,
          locked: squad.locked,
          version: squad.version,
        };
      });
    };
    return {
      version: this.version,
      ally: copyTeam(this.squads.ally),
      enemy: copyTeam(this.squads.enemy),
    };
  };

  global.VF = global.VF || {};
  global.VF.Squads = new SquadManager();
  global.VF.SQUAD_SIZE = SIZE;
})(typeof window !== 'undefined' ? window : this);
