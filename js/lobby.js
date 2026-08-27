/**
 * lobby.js — Transparent UI over Hub base scene; orbit drag, click props
 */
(function (global) {
  'use strict';

  const STORAGE_CLASS = 'vf_lobby_class';
  const ORBIT_DIST = 10.5;
  const ORBIT_MIN_PITCH = -0.12;
  const ORBIT_MAX_PITCH = 0.52;
  const DRAG_CLICK_PX = 6;
  /** Street-clear look-at for lobby props (south of hub center) */
  const LOOK_AT = { x: 0, y: 1.2, z: 10 };

  const LOBBY_CLASS_ORDER = [
    'assault',
    'engineer',
    'support',
    'recon',
  ];
  const LEGACY_CLASS = {
    vanguard: 'assault',
    raider: 'assault',
    medic: 'support',
    juggernaut: 'support',
    ghost: 'recon',
  };

  const SHEETS = {
    profile: {
      title: '指挥官档案',
      body:
        '<p>前线指挥官 · Lv.1</p><p>点「开始游戏」进入 32v32 征服。底部码头可进防御塔、地图、靶场与商城。</p>',
    },
    shop: {
      title: '商城',
      body: '',
    },
    settings: {
      title: '设置',
      body:
        '<p>音效：右上角喇叭开关</p><p>地图：大厅底部「地图」· 俯视搭建 / 局内编辑</p><p>开发：F10 参数调节</p><p>大厅：拖拽旋转视野 · 点击道具进入</p><p>战场：WASD 移动 · 鼠标瞄准 · G 技能 · V 冲刺</p>',
    },
  };

  // Props around LOOK_AT on open street (avoid hub building footprints)
  // materials sits behind the hero (toward far towers / -Z from facing camera)
  const PROP_DEFS = [
    { id: 'weapons', action: 'weapons', label: '建造武器', x: -5.0, z: 7.5 },
    { id: 'tower', action: 'tower', label: '设计防御塔', x: 5.0, z: 7.2 },
    { id: 'map', action: 'map', label: '地图搭建', x: -4.6, z: 13.2 },
    { id: 'range', action: 'range', label: '射击靶场', x: 4.8, z: 13.0 },
    { id: 'materials', action: 'materials', label: '方块建材', x: 0.0, z: 4.5 },
  ];

  const DEFAULT_ORBIT_YAW = 0;
  const DEFAULT_ORBIT_PITCH = 0.26;

  function box(w, h, d, color, x, y, z, parent) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshLambertMaterial({ color: color })
    );
    mesh.position.set(x, y, z);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    if (parent) parent.add(mesh);
    return mesh;
  }

  const Lobby = {
    open: false,
    _handlers: null,
    _selectedClass: 'assault',
    _world: null,
    _hintAction: null,

    setHandlers(h) {
      this._handlers = h || {};
    },

    init() {
      if (this._bound) return;
      this._bound = true;
      this.els = {
        overlay: document.getElementById('lobby-overlay'),
        worldCanvas: document.getElementById('lobby-world-canvas'),
        stageCanvas: document.getElementById('lobby-stage-canvas'),
        stageWrap: document.getElementById('lobby-stage-wrap'),
        sheet: document.getElementById('lobby-sheet'),
        sheetTitle: document.getElementById('lobby-sheet-title'),
        sheetBody: document.getElementById('lobby-sheet-body'),
        hint: document.getElementById('lobby-world-hint'),
      };
      try {
        const saved = localStorage.getItem(STORAGE_CLASS);
        const migrated = LEGACY_CLASS[saved] || saved;
        if (migrated && LOBBY_CLASS_ORDER.indexOf(migrated) >= 0) {
          this._selectedClass = migrated;
          if (migrated !== saved) localStorage.setItem(STORAGE_CLASS, migrated);
        }
      } catch (_) {}

      const root = this.els.overlay;
      if (root) {
        root.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-lobby-action]');
          if (!btn || !root.contains(btn)) return;
          this._onAction(btn.getAttribute('data-lobby-action'));
        });
      }

      if (this.els.worldCanvas) {
        const canvas = this.els.worldCanvas;
        canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
        canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
        canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
        canvas.addEventListener('pointerleave', (e) => this._onPointerUp(e));
        canvas.addEventListener('pointercancel', (e) => this._onPointerUp(e));
      }

      if (global.VF.Economy && global.VF.Economy.refreshLobbyCoins) {
        global.VF.Economy.refreshLobbyCoins();
      }
      if (this.els.sheetBody && global.VF.Economy && global.VF.Economy.bindShopClicks) {
        global.VF.Economy.bindShopClicks(this.els.sheetBody);
      }

      window.addEventListener('resize', () => {
        if (this.open && this._world) this._world.resize = true;
      });
    },

    isOpen() {
      return !!this.open;
    },

    getSelectedClassId() {
      return this._selectedClass || 'assault';
    },

    openLobby() {
      this.init();
      const o = this.els && this.els.overlay;
      if (!o) return;
      this.open = true;
      o.classList.remove('hidden');
      this._closeSheet();
      if (global.VF.Economy && global.VF.Economy.refreshLobbyCoins) {
        global.VF.Economy.refreshLobbyCoins();
      }
      this._startWorld();
      if (global.VF && global.VF.syncGameBackBtn) global.VF.syncGameBackBtn();
    },

    refreshShopSheet() {
      if (!this.els || !this.els.sheetBody) return;
      if (!global.VF.Economy || !global.VF.Economy.renderShopHtml) return;
      this.els.sheetBody.innerHTML = global.VF.Economy.renderShopHtml();
      if (this.els.sheetTitle) this.els.sheetTitle.textContent = '商城';
    },

    hide() {
      this.open = false;
      if (this.els && this.els.overlay) this.els.overlay.classList.add('hidden');
      this._stopWorld();
      this._detachOverlay();
      this._closeSheet();
      this._setHint(null);
      if (global.VF && global.VF.syncGameBackBtn) global.VF.syncGameBackBtn();
    },

    resume() {
      this.openLobby();
    },

    close() {
      this.hide();
    },

    selectClass(classId) {
      classId = LEGACY_CLASS[classId] || classId;
      if (!classId || LOBBY_CLASS_ORDER.indexOf(classId) < 0) return;
      this._selectedClass = classId;
      try {
        localStorage.setItem(STORAGE_CLASS, classId);
      } catch (_) {}
      this._rebuildHero();
    },

    setPreviewClass(classId) {
      if (!classId) return;
      classId = LEGACY_CLASS[classId] || classId;
      if (LOBBY_CLASS_ORDER.indexOf(classId) >= 0) {
        this.selectClass(classId);
      } else {
        this._selectedClass = classId;
        try {
          localStorage.setItem(STORAGE_CLASS, classId);
        } catch (_) {}
      }
    },

    _sheetOpen() {
      return !!(this.els && this.els.sheet && !this.els.sheet.classList.contains('hidden'));
    },

    _openSheet(key) {
      const conf = SHEETS[key] || {
        title: '提示',
        body: '<p>功能筹备中。</p>',
      };
      if (this.els.sheetTitle) this.els.sheetTitle.textContent = conf.title;
      if (this.els.sheetBody) {
        if (key === 'shop' && global.VF.Economy && global.VF.Economy.renderShopHtml) {
          this.els.sheetBody.innerHTML = global.VF.Economy.renderShopHtml();
        } else {
          this.els.sheetBody.innerHTML = conf.body;
        }
      }
      if (this.els.sheet) {
        this.els.sheet.classList.remove('hidden');
        if (!this.els.sheet._backdropBound) {
          this.els.sheet._backdropBound = true;
          this.els.sheet.addEventListener('click', (e) => {
            if (e.target === this.els.sheet) this._closeSheet();
          });
        }
      }
      this._setHint(null);
      if (this._world) this._world.dragging = false;
    },

    _closeSheet() {
      if (this.els && this.els.sheet) this.els.sheet.classList.add('hidden');
    },

    _onAction(action) {
      const h = this._handlers || {};
      switch (action) {
        case 'sheet-close':
          this._closeSheet();
          break;
        case 'play':
          if (h.onPlay) h.onPlay();
          break;
        case 'pve':
          this.hide();
          if (h.onPve) h.onPve();
          break;
        case 'pvp':
          this.hide();
          if (h.onPvp) h.onPvp();
          else if (global.VF.Hub && global.VF.Hub.openCraft) global.VF.Hub.openCraft('pvp');
          break;
        case 'range':
          this.hide();
          if (h.onRange) h.onRange();
          break;
        case 'materials':
          this.hide();
          if (h.onMaterials) h.onMaterials();
          else if (global.VF.Hub && global.VF.Hub.openCraft) global.VF.Hub.openCraft('material');
          break;
        case 'weapons':
          this.hide();
          if (h.onWeapons) h.onWeapons();
          else if (global.VF.Hub && global.VF.Hub.openCraft) global.VF.Hub.openCraft('weapon');
          break;
        case 'tower':
          this.hide();
          if (h.onTower) h.onTower();
          break;
        case 'map':
          this.hide();
          if (h.onMap) h.onMap();
          break;
        case 'profile':
          this._openSheet('profile');
          break;
        case 'shop':
          this._openSheet('shop');
          break;
        case 'settings':
          this._openSheet('settings');
          break;
        default:
          break;
      }
    },

    _setHint(text) {
      const el = this.els && this.els.hint;
      if (!el) return;
      if (!text) {
        el.textContent = '';
        el.classList.add('hidden');
        this._hintAction = null;
        return;
      }
      el.textContent = text;
      el.classList.remove('hidden');
    },

    _stripExtras(model) {
      if (!model) return;
      const marker = model.getObjectByName('TeamMarker');
      if (marker) {
        if (marker.parent) marker.parent.remove(marker);
        marker.visible = false;
      }
      model.traverse((obj) => {
        if (!obj || !obj.isMesh) return;
        obj.frustumCulled = false;
        const geo = obj.geometry;
        if (geo && geo.type === 'RingGeometry') obj.visible = false;
      });
    },

    _mat(color, opts) {
      opts = opts || {};
      return new THREE.MeshLambertMaterial({
        color: color,
        emissive: opts.emissive != null ? opts.emissive : 0x000000,
        emissiveIntensity: opts.emissiveIntensity != null ? opts.emissiveIntensity : 0,
        transparent: !!opts.transparent,
        opacity: opts.opacity != null ? opts.opacity : 1,
      });
    },

    _markInteractable(root, action, label) {
      root.userData.lobbyAction = action;
      root.userData.lobbyLabel = label;
      root.traverse((o) => {
        if (o.isMesh) {
          o.userData.lobbyAction = action;
          o.userData.lobbyLabel = label;
          o.userData.lobbyRoot = root;
        }
      });
      return root;
    },

    _buildWeaponBench() {
      const g = new THREE.Group();
      g.name = 'LobbyWeaponBench';
      box(2.4, 0.12, 1.1, 0x5a4030, 0, 0.95, 0, g);
      box(0.16, 0.95, 0.16, 0x3a2a1c, -1.0, 0.48, -0.4, g);
      box(0.16, 0.95, 0.16, 0x3a2a1c, 1.0, 0.48, -0.4, g);
      box(0.16, 0.95, 0.16, 0x3a2a1c, -1.0, 0.48, 0.4, g);
      box(0.16, 0.95, 0.16, 0x3a2a1c, 1.0, 0.48, 0.4, g);
      box(2.2, 0.08, 0.9, 0x2a2218, 0, 0.55, 0, g);
      const gun = new THREE.Group();
      box(1.15, 0.1, 0.12, 0x2e3238, 0, 0, 0, gun);
      box(0.35, 0.14, 0.16, 0x4a4030, -0.35, -0.04, 0, gun);
      box(0.18, 0.08, 0.08, 0x1a1c20, 0.55, 0.02, 0, gun);
      gun.position.set(0.15, 1.08, 0.05);
      gun.rotation.y = 0.35;
      g.add(gun);
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 10, 10),
        this._mat(0xff8020, {
          emissive: 0xff6010,
          emissiveIntensity: 0.85,
          transparent: true,
          opacity: 0.55,
        })
      );
      glow.position.set(-0.7, 1.05, 0.25);
      glow.name = 'ForgeGlow';
      g.add(glow);
      return this._markInteractable(g, 'weapons', '建造武器');
    },

    _buildTowerMini() {
      const g = new THREE.Group();
      g.name = 'LobbyTowerMini';
      box(1.8, 0.18, 1.8, 0x4a4540, 0, 0.09, 0, g);
      box(1.2, 1.4, 1.2, 0x6e7278, 0, 0.9, 0, g);
      box(1.4, 0.2, 1.4, 0x5a4030, 0, 1.7, 0, g);
      box(0.35, 0.7, 0.35, 0x4a5560, -0.45, 2.15, -0.45, g);
      box(0.35, 0.7, 0.35, 0x4a5560, 0.45, 2.15, -0.45, g);
      box(0.35, 0.7, 0.35, 0x4a5560, -0.45, 2.15, 0.45, g);
      box(0.35, 0.7, 0.35, 0x4a5560, 0.45, 2.15, 0.45, g);
      return this._markInteractable(g, 'tower', '设计防御塔');
    },

    _buildFloatingMap() {
      const g = new THREE.Group();
      g.name = 'LobbyMapTable';
      box(1.1, 0.9, 1.1, 0x3a3228, 0, 0.45, 0, g);
      box(1.6, 0.08, 1.6, 0x2a241c, 0, 0.95, 0, g);
      const board = new THREE.Mesh(
        new THREE.BoxGeometry(1.35, 0.06, 1.35),
        this._mat(0x3d6b4a, { emissive: 0x1a4028, emissiveIntensity: 0.25 })
      );
      board.position.set(0, 1.35, 0);
      board.name = 'FloatMap';
      g.add(board);
      for (let i = -2; i <= 2; i++) {
        box(1.2, 0.02, 0.03, 0xc8e0b0, 0, 1.39, i * 0.25, g);
        box(0.03, 0.02, 1.2, 0xc8e0b0, i * 0.25, 1.39, 0, g);
      }
      box(0.2, 0.12, 0.2, 0x8a3a2a, -0.35, 1.45, 0.2, g);
      box(0.2, 0.12, 0.2, 0x4a5560, 0.3, 1.45, -0.25, g);
      return this._markInteractable(g, 'map', '地图搭建');
    },

    _buildRangeCorner() {
      const g = new THREE.Group();
      g.name = 'LobbyRange';
      box(1.4, 0.55, 0.7, 0x8a7a58, 0, 0.28, 0.2, g);
      box(0.12, 1.5, 0.12, 0x5a4030, 0, 0.95, -0.55, g);
      box(0.7, 0.9, 0.08, 0xd8d0c0, 0, 1.35, -0.55, g);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.12, 0.28, 24),
        new THREE.MeshBasicMaterial({ color: 0xc03030, side: THREE.DoubleSide })
      );
      ring.position.set(0, 1.35, -0.5);
      g.add(ring);
      return this._markInteractable(g, 'range', '射击靶场');
    },

    _buildBlockCrate() {
      const g = new THREE.Group();
      g.name = 'LobbyBlocks';
      box(1.5, 0.7, 1.1, 0x5a4030, 0, 0.35, 0, g);
      const cols = [0x3d6b2e, 0x8a3a2a, 0x4a5560, 0x9a968e, 0x6a9aaa, 0x6e7278];
      let n = 0;
      for (let y = 0; y < 2; y++) {
        for (let x = -1; x <= 1; x++) {
          for (let z = -1; z <= 0; z++) {
            box(0.32, 0.32, 0.32, cols[n % cols.length], x * 0.36, 0.85 + y * 0.34, z * 0.36, g);
            n++;
          }
        }
      }
      return this._markInteractable(g, 'materials', '方块建材');
    },

    _hubScene() {
      const hub = global.VF && global.VF.Hub && global.VF.Hub.instance;
      return hub && hub.scene ? hub.scene : null;
    },

    _buildOverlay(parent) {
      const overlay = new THREE.Group();
      overlay.name = 'LobbyOverlay';

      // Hub asphalt top ≈ 0.11 — keep glow above road so it is visible
      const footY = 0.14;
      const pad = new THREE.Mesh(
        new THREE.CircleGeometry(1.55, 48),
        new THREE.MeshBasicMaterial({
          color: 0x1a1814,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
        })
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(LOOK_AT.x, footY, LOOK_AT.z);
      pad.renderOrder = 2;
      overlay.add(pad);

      const glowDisc = new THREE.Mesh(
        new THREE.CircleGeometry(1.28, 48),
        new THREE.MeshBasicMaterial({
          color: 0xff7a28,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
        })
      );
      glowDisc.rotation.x = -Math.PI / 2;
      glowDisc.position.set(LOOK_AT.x, footY + 0.01, LOOK_AT.z);
      glowDisc.name = 'HeroGlowDisc';
      glowDisc.renderOrder = 3;
      overlay.add(glowDisc);

      const glowRing = new THREE.Mesh(
        new THREE.RingGeometry(1.12, 1.52, 48),
        new THREE.MeshBasicMaterial({
          color: 0xffc078,
          transparent: true,
          opacity: 0.95,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      glowRing.rotation.x = -Math.PI / 2;
      glowRing.position.set(LOOK_AT.x, footY + 0.02, LOOK_AT.z);
      glowRing.name = 'HeroGlowRing';
      glowRing.renderOrder = 4;
      overlay.add(glowRing);

      const props = [];
      const builders = {
        weapons: () => this._buildWeaponBench(),
        tower: () => this._buildTowerMini(),
        map: () => this._buildFloatingMap(),
        range: () => this._buildRangeCorner(),
        materials: () => this._buildBlockCrate(),
      };
      for (let i = 0; i < PROP_DEFS.length; i++) {
        const def = PROP_DEFS[i];
        const node = builders[def.id]();
        node.position.set(def.x, 0, def.z);
        overlay.add(node);
        props.push({ def: def, root: node });
      }

      parent.add(overlay);
      return { overlay: overlay, props: props };
    },

    _detachOverlay() {
      const w = this._world;
      if (!w || !w.overlay) return;
      if (w.overlay.parent) w.overlay.parent.remove(w.overlay);
      w.overlay = null;
      w.props = [];
      w.hero = null;
    },

    _startWorld() {
      if (!global.THREE || !global.VF || !global.VF.Soldier) return;
      const canvas = this.els.worldCanvas;
      if (!canvas) return;

      let scene = this._hubScene();
      let ownedScene = false;
      if (!scene) {
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x7eb6e4);
        scene.fog = new THREE.Fog(0x7eb6e4, 42, 135);
        scene.add(new THREE.AmbientLight(0xd4e2f2, 0.62));
        const sun = new THREE.DirectionalLight(0xfff2cc, 1.05);
        sun.position.set(-45, 55, 18);
        scene.add(sun);
        ownedScene = true;
      }

      if (!this._world) {
        const cam = new THREE.PerspectiveCamera(42, 16 / 9, 0.12, 220);
        const renderer = new THREE.WebGLRenderer({
          canvas: canvas,
          antialias: false,
          alpha: false,
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        renderer.setClearColor(0x7eb6e4, 1);

        this._world = {
          scene: scene,
          ownedScene: ownedScene,
          cam: cam,
          renderer: renderer,
          overlay: null,
          props: [],
          hero: null,
          // Preview soldier wrap already has +π; +π here faces camera (+Z)
          heroYaw: Math.PI,
          raycaster: new THREE.Raycaster(),
          pointer: new THREE.Vector2(),
          hover: null,
          raf: 0,
          lastT: performance.now(),
          resize: true,
          floatT: 0,
          orbitYaw: DEFAULT_ORBIT_YAW,
          orbitPitch: DEFAULT_ORBIT_PITCH,
          orbitDist: ORBIT_DIST,
          dragging: false,
          dragMoved: false,
          dragStartX: 0,
          dragStartY: 0,
          lastX: 0,
          lastY: 0,
          pointerId: null,
        };
      } else {
        this._world.scene = scene;
        this._world.ownedScene = ownedScene;
      }

      this._detachOverlay();
      const built = this._buildOverlay(scene);
      this._world.overlay = built.overlay;
      this._world.props = built.props;
      // Frontal default view each time lobby opens
      this._world.orbitYaw = DEFAULT_ORBIT_YAW;
      this._world.orbitPitch = DEFAULT_ORBIT_PITCH;
      this._world.orbitDist = ORBIT_DIST;
      // Facing wrap is already π; root π → faces camera
      this._world.heroYaw = Math.PI;

      this._rebuildHero();
      this._applyOrbitCamera();
      this._world.lastT = performance.now();
      this._tickWorld();
    },

    _rebuildHero() {
      const w = this._world;
      if (!w || !w.overlay || !global.VF.Soldier) return;
      if (w.hero) {
        if (w.hero.parent) w.hero.parent.remove(w.hero);
        w.hero = null;
      }
      const id = this._selectedClass || 'assault';
      const model = global.VF.Soldier.createPreviewSoldier(id);
      this._stripExtras(model);
      model.scale.set(1, 1, 1);
      model.position.set(LOOK_AT.x, 0, LOOK_AT.z);
      model.rotation.y = w.heroYaw;
      if (global.VF.Soldier.initLocomotion) global.VF.Soldier.initLocomotion(model);
      w.overlay.add(model);
      w.hero = model;
    },

    _applyOrbitCamera() {
      const w = this._world;
      if (!w) return;
      const yaw = w.orbitYaw;
      const pitch = w.orbitPitch;
      const dist = w.orbitDist;
      const cp = Math.cos(pitch);
      w.cam.position.set(
        LOOK_AT.x + Math.sin(yaw) * cp * dist,
        LOOK_AT.y + Math.sin(pitch) * dist,
        LOOK_AT.z + Math.cos(yaw) * cp * dist
      );
      w.cam.lookAt(LOOK_AT.x, LOOK_AT.y, LOOK_AT.z);
    },

    _pickFromEvent(e) {
      const w = this._world;
      const canvas = this.els.worldCanvas;
      if (!w || !canvas || !w.props) return null;
      const rect = canvas.getBoundingClientRect();
      w.pointer.x = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      w.pointer.y = -((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
      w.raycaster.setFromCamera(w.pointer, w.cam);
      const meshes = [];
      for (let i = 0; i < w.props.length; i++) {
        w.props[i].root.traverse((o) => {
          if (o.isMesh) meshes.push(o);
        });
      }
      const hits = w.raycaster.intersectObjects(meshes, false);
      if (!hits.length) return null;
      let obj = hits[0].object;
      while (obj && !obj.userData.lobbyAction) obj = obj.parent;
      if (obj && obj.userData.lobbyAction) {
        return {
          action: obj.userData.lobbyAction,
          label: obj.userData.lobbyLabel || obj.userData.lobbyAction,
          root: obj.userData.lobbyRoot || obj,
        };
      }
      return null;
    },

    _onPointerDown(e) {
      if (!this.open || this._sheetOpen()) return;
      if (e.target !== this.els.worldCanvas || e.button !== 0) return;
      const w = this._world;
      if (!w) return;
      w.dragging = true;
      w.dragMoved = false;
      w.dragStartX = e.clientX;
      w.dragStartY = e.clientY;
      w.lastX = e.clientX;
      w.lastY = e.clientY;
      w.pointerId = e.pointerId;
      try {
        this.els.worldCanvas.setPointerCapture(e.pointerId);
      } catch (_) {}
    },

    _onPointerMove(e) {
      if (!this.open || this._sheetOpen()) return;
      const w = this._world;
      if (!w) return;

      if (w.dragging) {
        const dx = e.clientX - w.lastX;
        const dy = e.clientY - w.lastY;
        w.lastX = e.clientX;
        w.lastY = e.clientY;
        const dist = Math.hypot(e.clientX - w.dragStartX, e.clientY - w.dragStartY);
        if (dist > DRAG_CLICK_PX) w.dragMoved = true;
        if (w.dragMoved) {
          w.orbitYaw -= dx * 0.0055;
          w.orbitPitch += dy * 0.004;
          w.orbitPitch = Math.max(ORBIT_MIN_PITCH, Math.min(ORBIT_MAX_PITCH, w.orbitPitch));
          this._applyOrbitCamera();
          this._setHint(null);
          this._setHover(null);
        }
        return;
      }

      if (e.target !== this.els.worldCanvas) return;
      const hit = this._pickFromEvent(e);
      if (hit && hit.action) {
        if (this._hintAction !== hit.action) {
          this._hintAction = hit.action;
          this._setHint('点击进入 · ' + hit.label);
          this._setHover(hit.root);
        }
      } else if (this._hintAction) {
        this._setHint(null);
        this._setHover(null);
      }
    },

    _onPointerUp(e) {
      const w = this._world;
      if (!w || !w.dragging) return;
      const wasDrag = w.dragMoved;
      w.dragging = false;
      if (w.pointerId != null) {
        try {
          this.els.worldCanvas.releasePointerCapture(w.pointerId);
        } catch (_) {}
        w.pointerId = null;
      }
      if (this._sheetOpen()) return;
      if (!wasDrag) {
        const hit = this._pickFromEvent(e);
        if (hit && hit.action) this._onAction(hit.action);
      }
    },

    _setHover(root) {
      const w = this._world;
      if (!w) return;
      if (w.hover && w.hover !== root) {
        w.hover.traverse((o) => {
          if (o.isMesh && o.userData._lobbyEmissive != null) {
            o.material.emissiveIntensity = o.userData._lobbyEmissive;
          }
        });
      }
      w.hover = root || null;
      if (!root) return;
      root.traverse((o) => {
        if (o.isMesh && o.material && o.material.emissive != null) {
          if (o.userData._lobbyEmissive == null) {
            o.userData._lobbyEmissive = o.material.emissiveIntensity || 0;
          }
          o.material.emissiveIntensity = Math.max(0.35, o.userData._lobbyEmissive + 0.35);
        }
      });
    },

    _tickWorld() {
      const w = this._world;
      if (!this.open || !w) return;

      const now = performance.now();
      let dt = (now - w.lastT) / 1000;
      w.lastT = now;
      if (dt > 0.05) dt = 0.05;
      w.floatT += dt;

      const canvas = this.els.worldCanvas;
      if (canvas && (w.resize || !canvas.width)) {
        w.resize = false;
        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        const ww = Math.max(640, Math.floor(rect.width * dpr) || 1280);
        const hh = Math.max(360, Math.floor(rect.height * dpr) || 720);
        if (canvas.width !== ww || canvas.height !== hh) {
          canvas.width = ww;
          canvas.height = hh;
          w.cam.aspect = ww / Math.max(1, hh);
          w.cam.updateProjectionMatrix();
          w.renderer.setSize(ww, hh, false);
        }
      }

      for (let i = 0; i < w.props.length; i++) {
        const p = w.props[i];
        if (p.def.id === 'map') {
          const board = p.root.getObjectByName('FloatMap');
          if (board) {
            board.position.y = 1.35 + Math.sin(w.floatT * 1.4) * 0.12;
            board.rotation.y = Math.sin(w.floatT * 0.5) * 0.08;
          }
        }
        if (p.def.id === 'weapons') {
          const glow = p.root.getObjectByName('ForgeGlow');
          if (glow && glow.material) {
            glow.material.opacity = 0.4 + Math.sin(w.floatT * 3.2) * 0.2;
          }
        }
      }

      if (w.hero && global.VF.Soldier && global.VF.Soldier.updateLocomotion) {
        global.VF.Soldier.updateLocomotion(w.hero, dt, {
          moving: false,
          speedRatio: 0,
          onGround: true,
        });
      }

      this._applyOrbitCamera();
      w.renderer.render(w.scene, w.cam);
      w.raf = requestAnimationFrame(() => this._tickWorld());
    },

    _stopWorld() {
      const w = this._world;
      if (!w) return;
      if (w.raf) cancelAnimationFrame(w.raf);
      w.raf = 0;
      w.dragging = false;
      this._setHover(null);
    },
  };

  global.VF = global.VF || {};
  global.VF.Lobby = Lobby;
})(typeof window !== 'undefined' ? window : globalThis);
