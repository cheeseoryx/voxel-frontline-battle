/**
 * weapons.js — Weapon definitions, shooting, recoil, muzzle flash, impacts
 * Hotbar slots 1–3: AKM, Remington 870, SVD (ids ar/sg/sr kept for save compat)
 *
 * Infantry guns use the same 16 base-stat kinds as the loadout inspect panel:
 * damage, playerArmorDamage, lightArmorDamage, verticalRecoil, horizontalRecoil,
 * firstShotRecoil, muzzleVelocity, accuracy, fireRate (RPM), soundRange,
 * muzzleFlash, control, adsTime, runSpeed, reloadTime, switchSpeed
 * plus a damage-over-distance graph (falloffStart / falloffEnd / minDamage).
 */
(function (global) {
  'use strict';

  const AMMO_RESERVE_MAX = 320;
  const AMMO_DROP_AMOUNT = 45;
  const TRACER_MAX = 48;
  const TRACER_LIFE = 0.14;
  const TRACER_FADE = 0.05;
  const RECOIL_KICK_SCALE = 0.048;
  const ACCURACY_SPREAD_MAX = 0.12;
  const FIRST_SHOT_RESET = 0.38;
  const SWITCH_BASE_SEC = 0.15;
  const LEGACY_FIRE_RATE_SEC_MAX = 5;

  /** Enemy type → ammo pool */
  const ENEMY_AMMO_TYPE = {
    infantry: 'ar',
    heavy: 'sg',
    ranged: 'sr',
  };

  const WEAPON_BASE_STATS = [
    { key: 'damage', label: '伤害', decimals: 2 },
    { key: 'playerArmorDamage', label: 'Player Armor Damage', decimals: 2 },
    { key: 'lightArmorDamage', label: '对轻型装甲载具造成的伤害', decimals: 2 },
    { key: 'verticalRecoil', label: '垂直后坐力', decimals: 2 },
    { key: 'horizontalRecoil', label: '横向后坐力', decimals: 2 },
    { key: 'firstShotRecoil', label: '首发后坐力', decimals: 2 },
    { key: 'muzzleVelocity', label: '枪口初速', decimals: 2 },
    { key: 'accuracy', label: '准确度', decimals: 2 },
    { key: 'fireRate', label: '射速', decimals: 0 },
    { key: 'soundRange', label: '枪声传播距离', decimals: 0 },
    { key: 'muzzleFlash', label: '枪口火焰', decimals: 2 },
    { key: 'control', label: '控制', decimals: 2 },
    { key: 'adsTime', label: '瞄准耗时', decimals: 2 },
    { key: 'runSpeed', label: '奔跑速度', decimals: 2 },
    { key: 'reloadTime', label: '换弹时间', decimals: 2 },
    { key: 'switchSpeed', label: '切换速度', decimals: 2 },
  ];

  const WEAPON_STAT_KEYS = WEAPON_BASE_STATS.map(function (row) {
    return row.key;
  });

  function fireInterval(def) {
    const rpm = def && def.fireRate;
    if (!(rpm > 0)) return 0.1;
    if (rpm <= LEGACY_FIRE_RATE_SEC_MAX) return rpm;
    return 60 / rpm;
  }

  function spreadFromAccuracy(accuracy) {
    const a = Math.max(0, Math.min(100, accuracy != null ? accuracy : 70));
    return ACCURACY_SPREAD_MAX * (1 - a / 100);
  }

  function adsSpreadMul(def) {
    const scope = def && def.scope;
    if (scope === 'sniper') return 0.03;
    if (scope === 'optic') return 0.31;
    return 0.6;
  }

  function recoilKicks(def, adsBlend, firstShot) {
    const adsMul = def.adsRecoilMul != null ? def.adsRecoilMul : 0.4;
    const ads = 1 - (adsBlend || 0) * (1 - adsMul);
    const first = firstShot ? (def.firstShotRecoil != null ? def.firstShotRecoil : 1) : 1;
    const scale = RECOIL_KICK_SCALE * ads * first;
    return {
      vertical: (def.verticalRecoil != null ? def.verticalRecoil : 1.3) * scale,
      horizontal: (def.horizontalRecoil != null ? def.horizontalRecoil : 0.7) * scale,
    };
  }

  function applyStatOverrides(base, ov) {
    const out = Object.assign({}, base);
    if (!ov) return out;
    for (let i = 0; i < WEAPON_STAT_KEYS.length; i++) {
      const k = WEAPON_STAT_KEYS[i];
      if (ov[k] != null) out[k] = ov[k];
    }
    [
      'falloffStart',
      'falloffEnd',
      'minDamage',
      'adsRecoilMul',
      'adsSpread',
      'spread',
      'recoil',
    ].forEach(function (k) {
      if (ov[k] != null) out[k] = ov[k];
    });
    if (ov.verticalRecoil == null && ov.recoil != null) {
      out.verticalRecoil = ov.recoil / RECOIL_KICK_SCALE;
    }
    if (ov.accuracy == null && ov.spread != null) {
      out.accuracy = (1 - ov.spread / ACCURACY_SPREAD_MAX) * 100;
    }
    if (ov.fireRate != null && ov.fireRate > 0 && ov.fireRate <= LEGACY_FIRE_RATE_SEC_MAX) {
      out.fireRate = 60 / ov.fireRate;
    }
    return out;
  }

  function formatWeaponBaseStats(def) {
    if (!def) return [];
    return WEAPON_BASE_STATS.map(function (row) {
      const raw = def[row.key];
      const n = raw == null ? 0 : Number(raw);
      return {
        key: row.key,
        label: row.label,
        value: n,
        text: n.toFixed(row.decimals),
      };
    });
  }

  const WEAPONS = {
    ar: {
      id: 'ar',
      model: 'AKM',
      name: 'AKM',
      nameZh: 'AKM',
      caliber: '7.62×39mm',
      slot: 1,
      damage: 22,
      playerArmorDamage: 0,
      lightArmorDamage: 4,
      verticalRecoil: 1.29,
      horizontalRecoil: 0.7,
      firstShotRecoil: 1,
      muzzleVelocity: 715,
      accuracy: 73.33,
      fireRate: 600,
      soundRange: 600,
      muzzleFlash: 0.4,
      control: 0.87,
      adsTime: 0.25,
      runSpeed: 1,
      reloadTime: 1.65,
      switchSpeed: 1,
      damageType: 'bullet',
      magSize: 30,
      reserve: 150,
      range: 95,
      adsRecoilMul: 0.4,
      pellets: 1,
      breakChance: 0.55,
      automatic: true,
      ammoColor: 0xffaa44,
      ammoLabel: 'AKM',
      falloffStart: 35,
      falloffEnd: 90,
      minDamage: 12.1,
      coreFalloffStart: 18,
      coreFalloffEnd: 48,
      coreMinDamageScale: 0.12,
      coreMaxRange: 60,
      adsFov: 40,
      scope: 'optic',
      adsSens: 0.7,
      category: 'assault',
      modelStyle: 'ak',
    },
    sg: {
      id: 'sg',
      model: 'Remington 870',
      name: 'Remington 870',
      nameZh: 'Remington 870',
      caliber: '12ga 00 Buck',
      slot: 2,
      damage: 14,
      playerArmorDamage: 0,
      lightArmorDamage: 2,
      verticalRecoil: 3.54,
      horizontalRecoil: 1.9,
      firstShotRecoil: 1,
      muzzleVelocity: 400,
      accuracy: 16.67,
      fireRate: 75,
      soundRange: 500,
      muzzleFlash: 0.7,
      control: 0.55,
      adsTime: 0.32,
      runSpeed: 0.97,
      reloadTime: 2.15,
      switchSpeed: 0.9,
      damageType: 'bullet',
      magSize: 7,
      reserve: 35,
      range: 36,
      adsRecoilMul: 0.5,
      pellets: 8,
      breakChance: 0.7,
      automatic: false,
      ammoColor: 0xff6644,
      ammoLabel: '870',
      falloffStart: 10,
      falloffEnd: 32,
      minDamage: 4.9,
      coreFalloffStart: 6,
      coreFalloffEnd: 20,
      coreMinDamageScale: 0.08,
      coreMaxRange: 28,
      adsFov: 52,
      scope: 'holo',
      adsSens: 0.85,
      category: 'shotgun',
      modelStyle: 'shotgun',
    },
    sr: {
      id: 'sr',
      model: 'SVD',
      name: 'SVD',
      nameZh: 'SVD',
      caliber: '7.62×54R',
      slot: 3,
      damage: 88,
      playerArmorDamage: 8,
      lightArmorDamage: 10,
      verticalRecoil: 3.13,
      horizontalRecoil: 1.2,
      firstShotRecoil: 1.2,
      muzzleVelocity: 830,
      accuracy: 70.83,
      fireRate: 63,
      soundRange: 750,
      muzzleFlash: 0.55,
      control: 0.65,
      adsTime: 0.28,
      runSpeed: 0.95,
      reloadTime: 2.45,
      switchSpeed: 0.85,
      damageType: 'bullet',
      magSize: 10,
      reserve: 40,
      range: 160,
      adsRecoilMul: 0.32,
      pellets: 1,
      breakChance: 0.9,
      automatic: false,
      ammoColor: 0x66aaff,
      ammoLabel: 'SVD',
      falloffStart: 55,
      falloffEnd: 150,
      minDamage: 57.2,
      coreFalloffStart: 20,
      coreFalloffEnd: 50,
      coreMinDamageScale: 0.1,
      coreMaxRange: 65,
      adsFov: 18,
      scope: 'sniper',
      adsSens: 0.45,
    },
    rpg: {
      id: 'rpg',
      model: 'RPG-7',
      name: 'RPG-7',
      nameZh: 'RPG-7',
      caliber: '85mm HEAT',
      slot: 6,
      damage: 150,
      playerArmorDamage: 0,
      lightArmorDamage: 150,
      verticalRecoil: 4.58,
      horizontalRecoil: 2.2,
      firstShotRecoil: 1,
      muzzleVelocity: 120,
      accuracy: 95,
      fireRate: 19,
      soundRange: 900,
      muzzleFlash: 1.2,
      control: 0.45,
      adsTime: 0.3,
      runSpeed: 0.9,
      reloadTime: 3.2,
      switchSpeed: 0.7,
      damageType: 'antiArmor',
      projectile: true,
      projectileSpeed: 38,
      magSize: 1,
      reserve: 2,
      range: 240,
      adsRecoilMul: 0.7,
      pellets: 1,
      automatic: false,
      ammoColor: 0xff8844,
      ammoLabel: 'RPG',
      falloffStart: 240,
      falloffEnd: 240,
      minDamage: 150,
      adsFov: 46,
      scope: 'holo',
      adsSens: 0.72,
      modelStyle: 'rpg',
      category: 'launcher',
    },
  };

  if (global.VF.WEAPON_CATALOG) {
    const catalog = global.VF.WEAPON_CATALOG;
    Object.keys(catalog).forEach(function (id) {
      if (id === 'svd') return;
      WEAPONS[id] = catalog[id];
    });
  }

  function Weapons(player, world, scene) {
    this.player = player;
    this.world = world;
    this.scene = scene;
    this.raycaster = new THREE.Raycaster();
    this.current = 'ar';
    this.state = {};
    const selfState = this;
    Object.keys(WEAPONS).forEach(function (id) {
      const d = WEAPONS[id];
      selfState.state[id] = { mag: d.magSize, reserve: d.reserve };
    });
    this.cooldown = 0;
    this._burstCount = 0;
    this._lastShotAt = 0;
    this.firing = false;
    this.reloading = false;
    this.reloadTimer = 0;
    this.reloadDuration = 0;
    this.impacts = [];
    this.tracers = [];
    this.ammoDrops = [];
    this.mode = 'weapon'; // 'weapon' | 'build' (build handled by Building)

    this._tmp = new THREE.Vector3();
    this._tmpEnd = new THREE.Vector3();
    this._tmpMid = new THREE.Vector3();
    this._tmpMuzzle = new THREE.Vector3();
    this._tmpTracerDir = new THREE.Vector3();
    this._tmpUp = new THREE.Vector3(0, 1, 0);
    this._tracerGeo = null;
    this._bind();
    if (this.player && this.player.applyWeaponModel) {
      this.player.applyWeaponModel(this.current);
    }
  }

  /** Add reserve ammo for a weapon; capped at AMMO_RESERVE_MAX. Returns amount actually added. */
  Weapons.prototype.addReserve = function (weaponId, amount) {
    if (!this.state[weaponId] || amount <= 0) return 0;
    const ammo = this.state[weaponId];
    const before = ammo.reserve;
    ammo.reserve = Math.min(AMMO_RESERVE_MAX, ammo.reserve + amount);
    const gained = ammo.reserve - before;
    if (gained > 0 && global.VF.UI && this.current === weaponId) {
      global.VF.UI.updateAmmo(ammo.mag, ammo.reserve);
    }
    return gained;
  };

  /** Drop ammo pickup at world position (from killed enemy) */
  Weapons.prototype.spawnAmmoDrop = function (position, weaponId, amount) {
    weaponId = weaponId || 'ar';
    amount = amount != null ? amount : AMMO_DROP_AMOUNT;
    const def = WEAPONS[weaponId] || WEAPONS.ar;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.35, 0.35, 0.5),
      new THREE.MeshLambertMaterial({
        color: def.ammoColor,
        emissive: def.ammoColor,
        emissiveIntensity: 0.35,
      })
    );
    mesh.position.copy(position);
    mesh.position.y += 0.4;
    this.scene.add(mesh);
    this.ammoDrops.push({
      mesh,
      weaponId,
      amount,
      spin: Math.random() * Math.PI * 2,
      life: 45, // seconds before despawn
    });
  };

  Weapons.prototype._bind = function () {
    const self = this;
    document.addEventListener('mousedown', (e) => {
      if (!self.player.locked || e.button !== 0) return;
      if (global.VF.game && global.VF.game.levelEditing) return;
      if (
        self.player.vehicleId &&
        global.VF.Vehicles &&
        !global.VF.Vehicles.canUsePersonalWeapon(self.player)
      ) {
        return;
      }
      if (self.mode !== 'weapon') return;
      self.firing = true;
      self.tryFire();
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) self.firing = false;
    });
    document.addEventListener('keydown', (e) => {
      if (!self.player.locked) return;
      if (global.VF.game && global.VF.game.levelEditing) return;
      if (
        self.player.vehicleId &&
        global.VF.Vehicles &&
        !global.VF.Vehicles.canUsePersonalWeapon(self.player)
      ) {
        return;
      }
      if (e.code === 'Digit1') {
        const primary =
          (global.VF.game && global.VF.game.preferredWeaponId) || 'ar';
        self.equip(WEAPONS[primary] ? primary : 'ar');
      }
      if (e.code === 'Digit2') {
        const secondary =
          (global.VF.game && global.VF.game.preferredSecondaryId) ||
          (global.VF.game && global.VF.game.loadout && global.VF.game.loadout.secondary) ||
          'm9';
        self.equip(WEAPONS[secondary] ? secondary : 'sg');
      }
      if (e.code === 'Digit3') self.equip('sr');
      if (e.code === 'Digit6') self.equip('rpg');
      if (e.code === 'KeyR') self.reload();
    });
  };

  Weapons.prototype.equip = function (id) {
    if (!WEAPONS[id]) return;
    if (id === 'rpg' && (!this.player || this.player.classId !== 'engineer')) {
      if (global.VF.UI && global.VF.UI.toast) {
        global.VF.UI.toast('RPG-7 仅工程兵可用');
      }
      return;
    }
    const rangeOpen = global.VF.Range && global.VF.Range.isOpen;
    if (
      id !== 'rpg' &&
      !rangeOpen &&
      global.VF.Economy &&
      global.VF.Economy.ownsWeapon &&
      !global.VF.Economy.ownsWeapon(id)
    ) {
      if (global.VF.UI && global.VF.UI.toast) {
        global.VF.UI.toast('未解锁 · 前往大厅商城购买');
      }
      return;
    }
    if (this.reloading) this._cancelReload();
    this.current = id;
    this.mode = 'weapon';
    this._burstCount = 0;
    this._lastShotAt = 0;
    const switchSpeed = WEAPONS[id].switchSpeed != null ? WEAPONS[id].switchSpeed : 1;
    const skillMul = global.VF.Skills ? global.VF.Skills.getWeaponSpeedMul(this.player) : 1;
    this.cooldown = SWITCH_BASE_SEC / Math.max(0.2, switchSpeed) / skillMul;
    if (global.VF.Audio) global.VF.Audio.play('ui');
    if (global.VF.game && global.VF.game.building) {
      global.VF.game.building.exitMode();
    }
    if (this.player && this.player.setHeldMode) this.player.setHeldMode('weapon');
    if (this.player && this.player.applyWeaponModel) this.player.applyWeaponModel(id);
    if (global.VF.UI) {
      global.VF.UI.setHotbarSlot(WEAPONS[id].slot);
      if (global.VF.UI.setEquippedWeapon) global.VF.UI.setEquippedWeapon(id);
      const ammo = this.state[id];
      if (ammo && global.VF.UI.updateAmmo) {
        global.VF.UI.updateAmmo(ammo.mag, ammo.reserve);
      }
    }
    this._restyleGun(id);
  };

  /** Ensure current gun is owned; fall back to AR. */
  Weapons.prototype.syncOwnedLoadout = function () {
    const owns =
      global.VF.Economy && global.VF.Economy.ownsWeapon
        ? function (id) {
            if (id === 'rpg') {
              return !!(
                global.VF.game &&
                global.VF.game.player &&
                global.VF.game.player.classId === 'engineer'
              );
            }
            return global.VF.Economy.ownsWeapon(id);
          }
        : function () {
            return true;
          };
    if (!owns(this.current)) {
      this.current = 'ar';
      this._restyleGun('ar');
      if (this.player && this.player.applyWeaponModel) this.player.applyWeaponModel('ar');
      if (global.VF.UI) global.VF.UI.setHotbarSlot(WEAPONS.ar.slot);
    }
    if (global.VF.UI && global.VF.UI.syncWeaponLocks) global.VF.UI.syncWeaponLocks();
  };

  Weapons.prototype._restyleGun = function (id) {
    const gun = this.player && this.player.gunNode;
    if (!gun) return;
    if (id === 'rpg') gun.scale.set(1.05, 1.05, 1.05);
    else gun.scale.set(1, 1, 1);
  };

  Weapons.prototype.getDef = function () {
    const base = WEAPONS[this.current] || WEAPONS.ar;
    const ov =
      global.VF &&
      global.VF.Feel &&
      global.VF.Feel.weapons &&
      global.VF.Feel.weapons[this.current];
    return applyStatOverrides(base, ov);
  };

  Weapons.prototype._ensureAmmo = function (weaponId) {
    if (this.state[weaponId]) return this.state[weaponId];
    const def = WEAPONS[weaponId];
    if (!def) return null;
    this.state[weaponId] = { mag: def.magSize, reserve: def.reserve };
    return this.state[weaponId];
  };

  Weapons.prototype.getAmmo = function () {
    return this._ensureAmmo(this.current);
  };

  Weapons.prototype.tryFire = function () {
    if (this.player && this.player.dead) return;
    if (
      this.player &&
      this.player.vehicleId &&
      global.VF.Vehicles &&
      !global.VF.Vehicles.canUsePersonalWeapon(this.player)
    ) {
      return;
    }
    if (this.mode !== 'weapon') return;
    if (this.reloading) return;
    if (this.cooldown > 0) return;
    const def = this.getDef();
    const ammo = this.getAmmo();
    if (ammo.mag <= 0) {
      if (ammo.reserve <= 0 && global.VF.Audio) global.VF.Audio.play('empty');
      this.reload();
      return;
    }

    // Firing breaks Ghost stealth; that shot still deals damage (+ ambush bonus)
    if (this.player && global.VF.Skills && global.VF.Skills.isPlayerStealthed(this.player)) {
      if (global.VF.game && global.VF.game.skills && global.VF.game.skills.breakStealth) {
        global.VF.game.skills.breakStealth(false);
      } else {
        this.player.stealthed = false;
        this.player.ghostAmbushShot = true;
      }
    }

    ammo.mag -= 1;
    if (this.player) {
      this.player._lastCombatAt = performance.now();
      this.player._reviveProtection = 0;
    }
    this.cooldown = fireInterval(def);
    // Capture aim BEFORE recoil so hitscan matches the crosshair
    const origin = this.player.getEyePosition();
    const baseDir = this.player.getLookDirection();
    // One shared muzzle tip for flash + tracer (force fresh world matrix)
    if (this.player.muzzle && this.player.muzzle.updateWorldMatrix) {
      this.player.muzzle.updateWorldMatrix(true, false);
      this.player.muzzle.getWorldPosition(this._tmpMuzzle);
    } else {
      this._tmpMuzzle.copy(origin).addScaledVector(baseDir, 0.55);
    }
    this._muzzleFlashAt(this._tmpMuzzle, baseDir);
    this._shotHitHostile = false;
    this._shotKill = false;
    this._shotHitCount = 0;
    this._shotDmg = 0;
    this._shotImpactCount = 0;
    if (def.projectile && this.current === 'rpg') {
      const net = global.VF && global.VF.NetSimulation;
      const game = global.VF && global.VF.game;
      const networkGuest = !!(
        net &&
        net.isNetworkConquest &&
        net.isNetworkConquest(game) &&
        !net.isAuthority(game)
      );
      if (networkGuest && net.sendCommand) {
        net.sendCommand('rpg-fire', {
          origin: {
            x: this._tmpMuzzle.x,
            y: this._tmpMuzzle.y,
            z: this._tmpMuzzle.z,
          },
          direction: { x: baseDir.x, y: baseDir.y, z: baseDir.z },
        });
      } else if (global.VF.Vehicles && global.VF.Vehicles.launchProjectile) {
        global.VF.Vehicles.launchProjectile({
          weaponId: 'rpg',
          actor: this.player,
          team:
            this.player.team ||
            (this.player.world && this.player.world._playerTeam) ||
            'ally',
          origin: this._tmpMuzzle,
          direction: baseDir,
          speed: def.projectileSpeed,
        });
      }
    } else {
      this._fireRays(def, origin, baseDir, this._tmpMuzzle);
    }
    // ADS reduces view/gun recoil (blend with hip → scoped)
    const adsBlend =
      this.player._adsBlend != null
        ? Math.max(0, Math.min(1, this.player._adsBlend))
        : this.player.aiming
          ? 1
          : 0;
    const nowSec = performance.now() * 0.001;
    if (!this._lastShotAt || nowSec - this._lastShotAt > FIRST_SHOT_RESET) {
      this._burstCount = 0;
    }
    this._lastShotAt = nowSec;
    const kicks = recoilKicks(def, adsBlend, this._burstCount === 0);
    this._burstCount += 1;
    this.player.applyRecoil(kicks.vertical, kicks.horizontal);
    // Soft fire shake — keep mild so FX doesn't outrun the shot
    if (this.player.addShake) {
      const sh = (global.VF.Feel && global.VF.Feel.shake) || {};
      const base = sh.fireBase != null ? sh.fireBase : 0.01;
      const mul = sh.fireRecoilMul != null ? sh.fireRecoilMul : 0.12;
      this.player.addShake(base + kicks.vertical * mul);
    }

    if (global.VF.Audio) {
      const shot =
        this.current === 'sg' || this.current === 'rpg'
          ? 'shoot_sg'
          : this.current === 'sr'
            ? 'shoot_sr'
            : 'shoot_ar';
      global.VF.Audio.play(shot);
    }

    if (global.VF.UI) {
      global.VF.UI.updateAmmo(ammo.mag, ammo.reserve);
    }
    this._applyShotFeedback(def);
  };

  /** Arcade hit/kill punctuation — light camera punch (strong FOV reserved for dash) */
  Weapons.prototype._applyShotFeedback = function (def) {
    const hit = (global.VF.Feel && global.VF.Feel.hit) || {};
    const kill = (global.VF.Feel && global.VF.Feel.kill) || {};
    if (this._shotKill) {
      if (global.VF.UI) global.VF.UI.flashCrosshair('kill');
      if (this.player && this.player.punchFeedback) {
        this.player.punchFeedback({
          shake: kill.shake != null ? kill.shake : 0.14,
          pitch: kill.pitch != null ? kill.pitch : 0.016,
          fov: kill.fov != null ? kill.fov : -2.5,
        });
      } else if (this.player) {
        if (this.player.addShake) this.player.addShake(kill.shake != null ? kill.shake : 0.14);
        if (this.player.addPitchKick)
          this.player.addPitchKick(kill.pitch != null ? kill.pitch : 0.016);
      }
      return;
    }
    if (this._shotHitHostile) {
      const heavy =
        this._shotDmg >= 40 ||
        (def && def.id === 'sr') ||
        (def && def.id === 'sg' && this._shotHitCount >= 3);
      if (global.VF.UI) global.VF.UI.flashCrosshair('hit');
      if (global.VF.Audio) global.VF.Audio.play(heavy ? 'hit_heavy' : 'hit');
      if (this.player && this.player.punchFeedback) {
        const shakeBase = hit.shake != null ? hit.shake : 0.05;
        const shakeDmg = hit.shakeDmg != null ? hit.shakeDmg : 0.0018;
        const shakeCap = hit.shakeDmgCap != null ? hit.shakeDmgCap : 0.07;
        const heavyExtra = hit.heavyExtra != null ? hit.heavyExtra : 0.04;
        this.player.punchFeedback({
          shake: shakeBase + Math.min(shakeCap, this._shotDmg * shakeDmg) + (heavy ? heavyExtra : 0),
          pitch: heavy
            ? hit.heavyPitch != null
              ? hit.heavyPitch
              : 0.009
            : hit.pitch != null
              ? hit.pitch
              : 0.004,
          fov: heavy
            ? hit.heavyFov != null
              ? hit.heavyFov
              : -2.5
            : hit.fov != null
              ? hit.fov
              : -1.5,
        });
      } else if (this.player && this.player.addShake) {
        this.player.addShake(0.05 + Math.min(0.07, this._shotDmg * 0.0018) + (heavy ? 0.04 : 0));
      }
      return;
    }
    if (global.VF.UI) global.VF.UI.flashCrosshair('fire');
  };

  /** Shared muzzle flash — cone bursting from muzzle tip along fire direction */
  const _flashPool = [];
  // Tip at +Y; after rot.x=+PI/2 tip → +Z, base → -Z; then shift so tip sits at z=0
  const _flashConeGeo = new THREE.ConeGeometry(0.09, 0.32, 8);
  const _flashConeWideGeo = new THREE.ConeGeometry(0.14, 0.22, 8);
  const _flashTipGeo = new THREE.SphereGeometry(0.028, 6, 6);
  const _flashCoreMat = new THREE.MeshBasicMaterial({
    color: 0xfff6c8,
    transparent: true,
    opacity: 1,
    depthWrite: false,
  });
  const _flashFlareMat = new THREE.MeshBasicMaterial({
    color: 0xffaa44,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  const _flashOuterMat = new THREE.MeshBasicMaterial({
    color: 0xff6622,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
  });
  const _flashActive = [];
  const _flashFwd = new THREE.Vector3(0, 0, -1);
  const _flashTmpDir = new THREE.Vector3();

  function _layoutFlashCone(mesh, height, scaleY) {
    // Tip at muzzle (z=0), open along local -Z (gun forward)
    mesh.rotation.set(Math.PI / 2, 0, 0);
    mesh.position.set(0, 0, -height * 0.5 * (scaleY != null ? scaleY : 1));
  }

  function _acquireFlashPair() {
    let pair = _flashPool.pop();
    if (!pair || !pair.root || !pair.cone) {
      pair = {
        root: new THREE.Object3D(),
        tip: new THREE.Mesh(_flashTipGeo, _flashCoreMat.clone()),
        cone: new THREE.Mesh(_flashConeGeo, _flashFlareMat.clone()),
        coneOuter: new THREE.Mesh(_flashConeWideGeo, _flashOuterMat.clone()),
        // keep aliases so fade loop stays compatible
        core: null,
        flare: null,
        flare2: null,
      };
      pair.core = pair.tip;
      pair.flare = pair.cone;
      pair.flare2 = pair.coneOuter;
      pair.root.add(pair.tip);
      pair.root.add(pair.cone);
      pair.root.add(pair.coneOuter);
    }
    return pair;
  }

  /**
   * Muzzle flash — cone from muzzle tip along shot direction.
   * - With opts.worldPos (+ optional dir): spawn in scene at that point (binds to tracer).
   * - Else attach under muzzle object (AI / legacy).
   */
  function spawnMuzzleFlash(muzzle, opts) {
    opts = opts || {};
    const size = opts.size != null ? opts.size : 0.14;
    const life = opts.life != null ? opts.life : 0.05;
    const worldPos = opts.worldPos;
    const dir = opts.dir;

    let light = null;
    if (muzzle) {
      for (let i = 0; i < muzzle.children.length; i++) {
        if (muzzle.children[i].isLight) {
          light = muzzle.children[i];
          break;
        }
      }
    }
    if (light) {
      light.intensity = opts.intensity != null ? opts.intensity : 10;
      light.distance = opts.distance != null ? opts.distance : 8;
      if (opts.color != null) light.color.setHex(opts.color);
    }

    const pair = _acquireFlashPair();
    const s = size / 0.12;
    const outerLen = 0.22 * s;

    pair.tip.scale.setScalar(s * 1.15);
    pair.tip.position.set(0, 0, 0);
    pair.tip.material.opacity = 1;
    pair.tip.visible = true;

    pair.cone.scale.set(s * 1.05, s * 1.15, s * 1.05);
    _layoutFlashCone(pair.cone, 0.32, s * 1.15);
    pair.cone.material.opacity = 0.95;
    pair.cone.visible = true;

    pair.coneOuter.scale.set(s * 1.25, s * 1.05, s * 1.25);
    _layoutFlashCone(pair.coneOuter, 0.22, s * 1.05);
    // Soft outer shell slightly ahead of tip
    pair.coneOuter.position.z = -outerLen * 0.35;
    pair.coneOuter.material.opacity = 0.72;
    pair.coneOuter.visible = true;
    pair.root.scale.setScalar(1);

    if (worldPos && opts.scene) {
      pair.root.position.copy(worldPos);
      if (dir && dir.lengthSq() > 1e-8) {
        _flashTmpDir.copy(dir).normalize();
        pair.root.quaternion.setFromUnitVectors(_flashFwd, _flashTmpDir);
      } else if (muzzle && muzzle.getWorldQuaternion) {
        muzzle.getWorldQuaternion(pair.root.quaternion);
      } else {
        pair.root.quaternion.identity();
      }
      opts.scene.add(pair.root);
      _flashActive.push({ pair: pair, muzzle: null, light: light, life: life, maxLife: life, world: true });
    } else if (muzzle) {
      pair.root.position.set(0, 0, 0);
      pair.root.quaternion.identity();
      muzzle.add(pair.root);
      _flashActive.push({ pair: pair, muzzle: muzzle, light: light, life: life, maxLife: life, world: false });
    } else {
      _flashPool.push(pair);
    }
  }

  function updateMuzzleFlashes(dt) {
    for (let i = _flashActive.length - 1; i >= 0; i--) {
      const f = _flashActive[i];
      f.life -= dt;
      const u = f.maxLife > 0 ? Math.max(0, f.life / f.maxLife) : 0;
      if (f.pair.tip && f.pair.tip.material) f.pair.tip.material.opacity = u;
      if (f.pair.cone && f.pair.cone.material) f.pair.cone.material.opacity = 0.95 * u;
      if (f.pair.coneOuter && f.pair.coneOuter.material) f.pair.coneOuter.material.opacity = 0.72 * u;
      f.pair.root.scale.setScalar(1 + (1 - u) * 0.4);
      if (f.life > 0) continue;
      f.pair.root.scale.setScalar(1);
      if (f.light) f.light.intensity = 0;
      if (f.pair.root.parent) f.pair.root.parent.remove(f.pair.root);
      _flashPool.push(f.pair);
      _flashActive.splice(i, 1);
    }
  }

  Weapons.prototype._muzzleFlashAt = function (worldPos, dir) {
    const def = this.getDef();
    const flash = def && def.muzzleFlash != null ? def.muzzleFlash : 0.4;
    spawnMuzzleFlash(this.player && this.player.muzzle, {
      size: 0.28 * flash,
      intensity: 14,
      life: 0.036,
      worldPos: worldPos,
      dir: dir,
      scene: this.scene,
    });
  };

  Weapons.prototype._muzzleFlash = function () {
    // Legacy: attach to muzzle (AI still uses spawnMuzzleFlash directly)
    spawnMuzzleFlash(this.player.muzzle, { size: 0.12, intensity: 12, life: 0.05 });
  };

  Weapons.prototype._fireRays = function (def, origin, baseDir, muzzlePos) {
    origin = origin || this.player.getEyePosition();
    baseDir = baseDir || this.player.getLookDirection();
    const hipSpread =
      def.spread != null ? def.spread : spreadFromAccuracy(def.accuracy);
    const adsSpread =
      def.adsSpread != null ? def.adsSpread : hipSpread * adsSpreadMul(def);
    const spread = this.player.aiming ? adsSpread : hipSpread;
    if (muzzlePos) {
      this._tmpMuzzle.copy(muzzlePos);
    } else if (this.player.muzzle && this.player.muzzle.getWorldPosition) {
      this.player.muzzle.updateWorldMatrix(true, false);
      this.player.muzzle.getWorldPosition(this._tmpMuzzle);
    } else {
      this._tmpMuzzle.copy(origin).addScaledVector(baseDir, 0.55);
    }

    for (let p = 0; p < def.pellets; p++) {
      const dir = baseDir.clone();
      if (spread > 0) {
        dir.x += (Math.random() - 0.5) * spread * 2;
        dir.y += (Math.random() - 0.5) * spread * 2;
        dir.z += (Math.random() - 0.5) * spread * 2;
        dir.normalize();
      }
      this._trace(origin, dir, def, this._tmpMuzzle);
    }
  };

  /** Damage after distance falloff (full until falloffStart, then down to minDamage) */
  Weapons.prototype._damageAtRange = function (def, dist) {
    const start = def.falloffStart != null ? def.falloffStart : 20;
    const end = def.falloffEnd != null ? def.falloffEnd : Math.max(start + 1, def.range * 0.85);
    const minDmg =
      def.minDamage != null
        ? def.minDamage
        : def.damage * (def.minDamageScale != null ? def.minDamageScale : 0.25);
    if (dist <= start) return Math.max(1, Math.round(def.damage));
    if (dist >= end) return Math.max(1, Math.round(minDmg));
    const t = (dist - start) / Math.max(0.01, end - start);
    return Math.max(1, Math.round(def.damage + (minDmg - def.damage) * t));
  };

  /**
   * Harsher falloff vs base crystals — blocks high-ground sniping.
   * Beyond coreMaxRange damage is 0 (hit spark still shows).
   */
  Weapons.prototype._damageVsCore = function (def, dist) {
    const maxR = def.coreMaxRange != null ? def.coreMaxRange : 50;
    if (dist > maxR) return 0;
    const start = def.coreFalloffStart != null ? def.coreFalloffStart : 10;
    const end = def.coreFalloffEnd != null ? def.coreFalloffEnd : 36;
    const minS = def.coreMinDamageScale != null ? def.coreMinDamageScale : 0.03;
    let scale = 1;
    if (dist > start) {
      if (dist >= end) scale = minS;
      else {
        const t = (dist - start) / Math.max(0.01, end - start);
        // Quadratic taper — mid range drops faster than linear
        scale = 1 - t * t * (1 - minS);
      }
    }
    const dmg = Math.round(def.damage * scale);
    return dmg > 0 ? dmg : 0;
  };

  Weapons.prototype._hitDistance = function (origin, bestAction) {
    if (bestAction.dist != null) return bestAction.dist;
    if (bestAction.hit && bestAction.hit.dist != null) return bestAction.hit.dist;
    if (bestAction.hit && bestAction.hit.point) return origin.distanceTo(bestAction.hit.point);
    return 0;
  };

  /** Ghost: backstab +30% and post-stealth first-shot +40 */
  Weapons.prototype._applyGhostDamageMods = function (dmg, enemyUnit, vsRemote) {
    if (!global.VF.Skills || !global.VF.Skills.modifyOutgoingDamage) return dmg;
    const player = this.player;
    if (!player || player.classId !== 'recon') return dmg;
    let targetInfo = null;
    if (enemyUnit && enemyUnit.mesh) {
      targetInfo = {
        pos: enemyUnit.mesh.position,
        yaw: enemyUnit.mesh.rotation.y,
      };
    } else if (vsRemote && global.VF.Pvp) {
      const st = global.VF.Pvp.remoteState;
      const av = global.VF.Pvp.remoteAvatar;
      if (st && st.x != null) {
        targetInfo = {
          pos: av && av.mesh ? av.mesh.position : { x: st.x, y: st.y, z: st.z },
          yaw: av && av.mesh ? av.mesh.rotation.y : st.yaw || 0,
        };
      }
    }
    const mod = global.VF.Skills.modifyOutgoingDamage(player, dmg, targetInfo);
    return mod.damage;
  };

  /** DDA-style voxel ray march for block hits + combat units */
  Weapons.prototype._trace = function (origin, dir, def, muzzlePos) {
    let bestDist = def.range;
    let bestAction = null;
    const inRange = !!(global.VF.Range && global.VF.Range.isOpen);

    // Shooting range dummies (training) — same feedback path as hostiles
    if (inRange && global.VF.Range.raycastTargets) {
      const rHit = global.VF.Range.raycastTargets(origin, dir, def.range);
      if (rHit && rHit.dist != null && rHit.dist < bestDist) {
        bestDist = rHit.dist;
        bestAction = { type: 'range', hit: rHit };
      }
    }

    // Enemy base core (win condition)
    if (!inRange && global.VF.game && global.VF.game.bases) {
      const coreHit = global.VF.game.bases.raycastEnemyCore(origin, dir, def.range);
      if (coreHit && coreHit.dist != null && coreHit.dist < bestDist) {
        bestDist = coreHit.dist;
        bestAction = { type: 'core', hit: coreHit };
      } else if (coreHit && coreHit.point && !coreHit.dist) {
        // fallback if raycast lacks dist
        const d = origin.distanceTo(coreHit.point);
        if (d < bestDist) {
          bestDist = d;
          bestAction = { type: 'core', hit: coreHit };
        }
      }
    }

    // Hit enemies only (no friendly fire on allies)
    if (!inRange && global.VF.AI && global.VF.AI.raycastEnemies) {
      const hit = global.VF.AI.raycastEnemies(origin, dir, def.range);
      if (hit) {
        let blocked = false;
        if (global.VF.AI.raycastAllies) {
          const allyHit = global.VF.AI.raycastAllies(origin, dir, hit.dist || def.range);
          if (allyHit && allyHit.dist < hit.dist) {
            bestAction = { type: 'ally', hit: allyHit };
            bestDist = allyHit.dist;
            blocked = true;
          }
        }
        if (!blocked && hit.dist < bestDist) {
          bestDist = hit.dist;
          bestAction = { type: 'enemy', hit: hit };
        }
      }
    }

    if (!inRange && global.VF.Gadgets && global.VF.Gadgets.raycast) {
      const team = this.player.team || (this.world && this.world._playerTeam) || 'ally';
      const gadgetHit = global.VF.Gadgets.raycast(origin, dir, bestDist, team);
      if (gadgetHit && gadgetHit.dist < bestDist) {
        bestDist = gadgetHit.dist;
        bestAction = { type: 'gadget', hit: gadgetHit };
      }
    }

    if (!inRange && global.VF.Vehicles && global.VF.Vehicles.raycast) {
      const vehicleHit = global.VF.Vehicles.raycast(origin, dir, bestDist, {
        excludeId: this.player.vehicleId || null,
      });
      if (vehicleHit && vehicleHit.dist < bestDist) {
        bestDist = vehicleHit.dist;
        bestAction = { type: 'vehicle', hit: vehicleHit };
      }
    }

    // PVP: hit remote human player
    if (!inRange && global.VF.Pvp && global.VF.Pvp.raycastRemote) {
      const rpHit = global.VF.Pvp.raycastRemote(origin, dir, bestDist);
      if (rpHit && rpHit.dist < bestDist) {
        bestDist = rpHit.dist;
        bestAction = { type: 'remote', hit: rpHit };
      }
    }

    // Breakable doors (1 shot)
    if (this.world.raycastDoors) {
      const doorHit = this.world.raycastDoors(origin, dir, bestDist);
      if (doorHit && doorHit.dist < bestDist) {
        bestDist = doorHit.dist;
        bestAction = { type: 'door', hit: doorHit };
      }
    }

    // Voxel DDA — find first solid closer than bestDist (skip 1m terrain fill)
    let x = Math.floor(origin.x);
    let y = Math.floor(origin.y);
    let z = Math.floor(origin.z);

    const stepX = dir.x > 0 ? 1 : dir.x < 0 ? -1 : 0;
    const stepY = dir.y > 0 ? 1 : dir.y < 0 ? -1 : 0;
    const stepZ = dir.z > 0 ? 1 : dir.z < 0 ? -1 : 0;

    const tDeltaX = stepX !== 0 ? Math.abs(1 / dir.x) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / dir.y) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dir.z) : Infinity;

    let tMaxX =
      stepX > 0
        ? (Math.floor(origin.x) + 1 - origin.x) * tDeltaX
        : stepX < 0
          ? (origin.x - Math.floor(origin.x)) * tDeltaX
          : Infinity;
    let tMaxY =
      stepY > 0
        ? (Math.floor(origin.y) + 1 - origin.y) * tDeltaY
        : stepY < 0
          ? (origin.y - Math.floor(origin.y)) * tDeltaY
          : Infinity;
    let tMaxZ =
      stepZ > 0
        ? (Math.floor(origin.z) + 1 - origin.z) * tDeltaZ
        : stepZ < 0
          ? (origin.z - Math.floor(origin.z)) * tDeltaZ
          : Infinity;

    let dist = 0;
    for (let i = 0; i < 400 && dist < bestDist; i++) {
      const fill = this.world._isTerrainFill && this.world._isTerrainFill(x, y, z);
      const block = this.world.get(x, y, z);
      if (
        !fill &&
        block !== global.VF.BLOCK.AIR &&
        block !== global.VF.BLOCK.WATER &&
        block !== global.VF.BLOCK.GLASS
      ) {
        bestDist = dist;
        bestAction = { type: 'voxel', x, y, z, dist };
        break;
      }

      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) {
          dist = tMaxX;
          tMaxX += tDeltaX;
          x += stepX;
        } else {
          dist = tMaxZ;
          tMaxZ += tDeltaZ;
          z += stepZ;
        }
      } else {
        if (tMaxY < tMaxZ) {
          dist = tMaxY;
          tMaxY += tDeltaY;
          y += stepY;
        } else {
          dist = tMaxZ;
          tMaxZ += tDeltaZ;
          z += stepZ;
        }
      }
    }

    if (this.world.raycastTerrain) {
      const thit = this.world.raycastTerrain(origin, dir, bestDist);
      if (thit && thit.dist < bestDist) {
        bestDist = thit.dist;
        bestAction = { type: 'terrain', hit: thit, dist: thit.dist };
      }
    }

    if (!bestAction) {
      // Miss into open air — still draw a tracer along the aim ray
      this._tmpEnd.copy(origin).addScaledVector(dir, Math.min(bestDist, def.range * 0.85));
      this._spawnTracer(muzzlePos || origin, this._tmpEnd, def);
      return;
    }

    const hitDist = this._hitDistance(origin, bestAction);
    let dmg =
      bestAction.type === 'core'
        ? this._damageVsCore(def, hitDist)
        : this._damageAtRange(def, hitDist);

    this._tmpEnd.copy(origin).addScaledVector(dir, Math.max(0.35, hitDist));
    this._spawnTracer(muzzlePos || origin, this._tmpEnd, def);

    if (bestAction.type === 'core') {
      if (dmg > 0) {
        global.VF.game.bases.damageEnemyCore(dmg);
      } else if (global.VF.UI && global.VF.UI.toast) {
        // Throttle spam while spraying from rooftops
        const now = performance.now();
        if (!this._coreFarToastAt || now - this._coreFarToastAt > 900) {
          this._coreFarToastAt = now;
          global.VF.UI.toast('距离过远 · 靠近再打水晶');
        }
      }
      this._spawnImpact(bestAction.hit.point, 0xff6688, 0.55);
    } else if (bestAction.type === 'vehicle') {
      const vehicle = bestAction.hit.vehicle;
      let vehDmg = 0;
      let vehType = def.damageType || 'bullet';
      if (def.damageType === 'antiArmor') {
        vehDmg = dmg;
        vehType = 'antiArmor';
      } else if (vehicle && vehicle.armorClass === 'light') {
        vehDmg = def.lightArmorDamage != null ? def.lightArmorDamage : 0;
        vehType = 'lightArmor';
      } else if (vehicle && vehicle.armorClass === 'heavy') {
        vehDmg = def.heavyArmorDamage != null ? def.heavyArmorDamage : 0;
        vehType = 'heavyArmor';
      }
      const applied =
        vehDmg > 0
          ? global.VF.Vehicles.applyDamage(vehicle, vehDmg, {
              damageType: vehType,
              source: this.player,
              sourceId: this.player.entityId || 'player-local',
              weaponId: def.id,
            })
          : 0;
      this._spawnImpact(
        bestAction.hit.point,
        applied > 0 ? 0xff8a3d : 0xaab5b8,
        applied > 0 ? 0.34 : 0.11
      );
      if (applied > 0) {
        this._shotHitHostile = true;
        this._shotHitCount++;
        this._shotDmg += applied;
      } else if (global.VF.UI) {
        const now = performance.now();
        if (!this._armorToastAt || now - this._armorToastAt > 900) {
          this._armorToastAt = now;
          global.VF.UI.toast('跳弹 · 需要反装甲武器');
        }
      }
    } else if (bestAction.type === 'gadget') {
      global.VF.Gadgets.damage(
        bestAction.hit.item,
        dmg,
        this.player.team || (this.world && this.world._playerTeam) || 'ally'
      );
      this._spawnImpact(bestAction.hit.point, 0xffaa44, 0.2);
    } else if (bestAction.type === 'range') {
      dmg = this._damageAtRange(def, hitDist);
      const result =
        global.VF.Range && global.VF.Range.damageTarget
          ? global.VF.Range.damageTarget(bestAction.hit.target, dmg, dir, bestAction.hit.point)
          : null;
      this._shotHitHostile = true;
      this._shotHitCount++;
      this._shotDmg += result && result.dmg != null ? result.dmg : dmg;
      if (result && result.killed) this._shotKill = true;
      if ((this._shotImpactCount || 0) < 3) {
        this._shotImpactCount = (this._shotImpactCount || 0) + 1;
        this._spawnImpact(bestAction.hit.point, 0xff6622, 0.18);
      }
    } else if (bestAction.type === 'enemy') {
      dmg = this._applyGhostDamageMods(dmg, bestAction.hit.enemy);
      const result = global.VF.AI.damageEnemy(bestAction.hit.enemy, dmg, dir);
      this._shotHitHostile = true;
      this._shotHitCount++;
      this._shotDmg += (result && result.dmg != null ? result.dmg : dmg);
      if (result && result.killed) this._shotKill = true;
      if ((this._shotImpactCount || 0) < 3) {
        this._shotImpactCount = (this._shotImpactCount || 0) + 1;
        this._spawnImpact(bestAction.hit.point, 0xff6622, 0.18);
      }
    } else if (bestAction.type === 'remote') {
      dmg = this._applyGhostDamageMods(dmg, null, true);
      if (global.VF.Pvp && global.VF.Pvp.dealDamageToRemote) {
        global.VF.Pvp.dealDamageToRemote(dmg);
      }
      this._spawnImpact(bestAction.hit.point, 0xff4422, 0.14);
      this._shotHitHostile = true;
      this._shotHitCount++;
      this._shotDmg += dmg;
    } else if (bestAction.type === 'ally') {
      this._spawnImpact(bestAction.hit.point, 0x44ffcc);
    } else if (bestAction.type === 'door') {
      const prop = bestAction.hit.prop;
      let dx = bestAction.hit.point.x;
      let dy = bestAction.hit.point.y;
      let dz = bestAction.hit.point.z;
      if (prop && prop.box) {
        dx = (prop.box.min.x + prop.box.max.x) * 0.5;
        dy = (prop.box.min.y + prop.box.max.y) * 0.5;
        dz = (prop.box.min.z + prop.box.max.z) * 0.5;
      }
      this.world.destroyProp(prop);
      this._syncWorldBreak('break-door', dx, dy, dz);
      this._spawnImpact(bestAction.hit.point, 0xc4a574);
      this._spawnDebris(
        bestAction.hit.point.x,
        bestAction.hit.point.y,
        bestAction.hit.point.z
      );
    } else if (bestAction.type === 'terrain') {
      const point =
        (bestAction.hit && bestAction.hit.point) ||
        origin.clone().addScaledVector(dir, bestAction.dist || 0);
      this._spawnImpact(point, 0x6a8a4a, 0.08);
      if (global.VF.Audio) global.VF.Audio.play('impact');
    } else if (bestAction.type === 'voxel') {
      const point = origin.clone().addScaledVector(dir, bestAction.dist);
      this._spawnImpact(point, 0xffaa66, 0.1);
      if (global.VF.Audio) global.VF.Audio.play('impact');
      const bx = bestAction.x;
      const by = bestAction.y;
      const bz = bestAction.z;
      const blockType = this.world.get(bx, by, bz);
      const blockColor =
        (global.VF.BLOCK_COLORS && global.VF.BLOCK_COLORS[blockType]) || 0x8a8680;
      if (this.world.breakBlock(bx, by, bz)) {
        this._syncWorldBreak('break-voxel', bx, by, bz);
        this._spawnDebris(bx + 0.5, by + 0.5, bz + 0.5, blockColor);
      }
    }
  };

  /** Bullet path — thin streak; rear (near gun) dissolves first toward impact. */
  Weapons.prototype._spawnTracer = function (from, to, def) {
    if (!this.scene || !from || !to) return;
    this._tmpTracerDir.subVectors(to, from);
    const dist = this._tmpTracerDir.length();
    if (dist < 0.35) return;
    this._tmpTracerDir.multiplyScalar(1 / dist);

    // Skip a short gap past the muzzle so flash owns the tip (no double-layer cone)
    const skip = Math.min(0.55, dist * 0.08);
    const start = from.clone().addScaledVector(this._tmpTracerDir, skip);
    const end = to.clone();
    const fullDist = start.distanceTo(end);
    if (fullDist < 0.25) return;

    while (this.tracers.length >= TRACER_MAX) {
      const old = this.tracers.shift();
      if (old && old.mesh) {
        this.scene.remove(old.mesh);
        if (old.mesh.material) old.mesh.material.dispose();
      }
    }

    if (!this._tracerGeo) {
      // Unit cylinder along Y; scale.y = length
      this._tracerGeo = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true);
    }

    const pellets = def.pellets || 1;
    const bright = !!def.bright;
    let radius = pellets > 1 ? 0.012 : def.id === 'sr' ? 0.022 : 0.016;
    if (bright) radius *= 1.4;
    const color = def.ammoColor != null ? def.ammoColor : 0xffcc66;
    let opacity = pellets > 1 ? 0.45 : 0.72;
    if (bright) opacity = Math.min(0.95, opacity + 0.22);
    const mat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this._tracerGeo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;

    this._tmpMid.copy(start).add(end).multiplyScalar(0.5);
    mesh.position.copy(this._tmpMid);
    // Taper: thinner toward impact (scale.x tip-ish via nonuniform — keep thin overall)
    mesh.scale.set(radius * (bright ? 0.7 : 0.55), fullDist, radius);
    mesh.quaternion.setFromUnitVectors(this._tmpUp, this._tmpTracerDir);

    this.scene.add(mesh);
    let life = TRACER_LIFE + (def.id === 'sr' ? 0.05 : def.id === 'sg' ? 0.02 : 0);
    if (def.lifeMul) life *= def.lifeMul;
    if (bright) life += 0.04;
    this.tracers.push({
      mesh: mesh,
      life: life,
      maxLife: life,
      fade: TRACER_FADE,
      baseOpacity: mat.opacity,
      from: start,
      to: end,
      dir: this._tmpTracerDir.clone(),
      fullDist: fullDist,
      radius: radius,
    });
  };

  /** Tell the other PVP player about a destroyed voxel / door */
  Weapons.prototype._syncWorldBreak = function (kind, x, y, z) {
    if (!global.VF.game || global.VF.game.mode !== 'pvp') return;
    if (!global.VF.Pvp || !global.VF.Pvp.sendWorldBreak) return;
    if (global.VF.Pvp.phase !== 'play') global.VF.Pvp.phase = 'play';
    global.VF.Pvp.sendWorldBreak({ kind: kind, x: x, y: y, z: z });
  };

  Weapons.prototype._syncTerrainDeform = function (x, z, radius, depth) {
    if (!global.VF.game || global.VF.game.mode !== 'pvp') return;
    if (!global.VF.Pvp || !global.VF.Pvp.sendWorldBreak) return;
    if (global.VF.Pvp.phase !== 'play') global.VF.Pvp.phase = 'play';
    global.VF.Pvp.sendWorldBreak({
      kind: 'deform-terrain',
      x: x,
      z: z,
      radius: radius,
      depth: depth,
    });
  };

  Weapons.prototype._spawnImpact = function (point, color, size) {
    const r = size != null ? size : 0.06;
    if (!this._impactGeo || this._impactGeoRadius !== 0.06) {
      this._impactGeo = new THREE.SphereGeometry(0.06, 4, 4);
      this._impactGeoRadius = 0.06;
      this._impactMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      this._debrisGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
      this._debrisMat = new THREE.MeshBasicMaterial({ color: 0x8a8680 });
    }
    const mat = this._impactMat.clone();
    mat.color.setHex(color);
    const mesh = new THREE.Mesh(this._impactGeo, mat);
    mesh.position.copy(point);
    const s = r / 0.06;
    mesh.scale.setScalar(s);
    this.scene.add(mesh);
    this.impacts.push({ mesh, life: r > 0.12 ? 0.22 : 0.15, geo: null, mat, vel: null });
  };

  const DEBRIS_ACTIVE_MAX = 140;
  const DEBRIS_COUNT_MIN = 16;
  const DEBRIS_COUNT_MAX = 24;
  const _debrisPool = [];
  const _dustPool = [];
  const _debrisGeoShared = new THREE.BoxGeometry(0.22, 0.22, 0.22);
  const _dustGeoShared = new THREE.SphereGeometry(0.32, 6, 6);

  function _acquireDebrisMesh() {
    let mesh = _debrisPool.pop();
    if (!mesh) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x8a8680,
        transparent: true,
        opacity: 1,
      });
      mesh = new THREE.Mesh(_debrisGeoShared, mat);
      mesh.frustumCulled = false;
    }
    return mesh;
  }

  function _releaseDebrisMesh(mesh) {
    if (!mesh) return;
    if (mesh.parent) mesh.parent.remove(mesh);
    _debrisPool.push(mesh);
  }

  function _acquireDustMesh() {
    let mesh = _dustPool.pop();
    if (!mesh) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xc4a574,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      });
      mesh = new THREE.Mesh(_dustGeoShared, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
    }
    return mesh;
  }

  function _releaseDustMesh(mesh) {
    if (!mesh) return;
    if (mesh.parent) mesh.parent.remove(mesh);
    _dustPool.push(mesh);
  }

  Weapons.prototype._countDebrisActive = function () {
    let n = 0;
    for (let i = 0; i < this.impacts.length; i++) {
      if (this.impacts[i].kind === 'debris' || this.impacts[i].kind === 'dust') n++;
    }
    return n;
  };

  Weapons.prototype._spawnDebris = function (x, y, z, colorHex) {
    if (!this._debrisGeo) {
      this._debrisGeo = _debrisGeoShared;
      this._debrisMat = new THREE.MeshBasicMaterial({ color: 0x8a8680 });
    }
    const baseColor = colorHex != null ? colorHex : 0x8a8680;
    const count = DEBRIS_COUNT_MIN + Math.floor(Math.random() * (DEBRIS_COUNT_MAX - DEBRIS_COUNT_MIN + 1));

    // Cap active debris — drop oldest debris/dust entries
    while (this._countDebrisActive() + count > DEBRIS_ACTIVE_MAX) {
      let oldest = -1;
      for (let i = 0; i < this.impacts.length; i++) {
        const k = this.impacts[i].kind;
        if (k === 'debris' || k === 'dust') {
          oldest = i;
          break;
        }
      }
      if (oldest < 0) break;
      const old = this.impacts[oldest];
      if (old.kind === 'debris') _releaseDebrisMesh(old.mesh);
      else if (old.kind === 'dust') _releaseDustMesh(old.mesh);
      else if (old.mesh && old.mesh.parent) this.scene.remove(old.mesh);
      this.impacts.splice(oldest, 1);
    }

    for (let i = 0; i < count; i++) {
      const mesh = _acquireDebrisMesh();
      const shade = 0.75 + Math.random() * 0.35;
      const c = new THREE.Color(baseColor);
      c.multiplyScalar(shade);
      mesh.material.color.copy(c);
      mesh.material.opacity = 1;
      const size = 0.22 + Math.random() * 0.32;
      mesh.scale.setScalar(size / 0.22);
      mesh.position.set(
        x + (Math.random() - 0.5) * 0.55,
        y + (Math.random() - 0.5) * 0.55,
        z + (Math.random() - 0.5) * 0.55
      );
      const spd = 6 + Math.random() * 9;
      const ang = Math.random() * Math.PI * 2;
      const vel = new THREE.Vector3(
        Math.cos(ang) * spd,
        7 + Math.random() * 9,
        Math.sin(ang) * spd
      );
      const life = 1.0 + Math.random() * 0.55;
      this.scene.add(mesh);
      this.impacts.push({
        kind: 'debris',
        mesh: mesh,
        life: life,
        maxLife: life,
        vel: vel,
        spin: 8 + Math.random() * 14,
        mat: null,
        pooled: true,
      });
    }

    // Sand/orange spark at break point
    this._spawnImpact(new THREE.Vector3(x, y, z), 0xffaa66, 0.28);
    this._spawnImpact(
      new THREE.Vector3(x + (Math.random() - 0.5) * 0.3, y + 0.15, z + (Math.random() - 0.5) * 0.3),
      0xffcc88,
      0.18
    );

    // Dust puff (larger / longer)
    const dust = _acquireDustMesh();
    dust.material.color.setHex(0xc4a070);
    dust.material.opacity = 0.65;
    dust.position.set(x, y, z);
    dust.scale.setScalar(1.4);
    this.scene.add(dust);
    this.impacts.push({
      kind: 'dust',
      mesh: dust,
      life: 0.55,
      maxLife: 0.55,
      vel: null,
      grow: 5.5,
      mat: null,
      pooled: true,
    });
    const dust2 = _acquireDustMesh();
    dust2.material.color.setHex(0xb09060);
    dust2.material.opacity = 0.4;
    dust2.position.set(x, y + 0.2, z);
    dust2.scale.setScalar(1.0);
    this.scene.add(dust2);
    this.impacts.push({
      kind: 'dust',
      mesh: dust2,
      life: 0.7,
      maxLife: 0.7,
      vel: null,
      grow: 4.2,
      mat: null,
      pooled: true,
    });

    const now = performance.now();
    if (global.VF.Audio && (!this._breakSfxAt || now - this._breakSfxAt > 70)) {
      this._breakSfxAt = now;
      global.VF.Audio.play('break_block');
    }
  };

  Weapons.prototype.reload = function () {
    if (this.reloading) return;
    if (this.mode !== 'weapon') return;
    if (this.player && this.player.dead) return;
    const def = this.getDef();
    const ammo = this.getAmmo();
    if (ammo.mag >= def.magSize || ammo.reserve <= 0) return;

    this.reloading = true;
    const baseReload = def.reloadTime != null ? def.reloadTime : 1.8;
    const speedMul = global.VF.Skills ? global.VF.Skills.getWeaponSpeedMul(this.player) : 1;
    this.reloadDuration = baseReload / speedMul;
    this.reloadTimer = this.reloadDuration;
    this.firing = false;
    if (this.player) {
      this.player.aiming = !!(this.player.locked && this.player.keys && this.player.keys['Mouse2']);
    }
    if (global.VF.Audio) {
      global.VF.Audio.play('reload_start');
      const mid = Math.max(0.25, this.reloadDuration * 0.45);
      const self = this;
      clearTimeout(this._reloadSfxTimer);
      this._reloadSfxTimer = setTimeout(function () {
        if (self.reloading && global.VF.Audio) global.VF.Audio.play('reload_mag');
      }, mid * 1000);
    }
    if (global.VF.UI && global.VF.UI.setReloading) {
      global.VF.UI.setReloading(true);
    }
  };

  Weapons.prototype._cancelReload = function () {
    if (!this.reloading) return;
    this.reloading = false;
    this.reloadTimer = 0;
    this.reloadDuration = 0;
    clearTimeout(this._reloadSfxTimer);
    if (global.VF.UI && global.VF.UI.setReloading) {
      global.VF.UI.setReloading(false);
    }
  };

  Weapons.prototype._finishReload = function () {
    if (!this.reloading) return;
    const def = this.getDef();
    const ammo = this.getAmmo();
    const need = def.magSize - ammo.mag;
    const take = Math.min(need, ammo.reserve);
    ammo.mag += take;
    ammo.reserve -= take;
    this.reloading = false;
    this.reloadTimer = 0;
    this.reloadDuration = 0;
    this.cooldown = 0.12;
    if (this.player) {
      this.player.aiming = !!(this.player.locked && this.player.keys && this.player.keys['Mouse2']);
    }
    clearTimeout(this._reloadSfxTimer);
    if (global.VF.Audio) global.VF.Audio.play('reload_rack');
    if (global.VF.UI) {
      global.VF.UI.updateAmmo(ammo.mag, ammo.reserve);
      if (global.VF.UI.setReloading) global.VF.UI.setReloading(false);
    }
  };

  /**
   * Reload pose weight 0..1 for FPS viewmodel.
   * Pull-down → hold → rack back.
   */
  Weapons.prototype.getReloadAnim = function () {
    if (!this.reloading || this.reloadDuration <= 0) return 0;
    const t = 1 - this.reloadTimer / this.reloadDuration;
    if (t <= 0) return 0;
    if (t >= 1) return 0;
    // 0–0.22 pull, 0.22–0.72 hold, 0.72–1 return
    if (t < 0.22) {
      const u = t / 0.22;
      return u * u * (3 - 2 * u); // smoothstep in
    }
    if (t < 0.72) {
      return 1;
    }
    const u = (t - 0.72) / 0.28;
    const s = u * u * (3 - 2 * u);
    return 1 - s;
  };

  Weapons.prototype.update = function (dt) {
    if (this.cooldown > 0) this.cooldown -= dt;

    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) this._finishReload();
    }

    updateMuzzleFlashes(dt);

    if (this.firing && this.mode === 'weapon' && !this.reloading && this.getDef().automatic) {
      this.tryFire();
    }

    // Ammo drop pickup + spin
    const playerPos = this.player.object.position;
    for (let i = this.ammoDrops.length - 1; i >= 0; i--) {
      const d = this.ammoDrops[i];
      d.life -= dt;
      d.mesh.rotation.y += dt * 2.5;
      d.mesh.position.y += Math.sin(performance.now() * 0.004 + d.spin) * 0.002;

      if (playerPos.distanceTo(d.mesh.position) < 2.2) {
        const gained = this.addReserve(d.weaponId, d.amount);
        const label = (WEAPONS[d.weaponId] && WEAPONS[d.weaponId].ammoLabel) || d.weaponId.toUpperCase();
        if (gained > 0 && global.VF.Audio) global.VF.Audio.play('pickup');
        if (global.VF.UI) {
          if (gained > 0) global.VF.UI.toast('+' + gained + ' ' + label + ' ammo');
          else global.VF.UI.toast(label + ' ammo full (' + AMMO_RESERVE_MAX + ')');
          const cur = this.getAmmo();
          global.VF.UI.updateAmmo(cur.mag, cur.reserve);
        }
        this.scene.remove(d.mesh);
        if (d.mesh.geometry) d.mesh.geometry.dispose();
        if (d.mesh.material) d.mesh.material.dispose();
        this.ammoDrops.splice(i, 1);
        continue;
      }

      if (d.life <= 0) {
        this.scene.remove(d.mesh);
        if (d.mesh.geometry) d.mesh.geometry.dispose();
        if (d.mesh.material) d.mesh.material.dispose();
        this.ammoDrops.splice(i, 1);
      }
    }

    // Animate impacts / debris / dust
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const p = this.impacts[i];
      p.life -= dt;
      if (p.kind === 'debris' && p.vel) {
        p.vel.y -= 18 * dt;
        p.mesh.position.addScaledVector(p.vel, dt);
        const spin = p.spin || 5;
        p.mesh.rotation.x += dt * spin;
        p.mesh.rotation.y += dt * spin * 0.7;
        if (p.mesh.material && p.maxLife) {
          p.mesh.material.opacity = Math.max(0, p.life / p.maxLife);
        }
      } else if (p.kind === 'dust') {
        const u = Math.max(0, p.life / Math.max(0.001, p.maxLife));
        const grow = p.grow != null ? p.grow : 2.5;
        p.mesh.scale.setScalar(0.8 + (1 - u) * grow);
        if (p.mesh.material) p.mesh.material.opacity = 0.5 * u;
      } else if (p.vel) {
        p.vel.y -= 12 * dt;
        p.mesh.position.addScaledVector(p.vel, dt);
        p.mesh.rotation.x += dt * 5;
      } else {
        p.mesh.scale.multiplyScalar(1 + dt * 2);
      }
      if (p.life <= 0) {
        if (p.pooled && p.kind === 'debris') {
          _releaseDebrisMesh(p.mesh);
        } else if (p.pooled && p.kind === 'dust') {
          _releaseDustMesh(p.mesh);
        } else {
          this.scene.remove(p.mesh);
          if (p.mat) p.mat.dispose();
        }
        this.impacts.splice(i, 1);
      }
    }

    // Tracers: rear (near gun) shrinks away first toward the impact tip
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      if (t.mesh && t.from && t.to && t.fullDist > 0) {
        const u = 1 - Math.max(0, t.life) / Math.max(0.001, t.maxLife);
        // Ease: tail races forward quickly, tip lingers briefly
        const tailT = Math.min(1, u * u * 1.35);
        const remain = t.fullDist * (1 - tailT);
        if (remain < 0.08 || t.life <= 0) {
          this.scene.remove(t.mesh);
          if (t.mesh.material) t.mesh.material.dispose();
          this.tracers.splice(i, 1);
          continue;
        }
        // New start = old start advanced along dir; end stays at impact
        this._tmpMid.copy(t.from).addScaledVector(t.dir, t.fullDist - remain);
        const tip = t.to;
        t.mesh.position.copy(this._tmpMid).add(tip).multiplyScalar(0.5);
        const r = t.radius * (1 - tailT * 0.35);
        t.mesh.scale.set(r * 0.55, remain, r);
        t.mesh.quaternion.setFromUnitVectors(this._tmpUp, t.dir);
        if (t.mesh.material) {
          const base = t.baseOpacity != null ? t.baseOpacity : 0.7;
          t.mesh.material.opacity = base * (1 - tailT * 0.55);
        }
      } else if (t.life <= 0) {
        if (t.mesh) {
          this.scene.remove(t.mesh);
          if (t.mesh.material) t.mesh.material.dispose();
        }
        this.tracers.splice(i, 1);
      }
    }
  };

  /** Shared tracer for player + AI — routes into the active Weapons list for fade/update. */
  function spawnTracer(from, to, opts) {
    opts = opts || {};
    const w = global.VF.game && global.VF.game.weapons;
    if (!w || !w._spawnTracer) return;
    w._spawnTracer(from, to, {
      id: opts.id || 'ar',
      pellets: opts.pellets != null ? opts.pellets : 1,
      ammoColor: opts.color != null ? opts.color : 0xffaa44,
      bright: !!opts.bright,
      lifeMul: opts.lifeMul != null ? opts.lifeMul : 1,
    });
  }

  global.VF = global.VF || {};
  global.VF.WEAPONS = WEAPONS;
  global.VF.WEAPON_BASE_STATS = WEAPON_BASE_STATS;
  global.VF.weaponFireInterval = fireInterval;
  global.VF.formatWeaponBaseStats = formatWeaponBaseStats;
  global.VF.AMMO_RESERVE_MAX = AMMO_RESERVE_MAX;
  global.VF.AMMO_DROP_AMOUNT = AMMO_DROP_AMOUNT;
  global.VF.ENEMY_AMMO_TYPE = ENEMY_AMMO_TYPE;
  global.VF.Weapons = Weapons;
  global.VF.spawnMuzzleFlash = spawnMuzzleFlash;
  global.VF.spawnTracer = spawnTracer;
})(window);
