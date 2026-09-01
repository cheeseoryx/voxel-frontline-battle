/* Deterministic data-level checks for the 10cm heightfield (no browser required). */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const BLOCK = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  ROAD: 7,
  WATER: 8,
  ASPHALT: 14,
  BEDROCK: 15,
};

function FakeWorld(size) {
  this.worldSize = size;
  this.height = 32;
  this.chunkSize = 16;
  this.worldChunks = Math.ceil(size / this.chunkSize);
  this.groundY = new Int8Array(size * size);
  this.terrainH = new Float32Array(size * size);
  this.blocks = new Uint8Array(size * this.height * size);
  this.buildings = [];
  this._kitFlags = [];
  this._plannedBases = [];
  this._dirty = [];
  this._lodCamX = 0;
  this._lodCamZ = 0;
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      this.groundY[z * size + x] = 9;
      this.terrainH[z * size + x] = 10;
      for (let y = 0; y <= 9; y++) {
        this.blocks[this.index(x, y, z)] = y === 9 ? BLOCK.GRASS : BLOCK.STONE;
      }
    }
  }
}

FakeWorld.prototype.index = function (x, y, z) {
  if (x < 0 || z < 0 || y < 0 || x >= this.worldSize || z >= this.worldSize || y >= this.height) {
    return -1;
  }
  return (y * this.worldSize + z) * this.worldSize + x;
};
FakeWorld.prototype.get = function (x, y, z) {
  const i = this.index(Math.floor(x), Math.floor(y), Math.floor(z));
  return i < 0 ? BLOCK.AIR : this.blocks[i];
};
FakeWorld.prototype.set = function (x, y, z, type) {
  const i = this.index(Math.floor(x), Math.floor(y), Math.floor(z));
  if (i < 0) return false;
  this.blocks[i] = type;
  return true;
};
FakeWorld.prototype._isBaseKeepClear = function () {
  return false;
};
FakeWorld.prototype.dirtyRect = function (x0, z0, x1, z1, reason) {
  this._dirty.push({ x0, z0, x1, z1, reason });
};

const context = {
  window: { VF: { VoxelWorld: FakeWorld, BLOCK: BLOCK, BLOCK_COLORS: {} } },
  console: console,
};
vm.runInNewContext(fs.readFileSync(path.join(root, 'js/terrain-fine.js'), 'utf8'), context);

function ok(condition, message) {
  if (!condition) throw new Error(message);
}

const world = new FakeWorld(24);
ok(world.getTerrainTop(6.2, 6.8) === 10, 'flat terrain query failed');

function fillTerrainHeights(target, heightAt) {
  for (let z = 0; z < target.worldSize; z++) {
    for (let x = 0; x < target.worldSize; x++) {
      target.terrainH[z * target.worldSize + x] = heightAt(x, z);
    }
  }
}

const slope45 = new FakeWorld(24);
fillTerrainHeights(slope45, function (x, z) {
  return 4 + z;
});
const drive45 = slope45.sampleDriveHeight(12, 12, 1.2, 3, 0, 4.2);
ok(drive45.climbable, 'a 45-degree vehicle slope was rejected');
ok(
  Math.abs(drive45.slope - Math.PI / 4) < 0.001,
  'vehicle slope angle was not measured longitudinally'
);

const slopeOver45 = new FakeWorld(24);
fillTerrainHeights(slopeOver45, function (x, z) {
  return 2 + z * 1.2;
});
const driveOver45 = slopeOver45.sampleDriveHeight(12, 12, 1.2, 3, 0, 4.2);
ok(!driveOver45.climbable, 'a vehicle accepted terrain steeper than 45 degrees');

const doubledStep = new FakeWorld(24);
fillTerrainHeights(doubledStep, function (x, z) {
  return z >= 12 ? 14 : 10;
});
ok(
  doubledStep.sampleDriveHeight(12, 11, 1.2, 2, 0, 4.2).climbable,
  'doubled tank obstacle clearance rejected a 4m step'
);

const excessiveStep = new FakeWorld(24);
fillTerrainHeights(excessiveStep, function (x, z) {
  return z >= 12 ? 15 : 10;
});
ok(
  !excessiveStep.sampleDriveHeight(12, 11, 1.2, 2, 0, 4.2).climbable,
  'tank crossed a step above its doubled obstacle clearance'
);

const plankStep = new FakeWorld(24);
fillTerrainHeights(plankStep, function (x, z) {
  return z >= 12 ? 14 : 10;
});
const plank = plankStep.sampleDriveHeight(12, 12, 1.2, 3, 0, 4.2);
ok(Math.abs(plank.frontY - 10) < 0.15, 'front bumper was not sampled at the nose');
ok(Math.abs(plank.rearY - 14) < 0.15, 'rear bumper was not sampled at the tail');
ok(
  Math.abs(plank.y - 12) < 0.2,
  'straddling pose used footprint average instead of the front/rear plank'
);
ok(plank.centerY === 14, 'center height should stay on the high lip until the tail climbs');

