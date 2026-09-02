/**
 * player.js — First-person controller + voxel soldier view-model
 * WASD · mouse look · jump · crouch (Ctrl) · ADS (RMB) · pointer lock
 */
(function (global) {
  'use strict';

  const EYE_HEIGHT = 1.85;
  const EYE_CROUCH = 1.05;
  const PLAYER_RADIUS = 0.35;
  const PLAYER_HEIGHT = 2.0;
  const PLAYER_CROUCH_HEIGHT = 1.15;
  const MOVE_SPEED = 8.5;
  const CROUCH_SPEED_MULT = 0.48;
  const SPRINT_MULT = 1.42;
  const JUMP_VEL = 8.2;
  const GRAVITY = 22;
  const MOUSE_SENS = 0.0022;
  const ADS_SENS = 0.0011;
  const ADS_FOV = 48;
  const HIP_FOV = 70;
  const STEP_UP = 1.05; // walk up marked stair treads without jumping
  const TERRAIN_STEP_UP = 0.35;
  const TERRAIN_SNAP_DOWN = 0.22;

  function feelGroup(name) {
    const F = global.VF && global.VF.Feel;
    return (F && F[name]) || {};
  }

  function Player(camera, world) {
    this.camera = camera;
    this.world = world;
    this.velocity = new THREE.Vector3();
    this.direction = new THREE.Vector3();
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.onGround = false;
    this.health = 100;
    this.maxHealth = 100;
    this.armor = 50;
    this.maxArmor = 100;
    this.alive = true;
    this.dead = false;
    this.cores = 0;
    this.blocks = 8; // starter building blocks for later
    this.aiming = false;
    this.locked = false;
    this.keys = Object.create(null);
    this.pitch = 0;
    this.yaw = 0;
    this.crouching = false;
    this._crouchBlend = 0;
    this.zipRide = null;
    this._zipKeyWasDown = false;
    this._zipJumpWasDown = false;
    this._zipCool = 0;
    this.vehicleId = null;
    this.vehicleSeat = null;
    this.vehicleRole = null;
    this.vehicleWeaponIndex = 0;
    this.vehicleCameraMode = 0;
    this.vehicleTurretLocked = false;
    this._vehicleExitCool = 0;

    // Body (collision root)
    this.object = new THREE.Object3D();
    this.applySelectedSpawn();

    // First-person voxel soldier (shared palette with squad)
    this.classId = 'assault';
    this._heldMode = 'weapon';
    this.buildViewModel = null;
    if (global.VF.Soldier) {
      this._rebuildWeaponViewModel(this.classId, 'ar');
    } else {
      this.viewModel = this._createSoldierViewModel();
      camera.add(this.viewModel);
    }

    this._bobTime = 0;
    this._swayBlend = 0;
    this._adsBlend = 0;
    this._recoilKick = 0;
    this._recoilVel = 0;
    this._viewPunchPitch = 0;
    this._viewPunchYaw = 0;
    this._viewPunchPitchVel = 0;
    this._viewPunchYawVel = 0;
    this._viewPunchPitchTarget = 0;
    this._viewPunchYawTarget = 0;
    this._recoilWasRecovering = false;
    this._recoilIdleTimer = 1;
    this._gunRest = null;
    this._shake = 0;
    this._fovPunch = 0;
    this._vmBase = new THREE.Vector3();
    this.skillSpeedBuffTimer = 0;
    this.skillSpeedBuffMul = 1.2;
    this.stealthed = false;
    this.ghostAmbushShot = false;

    this._bindInput();
  }

  /** Rebuild FPS arms + gun to match class and equipped weapon. */
  Player.prototype._rebuildWeaponViewModel = function (classId, weaponId) {
    if (!global.VF.Soldier) return;
    const wasBuild = this._heldMode === 'build';
    if (this._weaponViewModel && this._weaponViewModel.parent) {
      this._weaponViewModel.parent.remove(this._weaponViewModel);
    } else if (this.viewModel && this.viewModel.parent && this.viewModel !== this.buildViewModel) {
      this.viewModel.parent.remove(this.viewModel);
    }
    const vm = global.VF.Soldier.createViewModel(classId, weaponId);
    this._weaponViewModel = vm.root;
    this._weaponGunNode = vm.gun;
    this._weaponMuzzle = vm.muzzle;
    this._weaponFlash = vm.flash;
    this.rightArm = vm.rightArm;
    this.leftArm = vm.leftArm;
    this._hipPos = vm.root.position.clone();
    this._adsPos = new THREE.Vector3(0.08, -0.26, -0.4);
    this._weaponHip = this._hipPos.clone();
    this._weaponAds = this._adsPos.clone();
    this._gunRest = null;
    if (this.camera) this.camera.add(this._weaponViewModel);
    if (!wasBuild) {
      this.viewModel = this._weaponViewModel;
      this.gunNode = this._weaponGunNode;
      this.muzzle = this._weaponMuzzle;
      this.muzzleFlash = this._weaponFlash;
    } else if (this._weaponViewModel) {
      this._weaponViewModel.visible = false;
    }
  };

  Player.prototype.applyWeaponModel = function (weaponId) {
    if (!global.VF.Soldier) return;
    this._rebuildWeaponViewModel(this.classId, weaponId);
  };

  /** Swap first-person arms / gun look to match selected class */
  Player.prototype.applyClass = function (classId) {
    if (!classId || !global.VF.Soldier) return;
    if (global.VF.Soldier.normalizeClassId) {
      classId = global.VF.Soldier.normalizeClassId(classId);
    }
    this.classId = classId;
    const wasBuild = this._heldMode === 'build';
    const weaponId =
      (global.VF.game && global.VF.game.weapons && global.VF.game.weapons.current) ||
      (global.VF.game && global.VF.game.preferredWeaponId) ||
      'ar';
    this._rebuildWeaponViewModel(classId, weaponId);
    this._heldMode = 'weapon';
    if (wasBuild) this.setHeldMode('build');
    if (global.VF.game && global.VF.game.weapons) {
      global.VF.game.weapons.syncOwnedLoadout();
    }
    if (global.VF.UI && global.VF.UI.syncWeaponLocks) {
      global.VF.UI.syncWeaponLocks();
    }
  };

  /** Switch FPS hands between rifle and gray stone block (slots 4/5) */
  Player.prototype.setHeldMode = function (mode) {
    mode = mode === 'build' ? 'build' : 'weapon';
    if (!this.camera) return;

    if (mode === 'build') {
      if (!this.buildViewModel && global.VF.Soldier && global.VF.Soldier.createBuildViewModel) {
        const bm = global.VF.Soldier.createBuildViewModel();
        this.buildViewModel = bm.root;
        this._buildGunNode = bm.gun;
        this._buildMuzzle = bm.muzzle;
        this._buildHip = bm.root.position.clone();
        this._buildAds = new THREE.Vector3(0.22, -0.3, -0.4);
        this.camera.add(this.buildViewModel);
      }
      if (this._weaponViewModel) this._weaponViewModel.visible = false;
      if (this.buildViewModel) {
        this.buildViewModel.visible = true;
        this.viewModel = this.buildViewModel;
        this.gunNode = this._buildGunNode;
        this.muzzle = this._buildMuzzle;
        this.muzzleFlash = null;
        this._hipPos = this._buildHip.clone();
        this._adsPos = this._buildAds.clone();
      }
    } else {
      if (this.buildViewModel) this.buildViewModel.visible = false;
      if (this._weaponViewModel) {
        this._weaponViewModel.visible = true;
        this.viewModel = this._weaponViewModel;
        this.gunNode = this._weaponGunNode;
        this.muzzle = this._weaponMuzzle;
        this.muzzleFlash = this._weaponFlash;
        this._hipPos = this._weaponHip.clone();
        this._adsPos = this._weaponAds.clone();
      }
    }
    this._heldMode = mode;
    this._gunRest = null;
    this._recoilKick = 0;
    this._recoilVel = 0;
    this._viewPunchPitch = 0;
    this._viewPunchYaw = 0;
    this._viewPunchPitchVel = 0;
    this._viewPunchYawVel = 0;
    this._viewPunchPitchTarget = 0;
    this._viewPunchYawTarget = 0;
    this._recoilWasRecovering = false;
    this._recoilIdleTimer = 1;
  };

  /** Teleport to selected spawn and face the opposite base */
  Player.prototype.applySelectedSpawn = function () {
    if (this.vehicleId && global.VF.Vehicles) {
      global.VF.Vehicles.dismount(this, { reason: 'spawn', silent: true });
    }
    const world = this.world;
    const spawn = world.getSpawnPosition();
    this.object.position.copy(spawn);
    if (world.setLodFocus) world.setLodFocus(spawn.x, spawn.z);
    this.velocity.set(0, 0, 0);
    this.zipRide = null;
    const sel = world.getSelectedSpawn && world.getSelectedSpawn();
    const target =
      sel && sel.team === 'enemy'
        ? world._allyBasePos
        : world._enemyBasePos || world._allyBasePos;
    if (target) {
      const dx = target.x - spawn.x;
      const dz = target.z - spawn.z;
      // Match look forward (-sin yaw, -cos yaw) toward target
      this.yaw = Math.atan2(dx, dz) + Math.PI;
    } else if (world._allyBasePos) {
      this.yaw = Math.PI;
    }
    this.pitch = 0;
    this._viewPunchPitch = 0;
    this._viewPunchYaw = 0;
    this._viewPunchPitchVel = 0;
    this._viewPunchYawVel = 0;
    this._viewPunchPitchTarget = 0;
    this._viewPunchYawTarget = 0;
    this._recoilWasRecovering = false;
    this._recoilIdleTimer = 1;
    this._recoilKick = 0;
    this._recoilVel = 0;
    this.unstuckFromWorld();
  };

  /** Push feet out of solid voxels after spawn / bad landings. */
  Player.prototype.unstuckFromWorld = function () {
    const pos = this.object.position;
    if (!this.world || !this._overlaps) return;
    if (!isFinite(pos.x) || !isFinite(pos.y) || !isFinite(pos.z)) {
      const spawn = this.world.getSpawnPosition && this.world.getSpawnPosition();
      if (spawn) pos.copy(spawn);
    }
    if (!this._overlaps()) return;
    const ox = pos.x;
    const oy = pos.y;
    const oz = pos.z;
    for (let r = 1; r <= 28; r++) {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        const x = ox + Math.cos(ang) * r;
        const z = oz + Math.sin(ang) * r;
        let y = oy;
        if (this.world.getWalkHeight) {
          const wh = this.world.getWalkHeight(x, z);
          if (wh != null && isFinite(wh) && Math.abs(wh - oy) < 8) y = wh;
        }
        pos.set(x, y, z);
        if (!this._overlaps()) {
          this.velocity.set(0, 0, 0);
          this.onGround = true;
          return;
        }
      }
    }
    pos.set(ox, oy, oz);
    for (let i = 0; i < 48 && this._overlaps(); i++) pos.y += 0.5;
    this.velocity.set(0, 0, 0);
  };

  /** Fallback FPS arms if soldier.js is unavailable */
  Player.prototype._createSoldierViewModel = function () {
    const root = new THREE.Group();
    root.position.set(0.32, -0.52, -0.58);
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.7), mat(0x2e343c));
    gun.name = 'ViewGun';
    gun.position.set(0.05, -0.08, -0.35);
    root.add(gun);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.02, -0.95);
    gun.add(muzzle);
    const flash = new THREE.PointLight(0xffaa44, 0, 4);
    muzzle.add(flash);
    this.gunNode = gun;
    this.muzzle = muzzle;
    this.muzzleFlash = flash;
    this._hipPos = root.position.clone();
    this._adsPos = new THREE.Vector3(0.04, -0.22, -0.42);
    return root;
  };

  Player.prototype._bindInput = function () {
    const self = this;

    document.addEventListener('keydown', (e) => {
      self.keys[e.code] = true;
      if (e.key === 'f' || e.key === 'F') self.keys['KeyF'] = true;
      const seatHotkey = /^F[1-6]$/.test(e.code) || /^F[1-6]$/.test(e.key);
      if (self.vehicleId && seatHotkey) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      if (
        !e.repeat &&
        self._handleVehicleKey &&
        (self.locked || self.vehicleId) &&
        self._handleVehicleKey(e)
      ) {
        self.keys[e.code] = false;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
      if (e.code === 'ControlLeft' || e.code === 'ControlRight') e.preventDefault();
    });
    document.addEventListener('keyup', (e) => {
      self.keys[e.code] = false;
      if (e.key === 'f' || e.key === 'F') self.keys['KeyF'] = false;
    });

    document.addEventListener('mousemove', (e) => {
      if (!self.locked) return;
      let sens = feelGroup('camera').mouseSens != null ? feelGroup('camera').mouseSens : MOUSE_SENS;
      if (self.aiming) {
        sens =
          feelGroup('camera').adsSens != null ? feelGroup('camera').adsSens : ADS_SENS;
        const def = self._weaponDef && self._weaponDef();
        if (def && def.adsSens != null) {
          const base =
            feelGroup('camera').mouseSens != null ? feelGroup('camera').mouseSens : MOUSE_SENS;
          sens = base * def.adsSens;
        }
      }
      if (
        self.vehicleId &&
        self.vehicleCameraMode === 1 &&
        self.vehicleRole &&
        self.vehicleRole !== 'passenger'
      ) {
        sens *= 0.82;
      }
      self.yaw -= e.movementX * sens;
      self.pitch -= e.movementY * sens;
      if (self.vehicleId && self.vehicleRole && self.vehicleRole !== 'passenger') {
        self.pitch = Math.max(-0.46, Math.min(0.34, self.pitch));
      } else {
        self.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, self.pitch));
      }
    });

    document.addEventListener('mousedown', (e) => {
      if (!self.locked) return;
      if (e.button === 0) self.keys['Mouse0'] = true;
      if (e.button === 2) {
        self.keys['Mouse2'] = true;
        self.aiming = true;
      }
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) self.keys['Mouse0'] = false;
      if (e.button === 2) {
        self.keys['Mouse2'] = false;
        self.aiming = false;
      }
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
  };

  Player.prototype._setVehicleViewModelVisible = function (visible) {
    if (this._weaponViewModel) this._weaponViewModel.visible = !!visible;
    if (this.buildViewModel) this.buildViewModel.visible = false;
  };

  Player.prototype._sendVehicleCommand = function (command, data) {
    const net = global.VF && global.VF.NetSimulation;
    const game = global.VF && global.VF.game;
    if (
      !net ||
      !net.sendCommand ||
      !net.isNetworkConquest ||
      !net.isNetworkConquest(game) ||
      net.isAuthority(game)
    ) {
      return false;
    }
    return !!net.sendCommand(command, data || {});
  };

  Player.prototype._handleVehicleKey = function (event) {
    const vehicles = global.VF && global.VF.Vehicles;
    if (!vehicles || this.dead) return false;
    const game = global.VF && global.VF.game;
    if (game && game.mode === 'pvp' && global.VF.MatchFlow && global.VF.MatchFlow.phase !== 'live') {
      const blocked =
        event.code === 'KeyE' ||
        /^F[1-6]$/.test(event.code) ||
        /^F[1-6]$/.test(event.key);
      if (blocked) {
        if (
          global.VF.UI &&
          global.VF.UI.toast &&
          (!this._vehicleWarmupToastAt ||
            performance.now() - this._vehicleWarmupToastAt > 900)
        ) {
          this._vehicleWarmupToastAt = performance.now();
          global.VF.UI.toast('热身结束后可使用载具');
        }
        return true;
      }
    }
    if (event.code === 'KeyE') {
      if (this.vehicleId) {
        const exited = vehicles.dismount(this, { reason: 'player-exit' });
        if (exited) {
          this._sendVehicleCommand('vehicle-dismount', {});
          this._vehicleExitCool = 0.4;
          this.vehicleCameraMode = 0;
          this.velocity.set(0, 0, 0);
          this._setVehicleViewModelVisible(true);
          if (this.camera) {
            this.camera.fov = HIP_FOV;
            this.camera.updateProjectionMatrix();
          }
          if (this.unstuckFromWorld) this.unstuckFromWorld();
        }
        return exited;
      }
      if (this._vehicleExitCool > 0) return false;
      const team =
        this.team || (this.world && this.world._playerTeam) || 'ally';
      const nearby = vehicles.findNearby(this, 4.5, team);
      for (let i = 0; i < nearby.length; i++) {
        let open = nearby[i].seats.find(function (seatState) {
          return (
            seatState.role === 'driver' &&
            !seatState.occupant &&
            seatState.occupantId == null
          );
        });
        const driver = nearby[i].seats.find(function (seatState) {
          return seatState.role === 'driver';
        });
        if (
          !open &&
          driver &&
          driver.occupant &&
          driver.occupant.isAI
        ) {
          const passenger = nearby[i].seats.find(function (seatState) {
            return (
              seatState.role !== 'driver' &&
              !seatState.occupant &&
              seatState.occupantId == null
            );
          });
          if (passenger && vehicles.switchSeat(driver.occupant, passenger.index)) {
            open = driver;
          } else {
            driver.occupant._vehicleMountCooldown = 5;
            if (
              vehicles.dismount(driver.occupant, {
                reason: 'player-priority',
              })
            ) {
              open = driver;
            }
          }
        }
        if (!open) open = vehicles.getOpenSeat(nearby[i]);
        if (!open || !vehicles.mount(this, nearby[i], open.index)) continue;
        this.vehicleWeaponIndex = 0;
        this._vehicleAuthorityGraceUntil = performance.now() + 800;
        this.vehicleCameraMode = 0;
        this.vehicleTurretLocked = false;
        this.velocity.set(0, 0, 0);
        this.zipRide = null;
        if (
          global.VF.game &&
          global.VF.game.building &&
          global.VF.game.building.exitMode
        ) {
          global.VF.game.building.exitMode();
        }
        this.yaw = nearby[i].yaw || 0;
        this.pitch = -0.08;
        this._setVehicleViewModelVisible(
          vehicles.canUsePersonalWeapon(this)
        );
        this._sendVehicleCommand('vehicle-mount', {
          vehicleId: nearby[i].id,
          seatIndex: open.index,
        });
        return true;
      }
      return false;
    }
    if (!this.vehicleId) return false;
    const seatHotkey = /^F[1-6]$/.test(event.code)
      ? event.code
      : /^F[1-6]$/.test(event.key)
        ? event.key
        : '';
    if (seatHotkey) {
      const seatIndex = Number(seatHotkey.slice(1)) - 1;
      const switched = vehicles.switchSeat(this, seatIndex);
      if (switched) {
        this.vehicleWeaponIndex = 0;
        this._vehicleAuthorityGraceUntil = performance.now() + 800;
        this._setVehicleViewModelVisible(
          vehicles.canUsePersonalWeapon(this)
        );
        if (
          vehicles.canUseVehicleFirstPerson &&
          !vehicles.canUseVehicleFirstPerson(this)
        ) {
          this.vehicleCameraMode = 0;
        }
        this._sendVehicleCommand('vehicle-seat', {
          vehicleId: this.vehicleId,
          seatIndex: seatIndex,
        });
      }
      return true;
    }
    if (event.code === 'KeyC') {
      if (
        vehicles.canUseVehicleFirstPerson &&
        !vehicles.canUseVehicleFirstPerson(this)
      ) {
        this.vehicleCameraMode = 0;
        return true;
      }
      this.vehicleCameraMode = this.vehicleCameraMode ? 0 : 1;
      return true;
    }
    if (event.code === 'KeyV') {
      this.vehicleTurretLocked = !this.vehicleTurretLocked;
      if (global.VF.UI && global.VF.UI.toast) {
        global.VF.UI.toast(
          this.vehicleTurretLocked ? '炮塔已锁定' : '炮塔已解锁'
        );
      }
      return true;
    }
    if (event.code === 'Digit1' || event.code === 'Digit2') {
      const vehicle = vehicles.getById(this.vehicleId);
      const available = vehicle
        ? vehicles.getWeaponsForRole(vehicle, this.vehicleRole)
        : [];
      if (available.length) {
        this.vehicleWeaponIndex = Math.min(
          event.code === 'Digit2' ? 1 : 0,
          available.length - 1
        );
        return true;
      }
      return !vehicles.canUsePersonalWeapon(this);
    }
    if (event.code === 'KeyR') {
      const vehicle = vehicles.getById(this.vehicleId);
      const list = vehicle
        ? vehicles.getWeaponsForRole(vehicle, this.vehicleRole)
        : [];
      const weaponId = list[
        Math.min(this.vehicleWeaponIndex || 0, Math.max(0, list.length - 1))
      ];
      return !!(weaponId && vehicles.reloadWeapon(vehicle, weaponId));
    }
    return false;
  };

  Player.prototype._updateVehicleRide = function (dt) {
    const vehicles = global.VF && global.VF.Vehicles;
    const vehicle = vehicles && vehicles.getById(this.vehicleId);
    if (!vehicles || !vehicle || !vehicle.alive) {
      this.vehicleId = null;
      this.vehicleSeat = null;
      this.vehicleRole = null;
      this.vehicleCameraMode = 0;
      this._vehicleSightRange = null;
      this._setVehicleViewModelVisible(true);
      return false;
    }
    if (this._vehicleExitCool > 0) {
      this._vehicleExitCool = Math.max(0, this._vehicleExitCool - dt);
    }
    const role = this.vehicleRole;
    let driverInput = null;
    if (role === 'driver') {
      driverInput = {
        throttle: (this.keys['KeyW'] ? 1 : 0) - (this.keys['KeyS'] ? 1 : 0),
        steer: (this.keys['KeyD'] ? 1 : 0) - (this.keys['KeyA'] ? 1 : 0),
        brake: this.keys['Space'] ? 1 : 0,
        handbrake: false,
        boost: !!this.keys['ShiftLeft'],
        slow: !!(
          this.keys['ControlLeft'] || this.keys['ControlRight']
        ),
      };
      vehicles.setDriverInput(vehicle, driverInput);
    }

    const look = this.getLookDirection();
    if (
      (role === 'driver' || role === 'gunner') &&
      !this.vehicleTurretLocked
    ) {
      vehicles.setAim(vehicle, { direction: look, role: role });
    }
    if (role === 'driver' || role === 'gunner') {
      const available = vehicles.getWeaponsForRole(vehicle, role);
      if (available.length) {
        this.vehicleWeaponIndex = Math.min(
          this.vehicleWeaponIndex || 0,
          available.length - 1
        );
        if (this.keys['Mouse0']) {
          const net = global.VF && global.VF.NetSimulation;
          const game = global.VF && global.VF.game;
          const predictOnly = !!(
            net &&
            net.isNetworkConquest &&
            net.isNetworkConquest(game) &&
            !net.isAuthority(game)
          );
          const fireDirection = this._vehicleFireDirection(
            vehicles,
            vehicle,
            look,
            available[this.vehicleWeaponIndex]
          );
          vehicles.fireWeapon(
            vehicle,
            available[this.vehicleWeaponIndex],
            this,
            { direction: fireDirection, predictOnly: predictOnly }
          );
        }
      }
    }
    const now = performance.now();
    if (!this._vehicleNetAt || now - this._vehicleNetAt >= 50) {
      this._vehicleNetAt = now;
      this._sendVehicleCommand('vehicle-input', {
        vehicleId: vehicle.id,
        seatIndex: this.vehicleSeat,
        role: role,
        throttle: driverInput ? driverInput.throttle : 0,
        steer: driverInput ? driverInput.steer : 0,
        brake: driverInput ? driverInput.brake : 0,
        handbrake: driverInput ? driverInput.handbrake : false,
        boost: driverInput ? driverInput.boost : false,
        slow: driverInput ? driverInput.slow : false,
        turretLocked: !!this.vehicleTurretLocked,
        aimYaw: this.yaw,
        aimPitch: this.pitch,
        weaponIndex: this.vehicleWeaponIndex || 0,
        fire: !!this.keys['Mouse0'],
      });
    }

    const seatPosition = vehicles.getSeatWorldPosition(
      vehicle,
      this.vehicleSeat
    );
    if (seatPosition) this.object.position.set(
      seatPosition.x,
      seatPosition.y,
      seatPosition.z
    );

    const personalWeapon = vehicles.canUsePersonalWeapon(this);
    if (
      vehicles.canUseVehicleFirstPerson &&
      !vehicles.canUseVehicleFirstPerson(this)
    ) {
      this.vehicleCameraMode = 0;
    }
    this._setVehicleViewModelVisible(personalWeapon);
    this._applyVehicleCamera(vehicles, vehicle, look, personalWeapon);
    this._updateVehicleSight(vehicles, vehicle, look);
    return true;
  };

  Player.prototype._vehicleFireDirection = function (
    vehicles,
    vehicle,
    look,
    weaponId
  ) {
    if (this.vehicleTurretLocked) {
      const roleAim =
        (vehicle.aimByRole && vehicle.aimByRole[this.vehicleRole]) ||
        vehicle.aim;
      return roleAim && roleAim.direction ? roleAim.direction : look;
    }
    const def =
      weaponId && global.VF.VEHICLE_WEAPONS
        ? global.VF.VEHICLE_WEAPONS[weaponId]
        : null;
    if (!def || !vehicles._shotOrigin || !this.camera) return look;
    const muzzle = vehicles._shotOrigin(vehicle, def, {});
    const zero = 180;
    const dx = this.camera.position.x + look.x * zero - muzzle.x;
    const dy = this.camera.position.y + look.y * zero - muzzle.y;
    const dz = this.camera.position.z + look.z * zero - muzzle.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    return { x: dx / len, y: dy / len, z: dz / len };
  };

  Player.prototype._applyVehicleCamera = function (
    vehicles,
    vehicle,
    look,
    personalWeapon
  ) {
    const vehicleFpv =
      this.vehicleCameraMode === 1 &&
      (!vehicles.canUseVehicleFirstPerson ||
        vehicles.canUseVehicleFirstPerson(this));
    const firstPerson = !!(personalWeapon || vehicleFpv);
    if (firstPerson) {
      this._applyVehicleFirstPersonCamera(vehicles, vehicle, look, personalWeapon);
      return;
    }
    const dims = vehicle.def.dimensions;
    const type = vehicle.type;
    const back = type === 'tank' ? 9.8 : type === 'ifv' ? 8.6 : 6.4;
    const lift = type === 'tank' ? 1.85 : type === 'ifv' ? 1.55 : 1.28;
    const focus = new THREE.Vector3(
      vehicle.position.x,
      vehicle.position.y + dims.height * (type === 'jeep' ? 0.62 : 0.58),
      vehicle.position.z
    );
    const desired = new THREE.Vector3(
      focus.x - look.x * back,
      focus.y - look.y * back + lift,
      focus.z - look.z * back
    );
    const ray = desired.clone().sub(focus);
    const rayLen = ray.length();
    if (rayLen > 0.08) {
      ray.multiplyScalar(1 / rayLen);
      const hit = vehicles.raycastWorld
        ? vehicles.raycastWorld(focus, ray, rayLen)
        : null;
      if (hit && hit.distance < rayLen) {
        desired.copy(focus).addScaledVector(
          ray,
          Math.max(1.4, hit.distance - 0.35)
        );
      }
    }
    this.camera.position.copy(desired);
    this._syncCameraLook();
    this.camera.fov = 62;
    this.camera.updateProjectionMatrix();
  };

  Player.prototype._applyVehicleFirstPersonCamera = function (
    vehicles,
    vehicle,
    look,
    personalWeapon
  ) {
    if (personalWeapon) {
      this.camera.position.set(
        this.object.position.x,
        this.object.position.y + 0.45,
        this.object.position.z
      );
      this._syncCameraLook();
      this.camera.fov = this.aiming ? ADS_FOV : 68;
      this.camera.updateProjectionMatrix();
      return;
    }
    let anchor =
      vehicles.getFirstPersonCameraAnchor
        ? vehicles.getFirstPersonCameraAnchor(vehicle, this.vehicleRole)
        : null;
    if (!anchor) {
      const seat = vehicles.getSeatWorldPosition(vehicle, this.vehicleSeat);
      anchor = seat
        ? { x: seat.x, y: seat.y + 0.55, z: seat.z }
        : {
            x: vehicle.position.x,
            y: vehicle.position.y + vehicle.def.dimensions.height * 0.72,
            z: vehicle.position.z,
          };
    }
    this.camera.position.set(anchor.x, anchor.y, anchor.z);
    this._syncCameraLook();
    this.camera.fov = vehicle.type === 'jeep' ? 68 : 54;
    this.camera.updateProjectionMatrix();
  };

  Player.prototype._updateVehicleSight = function (vehicles, vehicle, look) {
    let dist = null;
    const origin = this.camera.position;
    const worldHit = vehicles.raycastWorld
      ? vehicles.raycastWorld(origin, look, 420)
      : null;
    if (worldHit && worldHit.distance > 0.8) dist = worldHit.distance;
    const vehHit = vehicles.raycast
      ? vehicles.raycast(origin, look, 420, { excludeId: vehicle.id })
      : null;
    if (vehHit && vehHit.distance > 0.8 && (dist == null || vehHit.distance < dist)) {
      dist = vehHit.distance;
    }
    this._vehicleSightRange = dist;
  };

  Player.prototype.setPointerLock = function (locked) {
    this.locked = locked;
    if (!locked) this.aiming = false;
  };

  Player.prototype.getEyeHeight = function () {
    return THREE.MathUtils.lerp(EYE_HEIGHT, EYE_CROUCH, this._crouchBlend || 0);
  };

  Player.prototype.getBodyHeight = function () {
    return THREE.MathUtils.lerp(PLAYER_HEIGHT, PLAYER_CROUCH_HEIGHT, this._crouchBlend || 0);
  };

  Player.prototype.getEyePosition = function () {
    const height = this.vehicleId ? 0.45 : this.getEyeHeight();
    return this.object.position.clone().add(new THREE.Vector3(0, height, 0));
  };

  /** True if standing capsule fits at current feet position */
  Player.prototype._canStand = function () {
    if (!this._standBoxScratch) {
      this._standBoxScratch = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
    }
    const pos = this.object.position;
    const box = this._standBoxScratch;
    box.min.set(pos.x - PLAYER_RADIUS, pos.y + 0.02, pos.z - PLAYER_RADIUS);
    box.max.set(pos.x + PLAYER_RADIUS, pos.y + PLAYER_HEIGHT, pos.z + PLAYER_RADIUS);
    if (this.world.overlapsSolid) return !this.world.overlapsSolid(box);
    return this.world.collideAABB(box).length === 0;
  };

  Player.prototype.getLookDirection = function () {
    const dir = new THREE.Vector3(0, 0, -1);
    dir.applyEuler(
      new THREE.Euler(
        this.pitch + (this._viewPunchPitch || 0),
        this.yaw + (this._viewPunchYaw || 0),
        0,
        'YXZ'
      )
    );
    return dir.normalize();
  };

  Player.prototype._syncCameraLook = function () {
    if (!this.camera || !this.euler) return;
    this.euler.set(
      this.pitch + (this._viewPunchPitch || 0),
      this.yaw + (this._viewPunchYaw || 0),
      0,
      'YXZ'
    );
    this.camera.quaternion.setFromEuler(this.euler);
  };

  /**
   * View punch: climb while firing, then settle toward settleRemain * peak.
   * settleRemain 0 = full recover; 0.25 = keep 1/4 (recover ~3/4); 0.5 = half.
   */
  Player.prototype._updateViewPunch = function (dt) {
    const v = feelGroup('view');
    this._recoilIdleTimer = (this._recoilIdleTimer || 0) + dt;
    const idleDelay = v.idleDelay != null ? v.idleDelay : 0.15;
    const recovering = this._recoilIdleTimer >= idleDelay;

    if (recovering && !this._recoilWasRecovering) {
      const remain = v.settleRemain != null ? v.settleRemain : 0.25;
      this._viewPunchPitchTarget = (this._viewPunchPitch || 0) * remain;
      this._viewPunchYawTarget = (this._viewPunchYaw || 0) * remain;
    }
    if (!recovering) {
      this._viewPunchPitchTarget = 0;
      this._viewPunchYawTarget = 0;
    }
    this._recoilWasRecovering = recovering;

    const weaponDef = this._weaponDef && this._weaponDef();
    const control = weaponDef && weaponDef.control != null ? weaponDef.control : 0.87;
    const controlMul = control / 0.87;
    const spring = recovering
      ? (v.recoverSpring != null ? v.recoverSpring : 90) * controlMul
      : v.fireSpring != null
        ? v.fireSpring
        : 10;
    const damp = recovering
      ? v.recoverDamp != null
        ? v.recoverDamp
        : 9
      : v.fireDamp != null
        ? v.fireDamp
        : 8;
    const pTarget = this._viewPunchPitchTarget || 0;
    const yTarget = this._viewPunchYawTarget || 0;

    this._viewPunchPitchVel =
      (this._viewPunchPitchVel || 0) +
      -((this._viewPunchPitch || 0) - pTarget) * spring * dt;
    this._viewPunchYawVel =
      (this._viewPunchYawVel || 0) +
      -((this._viewPunchYaw || 0) - yTarget) * spring * dt;
    this._viewPunchPitchVel *= Math.exp(-damp * dt);
    this._viewPunchYawVel *= Math.exp(-damp * dt);

    this._viewPunchPitch = (this._viewPunchPitch || 0) + this._viewPunchPitchVel * dt;
    this._viewPunchYaw = (this._viewPunchYaw || 0) + this._viewPunchYawVel * dt;

    const floor = v.pitchFloor != null ? v.pitchFloor : -0.02;
    const cap = v.pitchCap != null ? v.pitchCap : 0.16;
    const yawCap = v.yawCap != null ? v.yawCap : 0.06;
    if (this._viewPunchPitch < floor) {
      this._viewPunchPitch = floor;
      this._viewPunchPitchVel *= -0.35;
    }
    if (this._viewPunchPitch > cap) {
      this._viewPunchPitch = cap;
      this._viewPunchPitchVel *= 0.4;
    }
    if (Math.abs(this._viewPunchYaw) > yawCap) {
      this._viewPunchYaw = Math.sign(this._viewPunchYaw) * yawCap;
      this._viewPunchYawVel *= 0.4;
    }

    if (
      recovering &&
      Math.abs((this._viewPunchPitch || 0) - pTarget) < 0.001 &&
      Math.abs(this._viewPunchPitchVel) < 0.002
    ) {
      this._viewPunchPitch = pTarget;
      this._viewPunchPitchVel = 0;
    }
    if (
      recovering &&
      Math.abs((this._viewPunchYaw || 0) - yTarget) < 0.001 &&
      Math.abs(this._viewPunchYawVel) < 0.002
    ) {
      this._viewPunchYaw = yTarget;
      this._viewPunchYawVel = 0;
    }
  };

  Player.prototype._weaponDef = function () {
    const w = global.VF.game && global.VF.game.weapons;
    return w && w.getDef ? w.getDef() : null;
  };

  Player.prototype.applyRecoil = function (vertical, horizontal) {
    const v = feelGroup('view');
    const g = feelGroup('gun');
    this._recoilIdleTimer = 0;
    const pitchMul = v.pitchMul != null ? v.pitchMul : 0.55;
    const velMul = v.velMul != null ? v.velMul : 22;
    const yawMul = v.yawMul != null ? v.yawMul : 0.34;
    const vert = vertical != null ? vertical : 0;
    const horiz =
      horizontal != null
        ? horizontal * (Math.random() < 0.5 ? -1 : 1)
        : (Math.random() - 0.5) * vert;
    this._viewPunchPitch = (this._viewPunchPitch || 0) + vert * pitchMul;
    this._viewPunchPitchVel = (this._viewPunchPitchVel || 0) + vert * velMul;
    this._viewPunchYaw = (this._viewPunchYaw || 0) + horiz * yawMul;
    this._viewPunchYawVel = (this._viewPunchYawVel || 0) + horiz * yawMul * 12;
    this._recoilVel = (this._recoilVel || 0) + vert * (g.velMul != null ? g.velMul : 38);
    const kickMul = g.kickMul != null ? g.kickMul : 3.4;
    const kickMax = g.kickMax != null ? g.kickMax : 0.85;
    this._recoilKick = Math.min(kickMax, (this._recoilKick || 0) + vert * kickMul);
    this._syncCameraLook();
    this._applyGunRecoilPose(0);
  };

  /** Apply current _recoilKick to gunNode (rl = reload blend 0..1) */
  Player.prototype._applyGunRecoilPose = function (rl) {
    if (this._heldMode === 'build' || !this.gunNode) return;
    if (!this._gunRest) {
      this._gunRest = {
        x: this.gunNode.position.x,
        y: this.gunNode.position.y,
        z: this.gunNode.position.z,
        rx: this.gunNode.rotation.x,
        ry: this.gunNode.rotation.y,
        rz: this.gunNode.rotation.z,
      };
    }
    rl = rl || 0;
    const g = feelGroup('gun');
    const kick = (this._recoilKick || 0) * (1 - rl * 0.85);
    const rest = this._gunRest;
    const rack = rl > 0.35 && rl < 0.85 ? Math.sin(((rl - 0.35) / 0.5) * Math.PI) * 0.18 : 0;
    const posePitch = g.posePitch != null ? g.posePitch : 1.65;
    const poseRoll = g.poseRoll != null ? g.poseRoll : 0.12;
    const poseY = g.poseY != null ? g.poseY : 0.05;
    const poseZ = g.poseZ != null ? g.poseZ : 0.06;
    this.gunNode.rotation.x = rest.rx + kick * posePitch + rack;
    this.gunNode.rotation.z = rest.rz + kick * poseRoll;
    this.gunNode.position.x = rest.x;
    this.gunNode.position.y = rest.y + kick * poseY - rack * 0.04;
    this.gunNode.position.z = rest.z - kick * poseZ;
  };

  Player.prototype.addShake = function (amount) {
    const max = feelGroup('shake').max != null ? feelGroup('shake').max : 0.48;
    this._shake = Math.min(max, (this._shake || 0) + amount);
  };

  /** Extra pitch punch — recoverable view punch */
  Player.prototype.addPitchKick = function (amount) {
    const a = amount != null ? amount : 0.028;
    const v = feelGroup('view');
    const cap = v.pitchCap != null ? v.pitchCap : 0.16;
    this._viewPunchPitch = Math.min(cap, (this._viewPunchPitch || 0) + a);
    this._viewPunchPitchVel = (this._viewPunchPitchVel || 0) + a * 18;
    this._recoilVel = (this._recoilVel || 0) + a * 18;
    this._syncCameraLook();
  };

  /**
   * Instant arcade punch — no world time freeze.
   * @param {{shake?:number,pitch?:number,fov?:number}} opts
   *   fov: degrees offset (negative = tighten/zoom punch, positive = widen)
   */
  Player.prototype.punchFeedback = function (opts) {
    opts = opts || {};
    if (opts.shake) this.addShake(opts.shake);
    if (opts.pitch) this.addPitchKick(opts.pitch);
    if (opts.fov) {
      this._fovPunch = (this._fovPunch || 0) + opts.fov;
      // Clamp so ADS + punch stays sane
      this._fovPunch = Math.max(-14, Math.min(16, this._fovPunch));
    }
  };

  /** Apply damage (armor absorbs ~55%). Returns true if still alive.
   * @param {number} amount
   * @param {THREE.Vector3|{x,y,z}|null} [fromPos] attacker position (for frontal shield)
   */
  Player.prototype.takeDamage = function (amount, fromPos, source) {
    if (this.dead || !this.alive) return false;
    if (this._reviveProtection > 0) return true;
    if (
      global.VF.MatchFlow &&
      global.VF.MatchFlow.canDamage &&
      !global.VF.MatchFlow.canDamage(this, source && source.team)
    ) {
      return true;
    }
    this._lastCombatAt = performance.now();
    // Stealthed ghost: AI/hostiles cannot damage (stealth only breaks on fire or timeout)
    if (global.VF.Skills && global.VF.Skills.isPlayerStealthed(this)) {
      return true;
    }
    let dmg = Math.max(0, amount);
    if (global.VF.Skills && global.VF.Skills.modifyIncomingBulletDamage) {
      dmg = global.VF.Skills.modifyIncomingBulletDamage(this, dmg);
    }
    if (
      dmg > 0 &&
      global.VF.game &&
      global.VF.game.skills &&
      global.VF.game.skills.tryAbsorbShieldDamage
    ) {
      dmg = global.VF.game.skills.tryAbsorbShieldDamage(dmg, fromPos || null);
    }
    if (!(dmg > 0)) {
      if (global.VF.UI) global.VF.UI.updateVitals(this.health, this.armor);
      return true;
    }

    const felt = dmg;
    if (source && source.playerArmorDamage > 0 && this.armor > 0) {
      this.armor = Math.max(0, this.armor - source.playerArmorDamage);
    }
    if (this.armor > 0 && dmg > 0) {
      const absorb = Math.min(this.armor, dmg * 0.55);
      this.armor -= absorb;
      dmg -= absorb;
    }
    const healthBefore = this.health;
    this.health = Math.max(0, this.health - dmg);
    const applied = healthBefore - this.health;
    const attackerId = source && (source.entityId || source.id);
    if (attackerId) {
      this._lastDamagerId = attackerId;
      this._lastDamagerTeam = source.team || null;
      if (global.VF.Scoring && global.VF.Scoring.recordDamage) {
        global.VF.Scoring.recordDamage(
          attackerId,
          this.entityId || 'player-local',
          applied,
          source.team,
          this.team || (this.world && this.world._playerTeam)
        );
      }
    }

    this._applyHurtFeedback(felt, fromPos);

    if (global.VF.UI) {
      global.VF.UI.updateVitals(this.health, this.armor);
    }
    if (this.health <= 0) {
      this.die();
      return false;
    }
    return true;
  };

  /** Hurt juice: red flash + mild shake (toned down to avoid dizziness) */
  Player.prototype._applyHurtFeedback = function (feltDmg, fromPos) {
    const dmg = Math.max(1, feltDmg || 1);
    const h = feelGroup('hurt');
    if (global.VF.Audio) global.VF.Audio.play('hurt');
    if (global.VF.UI && global.VF.UI.damageFlash) global.VF.UI.damageFlash();

    const shakeAmt = Math.min(
      h.shakeMax != null ? h.shakeMax : 0.2,
      (h.shakeBase != null ? h.shakeBase : 0.1) + dmg * (h.shakeDmg != null ? h.shakeDmg : 0.006)
    );
    this.punchFeedback({
      shake: shakeAmt,
      fov: Math.min(
        h.fovMax != null ? h.fovMax : 4,
        (h.fovBase != null ? h.fovBase : 2) + dmg * (h.fovDmg != null ? h.fovDmg : 0.08)
      ),
    });

    // Light directional flinch
    const pitchAdd =
      (h.pitchBase != null ? h.pitchBase : 0.014) +
      Math.min(
        h.pitchDmgCap != null ? h.pitchDmgCap : 0.02,
        dmg * (h.pitchDmg != null ? h.pitchDmg : 0.001)
      );
    this.pitch = Math.min(1.45, this.pitch + pitchAdd);
    const yawRand = h.yawRandom != null ? h.yawRandom : 0.04;
    if (fromPos) {
      const px = this.object.position.x;
      const pz = this.object.position.z;
      const fx = (fromPos.x != null ? fromPos.x : fromPos.X) - px;
      const fz = (fromPos.z != null ? fromPos.z : fromPos.Z) - pz;
      const len = Math.hypot(fx, fz);
      if (len > 0.05) {
        const inv = 1 / len;
        const lookX = -Math.sin(this.yaw);
        const lookZ = -Math.cos(this.yaw);
        const cross = lookX * (fz * inv) - lookZ * (fx * inv);
        this.yaw +=
          cross *
          ((h.yawBase != null ? h.yawBase : 0.025) +
            Math.min(
              h.yawDmgCap != null ? h.yawDmgCap : 0.03,
              dmg * (h.yawDmg != null ? h.yawDmg : 0.001)
            ));
      } else {
        this.yaw += (Math.random() - 0.5) * yawRand;
      }
    } else {
      this.yaw += (Math.random() - 0.5) * yawRand;
    }
    if (this.camera && this.euler) {
      this._syncCameraLook();
    }
  };

  Player.prototype.die = function () {
    if (this.dead) return;
    if (this.vehicleId && global.VF.Vehicles) {
      global.VF.Vehicles.dismount(this, { reason: 'death', silent: true });
    }
    this.dead = true;
    this.alive = false;
    this.health = 0;
    this.velocity.set(0, 0, 0);
    this.zipRide = null;
    this.aiming = false;
    if (global.VF.game && global.VF.game.skills && global.VF.game.skills._clearStealth) {
      global.VF.game.skills._clearStealth(true);
    }
    if (global.VF.game && global.VF.game.skills && global.VF.game.skills._clearRiotShield) {
      global.VF.game.skills._clearRiotShield(true);
    }
    if (global.VF.game && global.VF.game.weapons && global.VF.game.weapons._cancelReload) {
      global.VF.game.weapons._cancelReload();
    }
    if (global.VF.Audio) {
      global.VF.Audio.play('death');
    }

    const g = global.VF.game;
    const pveConquest = !!(g && global.VF.Conquest && global.VF.Conquest.active);
    document.exitPointerLock && document.exitPointerLock();
    if (this.setPointerLock) this.setPointerLock(false);

    if (
      pveConquest &&
      global.VF.Revive &&
      global.VF.Revive.downPlayer &&
      global.VF.Revive.downPlayer(this)
    ) {
      return;
    }

    if (global.VF.Conquest && global.VF.Conquest.onPlayerDown) {
      const team = this.team || (this.world && this.world._playerTeam) || 'ally';
      global.VF.Conquest.onPlayerDown(team);
      this._cqTicketPending = false;
    }

    if (
      g &&
      g.mode === 'pvp' &&
      !pveConquest &&
      global.VF.Pvp &&
      global.VF.Pvp.reportLocalDeath
    ) {
      global.VF.Pvp.reportLocalDeath();
    }

    if (pveConquest) {
      if (global.VF.openRedeployFromDeath) global.VF.openRedeployFromDeath();
      return;
    }

    if (g) g.running = false;
    if (global.VF.UI && global.VF.UI.showDeath) {
      global.VF.UI.showDeath('你已阵亡', '血量耗尽 · 等待重新部署', '选个出生点再上！');
    }
  };

  /** Revive after death redeploy (keeps class / inventory). */
  Player.prototype.respawn = function () {
    if (this.vehicleId && global.VF.Vehicles) {
      global.VF.Vehicles.dismount(this, { reason: 'respawn', silent: true });
    }
    this.dead = false;
    this.alive = true;
    this.downed = false;
    this.downState = null;
    this.draggingTarget = null;
    this._reviveProtection = 0;
    this._lastDamagerId = null;
    this._lastDamagerTeam = null;
    this.health = this.maxHealth || 100;
    this.armor = Math.min(this.maxArmor || 100, 50);
    this.velocity.set(0, 0, 0);
    this.zipRide = null;
    this.aiming = false;
    this.crouching = false;
    this.stealthed = false;
    this.ghostAmbushShot = false;
    this.skillSpeedBuffTimer = 0;
    this._recoilKick = 0;
    this._recoilVel = 0;
    this._viewPunchPitch = 0;
    this._viewPunchYaw = 0;
    this._viewPunchPitchVel = 0;
    this._viewPunchYawVel = 0;
    this._viewPunchPitchTarget = 0;
    this._viewPunchYawTarget = 0;
    if (global.VF.UI && global.VF.UI.updateVitals) {
      global.VF.UI.updateVitals(this.health, this.armor);
    }
  };

  Player.prototype.update = function (dt) {
    if (this.dead) return;
    if (this.vehicleId && this._updateVehicleRide(dt)) return;
    if (this._vehicleExitCool > 0) {
      this._vehicleExitCool = Math.max(0, this._vehicleExitCool - dt);
    }

    this._updateViewPunch(dt);
    this._syncCameraLook();

    // Zipline: hold F to mount; F/Space to jump off after a short grace
    const fDown = !!this.keys['KeyF'];
    const jumpDown = !!this.keys['Space'];
    if (this._zipCool > 0) this._zipCool -= dt;
    if (this.zipRide) {
      this.zipRide.age = (this.zipRide.age || 0) + dt;
      const canOff = this.zipRide.age > 0.35;
      const wantOff =
        canOff &&
        ((fDown && !this._zipKeyWasDown) || (jumpDown && !this._zipJumpWasDown));
      if (wantOff) this._dismountZipline(true);
      else this._updateZipline(dt);
      this._zipKeyWasDown = fDown;
      this._zipJumpWasDown = jumpDown;
      if (this.zipRide) {
        const eye = this.getEyePosition();
        this.camera.position.set(eye.x, eye.y, eye.z);
        this.camera.fov = HIP_FOV;
        this.camera.updateProjectionMatrix();
        return;
      }
    } else if (fDown && this._zipCool <= 0) {
      const ok = this._tryStartZipline();
      if (!ok) this._zipCool = 0.18;
    }
    this._zipKeyWasDown = fDown;
    this._zipJumpWasDown = jumpDown;

    // Movement input
    const forward = this.keys['KeyW'] ? 1 : 0;
    const back = this.keys['KeyS'] ? 1 : 0;
    const left = this.keys['KeyA'] ? 1 : 0;
    const right = this.keys['KeyD'] ? 1 : 0;
    const wantCrouch =
      !!(this.keys['ControlLeft'] || this.keys['ControlRight']) &&
      this.onGround &&
      !this.zipRide;
    if (wantCrouch) {
      this.crouching = true;
    } else if (this.crouching && this._canStand()) {
      this.crouching = false;
    }
    this._crouchBlend += ((this.crouching ? 1 : 0) - this._crouchBlend) * Math.min(1, dt * 14);

    const sprint =
      !this.crouching &&
      (this.keys['ShiftLeft'] || this.keys['ShiftRight']);
    if (sprint && this._reviveProtection > 0) this._reviveProtection = 0;

    this.direction.set(right - left, 0, back - forward);
    if (this.direction.lengthSq() > 0) this.direction.normalize();

    // Rotate move vector by yaw
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const mx = this.direction.x * cos + this.direction.z * sin;
    const mz = -this.direction.x * sin + this.direction.z * cos;

    const pm = feelGroup('playerMove');
    const baseSpeed = pm.moveSpeed != null ? pm.moveSpeed : MOVE_SPEED;
    const adsMul = pm.adsMul != null ? pm.adsMul : 0.55;
    const crouchMul = pm.crouchMul != null ? pm.crouchMul : CROUCH_SPEED_MULT;
    const feelSprintMul = pm.sprintMul != null ? pm.sprintMul : SPRINT_MULT;
    let speedMul = this.aiming ? adsMul : 1;
    if (this.crouching) speedMul *= crouchMul;
    else if (sprint && !this.aiming) speedMul *= feelSprintMul;
    if (this.draggingTarget) speedMul *= 0.55;
    if (this.skillSpeedBuffTimer > 0) {
      speedMul *= this.skillSpeedBuffMul || 1.2;
    }
    const dashing = global.VF.game && global.VF.game.skills && global.VF.game.skills.dash;
    if (dashing) {
      this.velocity.x = 0;
      this.velocity.y = 0;
      this.velocity.z = 0;
    } else {
      const heldDef =
        this._heldMode !== 'build' && this._weaponDef ? this._weaponDef() : null;
      const weaponRun = heldDef && heldDef.runSpeed != null ? heldDef.runSpeed : 1;
      const speed = baseSpeed * speedMul * weaponRun;
      this.velocity.x = mx * speed;
      this.velocity.z = mz * speed;
    }

    // Jump + gravity (jump exits crouch when headroom allows)
    if (!dashing) {
      if (this.onGround && this.keys['Space']) {
        if (this.crouching) {
          if (this._canStand()) this.crouching = false;
        }
        if (!this.crouching) {
          this.velocity.y = JUMP_VEL;
          this.onGround = false;
          if (global.VF.Audio) global.VF.Audio.play('jump');
        }
      }
      this.velocity.y -= GRAVITY * dt;
    }

    this._moveWithCollision(dt);

    if (this._overlaps && this._overlaps() && this.direction.lengthSq() > 0) {
      this._stuckMoveT = (this._stuckMoveT || 0) + dt;
      if (this._stuckMoveT > 0.2) {
        this.unstuckFromWorld();
        this._stuckMoveT = 0;
      }
    } else {
      this._stuckMoveT = 0;
    }

    // Sync camera to eye
    const eye = this.getEyePosition();
    // Head bob
    const moving = this.direction.lengthSq() > 0 && this.onGround;
    if (moving) this._bobTime += dt * (this.crouching ? 7 : sprint ? 12 : 9);
    const bob = moving ? Math.sin(this._bobTime) * (this.crouching ? 0.018 : 0.035) : 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    if (this._shake > 0.0005) {
      const sh = feelGroup('shake');
      const ay = sh.axisY != null ? sh.axisY : 0.7;
      const az = sh.axisZ != null ? sh.axisZ : 0.5;
      const decay = sh.decay != null ? sh.decay : 16;
      sx = (Math.random() - 0.5) * this._shake;
      sy = (Math.random() - 0.5) * this._shake * ay;
      sz = (Math.random() - 0.5) * this._shake * az;
      this._shake *= Math.exp(-dt * decay);
    } else {
      this._shake = 0;
    }
    this.camera.position.set(eye.x + sx, eye.y + bob + sy, eye.z + sz);

    // ADS / held-item base pose (no ADS while reloading)
    const weapons = global.VF.game && global.VF.game.weapons;
    const reloadW = weapons && weapons.getReloadAnim ? weapons.getReloadAnim() : 0;
    const adsTarget = this.aiming && this._heldMode !== 'build' && reloadW < 0.05 ? 1 : 0;
    const adsDef = this._weaponDef && this._weaponDef();
    const adsTime = adsDef && adsDef.adsTime != null ? adsDef.adsTime : 0.25;
    const adsRate = 3 / Math.max(0.08, adsTime);
    this._adsBlend += (adsTarget - this._adsBlend) * Math.min(1, dt * adsRate);

    // Run sway: gun follows footsteps (side + vertical + light roll)
    const wantSway = moving && reloadW < 0.2 ? 1 : 0;
    this._swayBlend += (wantSway - (this._swayBlend || 0)) * Math.min(1, dt * (moving ? 10 : 7));
    const sway = this._swayBlend || 0;
    const adsDamp = 1 - this._adsBlend * 0.72;
    const sprintMul = sprint && !this.aiming ? 1.4 : this.crouching ? 0.55 : 1;
    const t = this._bobTime;
    const crouchDip = (this._crouchBlend || 0) * 0.14;
    const ax = Math.sin(t) * 0.032 * sway * sprintMul * adsDamp;
    const ay = -Math.abs(Math.sin(t)) * 0.026 * sway * sprintMul * adsDamp - crouchDip;
    const az = Math.cos(t) * 0.014 * sway * adsDamp;
    const rRoll = Math.sin(t) * 0.055 * sway * sprintMul * adsDamp;
    const rPitch = Math.cos(t * 2) * 0.03 * sway * adsDamp + (this._crouchBlend || 0) * 0.08;
    const rYaw = Math.sin(t * 0.5) * 0.02 * sway * adsDamp;

    // Reload: tilt gun down/right, dip viewmodel
    const rl = reloadW;
    const rlDipY = -0.22 * rl;
    const rlPullZ = 0.12 * rl;
    const rlSideX = 0.1 * rl;
    const rlPitch = 0.55 * rl;
    const rlYaw = -0.35 * rl;
    const rlRoll = 0.28 * rl;

    if (this.viewModel) {
      this._vmBase.lerpVectors(this._hipPos, this._adsPos, this._adsBlend);
      this.viewModel.position.set(
        this._vmBase.x + ax + rlSideX,
        this._vmBase.y + ay + rlDipY,
        this._vmBase.z + az + rlPullZ
      );
      this.viewModel.rotation.set(rPitch + rlPitch, rYaw + rlYaw, rRoll + rlRoll);
    }

    // Gun recoil only while holding a weapon
    if (this._heldMode === 'build' || !this.gunNode) {
      this._recoilKick = 0;
      this._recoilVel = 0;
    } else {
    if (!this._gunRest) {
      this._gunRest = {
        x: this.gunNode.position.x,
        y: this.gunNode.position.y,
        z: this.gunNode.position.z,
        rx: this.gunNode.rotation.x,
        ry: this.gunNode.rotation.y,
        rz: this.gunNode.rotation.z,
      };
    }
    const g = feelGroup('gun');
    const spring = g.spring != null ? g.spring : 180;
    const damp = g.damp != null ? g.damp : 11;
    this._recoilVel += -this._recoilKick * spring * dt;
    this._recoilVel *= Math.exp(-damp * dt);
    this._recoilKick += this._recoilVel * dt;
    const kickFloor = g.kickFloor != null ? g.kickFloor : -0.04;
    const kickCeil = g.kickCeil != null ? g.kickCeil : 0.5;
    if (this._recoilKick < kickFloor) {
      this._recoilKick = kickFloor;
      this._recoilVel *= -0.35;
    }
    if (this._recoilKick > kickCeil) {
      this._recoilKick = kickCeil;
      this._recoilVel *= 0.4;
    }

    this._applyGunRecoilPose(rl);

    // Support hand reaches toward mag well during reload
    if (this.leftArm && this._leftArmRest) {
      this.leftArm.rotation.x = this._leftArmRest.rx - 0.85 * rl;
      this.leftArm.rotation.z = this._leftArmRest.rz + 0.4 * rl;
      this.leftArm.position.y = this._leftArmRest.y - 0.06 * rl;
      this.leftArm.position.z = this._leftArmRest.z + 0.05 * rl;
    } else if (this.leftArm && !this._leftArmRest) {
      this._leftArmRest = {
        y: this.leftArm.position.y,
        z: this.leftArm.position.z,
        rx: this.leftArm.rotation.x,
        rz: this.leftArm.rotation.z,
      };
    }
    }

    // FOV — weapon scope zoom + arcade punch (hit tighten / hurt widen)
    const def = this._weaponDef && this._weaponDef();
    const cam = feelGroup('camera');
    const hipFov = cam.hipFov != null ? cam.hipFov : HIP_FOV;
    const adsFov =
      def && def.adsFov != null ? def.adsFov : cam.adsFov != null ? cam.adsFov : ADS_FOV;
    let targetFov = THREE.MathUtils.lerp(hipFov, adsFov, this._adsBlend);
    if (this._fovPunch) {
      // Hit punch recovers faster (~90ms); hurt widen a touch slower
      const recover = this._fovPunch < 0 ? 14 : 11;
      this._fovPunch += (0 - this._fovPunch) * Math.min(1, dt * recover);
      if (Math.abs(this._fovPunch) < 0.05) this._fovPunch = 0;
      targetFov += this._fovPunch;
    }
    targetFov = Math.max(16, Math.min(92, targetFov));
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov = targetFov;
      this.camera.updateProjectionMatrix();
    } else {
      this.camera.fov = targetFov;
    }

    // Hide held gun when looking through optic / sniper scope
    if (this.viewModel && this._heldMode !== 'build') {
      const scope = def && def.scope;
      const hideGun = this._adsBlend > 0.55 && (scope === 'sniper' || scope === 'optic');
      this.viewModel.visible = !hideGun;
    }
  };

  Player.prototype._zipXYZ = function (p) {
    if (!p) return null;
    const x = Number(p.x);
    const y = Number(p.y);
    const z = Number(p.z);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
    return { x: x, y: y, z: z };
  };

  Player.prototype._zipSegDist = function (px, py, pz, a, b) {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const ab2 = abx * abx + aby * aby + abz * abz;
    let t = 0;
    if (ab2 > 1e-6) {
      t = ((px - a.x) * abx + (py - a.y) * aby + (pz - a.z) * abz) / ab2;
      t = Math.max(0, Math.min(1, t));
    }
    const cx = a.x + abx * t;
    const cy = a.y + aby * t;
    const cz = a.z + abz * t;
    const dx = px - cx;
    const dy = py - cy;
    const dz = pz - cz;
    return { dist: Math.sqrt(dx * dx + dy * dy + dz * dz), t: t, x: cx, y: cy, z: cz };
  };

  Player.prototype._zipMeta = function (line) {
    const a = this._zipXYZ(line && line.start);
    const b = this._zipXYZ(line && line.end);
    if (!a || !b) return null;
    const landA = this._zipXYZ(line.landLow) || this._zipXYZ(line.landA);
    const landB = this._zipXYZ(line.landHigh) || this._zipXYZ(line.landB);
    const lowIsA = a.y <= b.y;
    const low = lowIsA ? a : b;
    const high = lowIsA ? b : a;
    let footLow = landA && landA.y <= (landB ? landB.y : landA.y + 1) ? landA : null;
    let footHigh = landB && (!landA || landB.y >= landA.y) ? landB : null;
    if (!footLow) footLow = this._zipXYZ(line.rideStart) || low;
    if (!footHigh) footHigh = this._zipXYZ(line.rideEnd) || high;
    if (footLow.y > footHigh.y) {
      const tmp = footLow;
      footLow = footHigh;
      footHigh = tmp;
    }
    return { a: a, b: b, low: low, high: high, footLow: footLow, footHigh: footHigh };
  };

  Player.prototype.findNearbyZipline = function (maxDist) {
    maxDist = maxDist != null ? maxDist : 7.5;
    if (this.world && this.world.ensureRideableZiplines) this.world.ensureRideableZiplines();
    const lines = this.world && this.world.ziplines;
    if (!lines || !lines.length) return null;
    const pos = this.object.position;
    const eyeY = pos.y + 1.2;
    let best = null;
    let bestScore = 99;
    for (let i = 0; i < lines.length; i++) {
      const meta = this._zipMeta(lines[i]);
      if (!meta) continue;
      const pads = [meta.low, meta.high, meta.footLow, meta.footHigh];
      let padDist = maxDist;
      for (let p = 0; p < pads.length; p++) {
        const pad = pads[p];
        const d = Math.hypot(pos.x - pad.x, pos.z - pad.z);
        const dy = Math.abs(pos.y - pad.y);
        if (d < padDist && (dy < 7.5 || (d < 3 && dy < 12))) padDist = d;
      }
      const seg = this._zipSegDist(pos.x, eyeY, pos.z, meta.a, meta.b);
      const a0 = { x: meta.a.x, y: 0, z: meta.a.z };
      const b0 = { x: meta.b.x, y: 0, z: meta.b.z };
      const segXZ = this._zipSegDist(pos.x, 0, pos.z, a0, b0);
      const yHi = Math.max(meta.a.y, meta.b.y) + 4;
      const yLo = Math.min(meta.footLow.y, meta.a.y, meta.b.y) - 6;
      const underCable = segXZ.dist < 5.5 && pos.y > yLo && pos.y < yHi;
      const nearSeg = seg.dist < 3.8 || underCable;
      const nearPad = padDist < maxDist;
      if (!nearSeg && !nearPad) continue;
      const score = nearSeg ? Math.min(seg.dist, segXZ.dist + 0.4) : padDist + 0.8;
      if (score >= bestScore) continue;
      const midY = (meta.footLow.y + meta.footHigh.y) * 0.5;
      const goUp = pos.y < midY - 1.0;
      bestScore = score;
      best = { line: lines[i], meta: meta, goUp: goUp, dist: score };
    }
    return best;
  };

  Player.prototype._tryStartZipline = function () {
    const hit = this.findNearbyZipline(7.5);
    if (!hit || !hit.meta) return false;
    const meta = hit.meta;
    const goUp = hit.goUp;
    const footFrom = goUp ? meta.footLow : meta.footHigh;
    const footTo = goUp ? meta.footHigh : meta.footLow;
    const dx = footTo.x - footFrom.x;
    const dy = footTo.y - footFrom.y;
    const dz = footTo.z - footFrom.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!isFinite(len) || len < 0.4) return false;
    this.zipRide = {
      start: { x: footFrom.x, y: footFrom.y + 1.2, z: footFrom.z },
      end: { x: footTo.x, y: footTo.y + 1.2, z: footTo.z },
      land: { x: footTo.x, y: footTo.y, z: footTo.z },
      goingUp: goUp,
      t: 0,
      age: 0,
      len: len,
      speed: Math.max(11, Math.min(26, len * 0.5)),
    };
    this.velocity.set(0, 0, 0);
    this.onGround = false;
    if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast(goUp ? '滑索 · 上去' : '滑索 · 下去');
    return true;
  };

  /** Snap feet onto a solid top under (x,z); returns stand Y or null. */
  Player.prototype._standYAt = function (x, z) {
    const w = this.world;
    if (!w) return null;
    if (w.getWalkHeight) {
      const h = w.getWalkHeight(x, z);
      if (h != null && isFinite(h)) return h;
    }
    if (!w.get) return null;
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const maxY = Math.min(w.maxHeight || 80, 80);
    for (let y = maxY; y >= 0; y--) {
      const t = w.get(ix, y, iz);
      if (t && t !== 8) return y + 1; // skip AIR(0) and WATER(8)
    }
    if (w._surface) return w._surface(ix, iz) + 1;
    return null;
  };

  Player.prototype._findLandSpot = function (x, z, preferY) {
    let best = null;
    let bestScore = 1e9;
    for (let r = 0; r <= 4; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const px = x + dx;
          const pz = z + dz;
          const sy = this._standYAt(px, pz);
          if (sy == null || !isFinite(sy)) continue;
          const dy = preferY != null ? Math.abs(sy - preferY) : 0;
          if (preferY != null && dy > 4.2) continue;
          const score = Math.hypot(dx, dz) + dy * 0.4;
          if (score < bestScore) {
            bestScore = score;
            best = { x: px, y: sy, z: pz };
          }
        }
      }
    }
    return best;
  };

  Player.prototype._snapStand = function (x, z, preferY) {
    const pos = this.object.position;
    const spot = this._findLandSpot(x, z, preferY);
    if (spot) {
      x = spot.x;
      z = spot.z;
      preferY = spot.y;
    }
    let y = preferY;
    const sy = this._standYAt(x, z);
    if (sy != null && (preferY == null || Math.abs(sy - preferY) < 2.4)) y = sy;
    if (y == null || !isFinite(y)) y = preferY != null ? preferY : pos.y;
    pos.set(x, y, z);
    if (this._overlaps()) {
      for (let i = 0; i < 8 && this._overlaps(); i++) pos.y += 0.28;
    }
    if (this._overlaps()) {
      const near = this._findLandSpot(x, z, y);
      if (near) pos.set(near.x, near.y, near.z);
    }
    if (this._overlaps() && this.unstuckFromWorld) this.unstuckFromWorld();
    this.velocity.set(0, 0, 0);
    this.onGround = true;
  };

  Player.prototype._finishZipline = function (ride) {
    const pos = this.object.position;
    let x;
    let y;
    let z;
    if (ride && ride.land && isFinite(ride.land.x)) {
      x = ride.land.x;
      y = ride.land.y;
      z = ride.land.z;
    } else if (ride && ride.end) {
      const dx = ride.end.x - ride.start.x;
      const dz = ride.end.z - ride.start.z;
      const span = Math.hypot(dx, dz);
      const inset = span > 0.2 ? Math.min(0.9, span * 0.22) : 0;
      x = ride.end.x - (span > 0.2 ? (dx / span) * inset : 0);
      z = ride.end.z - (span > 0.2 ? (dz / span) * inset : 0);
      y = ride.end.y - 1.15;
    } else {
      x = pos.x;
      y = pos.y;
      z = pos.z;
    }
    this.zipRide = null;
    this._zipCool = 0.4;
    this._snapStand(x, z, y);
  };

  Player.prototype._dismountZipline = function (midRide) {
    const ride = this.zipRide;
    const pos = this.object.position;
    this.zipRide = null;
    this._zipCool = 0.45;
    if (midRide) {
      this._snapStand(pos.x, pos.z, pos.y);
      if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast('跳下滑索');
      return;
    }
    this._finishZipline(ride);
  };

  Player.prototype._updateZipline = function (dt) {
    const ride = this.zipRide;
    if (!ride) return;
    const a = this._zipXYZ(ride.start);
    const b = this._zipXYZ(ride.end);
    if (!a || !b || !isFinite(ride.len) || ride.len < 0.05) {
      this.zipRide = null;
      if (this.unstuckFromWorld) this.unstuckFromWorld();
      return;
    }
    ride.t += (ride.speed * dt) / Math.max(0.1, ride.len);
    if (ride.t >= 1) {
      this._finishZipline(ride);
      return;
    }
    const t = ride.t;
    const sag = Math.sin(t * Math.PI) * 0.28 * (1 - t * 0.4);
    this.object.position.set(
      a.x + (b.x - a.x) * t,
      a.y + (b.y - a.y) * t - sag - 1.05,
      a.z + (b.z - a.z) * t
    );
    this.velocity.set(0, 0, 0);
  };

  Player.prototype._moveWithCollision = function (dt) {
    const pos = this.object.position;
    const v = this.velocity;

    this._moveAxisWithStep('x', v.x * dt);
    this._moveAxisWithStep('z', v.z * dt);

    // Y
    pos.y += v.y * dt;
    this.onGround = false;
    this._resolveAxis('y');

    if (this.world.getTerrainTop) {
      const th = this.world.getTerrainTop(pos.x, pos.z);
      if (pos.y < th - 0.05) {
        pos.y = th;
        v.y = 0;
        this.onGround = true;
      } else if (v.y <= 0 && pos.y <= th + 0.05) {
        pos.y = th;
        v.y = 0;
        this.onGround = true;
      }
    }

    // World bounds
    const margin = 1;
    const max = this.world.worldSize - margin;
    pos.x = THREE.MathUtils.clamp(pos.x, margin, max);
    pos.z = THREE.MathUtils.clamp(pos.z, margin, max);
    if (pos.y < -10) {
      const spawn = this.world.getSpawnPosition();
      pos.copy(spawn);
      v.set(0, 0, 0);
    }
  };

  Player.prototype._bodyBox = function () {
    if (!this._bodyBoxScratch) {
      this._bodyBoxScratch = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
    }
    const pos = this.object.position;
    const h = this.getBodyHeight();
    const box = this._bodyBoxScratch;
    box.min.set(pos.x - PLAYER_RADIUS, pos.y, pos.z - PLAYER_RADIUS);
    box.max.set(pos.x + PLAYER_RADIUS, pos.y + h, pos.z + PLAYER_RADIUS);
    return box;
  };

  Player.prototype._overlaps = function () {
    if (this.world.overlapsSolid) return this.world.overlapsSolid(this._bodyBox());
    return this.world.collideAABB(this._bodyBox()).length > 0;
  };

  /**
   * True only when every voxel currently overlapping the body is a marked stair tread.
   * Regular cubes / platforms reject auto step-up (need jump).
   */
  Player.prototype._canAutoStep = function () {
    if (!this.world.isStairVoxel) return false;
    const hits = this.world.collideAABB(this._bodyBox());
    if (!hits.length) return false;
    for (let i = 0; i < hits.length; i++) {
      const b = hits[i];
      const sx = b.max.x - b.min.x;
      const sy = b.max.y - b.min.y;
      const sz = b.max.z - b.min.z;
      // Doors / mesh props are not stair treads
      if (Math.abs(sx - 1) > 0.02 || Math.abs(sy - 1) > 0.02 || Math.abs(sz - 1) > 0.02) {
        return false;
      }
      const vx = Math.floor(b.min.x + 1e-6);
      const vy = Math.floor(b.min.y + 1e-6);
      const vz = Math.floor(b.min.z + 1e-6);
      if (!this.world.isStairVoxel(vx, vy, vz)) return false;
    }
    return true;
  };

  /** Horizontal move; auto step-up only onto stair voxels (cubes require jump) */
  Player.prototype._moveAxisWithStep = function (axis, delta) {
    if (Math.abs(delta) < 1e-8) return;
    const pos = this.object.position;
    const before = pos[axis];
    const beforeY = pos.y;
    const wasGrounded = this.onGround;
    pos[axis] += delta;
    if (this.world.sampleTerrainFootprint) {
      const mx = axis === 'x' ? delta : 0;
      const mz = axis === 'z' ? delta : 0;
      const sample = this.world.sampleTerrainFootprint(pos.x, pos.z, PLAYER_RADIUS, mx, mz);
      const rise = sample.center - beforeY;
      if (wasGrounded && (sample.blocked || rise > TERRAIN_STEP_UP)) {
        pos[axis] = before;
        pos.y = beforeY;
        this.velocity[axis] = 0;
        return;
      }
      if (wasGrounded && rise > 0) pos.y = sample.center;
      else if (wasGrounded && rise >= -TERRAIN_SNAP_DOWN) pos.y = sample.center;
    } else if (this.world.getTerrainTop && wasGrounded) {
      const th = this.world.getTerrainTop(pos.x, pos.z);
      if (th - beforeY > TERRAIN_STEP_UP) {
        pos[axis] = before;
        pos.y = beforeY;
        this.velocity[axis] = 0;
        return;
      }
      if (th > pos.y) pos.y = th;
    }
    if (!this._overlaps()) return;

    // Stairs keep auto step-up; solid cubes do not
    if (this._canAutoStep()) {
      pos.y = beforeY + STEP_UP;
      if (!this._overlaps()) {
        // Keep raised; gravity settles feet onto the tread
        return;
      }
    }

    // Wall / cube / too high — push out (jump needed for cubes)
    pos.y = beforeY;
    pos[axis] = before;
    this._resolveAxis(axis);
  };

  Player.prototype._resolveAxis = function (axis) {
    const pos = this.object.position;
    const hits = this.world.collideAABB(this._bodyBox());
    for (let i = 0; i < hits.length; i++) {
      const b = hits[i];
      if (axis === 'x') {
        if (this.velocity.x > 0) pos.x = b.min.x - PLAYER_RADIUS - 0.001;
        else if (this.velocity.x < 0) pos.x = b.max.x + PLAYER_RADIUS + 0.001;
        this.velocity.x = 0;
      } else if (axis === 'z') {
        if (this.velocity.z > 0) pos.z = b.min.z - PLAYER_RADIUS - 0.001;
        else if (this.velocity.z < 0) pos.z = b.max.z + PLAYER_RADIUS + 0.001;
        this.velocity.z = 0;
      } else if (axis === 'y') {
        if (this.velocity.y > 0) {
          pos.y = b.min.y - PLAYER_HEIGHT - 0.001;
          this.velocity.y = 0;
        } else if (this.velocity.y < 0) {
          pos.y = b.max.y + 0.001;
          this.velocity.y = 0;
          this.onGround = true;
        }
      }
    }
  };

  global.VF = global.VF || {};
  global.VF.Player = Player;
})(window);
