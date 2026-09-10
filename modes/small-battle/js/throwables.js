/**
 * throwables.js — 投掷型投掷物（frag / semtex / molotov / flash / stun / smoke）
 *
 * 物理层复用先锋 C4 的思路：出手点在镜头前、分段射线碰体素、粘附时贴在墙外。
 * C4 本身仍是 G 技能（碰到就粘 + 冷却），本模块是独立的 Q 键一次性道具。
 *
 * 验证期：局内滚轮/点击自由换种类，不限数量。枪械模式不发。
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});

  const KEY = 'KeyQ';
  const POOL = ['frag', 'semtex', 'molotov', 'flash', 'stun', 'smoke'];

  /**
   * What you actually deploy with: the arsenal's pick first, then the rest of
   * what has been bought, so the in-match wheel can only reach owned kinds.
   */
  function carried() {
    const E = VF.Economy;
    const owned = POOL.filter(function (id) {
      return !E || !E.ownsThrowable || E.ownsThrowable(id);
    });
    const pick = E && E.throwableForSlot ? E.throwableForSlot() : null;
    const at = owned.indexOf(pick);
    if (at > 0) {
      owned.splice(at, 1);
      owned.unshift(pick);
    }
    return owned.length ? owned : [POOL[0]];
  }
  /** 验证用：不限量、局内可换。之后改回开局装配时关掉。 */
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
    draw: 0.24,
    throw: 0.52,
    releaseAt: 0.34,
    recover: 0.22,
  };

  /** First-person held size vs world mesh. 1 fills the lens; 0.48 read as a toy. */
  const VIEW_ITEM_SCALE = 0.55;

  /**
   * Throw arc, in metres and radians. The load-up is the shoulder swinging the
   * hand up and out behind the head — hauling it toward the lens instead just
   * makes the fist fill the screen and drags the upper arm across the glass.
   * The forward half is the whole viewmodel punching out, because rotating an
   * anchored shoulder barely changes the hand's depth and on its own reads as a
   * downward chop. Tuned for a ~110° sweep that parks the hand off the top for
   * about 0.12s of anticipation, while still leaving frame through an edge at
   * every point of it.
   */
  const ARC = {
    backZ: 0.04,
    backY: 0.06,
    backPitch: 0.1,
    backYaw: 0.05,
    outZ: 0.5,
    outY: 0.12,
    outPitch: 0.2,
    outYaw: 0.1,
    cockRx: 0.82,
    cockRy: 0.3,
    cockRz: 0.18,
    tossRx: 1.35,
    tossRy: 0.55,
    wristCock: 0.45,
    wristSnap: 1.25,
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

  /** Loadout-screen copy. Every number below is derived from DEFS, never typed twice. */
  const THROW_META = {
    frag: { kind: 'lethal', flavor: '拔销后计时起爆，落地会弹跳' },
    semtex: { kind: 'lethal', flavor: '命中即粘，贴人贴墙都不会滚走' },
    molotov: { kind: 'lethal', flavor: '落地碎裂成火池，用来封路和逼位' },
    flash: { kind: 'tactical', flavor: '起爆致盲，正对着看时持续最久' },
    stun: { kind: 'tactical', flavor: '压制移动与转向，给进攻开路' },
    smoke: { kind: 'tactical', flavor: '扩散成烟幕，切断一条线的视野' },
  };

  const FUSE_FROM_LABEL = {
    throw: '出手起算',
    stick: '粘住起算',
    impact: '触地即发',
    land: '落地起算',
  };

  /**
   * Lethals and tacticals have to share one stat panel, so both collapse onto a
   * common shape: `potency` is damage for a lethal and effect seconds for a
   * tactical, with the unit carried alongside instead of being assumed.
   */
  function throwableCatalog() {
    const out = {};
    Object.keys(THROW_META).forEach(function (id) {
      const d = DEFS[id];
      const meta = THROW_META[id];
      if (!d) return;
      const dps = d.tickDamage ? d.tickDamage / d.tickInterval : 0;
      const entry = {
        id: id,
        name: NAMES[id] || id,
        nameZh: NAMES[id] || id,
        kind: meta.kind,
        flavor: meta.flavor,
        color: d.color,
        collide: d.collide,
        fuseFrom: d.fuseFrom,
        fuseFromLabel: FUSE_FROM_LABEL[d.fuseFrom] || '',
        fuseTime: d.fuseTime || 0,
        radius: d.outerRadius || d.effectRadius || d.fireRadius || 0,
        innerRadius: d.innerRadius || 0,
        edgeDamage: d.minEdgeDamage || 0,
        coreDamage: d.coreDamage || 0,
        duration: d.areaDuration || d.maxBlind || d.maxStun || 0,
        dps: dps,
      };
      if (dps) {
        // A fire pool has no single hit to quote, so it is rated per second.
        entry.potency = dps;
        entry.potencyLabel = '灼烧';
        entry.potencyUnit = '/秒';
      } else if (meta.kind === 'lethal') {
        entry.potency = d.maxDamage || 0;
        entry.potencyLabel = '伤害';
        entry.potencyUnit = '';
      } else {
        entry.potency = d.maxBlind || d.maxStun || d.areaDuration || 0;
        entry.potencyLabel = d.maxBlind ? '致盲' : d.maxStun ? '压制' : '遮蔽';
        entry.potencyUnit = '秒';
      }
      out[id] = entry;
    });
    return out;
  }

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

  function modeAllows() {
    const GM = VF.GameModes;
    if (!GM) return true;
    if (GM.isGg && GM.isGg()) return false;
    return true;
  }

  function combatLive() {
    if (!state.active) return false;
    const g = VF.game;
    if (!g || !g.running) return false;
    if (VF.GgMatch && VF.GgMatch.active) return false;
    const tdm = VF.TdmMatch;
    if (tdm && tdm.active) return tdm.scoringLive();
    const ffa = VF.FfaMatch;
    if (ffa && ffa.active) return ffa.scoringLive();
    const sd = VF.SdMatch;
    if (sd && sd.active) return !!(sd.scoringLive && sd.scoringLive());
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
    if (!combatLive()) return false;
    return true;
  }

  function canCycle() {
    if (!state.active) return false;
    const g = VF.game;
    if (!g || !g.running) return false;
    if (VF.UI && VF.UI.isMenuOpen && VF.UI.isMenuOpen()) return false;
    if (VF.Range && VF.Range.isOpen) return false;
    if (g.levelEditing) return false;
    if (g.building && g.building.active) return false;
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
    const terrain = terrainTopAt(world, x, z);
    const floor = terrain != null && isFinite(terrain) ? terrain + 0.04 : null;
    // Deliberately not world.getWalkHeight: that answers with the highest
    // surface in the whole column, so an effect that landed on the street
    // under a bridge, or on a lower floor indoors, gets moved up onto the
    // deck or the roof and does nothing where it actually hit. Walk down
    // from the impact and take the first structure top face instead, then
    // fall back to the terrain, which carries finer height detail.
    const stop = floor != null ? floor : y - 12;
    let gy = y + 0.15;
    for (let i = 0; i < 400 && gy - 0.25 > stop; i++) {
      if (!isVoxelSolid(world, x, gy, z) && isVoxelSolid(world, x, gy - 0.25, z)) {
        return Math.floor(gy - 0.25) + 1.04;
      }
      gy -= 0.25;
    }
    return floor != null ? floor : y;
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

  // Block volumes, but not posterized voxel-art: mild face shade, real alpha,
  // and fog that does not bleach dark smoke back to wall-grey.
  const VOXEL_BOX = new THREE.BoxGeometry(1, 1, 1);
  const VOXEL_VERT = `
varying vec3 vN;
varying vec3 vWorld;
varying vec3 vCenter;
varying vec3 vRadius;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  vCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vRadius = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz)) * 0.5;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
  const VOXEL_FRAG = `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uEmi;
uniform float uPixel;
uniform float uTime;
uniform float uUseFog;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogAmt;
uniform float uSoft;
uniform float uAlphaCut;
uniform float uCloudY0;
uniform float uCloudH;
uniform vec3 uFogColor;
varying vec3 vN;
varying vec3 vWorld;
varying vec3 vCenter;
varying vec3 vRadius;
float hash13(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  float nx00 = mix(n000, n100, f.x);
  float nx10 = mix(n010, n110, f.x);
  float nx01 = mix(n001, n101, f.x);
  float nx11 = mix(n011, n111, f.x);
  return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
}
void main() {
  vec3 n = normalize(vN);
  float shade = 0.88 + 0.12 * n.y;
  float px = max(uPixel, 1.5);
  vec3 cell = floor(vWorld * px);
  float speckle = hash13(cell);
  vec3 col = uColor * shade * (0.94 + speckle * 0.08);
  col += uColor * uEmi;
  float a = uOpacity;
  if (uSoft > 0.5) {
    // Alpha comes from how much of the puff's ellipsoid the view ray crosses.
    // A box surface can never give a volume falloff, so solve the volume here;
    // the cube's own faces then stay invisible instead of showing as seams.
    vec3 rd = normalize(vWorld - cameraPosition);
    vec3 ro = (cameraPosition - vCenter) / vRadius;
    vec3 rdn = rd / vRadius;
    float qa = dot(rdn, rdn);
    float qb = 2.0 * dot(ro, rdn);
    float qc = dot(ro, ro) - 1.0;
    float disc = qb * qb - 4.0 * qa * qc;
    if (disc <= 0.0) discard;
    float sq = sqrt(disc);
    float t0 = max((-qb - sq) / (2.0 * qa), 0.0);
    float t1 = (-qb + sq) / (2.0 * qa);
    if (t1 <= t0) discard;
    // Only the fire's thin drifting smoke uses this path now; the smoke
    // grenade is built from real voxels instead.
    vec3 pSurf = cameraPosition + rd * t0;
    vec3 pRef = cameraPosition + rd * ((t0 + t1) * 0.5);
    float f =
      vnoise(pRef * 0.42 + uTime * 0.035) * 0.58 +
      vnoise(pRef * 1.15 - uTime * 0.07) * 0.29 +
      vnoise(pRef * 2.9 + 11.0) * 0.13;
    a = 1.0 - exp(-(t1 - t0) * uOpacity * (0.25 + f * 1.5));
    a *= smoothstep(0.0, 0.34, f - 0.1);
    float hT = clamp((pSurf.y - uCloudY0) / max(0.001, uCloudH), 0.0, 1.0);
    float grain = vnoise(pSurf * 1.5 + 4.3) * 0.62 + vnoise(pSurf * 3.4 - 2.1) * 0.38;
    float lift = mix(0.62, 1.2, smoothstep(0.02, 0.98, hT)) * (0.86 + grain * 0.28);
    col = uColor * (floor(lift * 9.0) / 9.0 + 0.06);
  }
  // Depth-only twins discard their faint outer gradient so they only occupy
  // the depth buffer where the cloud is thick enough to hide what is behind.
  if (a < uAlphaCut) discard;
  if (uUseFog > 0.5) {
    float fogT = smoothstep(uFogNear, uFogFar, length(vWorld - cameraPosition));
    fogT *= 1.0 - clamp(uEmi, 0.0, 1.0);
    col = mix(col, uFogColor, fogT * uFogAmt);
  }
  gl_FragColor = vec4(col, a);
}
`;

  // Smoke is built as one merged block of world-grid voxels rather than soft
  // sprites: any transparent volume, however it is shaded, ends up reading as
  // foam or bubbles. Cells grow in from the ground up as the cloud expands and
  // dissolve through an ordered dither as it thins, so the material stays
  // opaque the whole time — which also means the fog pass sees real depth.
  const SMOKE_VERT = `
attribute vec3 aCenter;
attribute float aDist;
attribute float aRim;
attribute float aRnd;
uniform float uFill;
uniform float uDens;
uniform float uTime;
varying vec3 vN;
varying vec3 vWorld;
varying float vRim;
varying float vRnd;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  vRim = aRim;
  vRnd = aRnd;
  // Same pop, ramp and dens mix as the solid pass. The only change is the
  // fill axis: height from the ground instead of horizontal radius from the
  // middle, so the column no longer arrives at full height first.
  // Per-cell jitter and a wider ramp keep the rising front from reading as
  // a flat layer of cubes switching on together.
  float j = (aRnd - 0.5) * 1.2;
  float s = clamp((uFill - aCenter.y + j) / 1.15, 0.0, 1.0);
  s = s * s * (3.0 - 2.0 * s);
  s *= mix(0.86, 1.0, uDens);
  // Drift is a smooth function of where the cell sits, not of the cell's own
  // random seed: neighbours have to move together or the block faces pull
  // apart and the cloud shows cracks.
  vec3 drift = vec3(
    sin(aCenter.z * 0.5 + uTime * 0.5),
    sin(aCenter.x * 0.42 + uTime * 0.41) * 0.6,
    cos(aCenter.x * 0.47 + uTime * 0.46)
  ) * 0.09;
  vec3 local = aCenter + drift + (position - aCenter) * s;
  vec4 w = modelMatrix * vec4(local, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
  const SMOKE_FRAG = `
uniform vec3 uColor;
uniform float uDens;
uniform float uTime;
uniform float uY0;
uniform float uH;
uniform float uUseFog;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogAmt;
uniform vec3 uFogColor;
varying vec3 vN;
varying vec3 vWorld;
varying float vRim;
varying float vRnd;
float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x * 0.5 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) {
  return bayer2(a * 0.5) * 0.25 + bayer2(a);
}
void main() {
  // Ordered dither, in screen space and at pixel scale, is how the fringe and
  // the dissolve stay chunky instead of turning into a soft gradient.
  float cover = mix(1.0, 0.6, vRim);
  float flick = fract(sin((vRnd + floor(uTime * 2.5)) * 91.7) * 4137.13);
  cover -= vRim * 0.16 * step(0.62, flick);
  cover *= smoothstep(0.0, 0.9, uDens);
  if (cover < bayer4(gl_FragCoord.xy)) discard;
  float face = 0.88 + 0.26 * vN.y + 0.07 * vN.x - 0.06 * vN.z;
  // Inner walls, seen through a gap, read as a cavity rather than a lit face.
  if (!gl_FrontFacing) face *= 0.55;
  float lift = mix(0.74, 1.18, clamp((vWorld.y - uY0) / max(0.001, uH), 0.0, 1.0));
  float tone = face * lift * (0.93 + vRnd * 0.14);
  vec3 col = uColor * (floor(tone * 6.0 + 0.5) / 6.0);
  if (uUseFog > 0.5) {
    float fogT = smoothstep(uFogNear, uFogFar, length(vWorld - cameraPosition));
    col = mix(col, uFogColor, fogT * uFogAmt);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

  function makeSmokeVoxelMat(opts) {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(opts.color) },
        uDens: { value: 1 },
        uFill: { value: 0 },
        uTime: { value: 0 },
        uY0: { value: opts.y0 || 0 },
        uH: { value: opts.h || 1 },
        uUseFog: { value: 1 },
        uFogNear: { value: 70 },
        uFogFar: { value: 340 },
        uFogAmt: { value: 0.14 },
        uFogColor: { value: new THREE.Color(0xbcd6ea) },
      },
      vertexShader: SMOKE_VERT,
      fragmentShader: SMOKE_FRAG,
      transparent: false,
      depthWrite: true,
      depthTest: true,
      // Double sided so that a gap in the shell shows the cloud's own inner
      // wall instead of a bright window straight through to the sky.
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });
    return mat;
  }

  function makeVoxelMat(opts) {
    opts = opts || {};
    const soft = !!opts.soft;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(opts.color || 0xffffff) },
        uOpacity: { value: opts.opacity != null ? opts.opacity : 1 },
        uEmi: { value: opts.emi || 0 },
        uPixel: { value: opts.pixel != null ? opts.pixel : 5 },
        uTime: { value: 0 },
        uUseFog: { value: 1 },
        uFogNear: { value: 70 },
        uFogFar: { value: 340 },
        uFogAmt: { value: opts.fogAmt != null ? opts.fogAmt : 0.28 },
        uSoft: { value: soft ? 1 : 0 },
        uAlphaCut: { value: opts.alphaCut != null ? opts.alphaCut : 0.02 },
        uCloudY0: { value: opts.cloudY0 || 0 },
        uCloudH: { value: opts.cloudH || 1 },
        uFogColor: { value: new THREE.Color(0xbcd6ea) },
      },
      vertexShader: VOXEL_VERT,
      fragmentShader: VOXEL_FRAG,
      transparent: opts.opaque ? false : soft || (opts.opacity != null && opts.opacity < 0.97),
      depthWrite:
        opts.depthWrite != null
          ? !!opts.depthWrite
          : !!(opts.opaque || (!soft && opts.depthWrite !== false && !(opts.opacity != null && opts.opacity < 0.85))),
      depthTest: true,
      fog: false,
      toneMapped: opts.toneMapped !== false,
    });
    mat.userData.baseOp = opts.opacity != null ? opts.opacity : 1;
    mat.userData.baseEmi = opts.emi || 0;
    return mat;
  }

  function syncVoxelFog(mat) {
    if (!mat || !mat.uniforms) return;
    const fog = VF.game && VF.game.scene && VF.game.scene.fog;
    if (!fog) {
      mat.uniforms.uUseFog.value = 0;
      return;
    }
    mat.uniforms.uUseFog.value = 1;
    mat.uniforms.uFogNear.value = fog.near;
    mat.uniforms.uFogFar.value = fog.far;
    mat.uniforms.uFogColor.value.copy(fog.color);
  }

  function tickVoxelMats(mats, fade, time) {
    if (!mats) return;
    for (let i = 0; i < mats.length; i++) {
      const mat = mats[i];
      if (!mat || !mat.uniforms) continue;
      const base = mat.userData.baseOp != null ? mat.userData.baseOp : 1;
      mat.uniforms.uOpacity.value = base * fade;
      mat.uniforms.uEmi.value = (mat.userData.baseEmi || 0) * fade;
      mat.uniforms.uTime.value = time;
      syncVoxelFog(mat);
    }
  }

  function snapG(v, g) {
    return Math.round(v / g) * g;
  }

  function addVoxel(root, mat, x, y, z, sx, sy, sz, data) {
    const key = (data && data.key) || snapG(x, 0.12) + ',' + snapG(y, 0.12) + ',' + snapG(z, 0.12);
    const occ = root.userData.occ || (root.userData.occ = {});
    if (occ[key]) return null;
    occ[key] = 1;
    const mesh = new THREE.Mesh(VOXEL_BOX, mat);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    mesh.frustumCulled = false;
    if (data) {
      for (const k in data) {
        if (k !== 'key') mesh.userData[k] = data[k];
      }
    }
    mesh.userData.baseX = x;
    mesh.userData.baseY = y;
    mesh.userData.baseZ = z;
    mesh.userData.baseScaleX = sx;
    mesh.userData.baseScaleY = sy;
    mesh.userData.baseScaleZ = sz;
    if (data && data.hidden) mesh.visible = false;
    root.add(mesh);
    return mesh;
  }

  function disposeZoneMesh(mesh) {
    if (!mesh) return;
    if (mesh.parent) mesh.parent.remove(mesh);
    const seen = [];
    mesh.traverse(function (n) {
      // Only geometry built for this effect; the shared unit box must survive.
      if (n.geometry && n.geometry.userData.owned && n.geometry.dispose) n.geometry.dispose();
      if (!n.material) return;
      const list = Array.isArray(n.material) ? n.material : [n.material];
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (!m || seen.indexOf(m) >= 0) continue;
        seen.push(m);
        if (m.dispose) m.dispose();
      }
    });
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

  function orientFlatC4(mesh, nx, ny, nz) {
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
  }

  /**
   * One voxel model per kind, sized to a common ~0.33 m envelope so the world
   * projectile, the loadout preview and the first-person hold can all share it
   * without per-kind scale tweaks.
   */
  function makeMesh(id) {
    if (id === 'semtex' && VF.makeC4Mesh) return VF.makeC4Mesh();
    const def = defOf(id);
    const g = new THREE.Group();
    g.name = 'Throwable_' + id;

    function box(w, h, d, color, x, y, z, opts) {
      const mat = Object.assign({ color: color }, opts || {});
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial(mat));
      m.position.set(x || 0, y || 0, z || 0);
      g.add(m);
      return m;
    }

    const STEEL = 0x9fa5a3;
    const BRASS = 0xc4a862;
    const DARK = 0x2a2c2a;

    /** Safety lever hugging the body with the pull ring stacked above it. */
    function pinAssembly(sideX, topY, spoonLen) {
      box(0.018, spoonLen, 0.044, STEEL, sideX, topY - spoonLen * 0.5, 0);
      const ry = topY + 0.032;
      box(0.036, 0.01, 0.01, BRASS, sideX, ry + 0.017, 0);
      box(0.036, 0.01, 0.01, BRASS, sideX, ry - 0.017, 0);
      box(0.01, 0.044, 0.01, BRASS, sideX - 0.017, ry, 0);
      box(0.01, 0.044, 0.01, BRASS, sideX + 0.017, ry, 0);
    }

    /** Fuse housing screwed into the top of a grenade body. */
    function fuseHead(y, w) {
      box(w, 0.036, w, DARK, 0, y, 0);
      box(w * 0.6, 0.016, w * 0.6, STEEL, 0, y + 0.024, 0);
    }

    if (id === 'frag') {
      // M67: stepped boxes round off the ovoid, grooves suggest the segmenting.
      const olive = def.color;
      box(0.10, 0.03, 0.10, olive, 0, -0.12);
      box(0.16, 0.05, 0.16, olive, 0, -0.08);
      box(0.19, 0.11, 0.19, olive, 0, 0);
      box(0.16, 0.05, 0.16, olive, 0, 0.08);
      box(0.10, 0.03, 0.10, olive, 0, 0.12);
      box(0.196, 0.014, 0.196, 0x33402a, 0, 0.032);
      box(0.196, 0.014, 0.196, 0x33402a, 0, -0.032);
      fuseHead(0.152, 0.07);
      pinAssembly(0.095, 0.15, 0.13);
    } else if (id === 'molotov') {
      // Cocktail bottle: tinted glass over a visible fuel line, paper label,
      // and a rag fuse stuffed in the neck that flops out to one side.
      const glass = { transparent: true, opacity: 0.62 };
      const glassCol = 0x5a7a55;
      box(0.135, 0.028, 0.135, 0x40563d, 0, -0.104);
      box(0.125, 0.13, 0.125, glassCol, 0, -0.03, 0, glass);
      box(0.105, 0.104, 0.105, def.color, 0, -0.042, 0, {
        emissive: def.color,
        emissiveIntensity: 0.26,
      });
      box(0.10, 0.034, 0.10, glassCol, 0, 0.052, 0, glass);
      box(0.055, 0.058, 0.055, glassCol, 0, 0.098, 0, glass);
      box(0.07, 0.018, 0.07, glassCol, 0, 0.134, 0, glass);
      box(0.084, 0.04, 0.006, 0xc9bd94, 0, -0.03, 0.064);
      const cloth = 0xcdbe93;
      box(0.042, 0.024, 0.042, cloth, 0, 0.15);
      box(0.03, 0.036, 0.034, cloth, 0.014, 0.171);
      box(0.026, 0.03, 0.028, cloth, 0.038, 0.183);
      box(0.022, 0.024, 0.024, 0x93835c, 0.058, 0.177);
    } else if (id === 'flash') {
      // M84: light steel can whose six ports read from any spin angle.
      box(0.145, 0.19, 0.145, 0xb4b8b2);
      box(0.155, 0.022, 0.155, DARK, 0, 0.106);
      box(0.155, 0.022, 0.155, DARK, 0, -0.106);
      [-0.05, 0, 0.05].forEach(function (vy) {
        box(0.024, 0.024, 0.006, DARK, 0, vy, 0.0745);
        box(0.024, 0.024, 0.006, DARK, 0, vy, -0.0745);
        box(0.006, 0.024, 0.024, DARK, 0.0745, vy, 0);
        box(0.006, 0.024, 0.024, DARK, -0.0745, vy, 0);
      });
      fuseHead(0.136, 0.06);
      pinAssembly(0.088, 0.134, 0.11);
    } else if (id === 'stun') {
      // Squatter and darker than the flash, with a lit band for the id colour.
      box(0.155, 0.165, 0.155, 0x3a4048);
      box(0.162, 0.038, 0.162, def.color, 0, 0.022, 0, {
        emissive: def.color,
        emissiveIntensity: 0.3,
      });
      box(0.165, 0.02, 0.165, DARK, 0, 0.093);
      box(0.165, 0.02, 0.165, DARK, 0, -0.093);
      fuseHead(0.122, 0.06);
      pinAssembly(0.093, 0.12, 0.1);
    } else {
      // M18 smoke: tall canister, colour band, ports punched in the top plate.
      box(0.135, 0.235, 0.135, 0x5f6a52);
      box(0.142, 0.044, 0.142, def.color, 0, 0.05);
      box(0.145, 0.02, 0.145, DARK, 0, 0.128);
      box(0.145, 0.02, 0.145, DARK, 0, -0.128);
      [-0.04, 0.04].forEach(function (px) {
        box(0.026, 0.008, 0.026, 0x1e201e, px, 0.139, 0.04);
        box(0.026, 0.008, 0.026, 0x1e201e, px, 0.139, -0.04);
      });
      fuseHead(0.155, 0.055);
      pinAssembly(0.082, 0.152, 0.12);
    }
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
      state.equipped = carried()[0];
      state.ammo = DEBUG_UNLIMITED ? 9999 : 1;
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
      if (VF.UI && VF.UI.toast) {
        VF.UI.toast('投掷物 · 滚轮切换 · Q 投掷' + (DEBUG_UNLIMITED ? '（不限量）' : ''));
      }
      return this;
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

    isActive: function () {
      return state.active;
    },

    /** Draw / charge / throw / recovery — blocks shooting and weapon swap. */
    busy: function () {
      return state.pose && state.pose !== 'idle';
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
        if (!DEBUG_UNLIMITED && state.ammo <= 0) return;
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
      }, { passive: false });
      document.addEventListener('mousedown', function (e) {
        const slot = e.target && e.target.closest && e.target.closest('#throw-hud [data-throw-id]');
        if (!slot) return;
        e.preventDefault();
        if (self.busy()) return;
        if (!canCycle()) return;
        self._equip(slot.getAttribute('data-throw-id'));
      });
    },

    _equip: function (id) {
      if (!id || !DEFS[id] || id === state.equipped) return;
      if (this.busy()) return;
      if (carried().indexOf(id) < 0) return;
      state.equipped = id;
      this._syncHud();
    },

    _cycle: function (dir) {
      const pool = carried();
      const i = Math.max(0, pool.indexOf(state.equipped));
      const n = pool.length;
      const next = pool[(i + (dir > 0 ? 1 : -1) + n) % n];
      this._equip(next);
    },

    _beginHold: function () {
      state.holding = true;
      state.holdTime = 0;
      state.pose = 'draw';
      state.poseT = 0;
      state.wantThrow = false;
      state.thrown = false;
      if (VF.UI && VF.UI.setHotbarSlot) VF.UI.setHotbarSlot('throw');
      this._showHeldVm();
      if (VF.Audio) VF.Audio.play('nade_pin');
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
      if (VF.Audio) VF.Audio.play('nade_throw');
    },

    _holster: function () {
      state.pose = 'idle';
      state.poseT = 0;
      state.holding = false;
      state.holdTime = 0;
      state.wantThrow = false;
      state.thrown = false;
      this._hidePreview();
      this._hideHeldVm();
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
      const w = VF.game && VF.game.weapons;
      if (w && VF.UI && VF.UI.setHotbarSlot && w.current && VF.WEAPONS && VF.WEAPONS[w.current]) {
        VF.UI.setHotbarSlot(VF.WEAPONS[w.current].slot);
      }
    },

    _showHeldVm: function () {
      const p = VF.game && VF.game.player;
      if (!p || !p.camera) return;
      const stale =
        !p._throwNode ||
        p._throwNode.parent !== p.camera ||
        p._throwNode.userData.classId !== p.classId ||
        !p._throwNode.userData.hip ||
        !p._throwNode.userData.rArmRest ||
        !p._throwNode.userData.lHandRest ||
        !(p._throwNode.userData.parts && p._throwNode.userData.parts.holder);
      if (stale) {
        if (p._throwNode && p._throwNode.parent) p._throwNode.parent.remove(p._throwNode);
        if (VF.Soldier && VF.Soldier.createThrowableViewModel) {
          p._throwNode = VF.Soldier.createThrowableViewModel(p.classId);
          p._throwNode.userData.classId = p.classId;
          p.camera.add(p._throwNode);
        }
      }
      const node = p._throwNode;
      if (!node) return;
      node.visible = true;
      if (node.userData.item) node.userData.item.visible = true;
      this._styleHeldItem(node, state.equipped);
      if (p.viewModel) p.viewModel.visible = false;
      if (p._weaponViewModel) p._weaponViewModel.visible = false;
      if (p.gunNode) p.gunNode.visible = false;
      if (p.rightArm) p.rightArm.visible = false;
      if (p.leftArm) p.leftArm.visible = false;
      if (p._knifeNode) p._knifeNode.visible = false;
      if (p.muzzleFlash) p.muzzleFlash.visible = false;
      this._applyThrowPose();
    },

    /**
     * Swap the held model for the equipped kind. The world mesh is reused rather
     * than a hand-built stand-in, so what you hold is what leaves your hand.
     */
    _styleHeldItem: function (node, id) {
      if (!node) return;
      const parts = node.userData.parts || {};
      const item = node.userData.item;
      const holder = parts.holder;
      const isC4 = id === 'semtex';
      if (holder && holder.userData.kind !== id) {
        for (let i = holder.children.length - 1; i >= 0; i--) {
          const child = holder.children[i];
          holder.remove(child);
          child.traverse(function (m) {
            if (m.geometry) m.geometry.dispose();
            if (m.material && m.material.dispose) m.material.dispose();
          });
        }
        const mesh = makeMesh(id);
        // Viewmodels sit inside the near plane, so culling has to be off or the
        // whole item pops out at certain angles.
        mesh.traverse(function (m) {
          m.frustumCulled = false;
        });
        holder.add(mesh);
        holder.userData.kind = id;
      }
      if (item) {
        item.scale.setScalar(VIEW_ITEM_SCALE);
        item.rotation.set(isC4 ? 0.12 : 0, isC4 ? 0.4 : -0.9, 0);
      }
    },

    _hideHeldItem: function (hide) {
      const p = VF.game && VF.game.player;
      const item = p && p._throwNode && p._throwNode.userData.item;
      if (item) item.visible = !hide;
    },

    _hideHeldVm: function () {
      const p = VF.game && VF.game.player;
      if (p && p._throwNode) p._throwNode.visible = false;
      if (p && p._heldMode !== 'build') {
        if (p.viewModel) p.viewModel.visible = true;
        if (p._weaponViewModel) p._weaponViewModel.visible = true;
      }
      const w = VF.game && VF.game.weapons;
      if (w && w._restyleGun) w._restyleGun(w.current);
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
      let rh = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
      let lh = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
      // The arms hang off anchored shoulders, so every phase below swings them
      // by rotation only — translating an arm walks its shoulder in from off
      // frame and the limb reads as a slab floating beside the lens.
      if (state.pose === 'draw') {
        // Rest pose is already the 平举 cook. Draw lifts into it from a holster.
        const u = 1 - sm(state.poseT / ANIM.draw);
        dy = -0.12 * u;
        dz = 0.06 * u;
        r.rx = -0.72 * u;
        r.ry = 0.14 * u;
        l.rx = -0.78 * u;
        l.ry = -0.12 * u;
        lh.rx = 0.3 * u;
      } else if (state.pose === 'charge') {
        const c = chargeRatio();
        dy = c * 0.02;
        r.rx = c * 0.16;
        r.ry = c * 0.06;
        rh.rx = c * 0.12;
        l.rx = -c * 0.03;
        lh.ry = c * 0.06;
      } else if (state.pose === 'throw') {
        const k = Math.max(0, Math.min(1, state.poseT / ANIM.throw));
        // A throw has to be seen loading up before it goes, so the wind-up eases
        // in over its own third of the clip and the release is an ease-out whip.
        const cock = k < 0.38 ? sm(k / 0.38) : 1;
        const raw = k < 0.38 ? 0 : (k - 0.38) / 0.62;
        const toss = 1 - Math.pow(1 - raw, 2.6);
        const follow = Math.max(0, (raw - 0.45) / 0.55);
        dy = cock * ARC.backY - toss * ARC.outY;
        dz = cock * ARC.backZ - toss * ARC.outZ + follow * ARC.outZ * 0.24;
        drx = cock * ARC.backPitch - toss * ARC.outPitch;
        dry = cock * ARC.backYaw - toss * ARC.outYaw;
        // Right: load the hand up and out behind the ear, then sweep it down and
        // through past the crosshair, wrist snapping open at the release.
        r.rx = 0.16 + cock * ARC.cockRx - toss * ARC.tossRx;
        r.ry = 0.06 + cock * ARC.cockRy - toss * ARC.tossRy;
        r.rz = -cock * ARC.cockRz + toss * ARC.cockRz * 0.43;
        rh.rx = 0.12 + cock * ARC.wristCock - toss * ARC.wristSnap;
        rh.ry = cock * 0.12 - toss * 0.3;
        // Left simply folds away as the throw goes. Cancelling the root's punch
        // off its shoulder keeps it from being carried forward with the right
        // arm, which looks like the off hand is throwing something too.
        l.z = -dz;
        l.y = -dy;
        l.rx = -0.03 - toss * 0.95;
        l.ry = -toss * 0.34;
        lh.rx = -toss * 0.45;
        lh.rz = toss * 0.66;
      } else if (state.pose === 'recover') {
        // Blends from the throw's last frame to the holster, expressed off the
        // same ARC values — hand-copied start angles drift the moment the arc is
        // retuned and pop the hands a frame after release.
        const k = sm(state.poseT / ANIM.recover);
        const mix = function (a, b) { return a + (b - a) * k; };
        dy = mix(ARC.backY - ARC.outY, -0.2);
        dz = mix(ARC.backZ - ARC.outZ * 0.76, -0.02);
        drx = mix(ARC.backPitch - ARC.outPitch, 0);
        dry = mix(ARC.backYaw - ARC.outYaw, 0);
        r.rx = mix(0.16 + ARC.cockRx - ARC.tossRx, -0.97);
        r.ry = mix(0.06 + ARC.cockRy - ARC.tossRy, 0.12);
        r.rz = mix(-ARC.cockRz * 0.57, 0);
        rh.rx = mix(0.12 + ARC.wristCock - ARC.wristSnap, -0.12);
        rh.ry = mix(-0.18, 0);
        l.z = -dz;
        l.y = -dy;
        l.rx = mix(-0.98, -1.1);
        l.ry = mix(-0.34, -0.14);
        lh.rx = mix(-0.45, -0.15);
        lh.rz = mix(0.66, 0.26);
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
      poseArm(node.userData.rHand, node.userData.rHandRest, rh.x, rh.y, rh.z, rh.rx, rh.ry, rh.rz);
      poseArm(node.userData.lHand, node.userData.lHandRest, lh.x, lh.y, lh.z, lh.rx, lh.ry, lh.rz);
    },

    _consume: function () {
      if (DEBUG_UNLIMITED) return;
      state.ammo = Math.max(0, state.ammo - 1);
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
          // An impact fuse is lit by a collision and by nothing else, so one
          // that never registers a hit has to be set off here or it hangs in
          // the air, inert and invisible, for the rest of the round.
          if (def.fuseFrom === 'impact') {
            this._trigger(g);
            this._removeLive(i);
            continue;
          }
          g.fuse = 0.05;
        }

        if (g.y < -24) {
          this._removeLive(i);
          continue;
        }

        const landReady = def.fuseFrom === 'land' && (g.settled || g.landed);
        if (g.id === 'semtex' && g.fuse != null && g.fuse > 0 && (g.attach || g.settled)) {
          g._beepAcc = (g._beepAcc || 0) + dt;
          const interval = 0.16 + Math.max(0, g.fuse) * 0.14;
          if (g._beepAcc >= interval) {
            g._beepAcc = 0;
            if (VF.Audio) VF.Audio.play('semtex_beep');
          }
        }
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
          if (g.id === 'semtex' && g.mesh.userData.led) {
            g.mesh.userData.led.visible = Math.sin(performance.now() * 0.02) > 0;
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
          const now = performance.now();
          if (!g._bounceAt || now - g._bounceAt > 85) {
            g._bounceAt = now;
            if (VF.Audio && VF.Audio.playAt) {
              VF.Audio.playAt('nade_bounce', g.x, g.y, g.z, { volMul: 0.55, hear: 40 });
            }
          }
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
            orientFlatC4(g.mesh, hit.nx, hit.ny, hit.nz);
            if (VF.Audio) VF.Audio.play('semtex_stick');
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
          if (floor) {
            g.groundHits = (g.groundHits || 0) + 1;
            this._restOnFloor(g, world);
            g.vx *= 0.62;
            g.vz *= 0.62;
            if (impact < 3.2 || g.groundHits >= 2) g.vy = 0;
            else if (g.vy < 0) g.vy = Math.abs(g.vy) * rest;
          }
          const spd = Math.sqrt(g.vx * g.vx + g.vy * g.vy + g.vz * g.vz);
          if (impact > 1.15) {
            const now = performance.now();
            if (!g._bounceAt || now - g._bounceAt > 85) {
              g._bounceAt = now;
              const vol = Math.min(1, 0.28 + impact * 0.1);
              if (VF.Audio && VF.Audio.playAt) {
                VF.Audio.playAt('nade_bounce', g.x, g.y, g.z, { volMul: vol, hear: 52 });
              } else if (VF.Audio) {
                VF.Audio.play('nade_bounce', { volMul: vol });
              }
            }
          }
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
      if (VF.Audio) VF.Audio.play('semtex_stick');
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
      if (VF.Audio) VF.Audio.play(g.id === 'semtex' ? 'semtex' : 'explosion');
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
      if (VF.Audio) VF.Audio.play('molotov');
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
      let seq = 0;

      const matHot = makeVoxelMat({
        color: 0xffb43a,
        opacity: 1,
        emi: 0.34,
        pixel: 5,
        fogAmt: 0.06,
        opaque: true,
        toneMapped: false,
      });
      const matMid = makeVoxelMat({
        color: 0xf9600f,
        opacity: 1,
        emi: 0.2,
        pixel: 5,
        fogAmt: 0.06,
        opaque: true,
        toneMapped: false,
      });
      const matDim = makeVoxelMat({
        color: 0xc7300a,
        opacity: 1,
        emi: 0.1,
        pixel: 4.5,
        fogAmt: 0.08,
        opaque: true,
        toneMapped: false,
      });
      const matChar = makeVoxelMat({
        color: 0x30231e,
        opacity: 1,
        emi: 0.04,
        pixel: 4,
        fogAmt: 0.12,
        opaque: true,
      });
      const matSmoke = makeVoxelMat({
        color: 0x555c64,
        opacity: 0.2,
        emi: 0,
        pixel: 3.2,
        fogAmt: 0.02,
        soft: true,
        toneMapped: false,
        cloudY0: y + 1.4,
        cloudH: 3.2,
      });
      root.userData.fxMats = [matHot, matMid, matDim, matChar, matSmoke];

      const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
      const TAU = Math.PI * 2;
      const can = (lx, ly, lz) => !(world && isSolid(world, x + lx, y + Math.max(ly, 0.4), z + lz));
      const put = (lx, ly, lz, sx, sy, sz, mat, kind) => {
        if (!can(lx, ly, lz)) return null;
        const m = addVoxel(root, mat, lx, ly, lz, sx, sy, sz, {
          kind: kind,
          d: Math.hypot(lx, lz),
          phase: Math.random() * TAU,
          spin: 0.55 + Math.random() * 1.4,
          key: 'f' + seq++,
        });
        if (m) m.rotation.y = Math.random() * TAU;
        return m;
      };

      // One continuous burn scar: tiles sit on a jittered grid but are wider
      // than the spacing, so they weld into a single pool instead of reading as
      // separate patches. The outline comes from low-frequency waves and the
      // embers from low-frequency blotches, never per-tile randomness.
      const s1 = Math.random() * TAU;
      const s2 = Math.random() * TAU;
      const s3 = Math.random() * TAU;
      const edgeAt = (a) =>
        r * (0.9 + 0.1 * Math.sin(a * 3 + s1) + 0.07 * Math.sin(a * 5 + s2) + 0.05 * Math.sin(a * 8 + s3));
      const gstep = 0.46;
      const gn = Math.ceil(r / gstep) + 1;
      for (let ix = -gn; ix <= gn; ix++) {
        for (let iz = -gn; iz <= gn; iz++) {
          const lx = ix * gstep + rnd(-0.07, 0.07);
          const lz = iz * gstep + rnd(-0.07, 0.07);
          const d = Math.hypot(lx, lz);
          if (d > edgeAt(Math.atan2(lz, lx))) continue;
          const blot =
            Math.sin(lx * 1.6 + s1) + Math.sin(lz * 1.9 + s2) + Math.sin((lx + lz) * 1.1 + s3) - (d / r) * 1.2;
          const mat = blot > 1.05 ? matHot : blot > 0.05 ? matMid : matChar;
          // Distinct tops per layer (plus jitter) so overlapping tiles never
          // end up coplanar and z-fight.
          const h = (mat === matHot ? 0.2 : mat === matMid ? 0.155 : 0.11) + Math.random() * 0.03;
          put(lx, h * 0.5, lz, gstep * 1.55, h, gstep * 1.55, mat, 'ground');
        }
      }

      // Flame tongues: stacked cubes tapering upward, gaps between them so the
      // silhouette reads as separate flames instead of one wall.
      for (let i = 0; i < 30; i++) {
        const a = Math.random() * TAU;
        const rr = Math.sqrt(Math.random()) * r * 0.95;
        const near = Math.max(0, 1 - rr / r);
        const total = rnd(0.5, 0.95) + near * rnd(0.45, 1.35);
        const segs = 2 + Math.floor(Math.random() * 3);
        let cx = Math.cos(a) * rr;
        let cz = Math.sin(a) * rr;
        let base = 0.02;
        let w = rnd(0.3, 0.52) * (0.8 + near * 0.5);
        for (let s = 0; s < segs; s++) {
          const t = s / segs;
          const segH = (total / segs) * rnd(0.75, 1.3);
          const mat = t < 0.3 ? matHot : t < 0.68 ? matMid : matDim;
          put(cx, base + segH * 0.5, cz, w, segH, w * rnd(0.75, 1.1), mat, 'flame');
          base += segH * rnd(0.78, 0.96);
          w *= rnd(0.56, 0.8);
          cx += rnd(-0.14, 0.14);
          cz += rnd(-0.14, 0.14);
        }
      }

      // Thin smoke drifting off the pool, kept clear of the flames themselves.
      for (let i = 0; i < 18; i++) {
        const a = Math.random() * TAU;
        const rr = Math.random() * r * 0.7;
        const s = rnd(1.1, 2.1);
        put(
          Math.cos(a) * rr,
          rnd(2.1, 3.9),
          Math.sin(a) * rr,
          s,
          s * rnd(0.7, 1.05),
          s * rnd(0.85, 1.15),
          matSmoke,
          'plume'
        );
      }
      for (let i = 0; i < 22; i++) {
        const a = Math.random() * TAU;
        const rr = Math.random() * r * 0.9;
        put(Math.cos(a) * rr, rnd(0.4, 1.6), Math.sin(a) * rr, 0.1, 0.1, 0.1, matHot, 'ember');
      }

      const light = new THREE.PointLight(0xff6a1c, 3.4, 15, 1.4);
      light.position.set(0, 0.95, 0);
      root.add(light);
      root.userData.light = light;
      root.userData.lightBase = 3.4;
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
      const mesh = this._makeSmokeMesh(cx, gy, cz, maxR, world);
      VF.game.scene.add(mesh);
      if (VF.Audio) VF.Audio.play('smoke');
      const expand = def.expandTime;
      const stable = def.areaDuration;
      const fade = def.fadeTime;
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
        cells: null,
        mesh: mesh,
      });
    },

    /**
     * One merged mesh of grid-aligned cubes. The occupied cells come from a
     * noise-carved dome, so the outline is cauliflower-lumpy rather than round,
     * and only the faces that touch an empty cell are emitted.
     */
    _makeSmokeMesh: function (cx, gy, cz, maxR, world) {
      const root = new THREE.Group();
      root.frustumCulled = false;
      const cell = 0.44;
      const colH = 3.6;
      const mat = makeSmokeVoxelMat({ color: 0x60646b, y0: gy, h: colH });
      // Deliberately not in fxMats: this material has no uOpacity/uEmi, so it
      // must not go through tickVoxelMats. _updateZones drives it directly.
      root.userData.smokeMat = mat;
      root.userData.smokeH = colH;

      const seed = Math.random() * 977;
      const h3 = (x, y, z) => {
        const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed) * 43758.5453;
        return s - Math.floor(s);
      };
      const vn = (x, y, z) => {
        const xi = Math.floor(x);
        const yi = Math.floor(y);
        const zi = Math.floor(z);
        const xf = x - xi;
        const yf = y - yi;
        const zf = z - zi;
        const u = xf * xf * (3 - 2 * xf);
        const v = yf * yf * (3 - 2 * yf);
        const w = zf * zf * (3 - 2 * zf);
        const mix2 = (a, b, t) => a + (b - a) * t;
        const y0 = mix2(
          mix2(h3(xi, yi, zi), h3(xi + 1, yi, zi), u),
          mix2(h3(xi, yi + 1, zi), h3(xi + 1, yi + 1, zi), u),
          v
        );
        const y1 = mix2(
          mix2(h3(xi, yi, zi + 1), h3(xi + 1, yi, zi + 1), u),
          mix2(h3(xi, yi + 1, zi + 1), h3(xi + 1, yi + 1, zi + 1), u),
          v
        );
        return mix2(y0, y1, w);
      };
      const lumps = (x, y, z) =>
        vn(x * 0.62, y * 0.62, z * 0.62) * 0.56 +
        vn(x * 1.35, y * 1.35, z * 1.35) * 0.29 +
        vn(x * 2.7, y * 2.7, z * 2.7) * 0.15;

      const nx = Math.ceil(maxR / cell) + 1;
      const ny = Math.ceil(colH / cell);
      const span = nx * 2 + 1;
      const solid = new Uint8Array(span * span * ny);
      const idx = (ix, iy, iz) => (iy * span + (ix + nx)) * span + (iz + nx);
      const yc = colH * 0.5;
      for (let iy = 0; iy < ny; iy++) {
        const ly = (iy + 0.5) * cell;
        for (let ix = -nx; ix <= nx; ix++) {
          for (let iz = -nx; iz <= nx; iz++) {
            const lx = ix * cell;
            const lz = iz * cell;
            const hr = Math.hypot(lx, lz) / maxR;
            // Flat-bottomed dome, not an ellipsoid: the lower half has to be a
            // full disc or the cloud thins out exactly at eye level, where a
            // gap both looks wrong and lets players see through the cover.
            const vr = Math.max(0, ly - yc) / (colH * 0.55);
            const q = Math.hypot(hr, vr);
            const edge = 1.02 + (lumps(lx, ly, lz) - 0.5) * 0.48;
            if (q >= edge) continue;
            if (world && isSolid(world, cx + lx, gy + ly, cz + lz)) continue;
            solid[idx(ix, iy, iz)] = 1;
          }
        }
      }

      const inRange = (ix, iy, iz) =>
        iy >= 0 && iy < ny && ix >= -nx && ix <= nx && iz >= -nx && iz <= nx;
      const solidAt = (ix, iy, iz) => (inRange(ix, iy, iz) ? solid[idx(ix, iy, iz)] : 0);
      // Close pinholes. The cloud is only a few cells thick near its top, so
      // the noise punches straight through it; each hole is a peephole onto the
      // bright sky, and enough of them average the whole cloud out to pale grey.
      const NB6 = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ];
      for (let pass = 0; pass < 2; pass++) {
        const add = [];
        for (let iy = 0; iy < ny; iy++) {
          for (let ix = -nx; ix <= nx; ix++) {
            for (let iz = -nx; iz <= nx; iz++) {
              if (solid[idx(ix, iy, iz)]) continue;
              let nb = 0;
              for (let d = 0; d < 6; d++) {
                const o = NB6[d];
                nb += solidAt(ix + o[0], iy + o[1], iz + o[2]);
              }
              if (nb >= 4) add.push(ix, iy, iz);
            }
          }
        }
        for (let a = 0; a < add.length; a += 3) solid[idx(add[a], add[a + 1], add[a + 2])] = 1;
      }

      const pos = [];
      const nor = [];
      const cens = [];
      const dists = [];
      const rims = [];
      const seeds = [];
      // Face basis picked so that u × v == the face normal, which makes the
      // two triangles below wind counter-clockwise seen from outside.
      const DIRS = [
        { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
        { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
        { n: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },
        { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
        { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
        { n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0] },
      ];
      const at = (ix, iy, iz) => {
        if (iy < 0 || iy >= ny || ix < -nx || ix > nx || iz < -nx || iz > nx) return 0;
        return solid[idx(ix, iy, iz)];
      };
      // Slightly oversized cubes so neighbours overlap and no seam of
      // background can show between them.
      const hh = cell * 0.53;
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = -nx; ix <= nx; ix++) {
          for (let iz = -nx; iz <= nx; iz++) {
            const k = idx(ix, iy, iz);
            if (!solid[k]) continue;
            const ccx = ix * cell;
            const ccy = (iy + 0.5) * cell;
            const ccz = iz * cell;
            const dist = Math.hypot(ccx, ccz);
            const cq = h3(ix * 3.1, iy * 5.7, iz * 2.3);
            // Only loosely attached cells get dithered. A cell on a flat wall
            // keeps five neighbours and stays solid, so the body of the cloud
            // never lets the background bleed through; the lumps sticking out
            // of the silhouette are the ones that break up into pixels.
            let nb = 0;
            for (let d = 0; d < 6; d++) {
              const n = DIRS[d].n;
              nb += at(ix + n[0], iy + n[1], iz + n[2]);
            }
            const cr = Math.min(1, Math.max(0, (4 - nb) / 3));
            for (let d = 0; d < 6; d++) {
              const dir = DIRS[d];
              const n = dir.n;
              if (at(ix + n[0], iy + n[1], iz + n[2])) continue;
              const u = dir.u;
              const v = dir.v;
              const fx = ccx + n[0] * hh;
              const fy = ccy + n[1] * hh;
              const fz = ccz + n[2] * hh;
              const corner = (su, sv) => [
                fx + u[0] * hh * su + v[0] * hh * sv,
                fy + u[1] * hh * su + v[1] * hh * sv,
                fz + u[2] * hh * su + v[2] * hh * sv,
              ];
              const c0 = corner(-1, -1);
              const c1 = corner(1, -1);
              const c2 = corner(1, 1);
              const c3 = corner(-1, 1);
              const tri = [c0, c1, c2, c0, c2, c3];
              for (let t = 0; t < 6; t++) {
                const c = tri[t];
                pos.push(c[0], c[1], c[2]);
                nor.push(n[0], n[1], n[2]);
                cens.push(ccx, ccy, ccz);
                dists.push(dist);
                rims.push(cr);
                seeds.push(cq);
              }
            }
          }
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      geo.setAttribute('aCenter', new THREE.Float32BufferAttribute(cens, 3));
      geo.setAttribute('aDist', new THREE.Float32BufferAttribute(dists, 1));
      geo.setAttribute('aRim', new THREE.Float32BufferAttribute(rims, 1));
      geo.setAttribute('aRnd', new THREE.Float32BufferAttribute(seeds, 1));
      geo.userData.owned = true;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      root.add(mesh);
      root.position.set(cx, gy, cz);
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
            disposeZoneMesh(z.mesh);
            state.zones.splice(i, 1);
          }
          continue;
        }
        if (z.kind === 'fire') {
          z.age = (z.age || 0) + dt;
          z.acc += dt;
          while (z.acc >= z.tick) {
            z.acc -= z.tick;
            this._fireTick(z, world);
          }
          if (z.mesh && z.mesh.children) {
            const t = performance.now() * 0.001;
            // Catches alight from the middle outward, then burns back inward.
            const lit = Math.min(1, z.age / 0.55);
            const left = Math.min(1, Math.max(0, z.life) / 1.5);
            const fade = Math.min(lit, left);
            const rLit = z.radius * lit * 1.12;
            const rLeft = z.radius * left * 1.12;
            tickVoxelMats(z.mesh.userData && z.mesh.userData.fxMats, fade, t);
            const lightRef = z.mesh.userData && z.mesh.userData.light;
            if (lightRef) lightRef.intensity = (z.mesh.userData.lightBase || 3.4) * fade;
            for (let c = 0; c < z.mesh.children.length; c++) {
              const ch = z.mesh.children[c];
              const u = ch.userData;
              if (u.phase == null) continue;
              const d = u.d || 0;
              const grow = Math.max(0, Math.min(1, (rLit - d) / 0.85));
              const burn = Math.max(0, Math.min(1, (rLeft - d) / 0.85));
              const app = Math.min(grow, burn);
              if (app <= 0.002) {
                ch.visible = false;
                continue;
              }
              ch.visible = true;
              const w = t * (u.spin || 1) + u.phase;
              const bx = u.baseScaleX || 0.4;
              const by = u.baseScaleY || bx;
              const bz = u.baseScaleZ || bx;
              if (u.kind === 'flame') {
                const tall = (0.78 + Math.sin(w * 6.6) * 0.16 + Math.sin(w * 11.7) * 0.07) * app;
                const wob = (0.92 + Math.sin(w * 5.1) * 0.08) * (0.4 + app * 0.6);
                ch.position.x = (u.baseX || 0) + Math.sin(w * 2.6) * 0.055;
                ch.position.y = (u.baseY || 0) * tall + Math.sin(w * 3.3) * 0.05 * app;
                ch.position.z = (u.baseZ || 0) + Math.cos(w * 2.2) * 0.055;
                ch.scale.set(bx * wob, by * tall, bz * wob);
              } else if (u.kind === 'ground') {
                // Only the thickness grows, so neighbouring tiles stay welded.
                const th = (0.85 + Math.sin(w * 3.6) * 0.15) * app;
                ch.position.y = (u.baseY || 0) * th;
                ch.scale.set(bx, by * th, bz);
              } else if (u.kind === 'plume') {
                const ps = 0.55 + app * 0.45;
                ch.position.x = (u.baseX || 0) + Math.sin(w * 0.45) * 0.1;
                ch.position.y = (u.baseY || 0) + Math.sin(w * 0.7) * 0.14 + (1 - fade) * 0.35;
                ch.position.z = (u.baseZ || 0) + Math.cos(w * 0.4) * 0.1;
                ch.scale.set(bx * ps, by * ps, bz * ps);
              } else if (u.kind === 'ember') {
                const lift = (w * 0.32) % 1.5;
                ch.position.x = (u.baseX || 0) + Math.sin(w * 1.8) * 0.16;
                ch.position.y = (u.baseY || 0) + lift;
                ch.position.z = (u.baseZ || 0) + Math.cos(w * 1.5) * 0.16;
                const pulse = (0.45 + 0.55 * Math.max(0, Math.sin(w * 6.5))) * app;
                ch.scale.set(bx * pulse, by * pulse, bz * pulse);
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
          const smokeMat = z.mesh && z.mesh.userData && z.mesh.userData.smokeMat;
          if (smokeMat) {
            const u = smokeMat.uniforms;
            u.uTime.value = performance.now() * 0.001;
            u.uDens.value = dens;
            // Same +1 m clearance as the solid pass, but the fill value is
            // height so the front walks up the cloud instead of out from the
            // axis. Held at the top during fade so Bayer dither is what
            // dissolves it, not the mesh sinking.
            const smokeH = z.mesh.userData.smokeH || 3.6;
            const t = z.phase === 'expand'
              ? Math.min(1, z.age / Math.max(0.001, expand))
              : 1;
            u.uFill.value = t * (smokeH + 2.0);
            syncVoxelFog(smokeMat);
          }
          if (z.age >= total) {
            disposeZoneMesh(z.mesh);
            state.zones.splice(i, 1);
            continue;
          }
        }
        if (z.kind !== 'smoke' && z.life <= 0) {
          disposeZoneMesh(z.mesh);
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
        disposeZoneMesh(state.zones[i].mesh);
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
      this._popBurst(g.x, g.y + 0.4, g.z, 0xf4f0dc, 1.35);
      const pl = VF.game && VF.game.player;
      if (pl && !pl.dead && pl.object) {
        const dur = this._flashOn(pl, true, g, def, world);
        if (dur > 0.05) {
          state.flashMax = Math.max(state.flashMax, def.maxBlind);
          state.flashT = Math.max(state.flashT, dur);
          if (pl.addShake) pl.addShake(0.28);
          if (VF.Audio) VF.Audio.play('flash_ring');
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
      if (VF.Audio) VF.Audio.play('flashbang');
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
      if (VF.Audio) VF.Audio.play('stun');
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
      if (VF.UI && VF.UI.syncThrowSlot) VF.UI.syncThrowSlot();
      if (!state.active || !state.equipped) {
        el.classList.add('hidden');
        return;
      }
      el.classList.remove('hidden');
      const pool = carried();
      for (let i = 0; i < state.slots.length; i++) {
        const slot = state.slots[i];
        const id = slot.getAttribute('data-throw-id');
        // An unbought kind is not carried, so it should not take up strip space.
        slot.classList.toggle('hidden', pool.indexOf(id) < 0);
        const selected = id === state.equipped;
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
      el.style.opacity = String(inside * 0.95);
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

  /** Hotbar Q slot mirrors these. */
  Api.isActive = function () {
    return !!state.active;
  };
  Api.equipped = function () {
    return state.active ? state.equipped : null;
  };
  Api.remaining = function () {
    return state.active ? state.ammo : 0;
  };
  /** Respawn / new round: back to a full carry of the equipped lethal. */
  Api.refill = function () {
    if (!state.active) return;
    if (state.pose && state.pose !== 'idle' && this._abortPose) this._abortPose();
    state.ammo = DEBUG_UNLIMITED ? 9999 : 1;
    this._syncHud();
  };

  /** Loadout screen reads the stats and builds a preview from the world mesh. */
  Api.catalog = throwableCatalog;
  Api.order = function () {
    return POOL.slice();
  };
  Api.carried = carried;
  Api.makeMesh = makeMesh;

  VF.Throwables = Api;
  VF.THROWABLE_CATALOG = throwableCatalog();
})(typeof window !== 'undefined' ? window : globalThis);
