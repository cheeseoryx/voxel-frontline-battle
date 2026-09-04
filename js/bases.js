/**
 * bases.js — Ally (blue) / Enemy (red) glowing core bases
 * Walls & pedestal = voxels (real collision) · Core = glowing mesh (1000 HP)
 */
(function (global) {
  'use strict';

  const CORE_MAX_HP = 1000;
  const SPAWN_RANGE = 12;
  const SPAWN_CAPTURE_SEC = 20;

  const TEAM = {
    ally: {
      glow: 0x33aaff,
      glowEmissive: 0x1188ff,
      banner: 0x2266cc,
      bannerMark: 0xffffff,
      name: '蓝方基地',
    },
    enemy: {
      glow: 0xff3344,
      glowEmissive: 0xff1122,
      banner: 0xaa2233,
      bannerMark: 0xffffff,
      name: '红方基地',
    },
  };

  function box(w, h, d, color, x, y, z, opts) {
    opts = opts || {};
    const mat = opts.emissive
      ? new THREE.MeshStandardMaterial({
          color: color,
          emissive: opts.emissive,
          emissiveIntensity: opts.emissiveIntensity != null ? opts.emissiveIntensity : 0.85,
          transparent: !!opts.transparent,
          opacity: opts.opacity != null ? opts.opacity : 1,
          metalness: 0.1,
          roughness: 0.4,
        })
      : new THREE.MeshLambertMaterial({
          color: color,
          transparent: !!opts.transparent,
          opacity: opts.opacity != null ? opts.opacity : 1,
        });
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = false;
    m.receiveShadow = true;
    return m;
  }

  /**
   * Decorative meshes only (no collision). Structure/collision is voxel.
   * Large compound core — walls/ziggurat are voxels; this is the glowing core + accents.
   */
  function createBase(team, origin) {
    const pal = TEAM[team];
    const root = new THREE.Group();
    root.name = team === 'ally' ? 'AllyBase' : 'EnemyBase';
    root.position.copy(origin);

    // Glow accents on pedestal (visual)
    const accents = [
      [-3.5, 1.6, -3.5],
      [3.5, 1.6, -3.5],
      [-3.5, 1.6, 3.5],
      [3.5, 1.6, 3.5],
      [-2.2, 2.6, 0],
      [2.2, 2.6, 0],
      [0, 2.6, -2.2],
      [0, 2.6, 2.2],
    ];
    for (let i = 0; i < accents.length; i++) {
      const a = accents[i];
      root.add(
        box(0.55, 0.55, 0.55, pal.glow, a[0], a[1], a[2], {
          emissive: pal.glowEmissive,
          emissiveIntensity: 1.2,
        })
      );
    }

    // Floating upright cube core (large — attackable, not capturable)
    const coreGroup = new THREE.Group();
    coreGroup.name = 'BaseCore';
    coreGroup.position.set(0, 9.2, 0);

    coreGroup.add(
      box(5.6, 5.6, 5.6, pal.glow, 0, 0, 0, {
        emissive: pal.glowEmissive,
        emissiveIntensity: 1.5,
        transparent: true,
        opacity: 0.55,
      })
    );
    coreGroup.add(
      box(3.6, 3.6, 3.6, 0xffffff, 0, 0, 0, {
        emissive: pal.glowEmissive,
        emissiveIntensity: 2.2,
        transparent: true,
        opacity: 0.8,
      })
    );
    coreGroup.add(
      box(1.8, 1.8, 1.8, pal.glow, 0, 0, 0, {
        emissive: pal.glowEmissive,
        emissiveIntensity: 2.6,
        transparent: true,
        opacity: 0.9,
      })
    );

    const coreLight = new THREE.PointLight(pal.glow, 3.5, 52);
    coreGroup.add(coreLight);
    root.add(coreGroup);

    // Banners near gate pillars (visual)
    const bannerZ = team === 'ally' ? 19 : -19;
    for (let bx of [-9, 9]) {
      root.add(box(2.6, 6.0, 0.12, pal.banner, bx, 10, bannerZ));
      root.add(
        box(1.0, 1.0, 0.14, pal.bannerMark, bx, 10.4, bannerZ + (bannerZ > 0 ? 0.02 : -0.02))
      );
    }

    const maxHp = CORE_MAX_HP;
    root.userData.team = team;
    root.userData.core = coreGroup;
    root.userData.coreHp = maxHp;
    root.userData.coreMaxHp = maxHp;
    root.userData.destroyed = false;
    root.userData.targetable = team === 'enemy';

    return root;
  }

  /** Tiny physical spawn crystal + pedestal + ground range ring.
   *  pos.y is ~gy+1.05 (just above block top). Pedestal/ring sit on that surface. */
  function createSpawnCrystal(team, pos, label, range) {
    const pal = TEAM[team] || TEAM.ally;
    const r = range != null ? range : SPAWN_RANGE;
    const root = new THREE.Group();
    root.name = 'SpawnCrystal';
    root.position.set(pos.x, pos.y, pos.z);

    // Local Y: 0 ≈ slightly above walk surface (root already at gy+1.05)
    const gY = 0.02;

    // Stone pedestal + team-colored top plate (recolors on capture refresh)
    root.add(box(1.9, 0.38, 1.9, 0x6a6560, 0, gY + 0.19, 0));
    root.add(box(1.35, 0.2, 1.35, 0x4a4642, 0, gY + 0.38 + 0.1, 0));
    const plate = box(1.45, 0.1, 1.45, pal.glow, 0, gY + 0.62, 0, {
      emissive: pal.glowEmissive,
      emissiveIntensity: 1.1,
      transparent: true,
      opacity: 0.9,
    });
    plate.name = 'SpawnPlate';
    root.add(plate);

    const crystalY = gY + 1.05;
    root.add(
      box(0.78, 0.78, 0.78, pal.glow, 0, crystalY, 0, {
        emissive: pal.glowEmissive,
        emissiveIntensity: 1.55,
        transparent: true,
        opacity: 0.7,
      })
    );
    root.add(
      box(0.42, 0.42, 0.42, 0xffffff, 0, crystalY, 0, {
        emissive: pal.glowEmissive,
        emissiveIntensity: 2.2,
        transparent: true,
        opacity: 0.9,
      })
    );
    const light = new THREE.PointLight(pal.glow, 1.6, 18);
    light.position.set(0, crystalY + 0.2, 0);
    root.add(light);

    // Filled range disc (easy to see in FPS) + thick outer ring
    const discMat = new THREE.MeshBasicMaterial({
      color: pal.glow,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 64), discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = gY + 0.04;
    disc.renderOrder = 2;
    root.add(disc);

    const ringMat = new THREE.MeshBasicMaterial({
      color: pal.glow,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(Math.max(0.8, r - 0.85), r, 64), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = gY + 0.06;
    ring.renderOrder = 3;
    root.add(ring);

    // Capture progress accent (starts invisible)
    const capMat = new THREE.MeshBasicMaterial({
      color: 0xffe8a0,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const capRing = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(0.5, r - 1.6), Math.max(1.0, r - 0.85), 64),
      capMat
    );
    capRing.rotation.x = -Math.PI / 2;
    capRing.position.y = gY + 0.08;
    capRing.renderOrder = 4;
    root.add(capRing);

    root.userData.team = team;
    root.userData.spawnLabel = label || '';
    root.userData.kitSpawn = true;
    root.userData.range = r;
    root.userData.rangeRingMat = ringMat;
    root.userData.rangeDiscMat = discMat;
    root.userData.captureRingMat = capMat;

    // Billboard capture progress ring above the crystal
    const hud = createCaptureProgressHud();
    hud.sprite.position.set(0, crystalY + 1.55, 0);
    hud.sprite.visible = false;
    root.add(hud.sprite);
    root.userData.captureHud = hud;
    return root;
  }

  /** Canvas sprite: circular progress + 「占领进度」 label above crystals. */
  function createCaptureProgressHud() {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      opacity: 1,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.4, 2.4, 1);
    sprite.renderOrder = 20;
    sprite.name = 'CaptureProgressHud';
    return {
      sprite: sprite,
      canvas: canvas,
      ctx: ctx,
      tex: tex,
      lastKey: '',
    };
  }

  function drawCaptureProgressHud(hud, progress, secs, total) {
    if (!hud || !hud.ctx) return;
    const p = Math.max(0, Math.min(1, progress || 0));
    const key = (secs | 0) + '/' + total + ':' + Math.round(p * 40);
    if (key === hud.lastKey) return;
    hud.lastKey = key;

    const ctx = hud.ctx;
    const size = hud.canvas.width;
    const cx = size * 0.5;
    const cy = size * 0.5;
    ctx.clearRect(0, 0, size, size);

    // Soft dark plate
    ctx.beginPath();
    ctx.arc(cx, cy, 108, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(8, 10, 14, 0.72)';
    ctx.fill();

    // Track ring
    ctx.beginPath();
    ctx.arc(cx, cy, 92, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 14;
    ctx.stroke();

    // Progress arc (start at top, clockwise)
    if (p > 0.001) {
      const start = -Math.PI * 0.5;
      const end = start + Math.PI * 2 * p;
      const grad = ctx.createLinearGradient(0, 0, size, size);
      grad.addColorStop(0, '#ffe08a');
      grad.addColorStop(1, '#ff9a3c');
      ctx.beginPath();
      ctx.arc(cx, cy, 92, start, end);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 16;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // Title
    ctx.fillStyle = '#ffe8d4';
    ctx.font = 'bold 28px Zpix, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('占领进度', cx, cy - 22);

    // Numbers
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px Zpix, "Microsoft YaHei", monospace';
    ctx.fillText((secs | 0) + '/' + total, cx, cy + 22);

    hud.tex.needsUpdate = true;
  }

  function Bases(scene, world) {
    this.scene = scene;
    this.world = world;
    this.allyBase = null;
    this.enemyBase = null;
    this.won = false;
    this.lost = false;

    const size = world.worldSize;
    const planned = world._plannedBases;
    const allyGate = (planned && planned[0] && planned[0].gate) || '+x';
    const enemyGate = (planned && planned[1] && planned[1].gate) || '-x';
    const allyPos = new THREE.Vector3(
      planned ? planned[0].x : size * 0.13,
      0,
      planned ? planned[0].z : size * 0.5
    );
    const enemyPos = new THREE.Vector3(
      planned ? planned[1].x : size * 0.87,
      0,
      planned ? planned[1].z : size * 0.5
    );

    // Flat pad + solid walls/pedestal (voxels = collision)
    this._buildBaseStructure(allyPos.x, allyPos.z, allyGate);
    this._buildBaseStructure(enemyPos.x, enemyPos.z, enemyGate);

    allyPos.y = world._surface(Math.floor(allyPos.x), Math.floor(allyPos.z));
    enemyPos.y = world._surface(Math.floor(enemyPos.x), Math.floor(enemyPos.z));

    this.allyBase = createBase('ally', allyPos);
    this.enemyBase = createBase('enemy', enemyPos);
    scene.add(this.allyBase);
    scene.add(this.enemyBase);

    this.allyOrigin = allyPos.clone();
    this.enemyOrigin = enemyPos.clone();
    world._allyBasePos = allyPos.clone();
    world._enemyBasePos = enemyPos.clone();
    world._allyGateDir = allyGate;
    world._enemyGateDir = enemyGate;
    world._objective = enemyPos.clone().add(new THREE.Vector3(0, 9, 0));

    this._setupSpawnPoints(allyPos, enemyPos);
  };

  /**
   * After world.regenerate(seed): re-stamp base voxels, refresh pads / spawn points.
   * Base XY positions stay fixed; only surrounding city changes.
   */
  Bases.prototype.rebuildAfterMapGen = function () {
    const w = this.world;
    const planned = w._plannedBases;
    const allyGate = (planned && planned[0] && planned[0].gate) || w._allyGateDir || '+x';
    const enemyGate = (planned && planned[1] && planned[1].gate) || w._enemyGateDir || '-x';
    const allyPos =
      planned && planned[0]
        ? new THREE.Vector3(planned[0].x, 0, planned[0].z)
        : this.allyOrigin.clone();
    const enemyPos =
      planned && planned[1]
        ? new THREE.Vector3(planned[1].x, 0, planned[1].z)
        : this.enemyOrigin.clone();

    this._buildBaseStructure(allyPos.x, allyPos.z, allyGate);
    this._buildBaseStructure(enemyPos.x, enemyPos.z, enemyGate);

    allyPos.y = w._surface(Math.floor(allyPos.x), Math.floor(allyPos.z));
    enemyPos.y = w._surface(Math.floor(enemyPos.x), Math.floor(enemyPos.z));
    this.allyOrigin.copy(allyPos);
    this.enemyOrigin.copy(enemyPos);

    if (this.allyBase) this.allyBase.position.set(allyPos.x, allyPos.y, allyPos.z);
    if (this.enemyBase) this.enemyBase.position.set(enemyPos.x, enemyPos.y, enemyPos.z);

    w._allyBasePos = allyPos.clone();
    w._enemyBasePos = enemyPos.clone();
    w._allyGateDir = allyGate;
    w._enemyGateDir = enemyGate;
    w._objective = enemyPos.clone().add(new THREE.Vector3(0, 9, 0));

    this.won = false;
    this.lost = false;
    this._setupSpawnPoints(allyPos, enemyPos);
    if (w.dirtyRect) {
      w.dirtyRect(allyPos.x - 34, allyPos.z - 34, allyPos.x + 34, allyPos.z + 34, 'content');
      w.dirtyRect(enemyPos.x - 34, enemyPos.z - 34, enemyPos.x + 34, enemyPos.z + 34, 'content');
    }
  };

  /** Spawn #1 = home base courtyard (not capturable). Kit crystals = capturable 2/3. */
  Bases.prototype._setupSpawnPoints = function (allyPos, enemyPos, kitSpawns) {
    const w = this.world;
    const size = w.worldSize;

    const clearPad = (fx, fz) => {
      let gy = w._surface(fx, fz);
      if (gy < 5) gy = w._surface(fx, fz) || 9;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const xx = fx + dx;
          const zz = fz + dz;
          if (xx < 1 || zz < 1 || xx >= size - 1 || zz >= size - 1) continue;
          if (w.isPropClaimed && w.isPropClaimed(xx, zz)) continue;
          for (let y = gy + 1; y <= gy + 4; y++) w.set(xx, y, zz, global.VF.BLOCK.AIR);
          if (w.groundY) w.groundY[zz * size + xx] = gy;
          if (w.terrainH) w.terrainH[zz * size + xx] = gy + 1;
        }
      }
      return gy;
    };

    const makePoint = (team, index, fx, fz, opts) => {
      opts = opts || {};
      const gy = clearPad(fx, fz);
      const tag = team === 'ally' ? '蓝' : '红';
      const capturable = opts.capturable !== false && index > 0;
      return {
        id: team + '-' + (index + 1),
        team: team,
        index: index,
        label: tag + (index + 1),
        x: fx + 0.5,
        y: gy + 1.05,
        z: fz + 0.5,
        range: capturable ? SPAWN_RANGE : 0,
        captureT: 0,
        fixed: !!opts.fixed || index === 0,
        capturable: capturable,
      };
    };

    const ally = [];
    const enemy = [];

    const gateStep = function (dir, dist) {
      if (dir === '+x') return { x: dist, z: 0 };
      if (dir === '-x') return { x: -dist, z: 0 };
      if (dir === '+z') return { x: 0, z: dist };
      return { x: 0, z: -dist };
    };
    const allyGate = w._allyGateDir || '+x';
    const enemyGate = w._enemyGateDir || '-x';
    const aOff = gateStep(allyGate, 15);
    const eOff = gateStep(enemyGate, 15);

    // Spawn #1: inside home courtyard (toward gate). Landmark = large base core, not a small crystal.
    ally.push(
      makePoint('ally', 0, Math.floor(allyPos.x + aOff.x), Math.floor(allyPos.z + aOff.z), {
        fixed: true,
        capturable: false,
      })
    );
    enemy.push(
      makePoint('enemy', 0, Math.floor(enemyPos.x + eOff.x), Math.floor(enemyPos.z + eOff.z), {
        fixed: true,
        capturable: false,
      })
    );

    const kit = kitSpawns || w._kitSpawns;
    const srcAlly = (kit && kit.ally) || [];
    const srcEnemy = (kit && kit.enemy) || [];

    // Kit crystals → 蓝2/3/4 · 红2/3/4 (capturable); base #1 + up to 3 = 4 per team
    for (let i = 0; i < srcAlly.length && ally.length < 4; i++) {
      const s = srcAlly[i];
      const fx = Math.floor(s.x != null ? s.x : s.cx);
      const fz = Math.floor(s.z != null ? s.z : s.cz);
      ally.push(makePoint('ally', ally.length, fx, fz, { capturable: true }));
    }
    for (let i = 0; i < srcEnemy.length && enemy.length < 4; i++) {
      const s = srcEnemy[i];
      const fx = Math.floor(s.x != null ? s.x : s.cx);
      const fz = Math.floor(s.z != null ? s.z : s.cz);
      enemy.push(makePoint('enemy', enemy.length, fx, fz, { capturable: true }));
    }

    w._spawnPoints = { ally: ally, enemy: enemy, all: ally.concat(enemy) };
    // Keep team selection if already locked mid-match (kit refresh); else clear
    const g = global.VF && global.VF.game;
    if (!(g && g.teamLocked && g.lockedTeam)) {
      w._playerTeam = null;
      w._selectedSpawnId = null;
    }

    this._refreshSpawnCrystals();

    for (let i = 0; i < w._spawnPoints.all.length; i++) {
      const s = w._spawnPoints.all[i];
      this._rebuildPadChunks(Math.floor(s.x), Math.floor(s.z), 6);
    }
  };

  Bases.prototype._clearSpawnCrystals = function () {
    if (!this._spawnCrystals) this._spawnCrystals = [];
    for (let i = 0; i < this._spawnCrystals.length; i++) {
      const m = this._spawnCrystals[i];
      if (m && m.parent) m.parent.remove(m);
      if (m) {
        m.traverse(function (c) {
          if (c.geometry) c.geometry.dispose();
          if (c.material) {
            if (Array.isArray(c.material)) c.material.forEach(function (x) { if (x.dispose) x.dispose(); });
            else if (c.material.dispose) c.material.dispose();
          }
        });
      }
    }
    this._spawnCrystals = [];
    const list = (this.world && this.world._spawnPoints && this.world._spawnPoints.all) || [];
    for (let i = 0; i < list.length; i++) list[i].mesh = null;
  };

  /** Place physical small crystals at capturable kit spawn points only (not home #1). */
  Bases.prototype._refreshSpawnCrystals = function () {
    this._clearSpawnCrystals();
    const w = this.world;
    const list = (w._spawnPoints && w._spawnPoints.all) || [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      s.mesh = null;
      // Home base spawn #1 uses the large compound core — no small crystal / no capture ring
      if (s.fixed || s.capturable === false) continue;
      if (s.range == null) s.range = SPAWN_RANGE;
      if (s.captureT == null) s.captureT = 0;
      const mesh = createSpawnCrystal(s.team, { x: s.x, y: s.y, z: s.z }, s.label, s.range);
      mesh.userData.spawnId = s.id;
      s.mesh = mesh;
      this.scene.add(mesh);
      this._spawnCrystals.push(mesh);
    }
  };

  /** Relabel ally/enemy lists after a capture flip (keep stable ids; home #1 stays *1). */
  Bases.prototype._relabelSpawnTeams = function () {
    const w = this.world;
    if (!w._spawnPoints || !w._spawnPoints.all) return;
    const ally = [];
    const enemy = [];
    for (let i = 0; i < w._spawnPoints.all.length; i++) {
      const s = w._spawnPoints.all[i];
      if (s.team === 'enemy') enemy.push(s);
      else ally.push(s);
    }
    const sortHomeFirst = (a, b) => (b.fixed ? 1 : 0) - (a.fixed ? 1 : 0);
    ally.sort(sortHomeFirst);
    enemy.sort(sortHomeFirst);
    for (let i = 0; i < ally.length; i++) {
      ally[i].index = i;
      ally[i].label = '蓝' + (i + 1);
    }
    for (let i = 0; i < enemy.length; i++) {
      enemy[i].index = i;
      enemy[i].label = '红' + (i + 1);
    }
    w._spawnPoints.ally = ally;
    w._spawnPoints.enemy = enemy;
    w._spawnPoints.all = ally.concat(enemy);
  };

  Bases.prototype._flipSpawnTeam = function (spawn, newTeam) {
    if (!spawn || spawn.team === newTeam) return;
    if (spawn.fixed || spawn.capturable === false) return;
    const from = spawn.team === 'enemy' ? '红' : '蓝';
    const to = newTeam === 'enemy' ? '红' : '蓝';
    spawn.team = newTeam;
    spawn.captureT = 0;
    this._relabelSpawnTeams();
    // Rebuild mesh so crystal / plate / range ring all take the new team color
    this._refreshSpawnCrystals();
    if (global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast('已占领出生点 · ' + from + '→' + to + ' ' + (spawn.label || ''));
    }
    if (global.VF.Audio && global.VF.Audio.play) global.VF.Audio.play('confirm');
  };

  /**
   * Apply map-kit spawn crystals (from editor). Each entry: {team, cx, cz} or spawn point shape.
   */
  Bases.prototype.applyKitSpawns = function (spawnItems) {
    const w = this.world;
    const ally = [];
    const enemy = [];
    const items = spawnItems || [];
    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      if (!p) continue;
      const team = p.team === 'enemy' ? 'enemy' : 'ally';
      const x = p.cx != null ? p.cx : p.x;
      const z = p.cz != null ? p.cz : p.z;
      if (x == null || z == null) continue;
      const gy = w._surface(Math.floor(x), Math.floor(z)) || 9;
      const entry = {
        x: Math.floor(x) + 0.5,
        y: gy + 1.05,
        z: Math.floor(z) + 0.5,
        team: team,
      };
      if (team === 'ally') ally.push(entry);
      else enemy.push(entry);
    }
    w._kitSpawns = { ally: ally, enemy: enemy };
    this._setupSpawnPoints(this.allyOrigin, this.enemyOrigin, w._kitSpawns);
  };

  Bases.prototype._gateAxis = function (gateDir) {
    if (gateDir === '+z') return { ox: 0, oz: 1, px: 1, pz: 0 };
    if (gateDir === '-z') return { ox: 0, oz: -1, px: 1, pz: 0 };
    if (gateDir === '+x') return { ox: 1, oz: 0, px: 0, pz: 1 };
    return { ox: -1, oz: 0, px: 0, pz: 1 };
  };

  Bases.prototype._surfaceAt = function (x, z) {
    const w = this.world;
    const gx = Math.floor(x);
    const gz = Math.floor(z);
    if (gx < 1 || gz < 1 || gx >= w.worldSize - 1 || gz >= w.worldSize - 1) return null;
    if (w._riverInfo && w._riverInfo(gx, gz).inWater) return null;
    let gy = w._surface(gx, gz);
    if (!(gy > 2)) gy = 6;
    return gy;
  };

  /** Courtyard height follows the gate approach, never a mesa above it. */
  Bases.prototype._pickCourtyardHeight = function (gx, gz, half, gateDir) {
    const center = this._surfaceAt(gx, gz) || 9;
    const axis = this._gateAxis(gateDir);
    const samples = [];
    for (let d = half + 4; d <= half + 36; d += 3) {
      for (let s = -10; s <= 10; s += 5) {
        const y = this._surfaceAt(gx + axis.ox * d + axis.px * s, gz + axis.oz * d + axis.pz * s);
        if (y != null) samples.push(y);
      }
    }
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const y = this._surfaceAt(
        gx + Math.cos(a) * (half + 8),
        gz + Math.sin(a) * (half + 8)
      );
      if (y != null) samples.push(y);
    }
    if (!samples.length) return center;
    samples.sort(function (a, b) {
      return a - b;
    });
    const lo = samples[Math.floor(samples.length * 0.2)];
    const med = samples[samples.length >> 1];
    return Math.max(6, Math.min(center, med, lo + 1));
  };

  Bases.prototype._setWalkColumn = function (x, z, walkTop, topBlock) {
    const w = this.world;
    const BLOCK = global.VF.BLOCK;
    if (x < 0 || z < 0 || x >= w.worldSize || z >= w.worldSize) return;
    // Never rewrite a column an artist-placed prop stands on — this function
    // overwrites the whole column and clears 24 blocks of air above it, which
    // used to erase ~25% of a prop placed near a base gate.
    if (w.isPropClaimed && w.isPropClaimed(x, z)) return;
    const top = Math.max(1.2, walkTop);
    const gy = Math.max(3, Math.round(top) - 1);
    const cap = topBlock || BLOCK.CONCRETE;
    for (let y = 0; y <= gy; y++) {
      let t = BLOCK.STONE;
      if (y === gy) t = cap;
      else if (y === gy - 1) t = BLOCK.DIRT;
      w.set(x, y, z, t);
    }
    for (let y = gy + 1; y < Math.min(gy + 24, w.height); y++) {
      w.set(x, y, z, BLOCK.AIR);
    }
    if (w.groundY) w.groundY[z * w.worldSize + x] = gy;
    if (w.terrainH) w.terrainH[z * w.worldSize + x] = top;
  };

  Bases.prototype._gradeGateExit = function (gx, gz, gy, half, gateDir) {
    const w = this.world;
    const BLOCK = global.VF.BLOCK;
    const axis = this._gateAxis(gateDir);
    const padTop = gy + 1;
    const apron = 6;
    const ramp = 18;
    for (let d = 1; d <= apron + ramp; d++) {
      const t = d <= apron ? 0 : Math.min(1, (d - apron) / ramp);
      const topBlock = d <= apron ? BLOCK.CONCRETE : BLOCK.DIRT;
      for (let s = -10; s <= 10; s++) {
        const x = gx + axis.ox * (half + d) + axis.px * s;
        const z = gz + axis.oz * (half + d) + axis.pz * s;
        if (x < 1 || z < 1 || x >= w.worldSize - 1 || z >= w.worldSize - 1) continue;
        if (w._riverInfo && w._riverInfo(x, z).inWater) continue;
        const idx = z * w.worldSize + x;
        const naturalTop =
          w.terrainH && w.terrainH[idx] > 1.2
            ? w.terrainH[idx]
            : (w._surface(x, z) || gy) + 1;
        const walkTop = padTop + (naturalTop - padTop) * t;
        this._setWalkColumn(x, z, walkTop, topBlock);
      }
    }
  };
  /**
   * Courtyard + walls on natural-height ground (no raised HQ mesa).
   */
  Bases.prototype._buildBaseStructure = function (cx, cz, gateDir) {
    const w = this.world;
    const BLOCK = global.VF.BLOCK;
    const gx = Math.floor(cx);
    const gz = Math.floor(cz);
    const half = 30;
    const wallH = 12;
    const gateHalf = 6;
    const wallThick = 4;

    const gy = this._pickCourtyardHeight(gx, gz, half, gateDir);

    // --- Floor pad (matches gate-out terrain, not the hilltop) ---
    for (let x = gx - half - 1; x <= gx + half + 1; x++) {
      for (let z = gz - half - 1; z <= gz + half + 1; z++) {
        if (x < 0 || z < 0 || x >= w.worldSize || z >= w.worldSize) continue;
        this._setWalkColumn(x, z, gy + 1, BLOCK.CONCRETE);
      }
    }

    // --- Ziggurat pedestal ---
    const tiers = [
      { r: 5, h: 1 },
      { r: 4, h: 2 },
      { r: 3, h: 3 },
    ];
    for (let t = 0; t < tiers.length; t++) {
      const tier = tiers[t];
      for (let x = gx - tier.r; x <= gx + tier.r; x++) {
        for (let z = gz - tier.r; z <= gz + tier.r; z++) {
          for (let y = gy + 1; y <= gy + tier.h; y++) {
            w.set(x, y, z, BLOCK.STONE);
          }
        }
      }
    }

    const isInGate = (x, z) => {
      if (gateDir === '+z') {
        return z >= gz + half - wallThick + 1 && z <= gz + half && Math.abs(x - gx) <= gateHalf;
      }
      if (gateDir === '-z') {
        return z <= gz - half + wallThick - 1 && z >= gz - half && Math.abs(x - gx) <= gateHalf;
      }
      if (gateDir === '+x') {
        return x >= gx + half - wallThick + 1 && x <= gx + half && Math.abs(z - gz) <= gateHalf;
      }
      if (gateDir === '-x') {
        return x <= gx - half + wallThick - 1 && x >= gx - half && Math.abs(z - gz) <= gateHalf;
      }
      return false;
    };

    // --- Perimeter walls (thick) ---
    for (let x = gx - half; x <= gx + half; x++) {
      for (let z = gz - half; z <= gz + half; z++) {
        const onRing =
          x <= gx - half + wallThick - 1 ||
          x >= gx + half - wallThick + 1 ||
          z <= gz - half + wallThick - 1 ||
          z >= gz + half - wallThick + 1;
        const inFootprint = x >= gx - half && x <= gx + half && z >= gz - half && z <= gz + half;
        if (!inFootprint || !onRing) continue;
        if (isInGate(x, z)) continue;
        for (let y = gy + 1; y <= gy + wallH; y++) {
          w.set(x, y, z, BLOCK.CONCRETE);
        }
      }
    }

    // --- Gate flanking pillars ---
    const pillarH = wallH + 2;
    let pillars = [];
    if (gateDir === '+z') {
      const zz = gz + half - 1;
      pillars = [
        [gx - gateHalf - 2, zz],
        [gx + gateHalf + 1, zz],
      ];
    } else if (gateDir === '-z') {
      const zz = gz - half;
      pillars = [
        [gx - gateHalf - 2, zz],
        [gx + gateHalf + 1, zz],
      ];
    } else if (gateDir === '+x') {
      const xx = gx + half - 1;
      pillars = [
        [xx, gz - gateHalf - 2],
        [xx, gz + gateHalf + 1],
      ];
    } else {
      const xx = gx - half;
      pillars = [
        [xx, gz - gateHalf - 2],
        [xx, gz + gateHalf + 1],
      ];
    }
    for (let i = 0; i < pillars.length; i++) {
      const px = pillars[i][0];
      const pz = pillars[i][1];
      for (let dx = 0; dx <= 1; dx++) {
        for (let dz = 0; dz <= 1; dz++) {
          for (let y = gy + 1; y <= gy + pillarH; y++) {
            w.set(px + dx, y, pz + dz, BLOCK.STONE);
          }
        }
      }
    }

    // Wipe buildings in the open approach OUTSIDE the gate (not the gate itself)
    this._clearGateApproach(gx, gz, gy, half, gateDir);
    this._gradeGateExit(gx, gz, gy, half, gateDir);

    // --- Interior spiral stairs: courtyard → wall walkway ---
    const stairCx =
      gx + (gateDir === '+x' ? -6 : gateDir === '-x' ? 6 : gateDir === '+z' ? -9 : 9);
    const stairCz =
      gz + (gateDir === '+x' ? -9 : gateDir === '-x' ? 9 : gateDir === '+z' ? 6 : -6);
    const landingY = gy + wallH;
    if (w._clearShaft) {
      w._clearShaft(stairCx - 2, stairCz - 2, 5, 5, gy + 1, landingY + 1);
    }
    if (w._addSpiralStairs) {
      w._addSpiralStairs({
        cx: stairCx,
        cz: stairCz,
        yStart: gy + 1,
        yEnd: landingY,
        color: 0x5a6a78,
        radius: 2.2,
      });
    }
    if (w._addStairLanding) {
      w._addStairLanding(stairCx, stairCz, landingY, 3);
    } else {
      for (let x = stairCx - 3; x <= stairCx + 3; x++) {
        for (let z = stairCz - 3; z <= stairCz + 3; z++) {
          w.set(x, landingY, z, BLOCK.METAL);
        }
      }
    }
    if (w._addExteriorStairs) {
      const px = gx + 4;
      const pz = gz - 6;
      w._addExteriorStairs(px, pz, gy + 1, gy + 3.2, 2);
      for (let x = px; x <= px + 3; x++) {
        for (let z = pz; z <= pz + 4; z++) {
          if (w.get(x, gy + 3, z) === BLOCK.AIR) w.set(x, gy + 3, z, BLOCK.STONE);
        }
      }
    }

    this._rebuildPadChunks(gx, gz, half + 48);
  };

  /** Clear buildings in gate approach corridor (ally +Z / enemy -Z) — no blockers in front of the gap */
  Bases.prototype._clearGateApproach = function (gx, gz, gy, half, gateDir) {
    const w = this.world;
    const BLOCK = global.VF.BLOCK;
    const corridorHalf = 24;
    const corridorLen = 72;
    let x0;
    let x1;
    let z0;
    let z1;

    if (gateDir === '+z') {
      x0 = gx - corridorHalf;
      x1 = gx + corridorHalf;
      z0 = gz + half + 1;
      z1 = gz + half + corridorLen;
    } else if (gateDir === '-z') {
      x0 = gx - corridorHalf;
      x1 = gx + corridorHalf;
      z0 = gz - half - corridorLen;
      z1 = gz - half - 1;
    } else if (gateDir === '+x') {
      x0 = gx + half + 1;
      x1 = gx + half + corridorLen;
      z0 = gz - corridorHalf;
      z1 = gz + corridorHalf;
    } else {
      x0 = gx - half - corridorLen;
      x1 = gx - half - 1;
      z0 = gz - corridorHalf;
      z1 = gz + corridorHalf;
    }

    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        if (x < 0 || z < 0 || x >= w.worldSize || z >= w.worldSize) continue;
        for (let y = gy + 1; y < Math.min(gy + 48, w.height); y++) {
          const t = w.get(x, y, z);
          if (t !== BLOCK.AIR && t !== BLOCK.WATER) w.set(x, y, z, BLOCK.AIR);
        }
      }
    }

    const inCorridor = (x, z) => x >= x0 && x <= x1 && z >= z0 && z <= z1;

    if (w.props && w.props.length) {
      const keep = [];
      for (let i = 0; i < w.props.length; i++) {
        const p = w.props[i];
        if (!p.box) {
          keep.push(p);
          continue;
        }
        const mx = (p.box.min.x + p.box.max.x) * 0.5;
        const mz = (p.box.min.z + p.box.max.z) * 0.5;
        if (inCorridor(mx, mz)) {
          if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
          continue;
        }
        keep.push(p);
      }
      w.props = keep;
    }

    if (w.rooftops && w.rooftops.length) {
      w.rooftops = w.rooftops.filter((rt) => !inCorridor(rt.x, rt.z));
    }

    if (w.ziplines && w.ziplines.length) {
      w.ziplines = w.ziplines.filter((z) => {
        if (z.keep || z.fixed) return true;
        if (inCorridor(z.start.x, z.start.z) || inCorridor(z.end.x, z.end.z)) {
          if (z.cable && z.cable.parent) z.cable.parent.remove(z.cable);
          return false;
        }
        return true;
      });
    }
  };

  Bases.prototype._rebuildPadChunks = function (gx, gz, r) {
    const w = this.world;
    if (w.dirtyRect) w.dirtyRect(gx - r, gz - r, gx + r, gz + r, 'content');
  };

  Bases.prototype.getTargetBase = function () {
    const team = this.world._playerTeam || 'ally';
    // Blue attacks red crystal; red attacks blue crystal
    return team === 'enemy' ? this.allyBase : this.enemyBase;
  };

  Bases.prototype.getFriendlyBase = function () {
    const team = this.world._playerTeam || 'ally';
    return team === 'enemy' ? this.enemyBase : this.allyBase;
  };

  Bases.prototype.getTargetLabel = function () {
    const team = this.world._playerTeam || 'ally';
    return team === 'enemy' ? '蓝方核心' : '红方核心';
  };

  Bases.prototype.getFriendlyLabel = function () {
    const team = this.world._playerTeam || 'ally';
    return team === 'enemy' ? '红方核心' : '蓝方核心';
  };

  /** Lock win target from chosen team (call when match starts) */
  Bases.prototype.applyPlayerTeam = function () {
    const target = this.getTargetBase();
    const friendly = this.getFriendlyBase();
    if (!target || !friendly) return;

    this.won = false;
    this.lost = false;
    [this.allyBase, this.enemyBase].forEach((b) => {
      if (!b) return;
      b.userData.destroyed = false;
      b.userData.coreHp = CORE_MAX_HP;
      b.userData.coreMaxHp = CORE_MAX_HP;
      b.userData.targetable = false;
      if (b.userData.core) b.userData.core.visible = true;
    });

    target.userData.targetable = true;
    friendly.userData.targetable = false;

    const origin = target.position;
    this.world._objective = origin.clone().add(new THREE.Vector3(0, 9, 0));

    const label = this.getTargetLabel();
    if (global.VF.UI) {
      // Left bar = blue (allyBase), right bar = red (enemyBase) — fixed colors
      global.VF.UI.setHomeCoreLabel('蓝方核心');
      global.VF.UI.setMissionTargetLabel('红方核心');
      if (this.allyBase) {
        global.VF.UI.updateHomeCore(this.allyBase.userData.coreHp, CORE_MAX_HP);
      }
      if (this.enemyBase) {
        global.VF.UI.updateMissionCore(this.enemyBase.userData.coreHp, CORE_MAX_HP);
      }
      if (global.VF.UI.els && global.VF.UI.els.objective) {
        global.VF.UI.els.objective.textContent = '摧毁' + label;
      }
    }
  };

  /**
   * Damage a crystal based on attacker faction (ally=blue → red core, enemy=red → blue core).
   */
  Bases.prototype.damageCoreByAttacker = function (attackerTeam, dmg) {
    if (this.won || this.lost) return false;
    const base = attackerTeam === 'enemy' ? this.allyBase : this.enemyBase;
    const pvp = global.VF.game && global.VF.game.mode === 'pvp' && global.VF.Pvp;
    // Guest forwards crystal damage to host (host is HP authority)
    if (pvp && global.VF.Pvp.mode === 'guest') {
      if (base && dmg > 0) this._playCoreHitFx(base, dmg);
      global.VF.Pvp.sendCoreDamage(attackerTeam, dmg);
      return false;
    }
    return this._applyCoreDamage(attackerTeam, dmg);
  };

  /** Host / PVE: apply damage to the crystal attacked by attackerTeam. */
  Bases.prototype._applyCoreDamage = function (attackerTeam, dmg) {
    if (this.won || this.lost) return false;
    const base = attackerTeam === 'enemy' ? this.allyBase : this.enemyBase;
    if (!base || base.userData.destroyed) return false;

    base.userData.coreHp = Math.max(0, base.userData.coreHp - dmg);
    if (dmg > 0) this._playCoreHitFx(base, dmg);

    this._refreshCoreHud();

    if (base.userData.coreHp <= 0) {
      this._onCoreDestroyed(base);
      return true;
    }
    return false;
  };

  /** Hit feedback: crystal sheds many falling debris chunks. */
  Bases.prototype._playCoreHitFx = function (base, dmg) {
    if (!base || !this.scene) return;
    const core = base.userData.core;
    if (!core || !core.visible) return;

    const pos = new THREE.Vector3();
    core.getWorldPosition(pos);
    const team = base.userData.team;
    const cols =
      team === 'ally'
        ? [0x3a7ad4, 0x6ab0ff, 0xa8d4ff, 0xffffff, 0x2a5088]
        : [0xc42828, 0xff5533, 0xff8866, 0xffcc88, 0x8a2020];
    const strength = Math.min(1.8, 0.6 + (dmg || 10) / 35);

    core.traverse(function (c) {
      if (c.isMesh && c.material && c.material.emissive) {
        c.material.emissiveIntensity = 3.6;
      }
    });
    base.userData.hitFlash = 0.22;
    base.userData.hitPunch = 0.12 * strength;

    const debris = [];
    const count = 40 + Math.floor(36 * strength);
    for (let i = 0; i < count; i++) {
      const s = 0.28 + Math.random() * 0.72;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(s, s * (0.65 + Math.random() * 0.7), s * (0.55 + Math.random() * 1.1)),
        new THREE.MeshLambertMaterial({
          color: cols[(Math.random() * cols.length) | 0],
          emissive: cols[1],
          emissiveIntensity: 0.35 + Math.random() * 0.45,
          transparent: true,
          opacity: 1,
        })
      );
      mesh.position.set(
        pos.x + (Math.random() - 0.5) * 4.2,
        pos.y + (Math.random() - 0.5) * 3.4,
        pos.z + (Math.random() - 0.5) * 4.2
      );
      mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      this.scene.add(mesh);
      debris.push({
        mesh: mesh,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * (9 + 7 * strength),
          2 + Math.random() * 6,
          (Math.random() - 0.5) * (9 + 7 * strength)
        ),
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 10,
          (Math.random() - 0.5) * 10,
          (Math.random() - 0.5) * 10
        ),
        life: 1.2 + Math.random() * 1.0,
        groundY: pos.y - 6.5,
      });
    }

    if (!this._hitFx) this._hitFx = [];
    this._hitFx.push({
      debris: debris,
      life: 2.0,
      maxLife: 2.0,
      strength: strength,
    });

    const player = global.VF.game && global.VF.game.player;
    if (player && player.object) {
      const dist = player.object.position.distanceTo(pos);
      if (player.addShake && dist < 80) {
        player.addShake(0.045 * strength * (1 - dist / 80));
      }
    }
    if (global.VF.UI && global.VF.UI.pulseCoreHit) {
      global.VF.UI.pulseCoreHit(base === this.allyBase ? 'home' : 'enemy');
    }
    if (global.VF.Audio && global.VF.Audio.play) {
      global.VF.Audio.play(Math.random() < 0.5 ? 'impact' : 'break_block');
    }
  };

  Bases.prototype._refreshCoreHud = function () {
    if (global.VF.Conquest && global.VF.Conquest.active) return;
    if (!global.VF.UI) return;
    // Fixed: left=blue(ally), right=red(enemy)
    if (this.allyBase) {
      global.VF.UI.updateHomeCore(this.allyBase.userData.coreHp, CORE_MAX_HP);
    }
    if (this.enemyBase) {
      global.VF.UI.updateMissionCore(this.enemyBase.userData.coreHp, CORE_MAX_HP);
    }
  };

  /** Apply authoritative HP from PVP host. */
  Bases.prototype.applyPvpCoreHp = function (allyHp, enemyHp) {
    if (this.allyBase) {
      this.allyBase.userData.coreHp = Math.max(0, allyHp);
      if (allyHp <= 0 && !this.allyBase.userData.destroyed) {
        this._destroyCoreVisual(this.allyBase);
      }
    }
    if (this.enemyBase) {
      this.enemyBase.userData.coreHp = Math.max(0, enemyHp);
      if (enemyHp <= 0 && !this.enemyBase.userData.destroyed) {
        this._destroyCoreVisual(this.enemyBase);
      }
    }
    this._refreshCoreHud();
  };

  Bases.prototype._destroyCoreVisual = function (base) {
    if (!base || base.userData.destroyed) return;
    base.userData.destroyed = true;
    const core = base.userData.core;
    const p = new THREE.Vector3();
    if (core) {
      core.getWorldPosition(p);
      // Final shatter burst of debris, then delayed explosion
      this._playCoreHitFx(base, 80);
      core.visible = false;
    }
    const self = this;
    setTimeout(function () {
      self._spawnExplosion(p);
    }, 280);
  };

  Bases.prototype.raycastEnemyCore = function (origin, dir, range) {
    const base = this.getTargetBase();
    if (!base || base.userData.destroyed || !base.userData.targetable) return null;
    const core = base.userData.core;
    const center = new THREE.Vector3();
    core.getWorldPosition(center);
    const to = center.clone().sub(origin);
    const proj = to.dot(dir);
    if (proj < 0.5 || proj > range) return null;
    const closest = origin.clone().addScaledVector(dir, proj);
    if (closest.distanceTo(center) < 6.2) {
      return { point: closest, dist: proj };
    }
    return null;
  };

  Bases.prototype.damageEnemyCore = function (dmg) {
    if (this.won || this.lost) return false;
    const attacker = this.world._playerTeam || 'ally';
    return this.damageCoreByAttacker(attacker, dmg);
  };

  Bases.prototype._onCoreDestroyed = function (base) {
    if (!base || base.userData.destroyed) {
      // already visually destroyed — still allow PVP winner declare once
    } else {
      this._destroyCoreVisual(base);
    }

    const conquest = global.VF.Conquest && global.VF.Conquest.active;
    const pvp = global.VF.game && global.VF.game.mode === 'pvp' && global.VF.Pvp;
    if (conquest) {
      if (global.VF.UI && global.VF.UI.toast) {
        global.VF.UI.toast('核心已摧毁 · 胜负仍由票数决定');
      }
      return;
    }
    if (pvp) {
      // Destroyed core's faction loses → opposite team wins
      const winner = base.userData.team === 'ally' ? 'enemy' : 'ally';
      const winLabel = winner === 'ally' ? '蓝方' : '红方';
      const lostLabel = base.userData.team === 'ally' ? '蓝方核心' : '红方核心';
      global.VF.Pvp.declareWinner(winner, winLabel + '摧毁了' + lostLabel);
      return;
    }

    const isPlayerWin = base === this.getTargetBase();
    if (isPlayerWin) {
      this.won = true;
      const label = this.getTargetLabel();
      let sub = label + '已摧毁';
      if (global.VF.Economy && global.VF.Economy.grantMatchReward) {
        const reward = global.VF.Economy.grantMatchReward('pve', true);
        const line =
          global.VF.Economy.formatRewardLine && global.VF.Economy.formatRewardLine(reward);
        if (line) sub = sub + ' · ' + line;
      }
      if (global.VF.UI) {
        this._refreshCoreHud();
        global.VF.UI.showVictory('任务完成', sub);
      }
    } else {
      this.lost = true;
      const ownLabel = this.getFriendlyLabel();
      let sub = ownLabel + '已被摧毁';
      if (global.VF.Economy && global.VF.Economy.grantMatchReward) {
        const reward = global.VF.Economy.grantMatchReward('pve', false);
        const line =
          global.VF.Economy.formatRewardLine && global.VF.Economy.formatRewardLine(reward);
        if (line) sub = sub + ' · ' + line;
      }
      if (global.VF.UI) {
        this._refreshCoreHud();
        global.VF.UI.showVictory('任务失败', sub);
      }
    }
  };

  Bases.prototype._destroyTargetCore = function (base) {
    this._onCoreDestroyed(base || this.getTargetBase());
  };

  Bases.prototype._destroyEnemyCore = function () {
    this._onCoreDestroyed(this.getTargetBase());
  };

  Bases.prototype._spawnExplosion = function (p) {
    const scene = this.scene;
    const light = new THREE.PointLight(0xff6622, 14, 70);
    light.position.copy(p);
    scene.add(light);

    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(2.4, 12, 12),
      new THREE.MeshBasicMaterial({
        color: 0xffe8a0,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    flash.position.copy(p);
    scene.add(flash);

    const fire = new THREE.Mesh(
      new THREE.SphereGeometry(3.2, 10, 10),
      new THREE.MeshBasicMaterial({
        color: 0xff5522,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    fire.position.copy(p);
    scene.add(fire);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.2, 4.5, 36),
      new THREE.MeshBasicMaterial({
        color: 0xffaa44,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(p.x, p.y - 0.3, p.z);
    scene.add(ring);

    const parts = [];
    for (let i = 0; i < 80; i++) {
      const s = 0.32 + Math.random() * 0.7;
      const geo = new THREE.BoxGeometry(s, s, s * (0.7 + Math.random()));
      const mat = new THREE.MeshBasicMaterial({
        color: i % 3 === 0 ? 0xff4422 : i % 3 === 1 ? 0xffaa44 : 0xff8855,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(p);
      scene.add(mesh);
      parts.push({
        mesh: mesh,
        geo: geo,
        mat: mat,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 22,
          Math.random() * 16 + 6,
          (Math.random() - 0.5) * 22
        ),
        spin: (Math.random() - 0.5) * 12,
        life: 1.4 + Math.random() * 0.8,
      });
    }

    if (global.VF.Audio && global.VF.Audio.play) {
      global.VF.Audio.play('explosion');
    }
    const player = global.VF.game && global.VF.game.player;
    if (player && player.addShake && player.object) {
      const d = player.object.position.distanceTo(p);
      if (d < 110) player.addShake(0.22 * (1 - d / 110));
    }

    const start = performance.now();
    const tick = function () {
      const dt = 0.016;
      const age = (performance.now() - start) / 1000;
      const u = Math.min(1, age / 0.55);
      flash.scale.setScalar(1 + u * 4);
      flash.material.opacity = Math.max(0, 1 - u);
      fire.scale.setScalar(1 + u * 3.2);
      fire.material.opacity = Math.max(0, 0.9 - u * 0.95);
      ring.scale.set(1 + u * 5, 1, 1 + u * 5);
      ring.material.opacity = Math.max(0, 0.8 * (1 - u));

      for (let i = parts.length - 1; i >= 0; i--) {
        const o = parts[i];
        o.life -= dt;
        o.vel.y -= 22 * dt;
        o.mesh.position.addScaledVector(o.vel, dt);
        o.mesh.rotation.x += o.spin * dt;
        o.mesh.rotation.z += o.spin * 0.7 * dt;
        if (o.life <= 0) {
          scene.remove(o.mesh);
          o.geo.dispose();
          o.mat.dispose();
          parts.splice(i, 1);
        }
      }
      light.intensity *= 0.9;
      if (parts.length > 0 && performance.now() - start < 2800) {
        requestAnimationFrame(tick);
      } else {
        scene.remove(light);
        scene.remove(flash);
        flash.geometry.dispose();
        flash.material.dispose();
        scene.remove(fire);
        fire.geometry.dispose();
        fire.material.dispose();
        scene.remove(ring);
        ring.geometry.dispose();
        ring.material.dispose();
        for (let i = 0; i < parts.length; i++) {
          scene.remove(parts[i].mesh);
          parts[i].geo.dispose();
          parts[i].mat.dispose();
        }
      }
    };
    requestAnimationFrame(tick);
  };

  Bases.prototype._hideAllCaptureHuds = function () {
    const list = (this.world && this.world._spawnPoints && this.world._spawnPoints.all) || [];
    for (let i = 0; i < list.length; i++) {
      const mesh = list[i].mesh;
      const hud = mesh && mesh.userData.captureHud;
      if (hud && hud.sprite) hud.sprite.visible = false;
    }
  };

  Bases.prototype._updateSpawnCapture = function (dt) {
    const g = global.VF && global.VF.game;
    const player = g && g.player;
    const w = this.world;
    if (!g || !g.running || !player || !player.object || player.dead) {
      if (global.VF.UI && global.VF.UI.setInteractHint && this._captureHintOn) {
        global.VF.UI.setInteractHint(false);
        this._captureHintOn = false;
      }
      this._hideAllCaptureHuds();
      return;
    }
    const team = player.team || w._playerTeam;
    if (!team || !w._spawnPoints || !w._spawnPoints.all) return;

    const px = player.object.position.x;
    const pz = player.object.position.z;
    let hintSpawn = null;

    for (let i = 0; i < w._spawnPoints.all.length; i++) {
      const s = w._spawnPoints.all[i];
      // Home base spawn #1 / large core: attack only, never capture
      if (s.fixed || s.capturable === false) {
        s.captureT = 0;
        continue;
      }
      const range = s.range != null ? s.range : SPAWN_RANGE;
      const dx = px - s.x;
      const dz = pz - s.z;
      const inRange = dx * dx + dz * dz < range * range;

      if (s.team === team) {
        s.captureT = 0;
      } else if (inRange) {
        s.captureT = (s.captureT || 0) + dt;
        hintSpawn = s;
        if (s.captureT >= SPAWN_CAPTURE_SEC) {
          this._flipSpawnTeam(s, team);
          if (global.VF.UI && global.VF.UI.setInteractHint) {
            global.VF.UI.setInteractHint(false);
            this._captureHintOn = false;
          }
          return;
        }
      } else {
        s.captureT = 0;
      }

      const mesh = s.mesh;
      const t = Math.max(0, Math.min(1, (s.captureT || 0) / SPAWN_CAPTURE_SEC));
      if (mesh && mesh.userData.captureRingMat) {
        mesh.userData.captureRingMat.opacity = t * 0.85;
        if (mesh.userData.rangeRingMat) {
          mesh.userData.rangeRingMat.opacity = 0.55 + t * 0.35;
        }
        if (mesh.userData.rangeDiscMat) {
          mesh.userData.rangeDiscMat.opacity = 0.16 + t * 0.28;
        }
      }
      // Overhead circular progress HUD
      const hud = mesh && mesh.userData.captureHud;
      if (hud && hud.sprite) {
        const show = t > 0.001 && s.team !== team;
        hud.sprite.visible = show;
        if (show) {
          drawCaptureProgressHud(hud, t, s.captureT || 0, SPAWN_CAPTURE_SEC);
          const cam = g.camera;
          if (cam) hud.sprite.quaternion.copy(cam.quaternion);
        }
      }
    }

    if (hintSpawn && global.VF.UI && global.VF.UI.setInteractHint) {
      const sec = Math.floor(hintSpawn.captureT || 0);
      global.VF.UI.setInteractHint(
        true,
        '占领中 ' + sec + '/' + SPAWN_CAPTURE_SEC + ' · ' + (hintSpawn.label || '')
      );
      this._captureHintOn = true;
    } else if (this._captureHintOn && global.VF.UI && global.VF.UI.setInteractHint) {
      global.VF.UI.setInteractHint(false);
      this._captureHintOn = false;
    }
  };

  Bases.prototype.update = function (dt) {
    this._updateSpawnCapture(dt);

    // Falling crystal debris from hits
    if (this._hitFx && this._hitFx.length) {
      for (let i = this._hitFx.length - 1; i >= 0; i--) {
        const fx = this._hitFx[i];
        fx.life -= dt;
        if (fx.debris) {
          for (let s = fx.debris.length - 1; s >= 0; s--) {
            const sp = fx.debris[s];
            sp.life -= dt;
            sp.vel.y -= 26 * dt;
            sp.mesh.position.addScaledVector(sp.vel, dt);
            sp.mesh.rotation.x += sp.spin.x * dt;
            sp.mesh.rotation.y += sp.spin.y * dt;
            sp.mesh.rotation.z += sp.spin.z * dt;
            // Settle on ground-ish under the core
            if (sp.mesh.position.y < sp.groundY) {
              sp.mesh.position.y = sp.groundY;
              sp.vel.y *= -0.25;
              sp.vel.x *= 0.7;
              sp.vel.z *= 0.7;
            }
            if (sp.mesh.material) {
              const fade = Math.max(0, Math.min(1, sp.life / 0.5));
              if (sp.mesh.material.opacity != null) sp.mesh.material.opacity = fade;
              if (sp.mesh.material.emissiveIntensity != null) {
                sp.mesh.material.emissiveIntensity = 0.15 + 0.4 * fade;
              }
            }
            if (sp.life <= 0) {
              this.scene.remove(sp.mesh);
              if (sp.mesh.geometry) sp.mesh.geometry.dispose();
              if (sp.mesh.material) sp.mesh.material.dispose();
              fx.debris.splice(s, 1);
            }
          }
        }
        if (fx.life <= 0 || (fx.debris && fx.debris.length === 0)) {
          if (fx.debris) {
            for (let s = 0; s < fx.debris.length; s++) {
              this.scene.remove(fx.debris[s].mesh);
              fx.debris[s].mesh.geometry.dispose();
              fx.debris[s].mesh.material.dispose();
            }
          }
          this._hitFx.splice(i, 1);
        }
      }
    }

    [this.allyBase, this.enemyBase].forEach((b) => {
      if (!b || b.userData.destroyed) return;
      const core = b.userData.core;
      if (!core) return;
      core.rotation.y += dt * 0.55;
      let y = 9.2 + Math.sin(performance.now() * 0.0012) * 0.45;
      if (b.userData.hitFlash != null && b.userData.hitFlash > 0) {
        b.userData.hitFlash -= dt;
        y += Math.sin(b.userData.hitFlash * 40) * 0.12;
        const punch = b.userData.hitPunch || 0;
        const u = Math.max(0, b.userData.hitFlash / 0.22);
        core.scale.setScalar(1 + punch * u);
        core.traverse(function (c) {
          if (c.isMesh && c.material && c.material.emissive) {
            c.material.emissiveIntensity = 1.2 + 2.4 * u;
          }
        });
        if (b.userData.hitFlash <= 0) {
          core.scale.setScalar(1);
          core.traverse(function (c) {
            if (c.isMesh && c.material && c.material.emissive) {
              c.material.emissiveIntensity = c.material.opacity > 0.75 ? 2.2 : 1.5;
            }
          });
        }
      }
      core.position.y = y;
    });
  };

  global.VF = global.VF || {};
  global.VF.Bases = Bases;
  global.VF.CORE_MAX_HP = CORE_MAX_HP;
  global.VF.SPAWN_RANGE = SPAWN_RANGE;
  global.VF.createBase = createBase;
})(window);
