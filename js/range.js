/**
 * range.js — Shooting range using real Player + Weapons (match gun feel).
 */
(function (global) {
  'use strict';

  const TARGET_HP = 80;
  const TARGET_RESPAWN = 2.5;
  const CHALLENGE_TIME = 60;
  const MK_WINDOW_MS = 3500;
  const FIRING_Z = 12;
  const LANE_X = 48;
  const TARGET_DISTS = [5, 10, 20, 35, 50];
  const HALL = { x0: 38, x1: 58, z0: 6, z1: 70, ceil: 7 };
  const RANGE_ENABLED = false;

  /** Flat arena voxel stub for Player collision + bullet DDA */
  function RangeWorld() {
    this.worldSize = 96;
    this.height = 32;
    this.props = [];
    this.ziplines = [];
    this._hitPool = [];
    this._block = global.VF.BLOCK || { AIR: 0, WATER: 8, CONCRETE: 4, STONE: 3, DIRT: 2, BEDROCK: 15 };
  }

  RangeWorld.prototype.get = function (x, y, z) {
    const B = this._block;
    const x0 = HALL.x0;
    const x1 = HALL.x1;
    const z0 = HALL.z0;
    const z1 = HALL.z1;
    const ceil = HALL.ceil;
    if (y < 0) return B.BEDROCK;
    if (x <= x0 || x >= x1 - 1 || z <= z0 || z >= z1 - 1) {
      if (y <= ceil) return B.STONE;
      return B.AIR;
    }
    if (y === 0) return B.CONCRETE;
    if (y >= ceil) return B.STONE;
    return B.AIR;
  };

  RangeWorld.prototype._isSolid = function (x, y, z) {
    const B = this._block;
    const t = this.get(x, y, z);
    return t !== B.AIR && t !== B.WATER;
  };

  RangeWorld.prototype.getWalkHeight = function () {
    return 1;
  };

  RangeWorld.prototype.getSpawnPosition = function () {
    return new THREE.Vector3(LANE_X, 1.05, FIRING_Z);
  };

  RangeWorld.prototype.collideAABB = function (box) {
    if (!this._hitPool) this._hitPool = [];
    const pool = this._hitPool;
    let n = 0;
    const minX = Math.floor(box.min.x);
    const maxX = Math.floor(box.max.x);
    const minY = Math.floor(box.min.y);
    const maxY = Math.floor(box.max.y);
    const minZ = Math.floor(box.min.z);
    const maxZ = Math.floor(box.max.z);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          if (!this._isSolid(x, y, z)) continue;
          let h = pool[n];
          if (!h) {
            h = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
            pool[n] = h;
          }
          h.min.set(x, y, z);
          h.max.set(x + 1, y + 1, z + 1);
          n++;
        }
      }
    }
    pool.length = n;
    return pool;
  };

  RangeWorld.prototype.overlapsSolid = function (box) {
    return this.collideAABB(box).length > 0;
  };

  RangeWorld.prototype.raycastDoors = function () {
    return null;
  };

  RangeWorld.prototype.breakBlock = function () {
    return false;
  };

  RangeWorld.prototype.destroyProp = function () {};

  function Range() {
    this.active = false;
    this.renderer = null;
    this.scene = null;
    this.world = null;
    this.targets = [];
    this._bound = false;
    this._handlers = {};
    this._debris = [];
    this._ray = new THREE.Ray();
    this._hitPt = new THREE.Vector3();
    this._box = new THREE.Box3();
    this._score = 0;
    this._hits = 0;
    this._breaks = 0;
    this._mode = 'free'; // 'free' | 'challenge'
    this._challengeLeft = 0;
    this._challengeDone = false;
    this._mkCount = 0;
    this._mkAt = 0;
    this._saved = null;
  }

  Object.defineProperty(Range.prototype, 'isOpen', {
    get: function () {
      return !!this.active;
    },
  });

  Range.prototype.init = function (renderer) {
    this.renderer = renderer;
    this.world = new RangeWorld();
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xc6c2ba);
    this.scene.fog = new THREE.Fog(0xc6c2ba, 95, 180);

    const ambient = new THREE.AmbientLight(0xeeeae2, 1.08);
    this.scene.add(ambient);
    const hemi = new THREE.HemisphereLight(0xfff8ee, 0x9a968e, 0.7);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xfff6e4, 0.62);
    key.position.set(8, 28, 6);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xe0e4ea, 0.28);
    fill.position.set(-10, 12, -8);
    this.scene.add(fill);

    this._buildArena();
    this._buildTargets();
    this._bind();
  };

  Range.prototype.setHandlers = function (h) {
    this._handlers = h || {};
  };

  Range.prototype._mat = function (color, opts) {
    opts = opts || {};
    if (opts.basic) {
      return new THREE.MeshBasicMaterial({
        color: color,
        transparent: !!opts.transparent,
        opacity: opts.opacity != null ? opts.opacity : 1,
        side: opts.side || THREE.FrontSide,
      });
    }
    return new THREE.MeshLambertMaterial({
      color: color,
      emissive: opts.emissive != null ? opts.emissive : 0x000000,
    });
  };

  Range.prototype._boxMesh = function (w, h, d, color, x, y, z, opts) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this._mat(color, opts));
    m.position.set(x, y, z);
    this.scene.add(m);
    return m;
  };

  Range.prototype._labelPlane = function (text, x, y, z, lookX, lookY, lookZ) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 256, 128);
    ctx.fillStyle = '#e8c84a';
    ctx.font = 'bold 78px Segoe UI, Microsoft YaHei, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(text), 128, 64);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.75), mat);
    mesh.position.set(x, y, z);
    mesh.lookAt(lookX, lookY, lookZ);
    this.scene.add(mesh);
    return mesh;
  };

  Range.prototype._buildArena = function () {
    const x0 = HALL.x0;
    const x1 = HALL.x1;
    const z0 = HALL.z0;
    const z1 = HALL.z1;
    const ceil = HALL.ceil;
    const cx = (x0 + x1) * 0.5;
    const cz = (z0 + z1) * 0.5;
    const spanX = x1 - x0;
    const spanZ = z1 - z0;

    const bounce = { emissive: 0x2c2a26 };
    this._boxMesh(spanX, 0.2, spanZ, 0xb2aca2, cx, 0.9, cz, bounce);
    this._boxMesh(0.5, ceil, spanZ, 0xb8b6b0, x0 + 0.25, ceil * 0.5, cz, bounce);
    this._boxMesh(0.5, ceil, spanZ, 0xb8b6b0, x1 - 0.25, ceil * 0.5, cz, bounce);
    this._boxMesh(spanX, ceil, 0.5, 0xb0aea8, cx, ceil * 0.5, z0 + 0.25, bounce);
    this._boxMesh(spanX, ceil, 0.8, 0x8a8278, cx, ceil * 0.5, z1 - 0.4, bounce);
    this._boxMesh(spanX, 0.35, spanZ, 0xc4c2bc, cx, ceil + 0.18, cz, bounce);

    for (let i = 0; i < 8; i++) {
      const z = 10 + i * 7.2;
      this._boxMesh(spanX - 2.4, 0.12, 0.5, 0x6a6e74, cx, ceil - 0.2, z);
      const lamp = this._boxMesh(2.2, 0.1, 0.55, 0xfff8e8, cx, ceil - 0.42, z, {
        basic: true,
      });
      lamp.material.color.setHex(0xfff8e8);
      const light = new THREE.PointLight(0xfff4dc, 2.4, 24, 1.2);
      light.position.set(cx, ceil - 0.85, z);
      this.scene.add(light);
    }

    this._boxMesh(3.4, 0.12, 0.55, 0x6b4a28, LANE_X, 1.08, FIRING_Z + 1.35);
    this._boxMesh(0.12, 2.4, 0.12, 0x2c3034, LANE_X - 1.7, 2.2, FIRING_Z + 1.15);
    this._boxMesh(0.12, 2.4, 0.12, 0x2c3034, LANE_X + 1.7, 2.2, FIRING_Z + 1.15);
    this._boxMesh(3.6, 0.1, 0.1, 0x2c3034, LANE_X, 3.42, FIRING_Z + 1.15);
    this._labelPlane('01', LANE_X - 2.4, 2.45, FIRING_Z + 1.2, LANE_X, 2.45, FIRING_Z + 1.2);

    const offsets = [-1.4, -0.7, 0, 0.7, 1.4];
    for (let i = 0; i < TARGET_DISTS.length; i++) {
      const meters = TARGET_DISTS[i];
      const z = FIRING_Z + meters;
      this._boxMesh(spanX - 1.2, 0.04, 0.12, 0xd4b44a, cx, 1.03, z);
      this._labelPlane(
        String(meters),
        x0 + 0.55,
        1.85,
        z,
        x0 + 2.4,
        1.85,
        z
      );
      this._boxMesh(0.08, 2.2, 0.08, 0x3a3228, LANE_X + offsets[i], 1.1, z + 0.18);
    }
  };

  Range.prototype._makeTargetMesh = function () {
    const g = new THREE.Group();
    const whiteMat = function () {
      return new THREE.MeshLambertMaterial({ color: 0xf3efe4 });
    };
    const dark = this._mat(0x3a3228);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.05, 0.12), dark);
    post.position.y = 0.52;
    g.add(post);
    const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.72, 0.14), whiteMat());
    leftLeg.position.set(-0.12, 0.38, 0);
    leftLeg.name = 'hitbody';
    g.add(leftLeg);
    const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.72, 0.14), whiteMat());
    rightLeg.position.set(0.12, 0.38, 0);
    rightLeg.name = 'hitbody';
    g.add(rightLeg);
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.74, 0.16), whiteMat());
    torso.position.set(0, 1.12, 0);
    torso.name = 'hitbody';
    g.add(torso);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.3, 0.22), whiteMat());
    head.position.set(0, 1.64, 0);
    head.name = 'hitbody';
    g.add(head);
    return g;
  };

  Range.prototype._buildTargets = function () {
    this.targets = [];
    const offsets = [-1.4, -0.7, 0, 0.7, 1.4];
    for (let i = 0; i < TARGET_DISTS.length; i++) {
      const meters = TARGET_DISTS[i];
      const x = LANE_X + offsets[i];
      const z = FIRING_Z + meters;
      const mesh = this._makeTargetMesh();
      mesh.position.set(x, 1, z);
      this.scene.add(mesh);
      this.targets.push({
        mesh: mesh,
        object: mesh,
        kind: 'fixed',
        meters: meters,
        hp: TARGET_HP,
        maxHp: TARGET_HP,
        alive: true,
        dead: false,
        hittable: true,
        respawn: 0,
        baseColor: 0xf3efe4,
        homeX: x,
        homeZ: z,
        homeY: 1,
        raised: 1,
        _flashAt: 0,
      });
    }
  };

  Range.prototype._bind = function () {
    if (this._bound) return;
    this._bound = true;
    const self = this;

    document.addEventListener('keydown', function (e) {
      if (!self.active) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        self.close();
        return;
      }
      if (e.code === 'KeyT') {
        e.preventDefault();
        self._toggleMode();
      }
    });

    const back = document.getElementById('range-back-btn');
    if (back) {
      back.addEventListener('click', function (e) {
        e.preventDefault();
        self.close();
      });
    }
    const modeBtn = document.getElementById('range-mode-btn');
    if (modeBtn) {
      modeBtn.addEventListener('click', function (e) {
        e.preventDefault();
        self._toggleMode();
      });
    }
    const resetBtn = document.getElementById('range-reset-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', function (e) {
        e.preventDefault();
        self._resetScore();
      });
    }
  };

  Range.prototype._player = function () {
    return global.VF.game && global.VF.game.player;
  };

  Range.prototype._weapons = function () {
    return global.VF.game && global.VF.game.weapons;
  };

  Range.prototype._refillAmmo = function () {
    const w = this._weapons();
    if (!w || !w.state) return;
    const ids = Object.keys(w.state);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const def = global.VF.WEAPONS && global.VF.WEAPONS[id];
      if (!w.state[id] || !def) continue;
      w.state[id].mag = def.magSize;
      w.state[id].reserve = 999;
    }
    if (global.VF.UI && w.getAmmo) {
      const a = w.getAmmo();
      global.VF.UI.updateAmmo(a.mag, a.reserve);
    }
  };

  Range.prototype._syncHud = function () {
    const best = this._loadBest();
    const scoreEl = document.getElementById('range-score');
    if (scoreEl) {
      let text = '分数 ' + this._score + ' · 命中 ' + this._hits + ' · 击破 ' + this._breaks;
      if (this._mode === 'challenge') {
        if (this._challengeDone) text += ' · 结束';
        else text += ' · 剩余 ' + Math.ceil(this._challengeLeft) + 's';
      }
      if (best > 0) text += ' · 最佳 ' + best;
      scoreEl.textContent = text;
    }
    const modeEl = document.getElementById('range-mode-label');
    if (modeEl) {
      modeEl.textContent = this._mode === 'challenge' ? '限时挑战' : '自由练习';
    }
    const w = this._weapons();
    const label = document.getElementById('range-weapon-label');
    if (label && w) {
      const id = w.current;
      label.textContent =
        (global.VF.WEAPONS &&
          global.VF.WEAPONS[id] &&
          (global.VF.WEAPONS[id].nameZh || global.VF.WEAPONS[id].model || global.VF.WEAPONS[id].name)) ||
        (id === 'usp' ? 'USP' : 'AK-74');
    }
  };

  Range.prototype._loadBest = function () {
    try {
      const v = parseInt(localStorage.getItem('vf_range_best') || '0', 10);
      return isNaN(v) ? 0 : v;
    } catch (_) {
      return 0;
    }
  };

  Range.prototype._saveBestIfNeeded = function () {
    if (this._mode !== 'challenge') return;
    const best = this._loadBest();
    if (this._score > best) {
      try {
        localStorage.setItem('vf_range_best', String(this._score));
      } catch (_) {}
      if (global.VF.UI && global.VF.UI.toast) {
        global.VF.UI.toast('新纪录 ' + this._score + '！');
      }
    }
  };

  Range.prototype._resetScore = function () {
    this._score = 0;
    this._hits = 0;
    this._breaks = 0;
    this._mkCount = 0;
    this._syncHud();
    if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast('分数已重置');
  };

  Range.prototype._toggleMode = function () {
    if (this._mode === 'free') {
      this._mode = 'challenge';
      this._challengeLeft = CHALLENGE_TIME;
      this._challengeDone = false;
      this._score = 0;
      this._hits = 0;
      this._breaks = 0;
      this._resetTargets();
      this._refillAmmo();
      if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast('限时挑战 60 秒');
    } else {
      this._mode = 'free';
      this._challengeDone = false;
      if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast('自由练习');
    }
    this._syncHud();
  };

  Range.prototype._resetTargets = function () {
    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i];
      t.hp = t.maxHp;
      t.alive = true;
      t.dead = false;
      t.hittable = true;
      t.respawn = 0;
      t.raised = 1;
      t.mesh.visible = true;
      t.mesh.position.set(t.homeX, t.homeY, t.homeZ);
      this._tintTarget(t, t.baseColor);
    }
  };

  Range.prototype.open = function () {
    if (!RANGE_ENABLED) return;
    if (!this.scene || !global.VF.game) return;
    const player = this._player();
    const weapons = this._weapons();
    if (!player || !weapons) return;

    this._saved = {
      world: player.world,
      wScene: weapons.scene,
      wWorld: weapons.world,
      px: player.object.position.x,
      py: player.object.position.y,
      pz: player.object.position.z,
      yaw: player.yaw,
      pitch: player.pitch,
      mode: weapons.mode,
      dead: player.dead,
      health: player.health,
    };

    player.world = this.world;
    weapons.world = this.world;
    weapons.scene = this.scene;
    weapons.mode = 'weapon';
    weapons.firing = false;
    weapons.reloading = false;
    if (player.setHeldMode) player.setHeldMode('weapon');
    player.dead = false;
    player.alive = true;
    player.health = player.maxHealth || 100;
    player.aiming = false;
    player._adsBlend = 0;
    player.velocity.set(0, 0, 0);

    const spawn = this.world.getSpawnPosition();
    player.object.position.copy(spawn);
    // yaw=0 faces -Z; targets are at higher Z → face +Z
    player.yaw = Math.PI;
    player.pitch = 0;
    player.onGround = true;

    const preferred =
      (global.VF.game && global.VF.game.preferredWeaponId) ||
      (global.VF.DEFAULT_PRIMARY || 'ak74');
    weapons.equip(preferred);
    this._refillAmmo();

    this._score = 0;
    this._hits = 0;
    this._breaks = 0;
    this._mode = 'free';
    this._challengeDone = false;
    this._mkCount = 0;
    this._resetTargets();

    this.active = true;

    // Viewmodel lives under the camera — the camera must sit in the rendered scene
    if (global.VF.game.camera) this.scene.add(global.VF.game.camera);

    if (global.VF.UI) {
      if (global.VF.UI.showHud) global.VF.UI.showHud();
      // Hide match-only chrome that clutter training
      if (global.VF.UI.els) {
        if (global.VF.UI.els.skillHud) global.VF.UI.els.skillHud.classList.add('hidden');
        if (global.VF.UI.els.dashHud) global.VF.UI.els.dashHud.classList.add('hidden');
        const mm = document.getElementById('minimap-wrap') || document.getElementById('minimap');
        if (mm) mm.classList.add('hidden');
      }
      const missionRow = document.getElementById('mission-row');
      if (missionRow) missionRow.classList.add('hidden');
      const waveInfo = document.getElementById('wave-info');
      if (waveInfo) waveInfo.classList.add('hidden');
    }

    const overlay = document.getElementById('range-overlay');
    if (overlay) overlay.classList.remove('hidden');
    this._syncHud();
    this._hintShown = null;
    const hint = document.getElementById('range-lock-hint');
    if (hint) hint.classList.remove('hidden');

    this._requestLock(6);
  };

  /**
   * Browsers reject a re-lock issued right after the hub released it, so retry
   * a few times and fall back to the click hint.
   */
  Range.prototype._requestLock = function (tries) {
    if (!this.active) return;
    const canvas =
      global.VF.game && global.VF.game.renderer && global.VF.game.renderer.domElement;
    if (!canvas) return;
    if (document.pointerLockElement === canvas) return;
    try {
      const p = canvas.requestPointerLock();
      if (p && p.catch) p.catch(function () {});
    } catch (_) {}
    const left = tries != null ? tries : 0;
    if (left <= 0) return;
    const self = this;
    setTimeout(function () {
      self._requestLock(left - 1);
    }, 240);
  };

  Range.prototype.close = function (silent) {
    const wasActive = this.active;
    this.active = false;

    const player = this._player();
    const weapons = this._weapons();
    if (weapons) {
      weapons.firing = false;
      // Clear FX that live in range scene
      for (let i = weapons.tracers.length - 1; i >= 0; i--) {
        const tr = weapons.tracers[i];
        if (tr.mesh && tr.mesh.parent) tr.mesh.parent.remove(tr.mesh);
      }
      weapons.tracers.length = 0;
      for (let i = weapons.impacts.length - 1; i >= 0; i--) {
        const im = weapons.impacts[i];
        if (im.mesh && im.mesh.parent) im.mesh.parent.remove(im.mesh);
      }
      weapons.impacts.length = 0;
    }

    if (player && this._saved) {
      player.world = this._saved.world;
      player.object.position.set(this._saved.px, this._saved.py, this._saved.pz);
      player.yaw = this._saved.yaw;
      player.pitch = this._saved.pitch;
      player.aiming = false;
      player.dead = this._saved.dead;
      player.health = this._saved.health;
      player.velocity.set(0, 0, 0);
    }
    if (weapons && this._saved) {
      weapons.scene = this._saved.wScene;
      weapons.world = this._saved.wWorld;
      weapons.mode = this._saved.mode || 'weapon';
    }
    this._saved = null;

    // Hand the shared camera back to the match scene
    if (global.VF.game && global.VF.game.camera && global.VF.game.scene) {
      global.VF.game.scene.add(global.VF.game.camera);
    }

    document.exitPointerLock && document.exitPointerLock();
    if (player) player.setPointerLock(false);

    const overlay = document.getElementById('range-overlay');
    if (overlay) overlay.classList.add('hidden');

    if (global.VF.UI && global.VF.UI.els && global.VF.UI.els.hud) {
      global.VF.UI.els.hud.classList.add('hidden');
    }
    // Undo training-only hide so the next match still has a minimap / cores
    const mm = document.getElementById('minimap-wrap') || document.getElementById('minimap');
    if (mm) mm.classList.remove('hidden');
    const missionRow = document.getElementById('mission-row');
    if (missionRow) missionRow.classList.remove('hidden');
    const waveInfo = document.getElementById('wave-info');
    if (waveInfo) waveInfo.classList.remove('hidden');

    for (let i = this._debris.length - 1; i >= 0; i--) {
      const d = this._debris[i];
      if (d.mesh && d.mesh.parent) d.mesh.parent.remove(d.mesh);
    }
    this._debris.length = 0;

    if (wasActive && !silent && this._handlers.onBack) this._handlers.onBack();
  };

  Range.prototype.hide = function () {
    this.close();
  };

  Range.prototype._tintTarget = function (t, hex) {
    t.mesh.traverse(function (c) {
      if (c.isMesh && c.name === 'hitbody' && c.material && c.material.color) {
        c.material.color.setHex(hex);
      }
    });
  };

  Range.prototype._flashHit = function (t) {
    t.mesh.traverse(function (c) {
      if (!c.isMesh || !c.material || !c.material.emissive) return;
      if (!c.material.userData._owned) {
        c.material = c.material.clone();
        c.material.userData._owned = true;
      }
      const mat = c.material;
      mat.emissive.setHex(0xff2200);
      mat.emissiveIntensity = 1.2;
    });
    t._flashAt = performance.now();
    this._tintTarget(t, 0xff6644);
  };

  Range.prototype._clearFlash = function (t) {
    t.mesh.traverse(function (c) {
      if (!c.isMesh || !c.material || !c.material.emissive) return;
      c.material.emissive.setHex(0x000000);
      c.material.emissiveIntensity = 0;
    });
    if (t.alive) this._tintTarget(t, t.baseColor);
  };

  Range.prototype._targetBox = function (t, out) {
    const p = t.mesh.position;
    // Board center ~2.2 above feet; size ~1.4 x 1.8
    const raise = t.raised != null ? t.raised : 1;
    const cy = p.y + 1.2 + 1.0 * raise;
    const halfH = 0.9 * Math.max(0.15, raise);
    out.min.set(p.x - 0.75, cy - halfH, p.z - 0.35);
    out.max.set(p.x + 0.75, cy + halfH, p.z + 0.35);
    return out;
  };

  /**
   * Same contract as AI.raycastEnemies
   */
  Range.prototype.raycastTargets = function (origin, dir, maxDist) {
    if (!this.active) return null;
    const HB = global.VF && global.VF.Hitboxes;
    let best = null;
    let bestDist = maxDist != null ? maxDist : 200;

    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i];
      if (!t.alive || !t.hittable || t.dead) continue;
      let hit = null;
      if (HB && HB.raycast) {
        hit = HB.raycast(t, origin, dir, bestDist);
      }
      if (!hit || hit.dist == null || hit.dist >= bestDist) continue;
      bestDist = hit.dist;
      best = {
        target: t,
        point: hit.point,
        dist: hit.dist,
        part: hit.part || 'torso',
      };
    }
    return best;
  };

  Range.prototype.damageTarget = function (target, dmg, hitDir, hitPoint, part) {
    if (!target || !target.alive) return { killed: false, dmg: 0 };
    const applied = Math.max(1, Math.round(dmg || 0));
    target.hp -= applied;
    this._flashHit(target);
    const scoring = !(this._mode === 'challenge' && this._challengeDone);
    if (scoring) {
      this._hits += 1;
      let add = 1;
      if (part === 'head') add += 2;
      else if (part === 'torso') add += 1;
      if (target.meters >= 35) add += 1;
      this._score += add;
      this._noteHitStreak();
    }

    if (target.hp <= 0) {
      target.alive = false;
      target.dead = true;
      target.hittable = false;
      target.respawn = TARGET_RESPAWN;
      if (scoring) {
        this._breaks += 1;
        this._score += 5;
      }
      this._shatterTarget(target, hitDir);
      if (global.VF.Audio) global.VF.Audio.play('kill');
      this._syncHud();
      return { killed: true, dmg: applied, part: part || null };
    }
    this._syncHud();
    return { killed: false, dmg: applied, part: part || null };
  };

  Range.prototype._noteHitStreak = function () {
    const now = performance.now();
    if (!this._mkAt || now - this._mkAt > MK_WINDOW_MS) this._mkCount = 0;
    this._mkCount += 1;
    this._mkAt = now;
    if (this._mkCount >= 3 && this._mkCount % 3 === 0 && global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast(this._mkCount + ' 连击');
    }
  };

  Range.prototype._shatterTarget = function (t, hitDir) {
    const origin = t.mesh.position.clone().add(new THREE.Vector3(0, 2.2, 0));
    let dx = hitDir && hitDir.x != null ? hitDir.x : 0;
    let dy = hitDir && hitDir.y != null ? hitDir.y : 0.2;
    let dz = hitDir && hitDir.z != null ? hitDir.z : 0;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;

    t.mesh.visible = false;
    if (global.VF.game && global.VF.game.weapons && global.VF.game.weapons._spawnImpact) {
      global.VF.game.weapons._spawnImpact(origin, 0xffaa44, 0.4);
      global.VF.game.weapons._spawnImpact(
        origin.clone().add(new THREE.Vector3(0, 0.2, 0)),
        0xff6622,
        0.28
      );
    }

    while (this._debris.length >= 48) {
      const old = this._debris.shift();
      if (old && old.mesh && old.mesh.parent) old.mesh.parent.remove(old.mesh);
    }
    for (let i = 0; i < 14; i++) {
      const size = 0.12 + Math.random() * 0.18;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(size, size, size),
        new THREE.MeshLambertMaterial({
          color: Math.random() > 0.35 ? 0xf3efe4 : 0xc8c2b4,
          transparent: true,
          opacity: 1,
        })
      );
      mesh.position.copy(origin).add(
        new THREE.Vector3(
          (Math.random() - 0.5) * 0.6,
          (Math.random() - 0.5) * 0.8,
          (Math.random() - 0.5) * 0.4
        )
      );
      this.scene.add(mesh);
      const spd = 6 + Math.random() * 10;
      this._debris.push({
        mesh: mesh,
        life: 0.7 + Math.random() * 0.5,
        maxLife: 1.2,
        vx: dx * spd + (Math.random() - 0.5) * 8,
        vy: Math.max(2, dy * spd) + 3 + Math.random() * 5,
        vz: dz * spd + (Math.random() - 0.5) * 8,
        rx: (Math.random() - 0.5) * 12,
        ry: (Math.random() - 0.5) * 12,
        rz: (Math.random() - 0.5) * 12,
      });
    }
  };

  Range.prototype._updateTargets = function (dt) {
    for (let i = 0; i < this.targets.length; i++) {
      const tgt = this.targets[i];

      if (tgt._flashAt && performance.now() - tgt._flashAt > 90) {
        this._clearFlash(tgt);
        tgt._flashAt = 0;
      }

      if (!tgt.alive) {
        tgt.respawn -= dt;
        if (tgt.respawn <= 0) {
          tgt.alive = true;
          tgt.dead = false;
          tgt.hittable = true;
          tgt.hp = tgt.maxHp;
          tgt.raised = 1;
          tgt.mesh.visible = true;
          tgt.mesh.position.set(tgt.homeX, tgt.homeY, tgt.homeZ);
          this._tintTarget(tgt, tgt.baseColor);
        }
        continue;
      }

      tgt.mesh.position.set(tgt.homeX, tgt.homeY, tgt.homeZ);
      tgt.raised = 1;
      tgt.hittable = true;
    }
  };

  Range.prototype._updateDebris = function (dt) {
    for (let i = this._debris.length - 1; i >= 0; i--) {
      const d = this._debris[i];
      d.life -= dt;
      d.vy -= 22 * dt;
      d.mesh.position.x += d.vx * dt;
      d.mesh.position.y += d.vy * dt;
      d.mesh.position.z += d.vz * dt;
      d.mesh.rotation.x += d.rx * dt;
      d.mesh.rotation.y += d.ry * dt;
      d.mesh.rotation.z += d.rz * dt;
      const u = Math.max(0, d.life / Math.max(0.001, d.maxLife));
      d.mesh.material.opacity = u;
      if (d.life <= 0) {
        if (d.mesh.parent) d.mesh.parent.remove(d.mesh);
        this._debris.splice(i, 1);
      }
    }
  };

  Range.prototype.update = function (dt) {
    if (!this.active) return;
    const player = this._player();
    const weapons = this._weapons();
    if (!player || !weapons) return;

    // Infinite reserve while training (only top up when low)
    if (weapons.state) {
      const ids =
        (global.VF.WEAPON_LOADOUT_ORDER && global.VF.WEAPON_LOADOUT_ORDER.slice()) ||
        ['ak74'];
      for (let i = 0; i < ids.length; i++) {
        const st = weapons.state[ids[i]];
        if (st && st.reserve < 200) st.reserve = 999;
      }
    }

    if (this._mode === 'challenge' && !this._challengeDone) {
      this._challengeLeft -= dt;
      if (this._challengeLeft <= 0) {
        this._challengeLeft = 0;
        this._challengeDone = true;
        weapons.firing = false;
        this._saveBestIfNeeded();
        if (global.VF.UI && global.VF.UI.toast) {
          global.VF.UI.toast('挑战结束 · 分数 ' + this._score);
        }
      }
      this._syncHud();
    }

    player.update(dt);
    if (this._challengeDone) weapons.firing = false;
    weapons.update(dt);
    if (global.VF.Audio) global.VF.Audio.update(dt, player);

    this._updateTargets(dt);
    this._updateDebris(dt);

    const hint = document.getElementById('range-lock-hint');
    if (hint) {
      const wantHint = !player.locked;
      if (wantHint !== this._hintShown) {
        this._hintShown = wantHint;
        hint.classList.toggle('hidden', !wantHint);
      }
    }

    if (global.VF.UI) {
      const def = weapons.getDef && weapons.getDef();
      global.VF.UI.setAiming(
        player.aiming && weapons.mode === 'weapon',
        def && def.scope,
        player._adsBlend || 0
      );
      const ammo = weapons.getAmmo && weapons.getAmmo();
      if (ammo && (ammo.mag !== this._lastMag || ammo.reserve !== this._lastReserve)) {
        this._lastMag = ammo.mag;
        this._lastReserve = ammo.reserve;
        global.VF.UI.updateAmmo(ammo.mag, ammo.reserve);
      }
    }
  };

  Range.prototype.render = function () {
    if (!this.active || !this.renderer || !global.VF.game) return;
    const cam = global.VF.game.camera;
    if (!cam) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const aspect = w / Math.max(1, h);
    if (Math.abs(cam.aspect - aspect) > 0.001) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
    this.renderer.render(this.scene, cam);
  };

  const range = new Range();
  global.VF = global.VF || {};
  global.VF.Range = range;
})(window);
