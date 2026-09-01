/**
 * gadgets.js — Infantry deployables, supply, recon, smoke and demolition.
 * X uses the class gadget; Z throws smoke.
 */
(function (global) {
  'use strict';

  const LIFE = {
    beacon: 120,
    supply: 45,
    sensor: 35,
    charge: 90,
    smoke: 14,
  };

  function now() {
    return performance.now();
  }

  function GadgetSystem() {
    this.items = [];
    this.smokes = [];
    this.cooldowns = Object.create(null);
    this._seq = 0;
    this._bound = false;
    this._bind();
  }

  GadgetSystem.prototype._bind = function () {
    if (this._bound) return;
    this._bound = true;
    const self = this;
    document.addEventListener('keydown', function (event) {
      if (event.repeat) return;
      const g = global.VF && global.VF.game;
      if (!g || !g.running || !g.player || g.player.dead || !g.player.locked) return;
      if (g.player.vehicleId) return;
      if (global.VF.UI && global.VF.UI.isMenuOpen && global.VF.UI.isMenuOpen()) return;
      if (event.code === 'KeyX') {
        event.preventDefault();
        self.useClassGadget(g);
      } else if (event.code === 'KeyZ') {
        event.preventDefault();
        self.throwSmoke(g);
      }
    });
  };

  GadgetSystem.prototype._emit = function (type, data) {
    const C = global.VF && global.VF.Conquest;
    if (C && C._emit) C._emit(type, data);
  };

  GadgetSystem.prototype._ground = function (world, x, z) {
    if (world && world.getWalkHeight) return world.getWalkHeight(x, z);
    if (world && world.getTerrainTop) return world.getTerrainTop(x, z);
    return 1;
  };

  GadgetSystem.prototype._placement = function (game, distance) {
    const player = game.player;
    const p = player.object.position;
    const d = distance || 3;
    const x = p.x - Math.sin(player.yaw) * d;
    const z = p.z - Math.cos(player.yaw) * d;
    return { x: x, y: this._ground(game.world, x, z), z: z };
  };

  GadgetSystem.prototype._mesh = function (kind, team) {
    const color = team === 'enemy' ? 0xb93838 : 0x3087c9;
    const root = new THREE.Group();
    let body;
    if (kind === 'beacon') {
      body = new THREE.Mesh(
        new THREE.BoxGeometry(0.45, 0.55, 0.45),
        new THREE.MeshLambertMaterial({ color: color, emissive: color, emissiveIntensity: 0.35 })
      );
      const antenna = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 1.3, 0.08),
        new THREE.MeshLambertMaterial({ color: 0x333940 })
      );
      antenna.position.y = 0.75;
      root.add(antenna);
    } else if (kind === 'supply') {
      body = new THREE.Mesh(
        new THREE.BoxGeometry(1.25, 0.65, 0.85),
        new THREE.MeshLambertMaterial({ color: 0x51643a })
      );
    } else if (kind === 'sensor') {
      body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.38, 0.35, 10),
        new THREE.MeshLambertMaterial({ color: 0x5a6672, emissive: color, emissiveIntensity: 0.25 })
      );
    } else {
      body = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, 0.18, 0.4),
        new THREE.MeshLambertMaterial({ color: 0x3b3027 })
      );
    }
    body.position.y = kind === 'supply' ? 0.33 : 0.25;
    root.add(body);
    root.userData.gadgetKind = kind;
    return root;
  };

  GadgetSystem.prototype._classKind = function (classId) {
    if (classId === 'support') return 'supply';
    if (classId === 'engineer') return 'charge';
    if (classId === 'recon') return 'sensor';
    return 'beacon';
  };

  GadgetSystem.prototype._cooldownSec = function (kind) {
    if (kind === 'beacon') return 35;
    if (kind === 'supply') return 24;
    if (kind === 'sensor') return 22;
    if (kind === 'charge') return 18;
    return 20;
  };

  GadgetSystem.prototype._ready = function (key) {
    return !this.cooldowns[key] || this.cooldowns[key] <= now();
  };

  GadgetSystem.prototype._setCooldown = function (key, seconds) {
    this.cooldowns[key] = now() + seconds * 1000;
  };

  GadgetSystem.prototype._removeOwned = function (kind, ownerId, squadId) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      const same =
        kind === 'beacon'
          ? item.kind === kind && item.squadId && item.squadId === squadId
          : item.kind === kind && item.ownerId === ownerId;
      if (same) this.destroy(item, 'replaced');
    }
  };

  GadgetSystem.prototype.deploy = function (kind, game, opts) {
    opts = opts || {};
    const player = game.player;
    const team = player.team || game.world._playerTeam || 'ally';
    const ownerId = player.entityId || 'player-local';
    const squadId = player.squadId || null;
    const pos = opts.position || this._placement(game, kind === 'charge' ? 2.2 : 3.2);
    if (game.world && game.world.isInBuilding && game.world.isInBuilding(pos.x, pos.z, 0.8)) {
      if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast('此处无法部署');
      return null;
    }
    this._removeOwned(kind, ownerId, squadId);
    const id =
      ((global.VF.Conquest && global.VF.Conquest.matchId) || 'local') +
      ':gadget:' +
      ++this._seq;
    const mesh = this._mesh(kind, team);
    mesh.position.set(pos.x, pos.y, pos.z);
    game.scene.add(mesh);
    const item = {
      id: id,
      kind: kind,
      team: team,
      ownerId: ownerId,
      squadId: squadId,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      mesh: mesh,
      hp: kind === 'supply' ? 120 : kind === 'beacon' ? 80 : 60,
      maxHp: kind === 'supply' ? 120 : kind === 'beacon' ? 80 : 60,
      life: LIFE[kind] || 45,
      tick: 0,
      destroyed: false,
      armed: kind !== 'charge',
    };
    this.items.push(item);
    if (kind === 'beacon') {
      game.world._deployBeacons = game.world._deployBeacons || [];
      game.world._deployBeacons.push(item);
    }
    this._emit('gadget-deployed', {
      id: id,
      kind: kind,
      team: team,
      ownerId: ownerId,
      squadId: squadId,
      x: pos.x,
      y: pos.y,
      z: pos.z,
    });
    if (global.VF.UI && global.VF.UI.toast) {
      const names = { beacon: '部署信标', supply: '综合补给箱', sensor: '运动传感器', charge: '定向炸药' };
      global.VF.UI.toast((names[kind] || '装备') + '已部署');
    }
    return item;
  };

  GadgetSystem.prototype.useClassGadget = function (game) {
    const player = game.player;
    const kind = this._classKind(player.classId);
    if (kind === 'charge') {
      const active = this.items.find(function (item) {
        return item.kind === 'charge' && item.ownerId === (player.entityId || 'player-local') && !item.destroyed;
      });
      if (active) {
        this.detonate(active, game);
        return true;
      }
    }
    const key = 'class:' + player.classId;
    if (!this._ready(key)) {
      if (global.VF.UI && global.VF.UI.toast) {
        global.VF.UI.toast('装备冷却 ' + Math.ceil((this.cooldowns[key] - now()) / 1000) + 's');
      }
      return false;
    }
    const item = this.deploy(kind, game);
    if (!item) return false;
    this._setCooldown(key, this._cooldownSec(kind));
    return true;
  };

  GadgetSystem.prototype.throwSmoke = function (game) {
    const player = game.player;
    const key = 'smoke:' + (player.entityId || 'player-local');
    if (!this._ready(key)) return false;
    const pos = this._placement(game, 7);
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color: 0xb8bcc0,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    for (let i = 0; i < 9; i++) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(2.4 + (i % 3) * 0.35, 8, 6), mat.clone());
      const angle = (i / 9) * Math.PI * 2;
      puff.position.set(Math.cos(angle) * 2.2, 1.4 + (i % 2) * 1.3, Math.sin(angle) * 2.2);
      group.add(puff);
    }
    group.position.set(pos.x, pos.y, pos.z);
    game.scene.add(group);
    const smoke = {
      id: ((global.VF.Conquest && global.VF.Conquest.matchId) || 'local') + ':smoke:' + ++this._seq,
      team: player.team || game.world._playerTeam || 'ally',
      x: pos.x,
      y: pos.y + 2,
      z: pos.z,
      radius: 6.5,
      life: LIFE.smoke,
      maxLife: LIFE.smoke,
      mesh: group,
    };
    this.smokes.push(smoke);
    game.world._smokeVolumes = this.smokes;
    this._setCooldown(key, 25);
    this._emit('smoke-deployed', { id: smoke.id, team: smoke.team, x: smoke.x, y: smoke.y, z: smoke.z });
    return true;
  };

  GadgetSystem.prototype.detonate = function (item, game) {
    if (!item || item.destroyed || item.kind !== 'charge') return false;
    const radius = 6;
    const ai = game.ai;
    const lists = ai ? [ai.blue || [], ai.red || []] : [];
    for (let L = 0; L < lists.length; L++) {
      for (let i = 0; i < lists[L].length; i++) {
        const unit = lists[L][i];
        if (!unit || !unit.alive || !unit.mesh) continue;
        const dist = Math.hypot(unit.mesh.position.x - item.x, unit.mesh.position.z - item.z);
        if (dist <= radius && ai._damageUnit) {
          ai._damageUnit(unit, Math.max(25, 125 * (1 - dist / (radius + 0.1))), null, item.team === game.world._playerTeam);
        }
      }
    }
    if (game.world && game.world.deformTerrainCircle) {
      game.world.deformTerrainCircle(item.x, item.z, 4.5, 0.7, { source: 'gadget', maxDepth: 0.9 });
    }
    if (game.weapons && game.weapons._spawnImpact) {
      game.weapons._spawnImpact(new THREE.Vector3(item.x, item.y + 0.5, item.z), 0xff7733, 1.1);
    }
    this._emit('gadget-detonated', { id: item.id, ownerId: item.ownerId, x: item.x, y: item.y, z: item.z });
    this.destroy(item, 'detonated');
    return true;
  };

  GadgetSystem.prototype.damage = function (id, amount, sourceTeam) {
    const item = typeof id === 'string' ? this.items.find(function (entry) { return entry.id === id; }) : id;
    if (!item || item.destroyed || sourceTeam === item.team) return false;
    item.hp -= Math.max(0, amount || 0);
    if (item.hp <= 0) this.destroy(item, 'destroyed');
    return true;
  };

  GadgetSystem.prototype.destroy = function (item, reason) {
    if (!item || item.destroyed) return;
    item.destroyed = true;
    if (item.mesh && item.mesh.parent) item.mesh.parent.remove(item.mesh);
    if (item.mesh) {
      item.mesh.traverse(function (node) {
        if (node.geometry && node.geometry.dispose) node.geometry.dispose();
        if (node.material && node.material.dispose) node.material.dispose();
      });
    }
    const g = global.VF && global.VF.game;
    if (g && g.world && g.world._deployBeacons) {
      g.world._deployBeacons = g.world._deployBeacons.filter(function (entry) {
        return entry !== item;
      });
    }
    this._emit('gadget-destroyed', { id: item.id, kind: item.kind, reason: reason || 'expired' });
  };

  GadgetSystem.prototype._tickSupply = function (item, dt, game) {
    item.tick -= dt;
    if (item.tick > 0) return;
    item.tick = 1;
    const radius = 5.5;
    const player = game.player;
    if (
      player &&
      player.alive &&
      !player.dead &&
      (player.team || game.world._playerTeam) === item.team &&
      Math.hypot(player.object.position.x - item.x, player.object.position.z - item.z) <= radius
    ) {
      const before = player.health;
      player.health = Math.min(player.maxHealth || 100, player.health + 14);
      let ammo = 0;
      if (game.weapons && game.weapons.addReserve) ammo = game.weapons.addReserve(game.weapons.current, 18);
      if (player.health > before) {
        this._emit('soldier-healed', { actorId: item.ownerId, targetId: player.entityId || 'player-local', amount: player.health - before });
      }
      if (ammo > 0) {
        this._emit('soldier-resupplied', { actorId: item.ownerId, targetId: player.entityId || 'player-local', amount: ammo });
      }
    }
    const ai = game.ai;
    const list = ai ? (item.team === 'enemy' ? ai.red : ai.blue) : [];
    for (let i = 0; i < list.length; i++) {
      const unit = list[i];
      if (!unit || !unit.alive || !unit.mesh) continue;
      if (Math.hypot(unit.mesh.position.x - item.x, unit.mesh.position.z - item.z) > radius) continue;
      const before = unit.hp;
      unit.hp = Math.min(unit.maxHp, unit.hp + 12);
      if (unit.hp > before) {
        this._emit('soldier-healed', { actorId: item.ownerId, targetId: unit.entityId, amount: unit.hp - before });
      }
    }
  };

  GadgetSystem.prototype._tickSensor = function (item, dt, game) {
    item.tick -= dt;
    if (item.tick > 0) return;
    item.tick = 1;
    const ai = game.ai;
    const list = ai ? (item.team === 'enemy' ? ai.blue : ai.red) : [];
    for (let i = 0; i < list.length; i++) {
      const unit = list[i];
      if (!unit || !unit.alive || !unit.mesh) continue;
      if (Math.hypot(unit.mesh.position.x - item.x, unit.mesh.position.z - item.z) > 22) continue;
      unit.spottedUntil = now() + 2200;
      unit.spottedBy = item.ownerId;
      this._emit('soldier-spotted', { actorId: item.ownerId, targetId: unit.entityId, sourceId: item.id });
    }
  };

  GadgetSystem.prototype.update = function (dt, game) {
    if (!game) return;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (!item || item.destroyed) {
        this.items.splice(i, 1);
        continue;
      }
      item.life -= dt;
      if (item.kind === 'supply') this._tickSupply(item, dt, game);
      else if (item.kind === 'sensor') this._tickSensor(item, dt, game);
      else if (item.kind === 'charge' && !item.armed) {
        item.armed = true;
      }
      if (item.life <= 0) {
        this.destroy(item, 'expired');
        this.items.splice(i, 1);
      }
    }
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const smoke = this.smokes[i];
      smoke.life -= dt;
      const alpha = Math.min(1, Math.max(0, smoke.life / 2, (smoke.maxLife - smoke.life) / 1.2));
      if (smoke.mesh) {
        smoke.mesh.children.forEach(function (puff) {
          if (puff.material) puff.material.opacity = 0.28 * alpha;
          puff.scale.multiplyScalar(1 + dt * 0.025);
        });
      }
      if (smoke.life <= 0) {
        if (smoke.mesh && smoke.mesh.parent) smoke.mesh.parent.remove(smoke.mesh);
        if (smoke.mesh) {
          smoke.mesh.traverse(function (node) {
            if (node.geometry && node.geometry.dispose) node.geometry.dispose();
            if (node.material && node.material.dispose) node.material.dispose();
          });
        }
        this.smokes.splice(i, 1);
      }
    }
    if (game.world) game.world._smokeVolumes = this.smokes;
  };

  GadgetSystem.prototype.blocksLine = function (a, b) {
    if (!a || !b || !this.smokes.length) return false;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const len2 = abx * abx + aby * aby + abz * abz || 1;
    for (let i = 0; i < this.smokes.length; i++) {
      const smoke = this.smokes[i];
      let t =
        ((smoke.x - a.x) * abx + (smoke.y - a.y) * aby + (smoke.z - a.z) * abz) / len2;
      t = Math.max(0, Math.min(1, t));
      const x = a.x + abx * t;
      const y = a.y + aby * t;
      const z = a.z + abz * t;
      const dx = x - smoke.x;
      const dy = y - smoke.y;
      const dz = z - smoke.z;
      if (dx * dx + dy * dy + dz * dz <= smoke.radius * smoke.radius) return true;
    }
    return false;
  };

  GadgetSystem.prototype.listDeployBeacons = function (team) {
    return this.items.filter(function (item) {
      return item.kind === 'beacon' && item.team === team && !item.destroyed;
    });
  };

  GadgetSystem.prototype.raycast = function (origin, dir, maxDist, sourceTeam) {
    let best = null;
    let bestDist = maxDist;
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (!item || item.destroyed || item.team === sourceTeam) continue;
      const cx = item.x;
      const cy = item.y + 0.45;
      const cz = item.z;
      const ox = origin.x - cx;
      const oy = origin.y - cy;
      const oz = origin.z - cz;
      const b = ox * dir.x + oy * dir.y + oz * dir.z;
      const c = ox * ox + oy * oy + oz * oz - 0.8 * 0.8;
      const disc = b * b - c;
      if (disc < 0) continue;
      const dist = -b - Math.sqrt(disc);
      if (dist < 0 || dist >= bestDist) continue;
      bestDist = dist;
      best = {
        item: item,
        dist: dist,
        point: origin.clone().addScaledVector(dir, dist),
      };
    }
    return best;
  };

  GadgetSystem.prototype.clear = function () {
    for (let i = 0; i < this.items.length; i++) this.destroy(this.items[i], 'round-end');
    const g = global.VF && global.VF.game;
    for (let i = 0; i < this.smokes.length; i++) {
      const smoke = this.smokes[i];
      if (smoke.mesh && smoke.mesh.parent) smoke.mesh.parent.remove(smoke.mesh);
    }
    this.items.length = 0;
    this.smokes.length = 0;
    this.cooldowns = Object.create(null);
    if (g && g.world) {
      g.world._deployBeacons = [];
      g.world._smokeVolumes = [];
    }
  };

  global.VF = global.VF || {};
  global.VF.Gadgets = new GadgetSystem();
})(typeof window !== 'undefined' ? window : this);
