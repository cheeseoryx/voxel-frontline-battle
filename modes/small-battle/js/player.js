/**
 * player.js — First-person controller + voxel soldier view-model
 * WASD · mouse look · jump · crouch (C toggle / Ctrl hold / sprint+crouch slide) · ADS (RMB) · pointer lock
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
  const SLIDE_MULT = 1.35;
  const SLIDE_DUR = 0.45;
  const SLIDE_COOL = 0.28;
  const SPRINT_MULT = 1.42;
  const JUMP_VEL = 8.2;
  const GRAVITY = 22;
  const MOUSE_SENS = 0.0022;
  const ADS_SENS = 0.0011;
  const ADS_FOV = 48;
  const HIP_FOV = 70;
  const STEP_UP = 1.05; // walk up marked stair treads without jumping
  const LOOK_WARP_PX2 = 480 * 480; // compositor / pointer-lock teleport
  const LOOK_CLAMP_PX = 160; // cap a single event so a hitch cannot spin 90°

  function feelGroup(name) {
    const F = global.VF && global.VF.Feel;
    return (F && F[name]) || {};
  }

  /** Frame-rate independent exponential follow (doodleshooter `st`). */
  function expSmooth(cur, target, rate, dt) {
    if (!(dt > 0) || cur === target) return cur;
    return cur + (target - cur) * (1 - Math.exp(-Math.max(0, rate) * dt));
  }

  /**
   * Doodle can put the red-dot on the optical axis because its optic is a
   * see-through window. Our voxel guns are solid boxes, so ADS is look-over:
   * square the gun, park its TOP just under the HUD +, and pull it in so the
   * receiver fills the lower frame the way doodle's shotgun does.
   * 0.28 NDC left a dead band under the +; ~0.09 is a hair of air, not a gap.
   */
  const ADS_TOP_NDC = 0.09;
  const ADS_PULL_Z = 0.16;
  const ADS_NEAR_PAD = 0.15;
  const _adsTmp = new THREE.Vector3();
  const _adsWorld = new THREE.Vector3();
  const _adsArmWrist = new THREE.Vector3();
  const ADS_WRIST_R = new THREE.Vector3(0.01, -0.22, 0.04);
  const ADS_WRIST_L = new THREE.Vector3(-0.01, -0.22, 0.05);

  function adsPosFromHip(hip) {
    const hx = hip && hip.x != null ? hip.x : 0.3;
    const hy = hip && hip.y != null ? hip.y : -0.34;
    const hz = hip && hip.z != null ? hip.z : -0.52;
    return new THREE.Vector3(hx * 0.08, hy + 0.14, hz + ADS_PULL_Z);
  }

  function weaponIsSniper(weaponId) {
    const d = global.VF.WEAPONS && weaponId && global.VF.WEAPONS[weaponId];
    return !!(d && d.scope === 'sniper');
  }

  function findAdsSight(gunNode) {
    let sight = null;
    if (!gunNode) return null;
    gunNode.traverse(function (o) {
      if (sight || !o.isMesh || !o.material || !o.material.color || !o.material.color.getHex) return;
      if (o.material.color.getHex() === 0xff4422) sight = o;
    });
    return sight;
  }

  function isViewHand(obj, gunNode) {
    let p = obj;
    while (p && p !== gunNode) {
      const n = p.name || '';
      if (n === 'ViewRightHand' || n === 'ViewLeftHand') return true;
      p = p.parent;
    }
    return false;
  }

  /** Highest on-screen gun corner + camera-space X to centre (sight if any). */
  function pickAdsScreen(camera, gunNode, sight) {
    const tmp = _adsTmp;
    const world = _adsWorld;
    let topNdc = -Infinity;
    let topCamY = 0;
    let topCamZ = -0.5;
    let minCamX = Infinity;
    let maxCamX = -Infinity;
    gunNode.traverse(function (o) {
      if (!o.isMesh || !o.geometry || isViewHand(o, gunNode)) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      for (let i = 0; i < 8; i++) {
        tmp.set(
          i & 1 ? bb.max.x : bb.min.x,
          i & 2 ? bb.max.y : bb.min.y,
          i & 4 ? bb.max.z : bb.min.z
        );
        o.localToWorld(tmp);
        world.copy(tmp);
        camera.worldToLocal(tmp);
        // Stocks sit toward the camera; corners past the near plane explode NDC.
        if (tmp.z > -0.12) continue;
        minCamX = Math.min(minCamX, tmp.x);
        maxCamX = Math.max(maxCamX, tmp.x);
        const camY = tmp.y;
        const camZ = tmp.z;
        world.project(camera);
        if (world.y > topNdc) {
          topNdc = world.y;
          topCamY = camY;
          topCamZ = camZ;
        }
      }
    });
    let cx = (minCamX + maxCamX) * 0.5;
    if (sight) {
      sight.getWorldPosition(tmp);
      camera.worldToLocal(tmp);
      cx = tmp.x;
    }
    return {
      ok: topNdc !== -Infinity && isFinite(cx),
      cx: cx,
      topNdc: topNdc,
      topCamY: topCamY,
      topCamZ: topCamZ,
    };
  }

  function adsLookOverDeltaY(camera, st) {
    const fov = ((camera && camera.fov) || HIP_FOV) * (Math.PI / 180);
    const z = Math.max(0.12, -(st.topCamZ || 0.5));
    const wantCamY = -ADS_TOP_NDC * z * Math.tan(fov * 0.5);
    return wantCamY - st.topCamY;
  }

  function gunViewLocalMaxZ(viewModel, gunNode) {
    let maxZ = -Infinity;
    const tmp = _adsTmp;
    gunNode.traverse(function (o) {
      if (!o.isMesh || !o.geometry || isViewHand(o, gunNode)) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      for (let i = 0; i < 8; i++) {
        tmp.set(
          i & 1 ? bb.max.x : bb.min.x,
          i & 2 ? bb.max.y : bb.min.y,
          i & 4 ? bb.max.z : bb.min.z
        );
        o.localToWorld(tmp);
        viewModel.worldToLocal(tmp);
        if (tmp.z > maxZ) maxZ = tmp.z;
      }
    });
    return maxZ;
  }

  function adsSafeVmZ(hipZ, maxLocalZ) {
    const pulled = hipZ + ADS_PULL_Z;
    const safe = -ADS_NEAR_PAD - (isFinite(maxLocalZ) ? maxLocalZ : 0.4);
    return Math.min(pulled, safe);
  }

  /** Bake a look-over rest pose: gun squared, top just under the +, X on the midline. */
  function adsPosFromLookOver(viewModel, gunNode, hip, camera) {
    const fallback = adsPosFromHip(hip);
    if (!viewModel || !gunNode || !camera) return fallback;
    const hipZ = hip && hip.z != null ? hip.z : -0.52;
    const saved = {
      px: viewModel.position.x,
      py: viewModel.position.y,
      pz: viewModel.position.z,
      rx: viewModel.rotation.x,
      ry: viewModel.rotation.y,
      rz: viewModel.rotation.z,
      gx: gunNode.rotation.x,
      gy: gunNode.rotation.y,
      gz: gunNode.rotation.z,
    };
    viewModel.rotation.set(0, 0, 0);
    gunNode.rotation.set(0, 0, 0);
    viewModel.updateMatrixWorld(true);
    const adsZ = adsSafeVmZ(hipZ, gunViewLocalMaxZ(viewModel, gunNode));
    viewModel.position.set(0, fallback.y, adsZ);
    viewModel.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    const st = pickAdsScreen(camera, gunNode, findAdsSight(gunNode));
    viewModel.position.set(saved.px, saved.py, saved.pz);
    viewModel.rotation.set(saved.rx, saved.ry, saved.rz);
    gunNode.rotation.set(saved.gx, saved.gy, saved.gz);
    viewModel.updateMatrixWorld(true);
    if (!st.ok) return new THREE.Vector3(fallback.x, fallback.y, adsZ);
    return new THREE.Vector3(-st.cx, fallback.y + adsLookOverDeltaY(camera, st), adsZ);
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
    /** 死斗 spawn protection, in seconds; cleared early by firing. */
    this.spawnProtect = 0;
    this.cores = 0;
    this.blocks = 8; // starter building blocks for later
    this.aiming = false;
    this.locked = false;
    this.keys = Object.create(null);
    this.pitch = 0;
    this.yaw = 0;
    this.crouching = false;
    this._crouchToggle = false;
    this._crouchBlend = 0;
    this.slide = false;
    this._slideT = 0;
    this._slideDx = 0;
    this._slideDz = 0;
    this._slideCool = 0;
    this._ctrlWas = false;
    this._cWas = false;
    this._shiftWas = false;
    this.zipRide = null;
    this._zipKeyWasDown = false;
    this._zipJumpWasDown = false;
    this._zipCool = 0;

    // Body (collision root)
    this.object = new THREE.Object3D();
    this.applySelectedSpawn();

    // First-person voxel soldier (shared palette with squad)
    this.classId = 'vanguard';
    this.weaponId = 'ar';
    this._heldMode = 'weapon'; // 'weapon' | 'build'
    this.buildViewModel = null;
    if (global.VF.Soldier) {
      this._rebuildWeaponViewModel(this.classId, this.weaponId);
    } else {
      this.viewModel = this._createSoldierViewModel();
      camera.add(this.viewModel);
      this._weaponViewModel = this.viewModel;
    }

    this._bobTime = 0;
    this._swayBlend = 0;
    this._adsBlend = 0;
    this._adsFov = HIP_FOV;
    this._lookDx = 0;
    this._lookDy = 0;
    this._lookSwayPos = new THREE.Vector3();
    this._lookSwayRot = new THREE.Vector3();
    this._camRoll = 0;
    this._viewY = null;
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
    this._equipT = 1;
    this.skillSpeedBuffTimer = 0;
    this.skillSpeedBuffMul = 1.2;
    this.stealthed = false;
    this.ghostAmbushShot = false;

    this._bindInput();
  }

  /**
   * Rebuild the first-person arms + gun. Each gun id has its own mesh, so this
   * runs on class change and on every weapon swap.
   */
  Player.prototype._rebuildWeaponViewModel = function (classId, weaponId) {
    if (!global.VF.Soldier) return;
    if (this._weaponViewModel && this._weaponViewModel.parent) {
      this._weaponViewModel.parent.remove(this._weaponViewModel);
    } else if (this.viewModel && this.viewModel.parent && this.viewModel !== this.buildViewModel) {
      this.viewModel.parent.remove(this.viewModel);
    }
    const vm = global.VF.Soldier.createViewModel(classId, weaponId);
    this.viewModel = vm.root;
    this.gunNode = vm.gun;
    this.muzzle = vm.muzzle;
    this.muzzleFlash = vm.flash;
    this.rightArm = vm.rightArm;
    this.leftArm = vm.leftArm;
    this._hipPos = vm.root.position.clone();
    this._adsPos = adsPosFromHip(this._hipPos);
    this._gunRest = null;
    // Rest poses are captured per gun; a stale cache would replay the previous
    // gun's arm placement after the next reload or holster animation.
    this._leftArmRest = null;
    this._viewRightHand = this.gunNode ? this.gunNode.getObjectByName('ViewRightHand') : null;
    this._viewLeftHand = this.gunNode ? this.gunNode.getObjectByName('ViewLeftHand') : null;
    if (this._viewRightHand) this._viewRightHand.userData._adsHandRest = null;
    if (this._viewLeftHand) this._viewLeftHand.userData._adsHandRest = null;
    if (this.rightArm) this.rightArm.userData._adsPoseRest = null;
    if (this.leftArm) this.leftArm.userData._adsPoseRest = null;
    // Melee and throwables restore arm visibility wholesale, so the one-handed
    // hold has to be recorded here for them to honour.
    this._hideLeftArm = !!vm.oneHanded;
    this._weaponViewModel = this.viewModel;
    this._weaponGunNode = this.gunNode;
    this._weaponMuzzle = this.muzzle;
    this._weaponFlash = this.muzzleFlash;
    this._weaponHip = this._hipPos.clone();
    this.camera.add(this.viewModel);
    this._adsSight = findAdsSight(this.gunNode);
    this._adsLookOver = !weaponIsSniper(weaponId);
    this._adsPos = this._adsLookOver
      ? adsPosFromLookOver(this.viewModel, this.gunNode, this._hipPos, this.camera)
      : adsPosFromHip(this._hipPos);
    this._weaponAds = this._adsPos.clone();
    // Build mode owns the viewmodel while it is active; don't steal it back.
    if (this._heldMode === 'build') this.viewModel.visible = false;
    this._snapEquipPose();
  };

  /** Doodle switch: gun starts dipped and pitches up (ease-out cubic, ~0.31s). */
  Player.prototype.beginWeaponDraw = function () {
    this._equipT = 0;
    this._snapEquipPose();
  };

  Player.prototype._equipRaise = function () {
    const t = this._equipT == null ? 1 : this._equipT;
    if (t >= 1) return 0;
    return Math.pow(1 - t, 3);
  };

  Player.prototype._snapEquipPose = function () {
    if (!this.viewModel) return;
    const r = this._equipRaise();
    if (!r) return;
    const g = feelGroup('gun');
    const dip = g.equipDip != null ? g.equipDip : 0.32;
    const pitch = g.equipPitch != null ? g.equipPitch : 0.9;
    this.viewModel.position.y -= dip * r;
    this.viewModel.rotation.x -= pitch * r;
  };

  /** Swap the held gun mesh without touching the class. */
  Player.prototype.applyWeaponModel = function (weaponId) {
    if (!weaponId || !global.VF.Soldier) return;
    if (this.weaponId === weaponId && this._weaponViewModel) return;
    this.weaponId = weaponId;
    const wasBuild = this._heldMode === 'build';
    this._rebuildWeaponViewModel(this.classId, weaponId);
    if (!wasBuild) this.setHeldMode('weapon');
  };

  /** Swap first-person arms / gun look to match selected class */
  Player.prototype.applyClass = function (classId) {
    if (!classId || !global.VF.Soldier) return;
    this.classId = classId;
    const wasBuild = this._heldMode === 'build';
    this._rebuildWeaponViewModel(classId, this.weaponId);
    this._heldMode = 'weapon';
    if (wasBuild) this.setHeldMode('build');
    const wpn = global.VF.game && global.VF.game.weapons;
    if (wpn && wpn._restyleGun) wpn._restyleGun(wpn.current);
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
    const world = this.world;
    const spawn = world.getSpawnPosition();
    this.object.position.copy(spawn);
    this.velocity.set(0, 0, 0);
    this._viewY = null;
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

  /** Push feet out of solid voxels after spawn / bad landings.
   *  maxR limits how far the search walks — keep it small during live
   *  movement so a corner clip cannot teleport the camera across the lot. */
  Player.prototype.unstuckFromWorld = function (maxR) {
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
    const rMax = maxR != null ? maxR : 28;
    for (let r = 1; r <= rMax; r++) {
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
    if (rMax < 8) {
      // Live-move rescue failed nearby — don't lift 24m into the sky.
      this.velocity.x = 0;
      this.velocity.z = 0;
      return;
    }
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
    this._adsPos = adsPosFromHip(this._hipPos);
    return root;
  };

  Player.prototype._bindInput = function () {
    const self = this;

    document.addEventListener('keydown', (e) => {
      self.keys[e.code] = true;
      if (e.key === 'f' || e.key === 'F') self.keys['KeyF'] = true;
      if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
      if (e.code === 'ControlLeft' || e.code === 'ControlRight') e.preventDefault();
      if (e.code === 'KeyC' && self.locked) e.preventDefault();
    });
    document.addEventListener('keyup', (e) => {
      self.keys[e.code] = false;
      if (e.key === 'f' || e.key === 'F') self.keys['KeyF'] = false;
    });

    document.addEventListener('mousemove', (e) => {
      if (!self.locked) return;
      if (self._inspecting) return;
      if (self._lookIgnoreUntil && performance.now() < self._lookIgnoreUntil) return;
      const mx0 = e.movementX || 0;
      const my0 = e.movementY || 0;
      // Pointer-lock (re)acquire, alt-tab and compositor hitches inject huge
      // one-frame deltas that snap the camera. Drop true warps, clamp the rest.
      if (mx0 * mx0 + my0 * my0 > LOOK_WARP_PX2) return;
      const mx = mx0 > LOOK_CLAMP_PX ? LOOK_CLAMP_PX : mx0 < -LOOK_CLAMP_PX ? -LOOK_CLAMP_PX : mx0;
      const my = my0 > LOOK_CLAMP_PX ? LOOK_CLAMP_PX : my0 < -LOOK_CLAMP_PX ? -LOOK_CLAMP_PX : my0;
      const camFeel = feelGroup('camera');
      let sens = camFeel.mouseSens != null ? camFeel.mouseSens : MOUSE_SENS;
      const adsT = Math.max(0, Math.min(1, self._adsBlend || 0));
      const def = self._weaponDef && self._weaponDef();
      let adsMul = ADS_SENS / MOUSE_SENS;
      if (def && def.adsSens != null) adsMul = def.adsSens;
      else if (camFeel.adsSens != null && (camFeel.mouseSens || MOUSE_SENS)) {
        adsMul = camFeel.adsSens / (camFeel.mouseSens != null ? camFeel.mouseSens : MOUSE_SENS);
      }
      sens *= 1 - adsT * (1 - adsMul);
      if (global.VF.Throwables && global.VF.Throwables.lookMul) {
        sens *= global.VF.Throwables.lookMul();
      }
      const yawD = -mx * sens;
      const pitchD = -my * sens;
      self.yaw += yawD;
      self.pitch += pitchD;
      self.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, self.pitch));
      self._lookDx = (self._lookDx || 0) + yawD;
      self._lookDy = (self._lookDy || 0) + pitchD;
    });

    document.addEventListener('mousedown', (e) => {
      if (!self.locked) return;
      if (self._inspecting) return;
      if (e.button === 2) {
        const wdef = self._weaponDef && self._weaponDef();
        if (!(wdef && wdef.melee)) {
          self.keys['Mouse2'] = true;
          self.aiming = true;
        }
      }
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 2) {
        self.keys['Mouse2'] = false;
        self.aiming = false;
      }
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
  };

  Player.prototype.setPointerLock = function (locked) {
    this.locked = locked;
    if (!locked) this.aiming = false;
    else this._lookIgnoreUntil = performance.now() + 80;
  };

  Player.prototype.getEyeHeight = function () {
    const stand = THREE.MathUtils.lerp(EYE_HEIGHT, EYE_CROUCH, this._crouchBlend || 0);
    if (!this.dead) return stand;
    const target = 0.34;
    const b = this._deathBlend == null ? 1 : this._deathBlend;
    const from = this._deathEyeFrom != null ? this._deathEyeFrom : stand;
    return THREE.MathUtils.lerp(from, target, b);
  };

  Player.prototype.getBodyHeight = function () {
    return THREE.MathUtils.lerp(PLAYER_HEIGHT, PLAYER_CROUCH_HEIGHT, this._crouchBlend || 0);
  };

  Player.prototype.getEyePosition = function () {
    return this.object.position.clone().add(new THREE.Vector3(0, this.getEyeHeight(), 0));
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

  Player.prototype._resetCrouchStance = function () {
    this.crouching = false;
    this._crouchToggle = false;
    this.slide = false;
    this._slideT = 0;
    this._slideDx = 0;
    this._slideDz = 0;
  };

  /**
   * COD MW stance:
   *   C tap     → toggle crouch (sprint + C → slide)
   *   Ctrl hold → crouch while held; release stands if not toggled
   *   Shift     → sprint; standing sprint + crouch = slide; sprint cancels toggle-crouch
   * Slide ends crouched. Low ceiling blocks stand.
   */
  Player.prototype._tryBeginSlide = function () {
    const pm = feelGroup('playerMove');
    if (!this.onGround || this.slide || this.zipRide) return false;
    let dx = this.velocity.x;
    let dz = this.velocity.z;
    let len = Math.hypot(dx, dz);
    if (len < 0.4) {
      dx = -Math.sin(this.yaw);
      dz = -Math.cos(this.yaw);
      len = 1;
    }
    this.slide = true;
    this._slideT = pm.slideDur != null ? pm.slideDur : SLIDE_DUR;
    this._slideDx = dx / len;
    this._slideDz = dz / len;
    this.crouching = true;
    this._crouchToggle = true;
    if (this.punchFeedback) this.punchFeedback({ shake: 0.07, pitch: 0.04 });
    return true;
  };

  Player.prototype._endSlide = function (keepCrouch) {
    this.slide = false;
    this._slideT = 0;
    this._slideCool = SLIDE_COOL;
    if (keepCrouch === false) {
      if (this._canStand()) {
        this.crouching = false;
        this._crouchToggle = false;
      }
    } else {
      this.crouching = true;
      this._crouchToggle = true;
    }
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
      this._camRoll || 0,
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

    const spring = recovering
      ? v.recoverSpring != null
        ? v.recoverSpring
        : 90
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

  Player.prototype.applyRecoil = function (amount) {
    const v = feelGroup('view');
    const g = feelGroup('gun');
    this._recoilIdleTimer = 0;
    // Recoverable view punch (mouse pitch/yaw stay put)
    const pitchMul = v.pitchMul != null ? v.pitchMul : 0.55;
    const velMul = v.velMul != null ? v.velMul : 22;
    const yawMul = v.yawMul != null ? v.yawMul : 0.34;
    this._viewPunchPitch = (this._viewPunchPitch || 0) + amount * pitchMul;
    this._viewPunchPitchVel = (this._viewPunchPitchVel || 0) + amount * velMul;
    const yawJitter = (Math.random() - 0.5) * amount * yawMul;
    this._viewPunchYaw = (this._viewPunchYaw || 0) + yawJitter;
    this._viewPunchYawVel = (this._viewPunchYawVel || 0) + yawJitter * 12;
    // Gun kick (separate spring)
    this._recoilVel = (this._recoilVel || 0) + amount * (g.velMul != null ? g.velMul : 38);
    const kickMul = g.kickMul != null ? g.kickMul : 3.4;
    const kickMax = g.kickMax != null ? g.kickMax : 0.85;
    this._recoilKick = Math.min(kickMax, (this._recoilKick || 0) + amount * kickMul);
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
    const adsHold = 1 - Math.max(0, Math.min(1, this._adsBlend || 0));
    this.gunNode.rotation.x = rest.rx * adsHold + kick * posePitch + rack;
    this.gunNode.rotation.y = rest.ry * adsHold;
    this.gunNode.rotation.z = rest.rz * adsHold + kick * poseRoll;
    this.gunNode.position.x = rest.x;
    this.gunNode.position.y = rest.y + kick * poseY - rack * 0.04;
    this.gunNode.position.z = rest.z - kick * poseZ;
  };

  /** Lock look-over after bob / recoil: X on midline, gun top just under the +. */
  Player.prototype._alignViewmodelSight = function (blend) {
    const vm = this.viewModel;
    const cam = this.camera;
    if (this._adsLookOver === false) return;
    if (!vm || !cam || !this.gunNode || !(blend > 0.01)) return;
    vm.updateMatrixWorld(true);
    let sight = this._adsSight;
    if (sight && !sight.parent) {
      sight = this._adsSight = findAdsSight(this.gunNode);
    }
    const st = pickAdsScreen(cam, this.gunNode, sight);
    if (!st.ok) return;
    vm.position.x -= st.cx * blend;
    vm.position.y += adsLookOverDeltaY(cam, st) * blend;
  };

  /**
   * Look-over ADS centres the gun and would drag the camo sleeves into both
   * sides of the frame. Fade those sleeves, but keep the grip hands and aim
   * the skin forearms at them so the gun is held from below — not a floating
   * palm with no wrist.
   */
  Player.prototype._applyAdsArmTuck = function (blend) {
    const skip =
      this._heldMode === 'build' ||
      this._inspecting ||
      (global.VF.Throwables && global.VF.Throwables.busy && global.VF.Throwables.busy()) ||
      (this._weaponDef && this._weaponDef() && this._weaponDef().melee);
    const b = skip || this._adsLookOver === false ? 0 : Math.max(0, Math.min(1, blend || 0));
    const oneHanded = !!this._hideLeftArm;
    const vm = this.viewModel;

    const restPos = function (node) {
      if (!node.userData._adsHandRest) node.userData._adsHandRest = node.position.clone();
      return node.userData._adsHandRest;
    };
    const restPose = function (node) {
      if (!node.userData._adsPoseRest) {
        node.userData._adsPoseRest = {
          x: node.position.x,
          y: node.position.y,
          z: node.position.z,
          rx: node.rotation.x,
          ry: node.rotation.y,
          rz: node.rotation.z,
        };
      }
      return node.userData._adsPoseRest;
    };
    const fadeSleeve = function (arm, allow) {
      if (!arm) return;
      const sleeve =
        arm.getObjectByName('ViewRightSleeve') || arm.getObjectByName('ViewLeftSleeve');
      if (!sleeve) return;
      const s = allow ? Math.max(0.04, 1 - b) : 1;
      sleeve.scale.setScalar(s);
      sleeve.visible = !allow || s > 0.14;
    };
    const setForeScale = function (arm, s) {
      if (!arm) return;
      const fore =
        arm.getObjectByName('ViewRightForearm') || arm.getObjectByName('ViewLeftForearm');
      if (fore) fore.scale.setScalar(s);
    };
    const poseHand = function (node, visible) {
      if (!node) return;
      node.position.copy(restPos(node));
      node.scale.setScalar(skip ? 1 : 1 - b * 0.18);
      if (visible != null) node.visible = visible;
    };
    // Wrist box sits at local ~-Y on the arm; rotate from below then park
    // that point on the gun-parented hand. Drop a bit more so the limb
    // leaves the bottom of the frame instead of sitting as a slab.
    const attachArm = function (arm, hand, wristLocal, allow, freeze) {
      if (!arm) return;
      const rest = restPose(arm);
      if (freeze) {
        setForeScale(arm, 1);
        return;
      }
      if (!allow || !(b > 0.01) || !hand || !vm) {
        arm.position.set(rest.x, rest.y, rest.z);
        arm.rotation.set(rest.rx, rest.ry, rest.rz);
        arm.scale.setScalar(1);
        setForeScale(arm, 1);
        return;
      }
      arm.visible = true;
      arm.scale.setScalar(1);
      const rx = rest.rx + (1.12 - rest.rx) * b;
      const ry = rest.ry * (1 - 0.45 * b);
      const rz = rest.rz * (1 - 0.4 * b);
      arm.rotation.set(rx, ry, rz);
      vm.updateMatrixWorld(true);
      hand.updateWorldMatrix(true);
      hand.getWorldPosition(_adsWorld);
      vm.worldToLocal(_adsWorld);
      _adsArmWrist.copy(wristLocal).applyEuler(arm.rotation);
      _adsTmp.set(rest.x, rest.y, rest.z);
      arm.position.lerpVectors(_adsTmp, _adsWorld.sub(_adsArmWrist), b);
      arm.position.y -= 0.07 * b;
      setForeScale(arm, 1 - 0.28 * b);
    };

    fadeSleeve(this.rightArm, !skip);
    fadeSleeve(this.leftArm, !skip && !oneHanded);

    poseHand(this._viewRightHand, skip ? null : true);
    if (oneHanded) poseHand(this._viewLeftHand, false);
    else poseHand(this._viewLeftHand, skip ? null : true);

    const weapons = global.VF.game && global.VF.game.weapons;
    const reloading = !!(weapons && weapons.getReloadAnim && weapons.getReloadAnim() > 0.05);
    attachArm(this.rightArm, this._viewRightHand, ADS_WRIST_R, !skip, skip);
    attachArm(
      this.leftArm,
      this._viewLeftHand,
      ADS_WRIST_L,
      !skip && !oneHanded,
      skip || reloading
    );
    if (oneHanded && this.leftArm && !skip) this.leftArm.visible = false;
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
   * @param {object|string|null} [attacker]
   * @param {{headshot?:boolean, weaponId?:string}} [opts] 枪械模式需要知道这一枪是不是
   *   爆头（决定降级）以及用的哪把武器（决定击杀方能否升级）。
   */
  Player.prototype.takeDamage = function (amount, fromPos, attacker, opts) {
    if (this.dead || !this.alive) return false;
    // die() 在本函数末尾才被调用，先把这一枪的性质记下来交给结算。
    this._lastHitInfo = opts || null;
    // 死斗 spawn protection: drops the moment the player fires (see weapons.js).
    // The prep phase is covered too, so nobody can be killed before the start.
    const tdmGate = global.VF.TdmMatch;
    const ggGate = global.VF.GgMatch;
    if (
      this.spawnProtect > 0 ||
      (tdmGate && tdmGate.active && !tdmGate.ended && !tdmGate.scoringLive()) ||
      (ggGate && ggGate.active && !ggGate.ended && !ggGate.scoringLive())
    ) {
      if (global.VF.UI) global.VF.UI.updateVitals(this.health, this.armor);
      return true;
    }
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
    if (!(opts && opts.ignoreArmor) && this.armor > 0 && dmg > 0) {
      const absorb = Math.min(this.armor, dmg * 0.55);
      this.armor -= absorb;
      dmg -= absorb;
    }
    this.health = Math.max(0, this.health - dmg);

    const tdm = global.VF.TdmMatch;
    if (tdm && tdm.scoringLive()) tdm.registerDamage(this, dmg, attacker);
    const sdStats = global.VF.SdStats;
    if (sdStats && sdStats.live()) sdStats.registerDamage(this, dmg, attacker);

    this._applyHurtFeedback(felt, fromPos);

    if (global.VF.UI) {
      global.VF.UI.updateVitals(this.health, this.armor);
    }
    if (this.health <= 0) {
      this.die(attacker);
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

  Player.prototype.die = function (attacker) {
    if (this.dead) return;
    const eyeFrom = this.getEyeHeight();
    this.dead = true;
    this.alive = false;
    this.health = 0;
    this.spawnProtect = 0;
    if (global.VF.Career && global.VF.Career.noteDeath) global.VF.Career.noteDeath();

    const tdm = global.VF.TdmMatch;
    const ffa = global.VF.FfaMatch;
    const gg = global.VF.GgMatch;
    const hit = this._lastHitInfo || null;
    this._lastHitInfo = null;
    if (tdm && tdm.scoringLive()) {
      tdm.registerKill({
        victim: this,
        killer: attacker || null,
        maxHp: this.maxHealth || 100,
      });
    }
    if (ffa && ffa.scoringLive()) {
      ffa.registerKill({
        victim: this,
        killer: attacker || null,
        maxHp: this.maxHealth || 100,
      });
    }
    if (gg && gg.scoringLive()) {
      gg.registerKill({
        victim: this,
        killer: attacker || null,
        headshot: !!(hit && hit.headshot),
        weaponId: (hit && hit.weaponId) || null,
        maxHp: this.maxHealth || 100,
      });
    }
    if (global.VF.SdStats && global.VF.SdStats.live()) {
      global.VF.SdStats.registerKill({
        victim: this,
        killer: attacker || null,
        maxHp: this.maxHealth || 100,
      });
    }
    if (global.VF.TdmSpawn && tdm && tdm.isRunning()) {
      global.VF.TdmSpawn.onPlayerDeath();
    }
    // 枪械模式复用 自由混战 的复活选点
    if (global.VF.FfaSpawn && ((ffa && ffa.isRunning()) || (gg && gg.isRunning()))) {
      global.VF.FfaSpawn.onPlayerDeath();
    }
    this.velocity.set(0, 0, 0);
    this.zipRide = null;
    this.aiming = false;
    this._resetCrouchStance();
    if (global.VF.game && global.VF.game.skills && global.VF.game.skills._clearStealth) {
      global.VF.game.skills._clearStealth(true);
    }
    if (global.VF.game && global.VF.game.skills && global.VF.game.skills._clearRiotShield) {
      global.VF.game.skills._clearRiotShield(true);
    }
    if (global.VF.game && global.VF.game.weapons && global.VF.game.weapons._cancelReload) {
      global.VF.game.weapons._cancelReload();
    }
    if (global.VF.Throwables && global.VF.Throwables.onPlayerDeath) {
      global.VF.Throwables.onPlayerDeath();
    }
    if (global.VF.Audio) {
      global.VF.Audio.play('death');
    }
    this._deathEyeFrom = eyeFrom;
    this._deathBlend = 0;
    this._hideViewModels(true);
    if (global.VF.game) global.VF.game.running = false;

    // PVP: sync death to opponent (no longer ends the match)
    if (
      global.VF.game &&
      global.VF.game.mode === 'pvp' &&
      global.VF.Pvp &&
      global.VF.Pvp.reportLocalDeath
    ) {
      global.VF.Pvp.reportLocalDeath(attacker);
    }

    // 枪械模式: 这一刀可能同时是对手的通关击杀，那样 GgUi 已经弹出结算面板了，
    // 别再往上盖一层阵亡界面。
    const ggFinished = !!(gg && gg.active && gg.ended);
    if (global.VF.UI && global.VF.UI.showDeath && !ggFinished) {
      const sd = global.VF.SdMatch;
      if (tdm && tdm.isRunning()) {
        global.VF.UI.showDeath('你已阵亡', '系统正在挑选安全出生区', '稍后自动重新投放', {
          autoRespawn: true,
        });
      } else if (ffa && ffa.isRunning()) {
        // Name the killer to feed the design's 个人恩怨 / 复仇 loop.
        const foe = attacker && attacker.name ? attacker.name : null;
        global.VF.UI.showDeath(
          '你已阵亡',
          foe ? '被 ' + foe + ' 击杀' : '混战阵亡',
          '系统正在挑选最空旷的角落',
          { autoRespawn: true }
        );
      } else if (gg && gg.isRunning()) {
        const me = gg.playerStats();
        const foe = attacker && attacker.name ? attacker.name : null;
        global.VF.UI.showDeath(
          '你已阵亡',
          foe ? '被 ' + foe + ' 击杀' : '混战阵亡',
          me ? '当前 Lv' + me.level + ' · ' + gg.labelAt(me.level) : '系统正在挑选出生点',
          { autoRespawn: true }
        );
      } else if (sd && sd.isRunning()) {
        // 爆破 单命制: no mid-round redeploy — spectate until the next round.
        global.VF.UI.showDeath('你已阵亡', '本回合单命制 · 观战至下回合', '下回合开始时自动重新投放', {
          autoRespawn: true,
        });
      } else {
        global.VF.UI.showDeath('你已阵亡', '血量耗尽 · 等待重新部署', '选个出生点再上！');
      }
    }
  };

  /** Revive after death redeploy (keeps class / inventory). */
  Player.prototype.respawn = function () {
    this.dead = false;
    this.alive = true;
    this._deathBlend = 0;
    this._deathEyeFrom = null;
    this._hideViewModels(false);
    this.health = this.maxHealth || 100;
    this.armor = Math.min(this.maxArmor || 100, 50);
    this.velocity.set(0, 0, 0);
    this._viewY = null;
    this.zipRide = null;
    this.aiming = false;
    this._resetCrouchStance();
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
    const wpn = global.VF.game && global.VF.game.weapons;
    if (wpn && wpn.resetAmmo) wpn.resetAmmo();
    if (global.VF.Throwables && global.VF.Throwables.refill) {
      global.VF.Throwables.refill();
    }
  };

  Player.prototype._hideViewModels = function (hide) {
    const nodes = [this.viewModel, this._weaponViewModel, this.buildViewModel];
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i]) nodes[i].visible = !hide;
    }
  };

  Player.prototype._updateDeadCam = function (dt) {
    if (this._inspecting) {
      if (this.updateWeaponInspect) this.updateWeaponInspect(dt);
      return;
    }
    this._deathBlend = Math.min(1, (this._deathBlend || 0) + dt / 0.36);
    this.aiming = false;
    this._adsBlend = expSmooth(this._adsBlend || 0, 0, 8, dt);
    this._hideViewModels(true);
    this._updateViewPunch(dt);
    this._syncCameraLook();
    const eye = this.getEyePosition();
    this.camera.position.set(eye.x, eye.y, eye.z);
    if (this.camera.fov !== HIP_FOV) {
      this.camera.fov = HIP_FOV;
      this.camera.updateProjectionMatrix();
    }
  };

  Player.prototype.update = function (dt) {
    if (this.dead) {
      this._updateDeadCam(dt);
      return;
    }

    if (this.spawnProtect > 0) {
      // 复活保护：站定即维持无敌；一旦移动/跳跃即刻取消（开火取消见 weapons.js）
      const moved =
        this.keys['KeyW'] ||
        this.keys['KeyS'] ||
        this.keys['KeyA'] ||
        this.keys['KeyD'] ||
        this.keys['Space'];
      this.spawnProtect = moved ? 0 : Math.max(0, this.spawnProtect - dt);
    }

    this._updateViewPunch(dt);
    this._syncCameraLook();

    const frozen =
      global.VF.GameModes && global.VF.GameModes.prepFrozen && global.VF.GameModes.prepFrozen();

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
        this._ctrlWas = !!(this.keys['ControlLeft'] || this.keys['ControlRight']);
        this._cWas = !!this.keys['KeyC'];
        this._shiftWas = !!(this.keys['ShiftLeft'] || this.keys['ShiftRight']);
        const eye = this.getEyePosition();
        this.camera.position.set(eye.x, eye.y, eye.z);
        this.camera.fov = HIP_FOV;
        this.camera.updateProjectionMatrix();
        return;
      }
    } else if (!frozen && fDown && this._zipCool <= 0) {
      const ok = this._tryStartZipline();
      if (!ok) this._zipCool = 0.18;
    }
    this._zipKeyWasDown = fDown;
    this._zipJumpWasDown = jumpDown;

    const ctrlDown =
      !frozen && !!(this.keys['ControlLeft'] || this.keys['ControlRight']);
    const cDown = !frozen && !!this.keys['KeyC'];
    const ctrlPressed = ctrlDown && !this._ctrlWas;
    const cPressed = cDown && !this._cWas;
    this._ctrlWas = ctrlDown;
    this._cWas = cDown;
    if (this._slideCool > 0) this._slideCool = Math.max(0, this._slideCool - dt);

    // Movement input
    const forward = frozen ? 0 : this.keys['KeyW'] ? 1 : 0;
    const back = frozen ? 0 : this.keys['KeyS'] ? 1 : 0;
    const left = frozen ? 0 : this.keys['KeyA'] ? 1 : 0;
    const right = frozen ? 0 : this.keys['KeyD'] ? 1 : 0;
    this.direction.set(right - left, 0, back - forward);
    if (this.direction.lengthSq() > 0) this.direction.normalize();

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const mx = this.direction.x * cos + this.direction.z * sin;
    const mz = -this.direction.x * sin + this.direction.z * cos;

    const shiftDown = !frozen && !!(this.keys['ShiftLeft'] || this.keys['ShiftRight']);
    const shiftPressed = shiftDown && !this._shiftWas;
    this._shiftWas = shiftDown;
    const dashing = global.VF.game && global.VF.game.skills && global.VF.game.skills.dash;
    if (dashing && this.slide) this._endSlide(false);
    if (frozen && this.slide) this._endSlide(true);

    if (!this.slide && !this.zipRide && !frozen && !dashing) {
      const moving = this.direction.lengthSq() > 0;
      const fastEnough = Math.hypot(this.velocity.x, this.velocity.z) > 2;
      const canSlide =
        this.onGround &&
        shiftDown &&
        !this.crouching &&
        !this.aiming &&
        this._slideCool <= 0 &&
        (moving || fastEnough);
      if ((ctrlPressed || cPressed) && canSlide && this._tryBeginSlide()) {
        // sprint + crouch → slide
      } else {
        if (cPressed) {
          if (ctrlDown) {
            this._crouchToggle = true;
          } else if (this._crouchToggle || this.crouching) {
            if (this._canStand()) {
              this._crouchToggle = false;
              this.crouching = false;
            }
          } else {
            this._crouchToggle = true;
          }
        }
        if (ctrlDown) this.crouching = true;
        else if (this._crouchToggle) this.crouching = true;
        else if (this.crouching && this._canStand()) this.crouching = false;

        if (shiftPressed && !ctrlDown && this.crouching && this._canStand()) {
          this.crouching = false;
          this._crouchToggle = false;
        }
      }
    }

    const crouchTarget = this.slide || this.crouching ? 1 : 0;
    this._crouchBlend += (crouchTarget - this._crouchBlend) * Math.min(1, dt * 14);

    const sprint = !frozen && !this.crouching && !this.slide && shiftDown;

    const pm = feelGroup('playerMove');
    const baseSpeed = pm.moveSpeed != null ? pm.moveSpeed : MOVE_SPEED;
    const adsMul = pm.adsMul != null ? pm.adsMul : 0.55;
    const crouchMul = pm.crouchMul != null ? pm.crouchMul : CROUCH_SPEED_MULT;
    const slideMul = pm.slideMul != null ? pm.slideMul : SLIDE_MULT;
    const feelSprintMul = pm.sprintMul != null ? pm.sprintMul : SPRINT_MULT;
    let speedMul = this.aiming ? adsMul : 1;
    if (this.slide) speedMul = slideMul;
    else if (this.crouching) speedMul *= crouchMul;
    else if (sprint && !this.aiming) speedMul *= feelSprintMul;
    if (this.skillSpeedBuffTimer > 0) {
      speedMul *= this.skillSpeedBuffMul || 1.2;
    }
    if (global.VF.Throwables && global.VF.Throwables.moveMul) {
      speedMul *= global.VF.Throwables.moveMul();
    }
    const heldDef = this._weaponDef && this._weaponDef();
    if (heldDef && heldDef.melee && !this.aiming && !this.slide) {
      speedMul *= sprint
        ? heldDef.sprintSpeedMul != null
          ? heldDef.sprintSpeedMul
          : 1.18
        : heldDef.moveSpeedMul != null
          ? heldDef.moveSpeedMul
          : 1.12;
    }
    if (dashing) {
      this.velocity.x = 0;
      this.velocity.y = 0;
      this.velocity.z = 0;
    } else if (this.slide) {
      const slideSpeed = baseSpeed * slideMul;
      this.velocity.x = this._slideDx * slideSpeed;
      this.velocity.z = this._slideDz * slideSpeed;
    } else {
      const speed = baseSpeed * speedMul;
      this.velocity.x = mx * speed;
      this.velocity.z = mz * speed;
    }

    // Jump + gravity (jump exits crouch / cancels slide when headroom allows)
    if (!dashing) {
      if (this.onGround && this.keys['Space'] && !frozen) {
        if (this.slide) this._endSlide(true);
        if (this.crouching) {
          if (this._canStand()) {
            this.crouching = false;
            this._crouchToggle = false;
          }
        }
        if (!this.crouching && !this.slide) {
          this.velocity.y = JUMP_VEL;
          this.onGround = false;
          if (global.VF.Audio) global.VF.Audio.play('jump');
        }
      }
      this.velocity.y -= GRAVITY * dt;
    }

    const slideX = this.object.position.x;
    const slideZ = this.object.position.z;
    this._moveWithCollision(dt);
    if (this.slide) {
      const moved = Math.hypot(this.object.position.x - slideX, this.object.position.z - slideZ);
      this._slideT -= dt;
      if (this._slideT <= 0 || moved < 0.5 * dt) this._endSlide(true);
    }

    if (this._overlaps && this._overlaps() && this.direction.lengthSq() > 0) {
      this._stuckMoveT = (this._stuckMoveT || 0) + dt;
      if (this._stuckMoveT > 0.2) {
        this.unstuckFromWorld(4);
        this._stuckMoveT = 0;
      }
    } else {
      this._stuckMoveT = 0;
    }

    // Sync camera to eye
    const eye = this.getEyePosition();
    // Head bob
    const moving = this.direction.lengthSq() > 0 && this.onGround && !this.slide;
    if (moving) this._bobTime += dt * (this.crouching ? 7 : sprint ? 12 : 9);
    const bob = moving ? Math.sin(this._bobTime) * (this.crouching ? 0.018 : 0.035) : 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    if (global.VF.Throwables && global.VF.Throwables.stunShake) {
      const stunSh = global.VF.Throwables.stunShake();
      if (stunSh > 0) this._shake = Math.max(this._shake || 0, stunSh);
    }
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
    this._applySmoothedEyeCam(eye, dt, bob, sx, sy, sz);

    // ADS / held-item base pose (no ADS while reloading)
    const weapons = global.VF.game && global.VF.game.weapons;
    const reloadW = weapons && weapons.getReloadAnim ? weapons.getReloadAnim() : 0;
    const held = this._weaponDef && this._weaponDef();
    const throwBusy = global.VF.Throwables && global.VF.Throwables.busy && global.VF.Throwables.busy();
    if (held && held.melee) this.aiming = false;
    if (throwBusy) this.aiming = false;
    const adsTarget =
      this.aiming && this._heldMode !== 'build' && reloadW < 0.05 && !(held && held.melee) && !throwBusy
        ? 1
        : 0;
    const adsTime = held && held.adsTime != null ? held.adsTime : 0.22;
    const camFeel = feelGroup('camera');
    const adsBlendIn =
      camFeel.adsBlendIn != null ? camFeel.adsBlendIn : 3 / Math.max(0.08, adsTime);
    const adsBlendOut =
      camFeel.adsBlendOut != null ? camFeel.adsBlendOut : adsBlendIn * 0.72;
    this._adsBlend = expSmooth(
      this._adsBlend || 0,
      adsTarget,
      adsTarget ? adsBlendIn : adsBlendOut,
      dt
    );

    const lookX = this._lookDx || 0;
    const lookY = this._lookDy || 0;
    this._lookDx = 0;
    this._lookDy = 0;
    const lx = THREE.MathUtils.clamp(lookX, -0.12, 0.12);
    const ly = THREE.MathUtils.clamp(lookY, -0.12, 0.12);
    const adsLoose = 1 - (this._adsBlend || 0);
    const strafe = this.direction ? this.direction.x : 0;
    if (!this._lookSwayPos) this._lookSwayPos = new THREE.Vector3();
    if (!this._lookSwayRot) this._lookSwayRot = new THREE.Vector3();
    this._lookSwayPos.x = expSmooth(this._lookSwayPos.x, lx * 0.5 * adsLoose, 10, dt);
    this._lookSwayPos.y = expSmooth(this._lookSwayPos.y, ly * 0.35 * adsLoose, 10, dt);
    this._lookSwayRot.y = expSmooth(this._lookSwayRot.y, lx * 1.4 * adsLoose, 10, dt);
    this._lookSwayRot.x = expSmooth(this._lookSwayRot.x, ly * 0.9 * adsLoose, 10, dt);
    this._lookSwayRot.z = expSmooth(
      this._lookSwayRot.z,
      (-lx * 1.8 - strafe * 0.06) * adsLoose,
      8,
      dt
    );
    const rollTarget = -strafe * (camFeel.camRoll != null ? camFeel.camRoll : 0.022) + (this.slide ? -0.08 : 0);
    this._camRoll = expSmooth(this._camRoll || 0, this.dead ? 0 : rollTarget, 9, dt);

    // Run sway: gun follows footsteps (side + vertical + light roll)
    const wantSway = moving && reloadW < 0.2 ? 1 : 0;
    this._swayBlend += (wantSway - (this._swayBlend || 0)) * Math.min(1, dt * (moving ? 10 : 7));
    const sway = this._swayBlend || 0;
    const adsDamp = adsLoose;
    const sprintMul = sprint && !this.aiming ? 1.4 : this.crouching || this.slide ? 0.55 : 1;
    const t = this._bobTime;
    const crouchDip = (this._crouchBlend || 0) * 0.14;
    const ax = Math.sin(t) * 0.032 * sway * sprintMul * adsDamp + this._lookSwayPos.x;
    const ay =
      -Math.abs(Math.sin(t)) * 0.026 * sway * sprintMul * adsDamp - crouchDip * adsLoose + this._lookSwayPos.y;
    const az = Math.cos(t) * 0.014 * sway * adsDamp;
    const rRoll = Math.sin(t) * 0.055 * sway * sprintMul * adsDamp + this._lookSwayRot.z;
    const rPitch =
      Math.cos(t * 2) * 0.03 * sway * adsDamp +
      (this._crouchBlend || 0) * 0.08 +
      this._lookSwayRot.x;
    const rYaw = Math.sin(t * 0.5) * 0.02 * sway * adsDamp + this._lookSwayRot.y;

    // Reload: tilt gun down/right, dip viewmodel
    const rl = reloadW;
    const rlDipY = -0.22 * rl;
    const rlPullZ = 0.12 * rl;
    const rlSideX = 0.1 * rl;
    const rlPitch = 0.55 * rl;
    const rlYaw = -0.35 * rl;
    const rlRoll = 0.28 * rl;

    const gFeel = feelGroup('gun');
    const equipRate = gFeel.equipRate != null ? gFeel.equipRate : 3.2;
    this._equipT = Math.min(1, (this._equipT == null ? 1 : this._equipT) + dt * equipRate);
    const eq = this._equipRaise();
    const eqDip = (gFeel.equipDip != null ? gFeel.equipDip : 0.32) * eq;
    const eqPitch = (gFeel.equipPitch != null ? gFeel.equipPitch : 0.9) * eq;

    if (this.viewModel) {
      this._vmBase.lerpVectors(this._hipPos, this._adsPos, this._adsBlend);
      this.viewModel.position.set(
        this._vmBase.x + ax + rlSideX,
        this._vmBase.y + ay + rlDipY - eqDip,
        this._vmBase.z + az + rlPullZ
      );
      const rotMul = adsLoose;
      this.viewModel.rotation.set(
        (rPitch + rlPitch) * rotMul - eqPitch,
        (rYaw + rlYaw) * rotMul,
        (rRoll + rlRoll) * rotMul
      );
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

    // FOV first so look-over NDC uses the zoom we are about to draw (doodle
    // keeps FOV independent of the gun blend, but the silhouette still has
    // to stay under the + as the lens tightens).
    const def = this._weaponDef && this._weaponDef();
    const cam = feelGroup('camera');
    const hipFov = cam.hipFov != null ? cam.hipFov : HIP_FOV;
    const adsFov =
      def && def.adsFov != null ? def.adsFov : cam.adsFov != null ? cam.adsFov : ADS_FOV;
    const fovIn = cam.adsFovIn != null ? cam.adsFovIn : 16;
    const fovOut = cam.adsFovOut != null ? cam.adsFovOut : 8;
    const fovTarget = adsTarget ? adsFov : hipFov;
    if (this._adsFov == null) this._adsFov = hipFov;
    this._adsFov = expSmooth(this._adsFov, fovTarget, adsTarget ? fovIn : fovOut, dt);
    let targetFov = this._adsFov;
    if (this._fovPunch) {
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

    this._alignViewmodelSight(this._adsBlend || 0);
    this._applyAdsArmTuck(this._adsBlend || 0);

    // Hide held gun when throwing, or when looking through a sniper scope overlay
    if (throwBusy) {
      if (this.viewModel) this.viewModel.visible = false;
    } else if (this.viewModel && this._heldMode !== 'build') {
      const scope = def && def.scope;
      const hideGun = this._adsBlend > 0.78 && scope === 'sniper';
      this.viewModel.visible = !hideGun;
    }
  };

  /**
   * Match-end inspect: lift the gun into frame, yaw to show the side, dip the
   * camera slightly. Runs while the sim is frozen; click-to-skip lives in
   * VF.WeaponInspect.
   */
  Player.prototype.beginWeaponInspect = function () {
    this._inspecting = true;
    this._inspectT = 0;
    this.aiming = false;
    this._adsBlend = 0;
    this._adsFov = HIP_FOV;
    this._lookDx = 0;
    this._lookDy = 0;
    if (this._lookSwayPos) this._lookSwayPos.set(0, 0, 0);
    if (this._lookSwayRot) this._lookSwayRot.set(0, 0, 0);
    this._camRoll = 0;
    this._viewY = null;
    this._recoilKick = 0;
    this._recoilVel = 0;
    this._viewPunchPitch = 0;
    this._viewPunchYaw = 0;
    this._viewPunchPitchVel = 0;
    this._viewPunchYawVel = 0;
    this._fovPunch = 0;
    this._shake = 0;
    this._resetCrouchStance();
    this._inspectPitch = 0;
    this._inspectYaw = 0;
    this._inspectRoll = 0;
    this._inspectStartFov = this.camera && this.camera.fov != null ? this.camera.fov : HIP_FOV;
    this._inspectHip = this._hipPos
      ? this._hipPos.clone()
      : new THREE.Vector3(0.3, -0.34, -0.52);

    const g = global.VF.game;
    if (global.VF.Throwables && global.VF.Throwables._abortPose) {
      global.VF.Throwables._abortPose();
    }
    if (g && g.building && g.building.active && g.building.exitMode) {
      g.building.exitMode();
    }
    if (this.setHeldMode) this.setHeldMode('weapon');
    if (g && g.weapons) {
      g.weapons.mode = 'weapon';
      g.weapons.firing = false;
      if (g.weapons._cancelReload) g.weapons._cancelReload();
    }
    if (global.VF.UI && global.VF.UI.hideDeath) global.VF.UI.hideDeath();
    this._hideViewModels(false);
    if (this.viewModel) this.viewModel.visible = true;

    if (this.gunNode && !this._gunRest) {
      this._gunRest = {
        x: this.gunNode.position.x,
        y: this.gunNode.position.y,
        z: this.gunNode.position.z,
        rx: this.gunNode.rotation.x,
        ry: this.gunNode.rotation.y,
        rz: this.gunNode.rotation.z,
      };
    }
    if (this.leftArm && !this._leftArmRest) {
      this._leftArmRest = {
        y: this.leftArm.position.y,
        z: this.leftArm.position.z,
        rx: this.leftArm.rotation.x,
        rz: this.leftArm.rotation.z,
      };
    }
  };

  Player.prototype.updateWeaponInspect = function (dt) {
    if (!this._inspecting || !this.camera) return;
    this._inspectT = (this._inspectT || 0) + (dt > 0 ? dt : 0);
    const t = this._inspectT;

    this._crouchBlend = Math.max(0, (this._crouchBlend || 0) - dt * 4);
    if (this.dead) {
      this._deathBlend = Math.max(0, (this._deathBlend || 0) - dt * 1.6);
    }

    const raise = Math.min(1, t / 0.42);
    const e = raise * raise * (3 - 2 * raise);
    const hold = Math.min(1, Math.max(0, (t - 0.28) / 1.55));
    const he = hold * hold * (3 - 2 * hold);
    const swayX = Math.sin(t * 1.55) * 0.007;
    const swayY = Math.cos(t * 1.12) * 0.005;

    const held = this._weaponDef && this._weaponDef();
    const melee = !!(held && held.melee);
    const hip = this._inspectHip || this._hipPos || new THREE.Vector3(0.3, -0.34, -0.52);
    const tx = melee ? 0.12 : 0.12;
    const ty = melee ? -0.2 : -0.22;
    const tz = melee ? -0.5 : -0.56;

    if (this.viewModel) {
      this.viewModel.visible = true;
      this.viewModel.position.set(
        hip.x + (tx - hip.x) * e + swayX,
        hip.y + (ty - hip.y) * e + swayY,
        hip.z + (tz - hip.z) * e
      );
      const rx = 0.14 * e + 0.08 * he;
      const ry = (melee ? 1.05 : 0.92) * he + Math.sin(t * 0.7) * 0.024;
      const rz = 0.08 * e;
      this.viewModel.rotation.set(rx, ry, rz);
    }

    if (this.gunNode && this._gunRest) {
      this.gunNode.position.set(this._gunRest.x, this._gunRest.y, this._gunRest.z);
      this.gunNode.rotation.set(this._gunRest.rx, this._gunRest.ry, this._gunRest.rz);
    }
    if (this.leftArm && this._leftArmRest) {
      this.leftArm.rotation.x = this._leftArmRest.rx - 0.22 * he;
      this.leftArm.rotation.z = this._leftArmRest.rz + 0.18 * he;
      this.leftArm.position.y = this._leftArmRest.y - 0.02 * he;
      this.leftArm.position.z = this._leftArmRest.z + 0.03 * he;
    }

    this._inspectPitch = -0.04 * e - 0.02 * he;
    this._inspectYaw = 0.06 * he;
    this._inspectRoll = 0.025 * e;
    this.euler.set(
      this.pitch + this._inspectPitch,
      this.yaw + this._inspectYaw,
      this._inspectRoll,
      'YXZ'
    );
    this.camera.quaternion.setFromEuler(this.euler);

    const eye = this.getEyePosition();
    this.camera.position.set(eye.x, eye.y, eye.z);

    const fov = THREE.MathUtils.lerp(this._inspectStartFov || HIP_FOV, melee ? 64 : 62, e);
    if (Math.abs(this.camera.fov - fov) > 0.04) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    } else {
      this.camera.fov = fov;
    }
  };

  Player.prototype.endWeaponInspect = function () {
    this._inspecting = false;
    this._inspectPitch = 0;
    this._inspectYaw = 0;
    this._inspectRoll = 0;
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
   * How far to raise feet to stand on an overlapping stair tread (0 = none).
   * Lands on the tread instead of popping a full STEP_UP then falling back.
   */
  Player.prototype._stairStepLift = function () {
    if (!this.world.isStairVoxel) return 0;
    const hits = this.world.collideAABB(this._bodyBox());
    if (!hits.length) return 0;
    const pos = this.object.position;
    let lift = 0;
    for (let i = 0; i < hits.length; i++) {
      const b = hits[i];
      const sx = b.max.x - b.min.x;
      const sy = b.max.y - b.min.y;
      const sz = b.max.z - b.min.z;
      if (Math.abs(sx - 1) > 0.02 || Math.abs(sy - 1) > 0.02 || Math.abs(sz - 1) > 0.02) {
        continue;
      }
      const vx = Math.floor(b.min.x + 1e-6);
      const vy = Math.floor(b.min.y + 1e-6);
      const vz = Math.floor(b.min.z + 1e-6);
      if (!this.world.isStairVoxel(vx, vy, vz)) continue;
      const need = b.max.y - pos.y + 0.002;
      if (need > lift) lift = need;
    }
    if (lift <= 0.01 || lift > STEP_UP) return 0;
    return lift;
  };

  /** Hide 1m voxel-stair pops: follow eye Y with a short lag while grounded. */
  Player.prototype._applySmoothedEyeCam = function (eye, dt, bob, sx, sy, sz) {
    if (this._viewY == null || !isFinite(this._viewY)) this._viewY = eye.y;
    const air = !this.onGround || this.zipRide;
    const vy = this.velocity.y || 0;
    if (air && (vy > 1.6 || vy < -5 || this.zipRide)) {
      this._viewY = eye.y;
    } else {
      const cam = feelGroup('camera');
      const rate = cam.stairSmooth != null ? cam.stairSmooth : 18;
      this._viewY = expSmooth(this._viewY, eye.y, rate, dt);
      const maxLag = 0.42;
      if (this._viewY > eye.y + maxLag) this._viewY = eye.y + maxLag;
      if (this._viewY < eye.y - maxLag) this._viewY = eye.y - maxLag;
    }
    this.camera.position.set(eye.x + sx, this._viewY + bob + sy, eye.z + sz);
  };

  /** Horizontal move; auto step-up only onto stair voxels (cubes require jump) */
  Player.prototype._moveAxisWithStep = function (axis, delta) {
    if (Math.abs(delta) < 1e-8) return;
    const pos = this.object.position;
    const before = pos[axis];
    const beforeY = pos.y;
    pos[axis] += delta;
    if (!this._overlaps()) return;

    const lift = this._stairStepLift();
    if (lift > 0) {
      pos.y = beforeY + lift;
      if (!this._overlaps()) {
        this.velocity.y = 0;
        this.onGround = true;
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
    if (!hits.length) return;

    const radius = PLAYER_RADIUS;
    const height = this.getBodyHeight();
    const vel = this.velocity[axis];

    if (axis === 'y') {
      if (vel > 0) {
        let best = Infinity;
        const head = pos.y + height;
        for (let i = 0; i < hits.length; i++) {
          const b = hits[i];
          if (!this._hitOverFeet(b, pos, 0.08)) continue;
          if (b.min.y < pos.y + height * 0.45) continue;
          if (b.min.y > head + 0.08) continue;
          const ny = b.min.y - height - 0.001;
          const push = pos.y - ny;
          if (push >= 0 && push < best && push <= 1.2) {
            best = push;
            pos.y = ny;
          }
        }
        if (best !== Infinity) this.velocity.y = 0;
      } else if (vel < 0) {
        const fallSlop = Math.max(STEP_UP + 0.12, Math.abs(vel) * 0.08 + 0.25);
        let bestY = -Infinity;
        for (let i = 0; i < hits.length; i++) {
          const b = hits[i];
          // Side walls extend far above the feet — they are not floors.
          // Only land on a box the player is actually standing over.
          if (!this._hitOverFeet(b, pos, 0.08)) continue;
          if (b.max.y > pos.y + fallSlop) continue;
          if (b.max.y < pos.y - 0.4) continue;
          if (b.max.y > bestY) bestY = b.max.y;
        }
        if (bestY > -Infinity) {
          pos.y = bestY + 0.001;
          this.velocity.y = 0;
          this.onGround = true;
        }
      }
      return;
    }

    const loOf = (b) => (axis === 'x' ? b.min.x : b.min.z);
    const hiOf = (b) => (axis === 'x' ? b.max.x : b.max.z);
    const maxPush = Math.max(0.55, Math.abs(vel) * 0.08 + 0.2);
    let bestPush = Infinity;
    let bestPos = pos[axis];

    for (let i = 0; i < hits.length; i++) {
      const b = hits[i];
      const lo = loOf(b);
      const hi = hiOf(b);
      if (vel > 0) {
        const next = lo - radius - 0.001;
        const push = pos[axis] - next;
        if (push >= 0 && push < bestPush && push <= maxPush) {
          bestPush = push;
          bestPos = next;
        }
      } else if (vel < 0) {
        const next = hi + radius + 0.001;
        const push = next - pos[axis];
        if (push >= 0 && push < bestPush && push <= maxPush) {
          bestPush = push;
          bestPos = next;
        }
      } else {
        const left = lo - radius - 0.001;
        const right = hi + radius + 0.001;
        const pL = pos[axis] - left;
        const pR = right - pos[axis];
        if (pL >= 0 && pL < bestPush && pL <= maxPush) {
          bestPush = pL;
          bestPos = left;
        }
        if (pR >= 0 && pR < bestPush && pR <= maxPush) {
          bestPush = pR;
          bestPos = right;
        }
      }
    }

    if (bestPush !== Infinity) {
      pos[axis] = bestPos;
      if (vel !== 0) this.velocity[axis] = 0;
    }
  };

  /** True if the player's XZ center sits over (or nearly over) the hit box. */
  Player.prototype._hitOverFeet = function (b, pos, pad) {
    pad = pad != null ? pad : 0.08;
    return (
      pos.x >= b.min.x - pad &&
      pos.x <= b.max.x + pad &&
      pos.z >= b.min.z - pad &&
      pos.z <= b.max.z + pad
    );
  };

  global.VF = global.VF || {};
  global.VF.Player = Player;
})(window);
