/**
 * net-simulation.js — Host-authoritative conquest state replication.
 * PeerJS remains a small-session prototype; 32v32 production requires a dedicated server/SFU.
 */
(function (global) {
  'use strict';

  function NetSimulation() {
    this.seq = 0;
    this.lastRemoteSeq = 0;
    this.lastSnapshotAt = 0;
    this.lastSendAt = 0;
    this.lastHash = '';
    this.remoteHash = '';
    this.remoteSquads = null;
    this.remoteScoring = null;
    this.remoteFlow = null;
    this.errors = [];
  }

  NetSimulation.prototype.reset = function () {
    this.lastRemoteSeq = 0;
    this.lastSnapshotAt = 0;
    this.lastSendAt = 0;
    this.lastHash = '';
    this.remoteHash = '';
    this.remoteSquads = null;
    this.remoteScoring = null;
    this.remoteFlow = null;
    this.errors.length = 0;
  };

  NetSimulation.prototype.isNetworkConquest = function (game) {
    const g = game || (global.VF && global.VF.game);
    return !!(g && g.mode === 'pvp' && g.pvp && g.pvp.conquest);
  };

  NetSimulation.prototype.isAuthority = function (game) {
    const g = game || (global.VF && global.VF.game);
    if (!this.isNetworkConquest(g)) return true;
    return !!(global.VF.Pvp && global.VF.Pvp.mode === 'host');
  };

  NetSimulation.prototype._send = function (message) {
    if (global.VF.Pvp && global.VF.Pvp._send) global.VF.Pvp._send(message);
  };

  NetSimulation.prototype._bundle = function () {
    const C = global.VF && global.VF.Conquest;
    if (!C || !C.active || !C.getStateSnapshot) return null;
    const snapshot = C.getStateSnapshot();
    return {
      snapshot: snapshot,
      checksum: global.VF.NetProtocol.checksum(snapshot),
      squads:
        global.VF.Squads && global.VF.Squads.getSnapshot
          ? global.VF.Squads.getSnapshot()
          : null,
      scoring:
        global.VF.Scoring && global.VF.Scoring.getSnapshot
          ? global.VF.Scoring.getSnapshot()
          : null,
      flow:
        global.VF.MatchFlow && global.VF.MatchFlow.getState
          ? global.VF.MatchFlow.getState()
          : null,
      downed:
        global.VF.Revive && global.VF.Revive.getDowned
          ? {
              ally: global.VF.Revive.getDowned('ally').map(this._downedWire),
              enemy: global.VF.Revive.getDowned('enemy').map(this._downedWire),
            }
          : null,
    };
  };

  NetSimulation.prototype._downedWire = function (state) {
    const entity = state.entity;
    const pos = entity && (entity.object ? entity.object.position : entity.mesh && entity.mesh.position);
    return {
      lifeId: state.lifeId,
      casualtyId: state.casualtyId,
      subjectId: entity && (entity.entityId || 'player-local'),
      remaining: state.remaining,
      reviveProgress: state.reviveProgress,
      x: pos ? pos.x : 0,
      y: pos ? pos.y : 0,
      z: pos ? pos.z : 0,
    };
  };

  NetSimulation.prototype.sendSnapshot = function () {
    const bundle = this._bundle();
    if (!bundle) return false;
    const P = global.VF.NetProtocol;
    this.seq++;
    this.lastHash = bundle.checksum;
    this._send(
      P.envelope('conquest-snapshot', bundle, {
        matchId: bundle.snapshot.matchId,
        seq: this.seq,
        ack: this.lastRemoteSeq,
      })
    );
    this.lastSendAt = performance.now();
    return true;
  };

  NetSimulation.prototype.requestSnapshot = function () {
    const C = global.VF && global.VF.Conquest;
    const P = global.VF && global.VF.NetProtocol;
    if (!P) return;
    this.seq++;
    this._send(
      P.envelope(
        'conquest-snapshot-request',
        { reason: 'late-join-or-recovery' },
        {
          matchId: (C && C.matchId) || '',
          seq: this.seq,
          ack: this.lastRemoteSeq,
        }
      )
    );
  };

  NetSimulation.prototype.sendCommand = function (command, payload) {
    const C = global.VF && global.VF.Conquest;
    const P = global.VF && global.VF.NetProtocol;
    if (!P || !command) return false;
    this.seq++;
    this._send(
      P.envelope(
        'conquest-command',
        { command: command, data: payload || {} },
        {
          matchId: (C && C.matchId) || '',
          seq: this.seq,
          ack: this.lastRemoteSeq,
        }
      )
    );
    return true;
  };

  NetSimulation.prototype.receive = function (message) {
    const P = global.VF && global.VF.NetProtocol;
    if (!P) return false;
    const checked = P.validateEnvelope(message);
    if (!checked.ok) {
      this.errors.push(checked.reason);
      return false;
    }
    if (message.seq <= this.lastRemoteSeq) return false;
    this.lastRemoteSeq = message.seq;
    if (message.type === 'conquest-snapshot-request') {
      if (this.isAuthority()) this.sendSnapshot();
      return true;
    }
    if (message.type === 'conquest-command') {
      return this._receiveCommand(message.payload);
    }
    if (message.type !== 'conquest-snapshot' || this.isAuthority()) return false;
    const bundle = message.payload;
    const valid = P.validateSnapshot(bundle.snapshot);
    if (!valid.ok || P.checksum(bundle.snapshot) !== bundle.checksum) {
      this.errors.push(valid.ok ? 'checksum' : valid.reason);
      this.requestSnapshot();
      return false;
    }
    this.remoteHash = bundle.checksum;
    this.remoteSquads = bundle.squads || null;
    this.remoteScoring = bundle.scoring || null;
    this.remoteFlow = bundle.flow || null;
    this._applySnapshot(bundle.snapshot);
    this._applyFlow(bundle.flow);
    this.lastSnapshotAt = performance.now();
    return true;
  };

  NetSimulation.prototype._receiveCommand = function (payload) {
    if (!this.isAuthority() || !payload || typeof payload.command !== 'string') return false;
    const data = payload.data || {};
    if (payload.command === 'squad-order') {
      if (
        !data.squadId ||
        !data.flagLetter ||
        ['attack', 'defend'].indexOf(data.kind) < 0
      ) {
        return false;
      }
      const squads = global.VF && global.VF.Squads;
      if (squads && squads.issueOrder) {
        return !!squads.issueOrder(data.squadId, data.flagLetter, data.kind, data.issuerId);
      }
    } else if (payload.command === 'casualty') {
      const C = global.VF && global.VF.Conquest;
      const pvp = global.VF && global.VF.Pvp;
      const remoteTeam =
        (pvp && pvp.remoteState && pvp.remoteState.team) ||
        (pvp && pvp.remoteLoadout && pvp.remoteLoadout.team) ||
        'enemy';
      if (!C || !data.lifeId || typeof data.lifeId !== 'string') return false;
      C.onDeath(remoteTeam, {
        lifeId: data.lifeId,
        subjectId: data.subjectId || 'remote-player',
        reason: data.reason || 'combat',
      });
      if (global.VF.Scoring && global.VF.Scoring.confirmKill && data.killerId) {
        global.VF.Scoring.confirmKill(
          data.killerId,
          data.subjectId || 'remote-player',
          data.killerTeam || (remoteTeam === 'ally' ? 'enemy' : 'ally'),
          remoteTeam,
          data.lifeId
        );
      }
      return true;
    } else if (payload.command === 'snapshot') {
      return this.sendSnapshot();
    }
    return false;
  };

  NetSimulation.prototype._applySnapshot = function (snapshot) {
    const C = global.VF && global.VF.Conquest;
    if (!C || !C.active) return;
    const wasEnded = C._ended;
    C.matchId = snapshot.matchId;
    C.phase = snapshot.phase;
    C._ended = !!snapshot.ended;
    C._endReason = snapshot.endReason || '';
    C._winner = snapshot.winner || null;
    C.tickets.ally = snapshot.tickets.ally;
    C.tickets.enemy = snapshot.tickets.enemy;
    C.ticketsMax = snapshot.ticketsMax;
    C.elapsed = snapshot.elapsed;
    C.roundSec = snapshot.roundSec;
    C.sweepSec = snapshot.sweepSec;
    C._sweepAlly = snapshot.sweep ? snapshot.sweep.ally : 0;
    C._sweepEnemy = snapshot.sweep ? snapshot.sweep.enemy : 0;
    const byLetter = Object.create(null);
    for (let i = 0; i < C.flags.length; i++) byLetter[C.flags[i].letter] = C.flags[i];
    for (let i = 0; i < snapshot.flags.length; i++) {
      const src = snapshot.flags[i];
      const dst = byLetter[src.letter];
      if (!dst) continue;
      dst.owner = src.owner;
      dst.phase = src.phase;
      dst.attackingTeam = src.attackingTeam;
      dst.progress = src.progress;
      dst.capture = src.capture;
      dst.contested = !!src.contested;
      dst.allyN = src.allyN | 0;
      dst.enemyN = src.enemyN | 0;
      if (C._tintFlag) C._tintFlag(dst);
    }
    const g = global.VF && global.VF.game;
    if (C._publishFlags) C._publishFlags(g);
    if (C._syncHud) C._syncHud(true);
    if (!wasEnded && C._ended && g && g.bases) {
      const playerTeam =
        (g.player && g.player.team) || (g.world && g.world._playerTeam) || 'ally';
      const won = C._winner === playerTeam;
      g.bases.won = won;
      g.bases.lost = !won;
      if (global.VF.UI && global.VF.UI.showVictory) {
        global.VF.UI.showVictory(
          won ? '占领胜利' : '占领失败',
          C._endReason === 'sweep'
            ? won
              ? '关键任务成功'
              : '关键任务失败'
            : won
              ? '敌方增援耗尽'
              : '我方增援耗尽'
        );
      }
    }
  };

  NetSimulation.prototype._applyFlow = function (flow) {
    const matchFlow = global.VF && global.VF.MatchFlow;
    if (!matchFlow || !flow || typeof flow.phase !== 'string') return;
    if (['idle', 'warmup', 'live', 'post'].indexOf(flow.phase) < 0) return;
    matchFlow.phase = flow.phase;
    matchFlow.warmupRemaining = Math.max(0, Number(flow.warmupRemaining) || 0);
    matchFlow.postRemaining = Math.max(0, Number(flow.postRemaining) || 0);
    matchFlow.rotationIndex = Math.max(0, Number(flow.rotationIndex) | 0);
  };

  NetSimulation.prototype.update = function (dt, game) {
    if (!this.isNetworkConquest(game)) return;
    const t = performance.now();
    if (this.isAuthority(game)) {
      if (t - this.lastSendAt >= 200) this.sendSnapshot();
    } else if (!this.lastSnapshotAt || t - this.lastSnapshotAt > 2200) {
      if (!this._lastRequestAt || t - this._lastRequestAt > 1800) {
        this._lastRequestAt = t;
        this.requestSnapshot();
      }
    }
  };

  NetSimulation.prototype.getDiagnostics = function () {
    return {
      authority: this.isAuthority(),
      localSeq: this.seq,
      remoteSeq: this.lastRemoteSeq,
      localHash: this.lastHash,
      remoteHash: this.remoteHash,
      lastSnapshotAgeMs: this.lastSnapshotAt ? performance.now() - this.lastSnapshotAt : null,
      errors: this.errors.slice(-20),
      transportLimit:
        'PeerJS mesh is supported only as a small-session prototype; 32v32 requires a dedicated authoritative server or SFU.',
    };
  };

  global.VF = global.VF || {};
  global.VF.NetSimulation = new NetSimulation();
})(typeof window !== 'undefined' ? window : this);
