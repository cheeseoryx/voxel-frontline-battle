/**
 * net-simulation.js — Host-authoritative conquest state replication.
 * PeerJS remains a small-session prototype; 32v32 production requires a dedicated server/SFU.
 */
(function (global) {
  'use strict';

  function NetSimulation() {
    this.seq = 0;
    this.lastRemoteSeq = 0;
    this.seenRemoteSeq = Object.create(null);
    this.lastSnapshotAt = 0;
    this.lastSnapshotSeq = 0;
    this.lastSendAt = 0;
    this.lastHash = '';
    this.remoteHash = '';
    this.remoteSquads = null;
    this.remoteScoring = null;
    this.remoteFlow = null;
    this.remoteVehicleHash = '';
    this.remoteVehicleActor = null;
    this.remoteTrustedPosition = null;
    this.remoteTrustedAt = 0;
    this.remoteMoveBudget = 2;
    this.remoteMoveBudgetAt = 0;
    this.lastVehicleControlSeq = 0;
    this.errors = [];
  }

  NetSimulation.prototype.reset = function () {
    if (
      this.remoteVehicleActor &&
      global.VF &&
      global.VF.Vehicles &&
      global.VF.Vehicles.dismount
    ) {
      global.VF.Vehicles.dismount(this.remoteVehicleActor, {
        reason: 'network-reset',
        silent: true,
      });
    }
    this.lastRemoteSeq = 0;
    this.seenRemoteSeq = Object.create(null);
    this.lastSnapshotAt = 0;
    this.lastSnapshotSeq = 0;
    this.lastSendAt = 0;
    this.lastHash = '';
    this.remoteHash = '';
    this.remoteSquads = null;
    this.remoteScoring = null;
    this.remoteFlow = null;
    this.remoteVehicleHash = '';
    this.remoteVehicleActor = null;
    this.remoteTrustedPosition = null;
    this.remoteTrustedAt = 0;
    this.remoteMoveBudget = 2;
    this.remoteMoveBudgetAt = 0;
    this.lastVehicleControlSeq = 0;
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
    const vehicles =
      global.VF.Vehicles && global.VF.Vehicles.getSnapshot
        ? global.VF.Vehicles.getSnapshot()
        : { version: 1, vehicles: [] };
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
      vehicles: vehicles,
      vehicleChecksum:
        global.VF.NetProtocol && global.VF.NetProtocol.vehicleChecksum
          ? global.VF.NetProtocol.vehicleChecksum(vehicles)
          : '',
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
    if (this.seenRemoteSeq[message.seq]) return false;
    if (message.type === 'conquest-command') {
      const pvpClock = global.VF && global.VF.Pvp;
      const offset =
        pvpClock && isFinite(pvpClock._remoteClockOffset)
          ? pvpClock._remoteClockOffset
          : 0;
      const adjustedAge =
        message.sentAt != null
          ? Date.now() - (message.sentAt + offset)
          : Infinity;
      if (
        !message._receivedAt ||
        performance.now() - message._receivedAt > 5000 ||
        adjustedAge > 5000 ||
        adjustedAge < -2000
      ) {
        this.errors.push('stale-command');
        return false;
      }
    }
    this.seenRemoteSeq[message.seq] = 1;
    if (message.seq > this.lastRemoteSeq) this.lastRemoteSeq = message.seq;
    const pruneBefore = this.lastRemoteSeq - 256;
    if (pruneBefore > 0) {
      for (const seq in this.seenRemoteSeq) {
        if (Number(seq) < pruneBefore) delete this.seenRemoteSeq[seq];
      }
    }
    if (message.type === 'conquest-snapshot-request') {
      if (this.isAuthority()) this.sendSnapshot();
      return true;
    }
    if (message.type === 'conquest-command') {
      const C = global.VF && global.VF.Conquest;
      const pvp = global.VF && global.VF.Pvp;
      const flow = global.VF && global.VF.MatchFlow;
      if (
        !C ||
        !C.active ||
        !pvp ||
        pvp.phase !== 'play' ||
        !flow ||
        flow.phase !== 'live' ||
        !message.matchId ||
        !C.matchId ||
        message.matchId !== C.matchId
      ) {
        this.errors.push('command-phase-or-match');
        return false;
      }
      return this._receiveCommand(message.payload, message.seq);
    }
    if (message.type !== 'conquest-snapshot' || this.isAuthority()) return false;
    if (message.seq <= this.lastSnapshotSeq) return false;
    const bundle = message.payload;
    const valid = P.validateSnapshot(bundle.snapshot);
    if (!valid.ok || P.checksum(bundle.snapshot) !== bundle.checksum) {
      this.errors.push(valid.ok ? 'checksum' : valid.reason);
      this.requestSnapshot();
      return false;
    }
    if (
      bundle.vehicles &&
      P.vehicleChecksum &&
      bundle.vehicleChecksum !== P.vehicleChecksum(bundle.vehicles)
    ) {
      this.errors.push('vehicle-checksum');
      this.requestSnapshot();
      return false;
    }
    this.remoteHash = bundle.checksum;
    this.remoteSquads = bundle.squads || null;
    this.remoteScoring = bundle.scoring || null;
    this.remoteFlow = bundle.flow || null;
    this.remoteVehicleHash = bundle.vehicleChecksum || '';
    this.lastSnapshotSeq = message.seq;
    this._applySnapshot(bundle.snapshot);
    this._applyFlow(bundle.flow);
    if (
      bundle.vehicles &&
      global.VF.Vehicles &&
      global.VF.Vehicles.applySnapshot
    ) {
      global.VF.Vehicles.applySnapshot(bundle.vehicles);
    }
    this.lastSnapshotAt = performance.now();
    return true;
  };

  NetSimulation.prototype._receiveCommand = function (payload, seq) {
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
        (pvp &&
          pvp._lockedRemoteLoadout &&
          pvp._lockedRemoteLoadout.team) ||
        (pvp && pvp.remoteLoadout && pvp.remoteLoadout.team) ||
        'enemy';
      if (!C || !data.lifeId || typeof data.lifeId !== 'string') return false;
      C.onDeath(remoteTeam, {
        lifeId: data.lifeId,
        subjectId: 'remote-player',
        reason: data.reason || 'combat',
      });
      if (pvp) pvp._remotePendingLifeId = data.lifeId;
      const game = global.VF && global.VF.game;
      const localPlayer = game && game.player;
      const localKillerId =
        data.killerId && localPlayer
          ? localPlayer.entityId || 'player-local'
          : null;
      const localTeam =
        (localPlayer && localPlayer.team) ||
        (game && game.world && game.world._playerTeam) ||
        (remoteTeam === 'ally' ? 'enemy' : 'ally');
      if (
        global.VF.Scoring &&
        global.VF.Scoring.confirmKill &&
        localKillerId
      ) {
        global.VF.Scoring.confirmKill(
          localKillerId,
          'remote-player',
          localTeam,
          remoteTeam,
          data.lifeId
        );
      }
      return true;
    } else if (payload.command.indexOf('vehicle-') === 0 || payload.command === 'rpg-fire') {
      if (
        payload.command !== 'rpg-fire' &&
        seq != null &&
        seq <= this.lastVehicleControlSeq
      ) {
        return false;
      }
      if (payload.command !== 'rpg-fire' && seq != null) {
        this.lastVehicleControlSeq = seq;
      }
      return this._receiveVehicleCommand(payload.command, data);
    } else if (payload.command === 'snapshot') {
      return this.sendSnapshot();
    }
    return false;
  };

  NetSimulation.prototype._remoteVehicleActor = function () {
    const pvp = global.VF && global.VF.Pvp;
    const state = (pvp && pvp.remoteState) || {};
    const loadout =
      (pvp && pvp._lockedRemoteLoadout) ||
      (pvp && pvp.remoteLoadout) ||
      {};
    if (!this.remoteVehicleActor) {
      this.remoteVehicleActor = {
        entityId: 'remote-player',
        isRemote: true,
        alive: true,
        position: { x: 0, y: 0, z: 0 },
      };
    }
    const actor = this.remoteVehicleActor;
    actor.team = loadout.team === 'ally' ? 'ally' : 'enemy';
    actor.classId = loadout.classId || 'assault';
    actor.alive =
      state.alive !== false &&
      (!pvp || pvp._remoteAuthoritativeAlive !== false);
    if (actor.rpgAmmo == null) actor.rpgAmmo = 3;
    if (actor.rpgCd == null) actor.rpgCd = 0;
    const now = performance.now();
    if (!this.remoteTrustedPosition) {
      const world = global.VF && global.VF.game && global.VF.game.world;
      const spawnList =
        world && world._spawnPoints && world._spawnPoints.all
          ? world._spawnPoints.all
          : [];
      let spawn = null;
      for (let i = 0; i < spawnList.length; i++) {
        if (spawnList[i].id === loadout.spawnId) {
          spawn = spawnList[i];
          break;
        }
      }
      if (!spawn) {
        for (let i = 0; i < spawnList.length; i++) {
          if (spawnList[i].team === actor.team && spawnList[i].fixed) {
            spawn = spawnList[i];
            break;
          }
        }
      }
      this.remoteTrustedPosition = {
        x: spawn ? spawn.x : 0,
        y: spawn ? spawn.y : 0,
        z: spawn ? spawn.z : 0,
      };
      this.remoteTrustedAt = now;
      this.remoteMoveBudget = 2;
      this.remoteMoveBudgetAt = now;
    } else if (state.x != null && !actor.vehicleId) {
      const candidate = {
        x: Number(state.x) || 0,
        y: Number(state.y) || 0,
        z: Number(state.z) || 0,
      };
      const elapsed = Math.max(
        0,
        (now - (this.remoteMoveBudgetAt || now)) / 1000
      );
      this.remoteMoveBudget = Math.min(
        4,
        (this.remoteMoveBudget || 0) + elapsed * 16
      );
      this.remoteMoveBudgetAt = now;
      const distance = Math.hypot(
        candidate.x - this.remoteTrustedPosition.x,
        candidate.y - this.remoteTrustedPosition.y,
        candidate.z - this.remoteTrustedPosition.z
      );
      if (distance <= this.remoteMoveBudget + 0.1) {
        this.remoteTrustedPosition = candidate;
        this.remoteTrustedAt = now;
        this.remoteMoveBudget = Math.max(
          0,
          this.remoteMoveBudget - distance
        );
      }
    }
    actor.position.x = this.remoteTrustedPosition.x;
    actor.position.y = this.remoteTrustedPosition.y;
    actor.position.z = this.remoteTrustedPosition.z;
    return actor;
  };

  NetSimulation.prototype._receiveVehicleCommand = function (command, data) {
    const vehicles = global.VF && global.VF.Vehicles;
    if (!vehicles) return false;
    const actor = this._remoteVehicleActor();
    if (command === 'vehicle-mount') {
      const vehicle = vehicles.getById(data.vehicleId);
      if (!vehicle || vehicle.team !== actor.team) return false;
      if (
        Math.hypot(
          actor.position.x - vehicle.position.x,
          actor.position.y -
            (vehicle.position.y + vehicle.def.dimensions.height * 0.45),
          actor.position.z - vehicle.position.z
        ) > 6
      ) {
        return false;
      }
      if (actor.vehicleId) vehicles.dismount(actor, { silent: true });
      return !!vehicles.mount(actor, vehicle, data.seatIndex);
    }
    if (command === 'vehicle-dismount') {
      const exited = !!vehicles.dismount(actor, {
        reason: 'remote',
        silent: true,
      });
      if (exited) {
        this.remoteTrustedPosition = {
          x: actor.position.x,
          y: actor.position.y,
          z: actor.position.z,
        };
        this.remoteTrustedAt = performance.now();
        this.remoteMoveBudget = 2;
        this.remoteMoveBudgetAt = this.remoteTrustedAt;
      }
      return exited;
    }
    if (command === 'vehicle-seat') {
      return !!vehicles.switchSeat(actor, data.seatIndex);
    }
    if (command === 'vehicle-input') {
      const vehicle = vehicles.getById(data.vehicleId);
      if (!vehicle || vehicle.team !== actor.team) return false;
      if (actor.vehicleId !== vehicle.id) {
        if (
          Math.hypot(
            actor.position.x - vehicle.position.x,
            actor.position.y -
              (vehicle.position.y + vehicle.def.dimensions.height * 0.45),
            actor.position.z - vehicle.position.z
          ) > 6
        ) {
          return false;
        }
        if (actor.vehicleId) vehicles.dismount(actor, { silent: true });
        if (!vehicles.mount(actor, vehicle, data.seatIndex)) return false;
      } else if (
        data.seatIndex != null &&
        Number(data.seatIndex) !== Number(actor.vehicleSeat)
      ) {
        vehicles.switchSeat(actor, Number(data.seatIndex));
      }
      if (actor.vehicleRole === 'driver') {
        vehicles.setDriverInput(vehicle, {
          throttle: data.throttle,
          steer: data.steer,
          brake: data.brake,
          handbrake: data.handbrake,
          boost: data.boost,
          slow: data.slow,
        });
      }
      if (!data.turretLocked) {
        vehicles.setAim(vehicle, {
          yaw: Number(data.aimYaw) || 0,
          pitch: Number(data.aimPitch) || 0,
          role: actor.vehicleRole,
        });
      }
      if (data.fire) {
        const choices = vehicles.getWeaponsForRole(vehicle, actor.vehicleRole);
        if (
          (data.role && data.role !== actor.vehicleRole) ||
          (data.weaponId && choices.indexOf(data.weaponId) < 0)
        ) {
          return false;
        }
        const index = Math.max(
          0,
          Math.min(choices.length - 1, Number(data.weaponIndex) | 0)
        );
        const weaponId = data.weaponId || choices[index];
        if (weaponId) {
          const roleAim =
            (vehicle.aimByRole &&
              vehicle.aimByRole[actor.vehicleRole]) ||
            vehicle.aim;
          vehicles.fireWeapon(vehicle, weaponId, actor, {
            direction: data.fireDirection || roleAim.direction,
            shotId: data.shotId || null,
          });
        }
      }
      return true;
    }
    if (command === 'rpg-fire') {
      const mountedVehicle = actor.vehicleId
        ? vehicles.getById(actor.vehicleId)
        : null;
      const mountedRpgAllowed = !!(
        mountedVehicle &&
        mountedVehicle.type === 'jeep' &&
        actor.vehicleRole === 'passenger'
      );
      if (
        actor.classId !== 'engineer' ||
        !actor.alive ||
        (actor.vehicleId && !mountedRpgAllowed) ||
        actor.rpgAmmo <= 0 ||
        actor.rpgCd > 0 ||
        !data.origin ||
        !data.direction
      ) {
        return false;
      }
      const originDistance = Math.hypot(
        Number(data.origin.x) - actor.position.x,
        Number(data.origin.y) - (actor.position.y + 1.3),
        Number(data.origin.z) - actor.position.z
      );
      const directionLength = Math.hypot(
        Number(data.direction.x),
        Number(data.direction.y),
        Number(data.direction.z)
      );
      if (
        !isFinite(originDistance) ||
        originDistance > 3 ||
        !isFinite(directionLength) ||
        directionLength < 0.5 ||
        directionLength > 1.5
      ) {
        return false;
      }
      actor.rpgAmmo--;
      actor.rpgCd = 3.2;
      return !!vehicles.launchProjectile({
        weaponId: 'rpg',
        actor: actor,
        team: actor.team,
        origin: data.origin,
        direction: data.direction,
      });
    }
    return false;
  };

  NetSimulation.prototype.applyRemoteVehicleState = function (state) {
    if (!this.isAuthority() || !state) return false;
    const vehicles = global.VF && global.VF.Vehicles;
    if (!vehicles) return false;
    const actor = this._remoteVehicleActor();
    if (
      state.vehicleId &&
      (!global.VF.MatchFlow || global.VF.MatchFlow.phase !== 'live')
    ) {
      return false;
    }
    if (!state.vehicleId || state.alive === false) {
      if (actor.vehicleId) {
        vehicles.dismount(actor, { reason: 'remote-state', silent: true });
        this.remoteTrustedPosition = {
          x: actor.position.x,
          y: actor.position.y,
          z: actor.position.z,
        };
        this.remoteTrustedAt = performance.now();
        this.remoteMoveBudget = 2;
        this.remoteMoveBudgetAt = this.remoteTrustedAt;
      }
      return true;
    }
    return this._receiveVehicleCommand('vehicle-input', {
      vehicleId: state.vehicleId,
      seatIndex: state.vehicleSeat,
      role: state.vehicleRole,
      throttle: state.vehicleThrottle,
      steer: state.vehicleSteer,
      brake: state.vehicleBrake,
      boost: state.vehicleBoost,
      slow: state.vehicleSlow,
      turretLocked: state.vehicleTurretLocked,
      aimYaw: state.vehicleAimYaw,
      aimPitch: state.vehicleAimPitch,
      weaponIndex: state.vehicleWeaponIndex,
      // Fire is carried by the reliable command containing the accepted shotId
      // and exact camera-zeroed direction. State packets only steer the vehicle.
      fire: false,
    });
  };

  NetSimulation.prototype.observeRemotePlayerState = function () {
    if (!this.isAuthority()) return null;
    return this._remoteVehicleActor();
  };

  NetSimulation.prototype.onRemoteRespawn = function (spawnPoint) {
    if (this.remoteVehicleActor && this.remoteVehicleActor.vehicleId) {
      const vehicles = global.VF && global.VF.Vehicles;
      if (vehicles) {
        vehicles.dismount(this.remoteVehicleActor, {
          reason: 'remote-respawn',
          silent: true,
        });
      }
    }
    this.remoteTrustedPosition = spawnPoint
      ? {
          x: Number(spawnPoint.x) || 0,
          y: Number(spawnPoint.y) || 0,
          z: Number(spawnPoint.z) || 0,
        }
      : null;
    this.remoteTrustedAt = performance.now();
    this.remoteMoveBudget = 2;
    this.remoteMoveBudgetAt = this.remoteTrustedAt;
    if (this.remoteVehicleActor) {
      this.remoteVehicleActor.alive = true;
      this.remoteVehicleActor.rpgAmmo = 3;
      this.remoteVehicleActor.rpgCd = 0;
    }
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
    if (this.remoteVehicleActor && this.remoteVehicleActor.rpgCd > 0) {
      this.remoteVehicleActor.rpgCd = Math.max(
        0,
        this.remoteVehicleActor.rpgCd - Math.max(0, Number(dt) || 0)
      );
    }
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
      remoteVehicleHash: this.remoteVehicleHash,
      lastSnapshotAgeMs: this.lastSnapshotAt ? performance.now() - this.lastSnapshotAt : null,
      errors: this.errors.slice(-20),
      transportLimit:
        'PeerJS mesh is supported only as a small-session prototype; 32v32 requires a dedicated authoritative server or SFU.',
    };
  };

  global.VF = global.VF || {};
  global.VF.NetSimulation = new NetSimulation();
})(typeof window !== 'undefined' ? window : this);
