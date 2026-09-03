/**
 * ai.js — 蓝 / 红方士兵
 * 每方默认 32 人（含玩家则本方 AI 31）：优先用地图编辑器摆的 AI 刷新点；无点时仅在己方大本营外围补齐。
 */
(function (global) {
  'use strict';

  const TEAM_SIZE = 32;

  function feelAi() {
    const F = global.VF && global.VF.Feel && global.VF.Feel.ai;
    return {
      teamSize: F && F.teamSize != null ? F.teamSize : TEAM_SIZE,
      speedMul: F && F.speedMul != null ? F.speedMul : 1,
      hpMul: F && F.hpMul != null ? F.hpMul : 1,
      damageMul: F && F.damageMul != null ? F.damageMul : 1,
      fireRateMul: F && F.fireRateMul != null ? F.fireRateMul : 1,
      accuracyMul: F && F.accuracyMul != null ? F.accuracyMul : 1,
    };
  }

  function unitDealDamage(unit) {
    const base = unit.damage != null ? unit.damage : 12;
    return base * feelAi().damageMul;
  }
  const ENGAGE_RANGE = 28;
  /** Collision capsule (feet at mesh.position) */
  const SOLDIER_RADIUS = 0.42;
  const SOLDIER_HEIGHT = 1.85;
  const STEP_UP = 1.05;
  const TERRAIN_STEP_UP = 0.35;
  const TERRAIN_SNAP_DOWN = 0.22;
  const MAX_STEP = 0.42;
  const JUMP_VEL = 8.6;
  const GRAVITY = 22;
  /** Min seconds between obstacle jumps (stops hop spam) */
  const JUMP_COOLDOWN = 2.8;
  const SEP_DIST = 1.4;
  const SEP_DIST_SQ = SEP_DIST * SEP_DIST;
  const VEHICLE_SEEK_RANGE = 72;
  const VEHICLE_MOUNT_RANGE = 4.2;
  const VEHICLE_TARGET_RANGE = 320;
  const RPG_RANGE = 55;
  const RPG_COOLDOWN = 3.2;
  /** House exterior ring (from outer wall) — farther out */
  const HOUSE_DIST_MIN = 12;
  const HOUSE_DIST_MAX = 16;
  /** Extra clear margin beyond building footprint for spawns */
  const BUILDING_SPAWN_MARGIN = 2.5;
  /** Base exterior: at least 15 blocks beyond wall */
  const BASE_DIST_MIN = 15;
  const BASE_DIST_MAX = 22;
  const BASE_HALF = 20;
  /** Ground zipline station patrol radius (blocks) */
  const ZIP_PATROL_R = 36;
  const BASE_PATROL_R = 40;
  const HOUSE_PATROL_R = 22;
  /** Kit AI refresh-pad leash */
  const PAD_PATROL_R = 14;
  const PAD_LEASH_R = 20;

  const RED_DEFS = {
    infantry: {
      variant: 'enemy',
      hp: 55,
      speed: 2.8,
      damage: 14,
      range: 24,
      accuracy: 0.72,
      fireRate: 0.55,
    },
    heavy: {
      variant: 'enemy_heavy',
      hp: 140,
      speed: 1.7,
      damage: 24,
      range: 18,
      accuracy: 0.62,
      fireRate: 0.85,
    },
    ranged: {
      variant: 'enemy_ranged',
      hp: 40,
      speed: 2.3,
      damage: 20,
      range: 36,
      accuracy: 0.78,
      fireRate: 0.95,
    },
  };

  const BLUE_DEF = {
    variant: 'ally',
    hp: 90,
    speed: 3.2,
    damage: 15,
    range: 28,
    accuracy: 0.7,
    fireRate: 0.5,
  };

  function AI(scene, world, player) {
    this.scene = scene;
    this.world = world;
    this.player = player;
    this.blue = [];
    this.red = [];
    this.enemies = [];
    this.allies = [];
    this.wave = 1;
    this.waveTimer = 0;
    this.enabled = true;
    this._armiesSpawned = false;
    this._aiFrame = 0;
    this._sepList = [];
    this._soldierBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
    this._tmpDir = new THREE.Vector3();
    this._tmpSide = new THREE.Vector3();
    this._tmpAway = new THREE.Vector3();
    this._tmpBack = new THREE.Vector3();
    this._tmpGoal = new THREE.Vector3();
    this._flagAssignAcc = 0;
    this._uiHudAt = 0;
    this._deathChunks = [];
    this._deathPool = [];
    this._deathRings = [];
    this._deathFlashes = [];
    this._mkCount = 0;
    this._mkAt = 0;
    this._unitSeq = 0;
    this._deathGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16);
  }

  /* ---------- World helpers ---------- */

  AI.prototype._groundAt = function (x, z) {
    if (this.world.getWalkHeight) return this.world.getWalkHeight(x, z);
    let y = this.world.height - 1;
    while (y > 0 && !this.world._isSolid(Math.floor(x), y, Math.floor(z))) y--;
    return y + 1;
  };

  AI.prototype._feetY = function (x, z) {
    const y = this._groundAt(x, z) + 0.04;
    if (!isFinite(y) || y < 0.5) return 4.04;
    return Math.min(90, y);
  };

  /** Feet Y raised until body clears solids (null if impossible) */
  AI.prototype._clearStandY = function (x, z) {
    let y = this._feetY(x, z);
    for (let i = 0; i < 16; i++) {
      if (!this._soldierOverlaps(x, y, z)) return y;
      y += 0.35;
      if (y > 95) break;
    }
    return null;
  };

  AI.prototype._inRiver = function (x, z) {
    if (!this.world._riverInfo) return false;
    const info = this.world._riverInfo(x, z);
    if (!info.inWater) return false;
    return this._groundAt(x, z) < 3.85;
  };

  AI.prototype._teamSide = function (x, z) {
    if (!this.world._riverInfo) return x < this.world.worldSize * 0.5 ? 'ally' : 'enemy';
    const info = this.world._riverInfo(x, z);
    return x < info.centerX ? 'ally' : 'enemy';
  };

  AI.prototype._onBuildingCell = function (x, z) {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const list = this.world.buildings || [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (ix >= b.ox && ix < b.ox + b.w && iz >= b.oz && iz < b.oz + b.d) {
        return true;
      }
    }
    return false;
  };

  /** True if (x,z) is on/inside any building footprint (optional outward margin) */
  AI.prototype._insideBuilding = function (x, z, margin) {
    margin = margin != null ? margin : 0;
    const list = this.world.buildings || [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (
        x >= b.ox - margin &&
        x < b.ox + b.w + margin &&
        z >= b.oz - margin &&
        z < b.oz + b.d + margin
      ) {
        return true;
      }
    }
    return false;
  };

  AI.prototype._isValidStand = function (x, z, faction) {
    if (this._inRiver(x, z)) return false;
    // Never spawn in/near house footprint
    if (this._insideBuilding(x, z, BUILDING_SPAWN_MARGIN)) return false;
    if (this._teamSide(x, z) !== faction) return false;
    if (this.world._riverInfo) {
      const info = this.world._riverInfo(x, z);
      if (info.dist < info.width + 3.5) return false;
    }
    const y = this._clearStandY(x, z);
    if (y == null) return false;
    return true;
  };

  /** Softer stand check for patrol — still needs clear footing */
  AI.prototype._isWalkable = function (x, z, faction) {
    if (this._inRiver(x, z)) return false;
    if (this._insideBuilding(x, z, 0.35)) return false;
    if (faction && this._teamSide(x, z) !== faction) return false;
    if (this.world._riverInfo) {
      const info = this.world._riverInfo(x, z);
      if (info.dist < info.width + 2.5) return false;
    }
    if (this.world.sampleTerrainFootprint) {
      const sample = this.world.sampleTerrainFootprint(x, z, SOLDIER_RADIUS, 1, 0);
      if (sample.max - sample.min > TERRAIN_STEP_UP * 2.2) return false;
    }
    return this._clearStandY(x, z) != null;
  };

  AI.prototype._soldierBoxAt = function (x, y, z) {
    const box = this._soldierBox;
    box.min.set(x - SOLDIER_RADIUS, y + 0.05, z - SOLDIER_RADIUS);
    box.max.set(x + SOLDIER_RADIUS, y + SOLDIER_HEIGHT, z + SOLDIER_RADIUS);
    return box;
  };

  AI.prototype._soldierOverlaps = function (x, y, z) {
    const box = this._soldierBoxAt(x, y, z);
    if (this.world.overlapsSolid) return this.world.overlapsSolid(box);
    const minX = Math.floor(box.min.x);
    const maxX = Math.floor(box.max.x);
    const minY = Math.floor(box.min.y);
    const maxY = Math.floor(box.max.y);
    const minZ = Math.floor(box.min.z);
    const maxZ = Math.floor(box.max.z);
    for (let vx = minX; vx <= maxX; vx++) {
      for (let vy = minY; vy <= maxY; vy++) {
        for (let vz = minZ; vz <= maxZ; vz++) {
          if (this.world._isSolid(vx, vy, vz)) return true;
        }
      }
    }
    const props = this.world.props;
    if (props) {
      for (let i = 0; i < props.length; i++) {
        const p = props[i];
        if (!p || !p.box || p.kind === 'stair') continue;
        if (box.intersectsBox(p.box)) return true;
      }
    }
    return false;
  };

  AI.prototype._basePos = function (faction) {
    if (faction === 'ally') return this.world._allyBasePos;
    return this.world._enemyBasePos;
  };

  AI.prototype._baseHome = function (faction) {
    const p = this._basePos(faction);
    if (!p) return null;
    const half = BASE_HALF;
    return {
      kind: 'base',
      cx: p.x,
      cz: p.z,
      ox: p.x - half,
      oz: p.z - half,
      w: half * 2,
      d: half * 2,
      side: faction,
    };
  };

  /* ---------- Sampling ---------- */

  AI.prototype._sampleRing = function (cx, cz, half, rMin, rMax, faction) {
    for (let tries = 0; tries < 56; tries++) {
      const edge = Math.floor(Math.random() * 4);
      const t = Math.random();
      const out = rMin + Math.random() * Math.max(0.1, rMax - rMin);
      let x;
      let z;
      if (edge === 0) {
        x = cx - half + t * half * 2;
        z = cz - half - out;
      } else if (edge === 1) {
        x = cx - half + t * half * 2;
        z = cz + half + out;
      } else if (edge === 2) {
        x = cx - half - out;
        z = cz - half + t * half * 2;
      } else {
        x = cx + half + out;
        z = cz - half + t * half * 2;
      }
      if (this._isValidStand(x, z, faction)) {
        const y = this._clearStandY(x, z);
        if (y == null) continue;
        return new THREE.Vector3(x, y, z);
      }
    }
    return null;
  };

  AI.prototype._sampleAroundBase = function (faction) {
    const p = this._basePos(faction);
    if (!p) return null;
    // Distance from base wall ≥ 15
    return this._sampleRing(p.x, p.z, BASE_HALF, BASE_DIST_MIN, BASE_DIST_MAX, faction);
  };

  /** Point outside a building footprint edge (never inside) */
  AI.prototype._sampleExterior = function (building, faction) {
    const b = building;
    for (let tries = 0; tries < 48; tries++) {
      const edge = Math.floor(Math.random() * 4);
      const t = Math.random();
      const out = HOUSE_DIST_MIN + Math.random() * (HOUSE_DIST_MAX - HOUSE_DIST_MIN);
      let x;
      let z;
      if (edge === 0) {
        x = b.ox + t * b.w;
        z = b.oz - out;
      } else if (edge === 1) {
        x = b.ox + t * b.w;
        z = b.oz + b.d + out;
      } else if (edge === 2) {
        x = b.ox - out;
        z = b.oz + t * b.d;
      } else {
        x = b.ox + b.w + out;
        z = b.oz + t * b.d;
      }
      if (this._insideBuilding(x, z, BUILDING_SPAWN_MARGIN)) continue;
      if (this._isValidStand(x, z, faction)) {
        const y = this._clearStandY(x, z);
        if (y == null) continue;
        return new THREE.Vector3(x, y, z);
      }
    }
    return null;
  };

  AI.prototype._sampleNearAnchor = function (ax, az, rMax, faction, loose) {
    for (let i = 0; i < 36; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = 2 + Math.random() * Math.max(2, rMax - 2);
      const x = ax + Math.cos(ang) * r;
      const z = az + Math.sin(ang) * r;
      if (Math.hypot(x - ax, z - az) > rMax) continue;
      let ok = false;
      if (loose) {
        if (!this._inRiver(x, z) && !this._insideBuilding(x, z, BUILDING_SPAWN_MARGIN)) {
          const y = this._clearStandY(x, z);
          if (y != null && !this._soldierOverlaps(x, y, z)) {
            return new THREE.Vector3(x, y, z);
          }
        }
      } else {
        ok =
          this._isWalkable(x, z, faction) &&
          !this._soldierOverlaps(x, this._feetY(x, z), z);
        if (ok) return new THREE.Vector3(x, this._feetY(x, z), z);
      }
    }
    return null;
  };

  AI.prototype._buildingsFor = function (faction) {
    const list = this.world.buildings || [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].side === faction) out.push(list[i]);
    }
    return out;
  };

  /** Ziplines whose ground station is on this faction's side */
  AI.prototype._ziplinesFor = function (faction) {
    const lines = this.world.ziplines || [];
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.start || !line.end) continue;
      if (this._teamSide(line.start.x, line.start.z) === faction) out.push(line);
    }
    return out;
  };

  /** Spawn beside bridge-top zip mount */
  AI.prototype._sampleBridgeZip = function (line) {
    const end = line.end;
    const start = line.start;
    const along = end.clone().sub(start);
    along.y = 0;
    if (along.lengthSq() < 0.01) along.set(1, 0, 0);
    along.normalize();
    const side = new THREE.Vector3(-along.z, 0, along.x);
    const sign = Math.random() > 0.5 ? 1 : -1;
    const x = end.x + side.x * (1.2 + Math.random() * 1.4) * sign + along.x * (Math.random() - 0.5);
    const z = end.z + side.z * (1.2 + Math.random() * 1.4) * sign + along.z * (Math.random() - 0.5);
    return new THREE.Vector3(x, end.y - 0.85, z);
  };

  AI.prototype._awayFromHome = function (unit) {
    const b = unit.home;
    const pos = unit.mesh.position;
    if (!b) return new THREE.Vector3(1, 0, 0);
    let dx = pos.x - b.cx;
    let dz = pos.z - b.cz;
    const len = Math.hypot(dx, dz);
    if (len < 0.15) {
      const a = Math.random() * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    }
    return new THREE.Vector3(dx / len, 0, dz / len);
  };

  AI.prototype._faceAwayFromHome = function (unit, dt) {
    const away = this._awayFromHome(unit);
    const look = unit.mesh.position.clone().addScaledVector(away, 6);
    this._faceToward(unit, look, dt);
  };

  AI.prototype._patrolPoint = function (unit) {
    if (unit.role === 'zip' && unit.zipAnchor) {
      const a = unit.zipAnchor;
      return this._sampleNearAnchor(a.x, a.z, ZIP_PATROL_R, unit.team);
    }
    const b = unit.home;
    if (!b) return null;
    if (unit.role === 'pad') {
      let p = this._sampleNearAnchor(b.cx, b.cz, PAD_PATROL_R, unit.team, true);
      if (p) return p;
      // Fallback: small ring around pad
      for (let t = 0; t < 12; t++) {
        const ang = Math.random() * Math.PI * 2;
        const r = 2 + Math.random() * (PAD_PATROL_R - 2);
        const x = b.cx + Math.cos(ang) * r;
        const z = b.cz + Math.sin(ang) * r;
        if (this._inRiver(x, z)) continue;
        const y = this._clearStandY(x, z);
        if (y == null) continue;
        return new THREE.Vector3(x, y, z);
      }
      return null;
    }
    if (unit.role === 'house') {
      const p = this._sampleExterior(b, unit.team);
      if (p) return p;
      return this._sampleNearAnchor(b.cx, b.cz, HOUSE_PATROL_R, unit.team);
    }
    // base
    const p = this._sampleNearAnchor(b.cx, b.cz, BASE_PATROL_R, unit.team);
    if (p) {
      // Keep base patrol at least ~12 from wall
      const dWall =
        Math.max(Math.abs(p.x - b.cx), Math.abs(p.z - b.cz)) - BASE_HALF;
      if (dWall >= 12) return p;
    }
    return this._sampleRing(b.cx, b.cz, BASE_HALF, BASE_DIST_MIN, BASE_DIST_MAX, unit.team);
  };

  /* ---------- Spawn ---------- */

  AI.prototype._mixRedTypes = function (total) {
    const list = [];
    const heavies = Math.max(1, Math.floor(total * 0.2));
    const ranged = Math.max(1, Math.floor(total * 0.25));
    const rest = Math.max(0, total - heavies - ranged);
    for (let i = 0; i < rest; i++) list.push('infantry');
    for (let i = 0; i < heavies; i++) list.push('heavy');
    for (let i = 0; i < ranged; i++) list.push('ranged');
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = list[i];
      list[i] = list[j];
      list[j] = t;
    }
    return list;
  };

  AI.prototype._spawnUnit = function (typeKey, pos, faction, opts) {
    opts = opts || {};
    const def = faction === 'ally' ? BLUE_DEF : RED_DEFS[typeKey] || RED_DEFS.infantry;
    const mesh = global.VF.Soldier.createSoldier(def.variant);
    mesh.position.copy(pos);
    mesh.visible = true;
    if (global.VF.Soldier.initLocomotion) global.VF.Soldier.initLocomotion(mesh);
    this.scene.add(mesh);

    const home = opts.home || null;
    if (home) {
      const adx = pos.x - home.cx;
      const adz = pos.z - home.cz;
      if (adx * adx + adz * adz > 0.01) {
        mesh.rotation.y = Math.atan2(adx, adz) + Math.PI;
      }
    }

    const hpMul = feelAi().hpMul;
    const hp = def.hp * hpMul;
    const entityId = opts.entityId || 'ai-' + faction + '-' + ++this._unitSeq;
    const classCycle = ['assault', 'engineer', 'support', 'recon'];
    const classId = opts.classId || classCycle[this._unitSeq % classCycle.length];
    return {
      entityId: entityId,
      mesh: mesh,
      team: faction,
      type: typeKey || 'infantry',
      hp: hp,
      maxHp: hp,
      speed: def.speed,
      damage: def.damage,
      range: def.range,
      accuracy: def.accuracy,
      fireRate: def.fireRate,
      shootCd: Math.random() * def.fireRate,
      alive: true,
      downed: false,
      squadId: opts.squadId || null,
      isSquadLeader: !!opts.isSquadLeader,
      classId: classId,
      state: opts.role === 'zip' ? 'zip_descend' : 'patrol',
      role: opts.role || 'base',
      home: home,
      zipLine: opts.zipLine || null,
      zipAnchor: opts.zipAnchor || null,
      zipRide: null,
      zipPhase: opts.role === 'zip' ? 'descend' : null,
      isAI: true,
      vehicleId: null,
      vehicleSeat: null,
      vehicleRole: null,
      vehicleWeaponIndex: 0,
      rpgAmmo: 3,
      rpgCd: 0,
      _rpgScanCd: Math.random() * 0.35,
      _vehicleTargetId: null,
      _vehicleTargetKind: null,
      _vehicleTarget: null,
      _vehicleCombatScanCd: 0,
      _vehicleSeekId: null,
      _vehicleSeekCd: 0.35 + Math.random() * 1.8,
      _vehicleMountCooldown: 0,
      _vehicleGoal: null,
      _vehicleGoalCd: 0,
      _vehicleDriveIntent: false,
      _vehicleStuckTime: 0,
      _vehicleReverseTime: 0,
      _vehicleReverseCooldown: 0,
      _vehicleRecoverySteer: 0,
      _vehicleProbeCd: 0,
      _vehicleLastX: null,
      _vehicleLastZ: null,
      _vehicleBoardingWait: 0,
      patrolTarget: null,
      patrolWait: opts.role === 'zip' ? 0 : 0.4 + Math.random() * 1.2,
      patrolWalk: 0,
      patrolBudget: opts.role === 'zip' ? 10 + Math.random() * 8 : 0,
      target: null,
      thinkCd: Math.random() * 0.8,
      velY: 0,
      onGround: true,
      stuckTime: 0,
      blockTime: 0,
      jumpCd: 0,
      _blockRepath: 0,
      _moveBlocked: false,
    };
  };

  AI.prototype._notCrowded = function (pos, list, minDist) {
    minDist = minDist != null ? minDist : SEP_DIST;
    for (let i = 0; i < list.length; i++) {
      if (list[i].mesh.position.distanceTo(pos) < minDist) return false;
    }
    return true;
  };

  AI.prototype._spawnFaction = function (faction, count) {
    const teamSize = Math.max(0, Math.floor(count != null ? count : feelAi().teamSize));
    if (!teamSize) return [];
    const types =
      faction === 'enemy'
        ? this._mixRedTypes(teamSize)
        : Array(teamSize).fill('infantry');
    const out = [];
    let typeIdx = 0;
    const baseHome = this._baseHome(faction);
    const takeType = function () {
      return types[typeIdx++] || 'infantry';
    };

    const kitPads =
      (this.world._aiSpawns && this.world._aiSpawns[faction]) ||
      (global.VF.game &&
        global.VF.game._mapKitAiSpawns &&
        global.VF.game._mapKitAiSpawns[faction]) ||
      [];

    const padHome = function (pad) {
      const cx = pad.cx != null ? pad.cx : pad.x;
      const cz = pad.cz != null ? pad.cz : pad.z;
      return {
        kind: 'pad',
        cx: cx,
        cz: cz,
        ox: cx - 4,
        oz: cz - 4,
        w: 8,
        d: 8,
        side: faction,
      };
    };

    // Kit pads already constrained to team half — skip _teamSide / river-edge veto
    const canStandLoose = function (self, x, z) {
      if (self._inRiver(x, z)) return false;
      if (self._insideBuilding(x, z, BUILDING_SPAWN_MARGIN)) return false;
      const y = self._clearStandY(x, z);
      return y != null;
    };

    const sampleNearPad = function (self, pad) {
      const cx = pad.cx != null ? pad.cx : pad.x;
      const cz = pad.cz != null ? pad.cz : pad.z;
      for (let t = 0; t < 18; t++) {
        const ang = Math.random() * Math.PI * 2;
        const r = 0.4 + Math.random() * 3.6;
        const x = cx + Math.cos(ang) * r;
        const z = cz + Math.sin(ang) * r;
        if (!canStandLoose(self, x, z)) continue;
        const y = self._clearStandY(x, z);
        if (y == null) continue;
        return new THREE.Vector3(x, y, z);
      }
      if (canStandLoose(self, cx, cz)) {
        const y = self._clearStandY(cx, cz);
        if (y != null) return new THREE.Vector3(cx, y, cz);
      }
      return null;
    };

    const sampleNearBaseLoose = function (self) {
      const p = self._basePos(faction);
      if (!p) return null;
      for (let t = 0; t < 40; t++) {
        const ang = Math.random() * Math.PI * 2;
        const r = 8 + Math.random() * 14;
        const x = p.x + Math.cos(ang) * r;
        const z = p.z + Math.sin(ang) * r;
        if (!canStandLoose(self, x, z)) continue;
        const y = self._clearStandY(x, z);
        if (y == null) continue;
        return new THREE.Vector3(x, y, z);
      }
      return null;
    };

    if (kitPads.length) {
      let guard = 0;
      let pi = 0;
      while (out.length < teamSize && guard++ < teamSize * 50) {
        const pad = kitPads[pi % kitPads.length];
        pi++;
        const pos = sampleNearPad(this, pad);
        if (!pos || !this._notCrowded(pos, out)) continue;
        out.push(
          this._spawnUnit(takeType(), pos, faction, {
            role: 'pad',
            home: padHome(pad),
          })
        );
      }
    }

    // Fallback / fill shortfall around own base
    let fillGuard = 0;
    while (out.length < teamSize && fillGuard++ < 320) {
      let pos = this._sampleAroundBase(faction);
      if (!pos) pos = sampleNearBaseLoose(this);
      if (!pos || !this._notCrowded(pos, out)) continue;
      out.push(
        this._spawnUnit(takeType(), pos, faction, {
          role: 'base',
          home: baseHome,
        })
      );
    }

    return out;
  };

  AI.prototype._clearUnits = function () {
    const all = this.blue.concat(this.red);
    for (let i = 0; i < all.length; i++) {
      if (all[i].vehicleId != null) {
        this._dismountAI(all[i], {
          reason: 'reset',
          silent: true,
          resume: false,
        });
      }
      if (all[i].mesh) this.scene.remove(all[i].mesh);
    }
    this.blue = [];
    this.red = [];
    this.allies = [];
    this.enemies = [];
    this._respawnQ = [];
  };

  AI.prototype._pvpHumanCounts = function () {
    if (
      global.VF.game &&
      global.VF.game.mode === 'pvp' &&
      global.VF.Pvp &&
      typeof global.VF.Pvp.getHumanCounts === 'function'
    ) {
      return global.VF.Pvp.getHumanCounts();
    }
    const playerTeam = (this.world && this.world._playerTeam) || 'ally';
    return {
      ally: playerTeam === 'ally' ? 1 : 0,
      enemy: playerTeam === 'enemy' ? 1 : 0,
    };
  };

  AI.prototype._aiCapForTeam = function (team) {
    const roster = Math.max(1, Math.floor(feelAi().teamSize));
    const humans = this._pvpHumanCounts();
    const taken = team === 'enemy' ? humans.enemy || 0 : humans.ally || 0;
    return Math.max(0, roster - taken);
  };

  AI.prototype._factionOccupancy = function (team) {
    const list = team === 'enemy' ? this.red : this.blue;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].alive || list[i].downed) n++;
    }
    if (this._respawnQ) {
      for (let i = 0; i < this._respawnQ.length; i++) {
        if (this._respawnQ[i].team === team) n++;
      }
    }
    return n;
  };

  AI.prototype._bindTeamViews = function () {
    const playerTeam = (this.world && this.world._playerTeam) || 'ally';
    if (playerTeam === 'ally') {
      this.allies = this.blue;
      this.enemies = this.red;
    } else {
      this.allies = this.red;
      this.enemies = this.blue;
    }
  };

  AI.prototype._refreshArmyHud = function () {
    if (!global.VF.UI) return;
    const playerTeam = (this.world && this.world._playerTeam) || 'ally';
    const humans = this._pvpHumanCounts();
    let blueN = 0;
    let redN = 0;
    for (let i = 0; i < this.blue.length; i++) if (this.blue[i].alive) blueN++;
    for (let i = 0; i < this.red.length; i++) if (this.red[i].alive) redN++;
    blueN += humans.ally || 0;
    redN += humans.enemy || 0;
    global.VF.UI.updateArmyCounts(blueN, redN);
    global.VF.UI.updateSquad(
      playerTeam === 'ally' ? blueN : redN,
      playerTeam === 'ally' ? redN : blueN,
      '占领旗帜 · 耗尽敌方票数'
    );
  };

  AI.prototype._removeOneUnit = function (faction) {
    if (this._respawnQ && this._respawnQ.length) {
      for (let i = this._respawnQ.length - 1; i >= 0; i--) {
        if (this._respawnQ[i].team === faction) {
          this._respawnQ.splice(i, 1);
          return true;
        }
      }
    }
    const list = faction === 'enemy' ? this.red : this.blue;
    let idx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (!list[i].alive && !list[i].downed) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (!list[i].alive) {
          idx = i;
          break;
        }
      }
    }
    if (idx < 0 && list.length) idx = list.length - 1;
    if (idx < 0) return false;
    const unit = list[idx];
    if (unit.vehicleId != null) {
      this._dismountAI(unit, { reason: 'roster', silent: true, resume: false });
    }
    if (unit.mesh) this.scene.remove(unit.mesh);
    list.splice(idx, 1);
    return true;
  };

  AI.prototype._addOneUnit = function (faction) {
    const home = this._baseHome(faction);
    let pos = this._sampleAroundBase(faction);
    if (!pos) {
      const p = this._basePos(faction);
      if (p) pos = new THREE.Vector3(p.x, p.y || 8, p.z);
    }
    if (!pos) return false;
    const unit = this._spawnUnit('infantry', pos, faction, {
      role: 'base',
      home: home,
    });
    if (faction === 'enemy') this.red.push(unit);
    else this.blue.push(unit);
    return true;
  };

  AI.prototype.syncHumanCounts = function () {
    if (!this._armiesSpawned) return;
    const teams = ['ally', 'enemy'];
    for (let t = 0; t < teams.length; t++) {
      const team = teams[t];
      const cap = this._aiCapForTeam(team);
      let guard = 0;
      while (this._factionOccupancy(team) > cap && guard++ < 48) {
        if (!this._removeOneUnit(team)) break;
      }
      guard = 0;
      while (this._factionOccupancy(team) < cap && guard++ < 48) {
        if (!this._addOneUnit(team)) break;
      }
    }
    this._bindTeamViews();
    this._refreshArmyHud();
    if (global.VF.Squads && global.VF.Squads.buildRosters && global.VF.game) {
      global.VF.Squads.buildRosters(global.VF.game);
    }
  };

  AI.prototype.applyPlayerTeam = function () {
    this._clearUnits();
    if (!this.world.buildings) this.world.buildings = [];
    this.blue = this._spawnFaction('ally', this._aiCapForTeam('ally'));
    this.red = this._spawnFaction('enemy', this._aiCapForTeam('enemy'));
    this._bindTeamViews();
    this._armiesSpawned = true;
    this.waveTimer = 0;
    this._refreshArmyHud();
  };

  AI.prototype.relocateSquadNearSpawn = function () {
    if (!this._armiesSpawned) this.applyPlayerTeam();
  };

  /* ---------- Combat ---------- */

  AI.prototype.raycastEnemies = function (origin, dir, range) {
    return this._raycastTeam(this.enemies, origin, dir, range);
  };

  AI.prototype.raycastAllies = function (origin, dir, range) {
    return this._raycastTeam(this.allies, origin, dir, range);
  };

  AI.prototype._raycastTeam = function (list, origin, dir, range) {
    let best = null;
    let bestDist = range;
    const HB = global.VF && global.VF.Hitboxes;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.alive || e.vehicleId != null) continue;
      if (HB && HB.raycast) {
        const hit = HB.raycast(e, origin, dir, bestDist);
        if (hit && hit.dist < bestDist) {
          bestDist = hit.dist;
          best = {
            enemy: e,
            unit: e,
            point: hit.point,
            dist: hit.dist,
            part: hit.part,
          };
        }
        continue;
      }
      const center = e.mesh.position.clone().add(new THREE.Vector3(0, 1.2, 0));
      const to = center.clone().sub(origin);
      const proj = to.dot(dir);
      if (proj < 0 || proj > bestDist) continue;
      const closest = origin.clone().addScaledVector(dir, proj);
      const radius = e.type === 'heavy' ? 1.25 : 1.0;
      if (closest.distanceTo(center) < radius) {
        bestDist = proj;
        best = { enemy: e, unit: e, point: closest, dist: proj, part: 'torso' };
      }
    }
    return best;
  };

  AI.prototype.damageEnemy = function (enemy, dmg, hitDir, meta) {
    return this._damageUnit(enemy, dmg, hitDir, true, this.player, meta);
  };

  AI.prototype._restoreOnFoot = function (unit) {
    if (!unit) return;
    unit.vehicleId = null;
    unit.vehicleSeat = null;
    unit.vehicleRole = null;
    unit.vehicleWeaponIndex = 0;
    unit._vehicleSeekId = null;
    unit._vehicleTargetId = null;
    unit._vehicleTargetKind = null;
    unit._vehicleTarget = null;
    unit._vehicleCombatScanCd = 0;
    unit._vehicleDriveIntent = false;
    unit._vehicleStuckTime = 0;
    unit._vehicleReverseTime = 0;
    unit._vehicleReverseCooldown = 0;
    unit._vehicleLastX = null;
    unit._vehicleLastZ = null;
    unit._vehicleBoardingWait = 0;
    unit._vehicleMountCooldown = Math.max(unit._vehicleMountCooldown || 0, 3.5);
    unit.velY = 0;
    unit.onGround = true;
    unit.target = null;
    unit._lastThreatPos = null;
    unit.state = 'patrol';
    if (unit.mesh) {
      unit.mesh.visible = true;
      if (unit.mesh.userData) unit.mesh.userData.downed = false;
    }
    if (Object.prototype.hasOwnProperty.call(unit, '_vehiclePreviousVisible')) {
      delete unit._vehiclePreviousVisible;
    }
  };

  AI.prototype._dismountAI = function (unit, opts) {
    if (!unit || unit.vehicleId == null) return false;
    opts = opts || {};
    const vehicles = global.VF && global.VF.Vehicles;
    let dismounted = false;
    if (vehicles && typeof vehicles.dismount === 'function') {
      dismounted = !!vehicles.dismount(unit, {
        reason: opts.reason || 'ai-exit',
        silent: !!opts.silent,
      });
    }
    if (opts.resume === false) {
      unit.vehicleId = null;
      unit.vehicleSeat = null;
      unit.vehicleRole = null;
      unit._vehicleSeekId = null;
      unit._vehicleTargetId = null;
      unit._vehicleTargetKind = null;
      unit._vehicleTarget = null;
      unit._vehicleDriveIntent = false;
      if (unit.mesh) unit.mesh.visible = true;
      return dismounted;
    }
    this._restoreOnFoot(unit);
    return dismounted;
  };

  AI.prototype._damageUnit = function (unit, dmg, hitDir, fromPlayer, attacker, meta) {
    if (!unit || !unit.alive) return { killed: false, dmg: 0 };
    if (unit._reviveProtection > 0) return { killed: false, dmg: 0 };
    const sourceTeam =
      (attacker && attacker.team) || (fromPlayer && this.world && this.world._playerTeam);
    if (
      global.VF.MatchFlow &&
      global.VF.MatchFlow.canDamage &&
      !global.VF.MatchFlow.canDamage(unit, sourceTeam)
    ) {
      return { killed: false, dmg: 0 };
    }
    unit._lastCombatAt = performance.now();
    if (meta && meta.part) unit._lastHitPart = meta.part;
    if (meta && meta.weaponId) unit._lastHitWeaponId = meta.weaponId;
    else if (attacker && (attacker.weaponId || attacker.current)) {
      unit._lastHitWeaponId = attacker.weaponId || attacker.current;
    }
    const before = unit.hp;
    unit.hp -= dmg;
    const applied = Math.min(before, Math.max(0, dmg));
    const attackerId =
      (attacker && (attacker.entityId || (attacker === this.player ? 'player-local' : null))) ||
      (fromPlayer ? 'player-local' : null);
    if (global.VF.Scoring && global.VF.Scoring.recordDamage && attackerId) {
      global.VF.Scoring.recordDamage(
        attackerId,
        unit.entityId,
        applied,
        attacker && attacker.team,
        unit.team,
        (meta && meta.part) || unit._lastHitPart || null
      );
    }

    unit.mesh.traverse(function (c) {
      if (!c.isMesh || !c.material || !c.material.emissive) return;
      // Shared soldier mats — clone once before flash so others aren't tinted
      if (!c.material.userData._owned) {
        c.material = c.material.clone();
        c.material.userData._owned = true;
      }
      const mat = c.material;
      if (mat.userData._hitFlash) return;
      mat.userData._hitFlash = true;
      const prevHex = mat.emissive.getHex();
      const prevInt = mat.emissiveIntensity != null ? mat.emissiveIntensity : 0;
      mat.emissive.setHex(0xff1100);
      mat.emissiveIntensity = Math.max(prevInt, 1.35);
      setTimeout(function () {
        if (!mat) return;
        mat.emissive.setHex(prevHex);
        mat.emissiveIntensity = prevInt;
        mat.userData._hitFlash = false;
      }, 160);
    });

    // Light knockback (non-lethal) along hit direction
    if (unit.hp > 0 && hitDir && unit.mesh) {
      let hx = hitDir.x;
      let hz = hitDir.z;
      const len = Math.hypot(hx, hz);
      if (len > 0.001) {
        hx /= len;
        hz /= len;
        const push = 0.14 + Math.min(0.14, applied * 0.003);
        unit.mesh.position.x += hx * push;
        unit.mesh.position.z += hz * push;
        unit._kb = { life: 0.14, dur: 0.14, ox: hx * push, oz: hz * push };
      }
    }

    if (unit.hp <= 0) {
      if (unit.vehicleId != null) {
        this._dismountAI(unit, {
          reason: 'death',
          silent: true,
          resume: false,
        });
      }
      if (
        global.VF.Conquest &&
        global.VF.Conquest.active &&
        global.VF.Revive &&
        global.VF.Revive.downAI &&
        global.VF.Revive.downAI(unit, this, {
          hitDir: hitDir && hitDir.clone ? hitDir.clone() : hitDir || null,
          fromPlayer: !!fromPlayer,
          attackerId: attackerId,
          attackerTeam: (attacker && attacker.team) || (fromPlayer ? this.world._playerTeam : null),
        })
      ) {
        this._pushCombatFeed(unit, attacker, attackerId, fromPlayer, 'down', meta);
        return { killed: true, downed: true, dmg: applied };
      }
      unit.alive = false;
      if (global.VF.Conquest && global.VF.Conquest.active) {
        this._queueConquestRespawn(unit);
      }
      const deathPos = unit.mesh ? unit.mesh.position.clone() : null;
      this._playVoxelDeath(unit, hitDir);
      if (deathPos && this.world && this.world.stampDeathStain) {
        this.world.stampDeathStain(
          deathPos.x,
          deathPos.y + 1.0,
          deathPos.z,
          unit.team,
          hitDir
        );
      }
      const playerTeam = this.world._playerTeam || 'ally';
      if (unit.team !== playerTeam) {
        if (fromPlayer) {
          this._registerPlayerKill();
        } else if (global.VF.Audio) {
          global.VF.Audio.play('kill');
        }
        const ammoId =
          (global.VF.ENEMY_AMMO_TYPE && global.VF.ENEMY_AMMO_TYPE[unit.type]) || 'ar';
        const baseAmt = global.VF.AMMO_DROP_AMOUNT || 30;
        const lootMul =
          global.VF.Skills && global.VF.Skills.getLootMul
            ? global.VF.Skills.getLootMul(this.player)
            : 1;
        const amount = Math.max(1, Math.round(baseAmt * lootMul));
        const dropAt = deathPos || (unit.mesh && unit.mesh.position);
        if (dropAt && global.VF.game && global.VF.game.weapons) {
          global.VF.game.weapons.spawnAmmoDrop(dropAt.clone(), ammoId, amount);
        }
        const dropChance = lootMul > 1 ? 0.72 : 0.45;
        if (dropAt && global.VF.game && Math.random() < dropChance) {
          global.VF.game.spawnResource(
            dropAt.clone(),
            Math.random() > 0.5 ? 'core' : 'block'
          );
        }
        if (dropAt && lootMul > 1 && global.VF.game && Math.random() < lootMul - 1) {
          global.VF.game.spawnResource(
            dropAt.clone().add(new THREE.Vector3(0.35, 0.2, -0.2)),
            Math.random() > 0.5 ? 'core' : 'block'
          );
        }
      }
      this._pushCombatFeed(unit, attacker, attackerId, fromPlayer, 'kill', meta);
      return { killed: true, dmg: applied };
    }
    return { killed: false, dmg: applied };
  };

  const DEATH_POOL_MAX = 280;
  const DEATH_SAMPLE_MAX = 110;
  const MK_WINDOW_MS = 3500;
  const MK_LABELS = ['', '', '双杀', '三杀', '四杀', '五杀', '六杀', '超神'];

  AI.prototype._registerPlayerKill = function () {
    const now = performance.now();
    if (!this._mkAt || now - this._mkAt > MK_WINDOW_MS) this._mkCount = 0;
    this._mkCount += 1;
    this._mkAt = now;
    const n = this._mkCount;
    if (global.VF.Conquest && global.VF.Conquest.active && global.VF.Conquest.onKill) {
      const team = (this.world && this.world._playerTeam) || 'ally';
      global.VF.Conquest.onKill(team, true);
    }
    const pitch = 1 + Math.min(0.5, (n - 1) * 0.09);
    if (global.VF.Audio) {
      global.VF.Audio.play('kill', { pitch: pitch, streak: n });
    }
    if (n >= 2 && global.VF.UI && global.VF.UI.toast) {
      const msg = n < MK_LABELS.length ? MK_LABELS[n] : n + '连杀';
      global.VF.UI.toast(msg);
    }
  };

  AI.prototype._pushCombatFeed = function (unit, attacker, attackerId, fromPlayer, kind, meta) {
    if (!global.VF.UI || !global.VF.UI.pushKillFeed || !unit) return;
    const pos = unit.mesh && unit.mesh.position;
    const weaponId =
      (meta && meta.weaponId) ||
      unit._lastHitWeaponId ||
      (attacker && (attacker.weaponId || attacker.current)) ||
      (attacker && attacker.type === 'heavy'
        ? 'sg'
        : attacker && attacker.type === 'ranged'
          ? 'sr'
          : 'ar');
    global.VF.UI.pushKillFeed({
      killerId: attackerId || (fromPlayer ? 'player-local' : null),
      killerName: null,
      killerTeam:
        (attacker && attacker.team) ||
        (fromPlayer && this.world && this.world._playerTeam) ||
        null,
      victimId: unit.entityId,
      victimName: null,
      victimTeam: unit.team,
      weaponId: weaponId,
      part: (meta && meta.part) || unit._lastHitPart || null,
      kind: kind,
      lifeId: unit.downState && unit.downState.lifeId,
      x: pos && pos.x,
      y: pos && pos.y,
      z: pos && pos.z,
    });
  };

  AI.prototype._acquireDeathChunk = function () {
    let mesh = this._deathPool.pop();
    if (!mesh) {
      const mat = new THREE.MeshLambertMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 1,
      });
      mesh = new THREE.Mesh(this._deathGeo, mat);
      mesh.frustumCulled = false;
    }
    return mesh;
  };

  AI.prototype._releaseDeathChunk = function (entry) {
    if (!entry || !entry.mesh) return;
    if (entry.mesh.parent) entry.mesh.parent.remove(entry.mesh);
    this._deathPool.push(entry.mesh);
  };

  AI.prototype._spawnDeathBurstRing = function (origin) {
    if (!this._deathRingGeo) {
      this._deathRingGeo = new THREE.RingGeometry(0.28, 0.72, 28);
      this._deathRings = this._deathRings || [];
    }
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffcc66,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(this._deathRingGeo, mat);
    ring.position.copy(origin);
    ring.rotation.x = -Math.PI / 2;
    ring.scale.setScalar(0.55);
    this.scene.add(ring);
    this._deathRings.push({ mesh: ring, life: 0.38, maxLife: 0.38, grow: 4.4 });
  };

  /** Brief white flash sphere at kill origin */
  AI.prototype._spawnDeathFlashBall = function (origin) {
    if (!this._deathFlashGeo) {
      this._deathFlashGeo = new THREE.SphereGeometry(0.48, 10, 10);
      this._deathFlashes = [];
    }
    const mat = new THREE.MeshBasicMaterial({
      color: 0xfff4d0,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
    const ball = new THREE.Mesh(this._deathFlashGeo, mat);
    ball.position.copy(origin);
    ball.scale.setScalar(0.75);
    this.scene.add(ball);
    if (!this._deathFlashes) this._deathFlashes = [];
    this._deathFlashes.push({ mesh: ball, life: 0.24, maxLife: 0.24 });
  };

  AI.prototype._emitDeathChunks = function (samples, origin, dir, opts) {
    opts = opts || {};
    const cone = opts.cone != null ? opts.cone : 0.95;
    const spdMin = opts.spdMin != null ? opts.spdMin : 8;
    const spdRange = opts.spdRange != null ? opts.spdRange : 8;
    const sizeMin = opts.sizeMin != null ? opts.sizeMin : 0.18;
    const sizeRange = opts.sizeRange != null ? opts.sizeRange : 0.2;
    const lifeMin = opts.lifeMin != null ? opts.lifeMin : 0.9;
    const lifeRange = opts.lifeRange != null ? opts.lifeRange : 0.5;

    while (this._deathChunks.length + samples.length > DEATH_POOL_MAX) {
      const old = this._deathChunks.shift();
      if (old) this._releaseDeathChunk(old);
    }

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const chunk = this._acquireDeathChunk();
      chunk.material.color.setHex(s.color);
      chunk.material.opacity = 1;
      const size = sizeMin + Math.random() * sizeRange;
      chunk.scale.setScalar(size / 0.16);
      if (s.pos) chunk.position.copy(s.pos);
      else chunk.position.copy(origin);
      this.scene.add(chunk);

      const spd = spdMin + Math.random() * spdRange;
      const life = lifeMin + Math.random() * lifeRange;
      this._deathChunks.push({
        mesh: chunk,
        life: life,
        maxLife: life,
        vx: dir.x * spd + (Math.random() - 0.5) * cone * spd,
        vy: Math.max(3.5, dir.y * spd * 0.4) + 3 + Math.random() * 6,
        vz: dir.z * spd + (Math.random() - 0.5) * cone * spd,
        rx: (Math.random() - 0.5) * 16,
        ry: (Math.random() - 0.5) * 16,
        rz: (Math.random() - 0.5) * 16,
      });
    }
  };

  AI.prototype._playVoxelDeath = function (unit, hitDir) {
    if (!unit || !unit.mesh) return;
    const meshRoot = unit.mesh;
    const origin = meshRoot.position.clone().add(new THREE.Vector3(0, 1.0, 0));
    const teamColor = unit.team === 'ally' || unit.team === 'blue' ? 0x4488ff : 0xff4444;
    const samples = [];

    meshRoot.updateMatrixWorld(true);
    meshRoot.traverse(function (c) {
      if (!c.isMesh || samples.length >= DEATH_SAMPLE_MAX) return;
      const pos = new THREE.Vector3();
      c.getWorldPosition(pos);
      let color = teamColor;
      if (c.material) {
        const mat = Array.isArray(c.material) ? c.material[0] : c.material;
        if (mat && mat.color) color = mat.color.getHex();
      }
      samples.push({ pos: pos, color: color });
    });

    if (samples.length < 12) {
      for (let ix = 0; ix < 4 && samples.length < 56; ix++) {
        for (let iy = 0; iy < 5 && samples.length < 56; iy++) {
          for (let iz = 0; iz < 3 && samples.length < 56; iz++) {
            samples.push({
              pos: new THREE.Vector3(
                origin.x + (ix - 1.5) * 0.24,
                origin.y - 0.85 + iy * 0.3,
                origin.z + (iz - 1) * 0.24
              ),
              color: teamColor,
            });
          }
        }
      }
    }

    const dir = hitDir
      ? hitDir.clone()
      : new THREE.Vector3((Math.random() - 0.5) * 0.4, 1, (Math.random() - 0.5) * 0.4);
    if (dir.lengthSq() < 0.0001) dir.set(0, 1, 0);
    else dir.normalize();

    this._emitDeathChunks(samples, origin, dir, {
      cone: 1.35,
      spdMin: 12,
      spdRange: 10,
      sizeMin: 0.26,
      sizeRange: 0.29,
      lifeMin: 1.2,
      lifeRange: 0.6,
    });

    // Secondary center pulse — extra spray for punch
    const pulse = [];
    for (let i = 0; i < 30; i++) {
      pulse.push({
        pos: origin
          .clone()
          .add(
            new THREE.Vector3(
              (Math.random() - 0.5) * 0.5,
              (Math.random() - 0.5) * 0.65,
              (Math.random() - 0.5) * 0.5
            )
          ),
        color: Math.random() > 0.45 ? teamColor : 0xffaa44,
      });
    }
    this._emitDeathChunks(pulse, origin, dir, {
      cone: 1.7,
      spdMin: 14,
      spdRange: 10,
      sizeMin: 0.22,
      sizeRange: 0.24,
      lifeMin: 1.0,
      lifeRange: 0.55,
    });

    // Forward cone spray — directional impact along hitDir
    const coneSpray = [];
    for (let i = 0; i < 28; i++) {
      coneSpray.push({
        pos: origin
          .clone()
          .add(
            new THREE.Vector3(
              dir.x * (0.15 + Math.random() * 0.35) + (Math.random() - 0.5) * 0.2,
              (Math.random() - 0.3) * 0.45,
              dir.z * (0.15 + Math.random() * 0.35) + (Math.random() - 0.5) * 0.2
            )
          ),
        color: Math.random() > 0.5 ? teamColor : 0xffeeaa,
      });
    }
    this._emitDeathChunks(coneSpray, origin, dir, {
      cone: 0.45,
      spdMin: 16,
      spdRange: 8,
      sizeMin: 0.2,
      sizeRange: 0.22,
      lifeMin: 1.1,
      lifeRange: 0.5,
    });

    this._spawnDeathBurstRing(origin);
    this._spawnDeathFlashBall(origin);

    if (global.VF.game && global.VF.game.weapons && global.VF.game.weapons._spawnImpact) {
      global.VF.game.weapons._spawnImpact(origin, 0xffaa44, 0.55);
      global.VF.game.weapons._spawnImpact(
        origin.clone().add(new THREE.Vector3(0, 0.15, 0)),
        0xff6622,
        0.36
      );
    }

    meshRoot.visible = false;
    this.scene.remove(meshRoot);
  };

  AI.prototype._updateDeathChunks = function (dt) {
    if (this._deathRings && this._deathRings.length) {
      for (let i = this._deathRings.length - 1; i >= 0; i--) {
        const r = this._deathRings[i];
        r.life -= dt;
        const u = Math.max(0, r.life / r.maxLife);
        const grow = r.grow != null ? r.grow : 2.8;
        const sc = 0.45 + (1 - u) * grow;
        r.mesh.scale.setScalar(sc);
        r.mesh.material.opacity = 0.95 * u;
        if (r.life <= 0) {
          if (r.mesh.parent) r.mesh.parent.remove(r.mesh);
          if (r.mesh.material) r.mesh.material.dispose();
          this._deathRings.splice(i, 1);
        }
      }
    }
    if (this._deathFlashes && this._deathFlashes.length) {
      for (let i = this._deathFlashes.length - 1; i >= 0; i--) {
        const f = this._deathFlashes[i];
        f.life -= dt;
        const u = Math.max(0, f.life / f.maxLife);
        f.mesh.scale.setScalar(0.75 + (1 - u) * 2.8);
        f.mesh.material.opacity = 0.9 * u;
        if (f.life <= 0) {
          if (f.mesh.parent) f.mesh.parent.remove(f.mesh);
          if (f.mesh.material) f.mesh.material.dispose();
          this._deathFlashes.splice(i, 1);
        }
      }
    }
    for (let i = this._deathChunks.length - 1; i >= 0; i--) {
      const c = this._deathChunks[i];
      c.life -= dt;
      c.vy -= 24 * dt;
      c.mesh.position.x += c.vx * dt;
      c.mesh.position.y += c.vy * dt;
      c.mesh.position.z += c.vz * dt;
      c.mesh.rotation.x += c.rx * dt;
      c.mesh.rotation.y += c.ry * dt;
      c.mesh.rotation.z += c.rz * dt;
      const u = Math.max(0, c.life / Math.max(0.001, c.maxLife));
      c.mesh.material.opacity = u;
      if (c.life <= 0) {
        this._releaseDeathChunk(c);
        this._deathChunks.splice(i, 1);
      }
    }
  };

  AI.prototype._updateKnockback = function (unit, dt) {
    if (!unit || !unit._kb || unit._kb.life <= 0) return;
    const kb = unit._kb;
    const dur = kb.dur || 0.14;
    const step = Math.min(dt, kb.life);
    const f = step / dur;
    unit.mesh.position.x -= kb.ox * f;
    unit.mesh.position.z -= kb.oz * f;
    kb.life -= step;
    if (kb.life <= 0) unit._kb = null;
  };

  AI.prototype._hasLOS = function (from, to) {
    if (global.VF.Gadgets && global.VF.Gadgets.blocksLine && global.VF.Gadgets.blocksLine(from, to)) {
      return false;
    }
    const dist = from.distanceTo(to);
    if (dist < 1.5) return true;
    const steps = Math.min(24, Math.max(3, Math.ceil(dist)));
    if (!this._losDir) {
      this._losDir = new THREE.Vector3();
      this._losPt = new THREE.Vector3();
    }
    this._losDir.copy(to).sub(from).normalize();
    for (let i = 1; i < steps; i++) {
      this._losPt.copy(from).addScaledVector(this._losDir, (dist * i) / steps);
      if (
        this.world.getTerrainTop &&
        this._losPt.y <= this.world.getTerrainTop(this._losPt.x, this._losPt.z) - 0.04
      ) {
        return false;
      }
      const vx = Math.floor(this._losPt.x);
      const vy = Math.floor(this._losPt.y);
      const vz = Math.floor(this._losPt.z);
      if (this.world._isTerrainFill && this.world._isTerrainFill(vx, vy, vz)) continue;
      const t = this.world.get(vx, vy, vz);
      if (
        t !== global.VF.BLOCK.AIR &&
        t !== global.VF.BLOCK.WATER &&
        t !== global.VF.BLOCK.GLASS
      ) {
        return false;
      }
    }
    return true;
  };

  AI.prototype._nearestHostile = function (unit, range) {
    const playerTeam = this.world._playerTeam || 'ally';
    const foes = unit.team === playerTeam ? this.enemies : this.allies;
    let best = null;
    let bestD = range;
    for (let i = 0; i < foes.length; i++) {
      const e = foes[i];
      if (!e.alive || e.vehicleId != null) continue;
      const d = unit.mesh.position.distanceTo(e.mesh.position);
      if (d < bestD) {
        bestD = d;
        best = { unit: e, isPlayer: false, pos: e.mesh.position, dist: d };
      }
    }
    if (
      unit.team !== playerTeam &&
      this.player.health > 0 &&
      !this.player.dead &&
      this.player.vehicleId == null
    ) {
      // Ghost stealth: AI cannot lock onto stealthed player
      const stealthed =
        (global.VF.Skills && global.VF.Skills.isPlayerStealthed(this.player)) ||
        !!this.player.stealthed;
      if (!stealthed) {
        const d = unit.mesh.position.distanceTo(this.player.object.position);
        if (d < bestD) {
          best = {
            unit: this.player,
            isPlayer: true,
            pos: this.player.object.position,
            dist: d,
          };
        }
      }
    }
    return best;
  };

  AI.prototype._faceToward = function (unit, targetPos, dt) {
    if (!unit || !unit.mesh || !targetPos) return;
    const dx = targetPos.x - unit.mesh.position.x;
    const dz = targetPos.z - unit.mesh.position.z;
    if (dx * dx + dz * dz < 0.04) return;
    const want = Math.atan2(dx, dz) + Math.PI;
    let dy = want - unit.mesh.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const maxTurn = 4.5 * Math.max(0.008, dt || 0.016);
    if (dy > maxTurn) dy = maxTurn;
    if (dy < -maxTurn) dy = -maxTurn;
    unit.mesh.rotation.y += dy;
  };

  AI.prototype._tryShoot = function (unit, targetUnit, dt) {
    unit.shootCd -= dt;
    if (unit.shootCd > 0 || !targetUnit || !targetUnit.alive) return;

    const from = unit.mesh.position.clone().add(new THREE.Vector3(0, 1.4, 0));
    let to;
    if (targetUnit.isTurret && targetUnit.mesh) {
      to = targetUnit.mesh.position.clone().add(new THREE.Vector3(0, 1.1, 0));
    } else if (targetUnit === this.player || targetUnit.isPlayer) {
      if (this.player.getEyePosition) {
        to = this.player.getEyePosition().clone();
        to.y -= 0.35; // aim chest, not top of head
      } else {
        to = this.player.object.position.clone().add(new THREE.Vector3(0, 1.35, 0));
      }
    } else if (targetUnit.mesh) {
      to = targetUnit.mesh.position.clone().add(new THREE.Vector3(0, 1.3, 0));
    } else {
      to = targetUnit.object.position.clone().add(new THREE.Vector3(0, 1.5, 0));
    }
    const dist = from.distanceTo(to);
    if (dist > unit.range) return;
    if (!this._hasLOS(from, to)) return;

    const feel = feelAi();
    const rateMul = Math.max(0.12, feel.fireRateMul);
    unit.shootCd = unit.fireRate * rateMul * (0.8 + Math.random() * 0.25);
    unit._lastCombatAt = performance.now();
    this._faceToward(unit, to, dt);

    const muzzle = unit.mesh.userData && unit.mesh.userData.muzzle;
    const tracerColor = unit.team === 'ally' ? 0x88ddff : 0xffaa44;
    if (muzzle && global.VF.spawnMuzzleFlash) {
      global.VF.spawnMuzzleFlash(muzzle, {
        size: unit.type === 'heavy' ? 0.24 : 0.17,
        intensity: unit.type === 'heavy' ? 8 : 5,
        life: 0.06,
        color: tracerColor,
      });
    }

    // Closer = easier to hit; accuracyMul from feel config
    let hitChance = (unit.accuracy != null ? unit.accuracy : 0.55) * feel.accuracyMul;
    if (dist < 10) hitChance *= 1.15;
    else if (dist < 16) hitChance *= 1.05;
    if (unit.flashedUntil && unit.flashedUntil > performance.now()) hitChance *= 0.12;
    hitChance = Math.min(0.95, Math.max(0.08, hitChance));
    const didHit = Math.random() <= hitChance;
    if (global.VF.spawnTracer) {
      if (!this._tracerFrom) {
        this._tracerFrom = new THREE.Vector3();
        this._tracerTo = new THREE.Vector3();
      }
      if (muzzle && muzzle.getWorldPosition) {
        muzzle.getWorldPosition(this._tracerFrom);
      } else {
        this._tracerFrom.copy(from);
      }
      this._tracerTo.copy(to);
      // Misses still show a near-miss streak
      if (!didHit) {
        this._tracerTo.x += (Math.random() - 0.5) * 1.6;
        this._tracerTo.y += (Math.random() - 0.5) * 0.9;
        this._tracerTo.z += (Math.random() - 0.5) * 1.6;
      }
      const tracerId = unit.type === 'heavy' ? 'sg' : unit.type === 'ranged' ? 'sr' : 'ar';
      global.VF.spawnTracer(this._tracerFrom, this._tracerTo, {
        color: tracerColor,
        id: tracerId,
        pellets: unit.type === 'heavy' ? 3 : 1,
        bright: true,
        lifeMul: 1.3,
      });
    }

    if (!didHit) return;

    const dmgBase = unitDealDamage(unit);
    if (targetUnit.isTurret && targetUnit.turret) {
      const skills = global.VF.game && global.VF.game.skills;
      if (skills && skills.damageTurret) {
        skills.damageTurret(targetUnit.turret, dmgBase);
      }
      return;
    }

    if (targetUnit === this.player || targetUnit.isPlayer) {
      if (
        global.VF.Skills &&
        global.VF.Skills.isPlayerStealthed(this.player)
      ) {
        return;
      }
      let dmg = dmgBase;
      let part = 'torso';
      if (global.VF.Hitboxes && global.VF.Hitboxes.raycast) {
        const shotDir = to.clone().sub(from);
        const shotLen = shotDir.length() || 1;
        shotDir.multiplyScalar(1 / shotLen);
        const hit = global.VF.Hitboxes.raycast(this.player, from, shotDir, dist + 0.8);
        if (hit && hit.part) part = hit.part;
        dmg = Math.round(dmg * global.VF.Hitboxes.partMul(part));
      }
      unit.hitPart = part;
      if (this.player.takeDamage) {
        this.player.takeDamage(dmg, unit.mesh.position, unit);
      } else {
        this.player.health = Math.max(0, this.player.health - dmg);
        if (global.VF.UI) {
          global.VF.UI.updateVitals(this.player.health, this.player.armor);
        }
      }
    } else {
      this._damageUnit(targetUnit, dmgBase, null, false, unit);
    }
  };

  /* ---------- Zipline ride ---------- */

  AI.prototype._beginZipRide = function (unit, from, to) {
    const line = unit.zipLine;
    let a = from;
    let b = to;
    let landHigh = null;
    let landLow = null;
    if (line && line.rideStart && line.rideEnd) {
      const atStart = from.distanceToSquared(line.start) <= from.distanceToSquared(line.end);
      if (atStart) {
        a = line.rideStart;
        b = line.rideEnd;
        landHigh = line.landHigh || null;
      } else {
        a = line.rideEnd;
        b = line.rideStart;
        landLow = line.landLow || null;
      }
    }
    const len = Math.max(0.5, a.distanceTo(b));
    unit.zipRide = {
      start: a.clone(),
      end: b.clone(),
      t: 0,
      len: len,
      speed: Math.max(12, len * 0.34),
      landHigh: landHigh,
      landLow: landLow,
      goingUp: b.y > a.y + 3,
    };
    unit.velY = 0;
    if (unit.mesh) unit.mesh.visible = true;
  };

  /** Land beside ground station — never inside the metal post */
  AI.prototype._placeClearLanding = function (unit) {
    const line = unit.zipLine;
    const pos = unit.mesh.position;
    if (!line) {
      pos.y = this._clearStandY(pos.x, pos.z) || this._feetY(pos.x, pos.z);
      return;
    }
    const from = line.end;
    const to = line.start;
    let dx = to.x - from.x;
    let dz = to.z - from.z;
    let len = Math.hypot(dx, dz);
    if (len < 0.01) {
      dx = 1;
      dz = 0;
    } else {
      dx /= len;
      dz /= len;
    }

    const tryPlace = (x, z) => {
      if (!this._isWalkable(x, z, unit.team)) return false;
      const y = this._clearStandY(x, z);
      if (y == null) return false;
      pos.set(x, y, z);
      return true;
    };

    for (let r = 2.2; r <= 9; r += 0.7) {
      if (tryPlace(to.x + dx * r, to.z + dz * r)) return;
      if (tryPlace(to.x + dx * r - dz * 1.2, to.z + dz * r + dx * 1.2)) return;
      if (tryPlace(to.x + dx * r + dz * 1.2, to.z + dz * r - dx * 1.2)) return;
    }
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      if (tryPlace(to.x + Math.cos(ang) * 3.5, to.z + Math.sin(ang) * 3.5)) return;
    }
    const fx = to.x + dx * 3.5;
    const fz = to.z + dz * 3.5;
    let y = this._clearStandY(fx, fz);
    if (y == null) y = this._feetY(fx, fz) + 2.2;
    pos.set(fx, y, fz);
    if (this._soldierOverlaps(pos.x, pos.y, pos.z)) this._resolveEmbed(unit);
  };

  /** @returns true when ride finished */
  AI.prototype._updateZipRide = function (unit, dt) {
    const ride = unit.zipRide;
    if (!ride) return true;
    unit.mesh.visible = true;
    ride.t += (ride.speed * dt) / Math.max(0.1, ride.len);
    this._faceToward(unit, ride.end, dt);
    if (ride.t >= 1) {
      if (ride.goingUp) {
        const end = ride.landHigh || ride.end;
        const y = ride.landHigh ? ride.landHigh.y : end.y - 0.85;
        unit.mesh.position.set(end.x, y, end.z);
        if (this._soldierOverlaps(unit.mesh.position.x, unit.mesh.position.y, unit.mesh.position.z)) {
          this._resolveEmbed(unit);
        }
        // Prefer standing on deck solid
        if (this.world && this.world.getWalkHeight) {
          const wh = this.world.getWalkHeight(unit.mesh.position.x, unit.mesh.position.z);
          if (wh != null) unit.mesh.position.y = wh;
        }
        unit.onGround = true;
      } else {
        if (ride.landLow) {
          unit.mesh.position.copy(ride.landLow);
          if (this._soldierOverlaps(unit.mesh.position.x, unit.mesh.position.y, unit.mesh.position.z)) {
            this._resolveEmbed(unit);
          }
        } else {
          this._placeClearLanding(unit);
        }
        unit.onGround = true;
      }
      unit.zipRide = null;
      unit.velY = 0;
      unit.stuckTime = 0;
      unit.blockTime = 0;
      unit.mesh.visible = true;
      return true;
    }
    const p = ride.start.clone().lerp(ride.end, ride.t);
    const sag = Math.sin(ride.t * Math.PI) * 0.55;
    unit.mesh.position.set(p.x, p.y - sag - 1.05, p.z);
    return false;
  };

  /* ---------- Collision / unstuck ---------- */

  AI.prototype._aiBreakBlock = function (x, y, z) {
    const w = this.world;
    x = Math.floor(x);
    y = Math.floor(y);
    z = Math.floor(z);
    if (y <= 1) return false;
    const BLOCK = global.VF.BLOCK;
    const t = w.get(x, y, z);
    if (t === BLOCK.AIR || t === BLOCK.WATER) return false;
    if (t === BLOCK.BEDROCK) return false;
    if (w._isStructureSolid && !w._isStructureSolid(x, y, z)) return false;
    if (w._isBaseKeepClear && w._isBaseKeepClear(x, z, 0) && y <= 6) return false;
    return w.breakBlock ? !!w.breakBlock(x, y, z) : false;
  };

  AI.prototype._breakOverlapping = function (unit) {
    const pos = unit.mesh.position;
    const box = this._soldierBoxAt(pos.x, pos.y, pos.z);
    let broke = false;
    for (let vx = Math.floor(box.min.x); vx <= Math.floor(box.max.x); vx++) {
      for (let vy = Math.floor(box.min.y); vy <= Math.floor(box.max.y); vy++) {
        for (let vz = Math.floor(box.min.z); vz <= Math.floor(box.max.z); vz++) {
          if (this.world._isStructureSolid(vx, vy, vz) && this._aiBreakBlock(vx, vy, vz)) {
            broke = true;
          }
        }
      }
    }
    return broke;
  };

  AI.prototype._breakAhead = function (unit) {
    const pos = unit.mesh.position;
    const yaw = unit.mesh.rotation.y;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    let broke = false;
    for (let d = 0.6; d <= 1.8; d += 0.6) {
      const x = pos.x + fx * d;
      const z = pos.z + fz * d;
      for (let dy = 0; dy <= 2; dy++) {
        if (this._aiBreakBlock(x, pos.y + dy, z)) broke = true;
      }
    }
    return broke;
  };

  AI.prototype._resolveEmbed = function (unit) {
    const pos = unit.mesh.position;
    if (!this._soldierOverlaps(pos.x, pos.y, pos.z)) return false;

    for (let dy = 0.25; dy <= 4; dy += 0.25) {
      if (!this._soldierOverlaps(pos.x, pos.y + dy, pos.z)) {
        pos.y += dy;
        return true;
      }
    }
    for (let r = 0.4; r <= 4; r += 0.4) {
      for (let a = 0; a < 8; a++) {
        const ang = (a * Math.PI) / 4;
        const x = pos.x + Math.cos(ang) * r;
        const z = pos.z + Math.sin(ang) * r;
        const y = this._clearStandY(x, z);
        if (y != null && this._teamSide(x, z) === unit.team && !this._inRiver(x, z)) {
          pos.set(x, y, z);
          return true;
        }
      }
    }
    this._breakOverlapping(unit);
    const y2 = this._clearStandY(pos.x, pos.z);
    if (y2 != null) pos.y = y2;
    return true;
  };

  AI.prototype._updatePhysics = function (unit, dt) {
    if (!unit || !unit.alive || unit.zipRide || unit.vehicleId != null) return;
    const pos = unit.mesh.position;
    unit.mesh.visible = true;
    this._updateKnockback(unit, dt);
    unit.jumpCd = Math.max(0, (unit.jumpCd || 0) - dt);

    // Stay on bridge after zip-up — do not snap to ground under the deck
    if (unit.role === 'zip' && unit.zipPhase === 'wait') {
      unit.velY = 0;
      unit.onGround = true;
      if (this._soldierOverlaps(pos.x, pos.y, pos.z)) this._resolveEmbed(unit);
      return;
    }

    if (this._soldierOverlaps(pos.x, pos.y, pos.z)) {
      this._resolveEmbed(unit);
      unit.stuckTime = (unit.stuckTime || 0) + dt;
    } else {
      unit.stuckTime = Math.max(0, (unit.stuckTime || 0) - dt * 0.6);
    }

    // Only jump while engaging — patrol should repath, not hop endlessly
    const allowJump = unit.state === 'engage' && (unit.jumpCd || 0) <= 0;

    if (unit._moveBlocked) {
      unit.blockTime = (unit.blockTime || 0) + dt;
      if (allowJump && unit.onGround && unit.blockTime > 0.35 && (unit.velY || 0) <= 0.05) {
        unit.velY = JUMP_VEL;
        unit.onGround = false;
        unit.jumpCd = JUMP_COOLDOWN;
      }
      if (unit.blockTime > 0.75) {
        if (!this._breakAhead(unit)) this._breakOverlapping(unit);
        unit.blockTime = 0.2;
      }
    } else {
      unit.blockTime = Math.max(0, (unit.blockTime || 0) - dt);
    }

    if ((unit.stuckTime || 0) > 1.2) {
      this._breakOverlapping(unit);
      this._resolveEmbed(unit);
      unit.stuckTime = 0.4;
      if (allowJump && unit.onGround) {
        unit.velY = JUMP_VEL * 0.85;
        unit.onGround = false;
        unit.jumpCd = JUMP_COOLDOWN;
      }
    }

    unit.velY = (unit.velY || 0) - GRAVITY * dt;
    pos.y += unit.velY * dt;

    const gy = this._feetY(pos.x, pos.z);
    if (unit.velY <= 0 && pos.y <= gy + 0.08) {
      if (!this._soldierOverlaps(pos.x, gy, pos.z)) {
        pos.y = gy;
        unit.velY = 0;
        unit.onGround = true;
      } else {
        const cy = this._clearStandY(pos.x, pos.z);
        if (cy != null) {
          pos.y = cy;
          unit.velY = 0;
          unit.onGround = true;
        } else {
          this._resolveEmbed(unit);
          unit.velY = 0;
          unit.onGround = true;
        }
      }
    } else if (pos.y > gy + 0.15) {
      unit.onGround = false;
    }

    if (this._soldierOverlaps(pos.x, pos.y, pos.z)) {
      if (unit.velY > 0) unit.velY = 0;
      this._resolveEmbed(unit);
    }
  };

  /* ---------- Movement ---------- */

  AI.prototype._moveAxis = function (unit, axis, delta) {
    if (Math.abs(delta) < 1e-8) return false;
    const pos = unit.mesh.position;
    const before = pos[axis];
    const beforeY = pos.y;
    const wasGrounded = unit.onGround;
    pos[axis] += delta;

    // Pad/base patrol can skim shore; only hard-block river + buildings
    const enforceTeam = unit.role !== 'pad' && unit.state !== 'patrol' && unit.state !== 'idle';
    if (
      this._inRiver(pos.x, pos.z) ||
      this._insideBuilding(pos.x, pos.z, 0.25) ||
      (enforceTeam && this._teamSide(pos.x, pos.z) !== unit.team)
    ) {
      pos[axis] = before;
      return false;
    }

    if (this.world.sampleTerrainFootprint && wasGrounded) {
      const mx = axis === 'x' ? delta : 0;
      const mz = axis === 'z' ? delta : 0;
      const sample = this.world.sampleTerrainFootprint(pos.x, pos.z, SOLDIER_RADIUS, mx, mz);
      const rise = sample.center - beforeY;
      if (sample.blocked || rise > TERRAIN_STEP_UP) {
        pos[axis] = before;
        pos.y = beforeY;
        return false;
      }
      if (rise > 0 || rise >= -TERRAIN_SNAP_DOWN) pos.y = sample.center;
    }

    if (!this._soldierOverlaps(pos.x, pos.y, pos.z)) return true;

    pos.y = beforeY + STEP_UP;
    if (
      !this._inRiver(pos.x, pos.z) &&
      !this._insideBuilding(pos.x, pos.z, 0.25) &&
      !this._soldierOverlaps(pos.x, pos.y, pos.z)
    ) {
      return true;
    }

    pos.y = beforeY;
    pos[axis] = before;
    return false;
  };

  AI.prototype._moveToward = function (unit, target, dt, stopDist) {
    const pos = unit.mesh.position;
    unit._moveBlocked = false;
    if (!target) return 0;
    const dir = this._tmpDir.copy(target).sub(pos);
    dir.y = 0;
    const dist = dir.length();
    if (dist <= stopDist) return dist;
    dir.normalize();

    let step = unit.speed * feelAi().speedMul * dt;
    if (step > MAX_STEP) step = MAX_STEP;

    const mx = this._moveAxis(unit, 'x', dir.x * step);
    const mz = this._moveAxis(unit, 'z', dir.z * step);
    let moved = mx || mz;
    if (!moved) {
      const side = this._tmpSide.set(-dir.z, 0, dir.x);
      if (this._moveAxis(unit, 'x', side.x * step * 0.9)) moved = true;
      else if (this._moveAxis(unit, 'x', -side.x * step * 0.9)) moved = true;
      if (this._moveAxis(unit, 'z', side.z * step * 0.9)) moved = true;
      else if (this._moveAxis(unit, 'z', -side.z * step * 0.9)) moved = true;
    }

    unit._moveBlocked = !moved;
    if (moved) this._faceToward(unit, target, dt);
    return dist;
  };

  AI.prototype._separateAll = function (dt) {
    const list = this._sepList;
    list.length = 0;
    const teams = [this.blue, this.red];
    for (let t = 0; t < teams.length; t++) {
      for (let i = 0; i < teams[t].length; i++) {
        const u = teams[t][i];
        if (u.alive && u.mesh && !u.zipRide && u.vehicleId == null) {
          u._sepId = list.length;
          list.push(u);
        }
      }
    }
    const cell = SEP_DIST;
    const buckets = this._sepBuckets || (this._sepBuckets = new Map());
    buckets.clear();
    for (let i = 0; i < list.length; i++) {
      const p = list[i].mesh.position;
      const key = ((p.x / cell) | 0) + ',' + ((p.z / cell) | 0);
      let arr = buckets.get(key);
      if (!arr) {
        arr = [];
        buckets.set(key, arr);
      }
      arr.push(list[i]);
    }
    const pushScale = Math.min(1, (dt || 0.016) * 10);
    const dirs = [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const pa = a.mesh.position;
      const cx = (pa.x / cell) | 0;
      const cz = (pa.z / cell) | 0;
      for (let d = 0; d < dirs.length; d++) {
        const neighbors = buckets.get(cx + dirs[d][0] + ',' + (cz + dirs[d][1]));
        if (!neighbors) continue;
        for (let j = 0; j < neighbors.length; j++) {
          const b = neighbors[j];
          if ((b._sepId || 0) <= (a._sepId || 0)) continue;
          const pb = b.mesh.position;
          let dx = pa.x - pb.x;
          let dz = pa.z - pb.z;
          let d2 = dx * dx + dz * dz;
          if (d2 >= SEP_DIST_SQ || d2 < 1e-8) {
            if (d2 < 1e-8) {
              dx = Math.cos(i + j);
              dz = Math.sin(i + j);
              d2 = 1;
            } else continue;
          }
          const dist = Math.sqrt(d2);
          const push = ((SEP_DIST - dist) / dist) * 0.45 * pushScale;
          const ox = dx * push;
          const oz = dz * push;
          const ax = pa.x + ox;
          const az = pa.z + oz;
          const bx = pb.x - ox;
          const bz = pb.z - oz;
          if (this._isWalkable(ax, az, a.team) && !this._soldierOverlaps(ax, pa.y, az)) {
            pa.x = ax;
            pa.z = az;
          }
          if (this._isWalkable(bx, bz, b.team) && !this._soldierOverlaps(bx, pb.y, bz)) {
            pb.x = bx;
            pb.z = bz;
          }
        }
      }
    }
  };

  /* ---------- Vehicles ---------- */

  AI.prototype._vehicleWeaponDef = function (vehicles, weaponId) {
    const defs =
      (vehicles && (vehicles.weaponDefinitions || vehicles.weaponDefs)) ||
      (global.VF && global.VF.VEHICLE_WEAPONS) ||
      {};
    return defs[weaponId] || null;
  };

  AI.prototype._nearestEnemyVehicle = function (unit, vehicles, range, from) {
    if (!vehicles || typeof vehicles.getAll !== 'function') return null;
    const origin = from || (unit.mesh && unit.mesh.position);
    if (!origin) return null;
    const list = vehicles.getAll();
    let best = null;
    let bestD = range;
    for (let i = 0; i < list.length; i++) {
      const vehicle = list[i];
      if (
        !vehicle ||
        !vehicle.alive ||
        vehicle.team === unit.team ||
        vehicle.id === unit.vehicleId ||
        !vehicle.position
      ) {
        continue;
      }
      const dist = Math.hypot(
        vehicle.position.x - origin.x,
        vehicle.position.z - origin.z
      );
      if (dist < bestD) {
        best = vehicle;
        bestD = dist;
      }
    }
    return best ? { vehicle: best, dist: bestD } : null;
  };

  AI.prototype._vehicleLineClear = function (from, to) {
    const vehicles = global.VF && global.VF.Vehicles;
    if (vehicles && vehicles.raycastWorld) {
      const direction = to.clone().sub(from);
      const distance = direction.length();
      if (distance <= 0.01) return true;
      direction.divideScalar(distance);
      const hit = vehicles.raycastWorld(from, direction, distance);
      return !hit || hit.distance >= distance - 0.35;
    }
    if (
      !this.world ||
      typeof this.world.get !== 'function' ||
      typeof this.world._isSolid !== 'function' ||
      !global.VF ||
      !global.VF.BLOCK
    ) {
      return true;
    }
    return this._hasLOS(from, to);
  };

  AI.prototype._vehicleAimPoint = function (target, kind) {
    if (!target) return null;
    if (kind === 'vehicle') {
      const dims = target.def && target.def.dimensions;
      return new THREE.Vector3(
        target.position.x,
        target.position.y + (dims ? dims.height * 0.52 : 1.2),
        target.position.z
      );
    }
    if (target === this.player) {
      if (this.player.getEyePosition) {
        const eye = this.player.getEyePosition().clone();
        eye.y -= 0.35;
        return eye;
      }
      return this.player.object.position.clone().add(new THREE.Vector3(0, 1.35, 0));
    }
    return target.mesh
      ? target.mesh.position.clone().add(new THREE.Vector3(0, 1.25, 0))
      : null;
  };

  AI.prototype._tryEngineerRpg = function (unit, dt) {
    if (
      unit.classId !== 'engineer' ||
      unit.vehicleId != null ||
      unit.zipRide ||
      (unit.rpgAmmo || 0) <= 0 ||
      (unit.rpgCd || 0) > 0
    ) {
      return false;
    }
    const vehicles = global.VF && global.VF.Vehicles;
    if (
      !vehicles ||
      typeof vehicles.getById !== 'function' ||
      typeof vehicles.getAll !== 'function' ||
      typeof vehicles.launchProjectile !== 'function'
    ) {
      return false;
    }

    let target = unit._vehicleTargetId
      ? vehicles.getById(unit._vehicleTargetId)
      : null;
    if (
      !target ||
      !target.alive ||
      target.team === unit.team ||
      Math.hypot(
        target.position.x - unit.mesh.position.x,
        target.position.z - unit.mesh.position.z
      ) > RPG_RANGE
    ) {
      target = null;
    }
    unit._rpgScanCd = Math.max(0, (unit._rpgScanCd || 0) - dt);
    if (!target && unit._rpgScanCd <= 0) {
      const hit = this._nearestEnemyVehicle(unit, vehicles, RPG_RANGE);
      target = hit && hit.vehicle;
      unit._rpgScanCd = 0.22 + Math.random() * 0.18;
    }
    if (!target) {
      unit._vehicleTargetId = null;
      return false;
    }

    const origin = unit.mesh.position.clone().add(new THREE.Vector3(0, 1.35, 0));
    const targetPoint = this._vehicleAimPoint(target, 'vehicle');
    if (!targetPoint || !this._vehicleLineClear(origin, targetPoint)) return false;
    const direction = targetPoint.clone().sub(origin);
    if (direction.lengthSq() < 0.01) return false;
    direction.normalize();
    this._faceToward(unit, targetPoint, dt);
    const shot = vehicles.launchProjectile({
      weaponId: 'rpg',
      actor: unit,
      team: unit.team,
      origin: origin,
      direction: direction,
    });
    if (!shot) return false;
    unit.rpgAmmo = Math.max(0, unit.rpgAmmo - 1);
    unit.rpgCd = RPG_COOLDOWN;
    unit._vehicleTargetId = target.id;
    unit._vehicleTargetKind = 'vehicle';
    unit._lastCombatAt = performance.now();
    unit.state = 'anti_vehicle';
    return true;
  };

  AI.prototype._vehicleSeatOpen = function (seat) {
    return !!(seat && !seat.occupant && seat.occupantId == null);
  };

  AI.prototype._vehicleOpenSeatCount = function (vehicle) {
    if (!vehicle || !vehicle.seats) return 0;
    let count = 0;
    for (let i = 0; i < vehicle.seats.length; i++) {
      if (this._vehicleSeatOpen(vehicle.seats[i])) count++;
    }
    return count;
  };

  AI.prototype._preferredVehicleSeat = function (vehicles, vehicle) {
    if (!vehicles || typeof vehicles.getOpenSeat !== 'function') return null;
    const roles = ['driver', 'gunner', 'passenger'];
    for (let i = 0; i < roles.length; i++) {
      const seat = vehicles.getOpenSeat(vehicle, roles[i]);
      if (seat && seat.role === roles[i] && this._vehicleSeatOpen(seat)) return seat;
    }
    const fallback = vehicles.getOpenSeat(vehicle);
    return this._vehicleSeatOpen(fallback) ? fallback : null;
  };

  AI.prototype._unitForVehicleSeat = function (seat) {
    if (!seat) return null;
    if (seat.occupant) return seat.occupant;
    if (seat.occupantId == null) return null;
    const id = String(seat.occupantId);
    if (this.player && String(this.player.entityId || 'player-local') === id) {
      return this.player;
    }
    const lists = [this.blue, this.red];
    for (let l = 0; l < lists.length; l++) {
      for (let i = 0; i < lists[l].length; i++) {
        if (lists[l][i] && String(lists[l][i].entityId) === id) return lists[l][i];
      }
    }
    return null;
  };

  AI.prototype._vehicleReservationInfo = function (vehicle, unit) {
    const info = { total: 0, sameSquad: 0, otherSquad: 0 };
    const lists = [this.blue, this.red];
    for (let l = 0; l < lists.length; l++) {
      for (let i = 0; i < lists[l].length; i++) {
        const other = lists[l][i];
        if (
          !other ||
          other === unit ||
          !other.alive ||
          other.vehicleId != null ||
          other._vehicleSeekId !== vehicle.id
        ) {
          continue;
        }
        info.total++;
        if (unit.squadId && other.squadId === unit.squadId) info.sameSquad++;
        else if (unit.squadId && other.squadId) info.otherSquad++;
      }
    }
    return info;
  };

  AI.prototype._vehicleSquadOccupancy = function (vehicle, unit) {
    const info = { sameSquad: 0, otherSquad: 0 };
    if (!vehicle || !vehicle.seats || !unit.squadId) return info;
    for (let i = 0; i < vehicle.seats.length; i++) {
      const seat = vehicle.seats[i];
      if (this._vehicleSeatOpen(seat)) continue;
      const rider = this._unitForVehicleSeat(seat);
      if (rider && rider.squadId === unit.squadId) info.sameSquad++;
      else info.otherSquad++;
    }
    return info;
  };

  AI.prototype._cancelVehicleSeek = function (unit) {
    unit._vehicleSeekId = null;
    if (unit.state === 'seek_vehicle') unit.state = 'idle';
  };

  AI.prototype._mountVehicle = function (unit, vehicles, vehicle) {
    const seat = this._preferredVehicleSeat(vehicles, vehicle);
    if (!seat || unit.zipRide) return false;
    if (!vehicles.mount(unit, vehicle, seat.index)) return false;
    unit.zipRide = null;
    unit._vehicleSeekId = null;
    unit._vehicleTargetId = null;
    unit._vehicleTargetKind = null;
    unit._vehicleTarget = null;
    unit._vehicleCombatScanCd = 0;
    unit.vehicleWeaponIndex = 0;
    unit.velY = 0;
    unit.onGround = true;
    unit._moveBlocked = false;
    unit._vehicleStuckTime = 0;
    unit._vehicleReverseTime = 0;
    unit._vehicleReverseCooldown = 0;
    unit._vehicleLastX = vehicle.position.x;
    unit._vehicleLastZ = vehicle.position.z;
    unit._vehicleBoardingWait = unit.vehicleRole === 'driver' ? 3 : 0;
    unit.state = 'vehicle_' + (unit.vehicleRole || 'passenger');
    if (unit.mesh) unit.mesh.visible = false;
    return true;
  };

  AI.prototype._updateVehicleSeeking = function (unit, dt, doBrain) {
    if (
      unit.vehicleId != null ||
      unit.downed ||
      unit.zipRide ||
      unit.role === 'zip' ||
      (unit._vehicleMountCooldown || 0) > 0
    ) {
      return false;
    }
    const vehicles = global.VF && global.VF.Vehicles;
    if (
      !vehicles ||
      typeof vehicles.getById !== 'function' ||
      typeof vehicles.findNearby !== 'function' ||
      typeof vehicles.getOpenSeat !== 'function' ||
      typeof vehicles.mount !== 'function'
    ) {
      this._cancelVehicleSeek(unit);
      return false;
    }

    const recentlyFought =
      unit._lastCombatAt && performance.now() - unit._lastCombatAt < 2500;
    if (recentlyFought || (!doBrain && unit.state === 'engage')) {
      this._cancelVehicleSeek(unit);
      return false;
    }
    if (doBrain && this._nearestHostile(unit, ENGAGE_RANGE)) {
      this._cancelVehicleSeek(unit);
      return false;
    }

    unit._vehicleSeekCd = Math.max(0, (unit._vehicleSeekCd || 0) - dt);
    let vehicle = unit._vehicleSeekId
      ? vehicles.getById(unit._vehicleSeekId)
      : null;
    if (vehicle) {
      const open = this._vehicleOpenSeatCount(vehicle);
      const reserved = this._vehicleReservationInfo(vehicle, unit).total;
      if (
        !vehicle.alive ||
        vehicle.team !== unit.team ||
        !open ||
        reserved >= open
      ) {
        vehicle = null;
        this._cancelVehicleSeek(unit);
      }
    }

    if (!vehicle && doBrain && unit._vehicleSeekCd <= 0) {
      const nearby = vehicles.findNearby(unit, VEHICLE_SEEK_RANGE, unit.team);
      let bestScore = Infinity;
      for (let i = 0; i < nearby.length; i++) {
        const candidate = nearby[i];
        const open = this._vehicleOpenSeatCount(candidate);
        const reservations = this._vehicleReservationInfo(candidate, unit);
        if (!candidate.alive || !open || reservations.total >= open) continue;
        const dist = Math.hypot(
          candidate.position.x - unit.mesh.position.x,
          candidate.position.z - unit.mesh.position.z
        );
        const occupancy = this._vehicleSquadOccupancy(candidate, unit);
        const score =
          dist -
          occupancy.sameSquad * 58 -
          reservations.sameSquad * 38 +
          occupancy.otherSquad * 20 +
          reservations.otherSquad * 12;
        if (score < bestScore) {
          bestScore = score;
          vehicle = candidate;
        }
      }
      unit._vehicleSeekCd = 1.2 + Math.random() * 1.4;
      if (vehicle) unit._vehicleSeekId = vehicle.id;
    }
    if (!vehicle) return false;

    unit.state = 'seek_vehicle';
    unit.patrolTarget = null;
    const dist = Math.hypot(
      vehicle.position.x - unit.mesh.position.x,
      vehicle.position.z - unit.mesh.position.z
    );
    if (
      dist <= VEHICLE_MOUNT_RANGE &&
      Math.abs(vehicle.speed || 0) <= 5.5
    ) {
      if (this._mountVehicle(unit, vehicles, vehicle)) return true;
      this._cancelVehicleSeek(unit);
      unit._vehicleSeekCd = 0.25;
      return false;
    }
    this._moveToward(unit, vehicle.position, dt, 2.1);
    return true;
  };

  AI.prototype._vehicleGoalFor = function (unit, vehicle, dt) {
    if (unit._flagGoal) return unit._flagGoal;
    unit._vehicleGoalCd = Math.max(0, (unit._vehicleGoalCd || 0) - dt);
    if (unit._vehicleGoal && unit._vehicleGoalCd > 0) return unit._vehicleGoal;

    const C = global.VF && global.VF.Conquest;
    let best = null;
    let bestScore = Infinity;
    if (C && C.active && C.flags && C.flags.length) {
      for (let i = 0; i < C.flags.length; i++) {
        const flag = C.flags[i];
        const held = C._isFullyHeld
          ? C._isFullyHeld(flag, unit.team)
          : flag.owner === unit.team && !flag.contested;
        const dist = Math.hypot(
          flag.x - vehicle.position.x,
          flag.z - vehicle.position.z
        );
        let score = dist;
        if (flag.contested) score -= 90;
        else if (!held && flag.owner === 'neutral') score -= 55;
        else if (!held) score -= 35;
        else score += 75;
        if (score < bestScore) {
          bestScore = score;
          best = {
            x: flag.x,
            z: flag.z,
            r: flag.radius || 16,
            letter: flag.letter,
          };
        }
      }
    } else if (unit.patrolTarget) {
      best = {
        x: unit.patrolTarget.x,
        z: unit.patrolTarget.z,
        r: 8,
      };
    }
    unit._vehicleGoal = best;
    unit._vehicleGoalCd = 1 + Math.random() * 0.6;
    return best;
  };

  AI.prototype._vehicleHasDriver = function (vehicle) {
    if (!vehicle || !vehicle.seats) return false;
    for (let i = 0; i < vehicle.seats.length; i++) {
      if (
        vehicle.seats[i].role === 'driver' &&
        !this._vehicleSeatOpen(vehicle.seats[i])
      ) {
        return true;
      }
    }
    return false;
  };

  AI.prototype._squadNeedsVehicleSeat = function (unit, vehicle) {
    if (!unit.squadId || this._vehicleOpenSeatCount(vehicle) <= 0) return false;
    const list = unit.team === 'enemy' ? this.red : this.blue;
    for (let i = 0; i < list.length; i++) {
      const mate = list[i];
      if (
        mate === unit ||
        !mate ||
        !mate.alive ||
        mate.downed ||
        mate.squadId !== unit.squadId ||
        mate.vehicleId != null
      ) {
        continue;
      }
      const dist = Math.hypot(
        mate.mesh.position.x - vehicle.position.x,
        mate.mesh.position.z - vehicle.position.z
      );
      if (dist <= 18) return true;
    }
    const playerTeam = (this.world && this.world._playerTeam) || 'ally';
    if (
      this.player &&
      unit.team === playerTeam &&
      this.player.squadId === unit.squadId &&
      this.player.vehicleId == null &&
      !this.player.dead &&
      this.player.object
    ) {
      const pos = this.player.object.position;
      if (Math.hypot(pos.x - vehicle.position.x, pos.z - vehicle.position.z) <= 18) {
        return true;
      }
    }
    return false;
  };

  AI.prototype._vehicleForwardBlocked = function (vehicle) {
    if (
      !vehicle ||
      !vehicle.position ||
      !vehicle.def ||
      !vehicle.def.dimensions ||
      !this.world ||
      typeof this.world.overlapsSolid !== 'function' ||
      typeof THREE === 'undefined' ||
      !THREE.Box3
    ) {
      return false;
    }
    const dims = vehicle.def.dimensions;
    const forwardX = -Math.sin(vehicle.yaw || 0);
    const forwardZ = -Math.cos(vehicle.yaw || 0);
    const sideX = -forwardZ;
    const sideZ = forwardX;
    const centerDist = dims.length * 0.5 + 0.75;
    const cx = vehicle.position.x + forwardX * centerDist;
    const cz = vehicle.position.z + forwardZ * centerDist;
    const halfW = dims.width * 0.36;
    const halfD = 0.55;
    const halfX = Math.abs(sideX) * halfW + Math.abs(forwardX) * halfD;
    const halfZ = Math.abs(sideZ) * halfW + Math.abs(forwardZ) * halfD;
    const box =
      this._vehicleProbeBox ||
      (this._vehicleProbeBox = new THREE.Box3(
        new THREE.Vector3(),
        new THREE.Vector3()
      ));
    box.min.set(cx - halfX, vehicle.position.y + 0.42, cz - halfZ);
    box.max.set(
      cx + halfX,
      vehicle.position.y + Math.min(2.2, dims.height * 0.78),
      cz + halfZ
    );
    box.excludeVehicleId = vehicle.id;
    try {
      return !!this.world.overlapsSolid(box);
    } catch (_) {
      return false;
    }
  };

  AI.prototype._setVehicleDriverInput = function (vehicles, vehicle, input) {
    if (vehicles && typeof vehicles.setDriverInput === 'function') {
      vehicles.setDriverInput(vehicle, input);
    }
  };

  AI.prototype._updateVehicleDriver = function (unit, vehicle, vehicles, dt) {
    unit.state = 'vehicle_driver';
    unit._vehicleReverseCooldown = Math.max(
      0,
      (unit._vehicleReverseCooldown || 0) - dt
    );
    if (
      unit._vehicleBoardingWait > 0 &&
      this._squadNeedsVehicleSeat(unit, vehicle)
    ) {
      unit._vehicleBoardingWait = Math.max(0, unit._vehicleBoardingWait - dt);
      unit._vehicleDriveIntent = false;
      unit._vehicleLastX = vehicle.position.x;
      unit._vehicleLastZ = vehicle.position.z;
      this._setVehicleDriverInput(vehicles, vehicle, {
        throttle: 0,
        steer: 0,
        brake: 1,
      });
      return;
    }
    unit._vehicleBoardingWait = 0;

    const goal = this._vehicleGoalFor(unit, vehicle, dt);
    if (!goal) {
      unit._vehicleDriveIntent = false;
      this._setVehicleDriverInput(vehicles, vehicle, {
        throttle: 0,
        steer: 0,
        brake: 1,
      });
      return;
    }
    const dx = goal.x - vehicle.position.x;
    const dz = goal.z - vehicle.position.z;
    const dist = Math.hypot(dx, dz);
    const stopDist = Math.max(5.5, Math.min(10, (goal.r || 16) * 0.38));
    if (dist <= stopDist) {
      unit._vehicleDriveIntent = false;
      unit._vehicleStuckTime = 0;
      unit._vehicleReverseTime = 0;
      unit._vehicleLastX = vehicle.position.x;
      unit._vehicleLastZ = vehicle.position.z;
      this._setVehicleDriverInput(vehicles, vehicle, {
        throttle: 0,
        steer: 0,
        brake: 1,
      });
      return;
    }

    if (unit._vehicleLastX != null && unit._vehicleDriveIntent) {
      const moved = Math.hypot(
        vehicle.position.x - unit._vehicleLastX,
        vehicle.position.z - unit._vehicleLastZ
      );
      if (moved < 0.018 && Math.abs(vehicle.speed || 0) < 1.25) {
        unit._vehicleStuckTime = (unit._vehicleStuckTime || 0) + dt;
      } else {
        unit._vehicleStuckTime = Math.max(
          0,
          (unit._vehicleStuckTime || 0) - dt * 1.8
        );
      }
    }
    unit._vehicleLastX = vehicle.position.x;
    unit._vehicleLastZ = vehicle.position.z;
    unit._vehicleProbeCd = Math.max(0, (unit._vehicleProbeCd || 0) - dt);
    let frontBlocked = false;
    if (
      unit._vehicleProbeCd <= 0 &&
      (unit._vehicleReverseTime || 0) <= 0
    ) {
      frontBlocked = this._vehicleForwardBlocked(vehicle);
      unit._vehicleProbeCd = 0.22;
    }
    if (
      unit._vehicleReverseCooldown <= 0 &&
      (frontBlocked || (unit._vehicleStuckTime || 0) > 0.72)
    ) {
      unit._vehicleReverseTime = 0.9 + Math.random() * 0.55;
      unit._vehicleReverseCooldown = 2;
      unit._vehicleRecoverySteer =
        Math.random() < 0.5 ? -0.78 : 0.78;
      unit._vehicleStuckTime = 0;
    }

    if ((unit._vehicleReverseTime || 0) > 0) {
      unit._vehicleReverseTime = Math.max(0, unit._vehicleReverseTime - dt);
      unit._vehicleDriveIntent = false;
      this._setVehicleDriverInput(vehicles, vehicle, {
        throttle: -0.82,
        steer: unit._vehicleRecoverySteer || 0.78,
        brake: 0,
      });
      return;
    }

    const wantYaw = Math.atan2(-dx, -dz);
    let error = wantYaw - (vehicle.yaw || 0);
    while (error > Math.PI) error -= Math.PI * 2;
    while (error < -Math.PI) error += Math.PI * 2;
    const absError = Math.abs(error);
    const steer = Math.max(-1, Math.min(1, -error * 1.45));
    let throttle = absError > 2.25 ? 0.2 : absError > 1.2 ? 0.42 : 1;
    if (dist < stopDist * 2.2) throttle = Math.min(throttle, 0.48);
    unit._vehicleDriveIntent = throttle > 0.1;
    this._setVehicleDriverInput(vehicles, vehicle, {
      throttle: throttle,
      steer: steer,
      brake: 0,
    });
  };

  AI.prototype._validMountedInfantryTarget = function (unit, target) {
    if (!target) return false;
    const playerTeam = (this.world && this.world._playerTeam) || 'ally';
    if (target === this.player) {
      return !!(
        unit.team !== playerTeam &&
        !this.player.dead &&
        this.player.health > 0 &&
        this.player.vehicleId == null
      );
    }
    return !!(
      target.alive &&
      target.team !== unit.team &&
      target.vehicleId == null &&
      target.mesh
    );
  };

  AI.prototype._updateVehicleCombat = function (unit, vehicle, vehicles, dt) {
    if (
      !vehicles ||
      typeof vehicles.getWeaponsForRole !== 'function' ||
      typeof vehicles.setAim !== 'function' ||
      typeof vehicles.fireWeapon !== 'function'
    ) {
      return;
    }
    const available = vehicles.getWeaponsForRole(vehicle, unit.vehicleRole) || [];
    if (!available.length) {
      unit._vehicleTargetId = null;
      unit._vehicleTarget = null;
      return;
    }
    const antiArmor = [];
    const antiInfantry = [];
    let vehicleRange = 0;
    let infantryRange = 0;
    for (let i = 0; i < available.length; i++) {
      const def = this._vehicleWeaponDef(vehicles, available[i]);
      if (!def) continue;
      if (def.damageType === 'antiArmor') {
        antiArmor.push(available[i]);
        vehicleRange = Math.max(vehicleRange, def.range || VEHICLE_TARGET_RANGE);
      } else if (def.damageType === 'explosive' || def.damageType === 'bullet') {
        antiInfantry.push(available[i]);
        infantryRange = Math.max(infantryRange, def.range || 120);
      }
    }

    let target = unit._vehicleTarget;
    let kind = unit._vehicleTargetKind;
    if (kind === 'vehicle') {
      target = unit._vehicleTargetId
        ? vehicles.getById(unit._vehicleTargetId)
        : null;
      if (
        !target ||
        !target.alive ||
        target.team === unit.team ||
        !antiArmor.length
      ) {
        target = null;
      }
    } else if (!this._validMountedInfantryTarget(unit, target)) {
      target = null;
    }

    unit._vehicleCombatScanCd = Math.max(
      0,
      (unit._vehicleCombatScanCd || 0) - dt
    );
    if (!target || unit._vehicleCombatScanCd <= 0) {
      target = null;
      kind = null;
      let vehicleHit = null;
      let infantryThreat = null;
      if (antiArmor.length) {
        vehicleHit = this._nearestEnemyVehicle(
          unit,
          vehicles,
          vehicleRange || VEHICLE_TARGET_RANGE,
          vehicle.position
        );
      }
      if (antiInfantry.length) {
        infantryThreat = this._nearestHostile(unit, infantryRange || 120);
      }
      if (
        vehicleHit &&
        (!infantryThreat || vehicleHit.dist <= infantryThreat.dist)
      ) {
        target = vehicleHit.vehicle;
        kind = 'vehicle';
      } else if (infantryThreat) {
        target = infantryThreat.isPlayer ? this.player : infantryThreat.unit;
        kind = 'infantry';
      }
      unit._vehicleCombatScanCd = 0.18 + Math.random() * 0.12;
      unit._vehicleTarget = target;
      unit._vehicleTargetKind = kind;
      unit._vehicleTargetId =
        target && kind === 'vehicle'
          ? target.id
          : target && (target.entityId || (target === this.player ? 'player-local' : null));
    }
    if (!target || !kind) return;

    const choices = kind === 'vehicle' ? antiArmor : antiInfantry;
    if (!choices.length) return;
    const weaponId = choices[0];
    const def = this._vehicleWeaponDef(vehicles, weaponId);
    const point = this._vehicleAimPoint(target, kind);
    if (!def || !point) return;
    const origin = new THREE.Vector3(
      vehicle.position.x,
      vehicle.position.y + (vehicle.def.dimensions.height || 2) * 0.7,
      vehicle.position.z
    );
    const direction = point.clone().sub(origin);
    const dist = direction.length();
    if (dist < 0.01 || dist > (def.range || VEHICLE_TARGET_RANGE)) return;
    direction.normalize();
    vehicles.setAim(vehicle, { target: point, role: unit.vehicleRole });
    if (!this._vehicleLineClear(origin, point)) return;
    unit.vehicleWeaponIndex = Math.max(0, available.indexOf(weaponId));
    const options =
      kind === 'vehicle'
        ? { targetVehicle: target, direction: direction }
        : { target: point, direction: direction };
    const shot = vehicles.fireWeapon(vehicle, weaponId, unit, options);
    if (shot) unit._lastCombatAt = performance.now();
  };

  AI.prototype._updateMountedPassenger = function (unit, vehicle, vehicles, dt) {
    unit.state = 'vehicle_passenger';
    if (
      vehicle.type === 'jeep' &&
      typeof vehicles.canUsePersonalWeapon === 'function' &&
      vehicles.canUsePersonalWeapon(unit)
    ) {
      const threat = this._nearestHostile(unit, unit.range || ENGAGE_RANGE);
      if (threat) {
        const target = threat.isPlayer
          ? {
              object: this.player.object,
              isPlayer: true,
              alive: !this.player.dead && this.player.health > 0,
            }
          : threat.unit;
        this._faceToward(unit, threat.pos, dt);
        this._tryShoot(unit, target, dt);
      } else {
        unit.shootCd = Math.max(0, (unit.shootCd || 0) - dt);
      }
    }
    if (vehicle.type !== 'ifv') return;

    const hasDriver = this._vehicleHasDriver(vehicle);
    if (!hasDriver) {
      this._setVehicleDriverInput(vehicles, vehicle, {
        throttle: 0,
        steer: 0,
        brake: 1,
      });
    }
    const goal = this._vehicleGoalFor(unit, vehicle, dt);
    const nearGoal =
      goal &&
      Math.hypot(
        vehicle.position.x - goal.x,
        vehicle.position.z - goal.z
      ) <= Math.max(10, (goal.r || 16) * 0.72);
    if (!nearGoal && hasDriver) return;
    unit.state = 'vehicle_exit_wait';
    if (Math.abs(vehicle.speed || 0) <= 2.2) {
      this._dismountAI(unit, {
        reason: hasDriver ? 'objective' : 'no-driver',
        silent: false,
      });
    }
  };

  AI.prototype._updateMountedSoldier = function (unit, dt) {
    const vehicles = global.VF && global.VF.Vehicles;
    if (!vehicles || typeof vehicles.getById !== 'function') {
      this._restoreOnFoot(unit);
      return false;
    }
    const vehicle = vehicles.getById(unit.vehicleId);
    if (!vehicle || !vehicle.alive) {
      this._dismountAI(unit, {
        reason: 'vehicle-unavailable',
        silent: true,
      });
      return false;
    }

    unit.zipRide = null;
    unit.velY = 0;
    unit.onGround = true;
    unit._moveBlocked = false;
    if (unit.mesh) unit.mesh.visible = false;
    if (unit.vehicleRole === 'driver') {
      this._updateVehicleDriver(unit, vehicle, vehicles, dt);
      this._updateVehicleCombat(unit, vehicle, vehicles, dt);
    } else if (unit.vehicleRole === 'gunner') {
      unit.state = 'vehicle_gunner';
      this._updateVehicleCombat(unit, vehicle, vehicles, dt);
    } else {
      this._updateMountedPassenger(unit, vehicle, vehicles, dt);
    }
    return true;
  };

  /* ---------- Brain ---------- */

  AI.prototype._engage = function (unit, threat, dt) {
    // Drop player chase immediately if they entered stealth
    if (
      threat &&
      threat.isPlayer &&
      global.VF.Skills &&
      global.VF.Skills.isPlayerStealthed(this.player)
    ) {
      unit.state = 'idle';
      unit._lastThreatPos = null;
      return;
    }
    unit.state = 'engage';
    unit.patrolTarget = null;
    if (!unit._lastThreatPos) unit._lastThreatPos = new THREE.Vector3();
    unit._lastThreatPos.copy(threat.pos);
    this._faceToward(unit, threat.pos, dt);
    if (threat.dist < 6) {
      const away = this._tmpAway.copy(unit.mesh.position).sub(threat.pos);
      away.y = 0;
      if (away.lengthSq() > 0.01) {
        away.normalize();
        const back = this._tmpBack.copy(unit.mesh.position).addScaledVector(away, 4);
        if (this._isWalkable(back.x, back.z, unit.team)) {
          this._moveToward(unit, back, dt, 0.6);
        }
      }
    }
    const shootTarget = threat.isPlayer
      ? {
          object: this.player.object,
          isPlayer: true,
          alive: !this.player.dead && this.player.health > 0,
        }
      : threat.unit;

    // Enemy AI may engage player turrets when closer / equally threatening
    let finalTarget = shootTarget;
    if (unit.team !== (this.world._playerTeam || 'ally')) {
      const skills = global.VF.game && global.VF.game.skills;
      if (skills && skills.getNearestTurret) {
        const hit = skills.getNearestTurret(
          unit.mesh.position,
          this.world._playerTeam || 'ally'
        );
        if (hit && hit.turret && hit.turret.alive && hit.dist < ENGAGE_RANGE) {
          const playerDist = threat.dist != null ? threat.dist : 999;
          if (hit.dist < playerDist * 1.15 || hit.dist < 14) {
            finalTarget = {
              isTurret: true,
              turret: hit.turret,
              mesh: hit.turret.mesh,
              alive: true,
            };
          }
        }
      }
    }
    this._tryShoot(unit, finalTarget, dt);
  };

  AI.prototype._updateBaseSoldier = function (unit, dt) {
    const home = unit.home;
    const distHome =
      home && home.cx != null
        ? Math.hypot(unit.mesh.position.x - home.cx, unit.mesh.position.z - home.cz)
        : 0;

    // Pad units: stay near refresh point (leash)
    if (unit.role === 'pad' && home && distHome > PAD_LEASH_R && !unit._flagGoal) {
      unit.state = 'patrol';
      unit.target = null;
      const back = new THREE.Vector3(home.cx, unit.mesh.position.y, home.cz);
      this._moveToward(unit, back, dt, 0.95);
      this._faceToward(unit, back, dt);
      unit.patrolTarget = null;
      return;
    }

    const threat = this._nearestHostile(unit, ENGAGE_RANGE);
    if (threat) {
      if (unit.role === 'pad' && !unit._flagGoal && home && distHome > PAD_PATROL_R + 2) {
        // Only engage if still near pad; otherwise return first
        const threatNearPad =
          Math.hypot(threat.mesh.position.x - home.cx, threat.mesh.position.z - home.cz) <=
          PAD_LEASH_R;
        if (!threatNearPad) {
          unit.state = 'patrol';
          const back = new THREE.Vector3(home.cx, unit.mesh.position.y, home.cz);
          this._moveToward(unit, back, dt, 0.95);
          return;
        }
      }
      this._engage(unit, threat, dt);
      return;
    }

    if (unit._flagGoal) {
      const g = unit._flagGoal;
      const dist = Math.hypot(unit.mesh.position.x - g.x, unit.mesh.position.z - g.z);
      const inner = (g.r || 16) * 0.45;
      if (dist > inner) {
        unit.state = 'patrol';
        this._tmpGoal.set(g.x, unit.mesh.position.y, g.z);
        this._moveToward(unit, this._tmpGoal, dt, 1);
        this._faceToward(unit, this._tmpGoal, dt);
        return;
      }
      if (
        !unit.patrolTarget ||
        Math.hypot(unit.patrolTarget.x - g.x, unit.patrolTarget.z - g.z) > (g.r || 16) * 0.75
      ) {
        const ang = Math.random() * Math.PI * 2;
        const rr = 2 + Math.random() * 6;
        const x = g.x + Math.cos(ang) * rr;
        const z = g.z + Math.sin(ang) * rr;
        const y = this._clearStandY(x, z);
        if (y != null) unit.patrolTarget = new THREE.Vector3(x, y, z);
        else unit.patrolTarget = null;
        unit.patrolWalk = 2 + Math.random() * 3;
      }
      if (unit.patrolTarget) {
        this._moveToward(unit, unit.patrolTarget, dt, 0.9);
        unit.patrolWalk -= dt;
        if ((unit.patrolWalk || 0) <= 0) unit.patrolTarget = null;
      }
      return;
    }

    if ((unit.patrolWait || 0) > 0) {
      unit.state = 'idle';
      unit.patrolWait -= dt;
      this._faceAwayFromHome(unit, dt);
      return;
    }

    unit.state = 'patrol';
    const needNew =
      !unit.patrolTarget ||
      (unit.role === 'pad'
        ? false
        : !this._isWalkable(unit.patrolTarget.x, unit.patrolTarget.z, unit.team));
    if (
      needNew ||
      (unit.role === 'pad' &&
        unit.patrolTarget &&
        home &&
        Math.hypot(unit.patrolTarget.x - home.cx, unit.patrolTarget.z - home.cz) > PAD_PATROL_R)
    ) {
      unit.patrolTarget = this._patrolPoint(unit);
      unit.patrolWalk = 2.5 + Math.random() * 4;
    }
    if (!unit.patrolTarget) {
      this._faceAwayFromHome(unit, dt);
      unit.patrolWait = 1 + Math.random();
      return;
    }

    const dist = this._moveToward(unit, unit.patrolTarget, dt, 0.9);
    unit.patrolWalk -= dt;
    // Blocked while patrolling → pick a new waypoint instead of hopping
    if (unit._moveBlocked) {
      unit._blockRepath = (unit._blockRepath || 0) + dt;
      if (unit._blockRepath > 0.45) {
        unit.patrolTarget = null;
        unit.patrolWait = 0.35 + Math.random() * 0.8;
        unit._blockRepath = 0;
        unit.blockTime = 0;
        return;
      }
    } else {
      unit._blockRepath = 0;
    }
    if (dist <= 1.0 || unit.patrolWalk <= 0) {
      unit.patrolTarget = null;
      unit.patrolWait = 1.2 + Math.random() * 2.8;
    }
  };

  AI.prototype._updateZipSoldier = function (unit, dt) {
    // Finish any in-flight ride first
    if (unit.zipRide) {
      unit.state = unit.zipPhase === 'ascend' ? 'zip_ascend' : 'zip_descend';
      if (this._updateZipRide(unit, dt)) {
        if (unit.zipPhase === 'descend') {
          unit.zipPhase = 'patrol';
          unit.patrolBudget = 10 + Math.random() * 8;
          unit.patrolWait = 0.6 + Math.random();
          unit.patrolTarget = null;
        } else if (unit.zipPhase === 'ascend') {
          unit.zipPhase = 'wait';
          unit.patrolWait = 1.2 + Math.random() * 1.5;
        }
      }
      return;
    }

    // On ground: may engage
    if (unit.zipPhase === 'patrol' || unit.zipPhase === 'return') {
      const threat = this._nearestHostile(unit, ENGAGE_RANGE);
      if (threat) {
        this._engage(unit, threat, dt);
        return;
      }
    }

    if (unit.zipPhase === 'wait') {
      unit.state = 'idle';
      unit.patrolWait -= dt;
      if (unit.patrolWait <= 0 && unit.zipLine) {
        this._beginZipRide(unit, unit.zipLine.end, unit.zipLine.start);
        unit.zipPhase = 'descend';
      }
      return;
    }

    if (unit.zipPhase === 'return') {
      unit.state = 'return_zip';
      const line = unit.zipLine;
      if (!line) {
        unit.zipPhase = 'patrol';
        return;
      }
      const dest = new THREE.Vector3(
        line.start.x,
        this._feetY(line.start.x, line.start.z),
        line.start.z
      );
      const dist = this._moveToward(unit, dest, dt, 1.2);
      if (dist <= 1.4) {
        this._beginZipRide(unit, line.start, line.end);
        unit.zipPhase = 'ascend';
      }
      return;
    }

    // Patrol around ground station
    unit.zipPhase = 'patrol';
    unit.state = 'patrol';
    unit.patrolBudget -= dt;

    if ((unit.patrolWait || 0) > 0) {
      unit.state = 'idle';
      unit.patrolWait -= dt;
      if (unit.patrolBudget <= 0 && unit.patrolWait <= 0) {
        unit.zipPhase = 'return';
        unit.patrolTarget = null;
      }
      return;
    }

    if (!unit.patrolTarget || !this._isWalkable(unit.patrolTarget.x, unit.patrolTarget.z, unit.team)) {
      unit.patrolTarget = this._patrolPoint(unit);
      unit.patrolWalk = 2.2 + Math.random() * 3.5;
    }

    if (!unit.patrolTarget) {
      unit.patrolWait = 0.8 + Math.random();
      return;
    }

    // Keep inside 36 of anchor
    const a = unit.zipAnchor;
    if (a) {
      const dA = Math.hypot(unit.patrolTarget.x - a.x, unit.patrolTarget.z - a.z);
      if (dA > ZIP_PATROL_R) {
        unit.patrolTarget = this._patrolPoint(unit);
      }
    }

    const dist = this._moveToward(unit, unit.patrolTarget, dt, 0.9);
    unit.patrolWalk -= dt;
    if (unit._moveBlocked) {
      unit._blockRepath = (unit._blockRepath || 0) + dt;
      if (unit._blockRepath > 0.45) {
        unit.patrolTarget = null;
        unit.patrolWait = 0.3 + Math.random() * 0.7;
        unit._blockRepath = 0;
        unit.blockTime = 0;
        return;
      }
    } else {
      unit._blockRepath = 0;
    }
    if (dist <= 1.0 || unit.patrolWalk <= 0) {
      unit.patrolTarget = null;
      unit.patrolWait = 1.0 + Math.random() * 2.2;
    }

    if (unit.patrolBudget <= 0) {
      unit.zipPhase = 'return';
      unit.patrolTarget = null;
      unit.patrolWait = 0;
    }
  };

  AI.prototype._pickReviveTarget = function (unit) {
    const R = global.VF && global.VF.Revive;
    if (!R || !R.getDowned) return null;
    const states = R.getDowned(unit.team);
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < states.length; i++) {
      const state = states[i];
      if (!state || state.status !== 'pending' || state.entity === unit) continue;
      if (R._canRevive && !R._canRevive(unit, state.entity)) continue;
      const pos = state.entity.object
        ? state.entity.object.position
        : state.entity.mesh && state.entity.mesh.position;
      if (!pos) continue;
      const dist = Math.hypot(unit.mesh.position.x - pos.x, unit.mesh.position.z - pos.z);
      if (dist > 24) continue;
      const score = dist - (state.called ? 5 : 0) - (unit.classId === 'support' ? 2 : 0);
      if (score < bestScore) {
        best = state;
        bestScore = score;
      }
    }
    return best;
  };

  AI.prototype._updateRescue = function (unit, dt, doBrain) {
    if (doBrain || !unit._rescueState || unit._rescueState.status !== 'pending') {
      unit._rescueState = this._pickReviveTarget(unit);
    }
    const state = unit._rescueState;
    if (!state || state.status !== 'pending') {
      unit._rescueState = null;
      return false;
    }
    const pos = state.entity.object
      ? state.entity.object.position
      : state.entity.mesh && state.entity.mesh.position;
    if (!pos) {
      unit._rescueState = null;
      return false;
    }
    unit.state = 'rescue';
    const dist = Math.hypot(unit.mesh.position.x - pos.x, unit.mesh.position.z - pos.z);
    if (dist > 1.9) this._moveToward(unit, pos, dt, 1.05);
    this._faceToward(unit, pos, dt);
    return true;
  };

  AI.prototype._updateSoldier = function (unit, dt, doBrain) {
    if (!unit.alive) return;
    unit.rpgCd = Math.max(0, (unit.rpgCd || 0) - dt);
    unit._vehicleMountCooldown = Math.max(
      0,
      (unit._vehicleMountCooldown || 0) - dt
    );
    if (unit.vehicleId != null && this._updateMountedSoldier(unit, dt)) return;
    if (
      unit.vehicleId == null &&
      typeof unit.state === 'string' &&
      unit.state.indexOf('vehicle_') === 0
    ) {
      this._restoreOnFoot(unit);
    }

    unit._moveBlocked = false;
    const px = unit.mesh.position.x;
    const pz = unit.mesh.position.z;
    let distP = 0;
    if (this.player && this.player.object) {
      const pp = this.player.object.position;
      distP = Math.hypot(px - pp.x, pz - pp.z);
    }
    if (unit.mesh) unit.mesh.visible = distP <= 140;
    const rescuing = this._updateRescue(unit, dt, doBrain);
    const firedRpg = !rescuing && this._tryEngineerRpg(unit, dt);
    const seekingVehicle =
      !rescuing &&
      !firedRpg &&
      this._updateVehicleSeeking(unit, dt, doBrain);
    if (!rescuing && !firedRpg && !seekingVehicle && doBrain) {
      if (unit.role === 'zip') this._updateZipSoldier(unit, dt);
      else this._updateBaseSoldier(unit, dt);
    } else if (
      !rescuing &&
      !firedRpg &&
      !seekingVehicle &&
      unit.state === 'patrol' &&
      unit.patrolTarget
    ) {
      this._moveToward(unit, unit.patrolTarget, dt, 0.9);
    } else if (
      !rescuing &&
      !firedRpg &&
      !seekingVehicle &&
      unit.state === 'engage' &&
      unit._lastThreatPos
    ) {
      if (global.VF.Skills && global.VF.Skills.isPlayerStealthed(this.player)) {
        unit.state = 'idle';
        unit._lastThreatPos = null;
      } else {
        this._faceToward(unit, unit._lastThreatPos, dt);
      }
    }
    this._updatePhysics(unit, dt);
    if (unit.vehicleId != null) return;

    if (distP <= 70 && global.VF.Soldier && global.VF.Soldier.updateLocomotion) {
      const dx = unit.mesh.position.x - px;
      const dz = unit.mesh.position.z - pz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const maxStep = Math.max(0.001, unit.speed * feelAi().speedMul * dt);
      const speedRatio = Math.min(1.35, dist / maxStep);
      const moving = dist > 0.002 && !unit.zipRide;
      global.VF.Soldier.updateLocomotion(unit.mesh, dt, {
        moving: moving,
        speedRatio: moving ? Math.max(0.35, speedRatio) : 0,
        onGround: unit.onGround !== false && !unit.zipRide,
      });
      if (global.VF.Soldier.updateCrouchPose) {
        global.VF.Soldier.updateCrouchPose(unit.mesh, dt);
      }
    }
  };

  AI.prototype._clearFlagGoals = function (units) {
    for (let i = 0; i < units.length; i++) units[i]._flagGoal = null;
  };

  AI.prototype._assignTeamFlagGoals = function (units, team, flags) {
    const field = [];
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u.alive) continue;
      if (u.role === 'zip') {
        u._flagGoal = null;
        continue;
      }
      field.push(u);
    }
    for (let i = field.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = field[i];
      field[i] = field[j];
      field[j] = t;
    }
    const homeN = Math.max(1, Math.floor(field.length * 0.2));
    for (let i = 0; i < homeN && i < field.length; i++) field[i]._flagGoal = null;
    const movers = field.slice(homeN);
    if (!movers.length || !flags.length) return;
    const bag = [];
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      let w = 1;
      if (f.owner === 'neutral') w = 3;
      else if (f.owner !== team) w = f.contested ? 3 : 2;
      else w = f.contested ? 2 : 1;
      for (let k = 0; k < w; k++) bag.push(f);
    }
    for (let i = 0; i < movers.length; i++) {
      const f = bag[i % bag.length];
      movers[i]._flagGoal = { x: f.x, z: f.z, r: f.radius || 16, letter: f.letter };
    }
  };

  AI.prototype._assignSquadFlagGoals = function (team, flags) {
    const squads = global.VF && global.VF.Squads;
    const C = global.VF && global.VF.Conquest;
    if (!squads || !C) return false;
    const list = squads.squads[team] || [];
    if (!list.length) return false;
    const friendly = flags.filter(function (flag) {
      return C._isFullyHeld ? C._isFullyHeld(flag, team) : flag.owner === team;
    });
    const attack = flags
      .filter(function (flag) {
        return !(C._isFullyHeld ? C._isFullyHeld(flag, team) : flag.owner === team);
      })
      .sort(function (a, b) {
        const ap = a.contested ? 0 : a.owner === 'neutral' ? 1 : 2;
        const bp = b.contested ? 0 : b.owner === 'neutral' ? 1 : 2;
        return ap - bp || a.letter.localeCompare(b.letter);
      });
    for (let i = 0; i < list.length; i++) {
      const squad = list[i];
      let target = null;
      let kind = 'attack';
      if (friendly.length && i === 0) {
        target =
          friendly.find(function (flag) {
            return flag.contested || flag.phase === 'neutralizing';
          }) || friendly[0];
        kind = 'defend';
      } else if (attack.length) {
        target = attack[(i - (friendly.length ? 1 : 0) + attack.length) % attack.length];
      } else if (friendly.length) {
        target = friendly[i % friendly.length];
        kind = 'defend';
      }
      if (!target) continue;
      if (
        !squad.order ||
        squad.order.flagLetter !== target.letter ||
        squad.order.kind !== kind ||
        squad.order.status === 'failed'
      ) {
        squads.issueOrder(squad.id, target.letter, kind, squad.leaderId);
      }
      for (let m = 0; m < squad.memberIds.length; m++) {
        const unit = squads.getEntity(squad.memberIds[m]);
        if (!unit || !unit.alive || unit === this.player) continue;
        const angle = (m / Math.max(1, squad.memberIds.length)) * Math.PI * 2;
        const spread = m === 0 ? 0 : 2.2;
        unit._flagGoal = {
          x: target.x + Math.cos(angle) * spread,
          z: target.z + Math.sin(angle) * spread,
          r: target.radius || 16,
          letter: target.letter,
          kind: kind,
          squadId: squad.id,
        };
      }
    }
    return true;
  };

  AI.prototype._assignFlagObjectives = function () {
    const C = global.VF.Conquest;
    if (!C || !C.active || !C.flags || !C.flags.length) {
      this._clearFlagGoals(this.blue);
      this._clearFlagGoals(this.red);
      return;
    }
    if (
      this._assignSquadFlagGoals('ally', C.flags) &&
      this._assignSquadFlagGoals('enemy', C.flags)
    ) {
      return;
    }
    this._assignTeamFlagGoals(this.blue, 'ally', C.flags);
    this._assignTeamFlagGoals(this.red, 'enemy', C.flags);
  };

  AI.prototype._queueConquestRespawn = function (unit, opts) {
    if (!unit) return;
    opts = opts || {};
    const C = global.VF.Conquest;
    if (!C || !C.active || C._ended) return;
    if (!this._respawnQ) this._respawnQ = [];
    const team = unit.team === 'enemy' ? 'enemy' : 'ally';
    const list = team === 'enemy' ? this.red : this.blue;
    let alive = 0;
    for (let i = 0; i < list.length; i++) if (list[i].alive) alive++;
    let queued = 0;
    for (let i = 0; i < this._respawnQ.length; i++) {
      if (this._respawnQ[i].team === team) queued++;
    }
    const cap = this._aiCapForTeam(team);
    if (alive + queued >= cap) return;
    if (!opts.casualtySettled && C.onDeath) {
      C.onDeath(team, {
        subjectId: unit.entityId || null,
        lifeId: unit.entityId ? C.matchId + ':legacy:' + unit.entityId + ':' + (unit.lifeSerial || 0) : null,
      });
    }
    this._respawnQ.push({
      team: team,
      type: unit.type || 'infantry',
      entityId: unit.entityId || null,
      squadId: unit.squadId || null,
      isSquadLeader: !!unit.isSquadLeader,
      classId: unit.classId || null,
      wait: 7 + Math.random() * 4,
    });
  };

  AI.prototype._sampleNearPoint = function (x, z, rMin, rMax) {
    for (let t = 0; t < 40; t++) {
      const ang = Math.random() * Math.PI * 2;
      const r = rMin + Math.random() * Math.max(0.2, rMax - rMin);
      const px = x + Math.cos(ang) * r;
      const pz = z + Math.sin(ang) * r;
      if (this._inRiver(px, pz)) continue;
      if (this._insideBuilding(px, pz, BUILDING_SPAWN_MARGIN)) continue;
      const y = this._clearStandY(px, pz);
      if (y == null) continue;
      return new THREE.Vector3(px, y, pz);
    }
    return null;
  };

  AI.prototype._tickConquestRespawns = function (dt) {
    const C = global.VF.Conquest;
    if (!this._respawnQ || !this._respawnQ.length) return;
    if (!C || !C.active || C._ended) {
      this._respawnQ.length = 0;
      return;
    }
    for (let i = this._respawnQ.length - 1; i >= 0; i--) {
      const job = this._respawnQ[i];
      job.wait -= dt;
      if (job.wait > 0) continue;
      if ((C.tickets[job.team] || 0) <= 0) {
        this._respawnQ.splice(i, 1);
        continue;
      }
      const spawned = this._spawnConquestReinforcement(job);
      if (spawned) {
        this._respawnQ.splice(i, 1);
        if (C.onRespawn) C.onRespawn(job.team);
      } else {
        job.wait = 1.2;
      }
    }
  };

  AI.prototype._spawnConquestReinforcement = function (job) {
    const C = global.VF.Conquest;
    const team = job.team === 'enemy' ? 'enemy' : 'ally';
    const pts = C && C.listDeployPoints ? C.listDeployPoints(team) : [];
    const flags = [];
    let hq = null;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].available === false) continue;
      if (pts[i].kind === 'flag') flags.push(pts[i]);
      else if (!hq) hq = pts[i];
    }
    let spot = null;
    const squads = global.VF && global.VF.Squads;
    const squad = squads && job.squadId ? squads.getSquad(job.squadId) : null;
    if (squad) {
      const living = squads.getLivingSquadmates(job.entityId, global.VF.game);
      for (let i = 0; i < living.length; i++) {
        const mate = living[i];
        const mp = mate.object ? mate.object.position : mate.mesh && mate.mesh.position;
        const safe = mp && C._deploySafety ? C._deploySafety(team, mate, mp.x, mp.z) : null;
        if (mp && (!safe || safe.available)) {
          spot = {
            kind: 'squad',
            x: mp.x,
            y: mp.y,
            z: mp.z,
            team: team,
          };
          break;
        }
      }
    }
    if (!spot && flags.length && Math.random() < 0.7) {
      spot = flags[(Math.random() * flags.length) | 0];
    } else if (!spot) {
      spot = hq || flags[0] || null;
    }
    let pos = null;
    if (spot) {
      pos = this._sampleNearPoint(spot.x, spot.z, 3, spot.kind === 'flag' ? 10 : 16);
    }
    if (!pos) pos = this._sampleAroundBase(team);
    if (!pos) {
      const p = this._basePos(team);
      if (p) {
        const y = this._clearStandY(p.x + 4, p.z + 4);
        if (y != null) pos = new THREE.Vector3(p.x + 4, y, p.z + 4);
      }
    }
    if (!pos) return false;
    const home =
      spot && spot.kind === 'flag'
        ? {
            kind: 'flag',
            cx: spot.x,
            cz: spot.z,
            ox: spot.x - 8,
            oz: spot.z - 8,
            w: 16,
            d: 16,
            side: team,
          }
        : this._baseHome(team);
    const unit = this._spawnUnit(job.type || 'infantry', pos, team, {
      role: 'base',
      home: home,
      entityId: job.entityId || null,
      squadId: job.squadId || null,
      isSquadLeader: !!job.isSquadLeader,
      classId: job.classId || null,
    });
    if (team === 'enemy') this.red.push(unit);
    else this.blue.push(unit);
    return true;
  };

  AI.prototype.update = function (dt) {
    this._updateDeathChunks(dt);
    if (!this.enabled || !this._armiesSpawned) return;

    this.waveTimer += dt;
    const stepDt = Math.min(dt, 0.05);
    this._aiFrame = (this._aiFrame || 0) + 1;
    const brainStride = 4;
    const frame = this._aiFrame;

    this._flagAssignAcc = (this._flagAssignAcc || 0) + dt;
    if (this._flagAssignAcc >= 1) {
      this._flagAssignAcc = 0;
      this._assignFlagObjectives();
    }
    this._tickConquestRespawns(dt);

    // Physics every frame; brain staggered to cut CPU
    for (let i = 0; i < this.blue.length; i++) {
      const u = this.blue[i];
      if (u._reviveProtection > 0) {
        u._reviveProtection = Math.max(0, u._reviveProtection - stepDt);
      }
      if (!u.alive) continue;
      this._updateSoldier(u, stepDt, (i + frame) % brainStride === 0);
    }
    for (let i = 0; i < this.red.length; i++) {
      const u = this.red[i];
      if (u._reviveProtection > 0) {
        u._reviveProtection = Math.max(0, u._reviveProtection - stepDt);
      }
      if (!u.alive) continue;
      this._updateSoldier(u, stepDt, (i + frame + 1) % brainStride === 0);
    }

    // Separation every other frame
    if (frame % 2 === 0) this._separateAll(stepDt * 2);

    // Compact dead units occasionally (not every frame)
    if (frame % 15 === 0) {
      this.blue = this.blue.filter(function (u) {
        return u.alive || u.downed;
      });
      this.red = this.red.filter(function (u) {
        return u.alive || u.downed;
      });
    }

    const playerTeam = this.world._playerTeam || 'ally';
    if (playerTeam === 'ally') {
      this.allies = this.blue;
      this.enemies = this.red;
    } else {
      this.allies = this.red;
      this.enemies = this.blue;
    }

    // HUD ~4 Hz
    const now = performance.now();
    if (!this._uiHudAt || now - this._uiHudAt > 250) {
      this._uiHudAt = now;
      let blueN = 0;
      let redN = 0;
      for (let i = 0; i < this.blue.length; i++) if (this.blue[i].alive) blueN++;
      for (let i = 0; i < this.red.length; i++) if (this.red[i].alive) redN++;
      if (this.player && !this.player.dead && !(global.VF.game && global.VF.game.mode === 'pvp')) {
        if (playerTeam === 'ally') blueN++;
        else redN++;
      }
      if (global.VF.game && global.VF.game.mode === 'pvp') {
        const humans = this._pvpHumanCounts();
        blueN += humans.ally || 0;
        redN += humans.enemy || 0;
      }
      if (global.VF.UI) {
        if (!(global.VF.game && global.VF.game.mode === 'pvp')) {
          global.VF.UI.updateWave(1, this.waveTimer);
        } else if (
          global.VF.Pvp &&
          global.VF.Pvp.mode === 'guest' &&
          global.VF.Pvp.matchTime != null
        ) {
          // Guest clock from host
        } else if (global.VF.Pvp && global.VF.Pvp.matchTime != null) {
          this.waveTimer = global.VF.Pvp.matchTime;
        }
        global.VF.UI.updateArmyCounts(blueN, redN);
        const allyN = playerTeam === 'ally' ? blueN : redN;
        const enemyN = playerTeam === 'ally' ? redN : blueN;
        global.VF.UI.updateSquad(allyN, enemyN);
      }
    }
  };

  global.VF = global.VF || {};
  global.VF.AIController = AI;
  global.VF.ENEMY_DEFS = RED_DEFS;
  Object.defineProperty(global.VF, 'TEAM_SIZE', {
    configurable: true,
    enumerable: true,
    get: function () {
      return feelAi().teamSize;
    },
  });
  global.VF.ALLY_CHASE_RANGE = ENGAGE_RANGE;
})(window);
