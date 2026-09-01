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
      weaponDefs.rpg.damage === 200 &&
      weaponDefs.rpg.damageType === 'antiArmor',
    'RPG anti-armor definition is missing'
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
  ok(ifv.hp === 600 && tank.hp === 600, 'ignored damage changed vehicle HP');
  ok(
    Vehicles.applyDamage(ifv, 200, { damageType: 'antiArmor', weaponId: 'rpg' }) === 200,
    'RPG damage against light armor was not 200'
  );
  ok(
    Vehicles.applyDamage(tank, 200, { damageType: 'antiArmor', weaponId: 'rpg' }) === 133,
    'RPG damage against heavy armor was not rounded to 133'
  );
  ok(ifv.hp === 400 && tank.hp === 467, 'anti-armor HP results are incorrect');

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
  ok(tank.alive && tank.hp === 600, 'tank did not respawn at full HP');
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
  Vehicles.update(0.4);
  ok(
    cannonShot.damageApplied === 320 && weaponIfv.hp === 280,
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
  ok(rpgTarget.hp === 467, 'RPG projectile did not apply 133 heavy-armor damage');
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
  weaponWire.vehicles[0].weapons.tank_main_cannon.reserve -= 1;
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
  ok(projectileWire.projectiles.length === 1, 'network RPG projectile was not snapshotted');
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
    'canUsePersonalWeapon',
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
    'applyDamage',
    'destroy',
    'getDeployPoints',
    'getSnapshot',
    'applySnapshot',
    'clear',
  ];
  ok(api.every((name) => typeof Vehicles[name] === 'function'), 'required API is incomplete');

  return {
    ok: true,
    seats: { jeep: 6, ifv: 6, tank: 2 },
    weapons: { jeep: 0, ifv: 3, tank: 3 },
    damage: {
      ignoredTypes: ['bullet', 'explosive'],
      rpg200Light: 200,
      rpg200Heavy: 133,
    },
    respawnSec: { jeep: 45, ifv: 60, tank: 75 },
    fireDescriptors: ['hitscan', 'guided-projectile'],
    snapshotVehicles: roundTrip.vehicles.length,
    damageCalls: 10000,
    damagePerfMs: Number(damagePerfMs.toFixed(3)),
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
