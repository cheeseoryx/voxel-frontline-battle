/**
 * main.js — Voxel Frontline bootstrap
 * Scene · lighting · game loop · pointer lock · resource nodes
 * Open index.html to play (Three.js via CDN).
 */
(function () {
  'use strict';

  if (typeof THREE === 'undefined') {
    document.body.innerHTML =
      '<p style="color:#fff;font-family:sans-serif;padding:2rem">Failed to load Three.js. Check your network connection.</p>';
    return;
  }

  const game = {
    renderer: null,
    scene: null,
    camera: null,
    world: null,
    player: null,
    weapons: null,
    building: null,
    ai: null,
    resources: [],
    clock: new THREE.Clock(),
    running: false,
    mode: 'pve', // 'pve' | 'pvp'
    pvp: null,
    timeScale: 1,
    _hitstop: 0,
    teamLocked: false,
    lockedTeam: null,
  };

  globalThis.VF = globalThis.VF || {};
  VF.game = game;

  /** Kept for API compat — world freeze removed (felt laggy / half-beat late) */
  VF.triggerHitstop = function () {
    /* no-op: use player.punchFeedback instead */
  };

  function init() {
    const enterHubBtn = document.getElementById('enter-hub-btn');
    const quitBtn = document.getElementById('quit-btn');
    const tutorialBtn = document.getElementById('tutorial-btn');
    const tutorialBack = document.getElementById('tutorial-back-btn');
    const tutorialPlay = document.getElementById('tutorial-play-btn');
    const tutorialOverlay = document.getElementById('tutorial-overlay');
    const overlay = document.getElementById('start-overlay');
    if (enterHubBtn) {
      enterHubBtn.disabled = true;
      const label = enterHubBtn.querySelector('span:last-child');
      if (label) label.textContent = '加载中…';
    }

    function showTutorial() {
      if (tutorialOverlay) tutorialOverlay.classList.remove('hidden');
      if (overlay) overlay.classList.add('hidden');
    }
    function hideTutorial() {
      if (tutorialOverlay) tutorialOverlay.classList.add('hidden');
      if (overlay) overlay.classList.remove('hidden');
    }

    if (tutorialBtn) {
      tutorialBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showTutorial();
      });
    }
    if (tutorialBack) {
      tutorialBack.addEventListener('click', (e) => {
        e.stopPropagation();
        hideTutorial();
      });
    }
    if (tutorialPlay) {
      tutorialPlay.addEventListener('click', (e) => {
        e.stopPropagation();
        hideTutorial();
        openFrontlineHub();
      });
    }

    if (quitBtn) {
      quitBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        try {
          window.close();
        } catch (_) {}
        setTimeout(() => {
          document.body.innerHTML =
            '<p style="color:#e8ecf2;font-family:sans-serif;padding:2rem;background:#0a0c10;min-height:100vh">游戏已结束。关闭此标签页即可离开。</p>';
        }, 50);
      });
    }

    try {
      _initGame();

      function _enableCoverReady() {
        if (enterHubBtn) {
          enterHubBtn.disabled = false;
          const label = enterHubBtn.querySelector('span:last-child');
          if (label) label.textContent = '进入大厅';
        }
      }

      if (enterHubBtn) {
        enterHubBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openFrontlineHub();
        });
      }
      if (overlay) {
        overlay.addEventListener('click', (e) => {
          if (e.target.closest('.cover-ui') || e.target.closest('.cover-title')) return;
          if (e.target.id === 'start-overlay' || e.target.classList.contains('cover-art')) {
            openFrontlineHub();
          }
        });
      }

      if (VF.Pvp) {
        VF.Pvp.init(function (info) {
          startPvpMatch(info);
        });
      }
      if (VF.Audio) VF.Audio.init();
      const audioBtn = document.getElementById('audio-toggle');
      if (audioBtn) {
        audioBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!VF.Audio) return;
          // Clicking the speaker = enable + test beep (don't mute on first tap).
          if (!VF.Audio.enabled) {
            VF.Audio.setEnabled(true);
          } else if (VF.Audio.unlocked) {
            VF.Audio.toggle();
          }
          const after = () => { if (VF.Audio.enabled) VF.Audio.play('ui'); };
          if (VF.Audio.unlock) VF.Audio.unlock().then(after);
          else after();
        });
      }
      // UI click feedback on major menu buttons
      document.querySelectorAll('.cover-btn, .hub-action, .class-card').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (!VF.Audio) return;
          const playUi = () => VF.Audio.play('ui');
          if (VF.Audio.unlock) VF.Audio.unlock().then(playUi);
          else playUi();
        });
      });

      // Unlock cover once systems are ready
      _enableCoverReady();
    } catch (err) {
      console.error(err);
      if (enterHubBtn) {
        enterHubBtn.disabled = false;
        const label = enterHubBtn.querySelector('span:last-child');
        if (label) label.textContent = '加载失败 · 重试';
        enterHubBtn.onclick = () => location.reload();
      }
    }
  }

  function _initGame() {
    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(1);
    renderer.shadowMap.enabled = false;
    renderer.setClearColor(0x7eb6e4);
    document.body.prepend(renderer.domElement);
    game.renderer = renderer;
    renderer.domElement.addEventListener(
      'webglcontextlost',
      function (e) {
        e.preventDefault();
        console.warn('[VF] webgl context lost — waiting to restore');
      },
      false
    );
    renderer.domElement.addEventListener(
      'webglcontextrestored',
      function () {
        try {
          renderer.setSize(window.innerWidth, window.innerHeight);
          renderer.setPixelRatio(1);
          renderer.setClearColor(0x7eb6e4);
        } catch (_) {}
      },
      false
    );

    // Scene — daylight blue sky (no sky sphere — avoids black ball artifacts)
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x7eb6e4);
    scene.fog = new THREE.Fog(0x7eb6e4, 220, 920);
    game.scene = scene;

    // Camera — must be in the scene so FPS viewmodel (camera children) render
    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.08, 1100);
    scene.add(camera);
    game.camera = camera;

    // Lighting — noon daylight
    const ambient = new THREE.AmbientLight(0xd4e2f2, 0.62);
    scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xfff2cc, 1.05);
    sun.position.set(-60, 45, 25);
    sun.castShadow = false;
    scene.add(sun);

    const fill = new THREE.DirectionalLight(0x5a8ac8, 0.28);
    fill.position.set(40, 20, -30);
    scene.add(fill);

    // Voxel world
    game.world = new VF.VoxelWorld(scene);

    // Ally / enemy glowing bases (sets spawn + objective positions)
    game.bases = new VF.Bases(scene, game.world);

    // Restore hand-built map kit (empty terrain + stamps); no procedural city
    game._mapKitLayout = true;
    if (VF.MapEditor && VF.MapEditor.applyMatchMap) {
      VF.MapEditor.applyMatchMap();
    }

    // Player (spawns at ally base)
    game.player = new VF.Player(camera, game.world);

    // Systems
    game.weapons = new VF.Weapons(game.player, game.world, scene);
    game.skills = VF.Skills ? new VF.Skills(game.player, game.world, scene) : null;
    game.building = new VF.Building(game.player, game.world, scene);
    game.ai = new VF.AIController(scene, game.world, game.player);
    VF.AI = game.ai;

    // Tiny opaque dust cubes (solid, not soft fog)
    if (VF.createAtmosphere) {
      game.atmosphere = VF.createAtmosphere(scene);
    }

    // UI
    VF.UI.init();
    bindGameBackBtn();
    VF.syncGameBackBtn = syncGameBackBtn;
    VF.exitToLobby = exitToLobby;
    VF.openRedeployFromDeath = openRedeployFromDeath;
    VF.startConquest32 = startConquest32;
    if (VF.UI.setDeathHandlers) {
      VF.UI.setDeathHandlers({
        onRedeploy: function () {
          if (VF.Revive && VF.Revive.giveUpPlayer && VF.Revive.giveUpPlayer()) return;
          openRedeployFromDeath();
        },
        onCallout: function () {
          if (VF.Revive && VF.Revive.callForHelp) VF.Revive.callForHelp();
        },
        onHub: function () {
          returnFromDeathToHub();
        },
      });
    }
    const victoryBtn = document.getElementById('victory-btn');
    if (victoryBtn && !victoryBtn._vfBound) {
      victoryBtn._vfBound = true;
      victoryBtn.addEventListener('click', function (e) {
        e.preventDefault();
        returnFromDeathToHub();
      });
    }
    VF.UI.updateVitals(game.player.health, game.player.armor);
    VF.UI.updateResources(game.player.cores, game.player.blocks);
    const ammo = game.weapons.getAmmo();
    VF.UI.updateAmmo(ammo.mag, ammo.reserve);
    VF.UI.updateWave(1, 0);
    VF.UI.updateArmyCounts(0, 0);
    VF.UI.updateSquad(0, 0, '占领旗帜 · 耗尽敌方票数');
    VF.UI.setMissionTargetLabel('红方核心');
    VF.UI.setHomeCoreLabel('蓝方核心');
    VF.UI.updateMissionCore(1000, 1000);
    VF.UI.updateHomeCore(1000, 1000);

    // Scatter glowing Voxel Core / build block pickups
    seedResources();

    // Flat pixel lobby (+ keep Hub craft overlays via Hub.init)
    if (VF.Hub) {
      VF.Hub.init(renderer);
      VF.Hub.setHandlers({
        onPve: function () {
          if (VF.UI && VF.UI.openModeSelect) VF.UI.openModeSelect();
          else startConquest32();
        },
        onPvpCreate: function () {
          if (VF.Pvp && VF.Pvp.createRoom) VF.Pvp.createRoom();
        },
        onPvpJoin: function () {
          if (VF.Pvp && VF.Pvp.openJoin) VF.Pvp.openJoin();
        },
        onTower: function () {
          openTowerFromHub();
        },
        onRange: function () {
          openRangeFromHub();
        },
        onBackHome: function () {
          const cover = document.getElementById('start-overlay');
          if (cover) cover.classList.remove('hidden');
        },
      });
    }

    if (VF.Lobby) {
      VF.Lobby.init();
      VF.Lobby.setHandlers({
        onPlay: function () {
          if (VF.UI && VF.UI.openModeSelect) VF.UI.openModeSelect();
        },
        onPve: function () {
          if (VF.UI && VF.UI.openModeSelect) VF.UI.openModeSelect();
          else startConquest32();
        },
        onPvp: function () {
          if (VF.Hub && VF.Hub.openCraft) VF.Hub.openCraft('pvp');
        },
        onTower: function () {
          openTowerFromHub();
        },
        onMap: function () {
          openMapFromLobby();
        },
        onRange: function () {
          openRangeFromHub();
        },
        onMaterials: function () {
          if (VF.Hub && VF.Hub.openCraft) VF.Hub.openCraft('material');
        },
        onWeapons: function () {
          if (VF.Hub && VF.Hub.openCraft) VF.Hub.openCraft('weapon');
        },
        onBackHome: function () {
          const cover = document.getElementById('start-overlay');
          if (cover) cover.classList.remove('hidden');
        },
      });
    }

    if (VF.Range) {
      VF.Range.init(renderer);
      VF.Range.setHandlers({
        onBack: function () {
          openFrontlineHub();
        },
      });
    }

    // Events
    window.addEventListener('resize', onResize);
    setupPointerLock();
    setupInventoryToggle();
    setupMapToggle();

    // Render idle preview before lock
    animate();
  }

  function spawnResource(pos, type) {
    const color = type === 'core' ? 0x7dffc8 : 0xc4a574;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.45, 0.45),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
      })
    );
    mesh.position.copy(pos);
    game.scene.add(mesh);
    game.resources.push({ mesh, type, spin: Math.random() * Math.PI * 2 });
  }

  function seedResources() {
    const w = game.world;
    for (let i = 0; i < 20; i++) {
      const x = 8 + Math.random() * (w.worldSize - 16);
      const z = 8 + Math.random() * (w.worldSize - 16);
      let y = w.height - 1;
      while (y > 1 && !w._isSolid(Math.floor(x), y, Math.floor(z))) y--;
      const type = Math.random() > 0.45 ? 'core' : 'blocks';
      spawnResource(new THREE.Vector3(x, y + 1.4, z), type);
    }
  }

  game.spawnResource = spawnResource;

  function openFrontlineHub() {
    game.teamLocked = false;
    game.lockedTeam = null;
    const tutorial = document.getElementById('tutorial-overlay');
    if (tutorial) tutorial.classList.add('hidden');
    if (VF.TowerDesigner && VF.TowerDesigner.open) VF.TowerDesigner.close();
    if (VF.Range && VF.Range.isOpen) VF.Range.close(true);
    if (VF.MapEditor && VF.MapEditor.isOpen && VF.MapEditor.isOpen()) {
      VF.MapEditor.close({ skipLobby: true });
    }
    if (VF.Hub && VF.Hub.hide) VF.Hub.hide();
    if (VF.Lobby && VF.Lobby.hide) VF.Lobby.hide();
    if (VF.UI && VF.UI.openModeSelect) VF.UI.openModeSelect();
    syncGameBackBtn();
  }

  function openMapFromLobby() {
    if (VF.Lobby) VF.Lobby.hide();
    if (VF.Hub && VF.Hub.hide) VF.Hub.hide();
    const cover = document.getElementById('start-overlay');
    if (cover) cover.classList.add('hidden');
    if (VF.MapEditor && VF.MapEditor.open) {
      VF.MapEditor.open({ fromLobby: true });
    } else if (VF.UI && VF.UI.toast) {
      VF.UI.toast('地图编辑器未加载');
      openFrontlineHub();
    }
  }

  function openRangeFromHub() {
    if (VF.Lobby) VF.Lobby.hide();
    if (VF.Hub) VF.Hub.hide();
    if (VF.Range) VF.Range.open();
  }

  function returnToHub() {
    game.teamLocked = false;
    game.lockedTeam = null;
    game.running = false;
    if (game.player) game.player._cqTicketPending = false;
    if (VF.Conquest && VF.Conquest.stop) VF.Conquest.stop();
    if (document.exitPointerLock) document.exitPointerLock();
    if (VF.UI && VF.UI.hideHud) VF.UI.hideHud();
    if (VF.UI && VF.UI.hideDeath) VF.UI.hideDeath();
    if (VF.UI && VF.UI.hideVictory) VF.UI.hideVictory();
    if (VF.UI && VF.UI.closeClassSelect) VF.UI.closeClassSelect();
    if (VF.UI && VF.UI.closeSpawnSelect) VF.UI.closeSpawnSelect();
    if (VF.UI && VF.UI.closeModeSelect) VF.UI.closeModeSelect();
    if (VF.TowerDesigner && VF.TowerDesigner.open) VF.TowerDesigner.close();
    if (VF.MapEditor && VF.MapEditor.isOpen && VF.MapEditor.isOpen()) {
      VF.MapEditor.close({ skipLobby: true });
    }
    if (VF.Range && VF.Range.isOpen) VF.Range.close(true);
    if (game.ai && game.ai._clearUnits) game.ai._clearUnits();
    if (VF.Hub && VF.Hub.hide) VF.Hub.hide();
    openFrontlineHub();
  }

  /** Top-left 返回 — leave match / hub / range / menus back to lobby */
  function exitToLobby() {
    if (document.exitPointerLock) document.exitPointerLock();
    if (VF.MapEditor && VF.MapEditor.isOpen && VF.MapEditor.isOpen()) {
      VF.MapEditor.close({});
      syncGameBackBtn();
      return;
    }
    if (VF.Range && VF.Range.isOpen) {
      VF.Range.close(true);
      openFrontlineHub();
      return;
    }
    if (VF.TowerDesigner && VF.TowerDesigner.open) {
      VF.TowerDesigner.close();
      openFrontlineHub();
      return;
    }
    if (VF.Hub && VF.Hub.isOpen) {
      if (VF.Hub.closeToHome) VF.Hub.closeToHome();
      else returnToHub();
      syncGameBackBtn();
      return;
    }
    if (game.mode === 'pvp' && VF.Pvp && VF.Pvp.roomCode && !game.running) {
      // Still in PVP lobby overlays — leave room entirely
      if (VF.Pvp.leaveLobby) VF.Pvp.leaveLobby();
      game.mode = 'pve';
      game.pvp = null;
      openFrontlineHub();
      syncGameBackBtn();
      return;
    }
    if (game.running || (VF.UI && VF.UI.els && VF.UI.els.hud && !VF.UI.els.hud.classList.contains('hidden'))) {
      returnFromDeathToHub();
      syncGameBackBtn();
      return;
    }
    returnToHub();
  }

  function syncGameBackBtn() {
    const btn = document.getElementById('game-back-btn');
    if (!btn) return;
    const lobbyOpen = !!(VF.Lobby && VF.Lobby.isOpen && VF.Lobby.isOpen());
    const cover = document.getElementById('start-overlay');
    const coverOpen = !!(cover && !cover.classList.contains('hidden'));
    const hubOpen = !!(VF.Hub && VF.Hub.isOpen);
    const rangeOpen = !!(VF.Range && VF.Range.isOpen);
    const hud = document.getElementById('hud');
    const hudOpen = !!(hud && !hud.classList.contains('hidden'));
    const mapOpen = !!(VF.MapEditor && VF.MapEditor.isOpen && VF.MapEditor.isOpen());
    const show = !lobbyOpen && !coverOpen && (hubOpen || rangeOpen || hudOpen || mapOpen || game.running);
    btn.classList.toggle('hidden', !show);
  }

  function bindGameBackBtn() {
    const btn = document.getElementById('game-back-btn');
    if (!btn || btn._vfBound) return;
    btn._vfBound = true;
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      exitToLobby();
    });
  }

  function openClassSelect() {
    const overlay = document.getElementById('start-overlay');
    const tutorial = document.getElementById('tutorial-overlay');
    if (overlay) overlay.classList.add('hidden');
    if (tutorial) tutorial.classList.add('hidden');
    if (VF.TowerDesigner && VF.TowerDesigner.open) VF.TowerDesigner.close();
    if (VF.Lobby) VF.Lobby.hide();
    if (VF.Hub) VF.Hub.hide();
    const preferredClass =
      VF.Lobby && typeof VF.Lobby.getSelectedClassId === 'function'
        ? VF.Lobby.getSelectedClassId()
        : null;
    VF.UI.openClassSelect(
      function (classId) {
        if (game.player && game.player.applyClass) {
          game.player.applyClass(classId);
        }
        game.playerClass = classId;
        if (VF.Lobby && VF.Lobby.setPreviewClass) VF.Lobby.setPreviewClass(classId);
        VF.UI.closeClassSelect();
        // Tower design moved to hub — go straight to spawn
        openSpawnSelect();
      },
      function () {
        VF.UI.closeClassSelect();
        if (game.mode === 'pvp' && VF.Pvp && VF.Pvp.roomCode) {
          returnToPvpLobby();
        } else {
          returnToHub();
        }
      },
      preferredClass
    );
  }

  function returnToPvpLobby() {
    if (!VF.Pvp) return;
    VF.Pvp.localReady = false;
    VF.Pvp._send({ type: 'ready', ready: false });
    if (VF.Pvp.mode === 'host') VF.Pvp._sendLobbySync();
    VF.Pvp._refreshLobby();
    VF.Pvp._setStatus('已返回大厅 · 重新准备后开始');
    if (VF.Pvp.els && VF.Pvp.els.lobbyOverlay) {
      VF.Pvp.els.lobbyOverlay.classList.remove('hidden');
    }
  }

  function startPvpMatch(info) {
    game.mode = 'pvp';
    game.pvp = info || null;
    if (game.pvp) game.pvp.conquest = true;
    game.teamLocked = false;
    game.lockedTeam = null;
    // Map is always hand-built (empty canvas + kit stamps); seed only for sync bookkeeping
    if (info && info.seed != null) game.mapSeed = info.seed >>> 0;
    else if (VF.Pvp && VF.Pvp.matchSeed != null) game.mapSeed = VF.Pvp.matchSeed >>> 0;
    else if (game.mapSeed == null) game.mapSeed = ((Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0);
    if (VF.Pvp && game.mapSeed != null) VF.Pvp.matchSeed = game.mapSeed;
    if (VF.UI && VF.UI.toast) {
      const side = info && info.team === 'enemy' ? '红方' : '蓝方';
      VF.UI.toast('联机征服开始 · 你是' + side);
    }
    openClassSelect();
  }

  function startGame() {
    if (VF.UI && VF.UI.openModeSelect) {
      VF.UI.openModeSelect();
      return;
    }
    startConquest32();
  }

  function startConquest32() {
    game.mode = 'pve';
    game.pvp = null;
    game.teamLocked = false;
    game.lockedTeam = null;
    if (game.mapSeed == null) {
      game.mapSeed = ((Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0);
    }
    const classId =
      (VF.Lobby && typeof VF.Lobby.getSelectedClassId === 'function' && VF.Lobby.getSelectedClassId()) ||
      (game.player && game.player.classId) ||
      'assault';
    game.playerClass = classId;
    if (game.player && game.player.applyClass) game.player.applyClass(classId);
    if (VF.UI && VF.UI.closeModeSelect) VF.UI.closeModeSelect();
    openSpawnSelect();
  }

  function openTowerFromHub() {
    if (VF.Lobby) VF.Lobby.hide();
    if (VF.Hub) VF.Hub.hide();
    if (!VF.TowerDesigner) {
      returnToHub();
      return;
    }
    VF.TowerDesigner.mount();
    VF.TowerDesigner.openEditor(
      function () {
        VF.TowerDesigner.close();
        returnToHub();
        if (VF.UI && VF.UI.toast) VF.UI.toast('防御塔设计已保存');
      },
      function () {
        VF.TowerDesigner.close();
        returnToHub();
      }
    );
  }

  function openTowerBuilder() {
    // Legacy: tower design lives in the hub now
    openSpawnSelect();
  }

  function prepareMatchMap() {
    let seed;
    if (game.mode === 'pvp' && VF.Pvp && VF.Pvp.matchSeed != null) {
      seed = VF.Pvp.matchSeed >>> 0;
    } else if (game.mapSeed != null) {
      seed = game.mapSeed >>> 0;
    } else {
      seed = ((Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0);
      game.mapSeed = seed;
    }

    // No procedural city — always empty terrain/roads + map-kit stamps
    if (VF.MapEditor && VF.MapEditor.applyMatchMap) {
      VF.MapEditor.applyMatchMap();
    } else if (game.world && game.world.regenerate) {
      game.world.regenerate(seed);
      if (game.bases && game.bases.rebuildAfterMapGen) game.bases.rebuildAfterMapGen();
    }

    if (game.resources && game.resources.length) {
      for (let i = 0; i < game.resources.length; i++) {
        const r = game.resources[i];
        if (r.mesh && r.mesh.parent) r.mesh.parent.remove(r.mesh);
      }
      game.resources.length = 0;
    }
    seedResources();

    game.mapSeed = seed;
    game._mapReadyForSeed = seed;
    game._mapKitLayout = true;
    return seed;
  }

  function openSpawnSelect() {
    if (!game.player || !game.world) return;
    prepareMatchMap();

    const overlay = document.getElementById('start-overlay');
    const tutorial = document.getElementById('tutorial-overlay');
    if (overlay) overlay.classList.add('hidden');
    if (tutorial) tutorial.classList.add('hidden');
    if (VF.TowerDesigner && VF.TowerDesigner.open) VF.TowerDesigner.close();

    // 1v1: lock faction from lobby (host=blue/ally, guest=red/enemy)
    if (game.mode === 'pvp' && game.pvp && game.pvp.team && game.world.setPlayerTeam) {
      game.world.setPlayerTeam(game.pvp.team);
    } else if (game.teamLocked && game.lockedTeam && game.world.setPlayerTeam) {
      game.world.setPlayerTeam(game.lockedTeam);
    }

    if (VF.Lobby) VF.Lobby.hide();
    if (VF.Hub) VF.Hub.hide();

    VF.UI.openSpawnSelect(
      game.world,
      function () {
        try {
          if (game.mode === 'pvp' && VF.Pvp && VF.Pvp.roomCode) {
            openPvpSpawnGate();
          } else {
            beginMatch();
          }
        } catch (err) {
          console.error('[VF] spawn confirm', err);
          game.running = true;
          if (VF.UI && VF.UI.closeSpawnSelect) VF.UI.closeSpawnSelect();
          if (VF.UI && VF.UI.showHud) VF.UI.showHud();
        }
      },
      function () {
        VF.UI.closeSpawnSelect();
        if (game.mode === 'pvp' && VF.Pvp && VF.Pvp.roomCode) {
          returnToPvpLobby();
        } else {
          if (VF.Lobby) VF.Lobby.openLobby();
          if (VF.UI && VF.UI.openModeSelect) VF.UI.openModeSelect();
        }
      }
    );
  }

  function openPvpSpawnGate() {
    if (!game.player || !game.world) return;
    if (game.mode === 'pvp' && game.pvp && game.pvp.team && game.world.setPlayerTeam) {
      game.world.setPlayerTeam(game.pvp.team);
    }
    if (!game.world._playerTeam || !game.world.getSelectedSpawn()) return;
    VF.UI.closeSpawnSelect();

    const spawn = game.world.getSelectedSpawn();
    const loadout = {
      classId: game.playerClass || (game.player && game.player.classId) || 'assault',
      spawnId: spawn && spawn.id,
      team: game.world._playerTeam,
    };

    VF.Pvp.openSpawnGate(
      loadout,
      function () {
        beginMatch();
      },
      function () {
        openSpawnSelect();
      }
    );
  }

  function clearMatchBlockers() {
    if (VF.Lobby) {
      if (VF.Lobby._closeSheet) VF.Lobby._closeSheet();
      if (VF.Lobby.hide) VF.Lobby.hide();
    }
    if (VF.Hub && VF.Hub.hide) VF.Hub.hide();
    if (VF.MapEditor && VF.MapEditor.close) {
      try {
        VF.MapEditor.close({ skipLobby: true });
      } catch (_) {}
    }
    [
      'start-overlay',
      'lobby-overlay',
      'lobby-sheet',
      'mode-overlay',
      'weapon-craft-overlay',
      'material-craft-overlay',
      'hub-pvp-overlay',
      'class-overlay',
      'spawn-overlay',
      'map-overlay',
      'map-kit-overlay',
      'victory-overlay',
      'death-overlay',
      'tutorial-overlay',
      'pvp-join-overlay',
      'pvp-lobby-overlay',
      'pvp-match-ready-overlay',
      'tower-builder-overlay',
      'range-overlay',
    ].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
    if (VF.UI) {
      // Hide flags only — do not closeClassSelect() here (it tears down a
      // WebGL preview and can lose the match renderer on Intel GPUs).
      if (VF.UI.closeSpawnSelect) VF.UI.closeSpawnSelect();
      if (VF.UI.hideDeath) VF.UI.hideDeath();
      VF.UI.inventoryOpen = false;
      VF.UI.mapOpen = false;
      VF.UI.classSelectOpen = false;
      VF.UI.spawnSelectOpen = false;
      if (VF.UI.els) {
        if (VF.UI.els.inventory) VF.UI.els.inventory.classList.add('hidden');
        if (VF.UI.els.mapOverlay) VF.UI.els.mapOverlay.classList.add('hidden');
      }
    }
    if (game.player) {
      game.player.zipRide = null;
      game.player.dead = false;
      game.player.alive = true;
    }
  }

  function beginMatch() {
    if (!game.player || !game.renderer) return;
    if (game.mode === 'pvp' && game.pvp && game.pvp.team && game.world.setPlayerTeam) {
      game.world.setPlayerTeam(game.pvp.team);
    }
    if (!game.world._playerTeam || !game.world.getSelectedSpawn()) return;
    // First spawn confirm locks faction for this match (incl. death redeploy)
    game.teamLocked = true;
    game.lockedTeam = game.world._playerTeam;
    // Enable the sim immediately so a later throw cannot leave the player frozen
    game.running = true;
    game.levelEditing = false;
    try {
      clearMatchBlockers();
      VF.UI.closeSpawnSelect();
      if (VF.Pvp && VF.Pvp.els && VF.Pvp.els.matchReadyOverlay) {
        VF.Pvp.els.matchReadyOverlay.classList.add('hidden');
      }
      game.player.team = game.world._playerTeam;
      if (game.playerClass && game.player.applyClass) {
        game.player.applyClass(game.playerClass);
      }
      if (game.player.respawn) game.player.respawn();
      game.player._reviveProtection =
        (VF.Feel && VF.Feel.conquest && VF.Feel.conquest.spawnProtectionSec) || 1.5;
      game.player._cqTicketPending = false;
      if (game.bases && game.bases.applyPlayerTeam) {
        game.bases.applyPlayerTeam();
      }
      if (game.ai && game.ai.applyPlayerTeam) {
        game.ai.applyPlayerTeam();
      }
      if (VF.Squads && VF.Squads.buildRosters) VF.Squads.buildRosters(game);
      game.player.applySelectedSpawn();
      if (game.world) game.world._deployList = null;
      if (game.player.unstuckFromWorld) game.player.unstuckFromWorld();
      if (game.world && game.world.ensureMeshedAround && game.player.object) {
        const sp = game.player.object.position;
        game.world.ensureMeshedAround(sp.x, sp.z, 8);
      }
      VF.UI.showHud();
      game.player.cores = 1;
      game.player.blocks = 8;
      game._towerGunArmed = false;
      if (game.skills && game.skills.reset) game.skills.reset();
      game._coinGranted = false;
      game._towerCoinsCharged = false;
      game._towerUnpaid = false;
      if (game.weapons && game.weapons.syncOwnedLoadout) game.weapons.syncOwnedLoadout();
      if (VF.Economy && VF.Economy.applyMatchLoadout) {
        VF.Economy.applyMatchLoadout(game.player, game.weapons);
      }
      if (VF.Economy && VF.Economy.chargeTowerForMatch) {
        VF.Economy.chargeTowerForMatch();
      }
      if (VF.UI && VF.UI.syncWeaponLocks) VF.UI.syncWeaponLocks();
      if (
        (game.mode !== 'pvp' || (game.pvp && game.pvp.conquest)) &&
        VF.Conquest &&
        VF.Conquest.start
      ) {
        if (VF.NetSimulation && VF.NetSimulation.reset) VF.NetSimulation.reset();
        VF.Conquest.start(game);
        if (VF.Revive && VF.Revive.reset) VF.Revive.reset();
        if (VF.MatchFlow && VF.MatchFlow.start) VF.MatchFlow.start(game);
      } else if (VF.Conquest && VF.Conquest.stop) {
        VF.Conquest.stop();
      }
      if (VF.Audio) {
        VF.Audio.play('confirm');
      }
      if (game.mode === 'pvp' && VF.Pvp) {
        VF.Pvp.phase = 'play';
        VF.Pvp.ensureRemoteAvatar(game.scene);
        if (VF.UI.toast) VF.UI.toast('已进入同一战场 · 寻找对手');
      }
    } catch (err) {
      console.error('[VF] beginMatch', err);
      game.running = true;
      if (VF.UI && VF.UI.showHud) VF.UI.showHud();
      if (
        (game.mode !== 'pvp' || (game.pvp && game.pvp.conquest)) &&
        VF.Conquest &&
        !VF.Conquest.active &&
        VF.Conquest.start
      ) {
        try {
          if (VF.NetSimulation && VF.NetSimulation.reset) VF.NetSimulation.reset();
          VF.Conquest.start(game);
          if (VF.MatchFlow && VF.MatchFlow.start) VF.MatchFlow.start(game);
        } catch (err2) {
          console.error('[VF] Conquest.start', err2);
        }
      }
    }
    const canvas = game.renderer.domElement;
    setTimeout(function () {
      if (game.running && document.pointerLockElement !== canvas) {
        try {
          canvas.requestPointerLock();
        } catch (_) {}
      }
    }, 0);
  }

  function matchAlreadyEnded() {
    if (game.bases && (game.bases.won || game.bases.lost)) return true;
    if (game.mode === 'pvp' && VF.Pvp && VF.Pvp._matchEnded) return true;
    return false;
  }

  function openRedeployFromDeath() {
    if (!game.player || !game.world) return;
    if (matchAlreadyEnded()) return;
    if (VF.UI && VF.UI.hideDeath) VF.UI.hideDeath();

    // Keep existing map / cores — do not call prepareMatchMap
    if (game.mode === 'pvp' && game.pvp && game.pvp.team && game.world.setPlayerTeam) {
      game.world.setPlayerTeam(game.pvp.team);
    } else if (game.teamLocked && game.lockedTeam && game.world.setPlayerTeam) {
      game.world.setPlayerTeam(game.lockedTeam);
    } else if (game.player.team && game.world.setPlayerTeam) {
      game.world.setPlayerTeam(game.player.team);
    }

    VF.UI.openSpawnSelect(
      game.world,
      function () {
        resumeAfterRedeploy();
      },
      function () {
        VF.UI.closeSpawnSelect();
        if (matchAlreadyEnded()) return;
        if (VF.UI && VF.UI.showDeath) {
          VF.UI.showDeath('你已阵亡', '血量耗尽 · 等待重新部署', '选个出生点再上！');
        }
      },
      { redeploy: true, countdown: (VF.CONQUEST && VF.CONQUEST.DEPLOY_COUNTDOWN) || 5 }
    );
  }

  function resumeAfterRedeploy() {
    if (!game.player || !game.renderer) return;
    if (matchAlreadyEnded()) return;
    if (game.teamLocked && game.lockedTeam && game.world.setPlayerTeam) {
      game.world.setPlayerTeam(game.lockedTeam);
    }
    if (VF.Conquest && VF.Conquest.active && VF.Conquest.applyDeployList) {
      VF.Conquest.applyDeployList(game.world, game.world._playerTeam);
    }
    if (!game.world._playerTeam || !game.world.getSelectedSpawn()) return;

    game.running = true;
    game.levelEditing = false;
    try {
      clearMatchBlockers();
      VF.UI.closeSpawnSelect();
      if (VF.UI && VF.UI.hideDeath) VF.UI.hideDeath();

      game.player.team = game.world._playerTeam;
      if (game.playerClass && game.player.applyClass) {
        game.player.applyClass(game.playerClass);
      }
      if (game.player.respawn) game.player.respawn();
      game.player._reviveProtection =
        (VF.Feel && VF.Feel.conquest && VF.Feel.conquest.spawnProtectionSec) || 1.5;
      const ticketPending = game.player._cqTicketPending;
      if (ticketPending && VF.Conquest) {
        const netGuest =
          VF.NetSimulation &&
          VF.NetSimulation.isNetworkConquest(game) &&
          !VF.NetSimulation.isAuthority(game);
        if (netGuest && VF.NetSimulation.sendCommand) {
          VF.NetSimulation.sendCommand('casualty', {
            lifeId: ticketPending.lifeId,
            subjectId: 'remote-player',
            reason: ticketPending.reason || 'combat',
            killerId: ticketPending.killerId || null,
            killerTeam: ticketPending.killerTeam || null,
            victimTeam: ticketPending.victimTeam || game.player.team,
          });
          const localCasualty =
            VF.Conquest._casualties &&
            VF.Conquest._casualties[ticketPending.casualtyId];
          if (localCasualty && localCasualty.status === 'pending') {
            localCasualty.status = 'submitted';
            localCasualty.finalizedAt = VF.Conquest.elapsed;
          }
        } else if (VF.Conquest.finalizeCasualty) {
          VF.Conquest.finalizeCasualty(ticketPending.casualtyId, {
            reason: ticketPending.reason || 'deploy',
          });
        }
        if (VF.Conquest.onRespawn) {
          VF.Conquest.onRespawn(game.player.team || game.world._playerTeam || 'ally', {
            casualtyId: ticketPending.casualtyId,
          });
        }
      }
      game.player._cqTicketPending = false;
      game.player.applySelectedSpawn();
      if (game.world) game.world._deployList = null;
      if (game.player.unstuckFromWorld) game.player.unstuckFromWorld();
      if (game.world && game.world.ensureMeshedAround && game.player.object) {
        const sp = game.player.object.position;
        game.world.ensureMeshedAround(sp.x, sp.z, 8);
      }
      if (game.skills && game.skills.reset) game.skills.reset();
      VF.UI.showHud();
      if (VF.Audio) {
        VF.Audio.play('confirm');
      }
      if (game.mode === 'pvp' && VF.Pvp) {
        VF.Pvp.phase = 'play';
        VF.Pvp.ensureRemoteAvatar(game.scene);
      }
    } catch (err) {
      console.error('[VF] resumeAfterRedeploy', err);
      game.running = true;
    }
    const canvas = game.renderer.domElement;
    setTimeout(function () {
      if (game.running && document.pointerLockElement !== canvas) {
        try {
          canvas.requestPointerLock();
        } catch (_) {}
      }
    }, 0);
  }

  function returnFromDeathToHub() {
    if (VF.UI && VF.UI.hideDeath) VF.UI.hideDeath();
    if (VF.UI && VF.UI.hideVictory) VF.UI.hideVictory();
    if (VF.UI && VF.UI.closeSpawnSelect) VF.UI.closeSpawnSelect();
    game.running = false;
    game.teamLocked = false;
    game.lockedTeam = null;
    if (game.player) game.player._cqTicketPending = false;
    if (VF.Conquest && VF.Conquest.stop) VF.Conquest.stop();
    if (game.mode === 'pvp' && VF.Pvp && VF.Pvp.leaveLobby) {
      VF.Pvp.leaveLobby();
      game.mode = 'pve';
      game.pvp = null;
    }
    openFrontlineHub();
    syncGameBackBtn();
  }

  function setupPointerLock() {
    const canvas = game.renderer.domElement;
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === canvas;
      game.player.setPointerLock(locked);
      if (!locked && game.running) {
        // Click canvas again to re-lock
      }
    });
    canvas.addEventListener('click', () => {
      if (VF.Lobby && VF.Lobby.isOpen && VF.Lobby.isOpen()) return;
      if (VF.Hub && VF.Hub.isOpen) return;
      if (VF.UI && VF.UI.isMenuOpen && VF.UI.isMenuOpen()) return;
      if (VF.Range && VF.Range.isOpen) {
        if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
        return;
      }
      if (game.running && document.pointerLockElement !== canvas) {
        canvas.requestPointerLock();
      }
    });
  }

  function setupInventoryToggle() {
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Tab') return;
      e.preventDefault();
      if (!game.running) return;
      if (VF.UI.mapOpen) VF.UI.setMapOpen(false);
      if (VF.UI.spawnSelectOpen) return;
      if (VF.Conquest && VF.Conquest.active && VF.UI.toggleScoreboard) {
        VF.UI.toggleScoreboard();
        return;
      }
      const open = VF.UI.toggleInventory();
      if (open) {
        document.exitPointerLock();
      } else if (game.running) {
        game.renderer.domElement.requestPointerLock();
      }
    });
  }

  function setupMapToggle() {
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyM') return;
      if (!game.running) return;
      e.preventDefault();
      if (VF.UI.inventoryOpen) {
        VF.UI.inventoryOpen = false;
        if (VF.UI.els.inventory) VF.UI.els.inventory.classList.add('hidden');
      }
      const open = VF.UI.toggleMap();
      if (open) {
        document.exitPointerLock();
        VF.UI.drawBigMap(game.player, game.world, game.ai.enemies, game.ai.allies);
      } else if (game.running) {
        game.renderer.domElement.requestPointerLock();
      }
    });
  }

  function onResize() {
    game.camera.aspect = window.innerWidth / window.innerHeight;
    game.camera.updateProjectionMatrix();
    game.renderer.setSize(window.innerWidth, window.innerHeight);
    if (VF.Hub) VF.Hub.onResize();
  }

  function animate() {
    requestAnimationFrame(animate);
    try {
      _animateFrame();
    } catch (err) {
      console.error('[VF] animate', err);
    }
  }

  function _animateFrame() {
    const rawDt = Math.min(game.clock.getDelta(), 0.05);
    if (game._hitstop > 0) {
      game._hitstop -= rawDt;
      if (game._hitstop <= 0) {
        game._hitstop = 0;
        game.timeScale = 1;
      }
    } else if (game.timeScale !== 1) {
      game.timeScale = 1;
    }
    const dt = rawDt * (game.timeScale != null ? game.timeScale : 1);

    const rangeOpen = !!(VF.Range && VF.Range.isOpen);

    // Deferred voxel mesh rebuilds — prefer chunks around the player so the road loads first
    if (!rangeOpen && game.world && game.world.flushRebuilds) {
      const pref =
        game.player && game.player.object
          ? game.player.object.position
          : null;
      // Hard wall-clock budget: never turn a mesh backlog into a multi-hundred-ms frame.
      game.world.flushRebuilds(6, pref ? pref.x : null, pref ? pref.z : null);
    }

    // Resource spin / bob
    if (!rangeOpen) {
      const t = game.clock.elapsedTime;
      for (let i = 0; i < game.resources.length; i++) {
        const r = game.resources[i];
        r.mesh.rotation.y = t * 1.5 + r.spin;
        r.mesh.position.y += Math.sin(t * 2 + r.spin) * 0.002;
      }
    }

    // PVP sync continues while dead/redeploying so core HP + remote avatar stay live
    if (game.mode === 'pvp' && VF.Pvp && VF.Pvp.phase === 'play' && game.player && !VF.Pvp._matchEnded) {
      const pos = game.player.object.position;
      VF.Pvp.publishPlayState({
        x: pos.x,
        y: pos.y,
        z: pos.z,
        yaw: game.player.yaw,
        hp: game.player.health,
        alive: !game.player.dead,
        crouch: !!game.player.crouching,
        classId: game.player.classId || game.playerClass || 'assault',
        team: game.player.team || game.world._playerTeam,
        stealth: !!game.player.stealthed,
      });
      VF.Pvp.updateRemoteAvatar(game.scene, dt);
      VF.Pvp.tickMatch(dt, game);
      if (
        game.player.dead &&
        VF.UI.pausesWorld &&
        VF.UI.pausesWorld()
      ) {
        if (game.bases) game.bases.update(dt);
      }
    }

    if (game.running && game.skills && VF.UI.isMenuOpen()) {
      // Menus pause combat, but keep stealth/CD clocks
      if (game.skills.stealthTimer > 0 || (game.player && game.player.stealthed)) {
        game.skills._updateStealth(dt);
        if (game.skills.cooldown > 0) {
          game.skills.cooldown = Math.max(0, game.skills.cooldown - dt);
        }
        game.skills._syncHud();
      }
    }

    const menuOpen = !!(VF.UI && VF.UI.isMenuOpen && VF.UI.isMenuOpen());
    const worldPaused = !!(VF.UI && VF.UI.pausesWorld && VF.UI.pausesWorld());
    const playerCanAct = game.running && !menuOpen && game.player && !game.player.dead;

    if (playerCanAct) {
      try {
        game.player.update(dt);
      } catch (err) {
        console.error('[VF] player.update', err);
        if (game.player.unstuckFromWorld) game.player.unstuckFromWorld();
      }
      if (!game.levelEditing) {
        if (game.player.locked) {
          game.weapons.update(dt);
          if (game.skills) game.skills.update(dt);
          game.building.update(dt);
        } else if (game.skills) {
          if (game.skills.stealthTimer > 0 || (game.player && game.player.stealthed)) {
            game.skills._updateStealth(dt);
          }
          if (game.skills.cooldown > 0) {
            game.skills.cooldown = Math.max(0, game.skills.cooldown - dt);
          }
          game.skills._syncHud();
        }
        if (VF.Audio && game.player.locked) VF.Audio.update(dt, game.player);
      } else if (game.world && game.world.ensureMeshedAround && game.player.object) {
        game.world.ensureMeshedAround(
          game.player.object.position.x,
          game.player.object.position.z,
          8
        );
      }

      VF.UI.setAiming(
        game.player.aiming && game.weapons.mode === 'weapon',
        game.weapons.getDef && game.weapons.getDef().scope,
        game.player._adsBlend || 0
      );
      if (!game.levelEditing) {
        const nearCollect = game.building.getNearbyHint();
        const nearZip = game.player.findNearbyZipline && game.player.findNearbyZipline(7.5);
        if (nearCollect) {
          VF.UI.setInteractHint(true, '按 <kbd>E</kbd> 拾取');
        } else if (nearZip) {
          VF.UI.setInteractHint(true, '按 <kbd>F</kbd> 乘坐滑索 · 空格跳下');
        } else if (VF.Conquest && VF.Conquest.active && VF.Conquest.playerHint) {
          VF.UI.setInteractHint(false);
        } else {
          VF.UI.setInteractHint(false);
        }
        VF.UI.updateResources(game.player.cores, game.player.blocks);
        VF.UI.updateVitals(game.player.health, game.player.armor);
      } else {
        VF.UI.setInteractHint(false);
        if (VF.MapEditor && VF.MapEditor.update) VF.MapEditor.update();
      }

      if (game.weapons.mode === 'weapon' && game.building.active) {
        game.building.exitMode();
      }
    } else if (game.player && !rangeOpen) {
      const eye = game.player.getEyePosition();
      game.camera.position.copy(eye);
      if (!game._idleEuler) game._idleEuler = new THREE.Euler(0, 0, 0, 'YXZ');
      game._idleEuler.set(game.player.pitch, game.player.yaw, 0);
      game.camera.quaternion.setFromEuler(game._idleEuler);
    }

    if (game.running && !game.levelEditing && !worldPaused) {
      if (VF.Revive && VF.Revive.update) VF.Revive.update(dt, game);
      if (VF.Squads && VF.Squads.update) VF.Squads.update(dt, game);
      if (VF.Gadgets && VF.Gadgets.update) VF.Gadgets.update(dt, game);
      if (VF.Comms && VF.Comms.update) VF.Comms.update(dt, game);
      if (VF.MatchFlow && VF.MatchFlow.update) VF.MatchFlow.update(dt, game);
      if (game.ai) game.ai.update(dt);
      if (game.bases) game.bases.update(dt);
      if (
        VF.Conquest &&
        VF.Conquest.active &&
        VF.Conquest.update &&
        (!VF.MatchFlow || VF.MatchFlow.canRunRules(game))
      ) {
        VF.Conquest.update(dt, game);
      }
      if (VF.NetSimulation && VF.NetSimulation.update) VF.NetSimulation.update(dt, game);
      if (game.player && game.player.object) {
        if (game.atmosphere && game.atmosphere.update) {
          game.atmosphere.update(dt, game.player.object.position);
        }
        if (VF.updateWorldBoundary) {
          VF.updateWorldBoundary(dt, game.player.object.position);
        }
        if (game.world.updateChunkVisibility) {
          const p = game.player.object.position;
          game.world.updateChunkVisibility(p.x, p.z, 340);
        }
        if (
          VF.DEBUG_TERRAIN &&
          game.world.getTerrainStats &&
          (!game._terrainStatsAt || performance.now() - game._terrainStatsAt > 1000)
        ) {
          game._terrainStatsAt = performance.now();
          console.debug('[Terrain]', game.world.getTerrainStats());
        }
      }
      if (game.bases && (game.bases.won || game.bases.lost)) {
        game.running = false;
        document.exitPointerLock && document.exitPointerLock();
      }
      if (game.mode === 'pvp' && VF.Pvp && VF.Pvp._matchEnded) {
        game.running = false;
        document.exitPointerLock && document.exitPointerLock();
      }
    }

    if (VF.UI && VF.UI.tickDeployCountdown) VF.UI.tickDeployCountdown();

    // Minimap ~12 fps; big map only when open (skip during level edit)
    if (game.running && !game.levelEditing) {
      const now = performance.now();
      if (!game._mmAt || now - game._mmAt > 80) {
        game._mmAt = now;
        VF.UI.drawMinimap(game.player, game.world, game.ai.enemies, game.resources, game.ai.allies);
      }
      if (VF.UI.mapOpen) {
        VF.UI.drawBigMap(game.player, game.world, game.ai.enemies, game.ai.allies);
      }
    }

    if (rangeOpen) {
      VF.Range.update(dt);
      VF.Range.render();
    } else if (VF.Hub && VF.Hub.isOpen) {
      VF.Hub.update(dt);
      VF.Hub.render();
    } else {
      game.renderer.render(game.scene, game.camera);
    }
  }

  // Boot — paint LOADING before heavy sync world gen
  requestAnimationFrame(() => {
    requestAnimationFrame(() => init());
  });
})();
