/**
 * throwables.js — voxel-frontline-battle 投掷物模块
 * （frag / semtex / molotov / flash / stun / smoke）
 *
 * 槽位 5；按住 G 蓄力投出。物理层复用先锋 C4 的思路：出手点在镜头前、
 * 分段射线碰体素、粘附时贴在墙外。C4 本身仍是配件/技能（碰到就粘），
 * 不走本模块。
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});

  const KEY = 'KeyG';
  const POOL = ['frag', 'flash', 'smoke'];
  /** 仅调试：不限量，且允许局内滚轮/点选换雷。正式局按部署装备锁定种类。 */
  const DEBUG_UNLIMITED = false;

  const PHYS = {
    baseForce: 20.5, // 蓄满仰约 30° ≈ 28 m
    minCharge: 0.69, // 轻点平视 ≈ 9 m
    maxChargeTime: 1.0,
    gravity: 16, // 对齐先锋 C4 的体素重力，文档 9.8 在本项目会飘
    airDrag: 0.02,
    pitchOffset: (8 * Math.PI) / 180,
    originDist: 0.95,
    handRight: 0.16,
    handDown: 0.2,
    surfaceGap: 0.12,
    restSpeed: 0.5,
    restitution: 0.5,
    simDt: 1 / 40,
    maxFlight: 6,
    previewSteps: 48,
  };

  const ANIM = {
    draw: 0.22,
    throw: 0.4,
    releaseAt: 0.15,
    recover: 0.2,
  };

  const NAMES = {
    frag: '破片手雷',
    semtex: '黏性炸弹',
    molotov: '燃烧瓶',
    flash: '闪光弹',
    stun: '震撼弹',
    smoke: '烟雾弹',
  };

  const DEFS = {
    frag: {
      id: 'frag',
      collide: 'bounce',
      fuseFrom: 'throw',
      fuseTime: 3.0,
      restitution: 0.5,
      maxDamage: 130,
      minEdgeDamage: 20,
      innerRadius: 2.5,
      outerRadius: 6.0,
      coreDamage: 60,
      coreMaxRange: 6.0,
      breakChance: 0.6,
      color: 0x4a5a3a,
    },
    semtex: {
      id: 'semtex',
      collide: 'stick',
      fuseFrom: 'stick',
      fuseTime: 2.0,
      maxDamage: 130,
      minEdgeDamage: 20,
      innerRadius: 2.2,
      outerRadius: 5.5,
      coreDamage: 70,
      coreMaxRange: 5.5,
      breakChance: 0.6,
      color: 0xc04028,
    },
    molotov: {
      id: 'molotov',
      collide: 'shatter',
      fuseFrom: 'impact',
      fuseTime: 0,
      tickDamage: 25,
      tickInterval: 0.5,
      fireRadius: 3.0,
      areaDuration: 7.0,
      coreDamage: 10,
      coreMaxRange: 3.0,
      breakChance: 0.3,
      color: 0xcc6622,
      baseForce: 17.9, // 蓄满仰约 30° ≈ 22 m
      minCharge: 0.63, // 轻点平视 ≈ 7 m
    },
    flash: {
      id: 'flash',
      collide: 'bounce',
      fuseFrom: 'throw',
      fuseTime: 1.5,
      restitution: 0.5,
      effectRadius: 8.0,
      maxBlind: 3.0,
      color: 0xe8e0c8,
    },
    stun: {
      id: 'stun',
      collide: 'bounce',
      fuseFrom: 'throw',
      fuseTime: 1.5,
      restitution: 0.5,
      effectRadius: 6.0,
      maxStun: 7.0,
      moveSlowMul: 0.4,
      turnSlowMul: 0.28,
      color: 0x88aacc,
    },
    smoke: {
      id: 'smoke',
      collide: 'bounce',
      fuseFrom: 'land',
      fuseTime: 1.0,
      restitution: 0.35,
      effectRadius: 5.0,
      areaDuration: 12.0,
      expandTime: 1.5,
      fadeTime: 2.0,
      color: 0x889090,
    },
  };

  const state = {
    active: false,
    equipped: null,
    ammo: 0,
    holding: false,
    holdTime: 0,
    pose: 'idle',
    poseT: 0,
    wantThrow: false,
    thrown: false,
    live: [],
    zones: [],
    flashT: 0,
    flashMax: 0,
    stunT: 0,
    stunMax: 0,
    stunMove: 1,
    stunTurn: 1,
    preview: null,
    hud: null,
    slots: null,
    flashEl: null,
    stunEl: null,
    smokeEl: null,
    bound: false,
    _pts: [],
  };

  function defOf(id) {
    return DEFS[id] || DEFS.frag;
  }

  function playSound(id, position, options) {
    if (!VF.Audio || !VF.Audio.play) return;
    const opts = Object.assign({}, options || {});
    if (position) opts.position = position;
    VF.Audio.play(id, opts);
  }

  function modeAllows() {
    const GM = VF.GameModes;
    if (!GM) return true;
    if (GM.isGg && GM.isGg()) return false;
    return true;
  }

  function combatLive() {
    if (!state.active) return false;
    if (!VF.game || !VF.game.running) return false;
    if (VF.Range && VF.Range.isOpen) return false;
    return true;
  }

  function canHold() {
    const g = VF.game;
    const p = g && g.player;
    if (!p || !p.locked || p.dead) return false;
    if (VF.UI && VF.UI.isMenuOpen && VF.UI.isMenuOpen()) return false;
    if (VF.Range && VF.Range.isOpen) return false;
    if (g.levelEditing) return false;
    if (g.building && g.building.active) return false;
    if (p.downed) return false;
    if (
      p.vehicleId &&
      !(VF.Vehicles && VF.Vehicles.canUsePersonalWeapon && VF.Vehicles.canUsePersonalWeapon(p))
    ) {
      return false;
    }
    if (!combatLive()) return false;
    return true;
  }

  function loadoutGrenadeId() {
    if (VF.Gadgets && VF.Gadgets.ensureLoadout) {
      const gid = VF.Gadgets.ensureLoadout().grenade;
      if (gid && DEFS[gid] && POOL.indexOf(gid) >= 0) return gid;
    }
    return POOL[0];
  }

  function canCycle() {
    if (!DEBUG_UNLIMITED) return false;
    if (!state.active) return false;
    const g = VF.game;
    if (!g || !g.running) return false;
    if (VF.UI && VF.UI.isMenuOpen && VF.UI.isMenuOpen()) return false;
    if (VF.Range && VF.Range.isOpen) return false;
    if (g.levelEditing) return false;
    if (g.building && g.building.active) return false;
    if (!((VF.Gadgets && VF.Gadgets.hand === 'grenade') || state.holding || state.pose !== 'idle')) {
      return false;
    }
    return combatLive();
  }

  function terrainTopAt(world, x, z) {
    if (!world || !world.getTerrainTop) return null;
    return world.getTerrainTop(x, z);
  }

  function isTerrainSolid(world, x, y, z) {
    const top = terrainTopAt(world, x, z);
    return top != null && y < top;
  }

  function isVoxelSolid(world, x, y, z) {
    if (!world) return false;
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);
    if (world._isStructureSolid) return world._isStructureSolid(bx, by, bz);
    if (world._isSolid) return world._isSolid(bx, by, bz);
    const t = world.get && world.get(bx, by, bz);
    return !!(t && t !== 0 && t !== (VF.BLOCK && VF.BLOCK.AIR) && t !== (VF.BLOCK && VF.BLOCK.WATER));
  }

  function isSolid(world, x, y, z) {
    return isTerrainSolid(world, x, y, z) || isVoxelSolid(world, x, y, z);
  }

  function isWater(world, x, y, z) {
    if (!world || !world.get || !VF.BLOCK) return false;
    return world.get(Math.floor(x), Math.floor(y), Math.floor(z)) === VF.BLOCK.WATER;
  }

  /** Pioneer C4 stick: sit just outside the hit face. */
  function resolveStick(world, prevX, prevY, prevZ, hitX, hitY, hitZ) {
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
    for (let i = 0; i < 4 && isVoxelSolid(world, x, y, z); i++) {
      x += nx * 0.12;
      y += ny * 0.12;
      z += nz * 0.12;
    }
    return { x: x, y: y, z: z, nx: nx, ny: ny, nz: nz };
  }

  /** Sit on the heightfield floor, or just outside a 1m structure face. */
  function resolveHit(world, prevX, prevY, prevZ, hitX, hitY, hitZ) {
    const gap = PHYS.surfaceGap;
    const top = terrainTopAt(world, hitX, hitZ);
    const terrainHit = top != null && hitY < top;
    const voxelHit = isVoxelSolid(world, hitX, hitY, hitZ);
    if (terrainHit && !voxelHit) {
      return { x: hitX, y: top + gap, z: hitZ, nx: 0, ny: 1, nz: 0 };
    }
    if (terrainHit && prevY >= top) {
      return { x: hitX, y: top + gap, z: hitZ, nx: 0, ny: 1, nz: 0 };
    }
    const st = resolveStick(world, prevX, prevY, prevZ, hitX, hitY, hitZ);
    const t2 = terrainTopAt(world, st.x, st.z);
    if (t2 != null && st.y < t2 + gap) {
      st.y = t2 + gap;
      if (!voxelHit || prevY >= t2) {
        st.nx = 0;
        st.ny = 1;
        st.nz = 0;
      }
    }
    return st;
  }

  function freeLaunchOrigin(world, origin, aimed, eye) {
    if (!world || !origin) return origin;
    const gap = 0.22;
    let x = origin.x;
    let y = origin.y;
    let z = origin.z;
    const buried = isTerrainSolid(world, x, y, z) || isVoxelSolid(world, x, y, z);
    if (buried && eye) {
      const hx = aimed ? aimed.x : 0;
      const hz = aimed ? aimed.z : 0;
      x = eye.x + hx * 0.35;
      z = eye.z + hz * 0.35;
      y = eye.y - 0.05;
    }
    const top = terrainTopAt(world, x, z);
    if (top != null && y < top + gap) y = top + gap;
    if (!isVoxelSolid(world, x, y, z)) {
      origin.x = x;
      origin.y = y;
      origin.z = z;
      return origin;
    }
    for (let i = 0; i < 10 && isVoxelSolid(world, x, y, z); i++) y += 0.18;
    if (!isVoxelSolid(world, x, y, z)) {
      const t = terrainTopAt(world, x, z);
      if (t != null && y < t + gap) y = t + gap;
      origin.x = x;
      origin.y = y;
      origin.z = z;
      return origin;
    }
    const len = Math.hypot(aimed.x, aimed.z) || 1;
    const dx = aimed.x / len;
    const dz = aimed.z / len;
    for (let i = 1; i <= 14; i++) {
      const px = x + dx * 0.16 * i;
      const pz = z + dz * 0.16 * i;
      let py = y;
      const t = terrainTopAt(world, px, pz);
      if (t != null && py < t + gap) py = t + gap;
      if (!isSolid(world, px, py, pz)) {
        origin.x = px;
        origin.y = py;
        origin.z = pz;
        return origin;
      }
    }
    origin.x = x;
    origin.y = y;
    origin.z = z;
    return origin;
  }

  function voxelLos(world, ax, ay, az, bx, by, bz) {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 0.4) return true;
    const skip = Math.min(0.45, dist * 0.15);
    const steps = Math.min(28, Math.max(3, Math.ceil(dist * 1.4)));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (t * dist < skip) continue;
      if (isSolid(world, ax + dx * t, ay + dy * t, az + dz * t)) return false;
    }
    return true;
  }

  /** First walkable top-face at or below (x,y,z). */
  function groundY(world, x, y, z) {
    if (world && world.getWalkHeight) {
      const top = world.getWalkHeight(x, z);
      if (top != null && isFinite(top)) return top + 0.04;
    }
    let gy = y + 0.15;
    for (let i = 0; i < 48; i++) {
      if (!isSolid(world, x, gy, z) && isSolid(world, x, gy - 0.25, z)) {
        return Math.floor(gy - 0.25) + 1.04;
      }
      gy -= 0.25;
    }
    return y;
  }

  function fxMat(color, opacity, additive) {
    const o = {
      color: color,
      transparent: true,
      opacity: opacity,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    };
    if (additive) o.blending = THREE.AdditiveBlending;
    return new THREE.MeshBasicMaterial(o);
  }

  function smokeDensity(z) {
    if (!z || z.kind !== 'smoke') return 0;
    if (z.phase === 'stable') return 1;
    if (z.phase === 'expand') {
      const e = z.expand || 1.5;
      return 0.35 + 0.65 * Math.min(1, (z.age || 0) / Math.max(0.001, e));
    }
    if (z.phase === 'fade') {
      const f = z.fade || 2;
      return Math.max(0, (z.fadeLeft != null ? z.fadeLeft : 0) / f);
    }
    return 0.5;
  }

  /** Overlapping puffs that fill a cylinder of radius maxR (the ground ring). */
  function fillSmokeCloud(world, ox, oy, oz, maxR) {
    const slots = [];
    const push = function (x, y, z) {
      if (isSolid(world, x, y, z)) return;
      if (!voxelLos(world, ox, oy, oz, x, y, z)) return;
      const dx = x - ox;
      const dz = z - oz;
      slots.push({
        x: x,
        y: y,
        z: z,
        d: Math.sqrt(dx * dx + dz * dz),
      });
    };
    const rings = [
      { y: 0.15, rs: [0, 1.55, 3.05, 4.45] },
      { y: 1.15, rs: [0.9, 2.45, 4.15] },
      { y: 2.15, rs: [0.5, 2.05, 3.55] },
    ];
    for (let li = 0; li < rings.length; li++) {
      const layer = rings[li];
      for (let ri = 0; ri < layer.rs.length; ri++) {
        const rad = layer.rs[ri];
        if (rad > maxR - 0.15) continue;
        const n = rad < 0.2 ? 1 : Math.max(5, Math.round((rad * 2.1) + 4));
        const spin = li * 0.22 + ri * 0.17;
        for (let i = 0; i < n; i++) {
          const ang = spin + (i / n) * Math.PI * 2;
          const jr = rad < 0.2 ? 0 : (i % 2 === 0 ? 0.12 : -0.1);
          const x = ox + Math.cos(ang) * (rad + jr);
          const z = oz + Math.sin(ang) * (rad + jr);
          const y = oy + layer.y + ((i + li) % 3) * 0.12 - 0.12;
          push(x, y, z);
        }
      }
    }
    return slots;
  }

  function segHitsPoint(ax, ay, az, bx, by, bz, px, py, pz, r2) {
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const apx = px - ax;
    const apy = py - ay;
    const apz = pz - az;
    const ab2 = abx * abx + aby * aby + abz * abz || 1;
    let t = (apx * abx + apy * aby + apz * abz) / ab2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const dx = ax + abx * t - px;
    const dy = ay + aby * t - py;
    const dz = az + abz * t - pz;
    return dx * dx + dy * dy + dz * dz < r2;
  }

  function launchParams(charge) {
    const p = VF.game && VF.game.player;
    const eye = p.getEyePosition();
    const dir = p.getLookDirection();
    // 仰角补偿：抬一点，抛物线自然落下
    const pitch = PHYS.pitchOffset;
    const up = new THREE.Vector3(0, 1, 0);
    const aimed = dir.clone().addScaledVector(up, Math.tan(pitch)).normalize();
    const origin = eye.clone().addScaledVector(aimed, PHYS.originDist);
    const right = new THREE.Vector3();
    right.crossVectors(dir, up);
    if (right.lengthSq() > 0.0001) {
      right.normalize();
      origin.addScaledVector(right, PHYS.handRight || 0.16);
    }
    origin.y -= PHYS.handDown || 0.2;
    freeLaunchOrigin(VF.game && VF.game.world, origin, aimed, eye);
    const def = defOf(state.equipped);
    const force = (def.baseForce != null ? def.baseForce : PHYS.baseForce) * charge;
    const vel = aimed.multiplyScalar(force);
    return { origin: origin, vel: vel };
  }

  function chargeRatio() {
    const def = defOf(state.equipped);
    const minC = def.minCharge != null ? def.minCharge : PHYS.minCharge;
    const t = Math.max(0, Math.min(1, state.holdTime / PHYS.maxChargeTime));
    return minC + t * (1 - minC);
  }

  function makeMesh(id) {
    const def = defOf(id);
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(id === 'molotov' ? 0.18 : 0.22, 0.28, 0.18),
      new THREE.MeshLambertMaterial({ color: def.color, emissive: def.color, emissiveIntensity: 0.18 })
    );
    g.add(body);
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.08, 0.1),
      new THREE.MeshLambertMaterial({ color: 0x222222 })
    );
    cap.position.y = 0.16;
    g.add(cap);
    return g;
  }

  function findActorHit(ox, oy, oz, nx, ny, nz, skipPlayer) {
    const g = VF.game;
    const r = 0.55;
    const r2 = r * r;
    const player = g && g.player;
    if (!skipPlayer && player && !player.dead && player.object) {
      const pp = player.object.position;
      const py = pp.y + 0.9;
      // nearest point on segment to player torso
      const abx = nx - ox;
      const aby = ny - oy;
      const abz = nz - oz;
      const apx = pp.x - ox;
      const apy = py - oy;
      const apz = pp.z - oz;
      const ab2 = abx * abx + aby * aby + abz * abz || 1;
      let u = (apx * abx + apy * aby + apz * abz) / ab2;
      if (u < 0) u = 0;
      else if (u > 1) u = 1;
      const hx = ox + abx * u - pp.x;
      const hy = oy + aby * u - py;
      const hz = oz + abz * u - pp.z;
      if (hx * hx + hy * hy + hz * hz < r2) {
        return { kind: 'player', actor: player, x: pp.x, y: py, z: pp.z };
      }
    }
    const ai = g && g.ai;
    const lists = ai ? [ai.blue, ai.red] : [];
    for (let l = 0; l < lists.length; l++) {
      const list = lists[l];
      if (!list) continue;
      for (let i = 0; i < list.length; i++) {
        const u = list[i];
        if (!u || !u.alive || !u.mesh) continue;
        const pp = u.mesh.position;
        const py = pp.y + 1.0;
        const abx = nx - ox;
        const aby = ny - oy;
        const abz = nz - oz;
        const apx = pp.x - ox;
        const apy = py - oy;
        const apz = pp.z - oz;
        const ab2 = abx * abx + aby * aby + abz * abz || 1;
        let t = (apx * abx + apy * aby + apz * abz) / ab2;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const hx = ox + abx * t - pp.x;
        const hy = oy + aby * t - py;
        const hz = oz + abz * t - pp.z;
        if (hx * hx + hy * hy + hz * hz < r2) {
          return { kind: 'ai', actor: u, x: pp.x, y: py, z: pp.z };
        }
      }
    }
    return null;
  }

  function friendlyFireOn() {
    const GM = VF.GameModes;
    if (GM && GM.isTeamless && GM.isTeamless()) return true;
    return !!(GM && GM.param && GM.param('friendlyFire', false));
  }

  function isAllyUnit(unit) {
    const g = VF.game;
    const team = (g && g.player && g.player.team) || (g && g.world && g.world._playerTeam) || 'ally';
    return unit && unit.team === team;
  }

  /* ─────────────────────────── public ─────────────────────────── */

  const Api = {
    start: function () {
      this.stop();
      if (!modeAllows()) return this;
      state.active = true;
      state.equipped = loadoutGrenadeId();
      if (VF.Gadgets && VF.Gadgets.grenades != null) {
        state.ammo = VF.Gadgets.grenades;
      } else {
        state.ammo = (VF.Gadgets && VF.Gadgets.GRENADE_MAX) || 2;
      }
      state.holding = false;
      state.holdTime = 0;
      state.pose = 'idle';
      state.poseT = 0;
      state.wantThrow = false;
      state.thrown = false;
      state.live = [];
      state.zones = [];
      state.flashT = 0;
      state.stunT = 0;
      this._bind();
      this._syncHud();
      return this;
    },

    setAmmo: function (n) {
      state.ammo = Math.max(0, n | 0);
      this._syncHud();
    },

    currentId: function () {
      return state.equipped || null;
    },

    stop: function () {
      this._abortPose();
      this._clearLive();
      this._clearZones();
      this._hidePreview();
      state.active = false;
      state.equipped = null;
      state.ammo = 0;
      state.flashT = 0;
      state.stunT = 0;
      this._syncHud();
      this._syncFlash();
      this._syncStunVeil();
      this._syncSmokeVeil();
      this._syncSmokeMarkers();
    },

    /** Round reset: clear in-flight nades without disabling G. */
    clearRound: function () {
      this._abortPose();
      this._clearLive();
      this._clearZones();
      this._hidePreview();
      state.flashT = 0;
      state.stunT = 0;
      this._syncFlash();
      this._syncStunVeil();
      this._syncSmokeVeil();
      this._syncSmokeMarkers();
      if (state.active) this._syncHud();
      if (state.active && VF.Gadgets && VF.Gadgets.hand === 'grenade') this.showIdleHold();
    },

    isActive: function () {
      return state.active;
    },

    /** Draw / charge / throw / recovery — blocks shooting and weapon swap. */
    busy: function () {
      return state.pose && state.pose !== 'idle';
    },

    _idleHolding: function () {
      const p = VF.game && VF.game.player;
      return !!(
        VF.Gadgets &&
        VF.Gadgets.hand === 'grenade' &&
        p &&
        p._throwNode &&
        p._throwNode.visible
      );
    },

    showIdleHold: function () {
      if (!state.equipped) state.equipped = loadoutGrenadeId();
      if (this.busy()) {
        this._showHeldVm();
        return;
      }
      this._showHeldVm();
      if (!DEBUG_UNLIMITED && state.ammo <= 0) this._hideHeldItem(true);
      else this._hideHeldItem(false);
      this._applyThrowPose();
    },

    hideIdleHold: function () {
      if (this.busy()) return;
      this._hideHeldVm();
    },

    moveMul: function () {
      return state.stunT > 0 ? state.stunMove : 1;
    },

    lookMul: function () {
      return state.stunT > 0 ? state.stunTurn : 1;
    },

    /** Camera shake amplitude while stunned (applied in player update). */
    stunShake: function () {
      if (state.stunT <= 0) return 0;
      const k = state.stunMax > 0 ? state.stunT / state.stunMax : 0;
      return 0.28 * Math.max(0.35, k);
    },

    /** 烟雾挡住视线：穿过烟柱（地面圈半径 × 高度）则不可见。 */
    occludesRay: function (from, to) {
      if (!from || !to) return false;
      const ax = from.x;
      const ay = from.y;
      const az = from.z;
      const bx = to.x;
      const by = to.y;
      const bz = to.z;
      const steps = 12;
      for (let i = 0; i < state.zones.length; i++) {
        const z = state.zones[i];
        if (z.kind !== 'smoke') continue;
        const dens = smokeDensity(z);
        if (dens < 0.12) continue;
        const r = z.radius || 0;
        if (r < 0.35) continue;
        const r2 = r * r;
        const y0 = (z.y0 != null ? z.y0 : z.y - 1.2) - 0.2;
        const y1 = y0 + (z.colH != null ? z.colH : 3.4);
        let inside = 0;
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const py = ay + (by - ay) * t;
          if (py < y0 || py > y1) continue;
          const dx = ax + (bx - ax) * t - z.x;
          const dz = az + (bz - az) * t - z.z;
          if (dx * dx + dz * dz <= r2) inside++;
        }
        const need = dens >= 0.85 ? 1 : dens >= 0.45 ? 2 : 3;
        if (inside >= need) return true;
      }
      return false;
    },

    update: function (dt) {
      if (!state.active) return;
      if (state.pose && state.pose !== 'idle') this._updatePose(dt);
      else if (state.holding) this._updateHold(dt);
      else if (this._idleHolding()) this._applyThrowPose();
      this._updateLive(dt);
      this._updateZones(dt);
      if (state.flashT > 0) {
        state.flashT = Math.max(0, state.flashT - dt);
      }
      if (state.stunT > 0) {
        state.stunT = Math.max(0, state.stunT - dt);
        const k = state.stunMax > 0 ? state.stunT / state.stunMax : 0;
        const def = DEFS.stun;
        state.stunMove = 1 - (1 - def.moveSlowMul) * k;
        state.stunTurn = 1 - (1 - def.turnSlowMul) * k;
      } else {
        state.stunMove = 1;
        state.stunTurn = 1;
      }
      this._tickAiStatus(dt);
      this._syncSmokeMarkers();
      this._syncHud();
      this._syncFlash();
      this._syncStunVeil();
      this._syncSmokeVeil();
    },

    onPlayerDeath: function () {
      this._abortPose(true);
    },

    /* ──────────────────────── input ──────────────────────── */

    _bind: function () {
      if (state.bound) return;
      state.bound = true;
      const self = this;
      document.addEventListener('keydown', function (e) {
        if (e.code !== KEY || e.repeat) return;
        if (!state.active || !canHold()) return;
        if (self.busy()) return;
        if (VF.Gadgets && VF.Gadgets._throwAim) return;
        if (!DEBUG_UNLIMITED && state.ammo <= 0) {
          if (VF.UI && VF.UI.toast) VF.UI.toast('没有投掷物');
          return;
        }
        e.preventDefault();
        self._beginHold();
      });
      document.addEventListener('keyup', function (e) {
        if (e.code !== KEY) return;
        if (!self.busy()) return;
        e.preventDefault();
        self._releaseThrow();
      });
      document.addEventListener('pointerlockchange', function () {
        if (!document.pointerLockElement && self.busy()) self._commitThrow();
      });
      document.addEventListener('wheel', function (e) {
        if (self.busy()) {
          e.preventDefault();
          return;
        }
        if (!canCycle()) return;
        e.preventDefault();
        self._cycle(e.deltaY > 0 ? 1 : -1);
      }, { passive: false });
      document.addEventListener('mousedown', function (e) {
        const slot = e.target && e.target.closest && e.target.closest('#throw-hud [data-throw-id]');
        if (slot) {
          e.preventDefault();
          if (!DEBUG_UNLIMITED) return;
          if (self.busy()) return;
          if (!state.active || !combatLive()) return;
          const g = VF.game;
          if (g && g.building && g.building.active) return;
          self._equip(slot.getAttribute('data-throw-id'));
          return;
        }
        if (e.button === 0 && VF.Gadgets && VF.Gadgets.hand === 'grenade') {
          if (!state.active || !canHold()) return;
          if (self.busy()) return;
          if (!DEBUG_UNLIMITED && state.ammo <= 0) return;
          e.preventDefault();
          self._beginHold();
        }
      });
      document.addEventListener('mouseup', function (e) {
        if (e.button !== 0) return;
        if (!self.busy()) return;
        if (state.holding || state.pose === 'draw' || state.pose === 'charge') {
          e.preventDefault();
          self._releaseThrow();
        }
      });
    },

    _equip: function (id) {
      if (!DEBUG_UNLIMITED) return;
      if (!id || !DEFS[id] || POOL.indexOf(id) < 0 || id === state.equipped) return;
      if (this.busy()) return;
      state.equipped = id;
      this._syncHud();
      if (VF.Gadgets && VF.Gadgets.hand === 'grenade') this.showIdleHold();
    },

    _cycle: function (dir) {
      const i = Math.max(0, POOL.indexOf(state.equipped));
      const n = POOL.length;
      const next = POOL[(i + (dir > 0 ? 1 : -1) + n) % n];
      this._equip(next);
    },

    _beginHold: function () {
      state.holding = true;
      state.holdTime = 0;
      state.pose = 'draw';
      state.poseT = 0;
      state.wantThrow = false;
      state.thrown = false;
      this._showHeldVm();
      playSound('throwable.' + state.equipped + '.pin', null, {
        local: true,
        priority: 6,
      });
    },

    _updateHold: function (dt) {
      if (!canHold()) {
        this._commitThrow();
        return;
      }
      state.holdTime += dt;
      this._updatePreview();
      this._applyThrowPose();
    },

    _updatePose: function (dt) {
      if (state.pose === 'draw') {
        state.poseT += dt;
        state.holdTime += dt;
        this._updatePreview();
        this._applyThrowPose();
        if (state.poseT >= ANIM.draw) {
          if (state.wantThrow || !state.holding) this._startThrowAnim();
          else {
            state.pose = 'charge';
            state.poseT = 0;
          }
        }
        return;
      }
      if (state.pose === 'charge') {
        this._updateHold(dt);
        return;
      }
      if (state.pose === 'throw') {
        state.poseT += dt;
        this._applyThrowPose();
        if (!state.thrown && state.poseT >= ANIM.releaseAt) this._spawnThrown();
        if (state.poseT >= ANIM.throw) {
          state.pose = 'recover';
          state.poseT = 0;
        }
        return;
      }
      if (state.pose === 'recover') {
        state.poseT += dt;
        this._applyThrowPose();
        if (state.poseT >= ANIM.recover) this._holster();
      }
    },

    _releaseThrow: function () {
      if (state.pose === 'draw') {
        state.holding = false;
        state.wantThrow = true;
        return;
      }
      if (state.pose === 'charge') this._startThrowAnim();
    },

    _commitThrow: function () {
      if (state.pose === 'draw' || state.pose === 'charge') this._startThrowAnim();
    },

    _startThrowAnim: function () {
      if (state.pose === 'throw' || state.pose === 'recover') return;
      state.holding = false;
      state.pose = 'throw';
      state.poseT = 0;
      state.thrown = false;
      this._hidePreview();
    },

    _spawnThrown: function () {
      if (state.thrown) return;
      const p = VF.game && VF.game.player;
      if (!p || p.dead || (!DEBUG_UNLIMITED && state.ammo <= 0)) {
        this._holster();
        return;
      }
      const def = defOf(state.equipped);
      const charge = chargeRatio();
      const launch = launchParams(charge);
      const nade = {
        id: def.id,
        x: launch.origin.x,
        y: launch.origin.y,
        z: launch.origin.z,
        vx: launch.vel.x,
        vy: launch.vel.y,
        vz: launch.vel.z,
        fuse: def.fuseTime,
        settled: false,
        landed: false,
        airT: 0,
        attach: null,
        mesh: makeMesh(def.id),
      };
      nade.mesh.position.set(nade.x, nade.y, nade.z);
      VF.game.scene.add(nade.mesh);
      state.live.push(nade);
      state.thrown = true;
      this._consume();
      this._hideHeldItem(true);
      playSound('throwable.' + def.id + '.throw', launch.origin, {
        local: true,
        priority: 5,
      });
    },

    _holster: function () {
      state.pose = 'idle';
      state.poseT = 0;
      state.holding = false;
      state.holdTime = 0;
      state.wantThrow = false;
      state.thrown = false;
      this._hidePreview();
      if (VF.Gadgets && VF.Gadgets.hand === 'grenade') this.showIdleHold();
      else this._hideHeldVm();
    },

    _abortPose: function () {
      state.pose = 'idle';
      state.poseT = 0;
      state.holding = false;
      state.holdTime = 0;
      state.wantThrow = false;
      state.thrown = false;
      this._hidePreview();
      this._hideHeldVm();
    },

    _showHeldVm: function () {
      const p = VF.game && VF.game.player;
      if (!p || !p.camera) return;
      const team = p.team === 'enemy' ? 'enemy' : 'ally';
      const stale =
        !p._throwNode ||
        p._throwNode.parent !== p.camera ||
        p._throwNode.userData.classId !== p.classId ||
        p._throwNode.userData.team !== team ||
        !p._throwNode.userData.hip ||
        !p._throwNode.userData.rArmRest ||
        !p._throwNode.userData.lArm ||
        !p._throwNode.userData.lArmRest;
      if (stale) {
        if (p._throwNode && p._throwNode.parent) p._throwNode.parent.remove(p._throwNode);
        if (VF.Soldier && VF.Soldier.createThrowableViewModel) {
          p._throwNode = VF.Soldier.createThrowableViewModel(p.classId, { team: team });
          p._throwNode.userData.classId = p.classId;
          p.camera.add(p._throwNode);
        }
      }
      const node = p._throwNode;
      if (!node) return;
      node.visible = true;
      if (node.userData.item) node.userData.item.visible = true;
      this._styleHeldItem(node, state.equipped);
      if (p._gadgetNode) p._gadgetNode.visible = false;
      if (p.viewModel) p.viewModel.visible = false;
      if (p._weaponViewModel) p._weaponViewModel.visible = false;
      if (p.gunNode) p.gunNode.visible = false;
      if (p.rightArm) p.rightArm.visible = false;
      if (p.leftArm) p.leftArm.visible = false;
      if (p._knifeNode) p._knifeNode.visible = false;
      if (p.muzzleFlash) p.muzzleFlash.visible = false;
      if (node.userData.lArm) node.userData.lArm.visible = false;
      if (p.camera) {
        const kids = p.camera.children;
        for (let i = 0; i < kids.length; i++) {
          const ch = kids[i];
          if (ch === node) continue;
          const n = ch.name || '';
          if (
            n === 'SoldierViewModel' ||
            n === 'ViewGadget' ||
            n === 'BuildViewModel' ||
            n === 'ViewKnife'
          ) {
            ch.visible = false;
          }
        }
      }
      this._applyThrowPose();
    },

    _styleHeldItem: function (node, id) {
      if (!node) return;
      const parts = node.userData.parts || {};
      const isBottle = id === 'molotov';
      const isCan = id === 'flash' || id === 'stun' || id === 'smoke';
      if (parts.grenade) parts.grenade.visible = !isBottle && !isCan;
      if (parts.bottle) parts.bottle.visible = isBottle;
      if (parts.can) parts.can.visible = isCan;
      const def = defOf(id);
      const paint = function (obj) {
        if (!obj) return;
        obj.traverse(function (m) {
          if (m.material && m.material.color && m.material.emissive) {
            m.material.color.setHex(def.color);
            m.material.emissive.setHex(def.color);
            m.material.emissiveIntensity = 0.16;
          }
        });
      };
      const body = node.userData.body;
      if (body && body.material && body.material.color) {
        body.material.color.setHex(def.color);
        if (body.material.emissive) {
          body.material.emissive.setHex(def.color);
          body.material.emissiveIntensity = 0.2;
        }
      }
      if (isBottle) paint(parts.bottle);
      if (isCan) paint(parts.can);
    },

    _hideHeldItem: function (hide) {
      const p = VF.game && VF.game.player;
      const item = p && p._throwNode && p._throwNode.userData.item;
      if (item) item.visible = !hide;
    },

    _hideHeldVm: function () {
      const p = VF.game && VF.game.player;
      if (p && p._throwNode) p._throwNode.visible = false;
      const grenadeHand = VF.Gadgets && VF.Gadgets.hand === 'grenade';
      if (grenadeHand) return;
      if (VF.Gadgets && VF.Gadgets._syncHeldVisual && VF.Gadgets.hand !== 'grenade') {
        VF.Gadgets._syncHeldVisual(VF.game);
        return;
      }
      const w = VF.game && VF.game.weapons;
      if (p && p._heldMode !== 'build') {
        if (p.viewModel) p.viewModel.visible = true;
        if (p._weaponViewModel) p._weaponViewModel.visible = true;
      }
      if (w && w.current === 'knife' && VF.Melee && VF.Melee.restyle) {
        VF.Melee.restyle(p, 'knife');
      } else if (w && w._restyleGun) {
        w._restyleGun(w.current);
      }
    },

    _applyThrowPose: function () {
      const p = VF.game && VF.game.player;
      const node = p && p._throwNode;
      if (!node || !node.visible) return;
      const hip = node.userData.hip;
      if (!hip) return;
      const sm = function (t) {
        t = Math.max(0, Math.min(1, t));
        return t * t * (3 - 2 * t);
      };
      const poseArm = function (arm, rest, dx, dy, dz, drx, dry, drz) {
        if (!arm || !rest) return;
        arm.position.set(rest.x + dx, rest.y + dy, rest.z + dz);
        arm.rotation.set(rest.rx + drx, rest.ry + dry, rest.rz + drz);
      };
      let dx = 0;
      let dy = 0;
      let dz = 0;
      let drx = 0;
      let dry = 0;
      let drz = 0;
      let r = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
      let l = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
      if (state.pose === 'draw') {
        const k = sm(state.poseT / ANIM.draw);
        dx = 0.03 * (1 - k);
        dy = -0.26 + k * 0.26;
        dz = 0.1 - k * 0.1;
        drx = 0.28 - k * 0.28;
        r.z = 0.04 * (1 - k);
        r.rx = 0.18 * (1 - k);
        l.y = -0.08 * (1 - k);
      } else if (state.pose === 'charge') {
        const c = chargeRatio();
        dy = c * 0.02;
        dz = c * 0.03;
        drx = c * 0.08;
        r.z = c * 0.03;
        r.rx = c * 0.12;
        l.z = c * 0.02;
      } else if (state.pose === 'throw') {
        const k = Math.max(0, Math.min(1, state.poseT / ANIM.throw));
        const cock = k < 0.32 ? sm(k / 0.32) : 1;
        const toss = k < 0.32 ? 0 : sm((k - 0.32) / 0.68);
        const follow = Math.max(0, (toss - 0.4) / 0.6);
        dx = toss * 0.04;
        dy = cock * 0.02 - follow * 0.08;
        dz = -toss * 0.06;
        drx = cock * 0.06 - toss * 0.12;
        dry = -toss * 0.04;
        r.z = cock * 0.05 - toss * 0.22;
        r.y = cock * 0.03 + toss * 0.04 - follow * 0.38;
        r.x = toss * 0.02 + follow * 0.06;
        r.rx = cock * 0.32 - toss * 0.7 - follow * 0.2;
        r.ry = -toss * 0.08;
        r.rz = -toss * 0.1;
        l.y = -toss * 0.28 - follow * 0.18;
        l.x = -toss * 0.1;
        l.z = toss * 0.06;
        l.rx = toss * 0.25;
        l.rz = toss * 0.12;
      } else if (state.pose === 'recover') {
        const k = sm(state.poseT / ANIM.recover);
        dx = 0.04 + k * 0.08;
        dy = -0.06 - k * 0.38;
        dz = -0.06 + k * 0.16;
        drx = -0.06 + k * 0.2;
        dry = -0.04;
        r.y = -0.31 - k * 0.28;
        r.z = -0.17 + k * 0.12;
        r.x = 0.08 + k * 0.06;
        r.rx = -0.58 + k * 0.2;
        l.y = -0.46 - k * 0.22;
        l.x = -0.1 - k * 0.08;
        l.rx = 0.25 + k * 0.15;
      }
      const sway = (p._swayBlend || 0) * (state.pose === 'charge' ? 0.55 : 0.15);
      const t = p._bobTime || 0;
      dx += Math.sin(t) * 0.018 * sway;
      dy += -Math.abs(Math.sin(t)) * 0.014 * sway;
      drz += Math.sin(t) * 0.03 * sway;
      node.position.set(hip.x + dx, hip.y + dy, hip.z + dz);
      node.rotation.set(hip.rx + drx, hip.ry + dry, hip.rz + drz);
      poseArm(node.userData.rArm, node.userData.rArmRest, r.x, r.y, r.z, r.rx, r.ry, r.rz);
      poseArm(node.userData.lArm, node.userData.lArmRest, l.x, l.y, l.z, l.rx, l.ry, l.rz);
    },

    _consume: function () {
      if (DEBUG_UNLIMITED) return;
      state.ammo = Math.max(0, state.ammo - 1);
      if (VF.Gadgets) {
        VF.Gadgets.grenades = state.ammo;
        if (VF.Gadgets.syncHud) VF.Gadgets.syncHud(VF.game);
      }
    },

    _cancelHold: function () {
      this._abortPose();
    },

    /* ──────────────────────── flight ──────────────────────── */

    _updateLive: function (dt) {
      const world = VF.game && VF.game.world;
      for (let i = state.live.length - 1; i >= 0; i--) {
        const g = state.live[i];
        const def = defOf(g.id);

        if (g.attach) this._followAttach(g);

        if (!g.settled && !g.attach) {
          this._integrate(g, world, dt);
        }
        if (g._done) {
          this._removeLive(i);
          continue;
        }

        g.airT = (g.airT || 0) + dt;
        if (!g.landed && !g.settled && g.airT > 4.5) {
          g.landed = true;
          g.settled = true;
          g.vx = g.vy = g.vz = 0;
          g.fuse = 0.05;
        }

        if (g.y < -24) {
          this._removeLive(i);
          continue;
        }

        const landReady = def.fuseFrom === 'land' && (g.settled || g.landed);
        if (def.fuseFrom === 'throw' || (def.fuseFrom === 'stick' && (g.attach || g.settled)) || landReady) {
          g.fuse -= dt;
          if (g.fuse <= 0) {
            this._trigger(g);
            this._removeLive(i);
            continue;
          }
        }

        if (g.mesh) {
          const px = g.mesh.position.x;
          const pz = g.mesh.position.z;
          g.mesh.position.set(g.x, g.y, g.z);
          if (!g.settled && !g.attach) {
            const rolled = Math.hypot(g.x - px, g.z - pz);
            if (rolled > 0.0008) {
              const spin = Math.min(0.55, rolled * 9);
              g.mesh.rotation.x += spin;
              g.mesh.rotation.z += spin * 0.62;
            }
          }
        }
      }
    },

    _restOnFloor: function (g, world) {
      const top = terrainTopAt(world, g.x, g.z);
      if (top == null) return false;
      if (g.y > top + PHYS.surfaceGap + 0.2) return false;
      g.y = top + PHYS.surfaceGap;
      return true;
    },

    _settleNade: function (g, def) {
      g.vx = g.vy = g.vz = 0;
      g.settled = true;
      if (def.fuseFrom === 'land' && g.fuse == null) g.fuse = def.fuseTime;
    },

    _integrate: function (g, world, dt) {
      const def = defOf(g.id);
      if (world && isSolid(world, g.x, g.y, g.z)) {
        const top = terrainTopAt(world, g.x, g.z);
        if (top != null && g.y < top + 0.28 && !isVoxelSolid(world, g.x, top + PHYS.surfaceGap, g.z)) {
          g.y = top + PHYS.surfaceGap;
          if (g.vy < 0) g.vy = 0;
        } else {
          const freed = resolveHit(world, g.x, g.y + 1.2, g.z, g.x, g.y, g.z);
          g.x = freed.x;
          g.y = freed.y;
          g.z = freed.z;
        }
      }
      let remain = Math.min(dt, 0.05);
      const step = 1 / 60;
      const drag = PHYS.airDrag;
      let hits = 0;
      while (remain > 0) {
        const h = Math.min(step, remain);
        remain -= h;
        const ox = g.x;
        const oy = g.y;
        const oz = g.z;
        g.vy -= PHYS.gravity * h;
        g.vx *= 1 - drag * h;
        g.vy *= 1 - drag * h;
        g.vz *= 1 - drag * h;
        const nx = g.x + g.vx * h;
        const ny = g.y + g.vy * h;
        const nz = g.z + g.vz * h;

        const actor = findActorHit(ox, oy, oz, nx, ny, nz, true);
        if (actor) {
          if (def.collide === 'stick') {
            this._stickToActor(g, actor);
            return;
          }
          if (def.collide === 'shatter') {
            g.x = actor.x;
            g.y = actor.y;
            g.z = actor.z;
            this._shatter(g);
            return;
          }
          if (def.fuseFrom === 'land' && !g.landed) {
            g.landed = true;
            g.fuse = def.fuseTime;
          }
          g.vx *= -0.35;
          g.vy *= 0.4;
          g.vz *= -0.35;
          g.x = ox;
          g.y = oy;
          g.z = oz;
          playSound('throwable.' + g.id + '.bounce', { x: g.x, y: g.y, z: g.z }, {
            maxDistance: 55,
            priority: 3,
          });
          continue;
        }

        const sub = 4;
        let hit = null;
        for (let s = 1; s <= sub; s++) {
          const u = s / sub;
          const sx = ox + (nx - ox) * u;
          const sy = oy + (ny - oy) * u;
          const sz = oz + (nz - oz) * u;
          if (isSolid(world, sx, sy, sz)) {
            hit = resolveHit(world, ox, oy, oz, sx, sy, sz);
            break;
          }
        }
        if (hit) {
          hits++;
          if (def.collide === 'shatter') {
            g.x = hit.x;
            g.y = hit.y;
            g.z = hit.z;
            this._shatter(g);
            return;
          }
          if (def.collide === 'stick') {
            g.x = hit.x;
            g.y = hit.y;
            g.z = hit.z;
            this._settleNade(g, def);
            g.fuse = def.fuseTime;
            if (VF.Audio) VF.Audio.play('c4_plant');
            return;
          }
          const rest = def.restitution != null ? def.restitution : PHYS.restitution;
          const nxn = hit.nx;
          const nyn = hit.ny;
          const nzn = hit.nz;
          const vn = g.vx * nxn + g.vy * nyn + g.vz * nzn;
          g.vx = (g.vx - 2 * vn * nxn) * rest;
          g.vy = (g.vy - 2 * vn * nyn) * rest;
          g.vz = (g.vz - 2 * vn * nzn) * rest;
          g.x = hit.x;
          g.y = hit.y;
          g.z = hit.z;
          if (isSolid(world, g.x, g.y, g.z)) {
            const lifted = resolveHit(world, g.x, g.y + 1.2, g.z, g.x, g.y, g.z);
            g.x = lifted.x;
            g.y = lifted.y;
            g.z = lifted.z;
          }
          const floor = nyn > 0.5;
          const impact = Math.abs(vn);
          const horiz = Math.hypot(g.vx, g.vz);
          const audioNow = performance.now();
          if (impact > 0.9 && (!g._bounceAudioAt || audioNow - g._bounceAudioAt > 90)) {
            g._bounceAudioAt = audioNow;
            playSound('throwable.' + g.id + '.bounce', { x: g.x, y: g.y, z: g.z }, {
              gain: Math.min(1, 0.35 + impact / 12),
              maxDistance: 55,
              priority: 3,
            });
          }
          if (floor) {
            g.groundHits = (g.groundHits || 0) + 1;
            this._restOnFloor(g, world);
            g.vx *= 0.62;
            g.vz *= 0.62;
            if (impact < 3.2 || g.groundHits >= 2) g.vy = 0;
            else if (g.vy < 0) g.vy = Math.abs(g.vy) * rest;
          }
          const spd = Math.sqrt(g.vx * g.vx + g.vy * g.vy + g.vz * g.vz);
          if (def.fuseFrom === 'land' && !g.landed) {
            g.landed = true;
            g.fuse = def.fuseTime;
          }
          const stop =
            spd < PHYS.restSpeed ||
            (floor && horiz < 1.15 && (g.vy <= 0.8 || impact < 3.2)) ||
            (g.landed && floor && spd < 2.2) ||
            hits > 8;
          if (stop) {
            this._settleNade(g, def);
            return;
          }
          continue;
        }

        g.x = nx;
        g.y = ny;
        g.z = nz;
      }
    },

    _stickToActor: function (g, actor) {
      g.vx = g.vy = g.vz = 0;
      g.x = actor.x;
      g.y = actor.y;
      g.z = actor.z;
      g.attach = actor;
      g.settled = true;
      g.fuse = defOf(g.id).fuseTime;
      if (actor.kind === 'ai' && actor.actor && actor.actor.mesh) {
        g._offX = actor.x - actor.actor.mesh.position.x;
        g._offY = actor.y - actor.actor.mesh.position.y;
        g._offZ = actor.z - actor.actor.mesh.position.z;
      } else if (actor.kind === 'player') {
        const p = actor.actor.object.position;
        g._offX = actor.x - p.x;
        g._offY = actor.y - p.y;
        g._offZ = actor.z - p.z;
      }
      if (VF.Audio) VF.Audio.play('c4_plant');
    },

    _followAttach: function (g) {
      const a = g.attach;
      if (!a) return;
      if (a.kind === 'ai') {
        const u = a.actor;
        if (!u || !u.alive || !u.mesh) {
          g.attach = null;
          return;
        }
        g.x = u.mesh.position.x + (g._offX || 0);
        g.y = u.mesh.position.y + (g._offY || 1);
        g.z = u.mesh.position.z + (g._offZ || 0);
      } else if (a.kind === 'player') {
        const p = a.actor;
        if (!p || p.dead || !p.object) {
          g.attach = null;
          return;
        }
        g.x = p.object.position.x + (g._offX || 0);
        g.y = p.object.position.y + (g._offY || 1.1);
        g.z = p.object.position.z + (g._offZ || 0);
      }
    },

    _shatter: function (g) {
      g.settled = true;
      g.vx = g.vy = g.vz = 0;
      g._done = true;
      this._trigger(g);
    },

    _removeLive: function (i) {
      const g = state.live[i];
      if (g && g.mesh && g.mesh.parent) g.mesh.parent.remove(g.mesh);
      state.live.splice(i, 1);
    },

    _clearLive: function () {
      while (state.live.length) this._removeLive(0);
    },

    /* ──────────────────────── trigger ──────────────────────── */

    _trigger: function (g) {
      const def = defOf(g.id);
      if (def.maxDamage) this._explode(g, def);
      if (g.id === 'molotov') this._spawnFire(g, def);
      if (g.id === 'flash') this._flash(g, def);
      if (g.id === 'stun') this._stun(g, def);
      if (g.id === 'smoke') this._spawnSmoke(g, def);
    },

    _explode: function (g, def) {
      const world = VF.game && VF.game.world;
      playSound('throwable.frag.detonate', { x: g.x, y: g.y, z: g.z }, {
        maxDistance: 450,
        priority: 10,
        gain: 1.6,
        refDistance: 12,
        rolloff: 0.55,
      });
      this._blastFx(g.x, g.y, g.z, def);
      this._breakBlocks(g.x, g.y, g.z, def.outerRadius, def.breakChance);
      if (world && world.deformTerrainCircle) {
        const craterR = def.outerRadius || 6;
        const craterD = 0.6;
        const changed = world.deformTerrainCircle(g.x, g.z, craterR, craterD, {
          source: 'gadget',
          maxDepth: 0.75,
        });
        const weapons = VF.game && VF.game.weapons;
        if (changed && weapons && weapons._syncTerrainDeform) {
          weapons._syncTerrainDeform(g.x, g.z, craterR, craterD);
        }
      }
      this._blastSpray(g.x, g.y, g.z);
      this._blastActors(g, def, world);
      this._blastCore(g, def, world);
      const p = VF.game && VF.game.player;
      if (p && p.addShake) p.addShake(0.22);
    },

    _blastActors: function (g, def, world) {
      const inner = def.innerRadius;
      const outer = def.outerRadius;
      const apply = (posY, pos, target, isPlayer) => {
        const dx = pos.x - g.x;
        const dy = posY - g.y;
        const dz = pos.z - g.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > outer) return;
        if (!voxelLos(world, g.x, g.y, g.z, pos.x, posY, pos.z)) return;
        let dmg;
        if (d <= inner) dmg = def.maxDamage;
        else {
          const t = (d - inner) / Math.max(0.001, outer - inner);
          dmg = def.maxDamage + (def.minEdgeDamage - def.maxDamage) * t;
        }
        dmg = Math.round(dmg);
        if (dmg <= 0) return;
        if (isPlayer) {
          const pl = VF.game.player;
          if (pl.takeDamage) pl.takeDamage(dmg, { x: g.x, y: g.y, z: g.z }, pl);
        } else {
          const ai = VF.game && VF.game.ai;
          if (ai && ai._damageUnit) {
            ai._damageUnit(target, dmg, null, true, 'player', { weaponId: def.id });
          }
        }
      };

      const pl = VF.game && VF.game.player;
      if (pl && !pl.dead && pl.object) {
        apply(pl.object.position.y + 1.1, pl.object.position, pl, true);
      }
      const ai = VF.game && VF.game.ai;
      const lists = ai ? [ai.blue, ai.red] : [];
      const ff = friendlyFireOn();
      for (let l = 0; l < lists.length; l++) {
        const list = lists[l];
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const u = list[i];
          if (!u || !u.alive || !u.mesh) continue;
          if (!ff && isAllyUnit(u)) continue;
          apply(u.mesh.position.y + 1.0, u.mesh.position, u, false);
        }
      }
    },

    _blastCore: function (g, def, world) {
      if (!def.coreDamage) return;
      const bases = VF.game && VF.game.bases;
      const core = bases && bases.enemyBase;
      if (!core || core.userData.destroyed) return;
      const cx = core.position.x;
      const cy = core.position.y + 8;
      const cz = core.position.z;
      const dx = cx - g.x;
      const dy = cy - g.y;
      const dz = cz - g.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > (def.coreMaxRange || 0)) return;
      if (!voxelLos(world, g.x, g.y, g.z, cx, cy, cz)) return;
      if (bases.damageEnemyCore) bases.damageEnemyCore(def.coreDamage);
    },

    _breakBlocks: function (x, y, z, radius, chance) {
      const world = VF.game && VF.game.world;
      if (!world || !world.breakBlock) return;
      const R = radius || 4;
      const r2 = R * R;
      const span = Math.ceil(R);
      const cx = Math.floor(x);
      const cy = Math.floor(y);
      const cz = Math.floor(z);
      for (let dx = -span; dx <= span; dx++) {
        for (let dy = -span; dy <= span; dy++) {
          for (let dz = -span; dz <= span; dz++) {
            if (dx * dx + dy * dy + dz * dz > r2) continue;
            if (Math.random() > (chance || 0)) continue;
            world.breakBlock(cx + dx, cy + dy, cz + dz);
          }
        }
      }
    },

    /** Voxel chips around the fireball, even in camera left/right — not world +X. */
    _blastSpray: function (x, y, z) {
      const weapons = VF.game && VF.game.weapons;
      if (weapons && weapons._spawnRadialDebris) {
        weapons._spawnRadialDebris(x, y + 0.4, z, 0xc47840, 20);
      }
    },

    /**
     * Grenade blast: readable from FPS, peaks a bit past damage radius (~8 m),
     * not C4's 30–70 m ground rings.
     */
    _blastFx: function (x, y, z, def) {
      const scene = VF.game && VF.game.scene;
      if (!scene) return;
      const color = (def && def.color) || 0xff7722;
      const add = (mesh, life, grow, op) => {
        scene.add(mesh);
        state.zones.push({
          kind: 'fx',
          mesh: mesh,
          life: life,
          maxLife: life,
          grow: grow,
          baseOp: op,
        });
      };

      const flash = new THREE.Mesh(new THREE.SphereGeometry(1.35, 14, 14), fxMat(0xfff6e0, 0.98, true));
      flash.position.set(x, y + 0.45, z);
      add(flash, 0.26, 2.1, 0.98);

      const fire = new THREE.Mesh(new THREE.SphereGeometry(1.85, 14, 14), fxMat(0xff7722, 0.88, true));
      fire.position.set(x, y + 0.4, z);
      add(fire, 0.48, 2.15, 0.88);

      const fire2 = new THREE.Mesh(new THREE.SphereGeometry(2.2, 12, 12), fxMat(0xffaa44, 0.55, true));
      fire2.position.set(x, y + 0.5, z);
      add(fire2, 0.4, 1.9, 0.55);

      const smoke = new THREE.Mesh(new THREE.SphereGeometry(2.4, 12, 12), fxMat(0x6a5340, 0.5, false));
      smoke.position.set(x, y + 0.55, z);
      add(smoke, 0.85, 1.7, 0.5);

      const disc = new THREE.Mesh(new THREE.CircleGeometry(2.4, 28), fxMat(0xffaa33, 0.7, true));
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(x, y + 0.08, z);
      add(disc, 0.38, 1.6, 0.7);

      const ringHi = new THREE.Mesh(new THREE.RingGeometry(0.7, 2.6, 36), fxMat(0xffee88, 0.95, true));
      ringHi.rotation.x = -Math.PI / 2;
      ringHi.position.set(x, y + 0.1, z);
      add(ringHi, 0.42, 1.7, 0.95);

      const ringLo = new THREE.Mesh(new THREE.RingGeometry(1.6, 3.6, 36), fxMat(color, 0.82, true));
      ringLo.rotation.x = -Math.PI / 2;
      ringLo.position.set(x, y + 0.06, z);
      add(ringLo, 0.58, 1.35, 0.82);

      const column = new THREE.Mesh(
        new THREE.CylinderGeometry(0.45, 1.35, 5.2, 12, 1, true),
        fxMat(0xffcc66, 0.62, true)
      );
      column.position.set(x, y + 2.4, z);
      add(column, 0.32, 1.4, 0.62);

      const weapons = VF.game && VF.game.weapons;
      if (weapons && weapons._spawnImpact) {
        weapons._spawnImpact(new THREE.Vector3(x, y + 0.4, z), 0xffee88, 0.55);
        weapons._spawnImpact(new THREE.Vector3(x, y + 0.7, z), 0xff6622, 0.85);
      }
    },

    /* ──────────────────────── zones / effects ──────────────────────── */

    _spawnFire: function (g, def) {
      const world = VF.game && VF.game.world;
      if (isWater(world, g.x, g.y, g.z) || isWater(world, g.x, g.y + 0.5, g.z)) {
        if (VF.UI && VF.UI.toast) VF.UI.toast('燃烧瓶入水熄灭');
        return;
      }
      if (VF.Audio) VF.Audio.play('explosion');
      const gy = groundY(world, g.x, g.y, g.z);
      const mesh = this._makeFireMesh(g.x, gy, g.z, def.fireRadius, world);
      VF.game.scene.add(mesh);
      const p = VF.game && VF.game.player;
      if (p && p.addShake) p.addShake(0.14);
      state.zones.push({
        kind: 'fire',
        x: g.x,
        y: gy,
        z: g.z,
        radius: def.fireRadius,
        life: def.areaDuration,
        tick: def.tickInterval,
        acc: 0,
        tickDamage: def.tickDamage,
        coreDamage: def.coreDamage,
        coreMaxRange: def.coreMaxRange,
        mesh: mesh,
      });
    },

    _makeFireMesh: function (x, y, z, r, world) {
      const root = new THREE.Group();
      root.frustumCulled = false;
      const blobGeo = new THREE.SphereGeometry(1, 10, 8);

      const glow = new THREE.Mesh(new THREE.CircleGeometry(r * 1.08, 28), fxMat(0xffaa22, 0.28, true));
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = 0.03;
      root.add(glow);

      const addBlob = (lx, ly, lz, sc, color, op, additive, kind) => {
        if (world && isSolid(world, x + lx, y + ly, z + lz)) return;
        const mesh = new THREE.Mesh(blobGeo, fxMat(color, op, additive));
        mesh.scale.setScalar(sc);
        mesh.position.set(lx, ly, lz);
        mesh.userData.kind = kind;
        mesh.userData.phase = Math.random() * 6.283;
        mesh.userData.spin = 0.6 + Math.random() * 1.4;
        mesh.userData.baseY = ly;
        mesh.userData.baseX = lx;
        mesh.userData.baseZ = lz;
        mesh.userData.baseScale = sc;
        mesh.userData.baseOp = op;
        mesh.renderOrder = kind === 'ember' ? 6 : kind === 'fire' ? 5 : 3;
        root.add(mesh);
      };

      const ring = (n, r0, r1, y0, y1, s0, s1, color, op, additive, kind) => {
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.45;
          const rr = r0 + Math.random() * (r1 - r0);
          addBlob(
            Math.cos(a) * rr,
            y0 + Math.random() * (y1 - y0),
            Math.sin(a) * rr,
            s0 + Math.random() * (s1 - s0),
            color,
            op,
            additive,
            kind
          );
        }
      };

      // Ground fire carpet: dense yellow core → orange mid → thinner rim
      ring(10, 0.0, r * 0.28, 0.22, 0.85, 0.62, 0.95, 0xfff04a, 0.88, true, 'fire');
      ring(8, 0.05, r * 0.22, 0.45, 1.15, 0.5, 0.78, 0xffee66, 0.8, true, 'fire');
      ring(16, r * 0.28, r * 0.68, 0.18, 0.75, 0.48, 0.78, 0xff8818, 0.78, true, 'fire');
      ring(14, r * 0.62, r * 0.98, 0.14, 0.52, 0.38, 0.62, 0xff5510, 0.62, true, 'fire');

      // Light haze only — must not wall off soldiers or the camera.
      ring(6, r * 0.15, r * 0.45, 0.9, 1.6, 0.45, 0.7, 0x6a6e68, 0.16, false, 'plume');
      ring(5, r * 0.12, r * 0.4, 1.5, 2.4, 0.4, 0.62, 0x7a7e78, 0.12, false, 'plume');
      ring(4, r * 0.08, r * 0.32, 2.2, 3.1, 0.35, 0.52, 0x8a8e88, 0.09, false, 'plume');

      // Embers in the fire→smoke transition
      ring(18, r * 0.1, r * 0.8, 0.55, 2.2, 0.1, 0.16, 0xff6622, 0.95, true, 'ember');

      root.position.set(x, y, z);
      return root;
    },

    _spawnSmoke: function (g, def) {
      const world = VF.game && VF.game.world;
      const gy = groundY(world, g.x, g.y, g.z);
      const cx = g.x;
      const cy = gy + 1.15;
      const cz = g.z;
      const maxR = def.effectRadius || 5;
      const colH = 3.4;
      const cells = fillSmokeCloud(world, cx, cy, cz, maxR);
      const mesh = this._makeSmokeMesh(cx, cy, cz, gy, cells, maxR);
      VF.game.scene.add(mesh);
      playSound('throwable.smoke.ignite', { x: cx, y: cy, z: cz }, {
        maxDistance: 90,
        priority: 6,
      });
      const expand = def.expandTime;
      const stable = def.areaDuration;
      const fade = def.fadeTime;
      const audioKey = 'throwable-smoke:' + (++state._soundSeq || (state._soundSeq = 1));
      if (VF.Audio && VF.Audio.playLoop) {
        VF.Audio.playLoop('throwable.smoke.loop', audioKey, {
          position: { x: cx, y: cy, z: cz },
          maxDistance: 55,
          gain: 0.42,
          priority: 3,
        });
      }
      state.zones.push({
        kind: 'smoke',
        x: cx,
        y: cy,
        z: cz,
        y0: gy,
        colH: colH,
        radius: 0.45,
        maxR: maxR,
        expand: expand,
        stable: stable,
        fade: fade,
        fadeLeft: fade,
        age: 0,
        phase: 'expand',
        cells: cells,
        mesh: mesh,
        audioKey: audioKey,
      });
    },

    _makeSmokeMesh: function (cx, cy, cz, gy, cells, maxR) {
      const root = new THREE.Group();
      root.frustumCulled = false;
      const geo = new THREE.SphereGeometry(1.55, 12, 10);
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        const dark = i % 3 === 0;
        const puff = new THREE.Mesh(geo, fxMat(dark ? 0x2a322f : 0x4a5650, 0.72, false));
        puff.position.set(c.x - cx, c.y - cy, c.z - cz);
        puff.userData.d = c.d;
        puff.userData.baseOp = dark ? 0.8 : 0.62;
        puff.userData.baseScale = 0.92 + (i % 5) * 0.04;
        puff.visible = false;
        puff.renderOrder = 4;
        root.add(puff);
      }
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.93, 1.02, 48), fxMat(0xd0e0dc, 0.7, false));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = gy - cy + 0.05;
      ring.userData.ring = true;
      ring.scale.setScalar(0.5);
      root.add(ring);
      root.position.set(cx, cy, cz);
      return root;
    },

    _updateZones: function (dt) {
      const world = VF.game && VF.game.world;
      for (let i = state.zones.length - 1; i >= 0; i--) {
        const z = state.zones[i];
        if (z.kind !== 'smoke') z.life -= dt;
        if (z.kind === 'fx') {
          if (z.mesh) {
            const maxL = z.maxLife || 0.4;
            const u = 1 - Math.max(0, z.life) / maxL;
            z.mesh.scale.setScalar(1 + u * (z.grow || 4));
            if (z.mesh.material) {
              z.mesh.material.opacity = Math.max(0, z.life / maxL) * (z.baseOp != null ? z.baseOp : 0.8);
            }
          }
          if (z.life <= 0) {
            if (z.mesh && z.mesh.parent) z.mesh.parent.remove(z.mesh);
            state.zones.splice(i, 1);
          }
          continue;
        }
        if (z.kind === 'fire') {
          z.acc += dt;
          while (z.acc >= z.tick) {
            z.acc -= z.tick;
            this._fireTick(z, world);
          }
          if (z.mesh && z.mesh.children) {
            const t = performance.now() * 0.001;
            const fade = Math.max(0.25, Math.min(1, z.life / 1.4));
            for (let c = 0; c < z.mesh.children.length; c++) {
              const ch = z.mesh.children[c];
              const u = ch.userData;
              if (u.phase == null) continue;
              const w = t * (u.spin || 1) + u.phase;
              if (u.kind === 'fire') {
                const flick = 0.86 + Math.sin(w * 5.2) * 0.14;
                ch.scale.setScalar((u.baseScale || 0.6) * flick);
                ch.position.y = u.baseY + Math.sin(w * 3.1) * 0.08;
                if (ch.material) ch.material.opacity = (u.baseOp || 0.7) * fade * flick;
              } else if (u.kind === 'plume') {
                ch.position.y = u.baseY + Math.sin(w * 0.7) * 0.18 + (1 - fade) * 0.35;
                ch.position.x = (u.baseX || 0) + Math.sin(w * 0.45) * 0.12;
                ch.position.z = (u.baseZ || 0) + Math.cos(w * 0.4) * 0.12;
                const puff = 0.94 + Math.sin(w * 1.1) * 0.08;
                ch.scale.setScalar((u.baseScale || 0.8) * puff);
                if (ch.material) ch.material.opacity = (u.baseOp || 0.5) * fade;
              } else if (u.kind === 'ember') {
                const lift = (w * 0.35) % 1.6;
                ch.position.y = u.baseY + lift;
                ch.position.x = (u.baseX || 0) + Math.sin(w * 2.2) * 0.18;
                ch.position.z = (u.baseZ || 0) + Math.cos(w * 1.8) * 0.18;
                if (ch.material) ch.material.opacity = (u.baseOp || 0.9) * fade * (0.45 + 0.55 * Math.sin(w * 8));
              }
            }
          }
        } else if (z.kind === 'smoke') {
          z.age += dt;
          const expand = z.expand || 1.5;
          const stable = z.stable || 12;
          const fade = z.fade || 2;
          const total = expand + stable + fade;
          if (z.age < expand) {
            z.phase = 'expand';
            z.radius = z.maxR * (z.age / expand);
            z.fadeLeft = fade;
          } else if (z.age < expand + stable) {
            z.phase = 'stable';
            z.radius = z.maxR;
            z.fadeLeft = fade;
          } else {
            z.phase = 'fade';
            z.fadeLeft = Math.max(0, total - z.age);
            z.radius = z.maxR * Math.max(0, z.fadeLeft / fade);
          }
          const dens = smokeDensity(z);
          if (z.mesh && z.mesh.children) {
            for (let c = 0; c < z.mesh.children.length; c++) {
              const ch = z.mesh.children[c];
              if (ch.userData.ring) {
                ch.scale.setScalar(Math.max(0.45, z.radius));
                if (ch.material) ch.material.opacity = 0.22 + dens * 0.45;
                continue;
              }
              const show = (ch.userData.d || 0) <= z.radius + 0.85;
              ch.visible = show;
              if (show && ch.material) {
                const base = ch.userData.baseOp != null ? ch.userData.baseOp : 0.7;
                const grow = 0.82 + dens * 0.28;
                const s0 = ch.userData.baseScale != null ? ch.userData.baseScale : 1;
                ch.scale.setScalar(s0 * grow);
                ch.material.opacity = base * (0.35 + 0.65 * dens);
              }
            }
          }
          if (z.age >= total) {
            if (z.audioKey && VF.Audio && VF.Audio.stopLoop) {
              VF.Audio.stopLoop(z.audioKey, 0.3);
            }
            if (z.mesh && z.mesh.parent) z.mesh.parent.remove(z.mesh);
            state.zones.splice(i, 1);
            continue;
          }
        }
        if (z.kind !== 'smoke' && z.life <= 0) {
          if (z.mesh && z.mesh.parent) z.mesh.parent.remove(z.mesh);
          state.zones.splice(i, 1);
        }
      }
    },

    _fireTick: function (z, world) {
      const r2 = z.radius * z.radius;
      const hit = (px, py, pz) => {
        const dx = px - z.x;
        const dy = py - z.y;
        const dz = pz - z.z;
        if (dx * dx + dy * dy + dz * dz > r2) return false;
        return voxelLos(world, z.x, z.y + 0.4, z.z, px, py, pz);
      };
      const pl = VF.game && VF.game.player;
      if (pl && !pl.dead && pl.object) {
        const p = pl.object.position;
        if (hit(p.x, p.y + 0.4, p.z) && pl.takeDamage) {
          pl.takeDamage(z.tickDamage, { x: z.x, y: z.y, z: z.z }, pl);
        }
      }
      const ai = VF.game && VF.game.ai;
      const ff = friendlyFireOn();
      const lists = ai ? [ai.blue, ai.red] : [];
      for (let l = 0; l < lists.length; l++) {
        const list = lists[l];
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const u = list[i];
          if (!u || !u.alive || !u.mesh) continue;
          if (!ff && isAllyUnit(u)) continue;
          const p = u.mesh.position;
          if (!hit(p.x, p.y + 0.4, p.z)) continue;
          if (ai._damageUnit) ai._damageUnit(u, z.tickDamage, null, true, 'player', { weaponId: 'molotov' });
        }
      }
      if (z.coreDamage) {
        this._blastCore({ x: z.x, y: z.y, z: z.z, id: 'molotov' }, { coreDamage: z.coreDamage, coreMaxRange: z.coreMaxRange }, world);
      }
    },

    _clearZones: function () {
      for (let i = 0; i < state.zones.length; i++) {
        const z = state.zones[i];
        if (z.audioKey && VF.Audio && VF.Audio.stopLoop) {
          VF.Audio.stopLoop(z.audioKey, 0.08);
        }
        if (z.mesh && z.mesh.parent) z.mesh.parent.remove(z.mesh);
      }
      state.zones.length = 0;
    },

    _popBurst: function (x, y, z, color, scale) {
      const scene = VF.game && VF.game.scene;
      if (!scene) return;
      const s = scale || 1;
      const add = (mesh, life, grow, op) => {
        scene.add(mesh);
        state.zones.push({ kind: 'fx', mesh: mesh, life: life, maxLife: life, grow: grow, baseOp: op });
      };
      const core = new THREE.Mesh(new THREE.SphereGeometry(1.1 * s, 12, 12), fxMat(0xfff6e0, 0.95, true));
      core.position.set(x, y, z);
      add(core, 0.28, 3.4, 0.95);
      const shell = new THREE.Mesh(new THREE.SphereGeometry(1.9 * s, 12, 12), fxMat(color, 0.72, true));
      shell.position.set(x, y, z);
      add(shell, 0.45, 2.8, 0.72);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.35 * s, 1.05 * s, 28), fxMat(color, 0.88, true));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, y + 0.06, z);
      add(ring, 0.5, 4.2, 0.88);
    },

    _flash: function (g, def) {
      const world = VF.game && VF.game.world;
      playSound('throwable.flash.detonate', { x: g.x, y: g.y, z: g.z }, {
        maxDistance: 300,
        priority: 10,
      });
      this._popBurst(g.x, g.y + 0.4, g.z, 0xf4f0dc, 1.35);
      const pl = VF.game && VF.game.player;
      if (pl && !pl.dead && pl.object) {
        const dur = this._flashOn(pl, true, g, def, world);
        if (dur > 0.05) {
          state.flashMax = Math.max(state.flashMax, def.maxBlind);
          state.flashT = Math.max(state.flashT, dur);
          playSound('throwable.flash.ring', null, {
            local: true,
            gain: Math.min(1, 0.45 + dur / def.maxBlind * 0.55),
            priority: 10,
          });
          if (pl.addShake) pl.addShake(0.28);
        }
      }
      const ai = VF.game && VF.game.ai;
      const lists = ai ? [ai.blue, ai.red] : [];
      const ff = friendlyFireOn();
      for (let l = 0; l < lists.length; l++) {
        const list = lists[l];
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const u = list[i];
          if (!u || !u.alive || !u.mesh) continue;
          if (!ff && isAllyUnit(u)) continue;
          const dur = this._flashOn(u, false, g, def, world);
          if (dur > 0) u.throwBlind = Math.max(u.throwBlind || 0, dur);
        }
      }
    },

    _flashOn: function (target, isPlayer, g, def, world) {
      let pos;
      let look;
      if (isPlayer) {
        pos = target.object.position.clone();
        pos.y += 1.5;
        look = target.getLookDirection();
      } else {
        pos = target.mesh.position.clone();
        pos.y += 1.4;
        const yaw = target.mesh.rotation.y;
        look = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      }
      const ox = g.x;
      const oy = g.y + 0.45;
      const oz = g.z;
      const dx = ox - pos.x;
      const dy = oy - pos.y;
      const dz = oz - pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > def.effectRadius) return 0;
      if (!voxelLos(world, ox, oy, oz, pos.x, pos.y, pos.z)) return 0;
      const toBlast = new THREE.Vector3(dx, dy, dz).normalize();
      const ang = Math.acos(Math.max(-1, Math.min(1, look.dot(toBlast))));
      const deg = (ang * 180) / Math.PI;
      let facing = 0.55;
      if (deg < 40) facing = 1;
      else if (deg < 100) facing = 0.55 + 0.45 * (1 - (deg - 40) / 60);
      const distF = 0.4 + 0.6 * (1 - dist / def.effectRadius);
      return Math.max(0.35, Math.min(def.maxBlind, def.maxBlind * facing * distF));
    },

    _stun: function (g, def) {
      const world = VF.game && VF.game.world;
      this._popBurst(g.x, g.y + 0.35, g.z, 0x88c8ff, 1.1);
      const affect = (pos, isPlayer, unit) => {
        const dx = pos.x - g.x;
        const dy = pos.y - (g.y + 0.4);
        const dz = pos.z - g.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > def.effectRadius) return;
        if (!voxelLos(world, g.x, g.y + 0.45, g.z, pos.x, pos.y, pos.z)) return;
        const dur = Math.max(2.8, def.maxStun * (0.55 + 0.45 * (1 - dist / def.effectRadius)));
        if (isPlayer) {
          state.stunT = Math.max(state.stunT, dur);
          state.stunMax = state.stunT;
          state.stunMove = def.moveSlowMul;
          state.stunTurn = def.turnSlowMul;
          const pl = VF.game.player;
          if (pl) {
            if (pl.addShake) pl.addShake(0.35);
            if (pl.addPitchKick) pl.addPitchKick(0.04);
          }
        } else if (unit) {
          unit.throwStun = Math.max(unit.throwStun || 0, dur);
        }
      };
      const pl = VF.game && VF.game.player;
      if (pl && !pl.dead && pl.object) {
        const p = pl.object.position.clone();
        p.y += 1.1;
        affect(p, true, null);
      }
      const ai = VF.game && VF.game.ai;
      const ff = friendlyFireOn();
      const lists = ai ? [ai.blue, ai.red] : [];
      for (let l = 0; l < lists.length; l++) {
        const list = lists[l];
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const u = list[i];
          if (!u || !u.alive || !u.mesh) continue;
          if (!ff && isAllyUnit(u)) continue;
          const p = u.mesh.position.clone();
          p.y += 1.0;
          affect(p, false, u);
        }
      }
      if (VF.Audio) VF.Audio.play('hit');
    },

    _tickAiStatus: function (dt) {
      const ai = VF.game && VF.game.ai;
      const lists = ai ? [ai.blue, ai.red] : [];
      for (let l = 0; l < lists.length; l++) {
        const list = lists[l];
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const u = list[i];
          if (!u) continue;
          if (u.throwBlind > 0) u.throwBlind = Math.max(0, u.throwBlind - dt);
          if (u.throwStun > 0) u.throwStun = Math.max(0, u.throwStun - dt);
        }
      }
    },

    /* ──────────────────────── preview / hud ──────────────────────── */

    _updatePreview: function () {
      const launch = launchParams(chargeRatio());
      const pts = state._pts;
      pts.length = 0;
      const world = VF.game && VF.game.world;
      let x = launch.origin.x;
      let y = launch.origin.y;
      let z = launch.origin.z;
      let vx = launch.vel.x;
      let vy = launch.vel.y;
      let vz = launch.vel.z;
      pts.push(new THREE.Vector3(x, y, z));
      let land = null;
      const dt = PHYS.simDt;
      for (let t = 0; t < PHYS.maxFlight; t += dt) {
        const nx = x + vx * dt;
        const ny = y + vy * dt;
        const nz = z + vz * dt;
        vy -= PHYS.gravity * dt;
        if (isSolid(world, nx, ny, nz)) {
          land = resolveHit(world, x, y, z, nx, ny, nz);
          pts.push(new THREE.Vector3(land.x, land.y, land.z));
          break;
        }
        x = nx;
        y = ny;
        z = nz;
        pts.push(new THREE.Vector3(x, y, z));
        if (y < -8) break;
      }
      this._drawPreview(pts, land);
    },

    _ensurePreview: function () {
      if (state.preview) return state.preview;
      const positions = new Float32Array(PHYS.previewSteps * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setDrawRange(0, 0);
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({ color: 0xe8c56a, transparent: true, opacity: 0.85 })
      );
      line.frustumCulled = false;
      VF.game.scene.add(line);
      const marker = new THREE.Mesh(
        new THREE.RingGeometry(0.28, 0.48, 24),
        new THREE.MeshBasicMaterial({
          color: 0xff6622,
          transparent: true,
          opacity: 0.9,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      marker.rotation.x = -Math.PI / 2;
      marker.frustumCulled = false;
      VF.game.scene.add(marker);
      state.preview = { line: line, marker: marker, geo: geo };
      return state.preview;
    },

    _drawPreview: function (pts, land) {
      const prev = this._ensurePreview();
      const arr = prev.geo.attributes.position.array;
      const n = Math.min(pts.length, PHYS.previewSteps);
      for (let i = 0; i < n; i++) {
        arr[i * 3] = pts[i].x;
        arr[i * 3 + 1] = pts[i].y;
        arr[i * 3 + 2] = pts[i].z;
      }
      prev.geo.setDrawRange(0, n);
      prev.geo.attributes.position.needsUpdate = true;
      prev.line.visible = true;
      if (land) {
        prev.marker.position.set(land.x, land.y + 0.04, land.z);
        prev.marker.visible = true;
      } else {
        prev.marker.visible = false;
      }
    },

    _hidePreview: function () {
      if (!state.preview) return;
      const prev = state.preview;
      if (prev.line && prev.line.parent) prev.line.parent.remove(prev.line);
      if (prev.marker && prev.marker.parent) prev.marker.parent.remove(prev.marker);
      state.preview = null;
    },

    _syncHud: function () {
      let el = state.hud;
      if (!el) {
        el = document.getElementById('throw-hud');
        state.hud = el;
      }
      if (!el) return;
      if (!state.slots) {
        state.slots = el.querySelectorAll('[data-throw-id]');
      }
      if (!state.active || !state.equipped) {
        el.classList.add('hidden');
        return;
      }
      el.classList.remove('hidden');
      for (let i = 0; i < state.slots.length; i++) {
        const slot = state.slots[i];
        const selected = slot.getAttribute('data-throw-id') === state.equipped;
        slot.hidden = !DEBUG_UNLIMITED && !selected;
        slot.classList.toggle('selected', selected);
        slot.classList.toggle('holding', selected && (state.holding || state.pose === 'draw' || state.pose === 'charge'));
        const cook = slot.querySelector('[data-throw-cook]');
        if (!cook) continue;
        if (selected && (state.holding || state.pose === 'draw' || state.pose === 'charge')) {
          cook.classList.remove('hidden');
          cook.classList.remove('fuse');
          cook.textContent = Math.round(chargeRatio() * 100) + '%';
        } else {
          cook.classList.add('hidden');
          cook.textContent = '';
        }
      }
    },

    _syncFlash: function () {
      let el = state.flashEl;
      if (!el) {
        el = document.getElementById('throw-flash');
        state.flashEl = el;
      }
      if (!el) return;
      if (state.flashT <= 0) {
        el.style.opacity = '0';
        return;
      }
      el.style.opacity = state.flashT > 0.5 ? '1' : String(state.flashT / 0.5);
    },

    _syncStunVeil: function () {
      let el = state.stunEl;
      if (!el) {
        el = document.getElementById('throw-stun');
        state.stunEl = el;
      }
      if (!el) return;
      if (state.stunT <= 0) {
        el.style.opacity = '0';
        el.style.backdropFilter = 'blur(0px)';
        el.style.webkitBackdropFilter = 'blur(0px)';
        return;
      }
      const k = state.stunMax > 0 ? state.stunT / state.stunMax : 0;
      el.style.opacity = String(0.28 + k * 0.5);
      const blur = (8 + 12 * k).toFixed(1) + 'px';
      el.style.backdropFilter = 'blur(' + blur + ')';
      el.style.webkitBackdropFilter = 'blur(' + blur + ')';
    },

    _syncSmokeVeil: function () {
      let el = state.smokeEl;
      if (!el) {
        el = document.getElementById('throw-smoke-veil');
        state.smokeEl = el;
      }
      if (!el) return;
      const p = VF.game && VF.game.player;
      if (!state.active || !p || p.dead || !p.object) {
        el.style.opacity = '0';
        return;
      }
      const eye = p.getEyePosition ? p.getEyePosition() : p.object.position;
      const ex = eye.x;
      const ey = eye.y;
      const ez = eye.z;
      let inside = 0;
      for (let i = 0; i < state.zones.length; i++) {
        const z = state.zones[i];
        if (z.kind !== 'smoke') continue;
        const dens = smokeDensity(z);
        if (dens < 0.12) continue;
        const r = z.radius || 0;
        if (r < 0.35) continue;
        const dx = ex - z.x;
        const dz = ez - z.z;
        const horiz = Math.sqrt(dx * dx + dz * dz);
        if (horiz > r) continue;
        const y0 = z.y0 != null ? z.y0 : z.y - 1.2;
        const y1 = y0 + (z.colH != null ? z.colH : 3.4);
        if (ey < y0 - 0.2 || ey > y1) continue;
        inside = Math.max(inside, dens * (1 - horiz / Math.max(0.001, r) * 0.35));
      }
      el.style.opacity = String(inside * 0.88);
    },

    _syncSmokeMarkers: function () {
      const p = VF.game && VF.game.player;
      const eye = p && !p.dead && p.getEyePosition ? p.getEyePosition() : null;
      const ai = VF.game && VF.game.ai;
      const lists = ai ? [ai.blue, ai.red] : [];
      for (let l = 0; l < lists.length; l++) {
        const list = lists[l];
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const u = list[i];
          if (!u || !u.mesh) continue;
          const marker = u.mesh.getObjectByName && u.mesh.getObjectByName('TeamMarker');
          if (!marker) continue;
          if (!eye || !u.alive) {
            marker.visible = true;
            continue;
          }
          const to = u.mesh.position.clone();
          to.y += 1.15;
          marker.visible = !this.occludesRay(eye, to);
        }
      }
    },
  };

  VF.Throwables = Api;
})(typeof window !== 'undefined' ? window : globalThis);