const plazaLip = new FakeWorld(24);
fillTerrainHeights(plazaLip, function (x, z) {
  return z <= 12 ? 15 : 13.9;
});
const lip = plazaLip.sampleDriveHeight(12, 14, 1.75, 3.48, 0, 4.2);
ok(lip.climbable, 'a 1.1m capture-point lip was treated as unclimbable');
ok(lip.frontY > lip.rearY, 'west-facing tank did not lift its nose onto the plaza');
ok(
  lip.y > 13.9 && lip.y < 15,
  'tank on a plaza lip jumped to the platform before the tail climbed'
);

ok(world.setTerrainTop(8, 8, 9.2, { protect: false }), 'setTerrainTop did not change height');
ok(Math.abs(world.terrainH[8 * 24 + 8] - 9.2) < 0.001, 'terrainH was not quantized/written');
ok(world.groundY[8 * 24 + 8] === 8, 'groundY did not follow terrainH');
ok(world.get(8, 8, 8) === BLOCK.GRASS, 'surface material was not restored after lowering');
ok(world.assertTerrainColumn(8, 8), 'column consistency assertion failed');
ok(world._dirty.length === 1 && world._dirty[0].reason === 'content', 'content dirty rect missing');
world.set(6, 10, 6, BLOCK.STONE);
ok(
  !world.setTerrainTop(6, 6, 11.5, { protect: false }),
  'terrain height rose through an existing structure'
);
ok(world.get(6, 10, 6) === BLOCK.STONE, 'terrain write deleted an existing structure');
ok(
  world._terrainOverlapsBox({
    min: { x: 7.7, y: 5, z: 7.7 },
    max: { x: 8.3, y: 7, z: 8.3 },
  }),
  'a body fully below terrain was not detected'
);

world._kitFlags = [{ x: 12.5, z: 12.5 }];
const protectedChanges = world.deformTerrainCircle(12.5, 12.5, 1.5, 0.8, {
  flagRadius: 2,
});
ok(protectedChanges === 0, 'flag plaza protection failed');
world._kitFlags = [];
const craterChanges = world.deformTerrainCircle(12.5, 12.5, 2.5, 0.8);
ok(craterChanges > 0, 'terrain deformation produced no changes');
for (let z = 9; z <= 15; z++) {
  for (let x = 9; x <= 15; x++) {
    ok(world.assertTerrainColumn(x, z), 'deformation desynchronized column ' + x + ',' + z);
    if (x < 15) {
      ok(
        Math.abs(world.terrainH[z * 24 + x] - world.terrainH[z * 24 + x + 1]) <= 0.9,
        'crater created an excessive horizontal step'
      );
    }
    if (z < 15) {
      ok(
        Math.abs(world.terrainH[z * 24 + x] - world.terrainH[(z + 1) * 24 + x]) <= 0.9,
        'crater created an excessive vertical step'
      );
    }
  }
}

const orderA = new FakeWorld(24);
const orderB = new FakeWorld(24);
orderA.deformTerrainCircle(10.5, 12.5, 3.2, 0.7);
orderA.deformTerrainCircle(13.5, 12.5, 3.2, 0.9);
orderB.deformTerrainCircle(13.5, 12.5, 3.2, 0.9);
orderB.deformTerrainCircle(10.5, 12.5, 3.2, 0.7);
for (let i = 0; i < orderA.terrainH.length; i++) {
  ok(orderA.terrainH[i] === orderB.terrainH[i], 'overlapping deformations depend on event order');
}

const lodProbe = {
  worldSize: 640,
  chunkSize: 16,
  _lodCamX: 0,
  _lodCamZ: 8,
  _plannedBases: [],
};
const lodFn = FakeWorld.prototype._chunkTerrainLod;
ok(lodFn.call(lodProbe, 1, 0, 0.1) === 0.1, 'fine LOD exited before hysteresis boundary');
ok(lodFn.call(lodProbe, 2, 0, 0.1) === 0.4, 'fine LOD did not exit after hysteresis boundary');
ok(lodFn.call(lodProbe, 4, 0, 1) === 0.4, 'far LOD did not enter mid band');
ok(lodFn.call(lodProbe, 6, 0, 0.4) === 1, 'mid LOD did not exit after hysteresis boundary');

const mapContext = { window: { VF: {} } };
vm.runInNewContext(
  fs.readFileSync(path.join(root, 'js/maps/island-conquest.js'), 'utf8'),
  mapContext
);
const map = mapContext.window.VF.IslandConquestMap;
for (let i = 0; i < 64; i++) {
  const x = 16 + i * 9.1;
  const z = 20 + ((i * 37) % 580);
  const h = map.heightAtMeters(x, z, 640);
  ok(Math.abs(h * 10 - Math.round(h * 10)) < 1e-6, 'map height is not quantized to 10cm');
}

