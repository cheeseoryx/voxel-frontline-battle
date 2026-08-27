/**
 * tower-designer.js — Pre-match 3D defense tower builder
 * Design is saved and deployed in-match with hotkey 5.
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'vf_custom_tower_v2';
  const GRID_W = 13;
  const GRID_H = 14;
  const GRID_D = 13;

  const PALETTE = [
    { id: 'grass', block: 1, color: 0x3d6b2e, name: '草地', hits: 1, unit: 2 },
    { id: 'dirt', block: 2, color: 0x6b4a2e, name: '泥土', hits: 1, unit: 2 },
    { id: 'rubble', block: 9, color: 0x5a5048, name: '废墟', hits: 1, unit: 2 },
    { id: 'stone', block: 3, color: 0x6e7278, name: '石块', hits: 2, unit: 3 },
    { id: 'road', block: 7, color: 0x2a2c30, name: '路面', hits: 2, unit: 3 },
    { id: 'asphalt', block: 14, color: 0x222428, name: '沥青', hits: 2, unit: 3 },
    { id: 'wood', block: 12, color: 0x5a4030, name: '木板', hits: 1, unit: 3 },
    { id: 'plaster', block: 11, color: 0xd8d2c4, name: '灰泥', hits: 1, unit: 3 },
    { id: 'brick', block: 10, color: 0x8a3a2a, name: '砖块', hits: 2, unit: 4 },
    { id: 'rust', block: 5, color: 0x8b4518, name: '锈铁', hits: 2, unit: 4 },
    { id: 'glass', block: 13, color: 0x6a9aaa, name: '玻璃', hits: 1, unit: 4 },
    { id: 'concrete', block: 4, color: 0x9a968e, name: '混凝土', hits: 3, unit: 5 },
    { id: 'metal', block: 6, color: 0x4a5560, name: '金属', hits: 5, unit: 8 },
  ];

  function fixPalette() {
    const Econ = global.VF && global.VF.Economy;
    if (Econ && Econ.TOWER_BLOCKS) {
      Econ.TOWER_BLOCKS.forEach(function (b, i) {
        if (!PALETTE[i]) return;
        PALETTE[i].id = b.id;
        PALETTE[i].block = b.block;
        PALETTE[i].color = b.color;
        PALETTE[i].name = b.name;
        PALETTE[i].hits = b.hits;
        PALETTE[i].unit = b.unit;
      });
    }
    const B = global.VF && global.VF.BLOCK;
    if (!B) return;
    PALETTE.forEach(function (p) {
      if (p.id === 'wood' && B.ROOF != null) p.block = B.ROOF;
      else {
        const key = p.id.toUpperCase();
        if (B[key] != null) p.block = B[key];
      }
    });
  }

  function emptyDesign() {
    return {
      w: GRID_W,
      h: GRID_H,
      d: GRID_D,
      cells: {}, // "x,y,z" -> blockType
      order: [], // placement order — first coins of value stay free
      ziplines: [], // [{ax,ay,az, bx,by,bz}]
    };
  }

  function defaultDesign() {
    const d = emptyDesign();
    const B = (global.VF && global.VF.BLOCK) || {};
    const stone = B.STONE != null ? B.STONE : 3;
    const wood = B.ROOF != null ? B.ROOF : 12;
    // 3×3 bunker ≈ 99 币，落在 120 币免费额度内
    for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 1; z++) {
        d.cells[x + ',0,' + z] = stone;
      }
    }
    for (let y = 1; y <= 2; y++) {
      for (let x = -1; x <= 1; x++) {
        for (let z = -1; z <= 1; z++) {
          const edge = x === -1 || x === 1 || z === -1 || z === 1;
          if (!edge) continue;
          if (z === 1 && x === 0 && y === 1) continue;
          d.cells[x + ',' + y + ',' + z] = stone;
        }
      }
    }
    for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 1; z++) {
        d.cells[x + ',3,' + z] = wood;
      }
    }
    d.ziplines = [];
    d.order = Object.keys(d.cells);
    return d;
  }

  function loadDesign() {
    fixPalette();
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) raw = localStorage.getItem('vf_custom_tower_v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.cells) {
          if (!parsed.ziplines) parsed.ziplines = [];
          if (!Array.isArray(parsed.order)) parsed.order = Object.keys(parsed.cells);
          parsed.w = GRID_W;
          parsed.h = GRID_H;
          parsed.d = GRID_D;
          if (global.VF.Economy && global.VF.Economy.releaseDesignReservation) {
            global.VF.Economy.releaseDesignReservation(parsed);
          }
          return parsed;
        }
      }
    } catch (_) {}
    return defaultDesign();
  }

  function saveDesign(design) {
    if (!design) return;
    if (global.VF.Economy && global.VF.Economy.syncTowerTax) {
      global.VF.Economy.syncTowerTax(design);
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(design));
    } catch (_) {}
    global.VF.customTower = design;
  }

  function cellKey(x, y, z) {
    return x + ',' + y + ',' + z;
  }

  function parseKey(k) {
    const p = k.split(',');
    return { x: +p[0], y: +p[1], z: +p[2] };
  }

  function countCells(design) {
    return design && design.cells ? Object.keys(design.cells).length : 0;
  }

  function countZips(design) {
    return design && design.ziplines ? design.ziplines.length : 0;
  }

  function localToWorldCell(c, bx, by, bz, sin, cos) {
    const rx = Math.round(c.x * cos + c.z * sin);
    const rz = Math.round(c.x * -sin + c.z * cos);
    return { x: bx + rx, y: by + c.y, z: bz + rz };
  }

  /** Cell AABB center (matches editor voxel mesh at y+0.5). */
  function cellCenter(c) {
    return new THREE.Vector3(c.x, c.y + 0.5, c.z);
  }

  /**
   * Distance from cube center to exit a unit AABB along unit direction `d`.
   * Voxel mesh is ~0.98 wide; use 0.5 half-extent then add clear margin outside.
   */
  function _exitUnitCube(d) {
    const eps = 1e-6;
    let t = Infinity;
    if (Math.abs(d.x) > eps) t = Math.min(t, 0.5 / Math.abs(d.x));
    if (Math.abs(d.y) > eps) t = Math.min(t, 0.5 / Math.abs(d.y));
    if (Math.abs(d.z) > eps) t = Math.min(t, 0.5 / Math.abs(d.z));
    return t === Infinity ? 0.5 : t;
  }

  /**
   * Zipline mounts: on the center→center ray, just OUTSIDE each voxel
   * so the cable never starts/ends inside a solid (avoids merge/clip).
   */
  function zipEndpoints(a, b) {
    const ca = cellCenter(a);
    const cb = cellCenter(b);
    const delta = cb.clone().sub(ca);
    const dist = delta.length();
    if (dist < 1e-5) {
      return {
        start: new THREE.Vector3(ca.x, ca.y + 0.55, ca.z),
        end: new THREE.Vector3(cb.x, cb.y + 0.55, cb.z),
      };
    }
    const dir = delta.multiplyScalar(1 / dist);
    // Clearance past the voxel face + cable radius so thick cylinder won't dig in
    // Extra push so player can stand at the mount without clipping into solids
    const clear = 0.52;
    const ta = _exitUnitCube(dir) + clear;
    const tb = _exitUnitCube(dir) + clear;
    // If cells are adjacent, keep a tiny visible gap instead of collapsing
    const maxT = Math.max(0.08, dist * 0.48);
    const oa = Math.min(ta, maxT);
    const ob = Math.min(tb, maxT);
    // Ride height slightly above voxel top for standable grab
    const yLift = 0.55;
    return {
      start: new THREE.Vector3(ca.x + dir.x * oa, ca.y + yLift, ca.z + dir.z * oa),
      end: new THREE.Vector3(cb.x - dir.x * ob, cb.y + yLift, cb.z - dir.z * ob),
    };
  }

  function cellCablePoint(c) {
    return new THREE.Vector3(c.x, c.y + 1.15, c.z);
  }

  function addZipVisual(root, a, b, ghost) {
    const ends = zipEndpoints(a, b);
    const start = ends.start;
    const end = ends.end;
    let len = start.distanceTo(end);
    if (len < 0.15) {
      // Degenerate — skip cable, still show mounts
      len = 0.15;
    }
    const mid = start.clone().lerp(end, 0.5);
    const along = end.clone().sub(start).normalize();
    const opacity = ghost ? 0.5 : 1;
    const matCable = new THREE.MeshLambertMaterial({
      color: 0xe8c76a,
      transparent: !!ghost,
      opacity,
      depthWrite: !ghost,
    });
    const matPost = new THREE.MeshLambertMaterial({
      color: 0x4a5560,
      transparent: !!ghost,
      opacity,
      depthWrite: !ghost,
    });

    // Slightly shorter than endpoint span so caps don't poke into voxels
    const cableLen = Math.max(0.12, len - 0.06);
    const cable = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, cableLen, 6),
      matCable
    );
    cable.position.copy(mid);
    cable.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), along);
    cable.userData.zip = true;
    root.add(cable);

    // Mount cubes fully outside, offset away from the opposite end
    const postA = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), matPost);
    postA.position.copy(start).addScaledVector(along, -0.14);
    postA.userData.zip = true;
    root.add(postA);
    const postB = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), matPost);
    postB.position.copy(end).addScaledVector(along, 0.14);
    postB.userData.zip = true;
    root.add(postB);
  }

  /** Build Three.js group from design (ghost = translucent) */
  function buildMeshFromDesign(design, ghost) {
    const root = new THREE.Group();
    root.name = ghost ? 'CustomTowerGhost' : 'CustomTower';
    root.userData.kind = 'tower';
    root.userData.custom = true;
    if (!design || !design.cells) return root;

    const B = global.VF.BLOCK || {};
    const colors = {};
    PALETTE.forEach((p) => {
      colors[p.block] = p.color;
    });
    colors[B.STONE] = colors[B.STONE] || 0x6e7278;
    colors[B.CONCRETE] = colors[B.CONCRETE] || 0x9a968e;
    colors[B.BRICK] = colors[B.BRICK] || 0x8a3a2a;
    colors[B.METAL] = colors[B.METAL] || 0x4a5560;
    colors[B.ROOF] = colors[B.ROOF] || 0x5a4030;
    colors[B.GLASS] = colors[B.GLASS] || 0x6a9aaa;

    const matCache = {};
    const getMat = (block) => {
      if (!matCache[block]) {
        matCache[block] = new THREE.MeshLambertMaterial({
          color: colors[block] != null ? colors[block] : 0x888888,
          transparent: !!ghost,
          opacity: ghost ? 0.45 : 1,
          depthWrite: !ghost,
        });
      }
      return matCache[block];
    };

    const geo = new THREE.BoxGeometry(0.98, 0.98, 0.98);
    for (const k in design.cells) {
      const c = parseKey(k);
      const m = new THREE.Mesh(geo, getMat(design.cells[k]));
      m.position.set(c.x, c.y + 0.5, c.z);
      m.castShadow = !ghost;
      root.add(m);
    }
    if (design.ziplines) {
      for (let i = 0; i < design.ziplines.length; i++) {
        const z = design.ziplines[i];
        addZipVisual(
          root,
          { x: z.ax, y: z.ay, z: z.az },
          { x: z.bx, y: z.by, z: z.bz },
          ghost
        );
      }
    }
    root.userData.def = {
      id: 'custom',
      kind: 'tower',
      width: design.w,
      depth: design.d,
      height: design.h,
      cost: 1,
      costResource: 'cores',
    };
    return root;
  }

  /** Stamp design into voxel world at floor anchor (world y = bottom) */
  function stampDesign(world, design, pos, yaw, scene) {
    if (!design) return;
    if (!design.cells) design.cells = {};
    if (!design.ziplines) design.ziplines = [];

    const bx = Math.floor(pos.x);
    const by = Math.floor(pos.y);
    const bz = Math.floor(pos.z);
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const chunks = new Set();
    const game = global.VF.game;
    const extraHits =
      game &&
      game.player &&
      global.VF.Skills &&
      global.VF.Skills.getBuildDurabilityHits
        ? Math.max(0, global.VF.Skills.getBuildDurabilityHits(game.player) - 1)
        : 0;
    const typeHits = global.VF.BLOCK_HITS || {};

    for (const k in design.cells) {
      const c = parseKey(k);
      const wcell = localToWorldCell(c, bx, by, bz, sin, cos);
      if (world.get(wcell.x, wcell.y, wcell.z) === global.VF.BLOCK.AIR) {
        const t = design.cells[k];
        world.set(wcell.x, wcell.y, wcell.z, t);
        const base = typeHits[t] != null ? typeHits[t] : 1;
        const total = base > 0 ? base + extraHits : 0;
        if (total > 1 && world.setBlockDurability) {
          world.setBlockDurability(wcell.x, wcell.y, wcell.z, total);
        }
      }
      const cx = Math.floor(wcell.x / world.chunkSize);
      const cz = Math.floor(wcell.z / world.chunkSize);
      chunks.add(cx + ',' + cz);
    }

    chunks.forEach((key) => {
      const parts = key.split(',');
      const cx = Number(parts[0]);
      const cz = Number(parts[1]);
      if (cx >= 0 && cz >= 0 && cx < world.worldChunks && cz < world.worldChunks) {
        if (world._markChunkDirty) world._markChunkDirty(cx, cz);
        else world._rebuildChunk(cx, cz);
      }
    });

    // Deploy ziplines (visual + F-ride) using same transform as the ghost mesh
    if (design.ziplines.length) {
      world.ziplines = world.ziplines || [];
      const host = world.group || scene;
      if (!host) return;

      const zipRoot = new THREE.Group();
      zipRoot.name = 'CustomTowerZiplines';
      // Match ghost: continuous position + yaw (blocks use floored origin — zips follow visual)
      zipRoot.position.set(pos.x, pos.y, pos.z);
      zipRoot.rotation.y = yaw;
      host.add(zipRoot);
      zipRoot.updateMatrixWorld(true);

      const matCable = new THREE.MeshLambertMaterial({
        color: 0xffcc44,
        emissive: 0x664400,
        emissiveIntensity: 0.35,
      });
      const matPost = new THREE.MeshLambertMaterial({ color: 0x5a6570 });

      for (let i = 0; i < design.ziplines.length; i++) {
        const z = design.ziplines[i];
        const a = { x: z.ax, y: z.ay, z: z.az };
        const b = { x: z.bx, y: z.by, z: z.bz };
        const ends = zipEndpoints(a, b);
        const startLocal = ends.start;
        const endLocal = ends.end;
        const span = Math.max(0.2, startLocal.distanceTo(endLocal));
        const midLocal = startLocal.clone().lerp(endLocal, 0.5);
        const along = endLocal.clone().sub(startLocal).normalize();
        const cableLen = Math.max(0.15, span - 0.08);

        const cable = new THREE.Mesh(
          new THREE.CylinderGeometry(0.1, 0.1, cableLen, 8),
          matCable
        );
        cable.position.copy(midLocal);
        cable.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), along);
        cable.frustumCulled = false;
        cable.name = 'CustomZiplineCable';
        zipRoot.add(cable);

        const postA = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), matPost);
        postA.position.copy(startLocal).addScaledVector(along, -0.16);
        postA.frustumCulled = false;
        zipRoot.add(postA);
        const postB = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), matPost);
        postB.position.copy(endLocal).addScaledVector(along, 0.16);
        postB.frustumCulled = false;
        zipRoot.add(postB);

        const start = startLocal.clone().applyMatrix4(zipRoot.matrixWorld);
        const end = endLocal.clone().applyMatrix4(zipRoot.matrixWorld);
        const landA = new THREE.Vector3(a.x, a.y + 1.02, a.z).applyMatrix4(zipRoot.matrixWorld);
        const landB = new THREE.Vector3(b.x, b.y + 1.02, b.z).applyMatrix4(zipRoot.matrixWorld);
        const rideA = landA.clone();
        rideA.y += 1.15;
        const rideB = landB.clone();
        rideB.y += 1.15;
        const aLow = landA.y <= landB.y;
        world.ziplines.push({
          start: start,
          end: end,
          rideStart: aLow ? rideA : rideB,
          rideEnd: aLow ? rideB : rideA,
          landLow: aLow ? landA : landB,
          landHigh: aLow ? landB : landA,
          cable: cable,
          custom: true,
        });
      }
    }
  }

  /* ---------- Editor UI ---------- */

  function TowerDesigner() {
    this.open = false;
    this.design = loadDesign();
    this.selected = PALETTE[0];
    this.mode = 'block'; // 'block' | 'zip'
    this._zipPending = null;
    this._dragging = false;
    this._eraseHeld = false;
    this._eraseLastKey = '';
    this._eraseLastAt = 0;
    this._voxelsDirty = false;
    this._zipsDirty = false;
    this._orbit = { theta: 0.6, phi: 0.85, dist: 22 };
    this._raf = 0;
    global.VF.customTower = this.design;
  }

  TowerDesigner.prototype.mount = function () {
    fixPalette();
    this.els = {
      overlay: document.getElementById('tower-builder-overlay'),
      canvas: document.getElementById('tower-builder-canvas'),
      palette: document.getElementById('tower-palette'),
      paletteSection: document.getElementById('tower-palette-section'),
      count: document.getElementById('tower-block-count'),
      stock: document.getElementById('tower-stock'),
      zipHint: document.getElementById('tower-zip-hint'),
      modeBlock: document.getElementById('tower-mode-block'),
      modeZip: document.getElementById('tower-mode-zip'),
      saveBtn: document.getElementById('tower-save-btn'),
      clearBtn: document.getElementById('tower-clear-btn'),
      defaultBtn: document.getElementById('tower-default-btn'),
      backBtn: document.getElementById('tower-back-btn'),
    };
    this._buildPaletteUI();
    this._bind();
    this._syncModeUI();
  };

  TowerDesigner.prototype._buildPaletteUI = function () {
    const row = this.els.palette;
    if (!row) return;
    row.innerHTML = '';
    for (let i = 0; i < PALETTE.length; i++) {
      const p = PALETTE[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tower-pal' + (p === this.selected ? ' selected' : '');
      btn.dataset.id = p.id;
      btn.title = p.name;
      const hitTxt = p.hits <= 0 ? '打不碎' : p.hits + '刀';
      const priceTxt = p.unit != null ? p.unit + '币' : '';
      btn.innerHTML =
        '<span class="tower-pal-swatch" style="background:#' +
        p.color.toString(16).padStart(6, '0') +
        '"></span><span>' +
        p.name +
        '<small>' +
        (priceTxt ? priceTxt + ' · ' : '') +
        hitTxt +
        '</small></span>';
      btn.addEventListener('click', () => {
        this.selected = p;
        row.querySelectorAll('.tower-pal').forEach((el) => {
          el.classList.toggle('selected', el.dataset.id === p.id);
        });
        this._updateCount();
      });
      row.appendChild(btn);
    }
  };

  TowerDesigner.prototype._bind = function () {
    if (this._bound) return;
    this._bound = true;
    const self = this;

    if (this.els.saveBtn) {
      this.els.saveBtn.addEventListener('click', () => {
        const Econ = global.VF.Economy;
        if (Econ && Econ.commitTowerDesign) {
          const res = Econ.commitTowerDesign(self.design);
          if (!res.ok) {
            if (global.VF.UI && global.VF.UI.toast) {
              global.VF.UI.toast(res.reason || '余额不足');
            }
            self._updateCount();
            return;
          }
        }
        saveDesign(self.design);
        if (global.VF.UI && global.VF.UI.toast) {
          const cost =
            Econ && Econ.previewTowerCost ? Econ.previewTowerCost(self.design) : null;
          const bits = [];
          if (cost && cost.coinCost) bits.push(cost.coinCost + ' 前线币');
          if (cost && cost.cable) bits.push(cost.cable + ' 钢缆');
          global.VF.UI.toast(
            bits.length
              ? '防御塔已保存 · 进入对局时扣除 ' + bits.join(' · ')
              : '防御塔已保存 · 未超免费额度 · 进入对局不扣币'
          );
        }
        const done = self._onComplete;
        self._onComplete = null;
        self.close();
        if (typeof done === 'function') done(self.design);
      });
    }
    if (this.els.backBtn) {
      this.els.backBtn.addEventListener('click', () => {
        saveDesign(self.design);
        const back = self._onBack;
        self.close();
        if (typeof back === 'function') back();
      });
    }
    if (this.els.clearBtn) {
      this.els.clearBtn.addEventListener('click', () => {
        self.design = emptyDesign();
        self._zipPending = null;
        saveDesign(self.design);
        self._rebuildVoxels();
        self._rebuildZips();
        self._updateCount();
      });
    }
    if (this.els.defaultBtn) {
      this.els.defaultBtn.addEventListener('click', () => {
        self.design = defaultDesign();
        self._zipPending = null;
        saveDesign(self.design);
        self._rebuildVoxels();
        self._rebuildZips();
        self._updateCount();
      });
    }
    if (this.els.modeBlock) {
      this.els.modeBlock.addEventListener('click', () => {
        self.mode = 'block';
        self._zipPending = null;
        self._syncModeUI();
      });
    }
    if (this.els.modeZip) {
      this.els.modeZip.addEventListener('click', () => {
        self.mode = 'zip';
        self._zipPending = null;
        self._syncModeUI();
      });
    }

    const canvas = this.els.canvas;
    if (!canvas) return;

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Left drag = orbit · Left click = place · Right drag = erase (no hold-still spam)
    canvas.addEventListener('pointerdown', (e) => {
      if (!self.open) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      self._ptr = {
        x: e.clientX,
        y: e.clientY,
        button: e.button,
        moved: false,
      };
      if (e.button === 2) {
        self._dragging = 'erase';
        self._eraseHeld = true;
        self._eraseLastKey = '';
        // Single click erase once; further deletes only while dragging
        self._paintAt(e.clientX, e.clientY, true);
        self._flushDirty();
      } else if (e.button === 0 || e.button === 1) {
        self._dragging = 'orbit'; // start as orbit; click-without-drag places on up
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!self.open || !self._ptr) return;
      const dx = e.clientX - self._ptr.x;
      const dy = e.clientY - self._ptr.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) self._ptr.moved = true;

      if (self._dragging === 'orbit' && self._ptr.moved) {
        self._orbit.theta -= dx * 0.01;
        self._orbit.phi = Math.max(0.2, Math.min(1.45, self._orbit.phi + dy * 0.01));
        self._ptr.x = e.clientX;
        self._ptr.y = e.clientY;
      } else if (self._dragging === 'erase' && self._eraseHeld && e.buttons & 2) {
        // Only erase while the pointer actually moves (drag-paint)
        if (self._ptr.moved) {
          self._paintAt(e.clientX, e.clientY, true);
          self._flushDirty();
        }
        self._ptr.x = e.clientX;
        self._ptr.y = e.clientY;
      }
    });

    canvas.addEventListener('pointerup', (e) => {
      if (e.button === 2) {
        self._eraseHeld = false;
        self._eraseLastKey = '';
        self._flushDirty();
      }
      if (!self.open || !self._ptr) {
        self._dragging = false;
        self._ptr = null;
        return;
      }
      // Click (no drag) with left button = place
      if (
        self._ptr.button === 0 &&
        !self._ptr.moved &&
        self._dragging === 'orbit'
      ) {
        self._paintAt(e.clientX, e.clientY, false);
      }
      self._dragging = false;
      self._ptr = null;
    });

    canvas.addEventListener('pointercancel', () => {
      self._eraseHeld = false;
      self._dragging = false;
      self._ptr = null;
      self._flushDirty();
    });

    canvas.addEventListener('lostpointercapture', () => {
      if (self._eraseHeld) {
        self._eraseHeld = false;
        self._flushDirty();
      }
    });

    canvas.addEventListener('wheel', (e) => {
      if (!self.open) return;
      e.preventDefault();
      self._orbit.dist = Math.max(12, Math.min(40, self._orbit.dist + e.deltaY * 0.02));
    }, { passive: false });
  };

  TowerDesigner.prototype._syncModeUI = function () {
    if (this.els.modeBlock) {
      this.els.modeBlock.classList.toggle('selected', this.mode === 'block');
    }
    if (this.els.modeZip) {
      this.els.modeZip.classList.toggle('selected', this.mode === 'zip');
    }
    const palSec = this.els.paletteSection;
    if (palSec) {
      palSec.classList.toggle('is-zip-mode', this.mode === 'zip');
    }
    if (this.els.zipHint) {
      this.els.zipHint.textContent =
        this.mode === 'zip'
          ? this._zipPending
            ? '已选起点 · 再点终点方块完成滑索'
            : '滑索：点两块方块（需钢缆库存） · 对局部署时消耗'
          : '方块模式：单击放置 · 右键单击/拖动拆除';
    }
  };

  TowerDesigner.prototype._previewCost = function (design) {
    const Econ = global.VF && global.VF.Economy;
    if (Econ && Econ.previewTowerCost) return Econ.previewTowerCost(design || this.design);
    return {
      ok: true,
      paid: {},
      coinCost: 0,
      coins: 0,
      total: countCells(design || this.design),
      freeUsed: 0,
      freeCap: 120,
      stock: {},
      zips: 0,
      zipCap: 8,
    };
  };

  TowerDesigner.prototype._canCommitDesign = function (design) {
    return !!this._previewCost(design).ok;
  };

  TowerDesigner.prototype._updateCount = function () {
    const cost = this._previewCost(this.design);
    if (this.els.count) {
      this.els.count.textContent =
        '额度 ' +
        (cost.freeUsed || 0) +
        '/' +
        (cost.freeCap || 120) +
        '币 · 超出 ' +
        (cost.coinCost || 0) +
        ' · 方块 ' +
        (cost.total != null ? cost.total : countCells(this.design)) +
        ' · 滑索 ' +
        countZips(this.design) +
        '/' +
        (cost.zipCap || 8);
    }
    if (this.els.stock) {
      const sel = this.selected || PALETTE[0];
      const unitPrice = sel.unit != null ? sel.unit : 0;
      const paidCoinsSel =
        cost.paidCoins && cost.paidCoins[sel.id] ? cost.paidCoins[sel.id] : 0;
      const cableHave = cost.availCable != null ? cost.availCable : 0;
      const cableNeed = cost.cable || 0;
      const bal = cost.coins != null ? cost.coins : 0;
      this.els.stock.innerHTML =
        sel.name +
        ' ' +
        unitPrice +
        '币/格' +
        (paidCoinsSel ? ' · 超出扣 ' + paidCoinsSel + '币' : '') +
        ' · 余额 <b>' +
        bal +
        '</b>' +
        (cost.coinCost ? ' · 进局将扣 ' + cost.coinCost + '币' : '') +
        ' · 钢缆 <b>' +
        cableHave +
        '</b>' +
        (cableNeed ? ' · 本局将扣 ' + cableNeed : '') +
        (cost.ok ? '' : ' · <em>' + (cost.reason || '余额不足') + '</em>');
      this.els.stock.classList.toggle('is-over', !cost.ok);
    }
    if (this.els.saveBtn) {
      const zipBlocked = (cost.zips || 0) > (cost.zipCap || 8);
      this.els.saveBtn.disabled = zipBlocked;
    }
    this._syncModeUI();
  };

  /**
   * @param {function} onComplete — after 「完成建造」
   * @param {function} onBack — after 「返回角色」
   */
  TowerDesigner.prototype.openEditor = function (onComplete, onBack) {
    if (!this.els) this.mount();
    this._onComplete = onComplete;
    this._onBack = onBack;
    this.open = true;
    this.mode = 'block';
    this._zipPending = null;
    this.design = loadDesign();
    if (!this.design.ziplines) this.design.ziplines = [];
    global.VF.customTower = this.design;
    if (this.els.overlay) this.els.overlay.classList.remove('hidden');
    this._buildPaletteUI();
    this._initScene();
    this._updateCount();
    this._syncModeUI();
    this._loop();
  };

  TowerDesigner.prototype.close = function () {
    if (this.design) saveDesign(this.design);
    this.open = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._disposeScene();
    if (this.els && this.els.overlay) this.els.overlay.classList.add('hidden');
  };

  TowerDesigner.prototype._initScene = function () {
    this._disposeScene();
    const canvas = this.els.canvas;
    if (!canvas || !global.THREE) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101418);

    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 120);
    const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    scene.add(new THREE.AmbientLight(0x8899aa, 0.85));
    const sun = new THREE.DirectionalLight(0xfff0dd, 1.1);
    sun.position.set(8, 14, 6);
    scene.add(sun);

    // Ground grid plane
    const hw = Math.floor(GRID_W / 2);
    const hd = Math.floor(GRID_D / 2);
    const grid = new THREE.GridHelper(GRID_W, GRID_W, 0x445566, 0x2a3340);
    grid.position.y = 0.01;
    scene.add(grid);

    // Footprint outline
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(GRID_W, 0.02, GRID_D)),
      new THREE.LineBasicMaterial({ color: 0xc4a574 })
    );
    edge.position.y = 0.02;
    scene.add(edge);

    const voxelRoot = new THREE.Group();
    scene.add(voxelRoot);
    const zipRoot = new THREE.Group();
    scene.add(zipRoot);

    // Invisible pick targets: every cell in the volume (for placing on air)
    const pickRoot = new THREE.Group();
    pickRoot.name = 'PickVolume';
    const pickGeo = new THREE.BoxGeometry(1, 1, 1);
    const pickMat = new THREE.MeshBasicMaterial({
      visible: false,
      side: THREE.DoubleSide,
    });
    for (let y = 0; y < GRID_H; y++) {
      for (let x = -hw; x <= hw; x++) {
        for (let z = -hd; z <= hd; z++) {
          const m = new THREE.Mesh(pickGeo, pickMat);
          m.position.set(x, y + 0.5, z);
          m.userData.cell = { x, y, z };
          pickRoot.add(m);
        }
      }
    }
    scene.add(pickRoot);

    this._scene = scene;
    this._camera = camera;
    this._renderer = renderer;
    this._voxelRoot = voxelRoot;
    this._zipRoot = zipRoot;
    this._pickRoot = pickRoot;
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._rebuildVoxels();
    this._rebuildZips();
  };

  TowerDesigner.prototype._disposeScene = function () {
    if (this._renderer) {
      // keep canvas; just stop rendering
    }
    this._scene = null;
    this._camera = null;
    this._voxelRoot = null;
    this._zipRoot = null;
    this._pickRoot = null;
  };

  TowerDesigner.prototype._rebuildVoxels = function () {
    if (!this._voxelRoot) return;
    while (this._voxelRoot.children.length) {
      const c = this._voxelRoot.children[0];
      this._voxelRoot.remove(c);
      // Shared geometry — do NOT dispose
      if (c.material && c.material.dispose && !c.userData.sharedMat) {
        // materials are cached/shared too; skip dispose
      }
    }
    if (!this._voxelGeo) {
      this._voxelGeo = new THREE.BoxGeometry(0.96, 0.96, 0.96);
    }
    if (!this._matCache) this._matCache = {};
    const over = !this._previewCost(this.design).ok;
    if (over && !this._matCache._over) {
      this._matCache._over = new THREE.MeshLambertMaterial({ color: 0xc04040 });
    }
    for (const k in this.design.cells) {
      const c = parseKey(k);
      const block = this.design.cells[k];
      const pal = PALETTE.find((p) => p.block === block) || PALETTE[0];
      if (!this._matCache[block]) {
        this._matCache[block] = new THREE.MeshLambertMaterial({ color: pal.color });
      }
      const mat = over ? this._matCache._over : this._matCache[block];
      const m = new THREE.Mesh(this._voxelGeo, mat);
      m.position.set(c.x, c.y + 0.5, c.z);
      m.userData.cell = { x: c.x, y: c.y, z: c.z };
      m.userData.solid = true;
      this._voxelRoot.add(m);
    }
  };

  TowerDesigner.prototype._rebuildZips = function () {
    if (!this._zipRoot) return;
    while (this._zipRoot.children.length) {
      this._zipRoot.remove(this._zipRoot.children[0]);
    }
    if (!this.design.ziplines) this.design.ziplines = [];
    for (let i = 0; i < this.design.ziplines.length; i++) {
      const z = this.design.ziplines[i];
      const g = new THREE.Group();
      g.userData.zipIndex = i;
      addZipVisual(
        g,
        { x: z.ax, y: z.ay, z: z.az },
        { x: z.bx, y: z.by, z: z.bz },
        false
      );
      // Mark children for hit-test
      g.traverse((c) => {
        if (c.isMesh) c.userData.zipIndex = i;
      });
      this._zipRoot.add(g);
    }
    // Pending start marker
    if (this._zipPending) {
      const p = this._zipPending;
      const marker = new THREE.Mesh(
        new THREE.BoxGeometry(1.05, 1.05, 1.05),
        new THREE.MeshBasicMaterial({
          color: 0xe8c76a,
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
        })
      );
      marker.position.set(p.x, p.y + 0.5, p.z);
      marker.userData.pending = true;
      this._zipRoot.add(marker);
    }
  };

  TowerDesigner.prototype._hitSolidCell = function (clientX, clientY) {
    if (!this._camera || !this._voxelRoot) return null;
    const rect = this.els.canvas.getBoundingClientRect();
    this._pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._pointer, this._camera);
    const hits = this._raycaster.intersectObjects(this._voxelRoot.children, false);
    if (!hits.length) return null;
    return hits[0].object.userData.cell || null;
  };

  TowerDesigner.prototype._paintAt = function (clientX, clientY, erase) {
    if (!this._camera || !this._renderer || !this.els.canvas) return;
    const rect = this.els.canvas.getBoundingClientRect();
    this._pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._pointer, this._camera);

    // Zipline mode
    if (this.mode === 'zip') {
      if (erase) {
        const zipHits = this._raycaster.intersectObjects(this._zipRoot.children, true);
        for (let i = 0; i < zipHits.length; i++) {
          const idx = zipHits[i].object.userData.zipIndex;
          if (idx != null && this.design.ziplines[idx]) {
            this.design.ziplines.splice(idx, 1);
            this._zipPending = null;
            this._rebuildZips();
            this._rebuildVoxels();
            this._updateCount();
            return;
          }
        }
        return;
      }
      const cell = this._hitSolidCell(clientX, clientY);
      if (!cell) return;
      if (!this._zipPending) {
        this._zipPending = { x: cell.x, y: cell.y, z: cell.z };
        this._rebuildZips();
        this._syncModeUI();
        return;
      }
      const a = this._zipPending;
      if (a.x === cell.x && a.y === cell.y && a.z === cell.z) return;
      if (!this.design.ziplines) this.design.ziplines = [];
      const nextZip = {
        ax: a.x,
        ay: a.y,
        az: a.z,
        bx: cell.x,
        by: cell.y,
        bz: cell.z,
      };
      const trialZip = {
        cells: this.design.cells,
        order: this.design.order,
        ziplines: this.design.ziplines.concat([nextZip]),
      };
      const zipCost = this._previewCost(trialZip);
      if (!zipCost.ok) {
        if (global.VF.UI && global.VF.UI.toast) {
          global.VF.UI.toast(zipCost.reason || '钢缆不足，请先购买滑索');
        }
        this._zipPending = null;
        this._rebuildZips();
        this._updateCount();
        return;
      }
      this.design.ziplines.push(nextZip);
      this._zipPending = null;
      saveDesign(this.design);
      this._rebuildZips();
      this._updateCount();
      return;
    }

    // Block mode
    const solids = this._voxelRoot.children;
    let hits = this._raycaster.intersectObjects(solids, false);

    if (erase) {
      if (hits.length) {
        const cell = hits[0].object.userData.cell;
        const key = cellKey(cell.x, cell.y, cell.z);
        const now = performance.now();
        // Skip re-erasing the same cell while held (still allow drag across cells)
        if (key === this._eraseLastKey && now - this._eraseLastAt < 80) return;
        if (!this.design.cells[key]) return;
        delete this.design.cells[key];
        if (this.design.order) {
          this.design.order = this.design.order.filter(function (k) {
            return k !== key;
          });
        }
        this._eraseLastKey = key;
        this._eraseLastAt = now;
        // Drop ziplines attached to removed cell
        if (this.design.ziplines) {
          this.design.ziplines = this.design.ziplines.filter((z) => {
            const onA = z.ax === cell.x && z.ay === cell.y && z.az === cell.z;
            const onB = z.bx === cell.x && z.by === cell.y && z.bz === cell.z;
            return !onA && !onB;
          });
        }
        this._voxelsDirty = true;
        this._zipsDirty = true;
        saveDesign(this.design);
        this._updateCount();
      }
      return;
    }

    if (hits.length) {
      const hit = hits[0];
      const cell = hit.object.userData.cell;
      const n = hit.face.normal.clone();
      const nx = cell.x + Math.round(n.x);
      const ny = cell.y + Math.round(n.y);
      const nz = cell.z + Math.round(n.z);
      if (this._inBounds(nx, ny, nz)) {
        this._trySetCell(nx, ny, nz, this.selected.block);
      }
      return;
    }

    hits = this._raycaster.intersectObjects(this._pickRoot.children, false);
    if (hits.length) {
      const cell = hits[0].object.userData.cell;
      if (this._inBounds(cell.x, cell.y, cell.z)) {
        this._trySetCell(cell.x, cell.y, cell.z, this.selected.block);
      }
    }
  };

  TowerDesigner.prototype._trySetCell = function (x, y, z, block) {
    const key = cellKey(x, y, z);
    if (this.design.cells[key] === block) return;
    const nextCells = Object.assign({}, this.design.cells);
    nextCells[key] = block;
    const nextOrder = (this.design.order || Object.keys(this.design.cells)).slice();
    if (nextOrder.indexOf(key) < 0) nextOrder.push(key);
    const trial = {
      cells: nextCells,
      order: nextOrder,
      ziplines: this.design.ziplines,
    };
    const cost = this._previewCost(trial);
    if (!cost.ok) {
      if (global.VF.UI && global.VF.UI.toast) {
        global.VF.UI.toast(cost.reason || '余额不足');
      }
      return;
    }
    this.design.cells[key] = block;
    this.design.order = nextOrder;
    saveDesign(this.design);
    this._rebuildVoxels();
    this._updateCount();
  };

  TowerDesigner.prototype._flushDirty = function () {
    if (this._voxelsDirty) {
      this._voxelsDirty = false;
      this._rebuildVoxels();
    }
    if (this._zipsDirty) {
      this._zipsDirty = false;
      this._rebuildZips();
    }
  };

  TowerDesigner.prototype._inBounds = function (x, y, z) {
    const hw = Math.floor(GRID_W / 2);
    const hd = Math.floor(GRID_D / 2);
    return x >= -hw && x <= hw && z >= -hd && z <= hd && y >= 0 && y < GRID_H;
  };

  TowerDesigner.prototype._loop = function () {
    if (!this.open) return;
    const self = this;
    const tick = () => {
      if (!self.open) return;
      if (self._voxelsDirty || self._zipsDirty) {
        self._flushDirty();
      }
      const canvas = self.els.canvas;
      const cam = self._camera;
      const ren = self._renderer;
      if (canvas && cam && ren && self._scene) {
        const w = canvas.clientWidth || 640;
        const h = canvas.clientHeight || 480;
        if (canvas.width !== w || canvas.height !== h) {
          ren.setSize(w, h, false);
          cam.aspect = w / Math.max(1, h);
          cam.updateProjectionMatrix();
        }
        const o = self._orbit;
        const cx = Math.sin(o.theta) * Math.sin(o.phi) * o.dist;
        const cy = Math.cos(o.phi) * o.dist + 4;
        const cz = Math.cos(o.theta) * Math.sin(o.phi) * o.dist;
        cam.position.set(cx, cy, cz);
        cam.lookAt(0, 4, 0);
        ren.render(self._scene, cam);
      }
      self._raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(tick);
  };

  // Init singleton early so building can read design
  const designer = new TowerDesigner();
  global.VF = global.VF || {};
  global.VF.TowerDesigner = designer;
  global.VF.loadCustomTower = loadDesign;
  global.VF.buildTowerMeshFromDesign = buildMeshFromDesign;
  global.VF.stampCustomTower = stampDesign;
  global.VF.customTower = loadDesign();
  global.VF.TOWER_PALETTE = PALETTE;
})(window);
