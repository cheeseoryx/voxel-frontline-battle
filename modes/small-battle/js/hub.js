/**
 * hub.js — 3D lobby (局内废墟城风格)
 * 混色旧楼 · 弯曲天桥 · 载具/防御塔/墙 · 建筑碰撞
 */
(function (global) {
  'use strict';

  const HUB_SIZE = 120;
  const MOVE_SPEED = 8.5;
  const LOOK_SENS = 0.0022;
  const CAM_FOV = 70;
  const PLAYER_R = 0.45;

  const C = {
    asphalt: 0x4a4e56,
    road: 0x535860,
    concrete: 0xb8b3a8,
    concreteDk: 0x8a8680,
    stone: 0x8e8f8c,
    brick: 0xb45a44,
    brickDk: 0x7a382c,
    brickLt: 0xc87864,
    plaster: 0xe6e0d4,
    plasterDk: 0xc8c0b4,
    metal: 0x66758a,
    metalDk: 0x3e4854,
    glass: 0x8ec4d8,
    roof: 0x7a5844,
    dirt: 0x8a7354,
    rubble: 0x7a7266,
    rust: 0xa85a2e,
    rustLt: 0xc07040,
    olive: 0x4a5a32,
    oliveDk: 0x324022,
  };

  const BUILDINGS = [
    {
      id: 'tower',
      label: '设计防御塔',
      labelEn: 'TOWER',
      x: -24,
      z: -26,
      w: 14,
      d: 14,
      floors: 5,
      style: 'mid',
      accent: 0x7eb8ff,
    },
    {
      id: 'pvp',
      label: '多人 PVP',
      labelEn: 'PVP',
      x: -24,
      z: 18,
      w: 16,
      d: 18,
      floors: 6,
      style: 'brick',
      accent: 0xff6a4a,
    },
    {
      id: 'materials',
      label: '方块建材',
      labelEn: 'CRAFT',
      x: 24,
      z: -28,
      w: 12,
      d: 12,
      floors: 4,
      style: 'factory',
      accent: 0x6dff9a,
    },
    {
      id: 'weapons',
      label: '建造武器',
      labelEn: 'ARMS',
      x: 24,
      z: -6,
      w: 12,
      d: 12,
      floors: 5,
      style: 'mid',
      accent: 0xffd06a,
    },
    {
      id: 'pve',
      label: '单人 PVE',
      labelEn: 'CAMPAIGN',
      x: 26,
      z: 20,
      w: 20,
      d: 22,
      floors: 8,
      style: 'sky',
      accent: 0x4ac8ff,
    },
    {
      id: 'range',
      label: '射击靶场',
      labelEn: 'RANGE',
      x: -24,
      z: -4,
      w: 14,
      d: 14,
      floors: 4,
      style: 'factory',
      accent: 0xe8a040,
    },
  ];

  function Hub() {
    this.open = false;
    this.paused = false;
    this.scene = null;
    this.camera = null;
    this.player = null;
    this.yaw = 0;
    this.pitch = 0;
    this.keys = {};
    this.locked = false;
    this._near = null;
    this._handlers = {};
    this._bound = false;
    this.colliders = [];
    this.zones = [];
    this._mats = {};
    this._spin = [];
  }

  Hub.prototype.init = function (renderer) {
    this.renderer = renderer;
    this._buildScene();
    this._bindInput();
    this._ensureHud();
    this._ensureCraftUIs();
  };

  Hub.prototype._noise = function (x, y, z) {
    const n = Math.sin(x * 12.9898 + y * 78.233 + (z || 0) * 37.719) * 43758.5453;
    return n - Math.floor(n);
  };

  Hub.prototype._mat = function (hex) {
    const key = hex | 0;
    if (!this._mats[key]) {
      this._mats[key] = new THREE.MeshLambertMaterial({ color: hex });
    }
    return this._mats[key];
  };

  Hub.prototype._box = function (w, h, d, color, x, y, z, parent) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this._mat(color));
    mesh.position.set(x, y, z);
    (parent || this.scene).add(mesh);
    return mesh;
  };

  /** Axis-aligned footprint collider (ground-level walk blocking) */
  Hub.prototype._addCollider = function (minX, maxX, minZ, maxZ) {
    this.colliders.push({
      minX: minX,
      maxX: maxX,
      minZ: minZ,
      maxZ: maxZ,
    });
  };

  /** True if (x,z) sits inside any building / solid footprint */
  Hub.prototype._inSolidFootprint = function (x, z, pad) {
    pad = pad != null ? pad : 0.6;
    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i];
      if (
        x + pad > c.minX &&
        x - pad < c.maxX &&
        z + pad > c.minZ &&
        z - pad < c.maxZ
      ) {
        return true;
      }
    }
    return false;
  };

  Hub.prototype._wallTone = function (style, x, y, z) {
    const n = this._noise(x * 1.7, y * 2.1, z * 1.3);
    const n2 = this._noise(x + 9, y + 3, z + 2);
    if (style === 'brick') {
      if (n > 0.82) return C.brickDk;
      if (n > 0.55) return C.brick;
      if (n > 0.32) return C.brickLt;
      if (n2 > 0.6) return C.plasterDk;
      return C.rust;
    }
    if (style === 'factory') {
      if (n > 0.7) return C.rust;
      if (n > 0.4) return C.rustLt;
      if (n2 > 0.5) return C.metalDk;
      return C.metal;
    }
    if (style === 'sky') {
      if (n > 0.75) return C.concreteDk;
      if (n > 0.4) return C.concrete;
      if (n2 > 0.65) return C.stone;
      return C.metal;
    }
    // mid / plaster ruin
    if (n > 0.78) return C.brick;
    if (n > 0.5) return C.plaster;
    if (n > 0.28) return C.plasterDk;
    return C.concreteDk;
  };

  Hub.prototype._buildScene = function () {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xc45a28);
    scene.fog = new THREE.Fog(0xb85a32, 42, 135);
    this.scene = scene;
    this.colliders = [];
    this.zones = [];
    this._mats = {};
    this._spin = [];

    this.camera = new THREE.PerspectiveCamera(
      CAM_FOV,
      window.innerWidth / window.innerHeight,
      0.12,
      220
    );

    scene.add(new THREE.AmbientLight(0xffc9a0, 0.68));
    const sun = new THREE.DirectionalLight(0xff8c4a, 0.95);
    sun.position.set(-45, 55, 18);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0x4466aa, 0.22);
    fill.position.set(35, 22, -30);
    scene.add(fill);

    this._buildGroundAndRoad();
    this._buildSkyline();
    this._buildMidRuins();
    this._buildDefensePerimeter();

    this._hubBuildings = [];
    for (let i = 0; i < BUILDINGS.length; i++) {
      this._buildHubBuilding(BUILDINGS[i]);
      this._hubBuildings.push(BUILDINGS[i]);
    }

    this._buildCurvedSkyBridges();
    this._buildVehiclesAndProps();

    this.player = new THREE.Object3D();
    this.player.position.set(0, 0, 36);
    scene.add(this.player);

    // yaw 0 = look -Z into the hub (from south spawn)
    this.yaw = 0;
    this.pitch = 0;
  };

  Hub.prototype._buildGroundAndRoad = function () {
    this._box(HUB_SIZE, 1.2, HUB_SIZE, C.stone, 0, -0.6, 0);
    for (let i = 0; i < 28; i++) {
      const x = (this._noise(i, 1, 2) - 0.5) * (HUB_SIZE - 18);
      const z = (this._noise(i, 3, 4) - 0.5) * (HUB_SIZE - 18);
      if (Math.abs(x) < 7) continue;
      this._box(2 + this._noise(i, 5, 6) * 5, 0.14, 2 + this._noise(i, 7, 8) * 4, C.dirt, x, 0.05, z);
    }
    for (let i = 0; i < 20; i++) {
      const x = (this._noise(i + 20, 1, 2) - 0.5) * (HUB_SIZE - 22);
      const z = (this._noise(i + 20, 3, 4) - 0.5) * (HUB_SIZE - 22);
      if (Math.abs(x) < 8) continue;
      this._box(0.9 + this._noise(i, 9, 1), 0.4 + this._noise(i, 2, 3) * 0.8, 0.9, C.rubble, x, 0.3, z);
    }

    this._box(8.5, 0.12, HUB_SIZE - 8, C.asphalt, 0, 0.05, 0);
    this._box(1.3, 0.14, HUB_SIZE - 8, C.road, -3.4, 0.06, 0);
    this._box(1.3, 0.14, HUB_SIZE - 8, C.road, 3.4, 0.06, 0);
    for (let z = -52; z <= 52; z += 5) {
      this._box(0.4, 0.13, 2.2, 0xc8b060, 0, 0.1, z);
    }
    this._box(3.6, 0.18, HUB_SIZE - 10, C.concrete, -6.4, 0.08, 0);
    this._box(3.6, 0.18, HUB_SIZE - 10, C.concrete, 6.4, 0.08, 0);

    const half = HUB_SIZE / 2;
    const rim = 0x1a1c22;
    this._box(HUB_SIZE, 3.5, 1.4, rim, 0, 1.6, -half + 0.7);
    this._box(HUB_SIZE, 3.5, 1.4, rim, 0, 1.6, half - 0.7);
    this._box(1.4, 3.5, HUB_SIZE, rim, -half + 0.7, 1.6, 0);
    this._box(1.4, 3.5, HUB_SIZE, rim, half - 0.7, 1.6, 0);
    this._addCollider(-half, half, -half, -half + 1.5);
    this._addCollider(-half, half, half - 1.5, half);
    this._addCollider(-half, -half + 1.5, -half, half);
    this._addCollider(half - 1.5, half, -half, half);

    // Canal strip
    this._box(HUB_SIZE - 24, 0.35, 6, 0x2a5a7a, 0, -0.08, 52);
    this._box(16, 0.55, 7, C.concrete, 0, 0.22, 52);
  };

  Hub.prototype._buildSkyline = function () {
    const towers = [
      { x: -48, z: -44, w: 10, d: 10, floors: 12, style: 'sky' },
      { x: -54, z: -28, w: 7, d: 8, floors: 9, style: 'brick' },
      { x: -52, z: -10, w: 9, d: 9, floors: 11, style: 'mid' },
      { x: -46, z: 8, w: 8, d: 8, floors: 8, style: 'brick' },
      { x: -54, z: 22, w: 10, d: 9, floors: 13, style: 'sky' },
      { x: -50, z: 38, w: 11, d: 10, floors: 12, style: 'sky' },
      { x: -44, z: 52, w: 8, d: 8, floors: 8, style: 'factory' },
      { x: 48, z: -48, w: 9, d: 9, floors: 11, style: 'mid' },
      { x: 54, z: -32, w: 8, d: 7, floors: 9, style: 'brick' },
      { x: 52, z: -14, w: 10, d: 8, floors: 12, style: 'sky' },
      { x: 50, z: 4, w: 12, d: 10, floors: 14, style: 'sky' },
      { x: 54, z: 20, w: 8, d: 9, floors: 10, style: 'mid' },
      { x: 46, z: 36, w: 9, d: 9, floors: 9, style: 'brick' },
      { x: 50, z: 52, w: 8, d: 10, floors: 8, style: 'factory' },
      { x: -18, z: -54, w: 7, d: 7, floors: 9, style: 'mid' },
      { x: 0, z: -56, w: 6, d: 6, floors: 7, style: 'brick' },
      { x: 18, z: -54, w: 8, d: 6, floors: 8, style: 'sky' },
      { x: -18, z: 56, w: 7, d: 8, floors: 10, style: 'sky' },
      { x: 2, z: 58, w: 6, d: 6, floors: 7, style: 'factory' },
      { x: 20, z: 56, w: 9, d: 7, floors: 11, style: 'mid' },
      { x: -58, z: 4, w: 7, d: 7, floors: 7, style: 'brick' },
      { x: 58, z: -6, w: 7, d: 8, floors: 8, style: 'factory' },
      { x: -36, z: -52, w: 6, d: 6, floors: 6, style: 'mid' },
      { x: 36, z: -52, w: 6, d: 7, floors: 7, style: 'brick' },
    ];
    for (let i = 0; i < towers.length; i++) {
      const t = towers[i];
      if (this._inSolidFootprint(t.x, t.z, Math.max(t.w, t.d) * 0.4)) continue;
      this._voxelShell(t.x, t.z, t.w, t.d, t.floors, t.style, false);
    }
  };

  /** Closer ruined blocks between skyline and hub buildings */
  Hub.prototype._buildMidRuins = function () {
    const ruins = [
      { x: -34, z: -8, w: 6, d: 6, floors: 4, style: 'brick' },
      { x: -36, z: 6, w: 5, d: 7, floors: 5, style: 'mid' },
      { x: -32, z: 32, w: 6, d: 5, floors: 4, style: 'factory' },
      { x: 34, z: -14, w: 6, d: 6, floors: 5, style: 'mid' },
      { x: 36, z: 10, w: 5, d: 6, floors: 4, style: 'brick' },
      { x: 34, z: 38, w: 7, d: 5, floors: 5, style: 'sky' },
      { x: -8, z: -40, w: 5, d: 5, floors: 3, style: 'brick' },
      { x: 10, z: -42, w: 5, d: 5, floors: 4, style: 'mid' },
      { x: -10, z: 44, w: 5, d: 6, floors: 4, style: 'factory' },
      { x: 12, z: 44, w: 6, d: 5, floors: 3, style: 'brick' },
    ];
    for (let i = 0; i < ruins.length; i++) {
      const r = ruins[i];
      // Keep clear of road and already-placed solids
      if (Math.abs(r.x) < 11) continue;
      if (this._overlapsHubBuilding(r.x, r.z, r.w, r.d, 2)) continue;
      if (this._inSolidFootprint(r.x, r.z, Math.max(r.w, r.d) * 0.45)) continue;
      this._voxelShell(r.x, r.z, r.w, r.d, r.floors, r.style, false);
    }
  };

  /** Rough AABB overlap vs interactive hub buildings */
  Hub.prototype._overlapsHubBuilding = function (x, z, w, d, pad) {
    pad = pad != null ? pad : 2;
    const a0 = x - w / 2 - pad;
    const a1 = x + w / 2 + pad;
    const b0 = z - d / 2 - pad;
    const b1 = z + d / 2 + pad;
    for (let i = 0; i < BUILDINGS.length; i++) {
      const b = BUILDINGS[i];
      const c0 = b.x - b.w / 2;
      const c1 = b.x + b.w / 2;
      const d0 = b.z - b.d / 2;
      const d1 = b.z + b.d / 2;
      if (a0 < c1 && a1 > c0 && b0 < d1 && b1 > d0) return true;
    }
    return false;
  };

  /**
   * neat=true: interactive hub buildings — regular windows, light weathering
   * neat=false: background ruins — more holes / broken roofs
   */
  Hub.prototype._voxelShell = function (cx, cz, w, d, floors, style, neat) {
    const floorH = 3;
    const h = floors * floorH;
    const x0 = Math.floor(cx - w / 2);
    const z0 = Math.floor(cz - d / 2);
    const x1 = x0 + w;
    const z1 = z0 + d;

    for (let x = x0; x < x1; x++) {
      for (let z = z0; z < z1; z++) {
        this._box(1, 1, 1, C.brickDk, x + 0.5, 0.5, z + 0.5);
      }
    }

    for (let y = 1; y < h; y++) {
      for (let x = x0; x < x1; x++) {
        for (let z = z0; z < z1; z++) {
          const wall = x === x0 || x === x1 - 1 || z === z0 || z === z1 - 1;
          if (!wall) continue;

          if (neat) {
            // Almost intact — tiny roof-edge wear only
            if (y > h - 2 && this._noise(x, y, z) > 0.96) continue;
          } else {
            if (y > 3 && this._noise(x, y, z) > 0.8) continue;
            if (y > h - 5 && this._noise(x + 2, y, z) > 0.52) continue;
            if (y > h * 0.4 && this._noise(x, y + 1, z + 3) > 0.88) continue;
          }

          const band = y % floorH;
          // Hub: one neat window row per floor; ruins: messier bands
          const onWin = neat ? band === 2 : band === 1 || band === 2;
          const winSlot =
            onWin &&
            ((x > x0 + 1 &&
              x < x1 - 2 &&
              (z === z0 || z === z1 - 1) &&
              (neat ? (x - x0) % 3 === 2 : x % 3 === 1)) ||
              (z > z0 + 1 &&
                z < z1 - 2 &&
                (x === x0 || x === x1 - 1) &&
                (neat ? (z - z0) % 3 === 2 : z % 3 === 1)));
          if (winSlot) {
            const glassOk = neat || this._noise(x, y + 4, z) > 0.28;
            if (glassOk) {
              this._box(1, 1, 1, C.glass, x + 0.5, y + 0.5, z + 0.5);
              continue;
            }
          }
          this._box(1, 1, 1, this._wallTone(style, x, y, z), x + 0.5, y + 0.5, z + 0.5);
        }
      }
    }

    const roofLayers = neat ? 1 : 4;
    for (let layer = 0; layer < roofLayers; layer++) {
      const y = h + layer;
      for (let x = x0 + layer; x < x1 - layer; x++) {
        for (let z = z0 + layer; z < z1 - layer; z++) {
          if (!neat && this._noise(x, y, z) > 0.68 && layer > 0) continue;
          const rc = neat
            ? C.roof
            : this._noise(x, z, layer) > 0.5
              ? C.roof
              : C.metalDk;
          this._box(1, 0.5, 1, rc, x + 0.5, y + 0.25, z + 0.5);
        }
      }
    }

    this._addCollider(x0, x1, z0, z1);
    return { x0: x0, z0: z0, x1: x1, z1: z1, h: h, cx: cx, cz: cz };
  };

  Hub.prototype._buildHubBuilding = function (b) {
    const shell = this._voxelShell(b.x, b.z, b.w, b.d, b.floors, b.style, true);
    const faceRight = b.x > 0;
    const doorX = faceRight ? shell.x0 : shell.x1 - 1;
    const doorZ = Math.floor(b.z);

    // Door recess on street face
    this._box(1.15, 2.9, 2.5, 0x121010, doorX + 0.5, 1.55, doorZ + 0.5);
    this._box(1.25, 0.4, 2.9, b.accent, doorX + 0.5, 3.15, doorZ + 0.5);

    const ax = faceRight ? shell.x0 - 2.4 : shell.x1 + 2.4;
    this._box(1.8, 0.14, 1.8, b.accent, ax, 0.12, doorZ + 0.5);
    this._box(0.55, 0.16, 1.0, 0xffe8d4, ax, 0.2, doorZ + 0.5);

    const pad = 3.4;
    this.zones.push({
      id: b.id,
      label: b.label,
      minX: faceRight ? shell.x0 - pad : shell.x1 - 0.5,
      maxX: faceRight ? shell.x0 + 0.5 : shell.x1 + pad,
      minZ: doorZ - 2.5,
      maxZ: doorZ + 3.5,
    });

    b._shell = shell;
  };

  Hub.prototype._buildCurvedSkyBridges = function () {
    // Ring of non-crossing spans (no diagonal shortcuts — those pierced other decks)
    const links = [
      { a: 'tower', b: 'materials', y: 15, amp: 5 },
      { a: 'materials', b: 'weapons', y: 14, amp: 3.5 },
      { a: 'weapons', b: 'pve', y: 16, amp: 4.5 },
      { a: 'pve', b: 'pvp', y: 17, amp: 5 },
      { a: 'pvp', b: 'tower', y: 15.5, amp: 4.5 },
    ];
    const byId = {};
    for (let i = 0; i < BUILDINGS.length; i++) byId[BUILDINGS[i].id] = BUILDINGS[i];

    for (let i = 0; i < links.length; i++) {
      const L = links[i];
      const A = byId[L.a];
      const B = byId[L.b];
      if (!A || !B) continue;
      this._curveBridge(A.x, A.z, B.x, B.z, L.y, L.amp, i);
    }
  };

  /** Continuous curved deck — abutting planks, no ground pillars (prevents pierce) */
  Hub.prototype._curveBridge = function (x0, z0, x1, z1, y, amp, seed) {
    const steps = 56;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz) || 1;
    const px = -dz / len;
    const pz = dx / len;
    const pts = [];

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const bend =
        Math.sin(t * Math.PI) * amp + Math.sin(t * Math.PI * 2.05 + seed * 0.7) * (amp * 0.18);
      pts.push({
        x: x0 + dx * t + px * bend,
        z: z0 + dz * t + pz * bend,
        y: y + Math.sin(t * Math.PI) * 0.85,
      });
    }

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const sx = b.x - a.x;
      const sz = b.z - a.z;
      const seg = Math.hypot(sx, sz) || 0.01;
      const mx = (a.x + b.x) * 0.5;
      const mz = (a.z + b.z) * 0.5;
      const my = (a.y + b.y) * 0.5;
      const nx = -sz / seg;
      const nz = sx / seg;
      const yaw = Math.atan2(sx, sz) - Math.PI / 2;
      // Slight overlap only — avoids Z-fighting gaps without stacking thick
      const plank = this._box(seg * 1.06, 0.4, 2.8, C.asphalt, mx, my, mz);
      plank.rotation.y = yaw;
      const railL = this._box(seg * 1.06, 0.45, 0.2, C.metal, mx + nx * 1.35, my + 0.5, mz + nz * 1.35);
      railL.rotation.y = yaw;
      const railR = this._box(seg * 1.06, 0.45, 0.2, C.metal, mx - nx * 1.35, my + 0.5, mz - nz * 1.35);
      railR.rotation.y = yaw;
    }
  };

  Hub.prototype._buildDefensePerimeter = function () {
    // Sandbag / concrete defense walls along road flanks (not blocking main road)
    for (let z = -40; z <= 40; z += 6) {
      if (Math.abs(z) < 8) continue;
      this._box(1.2, 1.8, 4.5, C.concrete, -9.5, 0.9, z);
      this._box(1.2, 0.4, 4.5, C.metal, -9.5, 1.95, z);
      this._box(1.2, 1.8, 4.5, C.concreteDk, 9.5, 0.9, z);
      this._box(1.2, 0.4, 4.5, C.rust, 9.5, 1.95, z);
      this._addCollider(-10.2, -8.8, z - 2.3, z + 2.3);
      this._addCollider(8.8, 10.2, z - 2.3, z + 2.3);
    }

    // Defense towers (gun nests)
    this._defenseTower(-14, -12, 0x7eb8ff);
    this._defenseTower(14, -14, 0xffd06a);
    this._defenseTower(-14, 28, 0xff6a4a);
    this._defenseTower(16, 30, 0x4ac8ff);
  };

  Hub.prototype._defenseTower = function (x, z, accent) {
    this._box(4.2, 1.2, 4.2, C.concrete, x, 0.6, z);
    this._box(3.4, 5.5, 3.4, C.concreteDk, x, 3.5, z);
    this._box(3.8, 0.5, 3.8, C.metal, x, 6.4, z);
    this._box(1.2, 1.4, 1.2, accent, x, 7.3, z);
    // Gun
    this._box(0.35, 0.35, 2.4, C.metalDk, x, 7.5, z + 1.4);
    this._addCollider(x - 2.2, x + 2.2, z - 2.2, z + 2.2);
  };

  Hub.prototype._buildVehiclesAndProps = function () {
    this._tank(-7, 8, 0.4);
    this._tank(7.5, -18, -0.9);
    this._tank(-8, -32, 1.8);
    this._heli(5, 14, 22);
    this._heli(-6, 16, -8);
    // Crates — stacked without sideways clip
    for (let i = 0; i < 8; i++) {
      const x = (i % 2 === 0 ? -11 : 11) + (this._noise(i, 1, 1) - 0.5) * 1.2;
      const z = -36 + i * 9;
      this._box(1.4, 1.2, 1.4, C.dirt, x, 0.6, z);
      this._box(1.4, 1.2, 1.4, C.roof, x, 1.8, z);
      this._addCollider(x - 0.85, x + 0.85, z - 0.85, z + 0.85);
    }
  };

  Hub.prototype._tank = function (x, z, yaw) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = yaw;
    this._box(3.6, 1.1, 2.2, C.olive, 0, 0.7, 0, g);
    this._box(2.4, 0.9, 1.8, C.oliveDk, 0, 1.55, 0, g);
    this._box(0.35, 0.35, 2.8, C.metalDk, 1.4, 1.7, 0, g);
    this._box(0.9, 0.7, 2.6, C.metal, 0, 0.35, 1.2, g);
    this._box(0.9, 0.7, 2.6, C.metal, 0, 0.35, -1.2, g);
    this.scene.add(g);
    this._addCollider(x - 2.2, x + 2.2, z - 2.0, z + 2.0);
  };

  Hub.prototype._heli = function (x, y, z) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    this._box(2.2, 1.1, 5.5, C.metal, 0, 0, 0, g);
    this._box(1.4, 0.9, 1.6, C.glass, 0, 0.3, 2.2, g);
    this._box(0.35, 0.35, 4.2, C.metalDk, 0, 0.2, -3.5, g);
    const rotor = this._box(7.5, 0.12, 0.45, C.metalDk, 0, 0.85, 0.4, g);
    this._spin.push(rotor);
    this._box(0.45, 0.12, 2.2, C.metalDk, 0, 0.5, -5.2, g);
    // Skids
    this._box(0.2, 0.2, 3.5, C.metal, 0.9, -0.9, 0.2, g);
    this._box(0.2, 0.2, 3.5, C.metal, -0.9, -0.9, 0.2, g);
    this.scene.add(g);
  };

  Hub.prototype._blocked = function (x, z) {
    const r = PLAYER_R;
    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i];
      if (x + r > c.minX && x - r < c.maxX && z + r > c.minZ && z - r < c.maxZ) return true;
    }
    return false;
  };

  Hub.prototype._tryMove = function (nx, nz) {
    const lim = HUB_SIZE / 2 - 2.5;
    nx = Math.max(-lim, Math.min(lim, nx));
    nz = Math.max(-lim, Math.min(lim, nz));
    const px = this.player.position.x;
    const pz = this.player.position.z;
    // Axis-separated resolve so corners don't swallow the player
    if (!this._blocked(nx, pz)) this.player.position.x = nx;
    else if (!this._blocked(px + (nx - px) * 0.35, pz)) {
      this.player.position.x = px + (nx - px) * 0.35;
    }
    const cx = this.player.position.x;
    if (!this._blocked(cx, nz)) this.player.position.z = nz;
    else if (!this._blocked(cx, pz + (nz - pz) * 0.35)) {
      this.player.position.z = pz + (nz - pz) * 0.35;
    }
  };

  /* ---------- HUD / craft ---------- */

  Hub.prototype._ensureHud = function () {
    if (document.getElementById('hub-overlay')) {
      this.els = {
        overlay: document.getElementById('hub-overlay'),
        prompt: document.getElementById('hub-prompt'),
        back: document.getElementById('hub-back-home'),
      };
      return;
    }
    const el = document.createElement('div');
    el.id = 'hub-overlay';
    el.className = 'hidden';
    el.innerHTML =
      '<div class="hub-top">' +
      '<div class="hub-title">前线基地</div>' +
      '<div class="hub-sub">看门口大牌 · 走近按 <kbd>E</kbd></div>' +
      '</div>' +
      '<div id="hub-prompt" class="hub-prompt hidden"></div>' +
      '<div class="hub-bottom">' +
      '<button type="button" id="hub-back-home" class="cover-btn">返回首页</button>' +
      '<span class="hub-hint"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 移动 · 鼠标视角</span>' +
      '</div>';
    document.body.appendChild(el);
    this.els = {
      overlay: el,
      prompt: document.getElementById('hub-prompt'),
      back: document.getElementById('hub-back-home'),
    };
    this.els.back.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeToHome();
    });
  };

  Hub.prototype._ensureCraftUIs = function () {
    if (!document.getElementById('weapon-craft-overlay')) {
      const w = document.createElement('div');
      w.id = 'weapon-craft-overlay';
      w.className = 'hidden craft-overlay';
      w.innerHTML =
        '<div class="craft-panel start-panel">' +
        '<h1>建造武器</h1>' +
        '<p class="subtitle">前线币解锁 · 永久拥有</p>' +
        '<div class="craft-grid" id="weapon-craft-list"></div>' +
        '<p id="weapon-craft-msg" class="craft-msg"></p>' +
        '<div class="pvp-actions">' +
        '<button type="button" id="weapon-craft-do" class="cover-btn cover-btn-start">制造</button>' +
        '<button type="button" id="weapon-craft-back" class="cover-btn">返回基地</button>' +
        '</div></div>';
      document.body.appendChild(w);
    }
    if (!document.getElementById('material-craft-overlay')) {
      const m = document.createElement('div');
      m.id = 'material-craft-overlay';
      m.className = 'hidden craft-overlay';
      m.innerHTML =
        '<div class="craft-panel start-panel">' +
        '<h1>方块建材</h1>' +
        '<p class="subtitle">方块单价见商店 · 防御塔前 120 币免费，超出在进入对局时从余额扣 · 补给请走大厅商城</p>' +
        '<div class="craft-qty" id="material-craft-qty">' +
        '<button type="button" class="craft-qty-btn selected" data-qty="10">10</button>' +
        '<button type="button" class="craft-qty-btn" data-qty="50">50</button>' +
        '<button type="button" class="craft-qty-btn" data-qty="100">100</button>' +
        '</div>' +
        '<div class="craft-grid" id="material-craft-list"></div>' +
        '<p id="material-craft-msg" class="craft-msg"></p>' +
        '<div class="pvp-actions">' +
        '<button type="button" id="material-craft-do" class="cover-btn cover-btn-start">购买</button>' +
        '<button type="button" id="material-craft-back" class="cover-btn">返回基地</button>' +
        '</div></div>';
      document.body.appendChild(m);
    }
    if (!document.getElementById('hub-pvp-overlay')) {
      const p = document.createElement('div');
      p.id = 'hub-pvp-overlay';
      p.className = 'hidden craft-overlay';
      p.innerHTML =
        '<div class="craft-panel start-panel">' +
        '<h1>多人 PVP</h1>' +
        '<p class="subtitle" id="hub-pvp-sub">1v1 联机对战大厅</p>' +
        '<div class="pvp-actions craft-pvp-actions">' +
        '<button type="button" id="hub-pvp-enter" class="cover-btn cover-btn-start hidden">进入联机大厅</button>' +
        '<button type="button" id="hub-pvp-create" class="cover-btn cover-btn-start">创建房间</button>' +
        '<button type="button" id="hub-pvp-join" class="cover-btn cover-btn-pvp">加入房间</button>' +
        '<button type="button" id="hub-pvp-back" class="cover-btn">返回基地</button>' +
        '</div></div>';
      document.body.appendChild(p);
    }
    this._refreshPvpModeUI();
    this._bindCraftUI();
  };

  /** Kubee: no room codes — both players open the same Kubee URL. */
  Hub.prototype._refreshPvpModeUI = function () {
    const kubee = !!(global.VF_KUBEE && global.VF_KUBEE.active);
    const enter = document.getElementById('hub-pvp-enter');
    const create = document.getElementById('hub-pvp-create');
    const join = document.getElementById('hub-pvp-join');
    const sub = document.getElementById('hub-pvp-sub');
    if (enter) enter.classList.toggle('hidden', !kubee);
    if (create) create.classList.toggle('hidden', kubee);
    if (join) join.classList.toggle('hidden', kubee);
    if (sub) {
      sub.textContent = kubee
        ? '双方打开同一 Kubee 链接后点此进入 · 先到者为房主'
        : '1v1 联机对战大厅（房号 / PeerJS）';
    }
  };

  Hub.prototype._bindCraftUI = function () {
    if (this._craftBound) return;
    this._craftBound = true;
    const weapons = [
      { id: 'sg', name: 'Remington 870', cost: '200 前线币', desc: '永久解锁 · 12ga · 热键 2' },
      { id: 'sr', name: 'SVD', cost: '350 前线币', desc: '永久解锁 · 7.62×54R · 热键 3' },
      { id: 'ar', name: 'AKM', cost: '已配备', desc: '默认免费 · 7.62×39mm · 热键 1' },
    ];
    const blockMats = function () {
      if (!global.VF.Economy || !global.VF.Economy.listBlockItems) return [];
      const qty = this._matQty || 10;
      const items = global.VF.Economy.listBlockItems().map(function (it) {
        const unit = it.unit || 0;
        return {
          id: it.id,
          stockKey: it.stockKey,
          name: it.name,
          cost: unit * qty + ' 前线币 / ' + qty + ' 格',
          desc: it.desc,
        };
      });
      const cable = global.VF.Economy.CATALOG && global.VF.Economy.CATALOG.cable;
      if (cable) {
        items.push({
          id: cable.id,
          stockKey: cable.stockKey,
          name: cable.name,
          cost: (cable.unit || 10) * qty + ' 前线币 / ' + qty + ' 根',
          desc: cable.desc,
        });
      }
      return items;
    };
    const fill = (listId, items, selectedKey) => {
      const list = document.getElementById(listId);
      if (!list) return;
      list.innerHTML = '';
      if (!items || !items.length) return;
      const prevSel = this[selectedKey];
      items.forEach((it, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className =
          'craft-item' + ((prevSel ? it.id === prevSel : idx === 0) ? ' selected' : '');
        btn.dataset.id = it.id;
        let stockHint = '';
        if (global.VF.Economy && global.VF.Economy.getMeta) {
          const meta = global.VF.Economy.getMeta();
          if (it.id === 'ar' || it.id === 'sg' || it.id === 'sr') {
            const owned =
              global.VF.Economy.ownsWeapon && global.VF.Economy.ownsWeapon(it.id);
            stockHint = owned ? ' · 已拥有' : '';
          } else if (it.id.indexOf('mod_') === 0) {
            const owned =
              global.VF.Economy.ownsModule && global.VF.Economy.ownsModule(it.id);
            stockHint = owned ? ' · 已拥有' : '';
          } else {
            const sk = it.stockKey || it.id;
            if (meta.stock && meta.stock[sk] != null) {
              stockHint = ' · 库存 ' + meta.stock[sk];
            }
          }
        }
        btn.innerHTML =
          '<strong>' +
          it.name +
          '</strong><span>' +
          it.cost +
          stockHint +
          '</span><em>' +
          it.desc +
          '</em>';
        btn.addEventListener('click', () => {
          list.querySelectorAll('.craft-item').forEach((n) => n.classList.remove('selected'));
          btn.classList.add('selected');
          this[selectedKey] = it.id;
        });
        list.appendChild(btn);
      });
      this[selectedKey] =
        prevSel && items.some((it) => it.id === prevSel) ? prevSel : items[0].id;
    };
    this._matQty = 10;
    fill('weapon-craft-list', weapons, '_weaponSel');
    fill('material-craft-list', blockMats.call(this), '_matSel');
    this._fillCraftLists = function () {
      fill('weapon-craft-list', weapons, '_weaponSel');
      fill('material-craft-list', blockMats.call(this), '_matSel');
    };
    const qtyRow = document.getElementById('material-craft-qty');
    if (qtyRow && !qtyRow._qtyBound) {
      qtyRow._qtyBound = true;
      qtyRow.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-qty]');
        if (!btn || !qtyRow.contains(btn)) return;
        this._matQty = Number(btn.getAttribute('data-qty')) || 10;
        qtyRow.querySelectorAll('.craft-qty-btn').forEach((n) => {
          n.classList.toggle('selected', n === btn);
        });
        if (this._fillCraftLists) this._fillCraftLists();
      });
    }
    const bind = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    };
    bind('weapon-craft-back', () => this.closeCraft('weapon'));
    bind('material-craft-back', () => this.closeCraft('material'));
    bind('hub-pvp-back', () => this.closeCraft('pvp'));
    bind('weapon-craft-do', () => {
      const id = this._weaponSel || 'sg';
      const msg = document.getElementById('weapon-craft-msg');
      if (id === 'ar') {
        if (msg) msg.textContent = 'AKM 为默认配备，无需购买';
        return;
      }
      if (!global.VF.Economy || !global.VF.Economy.buy) {
        if (msg) msg.textContent = '经济系统未加载';
        return;
      }
      const res = global.VF.Economy.buy(id);
      if (!res.ok) {
        if (msg) msg.textContent = res.reason || '购买失败';
        if (global.VF.UI && VF.UI.toast) VF.UI.toast(res.reason || '购买失败');
        return;
      }
      if (msg) msg.textContent = '已解锁：' + (res.item && res.item.name ? res.item.name : id);
      if (global.VF.UI && VF.UI.toast) VF.UI.toast('已解锁武器');
      if (this._fillCraftLists) this._fillCraftLists();
    });
    bind('material-craft-do', () => {
      const id = this._matSel || 'blk_stone';
      const msg = document.getElementById('material-craft-msg');
      if (!global.VF.Economy || !global.VF.Economy.buy) {
        if (msg) msg.textContent = '经济系统未加载';
        return;
      }
      const qty = this._matQty || 10;
      const res = global.VF.Economy.buy(id, qty);
      if (!res.ok) {
        if (msg) msg.textContent = res.reason || '购买失败';
        if (global.VF.UI && VF.UI.toast) VF.UI.toast(res.reason || '购买失败');
        return;
      }
      if (msg) {
        msg.textContent =
          '已购入：' +
          (res.item && res.item.name ? res.item.name : id) +
          ' ×' +
          (res.qty || qty) +
          '（库存 ' +
          (res.stock != null ? res.stock : '?') +
          '）';
      }
      if (global.VF.UI && VF.UI.toast) {
        VF.UI.toast('已入库 ×' + (res.qty || qty));
      }
      if (this._fillCraftLists) this._fillCraftLists();
    });
    bind('hub-pvp-enter', () => {
      this.closeCraft('pvp');
      this.hide();
      if (this._handlers.onPvpCreate) this._handlers.onPvpCreate();
    });
    bind('hub-pvp-create', () => {
      this.closeCraft('pvp');
      this.hide();
      if (this._handlers.onPvpCreate) this._handlers.onPvpCreate();
    });
    bind('hub-pvp-join', () => {
      this.closeCraft('pvp');
      this.hide();
      if (this._handlers.onPvpJoin) this._handlers.onPvpJoin();
    });
  };

  Hub.prototype.refreshCraftLists = function () {
    if (this._fillCraftLists) this._fillCraftLists();
  };

  Hub.prototype.openCraft = function (kind) {
    this._ensureCraftUIs();
    if (kind === 'pvp') this._refreshPvpModeUI();
    if ((kind === 'weapon' || kind === 'material') && this.refreshCraftLists) {
      this.refreshCraftLists();
    }
    this.paused = true;
    document.exitPointerLock && document.exitPointerLock();
    this.locked = false;
    const map = {
      weapon: 'weapon-craft-overlay',
      material: 'material-craft-overlay',
      pvp: 'hub-pvp-overlay',
    };
    const el = document.getElementById(map[kind]);
    if (el) el.classList.remove('hidden');
  };

  Hub.prototype.closeCraft = function (kind) {
    const map = {
      weapon: 'weapon-craft-overlay',
      material: 'material-craft-overlay',
      pvp: 'hub-pvp-overlay',
    };
    const el = document.getElementById(map[kind]);
    if (el) el.classList.add('hidden');
    this.paused = false;
    if (this.open) {
      this._requestLock();
    } else if (global.VF.Lobby && global.VF.Lobby.openLobby) {
      global.VF.Lobby.openLobby();
    }
  };

  Hub.prototype._bindInput = function () {
    if (this._bound) return;
    this._bound = true;
    window.addEventListener('keydown', (e) => {
      if (!this.open || this.paused) return;
      this.keys[e.code] = true;
      if (e.code === 'KeyE' && this._near) {
        e.preventDefault();
        this._enterZone(this._near);
      }
      if (e.code === 'Escape') {
        document.exitPointerLock && document.exitPointerLock();
        this.locked = false;
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys[e.code] = false;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.open || !this.locked || this.paused) return;
      this.yaw -= e.movementX * LOOK_SENS;
      this.pitch -= e.movementY * LOOK_SENS;
      this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch));
    });
    document.addEventListener('pointerlockchange', () => {
      if (!this.renderer) return;
      this.locked =
        document.pointerLockElement === this.renderer.domElement && this.open && !this.paused;
    });
  };

  Hub.prototype._requestLock = function () {
    if (!this.renderer || !this.open || this.paused) return;
    try {
      this.renderer.domElement.requestPointerLock();
    } catch (_) {}
  };

  Hub.prototype._enterZone = function (zone) {
    if (!zone) return;
    if (zone.id === 'pve' && this._handlers.onPve) {
      this.hide();
      this._handlers.onPve();
    } else if (zone.id === 'pvp') {
      this.openCraft('pvp');
    } else if (zone.id === 'tower' && this._handlers.onTower) {
      this.hide();
      this._handlers.onTower();
    } else if (zone.id === 'weapons') {
      this.openCraft('weapon');
    } else if (zone.id === 'materials') {
      this.openCraft('material');
    } else if (zone.id === 'range' && this._handlers.onRange) {
      this.hide();
      this._handlers.onRange();
    }
  };

  Hub.prototype.setHandlers = function (h) {
    this._handlers = h || {};
  };

  Hub.prototype.openHub = function () {
    if (!this.scene) return;
    this.open = true;
    this.paused = false;
    const cover = document.getElementById('start-overlay');
    if (cover) cover.classList.add('hidden');
    if (this.els && this.els.overlay) this.els.overlay.classList.remove('hidden');
    this.player.position.set(0, 0, 36);
    this.yaw = 0;
    this.pitch = 0;
    this._near = null;
    this._updatePrompt(null);
    setTimeout(() => this._requestLock(), 50);
    if (global.VF && global.VF.syncGameBackBtn) global.VF.syncGameBackBtn();
  };

  Hub.prototype.hide = function () {
    this.open = false;
    this.paused = false;
    this.locked = false;
    document.exitPointerLock && document.exitPointerLock();
    if (this.els && this.els.overlay) this.els.overlay.classList.add('hidden');
    ['weapon-craft-overlay', 'material-craft-overlay', 'hub-pvp-overlay'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
    if (global.VF && global.VF.syncGameBackBtn) global.VF.syncGameBackBtn();
  };

  Hub.prototype.resume = function () {
    this.open = true;
    this.paused = false;
    if (this.els && this.els.overlay) this.els.overlay.classList.remove('hidden');
    const cover = document.getElementById('start-overlay');
    if (cover) cover.classList.add('hidden');
    setTimeout(() => this._requestLock(), 40);
    if (global.VF && global.VF.syncGameBackBtn) global.VF.syncGameBackBtn();
  };

  Hub.prototype.closeToHome = function () {
    this.hide();
    if (this._handlers.onBackHome) this._handlers.onBackHome();
  };

  Hub.prototype._updatePrompt = function (zone) {
    if (!this.els || !this.els.prompt) return;
    if (!zone) {
      this.els.prompt.classList.add('hidden');
      return;
    }
    this.els.prompt.classList.remove('hidden');
    this.els.prompt.innerHTML = '按 <kbd>E</kbd> 进入 · <strong>' + zone.label + '</strong>';
  };

  Hub.prototype._zoneAt = function (x, z) {
    for (let i = 0; i < this.zones.length; i++) {
      const z0 = this.zones[i];
      if (x >= z0.minX && x <= z0.maxX && z >= z0.minZ && z <= z0.maxZ) return z0;
    }
    return null;
  };

  Hub.prototype.update = function (dt) {
    if (!this.open || this.paused || !this.player) return;

    let mx = 0;
    let mz = 0;
    if (this.keys['KeyW']) {
      mx -= Math.sin(this.yaw);
      mz -= Math.cos(this.yaw);
    }
    if (this.keys['KeyS']) {
      mx += Math.sin(this.yaw);
      mz += Math.cos(this.yaw);
    }
    if (this.keys['KeyA']) {
      mx -= Math.cos(this.yaw);
      mz += Math.sin(this.yaw);
    }
    if (this.keys['KeyD']) {
      mx += Math.cos(this.yaw);
      mz -= Math.sin(this.yaw);
    }
    const len = Math.hypot(mx, mz);
    if (len > 0.001) {
      mx = (mx / len) * MOVE_SPEED * dt;
      mz = (mz / len) * MOVE_SPEED * dt;
      this._tryMove(this.player.position.x + mx, this.player.position.z + mz);
    }

    const eye = this.player.position.clone();
    eye.y = 1.65;
    this.camera.position.copy(eye);
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));

    for (let i = 0; i < this._spin.length; i++) {
      this._spin[i].rotation.y += dt * 8;
    }

    const zone = this._zoneAt(this.player.position.x, this.player.position.z);
    if (!this._near || !zone || this._near.id !== (zone && zone.id)) {
      this._near = zone;
      this._updatePrompt(zone);
    }
  };

  Hub.prototype.render = function () {
    if (!this.open || !this.renderer || !this.scene || !this.camera) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.fov = CAM_FOV;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  };

  Hub.prototype.onResize = function () {
    if (!this.camera) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  };

  const hub = new Hub();
  global.VF = global.VF || {};
  global.VF.Hub = {
    get isOpen() {
      return !!hub.open;
    },
    get instance() {
      return hub;
    },
    init: function (renderer) {
      hub.init(renderer);
    },
    setHandlers: function (h) {
      hub.setHandlers(h);
    },
    open: function () {
      hub.openHub();
    },
    hide: function () {
      hub.hide();
    },
    resume: function () {
      hub.resume();
    },
    closeToHome: function () {
      hub.closeToHome();
    },
    update: function (dt) {
      hub.update(dt);
    },
    render: function () {
      hub.render();
    },
    onResize: function () {
      hub.onResize();
    },
    openCraft: function (kind) {
      hub.openCraft(kind);
    },
    closeCraft: function (kind) {
      hub.closeCraft(kind);
    },
    refreshCraftLists: function () {
      hub.refreshCraftLists();
    },
  };

  document.addEventListener(
    'click',
    function () {
      if (hub.open && !hub.paused && hub.renderer) hub._requestLock();
    },
    true
  );
})(window);
