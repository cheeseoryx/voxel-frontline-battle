/**
 * vehicles.js — Lightweight arcade vehicles, mounted weapons and PVP snapshots.
 * The data/seat/damage layer intentionally works without THREE for Node checks.
 */
(function (global) {
  'use strict';

  const DEG = Math.PI / 180;
  const EPS = 1e-6;
  const RAM_MIN_SPEED = 2.5;
  const RAM_LOOKAHEAD = 1.45;
  const RAM_SLOW_FACTOR = 0.5;
  const RAM_SLOW_DURATION = 0.7;
  const RAM_MAX_VOXELS = 220;
  const DRIVE_HALF_WIDTH = 0.48;
  const DRIVE_HALF_LENGTH = 0.48;
  const MAX_DRIVE_PITCH = Math.PI / 4;
  const MAX_DRIVE_DOWN_PITCH = Math.PI * 0.42;
  const DRIVE_PITCH_RATE = 10;

  function seat(role, x, y, z) {
    return { role: role, offset: { x: x, y: y, z: z } };
  }

  const WEAPON_DEFS = {
    rpg: {
      id: 'rpg',
      vehicleType: null,
      role: 'engineer',
      name: 'RPG-7',
      nameZh: 'RPG-7 反装甲火箭',
      kind: 'anti-armor-rocket',
      mode: 'projectile',
      damage: 150,
      damageType: 'antiArmor',
      cooldown: 3.2,
      projectileSpeed: 38,
      projectileLife: 7,
      gravity: 1.5,
      range: 240,
    },
    ifv_he_autocannon: {
      id: 'ifv_he_autocannon',
      vehicleType: 'ifv',
      role: 'driver',
      name: 'IFV HE Cannon',
      nameZh: '高爆炮',
      kind: 'autocannon',
      mode: 'hitscan',
      damage: 46,
      damageType: 'explosive',
      cooldown: 0.22,
      range: 130,
      magSize: 12,
      reserve: 192,
      reserveMax: 192,
      reserveRegenSec: 15,
      reserveRegenAmount: 12,
      reloadSec: 3.2,
      pivot: { x: 0, y: 2.28, z: -1.28 },
      muzzle: { x: 0, y: 2.72, z: -3.45 },
    },
    ifv_at_missile: {
      id: 'ifv_at_missile',
      vehicleType: 'ifv',
      role: 'driver',
      name: 'Aim-guided Anti-armor Missile',
      nameZh: '瞄准制导反装甲导弹',
      kind: 'guided-missile',
      mode: 'projectile',
      guidance: 'aim',
      damage: 150,
      damageType: 'antiArmor',
      cooldown: 6.5,
      magSize: 1,
      reserve: 3,
      reloadSec: 5.5,
      projectileSpeed: 44,
      projectileLife: 8,
      guidanceRate: 2.8,
      range: 260,
      pivot: { x: 0, y: 2.28, z: -1.28 },
      muzzle: { x: 1.25, y: 2.65, z: -1.55 },
    },
    ifv_grenade_launcher: {
      id: 'ifv_grenade_launcher',
      vehicleType: 'ifv',
      role: 'gunner',
      name: 'Gunner Grenade Launcher',
      nameZh: '炮手榴弹发射器',
      kind: 'grenade-launcher',
      mode: 'projectile',
      damage: 78,
      damageType: 'explosive',
      cooldown: 0.85,
      magSize: 6,
      reserve: 24,
      reloadSec: 3.8,
      projectileSpeed: 34,
      projectileLife: 4.5,
      gravity: 7.5,
      range: 110,
      pivot: { x: -0.82, y: 2.58, z: 0.25 },
      muzzle: { x: -0.72, y: 2.56, z: -2.35 },
    },
    tank_main_cannon: {
      id: 'tank_main_cannon',
      vehicleType: 'tank',
      role: 'driver',
      name: 'Multi-purpose Main Cannon',
      nameZh: '多用途主炮',
      kind: 'main-cannon',
      mode: 'projectile',
      damage: 200,
      damageType: 'antiArmor',
      cooldown: 4.2,
      magSize: 15,
      range: 320,
      projectileSpeed: 95,
      projectileLife: 4.2,
      gravity: 1,
      pivot: { x: 0, y: 2.46, z: -1.57 },
      muzzle: { x: 0, y: 2.82, z: -5.9 },
    },
    tank_coax_mg: {
      id: 'tank_coax_mg',
      vehicleType: 'tank',
      role: 'driver',
      name: 'Coaxial Machine Gun',
      nameZh: '同轴机枪',
      kind: 'machine-gun',
      mode: 'hitscan',
      damage: 24,
      damageType: 'bullet',
      cooldown: 0.095,
      range: 150,
      maxHeat: 100,
      heatPerShot: 9,
      heatCoolPerSec: 20,
      pivot: { x: 0, y: 2.46, z: -1.57 },
      muzzle: { x: 0.32, y: 2.76, z: -4.2 },
    },
    tank_gunner_hmg: {
      id: 'tank_gunner_hmg',
      vehicleType: 'tank',
      role: 'gunner',
      name: 'Gunner Heavy Machine Gun',
      nameZh: '炮手重机枪',
      kind: 'heavy-machine-gun',
      mode: 'hitscan',
      damage: 36,
      damageType: 'bullet',
      cooldown: 0.14,
      range: 180,
      maxHeat: 100,
      heatPerShot: 9,
      heatCoolPerSec: 20,
      pivot: { x: -0.72, y: 3.15, z: 0.05 },
      muzzle: { x: -0.68, y: 3.25, z: -1.3 },
    },
  };

  const IFV_WEAPONS = [
    'ifv_he_autocannon',
    'ifv_at_missile',
    'ifv_grenade_launcher',
  ];
  const TANK_WEAPONS = [
    'tank_main_cannon',
    'tank_coax_mg',
    'tank_gunner_hmg',
  ];

  const VEHICLE_DEFS = {
    jeep: {
      id: 'jeep',
      name: 'Jeep',
      nameZh: '军用吉普',
      dimensions: { width: 2.35, height: 2.05, length: 4.45 },
      size: { x: 2.35, y: 2.05, z: 4.45 },
      speed: 22,
      maxSpeed: 22,
      reverseSpeed: 8,
      acceleration: 11,
      braking: 18,
      turn: 1.28,
      turnRate: 1.28,
      maxStep: 2.5,
      maxHp: 360,
      armorClass: 'light',
      armorMul: 1,
      respawnSec: 45,
      canRam: false,
      seats: [
        seat('driver', -0.48, 1.05, 0.15),
        seat('passenger', 0.48, 1.05, 0.15),
        seat('passenger', -0.55, 1.05, 1.15),
        seat('passenger', 0.55, 1.05, 1.15),
        seat('passenger', -0.55, 1.05, 1.72),
        seat('passenger', 0.55, 1.05, 1.72),
      ],
      weapons: [],
      mountedWeapons: [],
    },
    ifv: {
      id: 'ifv',
      name: 'IFV',
      nameZh: '步兵战车',
      dimensions: { width: 3.25, height: 2.85, length: 6.45 },
      size: { x: 3.25, y: 2.85, z: 6.45 },
      speed: 15,
      maxSpeed: 15,
      reverseSpeed: 6,
      acceleration: 7,
      braking: 14,
      turn: 0.82,
      turnRate: 0.82,
      maxStep: 3.6,
      maxHp: 600,
      armorClass: 'light',
      armorMul: 1,
      respawnSec: 60,
      canRam: true,
      cameraAnchors: {
        driver: {
          pivot: { x: 0, y: 2.03, z: -0.48 },
          offset: { x: -0.52, y: 0.86, z: -1.18 },
        },
        gunner: {
          pivot: { x: -0.82, y: 2.58, z: 0.25 },
          offset: { x: 0, y: 0.3, z: -0.5 },
        },
      },
      seats: [
        seat('driver', -0.62, 1.2, -1.15),
        seat('gunner', 0, 2.05, -0.25),
        seat('passenger', -0.72, 1.2, 0.55),
        seat('passenger', 0.72, 1.2, 0.55),
        seat('passenger', -0.72, 1.2, 1.6),
        seat('passenger', 0.72, 1.2, 1.6),
      ],
      weapons: IFV_WEAPONS,
      mountedWeapons: IFV_WEAPONS,
    },
    tank: {
      id: 'tank',
      name: 'Tank',
      nameZh: '主战坦克',
      dimensions: { width: 3.65, height: 3.05, length: 7.25 },
      size: { x: 3.65, y: 3.05, z: 7.25 },
      speed: 12,
      maxSpeed: 12,
      reverseSpeed: 5,
      acceleration: 5.5,
      braking: 12,
      turn: 0.68,
      turnRate: 0.68,
      maxStep: 4.2,
      maxHp: 1000,
      armorClass: 'heavy',
      armorMul: 1,
      respawnSec: 75,
      canRam: true,
      cameraAnchors: {
        driver: {
          pivot: { x: 0, y: 2.08, z: -0.42 },
          offset: { x: 0.58, y: 0.98, z: -1.42 },
        },
        gunner: {
          pivot: { x: -0.72, y: 3.15, z: 0.05 },
          offset: { x: 0, y: 0.34, z: -0.5 },
        },
      },
      seats: [
        seat('driver', -0.58, 1.35, -1.25),
        seat('gunner', 0, 2.25, -0.15),
      ],
      weapons: TANK_WEAPONS,
      mountedWeapons: TANK_WEAPONS,
    },
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function finite(value, fallback) {
    value = Number(value);
    return isFinite(value) ? value : fallback;
  }

  function normalizeAngle(value) {
    while (value > Math.PI) value -= Math.PI * 2;
    while (value < -Math.PI) value += Math.PI * 2;
    return value;
  }

  function vec(x, y, z) {
    return { x: finite(x, 0), y: finite(y, 0), z: finite(z, 0) };
  }

  function copyVec(source) {
    return vec(source && source.x, source && source.y, source && source.z);
  }

  function length3(value) {
    return Math.hypot(value.x || 0, value.y || 0, value.z || 0);
  }

  function normalizeVec(value, fallback) {
    const out = copyVec(value);
    const length = length3(out);
    if (length <= EPS) return fallback ? copyVec(fallback) : vec(0, 0, -1);
    out.x /= length;
    out.y /= length;
    out.z /= length;
    return out;
  }

  function distanceSq(a, b) {
    const dx = (a.x || 0) - (b.x || 0);
    const dy = (a.y || 0) - (b.y || 0);
    const dz = (a.z || 0) - (b.z || 0);
    return dx * dx + dy * dy + dz * dz;
  }

  function approach(value, target, amount) {
    if (value < target) return Math.min(target, value + amount);
    if (value > target) return Math.max(target, value - amount);
    return target;
  }

  function assignPosition(target, source) {
    if (!target || !source) return;
    if (typeof target.set === 'function') {
      target.set(source.x, source.y, source.z);
    } else {
      target.x = source.x;
      target.y = source.y;
      target.z = source.z;
    }
  }

  function entityPosition(entity) {
    if (!entity) return null;
    if (entity.object && entity.object.position) return entity.object.position;
    if (entity.mesh && entity.mesh.position) return entity.mesh.position;
    return entity.position || null;
  }

  function setEntityPosition(entity, position) {
    const target = entityPosition(entity);
    if (target) assignPosition(target, position);
    else if (entity) entity.position = copyVec(position);
  }

  function forwardFor(yaw, pitch) {
    const cp = Math.cos(pitch || 0);
    return {
      x: -Math.sin(yaw || 0) * cp,
      y: Math.sin(pitch || 0),
      z: -Math.cos(yaw || 0) * cp,
    };
  }

  function boxesOverlap(a, b) {
    if (!a || !b || !a.min || !b.min || !a.max || !b.max) return false;
    if (typeof a.intersectsBox === 'function') {
      try {
        return !!a.intersectsBox(b);
      } catch (_) {
        // Fall through to numeric overlap.
      }
    }
    return (
      a.min.x <= b.max.x &&
      a.max.x >= b.min.x &&
      a.min.y <= b.max.y &&
      a.max.y >= b.min.y &&
      a.min.z <= b.max.z &&
      a.max.z >= b.min.z
    );
  }

  function localToWorld(vehicle, offset) {
    const cy = Math.cos(vehicle.yaw || 0);
    const sy = Math.sin(vehicle.yaw || 0);
    const cp = Math.cos(vehicle.pitch || 0);
    const sp = Math.sin(vehicle.pitch || 0);
    const x1 = offset.x;
    const y1 = offset.y * cp - offset.z * sp;
    const z1 = offset.y * sp + offset.z * cp;
    return {
      x: vehicle.position.x + x1 * cy + z1 * sy,
      y: vehicle.position.y + y1,
      z: vehicle.position.z - x1 * sy + z1 * cy,
    };
  }

  function cloneWeaponState(state) {
    return {
      cooldown: finite(state.cooldown, 0),
      ammo: state.ammo == null ? null : state.ammo,
      mag: state.mag == null ? null : state.mag,
      reserve: state.reserve == null ? null : state.reserve,
      reloadTimer: finite(state.reloadTimer, 0),
      reserveRegenTimer: finite(state.reserveRegenTimer, 0),
      heat: finite(state.heat, 0),
      overheated: !!state.overheated,
    };
  }

  const MODEL_CACHE = {
    three: null,
    geometries: Object.create(null),
    materials: Object.create(null),
  };

  function ensureModelCache(THREE) {
    if (MODEL_CACHE.three === THREE) return;
    MODEL_CACHE.three = THREE;
    MODEL_CACHE.geometries = Object.create(null);
    MODEL_CACHE.materials = Object.create(null);
  }

  function cachedBox(THREE, width, height, depth) {
    ensureModelCache(THREE);
    const key = width + ':' + height + ':' + depth;
    if (!MODEL_CACHE.geometries[key]) {
      MODEL_CACHE.geometries[key] = new THREE.BoxGeometry(width, height, depth);
    }
    return MODEL_CACHE.geometries[key];
  }

  function cachedCylinder(THREE, radius, depth, segments) {
    ensureModelCache(THREE);
    const key = 'cyl:' + radius + ':' + depth + ':' + segments;
    if (!MODEL_CACHE.geometries[key]) {
      MODEL_CACHE.geometries[key] = new THREE.CylinderGeometry(
        radius,
        radius,
        depth,
        segments || 8
      );
    }
    return MODEL_CACHE.geometries[key];
  }

  function cachedMaterial(THREE, color) {
    ensureModelCache(THREE);
    const key = String(color);
    if (!MODEL_CACHE.materials[key]) {
      MODEL_CACHE.materials[key] = new THREE.MeshLambertMaterial({ color: color });
    }
    return MODEL_CACHE.materials[key];
  }

  function addBox(THREE, parent, size, position, color, name, rotation) {
    const mesh = new THREE.Mesh(
      cachedBox(THREE, size[0], size[1], size[2]),
      cachedMaterial(THREE, color)
    );
    mesh.position.set(position[0], position[1], position[2]);
    if (rotation) {
      mesh.rotation.set(rotation[0] || 0, rotation[1] || 0, rotation[2] || 0);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (name) mesh.name = name;
    parent.add(mesh);
    return mesh;
  }

  function addCylinder(THREE, parent, radius, depth, position, color, name) {
    const mesh = new THREE.Mesh(
      cachedCylinder(THREE, radius, depth, 8),
      cachedMaterial(THREE, color)
    );
    mesh.position.set(position[0], position[1], position[2]);
    mesh.rotation.z = Math.PI / 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (name) mesh.name = name;
    parent.add(mesh);
    return mesh;
  }

  function addVoxelWheels(THREE, root, x, zList, radius) {
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < zList.length; i++) {
        addBox(
          THREE,
          root,
          [0.42, radius * 1.55, radius * 1.55],
          [side * x, radius * 0.78, zList[i]],
          0x171a1d,
          'Wheel'
        );
      }
    }
  }

  function createVehicleModel(type, team) {
    const THREE = global.THREE;
    const def = VEHICLE_DEFS[type];
    if (!THREE || !def) return null;
    ensureModelCache(THREE);

    const root = new THREE.Group();
    root.name = 'Vehicle_' + type;
    const teamMark = team === 'enemy' ? 0xb43f36 : 0x3d8fbd;
    const armor = team === 'enemy' ? 0x66564d : 0x77775b;
    const armorLight = team === 'enemy' ? 0x806a5d : 0x99977a;
    const armorDark = team === 'enemy' ? 0x443b37 : 0x484b3c;
    const trackColor = 0x20221f;
    const wheelColor = 0x30322d;
    const glass = 0x6f8990;
    let turret = null;
    let barrel = null;
    let gunnerTurret = null;
    let gunnerBarrel = null;

    if (type === 'jeep') {
      addBox(THREE, root, [2.18, 0.34, 4.12], [0, 0.58, 0], armorDark, 'Frame');
      addBox(THREE, root, [2.02, 0.48, 1.6], [0, 0.94, -1.16], armor, 'Hood', [-0.06, 0, 0]);
      addBox(THREE, root, [2.1, 0.18, 0.2], [0, 0.72, -2.13], armorLight, 'FrontBumper');
      addBox(THREE, root, [1.76, 0.08, 1.25], [0, 1.2, -1.18], armorLight, 'HoodPanel');
      addBox(THREE, root, [1.88, 0.18, 2.2], [0, 0.88, 0.72], armor, 'CabinFloor');
      addBox(THREE, root, [1.72, 0.55, 0.08], [0, 1.5, -0.34], glass, 'Windshield', [-0.16, 0, 0]);
      addBox(THREE, root, [0.1, 1.05, 0.1], [-0.9, 1.4, -0.25], armorDark, 'RollBarFL');
      addBox(THREE, root, [0.1, 1.05, 0.1], [0.9, 1.4, -0.25], armorDark, 'RollBarFR');
      addBox(THREE, root, [0.1, 1.05, 0.1], [-0.9, 1.4, 1.45], armorDark, 'RollBarRL');
      addBox(THREE, root, [0.1, 1.05, 0.1], [0.9, 1.4, 1.45], armorDark, 'RollBarRR');
      addBox(THREE, root, [0.1, 0.1, 1.78], [-0.9, 1.92, 0.6], armorDark, 'RollRailL');
      addBox(THREE, root, [0.1, 0.1, 1.78], [0.9, 1.92, 0.6], armorDark, 'RollRailR');
      addBox(THREE, root, [1.88, 0.1, 0.1], [0, 1.92, -0.25], armorDark, 'RollRailF');
      addBox(THREE, root, [1.88, 0.1, 0.1], [0, 1.92, 1.45], armorDark, 'RollRailR');
      addBox(THREE, root, [0.62, 0.48, 0.5], [-0.5, 1.13, 0.2], armorDark, 'DriverSeat');
      addBox(THREE, root, [0.62, 0.48, 0.5], [0.5, 1.13, 0.2], armorDark, 'FrontSeat');
      addBox(THREE, root, [1.72, 0.38, 0.42], [0, 1.06, 1.15], armorDark, 'RearBench');
      for (let side = -1; side <= 1; side += 2) {
        addCylinder(THREE, root, 0.58, 0.4, [side * 1.08, 0.62, -1.35], wheelColor, 'Wheel');
        addCylinder(THREE, root, 0.58, 0.4, [side * 1.08, 0.62, 1.3], wheelColor, 'Wheel');
      }
      addBox(THREE, root, [0.42, 0.4, 0.16], [-0.63, 1.0, -2.08], 0xffe6a0, 'HeadlightL');
      addBox(THREE, root, [0.42, 0.4, 0.16], [0.63, 1.0, -2.08], 0xffe6a0, 'HeadlightR');
      addBox(THREE, root, [0.65, 0.28, 0.08], [0, 1.15, 2.08], teamMark, 'TeamMark');
    } else if (type === 'ifv') {
      addBox(THREE, root, [2.95, 0.65, 5.85], [0, 0.82, 0], armorDark, 'HullLower');
      addBox(THREE, root, [2.82, 0.62, 4.75], [0, 1.32, 0.08], armor, 'HullMid');
      addBox(THREE, root, [2.62, 0.5, 1.62], [0, 1.62, -2.0], armorLight, 'Glacis', [-0.18, 0, 0]);
      addBox(THREE, root, [2.56, 0.32, 2.65], [0, 1.72, 0.42], armor, 'RoofDeck');
      addBox(THREE, root, [2.5, 1.02, 0.16], [0, 1.34, 2.82], armorDark, 'RearDoor');
      addBox(THREE, root, [0.42, 0.78, 6.2], [-1.48, 0.62, 0], trackColor, 'TrackLeft');
      addBox(THREE, root, [0.42, 0.78, 6.2], [1.48, 0.62, 0], trackColor, 'TrackRight');
      const ifvWheelZ = [-2.35, -1.42, -0.48, 0.48, 1.42, 2.35];
      for (let side = -1; side <= 1; side += 2) {
        for (let i = 0; i < ifvWheelZ.length; i++) {
          addCylinder(THREE, root, 0.43, 0.18, [side * 1.7, 0.58, ifvWheelZ[i]], wheelColor, 'RoadWheel');
        }
        for (let panel = 0; panel < 4; panel++) {
          addBox(
            THREE,
            root,
            [0.16, 0.62, 1.38],
            [side * 1.66, 1.03, -2.05 + panel * 1.38],
            armor,
            'SideSkirt'
          );
        }
      }
      turret = new THREE.Group();
      turret.name = 'Turret';
      turret.position.set(0, 2.03, -0.48);
      root.add(turret);
      addBox(THREE, turret, [1.82, 0.5, 1.75], [0, 0.12, 0], armor, 'TurretBody');
      addBox(THREE, turret, [1.4, 0.32, 1.25], [0, 0.46, 0.12], armorLight, 'TurretRoof');
      addBox(THREE, turret, [0.42, 0.22, 0.46], [-0.48, 0.72, 0.05], armorDark, 'CommanderOptic');
      barrel = new THREE.Group();
      barrel.name = 'BarrelPivot';
      barrel.position.set(0, 0.25, -0.8);
      turret.add(barrel);
      addBox(THREE, barrel, [0.28, 0.28, 2.75], [0, 0, -1.37], 0x30383b, 'CannonBarrel');
      addBox(THREE, barrel, [0.42, 0.38, 0.42], [0, 0, -2.72], armorDark, 'MuzzleBrake');
      addBox(THREE, turret, [0.55, 0.48, 1.25], [1.05, 0.3, 0.05], armorDark, 'MissilePod');
      addBox(THREE, turret, [0.13, 0.13, 1.35], [0.92, 0.33, -0.08], 0x22282a, 'MissileTubeA');
      addBox(THREE, turret, [0.13, 0.13, 1.35], [1.18, 0.33, -0.08], 0x22282a, 'MissileTubeB');
      addBox(THREE, root, [0.24, 0.2, 0.1], [-0.85, 1.7, -2.45], 0xb8d8d8, 'DriverOptic');
      addBox(THREE, root, [0.52, 0.22, 0.08], [0, 1.35, 2.96], teamMark, 'TeamMark');
      gunnerTurret = new THREE.Group();
      gunnerTurret.name = 'GunnerTurret';
      gunnerTurret.position.set(-0.82, 2.58, 0.25);
      root.add(gunnerTurret);
      addBox(THREE, gunnerTurret, [0.5, 0.3, 0.5], [0, 0, 0], armorLight, 'GunnerMount');
      gunnerBarrel = new THREE.Group();
      gunnerBarrel.position.set(0, 0.08, -0.2);
      gunnerTurret.add(gunnerBarrel);
      addBox(THREE, gunnerBarrel, [0.16, 0.16, 1.35], [0, 0, -0.67], 0x30383b, 'GrenadeBarrel');
    } else {
      addBox(THREE, root, [3.3, 0.68, 6.55], [0, 0.8, 0.08], armorDark, 'HullLower');
      addBox(THREE, root, [3.0, 0.58, 4.75], [0, 1.32, 0.28], armor, 'HullMid');
      addBox(THREE, root, [2.9, 0.58, 1.82], [0, 1.55, -2.15], armorLight, 'Glacis', [-0.2, 0, 0]);
      addBox(THREE, root, [2.78, 0.28, 2.8], [0, 1.66, 0.68], armor, 'EngineDeck');
      addBox(THREE, root, [2.65, 0.82, 0.2], [0, 1.25, 3.18], armorDark, 'RearArmor');
      addBox(THREE, root, [0.52, 0.88, 6.85], [-1.67, 0.62, 0], trackColor, 'TrackLeft');
      addBox(THREE, root, [0.52, 0.88, 6.85], [1.67, 0.62, 0], trackColor, 'TrackRight');
      const tankWheelZ = [-2.72, -1.82, -0.91, 0, 0.91, 1.82, 2.72];
      for (let side = -1; side <= 1; side += 2) {
        for (let i = 0; i < tankWheelZ.length; i++) {
          addCylinder(THREE, root, 0.44, 0.22, [side * 1.9, 0.61, tankWheelZ[i]], wheelColor, 'RoadWheel');
        }
        for (let panel = 0; panel < 5; panel++) {
          addBox(
            THREE,
            root,
            [0.18, 0.72, 1.28],
            [side * 1.86, 1.08, -2.55 + panel * 1.28],
            panel % 2 ? armor : armorLight,
            'SideSkirt'
          );
        }
      }
      for (let grille = -1; grille <= 1; grille++) {
        addBox(THREE, root, [0.68, 0.08, 1.15], [grille * 0.83, 1.86, 1.5], armorDark, 'EngineGrille');
      }
      turret = new THREE.Group();
      turret.name = 'Turret';
      turret.position.set(0, 2.08, -0.42);
      root.add(turret);
      addBox(THREE, turret, [2.5, 0.62, 2.45], [0, 0.25, 0], armor, 'TurretBody');
      addBox(THREE, turret, [2.18, 0.48, 1.5], [0, 0.45, 0.72], armorDark, 'TurretBustle');
      addBox(THREE, turret, [2.0, 0.35, 1.3], [0, 0.63, -0.52], armorLight, 'TurretRoof', [-0.08, 0, 0]);
      addBox(THREE, turret, [0.78, 0.34, 0.72], [-0.55, 0.96, 0.18], armor, 'CommanderCupola');
      addBox(THREE, turret, [0.62, 0.12, 0.58], [-0.55, 1.16, 0.18], armorLight, 'CommanderHatch');
      addBox(THREE, turret, [0.32, 0.4, 0.38], [0.52, 0.92, -0.25], armorDark, 'GunnerSight');
      barrel = new THREE.Group();
      barrel.name = 'BarrelPivot';
      barrel.position.set(0, 0.38, -1.15);
      turret.add(barrel);
      addBox(THREE, barrel, [0.34, 0.34, 4.85], [0, 0, -2.42], 0x303638, 'MainBarrel');
      addBox(THREE, barrel, [0.5, 0.46, 0.65], [0, 0, -4.7], armorDark, 'MuzzleBrake');
      addBox(THREE, turret, [0.14, 0.14, 2.3], [0.42, 0.45, -1.8], 0x242a2c, 'CoaxBarrel');
      for (let side = -1; side <= 1; side += 2) {
        addBox(THREE, turret, [0.18, 0.18, 0.55], [side * 1.28, 0.52, -0.2], 0x353a34, 'SmokeLauncher', [0, side * 0.25, side * 0.16]);
        addBox(THREE, turret, [0.08, 1.5, 0.08], [side * 0.72, 1.5, 0.82], 0x262b29, 'Antenna', [0.08 * side, 0, 0]);
      }
      addBox(THREE, root, [0.24, 0.18, 0.08], [-0.72, 1.75, -2.72], 0xb8d8d8, 'DriverOptic');
      addBox(THREE, root, [0.58, 0.24, 0.08], [0, 1.2, 3.34], teamMark, 'TeamMark');
      gunnerTurret = new THREE.Group();
      gunnerTurret.name = 'GunnerTurret';
      gunnerTurret.position.set(-0.72, 3.15, 0.05);
      root.add(gunnerTurret);
      addBox(THREE, gunnerTurret, [0.5, 0.32, 0.55], [0, 0, 0], armor, 'GunnerMount');
      gunnerBarrel = new THREE.Group();
      gunnerBarrel.position.set(0, 0.08, -0.25);
      gunnerTurret.add(gunnerBarrel);
      addBox(THREE, gunnerBarrel, [0.13, 0.13, 1.9], [0, 0, -0.95], 0x252b2d, 'HeavyMachineGun');
    }

    root.userData = root.userData || {};
    root.userData.vehicleType = type;
    root.userData.turret = turret;
    root.userData.barrel = barrel;
    root.userData.gunnerTurret = gunnerTurret;
    root.userData.gunnerBarrel = gunnerBarrel;
    return root;
  }

  function VehicleSystem() {
    this.scene = null;
    this.world = null;
    this.root = null;
    this.onEvent = null;
    this.onWeaponHit = null;
    this.onProjectileUpdate = null;
    this.onProjectileRemoved = null;
    this.onOccupantDestroyed = null;
    this._vehicles = [];
    this.vehicles = this._vehicles;
    this._byId = Object.create(null);
    this.projectiles = [];
    this._listeners = Object.create(null);
    this._seq = 0;
    this._entitySeq = 0;
    this._projectileSeq = 0;
    this._eventSeq = 0;
  }

  VehicleSystem.prototype.on = function (type, handler) {
    if (!type || typeof handler !== 'function') return function () {};
    const list = this._listeners[type] || (this._listeners[type] = []);
    if (list.indexOf(handler) < 0) list.push(handler);
    const self = this;
    return function () {
      self.off(type, handler);
    };
  };

  VehicleSystem.prototype.off = function (type, handler) {
    const list = this._listeners[type];
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  };

  VehicleSystem.prototype._emit = function (type, data) {
    const event = {
      id: 'vehicle-event-' + ++this._eventSeq,
      type: type,
      at: Date.now(),
      data: data || {},
    };
    if (typeof this.onEvent === 'function') {
      try {
        if (this.onEvent.length >= 2) this.onEvent(type, event.data, event);
        else this.onEvent(event);
      } catch (error) {
        if (global.console && console.error) console.error('[VF] Vehicles onEvent', error);
      }
    }
    const direct = (this._listeners[type] || []).slice();
    const all = (this._listeners['*'] || []).slice();
    for (let i = 0; i < direct.length; i++) {
      try {
        direct[i](event);
      } catch (error) {
        if (global.console && console.error) console.error('[VF] Vehicles event', error);
      }
    }
    for (let i = 0; i < all.length; i++) {
      try {
        all[i](event);
      } catch (error) {
        if (global.console && console.error) console.error('[VF] Vehicles event', error);
      }
    }
    const conquest = global.VF && global.VF.Conquest;
    if (conquest && typeof conquest._emit === 'function') conquest._emit(type, event.data);
    return event;
  };

  VehicleSystem.prototype._ensureRoot = function () {
    const THREE = global.THREE;
    if (!THREE || !this.scene) return null;
    if (!this.root) {
      this.root = new THREE.Group();
      this.root.name = 'Vehicles';
      if (typeof this.scene.add === 'function') this.scene.add(this.root);
    }
    return this.root;
  };

  VehicleSystem.prototype.init = function (scene, world) {
    if (this.root && this.root.parent && this.root.parent !== scene) {
      this.root.parent.remove(this.root);
      this.root = null;
    }
    this.scene = scene || null;
    this.world = world || null;
    const root = this._ensureRoot();
    for (let i = 0; i < this._vehicles.length; i++) {
      const vehicle = this._vehicles[i];
      if (!vehicle.mesh && global.THREE) {
        vehicle.mesh = createVehicleModel(vehicle.type, vehicle.team);
        if (vehicle.mesh) {
          vehicle.mesh.userData.vehicleId = vehicle.id;
        }
      }
      if (vehicle.mesh && root && vehicle.mesh.parent !== root) root.add(vehicle.mesh);
      this._syncVisual(vehicle);
      this._syncAABB(vehicle);
    }
    this._publishWorldColliders();
    return this;
  };

  VehicleSystem.prototype._driveSampleHalf = function (def) {
    const dims = def && def.dimensions;
    return {
      halfX: (dims && dims.width ? dims.width : 2.4) * DRIVE_HALF_WIDTH,
      halfZ: (dims && dims.length ? dims.length : 4.8) * DRIVE_HALF_LENGTH,
    };
  };

  VehicleSystem.prototype._groundForSpawn = function (def, x, z, yaw) {
    const world = this.world;
    if (!world) return 0;
    if (typeof world.sampleDriveHeight === 'function') {
      try {
        const half = this._driveSampleHalf(def);
        const sample = world.sampleDriveHeight(
          x,
          z,
          half.halfX,
          half.halfZ,
          yaw || 0,
          def.maxStep
        );
        if (sample && isFinite(sample.y)) return sample.y;
      } catch (error) {
        // Fall through to simpler terrain APIs.
      }
    }
    if (typeof world.getWalkHeight === 'function') {
      const y = world.getWalkHeight(x, z);
      if (isFinite(y)) return y;
    }
    if (typeof world.getTerrainTop === 'function') {
      const y = world.getTerrainTop(x, z);
      if (isFinite(y)) return y;
    }
    return 0;
  };

  VehicleSystem.prototype._newWeaponState = function (weaponId) {
    const def = WEAPON_DEFS[weaponId];
    const mag = def && def.magSize != null ? def.magSize : null;
    return {
      id: weaponId,
      cooldown: 0,
      ammo: mag,
      mag: mag,
      reserve: def && def.reserve != null ? def.reserve : null,
      reloadTimer: 0,
      reserveRegenTimer: 0,
      heat: 0,
      overheated: false,
    };
  };

  VehicleSystem.prototype._resetWeapons = function (vehicle) {
    vehicle.weapons = Object.create(null);
    for (let i = 0; i < vehicle.def.weapons.length; i++) {
      const id = vehicle.def.weapons[i];
      vehicle.weapons[id] = this._newWeaponState(id);
    }
    vehicle.weaponState = vehicle.weapons;
  };

  VehicleSystem.prototype.spawn = function (spec) {
    spec = spec || {};
    const type = String(spec.type || spec.vehicleType || spec.kind || '').toLowerCase();
    const def = VEHICLE_DEFS[type];
    if (!def) return null;
    const id = String(spec.id || 'vehicle-' + ++this._seq);
    if (this._byId[id]) return null;

    const sourcePosition = spec.position || spec;
    const x = finite(sourcePosition.x, 0);
    const z = finite(sourcePosition.z, 0);
    const yaw = finite(spec.yaw, 0);
    const hasY = sourcePosition && sourcePosition.y != null && isFinite(Number(sourcePosition.y));
    const position = vec(x, hasY ? Number(sourcePosition.y) : this._groundForSpawn(def, x, z, yaw), z);
    const vehicle = {
      id: id,
      type: type,
      team: spec.team === 'enemy' ? 'enemy' : 'ally',
      def: def,
      position: position,
      yaw: yaw,
      pitch: finite(spec.pitch, 0),
      roll: finite(spec.roll, 0),
      speed: finite(spec.speed, 0),
      velocity: vec(0, 0, 0),
      hp: clamp(finite(spec.hp, def.maxHp), 0, def.maxHp),
      maxHp: def.maxHp,
      armorClass: def.armorClass,
      armorMul: def.armorMul,
      alive: spec.alive !== false && spec.destroyed !== true,
      destroyed: spec.destroyed === true || spec.alive === false,
      respawnTimer: Math.max(0, finite(spec.respawnTimer, 0)),
      seats: [],
      weapons: Object.create(null),
      weaponState: null,
      driverInput: {
        throttle: 0,
        steer: 0,
        brake: 0,
        handbrake: false,
        boost: false,
        slow: false,
      },
      aim: {
        yaw: yaw,
        pitch: 0,
        direction: forwardFor(yaw, 0),
        target: null,
      },
      aimByRole: {
        driver: {
          yaw: yaw,
          pitch: 0,
          direction: forwardFor(yaw, 0),
          target: null,
        },
        gunner: {
          yaw: yaw,
          pitch: 0,
          direction: forwardFor(yaw, 0),
          target: null,
        },
      },
      turretYaw: finite(spec.turretYaw, 0),
      turretPitch: finite(spec.turretPitch, 0),
      mesh: null,
      aabb: { min: vec(0, 0, 0), max: vec(0, 0, 0), vehicleId: id },
      ramSlowTimer: 0,
      spawn: {
        position: copyVec(spec.respawnPosition || position),
        yaw: finite(spec.respawnYaw, yaw),
      },
      remote: !!spec.remote,
      lastDamageResult: null,
    };
    if (!vehicle.alive) {
      vehicle.hp = 0;
      if (vehicle.respawnTimer <= 0) vehicle.respawnTimer = def.respawnSec;
    }
    for (let i = 0; i < def.seats.length; i++) {
      vehicle.seats.push({
        index: i,
        role: def.seats[i].role,
        offset: copyVec(def.seats[i].offset),
        occupant: null,
        occupantId: null,
      });
    }
    this._resetWeapons(vehicle);

    if (global.THREE) {
      vehicle.mesh = createVehicleModel(type, vehicle.team);
      if (vehicle.mesh) {
        vehicle.mesh.userData.vehicleId = id;
        const root = this._ensureRoot();
        if (root) root.add(vehicle.mesh);
      }
    }

    this._vehicles.push(vehicle);
    this._byId[id] = vehicle;
    this._syncVisual(vehicle);
    this._syncAABB(vehicle);
    this._publishWorldColliders();
    if (!spec.silent && !spec._silent) {
      this._emit('vehicle-spawned', {
        vehicleId: id,
        vehicleType: type,
        team: vehicle.team,
        position: copyVec(vehicle.position),
      });
    }
    return vehicle;
  };

  VehicleSystem.prototype.reset = function (spawnSpecs) {
    this.clear();
    const out = [];
    const list = Array.isArray(spawnSpecs) ? spawnSpecs : spawnSpecs ? [spawnSpecs] : [];
    for (let i = 0; i < list.length; i++) {
      const vehicle = this.spawn(list[i]);
      if (vehicle) out.push(vehicle);
    }
    return out;
  };

  VehicleSystem.prototype.getById = function (id) {
    if (id && typeof id === 'object') {
      if (id.id && this._byId[id.id]) return this._byId[id.id];
      if (id.vehicleId && this._byId[id.vehicleId]) return this._byId[id.vehicleId];
      return null;
    }
    return id != null ? this._byId[String(id)] || null : null;
  };

  VehicleSystem.prototype.getAll = function () {
    return this._vehicles.slice();
  };

  VehicleSystem.prototype.getProjectiles = function () {
    return this.projectiles.slice();
  };

  VehicleSystem.prototype.findNearby = function (position, maxDist, team) {
    position = entityPosition(position) || position;
    if (!position) return [];
    const limit = maxDist == null ? Infinity : Math.max(0, Number(maxDist));
    const maxSq = limit * limit;
    const found = [];
    for (let i = 0; i < this._vehicles.length; i++) {
      const vehicle = this._vehicles[i];
      if (!vehicle.alive || (team && vehicle.team !== team)) continue;
      const distSq = distanceSq(position, vehicle.position);
      if (distSq <= maxSq) found.push({ vehicle: vehicle, distSq: distSq });
    }
    found.sort(function (a, b) {
      return a.distSq - b.distSq;
    });
    return found.map(function (entry) {
      return entry.vehicle;
    });
  };

  VehicleSystem.prototype.getOpenSeat = function (vehicleOrId, preferredRole) {
    const vehicle = this.getById(vehicleOrId);
    if (!vehicle || !vehicle.alive) return null;
    if (preferredRole && typeof preferredRole === 'object') {
      preferredRole = preferredRole.role;
    }
    if (preferredRole) {
      for (let i = 0; i < vehicle.seats.length; i++) {
        const seatState = vehicle.seats[i];
        if (
          seatState.role === preferredRole &&
          !seatState.occupant &&
          seatState.occupantId == null
        ) {
          return seatState;
        }
      }
    }
    for (let i = 0; i < vehicle.seats.length; i++) {
      const seatState = vehicle.seats[i];
      if (!seatState.occupant && seatState.occupantId == null) return seatState;
    }
    return null;
  };

  VehicleSystem.prototype.getWeaponsForRole = function (vehicleOrId, role) {
    const vehicle = this.getById(vehicleOrId);
    if (!vehicle) return [];
    return vehicle.def.weapons.filter(function (id) {
      const def = WEAPON_DEFS[id];
      return def && (!role || def.role === role);
    });
  };

  VehicleSystem.prototype.canUsePersonalWeapon = function (entity) {
    const vehicle = entity && this.getById(entity.vehicleId);
    return !!(
      vehicle &&
      vehicle.alive &&
      vehicle.type === 'jeep' &&
      entity.vehicleRole === 'passenger'
    );
  };

  VehicleSystem.prototype.canUseVehicleFirstPerson = function (entity) {
    const vehicle = entity && this.getById(entity.vehicleId);
    if (!vehicle || !vehicle.alive) return false;
    if (entity.vehicleRole === 'passenger') {
      return this.getWeaponsForRole(vehicle, 'passenger').length > 0;
    }
    return entity.vehicleRole === 'driver' || entity.vehicleRole === 'gunner';
  };

  VehicleSystem.prototype.reloadWeapon = function (vehicleOrId, weaponId) {
    const vehicle = this.getById(vehicleOrId);
    const def = WEAPON_DEFS[weaponId];
    const state = vehicle && vehicle.weapons[weaponId];
    return !!(vehicle && def && state && this._beginReload(state, def));
  };

  VehicleSystem.prototype._entityId = function (entity) {
    if (!entity) return null;
    if (entity.entityId != null) return String(entity.entityId);
    if (entity.id != null) return String(entity.id);
    const game = global.VF && global.VF.game;
    if (game && game.player === entity) return 'player-local';
    if (!entity._vehicleOccupantId) {
      entity._vehicleOccupantId = 'vehicle-rider-' + ++this._entitySeq;
    }
    return entity._vehicleOccupantId;
  };

  VehicleSystem.prototype._findEntitySeat = function (entity) {
    const id = this._entityId(entity);
    for (let i = 0; i < this._vehicles.length; i++) {
      const vehicle = this._vehicles[i];
      for (let j = 0; j < vehicle.seats.length; j++) {
        const seatState = vehicle.seats[j];
        if (seatState.occupant === entity || (id && seatState.occupantId === id)) {
          return { vehicle: vehicle, seat: seatState };
        }
      }
    }
    return null;
  };

  VehicleSystem.prototype._hideMountedEntity = function (entity) {
    if (!entity || !entity.mesh || (entity.object && !entity.isAI)) return;
    if (!Object.prototype.hasOwnProperty.call(entity, '_vehiclePreviousVisible')) {
      entity._vehiclePreviousVisible = entity.mesh.visible !== false;
    }
    entity.mesh.visible = false;
  };

  VehicleSystem.prototype._restoreMountedEntity = function (entity) {
    if (!entity || !entity.mesh) return;
    if (Object.prototype.hasOwnProperty.call(entity, '_vehiclePreviousVisible')) {
      entity.mesh.visible = entity._vehiclePreviousVisible;
      delete entity._vehiclePreviousVisible;
    }
  };

  VehicleSystem.prototype._seatFromArg = function (vehicle, seatIndex) {
    if (seatIndex && typeof seatIndex === 'object' && seatIndex.index != null) {
      seatIndex = seatIndex.index;
    }
    if (typeof seatIndex === 'string' && !/^\d+$/.test(seatIndex)) {
      for (let i = 0; i < vehicle.seats.length; i++) {
        if (vehicle.seats[i].role === seatIndex) return vehicle.seats[i];
      }
      return null;
    }
    if (seatIndex == null) return this.getOpenSeat(vehicle);
    const index = Number(seatIndex);
    return Number.isInteger(index) ? vehicle.seats[index] || null : null;
  };

  VehicleSystem.prototype.getSeatWorldPosition = function (vehicleOrId, seatIndex) {
    const vehicle = this.getById(vehicleOrId);
    if (!vehicle) return null;
    const seatState = this._seatFromArg(vehicle, seatIndex);
    return seatState ? localToWorld(vehicle, seatState.offset) : null;
  };

  VehicleSystem.prototype.mount = function (entity, vehicleOrId, seatIndex) {
    const vehicle = this.getById(vehicleOrId);
    if (!entity || !vehicle || !vehicle.alive || entity.vehicleId != null) return false;
    if (this._findEntitySeat(entity)) return false;
    const seatState = this._seatFromArg(vehicle, seatIndex);
    if (!seatState || seatState.occupant || seatState.occupantId != null) return false;

    const occupantId = this._entityId(entity);
    seatState.occupant = entity;
    seatState.occupantId = occupantId;
    entity.vehicleId = vehicle.id;
    entity.vehicleSeat = seatState.index;
    entity.vehicleRole = seatState.role;
    this._hideMountedEntity(entity);
    this._syncOccupant(vehicle, seatState);
    this._emit('vehicle-mounted', {
      vehicleId: vehicle.id,
      vehicleType: vehicle.type,
      team: vehicle.team,
      occupantId: occupantId,
      seatIndex: seatState.index,
      role: seatState.role,
    });
    return true;
  };

  VehicleSystem.prototype.switchSeat = function (entity, seatIndex) {
    if (!entity) return false;
    const current = this._findEntitySeat(entity);
    if (!current || !current.vehicle.alive) return false;
    const target = this._seatFromArg(current.vehicle, seatIndex);
    if (!target || target === current.seat) return false;
    const other = target.occupant;
    if (target.occupantId != null && (!other || !other.isAI)) return false;

    if (current.seat.role === 'driver' || target.role === 'driver') {
      current.vehicle.driverInput = {
        throttle: 0,
        steer: 0,
        brake: 1,
        handbrake: false,
        boost: false,
        slow: false,
      };
    }

    const entityId = current.seat.occupantId || this._entityId(entity);
    if (other) {
      current.seat.occupant = other;
      current.seat.occupantId = target.occupantId || this._entityId(other);
      other.vehicleId = current.vehicle.id;
      other.vehicleSeat = current.seat.index;
      other.vehicleRole = current.seat.role;
      this._syncOccupant(current.vehicle, current.seat);
    } else {
      current.seat.occupant = null;
      current.seat.occupantId = null;
    }
    target.occupant = entity;
    target.occupantId = entityId;
    entity.vehicleSeat = target.index;
    entity.vehicleRole = target.role;
    this._syncOccupant(current.vehicle, target);
    this._emit('vehicle-seat-switched', {
      vehicleId: current.vehicle.id,
      occupantId: target.occupantId,
      fromSeat: current.seat.index,
      toSeat: target.index,
      role: target.role,
    });
    return true;
  };

  VehicleSystem.prototype._exitPosition = function (vehicle, seatState, opts) {
    opts = opts || {};
    if (opts.position) return copyVec(opts.position);
    const side = opts.side != null ? (opts.side < 0 ? -1 : 1) : seatState.index % 2 ? 1 : -1;
    const local = {
      x: side * (vehicle.def.dimensions.width * 0.5 + 1.05),
      y: 0.1,
      z: clamp((seatState.offset && seatState.offset.z) || 0, -1.5, 1.5),
    };
    const position = localToWorld(vehicle, local);
    const world = this.world;
    if (world) {
      let y = null;
      if (typeof world.getWalkHeight === 'function') y = world.getWalkHeight(position.x, position.z);
      if (!isFinite(y) && typeof world.getTerrainTop === 'function') {
        y = world.getTerrainTop(position.x, position.z);
      }
      if (isFinite(y)) position.y = y + 0.05;
    }
    return position;
  };

  VehicleSystem.prototype._detachSeat = function (vehicle, seatState, opts) {
    opts = opts || {};
    const entity = seatState.occupant;
    const occupantId = seatState.occupantId;
    const exit = this._exitPosition(vehicle, seatState, opts);
    if (seatState.role === 'driver') {
      vehicle.driverInput = {
        throttle: 0,
        steer: 0,
        brake: 1,
        handbrake: false,
        boost: false,
        slow: false,
      };
    }
    seatState.occupant = null;
    seatState.occupantId = null;
    if (entity) {
      if (entity.vehicleId === vehicle.id || entity.vehicleId == null) {
        entity.vehicleId = null;
        entity.vehicleSeat = null;
        entity.vehicleRole = null;
      }
      setEntityPosition(entity, exit);
      this._restoreMountedEntity(entity);
    }
    if (!opts.silent) {
      this._emit('vehicle-dismounted', {
        vehicleId: vehicle.id,
        vehicleType: vehicle.type,
        occupantId: occupantId,
        seatIndex: seatState.index,
        role: seatState.role,
        reason: opts.reason || 'manual',
        position: copyVec(exit),
      });
    }
    return !!(entity || occupantId);
  };

  VehicleSystem.prototype.dismount = function (entity, opts) {
    if (!entity) return false;
    const current = this._findEntitySeat(entity);
    if (!current) {
      if (entity.vehicleId != null) {
        entity.vehicleId = null;
        entity.vehicleSeat = null;
        entity.vehicleRole = null;
        this._restoreMountedEntity(entity);
      }
      return false;
    }
    return this._detachSeat(current.vehicle, current.seat, opts);
  };

  VehicleSystem.prototype.setDriverInput = function (vehicleOrId, input, steer, brake) {
    const vehicle = this.getById(vehicleOrId);
    if (!vehicle) return false;
    if (typeof input === 'number') {
      input = { throttle: input, steer: steer, brake: brake };
    }
    input = input || {};
    vehicle.driverInput.throttle = clamp(finite(input.throttle, 0), -1, 1);
    vehicle.driverInput.steer = clamp(finite(input.steer, 0), -1, 1);
    vehicle.driverInput.brake = clamp(finite(input.brake, 0), 0, 1);
    vehicle.driverInput.handbrake = !!input.handbrake;
    vehicle.driverInput.boost = !!input.boost;
    vehicle.driverInput.slow = !!input.slow;
    return true;
  };

  VehicleSystem.prototype.setAim = function (vehicleOrId, aim, pitch) {
    const vehicle = this.getById(vehicleOrId);
    if (!vehicle) return null;
    aim = typeof aim === 'number' ? { yaw: aim, pitch: pitch } : aim || {};
    const role = aim.role === 'gunner' ? 'gunner' : 'driver';
    const previous =
      (vehicle.aimByRole && vehicle.aimByRole[role]) ||
      vehicle.aim;
    let direction = null;
    let target = null;

    if (aim.target) {
      target = entityPosition(aim.target) || aim.target.position || aim.target;
      if (target && target.x != null) {
        direction = {
          x: target.x - vehicle.position.x,
          y: target.y - (vehicle.position.y + vehicle.def.dimensions.height * 0.7),
          z: target.z - vehicle.position.z,
        };
      }
    } else if (aim.direction) {
      direction = aim.direction;
    } else if (
      aim.x != null &&
      aim.z != null &&
      aim.y != null &&
      aim.yaw == null &&
      aim.pitch == null
    ) {
      target = aim;
      direction = {
        x: aim.x - vehicle.position.x,
        y: aim.y - vehicle.position.y,
        z: aim.z - vehicle.position.z,
      };
    }

    let worldYaw;
    let aimPitch;
    if (direction) {
      direction = normalizeVec(direction, forwardFor(vehicle.yaw, 0));
      worldYaw = Math.atan2(-direction.x, -direction.z);
      aimPitch = Math.asin(clamp(direction.y, -1, 1));
    } else {
      const localYaw = !!aim.local;
      worldYaw = finite(aim.yaw, previous ? previous.yaw : vehicle.yaw);
      if (localYaw) worldYaw += vehicle.yaw;
      aimPitch = finite(aim.pitch, previous ? previous.pitch : 0);
      direction = forwardFor(worldYaw, aimPitch);
    }
    aimPitch = clamp(aimPitch, -12 * DEG, 45 * DEG);
    const nextAim = {
      yaw: worldYaw,
      pitch: aimPitch,
      direction: normalizeVec(direction, forwardFor(worldYaw, aimPitch)),
      target: target ? copyVec(target) : null,
    };
    vehicle.aimByRole = vehicle.aimByRole || {};
    vehicle.aimByRole[role] = nextAim;
    if (role === 'driver') {
      vehicle.turretYaw = normalizeAngle(worldYaw - vehicle.yaw);
      vehicle.turretPitch = aimPitch;
      vehicle.aim = nextAim;
    }
    this._syncVisual(vehicle);
    return {
      yaw: nextAim.yaw,
      pitch: nextAim.pitch,
      direction: copyVec(nextAim.direction),
      target: nextAim.target ? copyVec(nextAim.target) : null,
    };
  };

  VehicleSystem.prototype._sampleDrive = function (vehicle, x, z) {
    const world = this.world;
    if (!world) return { y: vehicle.position.y, climbable: true };
    if (typeof world.sampleDriveHeight === 'function') {
      try {
        const half = this._driveSampleHalf(vehicle.def);
        const sample = world.sampleDriveHeight(
          x,
          z,
          half.halfX,
          half.halfZ,
          vehicle.yaw,
          vehicle.def.maxStep
        );
        if (sample && isFinite(sample.y)) return sample;
      } catch (error) {
        // Fall through to point sampling.
      }
    }
    let y = null;
    if (typeof world.getTerrainTop === 'function') y = world.getTerrainTop(x, z);
    else if (typeof world.getWalkHeight === 'function') y = world.getWalkHeight(x, z);
    return { y: isFinite(y) ? y : vehicle.position.y, climbable: true };
  };

  VehicleSystem.prototype._driveLength = function (vehicle) {
    return Math.max(0.8, vehicle.def.dimensions.length * (DRIVE_HALF_LENGTH * 2));
  };

  /**
   * Pose the hull on the front/rear contact line. The center is only halfway
   * up a step while the nose is on the lip and the tail is still below.
   */
  VehicleSystem.prototype._drivePoseFromSample = function (vehicle, sample) {
    const fallbackY = isFinite(sample && sample.y) ? sample.y : vehicle.position.y;
    const frontY = sample && isFinite(sample.frontY) ? sample.frontY : fallbackY;
    const rearY = sample && isFinite(sample.rearY) ? sample.rearY : fallbackY;
    const rise = frontY - rearY;
    const pitch = clamp(
      Math.atan2(rise, this._driveLength(vehicle)),
      -MAX_DRIVE_DOWN_PITCH,
      MAX_DRIVE_PITCH
    );
    return {
      y: (frontY + rearY) * 0.5,
      pitch: pitch,
      frontY: frontY,
      rearY: rearY,
      rise: rise,
      hasContacts: !!(sample && isFinite(sample.frontY) && isFinite(sample.rearY)),
    };
  };

  VehicleSystem.prototype._driveUphillBlocked = function (vehicle, sample, pose, currentY) {
    if (!sample || !pose) return false;
    const leadingY = vehicle.speed < -0.05 ? pose.rearY : pose.frontY;
    const trailingY = vehicle.speed < -0.05 ? pose.frontY : pose.rearY;
    const leadingRise = leadingY - trailingY;
    const descending = leadingRise <= 0.03 && pose.y <= currentY + 0.03;
    if (!pose.hasContacts) {
      return sample.climbable === false && !descending;
    }
    if (descending || leadingRise <= 0.03) return false;
    if (sample.climbable === false) return true;
    if (leadingRise > vehicle.def.maxStep + 1e-4) return true;
    return Math.atan2(leadingRise, this._driveLength(vehicle)) > MAX_DRIVE_PITCH + 1e-4;
  };

  VehicleSystem.prototype._applyDrivePitch = function (vehicle, targetPitch, dt) {
    vehicle.pitch = approach(
      vehicle.pitch || 0,
      targetPitch || 0,
      DRIVE_PITCH_RATE * Math.max(0.016, dt)
    );
  };

  VehicleSystem.prototype._worldLimits = function (vehicle) {
    const world = this.world;
    if (!world) return null;
    const radius = Math.max(vehicle.def.dimensions.width, vehicle.def.dimensions.length) * 0.5;
    if (world.bounds && world.bounds.min && world.bounds.max) {
      return {
        minX: finite(world.bounds.min.x, -Infinity) + radius,
        maxX: finite(world.bounds.max.x, Infinity) - radius,
        minZ: finite(world.bounds.min.z, -Infinity) + radius,
        maxZ: finite(world.bounds.max.z, Infinity) - radius,
      };
    }
    if (isFinite(world.worldSize)) {
      return {
        minX: radius,
        maxX: world.worldSize - radius,
        minZ: radius,
        maxZ: world.worldSize - radius,
      };
    }
    if (
      isFinite(world.minX) ||
      isFinite(world.maxX) ||
      isFinite(world.minZ) ||
      isFinite(world.maxZ)
    ) {
      return {
        minX: finite(world.minX, -Infinity) + radius,
        maxX: finite(world.maxX, Infinity) - radius,
        minZ: finite(world.minZ, -Infinity) + radius,
        maxZ: finite(world.maxZ, Infinity) - radius,
      };
    }
    return null;
  };

  VehicleSystem.prototype._clampToWorld = function (vehicle) {
    const limits = this._worldLimits(vehicle);
    if (!limits) return;
    const oldX = vehicle.position.x;
    const oldZ = vehicle.position.z;
    vehicle.position.x = clamp(vehicle.position.x, limits.minX, limits.maxX);
    vehicle.position.z = clamp(vehicle.position.z, limits.minZ, limits.maxZ);
    if (oldX !== vehicle.position.x || oldZ !== vehicle.position.z) vehicle.speed *= 0.25;
  };

  VehicleSystem.prototype._driveExtents = function (vehicle, x, y, z) {
    const dims = vehicle.def.dimensions;
    const c = Math.abs(Math.cos(vehicle.yaw || 0));
    const s = Math.abs(Math.sin(vehicle.yaw || 0));
    const halfX = c * dims.width * 0.43 + s * dims.length * 0.43;
    const halfZ = s * dims.width * 0.43 + c * dims.length * 0.43;
    return {
      min: { x: x - halfX, y: y + 0.18, z: z - halfZ },
      max: { x: x + halfX, y: y + dims.height * 0.88, z: z + halfZ },
    };
  };

  VehicleSystem.prototype._asOverlapBox = function (
    extents,
    vehicle,
    ignoreVehicleColliders,
    ignoreTerrain
  ) {
    let box;
    if (global.THREE && global.THREE.Box3 && global.THREE.Vector3) {
      box =
        this._driveBox ||
        (this._driveBox = new global.THREE.Box3(
          new global.THREE.Vector3(),
          new global.THREE.Vector3()
        ));
      box.min.set(extents.min.x, extents.min.y, extents.min.z);
      box.max.set(extents.max.x, extents.max.y, extents.max.z);
    } else {
      box = {
        min: { x: extents.min.x, y: extents.min.y, z: extents.min.z },
        max: { x: extents.max.x, y: extents.max.y, z: extents.max.z },
      };
    }
    box.excludeVehicleId = vehicle.id;
    box.ignoreVehicleColliders = !!ignoreVehicleColliders;
    box.ignoreTerrain = !!ignoreTerrain;
    return box;
  };

  VehicleSystem.prototype._wouldHitWorld = function (
    vehicle,
    x,
    y,
    z,
    ignoreVehicleColliders,
    ignoreTerrain
  ) {
    const world = this.world;
    if (!world || typeof world.overlapsSolid !== 'function') return false;
    const extents = this._driveExtents(vehicle, x, y, z);
    const box = this._asOverlapBox(
      extents,
      vehicle,
      ignoreVehicleColliders,
      ignoreTerrain
    );
    try {
      return !!world.overlapsSolid(box);
    } catch (_) {
      return false;
    }
  };

  VehicleSystem.prototype._expandExtentsAlong = function (extents, dx, dz, extra) {
    const out = {
      min: { x: extents.min.x, y: extents.min.y, z: extents.min.z },
      max: { x: extents.max.x, y: extents.max.y, z: extents.max.z },
    };
    const len = Math.hypot(dx, dz);
    if (len < EPS || extra <= 0) return out;
    const nx = (dx / len) * extra;
    const nz = (dz / len) * extra;
    if (nx >= 0) out.max.x += nx;
    else out.min.x += nx;
    if (nz >= 0) out.max.z += nz;
    else out.min.z += nz;
    return out;
  };

  VehicleSystem.prototype._isRamVoxel = function (x, y, z) {
    const world = this.world;
    if (!world) return false;
    x = Math.floor(x);
    y = Math.floor(y);
    z = Math.floor(z);
    if (typeof world._isStructureSolid === 'function') {
      try {
        return !!world._isStructureSolid(x, y, z);
      } catch (_) {
        return false;
      }
    }
    if (typeof world.get !== 'function') return false;
    const t = world.get(x, y, z);
    if (!t) return false;
    const BLOCK = global.VF && global.VF.BLOCK;
    if (BLOCK) {
      if (t === BLOCK.AIR || t === BLOCK.WATER || t === BLOCK.BEDROCK) return false;
    }
    if (typeof world._isTerrainFill === 'function') {
      try {
        if (world._isTerrainFill(x, y, z)) return false;
      } catch (_) {
        // Treat unknown fill checks as smashable structure.
      }
    }
    if (typeof world._isSolid === 'function') {
      try {
        return !!world._isSolid(x, y, z);
      } catch (_) {
        return true;
      }
    }
    return true;
  };

  VehicleSystem.prototype._breakRamVoxel = function (x, y, z) {
    const world = this.world;
    if (!world) return false;
    x = Math.floor(x);
    y = Math.floor(y);
    z = Math.floor(z);
    if (typeof world.breakBlock === 'function') {
      try {
        return !!world.breakBlock(x, y, z, { force: true });
      } catch (_) {
        return false;
      }
    }
    if (typeof world.set !== 'function') return false;
    const BLOCK = global.VF && global.VF.BLOCK;
    world.set(x, y, z, BLOCK && BLOCK.AIR != null ? BLOCK.AIR : 0);
    return true;
  };

  VehicleSystem.prototype._tryRamObstacles = function (vehicle, x, y, z, travelX, travelZ) {
    const world = this.world;
    const def = vehicle.def;
    if (!world || !def || !def.canRam) return false;
    if (Math.abs(vehicle.speed) < RAM_MIN_SPEED) return false;
    const extents = this._expandExtentsAlong(
      this._driveExtents(vehicle, x, y, z),
      travelX,
      travelZ,
      RAM_LOOKAHEAD
    );
    const voxels = [];
    const seen = Object.create(null);
    const minX = Math.floor(extents.min.x);
    const maxX = Math.floor(extents.max.x);
    const minY = Math.floor(extents.min.y);
    const maxY = Math.floor(extents.max.y);
    const minZ = Math.floor(extents.min.z);
    const maxZ = Math.floor(extents.max.z);
    const size = isFinite(world.worldSize) ? world.worldSize : Infinity;
    const height = isFinite(world.height) ? world.height : 96;
    for (let vx = minX; vx <= maxX; vx++) {
      if (vx < 0 || vx >= size) continue;
      for (let vz = minZ; vz <= maxZ; vz++) {
        if (vz < 0 || vz >= size) continue;
        for (let vy = minY; vy <= maxY; vy++) {
          if (vy < 0 || vy >= height) continue;
          if (!this._isRamVoxel(vx, vy, vz)) continue;
          const key = vx + ',' + vy + ',' + vz;
          if (seen[key]) continue;
          seen[key] = 1;
          voxels.push({ x: vx, y: vy, z: vz });
          if (voxels.length >= RAM_MAX_VOXELS) break;
        }
        if (voxels.length >= RAM_MAX_VOXELS) break;
      }
      if (voxels.length >= RAM_MAX_VOXELS) break;
    }

    const props = [];
    const list = world.props || [];
    const ramBox = {
      min: extents.min,
      max: extents.max,
    };
    for (let i = 0; i < list.length; i++) {
      const prop = list[i];
      if (!prop || !prop.box || !boxesOverlap(ramBox, prop.box)) continue;
      props.push(prop);
    }

    if (!voxels.length && !props.length) return false;

    const brokenVoxels = [];
    for (let i = 0; i < voxels.length; i++) {
      const voxel = voxels[i];
      if (this._breakRamVoxel(voxel.x, voxel.y, voxel.z)) brokenVoxels.push(voxel);
    }

    const brokenProps = [];
    for (let i = 0; i < props.length; i++) {
      const prop = props[i];
      let destroyed = false;
      if (typeof world.destroyProp === 'function') {
        try {
          destroyed = !!world.destroyProp(prop);
        } catch (_) {
          destroyed = false;
        }
      }
      if (!destroyed) continue;
      const box = prop.box;
      brokenProps.push({
        x: (box.min.x + box.max.x) * 0.5,
        y: (box.min.y + box.max.y) * 0.5,
        z: (box.min.z + box.max.z) * 0.5,
        kind: prop.kind || 'prop',
      });
    }

    if (!brokenVoxels.length && !brokenProps.length) return false;

    const alreadySlow = (vehicle.ramSlowTimer || 0) > 0;
    vehicle.ramSlowTimer = RAM_SLOW_DURATION;
    if (!alreadySlow) vehicle.speed *= RAM_SLOW_FACTOR;

    const payload = {
      vehicleId: vehicle.id,
      vehicleType: vehicle.type,
      team: vehicle.team,
      position: copyVec(vehicle.position),
      speed: vehicle.speed,
      voxels: brokenVoxels,
      props: brokenProps,
    };
    if (typeof this.onRamBreak === 'function') {
      try {
        this.onRamBreak(vehicle, payload);
      } catch (error) {
        if (global.console && console.error) console.error('[VF] Vehicles onRamBreak', error);
      }
    }
    this._emit('vehicle-ram-break', payload);
    return true;
  };

  VehicleSystem.prototype._updateMovement = function (vehicle, dt) {
    const input = vehicle.driverInput;
    const def = vehicle.def;
    let speedScale = input.slow ? 0.34 : input.boost ? 1.24 : 1;
    if ((vehicle.ramSlowTimer || 0) > 0) {
      speedScale *= RAM_SLOW_FACTOR;
      vehicle.ramSlowTimer = Math.max(0, vehicle.ramSlowTimer - dt);
    }
    let target = input.throttle >= 0
      ? input.throttle * def.maxSpeed
      : input.throttle * def.reverseSpeed;
    target *= speedScale;
    if (input.brake > 0 || input.handbrake) target = 0;
    const slowing =
      Math.abs(target) < Math.abs(vehicle.speed) ||
      input.brake > 0 ||
      input.handbrake;
    const rate = slowing ? def.braking : def.acceleration;
    vehicle.speed = approach(vehicle.speed, target, rate * dt);
    if (Math.abs(input.throttle) < EPS && input.brake <= 0 && !input.handbrake) {
      vehicle.speed = approach(vehicle.speed, 0, def.acceleration * 0.35 * dt);
    }

    const speedRatio = clamp(Math.abs(vehicle.speed) / Math.max(1, def.maxSpeed), 0, 1);
    const reverseSign = vehicle.speed < -0.05 ? -1 : 1;
    vehicle.yaw = normalizeAngle(
      vehicle.yaw -
        input.steer *
          def.turnRate *
          (0.18 + speedRatio * 0.82) *
          reverseSign *
          dt
    );

    const forward = forwardFor(vehicle.yaw, 0);
    let nextX = vehicle.position.x + forward.x * vehicle.speed * dt;
    let nextZ = vehicle.position.z + forward.z * vehicle.speed * dt;
    let sample = this._sampleDrive(vehicle, nextX, nextZ);
    let pose = this._drivePoseFromSample(vehicle, sample);
    let nextY = isFinite(pose.y) ? pose.y : vehicle.position.y;
    let uphillBlocked = this._driveUphillBlocked(
      vehicle,
      sample,
      pose,
      vehicle.position.y
    );
    // Terrain is owned by the front/rear contact pose; only structures/props block.
    let blocked =
      uphillBlocked ||
      this._wouldHitWorld(vehicle, nextX, nextY, nextZ, false, true);
    if (blocked && !uphillBlocked) {
      const rammed = this._tryRamObstacles(
        vehicle,
        nextX,
        nextY,
        nextZ,
        nextX - vehicle.position.x,
        nextZ - vehicle.position.z
      );
      if (rammed) {
        nextX = vehicle.position.x + forward.x * vehicle.speed * dt;
        nextZ = vehicle.position.z + forward.z * vehicle.speed * dt;
        sample = this._sampleDrive(vehicle, nextX, nextZ);
        pose = this._drivePoseFromSample(vehicle, sample);
        nextY = isFinite(pose.y) ? pose.y : vehicle.position.y;
      }
      uphillBlocked = this._driveUphillBlocked(
        vehicle,
        sample,
        pose,
        vehicle.position.y
      );
      blocked =
        uphillBlocked ||
        this._wouldHitWorld(vehicle, nextX, nextY, nextZ, false, true);
    }
    if (blocked) {
      vehicle.speed = approach(vehicle.speed, 0, def.braking * dt);
      const currentSample = this._sampleDrive(
        vehicle,
        vehicle.position.x,
        vehicle.position.z
      );
      const currentPose = this._drivePoseFromSample(vehicle, currentSample);
      if (isFinite(currentPose.y)) vehicle.position.y = currentPose.y;
      this._applyDrivePitch(vehicle, currentPose.pitch, dt);
    } else {
      vehicle.position.x = nextX;
      vehicle.position.z = nextZ;
      if (isFinite(pose.y)) vehicle.position.y = pose.y;
      this._applyDrivePitch(vehicle, pose.pitch, dt);
    }
    this._clampToWorld(vehicle);
    vehicle.velocity.x = forward.x * vehicle.speed;
    vehicle.velocity.y = 0;
    vehicle.velocity.z = forward.z * vehicle.speed;
  };

  VehicleSystem.prototype._separateVehicles = function () {
    for (let i = 0; i < this._vehicles.length; i++) {
      if (this._vehicles[i].alive) this._syncAABB(this._vehicles[i]);
    }
    for (let i = 0; i < this._vehicles.length; i++) {
      const a = this._vehicles[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < this._vehicles.length; j++) {
        const b = this._vehicles[j];
        if (!b.alive) continue;
        const overlapX =
          Math.min(a.aabb.max.x, b.aabb.max.x) -
          Math.max(a.aabb.min.x, b.aabb.min.x);
        const overlapY =
          Math.min(a.aabb.max.y, b.aabb.max.y) -
          Math.max(a.aabb.min.y, b.aabb.min.y);
        const overlapZ =
          Math.min(a.aabb.max.z, b.aabb.max.z) -
          Math.max(a.aabb.min.z, b.aabb.min.z);
        if (overlapX <= 0 || overlapY <= 0 || overlapZ <= 0) continue;
        const oldAX = a.position.x;
        const oldAZ = a.position.z;
        const oldBX = b.position.x;
        const oldBZ = b.position.z;
        if (overlapX < overlapZ) {
          const sign = b.position.x >= a.position.x ? 1 : -1;
          const push = overlapX * 0.5 + 0.02;
          a.position.x -= sign * push;
          b.position.x += sign * push;
        } else {
          const sign = b.position.z >= a.position.z ? 1 : -1;
          const push = overlapZ * 0.5 + 0.02;
          a.position.z -= sign * push;
          b.position.z += sign * push;
        }
        if (
          this._wouldHitWorld(
            a,
            a.position.x,
            a.position.y,
            a.position.z,
            true,
            true
          )
        ) {
          a.position.x = oldAX;
          a.position.z = oldAZ;
        }
        if (
          this._wouldHitWorld(
            b,
            b.position.x,
            b.position.y,
            b.position.z,
            true,
            true
          )
        ) {
          b.position.x = oldBX;
          b.position.z = oldBZ;
        }
        a.speed *= 0.82;
        b.speed *= 0.82;
        this._clampToWorld(a);
        this._clampToWorld(b);
        this._syncAABB(a);
        this._syncAABB(b);
      }
    }
  };

  VehicleSystem.prototype._syncVisual = function (vehicle) {
    const mesh = vehicle.mesh;
    if (!mesh) return;
    assignPosition(mesh.position, vehicle.position);
    if (mesh.rotation) {
      mesh.rotation.x = vehicle.pitch || 0;
      mesh.rotation.y = vehicle.yaw || 0;
      mesh.rotation.z = vehicle.roll || 0;
    }
    mesh.visible = !!vehicle.alive;
    mesh.userData = mesh.userData || {};
    mesh.userData.destroyed = !vehicle.alive;
    const turret = mesh.userData.turret;
    const barrel = mesh.userData.barrel;
    const gunnerTurret = mesh.userData.gunnerTurret;
    const gunnerBarrel = mesh.userData.gunnerBarrel;
    if (turret && turret.rotation) turret.rotation.y = vehicle.turretYaw || 0;
    if (barrel && barrel.rotation) barrel.rotation.x = -(vehicle.turretPitch || 0);
    const gunnerAim =
      vehicle.aimByRole && vehicle.aimByRole.gunner;
    if (gunnerTurret && gunnerTurret.rotation && gunnerAim) {
      gunnerTurret.rotation.y = normalizeAngle(gunnerAim.yaw - vehicle.yaw);
    }
    if (gunnerBarrel && gunnerBarrel.rotation && gunnerAim) {
      gunnerBarrel.rotation.x = -(gunnerAim.pitch || 0);
    }
  };

  VehicleSystem.prototype._syncAABB = function (vehicle) {
    const dims = vehicle.def.dimensions;
    const c = Math.abs(Math.cos(vehicle.yaw || 0));
    const s = Math.abs(Math.sin(vehicle.yaw || 0));
    const halfX = c * dims.width * 0.5 + s * dims.length * 0.5;
    const halfZ = s * dims.width * 0.5 + c * dims.length * 0.5;
    vehicle.aabb.vehicleId = vehicle.id;
    vehicle.aabb.team = vehicle.team;
    vehicle.aabb.alive = vehicle.alive;
    const pitchLift = Math.abs(Math.sin(vehicle.pitch || 0)) * dims.length * 0.5;
    vehicle.aabb.min.x = vehicle.position.x - halfX;
    vehicle.aabb.min.y = vehicle.position.y - pitchLift;
    vehicle.aabb.min.z = vehicle.position.z - halfZ;
    vehicle.aabb.max.x = vehicle.position.x + halfX;
    vehicle.aabb.max.y = vehicle.position.y + dims.height + pitchLift;
    vehicle.aabb.max.z = vehicle.position.z + halfZ;
  };

  VehicleSystem.prototype._publishWorldColliders = function () {
    if (!this.world) return;
    this.world._vehicles = this._vehicles;
    const colliders = [];
    for (let i = 0; i < this._vehicles.length; i++) {
      const vehicle = this._vehicles[i];
      if (vehicle.alive) colliders.push(vehicle.aabb);
    }
    this.world._vehicleAABBs = colliders;
    this.world._vehicleColliders = colliders;
  };

  VehicleSystem.prototype._syncOccupant = function (vehicle, seatState) {
    const entity = seatState.occupant;
    if (!entity) return;
    const position = localToWorld(vehicle, seatState.offset);
    setEntityPosition(entity, position);
    entity.vehicleId = vehicle.id;
    entity.vehicleSeat = seatState.index;
    entity.vehicleRole = seatState.role;
    if (entity.object && entity.object.rotation) entity.object.rotation.y = vehicle.yaw;
    if (entity.mesh && entity.mesh.rotation) entity.mesh.rotation.y = vehicle.yaw;
    this._hideMountedEntity(entity);
  };

  VehicleSystem.prototype._syncOccupants = function (vehicle) {
    for (let i = 0; i < vehicle.seats.length; i++) {
      this._syncOccupant(vehicle, vehicle.seats[i]);
    }
  };

  VehicleSystem.prototype._updateWeaponStates = function (vehicle, dt) {
    const ids = vehicle.def.weapons;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const state = vehicle.weapons[id];
      const def = WEAPON_DEFS[id];
      if (!state || !def) continue;
      state.cooldown = Math.max(0, state.cooldown - dt);
      if (state.reloadTimer > 0) {
        state.reloadTimer = Math.max(0, state.reloadTimer - dt);
        if (state.reloadTimer <= 0 && def.magSize != null) {
          const need = def.magSize - state.mag;
          const take = Math.min(need, state.reserve || 0);
          state.mag += take;
          state.ammo = state.mag;
          if (state.reserve != null) state.reserve -= take;
        }
      }
      this._tickReserveRegen(state, def, dt);
      if (def.maxHeat != null) {
        const cool = def.heatCoolPerSec != null ? def.heatCoolPerSec : 20;
        state.heat = Math.max(0, state.heat - cool * dt);
        if (state.overheated && state.heat <= def.maxHeat * 0.35) state.overheated = false;
      }
    }
  };

  VehicleSystem.prototype._tickReserveRegen = function (state, def, dt) {
    if (!state || !def || def.reserveRegenSec == null) {
      if (state) state.reserveRegenTimer = 0;
      return;
    }
    if ((state.reserve || 0) > 0) {
      state.reserveRegenTimer = 0;
      return;
    }
    state.reserveRegenTimer = (state.reserveRegenTimer || 0) + dt;
    if (state.reserveRegenTimer + EPS < def.reserveRegenSec) return;
    const amount = def.reserveRegenAmount != null ? def.reserveRegenAmount : def.magSize || 0;
    const cap = def.reserveMax != null ? def.reserveMax : def.reserve != null ? def.reserve : amount;
    state.reserve = Math.min(cap, Math.max(0, state.reserve || 0) + amount);
    state.reserveRegenTimer = 0;
    if (state.mag <= 0 && state.reserve > 0) this._beginReload(state, def);
  };

  VehicleSystem.prototype._beginReload = function (state, def) {
    if (
      !state ||
      !def ||
      def.magSize == null ||
      state.reloadTimer > 0 ||
      state.mag >= def.magSize ||
      !state.reserve
    ) {
      return false;
    }
    state.reloadTimer = def.reloadSec || 1;
    return true;
  };

  VehicleSystem.prototype._consumeWeapon = function (state, def) {
    state.cooldown = def.cooldown || 0;
    if (def.maxHeat != null) {
      state.heat = Math.min(def.maxHeat, state.heat + (def.heatPerShot || 0));
      if (state.heat >= def.maxHeat - EPS) state.overheated = true;
    }
    if (def.magSize != null) {
      state.mag = Math.max(0, state.mag - 1);
      state.ammo = state.mag;
      if (state.mag <= 0) this._beginReload(state, def);
    }
  };

  VehicleSystem.prototype._respawn = function (vehicle) {
    for (let i = 0; i < vehicle.seats.length; i++) {
      vehicle.seats[i].occupant = null;
      vehicle.seats[i].occupantId = null;
    }
    vehicle.position = copyVec(vehicle.spawn.position);
    vehicle.yaw = vehicle.spawn.yaw;
    vehicle.pitch = 0;
    vehicle.roll = 0;
    vehicle.speed = 0;
    vehicle.ramSlowTimer = 0;
    vehicle.velocity = vec(0, 0, 0);
    vehicle.hp = vehicle.maxHp;
    vehicle.alive = true;
    vehicle.destroyed = false;
    vehicle.respawnTimer = 0;
    vehicle.driverInput = {
      throttle: 0,
      steer: 0,
      brake: 0,
      handbrake: false,
      boost: false,
      slow: false,
    };
    vehicle.turretYaw = 0;
    vehicle.turretPitch = 0;
    vehicle.aim = {
      yaw: vehicle.yaw,
      pitch: 0,
      direction: forwardFor(vehicle.yaw, 0),
      target: null,
    };
    vehicle.aimByRole = {
      driver: {
        yaw: vehicle.yaw,
        pitch: 0,
        direction: forwardFor(vehicle.yaw, 0),
        target: null,
      },
      gunner: {
        yaw: vehicle.yaw,
        pitch: 0,
        direction: forwardFor(vehicle.yaw, 0),
        target: null,
      },
    };
    this._resetWeapons(vehicle);
    this._syncVisual(vehicle);
    this._syncAABB(vehicle);
    this._emit('vehicle-respawned', {
      vehicleId: vehicle.id,
      vehicleType: vehicle.type,
      team: vehicle.team,
      hp: vehicle.hp,
      position: copyVec(vehicle.position),
    });
  };

  VehicleSystem.prototype.update = function (dt, game) {
    dt = Math.max(0, finite(dt, 0));
    for (let i = 0; i < this._vehicles.length; i++) {
      const vehicle = this._vehicles[i];
      if (!vehicle.alive) {
        vehicle.respawnTimer = Math.max(0, vehicle.respawnTimer - dt);
        if (vehicle.respawnTimer <= 0) this._respawn(vehicle);
        else {
          this._syncVisual(vehicle);
          this._syncAABB(vehicle);
        }
        continue;
      }
      this._updateWeaponStates(vehicle, dt);
      this._updateMovement(vehicle, dt);
    }
    this._separateVehicles();
    for (let i = 0; i < this._vehicles.length; i++) {
      const vehicle = this._vehicles[i];
      if (vehicle.alive) {
        this._syncVisual(vehicle);
        this._syncAABB(vehicle);
        this._syncOccupants(vehicle);
      }
    }
    this._updateProjectiles(dt, game || (global.VF && global.VF.game));
    this._publishWorldColliders();
  };

  VehicleSystem.prototype._rayAABB = function (origin, direction, box, maxDist) {
    let tMin = 0;
    let tMax = maxDist;
    let hitNormal = vec(0, 0, 0);
    const axes = ['x', 'y', 'z'];
    for (let i = 0; i < axes.length; i++) {
      const axis = axes[i];
      const o = origin[axis];
      const d = direction[axis];
      if (Math.abs(d) < EPS) {
        if (o < box.min[axis] || o > box.max[axis]) return null;
        continue;
      }
      let near = (box.min[axis] - o) / d;
      let far = (box.max[axis] - o) / d;
      let sign = -1;
      if (near > far) {
        const swap = near;
        near = far;
        far = swap;
        sign = 1;
      }
      if (near > tMin) {
        tMin = near;
        hitNormal = vec(0, 0, 0);
        hitNormal[axis] = sign;
      }
      tMax = Math.min(tMax, far);
      if (tMin > tMax) return null;
    }
    return { distance: tMin, normal: hitNormal };
  };

  VehicleSystem.prototype.raycastWorld = function (origin, direction, maxDist) {
    const world = this.world;
    origin = entityPosition(origin) || origin;
    if (!world || !origin || !direction) return null;
    direction = normalizeVec(direction);
    maxDist = Math.max(0, finite(maxDist, 0));
    const rayOrigin =
      global.THREE && global.THREE.Vector3
        ? new global.THREE.Vector3(origin.x, origin.y, origin.z)
        : origin;
    const rayDirection =
      global.THREE && global.THREE.Vector3
        ? new global.THREE.Vector3(direction.x, direction.y, direction.z)
        : direction;
    let best = null;
    let bestDist = maxDist;
    if (typeof world.raycastDoors === 'function') {
      const door = world.raycastDoors(rayOrigin, rayDirection, bestDist);
      if (door && door.dist >= 0 && door.dist < bestDist) {
        bestDist = door.dist;
        best = {
          kind: 'prop',
          distance: door.dist,
          dist: door.dist,
          point: copyVec(door.point),
          prop: door.prop,
        };
      }
    }
    if (typeof world.get === 'function') {
      let x = Math.floor(origin.x);
      let y = Math.floor(origin.y);
      let z = Math.floor(origin.z);
      const sx = direction.x > 0 ? 1 : direction.x < 0 ? -1 : 0;
      const sy = direction.y > 0 ? 1 : direction.y < 0 ? -1 : 0;
      const sz = direction.z > 0 ? 1 : direction.z < 0 ? -1 : 0;
      const dx = sx ? Math.abs(1 / direction.x) : Infinity;
      const dy = sy ? Math.abs(1 / direction.y) : Infinity;
      const dz = sz ? Math.abs(1 / direction.z) : Infinity;
      let tx =
        sx > 0
          ? (x + 1 - origin.x) * dx
          : sx < 0
            ? (origin.x - x) * dx
            : Infinity;
      let ty =
        sy > 0
          ? (y + 1 - origin.y) * dy
          : sy < 0
            ? (origin.y - y) * dy
            : Infinity;
      let tz =
        sz > 0
          ? (z + 1 - origin.z) * dz
          : sz < 0
            ? (origin.z - z) * dz
            : Infinity;
      const blocks = global.VF && global.VF.BLOCK;
      const air = blocks ? blocks.AIR : 0;
      const water = blocks ? blocks.WATER : -9999;
      let distance = 0;
      for (let i = 0; i < 800 && distance < bestDist; i++) {
        const block = world.get(x, y, z);
        if (block !== air && block !== water) {
          bestDist = distance;
          best = {
            kind: 'voxel',
            distance: distance,
            dist: distance,
            point: {
              x: origin.x + direction.x * distance,
              y: origin.y + direction.y * distance,
              z: origin.z + direction.z * distance,
            },
            x: x,
            y: y,
            z: z,
          };
          break;
        }
        if (tx < ty) {
          if (tx < tz) {
            distance = tx;
            tx += dx;
            x += sx;
          } else {
            distance = tz;
            tz += dz;
            z += sz;
          }
        } else if (ty < tz) {
          distance = ty;
          ty += dy;
          y += sy;
        } else {
          distance = tz;
          tz += dz;
          z += sz;
        }
      }
    }
    if (typeof world.raycastTerrain === 'function') {
      const terrain = world.raycastTerrain(rayOrigin, rayDirection, bestDist);
      if (terrain && terrain.dist >= 0 && terrain.dist < bestDist) {
        best = {
          kind: 'terrain',
          distance: terrain.dist,
          dist: terrain.dist,
          point: copyVec(terrain.point),
        };
      }
    }
    return best;
  };

  VehicleSystem.prototype.raycast = function (origin, direction, maxDist, filter) {
    origin = entityPosition(origin) || origin;
    if (!origin || !direction) return null;
    direction = normalizeVec(direction);
    maxDist = maxDist == null ? Infinity : Math.max(0, finite(maxDist, 0));
    const options = typeof filter === 'string' ? { team: filter } : filter || {};
    let best = null;
    for (let i = 0; i < this._vehicles.length; i++) {
      const vehicle = this._vehicles[i];
      if (
        !vehicle.alive ||
        (options.team && vehicle.team !== options.team) ||
        (options.excludeTeam && vehicle.team === options.excludeTeam) ||
        (options.excludeId && vehicle.id === options.excludeId)
      ) {
        continue;
      }
      const result = this._rayAABB(origin, direction, vehicle.aabb, best ? best.distance : maxDist);
      if (!result || result.distance < 0 || result.distance > maxDist) continue;
      best = {
        vehicle: vehicle,
        vehicleId: vehicle.id,
        distance: result.distance,
        dist: result.distance,
        point: {
          x: origin.x + direction.x * result.distance,
          y: origin.y + direction.y * result.distance,
          z: origin.z + direction.z * result.distance,
        },
        normal: result.normal,
      };
    }
    return best;
  };

      VehicleSystem.prototype.repair = function (vehicleOrId, amount) {
        const vehicle = this.getById(vehicleOrId);
        amount = Math.max(0, finite(amount, 0));
        if (!vehicle || !vehicle.alive || !(amount > 0)) return 0;
        const before = vehicle.hp;
        vehicle.hp = Math.min(vehicle.maxHp, before + amount);
        const gained = vehicle.hp - before;
        if (gained > 0) {
          this._emit('vehicle-repaired', {
            vehicleId: vehicle.id,
            vehicleType: vehicle.type,
            team: vehicle.team,
            amount: gained,
            hp: vehicle.hp,
            maxHp: vehicle.maxHp,
          });
        }
        return gained;
      };

      VehicleSystem.prototype.applyDamage = function (vehicleOrId, rawDamage, meta) {
    const vehicle = this.getById(vehicleOrId);
    meta = meta || {};
    if (!vehicle || !vehicle.alive) return 0;
    const isAntiArmor = meta.damageType === 'antiArmor';
    const isLightChip =
      meta.damageType === 'lightArmor' && vehicle.armorClass === 'light';
    const isHeavyChip =
      meta.damageType === 'heavyArmor' && vehicle.armorClass === 'heavy';
    if (!isAntiArmor && !isLightChip && !isHeavyChip) return 0;
    if (
      global.VF &&
      global.VF.MatchFlow &&
      global.VF.MatchFlow.phase === 'warmup'
    ) {
      return 0;
    }
    rawDamage = Math.max(0, finite(rawDamage, 0));
    const finalDamage = Math.max(0, Math.round(rawDamage / vehicle.armorMul));
    if (!finalDamage) return 0;
    const before = vehicle.hp;
    const applied = Math.min(before, finalDamage);
    vehicle.hp = Math.max(0, before - finalDamage);
    vehicle.lastDamageResult = {
      raw: rawDamage,
      final: finalDamage,
      applied: applied,
      before: before,
      after: vehicle.hp,
      damageType: meta.damageType,
      sourceId: meta.sourceId || (meta.source && (meta.source.entityId || meta.source.id)) || null,
      weaponId: meta.weaponId || null,
    };
    this._emit('vehicle-damaged', {
      vehicleId: vehicle.id,
      vehicleType: vehicle.type,
      team: vehicle.team,
      rawDamage: rawDamage,
      damage: finalDamage,
      appliedDamage: applied,
      hpBefore: before,
      hp: vehicle.hp,
      maxHp: vehicle.maxHp,
      damageType: meta.damageType,
      sourceId: vehicle.lastDamageResult.sourceId,
      weaponId: meta.weaponId || null,
    });
    if (vehicle.hp <= 0) this.destroy(vehicle, meta);
    return finalDamage;
  };

  VehicleSystem.prototype.destroy = function (vehicleOrId, meta) {
    const vehicle = this.getById(vehicleOrId);
    if (!vehicle || !vehicle.alive) return false;
    meta = meta || {};
    vehicle.hp = 0;
    vehicle.alive = false;
    vehicle.destroyed = true;
    vehicle.speed = 0;
    vehicle.velocity = vec(0, 0, 0);
    vehicle.driverInput = {
      throttle: 0,
      steer: 0,
      brake: 1,
      handbrake: true,
      boost: false,
      slow: false,
    };
    vehicle.respawnTimer = vehicle.def.respawnSec;
    for (let i = 0; i < vehicle.seats.length; i++) {
      if (vehicle.seats[i].occupant || vehicle.seats[i].occupantId != null) {
        if (
          vehicle.seats[i].occupant &&
          typeof this.onOccupantDestroyed === 'function'
        ) {
          try {
            this.onOccupantDestroyed(
              vehicle.seats[i].occupant,
              vehicle,
              vehicle.seats[i],
              meta
            );
          } catch (error) {
            if (global.console && console.error) {
              console.error('[VF] vehicle occupant destruction', error);
            }
          }
        }
        this._detachSeat(vehicle, vehicle.seats[i], {
          reason: 'destroyed',
          silent: !!meta.silentDismount,
        });
      }
    }
    this._syncVisual(vehicle);
    this._syncAABB(vehicle);
    this._publishWorldColliders();
    this._emit('vehicle-destroyed', {
      vehicleId: vehicle.id,
      vehicleType: vehicle.type,
      team: vehicle.team,
      respawnSec: vehicle.def.respawnSec,
      position: copyVec(vehicle.position),
      sourceId: meta.sourceId || (meta.source && (meta.source.entityId || meta.source.id)) || null,
      weaponId: meta.weaponId || null,
    });
    return true;
  };

  VehicleSystem.prototype._weaponForRole = function (vehicle, role) {
    for (let i = 0; i < vehicle.def.weapons.length; i++) {
      const id = vehicle.def.weapons[i];
      if (!role || WEAPON_DEFS[id].role === role) return id;
    }
    return null;
  };

  VehicleSystem.prototype._shotOrigin = function (vehicle, def, options) {
    if (options.origin) return copyVec(options.origin);
    const offset =
      def.muzzle ||
      {
        x: 0,
        y: vehicle.def.dimensions.height * 0.7,
        z: -vehicle.def.dimensions.length * 0.5,
      };
    const aim =
      (vehicle.aimByRole && vehicle.aimByRole[def.role]) ||
      vehicle.aim;
    const relativeYaw = normalizeAngle(
      (aim ? aim.yaw : vehicle.yaw) - vehicle.yaw
    );
    const aimPitch = aim ? aim.pitch : 0;
    const pivot = def.pivot || { x: 0, y: 0, z: 0 };
    const relative = {
      x: offset.x - pivot.x,
      y: offset.y - pivot.y,
      z: offset.z - pivot.z,
    };
    const cosPitch = Math.cos(aimPitch);
    const pitchedZ = relative.z * cosPitch;
    const rotated = {
      x:
        pivot.x +
        relative.x * Math.cos(relativeYaw) +
        pitchedZ * Math.sin(relativeYaw),
      y: pivot.y + relative.y - relative.z * Math.sin(aimPitch),
      z:
        pivot.z -
        relative.x * Math.sin(relativeYaw) +
        pitchedZ * Math.cos(relativeYaw),
    };
    return localToWorld(vehicle, rotated);
  };

  VehicleSystem.prototype.getWeaponPivotWorld = function (vehicleOrId, weaponId) {
    const vehicle = this.getById(vehicleOrId);
    const def = WEAPON_DEFS[weaponId];
    if (!vehicle || !def) return null;
    const pivot = def.pivot || {
      x: 0,
      y: vehicle.def.dimensions.height * 0.7,
      z: 0,
    };
    return this._shotOrigin(
      vehicle,
      { role: def.role, pivot: pivot, muzzle: pivot },
      {}
    );
  };

  /**
   * Camera point fixed to the front of the active turret. The turret pivot is
   * hull-local; offset rotates around it with that seat's current world aim.
   */
  VehicleSystem.prototype.getFirstPersonCameraAnchor = function (
    vehicleOrId,
    role
  ) {
    const vehicle = this.getById(vehicleOrId);
    if (!vehicle || !vehicle.def.cameraAnchors) return null;
    if (role !== 'driver' && role !== 'gunner') return null;
    const anchor = vehicle.def.cameraAnchors[role];
    if (!anchor) return null;
    const aim =
      (vehicle.aimByRole && vehicle.aimByRole[role]) ||
      vehicle.aim;
    const relativeYaw = normalizeAngle(
      finite(aim && aim.yaw, vehicle.yaw) - vehicle.yaw
    );
    const c = Math.cos(relativeYaw);
    const s = Math.sin(relativeYaw);
    const pivot = anchor.pivot;
    const offset = anchor.offset;
    return localToWorld(vehicle, {
      x: pivot.x + offset.x * c + offset.z * s,
      y: pivot.y + offset.y,
      z: pivot.z - offset.x * s + offset.z * c,
    });
  };

  VehicleSystem.prototype._shotDirection = function (vehicle, origin, options, def) {
    const roleAim =
      (vehicle.aimByRole && def && vehicle.aimByRole[def.role]) ||
      vehicle.aim;
    if (options.direction) return normalizeVec(options.direction, roleAim.direction);
    const targetEntity = options.targetVehicle || options.target;
    const target = entityPosition(targetEntity) ||
      (targetEntity && targetEntity.position) ||
      (targetEntity && targetEntity.x != null ? targetEntity : null);
    if (target) {
      const targetY = finite(target.y, vehicle.position.y);
      return normalizeVec({
        x: target.x - origin.x,
        y: targetY +
          (targetEntity && targetEntity.def ? targetEntity.def.dimensions.height * 0.5 : 0) -
          origin.y,
        z: target.z - origin.z,
      });
    }
    return normalizeVec(
      roleAim.direction,
      forwardFor(vehicle.yaw + vehicle.turretYaw, vehicle.turretPitch)
    );
  };

  VehicleSystem.prototype._resolveVehicleHit = function (shot, hit, def, options) {
    if (!hit || !hit.vehicle) return 0;
    const damage = this.applyDamage(hit.vehicle, def.damage, {
      damageType: def.damageType,
      source: options.actor || null,
      sourceId: shot.ownerId,
      sourceVehicleId: shot.vehicleId,
      weaponId: def.id,
    });
    shot.hit = {
      vehicleId: hit.vehicle.id,
      point: copyVec(hit.point),
      distance: hit.distance,
      damage: damage,
    };
    shot.damageApplied = damage;
    this._emit('vehicle-weapon-hit', {
      shotId: shot.id,
      vehicleId: hit.vehicle.id,
      sourceVehicleId: shot.vehicleId,
      weaponId: def.id,
      damageType: def.damageType,
      damage: damage,
      point: copyVec(hit.point),
    });
    if (typeof options.onHit === 'function') options.onHit(shot.hit, shot);
    if (typeof this.onWeaponHit === 'function') this.onWeaponHit(shot.hit, shot);
    return damage;
  };

  VehicleSystem.prototype.launchProjectile = function (options) {
    options = options || {};
    const def = WEAPON_DEFS[options.weaponId];
    if (!def || def.mode !== 'projectile' || !options.origin || !options.direction) {
      return null;
    }
    const owner = options.actor || null;
    const ownerId =
      options.ownerId ||
      (owner ? this._entityId(owner) : null);
    const shot = {
      id: 'vehicle-shot-' + ++this._projectileSeq,
      type: 'projectile',
      mode: 'projectile',
      vehicleId: options.vehicleId || null,
      ownerId: ownerId,
      team: options.team === 'enemy' ? 'enemy' : 'ally',
      weaponId: def.id,
      damage: def.damage,
      damageType: def.damageType,
      position: copyVec(options.origin),
      previousPosition: copyVec(options.origin),
      direction: normalizeVec(options.direction),
      speed: finite(options.speed, def.projectileSpeed),
      life: finite(options.life, def.projectileLife),
      gravity: finite(options.gravity, def.gravity || 0),
      guidance: options.guidance || def.guidance || null,
      guidanceRate: finite(options.guidanceRate, def.guidanceRate || 0),
      targetVehicleId: options.targetVehicleId || null,
      targetPoint: options.targetPoint ? copyVec(options.targetPoint) : null,
      hit: null,
      damageApplied: 0,
    };
    this.projectiles.push(shot);
    this._emit('vehicle-weapon-fired', {
      shotId: shot.id,
      mode: shot.mode,
      vehicleId: shot.vehicleId,
      team: shot.team,
      ownerId: shot.ownerId,
      weaponId: shot.weaponId,
      damageType: shot.damageType,
      origin: copyVec(shot.position),
      direction: copyVec(shot.direction),
    });
    return shot;
  };

  VehicleSystem.prototype.fireWeapon = function (
    vehicleOrId,
    weaponId,
    actorOrOptions,
    maybeOptions
  ) {
    const vehicle = this.getById(vehicleOrId);
    if (!vehicle || !vehicle.alive) return null;
    let actor = null;
    let options = {};
    if (maybeOptions) {
      actor = actorOrOptions || null;
      options = maybeOptions;
    } else if (
      actorOrOptions &&
      (!actorOrOptions.vehicleId ||
        actorOrOptions.origin ||
        actorOrOptions.direction ||
        actorOrOptions.target ||
        actorOrOptions.targetVehicle ||
        actorOrOptions.targetId ||
        actorOrOptions.actor ||
        actorOrOptions.ownerId ||
        actorOrOptions.force ||
        actorOrOptions.friendlyFire)
    ) {
      options = actorOrOptions;
      actor = options.actor || null;
    } else {
      actor = actorOrOptions || null;
    }
    options = options || {};
    weaponId = weaponId || this._weaponForRole(vehicle, actor && actor.vehicleRole);
    if (
      !weaponId ||
      vehicle.def.weapons.indexOf(weaponId) < 0 ||
      !WEAPON_DEFS[weaponId]
    ) {
      return null;
    }
    const def = WEAPON_DEFS[weaponId];
    const state = vehicle.weapons[weaponId];
    if (!state || state.cooldown > EPS || state.reloadTimer > EPS || state.overheated) return null;
    if (actor && !options.force) {
      if (
        actor.vehicleId !== vehicle.id ||
        actor.vehicleRole !== def.role
      ) {
        return null;
      }
    }
    if (def.magSize != null && state.mag <= 0) {
      this._beginReload(state, def);
      return null;
    }

    this._consumeWeapon(state, def);
    const origin = this._shotOrigin(vehicle, def, options);
    const direction = this._shotDirection(vehicle, origin, options, def);
    const ownerId = actor ? this._entityId(actor) : options.ownerId || null;
    const id = 'vehicle-shot-' + ++this._projectileSeq;
    let shot;

    if (def.mode === 'hitscan') {
      shot = {
        id: id,
        type: 'hitscan',
        mode: 'hitscan',
        vehicleId: vehicle.id,
        ownerId: ownerId,
        team: vehicle.team,
        weaponId: weaponId,
        damage: def.damage,
        damageType: def.damageType,
        origin: origin,
        direction: direction,
        range: def.range,
        hit: null,
        damageApplied: 0,
        predictOnly: !!options.predictOnly,
      };
      const hit = this.raycast(origin, direction, def.range, {
        excludeId: vehicle.id,
        excludeTeam: options.friendlyFire ? null : vehicle.team,
      });
      const worldHit = this.raycastWorld(origin, direction, def.range);
      const blocked = !!(
        worldHit &&
        (!hit || worldHit.distance <= hit.distance)
      );
      if (blocked) {
        shot.worldHit = worldHit;
      } else if (hit) {
        if (options.predictOnly) {
          shot.hit = {
            vehicleId: hit.vehicle.id,
            point: copyVec(hit.point),
            distance: hit.distance,
            damage: 0,
          };
        } else {
          this._resolveVehicleHit(shot, hit, def, options);
        }
      }
    } else {
      const targetVehicle = this.getById(
        options.targetVehicle || options.targetId || options.target
      );
      const plainTarget =
        !targetVehicle &&
        options.target &&
        options.target.x != null
          ? options.target
          : null;
      shot = {
        id: id,
        type: 'projectile',
        mode: 'projectile',
        vehicleId: vehicle.id,
        ownerId: ownerId,
        team: vehicle.team,
        weaponId: weaponId,
        damage: def.damage,
        damageType: def.damageType,
        position: copyVec(origin),
        previousPosition: copyVec(origin),
        direction: direction,
        speed: def.projectileSpeed,
        life: def.projectileLife,
        gravity: def.gravity || 0,
        guidance: def.guidance || null,
        guidanceRate: def.guidanceRate || 0,
        targetVehicleId: targetVehicle ? targetVehicle.id : null,
        targetPoint: plainTarget
          ? copyVec(plainTarget)
          : vehicle.aim.target
            ? copyVec(vehicle.aim.target)
            : null,
        hit: null,
        damageApplied: 0,
        predictOnly: !!options.predictOnly,
      };
      this.projectiles.push(shot);
    }
    this.lastShot = shot;
    this._emit('vehicle-weapon-fired', {
      shotId: shot.id,
      mode: shot.mode,
      vehicleId: vehicle.id,
      vehicleType: vehicle.type,
      team: vehicle.team,
      ownerId: ownerId,
      weaponId: weaponId,
      damageType: def.damageType,
      predictOnly: !!options.predictOnly,
      origin: copyVec(origin),
      direction: copyVec(direction),
    });
    return shot;
  };

  VehicleSystem.prototype._steerProjectile = function (projectile, dt) {
    if (!projectile.guidance) return;
    let target = null;
    if (projectile.targetVehicleId) {
      const vehicle = this.getById(projectile.targetVehicleId);
      if (vehicle && vehicle.alive) {
        target = copyVec(vehicle.position);
        target.y += vehicle.def.dimensions.height * 0.5;
      }
    }
    if (!target) target = projectile.targetPoint;
    if (!target) return;
    const desired = normalizeVec({
      x: target.x - projectile.position.x,
      y: target.y - projectile.position.y,
      z: target.z - projectile.position.z,
    }, projectile.direction);
    const blend = clamp(projectile.guidanceRate * dt, 0, 1);
    projectile.direction = normalizeVec({
      x: projectile.direction.x + (desired.x - projectile.direction.x) * blend,
      y: projectile.direction.y + (desired.y - projectile.direction.y) * blend,
      z: projectile.direction.z + (desired.z - projectile.direction.z) * blend,
    }, desired);
  };

  VehicleSystem.prototype._removeProjectile = function (index, reason) {
    const projectile = this.projectiles[index];
    if (!projectile) return;
    this.projectiles.splice(index, 1);
    if (typeof this.onProjectileRemoved === 'function') {
      this.onProjectileRemoved(projectile, reason || 'removed');
    }
    this._emit('vehicle-projectile-removed', {
      shotId: projectile.id,
      vehicleId: projectile.vehicleId,
      weaponId: projectile.weaponId,
      reason: reason || 'removed',
      position: copyVec(projectile.position),
    });
  };

  VehicleSystem.prototype._updateProjectiles = function (dt, game) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const projectile = this.projectiles[i];
      const def = WEAPON_DEFS[projectile.weaponId];
      if (!def) {
        this._removeProjectile(i, 'invalid');
        continue;
      }
      projectile.life -= dt;
      if (projectile.life <= 0) {
        this._removeProjectile(i, 'expired');
        continue;
      }
      this._steerProjectile(projectile, dt);
      if (projectile.gravity) {
        projectile.direction.y -= (projectile.gravity * dt) / Math.max(1, projectile.speed);
        projectile.direction = normalizeVec(projectile.direction);
      }
      projectile.previousPosition = copyVec(projectile.position);
      const travel = Math.max(0, projectile.speed * dt);
      const hit = this.raycast(projectile.position, projectile.direction, travel, {
        excludeId: projectile.vehicleId,
        excludeTeam: projectile.team,
      });
      const worldHit = this.raycastWorld(
        projectile.position,
        projectile.direction,
        travel
      );
      if (worldHit && (!hit || worldHit.distance <= hit.distance)) {
        projectile.position = copyVec(worldHit.point);
        projectile.worldHit = worldHit;
        if (typeof this.onProjectileUpdate === 'function') {
          this.onProjectileUpdate(projectile, dt, game);
        }
        this._removeProjectile(i, 'world-hit');
        continue;
      }
      if (hit) {
        projectile.position = copyVec(hit.point);
        projectile.vehicleHit = hit;
        if (!projectile.predictOnly) {
          this._resolveVehicleHit(projectile, hit, def, {});
        }
        if (typeof this.onProjectileUpdate === 'function') {
          this.onProjectileUpdate(projectile, dt, game);
        }
        this._removeProjectile(i, 'hit');
        continue;
      }
      projectile.position.x += projectile.direction.x * travel;
      projectile.position.y += projectile.direction.y * travel;
      projectile.position.z += projectile.direction.z * travel;
      if (typeof this.onProjectileUpdate === 'function') {
        const handled = this.onProjectileUpdate(projectile, dt, game);
        if (handled === true) {
          this._removeProjectile(i, 'external-hit');
        }
      }
    }
  };

  VehicleSystem.prototype.getDeployPoints = function (team) {
    const targetTeam = team === 'enemy' ? 'enemy' : 'ally';
    const out = [];
    for (let i = 0; i < this._vehicles.length; i++) {
      const vehicle = this._vehicles[i];
      if (vehicle.team !== targetTeam) continue;
      const open = this.getOpenSeat(vehicle);
      let openSeats = 0;
      for (let s = 0; s < vehicle.seats.length; s++) {
        if (
          !vehicle.seats[s].occupant &&
          vehicle.seats[s].occupantId == null
        ) {
          openSeats++;
        }
      }
      out.push({
        id: 'vehicle-' + vehicle.id,
        vehicleId: vehicle.id,
        vehicleType: vehicle.type,
        team: vehicle.team,
        kind: 'vehicle',
        label:
          vehicle.def.nameZh +
          (vehicle.alive ? ' · ' + openSeats + ' 空座' : ''),
        x: vehicle.position.x,
        y: vehicle.position.y,
        z: vehicle.position.z,
        seatIndex: open ? open.index : null,
        role: open ? open.role : null,
        openSeats: openSeats,
        seatCount: vehicle.seats.length,
        respawnRemaining: vehicle.alive ? 0 : Math.ceil(vehicle.respawnTimer),
        available: !!(vehicle.alive && open),
        reason: !vehicle.alive
          ? '载具重生 ' + Math.ceil(vehicle.respawnTimer) + 's'
          : open
            ? ''
            : '载具座位已满',
      });
    }
    return out;
  };

  VehicleSystem.prototype.getSnapshot = function () {
    return {
      version: 1,
      vehicles: this._vehicles.map(function (vehicle) {
        const weapons = {};
        for (let i = 0; i < vehicle.def.weapons.length; i++) {
          const id = vehicle.def.weapons[i];
          weapons[id] = cloneWeaponState(vehicle.weapons[id]);
        }
        return {
          id: vehicle.id,
          type: vehicle.type,
          team: vehicle.team,
          position: copyVec(vehicle.position),
          yaw: vehicle.yaw,
          pitch: vehicle.pitch,
          roll: vehicle.roll,
          speed: vehicle.speed,
          ramSlowTimer: vehicle.ramSlowTimer || 0,
          hp: vehicle.hp,
          alive: vehicle.alive,
          destroyed: vehicle.destroyed,
          respawnTimer: vehicle.respawnTimer,
          turretYaw: vehicle.turretYaw,
          turretPitch: vehicle.turretPitch,
          aimByRole: {
            driver: {
              yaw: vehicle.aimByRole.driver.yaw,
              pitch: vehicle.aimByRole.driver.pitch,
            },
            gunner: {
              yaw: vehicle.aimByRole.gunner.yaw,
              pitch: vehicle.aimByRole.gunner.pitch,
            },
          },
          seats: vehicle.seats.map(function (seatState) {
            return {
              index: seatState.index,
              role: seatState.role,
              occupantId: seatState.occupantId == null ? null : String(seatState.occupantId),
            };
          }),
          weapons: weapons,
        };
      }),
      projectiles: this.projectiles
        .filter(function (projectile) {
          return !projectile.predictOnly;
        })
        .map(function (projectile) {
          return {
            id: projectile.id,
            vehicleId: projectile.vehicleId,
            ownerId: projectile.ownerId,
            team: projectile.team,
            weaponId: projectile.weaponId,
            damage: projectile.damage,
            damageType: projectile.damageType,
            position: copyVec(projectile.position),
            direction: copyVec(projectile.direction),
            speed: projectile.speed,
            life: projectile.life,
            gravity: projectile.gravity,
            guidance: projectile.guidance,
            guidanceRate: projectile.guidanceRate,
            targetVehicleId: projectile.targetVehicleId,
            targetPoint: projectile.targetPoint
              ? copyVec(projectile.targetPoint)
              : null,
          };
        }),
    };
  };

  VehicleSystem.prototype._isLocalOccupant = function (entity, occupantId) {
    const game = global.VF && global.VF.game;
    const player = game && game.player;
    if (!player) return false;
    if (entity === player) return true;
    const playerId = this._entityId(player);
    return !!(
      entity &&
      occupantId &&
      playerId === occupantId &&
      entity.vehicleId != null
    );
  };

  VehicleSystem.prototype._applySeatSnapshot = function (vehicle, sourceSeats) {
    sourceSeats = Array.isArray(sourceSeats) ? sourceSeats : [];
    const byIndex = Object.create(null);
    for (let i = 0; i < sourceSeats.length; i++) {
      byIndex[sourceSeats[i].index] = sourceSeats[i];
    }
    for (let i = 0; i < vehicle.seats.length; i++) {
      const seatState = vehicle.seats[i];
      const source = byIndex[i];
      if (this._isLocalOccupant(seatState.occupant, seatState.occupantId)) {
        const pvp = global.VF && global.VF.Pvp;
        const expectedId =
          pvp && pvp.mode === 'guest' ? 'remote-player' : 'player-local';
        if (
          source &&
          source.occupantId != null &&
          String(source.occupantId) === expectedId
        ) {
          seatState.occupant._vehicleAuthorityGraceUntil = 0;
          continue;
        }
        const now =
          global.performance && global.performance.now
            ? global.performance.now()
            : Date.now();
        if (
          (!source || source.occupantId == null) &&
          seatState.occupant._vehicleAuthorityGraceUntil > now
        ) {
          continue;
        }
        this._detachSeat(vehicle, seatState, {
          reason: 'authority-rejected',
          silent: true,
        });
        continue;
      }
      const nextId = source && source.occupantId != null ? String(source.occupantId) : null;
      const pvp = global.VF && global.VF.Pvp;
      const game = global.VF && global.VF.game;
      const localPlayer = game && game.player;
      if (
        pvp &&
        pvp.mode === 'guest' &&
        nextId === 'remote-player' &&
        localPlayer
      ) {
        const current = this._findEntitySeat(localPlayer);
        if (
          current &&
          (current.vehicle !== vehicle || current.seat.index !== seatState.index)
        ) {
          this._detachSeat(current.vehicle, current.seat, {
            reason: 'authority-seat',
            silent: true,
          });
        }
        seatState.occupant = localPlayer;
        seatState.occupantId = this._entityId(localPlayer);
        localPlayer.vehicleId = vehicle.id;
        localPlayer.vehicleSeat = seatState.index;
        localPlayer.vehicleRole = seatState.role;
        localPlayer._vehicleAuthorityGraceUntil = 0;
        this._hideMountedEntity(localPlayer);
        this._syncOccupant(vehicle, seatState);
        continue;
      }
      if (seatState.occupant && this._entityId(seatState.occupant) !== nextId) {
        const oldEntity = seatState.occupant;
        if (oldEntity.vehicleId === vehicle.id) {
          oldEntity.vehicleId = null;
          oldEntity.vehicleSeat = null;
          oldEntity.vehicleRole = null;
        }
        this._restoreMountedEntity(oldEntity);
        seatState.occupant = null;
      }
      seatState.occupantId = nextId;
    }
  };

  VehicleSystem.prototype._applyWeaponSnapshot = function (vehicle, sourceWeapons) {
    if (!sourceWeapons || typeof sourceWeapons !== 'object') return;
    for (let i = 0; i < vehicle.def.weapons.length; i++) {
      const id = vehicle.def.weapons[i];
      const source = sourceWeapons[id];
      const state = vehicle.weapons[id];
      const def = WEAPON_DEFS[id];
      if (!source || !state) continue;
      state.cooldown = Math.max(0, finite(source.cooldown, state.cooldown));
      if (def.magSize != null) {
        const sourceMag = source.mag != null ? source.mag : source.ammo;
        state.mag = clamp(Math.floor(finite(sourceMag, state.mag)), 0, def.magSize);
        state.ammo = state.mag;
        if (def.reserve != null || def.reserveRegenSec != null) {
          const cap =
            def.reserveMax != null ? def.reserveMax : def.reserve != null ? def.reserve : state.reserve;
          state.reserve = Math.max(
            0,
            Math.min(cap, Math.floor(finite(source.reserve, state.reserve)))
          );
        } else {
          state.reserve = null;
        }
        state.reloadTimer = Math.max(0, finite(source.reloadTimer, state.reloadTimer));
      }
      if (def.reserveRegenSec != null) {
        if ((state.reserve || 0) > 0) state.reserveRegenTimer = 0;
        else {
          state.reserveRegenTimer = Math.max(
            0,
            finite(source.reserveRegenTimer, state.reserveRegenTimer)
          );
        }
      }
      if (def.maxHeat != null) {
        state.heat = clamp(finite(source.heat, state.heat), 0, def.maxHeat);
        state.overheated = !!source.overheated;
      }
    }
  };

  VehicleSystem.prototype._applyProjectileSnapshot = function (sourceProjectiles) {
    const list = Array.isArray(sourceProjectiles) ? sourceProjectiles : [];
    const seen = Object.create(null);
    for (let i = 0; i < list.length; i++) {
      const source = list[i];
      if (!source || !source.id || !WEAPON_DEFS[source.weaponId]) continue;
      seen[source.id] = true;
      let projectile = null;
      for (let j = 0; j < this.projectiles.length; j++) {
        if (this.projectiles[j].id === source.id) {
          projectile = this.projectiles[j];
          break;
        }
      }
      if (!projectile) {
        projectile = {
          id: source.id,
          remote: true,
          predictOnly: true,
          previousPosition: copyVec(source.position),
          hit: null,
          damageApplied: 0,
        };
        this.projectiles.push(projectile);
      }
      projectile.remote = true;
      projectile.predictOnly = true;
      projectile.vehicleId = source.vehicleId || null;
      projectile.ownerId = source.ownerId || null;
      projectile.team = source.team === 'enemy' ? 'enemy' : 'ally';
      projectile.weaponId = source.weaponId;
      projectile.damage = finite(source.damage, 0);
      projectile.damageType = source.damageType || 'explosive';
      projectile.previousPosition = copyVec(projectile.position || source.position);
      projectile.position = copyVec(source.position);
      projectile.direction = normalizeVec(source.direction);
      projectile.speed = finite(source.speed, 0);
      projectile.life = Math.max(0, finite(source.life, 0));
      projectile.gravity = finite(source.gravity, 0);
      projectile.guidance = source.guidance || null;
      projectile.guidanceRate = finite(source.guidanceRate, 0);
      projectile.targetVehicleId = source.targetVehicleId || null;
      projectile.targetPoint = source.targetPoint
        ? copyVec(source.targetPoint)
        : null;
    }
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const projectile = this.projectiles[i];
      if (projectile.remote && !seen[projectile.id]) {
        this._removeProjectile(i, 'snapshot-removed');
      }
    }
  };

  VehicleSystem.prototype.applySnapshot = function (snapshot) {
    const list = Array.isArray(snapshot)
      ? snapshot
      : snapshot && Array.isArray(snapshot.vehicles)
        ? snapshot.vehicles
        : [];
    let applied = 0;
    for (let i = 0; i < list.length; i++) {
      const source = list[i];
      if (!source || !source.id || !VEHICLE_DEFS[source.type]) continue;
      let vehicle = this.getById(source.id);
      if (!vehicle) {
        vehicle = this.spawn({
          id: source.id,
          type: source.type,
          team: source.team,
          position: source.position,
          yaw: source.yaw,
          remote: true,
          silent: true,
        });
      }
      if (!vehicle || vehicle.type !== source.type) continue;
      vehicle.team = source.team === 'enemy' ? 'enemy' : 'ally';
      if (source.position) vehicle.position = copyVec(source.position);
      vehicle.yaw = finite(source.yaw, vehicle.yaw);
      vehicle.pitch = finite(source.pitch, vehicle.pitch);
      vehicle.roll = finite(source.roll, vehicle.roll);
      vehicle.speed = finite(source.speed, vehicle.speed);
      vehicle.ramSlowTimer = Math.max(0, finite(source.ramSlowTimer, vehicle.ramSlowTimer));
      vehicle.hp = clamp(finite(source.hp, vehicle.hp), 0, vehicle.maxHp);
      vehicle.alive = source.alive !== false && source.destroyed !== true;
      vehicle.destroyed = !vehicle.alive;
      vehicle.respawnTimer = Math.max(0, finite(source.respawnTimer, vehicle.respawnTimer));
      vehicle.turretYaw = finite(source.turretYaw, vehicle.turretYaw);
      vehicle.turretPitch = finite(source.turretPitch, vehicle.turretPitch);
      vehicle.aim = {
        yaw: vehicle.yaw + vehicle.turretYaw,
        pitch: vehicle.turretPitch,
        direction: forwardFor(vehicle.yaw + vehicle.turretYaw, vehicle.turretPitch),
        target: null,
      };
      const sourceAims = source.aimByRole || {};
      vehicle.aimByRole = vehicle.aimByRole || {};
      ['driver', 'gunner'].forEach(function (role) {
        const src = sourceAims[role] || {};
        const yaw = finite(
          src.yaw,
          role === 'driver'
            ? vehicle.yaw + vehicle.turretYaw
            : vehicle.yaw
        );
        const pitch = finite(
          src.pitch,
          role === 'driver' ? vehicle.turretPitch : 0
        );
        vehicle.aimByRole[role] = {
          yaw: yaw,
          pitch: pitch,
          direction: forwardFor(yaw, pitch),
          target: null,
        };
      });
      this._applySeatSnapshot(vehicle, source.seats);
      this._applyWeaponSnapshot(vehicle, source.weapons);
      this._syncVisual(vehicle);
      this._syncAABB(vehicle);
      this._syncOccupants(vehicle);
      applied++;
    }
    this._applyProjectileSnapshot(snapshot && snapshot.projectiles);
    this._publishWorldColliders();
    return applied;
  };

  VehicleSystem.prototype.clear = function () {
    for (let i = 0; i < this._vehicles.length; i++) {
      const vehicle = this._vehicles[i];
      for (let j = 0; j < vehicle.seats.length; j++) {
        if (vehicle.seats[j].occupant || vehicle.seats[j].occupantId != null) {
          this._detachSeat(vehicle, vehicle.seats[j], { silent: true });
        }
      }
      if (vehicle.mesh && vehicle.mesh.parent) vehicle.mesh.parent.remove(vehicle.mesh);
    }
    this._vehicles.length = 0;
    this.projectiles.length = 0;
    this._byId = Object.create(null);
    this.lastShot = null;
    if (this.root && this.root.parent) this.root.parent.remove(this.root);
    this.root = null;
    this._publishWorldColliders();
  };

  VehicleSystem.prototype.createModel = function (type, team) {
    return createVehicleModel(type, team);
  };

  VehicleSystem.prototype.getModelCacheStats = function () {
    return {
      geometries: Object.keys(MODEL_CACHE.geometries).length,
      materials: Object.keys(MODEL_CACHE.materials).length,
    };
  };

  const Vehicles = new VehicleSystem();
  Vehicles.definitions = VEHICLE_DEFS;
  Vehicles.defs = VEHICLE_DEFS;
  Vehicles.weaponDefinitions = WEAPON_DEFS;
  Vehicles.weaponDefs = WEAPON_DEFS;

  global.VF = global.VF || {};
  global.VF.Vehicles = Vehicles;
  global.VF.VEHICLE_DEFS = VEHICLE_DEFS;
  global.VF.VEHICLE_WEAPONS = WEAPON_DEFS;
})(typeof window !== 'undefined' ? window : this);
