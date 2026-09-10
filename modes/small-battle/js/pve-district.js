/**
 * pve-district.js — Doodle District layout, voxelized.
 * Used by personal 自由混战 (generateFfaDistrictMap). Art stays Voxel Frontline blocks.
 */
(function (global) {
  'use strict';

  const VW = global.VF && global.VF.VoxelWorld;
  if (!VW) return;
  const BLOCK = global.VF.BLOCK;

  const SCALE_XZ = 1.45;
  const SCALE_Y = 1;
  const BOUND = 55;
  const WALL_T = 6;
  const WALL_H = 18;

  VW.prototype._dX = function (x) {
    return Math.round(this._dOx + x * this._dS);
  };
  VW.prototype._dZ = function (z) {
    return Math.round(this._dOz + z * this._dS);
  };
  VW.prototype._dY = function (y) {
    return Math.round(this._dGy + y * this._dSY);
  };

  VW.prototype._dSpan = function (origin, c, size, scale) {
    const a = origin + (c - size * 0.5) * scale;
    const b = origin + (c + size * 0.5) * scale;
    let i0 = Math.floor(Math.min(a, b));
    let i1 = Math.ceil(Math.max(a, b)) - 1;
    if (i1 < i0) i1 = i0;
    return [i0, i1];
  };

  VW.prototype._dPut = function (x, y, z, type) {
    if (this.set(x, y, z, type) && type && type !== BLOCK.AIR) this.markManmade(x, y, z);
  };

  VW.prototype._dFill = function (x0, y0, z0, x1, y1, z1, type) {
    const xa = Math.min(x0, x1);
    const xb = Math.max(x0, x1);
    const ya = Math.min(y0, y1);
    const yb = Math.max(y0, y1);
    const za = Math.min(z0, z1);
    const zb = Math.max(z0, z1);
    for (let x = xa; x <= xb; x++) {
      for (let y = ya; y <= yb; y++) {
        for (let z = za; z <= zb; z++) {
          this._dPut(x, y, z, type);
        }
      }
    }
  };

  VW.prototype._dBox = function (x, y, z, w, h, d, type) {
    if (w <= 0 || h <= 0 || d <= 0) return;
    const xs = this._dSpan(this._dOx, x, w, this._dS);
    const zs = this._dSpan(this._dOz, z, d, this._dS);
    const y0 = this._dY(y);
    let y1 = this._dY(y + h);
    if (y1 <= y0) y1 = y0;
    else y1 -= 1;
    this._dFill(xs[0], y0, zs[0], xs[1], y1, zs[1], type || BLOCK.CONCRETE);
  };

  VW.prototype._dSlab = function (x1, z1, x2, z2, yTop, thick, type, asStair) {
    const xa = this._dX(Math.min(x1, x2));
    const xb = this._dX(Math.max(x1, x2));
    const za = this._dZ(Math.min(z1, z2));
    const zb = this._dZ(Math.max(z1, z2));
    const yt = this._dY(yTop);
    const th = Math.max(1, Math.round((thick || 0.4) * this._dSY));
    this._dFill(xa, yt - th + 1, za, xb, yt, zb, type || BLOCK.CONCRETE);
    if (asStair) {
      for (let x = xa; x <= xb; x++) {
        for (let z = za; z <= zb; z++) {
          this.markStair(x, yt, z);
        }
      }
    }
  };

  VW.prototype._dInHole = function (along, y, holes, axis, wallY0, wallY1) {
    if (!holes || !holes.length) return false;
    for (let i = 0; i < holes.length; i++) {
      const h = holes[i];
      const a0 = axis === 'x' ? this._dX(h[0]) : this._dZ(h[0]);
      const a1 = axis === 'x' ? this._dX(h[1]) : this._dZ(h[1]);
      const y0 = h.length > 2 ? this._dY(h[2]) : wallY0;
      const y1 = h.length > 3 ? this._dY(h[3]) : h.length > 2 ? this._dY(h[2]) : wallY1;
      if (
        along >= Math.min(a0, a1) &&
        along <= Math.max(a0, a1) &&
        y >= Math.min(y0, y1) &&
        y <= Math.max(y0, y1)
      ) {
        return true;
      }
    }
    return false;
  };

  VW.prototype._dWallX = function (x0, x1, z, y0, h, thick, holes, type) {
    const zc = this._dZ(z);
    const t = Math.max(1, Math.round((thick || 0.4) * this._dS));
    const xa = this._dX(Math.min(x0, x1));
    const xb = this._dX(Math.max(x0, x1));
    const ya = this._dY(y0);
    const yb = this._dY(y0 + h);
    const z0 = zc - (t >> 1);
    const z1 = z0 + t - 1;
    const mat = type || BLOCK.BRICK;
    for (let x = xa; x <= xb; x++) {
      for (let y = ya; y < yb; y++) {
        if (this._dInHole(x, y, holes, 'x', ya, yb - 1)) continue;
        for (let zz = z0; zz <= z1; zz++) this._dPut(x, y, zz, mat);
      }
    }
  };

  VW.prototype._dWallZ = function (z0, z1, x, y0, h, thick, holes, type) {
    const xc = this._dX(x);
    const t = Math.max(1, Math.round((thick || 0.4) * this._dS));
    const za = this._dZ(Math.min(z0, z1));
    const zb = this._dZ(Math.max(z0, z1));
    const ya = this._dY(y0);
    const yb = this._dY(y0 + h);
    const x0 = xc - (t >> 1);
    const x1 = x0 + t - 1;
    const mat = type || BLOCK.BRICK;
    for (let z = za; z <= zb; z++) {
      for (let y = ya; y < yb; y++) {
        if (this._dInHole(z, y, holes, 'z', ya, yb - 1)) continue;
        for (let xx = x0; xx <= x1; xx++) this._dPut(xx, y, z, mat);
      }
    }
  };

  VW.prototype._dRail = function (x1, z1, x2, z2, y, type) {
    const ax = this._dX(x1);
    const az = this._dZ(z1);
    const bx = this._dX(x2);
    const bz = this._dZ(z2);
    const yv = this._dY(y);
    const steps = Math.max(1, Math.abs(bx - ax), Math.abs(bz - az));
    const mat = type || BLOCK.METAL;
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(ax + ((bx - ax) * i) / steps);
      const z = Math.round(az + ((bz - az) * i) / steps);
      this._dPut(x, yv + 1, z, mat);
    }
  };

  VW.prototype._dStairs = function (x, y, z, dir, steps, width, opts) {
    opts = opts || {};
    const rise = opts.rise != null ? opts.rise : 0.286;
    const run = opts.run != null ? opts.run : 0.45;
    const ux = dir === '+x' ? 1 : dir === '-x' ? -1 : 0;
    const uz = dir === '+z' ? 1 : dir === '-z' ? -1 : 0;
    const px = -uz;
    const pz = ux;
    const climb = Math.max(2, Math.round(steps * rise * this._dSY));
    const runN = Math.max(climb, Math.round(steps * run * this._dS));
    const half = Math.max(1, Math.round((width || 1.8) * this._dS * 0.5));
    const x0 = this._dX(x);
    const y0 = this._dY(y);
    const z0 = this._dZ(z);
    for (let i = 0; i <= runN; i++) {
      const yy = y0 + Math.round((i / runN) * climb);
      const xx = Math.round(x0 + ux * i);
      const zz = Math.round(z0 + uz * i);
      for (let k = -half; k <= half; k++) {
        const wx = xx + Math.round(px * k);
        const wz = zz + Math.round(pz * k);
        this._dPut(wx, yy, wz, BLOCK.CONCRETE);
        this.markStair(wx, yy, wz);
        for (let fy = y0; fy < yy; fy++) {
          if (this.get(wx, fy, wz) === BLOCK.AIR) this._dPut(wx, fy, wz, BLOCK.CONCRETE);
        }
      }
    }
  };

  VW.prototype._dGate = function (dx, dz, alongX) {
    const x = this._dX(dx);
    const z = this._dZ(dz);
    const y0 = this._dGy + 1;
    const y1 = this._dGy + 4;
    const half = 2;
    if (alongX) {
      this.fill(x - half, y0, z - 8, x + half, y1, z + 8, BLOCK.AIR);
    } else {
      this.fill(x - 8, y0, z - half, x + 8, y1, z + half, BLOCK.AIR);
    }
  };

  VW.prototype._dMapSpawn = function (dx, dy, dz) {
    return { x: this._dX(dx), y: this._dY(dy), z: this._dZ(dz) };
  };

  VW.prototype._districtFlatten = function () {
    const pad = Math.ceil(BOUND * this._dS) + 8;
    const ox = Math.round(this._dOx);
    const oz = Math.round(this._dOz);
    const gy = this._dGy;
    const size = this.worldSize;
    for (let x = ox - pad; x <= ox + pad; x++) {
      if (x < 1 || x >= size - 1) continue;
      for (let z = oz - pad; z <= oz + pad; z++) {
        if (z < 1 || z >= size - 1) continue;
        for (let y = 1; y < gy; y++) this.set(x, y, z, BLOCK.STONE);
        this.set(x, gy, z, BLOCK.ASPHALT);
        for (let y = gy + 1; y <= gy + 28 && y < this.height; y++) this.set(x, y, z, BLOCK.AIR);
        this._setColumnGround(x, z, gy);
      }
    }
  };

  /**
   * Stamp Doodle District (non-arena) into the core PVE board.
   * Origin = map center. SCALE_XZ stretches the ±55 arena; SCALE_Y keeps 4m floors.
   */
  VW.prototype._buildPveDistrict = function () {
    const size = this.worldSize;
    this._dS = SCALE_XZ;
    this._dSY = SCALE_Y;
    this._dOx = size * 0.5;
    this._dOz = size * 0.5;
    this._dGy = this._surface(Math.floor(this._dOx), Math.floor(this._dOz)) || 9;

    this._districtFlatten();

    const B = BLOCK;
    const b = BOUND;
    const S = WALL_T;
    const L = WALL_H;
    const P = b - 3;

    // Perimeter walls (skip doodle ground slab — pad is already street)
    this._dBox(0, 0, -b, 2 * b + S, L, S, B.CONCRETE);
    this._dBox(0, 0, b, 2 * b + S, L, S, B.CONCRETE);
    this._dBox(-b, 0, 0, S, L, 2 * b + S, B.CONCRETE);
    this._dBox(b, 0, 0, S, L, 2 * b + S, B.CONCRETE);

    const xGates = [
      [-P, 0],
      [P, 0],
      [-P, 30],
      [P, -30],
      [-P, -30],
      [P, 30],
    ];
    for (let i = 0; i < xGates.length; i++) this._dGate(xGates[i][0], xGates[i][1], false);
    const zGates = [
      [0, -P],
      [0, P],
      [-30, P],
      [30, P],
    ];
    for (let i = 0; i < zGates.length; i++) this._dGate(zGates[i][0], zGates[i][1], true);

    this._districtCenterTower();
    this._districtWestBuilding();
    this._districtEastBuilding();
    this._districtSouthWalk();
    this._districtSouthBlocks();
    this._districtStreetCover();

    const ally = [
      [-40, 0, 18],
      [-34, 12, 12],
      [-48, 7, -30],
      [-52, 0, 30],
      [-30, 7, -48],
    ];
    const enemy = [
      [40, 0, 8],
      [34, 12, 18],
      [48, 7, -30],
      [52, 0, 30],
      [16, 7, -45],
    ];
    this._districtSpawns = {
      ally: ally.map((p) => this._dMapSpawn(p[0], p[1], p[2])),
      enemy: enemy.map((p) => this._dMapSpawn(p[0], p[1], p[2])),
    };
  };

  VW.prototype._districtCenterTower = function () {
    const B = BLOCK;
    for (let n = 1; n <= 4; n++) this._dSlab(-7, -7, 7, 7, n * 4, 0.4, B.CONCRETE);
    const posts = [
      [-6.6, -6.6],
      [6.6, -6.6],
      [-6.6, 6.6],
      [6.6, 6.6],
      [0, -6.6],
      [0, 6.6],
      [-6.6, 0],
      [6.6, 0],
    ];
    for (let i = 0; i < posts.length; i++) {
      this._dBox(posts[i][0], 0, posts[i][1], 0.8, 16, 0.8, B.CONCRETE);
    }
    for (let n = 1; n <= 3; n++) {
      const y = n * 4;
      this._dRail(-7, -1.5, 7, 7, y);
      this._dRail(1.5, 7, 7, 7, y);
      this._dRail(-7, -7, 7, -7, y);
      this._dRail(7, -7, 7, 7, y);
      this._dRail(-7, -7, -6.5, -7, y);
      this._dRail(3.5, -7, 7, -7, y);
    }
    this._dRail(-5, -7, 7, -7, 16);
    this._dRail(-7, 7, -1.5, 7, 16);
    this._dRail(1.5, 7, 7, 7, 16);
    this._dRail(-7, -7, -7, 7, 16);
    this._dRail(7, -7, 7, 3, 16);
    this._dBox(5.5, 16, 5.5, 1, 10, 1, B.CONCRETE);
    this._dBox(11.5, 25, 5.5, 16, 0.8, 0.8, B.METAL);
    this._dBox(1, 25, 5.5, 5, 0.8, 0.8, B.METAL);
    this._dBox(-0.5, 23.6, 5.5, 2, 1.6, 1.6, B.CONCRETE);

    let k = 0;
    for (let n = 0; n < 4; n++) {
      const dir = n % 2 === 0 ? '+x' : '-x';
      const gx = dir === '+x' ? -5 : 1.3;
      const gz = n % 2 === 0 ? -8.3 : -10.3;
      this._dStairs(gx, k, gz, dir, 14, 1.8);
      k += 4;
      const lx = dir === '+x' ? 2.4 : -6.1;
      this._dSlab(lx - 1.1, -11.4, lx + 1.1, -7, k, 0.4, B.CONCRETE, true);
      this._dRail(lx - 1.1, -11.4, lx + 1.1, -11.4, k);
    }
  };

  VW.prototype._districtWestBuilding = function () {
    const B = BLOCK;
    const brick = B.BRICK;
    for (let g = 1; g <= 3; g++) this._dSlab(-43, 4, -25, 20, g * 4, 0.4, B.CONCRETE);
    this._dWallZ(4, 20, -25, 0, 12, 0.4, [
      [10, 13, 0, 3.2],
      [6, 9, 5, 7],
      [14, 17, 5, 7],
      [6, 9, 9, 11],
      [14, 17, 9, 11],
    ], brick);
    this._dWallZ(4, 20, -43, 0, 12, 0.4, [
      [8, 11, 0, 3.2],
      [8, 11, 4.5, 7.5],
      [8, 11, 8.5, 11.5],
    ], brick);
    this._dWallX(-43, -25, 4, 0, 12, 0.4, [
      [-36, -33, 0, 3.2],
      [-40, -37, 5, 7],
      [-31, -28, 5, 7],
      [-36, -32, 8.5, 11.5],
    ], brick);
    this._dWallX(-43, -25, 20, 0, 12, 0.4, [
      [-36, -32, 0, 3.2],
      [-31, -27, 0, 3.2],
      [-42, -39, 0, 3.2],
      [-37.2, -33.5, 4.05, 7.2],
      [-36, -32, 8.4, 11.4],
      [-41, -27, 4.6, 7.6],
      [-29, -25.5, 8.05, 11.2],
    ], brick);
    this._dWallX(-43, -25, 12, 0, 4, 0.3, [
      [-40, -37.5],
      [-30, -27.5],
    ], brick);
    this._dWallX(-43, -25, 12, 4, 4, 0.3, [[-36, -32]], brick);
    this._dWallZ(4, 20, -34, 8, 4, 0.3, [
      [8, 11],
      [14, 17],
    ], brick);
    this._dRail(-43, 4, -37, 4, 12);
    this._dRail(-31, 4, -25, 4, 12);
    this._dRail(-43, 20, -37.4, 20, 12);
    this._dRail(-34.4, 20, -25, 20, 12);
    this._dRail(-43, 4, -43, 20, 12);
    this._dRail(-25, 4, -25, 9, 12);
    this._dRail(-25, 15, -25, 20, 12);

    let h = 0;
    for (let g = 0; g < 3; g++) {
      const dir = g % 2 === 0 ? '-x' : '+x';
      const X = dir === '-x' ? -28.5 : -34.8;
      const at = g % 2 === 0 ? 21.2 : 23.2;
      this._dStairs(X, h, at, dir, 14, 1.8);
      h += 4;
      const dt = dir === '-x' ? -35.9 : -27.4;
      this._dSlab(dt - 1.1, 20.2, dt + 1.1, 24.4, h, 0.4, B.CONCRETE, true);
      this._dRail(dt - 1.1, 24.4, dt + 1.1, 24.4, h);
    }

    // Orange skybridge west building → center tower
    const G = -7;
    const Y = G + 25.2;
    this._dBox((G - 25.2) / 2, 11.6, 6, Y, 0.4, 2.4, B.RUST);
    this._dRail(-25, 7.2, G, 7.2, 12, B.RUST);
  };

  VW.prototype._districtEastBuilding = function () {
    const B = BLOCK;
    const wall = B.PLASTER;
    this._dSlab(24, 4, 44, 9, 12, 0.4, B.CONCRETE);
    this._dSlab(24, 15, 44, 20, 12, 0.4, B.CONCRETE);
    this._dSlab(24, 9, 31, 15, 12, 0.4, B.CONCRETE);
    this._dSlab(37, 9, 44, 15, 12, 0.4, B.CONCRETE);
    this._dWallZ(4, 20, 24, 0, 12, 0.4, [
      [10, 14, 0, 3.6],
      [6, 9, 7, 10],
      [15, 18, 7, 10],
    ], wall);
    this._dWallZ(4, 20, 44, 0, 12, 0.4, [
      [7, 10, 0, 3.2],
      [14, 17, 0, 3.2],
      [8, 16, 7, 10],
    ], wall);
    this._dWallX(24, 44, 4, 0, 12, 0.4, [
      [32, 36, 0, 3.6],
      [27, 30, 7, 10],
      [38, 41, 7, 10],
    ], wall);
    this._dWallX(24, 44, 20, 0, 12, 0.4, [
      [26, 29, 0, 3.2],
      [39, 42, 0, 3.2],
      [33.5, 36.5, 4.05, 7.2],
      [25.5, 28.5, 8.05, 11.2],
      [32, 36, 8, 11],
    ], wall);
    this._dSlab(24.4, 4.4, 26, 19.6, 6, 0.3, B.CONCRETE);
    this._dSlab(42, 4.4, 43.6, 19.6, 6, 0.3, B.CONCRETE);
    this._dSlab(26, 4.4, 42, 6, 6, 0.3, B.CONCRETE);
    this._dSlab(26, 18, 42, 19.6, 6, 0.3, B.CONCRETE);
    this._dRail(26, 6, 26, 9, 6);
    this._dRail(26, 15, 26, 17, 6);
    this._dRail(42, 6, 42, 18, 6);
    this._dRail(26, 6, 31, 6, 6);
    this._dRail(37, 6, 42, 6, 6);
    this._dRail(26, 18, 42, 18, 6);
    this._dStairs(26.2, 0, 8.6, '+z', 21, 1.6, { rise: 6 / 21, run: 0.45 });
    this._dBox(34, 0, 12, 2.4, 2.4, 2.4, B.CONCRETE);
    this._dBox(36.4, 0, 12, 2.4, 1.2, 2.4, B.CONCRETE);
    this._dBox(30, 0, 16, 1.6, 1.6, 1.6, B.BRICK);

    let n = 0;
    for (let i = 0; i < 3; i++) {
      const dir = i % 2 === 0 ? '+x' : '-x';
      const Y = dir === '+x' ? 27.5 : 33.8;
      const X = i % 2 === 0 ? 21.2 : 23.2;
      this._dStairs(Y, n, X, dir, 14, 1.8);
      n += 4;
      const at = dir === '+x' ? 34.9 : 26.4;
      this._dSlab(at - 1.1, 20.2, at + 1.1, 24.4, n, 0.4, B.CONCRETE, true);
      this._dRail(at - 1.1, 24.4, at + 1.1, 24.4, n);
    }
    this._dRail(24, 4, 31, 4, 12);
    this._dRail(37, 4, 44, 4, 12);
    this._dRail(24, 20, 33.4, 20, 12);
    this._dRail(36.4, 20, 44, 20, 12);
    this._dRail(44, 4, 44, 20, 12);
    this._dRail(24, 4, 24, 9, 12);
    this._dRail(24, 15, 24, 20, 12);
    this._dBox(15.5, 11.6, 6, 17.4, 0.4, 2.2, B.CONCRETE);
    this._dRail(7, 4.9, 24, 4.9, 12);
  };

  VW.prototype._districtSouthWalk = function () {
    const B = BLOCK;
    this._dSlab(-52, -30 - 4.5, 52, -30 + 4.5, 7, 0.6, B.CONCRETE);
    this._dWallX(-52, 52, -30 - 4.3, 7, 0.9, 0.4, [
      [-33, -29],
      [27, 31],
      [-2, 2],
    ], B.METAL);
    this._dWallX(-52, 52, -30 + 4.3, 7, 0.9, 0.4, [
      [-36.5, -33],
      [33, 36.5],
    ], B.METAL);
    for (let q = -48; q <= 48; q += 12) this._dBox(q, 0, -30, 1.4, 6.4, 1.4, B.CONCRETE);
    this._dStairs(-46.5, 0, -30 + 5.5, '+x', 25, 2, { rise: 0.28, run: 0.45 });
    this._dStairs(46.5, 0, -30 + 5.5, '-x', 25, 2, { rise: 0.28, run: 0.45 });
  };

  VW.prototype._districtSouthBlocks = function () {
    const B = BLOCK;
    this._dBox(-30, 0, -45, 14, 7, 10, B.BRICK);
    this._dBox(-8, 0, -45, 14, 11, 10, B.CONCRETE);
    this._dBox(16, 0, -45, 14, 7, 10, B.PLASTER);
    this._dBox(-31, 6.7, -37.25, 2.6, 0.3, 5.5, B.CONCRETE);
    this._dBox(29, 6.7, -37.25, 2.6, 0.3, 5.5, B.CONCRETE);
    this._dBox(0, 6.7, -37.25, 2.6, 0.3, 5.5, B.CONCRETE);
    this._dRail(-32.3, -40, -32.3, -34.5, 7);
    this._dRail(-29.7, -40, -29.7, -34.5, 7);
    this._dRail(27.7, -40, 27.7, -34.5, 7);
    this._dRail(30.3, -40, 30.3, -34.5, 7);
    this._dStairs(-23, 7, -45, '+x', 14, 2.2);
    this._dSlab(-16.9, -46.1, -15, -43.9, 11, 0.4, B.CONCRETE, true);
    this._dStairs(9, 7, -45, '-x', 14, 2.2);
    this._dSlab(-1, -46.1, 2.9, -43.9, 11, 0.4, B.CONCRETE, true);
    this._dBox(-33, 7, -48, 1.2, 1.6, 1.2, B.CONCRETE);
    this._dBox(19, 7, -42, 1.2, 1.4, 1.2, B.CONCRETE);
    this._dBox(-10, 11, -47.5, 2.8, 2.6, 2.8, B.METAL);
  };

  VW.prototype._districtStreetCover = function () {
    const B = BLOCK;
    this._dBox(-14, 0, 34, 2.5, 2.6, 6.2, B.BRICK);
    this._dBox(-14, 2.6, 34, 2.5, 2.6, 6.2, B.RUST);
    this._dBox(14, 0, 36, 6.2, 2.6, 2.5, B.CONCRETE);
    this._dBox(17, 2.6, 36, 3, 2.6, 2.5, B.BRICK);
    this._dBox(-6, 0, 28, 1.4, 1.4, 1.4, B.CONCRETE);
    this._dBox(-4.5, 0, 28.5, 1.2, 1.2, 1.2, B.CONCRETE);
    this._dBox(-5.3, 1.4, 28.2, 1, 1, 1, B.CONCRETE);
    this._dBox(8, 0, 26, 1.6, 1.6, 1.6, B.CONCRETE);
    this._dBox(9.6, 0, 26.4, 1.2, 1.2, 1.2, B.CONCRETE);
    this._dBox(24, 0.6, 40, 11, 3.2, 2.8, B.CONCRETE);
    this._dBox(-30, 0, 44, 16, 1.6, 1.6, B.RUST);
    this._dBox(38, 0, 40, 6, 2.2, 3.2, B.PLASTER);
    this._dBox(38, 2.2, 40, 6, 0.8, 3.2, B.CONCRETE);
    this._dBox(-40, 0, 32, 5.2, 3.4, 5.2, B.CONCRETE);
    this._dBox(-16, 0, -8, 2.2, 1.2, 2.2, B.CONCRETE);
    this._dBox(18, 0, -10, 2.2, 1.6, 2.2, B.CONCRETE);
    this._dBox(-20, 0, 8, 1.6, 1, 3, B.CONCRETE);
    this._dBox(20, 0, -2, 3, 1, 1.6, B.CONCRETE);
    this._dBox(-8, 0, -18, 4, 1.1, 1.2, B.CONCRETE);
    this._dBox(8, 0, -18, 4, 1.1, 1.2, B.CONCRETE);
    this._dBox(0, 0, 22, 5, 0.5, 1.4, B.CONCRETE);
    this._dBox(-24, 0, -18, 2.4, 2.6, 2.4, B.RUST);
    this._dBox(26, 0, -18, 2.4, 2.6, 2.4, B.BRICK);
    const lamps = [
      [-10, 46],
      [10, 46],
      [-22, 24],
      [22, 24],
    ];
    for (let i = 0; i < lamps.length; i++) {
      this._dBox(lamps[i][0], 0, lamps[i][1], 0.25, 6, 0.25, B.METAL);
    }
  };
})(window);
