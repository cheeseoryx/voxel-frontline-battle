/**
 * building.js �?Build modes: voxel cover (4) + fortress tower (5)
 * Cover: width 6 × height 4 × thickness 1 �?solid voxels you can hide behind
 */
(function (global) {
  'use strict';

  const BUILDABLES = {
    // Slot 4 �?sandbag / barricade cover (voxel)
    // Shape (front view, thickness = 1):
    //   ██████
    //   ██████
    //   ██████
    //   ██████
    a: {
      id: 'a',
      name: 'Cover',
      kind: 'cover',
      slot: 4,
      cost: 2,
      width: 6,
      height: 4,
      thickness: 1,
    },
    // Slot 5 �?defensive tower (costs Voxel Cores)
    b: {
      id: 'b',
      name: 'Fortress Tower',
      kind: 'tower',
      slot: 5,
      cost: 1,
      costResource: 'cores',
      width: 14,
      depth: 14,
      height: 20,
    },
  };

  function _canAfford(player, def) {
    if (def.costResource === 'cores') return player.cores >= def.cost;
    return player.blocks >= def.cost;
  }

  function _spendCost(player, def) {
    if (def.costResource === 'cores') player.cores -= def.cost;
    else player.blocks -= def.cost;
  }

  function Building(player, world, scene) {
    this.player = player;
    this.world = world;
    this.scene = scene;
    this.active = false;
    this.buildType = 'a';
    this.ghost = null;
    this.placeYaw = 0; // snapped to 90°
    this.canPlace = false;
    this.placed = [];
    this._previewBlocks = []; // ghost voxel meshes for cover

    this._bind();
  }

  Building.prototype._bind = function () {
    const self = this;
    document.addEventListener('keydown', (e) => {
      if (!self.player.locked) return;
      if (global.VF.Range && global.VF.Range.isOpen) return;
      if (e.code === 'Digit4') {
        if (global.VF.Throwables && global.VF.Throwables.busy && global.VF.Throwables.busy()) return;
        if (global.VF.Melee && global.VF.Melee.available()) return;
        self.enterMode('a');
      }
      if (e.code === 'Digit5') self.enterMode('b');
      if (e.code === 'KeyE') self.tryCollect();
      // Rotate cover with Q / R while in build mode
      if (self.active && (e.code === 'KeyQ' || e.code === 'KeyR')) {
        const step = e.code === 'KeyQ' ? Math.PI / 2 : -Math.PI / 2;
        self.placeYaw = self._snapYaw(self.placeYaw + step);
        self._yawLocked = true;
      }
    });
    document.addEventListener('mousedown', (e) => {
      if (!self.player.locked || e.button !== 0) return;
      if (!self.active) return;
      self.tryPlace();
    });
  };

  Building.prototype._snapYaw = function (yaw) {
    const step = Math.PI / 2;
    return Math.round(yaw / step) * step;
  };

  /** 死斗 is pure gunplay: no cover walls, no custom towers. */
  Building.prototype.isEnabled = function () {
    const GM = global.VF.GameModes;
    return !GM || !GM.param || GM.param('building', true) !== false;
  };

  Building.prototype.enterMode = function (type) {
    if (!this.isEnabled()) {
      if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast('本模式禁用建造');
      return;
    }
    this.buildType = type;
    this.active = true;
    this.placeYaw = this._snapYaw(this.player.yaw);
    this._yawLocked = false; // Q/R locks yaw until re-enter mode
    if (type === 'b' && global.VF.loadCustomTower) {
      global.VF.customTower = global.VF.loadCustomTower();
    }
    const w = global.VF.game && global.VF.game.weapons;
    if (w) {
      if (w._cancelReload) w._cancelReload();
      w.mode = 'build';
    }
    if (global.VF.UI) global.VF.UI.setHotbarSlot(BUILDABLES[type].slot);
    if (this.player && this.player.setHeldMode) this.player.setHeldMode('build');
    this._ensureGhost();
  };

  Building.prototype.exitMode = function () {
    this.active = false;
    if (this.ghost) this.ghost.visible = false;
    if (this.player && this.player.setHeldMode) this.player.setHeldMode('weapon');
  };

  Building.prototype._ensureGhost = function () {
    if (this.ghost) {
      this.scene.remove(this.ghost);
      this.ghost.traverse((c) => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
          if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
          else c.material.dispose();
        }
      });
    }
    const def = BUILDABLES[this.buildType];
    if (def.kind === 'cover') {
      this.ghost = this._buildCoverGhost();
    } else {
      this.ghost = this._buildActiveTowerGhost();
    }
    this.ghost.visible = false;
    this.scene.add(this.ghost);
  };

  /** Prefer player-designed tower; fall back to stock fortress */
  Building.prototype._getCustomDesign = function () {
    // Always refresh from storage so ziplines saved in the builder are present
    if (global.VF.loadCustomTower) {
      const d = global.VF.loadCustomTower();
      if (d && d.cells && Object.keys(d.cells).length > 0) {
        if (!d.ziplines) d.ziplines = [];
        global.VF.customTower = d;
        return d;
      }
    }
    if (global.VF.customTower && global.VF.customTower.cells) {
      const n = Object.keys(global.VF.customTower.cells).length;
      if (n > 0) {
        if (!global.VF.customTower.ziplines) global.VF.customTower.ziplines = [];
        return global.VF.customTower;
      }
    }
    return null;
  };

  Building.prototype._buildActiveTowerGhost = function () {
    const design = this._getCustomDesign();
    if (design && global.VF.buildTowerMeshFromDesign) {
      return global.VF.buildTowerMeshFromDesign(design, true);
    }
    return this._buildTowerMesh(true);
  };

  /**
   * Cover footprint in local voxel coords (facing +Z):
   * width 6 (x: -2..3), height 4 (y: 0..3), thickness 1 (z: 0)
   *
   *   ██████   y=3
   *   ██████   y=2
   *   ██████   y=1
   *   ██████   y=0
   */
  Building.prototype._coverOffsets = function () {
    const offsets = [];
    const w = BUILDABLES.a.width;
    const h = BUILDABLES.a.height;
    const th = BUILDABLES.a.thickness;
    // Center width on anchor (even width: -2..3 for size 6)
    const x0 = -Math.floor((w - 1) / 2);
    for (let i = 0; i < w; i++) {
      const lx = x0 + i;
      for (let ly = 0; ly < h; ly++) {
        for (let lz = 0; lz < th; lz++) {
          offsets.push({ lx, ly, lz });
        }
      }
    }
    return offsets;
  };

  /** Ghost preview made of translucent voxel cubes */
  Building.prototype._buildCoverGhost = function () {
    const root = new THREE.Group();
    root.name = 'CoverGhost';
    const mat = new THREE.MeshLambertMaterial({
      color: 0x66ffaa,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });
    const offsets = this._coverOffsets();
    for (let i = 0; i < offsets.length; i++) {
      const o = offsets[i];
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.95, 0.95), mat.clone());
      // Local: X = width, Y = up, Z = thickness (toward look)
      m.position.set(o.lx, o.ly + 0.5, o.lz);
      root.add(m);
    }
    root.userData.kind = 'cover';
    return root;
  };

  Building.prototype._buildTowerMesh = function (ghost) {
    const def = BUILDABLES.b;
    const root = new THREE.Group();
    root.name = ghost ? 'TowerGhost' : 'Tower';
    root.userData.kind = 'tower';

    const opacity = ghost ? 0.45 : 1;
    const mat = (color) =>
      new THREE.MeshLambertMaterial({
        color,
        transparent: ghost,
        opacity,
        depthWrite: !ghost,
      });

    const stone = mat(0x8e8f8c);
    const wood = mat(0x8a7354);
    const dark = mat(0x4a4e56);
    const flag = mat(0xc4302b);
    const accent = mat(0x4a5a3a);

    const add = (w, h, d, material, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
      m.position.set(x, y, z);
      m.castShadow = !ghost;
      m.receiveShadow = !ghost;
      root.add(m);
      return m;
    };

    const w = def.width;
    const h = def.height;
    add(w, 1, w, dark, 0, 0.5, 0);
    const wallH = h - 2;
    const t = 0.8;
    // Front (+Z) wall with door gap (len 2, height 4)
    const doorLen = 2;
    const doorH = 4;
    const side = (w - doorLen) / 2;
    add(side, wallH, t, stone, -w / 2 + side / 2, 1 + wallH / 2, w / 2 - t / 2);
    add(side, wallH, t, stone, w / 2 - side / 2, 1 + wallH / 2, w / 2 - t / 2);
    const aboveDoor = wallH - doorH;
    if (aboveDoor > 0.1) {
      add(doorLen, aboveDoor, t, stone, 0, 1 + doorH + aboveDoor / 2, w / 2 - t / 2);
    }
    add(w, wallH, t, stone, 0, 1 + wallH / 2, -w / 2 + t / 2);
    add(t, wallH, w - t * 2, stone, w / 2 - t / 2, 1 + wallH / 2, 0);
    add(t, wallH, w - t * 2, stone, -w / 2 + t / 2, 1 + wallH / 2, 0);

    // Door opening only �?collidable door/stairs registered on place
    // (avoids duplicate meshes after yaw rotation)

    for (let i = 0; i < wallH; i++) {
      add(1.4, 0.25, 0.9, wood, -w / 2 + 2.5, 1.2 + i * 0.85, -w / 2 + 2.2 + (i % 4) * 0.6);
    }
    const platY = h - 0.5;
    add(w + 0.6, 0.4, w + 0.6, accent, 0, platY, 0);
    const c = w / 2;
    [
      [c, c],
      [c, -c],
      [-c, c],
      [-c, -c],
    ].forEach(([px, pz]) => {
      add(0.5, 1.4, 0.5, stone, px, platY + 0.9, pz);
    });
    add(0.12, 3.2, 0.12, dark, 0, platY + 2.2, 0);
    add(1.2, 0.7, 0.08, flag, 0.65, platY + 3.2, 0);

    // Ghost preview: show door panel
    if (ghost) {
      add(doorLen * 0.96, doorH * 0.96, 0.5, wood, 0, 1 + doorH / 2, w / 2 - 0.25);
    }

    root.userData.def = def;
    return root;
  };

  /** World-space voxel cells for cover at anchor (floor cell) + yaw */
  Building.prototype._coverWorldCells = function (anchorX, anchorY, anchorZ, yaw) {
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // Local +Z = look / thickness; local +X = right (width)
    const cells = [];
    const offsets = this._coverOffsets();
    for (let i = 0; i < offsets.length; i++) {
      const o = offsets[i];
      const wx = Math.round(anchorX + o.lx * cos + o.lz * sin);
      const wy = anchorY + o.ly;
      const wz = Math.round(anchorZ + o.lx * -sin + o.lz * cos);
      cells.push({ x: wx, y: wy, z: wz });
    }
    return cells;
  };

  Building.prototype.update = function () {
    if (!this.active) return;
    if (!this.ghost) this._ensureGhost();

    const origin = this.player.getEyePosition();
    const dir = this.player.getLookDirection();
    // Aim placement follows crosshair (not feet)
    const hit = this._findAimPlacement(origin, dir, 28);
    if (!hit) {
      this.ghost.visible = false;
      this.canPlace = false;
      return;
    }

    // Face camera yaw unless Q/R locked rotation
    if (!this._yawLocked) {
      this.placeYaw = this._snapYaw(this.player.yaw);
    }

    const def = BUILDABLES[this.buildType];
    const afford = _canAfford(this.player, def);

    if (def.kind === 'cover') {
      const ax = Math.floor(hit.x);
      const ay = Math.floor(hit.y);
      const az = Math.floor(hit.z);
      this.ghost.position.set(ax + 0.5, ay, az + 0.5);
      this.ghost.rotation.set(0, this.placeYaw, 0);

      const cells = this._coverWorldCells(ax, ay, az, this.placeYaw);
      let clear = true;
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        const t = this.world.get(c.x, c.y, c.z);
        if (t !== global.VF.BLOCK.AIR && t !== global.VF.BLOCK.GLASS) {
          clear = false;
          break;
        }
      }
      // Don't allow placing inside the player
      const pp = this.player.object.position;
      if (Math.hypot(ax + 0.5 - pp.x, az + 0.5 - pp.z) < 1.4) clear = false;

      this.canPlace = afford && clear;
    } else {
      this.ghost.position.set(hit.x, hit.y, hit.z);
      this.ghost.rotation.y = this.placeYaw;
      this.canPlace = afford;
    }

    this.ghost.visible = true;
    const tint = this.canPlace ? 0x66ffaa : 0xff4455;
    this.ghost.traverse((c) => {
      if (c.isMesh && c.material) {
        c.material.color.setHex(tint);
        c.material.opacity = 0.45;
      }
    });
  };

  /**
   * Ray from crosshair: first solid hit �?place on/against that surface.
   * Ignores near-player hits so preview isn't stuck underfoot.
   */
  Building.prototype._findAimPlacement = function (origin, dir, maxDist) {
    const minDist = 2.5;
    const playerPos = this.player.object.position;
    let lastAir = null;

    for (let t = 0.4; t <= maxDist; t += 0.12) {
      const p = origin.clone().addScaledVector(dir, t);
      const x = Math.floor(p.x);
      const y = Math.floor(p.y);
      const z = Math.floor(p.z);

      // Skip volume too close to player body
      const distPlayer = Math.hypot(p.x - playerPos.x, p.z - playerPos.z);
      if (t < minDist || distPlayer < 1.6) {
        if (!this.world._isSolid(x, y, z)) {
          lastAir = { x, y, z, t };
        }
        continue;
      }

      if (!this.world._isSolid(x, y, z)) {
        lastAir = { x, y, z, t };
        continue;
      }

      // Hit a solid block along the aim ray
      // If looking downward onto a top face �?place on top
      if (dir.y < -0.15) {
        let top = y;
        while (top + 1 < this.world.height && this.world._isSolid(x, top + 1, z)) top++;
        return { x: x + 0.5, y: top + 1, z: z + 0.5 };
      }

      // Side/frontal hit �?place at last air cell, grounded
      if (lastAir && lastAir.t >= minDist) {
        return this._groundAt(lastAir.x, lastAir.y, lastAir.z);
      }

      // Fallback: on top of hit block
      let top = y;
      while (top + 1 < this.world.height && this.world._isSolid(x, top + 1, z)) top++;
      return { x: x + 0.5, y: top + 1, z: z + 0.5 };
    }

    // Aiming into open air �?drop to ground under far aim point
    if (lastAir && lastAir.t >= minDist) {
      return this._groundAt(lastAir.x, lastAir.y, lastAir.z);
    }

    const far = origin.clone().addScaledVector(dir, Math.max(minDist + 1, Math.min(maxDist, 12)));
    return this._groundAt(Math.floor(far.x), Math.floor(far.y), Math.floor(far.z));
  };

  Building.prototype._groundAt = function (x, y, z) {
    let gy = Math.min(y, this.world.height - 2);
    // Search downward for solid
    for (let dy = 0; dy < 48; dy++) {
      const by = gy - dy;
      if (by < 0) break;
      if (this.world._isSolid(x, by, z)) {
        return { x: x + 0.5, y: by + 1, z: z + 0.5 };
      }
    }
    // Search upward then down (if we started underground)
    for (let by = 0; by < this.world.height - 1; by++) {
      if (this.world._isSolid(x, by, z) && !this.world._isSolid(x, by + 1, z)) {
        return { x: x + 0.5, y: by + 1, z: z + 0.5 };
      }
    }
    return null;
  };

  Building.prototype._findGround = function (origin, dir, maxDist) {
    return this._findAimPlacement(origin, dir, maxDist);
  };

  Building.prototype.tryPlace = function () {
    if (this.player && this.player.dead) return;
    if (!this.isEnabled()) return;
    if (!this.active || !this.canPlace || !this.ghost || !this.ghost.visible) return;
    const def = BUILDABLES[this.buildType];
    if (!_canAfford(this.player, def)) {
      if (global.VF.UI) {
        global.VF.UI.toast(
          def.costResource === 'cores' ? '需要部署核（开局 1 个，也可捡地图绿核）' : '需要掩体建材'
        );
      }
      return;
    }

    if (def.kind === 'tower') {
      const design = this._getCustomDesign();
      if (design && global.VF.Economy && global.VF.Economy.consumeTowerDeploy) {
        const peek =
          global.VF.Economy.previewTowerCost &&
          global.VF.Economy.previewTowerCost(design);
        if (peek && !peek.ok) {
          if (global.VF.UI) {
            global.VF.UI.toast(peek.reason || '余额不足');
          }
          return;
        }
      }
    }

    _spendCost(this.player, def);

    if (global.VF.Audio) global.VF.Audio.play('build');

    if (def.kind === 'cover') {
      this._placeCoverVoxels();
      if (global.VF.UI) {
        global.VF.UI.updateResources(this.player.cores, this.player.blocks);
        global.VF.UI.toast('Cover placed');
      }
      this._syncBuildToPvp({
        kind: 'cover',
        ax: Math.floor(this.ghost.position.x),
        ay: Math.floor(this.ghost.position.y),
        az: Math.floor(this.ghost.position.z),
        yaw: this.placeYaw,
      });
    } else {
      const design = this._getCustomDesign();
      if (design && global.VF.stampCustomTower) {
        if (global.VF.Economy && global.VF.Economy.consumeTowerDeploy) {
          const used = global.VF.Economy.consumeTowerDeploy(design);
          if (!used.ok) {
            this.player.cores = (this.player.cores || 0) + (def.cost || 0);
            if (global.VF.UI) {
              global.VF.UI.updateResources(this.player.cores, this.player.blocks);
              global.VF.UI.toast(used.reason || '余额不足');
            }
            return;
          }
        }
        // Custom design: stamp voxels into the world (real collision)
        global.VF.stampCustomTower(
          this.world,
          design,
          this.ghost.position,
          this.placeYaw,
          this.scene
        );
        this.placed.push({
          kind: 'custom-tower',
          pos: this.ghost.position.clone(),
          yaw: this.placeYaw,
        });
        if (global.VF.UI) {
          global.VF.UI.updateResources(this.player.cores, this.player.blocks);
          const zc =
            (design.ziplines && design.ziplines.length) || 0;
          global.VF.UI.toast(
            zc > 0 ? '防御塔已部署（含 ' + zc + ' 条滑索）' : '自定义防御塔已部署'
          );
        }
        this._maybeSpawnTowerGun(design, this.ghost.position, this.placeYaw);
        this._syncBuildToPvp({
          kind: 'custom-tower',
          x: this.ghost.position.x,
          y: this.ghost.position.y,
          z: this.ghost.position.z,
          yaw: this.placeYaw,
          design: design,
          modGun: !!(global.VF.game && global.VF.game._towerGunArmed),
        });
      } else {
        this.player.cores = (this.player.cores || 0) + (def.cost || 0);
        if (global.VF.UI) {
          global.VF.UI.updateResources(this.player.cores, this.player.blocks);
          global.VF.UI.toast('还没有防御塔蓝图 · 请先在大厅「防御塔」里建造');
        }
      }
    }
  };

  Building.prototype._syncBuildToPvp = function (payload) {
    if (!global.VF.game || global.VF.game.mode !== 'pvp') return;
    if (!global.VF.Pvp || !global.VF.Pvp.sendBuild) return;
    // Ensure phase is play (gate may lag one frame)
    if (global.VF.Pvp.phase !== 'play') global.VF.Pvp.phase = 'play';
    global.VF.Pvp.sendBuild(payload);
  };

  /** Apply a build placed by the other PVP player (no cost). */
  Building.prototype.applyNetworkBuild = function (data) {
    if (!data || !data.kind) return;
    if (data.kind === 'cover') {
      const ax = data.ax | 0;
      const ay = data.ay | 0;
      const az = data.az | 0;
      const yaw = data.yaw || 0;
      const cells = this._coverWorldCells(ax, ay, az, yaw);
      const blockType = global.VF.BLOCK.CONCRETE;
      const chunks = new Set();
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        if (this.world.get(c.x, c.y, c.z) === global.VF.BLOCK.AIR) {
          this.world.set(c.x, c.y, c.z, blockType);
          if (this.world.markManmade) this.world.markManmade(c.x, c.y, c.z);
        }
        const cx = Math.floor(c.x / this.world.chunkSize);
        const cz = Math.floor(c.z / this.world.chunkSize);
        chunks.add(cx + ',' + cz);
      }
      chunks.forEach((key) => {
        const parts = key.split(',');
        const cx = Number(parts[0]);
        const cz = Number(parts[1]);
        if (cx >= 0 && cz >= 0 && cx < this.world.worldChunks && cz < this.world.worldChunks) {
          if (this.world._markChunkDirty) this.world._markChunkDirty(cx, cz);
          else this.world._rebuildChunk(cx, cz);
        }
      });
      this.placed.push({ kind: 'cover', cells: cells.slice(), net: true });
      return;
    }

    if (data.kind === 'custom-tower' && data.design && global.VF.stampCustomTower) {
      const pos = new THREE.Vector3(data.x, data.y, data.z);
      global.VF.stampCustomTower(
        this.world,
        data.design,
        pos,
        data.yaw || 0,
        this.scene
      );
      this.placed.push({
        kind: 'custom-tower',
        pos: pos,
        yaw: data.yaw || 0,
        net: true,
      });
      if (data.modGun) this._spawnTowerGunAt(data.design, pos, data.yaw || 0, true);
      return;
    }

    if (data.kind === 'default-tower') {
      const def = BUILDABLES.b;
      const mesh = this._buildTowerMesh(false);
      mesh.position.set(data.x, data.y, data.z);
      mesh.rotation.y = data.yaw || 0;
      this.scene.add(mesh);
      this.placed.push(mesh);
      this._stampTowerCollision(mesh.position, def, data.yaw || 0);
      this._registerTowerDoorAndStairs(mesh.position, def, data.yaw || 0);
      if (data.modGun) this._spawnTowerGunAt(null, mesh.position, data.yaw || 0, true);
    }
  };

  Building.prototype._maybeSpawnTowerGun = function (design, pos, yaw) {
    const game = global.VF.game;
    if (!game || !game._towerGunArmed) return;
    this._spawnTowerGunAt(design, pos, yaw, false);
  };

  Building.prototype._spawnTowerGunAt = function (design, pos, yaw, fromNet) {
    const skills = global.VF.game && global.VF.game.skills;
    if (!skills || !skills.spawnModuleTurret) return;
    const anchor = this._towerGunAnchor(design, pos, yaw);
    const localTeam =
      (this.player && this.player.team) ||
      (this.world && this.world._playerTeam) ||
      'ally';
    const team = fromNet ? (localTeam === 'ally' ? 'enemy' : 'ally') : localTeam;
    skills.spawnModuleTurret(anchor.x, anchor.y, anchor.z, team);
    if (!fromNet && global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast('塔顶机枪已就位');
    }
  };

  Building.prototype._towerGunAnchor = function (design, pos, yaw) {
    let best = null;
    if (design && design.cells) {
      let bestY = -Infinity;
      let bestR = Infinity;
      Object.keys(design.cells).forEach(function (k) {
        const p = k.split(',');
        const x = +p[0];
        const y = +p[1];
        const z = +p[2];
        const r = Math.abs(x) + Math.abs(z);
        if (y > bestY || (y === bestY && r < bestR)) {
          bestY = y;
          bestR = r;
          best = { x: x, y: y, z: z };
        }
      });
    }
    if (best) {
      const sin = Math.sin(yaw || 0);
      const cos = Math.cos(yaw || 0);
      const bx = Math.floor(pos.x);
      const by = Math.floor(pos.y);
      const bz = Math.floor(pos.z);
      const rx = Math.round(best.x * cos + best.z * sin);
      const rz = Math.round(best.x * -sin + best.z * cos);
      return { x: bx + rx + 0.5, y: by + best.y + 1.05, z: bz + rz + 0.5 };
    }
    return {
      x: pos.x,
      y: pos.y + ((BUILDABLES.b && BUILDABLES.b.height) || 14) + 0.2,
      z: pos.z,
    };
  };

  /** Stamp cover into the voxel world �?real collision + bullet blocking */
  Building.prototype._placeCoverVoxels = function () {
    const ax = Math.floor(this.ghost.position.x);
    const ay = Math.floor(this.ghost.position.y);
    const az = Math.floor(this.ghost.position.z);
    const cells = this._coverWorldCells(ax, ay, az, this.placeYaw);
    const blockType = global.VF.BLOCK.CONCRETE;
    const chunks = new Set();
    const extraHits =
      global.VF.Skills && global.VF.Skills.getBuildDurabilityHits
        ? Math.max(0, global.VF.Skills.getBuildDurabilityHits(this.player) - 1)
        : 0;
    const typeHits = global.VF.BLOCK_HITS || {};

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (this.world.get(c.x, c.y, c.z) === global.VF.BLOCK.AIR) {
        this.world.set(c.x, c.y, c.z, blockType);
        if (this.world.markManmade) this.world.markManmade(c.x, c.y, c.z);
        const base = typeHits[blockType] != null ? typeHits[blockType] : 1;
        const total = base > 0 ? base + extraHits : 0;
        if (total > 1 && this.world.setBlockDurability) {
          this.world.setBlockDurability(c.x, c.y, c.z, total);
        }
      }
      const cx = Math.floor(c.x / this.world.chunkSize);
      const cz = Math.floor(c.z / this.world.chunkSize);
      chunks.add(cx + ',' + cz);
      // Neighbor chunk seams
      if (c.x % this.world.chunkSize === 0) chunks.add(cx - 1 + ',' + cz);
      if (c.x % this.world.chunkSize === this.world.chunkSize - 1) chunks.add(cx + 1 + ',' + cz);
      if (c.z % this.world.chunkSize === 0) chunks.add(cx + ',' + (cz - 1));
      if (c.z % this.world.chunkSize === this.world.chunkSize - 1) chunks.add(cx + ',' + (cz + 1));
    }

    chunks.forEach((key) => {
      const parts = key.split(',');
      const cx = Number(parts[0]);
      const cz = Number(parts[1]);
      if (cx >= 0 && cz >= 0 && cx < this.world.worldChunks && cz < this.world.worldChunks) {
        if (this.world._markChunkDirty) this.world._markChunkDirty(cx, cz); else this.world._rebuildChunk(cx, cz);
      }
    });

    this.placed.push({ kind: 'cover', cells: cells.slice() });
  };

  Building.prototype._stampTowerCollision = function (pos, def, yaw) {
    const half = Math.floor(def.width / 2);
    const bx = Math.floor(pos.x);
    const bz = Math.floor(pos.z);
    const by = Math.floor(pos.y);
    const doorLen = 2;
    const doorH = 4;
    const q = Math.round((((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 2)) % 4;
    const extraHits =
      global.VF.Skills && global.VF.Skills.getBuildDurabilityHits
        ? Math.max(0, global.VF.Skills.getBuildDurabilityHits(this.player) - 1)
        : 0;
    const typeHits = global.VF.BLOCK_HITS || {};

    const isDoorCell = (x, y, z) => {
      if (y < by + 1 || y >= by + 1 + doorH) return false;
      if (q === 0) return z === bz + half && x >= bx - 1 && x < bx - 1 + doorLen;
      if (q === 2) return z === bz - half && x >= bx - 1 && x < bx - 1 + doorLen;
      if (q === 1) return x === bx + half && z >= bz - 1 && z < bz - 1 + doorLen;
      return x === bx - half && z >= bz - 1 && z < bz - 1 + doorLen;
    };

    for (let x = bx - half; x <= bx + half; x++) {
      for (let z = bz - half; z <= bz + half; z++) {
        for (let y = by; y < by + def.height; y++) {
          const edge =
            x === bx - half || x === bx + half || z === bz - half || z === bz + half || y === by;
          if (!(edge || y >= by + def.height - 1)) continue;
          if (isDoorCell(x, y, z)) continue;
          if (this.world.get(x, y, z) === global.VF.BLOCK.AIR) {
            const t = global.VF.BLOCK.STONE;
            this.world.set(x, y, z, t);
            if (this.world.markManmade) this.world.markManmade(x, y, z);
            const base = typeHits[t] != null ? typeHits[t] : 1;
            const total = base > 0 ? base + extraHits : 0;
            if (total > 1 && this.world.setBlockDurability) {
              this.world.setBlockDurability(x, y, z, total);
            }
          }
        }
      }
    }
    const cx0 = Math.floor((bx - half) / this.world.chunkSize);
    const cx1 = Math.floor((bx + half) / this.world.chunkSize);
    const cz0 = Math.floor((bz - half) / this.world.chunkSize);
    const cz1 = Math.floor((bz + half) / this.world.chunkSize);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        if (this.world._markChunkDirty) this.world._markChunkDirty(cx, cz); else this.world._rebuildChunk(cx, cz);
      }
    }
  };

  /** Collidable door + half-block stairs for player-built towers */
  Building.prototype._registerTowerDoorAndStairs = function (pos, def, yaw) {
    const half = Math.floor(def.width / 2);
    const bx = Math.floor(pos.x);
    const bz = Math.floor(pos.z);
    const by = Math.floor(pos.y);
    const doorLen = 2;
    const doorH = 4;
    const doorThick = 0.5;
    const q = Math.round((((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 2)) % 4;

    let box;
    let panelPos;
    if (q === 0) {
      const x0 = bx - 1;
      const z = bz + half;
      box = new THREE.Box3(
        new THREE.Vector3(x0 + 0.02, by + 1, z),
        new THREE.Vector3(x0 + doorLen - 0.02, by + 1 + doorH, z + doorThick)
      );
      panelPos = new THREE.Vector3(x0 + doorLen / 2, by + 1 + doorH / 2, z + doorThick / 2);
    } else if (q === 2) {
      const x0 = bx - 1;
      const z = bz - half;
      box = new THREE.Box3(
        new THREE.Vector3(x0 + 0.02, by + 1, z - doorThick),
        new THREE.Vector3(x0 + doorLen - 0.02, by + 1 + doorH, z)
      );
      panelPos = new THREE.Vector3(x0 + doorLen / 2, by + 1 + doorH / 2, z - doorThick / 2);
    } else if (q === 1) {
      const z0 = bz - 1;
      const x = bx + half;
      box = new THREE.Box3(
        new THREE.Vector3(x, by + 1, z0 + 0.02),
        new THREE.Vector3(x + doorThick, by + 1 + doorH, z0 + doorLen - 0.02)
      );
      panelPos = new THREE.Vector3(x + doorThick / 2, by + 1 + doorH / 2, z0 + doorLen / 2);
    } else {
      const z0 = bz - 1;
      const x = bx - half;
      box = new THREE.Box3(
        new THREE.Vector3(x - doorThick, by + 1, z0 + 0.02),
        new THREE.Vector3(x, by + 1 + doorH, z0 + doorLen - 0.02)
      );
      panelPos = new THREE.Vector3(x - doorThick / 2, by + 1 + doorH / 2, z0 + doorLen / 2);
    }

    const mat = new THREE.MeshLambertMaterial({ color: 0x5a3a22 });
    const geo =
      q === 1 || q === 3
        ? new THREE.BoxGeometry(doorThick, doorH * 0.96, doorLen * 0.96)
        : new THREE.BoxGeometry(doorLen * 0.96, doorH * 0.96, doorThick);
    const panel = new THREE.Mesh(geo, mat);
    panel.position.copy(panelPos);
    panel.name = 'TowerDoor';
    this.world.registerProp({ kind: 'door', mesh: panel, box: box, breakable: true });

    // Interior voxel stairs to rooftop (breakable / climbable)
    if (this.world._addSpiralStairs) {
      this.world._addSpiralStairs({
        cx: bx + half - 3.5,
        cz: bz - half + 3.5,
        yStart: by + 1,
        yEnd: by + def.height - 1,
      });
      const cs = this.world.chunkSize;
      const x0 = bx + half - 6;
      const z0 = bz - half;
      for (let cx = Math.floor(x0 / cs); cx <= Math.floor((x0 + 8) / cs); cx++) {
        for (let cz = Math.floor(z0 / cs); cz <= Math.floor((z0 + 10) / cs); cz++) {
          if (cx >= 0 && cz >= 0 && cx < this.world.worldChunks && cz < this.world.worldChunks) {
            if (this.world._markChunkDirty) this.world._markChunkDirty(cx, cz); else this.world._rebuildChunk(cx, cz);
          }
        }
      }
    }
  };

  Building.prototype.tryCollect = function () {
    if (!global.VF.game || !global.VF.game.resources) return;
    const pos = this.player.object.position;
    const list = global.VF.game.resources;
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      if (pos.distanceTo(r.mesh.position) < 2.5) {
        if (r.type === 'core') this.player.cores += 1;
        else this.player.blocks += 2;
        this.scene.remove(r.mesh);
        if (r.mesh.geometry) r.mesh.geometry.dispose();
        list.splice(i, 1);
        if (global.VF.UI) {
          global.VF.UI.updateResources(this.player.cores, this.player.blocks);
          global.VF.UI.toast(r.type === 'core' ? '+1 部署核' : '+2 掩体建材');
        }
        return;
      }
    }
  };

  Building.prototype.getNearbyHint = function () {
    if (!global.VF.game || !global.VF.game.resources) return false;
    const pos = this.player.object.position;
    return global.VF.game.resources.some((r) => pos.distanceTo(r.mesh.position) < 2.5);
  };

  global.VF = global.VF || {};
  global.VF.TOWERS = BUILDABLES; // backward-compatible alias
  global.VF.BUILDABLES = BUILDABLES;
  global.VF.Building = Building;
})(window);
