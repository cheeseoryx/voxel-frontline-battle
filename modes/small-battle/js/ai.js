/**
 * ai.js — 蓝 / 红方士兵
 * 每方默认 25 人：优先用地图编辑器摆的 AI 刷新点；无点时仅在己方大本营外围补齐。
 */
(function (global) {
  'use strict';

  const TEAM_SIZE = 25;

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

  /** Match mode wins over the feel tuning: 死斗 wants 12v12 encounter density. */
  function modeTeamSize() {
    const GM = global.VF && global.VF.GameModes;
    const n = GM && GM.param ? GM.param('teamSize', null) : null;
    return Math.max(1, Math.floor(n != null ? n : feelAi().teamSize));
  }

  function tdmLive() {
    const m = global.VF && global.VF.TdmMatch;
    return !!(m && m.isRunning());
  }

  /** 爆破: true whenever a Search & Destroy match is active (any phase). */
  function sdLive() {
    const m = global.VF && global.VF.SdMatch;
    return !!(m && m.isRunning());
  }

  /** 自由混战: true whenever a Free-For-All match is scoring (teamless combat). */
  function ffaLive() {
    const m = global.VF && global.VF.FfaMatch;
    return !!(m && m.isRunning());
  }

  /** 枪械模式: teamless like FFA, but progress is weapon level rather than kills. */
  function ggLive() {
    const m = global.VF && global.VF.GgMatch;
    return !!(m && m.isRunning());
  }

  /** 自由混战 / 枪械模式 share the same hunt-everyone targeting and seek loop. */
  function teamlessLive() {
    return ffaLive() || ggLive();
  }

  /**
   * 枪械模式: AI 命中玩家时的爆头概率。项目里 AI 射击是「命中判定 + 固定伤害」，
   * 本来不产生爆头，那样「被爆头降级」就只有玩家能触发。给 AI 一个爆头掷骰，
   * 降级机制才是双向的。
   */
  function ggHeadshotChance() {
    const GM = global.VF && global.VF.GameModes;
    const v = GM && GM.param ? GM.param('aiHeadshotChance', 0.18) : 0.18;
    return Math.max(0, Math.min(1, v));
  }

  /** Mode-id check (valid before GgMatch has started, unlike ggLive). */
  function ggMode() {
    const GM = global.VF && global.VF.GameModes;
    return !!(GM && GM.isGg && GM.isGg());
  }

  /** No teams at all — 自由混战 / 枪械模式 share the "everyone is red" rostering. */
  function teamlessMode() {
    const GM = global.VF && global.VF.GameModes;
    return !!(GM && GM.isTeamless && GM.isTeamless());
  }

  /** Local human, plus the networked opponent in a 1v1 room. */
  function teamlessHumanSlots() {
    const p = global.VF.Pvp;
    return p && p.quickSession ? 1 + p.remoteHumanSlots() : global.VF.game && global.VF.game.mode === 'pvp' ? 2 : 1;
  }

  /** AI headcount so the board stays at `combatants` including humans. */
  function teamlessAiCount() {
    const GM = global.VF && global.VF.GameModes;
    const combatants = GM && GM.param ? GM.param('combatants', 8) : 8;
    return Math.max(0, combatants - teamlessHumanSlots());
  }

  /**
   * Whichever module scores this match. 枪械模式 and 自由混战 are teamless, 死斗 is
   * team-based; every guard / damage / kill hook routes through this so the
   * branch is written once.
   */
  function arenaScorer() {
    const GM = global.VF && global.VF.GameModes;
    if (GM && GM.isGg && GM.isGg()) return global.VF.GgMatch;
    if (GM && GM.isFfa && GM.isFfa()) return global.VF.FfaMatch;
    return global.VF.TdmMatch;
  }

  /**
   * Compact free-roam arena (死斗 / 爆破 / 自由混战 / 枪械模式): no fixed team
   * territory, no ground pickups, no spawn-pad leash. All arena modes share this
   * movement profile — the teamless modes reuse the 死斗 arena wholesale.
   */
  function arenaMode() {
    return tdmLive() || sdLive() || ffaLive() || ggLive();
  }

  function unitDealDamage(unit) {
    const base = unit.damage != null ? unit.damage : 12;
    return base * feelAi().damageMul;
  }
  const ENGAGE_RANGE = 28;
  /** 死斗: local reaction radius. Kept well under the compact arena's width so
   *  a fight on one side of the map does NOT suck in every soldier — that
   *  arena-spanning pull is what collapsed both teams into a single blob.
   *  Macro positioning is handled by the 热区 flow field instead. */
  const TDM_ENGAGE_RANGE = 40;
  /** How far a unit will march toward a spotted-but-not-yet-engaged foe. Only
   *  a touch above the engage radius, so units close the final gap onto a
   *  nearby contact but never abandon their hotzone to chase across the map. */
  const TDM_SENSE_RANGE = 46;
  /** 爆破: once the bomb is planted a defender only stops its retake to drop an
   *  attacker this close; anything further is ignored so it keeps pushing the
   *  plant and defuses on arrival instead of trading shots across the map. */
  const SD_RETAKE_SELF_DEF_R = 10;
  /** 爆破 守方站位（安装前）：守方在分配到的包点周围驻守，视野里有攻方就还击；
   *  拴绳只用于限制追击距离——「卡守包点」而非满图游走，也不再用半径去卡开火。 */
  const SD_DEF_LEASH_R = 24;
  /** 爆破: 炸弹安装后守方回防拆弹的冲刺倍率——安装音效一响，守方是「加速跑过来」
   *  抢拆，而非慢慢走。只作用于 _sdBombLive 的 retake 推进，交火/常态移动不加速。 */
  const SD_RETAKE_SPRINT = 1.5;
  /** 爆破 守方受击记忆窗口（毫秒）：被击中后的这段时间内，守方即使暂时看不到攻击者
   *  （侧翼 / 背后 / 超出常规索敌半径）也会转身回击「刚才打我的人」，而不是站桩挨打。*/
  const SD_AGGRO_MS = 4000;
  /** Collision capsule (feet at mesh.position) */
  const SOLDIER_RADIUS = 0.42;
  const SOLDIER_HEIGHT = 1.85;
  const STEP_UP = 1.05;
  const MAX_STEP = 0.42;
  const JUMP_VEL = 8.6;
  const GRAVITY = 22;
  /** Min seconds between obstacle jumps (stops hop spam) */
  const JUMP_COOLDOWN = 2.8;
  /** Personal space between soldiers. Loosened so squads hold a looser line
   *  instead of collapsing into one tight blob when they share a target. */
  const SEP_DIST = 1.8;
  const SEP_DIST_SQ = SEP_DIST * SEP_DIST;
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

  /**
   * Shared per-type stats for BOTH factions. 死斗 was a blue landslide every
   * match because ally soldiers were a uniform elite block (all hp90 / fastest
   * speed / best fire rate) while the enemy fielded a weaker mixed bag — same
   * headcount, very different strength. Both teams now draw the SAME
   * composition and the SAME stats; only the mesh colour differs, so the fight
   * is a true mirror and the only edge left is the human player on the ally side.
   */
  const UNIT_STATS = {
    infantry: { hp: 90, speed: 3.2, damage: 15, range: 28, accuracy: 0.7, fireRate: 0.5 },
    heavy: { hp: 140, speed: 1.7, damage: 24, range: 18, accuracy: 0.62, fireRate: 0.85 },
    ranged: { hp: 40, speed: 2.3, damage: 20, range: 36, accuracy: 0.78, fireRate: 0.95 },
  };

  /** Mesh variant per faction/type. Ally has a single mesh, so ally units of
   *  every type reuse it (cosmetic only — their stats still vary by type). */
  function unitVariant(faction, typeKey) {
    if (faction === 'ally') return 'ally';
    if (typeKey === 'heavy') return 'enemy_heavy';
    if (typeKey === 'ranged') return 'enemy_ranged';
    return 'enemy';
  }

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
    this._uiHudAt = 0;
    this._deathChunks = [];
    this._deathPool = [];
    this._deathRings = [];
    this._deathFlashes = [];
    this._mkCount = 0;
    this._mkAt = 0;
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
    return Math.min(48, y);
  };

  /** Feet Y raised until body clears solids (null if impossible) */
  AI.prototype._clearStandY = function (x, z) {
    let y = this._feetY(x, z);
    for (let i = 0; i < 16; i++) {
      if (!this._soldierOverlaps(x, y, z)) return y;
      y += 0.35;
      if (y > 50) break;
    }
    return null;
  };

  /** Highest solid surface at or just below fromY at (x,z).
   *
   * Unlike the sky-scanning _feetY (which returns the top of ANY overhead
   * structure — a bridge deck, an overpass beam, the landmark walkway), this
   * follows the unit's own level: it starts just above the feet and scans down.
   * A soldier moving *under* an overpass therefore keeps the ground beneath its
   * feet instead of being snapped up onto the deck and then walking off the far
   * edge — the "移动从空中掉下来" fall. A soldier legitimately standing on the
   * deck (fromY high) still resolves the deck as its floor. */
  AI.prototype._floorBelow = function (x, z, fromY) {
    const fx = Math.floor(x);
    const fz = Math.floor(z);
    let y = Math.min(this.world.height - 1, Math.floor(fromY + 0.5));
    while (y > 0 && !this.world._isSolid(fx, y, fz)) y--;
    if (y <= 0) return this._feetY(x, z);
    const top = y + 1 + 0.04;
    if (top < 0.5) return 4.04;
    return Math.min(48, top);
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
    // 死斗 / 爆破 have no territory — either team may stand anywhere in the arena
    if (faction && !arenaMode() && this._teamSide(x, z) !== faction) return false;
    if (this.world._riverInfo) {
      const info = this.world._riverInfo(x, z);
      if (info.dist < info.width + 2.5) return false;
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

  /** Liang-Barsky: does segment (x0,z0)-(x1,z1) cross rect [rx0,rz0]-[rx1,rz1]? */
  AI.prototype._segmentHitsRect = function (x0, z0, x1, z1, rx0, rz0, rx1, rz1) {
    const dx = x1 - x0;
    const dz = z1 - z0;
    let tMin = 0;
    let tMax = 1;
    const p = [-dx, dx, -dz, dz];
    const q = [x0 - rx0, rx1 - x0, z0 - rz0, rz1 - z0];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return false;
        continue;
      }
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > tMax) return false;
        if (t > tMin) tMin = t;
      } else {
        if (t < tMin) return false;
        if (t < tMax) tMax = t;
      }
    }
    return tMin <= tMax;
  };

  /**
   * TDM landmarks (ruined factories etc.) are large solid blocks that unit
   * movement cannot route around — it only walks straight + slides. A patrol
   * target on the far side of one looks "walkable" in isolation but leaves
   * the unit pinned against the wall forever (repeatedly blocked → resampled
   * → blocked again). Reject any candidate whose straight path from the
   * unit's current spot would cut through a landmark footprint.
   */
  AI.prototype._pathCrossesLandmark = function (x0, z0, x1, z1) {
    const marks = this.world._plannedLandmarks;
    if (!marks || !marks.length) return false;
    const pad = 1.5;
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      if (this._segmentHitsRect(x0, z0, x1, z1, m.x - pad, m.z - pad, m.x + m.w + pad, m.z + m.d + pad)) {
        return true;
      }
    }
    return false;
  };

  AI.prototype._sampleNearAnchor = function (ax, az, rMax, faction, loose, fromPos) {
    for (let i = 0; i < 36; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = 2 + Math.random() * Math.max(2, rMax - 2);
      const x = ax + Math.cos(ang) * r;
      const z = az + Math.sin(ang) * r;
      if (Math.hypot(x - ax, z - az) > rMax) continue;
      if (fromPos && this._pathCrossesLandmark(fromPos.x, fromPos.z, x, z)) continue;
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
    if ((tdmLive() || teamlessLive()) && this.world._tdmArenaCenter) {
      // 死斗: roam the whole compact arena instead of leashing to one spawn
      // cluster, so both teams keep crossing paths near the middle lanes.
      // Both samples pass the unit's own position as `fromPos` so
      // _sampleNearAnchor rejects any point that would require walking
      // straight through a landmark — see _pathCrossesLandmark.
      const c = this.world._tdmArenaCenter;
      const r = this.world._tdmArenaRadius || BASE_PATROL_R;
      const pos = unit.mesh.position;
      const roam = this._sampleNearAnchor(c.x, c.z, r, unit.team, false, pos);
      if (roam) return roam;
      // Arena-wide roam can whiff for many tries in a row when the sample
      // circle is partly eaten by a central landmark — fall back to a short
      // wander around the unit's own spot so it keeps moving instead of
      // freezing there forever. `unit.home` is a leftover classic-mode base
      // anchor with no relation to the compact arena, so it must not be used
      // as the fallback here.
      return this._sampleNearAnchor(pos.x, pos.z, 14, unit.team, false, pos);
    }
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

  let UNIT_SERIAL = 0;

  AI.prototype._mixTypes = function (total) {
    const list = [];
    // 枪械模式: 所有人同起点、同血量、同机动，唯一的差别只能是手里那把枪
    // （applyGgWeapon 按等级改交战数值，不动 hp / speed）。
    if (ggMode()) {
      for (let i = 0; i < total; i++) list.push('infantry');
      return list;
    }
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
    const stats = UNIT_STATS[typeKey] || UNIT_STATS.infantry;
    const mesh = global.VF.Soldier.createSoldier(unitVariant(faction, typeKey));
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
    const hp = stats.hp * hpMul;
    // Stable identity so kill attribution / the kill feed can name this soldier
    const serial = ++UNIT_SERIAL;
    return {
      id: 'ai-' + serial,
      name: (faction === 'enemy' ? '红' : '蓝') + ('0' + ((serial % 99) + 1)).slice(-2),
      mesh: mesh,
      team: faction,
      type: typeKey || 'infantry',
      hp: hp,
      maxHp: hp,
      speed: stats.speed,
      damage: stats.damage,
      range: stats.range,
      accuracy: stats.accuracy,
      fireRate: stats.fireRate,
      shootCd: Math.random() * stats.fireRate,
      alive: true,
      state: opts.role === 'zip' ? 'zip_descend' : 'patrol',
      role: opts.role || 'base',
      home: home,
      zipLine: opts.zipLine || null,
      zipAnchor: opts.zipAnchor || null,
      zipRide: null,
      zipPhase: opts.role === 'zip' ? 'descend' : null,
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

  /**
   * 枪械模式: 把单位的交战数值换成它当前武器对应的兵种档（文档 6.3 武器适配交战）。
   * range 就是交战距离，所以换枪后 AI 自动改用对应的贴脸/中距/远距打法，弹道与
   * 枪口特效也跟着 type 走。
   *
   * 刻意不动 hp / speed：枪械模式讲究「人人平等，只拼枪法适应」，让霰弹兵变成
   * 140 血的慢坦克会破坏这个前提。
   */
  AI.prototype.applyGgWeapon = function (unit, weaponId) {
    if (!unit) return;
    const gg = global.VF.GgMatch;
    const typeKey =
      (gg && gg.aiTypeForWeapon && gg.aiTypeForWeapon(weaponId)) || 'infantry';
    const stats = UNIT_STATS[typeKey] || UNIT_STATS.infantry;
    unit.type = typeKey;
    unit.damage = stats.damage;
    unit.range = stats.range;
    unit.accuracy = stats.accuracy;
    unit.fireRate = stats.fireRate;
    unit._ggWeapon = weaponId;
  };

  AI.prototype._notCrowded = function (pos, list, minDist) {
    minDist = minDist != null ? minDist : SEP_DIST;
    for (let i = 0; i < list.length; i++) {
      if (list[i].mesh.position.distanceTo(pos) < minDist) return false;
    }
    return true;
  };

  AI.prototype._spawnFaction = function (faction) {
    const playerTeam = this.world._playerTeam || 'ally';
    const hasPlayer = !!(global.VF.game && global.VF.game.player);
    const teamless = teamlessMode();
    let teamSize;
    if (teamless) {
      // Always park bots on red, even if this client spawned as the PVP
      // "enemy" human. Using playerTeam here made the guest fill BLUE instead,
      // then FFA reinforcements (always 'enemy') added a second red army —
      // 7+7+player = 15 on one board and 8 on the other.
      teamSize = faction === 'ally' ? 0 : teamlessAiCount();
    } else {
      // 玩家本身占本阵营一个名额，AI 少生成一个，保证含玩家在内为满编
      const pvp = global.VF.Pvp;
      const reserve = (hasPlayer && faction === playerTeam ? 1 : 0) + (pvp && pvp.remoteHumanSlots ? pvp.remoteHumanSlots(faction) : 0);
      teamSize = Math.max(0, modeTeamSize() - reserve);
    }
    const types = this._mixTypes(teamSize);
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

  AI.prototype._clearDeathFx = function () {
    while (this._deathChunks && this._deathChunks.length) {
      this._releaseDeathChunk(this._deathChunks.pop());
    }
    const drop = function (arr) {
      if (!arr) return;
      for (let i = 0; i < arr.length; i++) {
        const m = arr[i] && arr[i].mesh;
        if (m && m.parent) m.parent.remove(m);
        if (m && m.material) m.material.dispose();
      }
      arr.length = 0;
    };
    drop(this._deathRings);
    drop(this._deathFlashes);
  };

  AI.prototype._clearUnits = function () {
    const all = this.blue.concat(this.red);
    for (let i = 0; i < all.length; i++) {
      if (all[i].mesh) this.scene.remove(all[i].mesh);
    }
    this.blue = [];
    this.red = [];
    this.allies = [];
    this.enemies = [];
    this._clearDeathFx();
  };

  AI.prototype.applyPlayerTeam = function () {
    this._clearUnits();
    if (!this.world.buildings) this.world.buildings = [];
    const playerTeam = this.world._playerTeam || 'ally';
    this.blue = this._spawnFaction('ally');
    this.red = this._spawnFaction('enemy');
    if (teamlessMode()) {
      this.allies = this.blue.slice();
      this.enemies = this.red.slice();
    } else if (playerTeam === 'ally') {
      this.allies = this.blue.slice();
      this.enemies = this.red.slice();
    } else {
      this.allies = this.red.slice();
      this.enemies = this.blue.slice();
    }
    this._armiesSpawned = true;
    this.waveTimer = 0;
    if (global.VF.UI) {
      global.VF.UI.updateArmyCounts(
        this.blue.length + this._playerHead('ally'),
        this.red.length + this._playerHead('enemy')
      );
      const enemyTeam = playerTeam === 'ally' ? 'enemy' : 'ally';
      global.VF.UI.updateSquad(
        this.allies.length + this._playerHead(playerTeam),
        this.enemies.length + this._playerHead(enemyTeam),
        '刷新点'
      );
    }
  };

  AI.prototype.relocateSquadNearSpawn = function () {
    if (!this._armiesSpawned) this.applyPlayerTeam();
  };

  /** Live headcount for a faction, so callers can size reinforcements. */
  AI.prototype.aliveCount = function (faction) {
    const list = faction === 'enemy' ? this.red : this.blue;
    let n = 0;
    for (let i = 0; i < list.length; i++) if (list[i].alive) n++;
    return n;
  };

  AI.prototype.teamTarget = function () {
    return modeTeamSize();
  };

  /** 玩家算作本阵营一员：返回该 faction 上存活玩家数（0 或 1）。 */
  AI.prototype._playerHead = function (faction) {
    const p = global.VF.game && global.VF.game.player;
    if (!p || !p.alive) return 0;
    const team = p.team || this.world._playerTeam || 'ally';
    return team === faction ? 1 : 0;
  };

  /**
   * 死斗 reinforcement: put one fresh soldier back on the field.
   *
   * The base game never replaces losses, which is fine for a core match that
   * ends when a crystal falls but not for a 50-kill race. Timing and spawn
   * safety belong to TdmSpawn; this only owns the unit factory.
   *
   * @param {'ally'|'enemy'} faction
   * @param {{x:number, y:number, z:number}} pos
   */
  AI.prototype.spawnReinforcement = function (faction, pos) {
    if (!pos) return null;
    // Scatter around the zone so successive reinforcements do not stack
    let x = pos.x;
    let z = pos.z;
    let y = null;
    for (let t = 0; t < 14; t++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = t === 0 ? 0 : 1.2 + Math.random() * 4.5;
      const tx = pos.x + Math.cos(ang) * rad;
      const tz = pos.z + Math.sin(ang) * rad;
      if (this._inRiver(tx, tz)) continue;
      if (this._insideBuilding(tx, tz, BUILDING_SPAWN_MARGIN)) continue;
      const ty = this._clearStandY(tx, tz);
      if (ty == null) continue;
      x = tx;
      z = tz;
      y = ty;
      break;
    }
    if (y == null) y = pos.y != null ? pos.y : 0;

    const r = Math.random();
    // 枪械模式的兵种由武器等级决定，复活时先统一按 infantry 出场
    const type = ggMode() ? 'infantry' : r < 0.2 ? 'heavy' : r < 0.45 ? 'ranged' : 'infantry';
    const unit = this._spawnUnit(type, new THREE.Vector3(x, y, z), faction, {
      role: 'base',
      home: this._baseHome(faction),
    });

    // Reuse a fallen teammate's identity instead of minting a fresh id every
    // respawn. Otherwise a 50-kill instant-respawn match spawns ~80 unique ids
    // and the scoreboard shows 80+ one-death rows instead of the real 25v25
    // roster. The recycled TdmMatch row keeps accumulating K/D for that "slot".
    const freed = this._freeIds && this._freeIds[faction];
    if (freed && freed.length) {
      const reuse = freed.shift();
      unit.id = reuse.id;
      unit.name = reuse.name;
    }

    const list = faction === 'enemy' ? this.red : this.blue;
    list.push(unit);
    if (teamlessMode()) {
      this.allies = this.blue;
      this.enemies = this.red;
    } else {
      const playerTeam = this.world._playerTeam || 'ally';
      if (playerTeam === 'ally') {
        this.allies = this.blue;
        this.enemies = this.red;
      } else {
        this.allies = this.red;
        this.enemies = this.blue;
      }
    }
    return unit;
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
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.alive) continue;
      const center = e.mesh.position.clone().add(new THREE.Vector3(0, 1.2, 0));
      const to = center.clone().sub(origin);
      const proj = to.dot(dir);
      if (proj < 0 || proj > bestDist) continue;
      const closest = origin.clone().addScaledVector(dir, proj);
      const radius = e.type === 'heavy' ? 1.25 : 1.0;
      if (closest.distanceTo(center) < radius) {
        if (
          global.VF.Throwables &&
          global.VF.Throwables.occludesRay &&
          global.VF.Throwables.occludesRay(origin, closest)
        ) {
          continue;
        }
        bestDist = proj;
        best = { enemy: e, unit: e, point: closest, dist: proj };
      }
    }
    return best;
  };

  AI.prototype.damageEnemy = function (enemy, dmg, hitDir, opts) {
    return this._damageUnit(enemy, dmg, hitDir, true, 'player', opts);
  };

  /**
   * @param attacker  AI unit, 'player', or null for environment damage.
   * @param opts      { headshot } — only meaningful for player hits today.
   */
  AI.prototype._damageUnit = function (unit, dmg, hitDir, fromPlayer, attacker, opts) {
    if (!unit || !unit.alive) return { killed: false, dmg: 0 };
    // 死斗 / 自由混战 / 枪械模式 prep phase: everyone is untouchable until the
    // countdown ends. `match` resolves to whichever scorer owns this match, so the
    // guard, damage and kill hooks below all route to the right module without
    // duplicating this branch everywhere.
    const teamless = teamlessMode();
    const match = arenaScorer();
    if (match && match.active && !match.ended && !match.scoringLive()) {
      return { killed: false, dmg: 0 };
    }
    const before = unit.hp;
    unit.hp -= dmg;
    const applied = Math.min(before, Math.max(0, dmg));
    if (match && match.scoringLive()) match.registerDamage(unit, applied, attacker);
    if (global.VF.SdStats && global.VF.SdStats.live()) {
      global.VF.SdStats.registerDamage(unit, applied, attacker);
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

    // 受击记忆：记下「刚才是谁打的我」。守方站桩防守时即使一时看不到攻击者，也能靠这条
    // 线索转身回击，而不是被侧翼/背后火力打死都不还手。attacker 可能是 'player' 或单位对象。
    if (unit.hp > 0 && attacker && attacker !== unit) {
      unit._aggroFrom = attacker;
      unit._aggroAt =
        typeof performance !== 'undefined' ? performance.now() : Date.now();
    }

    if (unit.hp <= 0) {
      unit.alive = false;
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
      // 死斗 / 自由混战 / 枪械模式 score every death on the field, not just the player's
      if (match && match.scoringLive()) {
        match.registerKill({
          victim: unit,
          killer: attacker || null,
          headshot: !!(opts && opts.headshot),
          weaponId: (opts && opts.weaponId) || null,
          maxHp: unit.maxHp,
        });
        const spawn = teamless ? global.VF.FfaSpawn : global.VF.TdmSpawn;
        if (spawn && deathPos) {
          spawn.recordDeath(unit.team, deathPos.x, deathPos.z, false);
        }
        // Return this soldier's identity to the faction pool so the next
        // reinforcement reuses it (keeps the scoreboard at the true roster).
        if (unit.id && (unit.team === 'ally' || unit.team === 'enemy')) {
          const pool = this._freeIds || (this._freeIds = { ally: [], enemy: [] });
          if (pool[unit.team].length < 200) {
            pool[unit.team].push({ id: unit.id, name: unit.name });
          }
        }
      }
      if (global.VF.SdStats && global.VF.SdStats.live()) {
        global.VF.SdStats.registerKill({
          victim: unit,
          killer: attacker || null,
          headshot: !!(opts && opts.headshot),
          maxHp: unit.maxHp,
        });
      }

      const playerTeam = this.world._playerTeam || 'ally';
      if (teamless || unit.team !== playerTeam) {
        if (fromPlayer) {
          this._registerPlayerKill({
            weaponId: (opts && opts.weaponId) || null,
            headshot: !!(opts && opts.headshot),
            x: deathPos && deathPos.x,
            y: deathPos && deathPos.y,
            z: deathPos && deathPos.z,
          });
        } else if (global.VF.Audio) {
          global.VF.Audio.play('kill');
        }
        // 死斗 / 爆破 不产生地面掉落物（弹药箱 / 资源）
        if (!arenaMode()) {
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
      }
      return { killed: true, dmg: applied };
    }
    return { killed: false, dmg: applied };
  };

  const DEATH_POOL_MAX = 280;
  const DEATH_SAMPLE_MAX = 110;
  const MK_WINDOW_MS = 3500;
  const MK_LABELS = ['', '', '双杀', '三杀', '四杀', '五杀', '六杀', '超神'];

  AI.prototype._registerPlayerKill = function (opts) {
    const now = performance.now();
    if (!this._mkAt || now - this._mkAt > MK_WINDOW_MS) this._mkCount = 0;
    this._mkCount += 1;
    this._mkAt = now;
    const n = this._mkCount;
    if (global.VF.Career && global.VF.Career.noteKill) {
      global.VF.Career.noteKill({
        weaponId:
          (opts && opts.weaponId) ||
          (global.VF.game && global.VF.game.weapons && global.VF.game.weapons.current) ||
          null,
        headshot: !!(opts && opts.headshot),
        x: opts && opts.x,
        y: opts && opts.y,
        z: opts && opts.z,
      });
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
      const t = this.world.get(
        Math.floor(this._losPt.x),
        Math.floor(this._losPt.y),
        Math.floor(this._losPt.z)
      );
      if (
        t !== global.VF.BLOCK.AIR &&
        t !== global.VF.BLOCK.WATER &&
        t !== global.VF.BLOCK.GLASS
      ) {
        return false;
      }
    }
    if (global.VF.Throwables && global.VF.Throwables.occludesRay) {
      if (global.VF.Throwables.occludesRay(from, to)) return false;
    }
    return true;
  };

  /**
   * The set of units this soldier may target.
   *   自由混战 / 枪械模式: everyone else on the field — both internal lists minus
   *   self, since both modes park all AI on the enemy team but each one fights
   *   every other (and the player).
   *   死斗 / core: the opposing team's list, as before.
   */
  AI.prototype._foeList = function (unit) {
    if (teamlessLive()) {
      const out = [];
      const a = this.allies;
      const e = this.enemies;
      for (let i = 0; i < a.length; i++) if (a[i] !== unit) out.push(a[i]);
      for (let i = 0; i < e.length; i++) if (e[i] !== unit) out.push(e[i]);
      return out;
    }
    const playerTeam = this.world._playerTeam || 'ally';
    return unit.team === playerTeam ? this.enemies : this.allies;
  };

  /** In teamless modes every AI hunts the player too; otherwise only the opposing team does. */
  AI.prototype._targetsPlayer = function (unit) {
    if (teamlessLive()) return true;
    const playerTeam = this.world._playerTeam || 'ally';
    return unit.team !== playerTeam;
  };

  AI.prototype._nearestHostile = function (unit, range) {
    const foes = this._foeList(unit);
    let best = null;
    let bestD = range;
    for (let i = 0; i < foes.length; i++) {
      const e = foes[i];
      if (!e.alive) continue;
      const d = unit.mesh.position.distanceTo(e.mesh.position);
      if (d < bestD) {
        bestD = d;
        best = { unit: e, isPlayer: false, pos: e.mesh.position, dist: d };
      }
    }
    if (this._targetsPlayer(unit) && this.player.health > 0 && !this.player.dead) {
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

  /**
   * 受击记忆 → 可交战目标：把 _damageUnit 记下的「刚才打我的人」解析成一个 threat 描述子
   * （{unit,isPlayer,pos,dist}），供守方转身回击。超过 SD_AGGRO_MS 或攻击者已死/隐身/超出
   * maxRange 则返回 null 并清除记忆。attacker 记录的是 'player' 字符串或单位对象。
   */
  AI.prototype._recentAttacker = function (unit, maxRange) {
    const from = unit._aggroFrom;
    if (!from) return null;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - (unit._aggroAt || 0) > SD_AGGRO_MS) {
      unit._aggroFrom = null;
      return null;
    }
    let pos = null;
    let isPlayer = false;
    let tUnit = null;
    if (from === 'player') {
      const p = this.player;
      if (!p || p.dead || p.health <= 0 || !p.object) return null;
      const stealthed =
        (global.VF.Skills && global.VF.Skills.isPlayerStealthed(p)) || !!p.stealthed;
      if (stealthed) return null;
      pos = p.object.position;
      isPlayer = true;
    } else if (from.alive && from.mesh) {
      pos = from.mesh.position;
      tUnit = from;
    } else {
      unit._aggroFrom = null;
      return null;
    }
    const d = unit.mesh.position.distanceTo(pos);
    if (maxRange != null && d > maxRange) return null;
    return { unit: tUnit, isPlayer: isPlayer, pos: pos, dist: d };
  };

  /** Nearest enemy with no range cap. Used to march on the foe when none are
   *  in weapon range yet, so the two teams actually close in and fight instead
   *  of idling at their spawns. */
  AI.prototype._nearestEnemyAnywhere = function (unit, maxRange) {
    const foes = this._foeList(unit);
    let best = null;
    let bestD = maxRange != null ? maxRange : Infinity;
    for (let i = 0; i < foes.length; i++) {
      const e = foes[i];
      if (!e.alive || !e.mesh) continue;
      const d = unit.mesh.position.distanceTo(e.mesh.position);
      if (d < bestD) {
        bestD = d;
        best = { unit: e, isPlayer: false, pos: e.mesh.position, dist: d };
      }
    }
    if (this._targetsPlayer(unit) && this.player && this.player.health > 0 && !this.player.dead) {
      const stealthed =
        (global.VF.Skills && global.VF.Skills.isPlayerStealthed(this.player)) ||
        !!this.player.stealthed;
      if (!stealthed) {
        const d = unit.mesh.position.distanceTo(this.player.object.position);
        if (d < bestD) {
          best = { unit: this.player, isPlayer: true, pos: this.player.object.position, dist: d };
        }
      }
    }
    return best;
  };

  /**
   * A walkable waypoint one leg toward goalPos. Big TDM landmarks can't be
   * pathed through (movement only slides along walls), so the straight heading
   * is tried first and then fanned out to both sides to slip around a blocking
   * footprint — this is what lets an advancing line flow past the central
   * ruins instead of pinning against them.
   */
  AI.prototype._seekWaypoint = function (unit, goalPos) {
    const pos = unit.mesh.position;
    const dx = goalPos.x - pos.x;
    const dz = goalPos.z - pos.z;
    const gdist = Math.hypot(dx, dz);
    if (gdist < 0.01) return null;
    const baseAng = Math.atan2(dz, dx);
    const reach = Math.min(gdist, 15 + Math.random() * 6);
    // Primary: fan toward the goal, taking the straightest leg whose whole path
    // clears every route-around obstacle (river / building / landmark).
    const near = [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4, 1.9, -1.9];
    const wp = this._trySeekFan(pos, baseAng, reach, near);
    if (wp) return wp;
    // Fallback: a unit boxed by a building dead ahead peels off hard sideways or
    // doubles back rather than grinding into the wall (直直走卡在墙里).
    const wide = [2.4, -2.4, 2.9, -2.9, Math.PI];
    return this._trySeekFan(pos, baseAng, Math.min(reach, 12), wide);
  };

  /** First fan angle × decreasing reach whose straight leg is fully clear. */
  AI.prototype._trySeekFan = function (pos, baseAng, reach, fan) {
    for (let i = 0; i < fan.length; i++) {
      const ang = baseAng + fan[i];
      for (let r = reach; r >= 5; r -= 4) {
        const x = pos.x + Math.cos(ang) * r;
        const z = pos.z + Math.sin(ang) * r;
        if (this._inRiver(x, z)) continue;
        if (this._insideBuilding(x, z, BUILDING_SPAWN_MARGIN)) continue;
        if (this._pathCrossesLandmark(pos.x, pos.z, x, z)) continue;
        if (this._pathCrossesBuilding(pos.x, pos.z, x, z)) continue;
        if (!this._legClimbable(pos.x, pos.z, x, z, pos.y)) continue;
        const y = this._floorBelow(x, z, pos.y);
        if (this._soldierOverlaps(x, y, z) && !this._onRampCell(x, z)) continue;
        return new THREE.Vector3(x, y, z);
      }
    }
    return null;
  };

  /**
   * Buildings are the same class of "solid block you must route around, not
   * slide along" as landmarks, but _seekWaypoint only vetted landmark crossings
   * — so a bombsite behind a building made the router pick a leg straight
   * through the wall (or none at all, falling back to a straight march into it).
   * Reject any candidate whose straight path clips a building footprint. The pad
   * stays under the _moveAxis standoff (0.25) so a unit already hugging a wall
   * is still counted as outside and can pick a tangent leg around the corner.
   */
  AI.prototype._pathCrossesBuilding = function (x0, z0, x1, z1) {
    const list = this.world.buildings || [];
    if (!list.length) return false;
    const pad = 0.2;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (
        this._segmentHitsRect(x0, z0, x1, z1, b.ox - pad, b.oz - pad, b.ox + b.w + pad, b.oz + b.d + pad)
      ) {
        return true;
      }
    }
    return false;
  };

  /** True if (x,z) sits on a stair/door prop or a marked voxel-stair column. */
  AI.prototype._onRampCell = function (x, z) {
    if (this.world.isStairColumn && this.world.isStairColumn(Math.floor(x), Math.floor(z))) {
      return true;
    }
    const props = this.world.props;
    if (!props) return false;
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      if (!p || !p.box || (p.kind !== 'stair' && p.kind !== 'door')) continue;
      if (x >= p.box.min.x && x <= p.box.max.x && z >= p.box.min.z && z <= p.box.max.z) return true;
    }
    return false;
  };

  /** Cardinal neighbors whose floor is within 0.85m of y. A 1-wide rail/lip
   *  has support on only one axis; a real deck or stair flight has both. */
  AI.prototype._deckAxes = function (x, z, y) {
    const gyE = this._floorBelow(x + 1, z, y);
    const gyW = this._floorBelow(x - 1, z, y);
    const gyN = this._floorBelow(x, z + 1, y);
    const gyS = this._floorBelow(x, z - 1, y);
    const nx = (Math.abs(gyE - y) < 0.85 ? 1 : 0) + (Math.abs(gyW - y) < 0.85 ? 1 : 0);
    const nz = (Math.abs(gyN - y) < 0.85 ? 1 : 0) + (Math.abs(gyS - y) < 0.85 ? 1 : 0);
    return { nx: nx, nz: nz };
  };

  /** True on a 1-block strip (rail, stair lip) — not a stair column. */
  AI.prototype._isNarrowLip = function (x, z, y) {
    if (this._onRampCell(x, z)) return false;
    const a = this._deckAxes(x, z, y);
    return a.nx === 0 || a.nz === 0;
  };

  /** Standing above street / on stairs — do not break voxels or step off. */
  AI.prototype._stayOnDeck = function (unit) {
    const pos = unit.mesh.position;
    if (this._onRampCell(pos.x, pos.z)) return true;
    const streetCap = (this.world && this.world._dGy != null ? this.world._dGy : 8) + 1.5;
    const low = this._floorBelow(pos.x, pos.z, Math.min(pos.y, streetCap));
    return pos.y - low > 1.6;
  };

  /** Same-level stand that is not a 1-wide rail. */
  AI.prototype._sameDeckStand = function (x, z, fromY) {
    const y = this._floorBelow(x, z, fromY);
    if (Math.abs(y - fromY) > 1.15) return null;
    if (this._soldierOverlaps(x, y, z)) return null;
    if (this._inRiver(x, z)) return null;
    if (this._isNarrowLip(x, z, y)) return null;
    return y;
  };

  /** Nudge off a rail / inner corner onto the same floor. */
  AI.prototype._unstickDeck = function (unit) {
    const pos = unit.mesh.position;
    const y0 = pos.y;
    for (let r = 0.4; r <= 2.6; r += 0.4) {
      for (let a = 0; a < 8; a++) {
        const ang = (a * Math.PI) / 4;
        const x = pos.x + Math.cos(ang) * r;
        const z = pos.z + Math.sin(ang) * r;
        const y = this._sameDeckStand(x, z, y0);
        if (y == null) continue;
        pos.set(x, y, z);
        return true;
      }
    }
    return false;
  };

  /**
   * Next stair cell around a switchback. BFS along same-height treads until a
   * one-step rise/drop appears, then walk the first cell of that path — never
   * a straight XZ shortcut through the inner corner, and never ping-pong on
   * the landing.
   */
  AI.prototype._nextStairStep = function (unit, goalPos) {
    const pos = unit.mesh.position;
    if (!this.world.isStairColumn || !this._onRampCell(pos.x, pos.z)) return null;
    const wantUp = goalPos && goalPos.y > pos.y + 1.15;
    const wantDown = goalPos && goalPos.y < pos.y - 1.15;
    const ix = Math.floor(pos.x);
    const iz = Math.floor(pos.z);
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    const seen = {};
    seen[ix + ',' + iz] = 1;
    const q = [{ x: ix, z: iz, first: null, dist: 0 }];
    let qi = 0;
    const gyLo = pos.y - 1.3;
    const gyHi = pos.y + 1.3;
    while (qi < q.length) {
      const cur = q[qi++];
      if (cur.dist >= 16) continue;
      for (let d = 0; d < 4; d++) {
        const x = cur.x + dirs[d][0];
        const z = cur.z + dirs[d][1];
        const ck = x + ',' + z;
        if (seen[ck]) continue;
        if (!this.world.isStairColumn(x, z)) continue;
        const treads = this.world.stairTreadYs ? this.world.stairTreadYs(x, z) : [];
        let stand = null;
        for (let t = 0; t < treads.length; t++) {
          const s = treads[t] + 1;
          if (s < gyLo || s > gyHi) continue;
          if (stand == null) stand = s;
          else if (wantDown) {
            if (s < stand) stand = s;
          } else if (s > stand) stand = s;
        }
        if (stand == null) continue;
        if (wantUp && stand < pos.y - 0.12) continue;
        if (wantDown && stand > pos.y + 0.12) continue;
        seen[ck] = 1;
        const px = x + 0.5;
        const pz = z + 0.5;
        const first = cur.first || { x: px, z: pz, y: stand + 0.04 };
        if (cur.first == null && !this._legClimbable(pos.x, pos.z, px, pz, pos.y)) continue;
        if (wantUp && stand > pos.y + 0.22) return first;
        if (wantDown && stand < pos.y - 0.22) return first;
        q.push({ x: x, z: z, first: first, dist: cur.dist + 1 });
      }
    }
    return null;
  };

  /**
   * A leg is only usable if the unit can actually WALK its whole length, not
   * just stand at the far end. Height is read at the unit's current level
   * (_floorBelow) so a rooftop above a street cell is not treated as a wall.
   * Stair columns may rise a step at a time; a non-stair body overlap is a wall.
   */
  AI.prototype._legClimbable = function (x0, z0, x1, z1, fromY) {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return true;
    const n = Math.max(1, Math.ceil(len / 0.7));
    let prev = fromY != null ? fromY : this._floorBelow(x0, z0, 40);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = x0 + dx * t;
      const z = z0 + dz * t;
      const gy = this._floorBelow(x, z, prev + 0.85);
      const ramp = this._onRampCell(x, z);
      if (gy - prev > STEP_UP + 0.2 && !ramp) return false;
      if (!ramp && this._soldierOverlaps(x, gy, z)) return false;
      prev = gy;
    }
    return true;
  };

  /**
   * When the goal is on another floor, walk to the nearest stair tread at our
   * height instead of grinding the XZ shortcut into a wall.
   */
  AI.prototype._climbGoal = function (unit, goalPos) {
    if (!goalPos) return null;
    const pos = unit.mesh.position;
    const dy = goalPos.y - pos.y;
    const onRamp = this._onRampCell(pos.x, pos.z);
    if (onRamp) {
      const sameFloor =
        Math.abs(dy) < 1.4 && this._legClimbable(pos.x, pos.z, goalPos.x, goalPos.z, pos.y);
      if (!sameFloor) {
        const next = this._nextStairStep(unit, goalPos);
        if (next) {
          if (!this._tmpClimb) this._tmpClimb = new THREE.Vector3();
          return this._tmpClimb.set(next.x, next.y, next.z);
        }
      }
    }
    const list = this.world && this.world._stairColList;
    if (!list || !list.length) return null;
    if (Math.abs(dy) < 2.2) return null;
    const wantUp = dy > 0;
    const gx = goalPos.x - pos.x;
    const gz = goalPos.z - pos.z;
    const cand = [];
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const x = c.x + 0.5;
      const z = c.z + 0.5;
      const treads = this.world.stairTreadYs ? this.world.stairTreadYs(c.x, c.z) : [c.y];
      for (let t = 0; t < treads.length; t++) {
        const tread = (treads[t] != null ? treads[t] : 0) + 1;
        if (wantUp) {
          if (tread < pos.y - 1.3 || tread > pos.y + 4.2) continue;
        } else if (tread > pos.y + 1.3 || tread < pos.y - 4.2) continue;
        const d = Math.hypot(x - pos.x, z - pos.z);
        if (d < 0.35 || d > 58) continue;
        const ideal = wantUp ? pos.y + 1.0 : pos.y - 1.0;
        const toward = gx * (x - pos.x) + gz * (z - pos.z);
        cand.push({
          x: x,
          z: z,
          y: tread + 0.04,
          score: d + Math.abs(tread - ideal) * 0.4 - Math.min(10, toward * 0.06),
        });
      }
    }
    if (!cand.length) return null;
    cand.sort(function (a, b) {
      return a.score - b.score;
    });
    let pick = cand[0];
    const maxCheck = Math.min(12, cand.length);
    for (let i = 0; i < maxCheck; i++) {
      const c = cand[i];
      if (this._legClimbable(pos.x, pos.z, c.x, c.z, pos.y)) {
        pick = c;
        break;
      }
    }
    if (!this._tmpClimb) this._tmpClimb = new THREE.Vector3();
    return this._tmpClimb.set(pick.x, pick.y, pick.z);
  };

  /** March on goalPos, refreshing the routed waypoint as we arrive, stall out,
   *  or the cached leg goes stale. Pursuit is free: a foe that just left weapon
   *  range is still the nearest enemy, so the unit keeps advancing on them. */
  AI.prototype._advanceOn = function (unit, goalPos, dt) {
    unit.state = 'advance';
    const climb = this._climbGoal(unit, goalPos);
    if (climb) goalPos = climb;
    unit._seekCd = (unit._seekCd || 0) - dt;
    const stale =
      !unit.seekTarget ||
      unit._seekCd <= 0 ||
      !this._isWalkable(unit.seekTarget.x, unit.seekTarget.z, unit.team);
    if (stale && !climb) {
      unit.seekTarget = this._seekWaypoint(unit, goalPos);
      unit._seekCd = 1.0 + Math.random() * 0.8;
    }

    // Boxed against a wall the router could not route past → commit to circling
    // the obstacle on one side for a beat so the unit rounds the corner instead
    // of grinding straight into it (the 卡墙 case). Only armed after sustained
    // blockage below, and it decays the moment the unit moves freely again.
    let aim = climb || unit.seekTarget || goalPos;
    if (!climb && (unit._wallFollow || 0) > 0) {
      unit._wallFollow -= dt;
      aim = this._wallFollowAim(unit, goalPos) || aim;
    }

    const dist = this._moveToward(unit, aim, dt, 0.8);
    if (dist <= 1.0) unit.seekTarget = null;
    if (unit._moveBlocked) {
      unit._blockRepath = (unit._blockRepath || 0) + dt;
      if (unit._blockRepath > 0.4) {
        unit.seekTarget = null;
        unit._blockRepath = 0;
        unit.blockTime = 0;
        // Arm (or flip) the wall-follow commitment so repeated blocks round the
        // corner instead of re-picking the same blocked leg every refresh.
        unit._wallSide =
          (unit._wallFollow || 0) > 0
            ? -(unit._wallSide || 1)
            : unit._wallSide || (((unit._sepId || unit.id.length) & 1) ? 1 : -1);
        unit._wallFollow = 0.9;
      }
    } else {
      unit._blockRepath = 0;
    }

    // 行进间开火：赶路（advance）时不再只顾埋头移动——顺手还击进入射程且有视线的敌人，
    // 移动方向不变（本调用只补射，不干预 _moveToward 的走位），修复「赶路被打不还手送死」。
    this._opportunityFire(unit, dt);
  };

  /**
   * Move-and-shoot：advance 状态下的顺手一枪。找到武器射程内最近的敌人，交给
   * _tryShoot 统一处理冷却 / 视线 / 命中 / 曳光——无目标或打不到就静默返回，绝不改变走位。
   */
  AI.prototype._opportunityFire = function (unit, dt) {
    const foe = this._nearestHostile(unit, unit.range || 24);
    if (!foe) return;
    this._tryShoot(unit, this._shootTargetOf(foe), dt);
  };

  /** 把 _nearestHostile 的 threat 描述子解析成 _tryShoot 需要的射击目标（玩家需带 alive/object）。*/
  AI.prototype._shootTargetOf = function (threat) {
    if (threat.isPlayer) {
      return {
        object: this.player.object,
        isPlayer: true,
        alive: !this.player.dead && this.player.health > 0,
      };
    }
    return threat.unit;
  };

  /**
   * Lateral-forward aim that skirts a wall on unit._wallSide. Kept mostly
   * sideways (with a little forward bias) so _moveToward's per-axis slide walks
   * the unit ALONG the wall face and around the corner, rather than pressing
   * into it. Pure geometry — never touches world/bomb state.
   */
  AI.prototype._wallFollowAim = function (unit, goalPos) {
    const pos = unit.mesh.position;
    const gx = goalPos.x - pos.x;
    const gz = goalPos.z - pos.z;
    const gl = Math.hypot(gx, gz);
    if (gl < 0.01) return null;
    const nx = gx / gl;
    const nz = gz / gl;
    const side = unit._wallSide || 1;
    const px = -nz * side;
    const pz = nx * side;
    if (!this._tmpWall) this._tmpWall = new THREE.Vector3();
    return this._tmpWall.set(
      pos.x + (px * 0.85 + nx * 0.15) * 8,
      pos.y,
      pos.z + (pz * 0.85 + nz * 0.15) * 8
    );
  };

  /**
   * Offset an advance goal sideways by a stable per-unit bias so a squad fans
   * into a loose line closing on the target instead of every soldier funnelling
   * onto the exact same enemy and stacking into a blob. The lateral offset
   * shrinks with range, so units still collapse onto the foe for the actual
   * kill once they are close.
   */
  AI.prototype._spreadGoal = function (unit, targetPos) {
    if (unit._flank == null) unit._flank = Math.random() * 2 - 1;
    const pos = unit.mesh.position;
    const dx = targetPos.x - pos.x;
    const dz = targetPos.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 7) return targetPos;
    const inv = 1 / d;
    const px = -dz * inv;
    const pz = dx * inv;
    const spread = unit._flank * Math.min(16, d * 0.5);
    if (!this._tmpSpread) this._tmpSpread = new THREE.Vector3();
    return this._tmpSpread.set(
      targetPos.x + px * spread,
      targetPos.y != null ? targetPos.y : pos.y,
      targetPos.z + pz * spread
    );
  };

  /**
   * 热区导航 flow field. When a roaming 死斗 soldier has no enemy in local
   * reach it commits to a stable, weighted hotzone and keeps pressing toward
   * it (separation fans the arrivals into a loose crowd rather than a stack).
   * The commitment is per-unit, weight-proportional and time-boxed, and the
   * per-unit bias rotates on every re-pick — so units spread across ALL the
   * hotspots over time instead of every soldier draining onto the single
   * hottest one. That is what turns the old one-blob melee into several
   * simultaneous skirmishes the player can always find.
   */
  AI.prototype._hotzoneGoal = function (unit, dt) {
    const world = this.world;
    const zones = world && world.getTdmHotzones ? world.getTdmHotzones() : null;
    if (!zones || !zones.length) return null;

    let zone = unit._hotzone;
    if (!zone || zones.indexOf(zone) === -1 || (unit._hotzoneHold || 0) <= 0) {
      zone = this._pickHotzone(unit, zones);
      unit._hotzone = zone;
      unit._hotzoneHold = 8 + Math.random() * 6; // seconds committed here
    }
    if (!zone) return null;

    const pos = unit.mesh.position;
    const dx = zone.x - pos.x;
    const dz = zone.z - pos.z;
    const arriveR = zone.r || 14;
    // Only burn the commitment down once the unit is actually loitering in the
    // zone, so travel time doesn't count against its stay. When it expires the
    // unit rotates to a fresh hotspot, keeping every zone continuously fed.
    if (dx * dx + dz * dz <= arriveR * arriveR) {
      unit._hotzoneHold = (unit._hotzoneHold || 0) - dt;
    }

    if (!this._tmpHot) this._tmpHot = new THREE.Vector3();
    this._tmpHot.set(zone.x, pos.y, zone.z);
    return this._spreadGoal(unit, this._tmpHot);
  };

  /**
   * Weight-proportional hotzone assignment. Each unit gets a stable bias in
   * [0,1) mapped through the zones' cumulative weight, so roughly `weight`-many
   * soldiers pick each zone regardless of where they spawned — no distance term,
   * so a distant hot fight can't drag the whole map onto one point. The bias
   * advances by the golden ratio on every re-pick, walking the unit through the
   * different hotspots over the match.
   */
  AI.prototype._pickHotzone = function (unit, zones) {
    if (unit._hotBias == null) unit._hotBias = Math.random();
    else unit._hotBias = (unit._hotBias + 0.6180339887) % 1;
    let total = 0;
    for (let i = 0; i < zones.length; i++) total += zones[i].weight || 1;
    let r = unit._hotBias * total;
    for (let i = 0; i < zones.length; i++) {
      r -= zones[i].weight || 1;
      if (r <= 0) return zones[i];
    }
    return zones[zones.length - 1];
  };

  /** Rotate `unit` to face `targetPos`, capped to a fixed yaw step per frame. */
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
    if ((unit.throwBlind || 0) > 0.25) return;
    if ((unit.throwStun || 0) > 0.2) return;

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

    const A = global.VF.Audio;
    if (A && A.playAt) {
      const shot = unit.type === 'heavy' ? 'shoot_sg' : unit.type === 'ranged' ? 'shoot_sr' : 'shoot_ar';
      A.playAt(shot, from.x, from.y, from.z);
    }

    if (!didHit) return;

    const dmg = unitDealDamage(unit);
    if (targetUnit.isTurret && targetUnit.turret) {
      const skills = global.VF.game && global.VF.game.skills;
      if (skills && skills.damageTurret) {
        skills.damageTurret(targetUnit.turret, dmg);
      }
      return;
    }

    // 枪械模式: 这一枪属于该单位当前等级的武器——决定击杀能否算进度，
    // 也决定这一枪能否打出爆头降级。
    const ggWeapon = ggLive() && global.VF.GgMatch ? global.VF.GgMatch.weaponOfUnit(unit) : null;
    const ggHeadshot = ggWeapon ? Math.random() < ggHeadshotChance() : false;

    if (targetUnit === this.player || targetUnit.isPlayer) {
      if (
        global.VF.Skills &&
        global.VF.Skills.isPlayerStealthed(this.player)
      ) {
        return;
      }
      if (this.player.takeDamage) {
        this.player.takeDamage(dmg, unit.mesh.position, unit, {
          headshot: ggHeadshot,
          weaponId: ggWeapon,
        });
      } else {
        this.player.health = Math.max(0, this.player.health - dmg);
        if (global.VF.UI) {
          global.VF.UI.updateVitals(this.player.health, this.player.armor);
        }
      }
    } else {
      this._damageUnit(targetUnit, dmg, null, false, unit, {
        headshot: ggHeadshot,
        weaponId: ggWeapon,
      });
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
    if (w.isStairVoxel && w.isStairVoxel(x, y, z)) return false;
    if (w._isTerrainFill && w._isTerrainFill(x, y, z)) return false;
    if (w._isBaseKeepClear && w._isBaseKeepClear(x, z, 0) && y <= 6) return false;
    if (t === BLOCK.METAL && w.breakBlock) return !!w.breakBlock(x, y, z);
    w.set(x, y, z, BLOCK.AIR);
    const cs = w.chunkSize || 16;
    const cx = Math.floor(x / cs);
    const cz = Math.floor(z / cs);
    if (w._markChunkDirty) {
      w._markChunkDirty(cx, cz);
      if (x % cs === 0) w._markChunkDirty(cx - 1, cz);
      if (x % cs === cs - 1) w._markChunkDirty(cx + 1, cz);
      if (z % cs === 0) w._markChunkDirty(cx, cz - 1);
      if (z % cs === cs - 1) w._markChunkDirty(cx, cz + 1);
    }
    return true;
  };

  AI.prototype._breakOverlapping = function (unit) {
    const pos = unit.mesh.position;
    const box = this._soldierBoxAt(pos.x, pos.y, pos.z);
    let broke = false;
    for (let vx = Math.floor(box.min.x); vx <= Math.floor(box.max.x); vx++) {
      for (let vy = Math.floor(box.min.y); vy <= Math.floor(box.max.y); vy++) {
        for (let vz = Math.floor(box.min.z); vz <= Math.floor(box.max.z); vz++) {
          if (this.world._isSolid(vx, vy, vz) && this._aiBreakBlock(vx, vy, vz)) {
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
    const y0 = pos.y;

    if (this._unstickDeck(unit) && !this._soldierOverlaps(pos.x, pos.y, pos.z)) return true;

    for (let dy = 0.2; dy <= STEP_UP + 0.15; dy += 0.2) {
      const y = y0 + dy;
      if (this._soldierOverlaps(pos.x, y, pos.z)) continue;
      if (this._onRampCell(pos.x, pos.z) || !this._isNarrowLip(pos.x, pos.z, y)) {
        pos.y = y;
        return true;
      }
    }

    if (!this._stayOnDeck(unit)) this._breakOverlapping(unit);
    const y2 = this._floorBelow(pos.x, pos.z, pos.y);
    if (!this._soldierOverlaps(pos.x, y2, pos.z)) pos.y = y2;
    return true;
  };

  AI.prototype._updatePhysics = function (unit, dt) {
    if (!unit || !unit.alive || unit.zipRide) return;
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
      if (
        allowJump &&
        !this._stayOnDeck(unit) &&
        unit.onGround &&
        unit.blockTime > 0.35 &&
        (unit.velY || 0) <= 0.05
      ) {
        unit.velY = JUMP_VEL;
        unit.onGround = false;
        unit.jumpCd = JUMP_COOLDOWN;
      }
      if (unit.blockTime > 0.55) {
        if (this._stayOnDeck(unit) || this._isNarrowLip(pos.x, pos.z, pos.y)) {
          this._unstickDeck(unit);
        } else if (!this._breakAhead(unit)) {
          this._breakOverlapping(unit);
        }
        unit.blockTime = 0.2;
      }
    } else {
      unit.blockTime = Math.max(0, (unit.blockTime || 0) - dt);
    }

    if ((unit.stuckTime || 0) > 1.2) {
      if (this._stayOnDeck(unit) || this._isNarrowLip(pos.x, pos.z, pos.y)) {
        this._unstickDeck(unit);
      } else {
        this._breakOverlapping(unit);
        this._resolveEmbed(unit);
      }
      unit.stuckTime = 0.4;
      if (allowJump && !this._stayOnDeck(unit) && unit.onGround) {
        unit.velY = JUMP_VEL * 0.85;
        unit.onGround = false;
        unit.jumpCd = JUMP_COOLDOWN;
      }
    }

    const prevY = pos.y;
    unit.velY = (unit.velY || 0) - GRAVITY * dt;
    pos.y += unit.velY * dt;

    // Level-aware floor so walking beneath a bridge/overpass no longer snaps the
    // unit up onto the deck (then off the far edge → falling from the sky). Use
    // the higher of last frame / this frame so a fast drop still finds the sill.
    const gy = this._floorBelow(pos.x, pos.z, Math.max(prevY, pos.y));
    if (unit.velY <= 0 && pos.y <= gy + 0.08) {
      if (!this._soldierOverlaps(pos.x, gy, pos.z)) {
        pos.y = gy;
        unit.velY = 0;
        unit.onGround = true;
      } else {
        pos.y = gy;
        if (!this._unstickDeck(unit)) {
          const cy = this._clearStandY(pos.x, pos.z);
          if (cy != null && (this._onRampCell(pos.x, pos.z) || !this._isNarrowLip(pos.x, pos.z, cy))) {
            pos.y = cy;
          } else {
            this._resolveEmbed(unit);
          }
        }
        unit.velY = 0;
        unit.onGround = true;
      }
    } else if (pos.y > gy + 0.15) {
      unit.onGround = false;
    }

    if (this._soldierOverlaps(pos.x, pos.y, pos.z)) {
      if (unit.velY > 0) unit.velY = 0;
      this._resolveEmbed(unit);
    } else if (
      unit.onGround &&
      this._isNarrowLip(pos.x, pos.z, pos.y)
    ) {
      this._unstickDeck(unit);
    }
  };

  /* ---------- Movement ---------- */

  AI.prototype._moveAxis = function (unit, axis, delta) {
    if (Math.abs(delta) < 1e-8) return false;
    const pos = unit.mesh.position;
    const before = pos[axis];
    const beforeY = pos.y;
    pos[axis] += delta;

    // Pad/base patrol can skim shore; only hard-block river + buildings.
    // 死斗 / 爆破 also drop the territory fence so engaged units can chase across
    // the whole arena instead of stopping dead at the old river midline.
    const enforceTeam =
      !arenaMode() && unit.role !== 'pad' && unit.state !== 'patrol' && unit.state !== 'idle';
    if (
      this._inRiver(pos.x, pos.z) ||
      this._insideBuilding(pos.x, pos.z, 0.25) ||
      (enforceTeam && this._teamSide(pos.x, pos.z) !== unit.team)
    ) {
      pos[axis] = before;
      return false;
    }

    if (!this._soldierOverlaps(pos.x, pos.y, pos.z)) {
      const gy = this._floorBelow(pos.x, pos.z, beforeY);
      if (beforeY - gy > 1.35) {
        pos[axis] = before;
        return false;
      }
      return true;
    }

    let lifted = false;
    if (this.world.isStairColumn && this.world.isStairColumn(Math.floor(pos.x), Math.floor(pos.z))) {
      const treads = this.world.stairTreadYs
        ? this.world.stairTreadYs(Math.floor(pos.x), Math.floor(pos.z))
        : [];
      let stand = null;
      for (let t = 0; t < treads.length; t++) {
        const s = treads[t] + 1 + 0.04;
        const need = s - beforeY;
        if (need > 0.02 && need <= STEP_UP + 0.2 && (stand == null || s < stand)) stand = s;
      }
      if (stand != null) {
        pos.y = stand;
        lifted = true;
      }
    }
    if (!lifted) {
      pos.y = beforeY + STEP_UP;
      if (this._isNarrowLip(pos.x, pos.z, pos.y)) {
        pos.y = beforeY;
        pos[axis] = before;
        return false;
      }
    }
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

    let step = unit.speed * feelAi().speedMul * (unit._sprintMul || 1) * dt;
    if ((unit.throwStun || 0) > 0) step *= 0.5;
    const stepCap = MAX_STEP * (unit._sprintMul || 1);
    if (step > stepCap) step = stepCap;

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
        if (u.alive && u.mesh && !u.zipRide) {
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
          if (
            this._isWalkable(ax, az, a.team) &&
            !this._soldierOverlaps(ax, pa.y, az) &&
            Math.abs(this._floorBelow(ax, az, pa.y) - pa.y) <= 1.2 &&
            !this._isNarrowLip(ax, az, pa.y)
          ) {
            pa.x = ax;
            pa.z = az;
          }
          if (
            this._isWalkable(bx, bz, b.team) &&
            !this._soldierOverlaps(bx, pb.y, bz) &&
            Math.abs(this._floorBelow(bx, bz, pb.y) - pb.y) <= 1.2 &&
            !this._isNarrowLip(bx, bz, pb.y)
          ) {
            pb.x = bx;
            pb.z = bz;
          }
        }
      }
    }
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

    // Detection reaches TDM_ENGAGE_RANGE (60) but the weapon only bites at
    // unit.range (18–36), and a shot through the central landmark fails the LOS
    // test. Standing still the instant a foe is merely *spotted* is what froze
    // both teams in the dead zone. If we can't actually land a shot yet, keep
    // closing (routing around the landmark) instead of idling.
    const weaponR = unit.range || 24;
    if (threat.dist >= 6) {
      if (!this._engageFrom) {
        this._engageFrom = new THREE.Vector3();
        this._engageTo = new THREE.Vector3();
      }
      this._engageFrom.copy(unit.mesh.position);
      this._engageFrom.y += 1.4;
      this._engageTo.copy(threat.pos);
      this._engageTo.y += 1.3;
      const canFire = threat.dist <= weaponR && this._hasLOS(this._engageFrom, this._engageTo);
      if (!canFire) {
        this._advanceOn(unit, threat.pos, dt);
        return;
      }
    }
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
    const shootTarget = this._shootTargetOf(threat);

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

  /* ─────────────────────────── 爆破 objective brain ─────────────────────────── */

  /** True while this unit is committed to a plant/defuse — hold position. */
  AI.prototype._sdCommitted = function (unit, dt) {
    const b = global.VF && global.VF.SdBomb;
    if (!b) return false;
    if (b.is(b.S.PLANTING) && b.planterId === unit.id) {
      if (b.plantPos) this._faceToward(unit, b.plantPos, dt);
      unit.state = 'plant';
      return true;
    }
    if (b.is(b.S.DEFUSING) && b.defuserId === unit.id) {
      if (b.plantPos) this._faceToward(unit, b.plantPos, dt);
      unit.state = 'defuse';
      return true;
    }
    return false;
  };

  /**
   * Bomb-down override: once the bomb is planted the round is about the bomb,
   * not the firefight. Defenders make the retake/defuse the top priority — a
   * defender that reaches the plant defuses through the fight instead of trading
   * shots beside it, and defenders elsewhere rush the plant (only stopping to
   * drop a point-blank attacker) instead of getting pinned mid-map. Attackers
   * keep their normal engage/hold behaviour, so this only steers defenders.
   * Returns true when it has taken over this unit's turn.
   */
  AI.prototype._sdBombLive = function (unit, dt, b) {
    if (!b || !(b.is(b.S.PLANTED) || b.is(b.S.DEFUSING))) return false;
    const m = global.VF && global.VF.SdMatch;
    if (!m || unit.team === m.attackerTeam || !b.plantPos) return false;
    const pos = unit.mesh.position;

    // Standing on the bomb → defuse through the firefight (defuse wins the round).
    if (b.is(b.S.PLANTED) && this._within(pos, b.plantPos, this._sdDefuseR())) {
      b.beginDefuse(unit.id, false);
      this._faceToward(unit, b.plantPos, dt);
      unit.state = 'defuse';
      return true;
    }

    // Not there yet: clear a point-blank attacker, else rush the retake so the
    // defenders converge on the plant rather than fighting across the map.
    const near = this._nearestHostile(unit, SD_RETAKE_SELF_DEF_R);
    if (near) {
      this._engage(unit, near, dt);
      return true;
    }
    unit._sprintMul = SD_RETAKE_SPRINT;
    this._advanceOn(unit, this._sdGoal(unit, b.plantPos, pos, true), dt);
    return true;
  };

  /**
   * Dropped-bomb recovery: a live bomb lying on the ground is the round, so the
   * attackers converge on it and pick it back up with priority over stray fights
   * (only breaking for a point-blank threat). Without this the 40yd engage check
   * upstream always wins and the bomb just sits there. Returns true if it took
   * over this unit's turn; only steers attackers.
   */
  AI.prototype._sdDropRecovery = function (unit, dt, b) {
    if (!b || !b.is(b.S.DROPPED) || !b.dropPos) return false;
    const m = global.VF && global.VF.SdMatch;
    if (!m || unit.team !== m.attackerTeam) return false;
    const pos = unit.mesh.position;
    if (this._within(pos, b.dropPos, this._sdPickupR()) && b.canPickup()) {
      b.pickup(unit.id);
      return true;
    }
    const near = this._nearestHostile(unit, SD_RETAKE_SELF_DEF_R);
    if (near) {
      this._engage(unit, near, dt);
      return true;
    }
    this._advanceOn(unit, this._sdGoal(unit, b.dropPos, pos, false), dt);
    return true;
  };

  /** Drive one soldier toward its 爆破 objective. Returns true if it took over. */
  AI.prototype._sdObjective = function (unit, dt) {
    const VFg = global.VF;
    const b = VFg && VFg.SdBomb;
    const m = VFg && VFg.SdMatch;
    if (!b || !m) return false;
    const sites = this.world.getSdPlantSites ? this.world.getSdPlantSites() : [];
    if (!sites.length) return false;
    return unit.team === m.attackerTeam
      ? this._sdAttacker(unit, dt, b, sites)
      : this._sdDefender(unit, dt, b, sites);
  };

  AI.prototype._sdAttacker = function (unit, dt, b, sites) {
    const pos = unit.mesh.position;

    // Bomb down: push onto the plant to protect the countdown.
    if (b.is(b.S.PLANTED) || b.is(b.S.DEFUSING)) {
      if (b.plantPos) this._advanceOn(unit, this._sdGoal(unit, b.plantPos, pos, true), dt);
      return true;
    }
    // Bomb dropped: recover it (nearest attacker gets there first).
    if (b.is(b.S.DROPPED)) {
      if (!b.dropPos) return false;
      if (this._within(pos, b.dropPos, this._sdPickupR()) && b.canPickup()) {
        b.pickup(unit.id);
        return true;
      }
      this._advanceOn(unit, this._sdGoal(unit, b.dropPos, pos, false), dt);
      return true;
    }
    // Carrier: march the bomb onto the nearest site and start planting.
    if (b.carrierId === unit.id) {
      const site = this._nearestSite(pos, sites);
      if (!site) return false;
      if (this._within(pos, site, site.r)) {
        b.beginPlant(unit.id, site.id, { pos: { x: site.x, y: site.y, z: site.z } });
        this._faceToward(unit, this._sdVec(site, pos), dt);
        return true;
      }
      this._advanceOn(unit, this._sdGoal(unit, site, pos, false), dt);
      return true;
    }
    // Escort: converge on the site nearest the carrier so the push groups up.
    const carrierPos = this._agentPos(b.carrierId) || pos;
    const focus = this._nearestSite(carrierPos, sites);
    if (focus) {
      this._advanceOn(unit, this._sdGoal(unit, focus, pos, true), dt);
      return true;
    }
    return false;
  };

  AI.prototype._sdDefender = function (unit, dt, b, sites) {
    const pos = unit.mesh.position;

    // Bomb planted: rush the plant and defuse it.
    if (b.is(b.S.PLANTED) || b.is(b.S.DEFUSING)) {
      if (!b.plantPos) return false;
      if (this._within(pos, b.plantPos, this._sdDefuseR()) && b.is(b.S.PLANTED)) {
        b.beginDefuse(unit.id, false);
        this._faceToward(unit, b.plantPos, dt);
        return true;
      }
      this._advanceOn(unit, this._sdGoal(unit, b.plantPos, pos, true), dt);
      return true;
    }
    // Pre-plant / planting: hold the assigned site — or, once a plant is being
    // cast, rotate the whole defence onto that site to contest it (听到安装音效→转移).
    if (b.is(b.S.PLANTING)) {
      const ps = b.plantPos
        ? { x: b.plantPos.x, z: b.plantPos.z, r: 6 }
        : this._sdSiteById(sites, b.site);
      if (ps) {
        this._sdDefendSite(unit, dt, ps);
        return true;
      }
    }
    const site = this._assignedSite(unit, sites);
    if (!site) return false;
    this._sdDefendSite(unit, dt, site);
    return true;
  };

  /**
   * 守方驻守（安装前/安装中）：卡守一个包点及其咽喉。交火但受「拴绳」约束——
   * 只压制逼近包点的攻方或贴脸的攻方，绝不为追击离开包点太远（否则包点失守）。
   * 这样守方真正占据 A/B，而不是被通用追敌逻辑牵着满图游走。site 需含 {x,z,r?}。
   */
  AI.prototype._sdDefendSite = function (unit, dt, site) {
    const pos = unit.mesh.position;
    const r = site.r || 6;
    const distSite = Math.hypot(pos.x - site.x, pos.z - site.z);

    // 接敌：只要视野里有攻方就还击——「能打到」永远开火，拴绳只约束「追多远」，
    // 绝不再用包点半径去卡开火（否则守方被圈外打却站着不还手）。
    let threat = this._nearestHostile(unit, TDM_ENGAGE_RANGE);
    // 受击回击：被侧翼 / 背后 / 超出索敌半径的火力打中时，最近可见敌人可能是一堵墙后的
    // 诱饵（打不到），真正的射手却被忽略。用受击记忆兜底：没有可见目标，或射手与最近敌人
    // 距离相当时，优先转身回击刚才打我的人，而不是站桩挨打。
    const agg = this._recentAttacker(unit, SD_DEF_LEASH_R + 18);
    if (agg && (!threat || agg.dist <= threat.dist + 8)) threat = agg;
    if (threat) {
      if (!this._engageFrom) {
        this._engageFrom = new THREE.Vector3();
        this._engageTo = new THREE.Vector3();
      }
      this._engageFrom.copy(pos);
      this._engageFrom.y += 1.4;
      this._engageTo.copy(threat.pos);
      this._engageTo.y += 1.3;
      const weaponR = unit.range || 24;
      const canFire =
        threat.dist <= weaponR && this._hasLOS(this._engageFrom, this._engageTo);
      // 能开火：就地还击（此处已确保有视野且在射程内，_engage 会直接压枪射击）。
      if (canFire) {
        this._engage(unit, threat, dt);
        return;
      }
      // 打不到（无视野或超出射程）：绝不追出包点——那正是「只巡逻不守点」的根因。
      // 被引出包点就先归位，已在点上则钉住盯防进攻通道，等敌人进入射界再还击。
      if (distSite > r + 3) {
        this._advanceOn(unit, this._sdGoal(unit, site, pos, true), dt);
      } else {
        unit.state = 'idle';
        this._faceToward(unit, this._engageTo, dt);
      }
      return;
    }

    // 未接敌：不在包点上就归位，在包点上就驻守盯防进攻通道。
    if (distSite > r + 4) {
      this._advanceOn(unit, this._sdGoal(unit, site, pos, true), dt);
      return;
    }
    unit.state = 'idle';
    this._faceToward(unit, this._sdVec(site, pos), dt);
  };

  AI.prototype._sdSiteById = function (sites, id) {
    for (let i = 0; i < sites.length; i++) if (sites[i].id === id) return sites[i];
    return null;
  };

  /**
   * 守方站位（安装前/安装中）：先于通用追敌逻辑运行，让守方「卡守包点」而不是
   * 被最近的攻方牵着满图追人。安装后（PLANTED/DEFUSING）的 retake 由 _sdBombLive
   * 接管，这里不处理。只驱动守方；返回 true 表示已接管本帧。
   */
  AI.prototype._sdDefendPre = function (unit, dt, b) {
    const m = global.VF && global.VF.SdMatch;
    if (!b || !m || unit.team === m.attackerTeam) return false;
    if (b.is(b.S.PLANTED) || b.is(b.S.DEFUSING)) return false;
    const sites = this.world.getSdPlantSites ? this.world.getSdPlantSites() : [];
    if (!sites.length) return false;

    if (b.is(b.S.PLANTING)) {
      const ps = b.plantPos
        ? { x: b.plantPos.x, z: b.plantPos.z, r: 6 }
        : this._sdSiteById(sites, b.site);
      if (ps) {
        this._sdDefendSite(unit, dt, ps);
        return true;
      }
    }

    const site = this._assignedSite(unit, sites);
    if (!site) return false;
    this._sdDefendSite(unit, dt, site);
    return true;
  };

  AI.prototype._sdGoal = function (unit, target, pos, spread) {
    if (!this._tmpSd) this._tmpSd = new THREE.Vector3();
    this._tmpSd.set(target.x, pos.y, target.z);
    return spread ? this._spreadGoal(unit, this._tmpSd) : this._tmpSd;
  };

  AI.prototype._sdVec = function (target, pos) {
    if (!this._tmpSdFace) this._tmpSdFace = new THREE.Vector3();
    return this._tmpSdFace.set(target.x, pos ? pos.y : target.y || 0, target.z);
  };

  AI.prototype._within = function (pos, target, r) {
    const dx = pos.x - target.x;
    const dz = pos.z - target.z;
    return dx * dx + dz * dz <= r * r;
  };

  AI.prototype._nearestSite = function (pos, sites) {
    let best = null;
    let bd = Infinity;
    for (let i = 0; i < sites.length; i++) {
      const s = sites[i];
      const dx = pos.x - s.x;
      const dz = pos.z - s.z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  };

  /** Stable per-unit site assignment so defenders split across A and B. */
  AI.prototype._assignedSite = function (unit, sites) {
    if (unit._sdSite && sites.indexOf(unit._sdSite) !== -1) return unit._sdSite;
    const id = unit.id || '';
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h + id.charCodeAt(i)) | 0;
    unit._sdSite = sites[Math.abs(h) % sites.length];
    return unit._sdSite;
  };

  AI.prototype._agentPos = function (id) {
    if (!id) return null;
    if (id === 'player') {
      const p = this.player;
      return p && p.object ? p.object.position : null;
    }
    const lists = [this.blue, this.red];
    for (let l = 0; l < lists.length; l++) {
      const list = lists[l];
      if (!list) continue;
      for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) return list[i].mesh ? list[i].mesh.position : null;
      }
    }
    return null;
  };

  AI.prototype._sdPickupR = function () {
    const r = global.VF.GameModes ? global.VF.GameModes.param('pickupRange', 1.0) : 1.0;
    return Math.max(r, 1.6);
  };

  AI.prototype._sdDefuseR = function () {
    const r = global.VF.GameModes ? global.VF.GameModes.param('defuseRange', 1.5) : 1.5;
    return Math.max(r, 2.0);
  };

  AI.prototype._updateBaseSoldier = function (unit, dt) {
    unit._sprintMul = 1;
    const home = unit.home;
    const distHome =
      home && home.cx != null
        ? Math.hypot(unit.mesh.position.x - home.cx, unit.mesh.position.z - home.cz)
        : 0;

    // Pad units: stay near refresh point (leash). 死斗 / 爆破 drop the leash so
    // the spawn-pad soldiers (which is what kit maps hand out — role 'base' only
    // ever appears on the fill fallback) push out and seek instead of loitering.
    if (!arenaMode() && unit.role === 'pad' && home && distHome > PAD_LEASH_R) {
      unit.state = 'patrol';
      unit.target = null;
      const back = new THREE.Vector3(home.cx, unit.mesh.position.y, home.cz);
      this._moveToward(unit, back, dt, 0.95);
      this._faceToward(unit, back, dt);
      unit.patrolTarget = null;
      return;
    }

    // 爆破: a unit mid plant/defuse stays committed even under fire.
    if (sdLive() && this._sdCommitted(unit, dt)) return;

    // 爆破: once the bomb is down, defenders prioritise the retake/defuse over
    // random fights so they actually reach the plant and defuse it in time.
    if (sdLive() && this._sdBombLive(unit, dt, global.VF.SdBomb)) return;

    // 爆破: a live dropped bomb is recovered with priority so the attackers
    // actually go grab it instead of getting stuck in a nearby firefight.
    if (sdLive() && this._sdDropRecovery(unit, dt, global.VF.SdBomb)) return;

    // 爆破: 安装前/安装中，守方优先「卡守包点」而非被最近的攻方牵着满图追人。
    // 必须先于下方的通用追敌逻辑，否则守方永远在追人、不去包点（本次修复点）。
    if (sdLive() && this._sdDefendPre(unit, dt, global.VF.SdBomb)) return;

    const threat = this._nearestHostile(unit, arenaMode() ? TDM_ENGAGE_RANGE : ENGAGE_RANGE);
    if (threat) {
      if (!arenaMode() && unit.role === 'pad' && home && distHome > PAD_PATROL_R + 2) {
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

    // 爆破: no local threat → pursue the round objective (plant / defend / defuse).
    if (sdLive() && this._sdObjective(unit, dt)) return;

    // 死斗 / 自由混战 / 枪械模式: nobody in weapon range → advance on the nearest
    // enemy anywhere on the field instead of idling at spawn. This is the "seek"
    // step that keeps the arena churning; teamless modes reuse it verbatim, with
    // _foeList making "nearest enemy" mean "nearest of everyone else".
    if (tdmLive() || teamlessLive()) {
      const foe = this._nearestEnemyAnywhere(unit, TDM_SENSE_RANGE);
      if (foe) {
        this._advanceOn(unit, this._spreadGoal(unit, foe.pos), dt);
        return;
      }
      // No foe in sight → flow toward the nearest high-weight 热区 so the
      // arena never empties out. Wherever the player is, both teams drain
      // toward the same handful of hotspots, keeping time-to-contact short.
      const hot = this._hotzoneGoal(unit, dt);
      if (hot) {
        this._advanceOn(unit, hot, dt);
        return;
      }
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

  AI.prototype._updateSoldier = function (unit, dt, doBrain) {
    if (!unit.alive) return;
    unit._moveBlocked = false;
    const px = unit.mesh.position.x;
    const pz = unit.mesh.position.z;
    if (doBrain) {
      if (unit.role === 'zip') this._updateZipSoldier(unit, dt);
      else this._updateBaseSoldier(unit, dt);
    } else if (unit.state === 'patrol' && unit.patrolTarget) {
      // Keep walking between brain ticks
      this._moveToward(unit, unit.patrolTarget, dt, 0.9);
    } else if (unit.state === 'advance' && unit.seekTarget) {
      // Keep marching on the enemy between brain ticks (else it stutters at 1/3
      // the frame rate since the brain only re-runs every few frames)
      this._moveToward(unit, unit.seekTarget, dt, 0.8);
    } else if (unit.state === 'engage' && unit._lastThreatPos) {
      // Stop facing the player if they are stealthed
      if (
        global.VF.Skills &&
        global.VF.Skills.isPlayerStealthed(this.player)
      ) {
        unit.state = 'idle';
        unit._lastThreatPos = null;
      } else {
        this._faceToward(unit, unit._lastThreatPos, dt);
      }
    }
    this._updatePhysics(unit, dt);

    if (global.VF.Soldier && global.VF.Soldier.updateLocomotion) {
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

  AI.prototype.update = function (dt) {
    this._updateDeathChunks(dt);
    if (!this.enabled || !this._armiesSpawned) return;
    if (global.VF.GameModes && global.VF.GameModes.prepFrozen && global.VF.GameModes.prepFrozen()) {
      return;
    }

    this.waveTimer += dt;
    const stepDt = Math.min(dt, 0.05);
    this._aiFrame = (this._aiFrame || 0) + 1;
    const brainStride = 3; // full AI brain every 3rd frame per unit
    const frame = this._aiFrame;

    // Physics every frame; brain staggered to cut CPU
    for (let i = 0; i < this.blue.length; i++) {
      const u = this.blue[i];
      if (!u.alive) continue;
      this._updateSoldier(u, stepDt, (i + frame) % brainStride === 0);
    }
    for (let i = 0; i < this.red.length; i++) {
      const u = this.red[i];
      if (!u.alive) continue;
      this._updateSoldier(u, stepDt, (i + frame + 1) % brainStride === 0);
    }

    // Separation every other frame
    if (frame % 2 === 0) this._separateAll(stepDt * 2);

    // Compact dead units occasionally (not every frame)
    if (frame % 15 === 0) {
      this.blue = this.blue.filter(function (u) {
        return u.alive;
      });
      this.red = this.red.filter(function (u) {
        return u.alive;
      });
    }

    const playerTeam = this.world._playerTeam || 'ally';
    if (teamlessMode()) {
      this.allies = this.blue;
      this.enemies = this.red;
    } else if (playerTeam === 'ally') {
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
      blueN += this._playerHead('ally');
      redN += this._playerHead('enemy');
      if (global.VF.UI) {
        // 死斗 / 爆破 own #timer (match/round clock), so the wave timer stays off it
        if (tdmLive() || sdLive() || teamlessLive()) {
          /* TdmUi.sync / SdUi.sync / FfaUi.sync / GgUi.sync drives the clock */
        } else if (!(global.VF.game && global.VF.game.mode === 'pvp')) {
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
  global.VF.ENEMY_DEFS = UNIT_STATS;
  Object.defineProperty(global.VF, 'TEAM_SIZE', {
    configurable: true,
    enumerable: true,
    get: function () {
      return feelAi().teamSize;
    },
  });
  global.VF.ALLY_CHASE_RANGE = ENGAGE_RANGE;
})(window);
