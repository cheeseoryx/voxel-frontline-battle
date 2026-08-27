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

console.log('terrain-fine checks: OK');
