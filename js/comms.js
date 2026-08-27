/**
 * comms.js — Tactical ping, squad orders and original conquest callouts.
 */
(function (global) {
  'use strict';

  function CommsSystem() {
    this.pings = [];
    this._seq = 0;
    this._lastPingAt = 0;
    this._lastAnnounceAt = 0;
    this._unsubscribe = null;
    this._bind();
  }

  CommsSystem.prototype._bind = function () {
    const self = this;
    document.addEventListener('keydown', function (event) {
      if (event.code !== 'KeyQ' || event.repeat) return;
      const g = global.VF && global.VF.game;
      if (!g || !g.running || !g.player || g.player.dead || !g.player.locked || g.levelEditing) return;
      if (g.building && g.building.active) return;
      if (global.VF.UI && global.VF.UI.isMenuOpen && global.VF.UI.isMenuOpen()) return;
      event.preventDefault();
      self.ping(g);
    });
    const C = global.VF && global.VF.Conquest;
    if (C && C.on) {
      this._unsubscribe = C.on('*', function (event) {
        self._announce(event);
      });
    }
  };

  CommsSystem.prototype._pingMesh = function (kind, team) {
    const color = kind === 'enemy' ? 0xff4a4a : team === 'enemy' ? 0xff7b7b : 0x55b6ff;
    const root = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 0.85, 20),
      new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    root.add(ring);
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 3.5, 0.08),
      new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.55, depthWrite: false })
    );
    beam.position.y = 1.75;
    root.add(beam);
    return root;
  };

  CommsSystem.prototype.ping = function (game) {
    const t = performance.now();
    if (t - this._lastPingAt < 850) return null;
    this._lastPingAt = t;
    const player = game.player;
    const origin = player.getEyePosition();
    const dir = player.getLookDirection();
    let kind = 'move';
    let targetId = null;
    let point = null;
    if (game.ai && game.ai.raycastEnemies) {
      const hit = game.ai.raycastEnemies(origin, dir, 100);
      if (hit && hit.enemy) {
        kind = 'enemy';
        targetId = hit.enemy.entityId;
        hit.enemy.spottedUntil = t + 7000;
        hit.enemy.spottedBy = player.entityId || 'player-local';
        point = hit.point.clone();
      }
    }
    if (!point) {
      point = origin.clone().addScaledVector(dir, 60);
      const gy =
        game.world && game.world.getWalkHeight
          ? game.world.getWalkHeight(point.x, point.z)
          : point.y;
      point.y = gy + 0.12;
    }
    const team = player.team || game.world._playerTeam || 'ally';
    const id =
      ((global.VF.Conquest && global.VF.Conquest.matchId) || 'local') +
      ':ping:' +
      ++this._seq;
    const mesh = this._pingMesh(kind, team);
    mesh.position.copy(point);
    game.scene.add(mesh);
    const ping = {
      id: id,
      kind: kind,
      team: team,
      actorId: player.entityId || 'player-local',
      squadId: player.squadId || null,
      targetId: targetId,
      x: point.x,
      y: point.y,
      z: point.z,
      life: kind === 'enemy' ? 7 : 8,
      mesh: mesh,
    };
    this.pings.push(ping);
    game.world._pings = this.pings;
    const C = global.VF && global.VF.Conquest;
    if (C && C._emit) {
      C._emit('ping-created', Object.assign({}, ping, { mesh: undefined }));
      if (targetId) {
        C._emit('soldier-spotted', {
          actorId: player.entityId || 'player-local',
          targetId: targetId,
          sourceId: id,
        });
      }
    }
    this._tryIssueOrder(player, point);
    if (global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast(kind === 'enemy' ? '敌军已标记' : '战术位置已标记');
    }
    return ping;
  };

  CommsSystem.prototype._tryIssueOrder = function (player, point) {
    if (!player || !player.isSquadLeader || !player.squadId) return;
    const C = global.VF && global.VF.Conquest;
    const squads = global.VF && global.VF.Squads;
    if (!C || !squads || !C.flags || !C.flags.length) return;
    let best = null;
    let bestD = 35 * 35;
    for (let i = 0; i < C.flags.length; i++) {
      const flag = C.flags[i];
      const dx = flag.x - point.x;
      const dz = flag.z - point.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        best = flag;
      }
    }
    if (!best) return;
    const kind = C._isFullyHeld(best, player.team) ? 'defend' : 'attack';
    const order = squads.issueOrder(player.squadId, best.letter, kind, player.entityId || 'player-local');
    if (order && global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast((kind === 'defend' ? '防守命令 · ' : '进攻命令 · ') + best.letter + '点');
    }
  };

  CommsSystem.prototype._announce = function (event) {
    if (!event || !event.type || !global.VF.UI || !global.VF.UI.toast) return;
    const data = event.data || {};
    let text = '';
    if (event.type === 'objective-contested') text = data.letter + '点发生争夺';
    else if (event.type === 'objective-neutralized') text = data.letter + '点已中立';
    else if (event.type === 'objective-captured') {
      text = (data.owner === 'ally' ? '蓝方' : '红方') + '控制 ' + data.letter + '点';
    } else if (event.type === 'squad-order-completed') text = '小队命令完成';
    else if (event.type === 'squad-order-failed') text = '小队命令失败';
    else if (event.type === 'tickets-changed' && data.after <= 100 && data.before > 100) {
      text = (data.team === 'ally' ? '蓝方' : '红方') + '增援告急';
    }
    if (!text) return;
    const t = performance.now();
    if (t - this._lastAnnounceAt < 650 && event.type !== 'tickets-changed') return;
    this._lastAnnounceAt = t;
    global.VF.UI.toast(text);
    if (global.VF.Audio && global.VF.Audio.play) global.VF.Audio.play('confirm');
  };

  CommsSystem.prototype.update = function (dt, game) {
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const ping = this.pings[i];
      ping.life -= dt;
      if (ping.mesh) {
        ping.mesh.rotation.y += dt * 1.8;
        ping.mesh.position.y = ping.y + Math.sin(performance.now() * 0.004 + i) * 0.12;
      }
      if (ping.life <= 0) {
        if (ping.mesh && ping.mesh.parent) ping.mesh.parent.remove(ping.mesh);
        if (ping.mesh) {
          ping.mesh.traverse(function (node) {
            if (node.geometry && node.geometry.dispose) node.geometry.dispose();
            if (node.material && node.material.dispose) node.material.dispose();
          });
        }
        this.pings.splice(i, 1);
      }
    }
    if (game && game.world) game.world._pings = this.pings;
    if (game && game.player && global.VF.UI && global.VF.UI.updateSquadOrder) {
      const squads = global.VF && global.VF.Squads;
      const squad = squads && squads.getSquadFor ? squads.getSquadFor(game.player) : null;
      const order = squad && squad.order && squad.order.status === 'active' ? squad.order : null;
      const key =
        (order ? order.id + ':' + Math.round((order.progress || 0) * 20) : 'none') +
        ':' +
        (game.player.isSquadLeader ? 1 : 0);
      if (key !== this._orderUiKey) {
        this._orderUiKey = key;
        global.VF.UI.updateSquadOrder(order, !!game.player.isSquadLeader);
      }
    }
  };

  CommsSystem.prototype.clear = function () {
    for (let i = 0; i < this.pings.length; i++) {
      const ping = this.pings[i];
      if (ping.mesh && ping.mesh.parent) ping.mesh.parent.remove(ping.mesh);
    }
    this.pings.length = 0;
    const g = global.VF && global.VF.game;
    if (g && g.world) g.world._pings = [];
  };

  global.VF = global.VF || {};
  global.VF.Comms = new CommsSystem();
})(typeof window !== 'undefined' ? window : this);
