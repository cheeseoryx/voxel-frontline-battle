/**
 * skills.js — Class active/passive abilities
 * Assault stimulant · Support revive · Recon mark · Engineer repair
 */
(function (global) {
  'use strict';

  const VANGUARD = {
    id: 'assault',
    key: 'KeyX',
    cooldown: 60,
    healDuration: 1.0,
    healAmount: 100,
    weaponSpeed: 1.15,
    fuse: 3,
  };

  /** All classes — dash far enough to clear the river (~width 18–26). */
  const DASH = {
    key: 'KeyV',
    cooldown: 5,
    distance: 30,
    duration: 0.2,
    step: 0.45,
    jetEmitRate: 90,
    jetBurst: 32,
    jetLife: 0.45,
    sparkLife: 3.6,
    sparkRate: 70,
  };

  const DASH_JET_COLORS = [0xff6a18, 0xff9020, 0xffb040, 0xff4400, 0xffcc66];
  const DASH_SPARK_COLORS = [0xffee88, 0xffcc44, 0xffaa22, 0xff6622, 0xfff0a0];

  const MEDIC = {
    id: 'support',
    key: 'KeyX',
    reviveSec: 3,
    reviveHealth: 50,
    reviveRange: 2.8,
    startShield: 50,
    cooldown: 0,
    duration: 12,
    healRadius: 6,
    healPerSec: 8,
    placeRange: 8,
    placeRay: 16,
  };

  const GHOST = {
    id: 'recon',
    key: 'KeyX',
    cooldown: 28,
    duration: 6,
    speedBuff: 1.3,
    ambushBonus: 40,
    backstabMul: 1.3,
    backstabDot: -0.25,
  };

  const JUGGERNAUT = {
    id: 'juggernaut',
    key: 'KeyX',
    cooldown: 24,
    duration: 8,
    hp: 280,
    speedMul: 0.65,
    bulletResist: 0.94,
    frontDot: 0.2,
    offset: 1.35,
    width: 2.2,
    height: 2.2,
  };

  const RAIDER = {
    id: 'raider',
    key: 'KeyX',
    cooldown: 30,
    range: 28,
    halfAngleDeg: 30, // 60° cone total (3D)
    structureDmg: 480,
    // Dense core blast around impact (still cone-filtered); much larger than Vanguard ~5.5
    carveW: 12,
    carveH: 6,
    carveD: 12,
    lootMul: 1.3,
  };

  const ENGINEER = {
    id: 'engineer',
    key: 'KeyX',
    repairPerSec: 10,
    repairRange: 5,
    startBlocks: 20,
    buildDurabilityMul: 1.5,
    placeRange: 10,
    placeRay: 18,
    turretHp: 120,
    turretDmg: 9,
    fireInterval: 1.0,
    ammo: 120,
    range: 38,
    recallRefund: 8,
    blockCost: 12,
    cooldown: 0,
  };

  const SKILL_KEY = 'KeyX';

  const _tmpOrigin = new THREE.Vector3();
  const _tmpDir = new THREE.Vector3();
  const _tmpVel = new THREE.Vector3();
  const _tmpPos = new THREE.Vector3();
  const _tmpNext = new THREE.Vector3();
  const _grav = new THREE.Vector3(0, -1, 0);

  function Skills(player, world, scene) {
    this.player = player;
    this.world = world;
    this.scene = scene;
    this.cooldown = 0;
    this.dashCooldown = 0;
    this.dash = null;
    this.pending = null;
    this.healDevice = null;
    this.riotShield = null;
    this.turrets = [];
    this.stealthTimer = 0;
    this.aiming = false;
    this._aimKeyDown = false;
    this._skillHeld = false;
    this.stim = null;
    this.reviveProgress = 0;
    this.reviveTarget = null;
    this.repairTarget = null;
    this._fx = [];
    this._dashRibbons = [];
    this._preview = null;
    this._medicPreview = null;
    this._vmOpacitySaved = null;
    this._bind();
  }

  Skills.prototype._bind = function () {
    const self = this;
    document.addEventListener('keydown', function (e) {
      if (global.VF.Range && global.VF.Range.isOpen) return;
      if (global.VF.UI && global.VF.UI.isMenuOpen && global.VF.UI.isMenuOpen()) return;
      if (self.player && (self.player.vehicleId || self.player.dead || self.player.downed)) return;
      if (e.code === DASH.key && !e.repeat) {
        if (!self._canDash()) return;
        e.preventDefault();
        self.tryDash();
        return;
      }
      if (e.code !== SKILL_KEY || e.repeat) return;
      const kind = self._activeClassSkill();
      if (!kind) return;
      e.preventDefault();
      self._skillHeld = true;
      if (kind === 'vanguard') {
        self._skillHeld = false;
        self.tryStimulant();
      } else if (kind === 'medic') {
        self._beginReviveHold();
      } else if (kind === 'engineer') {
        self._beginRepairHold();
      } else if (kind === 'ghost') {
        self._skillHeld = false;
      } else if (kind === 'juggernaut') {
        self._skillHeld = false;
        if (self.cooldown > 0 || self.riotShield) {
          if (global.VF.UI && global.VF.UI.toast) {
            global.VF.UI.toast(
              self.riotShield ? '防暴盾已展开' : '防暴盾冷却中'
            );
          }
          return;
        }
        self.tryRiotShield();
      } else if (kind === 'raider') {
        self._skillHeld = false;
        if (self.cooldown > 0) {
          if (global.VF.UI && global.VF.UI.toast) {
            global.VF.UI.toast('电磁脉冲冷却中');
          }
          return;
        }
        self.tryEmpPulse();
      }
    });
    document.addEventListener('keyup', function (e) {
      if (e.code !== SKILL_KEY) return;
      self._skillHeld = false;
      if (self.reviveProgress > 0 || self.reviveTarget) {
        self.reviveProgress = 0;
        self.reviveTarget = null;
        if (global.VF.UI && global.VF.UI.updateReviveAssist) {
          global.VF.UI.updateReviveAssist(null);
        }
      }
      if (self.repairTarget) {
        self.repairTarget = null;
        if (global.VF.UI && global.VF.UI.updateRepairHud) {
          global.VF.UI.updateRepairHud(null);
        }
      }
      if (!self._aimKeyDown) return;
      self._aimKeyDown = false;
      if (!self.aiming) return;
      self.aiming = false;
      self._hidePreview();
      self._hideMedicPreview();
      self._hideTurretPreview();
    });
    document.addEventListener('pointerlockchange', function () {
      if (!document.pointerLockElement) {
        self.aiming = false;
        self._aimKeyDown = false;
        self._skillHeld = false;
        self.reviveProgress = 0;
        self.reviveTarget = null;
        self.repairTarget = null;
        if (global.VF.UI) {
          if (global.VF.UI.updateRepairHud) global.VF.UI.updateRepairHud(null);
          if (global.VF.UI.updateReviveAssist) global.VF.UI.updateReviveAssist(null);
        }
        self._hidePreview();
        self._hideMedicPreview();
        self._hideTurretPreview();
      }
    });
  };

  Skills.prototype._activeClassSkill = function () {
    if (!this.player || !this.player.locked || this.player.dead || this.player.downed) {
      return null;
    }
    if (global.VF.UI && global.VF.UI.isMenuOpen && global.VF.UI.isMenuOpen()) return null;
    const id = this.player.classId;
    if (id === VANGUARD.id) return 'vanguard';
    if (id === MEDIC.id) return 'medic';
    if (id === GHOST.id) return 'ghost';
    if (id === JUGGERNAUT.id) return 'juggernaut';
    if (id === RAIDER.id) return 'raider';
    if (id === ENGINEER.id) return 'engineer';
    return null;
  };

  Skills.prototype._canDash = function () {
    if (!this.player || !this.player.locked || this.player.dead || this.player.downed) {
      return false;
    }
    if (global.VF.UI && global.VF.UI.isMenuOpen && global.VF.UI.isMenuOpen()) return false;
    if (this.player.zipRide) return false;
    if (this.dash) return false;
    return true;
  };

  Skills.prototype._canUseVanguard = function () {
    if (!this.player || !this.player.locked || this.player.dead || this.player.downed) {
      return false;
    }
    if (global.VF.UI && global.VF.UI.isMenuOpen && global.VF.UI.isMenuOpen()) return false;
    if (this.player.classId !== VANGUARD.id) return false;
    return true;
  };

  Skills.prototype._canUseMedic = function () {
    if (!this.player || !this.player.locked || this.player.dead || this.player.downed) {
      return false;
    }
    if (global.VF.UI && global.VF.UI.isMenuOpen && global.VF.UI.isMenuOpen()) return false;
    if (this.player.classId !== MEDIC.id) return false;
    return true;
  };

  Skills.prototype._canUseGhost = function () {
    if (!this.player || !this.player.locked || this.player.dead || this.player.downed) {
      return false;
    }
    if (global.VF.UI && global.VF.UI.isMenuOpen && global.VF.UI.isMenuOpen()) return false;
    if (this.player.classId !== GHOST.id) return false;
    return true;
  };

  Skills.prototype._canUse = function () {
    return this._canUseVanguard();
  };

  Skills.prototype.isChanneling = function () {
    return !!(this.reviveTarget || this.repairTarget);
  };

  Skills.prototype.tryStimulant = function () {
    if (!this._canUseVanguard()) return false;
    if (this.stim) return false;
    if (this.cooldown > 0) {
      if (global.VF.UI && global.VF.UI.toast) {
        global.VF.UI.toast('战斗兴奋剂冷却中 · ' + Math.ceil(this.cooldown) + 's');
      }
      return false;
    }
    const player = this.player;
    const maxHp = player.maxHealth || 100;
    if (player.health >= maxHp) {
      if (global.VF.UI && global.VF.UI.toast) {
        global.VF.UI.toast('生命值已满');
      }
      return false;
    }
    this.stim = {
      remain: VANGUARD.healDuration,
      rate: VANGUARD.healAmount / VANGUARD.healDuration,
    };
    this.cooldown = VANGUARD.cooldown;
    if (global.VF.Audio && global.VF.Audio.play) global.VF.Audio.play('ui');
    if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast('战斗兴奋剂');
    this._syncHud();
    return true;
  };

  Skills.prototype._tickStimulant = function (dt) {
    if (!this.stim || !this.player) return;
    const player = this.player;
    if (player.dead || player.downed) {
      this.stim = null;
      if (global.VF.UI && global.VF.UI.setStimOverlay) global.VF.UI.setStimOverlay(false);
      return;
    }
    const maxHp = player.maxHealth || 100;
    const heal = this.stim.rate * dt;
    player.health = Math.min(maxHp, player.health + heal);
    this.stim.remain -= dt;
    if (global.VF.UI && global.VF.UI.updateVitals) {
      global.VF.UI.updateVitals(player.health, player.armor);
    }
    if (global.VF.UI && global.VF.UI.setStimOverlay) {
      global.VF.UI.setStimOverlay(true, this.stim.remain / VANGUARD.healDuration);
    }
    if (this.stim.remain <= 0 || player.health >= maxHp) {
      this.stim = null;
      if (global.VF.UI && global.VF.UI.setStimOverlay) global.VF.UI.setStimOverlay(false);
    }
  };

  Skills.prototype._nearestDownedAlly = function () {
    const game = global.VF && global.VF.game;
    const revive = global.VF && global.VF.Revive;
    const player = this.player;
    if (!game || !revive || !revive.getDowned || !player) return null;
    const team = player.team || (game.world && game.world._playerTeam) || 'ally';
    const list = revive.getDowned(team) || [];
    const origin = player.object && player.object.position;
    if (!origin) return null;
    const maxR = MEDIC.reviveRange;
    const maxSq = maxR * maxR;
    let best = null;
    let bestSq = maxSq;
    for (let i = 0; i < list.length; i++) {
      const state = list[i];
      if (!state || state.status !== 'pending' || !state.entity) continue;
      if (state.entity === player) continue;
      const pos =
        (state.entity.mesh && state.entity.mesh.position) ||
        (state.entity.object && state.entity.object.position);
      if (!pos) continue;
      const dx = pos.x - origin.x;
      const dy = pos.y - origin.y;
      const dz = pos.z - origin.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestSq) {
        bestSq = d2;
        best = state;
      }
    }
    return best;
  };

  Skills.prototype._beginReviveHold = function () {
    if (!this._canUseMedic()) {
      this._skillHeld = false;
      return;
    }
    const target = this._nearestDownedAlly();
    if (!target) {
      this._skillHeld = false;
      this.reviveTarget = null;
      this.reviveProgress = 0;
      if (global.VF.UI && global.VF.UI.toast) {
        global.VF.UI.toast('附近没有倒地队友');
      }
      if (global.VF.UI && global.VF.UI.updateReviveAssist) {
        global.VF.UI.updateReviveAssist(null);
      }
      return;
    }
    this.reviveTarget = target;
    this.reviveProgress = 0;
  };

  Skills.prototype._tickRevive = function (dt) {
    if (!this.player || !this._skillHeld || this.player.classId !== MEDIC.id || this.player.dead || this.player.downed) {
      if (this.reviveTarget || this.reviveProgress) {
        this.reviveTarget = null;
        this.reviveProgress = 0;
        if (global.VF.UI && global.VF.UI.updateReviveAssist) {
          global.VF.UI.updateReviveAssist(null);
        }
      }
      return;
    }
    const target = this._nearestDownedAlly();
    if (!target) {
      this._skillHeld = false;
      this.reviveTarget = null;
      this.reviveProgress = 0;
      if (global.VF.UI && global.VF.UI.updateReviveAssist) {
        global.VF.UI.updateReviveAssist(null);
      }
      return;
    }
    if (this.reviveTarget !== target) {
      this.reviveTarget = target;
      this.reviveProgress = 0;
    }
    this.reviveProgress += dt / MEDIC.reviveSec;
    if (global.VF.UI && global.VF.UI.updateReviveAssist) {
      global.VF.UI.updateReviveAssist({
        progress: Math.min(1, this.reviveProgress),
        name: global.VF.Revive && global.VF.Revive.entityName
          ? global.VF.Revive.entityName(target.entity)
          : '队友',
      });
    }
    if (this.reviveProgress >= 1) {
      const revive = global.VF.Revive;
      const opts = { healthFrac: MEDIC.reviveHealth / 100 };
      if (target.kind === 'player' && revive.revivePlayer) {
        revive.revivePlayer(this.player, opts);
      } else if (revive.reviveAI) {
        revive.reviveAI(target, this.player, opts);
      }
      this.reviveProgress = 0;
      this.reviveTarget = null;
      this._skillHeld = false;
      if (global.VF.UI && global.VF.UI.updateReviveAssist) {
        global.VF.UI.updateReviveAssist(null);
      }
    }
  };

  Skills.prototype._beginRepairHold = function () {
    if (!this._canUseEngineer()) {
      this._skillHeld = false;
      return;
    }
    const vehicle = this._nearestRepairVehicle();
    if (!vehicle) {
      this._skillHeld = false;
      if (global.VF.UI && global.VF.UI.toast) {
        global.VF.UI.toast('靠近友方载具后维修');
      }
      this.repairTarget = null;
      if (global.VF.UI && global.VF.UI.updateRepairHud) global.VF.UI.updateRepairHud(null);
      return;
    }
    this.repairTarget = vehicle;
  };

  Skills.prototype._nearestRepairVehicle = function () {
    const game = global.VF && global.VF.game;
    const vehicles = game && game.vehicles;
    const player = this.player;
    if (!vehicles || !vehicles.findNearby || !player || !player.object) return null;
    const team = player.team || (game.world && game.world._playerTeam) || 'ally';
    const list = vehicles.findNearby(player, ENGINEER.repairRange, team);
    return list && list[0] ? list[0] : null;
  };

  Skills.prototype._tickRepair = function (dt) {
    if (!this.player || !this._skillHeld || this.player.classId !== ENGINEER.id || this.player.dead || this.player.downed) {
      if (this.repairTarget) {
        this.repairTarget = null;
        if (global.VF.UI && global.VF.UI.updateRepairHud) global.VF.UI.updateRepairHud(null);
      }
      return;
    }
    const vehicle = this._nearestRepairVehicle();
    if (!vehicle) {
      this.repairTarget = null;
      if (global.VF.UI && global.VF.UI.updateRepairHud) global.VF.UI.updateRepairHud(null);
      return;
    }
    this.repairTarget = vehicle;
    if (vehicle.hp < vehicle.maxHp && gameVehiclesRepair(vehicle, ENGINEER.repairPerSec * dt)) {
      this._repairSpark(vehicle, dt);
    }
    const origin = this.player.object.position;
    const dist = Math.hypot(
      vehicle.position.x - origin.x,
      vehicle.position.z - origin.z
    );
    if (global.VF.UI && global.VF.UI.updateRepairHud) {
      global.VF.UI.updateRepairHud({
        hp: vehicle.hp,
        maxHp: vehicle.maxHp,
        dist: dist,
        name: (vehicle.def && vehicle.def.nameZh) || '载具',
      });
    }
  };

  function gameVehiclesRepair(vehicle, amount) {
    const vehicles = global.VF && global.VF.game && global.VF.game.vehicles;
    if (vehicles && vehicles.repair) return vehicles.repair(vehicle, amount) > 0;
    if (!vehicle || !vehicle.alive) return false;
    const before = vehicle.hp;
    vehicle.hp = Math.min(vehicle.maxHp, vehicle.hp + amount);
    return vehicle.hp > before;
  }

  Skills.prototype._repairSpark = function (vehicle, dt) {
    this._repairSparkAcc = (this._repairSparkAcc || 0) + (dt || 0);
    if (this._repairSparkAcc < 0.12) return;
    this._repairSparkAcc = 0;
    const game = global.VF && global.VF.game;
    if (!game || !game.weapons || !game.weapons._spawnImpact) return;
    const p = this.player.getEyePosition();
    const dir = this.player.getLookDirection();
    const pt = p.clone().addScaledVector(dir, 1.4);
    pt.y = Math.min(pt.y, (vehicle.position.y || 0) + 1.2);
    game.weapons._spawnImpact(pt, 0xff7722, 0.16);
  };

  Skills.prototype.isStealthed = function () {
    return !!(this.player && (this.player.stealthed || this.stealthTimer > 0));
  };

  /** Shared check for AI / weapons (works even if skills instance lags a frame). */
  Skills.isPlayerStealthed = function (player) {
    if (!player) return false;
    if (player.stealthed) return true;
    const skills = global.VF.game && global.VF.game.skills;
    return !!(skills && skills.stealthTimer > 0);
  };

  Skills.prototype.reset = function () {
    this.cooldown = 0;
    this.dashCooldown = 0;
    this.dash = null;
    this.aiming = false;
    this._aimKeyDown = false;
    this._skillHeld = false;
    this.stim = null;
    this.reviveProgress = 0;
    this.reviveTarget = null;
    this.repairTarget = null;
    this._clearPending();
    this._clearHealDevice();
    this._clearStealth(true);
    this._clearRiotShield(true);
    this._clearAllTurrets();
    this._clearDashRibbons();
    this._hidePreview();
    this._hideMedicPreview();
    this._hideTurretPreview();
    if (this.player) {
      this.player.skillSpeedBuffTimer = 0;
      this.player.ghostAmbushShot = false;
    }
    this.applyMatchPassives();
    this._syncHud();
    if (global.VF.UI) {
      if (global.VF.UI.updateRepairHud) global.VF.UI.updateRepairHud(null);
      if (global.VF.UI.updateReviveAssist) global.VF.UI.updateReviveAssist(null);
      if (global.VF.UI.setStimOverlay) global.VF.UI.setStimOverlay(false);
    }
  };

  /** Match-start passives (medic shield etc.) */
  Skills.prototype.applyMatchPassives = function () {
    if (!this.player) return;
    if (this.player.classId === MEDIC.id) {
      this.player.maxArmor = Math.max(this.player.maxArmor || 100, 50 + MEDIC.startShield);
      this.player.armor = 50 + MEDIC.startShield;
      if (global.VF.UI) global.VF.UI.updateVitals(this.player.health, this.player.armor);
    }
    if (this.player.classId === ENGINEER.id) {
      this.player.blocks = Math.max(this.player.blocks || 0, ENGINEER.startBlocks);
      if (global.VF.UI) global.VF.UI.updateResources(this.player.cores, this.player.blocks);
    }
  };

  /** Hits required to break a player-placed build voxel (engineer +50%). */
  Skills.getBuildDurabilityHits = function (player) {
    let hits = 1;
    if (player && player.classId === ENGINEER.id) {
      hits = Math.max(1, Math.ceil(ENGINEER.buildDurabilityMul));
    }
    if (global.VF.Economy && global.VF.Economy.ownsModule && global.VF.Economy.ownsModule('mod_armor')) {
      hits += 1;
    }
    return hits;
  };

  Skills.prototype.tryGhostStealth = function () {
    if (!this._canUseGhost()) return false;
    if (this.cooldown > 0 || this.stealthTimer > 0) return false;
    this.stealthTimer = GHOST.duration;
    this.cooldown = GHOST.cooldown;
    this.player.stealthed = true;
    this.player.ghostAmbushShot = false;
    this.player.skillSpeedBuffMul = GHOST.speedBuff;
    this.player.skillSpeedBuffTimer = GHOST.duration;
    this._applyStealthVisual(true);
    if (global.VF.Audio) global.VF.Audio.play('stealth_on');
    if (global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast('隐身 · 移速+30%');
    }
    this._syncHud();
    return true;
  };

  /**
   * End stealth. Grants first-shot +40 unless silent (reset/death).
   * @param {boolean} [silent]
   */
  Skills.prototype.breakStealth = function (silent) {
    if (!this.player || (!this.player.stealthed && this.stealthTimer <= 0)) return;
    const wasStealthed = !!this.player.stealthed;
    this._clearStealth(false);
    if (wasStealthed && !silent) {
      this.player.ghostAmbushShot = true;
      if (global.VF.Audio) global.VF.Audio.play('stealth_off');
      if (global.VF.UI && global.VF.UI.toast) {
        global.VF.UI.toast('破隐 · 下一枪伤害+40');
      }
    }
    this._syncHud();
  };

  Skills.prototype._clearStealth = function (silent) {
    this.stealthTimer = 0;
    if (this.player) {
      this.player.stealthed = false;
      if (this.player.classId === GHOST.id) {
        this.player.skillSpeedBuffTimer = 0;
      }
      if (silent) this.player.ghostAmbushShot = false;
    }
    this._applyStealthVisual(false);
  };

  Skills.prototype._applyStealthVisual = function (on) {
    if (document.body) {
      if (on) document.body.classList.add('stealthed');
      else document.body.classList.remove('stealthed');
    }
    // Dim FPS arms only via a per-mesh flag — never touch the shared material cache
    const vm = this.player && (this.player.viewModel || this.player._weaponViewModel);
    if (!vm) return;
    vm.traverse(function (c) {
      if (!c.isMesh) return;
      c.renderOrder = on ? 2 : 0;
      if (!c.material) return;
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      for (let i = 0; i < mats.length; i++) {
        const src = mats[i];
        if (!src) continue;
        if (on) {
          if (!c.userData._stealthMats) c.userData._stealthMats = [];
          if (!c.userData._stealthMats[i]) {
            const cloned = src.clone();
            cloned.transparent = true;
            cloned.opacity = 0.35;
            cloned.depthWrite = false;
            cloned.userData = cloned.userData || {};
            cloned.userData._owned = true;
            c.userData._stealthMats[i] = { cloned: cloned, original: src };
          }
          if (Array.isArray(c.material)) c.material[i] = c.userData._stealthMats[i].cloned;
          else c.material = c.userData._stealthMats[i].cloned;
        } else if (c.userData._stealthMats && c.userData._stealthMats[i]) {
          if (Array.isArray(c.material)) c.material[i] = c.userData._stealthMats[i].original;
          else c.material = c.userData._stealthMats[i].original;
        }
      }
      if (!on && c.userData._stealthMats) delete c.userData._stealthMats;
    });
    this._vmOpacitySaved = null;
  };

  Skills.prototype._updateStealth = function (dt) {
    if (this.stealthTimer <= 0) {
      if (this.player && this.player.stealthed) this.breakStealth(false);
      return;
    }
    this.stealthTimer = Math.max(0, this.stealthTimer - dt);
    if (this.player) {
      this.player.skillSpeedBuffMul = GHOST.speedBuff;
      this.player.skillSpeedBuffTimer = Math.max(this.stealthTimer, 0.0001);
    }
    if (this.stealthTimer <= 0) {
      // Keep stealthed=true until breakStealth so ambush +40 still applies
      this.breakStealth(false);
    } else if (this.player) {
      this.player.stealthed = true;
    }
  };

  /** True if attacker stands in the rear cone of a facing target. */
  Skills.isBackstab = function (attackerPos, targetPos, targetYaw) {
    if (!attackerPos || !targetPos) return false;
    const dx = attackerPos.x - targetPos.x;
    const dz = attackerPos.z - targetPos.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.05) return false;
    const fx = -Math.sin(targetYaw);
    const fz = -Math.cos(targetYaw);
    const dot = (fx * dx + fz * dz) / len;
    return dot <= GHOST.backstabDot;
  };

  /**
   * Ghost damage modifiers: backstab ×1.3, post-stealth first shot +40 (once).
   * @returns {{ damage: number, backstab: boolean, ambush: boolean }}
   */
  Skills.modifyOutgoingDamage = function (player, baseDmg, targetInfo) {
    let dmg = Math.max(0, baseDmg | 0);
    let backstab = false;
    let ambush = false;
    if (!player || player.classId !== GHOST.id) {
      return { damage: dmg, backstab: false, ambush: false };
    }
    if (targetInfo && targetInfo.pos != null && targetInfo.yaw != null) {
      const ap = player.object && player.object.position;
      if (ap && Skills.isBackstab(ap, targetInfo.pos, targetInfo.yaw)) {
        dmg = Math.round(dmg * GHOST.backstabMul);
        backstab = true;
      }
    }
    if (player.ghostAmbushShot) {
      dmg += GHOST.ambushBonus;
      player.ghostAmbushShot = false;
      ambush = true;
    }
    return { damage: dmg, backstab: backstab, ambush: ambush };
  };

  Skills.prototype._canUseJuggernaut = function () {
    if (!this.player || !this.player.locked || this.player.dead || this.player.downed) {
      return false;
    }
    if (global.VF.UI && global.VF.UI.isMenuOpen && global.VF.UI.isMenuOpen()) return false;
    if (this.player.classId !== JUGGERNAUT.id) return false;
    return true;
  };

  Skills.prototype.tryRiotShield = function () {
    if (!this._canUseJuggernaut()) return false;
    if (this.cooldown > 0 || this.riotShield) return false;
    this.cooldown = JUGGERNAUT.cooldown;
    const mesh = this._makeRiotShieldMesh();
    this.scene.add(mesh);
    this.riotShield = {
      mesh: mesh,
      hp: JUGGERNAUT.hp,
      maxHp: JUGGERNAUT.hp,
      life: JUGGERNAUT.duration,
      flash: 0,
    };
    this.player.skillSpeedBuffMul = JUGGERNAUT.speedMul;
    this.player.skillSpeedBuffTimer = JUGGERNAUT.duration;
    this._positionRiotShield();
    if (global.VF.Audio) global.VF.Audio.play('shield_on');
    if (global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast('防暴盾展开 · 移速-35%');
    }
    this._syncHud();
    return true;
  };

  Skills.prototype._makeRiotShieldMesh = function () {
    const root = new THREE.Group();
    root.name = 'RiotShield';
    root.frustumCulled = false;

    const w = JUGGERNAUT.width;
    const h = JUGGERNAUT.height;
    // Eye-level viewport — raised so hipfire can see the road ahead
    const winW = w * 0.46;
    const winH = h * 0.34;
    const winY = h * 0.36;
    const z = -0.12;

    const alloy = new THREE.MeshBasicMaterial({
      color: 0x3a4a58,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const energy = new THREE.MeshBasicMaterial({
      color: 0x6ec8ff,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const rimMat = new THREE.MeshBasicMaterial({
      color: 0xb8e8ff,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const glass = new THREE.MeshBasicMaterial({
      color: 0xc8e8ff,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    // Alloy frame around the viewport (top / bottom / left / right) — no solid plate over window
    const topPlateH = Math.max(0.18, h * 0.2);
    const botPlateH = Math.max(0.55, h * 0.4);
    const sideW = Math.max(0.22, (w * 0.72 - winW) * 0.5);

    const top = new THREE.Mesh(new THREE.BoxGeometry(w * 0.72, topPlateH, 0.1), alloy.clone());
    top.position.set(0, winY + winH * 0.5 + topPlateH * 0.5, z);
    root.add(top);
    const topGlow = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.74, topPlateH * 0.2, 0.06),
      energy.clone()
    );
    topGlow.position.set(0, top.position.y, z - 0.04);
    root.add(topGlow);

    const bottom = new THREE.Mesh(new THREE.BoxGeometry(w * 0.72, botPlateH, 0.1), alloy.clone());
    bottom.position.set(0, winY - winH * 0.5 - botPlateH * 0.5, z);
    root.add(bottom);
    const botGlow = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.74, botPlateH * 0.25, 0.06),
      energy.clone()
    );
    botGlow.position.set(0, bottom.position.y, z - 0.04);
    root.add(botGlow);

    const left = new THREE.Mesh(new THREE.BoxGeometry(sideW, winH + 0.08, 0.1), alloy.clone());
    left.position.set(-(winW * 0.5 + sideW * 0.5), winY, z);
    root.add(left);
    const right = new THREE.Mesh(new THREE.BoxGeometry(sideW, winH + 0.08, 0.1), alloy.clone());
    right.position.set(winW * 0.5 + sideW * 0.5, winY, z);
    root.add(right);

    // Side energy strips
    const sideGlowL = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, winH + topPlateH + botPlateH * 0.4, 0.05),
      energy.clone()
    );
    sideGlowL.position.set(-(w * 0.36), winY - 0.05, z - 0.05);
    root.add(sideGlowL);
    const sideGlowR = sideGlowL.clone();
    sideGlowR.position.x = w * 0.36;
    root.add(sideGlowR);

    // Clear viewport glass (almost invisible) + bright rim
    const viewport = new THREE.Mesh(new THREE.BoxGeometry(winW, winH, 0.03), glass);
    viewport.position.set(0, winY, z - 0.02);
    root.add(viewport);

    const rimT = 0.045;
    const wrT = new THREE.Mesh(new THREE.BoxGeometry(winW + 0.08, rimT, 0.05), rimMat);
    wrT.position.set(0, winY + winH * 0.5, z - 0.03);
    root.add(wrT);
    const wrB = wrT.clone();
    wrB.position.y = winY - winH * 0.5;
    root.add(wrB);
    const wrL = new THREE.Mesh(new THREE.BoxGeometry(rimT, winH, 0.05), rimMat);
    wrL.position.set(-winW * 0.5, winY, z - 0.03);
    root.add(wrL);
    const wrR = wrL.clone();
    wrR.position.x = winW * 0.5;
    root.add(wrR);

    // Warning stripe on lower plate
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, botPlateH * 0.7, 0.08),
      new THREE.MeshBasicMaterial({
        color: 0xffc040,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      })
    );
    stripe.position.set(0, bottom.position.y, z - 0.06);
    root.add(stripe);

    // Use topGlow as flash target (energy highlight)
    root.userData.shell = topGlow;
    root.userData.plate = top;
    root.userData.viewport = viewport;
    return root;
  };

  Skills.prototype._positionRiotShield = function () {
    if (!this.riotShield || !this.riotShield.mesh || !this.player) return;
    const pos = this.player.object.position;
    const yaw = this.player.yaw;
    // Player look forward matches soldier (-sin, -cos) after face convention used elsewhere
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const mesh = this.riotShield.mesh;
    mesh.position.set(
      pos.x + fx * JUGGERNAUT.offset,
      pos.y + JUGGERNAUT.height * 0.42,
      pos.z + fz * JUGGERNAUT.offset
    );
    mesh.rotation.y = yaw;
  };

  Skills.prototype._clearRiotShield = function (silent) {
    if (!this.riotShield) return;
    const mesh = this.riotShield.mesh;
    if (mesh) {
      this.scene.remove(mesh);
      mesh.traverse(function (c) {
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
          if (Array.isArray(c.material)) c.material.forEach(function (m) { m.dispose && m.dispose(); });
          else if (c.material.dispose) c.material.dispose();
        }
      });
    }
    this.riotShield = null;
    if (this.player && this.player.classId === JUGGERNAUT.id) {
      this.player.skillSpeedBuffTimer = 0;
    }
    if (!silent && global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast('防暴盾已结束');
    }
  };

  Skills.prototype._breakRiotShield = function () {
    if (!this.riotShield) return;
    if (global.VF.Audio) global.VF.Audio.play('shield_break');
    this._clearRiotShield(true);
    if (global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast('防暴盾破碎');
    }
    this._syncHud();
  };

  Skills.prototype._updateRiotShield = function (dt) {
    if (!this.riotShield) return;
    const s = this.riotShield;
    s.life -= dt;
    if (this.player) {
      this.player.skillSpeedBuffMul = JUGGERNAUT.speedMul;
      this.player.skillSpeedBuffTimer = Math.max(s.life, 0.0001);
    }
    this._positionRiotShield();

    if (s.flash > 0) {
      s.flash -= dt;
      const pulse = 0.55 + Math.min(1, s.flash * 4) * 0.4;
      if (s.mesh && s.mesh.userData.shell && s.mesh.userData.shell.material) {
        s.mesh.userData.shell.material.opacity = pulse;
      }
    } else if (s.mesh && s.mesh.userData.shell && s.mesh.userData.shell.material) {
      const hpRatio = s.hp / s.maxHp;
      s.mesh.userData.shell.material.opacity = 0.28 + hpRatio * 0.22;
    }

    if (s.life <= 0 || s.hp <= 0) {
      if (s.hp <= 0) this._breakRiotShield();
      else this._clearRiotShield(false);
      this._syncHud();
    }
  };

  /**
   * Absorb frontal bullet damage into the riot shield.
   * @returns {number} remaining damage to apply to the player
   */
  Skills.prototype.tryAbsorbShieldDamage = function (amount, fromPos) {
    if (!this.riotShield || !(amount > 0) || !this.player) return amount;
    if (fromPos) {
      const pos = this.player.object.position;
      const dx = fromPos.x - pos.x;
      const dz = fromPos.z - pos.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 0.05) {
        const yaw = this.player.yaw;
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        const dot = (fx * dx + fz * dz) / len;
        // Only block attacks from the front half
        if (dot < JUGGERNAUT.frontDot) return amount;
      }
    }
    const absorb = Math.min(this.riotShield.hp, amount);
    this.riotShield.hp -= absorb;
    this.riotShield.flash = 0.18;
    if (absorb > 0 && global.VF.Audio) global.VF.Audio.play('shield_hit');
    if (this.riotShield.hp <= 0) {
      this._breakRiotShield();
    }
    return Math.max(0, amount - absorb);
  };

  /** Juggernaut passive: incoming bullet damage ×0.94 */
  Skills.modifyIncomingBulletDamage = function (player, amount) {
    if (!player || player.classId !== JUGGERNAUT.id) return amount;
    return Math.max(0, amount * JUGGERNAUT.bulletResist);
  };

  /** Raider passive: loot multiplier on kills / fortification salvage */
  Skills.getLootMul = function (player) {
    if (player && player.classId === RAIDER.id) return RAIDER.lootMul;
    return 1;
  };

  Skills.prototype._canUseRaider = function () {
    if (!this.player || !this.player.locked || this.player.dead || this.player.downed) {
      return false;
    }
    if (global.VF.UI && global.VF.UI.isMenuOpen && global.VF.UI.isMenuOpen()) return false;
    if (this.player.classId !== RAIDER.id) return false;
    return true;
  };

  Skills.prototype.tryEmpPulse = function () {
    if (!this._canUseRaider()) return false;
    if (this.cooldown > 0) return false;
    this.cooldown = RAIDER.cooldown;

    const eye = this.player.getEyePosition();
    const look = this.player.getLookDirection();
    const dirLen = Math.sqrt(look.x * look.x + look.y * look.y + look.z * look.z) || 1;
    const dx = look.x / dirLen;
    const dy = look.y / dirLen;
    const dz = look.z / dirLen;

    // Impact point: first solid along look within range, else near max range
    let hitX = eye.x + dx * (RAIDER.range * 0.7);
    let hitY = eye.y + dy * (RAIDER.range * 0.7);
    let hitZ = eye.z + dz * (RAIDER.range * 0.7);
    const step = 0.35;
    for (let t = 0.5; t <= RAIDER.range; t += step) {
      const x = eye.x + dx * t;
      const y = eye.y + dy * t;
      const z = eye.z + dz * t;
      if (this._isBlocked(x, y, z)) {
        // Center carve inside the hit solid so the tunnel actually eats the wall
        hitX = x + dx * 0.35;
        hitY = y + dy * 0.35;
        hitZ = z + dz * 0.35;
        break;
      }
    }

    const broken = this._empCarve(hitX, hitY, hitZ, eye, dx, dy, dz);
    const doors = this._empBreakMechanisms(eye, dx, dy, dz);
    this._spawnEmpFx(eye.x, eye.y, eye.z, dx, dy, dz, hitX, hitY, hitZ);

    if (global.VF.Audio) global.VF.Audio.play('emp');
    if (this.player.addShake) this.player.addShake(0.28);

    // Salvage passive when wrecking fortifications
    if (broken + doors > 0 && this.player.classId === RAIDER.id) {
      this._raiderSalvageDrop(hitX, hitY, hitZ, broken + doors);
    }

    if (global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast(
        '电磁脉冲 · 摧毁 ' + broken + ' 方块' + (doors ? ' · 机关 ' + doors : '')
      );
    }
    this._syncHud();
    return true;
  };

  /** True if point is inside the forward 60° 3D cone within range. */
  Skills.prototype._inEmpCone = function (origin, dx, dy, dz, px, py, pz) {
    const vx = px - origin.x;
    const vy = py - origin.y;
    const vz = pz - origin.z;
    const dist = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (dist > RAIDER.range || dist < 0.15) return false;
    const dot = (dx * vx + dy * vy + dz * vz) / dist;
    const cosHalf = Math.cos((RAIDER.halfAngleDeg * Math.PI) / 180);
    return dot >= cosHalf;
  };

  /**
   * EMP structure break — metal still drops in one hit (guns need 5).
   * Skips only air / water / bedrock.
   */
  Skills.prototype._empBreakBlock = function (x, y, z) {
    if (!this.world) return false;
    x = Math.floor(x);
    y = Math.floor(y);
    z = Math.floor(z);
    const BLOCK = global.VF.BLOCK;
    const t = this.world.get(x, y, z);
    if (t === BLOCK.AIR || t === BLOCK.WATER || t === BLOCK.BEDROCK) return false;
    if (this.world._isStructureSolid && !this.world._isStructureSolid(x, y, z)) return false;
    if (t === BLOCK.METAL) {
      this.world.set(x, y, z, BLOCK.AIR);
      const cs = this.world.chunkSize || 16;
      const cx = Math.floor(x / cs);
      const cz = Math.floor(z / cs);
      if (this.world._markChunkDirty) {
        this.world._markChunkDirty(cx, cz);
        if (x % cs === 0) this.world._markChunkDirty(cx - 1, cz);
        if (x % cs === cs - 1) this.world._markChunkDirty(cx + 1, cz);
        if (z % cs === 0) this.world._markChunkDirty(cx, cz - 1);
        if (z % cs === cs - 1) this.world._markChunkDirty(cx, cz + 1);
      }
      return true;
    }
    return this.world.breakBlock(x, y, z);
  };

  /** Skip only the player's own base pad (still allow assault on enemy / city / mid). */
  Skills.prototype._isFriendlyBaseCell = function (x, z) {
    const bases = global.VF.game && global.VF.game.bases;
    if (!bases || !bases.getFriendlyBase) return false;
    const home = bases.getFriendlyBase();
    if (!home) return false;
    const hx = home.userData && home.userData.cx != null ? home.userData.cx : home.position.x;
    const hz = home.userData && home.userData.cz != null ? home.userData.cz : home.position.z;
    const half = 22;
    return Math.abs(x - hx) <= half && Math.abs(z - hz) <= half;
  };

  Skills.prototype._empCarve = function (hx, hy, hz, origin, dx, dy, dz) {
    const cx = Math.floor(hx);
    const cy = Math.floor(hy);
    const cz = Math.floor(hz);
    const hw = Math.floor(RAIDER.carveW / 2);
    const hd = Math.floor(RAIDER.carveD / 2);
    const hh = Math.floor(RAIDER.carveH / 2);
    const weapons = global.VF.game && global.VF.game.weapons;
    let broken = 0;
    let budget = RAIDER.structureDmg;

    // Dense core at impact — always carve this tunnel (cone optional, no river filter)
    for (let ix = -hw; ix < RAIDER.carveW - hw && budget > 0; ix++) {
      for (let iz = -hd; iz < RAIDER.carveD - hd && budget > 0; iz++) {
        for (let iy = -hh; iy < RAIDER.carveH - hh && budget > 0; iy++) {
          const bx = cx + ix;
          const by = cy + iy;
          const bz = cz + iz;
          if (this._isFriendlyBaseCell(bx, bz)) continue;
          // Prefer cells still roughly in front of the player
          const vx = bx + 0.5 - origin.x;
          const vy = by + 0.5 - origin.y;
          const vz = bz + 0.5 - origin.z;
          const dist = Math.sqrt(vx * vx + vy * vy + vz * vz);
          if (dist > RAIDER.range + 2) continue;
          if (dist > 0.4 && (dx * vx + dy * vy + dz * vz) / dist < 0.15) continue;
          if (this._empBreakBlock(bx, by, bz)) {
            broken++;
            budget--;
            if (weapons) {
              if (weapons._syncWorldBreak) weapons._syncWorldBreak('break-voxel', bx, by, bz);
              if (weapons._spawnDebris && broken % 4 === 0) {
                weapons._spawnDebris(bx + 0.5, by + 0.5, bz + 0.5);
              }
            }
          }
        }
      }
    }

    // Remaining budget: voxels inside the 3D cone
    if (budget > 0) {
      const r = Math.ceil(RAIDER.range);
      for (let t = 1; t <= r && budget > 0; t++) {
        const rad = Math.max(1, Math.ceil(Math.tan((RAIDER.halfAngleDeg * Math.PI) / 180) * t) + 1);
        const mx = Math.floor(origin.x + dx * t);
        const my = Math.floor(origin.y + dy * t);
        const mz = Math.floor(origin.z + dz * t);
        for (let ix = mx - rad; ix <= mx + rad && budget > 0; ix++) {
          for (let iy = my - Math.min(rad, 8); iy <= my + Math.min(rad, 8) && budget > 0; iy++) {
            for (let iz = mz - rad; iz <= mz + rad && budget > 0; iz++) {
              if (
                ix >= cx - hw &&
                ix < cx + RAIDER.carveW - hw &&
                iy >= cy - hh &&
                iy < cy + RAIDER.carveH - hh &&
                iz >= cz - hd &&
                iz < cz + RAIDER.carveD - hd
              ) {
                continue;
              }
              if (!this._inEmpCone(origin, dx, dy, dz, ix + 0.5, iy + 0.5, iz + 0.5)) continue;
              if (this._isFriendlyBaseCell(ix, iz)) continue;
              if (this._empBreakBlock(ix, iy, iz)) {
                broken++;
                budget--;
                if (weapons && weapons._syncWorldBreak) {
                  weapons._syncWorldBreak('break-voxel', ix, iy, iz);
                }
              }
            }
          }
        }
      }
    }

    if (broken > 0 && this.world.flushRebuilds) {
      this.world.flushRebuilds(48, hx, hz);
    }
    return broken;
  };

  Skills.prototype._empBreakMechanisms = function (origin, dx, dy, dz) {
    if (!this.world || !this.world.props) return 0;
    let n = 0;
    const props = this.world.props.slice();
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      if (!p || !p.breakable || p.kind !== 'door' || !p.box) continue;
      const pcx = (p.box.min.x + p.box.max.x) * 0.5;
      const pcy = (p.box.min.y + p.box.max.y) * 0.5;
      const pcz = (p.box.min.z + p.box.max.z) * 0.5;
      if (!this._inEmpCone(origin, dx, dy, dz, pcx, pcy, pcz)) continue;
      if (this._isFriendlyBaseCell(pcx, pcz)) continue;
      if (this.world.destroyProp(p)) {
        n++;
        const weapons = global.VF.game && global.VF.game.weapons;
        if (weapons && weapons._syncWorldBreak) {
          weapons._syncWorldBreak('break-door', pcx, pcy, pcz);
        }
        if (weapons && weapons._spawnDebris) {
          weapons._spawnDebris(pcx, pcy, pcz);
        }
      }
    }
    return n;
  };

  Skills.prototype._spawnEmpFx = function (ox, oy, oz, dx, dy, dz, hx, hy, hz) {
    // Expanding cone flash + impact
    const mat = new THREE.MeshBasicMaterial({
      color: 0x66e0ff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const coneLen = RAIDER.range * 0.95;
    const coneR = Math.tan((RAIDER.halfAngleDeg * Math.PI) / 180) * coneLen;
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(coneR, coneLen, 28, 1, true),
      mat
    );
    // Apex at eye: ConeGeometry tip is +Y, so map +Y to -look (base flares forward)
    cone.position.set(
      ox + dx * coneLen * 0.5,
      oy + dy * coneLen * 0.5,
      oz + dz * coneLen * 0.5
    );
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3(dx, dy, dz);
    cone.quaternion.setFromUnitVectors(up, dir.clone().negate());
    this.scene.add(cone);
    this._fx.push({ mesh: cone, life: 0.55, maxLife: 0.55 });

    // Impact core
    const blast = new THREE.Mesh(
      new THREE.SphereGeometry(2.4, 16, 16),
      new THREE.MeshBasicMaterial({
        color: 0xe8ffff,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    blast.position.set(hx, hy, hz);
    this.scene.add(blast);
    this._fx.push({ mesh: blast, life: 0.55, maxLife: 0.55, growUniform: 5 });

    // Outer EMP shell
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(3.6, 16, 16),
      new THREE.MeshBasicMaterial({
        color: 0x4ec8ff,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        wireframe: true,
      })
    );
    shell.position.set(hx, hy, hz);
    this.scene.add(shell);
    this._fx.push({ mesh: shell, life: 0.7, maxLife: 0.7, growUniform: 7 });

    // Expanding ground rings at impact
    for (let r = 0; r < 2; r++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.2 + r * 1.5, 4.5 + r * 3.5, 40),
        new THREE.MeshBasicMaterial({
          color: r === 0 ? 0xa8f0ff : 0x3ab0ff,
          transparent: true,
          opacity: 0.7 - r * 0.2,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(hx, hy - 0.4 + r * 0.12, hz);
      this.scene.add(ring);
      this._fx.push({
        mesh: ring,
        life: 0.65 + r * 0.15,
        maxLife: 0.65 + r * 0.15,
        empScale: 4 + r * 2,
      });
    }

    // Axial beams for readable cone silhouette
    for (let i = -2; i <= 2; i++) {
      const ang = (i * RAIDER.halfAngleDeg * Math.PI) / 180 / 2;
      // Rotate look dir around world up for horizontal spread hint
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      let sx = dx * cos + dz * sin;
      let sy = dy;
      let sz = -dx * sin + dz * cos;
      const sl = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
      sx /= sl;
      sy /= sl;
      sz /= sl;
      const beam = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 0.18, RAIDER.range * 0.92),
        new THREE.MeshBasicMaterial({
          color: 0x7ae8ff,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      );
      beam.position.set(
        ox + sx * RAIDER.range * 0.46,
        oy + sy * RAIDER.range * 0.46,
        oz + sz * RAIDER.range * 0.46
      );
      beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(sx, sy, sz));
      this.scene.add(beam);
      this._fx.push({ mesh: beam, life: 0.45, maxLife: 0.45 });
    }

    // Debris burst at EMP impact
    const weapons = global.VF.game && global.VF.game.weapons;
    if (weapons) {
      if (weapons._spawnDebris) {
        weapons._spawnDebris(hx, hy, hz, 0x88d0e8);
        weapons._spawnDebris(hx + dx * 1.2, hy + dy * 1.2, hz + dz * 1.2, 0xa8f0ff);
      }
      if (weapons._spawnImpact) {
        weapons._spawnImpact(new THREE.Vector3(hx, hy, hz), 0xffffff, 0.55);
        weapons._spawnImpact(new THREE.Vector3(hx, hy, hz), 0x66e0ff, 0.9);
      }
    }
  };

  Skills.prototype._raiderSalvageDrop = function (x, y, z, broken) {
    const mul = RAIDER.lootMul;
    const pos = new THREE.Vector3(x, y + 0.5, z);
    if (global.VF.game && global.VF.game.weapons) {
      const amount = Math.round((global.VF.AMMO_DROP_AMOUNT || 30) * (mul - 1));
      if (amount > 0) {
        global.VF.game.weapons.spawnAmmoDrop(pos.clone(), 'ar', amount);
      }
    }
    if (global.VF.game && global.VF.game.spawnResource && broken >= 6) {
      global.VF.game.spawnResource(pos.clone().add(new THREE.Vector3(0.4, 0, 0.2)), 'block');
      if (mul > 1.2 && Math.random() < 0.45) {
        global.VF.game.spawnResource(pos.clone().add(new THREE.Vector3(-0.3, 0, -0.2)), 'core');
      }
    }
  };

  Skills.prototype._clearHealDevice = function () {
    if (!this.healDevice) return;
    const d = this.healDevice;
    if (d.mesh) {
      this.scene.remove(d.mesh);
      d.mesh.traverse(function (c) {
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
          if (Array.isArray(c.material)) c.material.forEach(function (m) { m.dispose && m.dispose(); });
          else if (c.material.dispose) c.material.dispose();
        }
      });
    }
    if (d.aura) {
      this.scene.remove(d.aura);
      if (d.aura.geometry) d.aura.geometry.dispose();
      if (d.aura.material) d.aura.material.dispose();
    }
    this.healDevice = null;
  };

  Skills.prototype._clearPending = function () {
    if (this.pending && this.pending.mesh) {
      this.scene.remove(this.pending.mesh);
      this.pending.mesh.traverse(function (c) {
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
          if (Array.isArray(c.material)) c.material.forEach(function (m) { m.dispose && m.dispose(); });
          else if (c.material.dispose) c.material.dispose();
        }
      });
    }
    this.pending = null;
  };

  Skills.getWeaponSpeedMul = function (player) {
    if (player && player.classId === VANGUARD.id) return VANGUARD.weaponSpeed;
    return 1;
  };

  /** Dash along camera look — full 3D (spherical range). */
  Skills.prototype._getDashDir = function () {
    const dir = this.player.getLookDirection();
    const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z) || 1;
    return {
      x: dir.x / len,
      y: dir.y / len,
      z: dir.z / len,
    };
  };

  Skills.prototype.tryDash = function () {
    if (!this._canDash()) return false;
    if (this.dashCooldown > 0) {
      if (global.VF.UI && global.VF.UI.toast) {
        global.VF.UI.toast('冲刺冷却中');
      }
      return false;
    }
    const dir = this._getDashDir();
    const pos = this.player.object.position;
    const eyeY = (this.player.getEyeHeight && this.player.getEyeHeight()) || 1.6;
    this.dash = {
      dirX: dir.x,
      dirY: dir.y,
      dirZ: dir.z,
      remaining: DASH.distance,
      elapsed: 0,
      trail: [{ x: pos.x, y: pos.y + eyeY * 0.55, z: pos.z }],
      sampleAcc: 0,
      jetAcc: 0,
      sparkAcc: 0,
    };
    this.dashCooldown = DASH.cooldown;
    if (this.player.crouching && this.player._canStand && this.player._canStand()) {
      this.player.crouching = false;
    }
    this.player.velocity.set(0, 0, 0);
    if (global.VF.Audio) global.VF.Audio.play('dash');
    // Strong FOV/kick — former gun punch feel, reserved for dash whoosh
    if (this.player.punchFeedback) {
      this.player.punchFeedback({ shake: 0.32, fov: -9, pitch: 0.03 });
    } else if (this.player.addShake) {
      this.player.addShake(0.32);
    }
    this._syncHud();
    return true;
  };

  Skills.prototype._sampleDashTrail = function () {
    if (!this.dash || !this.player) return;
    const pos = this.player.object.position;
    const eyeY = (this.player.getEyeHeight && this.player.getEyeHeight()) || 1.6;
    const p = { x: pos.x, y: pos.y + eyeY * 0.55, z: pos.z };
    const trail = this.dash.trail;
    const last = trail[trail.length - 1];
    if (!last || (p.x - last.x) * (p.x - last.x) + (p.y - last.y) * (p.y - last.y) + (p.z - last.z) * (p.z - last.z) > 0.08) {
      trail.push(p);
    }
  };

  Skills.prototype._clearDashRibbons = function () {
    if (!this._dashRibbons) return;
    for (let i = 0; i < this._dashRibbons.length; i++) {
      const r = this._dashRibbons[i];
      if (r.mesh) {
        this.scene.remove(r.mesh);
        if (r.mesh.geometry) r.mesh.geometry.dispose();
        if (r.mesh.material) r.mesh.material.dispose();
      }
    }
    this._dashRibbons.length = 0;
  };

  /** Orange thruster / jet flame particle behind the player. */
  Skills.prototype._spawnDashJetParticle = function (x, y, z, dirX, dirY, dirZ, scaleMul) {
    if (!this.scene) return;
    const s = (0.12 + Math.random() * 0.22) * (scaleMul || 1);
    const geo = new THREE.SphereGeometry(s, 6, 6);
    const color = DASH_JET_COLORS[(Math.random() * DASH_JET_COLORS.length) | 0];
    const mat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(
      x + (Math.random() - 0.5) * 0.25,
      y + (Math.random() - 0.5) * 0.2,
      z + (Math.random() - 0.5) * 0.25
    );
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    this.scene.add(mesh);
    const kick = 4 + Math.random() * 7;
    this._dashRibbons.push({
      kind: 'jet',
      mesh: mesh,
      life: DASH.jetLife * (0.7 + Math.random() * 0.6),
      maxLife: DASH.jetLife,
      vx: -dirX * kick + (Math.random() - 0.5) * 2.5,
      vy: -dirY * kick * 0.6 + 0.5 + Math.random() * 2.2,
      vz: -dirZ * kick + (Math.random() - 0.5) * 2.5,
      grow: 1.6 + Math.random() * 1.8,
      baseScale: s,
    });
  };

  /** Lingering spark speck left along the dash path. */
  Skills.prototype._spawnDashSpark = function (x, y, z, dirX, dirY, dirZ) {
    if (!this.scene) return;
    const s = 0.07 + Math.random() * 0.11;
    const geo = new THREE.SphereGeometry(s, 5, 5);
    const color = DASH_SPARK_COLORS[(Math.random() * DASH_SPARK_COLORS.length) | 0];
    const mat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(
      x + (Math.random() - 0.5) * 0.55,
      y + (Math.random() - 0.5) * 0.4,
      z + (Math.random() - 0.5) * 0.55
    );
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    this.scene.add(mesh);
    this._dashRibbons.push({
      kind: 'spark',
      mesh: mesh,
      life: DASH.sparkLife * (0.75 + Math.random() * 0.45),
      maxLife: DASH.sparkLife,
      vx: -dirX * (0.3 + Math.random() * 1.0) + (Math.random() - 0.5) * 1.8,
      vy: 0.6 + Math.random() * 2.2,
      vz: -dirZ * (0.3 + Math.random() * 1.0) + (Math.random() - 0.5) * 1.8,
      grow: 0.8 + Math.random() * 1.1,
      flicker: 6 + Math.random() * 8,
    });
  };

  Skills.prototype._emitDashJets = function (count, scaleMul) {
    if (!this.dash || !this.player) return;
    const d = this.dash;
    const pos = this.player.object.position;
    const eyeY = (this.player.getEyeHeight && this.player.getEyeHeight()) || 1.6;
    const bx = pos.x - d.dirX * 0.55;
    const by = pos.y + eyeY * 0.45 - d.dirY * 0.35;
    const bz = pos.z - d.dirZ * 0.55;
    const n = count != null ? count : 3;
    for (let i = 0; i < n; i++) {
      this._spawnDashJetParticle(bx, by, bz, d.dirX, d.dirY, d.dirZ, scaleMul || 1);
    }
  };

  Skills.prototype._emitDashSparks = function (count) {
    if (!this.dash || !this.player) return;
    const d = this.dash;
    const pos = this.player.object.position;
    const eyeY = (this.player.getEyeHeight && this.player.getEyeHeight()) || 1.6;
    const bx = pos.x - d.dirX * 0.35;
    const by = pos.y + eyeY * 0.35;
    const bz = pos.z - d.dirZ * 0.35;
    const n = count != null ? count : 2;
    for (let i = 0; i < n; i++) {
      this._spawnDashSpark(bx, by, bz, d.dirX, d.dirY, d.dirZ);
    }
  };

  /** End-of-dash thruster burst + spark trail dump. */
  Skills.prototype._spawnDashRibbons = function (dashState) {
    if (!dashState || !this.player) return;
    const pos = this.player.object.position;
    const eyeY = (this.player.getEyeHeight && this.player.getEyeHeight()) || 1.6;
    const bx = pos.x - dashState.dirX * 0.4;
    const by = pos.y + eyeY * 0.4;
    const bz = pos.z - dashState.dirZ * 0.4;
    for (let i = 0; i < DASH.jetBurst; i++) {
      this._spawnDashJetParticle(
        bx,
        by,
        bz,
        dashState.dirX,
        dashState.dirY,
        dashState.dirZ,
        1.2 + Math.random() * 0.8
      );
    }
    // Scatter sparks along recorded trail so the path stays lit
    const trail = dashState.trail || [];
    for (let t = 0; t < trail.length; t++) {
      const p = trail[t];
      const sparks = 2 + ((Math.random() * 3) | 0);
      for (let s = 0; s < sparks; s++) {
        this._spawnDashSpark(p.x, p.y, p.z, dashState.dirX, dashState.dirY, dashState.dirZ);
      }
    }
  };

  Skills.prototype._updateDashRibbons = function (dt) {
    if (!this._dashRibbons || !this._dashRibbons.length) return;
    for (let i = this._dashRibbons.length - 1; i >= 0; i--) {
      const r = this._dashRibbons[i];
      r.life -= dt;
      if (r.mesh) {
        r.mesh.position.x += (r.vx || 0) * dt;
        r.mesh.position.y += (r.vy || 0) * dt;
        r.mesh.position.z += (r.vz || 0) * dt;
        if (r.kind === 'spark') {
          if (r.vy != null) r.vy -= 12 * dt;
          // Settle near ground-ish and linger as glowing crumbs
          if (r.mesh.position.y < 0.15) {
            r.mesh.position.y = 0.15;
            r.vx *= 0.85;
            r.vz *= 0.85;
            r.vy = 0;
          }
          const u = Math.max(0, r.life / Math.max(0.001, r.maxLife));
          const flick = 0.7 + 0.3 * Math.abs(Math.sin(performance.now() * 0.001 * (r.flicker || 8)));
          r.mesh.scale.setScalar(0.85 + (1 - u) * (r.grow || 0.8));
          if (r.mesh.material) r.mesh.material.opacity = Math.min(1, 0.35 + u * 0.9) * flick;
        } else {
          if (r.vy != null) r.vy -= 6 * dt;
          const u = Math.max(0, r.life / Math.max(0.001, r.maxLife));
          const g = 1 + (1 - u) * (r.grow || 1.5);
          r.mesh.scale.setScalar(g);
          if (r.mesh.material) r.mesh.material.opacity = 0.95 * u;
        }
      }
      if (r.life <= 0) {
        if (r.mesh) {
          this.scene.remove(r.mesh);
          if (r.mesh.geometry) r.mesh.geometry.dispose();
          if (r.mesh.material) r.mesh.material.dispose();
        }
        this._dashRibbons.splice(i, 1);
      }
    }
  };

  Skills.prototype._updateDash = function (dt) {
    if (!this.dash || !this.player) return;
    const d = this.dash;
    d.elapsed = (d.elapsed || 0) + dt;
    const speed = DASH.distance / DASH.duration;
    let budget = Math.min(d.remaining, speed * dt);
    const step = DASH.step;
    let blocked = false;
    while (budget > 0.001 && !blocked) {
      const move = Math.min(step, budget);
      budget -= move;
      d.remaining -= move;
      const pos = this.player.object.position;
      const ox = pos.x;
      const oy = pos.y;
      const oz = pos.z;
      pos.x += d.dirX * move;
      pos.y += d.dirY * move;
      pos.z += d.dirZ * move;
      if (this.player._overlaps && this.player._overlaps()) {
        // Try tiny slide along free axes, else stop
        pos.x = ox;
        pos.y = oy;
        pos.z = oz;
        let slid = false;
        // Prefer primary axis of motion
        const axes = [
          { x: d.dirX * move, y: 0, z: 0 },
          { x: 0, y: d.dirY * move, z: 0 },
          { x: 0, y: 0, z: d.dirZ * move },
        ];
        for (let i = 0; i < axes.length; i++) {
          const a = axes[i];
          if (Math.abs(a.x) + Math.abs(a.y) + Math.abs(a.z) < 1e-6) continue;
          pos.x = ox + a.x;
          pos.y = oy + a.y;
          pos.z = oz + a.z;
          if (!this.player._overlaps()) {
            slid = true;
            break;
          }
          pos.x = ox;
          pos.y = oy;
          pos.z = oz;
        }
        if (!slid) {
          blocked = true;
          d.remaining = 0;
        }
      }
      if (pos.y < -2) {
        pos.y = oy;
        blocked = true;
        d.remaining = 0;
      }
      this._sampleDashTrail();
    }
    // Orange thruster jets + lingering spark trail while dashing
    d.jetAcc = (d.jetAcc || 0) + dt;
    d.sparkAcc = (d.sparkAcc || 0) + dt;
    const jetInterval = 1 / Math.max(1, DASH.jetEmitRate);
    while (d.jetAcc >= jetInterval) {
      d.jetAcc -= jetInterval;
      this._emitDashJets(2 + ((Math.random() * 2) | 0), 1);
    }
    const sparkInterval = 1 / Math.max(1, DASH.sparkRate);
    while (d.sparkAcc >= sparkInterval) {
      d.sparkAcc -= sparkInterval;
      this._emitDashSparks(3 + ((Math.random() * 2) | 0));
    }
    const margin = 1;
    const max = this.world.worldSize - margin;
    const pos = this.player.object.position;
    pos.x = Math.max(margin, Math.min(max, pos.x));
    pos.z = Math.max(margin, Math.min(max, pos.z));
    // Soft ceiling — don't fly out of sky forever
    if (pos.y > 120) pos.y = 120;

    // Hold a stronger FOV tuck while dashing (no extra shake)
    if (this.player._fovPunch == null || this.player._fovPunch > -4) {
      this.player._fovPunch = -4;
    }

    if (d.remaining <= 0.05 || d.elapsed >= DASH.duration || blocked) {
      this._sampleDashTrail();
      this._spawnDashRibbons(d);
      // Carry a bit of momentum along look dir
      this.player.velocity.x = d.dirX * 6;
      this.player.velocity.y = d.dirY * 4;
      this.player.velocity.z = d.dirZ * 6;
      this.player.onGround = false;
      this.dash = null;
    }
  };

  Skills.prototype._getThrowParams = function () {
    const eye = this.player.getEyePosition();
    _tmpOrigin.copy(eye);
    // Start slightly in front of camera so arc clears the gun
    const dir = this.player.getLookDirection();
    _tmpOrigin.addScaledVector(dir, 0.45);
    _tmpDir.copy(dir);
    // Fast throw: slight upward bias so drop sits ~half-crosshair below aim
    _tmpVel.copy(dir).multiplyScalar(VANGUARD.throwSpeed);
    _tmpVel.y += 0.9;
    return { origin: _tmpOrigin, vel: _tmpVel };
  };

  Skills.prototype._isBlocked = function (x, y, z) {
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);
    if (this.world._isSolid) return this.world._isSolid(bx, by, bz);
    return this.world.get(bx, by, bz) !== 0;
  };

  /**
   * Stick C4 just outside the hit face.
   * prev = last free pos, hit = first blocked sample.
   * Returns { x, y, z, nx, ny, nz }.
   */
  Skills.prototype._resolveStick = function (prevX, prevY, prevZ, hitX, hitY, hitZ) {
    const stick = 0.16;
    const bx = Math.floor(hitX);
    const by = Math.floor(hitY);
    const bz = Math.floor(hitZ);
    const fbx = Math.floor(prevX);
    const fby = Math.floor(prevY);
    const fbz = Math.floor(prevZ);

    let nx = 0;
    let ny = 0;
    let nz = 0;
    if (fbx !== bx) nx = fbx < bx ? -1 : 1;
    else if (fbz !== bz) nz = fbz < bz ? -1 : 1;
    else if (fby !== by) ny = fby < by ? -1 : 1;
    else {
      const ax = Math.abs(hitX - prevX);
      const ay = Math.abs(hitY - prevY);
      const az = Math.abs(hitZ - prevZ);
      if (ay >= ax && ay >= az) ny = hitY >= prevY ? -1 : 1;
      else if (ax >= az) nx = hitX >= prevX ? -1 : 1;
      else nz = hitZ >= prevZ ? -1 : 1;
    }

    let x = hitX;
    let y = hitY;
    let z = hitZ;
    if (nx !== 0) {
      x = nx < 0 ? bx - stick : bx + 1 + stick;
      y = Math.min(by + 0.85, Math.max(by + 0.15, hitY));
      z = Math.min(bz + 0.85, Math.max(bz + 0.15, hitZ));
    } else if (nz !== 0) {
      z = nz < 0 ? bz - stick : bz + 1 + stick;
      x = Math.min(bx + 0.85, Math.max(bx + 0.15, hitX));
      y = Math.min(by + 0.85, Math.max(by + 0.15, hitY));
    } else {
      y = ny < 0 ? by - stick : by + 1 + stick;
      x = Math.min(bx + 0.85, Math.max(bx + 0.15, hitX));
      z = Math.min(bz + 0.85, Math.max(bz + 0.15, hitZ));
    }

    // Nudge out if still inside
    for (let i = 0; i < 4 && this._isBlocked(x, y, z); i++) {
      x += nx * 0.12;
      y += ny * 0.12;
      z += nz * 0.12;
    }
    return { x: x, y: y, z: z, nx: nx, ny: ny, nz: nz };
  };

  /** Orient flat C4 so its broad face sits against the surface. */
  Skills.prototype._orientStuck = function (mesh, nx, ny, nz) {
    if (!mesh) return;
    mesh.rotation.set(0, 0, 0);
    if (ny > 0.5) {
      // Floor — default orientation
    } else if (ny < -0.5) {
      mesh.rotation.x = Math.PI;
    } else if (Math.abs(nx) > 0.5) {
      mesh.rotation.z = nx > 0 ? -Math.PI / 2 : Math.PI / 2;
    } else if (Math.abs(nz) > 0.5) {
      mesh.rotation.x = nz > 0 ? Math.PI / 2 : -Math.PI / 2;
    }
  };

  /**
   * Simulate parabola. Writes points into outPoints.
   * Returns stick result {x,y,z,nx,ny,nz} or null.
   */
  Skills.prototype._simulateArc = function (origin, vel, outPoints) {
    if (outPoints) outPoints.length = 0;
    const g = VANGUARD.gravity;
    const dt = VANGUARD.simDt;
    const maxT = VANGUARD.maxFlight;
    let x = origin.x;
    let y = origin.y;
    let z = origin.z;
    let vx = vel.x;
    let vy = vel.y;
    let vz = vel.z;
    let land = null;

    if (outPoints) outPoints.push(new THREE.Vector3(x, y, z));

    for (let t = 0; t < maxT; t += dt) {
      const nx = x + vx * dt;
      const ny = y + vy * dt;
      const nz = z + vz * dt;
      vy -= g * dt;

      const steps = 3;
      let hit = false;
      let stick = null;
      for (let s = 1; s <= steps; s++) {
        const u = s / steps;
        const sx = x + (nx - x) * u;
        const sy = y + (ny - y) * u;
        const sz = z + (nz - z) * u;
        if (this._isBlocked(sx, sy, sz)) {
          stick = this._resolveStick(x, y, z, sx, sy, sz);
          hit = true;
          break;
        }
      }

      if (hit && stick) {
        x = stick.x;
        y = stick.y;
        z = stick.z;
        if (outPoints) outPoints.push(new THREE.Vector3(x, y, z));
        land = stick;
        break;
      }

      x = nx;
      y = ny;
      z = nz;
      if (outPoints) outPoints.push(new THREE.Vector3(x, y, z));

      if (y < -20) {
        land = { x: x, y: 0.2, z: z, nx: 0, ny: 1, nz: 0 };
        break;
      }
    }

    if (!land && outPoints && outPoints.length) {
      const p = outPoints[outPoints.length - 1];
      land = { x: p.x, y: p.y, z: p.z, nx: 0, ny: 1, nz: 0 };
    }
    return land;
  };

  Skills.prototype._ensurePreview = function () {
    if (this._preview) return this._preview;

    const positions = new Float32Array(VANGUARD.previewSteps * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setDrawRange(0, 0);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0xe8c56a,
      transparent: true,
      opacity: 0.85,
      depthTest: true,
    });
    const line = new THREE.Line(geo, lineMat);
    line.frustumCulled = false;
    this.scene.add(line);

    const marker = new THREE.Group();
    marker.frustumCulled = false;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.55, 28),
      new THREE.MeshBasicMaterial({
        color: 0xff6622,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    marker.add(ring);
    const cross = new THREE.Mesh(
      new THREE.RingGeometry(0.08, 0.16, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffcc66,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    cross.rotation.x = -Math.PI / 2;
    cross.position.y = 0.02;
    marker.add(cross);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 1.2, 6),
      new THREE.MeshBasicMaterial({
        color: 0xff8844,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      })
    );
    beam.position.y = 0.6;
    marker.add(beam);
    marker.visible = false;
    this.scene.add(marker);

    this._preview = { line: line, geo: geo, marker: marker, points: [] };
    return this._preview;
  };

  Skills.prototype._hidePreview = function () {
    if (!this._preview) return;
    this._preview.line.visible = false;
    this._preview.marker.visible = false;
    this._preview.geo.setDrawRange(0, 0);
  };

  Skills.prototype._updatePreview = function () {
    const prev = this._ensurePreview();
    const params = this._getThrowParams();
    const points = prev.points;
    const land = this._simulateArc(params.origin, params.vel, points);

    const attr = prev.geo.attributes.position;
    const n = Math.min(points.length, VANGUARD.previewSteps);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      attr.setXYZ(i, p.x, p.y, p.z);
    }
    attr.needsUpdate = true;
    prev.geo.setDrawRange(0, n);
    prev.geo.computeBoundingSphere();
    prev.line.visible = n > 1;

    if (land) {
      prev.marker.position.set(land.x, land.y, land.z);
      prev.marker.visible = true;
      // Align marker to surface normal
      const nn = new THREE.Vector3(land.nx || 0, land.ny || 1, land.nz || 0).normalize();
      prev.marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), nn);
      const s = 1 + Math.sin(performance.now() * 0.008) * 0.08;
      prev.marker.scale.setScalar(s);
    } else {
      prev.marker.visible = false;
    }
  };

  Skills.prototype._throwC4 = function () {
    this._hidePreview();
    const params = this._getThrowParams();
    const mesh = this._makeC4Mesh();
    mesh.position.copy(params.origin);
    this.scene.add(mesh);

    this.pending = {
      phase: 'flight',
      mesh: mesh,
      x: params.origin.x,
      y: params.origin.y,
      z: params.origin.z,
      vx: params.vel.x,
      vy: params.vel.y,
      vz: params.vel.z,
      fuse: VANGUARD.fuse,
    };
    this.cooldown = VANGUARD.cooldown;

    if (global.VF.Audio) global.VF.Audio.play('c4_plant');
    if (global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast('C4 已投出');
    }
    this._syncHud();
  };

  Skills.prototype._makeC4Mesh = function () {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.22, 0.32),
      new THREE.MeshLambertMaterial({ color: 0x2a2e24 })
    );
    g.add(body);
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.44, 0.06, 0.34),
      new THREE.MeshLambertMaterial({ color: 0xc07028, emissive: 0x401800, emissiveIntensity: 0.35 })
    );
    stripe.position.y = 0.02;
    g.add(stripe);
    const led = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.06, 0.06),
      new THREE.MeshBasicMaterial({ color: 0xff2200 })
    );
    led.position.set(0.14, 0.14, 0.1);
    g.add(led);
    g.userData.led = led;
    return g;
  };

  Skills.prototype._stickPending = function (stick) {
    const p = this.pending;
    if (!p || !stick) return;
    p.x = stick.x;
    p.y = stick.y;
    p.z = stick.z;
    p.nx = stick.nx;
    p.ny = stick.ny;
    p.nz = stick.nz;
    p.phase = 'fuse';
    p.vx = p.vy = p.vz = 0;
    if (p.mesh) {
      p.mesh.position.set(p.x, p.y, p.z);
      this._orientStuck(p.mesh, stick.nx, stick.ny, stick.nz);
    }
    if (global.VF.Audio) global.VF.Audio.play('c4_plant');
  };

  Skills.prototype._updateFlight = function (dt) {
    const p = this.pending;
    if (!p || p.phase !== 'flight') return;

    const g = VANGUARD.gravity;
    let remain = Math.min(dt, 0.05);
    const step = 1 / 60;
    while (remain > 0) {
      const h = Math.min(step, remain);
      remain -= h;
      const ox = p.x;
      const oy = p.y;
      const oz = p.z;
      const nx = p.x + p.vx * h;
      const ny = p.y + p.vy * h;
      const nz = p.z + p.vz * h;
      p.vy -= g * h;

      // Sub-step along segment to catch walls
      const sub = 4;
      let stuck = null;
      for (let s = 1; s <= sub; s++) {
        const u = s / sub;
        const sx = ox + (nx - ox) * u;
        const sy = oy + (ny - oy) * u;
        const sz = oz + (nz - oz) * u;
        if (this._isBlocked(sx, sy, sz)) {
          stuck = this._resolveStick(ox, oy, oz, sx, sy, sz);
          break;
        }
      }
      if (stuck) {
        this._stickPending(stuck);
        return;
      }

      p.x = nx;
      p.y = ny;
      p.z = nz;
    }

    if (p.mesh) {
      p.mesh.position.set(p.x, p.y, p.z);
      p.mesh.rotation.x += dt * 4;
      p.mesh.rotation.z += dt * 2.5;
    }

    if (p.y < -30) {
      this._clearPending();
    }
  };

  Skills.prototype.update = function (dt) {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.dashCooldown > 0) this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    this._tickStimulant(dt);
    this._tickRevive(dt);
    this._tickRepair(dt);

    // Ghost stealth ticks even if a speed-buff decrement runs; stealth owns its timer
    const ghostStealth = this.stealthTimer > 0 || (this.player && this.player.stealthed);
    const riotActive = !!this.riotShield;
    if (this.player && this.player.skillSpeedBuffTimer > 0 && !ghostStealth && !riotActive) {
      this.player.skillSpeedBuffTimer = Math.max(0, this.player.skillSpeedBuffTimer - dt);
    }

    if (this.dash) this._updateDash(dt);
    this._updateDashRibbons(dt);
    this._updateStealth(dt);
    if (this.riotShield) this._updateRiotShield(dt);

    // Aim preview
    const skillKind = this._activeClassSkill();
    if (this.aiming && skillKind === 'vanguard' && this.cooldown <= 0 && !this.pending) {
      this._hideMedicPreview();
      this._hideTurretPreview();
      this._updatePreview();
    } else if (this.aiming && skillKind === 'medic' && this.cooldown <= 0) {
      this._hidePreview();
      this._hideTurretPreview();
      this._updateMedicPreview();
    } else if (this.aiming && skillKind === 'engineer' && this.cooldown <= 0) {
      this._hidePreview();
      this._hideMedicPreview();
      this._updateTurretPreview();
    } else if (!this.aiming) {
      this._hidePreview();
      this._hideMedicPreview();
      this._hideTurretPreview();
    }

    if (this.healDevice) this._updateHealDevice(dt);
    this._updateTurrets(dt);

    if (this.pending) {
      if (this.pending.phase === 'flight') {
        this._updateFlight(dt);
      }
      if (this.pending && this.pending.phase === 'fuse') {
        this.pending.fuse -= dt;
        if (this.pending.mesh && this.pending.mesh.userData.led) {
          this.pending.mesh.userData.led.visible = Math.sin(performance.now() * 0.02) > 0;
        }
        if (this.pending.fuse <= 0) {
          const px = this.pending.x;
          const py = this.pending.y;
          const pz = this.pending.z;
          this._clearPending();
          this._detonate(px, py, pz);
        }
      }
    }

    for (let i = this._fx.length - 1; i >= 0; i--) {
      const fx = this._fx[i];
      fx.life -= dt;
      if (fx.mesh) {
        if (fx.empScale) {
          const t = 1 - fx.life / Math.max(0.001, fx.maxLife);
          const s = 1 + t * fx.empScale;
          fx.mesh.scale.set(s, 1, s);
        } else if (fx.growUniform != null) {
          const t = 1 - fx.life / Math.max(0.001, fx.maxLife);
          const s = 1 + t * fx.growUniform;
          fx.mesh.scale.setScalar(s);
        } else {
          fx.mesh.scale.multiplyScalar(1 + dt * 5.5);
        }
        if (fx.mesh.material) {
          if (fx.baseOpacity == null) fx.baseOpacity = fx.mesh.material.opacity;
          const fade = Math.max(0, fx.life / fx.maxLife);
          fx.mesh.material.opacity = fade * fx.baseOpacity;
        }
      }
      if (fx.life <= 0) {
        if (fx.mesh) {
          this.scene.remove(fx.mesh);
          if (fx.mesh.geometry) fx.mesh.geometry.dispose();
          if (fx.mesh.material) fx.mesh.material.dispose();
        }
        this._fx.splice(i, 1);
      }
    }

    this._syncHud();
  };

  Skills.prototype._detonate = function (x, y, z) {
    if (global.VF.Audio) global.VF.Audio.play('explosion');
    this._spawnBlastFx(x, y, z);
    this._breakVoxels(x, y, z);
    this._damageHostiles(x, y, z);

    if (this.player && this.player.classId === VANGUARD.id) {
      this.player.skillSpeedBuffTimer = VANGUARD.speedBuffDur;
      this.player.skillSpeedBuffMul = VANGUARD.speedBuff;
    }

    if (this.player && this.player.addShake) this.player.addShake(0.32);
    if (global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast('C4 起爆 · 移速提升');
    }
  };

  Skills.prototype._spawnBlastFx = function (x, y, z) {
    // Hot white core
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(1.6, 14, 14),
      new THREE.MeshBasicMaterial({
        color: 0xfff0c8,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    core.position.set(x, y + 0.4, z);
    this.scene.add(core);
    this._fx.push({ mesh: core, life: 0.35, maxLife: 0.35, growUniform: 3.5, baseOpacity: 0.95 });

    // Outer fireball
    const fire = new THREE.Mesh(
      new THREE.SphereGeometry(3.4, 16, 16),
      new THREE.MeshBasicMaterial({
        color: 0xff7722,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    fire.position.set(x, y + 0.35, z);
    this.scene.add(fire);
    this._fx.push({ mesh: fire, life: 0.65, maxLife: 0.65, growUniform: 4.5, baseOpacity: 0.75 });

    // Smoke shell
    const smoke = new THREE.Mesh(
      new THREE.SphereGeometry(4.2, 12, 12),
      new THREE.MeshBasicMaterial({
        color: 0x554433,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      })
    );
    smoke.position.set(x, y + 0.5, z);
    this.scene.add(smoke);
    this._fx.push({ mesh: smoke, life: 0.9, maxLife: 0.9, growUniform: 3.2, baseOpacity: 0.35 });

    // Expanding ground shock rings
    const rings = [
      { inner: 1.5, outer: 5.5, color: 0xffaa44, life: 0.55, empScale: 3.5 },
      { inner: 3.0, outer: 8.5, color: 0xff5522, life: 0.7, empScale: 4.5 },
      { inner: 5.0, outer: 11.0, color: 0xff2200, life: 0.85, empScale: 5.5 },
    ];
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      const ringMat = new THREE.MeshBasicMaterial({
        color: r.color,
        transparent: true,
        opacity: 0.65,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(r.inner, r.outer, 40), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, y + 0.06 + i * 0.04, z);
      this.scene.add(ring);
      this._fx.push({
        mesh: ring,
        life: r.life,
        maxLife: r.life,
        empScale: r.empScale,
        baseOpacity: 0.65,
      });
    }

    // Vertical flash column
    const column = new THREE.Mesh(
      new THREE.CylinderGeometry(0.6, 1.8, 7, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffcc66,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
    );
    column.position.set(x, y + 3.2, z);
    this.scene.add(column);
    this._fx.push({ mesh: column, life: 0.4, maxLife: 0.4, growUniform: 1.8, baseOpacity: 0.55 });

    // Debris + sparks at epicenter
    const weapons = global.VF.game && global.VF.game.weapons;
    if (weapons) {
      if (weapons._spawnDebris) {
        weapons._spawnDebris(x, y + 0.4, z, 0xc47840);
        weapons._spawnDebris(x + 0.6, y + 0.8, z - 0.4, 0xffaa66);
        weapons._spawnDebris(x - 0.5, y + 0.6, z + 0.5, 0x8a8680);
      }
      if (weapons._spawnImpact) {
        weapons._spawnImpact(new THREE.Vector3(x, y + 0.4, z), 0xffee88, 0.7);
        weapons._spawnImpact(new THREE.Vector3(x, y + 0.6, z), 0xff6622, 1.1);
      }
    }
  };

  Skills.prototype._breakVoxels = function (x, y, z) {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    const cz = Math.floor(z);
    const R = VANGUARD.blastRadius;
    const r2 = R * R;
    const span = Math.ceil(R);
    const weapons = global.VF.game && global.VF.game.weapons;
    if (this.world.deformTerrainCircle) {
      const deformRadius = Math.max(1.5, R * 0.72);
      const deformDepth = Math.min(1.2, Math.max(0.45, R * 0.16));
      const changed = this.world.deformTerrainCircle(x, z, deformRadius, deformDepth, {
        maxDepth: 1.2,
        maxNeighborDelta: 0.8,
      });
      if (changed && weapons && weapons._syncTerrainDeform) {
        weapons._syncTerrainDeform(x, z, deformRadius, deformDepth);
      }
    }
    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -span; dy <= span; dy++) {
        for (let dz = -span; dz <= span; dz++) {
          const ddx = dx + 0.5;
          const ddy = dy + 0.5;
          const ddz = dz + 0.5;
          if (ddx * ddx + ddy * ddy + ddz * ddz > r2) continue;
          const bx = cx + dx;
          const by = cy + dy;
          const bz = cz + dz;
          if (this.world.breakBlock(bx, by, bz)) {
            if (weapons) {
              if (weapons._syncWorldBreak) weapons._syncWorldBreak('break-voxel', bx, by, bz);
              if (weapons._spawnDebris) weapons._spawnDebris(bx + 0.5, by + 0.5, bz + 0.5);
            }
          }
        }
      }
    }
  };

  Skills.prototype._damageAtDist = function (dist) {
    if (dist <= VANGUARD.radiusInner) return VANGUARD.dmgInner;
    if (dist <= VANGUARD.radiusMid) {
      const t = (dist - VANGUARD.radiusInner) / (VANGUARD.radiusMid - VANGUARD.radiusInner);
      return VANGUARD.dmgInner + (VANGUARD.dmgNear - VANGUARD.dmgInner) * t;
    }
    if (dist <= VANGUARD.radiusOuter) {
      const t = (dist - VANGUARD.radiusMid) / (VANGUARD.radiusOuter - VANGUARD.radiusMid);
      return VANGUARD.dmgNear + (VANGUARD.dmgFar - VANGUARD.dmgNear) * t;
    }
    return 0;
  };

  Skills.prototype._distToUnit = function (x, y, z, pos) {
    const uy = pos.y + 1.0;
    const dx = pos.x - x;
    const dy = uy - y;
    const dz = pos.z - z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };

  Skills.prototype._damageHostiles = function (x, y, z) {
    const ai = global.VF.AI || (global.VF.game && global.VF.game.ai);
    if (ai && ai.enemies) {
      for (let i = 0; i < ai.enemies.length; i++) {
        const e = ai.enemies[i];
        if (!e || !e.alive || !e.mesh) continue;
        const dist = this._distToUnit(x, y, z, e.mesh.position);
        const dmg = Math.round(this._damageAtDist(dist));
        if (dmg > 0) ai.damageEnemy(e, dmg);
      }
    }

    if (global.VF.game && global.VF.game.mode === 'pvp' && global.VF.Pvp && global.VF.Pvp.remoteAvatar) {
      const av = global.VF.Pvp.remoteAvatar;
      if (av.alive !== false && av.mesh) {
        const dist = this._distToUnit(x, y, z, av.mesh.position);
        const dmg = Math.round(this._damageAtDist(dist));
        if (dmg > 0 && global.VF.Pvp.dealDamageToRemote) {
          global.VF.Pvp.dealDamageToRemote(dmg);
        }
      }
    }
  };

  /* ---------- Medic: heal station ---------- */

  /** Place on any ground / top surface near player. Walls (vertical faces) are invalid. */
  Skills.prototype._getMedicPlacePos = function (opts) {
    opts = opts || {};
    const eye = this.player.getEyePosition();
    const dir = this.player.getLookDirection();
    const feet = this.player.object.position;
    const maxR = opts.placeRange != null ? opts.placeRange : MEDIC.placeRange;
    const maxRay = opts.placeRay != null ? opts.placeRay : MEDIC.placeRay;
    const step = 0.25;

    // Aim XZ: first solid hit along look, else point at ray end
    let aimX = eye.x + dir.x * Math.min(maxRay, maxR);
    let aimZ = eye.z + dir.z * Math.min(maxRay, maxR);
    let prevX = eye.x;
    let prevY = eye.y;
    let prevZ = eye.z;
    let floorHit = null;

    for (let t = step; t <= maxRay; t += step) {
      const x = eye.x + dir.x * t;
      const y = eye.y + dir.y * t;
      const z = eye.z + dir.z * t;
      if (this._isBlocked(x, y, z)) {
        const stick = this._resolveStick(prevX, prevY, prevZ, x, y, z);
        aimX = x;
        aimZ = z;
        // Top of a block = ground; vertical face = wall (ignore, fall through to ground find)
        if (stick && stick.ny >= 0.55) {
          floorHit = stick;
        }
        break;
      }
      prevX = x;
      prevY = y;
      prevZ = z;
      aimX = x;
      aimZ = z;
    }

    // Clamp aim to place range around player (horizontal)
    let dx = aimX - feet.x;
    let dz = aimZ - feet.z;
    let dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > maxR && dist > 1e-6) {
      const s = maxR / dist;
      aimX = feet.x + dx * s;
      aimZ = feet.z + dz * s;
      floorHit = null; // need re-find ground at clamped xz
    }

    // If we already have a floor stick in range, use it
    if (floorHit) {
      const fdx = floorHit.x - feet.x;
      const fdz = floorHit.z - feet.z;
      if (Math.sqrt(fdx * fdx + fdz * fdz) <= maxR + 0.05) {
        return {
          x: floorHit.x,
          y: floorHit.y,
          z: floorHit.z,
          nx: 0,
          ny: 1,
          nz: 0,
        };
      }
    }

    // Find highest solid top under aim XZ (any walkable ground / platform top)
    const startY = Math.max(Math.floor(eye.y) + 8, Math.floor(feet.y) + 12);
    for (let y = startY; y >= 0; y--) {
      if (this._isBlocked(aimX, y, aimZ) && !this._isBlocked(aimX, y + 1, aimZ)) {
        return {
          x: aimX,
          y: y + 1.05,
          z: aimZ,
          nx: 0,
          ny: 1,
          nz: 0,
        };
      }
    }
    return null;
  };

  Skills.prototype._ensureMedicPreview = function () {
    if (this._medicPreview) return this._medicPreview;
    const marker = new THREE.Group();
    marker.frustumCulled = false;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.62, 28),
      new THREE.MeshBasicMaterial({
        color: 0x5ad89a,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    marker.add(ring);
    const crossH = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.04, 0.12),
      new THREE.MeshBasicMaterial({ color: 0xff4455, depthWrite: false })
    );
    crossH.position.y = 0.08;
    marker.add(crossH);
    const crossV = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.04, 0.55),
      new THREE.MeshBasicMaterial({ color: 0xff4455, depthWrite: false })
    );
    crossV.position.y = 0.08;
    marker.add(crossV);
    const ghost = this._makeHealDeviceMesh(true);
    ghost.position.y = 0.35;
    marker.add(ghost);
    marker.visible = false;
    this.scene.add(marker);
    this._medicPreview = { marker: marker, ring: ring };
    return this._medicPreview;
  };

  Skills.prototype._hideMedicPreview = function () {
    if (!this._medicPreview) return;
    this._medicPreview.marker.visible = false;
  };

  Skills.prototype._updateMedicPreview = function () {
    const prev = this._ensureMedicPreview();
    const place = this._getMedicPlacePos();
    if (!place) {
      prev.marker.visible = false;
      return;
    }
    prev.marker.position.set(place.x, place.y, place.z);
    prev.marker.visible = true;
    const ok = true;
    prev.ring.material.color.setHex(ok ? 0x5ad89a : 0xff5533);
    const s = 1 + Math.sin(performance.now() * 0.008) * 0.06;
    prev.marker.scale.set(s, 1, s);
  };

  Skills.prototype._makeHealDeviceMesh = function (ghost) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.7, 0.55),
      ghost
        ? new THREE.MeshBasicMaterial({ color: 0xe8eef2, transparent: true, opacity: 0.45, depthWrite: false })
        : new THREE.MeshLambertMaterial({ color: 0xe8eef2 })
    );
    body.position.y = 0.35;
    g.add(body);
    const crossMat = ghost
      ? new THREE.MeshBasicMaterial({ color: 0xe03040, transparent: true, opacity: 0.7, depthWrite: false })
      : new THREE.MeshLambertMaterial({ color: 0xd02828, emissive: 0x400810, emissiveIntensity: 0.25 });
    const ch = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.1, 0.12), crossMat);
    ch.position.set(0, 0.55, 0.29);
    g.add(ch);
    const cv = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.38), crossMat);
    cv.position.set(0, 0.55, 0.29);
    g.add(cv);
    const light = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.08, 0.2),
      ghost
        ? new THREE.MeshBasicMaterial({ color: 0x7ddea0, transparent: true, opacity: 0.5 })
        : new THREE.MeshBasicMaterial({ color: 0x7ddea0 })
    );
    light.position.y = 0.72;
    g.add(light);
    g.userData.light = light;
    return g;
  };

  Skills.prototype._deployHealDevice = function () {
    const place = this._getMedicPlacePos();
    if (!place) {
      if (global.VF.UI && global.VF.UI.toast) {
        global.VF.UI.toast('无法放置 · 请瞄准地面');
      }
      return false;
    }
    this._clearHealDevice();
    const mesh = this._makeHealDeviceMesh(false);
    mesh.position.set(place.x, place.y, place.z);
    this.scene.add(mesh);

    const aura = new THREE.Mesh(
      new THREE.RingGeometry(MEDIC.healRadius - 0.15, MEDIC.healRadius, 48),
      new THREE.MeshBasicMaterial({
        color: 0x5ad89a,
        transparent: true,
        opacity: 0.28,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    aura.rotation.x = -Math.PI / 2;
    aura.position.set(place.x, place.y + 0.06, place.z);
    this.scene.add(aura);

    this.healDevice = {
      mesh: mesh,
      aura: aura,
      x: place.x,
      y: place.y,
      z: place.z,
      life: MEDIC.duration,
    };
    this.cooldown = MEDIC.cooldown;
    if (global.VF.Audio) global.VF.Audio.play('build');
    if (global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast('修复装置已部署 · ' + MEDIC.duration + 's');
    }
    this._syncHud();
    return true;
  };

  Skills.prototype._healTarget = function (obj, amount) {
    if (!obj) return;
    if (obj === this.player) {
      const p = this.player;
      if (p.dead) return;
      p.health = Math.min(p.maxHealth || 100, p.health + amount);
      if (global.VF.UI) global.VF.UI.updateVitals(p.health, p.armor);
      return;
    }
    if (obj.alive && obj.hp != null) {
      const max = obj.maxHp != null ? obj.maxHp : obj.hp;
      obj.hp = Math.min(max, obj.hp + amount);
    }
  };

  Skills.prototype._updateHealDevice = function (dt) {
    const d = this.healDevice;
    if (!d) return;
    d.life -= dt;
    if (d.mesh && d.mesh.userData.light) {
      d.mesh.userData.light.visible = Math.sin(performance.now() * 0.012) > -0.2;
    }
    if (d.aura) {
      d.aura.material.opacity = 0.18 + Math.sin(performance.now() * 0.006) * 0.1;
      const pulse = 1 + Math.sin(performance.now() * 0.005) * 0.03;
      d.aura.scale.set(pulse, 1, pulse);
    }

    const heal = MEDIC.healPerSec * dt;
    const r = MEDIC.healRadius;
    const r2 = r * r;
    // Player
    if (this.player && !this.player.dead) {
      const pp = this.player.object.position;
      const dx = pp.x - d.x;
      const dz = pp.z - d.z;
      const dy = pp.y + 1 - d.y;
      if (dx * dx + dz * dz + dy * dy * 0.25 <= r2) {
        this._healTarget(this.player, heal);
      }
    }
    // Allies
    const ai = global.VF.AI || (global.VF.game && global.VF.game.ai);
    if (ai && ai.allies) {
      for (let i = 0; i < ai.allies.length; i++) {
        const u = ai.allies[i];
        if (!u || !u.alive || !u.mesh) continue;
        const p = u.mesh.position;
        const dx = p.x - d.x;
        const dz = p.z - d.z;
        if (dx * dx + dz * dz <= r2) this._healTarget(u, heal);
      }
    }

    if (d.life <= 0) {
      this._clearHealDevice();
      if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast('修复装置已失效');
    }
  };

  /* ---------- Engineer: gatling turret ---------- */

  Skills.prototype._canUseEngineer = function () {
    if (!this.player || !this.player.locked || this.player.dead || this.player.downed) {
      return false;
    }
    if (global.VF.UI && global.VF.UI.isMenuOpen && global.VF.UI.isMenuOpen()) return false;
    if (this.player.classId !== ENGINEER.id) return false;
    return true;
  };

  Skills.prototype._getTurretPlacePos = function () {
    const place = this._getMedicPlacePos({
      placeRange: ENGINEER.placeRange,
      placeRay: ENGINEER.placeRay,
    });
    if (!place) return null;
    for (let dy = 0; dy < 3; dy++) {
      if (this._isBlocked(place.x, place.y + dy + 0.2, place.z)) return null;
    }
    return place;
  };

  Skills.prototype._makeTurretMesh = function (ghost) {
    const root = new THREE.Group();
    root.name = ghost ? 'TurretGhost' : 'GatlingTurret';
    const opacity = ghost ? 0.45 : 1;
    const mat = function (color) {
      return new THREE.MeshLambertMaterial({
        color: color,
        transparent: ghost,
        opacity: opacity,
        depthWrite: !ghost,
      });
    };
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.28, 1.2), mat(0x4a5560));
    base.position.y = 0.14;
    root.add(base);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 0.9), mat(0x6e7278));
    plate.position.y = 0.34;
    root.add(plate);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.7, 0.35), mat(0x5a4030));
    post.position.y = 0.75;
    root.add(post);
    const head = new THREE.Group();
    head.position.y = 1.15;
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.4, 0.7), mat(0x3a4550));
    head.add(housing);
    const barrels = new THREE.Group();
    barrels.position.set(0, 0, 0.45);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.85), mat(0x2a2c30));
      b.position.set(Math.cos(a) * 0.14, Math.sin(a) * 0.14, 0.2);
      barrels.add(b);
    }
    head.add(barrels);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0, 0.95);
    head.add(muzzle);
    root.add(head);
    root.userData.head = head;
    root.userData.barrels = barrels;
    root.userData.muzzle = muzzle;
    return root;
  };

  Skills.prototype._ensureTurretPreview = function () {
    if (this._turretPreview) return this._turretPreview;
    const marker = new THREE.Group();
    marker.frustumCulled = false;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.78, 24),
      new THREE.MeshBasicMaterial({
        color: 0xf0a040,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    marker.add(ring);
    const ghost = this._makeTurretMesh(true);
    marker.add(ghost);
    marker.visible = false;
    this.scene.add(marker);
    this._turretPreview = { marker: marker, ring: ring };
    return this._turretPreview;
  };

  Skills.prototype._hideTurretPreview = function () {
    if (!this._turretPreview) return;
    this._turretPreview.marker.visible = false;
  };

  Skills.prototype._updateTurretPreview = function () {
    const prev = this._ensureTurretPreview();
    const place = this._getTurretPlacePos();
    if (!place) {
      prev.marker.visible = false;
      return;
    }
    prev.marker.visible = true;
    prev.marker.position.set(place.x, place.y, place.z);
    prev.ring.material.color.setHex(0xf0a040);
  };

  Skills.prototype._hasLiveTurret = function () {
    if (!this.turrets) return false;
    for (let i = 0; i < this.turrets.length; i++) {
      if (this.turrets[i] && this.turrets[i].alive) return true;
    }
    return false;
  };

  Skills.prototype._recallTurret = function () {
    if (!this._canUseEngineer()) return false;
    if (!this._hasLiveTurret()) return false;
    this._clearAllTurrets();
    const refund = ENGINEER.recallRefund != null ? ENGINEER.recallRefund : ENGINEER.blockCost;
    this.player.blocks = (this.player.blocks || 0) + refund;
    // Short remaining CD after pack-up so it isn't free spam
    this.cooldown = Math.min(this.cooldown > 0 ? this.cooldown : 8, 8);
    if (global.VF.UI) {
      global.VF.UI.updateResources(this.player.cores, this.player.blocks);
      if (global.VF.UI.toast) {
        global.VF.UI.toast('炮塔已收回 · 返还 ' + refund + ' 物料');
      }
    }
    if (global.VF.Audio) global.VF.Audio.play('build');
    this._syncHud();
    return true;
  };

  Skills.prototype._deployTurret = function () {
    if (!this._canUseEngineer()) return false;
    if (this.cooldown > 0) return false;
    if ((this.player.blocks || 0) < ENGINEER.blockCost) {
      if (global.VF.UI && global.VF.UI.toast) {
        global.VF.UI.toast('需要 ' + ENGINEER.blockCost + ' 体素物料');
      }
      return false;
    }
    const place = this._getTurretPlacePos();
    if (!place) {
      if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast('无法在此部署炮塔');
      return false;
    }

    this.player.blocks -= ENGINEER.blockCost;
    if (global.VF.UI) global.VF.UI.updateResources(this.player.cores, this.player.blocks);

    // Replace existing turrets (one active defense emplacement)
    this._clearAllTurrets();

    const mesh = this._makeTurretMesh(false);
    mesh.position.set(place.x, place.y, place.z);
    this.scene.add(mesh);

    const team = this.player.team || this.world._playerTeam || 'ally';
    const turret = {
      mesh: mesh,
      head: mesh.userData.head,
      barrels: mesh.userData.barrels,
      muzzle: mesh.userData.muzzle,
      hp: ENGINEER.turretHp,
      maxHp: ENGINEER.turretHp,
      ammo: ENGINEER.ammo,
      fireCd: 0.35,
      alive: true,
      isTurret: true,
      team: team,
      yaw: this.player.yaw || 0,
    };
    this.turrets.push(turret);
    this.cooldown = ENGINEER.cooldown;

    if (global.VF.Audio) global.VF.Audio.play('build');
    if (global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast(
        '加特林炮塔已部署 · HP' + ENGINEER.turretHp + ' · 弹药' + ENGINEER.ammo + ' · 再按 X 收回'
      );
    }
    this._syncHud();
    return true;
  };

  /** Place a gatling turret at a world point (tower module — no block cost). */
  Skills.prototype.spawnModuleTurret = function (x, y, z, team) {
    if (!this.scene) return null;
    if (!this.turrets) this.turrets = [];
    const mesh = this._makeTurretMesh(false);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    const turret = {
      mesh: mesh,
      head: mesh.userData.head,
      barrels: mesh.userData.barrels,
      muzzle: mesh.userData.muzzle,
      hp: ENGINEER.turretHp,
      maxHp: ENGINEER.turretHp,
      ammo: ENGINEER.ammo,
      fireCd: 0.35,
      alive: true,
      isTurret: true,
      fromTowerMod: true,
      team: team || (this.player && this.player.team) || 'ally',
      yaw: (this.player && this.player.yaw) || 0,
    };
    this.turrets.push(turret);
    return turret;
  };

  Skills.prototype._clearAllTurrets = function () {
    if (!this.turrets) return;
    for (let i = 0; i < this.turrets.length; i++) {
      this._destroyTurret(this.turrets[i], true);
    }
    this.turrets.length = 0;
  };

  Skills.prototype._destroyTurret = function (t, silent) {
    if (!t) return;
    t.alive = false;
    if (t.mesh) {
      this.scene.remove(t.mesh);
      t.mesh.traverse(function (c) {
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
          if (Array.isArray(c.material)) c.material.forEach(function (m) { m.dispose && m.dispose(); });
          else if (c.material.dispose) c.material.dispose();
        }
      });
      t.mesh = null;
    }
    if (!silent && global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast('炮塔已拆除');
    }
  };

  Skills.prototype.damageTurret = function (turret, dmg) {
    if (!turret || !turret.alive || dmg <= 0) return;
    turret.hp -= dmg;
    if (turret.mesh) {
      turret.mesh.traverse(function (c) {
        if (!c.isMesh || !c.material || !c.material.emissive) return;
        if (!c.material.userData._owned) {
          c.material = c.material.clone();
          c.material.userData._owned = true;
        }
        const mat = c.material;
        if (mat.userData._hitFlash) return;
        mat.userData._hitFlash = true;
        const prev = mat.emissive.getHex();
        mat.emissive.setHex(0xff4400);
        mat.emissiveIntensity = 0.6;
        setTimeout(function () {
          mat.emissive.setHex(prev);
          mat.emissiveIntensity = 0;
          mat.userData._hitFlash = false;
        }, 70);
      });
    }
    if (turret.hp <= 0) {
      this._destroyTurret(turret, false);
      this.turrets = this.turrets.filter(function (x) {
        return x && x.alive;
      });
      if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast('炮塔已被摧毁');
      this._syncHud();
    }
  };

  /** For AI: nearest living player turret (optionally filter by team). */
  Skills.prototype.getNearestTurret = function (fromPos, preferTeam) {
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < this.turrets.length; i++) {
      const t = this.turrets[i];
      if (!t || !t.alive || !t.mesh) continue;
      if (preferTeam && t.team !== preferTeam) continue;
      const d = fromPos.distanceTo(t.mesh.position);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best ? { turret: best, dist: bestD } : null;
  };

  Skills.prototype._turretHasLos = function (from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 0.5) return true;
    const steps = Math.min(48, Math.ceil(dist / 0.45));
    for (let i = 1; i < steps; i++) {
      const u = i / steps;
      const x = from.x + dx * u;
      const y = from.y + dy * u;
      const z = from.z + dz * u;
      if (this._isBlocked(x, y, z)) return false;
    }
    return true;
  };

  Skills.prototype._turretPickTarget = function (turret) {
    const origin = turret.mesh.position.clone().add(new THREE.Vector3(0, 1.2, 0));
    let best = null;
    let bestD = ENGINEER.range;

    const ai = global.VF.game && global.VF.game.ai;
    if (ai && ai.enemies) {
      for (let i = 0; i < ai.enemies.length; i++) {
        const e = ai.enemies[i];
        if (!e || !e.alive || !e.mesh) continue;
        if (e.team === turret.team) continue;
        const to = e.mesh.position.clone().add(new THREE.Vector3(0, 1.2, 0));
        const d = origin.distanceTo(to);
        if (d >= bestD) continue;
        if (!this._turretHasLos(origin, to)) continue;
        bestD = d;
        best = { kind: 'ai', unit: e, pos: to };
      }
    }

    if (global.VF.game && global.VF.game.mode === 'pvp' && global.VF.Pvp && global.VF.Pvp.remoteAvatar) {
      const av = global.VF.Pvp.remoteAvatar;
      if (av.alive !== false && av.mesh) {
        const remoteTeam = global.VF.Pvp.remoteTeam || (turret.team === 'ally' ? 'enemy' : 'ally');
        if (remoteTeam !== turret.team) {
          const to = av.mesh.position.clone().add(new THREE.Vector3(0, 1.3, 0));
          const d = origin.distanceTo(to);
          if (d < bestD && this._turretHasLos(origin, to)) {
            best = { kind: 'pvp', pos: to };
          }
        }
      }
    }
    return best;
  };

  Skills.prototype._turretFire = function (turret, target) {
    const muzzle = turret.muzzle;
    let from = turret.mesh.position.clone().add(new THREE.Vector3(0, 1.2, 0));
    if (muzzle && muzzle.getWorldPosition) {
      from = new THREE.Vector3();
      muzzle.getWorldPosition(from);
    }
    const to = target.pos;

    if (global.VF.spawnTracer) {
      global.VF.spawnTracer(from, to, { color: 0xffcc66, id: 'ar', pellets: 1 });
    }
    if (global.VF.spawnMuzzleFlash && muzzle) {
      global.VF.spawnMuzzleFlash(muzzle, {
        size: 0.12,
        intensity: 0,
        life: 0.04,
        color: 0xffaa44,
      });
    }
    if (global.VF.Audio) global.VF.Audio.play('shoot_ar');

    const dmg = ENGINEER.turretDmg;
    if (target.kind === 'ai' && target.unit) {
      const ai = global.VF.game && global.VF.game.ai;
      if (ai && ai.damageEnemy) ai.damageEnemy(target.unit, dmg);
    } else if (target.kind === 'pvp' && global.VF.Pvp && global.VF.Pvp.dealDamageToRemote) {
      global.VF.Pvp.dealDamageToRemote(dmg);
    }

    turret.ammo -= 1;
    if (turret.barrels) turret.barrels.rotation.z += 0.9;
  };

  Skills.prototype._updateTurrets = function (dt) {
    if (!this.turrets || !this.turrets.length) return;
    let changed = false;
    for (let i = this.turrets.length - 1; i >= 0; i--) {
      const t = this.turrets[i];
      if (!t || !t.alive) {
        this.turrets.splice(i, 1);
        changed = true;
        continue;
      }
      t.fireCd -= dt;
      const target = this._turretPickTarget(t);
      if (target && t.head) {
        const origin = t.mesh.position;
        const dx = target.pos.x - origin.x;
        const dz = target.pos.z - origin.z;
        const want = Math.atan2(dx, dz);
        let dy = want - t.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        t.yaw += Math.max(-4 * dt, Math.min(4 * dt, dy));
        t.head.rotation.y = t.yaw;
      }
      if (target && t.fireCd <= 0 && t.ammo > 0) {
        t.fireCd = ENGINEER.fireInterval;
        this._turretFire(t, target);
        changed = true;
      }
      if (t.ammo <= 0) {
        this._destroyTurret(t, false);
        this.turrets.splice(i, 1);
        if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast('炮塔弹药耗尽');
        changed = true;
      }
    }
    if (changed) this._syncHud();
  };

  Skills.prototype._syncHud = function () {
    if (global.VF.UI && global.VF.UI.updateDash) {
      global.VF.UI.updateDash({
        ready: this.dashCooldown <= 0 && !this.dash,
        cooldown: this.dashCooldown,
        maxCooldown: DASH.cooldown,
        dashing: !!this.dash,
      });
    }

    if (!global.VF.UI || !global.VF.UI.updateSkill) return;
    const id = this.player && this.player.classId;
    if (id === VANGUARD.id) {
      global.VF.UI.updateSkill({
        classId: 'assault',
        name: '战斗兴奋剂',
        key: 'X',
        ready: this.cooldown <= 0 && !this.stim,
        cooldown: this.cooldown,
        maxCooldown: VANGUARD.cooldown,
        pending: !!this.stim,
        aiming: false,
        flying: false,
        fuse: this.stim ? this.stim.remain : 0,
        speedBuff: false,
        buffTime: 0,
        charges: this.cooldown <= 0 && !this.stim ? 1 : 0,
      });
      return;
    }
    if (id === MEDIC.id) {
      global.VF.UI.updateSkill({
        classId: 'support',
        name: '急救装置',
        key: 'X',
        ready: true,
        cooldown: 0,
        maxCooldown: 0,
        pending: !!this.reviveTarget,
        aiming: !!this.reviveTarget,
        flying: false,
        fuse: this.reviveProgress,
        speedBuff: false,
        buffTime: 0,
        passiveShield: true,
        shieldAmount: Math.round(this.player.armor || 0),
      });
      return;
    }
    if (id === GHOST.id) {
      global.VF.UI.updateSkill({
        classId: 'recon',
        name: '强化标记',
        key: 'Q',
        ready: true,
        cooldown: 0,
        maxCooldown: 0,
        pending: false,
        aiming: false,
        flying: false,
        fuse: 0,
        speedBuff: false,
        buffTime: 0,
      });
      return;
    }
    if (id === JUGGERNAUT.id) {
      const shield = this.riotShield;
      global.VF.UI.updateSkill({
        classId: 'juggernaut',
        name: '防暴盾',
        key: 'G',
        ready: this.cooldown <= 0 && !shield,
        cooldown: this.cooldown,
        maxCooldown: JUGGERNAUT.cooldown,
        pending: !!shield,
        aiming: false,
        flying: false,
        fuse: shield ? shield.life : 0,
        speedBuff: !!shield,
        buffTime: shield ? shield.life : 0,
        riotHp: shield ? Math.round(shield.hp) : 0,
        bulletResist: true,
      });
      return;
    }
    if (id === RAIDER.id) {
      global.VF.UI.updateSkill({
        classId: 'raider',
        name: '电磁脉冲',
        key: 'G',
        ready: this.cooldown <= 0,
        cooldown: this.cooldown,
        maxCooldown: RAIDER.cooldown,
        pending: false,
        aiming: false,
        flying: false,
        fuse: 0,
        speedBuff: false,
        buffTime: 0,
        lootBonus: true,
      });
      return;
    }
    if (id === ENGINEER.id) {
      global.VF.UI.updateSkill({
        classId: 'engineer',
        name: '修复装置',
        key: 'X',
        ready: true,
        cooldown: 0,
        maxCooldown: 0,
        pending: !!this.repairTarget,
        aiming: !!this.repairTarget,
        flying: false,
        fuse: 0,
        speedBuff: false,
        buffTime: 0,
        buildDurability: true,
      });
      return;
    }

    global.VF.UI.updateSkill(null);
    this.aiming = false;
    this._hidePreview();
    this._hideMedicPreview();
    this._hideTurretPreview();
  };

  Skills.VANGUARD = VANGUARD;
  Skills.MEDIC = MEDIC;
  Skills.GHOST = GHOST;
  Skills.JUGGERNAUT = JUGGERNAUT;
  Skills.RAIDER = RAIDER;
  Skills.ENGINEER = ENGINEER;
  Skills.DASH = DASH;

  global.VF = global.VF || {};
  global.VF.Skills = Skills;
})(typeof window !== 'undefined' ? window : this);
