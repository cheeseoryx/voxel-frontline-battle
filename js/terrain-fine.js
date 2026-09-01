/**
 * terrain-fine.js — 10cm ground heightfield on top of 1m structure voxels.
 *
 * Character / buildings stay 100cm cubes. Natural ground is a 10cm-step
 * heightfield (interpolated from 1m float samples, then quantized).
 * Nearby chunks mesh as 10cm cubes; mid-range 40cm; far stays 1m voxels.
 */
(function (global) {
  'use strict';

  const STEP = 0.1;
  const FINE_DIST = 32;
  const MID_DIST = 88;
  const FINE_ENTER = 28;
  const FINE_EXIT = 36;
  const MID_ENTER = 80;
  const MID_EXIT = 96;
  const MID_STEP = 0.4;
  const MAX_QUADS_PER_MESH = 16000; // 64k vertices; safe for Uint16 indices
  const WALK_STEP = 0.35;
  const MAX_WALK_SLOPE = Math.PI * 0.28;
  const MAX_DRIVE_SLOPE = Math.PI / 4;
  const SINK = 0.12;
  const MIN_TERRAIN_TOP = 1.1;

  function attach(VW) {
    if (!VW || VW.prototype.getTerrainTop) return;
    const proto = VW.prototype;

    proto._chunkTerrainLod = function (cx, cz, currentLod) {
      let camX = this._lodCamX;
      let camZ = this._lodCamZ;
      if (camX == null || camZ == null) {
        const b = this._plannedBases && this._plannedBases[0];
        camX = b ? b.x : this.worldSize * 0.5;
        camZ = b ? b.z : this.worldSize * 0.5;
      }
      const mx = (cx + 0.5) * this.chunkSize;
      const mz = (cz + 0.5) * this.chunkSize;
      const dx = mx - camX;
      const dz = mz - camZ;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (currentLod === STEP) {
        if (d < FINE_EXIT) return STEP;
        return d < MID_EXIT ? MID_STEP : 1;
      }
      if (currentLod === MID_STEP) {
        if (d < FINE_ENTER) return STEP;
        if (d < MID_EXIT) return MID_STEP;
        return 1;
      }
      if (currentLod === 1) {
        if (d < FINE_ENTER) return STEP;
        if (d < MID_ENTER) return MID_STEP;
        return 1;
      }
      if (d < FINE_DIST) return STEP;
      if (d < MID_DIST) return MID_STEP;
      return 1;
    };

    proto.getTerrainTop = function (x, z) {
      const size = this.worldSize;
      if (x < 0) x = 0;
      if (z < 0) z = 0;
      if (x > size - 1.001) x = size - 1.001;
      if (z > size - 1.001) z = size - 1.001;
      const hmap = this.terrainH;
      if (!hmap) return (this._surface(x, z) || 4) + 1;
      const x0 = Math.floor(x);
      const z0 = Math.floor(z);
      const x1 = x0 + 1 < size ? x0 + 1 : size - 1;
      const z1 = z0 + 1 < size ? z0 + 1 : size - 1;
      const tx = x - x0;
      const tz = z - z0;
      let h00 = hmap[z0 * size + x0];
      let h10 = hmap[z0 * size + x1];
      let h01 = hmap[z1 * size + x0];
      let h11 = hmap[z1 * size + x1];
      if (h00 < 0.5) h00 = (this.groundY[z0 * size + x0] || 4) + 1;
      if (h10 < 0.5) h10 = (this.groundY[z0 * size + x1] || 4) + 1;
      if (h01 < 0.5) h01 = (this.groundY[z1 * size + x0] || 4) + 1;
      if (h11 < 0.5) h11 = (this.groundY[z1 * size + x1] || 4) + 1;
      const h0 = h00 + (h10 - h00) * tx;
      const h1 = h01 + (h11 - h01) * tx;
      return Math.round((h0 + (h1 - h0) * tz) * 10) / 10;
    };

    /** Compatibility name used by battlefield events; value is walk-on-top Y in meters. */
    proto.getGroundY = function (x, z) {
      return this.getTerrainTop(x, z);
    };

    proto._terrainCellProtected = function (x, z, opts) {
      opts = opts || {};
      if (opts.force) return false;
      if (x <= 1 || z <= 1 || x >= this.worldSize - 2 || z >= this.worldSize - 2) return true;
      const bases = this._plannedBases || [];
      for (let i = 0; i < bases.length; i++) {
        const b = bases[i];
        if (Math.abs(x + 0.5 - b.x) <= 34 && Math.abs(z + 0.5 - b.z) <= 34) return true;
      }
      if (this._isBaseKeepClear && this._isBaseKeepClear(x, z, 0)) return true;
      const buildings = this.buildings || [];
      for (let i = 0; i < buildings.length; i++) {
        const b = buildings[i];
        if (!b) continue;
        if (x >= b.ox - 1 && x < b.ox + b.w + 1 && z >= b.oz - 1 && z < b.oz + b.d + 1) {
          return true;
        }
      }
      const flags = this._kitFlags || [];
      const flagRadius = opts.flagRadius != null ? opts.flagRadius : 29;
      for (let i = 0; i < flags.length; i++) {
        const f = flags[i];
        const dx = x + 0.5 - (f.x != null ? f.x : f.cx);
        const dz = z + 0.5 - (f.z != null ? f.z : f.cz);
        if (dx * dx + dz * dz <= flagRadius * flagRadius) return true;
      }
      return false;
    };

    /**
     * Canonical runtime terrain-column writer.
     * Generation may fill arrays directly; gameplay/editor mutations use this API.
     */
    proto.setTerrainTop = function (x, z, topMeters, opts) {
      opts = opts || {};
      x = Math.floor(x);
      z = Math.floor(z);
      const size = this.worldSize;
      if (x < 1 || z < 1 || x >= size - 1 || z >= size - 1 || !isFinite(topMeters)) return false;
      if (opts.protect !== false && this._terrainCellProtected(x, z, opts)) return false;

      const index = z * size + x;
      const oldGy = this.groundY[index] || 0;
      let oldTop = this.terrainH[index];
      if (!(oldTop > 0.5)) oldTop = oldGy + 1;
      const maxTop = this.height - 2;
      let nextTop = Math.round(Math.max(MIN_TERRAIN_TOP, Math.min(maxTop, topMeters)) * 10) / 10;

      let newGy = Math.round(nextTop) - 1;
      newGy = Math.max(1, Math.min(this.height - 3, newGy));
      const BLOCK = global.VF.BLOCK;
      if (newGy > oldGy) {
        for (let y = oldGy + 1; y <= newGy; y++) {
          const t = this.get(x, y, z);
          if (t !== BLOCK.AIR && t !== BLOCK.WATER) {
            nextTop = Math.max(
              oldTop,
              Math.min(nextTop, Math.round((y - 0.1) * 10) / 10)
            );
            newGy = Math.max(oldGy, Math.round(nextTop) - 1);
            break;
          }
        }
      }
      if (Math.abs(nextTop - oldTop) < 0.049) return false;
      let surfaceType = opts.surfaceType;
      if (surfaceType == null) {
        surfaceType = this.get(x, oldGy, z);
        if (
          surfaceType === BLOCK.AIR ||
          surfaceType === BLOCK.WATER ||
          surfaceType === BLOCK.BEDROCK
        ) {
          surfaceType = BLOCK.DIRT;
        }
      }

      // Remove only old natural fill. Never clear structure voxels above groundY.
      if (newGy < oldGy) {
        for (let y = oldGy; y > newGy; y--) {
          const t = this.get(x, y, z);
          if (t === BLOCK.BEDROCK) break;
          if (y <= oldGy && t !== BLOCK.AIR && t !== BLOCK.WATER) this.set(x, y, z, BLOCK.AIR);
        }
      } else if (newGy > oldGy) {
        for (let y = oldGy + 1; y <= newGy; y++) {
          const t = this.get(x, y, z);
          if (t === BLOCK.AIR || t === BLOCK.WATER) {
            this.set(x, y, z, y === newGy ? surfaceType : BLOCK.DIRT);
          }
        }
      }
      if (this.get(x, newGy, z) === BLOCK.AIR || newGy <= oldGy) {
        this.set(x, newGy, z, surfaceType);
      }

      this.groundY[index] = newGy;
      this.terrainH[index] = nextTop;
      if (global.VF.DEBUG_TERRAIN && !this.assertTerrainColumn(x, z)) {
        throw new Error('Terrain column desynchronized at ' + x + ',' + z);
      }
      if (!opts.deferDirty) {
        if (this.dirtyRect) this.dirtyRect(x - 1, z - 1, x + 1, z + 1, 'content');
        else if (this._markChunkDirty) {
          this._markChunkDirty(Math.floor(x / this.chunkSize), Math.floor(z / this.chunkSize), 'content');
        }
      }
      return true;
    };

    /** Limited, deterministic heightfield crater used by explosive gameplay. */
    proto.deformTerrainCircle = function (cx, cz, radius, depth, opts) {
      opts = opts || {};
      radius = Math.max(0.5, +radius || 0);
      depth = Math.max(0, Math.min(opts.maxDepth != null ? opts.maxDepth : 1.2, +depth || 0));
      // Smoothstep's maximum radial derivative is 1.5*depth/radius.
      // This cap keeps adjacent columns walkable without order-dependent neighbor clamps.
      depth = Math.min(depth, radius * 0.52);
      if (!(depth > 0)) return 0;
      const minX = Math.max(1, Math.floor(cx - radius));
      const maxX = Math.min(this.worldSize - 2, Math.ceil(cx + radius));
      const minZ = Math.max(1, Math.floor(cz - radius));
      const maxZ = Math.min(this.worldSize - 2, Math.ceil(cz + radius));
      let changed = 0;
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          if (this._terrainCellProtected(x, z, opts)) continue;
          const dx = x + 0.5 - cx;
          const dz = z + 0.5 - cz;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d >= radius) continue;
          const t = 1 - d / radius;
          const falloff = t * t * (3 - 2 * t);
          const mapIndex = z * this.worldSize + x;
          const oldTop = this.terrainH[mapIndex] || this.getTerrainTop(x + 0.5, z + 0.5);
          const gy = this.groundY[mapIndex] || Math.round(oldTop) - 1;
          const surface = this.get(x, gy, z);
          const BLOCK = global.VF.BLOCK;
          const roadScale =
            surface === BLOCK.ROAD || surface === BLOCK.ASPHALT
              ? opts.roadScale != null
                ? opts.roadScale
                : 0.45
              : 1;
          const deltaSteps = Math.round(depth * falloff * roadScale * 10);
          if (!deltaSteps) continue;
          const nextTop = (Math.round(oldTop * 10) - deltaSteps) / 10;
          if (
            this.setTerrainTop(x, z, nextTop, {
              deferDirty: true,
              protect: false,
              surfaceType: opts.surfaceType,
            })
          ) {
            changed++;
          }
        }
      }
      if (changed && this.dirtyRect) {
        this.dirtyRect(minX - 1, minZ - 1, maxX + 1, maxZ + 1, 'content');
      }
      return changed;
    };

    proto.assertTerrainColumn = function (x, z) {
      x = Math.floor(x);
      z = Math.floor(z);
      if (x < 0 || z < 0 || x >= this.worldSize || z >= this.worldSize) return false;
      const i = z * this.worldSize + x;
      const top = this.terrainH[i];
      const gy = this.groundY[i];
      const t = this.get(x, gy, z);
      return top > 0.5 && gy === Math.round(top) - 1 && t !== global.VF.BLOCK.AIR;
    };

    /**
     * Treat the vehicle as a rigid plank: sample the front bumper and rear
     * bumper, then pose the hull on the line between those contacts.
     * Local -Z is the nose. `y` is the mid-plank height, not a footprint average.
     */
    proto.sampleDriveHeight = function (x, z, halfX, halfZ, yaw, maxStep) {
      maxStep = maxStep != null ? maxStep : 2.8;
      halfX = halfX != null ? halfX : 1.2;
      halfZ = halfZ != null ? halfZ : 2.4;
      const c = Math.cos(yaw || 0);
      const s = Math.sin(yaw || 0);
      const widthXs = [-halfX, -halfX * 0.5, 0, halfX * 0.5, halfX];

      const sampleLocal = (lx, lz) =>
        this.getTerrainTop(x + lx * c - lz * s, z + lx * s + lz * c);

      const sampleEdge = (lz) => {
        let sum = 0;
        let minY = 1e9;
        let maxY = -1e9;
        for (let i = 0; i < widthXs.length; i++) {
          const y = sampleLocal(widthXs[i], lz);
          sum += y;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        return { avg: sum / widthXs.length, minY: minY, maxY: maxY };
      };

      const front = sampleEdge(-halfZ);
      const rear = sampleEdge(halfZ);
      const centerY = sampleLocal(0, 0);
      const rise = front.avg - rear.avg;
      const run = Math.max(0.1, halfZ * 2);
      const longitudinalSlope = Math.atan2(Math.abs(rise), run);
      const stepClimbable = Math.abs(rise) <= maxStep;
      return {
        y: (front.avg + rear.avg) * 0.5,
        minY: Math.min(front.minY, rear.minY, centerY),
        maxY: Math.max(front.maxY, rear.maxY, centerY),
        centerY: centerY,
        frontY: front.avg,
        rearY: rear.avg,
        frontMaxY: front.maxY,
        rearMinY: rear.minY,
        slope: longitudinalSlope,
        climbable:
          stepClimbable ||
          longitudinalSlope <= MAX_DRIVE_SLOPE + 1e-4,
      };
    };

    proto.sampleTerrainFootprint = function (x, z, radius, moveX, moveZ) {
      radius = radius != null ? Math.max(0.05, radius) : 0.35;
      let dx = moveX || 0;
      let dz = moveZ || 0;
      const len = Math.hypot(dx, dz);
      if (len > 1e-6) {
        dx /= len;
        dz /= len;
      } else {
        dx = 1;
        dz = 0;
      }
      const sx = -dz;
      const sz = dx;
      const center = this.getTerrainTop(x, z);
      const front = this.getTerrainTop(x + dx * radius, z + dz * radius);
      const back = this.getTerrainTop(x - dx * radius, z - dz * radius);
      const left = this.getTerrainTop(x + sx * radius, z + sz * radius);
      const right = this.getTerrainTop(x - sx * radius, z - sz * radius);
      const min = Math.min(center, front, back, left, right);
      const max = Math.max(center, front, back, left, right);
      const slope = Math.atan2(Math.abs(front - back), Math.max(0.01, radius * 2));
      return {
        center: center,
        front: front,
        back: back,
        left: left,
        right: right,
        min: min,
        max: max,
        rise: front - center,
        slope: slope,
        blocked: front - center > WALK_STEP + 0.001 || slope > MAX_WALK_SLOPE,
      };
    };

    proto._terrainMaxUnderBox = function (box) {
      let maxH = 0;
      let minH = 1e9;
      const x0 = Math.floor(box.min.x / STEP);
      const x1 = Math.floor((box.max.x - 1e-4) / STEP);
      const z0 = Math.floor(box.min.z / STEP);
      const z1 = Math.floor((box.max.z - 1e-4) / STEP);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iz = z0; iz <= z1; iz++) {
          const h = this.getTerrainTop(ix * STEP + STEP * 0.5, iz * STEP + STEP * 0.5);
          if (h > maxH) maxH = h;
          if (h < minH) minH = h;
        }
      }
      if (minH > 1e8) minH = 0;
      return { min: minH, max: maxH };
    };

    proto._terrainOverlapsBox = function (box) {
      const cx = (box.min.x + box.max.x) * 0.5;
      const cz = (box.min.z + box.max.z) * 0.5;
      const cH = this.getTerrainTop(cx, cz);
      // The map has no underground tunnels, so a body fully below the
      // heightfield is also an overlap and must be recovered upward.
      if (box.min.y < cH - SINK) return true;
      return false;
    };

    proto._appendTerrainHits = function (box, pool, n) {
      const cx = (box.min.x + box.max.x) * 0.5;
      const cz = (box.min.z + box.max.z) * 0.5;
      const cH = this.getTerrainTop(cx, cz);
      if (!(box.min.y < cH)) return n;
      let h = pool[n];
      if (!h) {
        h = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
        pool[n] = h;
      }
      h.min.set(box.min.x, Math.min(cH - 0.18, box.min.y - 0.01), box.min.z);
      h.max.set(box.max.x, cH, box.max.z);
      return n + 1;
    };

    proto.raycastTerrain = function (origin, dir, maxDist) {
      if (!origin || !dir || !(maxDist > 0)) return null;
      const startH = this.getTerrainTop(origin.x, origin.z);
      if (origin.y <= startH - 0.02) {
        return { dist: 0, point: origin.clone(), x: origin.x, y: startH, z: origin.z };
      }
      // Shallow rays need finer horizontal coverage; steep rays can advance farther.
      const ds = 0.1 + Math.min(0.16, Math.abs(dir.y) * 0.16);
      let hitT = null;
      for (let t = 0; t <= maxDist; t += ds) {
        const py = origin.y + dir.y * t;
        const px = origin.x + dir.x * t;
        const pz = origin.z + dir.z * t;
        if (py <= this.getTerrainTop(px, pz)) {
          hitT = t;
          break;
        }
      }
      if (hitT == null) return null;
      let lo = Math.max(0, hitT - ds);
      let hi = hitT;
      for (let k = 0; k < 7; k++) {
        const mid = (lo + hi) * 0.5;
        const py = origin.y + dir.y * mid;
        const px = origin.x + dir.x * mid;
        const pz = origin.z + dir.z * mid;
        if (py <= this.getTerrainTop(px, pz)) hi = mid;
        else lo = mid;
      }
      const point = origin.clone().addScaledVector(dir, hi);
      return { dist: hi, point: point, x: point.x, y: point.y, z: point.z };
    };

    proto._buildTerrainChunkMesh = function (cx, cz, step) {
      step = step || STEP;
      const cs = this.chunkSize;
      const x0 = cx * cs;
      const z0 = cz * cs;
      const n = Math.max(2, Math.round(cs / step));
      const cell = cs / n;
      const nn = n * n;
      const hKey = new Int16Array(nn);
      const types = new Uint8Array(nn);
      const valid = new Uint8Array(nn);
      const size = this.worldSize;
      const BLOCK = global.VF.BLOCK;
      const COLORS = global.VF.BLOCK_COLORS || {};

      for (let lz = 0; lz < n; lz++) {
        for (let lx = 0; lx < n; lx++) {
          const wx = x0 + (lx + 0.5) * cell;
          const wz = z0 + (lz + 0.5) * cell;
          const i = lz * n + lx;
          const top = this.getTerrainTop(wx, wz);
          hKey[i] = (top * 10 + 0.5) | 0;
          const ix = Math.min(size - 1, Math.max(0, Math.floor(wx)));
          const iz = Math.min(size - 1, Math.max(0, Math.floor(wz)));
          const gy = this.groundY ? this.groundY[iz * size + ix] : 4;
          let t = this.get(ix, gy, iz);
          if (!t || t === BLOCK.AIR) t = BLOCK.GRASS;
          types[i] = t;
          valid[i] = t !== BLOCK.WATER && t !== BLOCK.AIR ? 1 : 0;
        }
      }

      const visited = new Uint8Array(nn);
      const rects = [];
      for (let lz = 0; lz < n; lz++) {
        for (let lx = 0; lx < n; lx++) {
          const i = lz * n + lx;
          if (visited[i] || !valid[i]) continue;
          const hk = hKey[i];
          const tp = types[i];
          let w = 1;
          while (
            lx + w < n &&
            !visited[lz * n + lx + w] &&
            valid[lz * n + lx + w] &&
            hKey[lz * n + lx + w] === hk &&
            types[lz * n + lx + w] === tp
          ) {
            w++;
          }
          let d = 1;
          let can = true;
          while (lz + d < n && can) {
            for (let k = 0; k < w; k++) {
              const j = (lz + d) * n + lx + k;
              if (visited[j] || !valid[j] || hKey[j] !== hk || types[j] !== tp) {
                can = false;
                break;
              }
            }
            if (can) d++;
          }
          for (let zz = 0; zz < d; zz++) {
            for (let xx = 0; xx < w; xx++) visited[(lz + zz) * n + lx + xx] = 1;
          }
          rects.push({ lx: lx, lz: lz, w: w, d: d, h: hk, type: tp });
        }
      }

      const sampleAt = function (self, lx, lz) {
        if (lx >= 0 && lz >= 0 && lx < n && lz < n) {
          const i = lz * n + lx;
          return { h: hKey[i] * STEP, valid: !!valid[i] };
        }
        const wx = x0 + (lx + 0.5) * cell;
        const wz = z0 + (lz + 0.5) * cell;
        const ix = Math.max(0, Math.min(size - 1, Math.floor(wx)));
        const iz = Math.max(0, Math.min(size - 1, Math.floor(wz)));
        const gy = self.groundY ? self.groundY[iz * size + ix] : 4;
        const t = self.get(ix, gy, iz);
        return {
          h: self.getTerrainTop(wx, wz),
          valid: t !== BLOCK.WATER && t !== BLOCK.AIR,
        };
      };

      let sideCount = 0;
      for (let lz = 0; lz < n; lz++) {
        for (let lx = 0; lx < n; lx++) {
          const i = lz * n + lx;
          if (!valid[i]) continue;
          const y = hKey[lz * n + lx] * STEP;
          if (y > sampleAt(this, lx + 1, lz).h + 0.001) sideCount++;
          if (y > sampleAt(this, lx - 1, lz).h + 0.001) sideCount++;
          if (y > sampleAt(this, lx, lz + 1).h + 0.001) sideCount++;
          if (y > sampleAt(this, lx, lz - 1).h + 0.001) sideCount++;
        }
      }

      const quadCount = rects.length + sideCount;
      if (!quadCount) return null;
      const positions = new Float32Array(quadCount * 12);
      const normals = new Float32Array(quadCount * 12);
      const colors = new Float32Array(quadCount * 12);
      const indices =
        quadCount * 4 > 65535 ? new Uint32Array(quadCount * 6) : new Uint16Array(quadCount * 6);
      if (!this._colorScratch) this._colorScratch = new THREE.Color();
      let qi = 0;
      const colOf = function (self, type, lx, lz) {
        const hex = COLORS[type] || 0x3d6b2e;
        let base = self._colorCache[hex];
        if (!base) {
          base = new THREE.Color(hex);
          self._colorCache[hex] = base;
        }
        const tint = 0.88 + self._noise(x0 + lx, z0 + lz) * 0.2;
        return self._colorScratch.copy(base).multiplyScalar(tint);
      };
      const emitQuad = function (verts, nx, ny, nz, col) {
        const po = qi * 12;
        const io = qi * 6;
        const vi = qi * 4;
        const shade = 0.72 + 0.28 * Math.max(0, ny);
        for (let v = 0; v < 4; v++) {
          positions[po + v * 3] = verts[v * 3];
          positions[po + v * 3 + 1] = verts[v * 3 + 1];
          positions[po + v * 3 + 2] = verts[v * 3 + 2];
          normals[po + v * 3] = nx;
          normals[po + v * 3 + 1] = ny;
          normals[po + v * 3 + 2] = nz;
          colors[po + v * 3] = col.r * shade;
          colors[po + v * 3 + 1] = col.g * shade;
          colors[po + v * 3 + 2] = col.b * shade;
        }
        indices[io] = vi;
        indices[io + 1] = vi + 1;
        indices[io + 2] = vi + 2;
        indices[io + 3] = vi;
        indices[io + 4] = vi + 2;
        indices[io + 5] = vi + 3;
        qi++;
      };

      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        const y = r.h * STEP;
        const xA = x0 + r.lx * cell;
        const zA = z0 + r.lz * cell;
        const xB = xA + r.w * cell;
        const zB = zA + r.d * cell;
        emitQuad(
          [xA, y, zB, xB, y, zB, xB, y, zA, xA, y, zA],
          0, 1, 0,
          colOf(this, r.type, r.lx, r.lz)
        );
      }

      for (let lz = 0; lz < n; lz++) {
        for (let lx = 0; lx < n; lx++) {
          const i = lz * n + lx;
          if (!valid[i]) continue;
          const y = hKey[i] * STEP;
          const xA = x0 + lx * cell;
          const zA = z0 + lz * cell;
          const xB = xA + cell;
          const zB = zA + cell;
          const col = colOf(this, types[i], lx, lz);
          const nxp = sampleAt(this, lx + 1, lz).h;
          if (y > nxp + 0.001) {
            emitQuad([xB, nxp, zB, xB, nxp, zA, xB, y, zA, xB, y, zB], 1, 0, 0, col);
          }
          const nxm = sampleAt(this, lx - 1, lz).h;
          if (y > nxm + 0.001) {
            emitQuad([xA, nxm, zA, xA, nxm, zB, xA, y, zB, xA, y, zA], -1, 0, 0, col);
          }
          const nzp = sampleAt(this, lx, lz + 1).h;
          if (y > nzp + 0.001) {
            emitQuad([xA, nzp, zB, xB, nzp, zB, xB, y, zB, xA, y, zB], 0, 0, 1, col);
          }
          const nzm = sampleAt(this, lx, lz - 1).h;
          if (y > nzm + 0.001) {
            emitQuad([xB, nzm, zA, xA, nzm, zA, xA, y, zA, xB, y, zA], 0, 0, -1, col);
          }
        }
      }

      if (!this._terrainMats) this._terrainMats = {};
      const matKey = step <= STEP ? 'fine' : step < 1 ? 'mid' : 'far';
      if (!this._terrainMats[matKey]) {
        const mat = this._chunkMat.clone();
        // Heightfield triangles must remain visible while spawn/collision recovery
        // lifts a player that entered from below.
        mat.side = THREE.DoubleSide;
        mat.vertexColors = true;
        this._terrainMats[matKey] = mat;
      }

      const makeMesh = (startQuad, count, useExistingIndices) => {
        const start = startQuad * 12;
        const end = (startQuad + count) * 12;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(start, end), 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(normals.subarray(start, end), 3));
        geo.setAttribute('color', new THREE.BufferAttribute(colors.subarray(start, end), 3));
        if (useExistingIndices) {
          geo.setIndex(new THREE.BufferAttribute(indices, 1));
        } else {
          const localIndices = new Uint16Array(count * 6);
          for (let q = 0; q < count; q++) {
            const io = q * 6;
            const base = q * 4;
            localIndices[io] = base;
            localIndices[io + 1] = base + 1;
            localIndices[io + 2] = base + 2;
            localIndices[io + 3] = base;
            localIndices[io + 4] = base + 2;
            localIndices[io + 5] = base + 3;
          }
          geo.setIndex(new THREE.BufferAttribute(localIndices, 1));
        }
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, this._terrainMats[matKey]);
        mesh.userData.terrainFine = true;
        mesh.userData.terrainStep = step;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        return mesh;
      };

      if (quadCount <= MAX_QUADS_PER_MESH) {
        return makeMesh(0, quadCount, true);
      }

      const group = new THREE.Group();
      group.userData.terrainFine = true;
      group.userData.terrainStep = step;
      for (let startQuad = 0; startQuad < quadCount; startQuad += MAX_QUADS_PER_MESH) {
        const count = Math.min(MAX_QUADS_PER_MESH, quadCount - startQuad);
        group.add(makeMesh(startQuad, count, false));
      }
      return group;
    };
  }

  global.VF = global.VF || {};
  global.VF.TERRAIN_STEP = STEP;
  if (global.VF.VoxelWorld) attach(global.VF.VoxelWorld);
})(typeof window !== 'undefined' ? window : this);