const SIZE = 1024;
ok(!map.isWater(10, 10, SIZE), 'mountain rim should not count as water');
let bed = 0;
let bankH = null;
for (let z = Math.floor(SIZE * 0.2); z < SIZE * 0.8 && bankH == null; z += 3) {
  for (let x = Math.floor(SIZE * 0.35); x < SIZE * 0.58; x += 2) {
    if (!map.isWater(x, z, SIZE)) continue;
    const nbs = [
      [x + 1, z],
      [x - 1, z],
      [x, z + 1],
      [x, z - 1],
    ];
    for (let i = 0; i < nbs.length; i++) {
      const bx = nbs[i][0];
      const bz = nbs[i][1];
      if (map.isLand(bx, bz, SIZE) && !map.isWater(bx, bz, SIZE)) {
        bed = map.heightAtMeters(x, z, SIZE);
        bankH = map.heightAtMeters(bx, bz, SIZE);
        break;
      }
    }
    if (bankH != null) break;
  }
}
ok(bankH != null, 'river bank sample was not found');
ok(Math.abs(bankH - bed - 0.3) < 0.15, 'river bed is not ~30cm below the bank: ' + (bankH - bed));

ok(typeof map.buildVehicleSpawns === 'function', 'vehicle spawn builder is missing');
ok(map.VEHICLE_POOL && map.VEHICLE_POOL.slots.length === 7, 'each side must have 7 vehicle slots');
const spawnWorld = {
  worldSize: SIZE,
  _plannedBases: [
    { x: SIZE * map.HQ.ally.nx, z: SIZE * map.HQ.ally.nz, gate: map.HQ.ally.gate },
    { x: SIZE * map.HQ.enemy.nx, z: SIZE * map.HQ.enemy.nz, gate: map.HQ.enemy.gate },
  ],
  _clearVehiclePad: function () {},
};
const vehicleSpawns = map.buildVehicleSpawns(spawnWorld);
ok(vehicleSpawns.length === 14, 'both sides must spawn 14 vehicles');
const HALF_LEN = { jeep: 4.45 / 2, ifv: 6.45 / 2, tank: 7.25 / 2 };
const PAD_OUTER = map.VEHICLE_POOL.padOuter;
['ally', 'enemy'].forEach(function (team) {
  const owned = vehicleSpawns.filter(function (s) {
    return s.team === team;
  });
  const counts = { jeep: 0, ifv: 0, tank: 0 };
  const base = spawnWorld._plannedBases[team === 'ally' ? 0 : 1];
  owned.forEach(function (s) {
    counts[s.type] += 1;
    const along =
      base.gate === '+z'
        ? s.z - base.z
        : base.gate === '-z'
          ? base.z - s.z
          : base.gate === '+x'
            ? s.x - base.x
            : base.x - s.x;
    const lateral =
      base.gate === '+z' || base.gate === '-z' ? s.x - base.x : s.z - base.z;
    ok(along - (HALF_LEN[s.type] || 0) > PAD_OUTER, team + ' ' + s.id + ' is still on the HQ pad');
    ok(Math.abs(lateral) <= 24, team + ' ' + s.id + ' is not aligned with the gate corridor');
    ok(!map.isWater(s.x, s.z, SIZE), team + ' ' + s.id + ' spawned in water');
    const padH = map.heightAtMeters(base.x, base.z, SIZE);
    const spawnH = map.heightAtMeters(s.x, s.z, SIZE);
    ok(spawnH <= padH + 0.35, team + ' ' + s.id + ' sits above the HQ platform');
  });
  ok(counts.tank === 1 && counts.ifv === 2 && counts.jeep === 4, team + ' vehicle mix is wrong');
});

ok(typeof map.buildAiSpawns === 'function', 'AI spawn builder is missing');
const aiSpawns = map.buildAiSpawns(spawnWorld);
['ally', 'enemy'].forEach(function (team) {
  const pads = aiSpawns[team];
  const base = spawnWorld._plannedBases[team === 'ally' ? 0 : 1];
  ok(pads.length >= 16, team + ' AI must spawn from the home yard');
  pads.forEach(function (pad, i) {
    const dx = pad.x - base.x;
    const dz = pad.z - base.z;
    ok(Math.hypot(dx, dz) < 30, team + ' AI pad ' + i + ' is outside the HQ courtyard');
    ok(!map.isWater(pad.x, pad.z, SIZE), team + ' AI pad ' + i + ' spawned in water');
  });
});

console.log('terrain-fine checks: OK');
