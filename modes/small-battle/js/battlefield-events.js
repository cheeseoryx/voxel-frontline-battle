/**
 * battlefield-events.js — Atmosphere air war with light combat.
 * Better plane models, large variable mushroom clouds, HP + faction damage.
 * Local only — do not require git sync.
 */
(function (global) {
  'use strict';

  const FLEET_MIN = 8;
  const FLEET_MAX = 12;
  const PLANE_ALT_MIN = 18;
  const PLANE_ALT_MAX = 52;
  const PLANE_SPEED_MIN = 9;
  const PLANE_SPEED_MAX = 15;
  const PLANE_HP = 100;
  const PLANE_HIT_R = 3.6;
  const MISSILE_MAX = 8;
  const MISSILE_AIR_HIT = 4.0;
  const DROP_CD_MIN = 3.0;
  const DROP_CD_MAX = 8.0;
  const PLAYER_SAFE_FRIENDLY = 16;
  const TOAST_CD = 28;
  const HIT_FLASH_RED = 0xff2200;

  const _tmpTo = new THREE.Vector3();
  const _tmpClosest = new THREE.Vector3();
  const _tmpCenter = new THREE.Vector3();

  function airFx() {
    return (global.VF.Feel && global.VF.Feel.airStrike) || {};
  }

  function airNum(key, fallback) {
    const v = airFx()[key];
    return v != null && isFinite(v) ? v : fallback;
  }

  function randRange(a, b) {
    return a + Math.random() * (b - a);
  }

  /**
   * Stable per-team killer identity for plane/missile splash damage.
   * These kills are AI-controlled ambiance, not the player's doing — TDM
   * scoring needs a real attacker (never null, never 'player') so a death
   * from an air strike credits the bombing team instead of being read as
   * an unattributed suicide against the victim's own side.
   */
  const _airstrikeActor = {
    ally: { id: 'env:airstrike:ally', name: '空袭', team: 'ally' },
    enemy: { id: 'env:airstrike:enemy', name: '空袭', team: 'enemy' },
  };
  function airstrikeActor(team) {
    return _airstrikeActor[team] || _airstrikeActor.enemy;
  }

  function disposeObject(obj) {
    if (!obj) return;
    obj.traverse(function (c) {
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        if (Array.isArray(c.material)) {
          c.material.forEach(function (m) {
            if (m && m.dispose) m.dispose();
          });
        } else if (c.material.dispose) {
          c.material.dispose();
        }
      }
    });
  }

  function BattlefieldEvents(scene) {
    this.scene = scene;
    this.enabled = true;
    this._active = false;
    this._planes = [];
    this._missiles = [];
    this._fx = [];
    this._toastAt = 0;
    this._worldSize = 256;
    this._targetCount = FLEET_MIN;
    // Ambient planes bomb the map on a loop by default. 死斗 turns this off:
    // there, an airstrike is a killstreak reward called via callStrike().
    this._autoStrike = true;
  }

  /**
   * 死斗 keeps an empty sky: the only aircraft allowed are transient killstreak
   * bombers (plane.strike). Checked live every frame so a stale spawn-time flag
   * can never leave the ambient fleet loitering over a deathmatch.
   */
  BattlefieldEvents.prototype._tdmMode = function () {
    return !!(global.VF.GameModes && global.VF.GameModes.isTdm());
  };

  BattlefieldEvents.prototype.reset = function (game) {
    this._clearAll();
    this._active = true;
    // In 死斗 the fleet is pure atmosphere — no looping bombardment. Strikes
    // are instead summoned on demand when a side lands a killstreak.
    // 爆破 forbids airstrikes entirely: single-life rounds must never be decided
    // by stray ordnance, so the sky stays empty (no ambient fleet, no strikes).
    // 自由混战 keeps the sky empty as well: killstreak rewards are notification
    // only, so a looping bombardment would just be unattributed random death.
    // 枪械模式 goes further — a stray bomb kill grants no weapon progress, so an
    // ambient bombardment would only ever cost people their progress.
    const gm = global.VF.GameModes;
    this._autoStrike = !(gm && (gm.isTdm() || gm.isSd() || gm.isTeamless()));
    if (game && game.world && game.world.worldSize) {
      this._worldSize = game.world.worldSize;
    }
    this._spawnFleet(game);
  };

  BattlefieldEvents.prototype.stop = function () {
    this._active = false;
    this._clearAll();
  };

  BattlefieldEvents.prototype._clearAll = function () {
    for (let i = 0; i < this._planes.length; i++) {
      const p = this._planes[i];
      if (p.mesh && p.mesh.parent) this.scene.remove(p.mesh);
      disposeObject(p.mesh);
    }
    this._planes.length = 0;
    for (let i = 0; i < this._missiles.length; i++) {
      const m = this._missiles[i];
      if (m.mesh && m.mesh.parent) this.scene.remove(m.mesh);
      disposeObject(m.mesh);
    }
    this._missiles.length = 0;
    for (let i = 0; i < this._fx.length; i++) {
      const fx = this._fx[i];
      if (fx.mesh && fx.mesh.parent) this.scene.remove(fx.mesh);
      disposeObject(fx.mesh);
    }
    this._fx.length = 0;
  };

  BattlefieldEvents.prototype.update = function (dt, game) {
    if (!this.enabled || !this._active || !game || !game.running) return;
    if (game.world && game.world.worldSize) this._worldSize = game.world.worldSize;

    for (let i = 0; i < this._planes.length; i++) {
      const p = this._planes[i];
      if (!p.alive) continue;
      this._updatePlane(p, dt, game);
    }

    for (let i = this._missiles.length - 1; i >= 0; i--) {
      if (this._updateMissile(this._missiles[i], dt, game)) {
        const m = this._missiles[i];
        if (m.mesh && m.mesh.parent) this.scene.remove(m.mesh);
        disposeObject(m.mesh);
        this._missiles.splice(i, 1);
      }
    }

    for (let i = this._planes.length - 1; i >= 0; i--) {
      if (!this._planes[i].alive && !this._planes[i].mesh) {
        this._planes.splice(i, 1);
      }
    }

    this._updateFx(dt);
  };

  /* ---------- Fleet / models ---------- */

  BattlefieldEvents.prototype._spawnFleet = function (game) {
    // 死斗: no loitering fleet. Airstrikes are summoned on a killstreak and
    // fly a single transient run (see callStrike), so the sky stays clear.
    if (this._tdmMode() || !this._autoStrike) {
      this._targetCount = 0;
      return;
    }
    const n = FLEET_MIN + ((Math.random() * (FLEET_MAX - FLEET_MIN + 1)) | 0);
    this._targetCount = n;
    let allies = Math.ceil(n / 2);
    let enemies = n - allies;
    for (let i = 0; i < n; i++) {
      let team;
      if (enemies > 0 && allies > 0) {
        team = Math.random() < 0.5 ? 'enemy' : 'ally';
      } else if (enemies > 0) {
        team = 'enemy';
      } else {
        team = 'ally';
      }
      if (team === 'enemy') enemies--;
      else allies--;
      this._planes.push(this._makePlane(game, i / n, team));
    }
  };

  BattlefieldEvents.prototype._buildPlaneMesh = function (hostile) {
    // Little-Bird style low-poly helo (BattleBit-like silhouette)
    const g = new THREE.Group();
    const olive = new THREE.MeshBasicMaterial({ color: 0x3a3d36 });
    const dark = new THREE.MeshBasicMaterial({ color: 0x2a2c28 });
    const skid = new THREE.MeshBasicMaterial({ color: 0x1a1a18 });
    const glass = new THREE.MeshBasicMaterial({
      color: 0x889988,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const tagMat = new THREE.MeshBasicMaterial({
      color: hostile ? 0xe02020 : 0x2a6adf,
    });

    // Bulbous cabin / egg fuselage
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.35, 2.6), olive);
    cabin.position.set(0, 0.15, 0.35);
    g.add(cabin);
    const cabinTop = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.55, 1.8), olive);
    cabinTop.position.set(0, 0.95, 0.25);
    g.add(cabinTop);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.95, 1.1), dark);
    nose.position.set(0, 0.2, 1.85);
    g.add(nose);
    const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.7, 0.35), glass);
    windshield.position.set(0, 0.55, 2.25);
    g.add(windshield);

    // Open side benches
    const benchL = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.18, 1.6), dark);
    benchL.position.set(-1.05, -0.15, 0.2);
    g.add(benchL);
    const benchR = benchL.clone();
    benchR.position.x = 1.05;
    g.add(benchR);

    // Long thin tail boom
    const boom = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 3.8), olive);
    boom.position.set(0, 0.45, -2.9);
    g.add(boom);
    const boomTaper = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 1.2), dark);
    boomTaper.position.set(0, 0.5, -5.0);
    g.add(boomTaper);

    // Vertical fin + tail rotor hub
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.1, 0.85), olive);
    fin.position.set(0, 1.0, -5.35);
    g.add(fin);

    const tailRotor = new THREE.Group();
    const tBlade = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.35, 0.18), dark);
    tailRotor.add(tBlade);
    const tBlade2 = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 1.35), dark);
    tailRotor.add(tBlade2);
    tailRotor.position.set(0.28, 0.85, -5.4);
    g.add(tailRotor);
    g.userData.tailRotor = tailRotor;

    // Main rotor mast + 4 blades
    const mast = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.7, 0.2), dark);
    mast.position.set(0, 1.55, 0.15);
    g.add(mast);
    const mainRotor = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 5.2), dark);
      blade.rotation.y = (i * Math.PI) / 2;
      mainRotor.add(blade);
    }
    mainRotor.position.set(0, 1.95, 0.15);
    g.add(mainRotor);
    g.userData.mainRotor = mainRotor;

    // Landing skids
    const skidL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 3.2), skid);
    skidL.position.set(-0.75, -0.75, 0.2);
    g.add(skidL);
    const skidR = skidL.clone();
    skidR.position.x = 0.75;
    g.add(skidR);
    const strutFL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.55, 0.1), skid);
    strutFL.position.set(-0.75, -0.45, 1.1);
    g.add(strutFL);
    const strutRL = strutFL.clone();
    strutRL.position.z = -0.7;
    g.add(strutRL);
    const strutFR = strutFL.clone();
    strutFR.position.x = 0.75;
    g.add(strutFR);
    const strutRR = strutRL.clone();
    strutRR.position.x = 0.75;
    g.add(strutRR);

    // Team color label plate on fuselage side
    const tagL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.55, 0.9), tagMat);
    tagL.position.set(-0.9, 0.35, 0.4);
    g.add(tagL);
    const tagR = tagL.clone();
    tagR.position.x = 0.9;
    g.add(tagR);

    g.scale.setScalar(1.85 + Math.random() * 0.25);
    g.userData.isPlane = true;
    // Cache base colors for hit-flash restore
    g.traverse(function (c) {
      if (c.isMesh && c.material && c.material.color) {
        c.material.userData = c.material.userData || {};
        c.material.userData.baseColor = c.material.color.getHex();
      }
    });
    return g;
  };

  BattlefieldEvents.prototype._makePlane = function (game, phase, team) {
    team = team || (Math.random() < 0.5 ? 'enemy' : 'ally');
    const hostile = team === 'enemy';
    const size = this._worldSize;
    const alt = randRange(PLANE_ALT_MIN, PLANE_ALT_MAX);
    const axisX = Math.random() < 0.5;
    const dir = Math.random() < 0.5 ? 1 : -1;
    const along = randRange(size * 0.15, size * 0.85);
    let start;
    let end;
    if (axisX) {
      start = new THREE.Vector3(dir < 0 ? size + 20 : -20, alt, along);
      end = new THREE.Vector3(dir < 0 ? -20 : size + 20, alt + randRange(-3, 3), along + randRange(-12, 12));
    } else {
      start = new THREE.Vector3(along, alt, dir < 0 ? size + 20 : -20);
      end = new THREE.Vector3(along + randRange(-12, 12), alt + randRange(-3, 3), dir < 0 ? -20 : size + 20);
    }
    const speed = randRange(PLANE_SPEED_MIN, PLANE_SPEED_MAX);
    const pathLen = start.distanceTo(end);
    const u0 = (phase + Math.random() * 0.15) % 1;
    const mesh = this._buildPlaneMesh(hostile);
    mesh.position.lerpVectors(start, end, u0);
    mesh.lookAt(end);
    this.scene.add(mesh);

    const plane = {
      mesh: mesh,
      hostile: hostile,
      team: team,
      hp: PLANE_HP,
      maxHp: PLANE_HP,
      alive: true,
      start: start,
      end: end,
      t: u0 * (pathLen / speed),
      dur: pathLen / speed,
      dropCd: randRange(0.8, DROP_CD_MAX * 0.5),
    };
    mesh.userData.plane = plane;
    return plane;
  };

  BattlefieldEvents.prototype._respawnPlanePath = function (plane) {
    const size = this._worldSize;
    const alt = randRange(PLANE_ALT_MIN, PLANE_ALT_MAX);
    const axisX = Math.random() < 0.5;
    const dir = Math.random() < 0.5 ? 1 : -1;
    const along = randRange(size * 0.12, size * 0.88);
    if (axisX) {
      plane.start.set(dir < 0 ? size + 25 : -25, alt, along);
      plane.end.set(dir < 0 ? -25 : size + 25, alt + randRange(-4, 4), along + randRange(-18, 18));
    } else {
      plane.start.set(along, alt, dir < 0 ? size + 25 : -25);
      plane.end.set(along + randRange(-18, 18), alt + randRange(-4, 4), dir < 0 ? -25 : size + 25);
    }
    const speed = randRange(PLANE_SPEED_MIN, PLANE_SPEED_MAX);
    plane.dur = plane.start.distanceTo(plane.end) / speed;
    plane.t = 0;
    plane.mesh.position.copy(plane.start);
    plane.mesh.lookAt(plane.end);
  };

  BattlefieldEvents.prototype._updatePlane = function (plane, dt, game) {
    if (!plane.alive || !plane.mesh) return;
    // 死斗 tolerates only killstreak bombers; cull any ambient plane that
    // slipped through a mistimed reset so the sky matches the rules live.
    if (this._tdmMode() && !plane.strike) {
      this._despawnPlane(plane);
      return;
    }
    plane.t += dt;
    const u = Math.min(1, plane.t / Math.max(0.1, plane.dur));
    plane.mesh.position.lerpVectors(plane.start, plane.end, u);
    const lookU = Math.min(1, u + 0.03);
    const look = new THREE.Vector3().lerpVectors(plane.start, plane.end, lookU);
    plane.mesh.lookAt(look);

    const main = plane.mesh.userData.mainRotor;
    const tail = plane.mesh.userData.tailRotor;
    if (main) main.rotation.y += dt * 28;
    if (tail) tail.rotation.x += dt * 42;

    if (plane.hitFlash != null && plane.hitFlash > 0) {
      plane.hitFlash -= dt;
      if (plane.hitFlash <= 0) {
        plane.hitFlash = 0;
        this._setPlaneFlash(plane, false);
      }
    }

    if (u >= 1) {
      if (plane.oneShot) {
        this._despawnPlane(plane);
        return;
      }
      this._respawnPlanePath(plane);
    }

    if (plane.strike) {
      this._runStrike(plane, dt, game);
      return;
    }

    plane.dropCd -= dt;
    if (plane.dropCd <= 0 && this._missiles.length < MISSILE_MAX) {
      plane.dropCd = randRange(DROP_CD_MIN, DROP_CD_MAX);
      if (this._autoStrike) this._dropMissile(plane, game);
    }
  };

  BattlefieldEvents.prototype._setPlaneFlash = function (plane, on) {
    if (!plane || !plane.mesh) return;
    plane.mesh.traverse(function (c) {
      if (!c.isMesh || !c.material || !c.material.color) return;
      if (on) {
        c.material.color.setHex(HIT_FLASH_RED);
      } else if (c.material.userData && c.material.userData.baseColor != null) {
        c.material.color.setHex(c.material.userData.baseColor);
      }
    });
  };

  /* ---------- Combat API ---------- */

  BattlefieldEvents.prototype.raycastPlanes = function (origin, dir, range, teamFilter) {
    let best = null;
    let bestDist = range != null ? range : 200;
    for (let i = 0; i < this._planes.length; i++) {
      const p = this._planes[i];
      if (!p.alive || !p.mesh) continue;
      if (teamFilter === true) {
        if (p.team !== 'enemy') continue;
      } else if (teamFilter && typeof teamFilter === 'string') {
        if (p.team !== teamFilter) continue;
      }
      _tmpCenter.copy(p.mesh.position);
      _tmpTo.copy(_tmpCenter).sub(origin);
      const proj = _tmpTo.dot(dir);
      if (proj < 0 || proj > bestDist) continue;
      _tmpClosest.copy(origin).addScaledVector(dir, proj);
      if (_tmpClosest.distanceTo(_tmpCenter) < PLANE_HIT_R) {
        bestDist = proj;
        best = {
          plane: p,
          point: _tmpClosest.clone(),
          dist: proj,
        };
      }
    }
    return best;
  };

  BattlefieldEvents.prototype.damagePlane = function (plane, dmg) {
    if (!plane || !plane.alive) return { killed: false, dmg: 0 };
    const dealt = Math.max(0, dmg | 0);
    plane.hp -= dealt;
    if (dealt > 0 && plane.hp > 0) {
      plane.hitFlash = 0.22;
      this._setPlaneFlash(plane, true);
    }
    if (plane.hp <= 0) {
      plane.hp = 0;
      this._killPlane(plane);
      return { killed: true, dmg: dealt };
    }
    return { killed: false, dmg: dealt };
  };

  BattlefieldEvents.prototype._killPlane = function (plane) {
    if (!plane || !plane.alive) return;
    plane.alive = false;
    const pos = plane.mesh ? plane.mesh.position.clone() : null;
    const quat = plane.mesh ? plane.mesh.quaternion.clone() : null;
    const scale = plane.mesh ? plane.mesh.scale.x : 1.8;
    if (plane.mesh) {
      if (plane.mesh.parent) this.scene.remove(plane.mesh);
      disposeObject(plane.mesh);
      plane.mesh = null;
    }
    if (pos) this._spawnPlaneKillFx(pos, plane.hostile, quat, scale);
  };

  BattlefieldEvents.prototype._spawnPlaneKillFx = function (pos, hostile, quat, planeScale) {
    const flashCol = hostile ? 0xff5522 : 0xffcc44;
    const fireCol = hostile ? 0xff7722 : 0xffd060;
    const sc = planeScale != null ? planeScale : 1.8;

    // Compact core + fireball (no dust)
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(2.2, 10, 10),
      new THREE.MeshBasicMaterial({
        color: 0xfff0c8,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    core.position.copy(pos);
    this.scene.add(core);
    this._fx.push({ kind: 'flash', mesh: core, life: 0.32, maxLife: 0.32, grow: 4 });

    const fire = new THREE.Mesh(
      new THREE.SphereGeometry(2.8, 10, 10),
      new THREE.MeshBasicMaterial({
        color: flashCol,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    fire.position.copy(pos);
    this.scene.add(fire);
    this._fx.push({ kind: 'flash', mesh: fire, life: 0.55, maxLife: 0.55, grow: 4.5 });

    for (let b = 0; b < 2; b++) {
      const burst = new THREE.Mesh(
        new THREE.SphereGeometry(1.2 + Math.random() * 0.6, 8, 8),
        new THREE.MeshBasicMaterial({
          color: b === 0 ? fireCol : flashCol,
          transparent: true,
          opacity: 0.8,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      );
      burst.position.set(
        pos.x + (Math.random() - 0.5) * 2.5,
        pos.y + (Math.random() - 0.2) * 2,
        pos.z + (Math.random() - 0.5) * 2.5
      );
      this.scene.add(burst);
      this._fx.push({ kind: 'flash', mesh: burst, life: 0.4, maxLife: 0.5, grow: 3.5 });
    }

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.0, 5.5, 32),
      new THREE.MeshBasicMaterial({
        color: flashCol,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, pos.y - 0.15, pos.z);
    this.scene.add(ring);
    this._fx.push({ kind: 'ring', mesh: ring, life: 0.65, maxLife: 0.65, growXZ: 3 });

    // Debris chunks only — no smoke / dust
    const colors = hostile
      ? [0xff5522, 0xff8844, 0xffaa33, 0x3a3d36, 0x2a2c28, 0xffee88]
      : [0xffd24a, 0xffc84a, 0xffee88, 0x3a3d36, 0x2a2c28, 0xffaa44];
    const n = 32 + ((Math.random() * 12) | 0);
    for (let i = 0; i < n; i++) {
      const big = Math.random() < 0.18;
      const size = (big ? 0.35 + Math.random() * 0.55 : 0.12 + Math.random() * 0.32) * sc * 0.55;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(size, size * (0.35 + Math.random()), size * (0.4 + Math.random())),
        new THREE.MeshBasicMaterial({
          color: colors[(Math.random() * colors.length) | 0],
          transparent: true,
          opacity: 1,
        })
      );
      mesh.position.copy(pos);
      mesh.position.x += (Math.random() - 0.5) * 1.4;
      mesh.position.y += (Math.random() - 0.5) * 1.0;
      mesh.position.z += (Math.random() - 0.5) * 1.4;
      if (quat) mesh.quaternion.copy(quat);
      mesh.rotation.x += Math.random() * Math.PI;
      mesh.rotation.y += Math.random() * Math.PI;
      const spd = 10 + Math.random() * (big ? 16 : 20);
      const ang = Math.random() * Math.PI * 2;
      const elev = 0.45 + Math.random() * 1.1;
      const vel = new THREE.Vector3(
        Math.cos(ang) * spd,
        elev * spd * 0.55,
        Math.sin(ang) * spd
      );
      this.scene.add(mesh);
      this._fx.push({
        kind: 'debris',
        mesh: mesh,
        life: 1.3 + Math.random() * 1.0,
        maxLife: 2.4,
        vel: vel,
        spin: (Math.random() - 0.5) * 18,
        gravity: 20 + Math.random() * 12,
      });
    }

    for (let i = 0; i < 10; i++) {
      const spark = new THREE.Mesh(
        new THREE.SphereGeometry(0.1 + Math.random() * 0.14, 6, 6),
        new THREE.MeshBasicMaterial({
          color: Math.random() < 0.5 ? 0xffee88 : fireCol,
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      );
      spark.position.copy(pos);
      const spd = 8 + Math.random() * 18;
      const ang = Math.random() * Math.PI * 2;
      const vel = new THREE.Vector3(
        Math.cos(ang) * spd,
        5 + Math.random() * 12,
        Math.sin(ang) * spd
      );
      this.scene.add(spark);
      this._fx.push({
        kind: 'debris',
        mesh: spark,
        life: 0.55 + Math.random() * 0.5,
        maxLife: 1.1,
        vel: vel,
        spin: 0,
        gravity: 14 + Math.random() * 8,
      });
    }

    const weapons = global.VF.game && global.VF.game.weapons;
    if (weapons && weapons._spawnImpact) {
      weapons._spawnImpact(pos.clone(), flashCol, 0.7);
    }

    if (global.VF.Audio) global.VF.Audio.play('explosion');
  };

  /* ---------- Missiles ---------- */

  BattlefieldEvents.prototype._buildMissileMesh = function (hostile) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color: hostile ? 0xff6622 : 0xffc84a,
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 1.8), mat);
    g.add(body);
    const tip = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.28, 0.45),
      new THREE.MeshBasicMaterial({ color: 0xffe8a0 })
    );
    tip.position.z = 1.05;
    g.add(tip);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 0.4), mat);
    fin.position.z = -0.6;
    g.add(fin);
    g.scale.setScalar(1.8);
    return g;
  };

  BattlefieldEvents.prototype._pickImpact = function (from, game, hostile) {
    const size = this._worldSize;
    let tx = from.x + (Math.random() - 0.5) * 55;
    let tz = from.z + (Math.random() - 0.5) * 55;
    tx = Math.max(12, Math.min(size - 12, tx));
    tz = Math.max(12, Math.min(size - 12, tz));

    // Friendly strikes avoid sitting on the player; enemy strikes may land nearer
    const safe = hostile ? 6 : PLAYER_SAFE_FRIENDLY;
    const player = game && game.player && game.player.object;
    if (player && !hostile) {
      const px = player.position.x;
      const pz = player.position.z;
      let dx = tx - px;
      let dz = tz - pz;
      let d = Math.hypot(dx, dz);
      if (d < safe) {
        if (d < 0.2) {
          dx = 1;
          dz = 0;
          d = 1;
        }
        const push = (safe - d) / d;
        tx += dx * push;
        tz += dz * push;
        tx = Math.max(12, Math.min(size - 12, tx));
        tz = Math.max(12, Math.min(size - 12, tz));
      }
    }

    let ty = 4;
    if (game && game.world && game.world.getGroundY) {
      ty = game.world.getGroundY(Math.floor(tx), Math.floor(tz)) + 0.4;
    }
    return new THREE.Vector3(tx, ty, tz);
  };

  BattlefieldEvents.prototype._dropMissile = function (plane, game) {
    const hostile = plane.hostile;
    const mesh = this._buildMissileMesh(hostile);
    const pos = plane.mesh.position.clone();
    pos.y -= 1.4;
    mesh.position.copy(pos);
    const aim = this._pickImpact(pos, game, hostile);
    const vel = aim.clone().sub(pos);
    vel.normalize();
    vel.y = Math.min(vel.y, -0.35);
    vel.normalize().multiplyScalar(32 + Math.random() * 14);

    mesh.lookAt(pos.clone().add(vel));
    this.scene.add(mesh);

    // Size from F10 airStrike.size / sizeVar
    const base = airNum('size', 1);
    const sizeVar = airNum('sizeVar', 0.35);
    const cloudScale = base * (0.85 + Math.random() * Math.max(0, sizeVar));

    this._missiles.push({
      mesh: mesh,
      hostile: hostile,
      team: plane.team,
      owner: plane,
      vel: vel,
      aim: aim,
      life: 0,
      maxLife: 7,
      trailCd: 0,
      gravity: 26 + Math.random() * 10,
      cloudScale: cloudScale,
    });
  };

  /* ---------- Killstreak reward strike (死斗) ---------- */

  /**
   * Summon one airstrike for `team`: a single transient plane flies in over the
   * opposing side, walks a bomb salvo across it, and leaves. TdmMatch calls this
   * when a participant reaches a killstreak tier. Self-contained — it spawns its
   * own aircraft, so it works even though the ambient fleet is grounded in 死斗.
   */
  BattlefieldEvents.prototype.callStrike = function (team, game, opts) {
    if (!this._active || !this.scene) return false;
    team = team === 'enemy' ? 'enemy' : 'ally';
    const foe = team === 'ally' ? 'enemy' : 'ally';
    const target = this._strikeTarget(foe, game);
    if (!target) return false;
    opts = opts || {};
    const count = Math.max(1, opts.count != null ? opts.count : 2);
    this._planes.push(this._makeStrikePlane(team, target, count));
    return true;
  };

  /** One-shot bomber: flies a straight run through the target then despawns. */
  BattlefieldEvents.prototype._makeStrikePlane = function (team, target, count) {
    const hostile = team === 'enemy';
    const alt = randRange(PLANE_ALT_MIN + 10, PLANE_ALT_MAX);
    const ang = Math.random() * Math.PI * 2;
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    const start = new THREE.Vector3(target.x - dx * 72, alt, target.z - dz * 72);
    const end = new THREE.Vector3(target.x + dx * 130, alt + randRange(-4, 4), target.z + dz * 130);
    const speed = randRange(24, 30);
    const pathLen = start.distanceTo(end);
    const mesh = this._buildPlaneMesh(hostile);
    mesh.position.copy(start);
    mesh.lookAt(end);
    this.scene.add(mesh);
    const plane = {
      mesh: mesh,
      hostile: hostile,
      team: team,
      hp: PLANE_HP,
      maxHp: PLANE_HP,
      alive: true,
      start: start,
      end: end,
      t: 0,
      dur: pathLen / speed,
      dropCd: 1e9,
      oneShot: true,
      strike: { target: target, left: count, cd: 0, spacing: 0.75 },
    };
    mesh.userData.plane = plane;
    return plane;
  };

  /** Walk the salvo across the target as the bomber passes overhead. */
  BattlefieldEvents.prototype._runStrike = function (plane, dt, game) {
    const s = plane.strike;
    if (!s || s.left <= 0 || !plane.mesh) return;
    const p = plane.mesh.position;
    if (Math.hypot(p.x - s.target.x, p.z - s.target.z) > 50) return;
    s.cd -= dt;
    if (s.cd > 0) return;
    s.cd = s.spacing;
    s.left -= 1;
    const ix = s.target.x + (Math.random() - 0.5) * 30;
    const iz = s.target.z + (Math.random() - 0.5) * 30;
    let iy = s.target.y != null ? s.target.y : 4;
    if (game && game.world && game.world.getGroundY) {
      iy = game.world.getGroundY(Math.floor(ix), Math.floor(iz)) + 0.35;
    }
    const belly = p.clone();
    belly.y -= 1.2;
    this._spawnStrikeMissile(belly, new THREE.Vector3(ix, iy, iz), plane.team);
  };

  /** Quiet removal for a bomber that finished its run (no death fireball). */
  BattlefieldEvents.prototype._despawnPlane = function (plane) {
    plane.alive = false;
    if (plane.mesh) {
      if (plane.mesh.parent) this.scene.remove(plane.mesh);
      disposeObject(plane.mesh);
      plane.mesh = null;
    }
  };

  /** Focal point for a reward strike: a live enemy, else their base/center. */
  BattlefieldEvents.prototype._strikeTarget = function (foe, game) {
    const ai = game && (game.ai || global.VF.AI);
    const pts = [];
    function scan(list) {
      if (!list) return;
      for (let i = 0; i < list.length; i++) {
        const u = list[i];
        if (!u || !u.alive || !u.mesh || u.team !== foe) continue;
        pts.push(u.mesh.position);
      }
    }
    if (ai) {
      scan(ai.enemies);
      scan(ai.allies);
    }
    if (pts.length) {
      const p = pts[(Math.random() * pts.length) | 0];
      return new THREE.Vector3(p.x, p.y, p.z);
    }
    const world = game && game.world;
    const base = foe === 'enemy' ? world && world._enemyBasePos : world && world._allyBasePos;
    if (base) return new THREE.Vector3(base.x, base.y, base.z);
    if (world && world._tdmArenaCenter) {
      const c = world._tdmArenaCenter;
      return new THREE.Vector3(c.x, 4, c.z);
    }
    return null;
  };

  /** Reward-strike ordnance: like _dropMissile but with an explicit path. */
  BattlefieldEvents.prototype._spawnStrikeMissile = function (start, aim, team) {
    const hostile = team === 'enemy';
    const mesh = this._buildMissileMesh(hostile);
    mesh.position.copy(start);
    const vel = aim.clone().sub(start).normalize();
    vel.y = Math.min(vel.y, -0.5);
    vel.normalize().multiplyScalar(34 + Math.random() * 12);
    mesh.lookAt(start.clone().add(vel));
    this.scene.add(mesh);

    const base = airNum('size', 1);
    const sizeVar = airNum('sizeVar', 0.35);
    const cloudScale = base * (0.95 + Math.random() * Math.max(0, sizeVar));

    this._missiles.push({
      mesh: mesh,
      hostile: hostile,
      team: team,
      owner: null,
      vel: vel,
      aim: aim.clone(),
      life: 0,
      maxLife: 7,
      trailCd: 0,
      gravity: 22 + Math.random() * 10,
      cloudScale: cloudScale,
    });
  };

  BattlefieldEvents.prototype._updateMissile = function (m, dt, game) {
    m.life += dt;
    m.vel.y -= m.gravity * dt;
    m.mesh.position.addScaledVector(m.vel, dt);
    m.mesh.lookAt(m.mesh.position.clone().add(m.vel));

    m.trailCd -= dt;
    if (m.trailCd <= 0) {
      m.trailCd = 0.035;
      this._spawnTrail(m.mesh.position, m.hostile);
    }

    // Air-to-air proximity vs opposing planes
    for (let i = 0; i < this._planes.length; i++) {
      const p = this._planes[i];
      if (!p.alive || !p.mesh || p.team === m.team) continue;
      if (p === m.owner) continue;
      if (m.mesh.position.distanceTo(p.mesh.position) < MISSILE_AIR_HIT) {
        this._detonateMissile(m, m.mesh.position.clone(), game, p);
        return true;
      }
    }

    const hitGround = m.mesh.position.y <= m.aim.y + 0.5;
    const nearAim = m.mesh.position.distanceTo(m.aim) < 2.5;
    const timeout = m.life > m.maxLife;

    if (hitGround || nearAim || timeout) {
      const impact = m.mesh.position.clone();
      if (game && game.world && game.world.getGroundY) {
        impact.y = game.world.getGroundY(Math.floor(impact.x), Math.floor(impact.z)) + 0.3;
      } else {
        impact.y = m.aim.y;
      }
      this._detonateMissile(m, impact, game, null);
      return true;
    }
    return false;
  };

  BattlefieldEvents.prototype._detonateMissile = function (m, pos, game, directPlane) {
    const scale = m.cloudScale != null ? m.cloudScale : airNum('size', 1);
    this._spawnMushroom(pos, m.hostile, game, scale);
    if (airNum('dust', 1) > 0.01) this._spawnDustCloud(pos, scale);
    this._carveLightTerrain(pos, scale, game);
    if (game && game.world && game.world.deformTerrainCircle) {
      const R = airNum('carveR', 4.5) * 0.45 * Math.max(0.8, scale);
      const changed = game.world.deformTerrainCircle(pos.x, pos.z, Math.max(2.2, R), 0.45, {
        source: 'airstrike',
        maxDepth: 0.6,
      });
      if (changed && game.weapons && game.weapons._syncTerrainDeform) {
        game.weapons._syncTerrainDeform(pos.x, pos.z, Math.max(2.2, R), 0.45);
      }
    }
    this._applyBlastDamage(pos, m.team, m.hostile, scale, game, directPlane);
  };

  BattlefieldEvents.prototype._spawnDustCloud = function (pos, scale) {
    const dustAmt = airNum('dust', 1);
    if (dustAmt <= 0.01) return;
    const dustSize = airNum('dustSize', 1);
    const s = Math.max(0.5, scale) * Math.max(0.3, dustSize);
    const dustCols = [0xc4a070, 0xb09060, 0xa88850, 0x8a7048];
    const groundN = Math.max(1, Math.round(5 * dustAmt));
    const plumeN = Math.max(0, Math.round(3 * dustAmt));

    for (let i = 0; i < groundN; i++) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry((1.4 + Math.random() * 1.8) * s, 8, 8),
        new THREE.MeshBasicMaterial({
          color: dustCols[(Math.random() * dustCols.length) | 0],
          transparent: true,
          opacity: 0.48,
          depthWrite: false,
        })
      );
      mesh.scale.set(1.15, 0.32, 1.15);
      mesh.position.set(
        pos.x + (Math.random() - 0.5) * 5 * s,
        pos.y + 0.35 + Math.random() * s,
        pos.z + (Math.random() - 0.5) * 5 * s
      );
      this.scene.add(mesh);
      this._fx.push({
        kind: 'dust',
        mesh: mesh,
        life: 1.4 + Math.random() * 1.1,
        maxLife: 2.5,
        rise: 1.0 + Math.random() * 2.0,
        expandXZ: 2.0 + Math.random() * 1.4,
        driftX: (Math.random() - 0.5) * 3.5,
        driftZ: (Math.random() - 0.5) * 3.5,
        baseOpacity: 0.48,
      });
    }

    for (let i = 0; i < plumeN; i++) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry((1.1 + Math.random() * 1.4) * s, 8, 8),
        new THREE.MeshBasicMaterial({
          color: dustCols[(Math.random() * dustCols.length) | 0],
          transparent: true,
          opacity: 0.4,
          depthWrite: false,
        })
      );
      mesh.position.set(
        pos.x + (Math.random() - 0.5) * 2.2 * s,
        pos.y + (0.8 + i * 0.7) * s,
        pos.z + (Math.random() - 0.5) * 2.2 * s
      );
      this.scene.add(mesh);
      this._fx.push({
        kind: 'dust',
        mesh: mesh,
        life: 1.6 + Math.random(),
        maxLife: 2.6,
        rise: 3.0 + Math.random() * 2.5,
        expandXZ: 1.4,
        driftX: (Math.random() - 0.5) * 1.8,
        driftZ: (Math.random() - 0.5) * 1.8,
        baseOpacity: 0.4,
      });
    }
  };

  /** Light terrain / building chips */
  BattlefieldEvents.prototype._carveLightTerrain = function (pos, scale, game) {
    const world = game && game.world;
    if (!world || !world.breakBlock) return;
    const weapons = game.weapons;
    const breakMax = Math.max(0, Math.round(airNum('breakMax', 6)));
    if (breakMax <= 0) return;
    const R = airNum('carveR', 4.5) * 0.45 * Math.max(0.8, scale);
    const r2 = R * R;
    const cx = Math.floor(pos.x);
    const cy = Math.floor(pos.y);
    const cz = Math.floor(pos.z);
    const span = Math.ceil(R);
    let broken = 0;
    const candidates = [];
    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -1; dy <= Math.min(4, span); dy++) {
        for (let dz = -span; dz <= span; dz++) {
          const ddx = dx + 0.5;
          const ddy = dy + 0.5;
          const ddz = dz + 0.5;
          const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d2 > r2) continue;
          candidates.push({ x: cx + dx, y: cy + dy, z: cz + dz, d2: d2 });
        }
      }
    }
    candidates.sort(function (a, b) {
      return a.d2 - b.d2;
    });
    for (let i = 0; i < candidates.length && broken < breakMax; i++) {
      if (i > 3 && Math.random() > 0.35) continue;
      const c = candidates[i];
      if (world.breakBlock(c.x, c.y, c.z)) {
        broken++;
        if (weapons && weapons._syncWorldBreak) {
          weapons._syncWorldBreak('break-voxel', c.x, c.y, c.z);
        }
      }
    }
  };

  BattlefieldEvents.prototype._applyBlastDamage = function (pos, team, hostile, scale, game, directPlane) {
    const radius = airNum('damageR', 6.2) * scale;

    if (directPlane && directPlane.alive) {
      this.damagePlane(directPlane, 45 + Math.round(18 * scale));
    }

    for (let i = 0; i < this._planes.length; i++) {
      const p = this._planes[i];
      if (!p.alive || !p.mesh || p.team === team) continue;
      if (p === directPlane) continue;
      const d = p.mesh.position.distanceTo(pos);
      if (d > radius * 1.15) continue;
      const falloff = 1 - d / (radius * 1.15);
      this.damagePlane(p, Math.round((28 + 22 * scale) * falloff));
    }

    const playerTeam =
      (game && game.player && game.player.team) ||
      (game && game.world && game.world._playerTeam) ||
      'ally';

    if (game && game.player && game.player.takeDamage && !game.player.dead && playerTeam !== team) {
      const pp = game.player.object.position;
      const dx = pp.x - pos.x;
      const dy = pp.y + 1 - pos.y;
      const dz = pp.z - pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < radius) {
        const falloff = 1 - dist / radius;
        const dmg = Math.round((12 + 16 * scale) * (0.4 + 0.6 * falloff));
        game.player.takeDamage(dmg, pos, airstrikeActor(team));
      }
    }

    const ai = game && (game.ai || global.VF.AI);
    if (!ai) return;

    const attacker = airstrikeActor(team);
    function hurtList(list) {
      if (!list || !ai._damageUnit) return;
      for (let i = 0; i < list.length; i++) {
        const u = list[i];
        if (!u || !u.alive || !u.mesh) continue;
        if (u.team === team) continue;
        const ep = u.mesh.position;
        const dx = ep.x - pos.x;
        const dy = ep.y + 1 - pos.y;
        const dz = ep.z - pos.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > radius) continue;
        const falloff = 1 - dist / radius;
        const dmg = Math.round((32 + 22 * scale) * falloff);
        // fromPlayer=false: this is ambient AI-plane ordnance, not a
        // player action — must not trigger player kill rewards/feedback.
        ai._damageUnit(u, dmg, null, false, attacker);
      }
    }

    hurtList(ai.enemies);
    hurtList(ai.allies);
  };

  BattlefieldEvents.prototype._spawnTrail = function (pos, hostile) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 6, 6),
      new THREE.MeshBasicMaterial({
        color: hostile ? 0xff7722 : 0xffd060,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this._fx.push({
      kind: 'trail',
      mesh: mesh,
      life: 0.4,
      maxLife: 0.4,
      grow: 2.2,
      rise: 0.4,
    });
  };

  /* ---------- Mushroom cloud ---------- */

  BattlefieldEvents.prototype._spawnMushroom = function (pos, hostile, game, scaleIn) {
    // Gold (friendly) vs orange/red (hostile) — sizes from F10 airStrike
    const stemColor = hostile ? 0xff6622 : 0xe8b020;
    const capColor = hostile ? 0xff9944 : 0xffd24a;
    const flashColor = hostile ? 0xffcc66 : 0xffe8a0;
    const smokeColor = hostile ? 0xaa5530 : 0xb89040;
    const life = Math.max(0.6, airNum('life', 2.8) * (0.85 + Math.random() * 0.3));
    const scale = scaleIn != null ? scaleIn : airNum('size', 1);
    const stemHBase = airNum('stemH', 7);
    const capR = airNum('capR', 1.6);
    const ringR = airNum('ringR', 3.2);
    const smokeAmt = airNum('smoke', 1);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.2 * ringR * scale, ringR * scale, 28),
      new THREE.MeshBasicMaterial({
        color: flashColor,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, pos.y + 0.1, pos.z);
    this.scene.add(ring);
    this._fx.push({
      kind: 'ring',
      mesh: ring,
      life: Math.min(1.2, life * 0.25),
      maxLife: Math.min(1.2, life * 0.25),
      growXZ: 1.8,
    });

    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.5 * capR * scale, 8, 8),
      new THREE.MeshBasicMaterial({
        color: flashColor,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    flash.position.copy(pos);
    flash.position.y += 0.35 * scale;
    this.scene.add(flash);
    this._fx.push({
      kind: 'flash',
      mesh: flash,
      life: 0.35,
      maxLife: 0.35,
      grow: 2.2,
    });

    const stemH = stemHBase * scale;
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45 * scale, 0.95 * scale, stemH, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: stemColor,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
    );
    stem.position.set(pos.x, pos.y + stemH * 0.2, pos.z);
    stem.scale.set(0.35, 0.2, 0.35);
    this.scene.add(stem);
    this._fx.push({
      kind: 'stem',
      mesh: stem,
      life: life,
      maxLife: life,
      targetY: pos.y + stemH * 0.5,
      baseY: pos.y + stemH * 0.2,
    });

    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(capR * scale, 12, 8),
      new THREE.MeshBasicMaterial({
        color: capColor,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    cap.scale.set(0.4, 0.22, 0.4);
    cap.position.set(pos.x, pos.y + 1.1 * scale, pos.z);
    this.scene.add(cap);
    this._fx.push({
      kind: 'cap',
      mesh: cap,
      life: life,
      maxLife: life,
      rise: Math.max(2, stemHBase * 0.55) * scale,
      expand: 0.85,
      startY: pos.y + 1.1 * scale,
    });

    if (smokeAmt > 0.01) {
      const disk = new THREE.Mesh(
        new THREE.SphereGeometry(capR * 1.35 * scale * Math.min(1.4, 0.7 + smokeAmt * 0.3), 12, 8),
        new THREE.MeshBasicMaterial({
          color: smokeColor,
          transparent: true,
          opacity: 0.32 * Math.min(1.2, smokeAmt),
          depthWrite: false,
        })
      );
      disk.scale.set(0.5, 0.18, 0.5);
      disk.position.set(pos.x, pos.y + 1.6 * scale, pos.z);
      this.scene.add(disk);
      this._fx.push({
        kind: 'cap',
        mesh: disk,
        life: life * 1.05,
        maxLife: life * 1.05,
        rise: Math.max(1.5, stemHBase * 0.35) * scale,
        expand: 1.2,
        startY: pos.y + 1.6 * scale,
        baseOpacity: 0.32 * Math.min(1.2, smokeAmt),
      });

      const puffN = Math.max(0, Math.round(4 * smokeAmt));
      for (let i = 0; i < puffN; i++) {
        const puff = new THREE.Mesh(
          new THREE.SphereGeometry((0.7 + Math.random() * 0.9) * scale, 8, 8),
          new THREE.MeshBasicMaterial({
            color: smokeColor,
            transparent: true,
            opacity: 0.38,
            depthWrite: false,
          })
        );
        puff.position.set(
          pos.x + (Math.random() - 0.5) * 3 * scale,
          pos.y + (0.8 + Math.random() * 2.2) * scale,
          pos.z + (Math.random() - 0.5) * 3 * scale
        );
        this.scene.add(puff);
        this._fx.push({
          kind: 'puff',
          mesh: puff,
          life: life * (0.65 + Math.random() * 0.35),
          maxLife: life,
          rise: (3 + Math.random() * 4) * scale,
          grow: 1.5 + Math.random(),
          driftX: (Math.random() - 0.5) * 2.5,
          driftZ: (Math.random() - 0.5) * 2.5,
          baseOpacity: 0.38,
        });
      }
    }

    const now = performance.now();
    if (global.VF.Audio && Math.random() < 0.55) {
      global.VF.Audio.play(Math.random() < 0.5 ? 'explosion' : 'distant_rumble');
    }
    if (now - this._toastAt > TOAST_CD * 1000) {
      this._toastAt = now;
      if (global.VF.UI && global.VF.UI.toast) {
        global.VF.UI.toast(hostile ? '敌方空袭' : '友军空袭');
      }
    }

    if (game && game.player && game.player.addShake && game.player.object) {
      const d = game.player.object.position.distanceTo(pos);
      const shake = airNum('shake', 0.05);
      const reach = airNum('shakeReach', 42) + 18 * scale;
      if (shake > 0 && d < reach) {
        game.player.addShake(shake * (1 - d / reach) * Math.min(1.2, scale + 0.15));
      }
    }
  };

  BattlefieldEvents.prototype._updateFx = function (dt) {
    for (let i = this._fx.length - 1; i >= 0; i--) {
      const fx = this._fx[i];
      fx.life -= dt;
      const t = 1 - fx.life / Math.max(0.001, fx.maxLife);
      const mesh = fx.mesh;
      if (mesh) {
        if (fx.kind === 'stem') {
          const sy = 0.2 + t * 1.1;
          const sx = 0.35 + t * 0.65;
          mesh.scale.set(sx, sy, sx);
          mesh.position.y = fx.baseY + (fx.targetY - fx.baseY) * Math.min(1, t * 1.2);
        } else if (fx.kind === 'cap') {
          const e = 0.4 + t * (1.2 + (fx.expand || 1));
          mesh.scale.set(e, 0.22 + t * 0.35, e);
          mesh.position.y = fx.startY + t * (fx.rise || 6);
        } else if (fx.kind === 'puff') {
          mesh.position.y += (fx.rise || 4) * dt * 0.35;
          mesh.position.x += (fx.driftX || 0) * dt * 0.25;
          mesh.position.z += (fx.driftZ || 0) * dt * 0.25;
          const g = 1 + t * (fx.grow || 1.5);
          mesh.scale.setScalar(g);
        } else if (fx.kind === 'ring') {
          const s = 1 + t * (fx.growXZ || 2);
          mesh.scale.set(s, 1, s);
        } else if (fx.kind === 'dust') {
          mesh.position.y += (fx.rise || 2) * dt * 0.4;
          mesh.position.x += (fx.driftX || 0) * dt * 0.3;
          mesh.position.z += (fx.driftZ || 0) * dt * 0.3;
          const base = 1 + t * (fx.expandXZ || 2) * 0.5;
          mesh.scale.x = base * (1.2 + t);
          mesh.scale.z = base * (1.2 + t);
          mesh.scale.y = 0.4 + t * 0.7;
        } else if (fx.kind === 'debris') {
          if (fx.vel) {
            fx.vel.y -= (fx.gravity != null ? fx.gravity : 20) * dt;
            mesh.position.addScaledVector(fx.vel, dt);
          }
          if (fx.spin) {
            mesh.rotation.x += fx.spin * dt;
            mesh.rotation.z += fx.spin * 0.7 * dt;
          }
        } else if (fx.grow != null) {
          mesh.scale.setScalar(1 + t * fx.grow);
          if (fx.rise) mesh.position.y += fx.rise * dt;
        }

        if (mesh.material) {
          if (fx.baseOpacity == null) fx.baseOpacity = mesh.material.opacity;
          const fade = Math.max(0, fx.life / fx.maxLife);
          const soft =
            fx.kind === 'stem' || fx.kind === 'cap' || fx.kind === 'puff' || fx.kind === 'dust'
              ? Math.pow(fade, 0.7)
              : fade;
          mesh.material.opacity = soft * fx.baseOpacity;
        }
      }
      if (fx.life <= 0) {
        if (mesh) {
          if (mesh.parent) this.scene.remove(mesh);
          disposeObject(mesh);
        }
        this._fx.splice(i, 1);
      }
    }
  };

  global.VF = global.VF || {};
  global.VF.BattlefieldEvents = BattlefieldEvents;
  global.VF.createBattlefieldEvents = function (scene) {
    const ev = new BattlefieldEvents(scene);
    global.VF.Battlefield = ev;
    return ev;
  };
})(typeof window !== 'undefined' ? window : globalThis);
