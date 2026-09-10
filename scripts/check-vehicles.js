/* Deterministic logic checks for vehicles.js. THREE is intentionally absent. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');

const root = path.resolve(__dirname, '..');

function ok(condition, message) {
  if (!condition) throw new Error(message);
}

function near(actual, expected, epsilon, message) {
  if (Math.abs(actual - expected) > (epsilon == null ? 1e-6 : epsilon)) {
    throw new Error(message + ': expected ' + expected + ', got ' + actual);
  }
}

function nearDirection(actual, expected, epsilon) {
  const limit = epsilon == null ? 1e-6 : epsilon;
  return !!(
    actual &&
    Math.abs(actual.x - expected.x) <= limit &&
    Math.abs(actual.y - expected.y) <= limit &&
    Math.abs(actual.z - expected.z) <= limit
  );
}

function loadVehicles() {
  const context = {
    window: { VF: {} },
    console,
    performance,
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'js', 'vehicles.js'), 'utf8'),
    context,
    { filename: 'js/vehicles.js' }
  );
  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'js', 'net-protocol.js'), 'utf8'),
    context,
    { filename: 'js/net-protocol.js' }
  );
  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'js', 'net-simulation.js'), 'utf8'),
    context,
    { filename: 'js/net-simulation.js' }
  );
  return { context, Vehicles: context.window.VF.Vehicles };
}

function checkVehicleEffectsStress() {
  class Transform {
    constructor() {
      this.x = 0;
      this.y = 0;
      this.z = 0;
    }
    set(x, y, z) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
    setScalar(value) {
      return this.set(value, value, value);
    }
    copy(value) {
      return this.set(value.x, value.y, value.z);
    }
  }
  class Node {
    constructor() {
      this.children = [];
      this.parent = null;
      this.position = new Transform();
      this.scale = new Transform().set(1, 1, 1);
      this.rotation = new Transform();
      this.quaternion = {
        setFromUnitVectors() {},
        identity() {},
      };
      this.userData = {};
      this.visible = true;
    }
    add() {
      for (let i = 0; i < arguments.length; i++) {
        const child = arguments[i];
        if (child.parent) child.parent.remove(child);
        child.parent = this;
        this.children.push(child);
      }
    }
    remove(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parent = null;
    }
    lookAt() {}
  }
  class Group extends Node {}
  class Geometry {
    rotateX() {}
  }
  class Material {
    constructor(options) {
      Object.assign(this, options || {});
      this.color = {
        value: options && options.color,
        setHex(value) {
          this.value = value;
        },
      };
    }
  }
  class Mesh extends Node {
    constructor(geometry, material) {
      super();
      this.geometry = geometry;
      this.material = material;
    }
  }
  class PointLight extends Node {
    constructor(color, intensity, distance) {
      super();
      this.color = { value: color, setHex(value) { this.value = value; } };
      this.intensity = intensity;
      this.distance = distance;
      this.isLight = true;
    }
  }
  class Vector3 extends Transform {
    lengthSq() {
      return this.x * this.x + this.y * this.y + this.z * this.z;
    }
  }
  const THREE = {
    Group,
    Mesh,
    PointLight,
    Vector3,
    BoxGeometry: Geometry,
    SphereGeometry: Geometry,
    RingGeometry: Geometry,
    ConeGeometry: Geometry,
    MeshBasicMaterial: Material,
    AdditiveBlending: 2,
    NormalBlending: 1,
    DoubleSide: 2,
    FrontSide: 0,
  };
  const scene = new Group();
  const context = {
    window: {
      THREE,
      VF: {},
      performance,
      setTimeout,
      clearTimeout,
    },
    console,
    performance,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'js', 'vehicle-effects.js'), 'utf8'),
    context,
    { filename: 'js/vehicle-effects.js' }
  );
  const FX = context.window.VF.VehicleEffects;
  const listeners = Object.create(null);
  const vehicles = {
    projectiles: [],
    on(type, handler) {
      listeners[type] = handler;
      return function () {
        delete listeners[type];
      };
    },
    getById() {
      return null;
    },
  };
  FX.init(
    {
      scene,
      camera: { position: new Transform() },
      world: { getTerrainTop() { return 0; } },
      player: {
        entityId: 'player-local',
        object: { position: new Transform() },
      },
    },
    vehicles
  );

  function stressPass(offset) {
    const projectiles = [];
    for (let i = 0; i < 100; i++) {
      const id = 'stress-' + (offset + i);
      FX.onWeaponFired({
        shotId: id,
        vehicleId: 'remote-tank',
        ownerId: 'remote-player',
        weaponId: 'tank_main_cannon',
        origin: { x: 0, y: 2.8, z: -5 },
        direction: { x: 0, y: 0, z: -1 },
      });
      const projectile = {
        id,
        vehicleId: 'remote-tank',
        ownerId: 'remote-player',
        weaponId: 'tank_main_cannon',
        position: { x: 0, y: 2.8, z: -12 },
        previousPosition: { x: 0, y: 2.8, z: -10 },
        direction: { x: 0, y: 0, z: -1 },
        speed: 95,
      };
      FX.updateProjectile(projectile, 1 / 60);
      projectiles.push(projectile);
      const impactKind = i % 3 === 0 ? 'armor' : i % 3 === 1 ? 'ground' : 'structure';
      FX.impact(id, impactKind, impactKind, { x: 0, y: 0, z: -20 }, {
        normal: { x: 0, y: 1, z: 0 },
        color: 0x8a705a,
      });
    }
    const peak = FX.getStats();
    ok(
      peak.activeProjectiles <= peak.limits.projectile,
      'active projectile visuals exceeded their cap'
    );
    for (let i = 0; i < projectiles.length; i++) {
      FX.releaseProjectile(projectiles[i]);
    }
    FX.update(2.1);
    const settled = FX.getStats();
    settled.peakActiveProjectiles = peak.activeProjectiles;
    return settled;
  }

  ok(
    FX.onWeaponFired({
      shotId: 'dedupe',
      vehicleId: 'remote-tank',
      weaponId: 'tank_main_cannon',
      origin: { x: 0, y: 2.8, z: -5 },
      direction: { x: 0, y: 0, z: -1 },
    }) === true,
    'first cannon presentation event was rejected'
  );
  ok(
    FX.onWeaponFired({
      shotId: 'dedupe',
      vehicleId: 'remote-tank',
      weaponId: 'tank_main_cannon',
      origin: { x: 0, y: 2.8, z: -5 },
      direction: { x: 0, y: 0, z: -1 },
    }) === false,
    'duplicate cannon presentation event was not rejected'
  );
  FX.update(2.1);
  const first = stressPass(0);
  const second = stressPass(100);
  ok(first.activeEffects === 0 && second.activeEffects === 0, 'pooled effects did not expire');
  ok(
    first.activeProjectiles === 0 && second.activeProjectiles === 0,
    'pooled projectile visuals did not return'
  );
  ok(
    first.projectileCreated === second.projectileCreated,
    'projectile geometry/material allocation kept growing'
  );
  ok(
    second.sharedGeometries === 6 &&
      second.sharedProjectileMaterials === 3,
    'projectile visuals did not use shared geometry/material resources'
  );
  Object.keys(second.created).forEach(function (kind) {
    ok(
      second.created[kind] <= second.limits[kind],
      kind + ' effect pool exceeded its cap'
    );
    ok(
      second.created[kind] === first.created[kind],
      kind + ' effect allocation kept growing after 100 shots'
    );
  });
  const impactAudio = [];
  context.window.VF.Audio = {
    play(name) {
      impactAudio.push(name);
    },
  };
  FX.impact(
    'infantry-impact-check',
    'infantry-target',
    'infantry',
    { x: 0, y: 0, z: -20 },
    { normal: { x: 0, y: 1, z: 0 } }
  );
  ok(
    impactAudio.indexOf('hit_heavy') >= 0 &&
      impactAudio.indexOf('tank_ground_impact') < 0,
    'direct infantry hit reused ground impact audio'
  );
  FX.update(1);
  return second;
}

function checkVehicleHud() {
  function element() {
    const classes = new Set();
    const attrs = Object.create(null);
    return {
      classList: {
        add() {
          for (let i = 0; i < arguments.length; i++) classes.add(arguments[i]);
        },
        remove() {
          for (let i = 0; i < arguments.length; i++) classes.delete(arguments[i]);
        },
        toggle(name, force) {
          if (force === undefined) force = !classes.has(name);
          if (force) classes.add(name);
          else classes.delete(name);
          return force;
        },
        contains(name) {
          return classes.has(name);
        },
      },
      style: {
        setProperty(name, value) {
          this[name] = String(value);
        },
      },
      textContent: '',
      offsetWidth: 88,
      setAttribute(name, value) {
        attrs[name] = String(value);
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(attrs, name)
          ? attrs[name]
          : null;
      },
    };
  }
  const context = {
    window: {
      VF: {
        VEHICLE_WEAPONS: {
          tank_main_cannon: {
            id: 'tank_main_cannon',
            nameZh: '多用途主炮',
            cooldown: 4.2,
      magSize: 30,
          },
        },
      },
    },
    console,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'js', 'ui.js'), 'utf8'),
    context,
    { filename: 'js/ui.js' }
  );
  const UI = context.window.VF.UI;
  const reticle = element();
  const cooldown = element();
  const ring = element();
  const cooldownText = element();
  const ready = element();
  UI.els = {
    vehicleReticle: reticle,
    vehicleCannonCooldown: cooldown,
    vehicleCannonCooldownRing: ring,
    vehicleCannonCooldownText: cooldownText,
    vehicleReticleReady: ready,
  };
  const state = {
    cooldown: 4.2,
    mag: 14,
    reloadTimer: 0,
    overheated: false,
  };
  const vehicle = {
    id: 'hud-tank',
    type: 'tank',
    alive: true,
    hp: 1000,
    maxHp: 1000,
    armorClass: 'heavy',
    speed: 0,
    def: {
      nameZh: '主战坦克',
      weapons: ['tank_main_cannon'],
    },
    seats: [{ occupantId: 'player-local' }],
    weapons: { tank_main_cannon: state },
  };
  const player = {
    vehicleId: vehicle.id,
    vehicleSeat: 0,
    vehicleRole: 'driver',
    vehicleWeaponIndex: 0,
    vehicleCameraMode: 1,
  };
  const vehicles = {
    getById() {
      return vehicle;
    },
    canUsePersonalWeapon() {
      return false;
    },
    canUseVehicleFirstPerson() {
      return true;
    },
    getWeaponsForRole() {
      return ['tank_main_cannon'];
    },
  };
  UI.updateVehicleHud(player, vehicles);
  ok(!cooldown.classList.contains('hidden'), 'main cannon cooldown ring was hidden');
  ok(cooldownText.textContent === '装填 4.2s', 'main cannon cooldown text was incorrect');
  ok(ring.style.strokeDashoffset === '100', 'main cannon cooldown ring did not start empty');
  ok(ready.textContent === '装填', 'reticle reported a cooling cannon as ready');
  state.cooldown = 0;
  UI.updateVehicleHud(player, vehicles);
  ok(
    cooldown.classList.contains('hidden') &&
      ready.textContent === '就绪' &&
      reticle.classList.contains('cannon-ready-flash'),
    'main cannon ready transition was not shown'
  );
  state.mag = 0;
  UI.updateVehicleHud(player, vehicles);
  ok(ready.textContent === '装填', 'empty main cannon was reported ready');

  context.window.VF.VEHICLE_WEAPONS.tank_coax = {
    id: 'tank_coax',
    nameZh: '同轴重机枪',
    maxHeat: 100,
  };
  const ammo = element();
  UI.els.vehicleHudAmmo = ammo;
  vehicle.weapons.tank_coax = { heat: 87, overheated: true };
  vehicles.getWeaponsForRole = function () {
    return ['tank_coax'];
  };
  UI.updateVehicleHud(player, vehicles);
  ok(ammo.textContent === '87% 过热', 'overheat HUD ammo text was incorrect');
  ok(ammo.classList.contains('overheated'), 'overheat HUD ammo class was missing');
  ok(ammo.textContent.indexOf(' · ') < 0, 'overheat HUD ammo still uses expanding suffix');
  vehicle.weapons.tank_coax.overheated = false;
  UI.updateVehicleHud(player, vehicles);
  ok(
    ammo.textContent === '87% 热量' && !ammo.classList.contains('overheated'),
    'cooled MG HUD ammo did not restore heat label'
  );

  const hull = element();
  const turret = element();
  const tankSpeed = element();
  const tankRange = element();
  UI.els.vehicleHullMarker = hull;
  UI.els.vehicleTurretMarker = turret;
  UI.els.vehicleTankSpeed = tankSpeed;
  UI.els.vehicleTankRange = tankRange;
  vehicle.yaw = Math.PI / 2;
  vehicle.turretYaw = Math.PI / 4;
  vehicle.speed = 5.555;
  player._vehicleAimDistance = 142.4;
  UI.updateVehicleHud(player, vehicles);
  ok(
    hull.getAttribute('transform') === 'rotate(270.00 40 42)',
    'tank hull schematic did not rotate against north'
  );
  ok(
    turret.getAttribute('transform') === 'rotate(225.00 40 42)',
    'tank turret schematic did not rotate against north'
  );
  ok(tankSpeed.textContent === '20', 'tank optic speed was incorrect');
  ok(tankRange.textContent === '142', 'tank optic range was incorrect');

  const hud = element();
  const heOpticEl = element();
  const ammoType = element();
  const ammoCount = element();
  const tankStatus = element();
  const reticleRange = element();
  UI.els.hud = hud;
  UI.els.vehicleHeOptic = heOpticEl;
  UI.els.vehicleReticleAmmoType = ammoType;
  UI.els.vehicleReticleAmmoCount = ammoCount;
  UI.els.vehicleTankWeaponStatus = tankStatus;
  UI.els.vehicleReticleRange = reticleRange;
  context.window.VF.VEHICLE_WEAPONS.ifv_at_missile = {
    id: 'ifv_at_missile',
    nameZh: '瞄准制导反装甲导弹',
    ammoTypeZh: '反装甲导弹',
    cooldown: 6.5,
    magSize: 1,
  };
  context.window.VF.VEHICLE_WEAPONS.ifv_he_autocannon = {
    id: 'ifv_he_autocannon',
    nameZh: '高爆炮',
    ammoTypeZh: '高爆弹',
    cooldown: 0.22,
    magSize: 12,
  };
  vehicle.type = 'ifv';
  vehicle.weapons.ifv_at_missile = {
    mag: 1,
    reserve: 19,
    cooldown: 0,
    reloadTimer: 0,
    overheated: false,
  };
  vehicles.getWeaponsForRole = function () {
    return ['ifv_at_missile'];
  };
  UI.updateVehicleHud(player, vehicles);
  ok(
    hud.classList.contains('vehicle-cannon-optic') &&
      !hud.classList.contains('vehicle-he-optic') &&
      ammoType.textContent === '反装甲导弹' &&
      ammoCount.textContent === '20' &&
      tankStatus.textContent === '就绪',
    'IFV missile did not reuse the tank cannon optic'
  );
  ok(
    hull.getAttribute('transform') === 'rotate(270.00 40 42)',
    'IFV missile optic did not keep a north-up hull schematic'
  );
  vehicle.weapons.ifv_he_autocannon = {
    mag: 12,
    reserve: 192,
    cooldown: 0,
    reloadTimer: 0,
    overheated: false,
  };
  vehicles.getWeaponsForRole = function () {
    return ['ifv_he_autocannon'];
  };
  player._vehicleSightRange = 460;
  player._vehicleAimDistance = 460;
  UI.updateVehicleHud(player, vehicles);
  ok(
    hud.classList.contains('vehicle-he-optic') &&
      !hud.classList.contains('vehicle-cannon-optic') &&
      !hud.classList.contains('vehicle-mg-optic'),
    'IFV autocannon still used the tank cannon optic'
  );
  ok(
    ammoType.textContent === '高爆弹' &&
      ammoCount.textContent === '12' &&
      tankStatus.textContent === '就绪' &&
      tankRange.textContent === '460',
    'IFV HE optic did not reuse tank compass chrome'
  );

  vehicle.type = 'tank';
  context.window.VF.VEHICLE_WEAPONS.tank_coax_mg = {
    id: 'tank_coax_mg',
    nameZh: '同轴重机枪',
    kind: 'machine-gun',
    maxHeat: 100,
  };
  vehicle.weapons.tank_coax_mg = {
    heat: 0,
    overheated: false,
    reloadTimer: 0,
    cooldown: 0,
  };
  vehicles.getWeaponsForRole = function () {
    return ['tank_coax_mg'];
  };
  UI.updateVehicleHud(player, vehicles);
  ok(
    hud.classList.contains('vehicle-he-optic') &&
      hud.classList.contains('vehicle-optic-no-count') &&
      hud.classList.contains('vehicle-mg-optic') &&
      !hud.classList.contains('vehicle-cannon-optic') &&
      ammoType.textContent === '同轴重机枪' &&
      ammoCount.textContent === '',
    'tank coaxial MG did not reuse the IFV HE optic without an ammo count'
  );
  ok(
    hud.style['--mg-arm-fill'] === '0.500' &&
      heOpticEl.style['--mg-arm-fill'] === '0.500' &&
      !hud.classList.contains('vehicle-mg-overheat'),
    'idle coaxial MG reticle arms were not half-faded'
  );
  vehicle.weapons.tank_coax_mg.heat = 50;
  UI.updateVehicleHud(player, vehicles);
  ok(
    hud.style['--mg-arm-fill'] === '0.750' &&
      heOpticEl.style['--mg-arm-fill'] === '0.750',
    'firing coaxial MG did not fill reticle arms from the inside out'
  );
  vehicle.weapons.tank_coax_mg.heat = 100;
  vehicle.weapons.tank_coax_mg.overheated = true;
  UI.updateVehicleHud(player, vehicles);
  ok(
    hud.style['--mg-arm-fill'] === '1.000' &&
      heOpticEl.style['--mg-arm-fill'] === '1.000' &&
      hud.classList.contains('vehicle-mg-overheat'),
    'overheated coaxial MG did not fully fill reticle arms'
  );
  vehicle.weapons.tank_coax_mg.heat = 0;
  vehicle.weapons.tank_coax_mg.overheated = false;

  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  ok(
    html.indexOf('id="vehicle-cannon-cooldown"') >= 0 &&
      html.indexOf('id="vehicle-heavy-hit"') >= 0 &&
      html.indexOf('id="vehicle-hud-service"') >= 0 &&
      html.indexOf('id="vehicle-hud-weapon-rack"') >= 0 &&
      html.indexOf('id="vehicle-mg-heat"') >= 0 &&
      html.indexOf('id="vehicle-compass"') >= 0 &&
      html.indexOf('id="vehicle-tank-schematic"') >= 0 &&
      html.indexOf('id="vehicle-hull-marker"') >= 0 &&
      html.indexOf('id="vehicle-tank-speed"') >= 0 &&
      html.indexOf('id="vehicle-tank-range"') >= 0 &&
      html.indexOf('class="vr-he-optic"') >= 0 &&
      html.indexOf('class="vr-he-tick n"') >= 0 &&
    'vehicle cooldown or heavy hit HUD markup is missing'
  );
  ok(
      css.indexOf('#hud.vehicle-optic.vehicle-mg-optic') >= 0 &&
      css.indexOf('--mg-arm-fill') >= 0 &&
      css.indexOf('vr-he-arm.solid') >= 0,
    'coaxial MG reticle arm styles are missing'
  );
  ok(
    html.indexOf('js/vehicle-effects.js') < html.indexOf('js/main.js'),
    'vehicle effects module is loaded after main.js'
  );
  const mainSource = fs.readFileSync(path.join(root, 'js', 'main.js'), 'utf8');
  ok(
    mainSource.indexOf("impactProjectile(projectile, 'infantry'") >= 0,
    'direct infantry hit is not routed to infantry presentation'
  );
  return true;
}

function positionNode() {
  return {
    x: 0,
    y: 0,
    z: 0,
    set(x, y, z) {
      this.x = x;
      this.y = y;
      this.z = z;
    },
  };
}

function entity(id, useMesh) {
  if (useMesh) {
    return {
      entityId: id,
      alive: true,
      isAI: true,
      mesh: {
        position: positionNode(),
        rotation: { y: 0 },
        visible: true,
      },
    };
  }
  return {
    entityId: id,
    alive: true,
    object: {
      position: positionNode(),
      rotation: { y: 0 },
    },
  };
}

function run() {
  const loaded = loadVehicles();
  const context = loaded.context;
  const Vehicles = loaded.Vehicles;
  ok(Vehicles, 'global.VF.Vehicles was not installed');
  const vehiclesSource = fs.readFileSync(path.join(root, 'js', 'vehicles.js'), 'utf8');
  ok(vehiclesSource.indexOf('createResupplyKiosk') >= 0, 'createResupplyKiosk is missing');
  ok(vehiclesSource.indexOf('载具补给站') >= 0, 'station name 载具补给站 is missing');
  ok(
    typeof context.window.VF.drawResupplyStationMark === 'function',
    'drawResupplyStationMark was not exported'
  );

  const defs = Vehicles.definitions;
  const weaponDefs = Vehicles.weaponDefinitions;
  ok(defs.jeep.seats.length === 6, 'jeep must have six seats');
  ok(defs.ifv.seats.length === 6, 'ifv must have six seats');
  ok(defs.tank.seats.length === 2, 'tank must have two seats');
  ok(
    defs.jeep.seats[0].role === 'driver' &&
      defs.jeep.seats.slice(1).every((seatDef) => seatDef.role === 'passenger'),
    'jeep seat roles are incorrect'
  );
  ok(
    defs.ifv.seats.filter((seatDef) => seatDef.role === 'driver').length === 1 &&
      defs.ifv.seats.filter((seatDef) => seatDef.role === 'gunner').length === 1 &&
      defs.ifv.seats.filter((seatDef) => seatDef.role === 'passenger').length === 4,
    'IFV seat roles are incorrect'
  );
  ok(
    defs.tank.seats[0].role === 'driver' && defs.tank.seats[1].role === 'gunner',
    'tank seat roles are incorrect'
  );

  ok(defs.jeep.weapons.length === 0, 'jeep must not have a mounted weapon');
  ok(defs.ifv.weapons.length === 3, 'IFV mounted weapon set is incomplete');
  ok(defs.tank.weapons.length === 3, 'tank mounted weapon set is incomplete');
  ok(
    defs.ifv.weapons.every((id) => weaponDefs[id]) &&
      defs.tank.weapons.every((id) => weaponDefs[id]),
    'a mounted weapon definition is missing'
  );
  ok(
    weaponDefs.ifv_he_autocannon.damageType === 'explosive' &&
      weaponDefs.ifv_at_missile.damageType === 'antiArmor' &&
      weaponDefs.tank_main_cannon.damageType === 'antiArmor' &&
      weaponDefs.tank_coax_mg.damageType === 'bullet',
    'mounted weapon damage types are incorrect'
  );
  ok(
    weaponDefs.rpg &&
      weaponDefs.rpg.damage === 150 &&
      weaponDefs.rpg.damageType === 'antiArmor',
    'RPG anti-armor definition is missing'
  );
  ok(
    weaponDefs.ifv_at_missile.damage === 150 &&
      weaponDefs.ifv_he_autocannon.ammoTypeZh === '高爆弹' &&
      weaponDefs.ifv_at_missile.ammoTypeZh === '反装甲导弹',
    'IFV anti-tank missile damage is not 150'
  );
  ok(
    weaponDefs.tank_main_cannon.damage === 200 &&
      weaponDefs.tank_main_cannon.cooldown === 4.2 &&
      weaponDefs.tank_main_cannon.projectileSpeed === 95 &&
      weaponDefs.tank_main_cannon.magSize === 30 &&
      weaponDefs.tank_main_cannon.blastRadius === 6.4 &&
      weaponDefs.tank_main_cannon.breakRadius === 2.9,
    'tank main cannon balance values changed'
  );
  ok(
    defs.tank.maxHp === 1000 && defs.tank.armorMul === 1,
    'tank HP / armor reduction setup is incorrect'
  );
  ok(
    weaponDefs.ifv_he_autocannon.role === 'driver' &&
      weaponDefs.ifv_at_missile.role === 'driver' &&
      weaponDefs.ifv_grenade_launcher.role === 'gunner' &&
      weaponDefs.tank_main_cannon.role === 'driver' &&
      weaponDefs.tank_coax_mg.role === 'driver' &&
      weaponDefs.tank_gunner_hmg.role === 'gunner',
    'driver/gunner weapon roles are incorrect'
  );
  ok(
    weaponDefs.ifv_he_autocannon.soundId === 'vehicle.weapon.ifv_autocannon' &&
      weaponDefs.ifv_at_missile.soundId === 'vehicle.weapon.ifv_missile' &&
      weaponDefs.ifv_grenade_launcher.soundId === 'vehicle.weapon.ifv_grenade' &&
      weaponDefs.tank_main_cannon.soundId === 'vehicle.weapon.tank_cannon' &&
      weaponDefs.tank_coax_mg.soundId === 'vehicle.weapon.tank_coax' &&
      weaponDefs.tank_gunner_hmg.soundId === 'vehicle.weapon.tank_hmg',
    'mounted weapon sound IDs are incomplete'
  );
  const vehicleFxSource = fs.readFileSync(
    path.join(root, 'js', 'vehicle-effects.js'),
    'utf8'
  );
  const mainSource = fs.readFileSync(path.join(root, 'js', 'main.js'), 'utf8');
  ok(
    vehicleFxSource.indexOf("'vehicle.weapon.tank_cannon'") >= 0 &&
      vehicleFxSource.indexOf("'vehicle.impact.armor'") >= 0 &&
      vehicleFxSource.indexOf("playExplosionAt(point, 'cannon'") >= 0 &&
      mainSource.indexOf('def.soundId') >= 0 &&
      mainSource.indexOf('position: data.origin') >= 0 &&
      mainSource.indexOf('playProjectileBlastAudio') >= 0 &&
      mainSource.indexOf('occupant: localOccupant') >= 0 &&
      mainSource.indexOf('setStations') >= 0,
    'vehicle fire/hit events are not routed into spatial audio'
  );

  ok(
    weaponDefs.ifv_he_autocannon.magSize === 12 &&
      weaponDefs.ifv_he_autocannon.reserve === 192 &&
      weaponDefs.ifv_he_autocannon.reserveMax === 192 &&
      weaponDefs.ifv_he_autocannon.maxHeat == null &&
      weaponDefs.ifv_he_autocannon.reserveRegenSec == null,
    'IFV HE cannon ammo setup is incorrect'
  );
  ok(
    context.window.VF.VEHICLE_AMMO_AUTO &&
      context.window.VF.VEHICLE_AMMO_AUTO.intervalSec === 15 &&
      context.window.VF.VEHICLE_AMMO_AUTO.capFraction === 0.5,
    'vehicle ammo auto-replenish constants are incorrect'
  );
  ok(
    weaponDefs.tank_main_cannon.magSize === 30 &&
      weaponDefs.tank_main_cannon.reserve == null,
    'tank main cannon ammo is not 30 rounds'
  );
  ok(
    weaponDefs.ifv_at_missile.magSize === 1 &&
      weaponDefs.ifv_at_missile.reserve === 19 &&
      weaponDefs.ifv_at_missile.reserveMax === 19,
    'IFV missile count is not 20'
  );
  ok(
    weaponDefs.tank_coax_mg.maxHeat === 100 &&
      weaponDefs.tank_coax_mg.heatBuildPerSec === 15 &&
      weaponDefs.tank_coax_mg.heatCoolPerSec === 20 &&
      weaponDefs.tank_coax_mg.heatIdleDelay === 1 &&
      weaponDefs.tank_coax_mg.magSize == null &&
      weaponDefs.tank_gunner_hmg.maxHeat === 100 &&
      weaponDefs.tank_gunner_hmg.heatBuildPerSec === 15 &&
      weaponDefs.tank_gunner_hmg.heatCoolPerSec === 20 &&
      weaponDefs.tank_gunner_hmg.heatIdleDelay === 1 &&
      weaponDefs.tank_gunner_hmg.magSize == null,
    'tank secondary overheat setup is incorrect'
  );

  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'js', 'maps', 'island-conquest.js'), 'utf8'),
    context,
    { filename: 'js/maps/island-conquest.js' }
  );
  const mapApi = context.window.VF.IslandConquestMap;
  ok(mapApi && typeof mapApi.buildRepairStations === 'function', 'map repair station builder is missing');
  const plannedStations = mapApi.buildRepairStations({
    worldSize: 1024,
    _plannedBases: [
      { x: 1024 * mapApi.HQ.ally.nx, z: 1024 * mapApi.HQ.ally.nz, gate: mapApi.HQ.ally.gate },
      { x: 1024 * mapApi.HQ.enemy.nx, z: 1024 * mapApi.HQ.enemy.nz, gate: mapApi.HQ.enemy.gate },
    ],
  });
  ok(
    plannedStations.length === 3 &&
      plannedStations.filter(function (row) { return row.team === 'neutral'; }).length === 1 &&
      plannedStations.filter(function (row) { return row.team === 'ally'; }).length === 1 &&
      plannedStations.filter(function (row) { return row.team === 'enemy'; }).length === 1,
    'map does not place center and both-base repair stations'
  );

  Vehicles.init(null, {
    worldSize: 64,
    getWalkHeight() {
      return 0;
    },
    getTerrainTop() {
      return 0;
    },
  });
  Vehicles.reset([
    { id: 'depot-tank', type: 'tank', team: 'ally', x: 0, z: 0, y: 0 },
    { id: 'depot-foe', type: 'tank', team: 'enemy', x: 0, z: 0, y: 0 },
    { id: 'depot-ifv', type: 'ifv', team: 'ally', x: 0, z: 0, y: 0 },
  ]);
  const depotTank = Vehicles.getById('depot-tank');
  const depotFoe = Vehicles.getById('depot-foe');
  const depotIfv = Vehicles.getById('depot-ifv');
  depotTank.hp = 500;
  depotTank.weapons.tank_main_cannon.mag = 0;
  depotFoe.hp = 500;
  depotIfv.weapons.ifv_at_missile.mag = 0;
  depotIfv.weapons.ifv_at_missile.reserve = 0;
  Vehicles.setStations([{ id: 'ally-bay', team: 'ally', x: 0, z: 0, radius: 18 }]);
  Vehicles.update(1);
  near(depotTank.hp, 550, 0.02, 'ally tank did not repair 5% max HP per second');
  ok(depotFoe.hp === 500, 'enemy tank repaired at an ally-only station');
  Vehicles.update(2);
  ok(
    depotTank.weapons.tank_main_cannon.mag === 3,
    'station did not restore 10% main-cannon ammo every 2 seconds'
  );
  ok(
    depotIfv.weapons.ifv_at_missile.mag + depotIfv.weapons.ifv_at_missile.reserve === 2,
    'station did not restore 10% of 20 IFV missiles every 2 seconds'
  );
  Vehicles.setStations([]);
  Vehicles.reset([]);

  const sampled = [];
  const world = {
    worldSize: 512,
    sampleDriveHeight(x, z, halfX, halfZ, yaw, maxStep) {
      sampled.push({ x, z, halfX, halfZ, yaw, maxStep });
      return { y: 3, minY: 3, maxY: 3, climbable: true };
    },
    getWalkHeight() {
      return 3;
    },
  };
  Vehicles.init(null, world);
  let spawned = Vehicles.reset([
    { id: 'seat-jeep', type: 'jeep', team: 'ally', x: 30, z: 30 },
    { id: 'seat-ifv', type: 'ifv', team: 'ally', x: 60, z: 30 },
  ]);
  ok(spawned.length === 2 && sampled.length >= 2, 'reset did not spawn grounded vehicles');

  const first = entity('rider-1');
  const second = entity('rider-2');
  ok(Vehicles.mount(first, 'seat-jeep', 0), 'first rider could not mount');
  ok(!Vehicles.mount(second, 'seat-jeep', 0), 'occupied seat accepted a second rider');
  ok(!Vehicles.mount(first, 'seat-jeep', 1), 'mounted rider occupied a duplicate seat');
  Vehicles.setDriverInput('seat-jeep', { throttle: 1, steer: 0.5 });
  ok(Vehicles.switchSeat(first, 1), 'rider could not switch to an open seat');
  ok(
    spawned[0].seats[0].occupant === null &&
      spawned[0].seats[1].occupant === first &&
      first.vehicleRole === 'passenger',
    'seat switch did not move the occupant cleanly'
  );
  ok(
    spawned[0].driverInput.throttle === 0 &&
      spawned[0].driverInput.brake === 1,
    'leaving the driver seat did not stop the vehicle'
  );
  ok(Vehicles.dismount(first), 'rider could not dismount');
  ok(
    first.vehicleId === null &&
      first.vehicleSeat === null &&
      first.vehicleRole === null &&
      spawned[0].seats[1].occupant === null,
    'dismount did not clear rider and seat state'
  );

  ok(Vehicles.mount(first, 'seat-jeep', 0), 'rider could not remount for sequential seats');
  for (let seat = 1; seat <= 5; seat++) {
    ok(Vehicles.switchSeat(first, seat), 'F' + (seat + 1) + ' did not switch to seat ' + (seat + 1));
    ok(first.vehicleSeat === seat, 'sequential seat switch did not land on seat ' + (seat + 1));
  }
  const aiSwap = entity('ai-swap', true);
  ok(Vehicles.mount(aiSwap, 'seat-jeep', 0), 'AI could not occupy seat 1 for swap');
  ok(Vehicles.switchSeat(first, 0), 'player could not take an AI-occupied seat');
  ok(
    first.vehicleSeat === 0 &&
      aiSwap.vehicleSeat === 5 &&
      spawned[0].seats[0].occupant === first &&
      spawned[0].seats[5].occupant === aiSwap,
    'switching onto an AI seat did not swap occupants'
  );
  ok(Vehicles.dismount(first), 'player could not dismount after seat swap');
  ok(Vehicles.dismount(aiSwap), 'AI could not dismount after seat swap');

  ok(
    Vehicles.canUseVehicleFirstPerson({
      vehicleId: 'seat-ifv',
      vehicleRole: 'driver',
    }),
    'IFV driver must still be able to use first person'
  );
  ok(
    Vehicles.canUseVehicleFirstPerson({
      vehicleId: 'seat-ifv',
      vehicleRole: 'gunner',
    }),
    'IFV gunner must still be able to use first person'
  );
  ok(
    !Vehicles.canUseVehicleFirstPerson({
      vehicleId: 'seat-ifv',
      vehicleRole: 'passenger',
    }),
    'unarmed IFV passenger must not toggle first person'
  );
  ok(
    !Vehicles.canUseVehicleFirstPerson({
      vehicleId: 'seat-jeep',
      vehicleRole: 'passenger',
    }),
    'jeep passenger must not toggle vehicle first person'
  );
  ok(
    Vehicles.canUseVehicleFirstPerson({
      vehicleId: 'seat-jeep',
      vehicleRole: 'driver',
    }),
    'jeep driver must still be able to toggle camera'
  );

  const aiRider = entity('ai-rider', true);
  ok(Vehicles.mount(aiRider, 'seat-jeep', 2), 'AI rider could not mount');
  ok(aiRider.mesh.visible === false, 'mounted AI mesh was not hidden');
  Vehicles.setDriverInput('seat-jeep', { throttle: 1, steer: 0.25 });
  Vehicles.update(0.1);
  ok(aiRider.mesh.position.y > 3, 'mounted AI position was not synchronized');
  ok(Vehicles.dismount(aiRider), 'AI rider could not dismount');
  ok(aiRider.mesh.visible === true, 'AI visibility was not restored after dismount');

  spawned = Vehicles.reset([
    { id: 'collision-a', type: 'tank', team: 'ally', x: 100, y: 3, z: 100 },
    { id: 'collision-b', type: 'tank', team: 'enemy', x: 104, y: 3, z: 100 },
  ]);
  Vehicles.update(0);
  ok(
    spawned[0].aabb.max.x <= spawned[1].aabb.min.x ||
      spawned[1].aabb.max.x <= spawned[0].aabb.min.x ||
      spawned[0].aabb.max.z <= spawned[1].aabb.min.z ||
      spawned[1].aabb.max.z <= spawned[0].aabb.min.z,
    'overlapping vehicle AABBs were not separated'
  );

  spawned = Vehicles.reset([
    { id: 'damage-ifv', type: 'ifv', team: 'ally', x: 80, y: 3, z: 80 },
    { id: 'damage-tank', type: 'tank', team: 'enemy', x: 120, y: 3, z: 80 },
  ]);
  const ifv = spawned[0];
  const tank = spawned[1];
  const ifvCrew = entity('ifv-crew');
  const tankCrew = entity('tank-crew');
  ok(Vehicles.mount(ifvCrew, ifv, 0), 'IFV crew could not mount');
  ok(Vehicles.mount(tankCrew, tank, 1), 'tank crew could not mount');
  let destroyedCrew = 0;
  Vehicles.onOccupantDestroyed = function () {
    destroyedCrew++;
  };

  ok(
    Vehicles.applyDamage(ifv, 200, { damageType: 'bullet' }) === 0,
    'bullet damage affected a vehicle'
  );
  ok(
    Vehicles.applyDamage(tank, 200, { damageType: 'explosive' }) === 0,
    'ordinary explosive damage affected a vehicle'
  );
  ok(ifv.hp === 600 && tank.hp === 1000, 'ignored damage changed vehicle HP');
  ok(
    Vehicles.applyDamage(ifv, 4, { damageType: 'lightArmor' }) === 4,
    'light armor chip did not apply to IFV'
  );
  ok(ifv.hp === 596, 'IFV HP after light armor chip is incorrect');
  ok(
    Vehicles.applyDamage(tank, 4, { damageType: 'lightArmor' }) === 0,
    'light armor chip affected a tank'
  );
  ok(tank.hp === 1000, 'tank HP changed from light armor chip');
  ok(
    Vehicles.applyDamage(tank, 5, { damageType: 'heavyArmor' }) === 5,
    'heavy armor chip did not apply to tank'
  );
  ok(tank.hp === 995, 'tank HP after heavy armor chip is incorrect');
  ok(
    Vehicles.applyDamage(ifv, 5, { damageType: 'heavyArmor' }) === 0,
    'heavy armor chip affected IFV'
  );
  tank.hp = 1000;
  ifv.hp = 600;
  ok(
    Vehicles.applyDamage(ifv, 200, { damageType: 'antiArmor', weaponId: 'rpg' }) === 200,
    'RPG damage against light armor was not 200'
  );
  ok(
    Vehicles.applyDamage(tank, 200, { damageType: 'antiArmor', weaponId: 'rpg' }) === 200,
    'tank still applied armor damage reduction'
  );
  ok(ifv.hp === 400 && tank.hp === 800, 'anti-armor HP results are incorrect');

  Vehicles.applyDamage(ifv, 1000, { damageType: 'antiArmor', weaponId: 'rpg' });
  Vehicles.applyDamage(tank, 1000, { damageType: 'antiArmor', weaponId: 'rpg' });
  ok(!ifv.alive && ifv.destroyed, 'IFV was not destroyed');
  ok(!tank.alive && tank.destroyed, 'tank was not destroyed');
  ok(
    ifv.seats.every((seatState) => !seatState.occupant && seatState.occupantId === null) &&
      tank.seats.every((seatState) => !seatState.occupant && seatState.occupantId === null),
    'destroyed vehicles retained occupied seats'
  );
  ok(
    ifvCrew.vehicleId === null && tankCrew.vehicleId === null,
    'destroyed vehicles retained crew entity state'
  );
  ok(destroyedCrew === 2, 'destroyed vehicle callback did not receive both crews');
  near(ifv.respawnTimer, 60, 1e-9, 'IFV respawn timer is incorrect');
  near(tank.respawnTimer, 75, 1e-9, 'tank respawn timer is incorrect');

  Vehicles.update(59.9);
  ok(!ifv.alive && !tank.alive, 'a vehicle respawned too early');
  Vehicles.update(0.2);
  ok(ifv.alive && ifv.hp === 600, 'IFV did not respawn at full HP');
  ok(!tank.alive, 'tank respawned before 75 seconds');
  Vehicles.update(15);
  ok(tank.alive && tank.hp === 1000, 'tank did not respawn at full HP');
  ok(
    ifv.seats.every((seatState) => seatState.occupantId === null) &&
      tank.seats.every((seatState) => seatState.occupantId === null),
    'respawned vehicles did not have empty seats'
  );

  spawned = Vehicles.reset([
    { id: 'weapon-tank', type: 'tank', team: 'ally', x: 100, y: 3, z: 100 },
    { id: 'weapon-ifv', type: 'ifv', team: 'enemy', x: 100, y: 3, z: 70 },
  ]);
  const weaponTank = spawned[0];
  const weaponIfv = spawned[1];
  const tankDriver = entity('tank-driver');
  const ifvDriver = entity('ifv-driver');
  ok(Vehicles.mount(tankDriver, weaponTank, 0), 'tank driver could not mount');
  ok(Vehicles.mount(ifvDriver, weaponIfv, 0), 'IFV driver could not mount');
  const tankHpBeforeHE = weaponTank.hp;
  const heShot = Vehicles.fireWeapon(
    weaponIfv,
    'ifv_he_autocannon',
    ifvDriver,
    { targetVehicle: weaponTank }
  );
  ok(heShot && heShot.type === 'hitscan', 'IFV HE cannon did not return a hitscan');
  ok(
    heShot.damageApplied === 0 && weaponTank.hp === tankHpBeforeHE,
    'IFV HE cannon damaged a vehicle'
  );
  const cannonShot = Vehicles.fireWeapon(
    weaponTank,
    'tank_main_cannon',
    tankDriver,
    { targetVehicle: weaponIfv }
  );
  ok(
    cannonShot &&
      cannonShot.type === 'projectile' &&
      cannonShot.damageType === 'antiArmor' &&
      weaponIfv.hp === 600,
    'tank main cannon did not launch an anti-armor projectile'
  );
  ok(
    Vehicles.fireWeapon(
      weaponTank,
      'tank_main_cannon',
      tankDriver,
      { targetVehicle: weaponIfv }
    ) === null,
    'tank main cannon fired again during its 4.2 second cooldown'
  );
  Vehicles.update(0.4);
  ok(
    cannonShot.damageApplied === 200 && weaponIfv.hp === 400,
    'tank main cannon projectile did not route anti-armor damage'
  );
  const missile = Vehicles.fireWeapon(
    weaponIfv,
    'ifv_at_missile',
    ifvDriver,
    { targetVehicle: weaponTank }
  );
  ok(
    missile &&
      missile.type === 'projectile' &&
      missile.guidance === 'aim' &&
      missile.targetVehicleId === weaponTank.id &&
      Vehicles.getProjectiles().indexOf(missile) >= 0,
    'IFV missile did not return an updateable guided projectile'
  );

  const heState = weaponIfv.weapons.ifv_he_autocannon;
  ok(
    heState.mag === 11 && heState.reserve === 192,
    'IFV HE cannon did not start as 12/192'
  );
  heState.mag = 0;
  heState.reserve = 0;
  heState.reloadTimer = 0;
  heState.ammoRegenTimer = 0;
  Vehicles.update(14.9);
  ok(
    heState.mag === 0 &&
      heState.reserve === 0 &&
      heState.ammoRegenTimer > 14,
    'IFV auto-replenish completed before 15 seconds'
  );
  Vehicles.update(0.2);
  ok(
    heState.mag === 1 && heState.reserve === 0,
    'IFV auto-replenish did not add 1 round after 15 seconds'
  );
  const heView = Vehicles.getWeaponAmmoView(heState, weaponDefs.ifv_he_autocannon);
  ok(
    heView.regenerating &&
      heView.cap === 204 &&
      heView.limit === 102 &&
      heView.loaded === 1 &&
      heView.current === 1,
    'IFV ammo view is incorrect'
  );

  const cannonState = weaponTank.weapons.tank_main_cannon;
  ok(cannonState.mag === 29, 'tank main cannon did not consume one of 30 shells');
  cannonState.mag = 10;
  cannonState.ammoRegenTimer = 0;
  Vehicles.update(15);
  ok(cannonState.mag === 11, 'tank cannon auto-replenish did not add 1 shell');
  cannonState.mag = 14;
  cannonState.ammoRegenTimer = 14.9;
  Vehicles.update(0.2);
  ok(cannonState.mag === 15, 'tank cannon auto-replenish did not fill to 50%');
  cannonState.ammoRegenTimer = 15;
  Vehicles.update(0.05);
  ok(
    cannonState.mag === 15 && cannonState.ammoRegenTimer === 0,
    'tank cannon auto-replenish exceeded 50%'
  );
  const coaxState = weaponTank.weapons.tank_coax_mg;
  coaxState.ammoRegenTimer = 0;
  Vehicles.update(15);
  ok(
    (coaxState.ammoRegenTimer || 0) === 0 &&
      Vehicles.getWeaponAmmoView(coaxState, weaponDefs.tank_coax_mg).infinite,
    'heat weapon received finite ammo auto-replenish'
  );

  const tankGunner = entity('tank-gunner');
  ok(Vehicles.mount(tankGunner, weaponTank, 1), 'tank gunner could not mount');
  const hmgState = weaponTank.weapons.tank_gunner_hmg;
  hmgState.heat = 0;
  hmgState.overheated = false;
  hmgState.heatShotAge = 0;
  let heatHold = 0;
  while (heatHold + 1e-9 < 2) {
    hmgState.cooldown = 0;
    ok(
      Vehicles.fireWeapon(weaponTank, 'tank_gunner_hmg', tankGunner),
      'tank HMG did not fire while heating'
    );
    Vehicles.update(0.1);
    heatHold += 0.1;
  }
  near(hmgState.heat, 30, 1.2, 'tank HMG heat did not build at 15% per second');
  hmgState.heatShotAge = 0.5;
  const heatHeld = hmgState.heat;
  Vehicles.update(0.4);
  near(hmgState.heat, heatHeld, 0.3, 'tank HMG cooled before the 1s idle delay');
  Vehicles.update(0.2);
  near(hmgState.heat, heatHeld - 4, 0.6, 'tank HMG did not cool at 20% per second after 1s');
  hmgState.heat = 0;
  hmgState.overheated = false;
  let overheatTime = 0;
  while (!hmgState.overheated && overheatTime < 8) {
    hmgState.cooldown = 0;
    const hmgShot = Vehicles.fireWeapon(weaponTank, 'tank_gunner_hmg', tankGunner);
    if (!hmgShot && !hmgState.overheated) break;
    Vehicles.update(0.1);
    overheatTime += 0.1;
  }
  ok(
    hmgState.overheated && hmgState.heat >= 99 && overheatTime > 6 && overheatTime < 7.5,
    'tank HMG did not overheat after ~6.7s of continuous fire'
  );
  ok(
    Vehicles.fireWeapon(weaponTank, 'tank_gunner_hmg', tankGunner) === null,
    'overheated tank HMG still fired'
  );
  const heatLocked = hmgState.heat;
  Vehicles.update(0.5);
  ok(hmgState.heat < heatLocked - 8, 'overheated HMG did not start forced cooling');

  const normalWorld = Vehicles.world;
  Vehicles.init(null, {
    worldSize: 512,
    get() {
      return 1;
    },
    getTerrainTop() {
      return 3;
    },
  });
  spawned = Vehicles.reset([
    { id: 'blocked-tank', type: 'tank', team: 'ally', x: 100, y: 3, z: 100 },
    { id: 'blocked-ifv', type: 'ifv', team: 'enemy', x: 100, y: 3, z: 70 },
  ]);
  const blockedDriver = entity('blocked-driver');
  Vehicles.mount(blockedDriver, spawned[0], 0);
  Vehicles.setAim(spawned[0], {
    target: spawned[1],
    role: 'driver',
  });
  const blockedShot = Vehicles.fireWeapon(
    spawned[0],
    'tank_main_cannon',
    blockedDriver,
    { targetVehicle: spawned[1] }
  );
  Vehicles.update(0.1);
  ok(
    blockedShot &&
      blockedShot.worldHit &&
      spawned[1].hp === 600,
    'world obstruction did not block a tank shell'
  );
  Vehicles.init(null, normalWorld);

  spawned = Vehicles.reset([
    { id: 'rear-fire-tank', type: 'tank', team: 'ally', x: 100, y: 3, z: 100 },
    { id: 'rear-fire-ifv', type: 'ifv', team: 'enemy', x: 100, y: 3, z: 135 },
  ]);
  const rearDriver = entity('rear-driver');
  Vehicles.mount(rearDriver, spawned[0], 0);
  Vehicles.setAim(spawned[0], {
    yaw: Math.PI,
    pitch: 0,
    role: 'driver',
  });
  const rearShot = Vehicles.fireWeapon(
    spawned[0],
    'tank_main_cannon',
    rearDriver,
    { direction: { x: 0, y: 0, z: 1 } }
  );
  ok(
    rearShot && rearShot.position.z > spawned[0].position.z,
    'rear-facing turret did not rotate the muzzle origin'
  );

  spawned = Vehicles.reset([
    { id: 'event-tank', type: 'tank', team: 'ally', x: 100, y: 3, z: 100 },
    { id: 'event-ifv', type: 'ifv', team: 'enemy', x: 100, y: 3, z: 70 },
  ]);
  spawned[1].hp = 125;
  const eventDriver = entity('event-driver');
  Vehicles.mount(eventDriver, spawned[0], 0);
  let cannonFireEvents = 0;
  let cannonHitEvent = null;
  const offFire = Vehicles.on('vehicle-weapon-fired', function (event) {
    if (event.data.weaponId === 'tank_main_cannon') cannonFireEvents++;
  });
  const offHit = Vehicles.on('vehicle-weapon-hit', function (event) {
    if (event.data.weaponId === 'tank_main_cannon') cannonHitEvent = event.data;
  });
  const acceptedEventShot = Vehicles.fireWeapon(
    spawned[0],
    'tank_main_cannon',
    eventDriver,
    {
      targetVehicle: spawned[1],
      shotId: 'vehicle-shot-guest-check-1',
    }
  );
  const cooldownEventShot = Vehicles.fireWeapon(
    spawned[0],
    'tank_main_cannon',
    eventDriver,
    {
      targetVehicle: spawned[1],
      shotId: 'vehicle-shot-guest-check-2',
    }
  );
  ok(
    acceptedEventShot &&
      cooldownEventShot === null &&
      cannonFireEvents === 1,
    'accepted/rejected cannon fire did not emit exactly one presentation event'
  );
  Vehicles.update(0.4);
  ok(
    cannonHitEvent &&
      cannonHitEvent.shotId === acceptedEventShot.id &&
      cannonHitEvent.ownerId === eventDriver.entityId &&
      cannonHitEvent.damage === 125 &&
      cannonHitEvent.finalDamage === 200 &&
      cannonHitEvent.normal,
    'cannon armor hit event did not include type, owner, normal and damage'
  );
  offFire();
  offHit();

  spawned = Vehicles.reset([
    { id: 'dedupe-tank', type: 'tank', team: 'ally', x: 100, y: 3, z: 100 },
  ]);
  const dedupeDriver = entity('dedupe-driver');
  Vehicles.mount(dedupeDriver, spawned[0], 0);
  const staleDedupeWire = JSON.parse(JSON.stringify(Vehicles.getSnapshot()));
  const predictedShot = Vehicles.fireWeapon(
    spawned[0],
    'tank_main_cannon',
    dedupeDriver,
    {
      direction: { x: 0, y: 0, z: -1 },
      predictOnly: true,
      shotId: 'vehicle-shot-guest-dedupe-1',
    }
  );
  Vehicles.applySnapshot(staleDedupeWire);
  ok(
    spawned[0].weapons.tank_main_cannon.mag === 29 &&
      spawned[0].weapons.tank_main_cannon.cooldown > 4 &&
      Vehicles.fireWeapon(
        spawned[0],
        'tank_main_cannon',
        dedupeDriver,
        {
          direction: { x: 0, y: 0, z: -1 },
          predictOnly: true,
          shotId: 'vehicle-shot-guest-dedupe-2',
        }
      ) === null,
    'stale PVP snapshot rolled back predicted ammo/cooldown'
  );
  const dedupeWire = JSON.parse(JSON.stringify(staleDedupeWire));
  dedupeWire.vehicles[0].weapons.tank_main_cannon.mag = 14;
  dedupeWire.vehicles[0].weapons.tank_main_cannon.ammo = 14;
  dedupeWire.vehicles[0].weapons.tank_main_cannon.cooldown = 4;
  dedupeWire.projectiles = [{
    id: predictedShot.id,
    vehicleId: predictedShot.vehicleId,
    ownerId: predictedShot.ownerId,
    team: predictedShot.team,
    weaponId: predictedShot.weaponId,
    damage: predictedShot.damage,
    damageType: predictedShot.damageType,
    position: predictedShot.position,
    direction: predictedShot.direction,
    speed: predictedShot.speed,
    life: predictedShot.life,
    gravity: predictedShot.gravity,
  }];
  Vehicles.applySnapshot(dedupeWire);
  ok(
    Vehicles.getProjectiles().length === 1 &&
      Vehicles.getProjectiles()[0] === predictedShot &&
      predictedShot.remote === true &&
      !spawned[0].weapons.tank_main_cannon._prediction,
    'PVP snapshot did not de-duplicate the locally predicted projectile by shotId'
  );

  spawned = Vehicles.reset([
    { id: 'rpg-target', type: 'tank', team: 'enemy', x: 100, y: 3, z: 70 },
  ]);
  const rpgTarget = spawned[0];
  let projectileHookCalls = 0;
  Vehicles.onProjectileUpdate = function () {
    projectileHookCalls++;
  };
  const rpg = Vehicles.launchProjectile({
    weaponId: 'rpg',
    ownerId: 'engineer-1',
    team: 'ally',
    origin: { x: 100, y: 4.5, z: 100 },
    direction: { x: 0, y: 0, z: -1 },
  });
  ok(rpg && rpg.weaponId === 'rpg', 'RPG projectile did not launch');
  Vehicles.update(1);
  ok(rpgTarget.hp === 850, 'RPG projectile did not apply 150 anti-armor damage');
  ok(projectileHookCalls === 1, 'vehicle projectile hit skipped the explosion hook');
  Vehicles.onProjectileUpdate = null;

  spawned = Vehicles.reset([
    { id: 'snap-jeep', type: 'jeep', team: 'ally', x: 150, y: 4, z: 150 },
    { id: 'snap-ifv', type: 'ifv', team: 'enemy', x: 200, y: 5, z: 200 },
  ]);
  const localPlayer = entity('player-local');
  context.window.VF.game = { player: localPlayer };
  ok(Vehicles.mount(localPlayer, spawned[0], 0), 'local player could not mount for snapshot test');
  Vehicles.setAim(spawned[1], { yaw: 0.7, pitch: 0.1 });
  const wire = JSON.parse(JSON.stringify(Vehicles.getSnapshot()));
  ok(wire.version === 1 && wire.vehicles.length === 2, 'snapshot shape is incorrect');
  wire.vehicles[0].seats[0].occupantId = 'player-local';
  wire.vehicles[1].seats[2].occupantId = 'remote-ai-7';
  spawned[0].position.x = 999;
  spawned[1].hp = 1;
  ok(Vehicles.applySnapshot(wire) === 2, 'snapshot did not apply to both vehicles');
  ok(spawned[0].position.x === 150, 'snapshot position was not restored');
  ok(spawned[1].hp === 600, 'snapshot HP was not restored');
  ok(
    spawned[0].seats[0].occupant === localPlayer &&
      spawned[0].seats[0].occupantId === 'player-local',
    'snapshot rebuilt or replaced the local player seat reference'
  );
  ok(
    spawned[1].seats[2].occupant === null &&
      spawned[1].seats[2].occupantId === 'remote-ai-7',
    'remote seat occupantId was not replicated'
  );
  const roundTrip = JSON.parse(JSON.stringify(Vehicles.getSnapshot()));
  ok(Vehicles.applySnapshot(roundTrip) === 2, 'round-trip snapshot could not be reapplied');
  ok(
    JSON.stringify(Vehicles.getSnapshot()) === JSON.stringify(roundTrip),
    'snapshot changed during a JSON round trip'
  );
  const protocol = context.window.VF.NetProtocol;
  const vehicleHash = protocol.vehicleChecksum(roundTrip);
  roundTrip.vehicles[0].hp -= 1;
  ok(
    protocol.vehicleChecksum(roundTrip) !== vehicleHash,
    'vehicle checksum did not detect an HP change'
  );
  roundTrip.vehicles[0].hp += 1;
  const weaponSnapshot = Vehicles.reset([
    { id: 'hash-tank', type: 'tank', team: 'ally', x: 10, y: 3, z: 10 },
  ]);
  const weaponWire = Vehicles.getSnapshot();
  const weaponHash = protocol.vehicleChecksum(weaponWire);
  weaponWire.vehicles[0].weapons.tank_main_cannon.mag -= 1;
  ok(
    protocol.vehicleChecksum(weaponWire) !== weaponHash,
    'vehicle checksum did not detect an ammo change'
  );
  Vehicles.reset(roundTrip.vehicles);
  Vehicles.mount(localPlayer, 'snap-jeep', 0);

  const deploy = Vehicles.getDeployPoints('ally');
  ok(
    deploy.length === 1 &&
      deploy[0].kind === 'vehicle' &&
      deploy[0].seatCount === 6 &&
      deploy[0].openSeats === 5,
    'vehicle deploy point did not expose seat occupancy'
  );

  const net = context.window.VF.NetSimulation;
  context.window.VF.Pvp = {
    mode: 'host',
    remoteLoadout: {
      team: 'enemy',
      classId: 'engineer',
    },
    remoteState: {
      team: 'enemy',
      classId: 'engineer',
      alive: true,
      x: 40,
      y: 3,
      z: 40,
    },
    _send() {},
  };
  context.window.VF.game = {
    mode: 'pvp',
    pvp: { conquest: true },
    player: localPlayer,
    world: {
      _spawnPoints: {
        all: [
          {
            id: 'enemy-hq',
            team: 'enemy',
            fixed: true,
            x: 40,
            y: 3,
            z: 40,
          },
        ],
      },
    },
  };
  context.window.VF.Conquest = {
    active: true,
    matchId: 'vehicle-net-test',
    getStateSnapshot() {
      return {
        matchId: 'vehicle-net-test',
        phase: 'live',
        ended: false,
        winner: null,
        endReason: '',
        elapsed: 10,
        tickets: { ally: 1000, enemy: 1000 },
        ticketsMax: 1000,
        roundSec: 2700,
        sweepSec: 60,
        sweep: { ally: 0, enemy: 0 },
        flags: [],
      };
    },
  };
  Vehicles.reset([
    { id: 'net-enemy-jeep', type: 'jeep', team: 'enemy', x: 40, y: 3, z: 40 },
  ]);
  net.reset();
  ok(
    net._receiveVehicleCommand('vehicle-mount', {
      vehicleId: 'net-enemy-jeep',
      seatIndex: 0,
    }),
    'host rejected a valid remote vehicle mount'
  );
  ok(
    net._receiveVehicleCommand('vehicle-input', {
      vehicleId: 'net-enemy-jeep',
      seatIndex: 0,
      throttle: 1,
      steer: 0.25,
      brake: 0,
      aimYaw: 0.4,
      aimPitch: 0.05,
      weaponIndex: 0,
      fire: false,
    }),
    'host rejected valid remote driver input'
  );
  const netVehicle = Vehicles.getById('net-enemy-jeep');
  ok(
    netVehicle.seats[0].occupantId === 'remote-player' &&
      netVehicle.driverInput.throttle === 1,
    'remote vehicle command was not applied authoritatively'
  );
  const bundle = net._bundle();
  ok(
    bundle &&
      bundle.vehicles.vehicles.length === 1 &&
      bundle.vehicleChecksum === protocol.vehicleChecksum(bundle.vehicles),
    'network bundle did not include a valid vehicle snapshot'
  );
  context.window.VF.Pvp.phase = 'play';
  context.window.VF.MatchFlow = { phase: 'live' };
  const validCommand = protocol.envelope(
    'conquest-command',
    { command: 'snapshot', data: {} },
    { matchId: 'vehicle-net-test', seq: 1 }
  );
  validCommand._receivedAt = performance.now();
  ok(net.receive(validCommand), 'valid live-match command was rejected');
  const wrongMatch = protocol.envelope(
    'conquest-command',
    { command: 'snapshot', data: {} },
    { matchId: 'wrong-match', seq: 2 }
  );
  wrongMatch._receivedAt = performance.now();
  ok(!net.receive(wrongMatch), 'wrong-match command was accepted');
  ok(
    net._receiveVehicleCommand('vehicle-dismount', {}),
    'host could not dismount the remote vehicle actor'
  );
  Vehicles.reset([
    { id: 'net-enemy-tank', type: 'tank', team: 'enemy', x: 40, y: 3, z: 40 },
  ]);
  ok(
    net._receiveVehicleCommand('vehicle-mount', {
      vehicleId: 'net-enemy-tank',
      seatIndex: 0,
    }),
    'host rejected the remote tank mount'
  );
  const networkShotId = 'vehicle-shot-guest-network-1';
  ok(
    net._receiveVehicleCommand('vehicle-input', {
      vehicleId: 'net-enemy-tank',
      seatIndex: 0,
      aimYaw: 0,
      aimPitch: 0,
      weaponIndex: 1,
      weaponId: 'tank_main_cannon',
      fire: true,
      shotId: networkShotId,
      fireDirection: { x: 1, y: 0, z: 0 },
    }),
    'host rejected the predicted cannon command'
  );
  ok(
    Vehicles.lastShot &&
      Vehicles.lastShot.id === networkShotId &&
      Vehicles.lastShot.weaponId === 'tank_main_cannon' &&
      nearDirection(Vehicles.lastShot.direction, { x: 1, y: 0, z: 0 }),
    'host did not preserve the predicted weapon, shotId and fire direction'
  );
  const acceptedNetworkShot = Vehicles.lastShot;
  const networkProjectileCount = Vehicles.getProjectiles().length;
  Vehicles.getById('net-enemy-tank').weapons.tank_main_cannon.cooldown = 0;
  net._receiveVehicleCommand('vehicle-input', {
    vehicleId: 'net-enemy-tank',
    seatIndex: 0,
    aimYaw: 0,
    aimPitch: 0,
    weaponIndex: 1,
    weaponId: 'tank_main_cannon',
    fire: true,
    shotId: networkShotId,
    fireDirection: { x: 1, y: 0, z: 0 },
  });
  ok(
    Vehicles.lastShot === acceptedNetworkShot &&
      Vehicles.getProjectiles().length === networkProjectileCount,
    'host accepted a duplicate PVP shotId'
  );
  ok(
    !net._receiveVehicleCommand('vehicle-input', {
      vehicleId: 'net-enemy-tank',
      seatIndex: 0,
      role: 'driver',
      aimYaw: 0,
      aimPitch: 0,
      weaponIndex: 1,
      weaponId: 'tank_gunner_hmg',
      fire: true,
      shotId: 'vehicle-shot-guest-invalid-role',
      fireDirection: { x: 1, y: 0, z: 0 },
    }) &&
      Vehicles.lastShot === acceptedNetworkShot &&
      Vehicles.getProjectiles().length === networkProjectileCount,
    'host fell back to another weapon for a mismatched bound weapon'
  );
  net.applyRemoteVehicleState({
    vehicleId: 'net-enemy-tank',
    vehicleSeat: 0,
    vehicleRole: 'driver',
    vehicleAimYaw: 0,
    vehicleAimPitch: 0,
    vehicleWeaponIndex: 0,
    vehicleFire: true,
    alive: true,
  });
  ok(
    Vehicles.lastShot === acceptedNetworkShot,
    'lossy player-state replication fired a second cannon shot'
  );
  ok(
    net._receiveVehicleCommand('vehicle-dismount', {}),
    'host could not dismount the remote tank actor'
  );
  const remoteActor = net._remoteVehicleActor();
  const rpgAccepted = net._receiveVehicleCommand('rpg-fire', {
    origin: {
      x: remoteActor.position.x,
      y: remoteActor.position.y + 1.3,
      z: remoteActor.position.z,
    },
    direction: { x: 0, y: 0, z: -1 },
  });
  ok(rpgAccepted, 'host rejected a valid remote engineer RPG shot');
  ok(
    !net._receiveVehicleCommand('rpg-fire', {
      origin: {
        x: remoteActor.position.x,
        y: remoteActor.position.y + 1.3,
        z: remoteActor.position.z,
      },
      direction: { x: 0, y: 0, z: -1 },
    }),
    'host accepted an RPG shot during cooldown'
  );
  const projectileWire = Vehicles.getSnapshot();
  ok(
    projectileWire.projectiles.filter(function (projectile) {
      return projectile.weaponId === 'rpg';
    }).length === 1,
    'network RPG projectile was not snapshotted'
  );
  const projectileHash = protocol.vehicleChecksum(projectileWire);
  projectileWire.projectiles[0].speed += 1;
  ok(
    protocol.vehicleChecksum(projectileWire) !== projectileHash,
    'vehicle checksum did not detect a projectile speed change'
  );

  const perfTarget = netVehicle;
  const perfStart = performance.now();
  let ignoredTotal = 0;
  for (let i = 0; i < 10000; i++) {
    ignoredTotal += Vehicles.applyDamage(perfTarget, 200, {
      damageType: i % 2 ? 'bullet' : 'explosive',
    });
  }
  const damagePerfMs = performance.now() - perfStart;
  ok(ignoredTotal === 0 && perfTarget.hp === 360, '10k ignored hits changed vehicle HP');
  ok(
    damagePerfMs < 1500,
    '10k damage checks exceeded the generous CPU budget: ' + damagePerfMs.toFixed(2) + 'ms'
  );

  ok(defs.jeep.canRam === false, 'jeep must not ram structures');
  ok(defs.ifv.canRam === true && defs.tank.canRam === true, 'IFV and tank must be able to ram');
  ok(
    defs.jeep.maxStep === 2.5 &&
      defs.ifv.maxStep === 3.6 &&
      defs.tank.maxStep === 4.2,
    'vehicle obstacle clearance was not doubled'
  );

  const SOLID = 2;
  const AIR = 0;
  function makeRamWorld() {
    const cells = Object.create(null);
    function key(x, y, z) {
      return Math.floor(x) + ',' + Math.floor(y) + ',' + Math.floor(z);
    }
    const world = {
      worldSize: 512,
      props: [],
      sampleDriveHeight() {
        return { y: 3, minY: 3, maxY: 3, climbable: true };
      },
      getWalkHeight() {
        return 3;
      },
      get(x, y, z) {
        return cells[key(x, y, z)] || AIR;
      },
      set(x, y, z, t) {
        const k = key(x, y, z);
        if (t) cells[k] = t;
        else delete cells[k];
      },
      _isTerrainFill() {
        return false;
      },
      _isStructureSolid(x, y, z) {
        return world.get(x, y, z) === SOLID;
      },
      breakBlock(x, y, z) {
        if (!world._isStructureSolid(x, y, z)) return false;
        world.set(x, y, z, AIR);
        return true;
      },
      destroyProp(prop) {
        const i = world.props.indexOf(prop);
        if (i < 0) return false;
        world.props.splice(i, 1);
        return true;
      },
      overlapsSolid(box) {
        const minX = Math.floor(box.min.x);
        const maxX = Math.floor(box.max.x);
        const minY = Math.floor(box.min.y);
        const maxY = Math.floor(box.max.y);
        const minZ = Math.floor(box.min.z);
        const maxZ = Math.floor(box.max.z);
        for (let x = minX; x <= maxX; x++) {
          for (let y = minY; y <= maxY; y++) {
            for (let z = minZ; z <= maxZ; z++) {
              if (world._isStructureSolid(x, y, z)) return true;
            }
          }
        }
        for (let i = 0; i < world.props.length; i++) {
          const p = world.props[i];
          if (!p || !p.box) continue;
          if (
            box.min.x <= p.box.max.x &&
            box.max.x >= p.box.min.x &&
            box.min.y <= p.box.max.y &&
            box.max.y >= p.box.min.y &&
            box.min.z <= p.box.max.z &&
            box.max.z >= p.box.min.z
          ) {
            return true;
          }
        }
        return false;
      },
      fillWall(x0, x1, y0, y1, z) {
        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y <= y1; y++) {
            world.set(x, y, z, SOLID);
          }
        }
      },
      countSolid() {
        return Object.keys(cells).length;
      },
    };
    return world;
  }

  const ramEvents = [];
  Vehicles.on('vehicle-ram-break', function (event) {
    ramEvents.push(event.data);
  });

  const tankWorld = makeRamWorld();
  tankWorld.fillWall(47, 53, 4, 7, 16);
  Vehicles.init(null, tankWorld);
  spawned = Vehicles.reset([
    { id: 'ram-tank', type: 'tank', team: 'ally', x: 50, y: 3, z: 20, yaw: 0 },
  ]);
  spawned[0].speed = 8;
  Vehicles.setDriverInput(spawned[0], { throttle: 1 });
  Vehicles.update(0.05);
  ok(tankWorld.countSolid() < 28, 'tank ram did not break the structure wall');
  ok(spawned[0].position.z < 20, 'tank did not continue through the broken wall');
  near(spawned[0].speed, 4.14, 0.4, 'tank speed did not drop to about half after ramming');
  ok(spawned[0].ramSlowTimer > 0, 'tank ram slow timer was not applied');
  ok(
    ramEvents.some((data) => data.vehicleId === 'ram-tank' && data.voxels.length > 0),
    'tank ram did not emit broken voxels'
  );

  const jeepWorld = makeRamWorld();
  jeepWorld.fillWall(77, 83, 4, 7, 16);
  Vehicles.init(null, jeepWorld);
  spawned = Vehicles.reset([
    { id: 'ram-jeep', type: 'jeep', team: 'ally', x: 80, y: 3, z: 18, yaw: 0 },
  ]);
  spawned[0].speed = 8;
  Vehicles.setDriverInput(spawned[0], { throttle: 1 });
  const jeepZ = spawned[0].position.z;
  Vehicles.update(0.05);
  ok(jeepWorld.countSolid() === 28, 'jeep rammed and broke a wall');
  near(spawned[0].position.z, jeepZ, 1e-6, 'jeep drove through a structure');
  ok(
    ramEvents.every((data) => data.vehicleType !== 'jeep'),
    'jeep emitted a ram-break event'
  );

  const ifvWorld = makeRamWorld();
  ifvWorld.fillWall(107, 113, 4, 7, 16);
  Vehicles.init(null, ifvWorld);
  spawned = Vehicles.reset([
    { id: 'ram-ifv', type: 'ifv', team: 'ally', x: 110, y: 3, z: 20, yaw: 0 },
  ]);
  spawned[0].speed = 9;
  Vehicles.setDriverInput(spawned[0], { throttle: 1 });
  Vehicles.update(0.05);
  ok(ifvWorld.countSolid() < 28, 'IFV ram did not break the structure wall');
  ok(spawned[0].position.z < 20, 'IFV did not continue through the broken wall');
  near(spawned[0].speed, 4.68, 0.45, 'IFV speed did not drop to about half after ramming');

  const doorWorld = makeRamWorld();
  doorWorld.props.push({
    kind: 'door',
    breakable: true,
    box: { min: { x: 48, y: 3.2, z: 16.2 }, max: { x: 52, y: 6.2, z: 17.2 } },
  });
  Vehicles.init(null, doorWorld);
  spawned = Vehicles.reset([
    { id: 'ram-door-tank', type: 'tank', team: 'ally', x: 50, y: 3, z: 20, yaw: 0 },
  ]);
  spawned[0].speed = 8;
  Vehicles.setDriverInput(spawned[0], { throttle: 1 });
  Vehicles.update(0.05);
  ok(doorWorld.props.length === 0, 'tank ram did not destroy the blocking door');
  ok(spawned[0].position.z < 20, 'tank did not continue after ramming a door');

  const crawlWorld = makeRamWorld();
  crawlWorld.fillWall(47, 53, 4, 7, 16);
  Vehicles.init(null, crawlWorld);
  spawned = Vehicles.reset([
    { id: 'ram-slow-tank', type: 'tank', team: 'ally', x: 50, y: 3, z: 20, yaw: 0 },
  ]);
  spawned[0].speed = 1.2;
  Vehicles.setDriverInput(spawned[0], { throttle: 0.2 });
  Vehicles.update(0.05);
  ok(crawlWorld.countSolid() === 28, 'slow tank still demolished a wall');
  near(spawned[0].position.z, 20, 1e-6, 'slow tank moved while blocked by a wall');

  function makeDirectionalSlopeWorld() {
    return {
      worldSize: 512,
      sawTerrainBypass: false,
      sampleDriveHeight(x, z) {
        if (z >= 19.5) {
          return { y: 20, minY: 2, maxY: 20, climbable: false };
        }
        return { y: 2, minY: 2, maxY: 20, climbable: false };
      },
      overlapsSolid(box) {
        if (box.ignoreTerrain) {
          this.sawTerrainBypass = true;
          return false;
        }
        return true;
      },
    };
  }

  const downhillWorld = makeDirectionalSlopeWorld();
  Vehicles.init(null, downhillWorld);
  spawned = Vehicles.reset([
    { id: 'downhill-tank', type: 'tank', team: 'ally', x: 50, y: 20, z: 20, yaw: 0 },
  ]);
  spawned[0].speed = 8;
  Vehicles.setDriverInput(spawned[0], { throttle: 1 });
  Vehicles.update(0.1);
  ok(spawned[0].position.z < 19.5, 'tank was blocked by a large downward drop');
  near(spawned[0].position.y, 2, 1e-6, 'tank did not settle onto lower terrain');
  ok(
    downhillWorld.sawTerrainBypass,
    'downhill movement did not bypass the terrain rise collision'
  );

  const uphillWorld = makeDirectionalSlopeWorld();
  Vehicles.init(null, uphillWorld);
  spawned = Vehicles.reset([
    { id: 'uphill-tank', type: 'tank', team: 'ally', x: 50, y: 2, z: 19, yaw: Math.PI },
  ]);
  spawned[0].speed = 8;
  Vehicles.setDriverInput(spawned[0], { throttle: 1 });
  Vehicles.update(0.1);
  near(spawned[0].position.z, 19, 1e-6, 'tank climbed an excessive upward step');
  near(spawned[0].position.y, 2, 1e-6, 'blocked uphill tank changed elevation');

  function makePlazaLipWorld() {
    const PLAZA = 20;
    const HIGH = 15;
    const LOW = 13.9;
    return {
      worldSize: 512,
      terrainHits: 0,
      heightAt(z) {
        return z <= PLAZA ? HIGH : LOW;
      },
      sampleDriveHeight(x, z, halfX, halfZ, yaw) {
        const c = Math.cos(yaw || 0);
        const halfL = halfZ != null ? halfZ : 3.48;
        const frontZ = z - halfL * c;
        const rearZ = z + halfL * c;
        const frontY = this.heightAt(frontZ);
        const rearY = this.heightAt(rearZ);
        return {
          y: (frontY + rearY) * 0.5,
          frontY: frontY,
          rearY: rearY,
          minY: Math.min(frontY, rearY),
          maxY: Math.max(frontY, rearY),
          climbable: true,
        };
      },
      overlapsSolid(box) {
        if (box.ignoreTerrain) return false;
        this.terrainHits += 1;
        return true;
      },
    };
  }

  const plazaWorld = makePlazaLipWorld();
  Vehicles.init(null, plazaWorld);
  spawned = Vehicles.reset([
    { id: 'plaza-tank', type: 'tank', team: 'ally', x: 50, y: 13.9, z: 24, yaw: 0 },
  ]);
  spawned[0].speed = 8;
  Vehicles.setDriverInput(spawned[0], { throttle: 1 });
  let straddled = false;
  for (let i = 0; i < 16; i++) {
    Vehicles.update(0.1);
    const tank = spawned[0];
    if (tank.position.z < 23 && tank.position.z > 17.4) {
      straddled = true;
      ok(tank.pitch > 0.04, 'tank did not pitch up when the nose met the plaza lip');
      ok(
        tank.position.y > 13.9 && tank.position.y < 14.85,
        'tank center jumped onto the plaza before the tail climbed'
      );
    }
  }
  ok(straddled, 'tank never straddled the plaza lip');
  ok(spawned[0].position.z < 17.2, 'tank could not climb the 1.1m plaza lip from the west');
  near(spawned[0].position.y, 15, 0.08, 'tank did not settle onto the plaza after the tail climbed');
  near(spawned[0].pitch, 0, 0.05, 'tank kept a climb pitch after both ends were on the plaza');
  ok(plazaWorld.terrainHits === 0, 'plaza terrain AABB still blocked the straddling tank');

  spawned = Vehicles.reset([
    { id: 'pivot-tank', type: 'tank', team: 'ally', x: 40, y: 3, z: 40, yaw: 0 },
  ]);
  const pivot = spawned[0];
  pivot.speed = 0;
  Vehicles.setDriverInput(pivot, { throttle: 0, steer: 1, brake: 0 });
  Vehicles.update(0.5);
  const idleYaw = Math.abs(pivot.yaw);
  const idleTurn = pivot.def.idleTurn != null ? pivot.def.idleTurn : 0.9;
  near(
    idleYaw,
    pivot.def.turnRate * idleTurn * 0.5,
    0.04,
    'stationary tank turn rate was still speed-starved'
  );
  spawned = Vehicles.reset([
    { id: 'pivot-tank-move', type: 'tank', team: 'ally', x: 40, y: 3, z: 40, yaw: 0 },
  ]);
  const rolling = spawned[0];
  rolling.speed = rolling.def.maxSpeed;
  Vehicles.setDriverInput(rolling, { throttle: 1, steer: 1, brake: 0 });
  Vehicles.update(0.5);
  const movingYaw = Math.abs(rolling.yaw);
  ok(
    idleYaw > movingYaw * 0.8,
    'stationary tank turn is still far below moving turn'
  );

  spawned = Vehicles.reset([
    { id: 'optic-tank', type: 'tank', team: 'ally', x: 40, y: 3, z: 40, yaw: 0 },
    { id: 'optic-ifv', type: 'ifv', team: 'ally', x: 80, y: 3, z: 80, yaw: 0 },
  ]);
  Vehicles.setAim(spawned[0], { yaw: 0, pitch: 0, role: 'driver' });
  const opticForward = Vehicles.getFirstPersonCameraAnchor(spawned[0], 'driver');
  Vehicles.setAim(spawned[0], { yaw: Math.PI / 2, pitch: 0, role: 'driver' });
  const opticLeft = Vehicles.getFirstPersonCameraAnchor(spawned[0], 'driver');
  ok(opticForward && opticLeft, 'tank first-person camera anchor is missing');
  ok(
    opticForward.z < spawned[0].position.z - 1.5,
    'forward-facing tank optic is not mounted at the turret front'
  );
  ok(
    opticLeft.x < spawned[0].position.x - 1.2,
    'tank optic position did not rotate with the turret'
  );
  ok(
    Math.hypot(
      opticForward.x - opticLeft.x,
      opticForward.z - opticLeft.z
    ) > 1,
    'tank optic remained fixed to the hull while the turret rotated'
  );
  Vehicles.setAim(spawned[1], { yaw: -Math.PI / 2, pitch: 0, role: 'driver' });
  const ifvOptic = Vehicles.getFirstPersonCameraAnchor(spawned[1], 'driver');
  ok(
    ifvOptic && ifvOptic.x > spawned[1].position.x + 1,
    'IFV optic position did not rotate with the turret'
  );

  spawned[0].mesh = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    visible: true,
    userData: {
      turret: { rotation: { y: 0 } },
      barrel: { rotation: { x: 0 } },
    },
  };
  Vehicles.setAim(spawned[0], { yaw: spawned[0].yaw, pitch: 0.3, role: 'driver' });
  ok(
    spawned[0].mesh.userData.barrel.rotation.x > 0,
    'first-person barrel pitch was inverted when looking up'
  );
  Vehicles.setAim(spawned[0], { yaw: spawned[0].yaw, pitch: -0.3, role: 'driver' });
  ok(
    spawned[0].mesh.userData.barrel.rotation.x < 0,
    'first-person barrel pitch was inverted when looking down'
  );

  const api = [
    'init',
    'reset',
    'spawn',
    'update',
    'findNearby',
    'getById',
    'getAll',
    'getOpenSeat',
    'getWeaponsForRole',
    'getWeaponAmmoView',
    'canUsePersonalWeapon',
    'canUseVehicleFirstPerson',
    'reloadWeapon',
    'mount',
    'switchSeat',
    'dismount',
    'setDriverInput',
    'setAim',
    'fireWeapon',
    'launchProjectile',
    'raycast',
    'raycastWorld',
    'getWeaponPivotWorld',
    'getCameraFireDirection',
    'getFirstPersonCameraAnchor',
    'applyDamage',
    'destroy',
    'getDeployPoints',
    'getSnapshot',
    'applySnapshot',
    'clear',
  ];
  ok(api.every((name) => typeof Vehicles[name] === 'function'), 'required API is incomplete');
  const fxStats = checkVehicleEffectsStress();
  checkVehicleHud();

  return {
    ok: true,
    seats: { jeep: 6, ifv: 6, tank: 2 },
    weapons: { jeep: 0, ifv: 3, tank: 3 },
    damage: {
      ignoredTypes: ['bullet', 'explosive'],
      rpg150: 150,
      tankCannon200: 200,
    },
    respawnSec: { jeep: 45, ifv: 60, tank: 75 },
    fireDescriptors: ['hitscan', 'guided-projectile'],
    snapshotVehicles: roundTrip.vehicles.length,
    damageCalls: 10000,
    damagePerfMs: Number(damagePerfMs.toFixed(3)),
    cannonFx: {
      activeEffects: fxStats.activeEffects,
      activeProjectiles: fxStats.activeProjectiles,
      projectileCreated: fxStats.projectileCreated,
      sharedGeometries: fxStats.sharedGeometries,
      sharedProjectileMaterials: fxStats.sharedProjectileMaterials,
      peakActiveProjectiles: fxStats.peakActiveProjectiles,
      created: fxStats.created,
    },
    apiCount: api.length,
  };
}

try {
  console.log(JSON.stringify(run(), null, 2));
} catch (error) {
  console.log(
    JSON.stringify(
      {
        ok: false,
        error: error && error.message ? error.message : String(error),
        stack: error && error.stack ? error.stack : null,
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}
