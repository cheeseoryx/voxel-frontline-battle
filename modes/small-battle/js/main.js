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
    mode: 'pve', // 'pve' | 'pvp' — 对战形式 / 网络拓扑
    matchMode: 'core', // 'core' | 'tdm' — 玩法规则 (js/gamemodes.js)
    pvp: null,
    timeScale: 1,
    _hitstop: 0,
    teamLocked: false,
    lockedTeam: null,
  };

  globalThis.VF = globalThis.VF || {};
  VF.game = game;
  /** Exposed for TdmSpawn: reuses the full redeploy path (reset → spawn → lock). */
  game.resumeAfterRedeploy = function () {
    resumeAfterRedeploy();
  };
  /** Exposed for TdmUi/TdmMatch: the shared "leave the match" path. */
  game.returnFromMatch = function () {
    returnFromDeathToHub();
  };

  /** Kept for API compat — world freeze removed (felt laggy / half-beat late) */
  VF.triggerHitstop = function () {
    /* no-op: use player.punchFeedback instead */
  };

  function init() {
    if(!VFEntry.selection.mode){VFEntry.goLobby();return;}
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
      if (label) label.textContent = '小型战斗 · 加载中…';
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
          if (label) label.textContent = '小型战斗';
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
      if (VFEntry.selection.mode) {
        VF.GameModes.setMode(VFEntry.selection.mode);
        VF.Pvp.quickMatch(VFEntry.selection.mode, VFEntry.selection.room);
      } else VFEntry.goLobby();
    } catch (err) {
      VFEntry.hideTransition();
      console.error(err);
      if (enterHubBtn) {
        enterHubBtn.disabled = false;
        const label = enterHubBtn.querySelector('span:last-child');
        if (label) label.textContent = '小型战斗 · 重试';
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

    // Sky dome + sun + ambient, all driven by VF.RenderConfig (see
    // render-scene.js). Falls back to fixed noon daylight if that fails.
    game.renderScene = VF.createRenderScene ? VF.createRenderScene(scene) : null;
    if (!game.renderScene) {
      const ambient = new THREE.AmbientLight(0xd4e2f2, 0.62);
      scene.add(ambient);

      const sun = new THREE.DirectionalLight(0xfff2cc, 1.05);
      sun.position.set(-60, 45, 25);
      sun.castShadow = false;
      scene.add(sun);

      const fill = new THREE.DirectionalLight(0x5a8ac8, 0.28);
      fill.position.set(40, 20, -30);
      scene.add(fill);
    }

    // Post-processing pipeline (Composer + Pass system; falls back to direct
    // renderer.render when RenderConfig.enabled is false or init fails).
    if (VF.createRenderPipeline) {
      game.pipeline = VF.createRenderPipeline(renderer, window.innerWidth, window.innerHeight);
    }

    // Voxel world
    game.world = new VF.VoxelWorld(scene, { deferGeneration: true });

    // Ally / enemy glowing bases (sets spawn + objective positions)
    game.bases = new VF.Bases(scene, game.world);

    // Selected-mode terrain is generated once when its room seed is available.
    game._mapKitLayout = false;

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

    // Timed atmosphere events (drone missile strikes, etc.)
    if (VF.createBattlefieldEvents) {
      game.battlefieldEvents = VF.createBattlefieldEvents(scene);
    }

    // UI
    VF.UI.init();
    bindGameBackBtn();
    VF.syncGameBackBtn = syncGameBackBtn;
    VF.exitToLobby = exitToLobby;
    if (VF.UI.setDeathHandlers) {
      VF.UI.setDeathHandlers({
        onRedeploy: function () {
          openRedeployFromDeath();
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
    VF.UI.updateSquad(0, 0, '摧毁对方核心');
    VF.UI.setMissionTargetLabel('红方核心');
    VF.UI.setHomeCoreLabel('蓝方核心');
    VF.UI.updateMissionCore(1000, 1000);
    VF.UI.updateHomeCore(1000, 1000);

    // Match resources are seeded with the selected map in prepareMatchMap().

    // Flat pixel lobby (+ keep Hub craft overlays via Hub.init)
    if (VF.Hub) {
      VF.Hub.init(renderer);
      VF.Hub.setHandlers({
        onPve: function () {
          pickModeThen('pve', startGame);
        },
        onPvpCreate: function () {
          // Host picks the mode; the guest inherits it over the room sync
          pickModeThen('pvp', function () {
            if (VF.Pvp && VF.Pvp.createRoom) VF.Pvp.createRoom();
          });
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
          VFEntry.goHome();
        },
      });
    }

    if (VF.Lobby) {
      VF.Lobby.init();
      VF.Lobby.setHandlers({
        onPve: function () {
          pickModeThen('pve', startGame);
        },
        onPvp: function () {
          pickModeThen('pvp', function () {
            if (VF.Hub && VF.Hub.openCraft) VF.Hub.openCraft('pvp');
          });
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
          VFEntry.goHome();
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
    VFEntry.goLobby();
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

  function wipeMatchFx() {
    if (VF.Audio && VF.Audio.clearPending) VF.Audio.clearPending();
    if (game.ai && game.ai._clearDeathFx) game.ai._clearDeathFx();
    if (game.weapons && game.weapons.clearWorldFx) game.weapons.clearWorldFx();
    if (game.bases && game.bases.clearWorldFx) game.bases.clearWorldFx();
    if (VF.SdField && VF.SdField._killDetonation) VF.SdField._killDetonation();
  }

  function returnToHub() {
    if (VF.Career && VF.Career.finish) VF.Career.finish(null);
    game.teamLocked = false;
    game.lockedTeam = null;
    game.running = false;
    if (VF.TdmMatch && VF.TdmMatch.stop) VF.TdmMatch.stop();
    if (VF.TdmSpawn && VF.TdmSpawn.stop) VF.TdmSpawn.stop();
    if (VF.TdmUi && VF.TdmUi.leave) VF.TdmUi.leave();
    if (VF.SdMatch && VF.SdMatch.stop) VF.SdMatch.stop();
    if (VF.SdSpawn && VF.SdSpawn.stop) VF.SdSpawn.stop();
    if (VF.SdField && VF.SdField.stop) VF.SdField.stop();
    if (VF.SdUi && VF.SdUi.leave) VF.SdUi.leave();
    if (VF.FfaMatch && VF.FfaMatch.stop) VF.FfaMatch.stop();
    if (VF.FfaSpawn && VF.FfaSpawn.stop) VF.FfaSpawn.stop();
    if (VF.FfaUi && VF.FfaUi.leave) VF.FfaUi.leave();
    if (VF.GgMatch && VF.GgMatch.stop) VF.GgMatch.stop();
    if (VF.GgUi && VF.GgUi.leave) VF.GgUi.leave();
    if (VF.Throwables && VF.Throwables.stop) VF.Throwables.stop();
    if (VF.WeaponInspect && VF.WeaponInspect.cancel) VF.WeaponInspect.cancel();
    if (game.battlefieldEvents && game.battlefieldEvents.stop) game.battlefieldEvents.stop();
    if (document.exitPointerLock) document.exitPointerLock();
    if (VF.UI && VF.UI.hideHud) VF.UI.hideHud();
    if (VF.UI && VF.UI.hideDeath) VF.UI.hideDeath();
    if (VF.UI && VF.UI.hideVictory) VF.UI.hideVictory();
    if (VF.UI && VF.UI.closeClassSelect) VF.UI.closeClassSelect();
    if (VF.UI && VF.UI.closeSpawnSelect) VF.UI.closeSpawnSelect();
    if (VF.TowerDesigner && VF.TowerDesigner.open) VF.TowerDesigner.close();
    if (VF.MapEditor && VF.MapEditor.isOpen && VF.MapEditor.isOpen()) {
      VF.MapEditor.close({ skipLobby: true });
    }
    if (VF.Range && VF.Range.isOpen) VF.Range.close(true);
    if (game.ai && game.ai._clearUnits) game.ai._clearUnits();
    wipeMatchFx();
    if (VF.Audio && VF.Audio.setInMatch) VF.Audio.setInMatch(false);
    const cover = document.getElementById('start-overlay');
    if (cover) cover.classList.add('hidden');
    if (VF.Hub && VF.Hub.hide) VF.Hub.hide();
    if (VF.Lobby) VF.Lobby.openLobby();
    syncGameBackBtn();
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
      if (VF.Lobby) VF.Lobby.openLobby();
      syncGameBackBtn();
      return;
    }
    if (VF.GameModes && VF.GameModes.isOpen && VF.GameModes.isOpen()) {
      VF.GameModes.close(true);
      syncGameBackBtn();
      return;
    }
    if (VF.TowerDesigner && VF.TowerDesigner.open) {
      VF.TowerDesigner.close();
      if (VF.Lobby) VF.Lobby.openLobby();
      syncGameBackBtn();
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
    const modeOpen = !!(VF.GameModes && VF.GameModes.isOpen && VF.GameModes.isOpen());
    const show =
      !lobbyOpen &&
      !coverOpen &&
      !modeOpen &&
      (hubOpen || rangeOpen || hudOpen || mapOpen || game.running);
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
    if (VF.Pvp && VF.Pvp.quickSession) {
      if (game._mapReadyForSeed !== game.mapSeed) prepareMatchMap();
      assignTdmStartSpawn();
    }
    VF.UI.openClassSelect(
      function (classId) {
        if (game.player && game.player.applyClass) {
          game.player.applyClass(classId);
        }
        game.playerClass = classId;
        if (VF.Lobby && VF.Lobby.setPreviewClass) VF.Lobby.setPreviewClass(classId);
        VF.UI.closeClassSelect();
        if (VF.Pvp && VF.Pvp.quickSession) openQuickDeployment();
        else openSpawnSelect();
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
    VFEntry.hideTransition();
  }

  function openQuickDeployment(remainingSec) {
    const classes = VF.Soldier.CLASSES;
    const selected = classes.find(c => c.id === game.playerClass) || classes[0];
    const teamless = VF.GameModes.isTeamless();
    const ids = teamless ? [selected] : [classes.find(c => c.id !== selected.id), selected].concat(classes.filter(c => c.id !== selected.id).slice(1,3));
    const weaponId = VF.GameModes.isGg() ? null : VF.Economy.weaponForSlot(1);
    const weapon = weaponId && VF.WEAPONS[weaponId];
    const roster = ids.map((c,i) => ({classId:c.id,className:c.nameZh||(c.label||'').split('|').pop().trim()||c.id,name:c.id === selected.id?'你':'AI 支援 '+(i+1),isPlayer:c.id === selected.id,weapon:c.id===selected.id?(weapon?weapon.nameZh||weapon.name:'武器阶梯'):'兵种制式装备'}));
    VF.UI.openSquadIntro(roster, function () {
      VF.Pvp.enterQuickBattle({classId:game.playerClass,team:game.world._playerTeam,spawnId:game.world._selectedSpawnId}, beginMatch);
    }, {durationSec:remainingSec == null ? 3 : remainingSec,mapName:game.world._mapName||'作战区域',modeName:VFEntry.modeNames[VF.GameModes.currentId()],factionName:game.world._playerTeam==='enemy'?'赤焰军团':'和平军团',
      onBack:openClassSelect,
      onCustomize:function(left){ if(VF.GameModes.isGg()) { openClassSelect(); return; } VF.Arsenal.show({onClose:function(){openQuickDeployment(left);}}); }
    });
  }

  function returnToPvpLobby() {
    if (VF.Pvp && VF.Pvp.quickSession) { VF.Pvp.destroySession(); VFEntry.goLobby(); return; }
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

  /**
   * Both match entries (PVE / PVP) go through the mode picker first, so the
   * rule set is decided before any map or spawn work happens.
   */
  function pickModeThen(entry, next) {
    if (VF.Lobby && VF.Lobby.hide) VF.Lobby.hide();
    if (VF.Hub && VF.Hub.hide) VF.Hub.hide();
    if (!VF.GameModes || !VF.GameModes.open) {
      next();
      return;
    }
    VF.GameModes.open(
      entry,
      function () {
        next();
      },
      function () {
        returnToHub();
      }
    );
  }

  function startPvpMatch(info) {
    game.mode = 'pvp';
    game.pvp = info || null;
    game.teamLocked = false;
    game.lockedTeam = null;
    // Map is always hand-built (empty canvas + kit stamps); seed only for sync bookkeeping
    if (info && info.seed != null) game.mapSeed = info.seed >>> 0;
    else if (VF.Pvp && VF.Pvp.matchSeed != null) game.mapSeed = VF.Pvp.matchSeed >>> 0;
    else if (game.mapSeed == null) game.mapSeed = ((Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0);
    if (VF.Pvp && game.mapSeed != null) VF.Pvp.matchSeed = game.mapSeed;
    if (VF.UI && VF.UI.toast) {
      const side = info && info.team === 'enemy' ? '红方' : '蓝方';
      VF.UI.toast('房间已连接 · 你是' + side + ' · 空余席位由 AI 补充');
    }
    openClassSelect();
  }

  function startGame() {
    game.mode = 'pve';
    game.pvp = null;
    game.teamLocked = false;
    game.lockedTeam = null;
    if (game.mapSeed == null) {
      game.mapSeed = ((Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0);
    }
    openClassSelect();
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

  function buildingEnabled() {
    return !(VF.GameModes && VF.GameModes.param('building', true) === false);
  }

  function prepareMatchMap() {
    wipeMatchFx();
    let seed;
    if (game.mode === 'pvp' && VF.Pvp && VF.Pvp.matchSeed != null) {
      seed = VF.Pvp.matchSeed >>> 0;
    } else if (game.mapSeed != null) {
      seed = game.mapSeed >>> 0;
    } else {
      seed = ((Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0);
      game.mapSeed = seed;
    }

    const tdm = !!(VF.GameModes && VF.GameModes.isTdm());
    const sd = !!(VF.GameModes && VF.GameModes.isSd());
    const personalFfa = !!(
      VF.GameModes &&
      VF.GameModes.isFfa &&
      VF.GameModes.isFfa() &&
      game.mode !== 'pvp'
    );
    // 枪械模式直接复用 自由混战 的随机地图
    const ffa = !!(VF.GameModes && VF.GameModes.isTeamless && VF.GameModes.isTeamless());
    if (personalFfa && game.world && game.world.generateFfaDistrictMap) {
      if (game.bases && game.bases.detach) game.bases.detach();
      game.world.generateFfaDistrictMap(seed);
      game.world.applyTdmSpawnPoints();
      game._mapKitLayout = false;
    } else if (ffa && game.world && game.world.generateFfaMap) {
      // 自由混战 / 枪械模式: a dedicated compact 60×60 arena (环+中心 循环流动) — no
      // kit stamps, no cores, no crystals. Reuses the 死斗 spawn/flow plumbing.
      if (game.bases && game.bases.detach) game.bases.detach();
      game.world.generateFfaMap(seed);
      game.world.applyTdmSpawnPoints();
      game._mapKitLayout = false;
    } else if (tdm && game.world && game.world.generateTdmMap) {
      // 团队死斗 shares the procedural arena: no kit stamps, no cores,
      // no crystals.
      if (game.bases && game.bases.detach) game.bases.detach();
      game.world.generateTdmMap(seed, {
        heightCap: VF.GameModes.param('mapHeightCap', 26),
      });
      game.world.applyTdmSpawnPoints();
      game._mapKitLayout = false;
    } else if (sd && game.world && game.world.generateSdMap) {
      // 爆破 generates a compact arena (≈1.25× 死斗) up front instead of scaling the
      // full hand-built board: spawns, cover and the A/B sites all live inside it.
      // SdSpawn re-rolls a fresh arena at the start of every round after the first.
      if (game.bases && game.bases.detach) game.bases.detach();
      game.world.generateSdMap(seed, {
        heightCap: VF.GameModes.param('mapHeightCap', 26),
      });
      game.world.applyTdmSpawnPoints();
      game._mapKitLayout = false;
    } else if (VF.MapEditor && VF.MapEditor.applyMatchMap) {
      // Core objective: empty terrain/roads + hand-built map-kit stamps
      if (game.bases && game.bases.reattach) game.bases.reattach();
      // core modes keep their canal river; 爆破 no longer routes here.
      if (game.world) game.world._tdmArena = false;
      VF.MapEditor.applyMatchMap();
    } else if (game.world && game.world.regenerate) {
      if (game.bases && game.bases.reattach) game.bases.reattach();
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
    // Build materials are pointless when building is off
    if (buildingEnabled()) seedResources();

    game.mapSeed = seed;
    game._mapReadyForSeed = seed;
    game._mapKitLayout = !(tdm || sd || ffa);
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
    if (game.mode === 'pvp' && game.pvp && game.pvp.team && game.world.setPlayerTeam && !(VF.GameModes && VF.GameModes.isTeamless())) {
      game.world.setPlayerTeam(game.pvp.team);
    } else if (game.teamLocked && game.lockedTeam && game.world.setPlayerTeam) {
      game.world.setPlayerTeam(game.lockedTeam);
    }

    if (VF.Lobby) VF.Lobby.hide();
    if (VF.Hub) VF.Hub.hide();

    // 死斗 assigns spawns by the safety algorithm, so there is nothing to pick.
    // 爆破 is single-life and side-locked, so it also skips the spawn picker and
    // takes the team's home cluster (per-round respawns are owned by SdSpawn).
    // 自由混战 / 枪械模式 have no teams — the player takes any home cluster and
    // FfaSpawn owns every respawn thereafter, so they likewise skip the picker.
    if (
      VF.GameModes &&
      (VF.GameModes.isTdm() || VF.GameModes.isSd() || VF.GameModes.isTeamless())
    ) {
      assignTdmStartSpawn();
      if (game.mode === 'pvp' && VF.Pvp && VF.Pvp.roomCode) openPvpSpawnGate();
      else beginMatch();
      return;
    }

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
        openClassSelect();
      }
    );
  }

  /**
   * Opening spawn for 死斗: lock a side, then take that side's home cluster.
   * The safety-scored picker takes over from the first respawn onward.
   */
  function assignTdmStartSpawn() {
    const w = game.world;
    if (!w) return null;

    let team = null;
    // 自由混战 / 枪械模式: the player is always the lone blue ally, so the "self
    // blue, everyone else red" identity and player-fire raycasts stay correct no
    // matter what a previous match locked.
    if (VF.GameModes && VF.GameModes.isTeamless()) team = 'ally';
    else if (game.mode === 'pvp' && game.pvp && game.pvp.team) team = game.pvp.team;
    else if (game.teamLocked && game.lockedTeam) team = game.lockedTeam;
    else team = 'ally';
    if (w.setPlayerTeam) w.setPlayerTeam(team);

    game.teamLocked = true;
    game.lockedTeam = team;
    if (game.player) game.player.team = team;

    if (w.setTdmSpawnOverride) w.setTdmSpawnOverride(null);
    const list = (w._spawnPoints && w._spawnPoints[team]) || [];
    const home = list.length ? list[0] : null;
    if (home && w.setSelectedSpawn) w.setSelectedSpawn(home.id);
    return home;
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
      classId: game.playerClass || (game.player && game.player.classId) || 'vanguard',
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
    wipeMatchFx();
    if (VF.Audio && VF.Audio.setInMatch) VF.Audio.setInMatch(true);
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
      if (game.bases && game.bases.applyPlayerTeam) {
        game.bases.applyPlayerTeam();
      }
      if (game.ai && game.ai.applyPlayerTeam) {
        game.ai.applyPlayerTeam();
      }
      game.player.applySelectedSpawn();
      if (game.player.unstuckFromWorld) game.player.unstuckFromWorld();
      if (game.world && game.world.ensureMeshedAround && game.player.object) {
        const sp = game.player.object.position;
        game.world.ensureMeshedAround(sp.x, sp.z, 8);
      }
      VF.UI.showHud();
      const canBuild = buildingEnabled();
      game.player.cores = canBuild ? 1 : 0;
      game.player.blocks = canBuild ? 8 : 0;
      // Start the mode rules before the optional loadout/economy work, so a
      // failure there cannot leave 死斗 running with no clock or scoring
      if (VF.GameModes && VF.GameModes.isTdm()) {
        if (VF.TdmMatch) VF.TdmMatch.start();
        if (VF.TdmSpawn) VF.TdmSpawn.start();
        if (VF.TdmUi) VF.TdmUi.enter();
      } else if (VF.GameModes && VF.GameModes.isSd()) {
        // 爆破: SdField drives player intent, SdSpawn owns single-life rosters,
        // SdUi reuses the top-bar HUD, SdMatch runs the round/match timeline.
        if (VF.SdUi) VF.SdUi.enter();
        if (VF.SdField) VF.SdField.start();
        if (VF.SdSpawn) VF.SdSpawn.start();
        if (VF.SdStats) VF.SdStats.start();
        if (VF.SdMatch) VF.SdMatch.start();
      } else if (VF.GameModes && VF.GameModes.isFfa()) {
        // 自由混战: teamless. FfaMatch owns the clock + personal scoring, FfaSpawn
        // owns every respawn (player + AI reinforcements), FfaUi owns the live
        // leaderboard. No team HUD is touched.
        if (VF.FfaMatch) VF.FfaMatch.start();
        if (VF.FfaSpawn) VF.FfaSpawn.start();
        if (VF.FfaUi) VF.FfaUi.enter();
      } else if (VF.GameModes && VF.GameModes.isGg()) {
        // 枪械模式: teamless like 自由混战 and reuses FfaSpawn wholesale. GgMatch owns
        // the weapon ladder + progress scoring, GgUi owns the progress HUD.
        if (VF.GgMatch) VF.GgMatch.start();
        if (VF.FfaSpawn) VF.FfaSpawn.start();
        if (VF.GgUi) VF.GgUi.enter();
      } else {
        if (VF.TdmMatch) VF.TdmMatch.stop();
        if (VF.TdmUi) VF.TdmUi.leave();
      }
      if (VF.Throwables) {
        if (VF.GameModes && VF.GameModes.isGg && VF.GameModes.isGg()) VF.Throwables.stop();
        else VF.Throwables.start();
      }
      game._towerGunArmed = false;
      if (game.skills && game.skills.reset) game.skills.reset();
      game._coinGranted = false;
      game._towerCoinsCharged = false;
      game._towerUnpaid = false;
      if (VF.Career && VF.Career.start) VF.Career.start();
      if (game.weapons && game.weapons.syncOwnedLoadout) game.weapons.syncOwnedLoadout();
      if (VF.Economy && VF.Economy.applyMatchLoadout) {
        VF.Economy.applyMatchLoadout(game.player, game.weapons);
      }
      // Only bill the tower when the mode actually lets you deploy one
      if (canBuild && VF.Economy && VF.Economy.chargeTowerForMatch) {
        VF.Economy.chargeTowerForMatch();
      }
      if (VF.UI && VF.UI.syncWeaponLocks) VF.UI.syncWeaponLocks();
      if (game.battlefieldEvents && game.battlefieldEvents.reset) {
        game.battlefieldEvents.reset(game);
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
    }
    const canvas = game.renderer.domElement;
    setTimeout(function () {
      if (game.running && document.pointerLockElement !== canvas) {
        try {
          VF.FrontlineUI.requestPointerLock(canvas);
        } catch (_) {}
      }
    }, 0);
  }

  function matchAlreadyEnded() {
    if (VF.TdmMatch && VF.TdmMatch.active) return VF.TdmMatch.ended;
    if (VF.SdMatch && VF.SdMatch.active) return VF.SdMatch.ended;
    if (VF.FfaMatch && VF.FfaMatch.active) return VF.FfaMatch.ended;
    if (VF.GgMatch && VF.GgMatch.active) return VF.GgMatch.ended;
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
      }
    );
  }

  function resumeAfterRedeploy() {
    if (!game.player || !game.renderer) return;
    if (matchAlreadyEnded()) return;
    if (game.teamLocked && game.lockedTeam && game.world.setPlayerTeam) {
      game.world.setPlayerTeam(game.lockedTeam);
    }
    // 死斗 may target a neutral zone, which is not in either team's spawn list
    const forced = !!(game.world._tdmSpawnOverride);
    if (!game.world._playerTeam || (!forced && !game.world.getSelectedSpawn())) return;

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
      game.player.applySelectedSpawn();
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
          VF.FrontlineUI.requestPointerLock(canvas);
        } catch (_) {}
      }
    }, 0);
  }

  function returnFromDeathToHub() {
    if(VFEntry.selection.mode){game.running=false;game._leaving=true;VFEntry.goLobby();return;}
    if (VF.UI && VF.UI.hideDeath) VF.UI.hideDeath();
    if (VF.UI && VF.UI.hideVictory) VF.UI.hideVictory();
    if (VF.UI && VF.UI.closeSpawnSelect) VF.UI.closeSpawnSelect();
    game.running = false;
    game.teamLocked = false;
    game.lockedTeam = null;
    if (VF.TdmMatch && VF.TdmMatch.stop) VF.TdmMatch.stop();
    if (VF.TdmSpawn && VF.TdmSpawn.stop) VF.TdmSpawn.stop();
    if (VF.TdmUi && VF.TdmUi.leave) VF.TdmUi.leave();
    if (VF.SdMatch && VF.SdMatch.stop) VF.SdMatch.stop();
    if (VF.SdSpawn && VF.SdSpawn.stop) VF.SdSpawn.stop();
    if (VF.SdField && VF.SdField.stop) VF.SdField.stop();
    if (VF.SdUi && VF.SdUi.leave) VF.SdUi.leave();
    if (VF.FfaMatch && VF.FfaMatch.stop) VF.FfaMatch.stop();
    if (VF.FfaSpawn && VF.FfaSpawn.stop) VF.FfaSpawn.stop();
    if (VF.FfaUi && VF.FfaUi.leave) VF.FfaUi.leave();
    if (VF.GgMatch && VF.GgMatch.stop) VF.GgMatch.stop();
    if (VF.GgUi && VF.GgUi.leave) VF.GgUi.leave();
    if (VF.Throwables && VF.Throwables.stop) VF.Throwables.stop();
    if (VF.WeaponInspect && VF.WeaponInspect.cancel) VF.WeaponInspect.cancel();
    if (game.battlefieldEvents && game.battlefieldEvents.stop) game.battlefieldEvents.stop();
    if (VF.Audio && VF.Audio.setInMatch) VF.Audio.setInMatch(false);
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
        if (document.pointerLockElement !== canvas) VF.FrontlineUI.requestPointerLock(canvas);
        return;
      }
      if (game.running && document.pointerLockElement !== canvas) {
        VF.FrontlineUI.requestPointerLock(canvas);
      }
    });
  }

  function setupInventoryToggle() {
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Tab') return;
      e.preventDefault();
      if (!game.running) return;
      if (VF.UI.mapOpen) VF.UI.setMapOpen(false);
      const open = VF.UI.toggleInventory();
      if (open) {
        document.exitPointerLock();
      } else if (game.running) {
        VF.FrontlineUI.requestPointerLock(game.renderer.domElement);
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
        VF.FrontlineUI.requestPointerLock(game.renderer.domElement);
      }
    });
  }

  function onResize() {
    game.camera.aspect = window.innerWidth / window.innerHeight;
    game.camera.updateProjectionMatrix();
    game.renderer.setSize(window.innerWidth, window.innerHeight);
    if (game.pipeline) game.pipeline.setSize(window.innerWidth, window.innerHeight);
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
    const cover=document.getElementById('start-overlay');
    if(game._leaving||(!game.running&&VF.UI&&(VF.UI.modeSelectOpen||VF.UI.classSelectOpen||VF.UI.squadIntroOpen||(cover&&!cover.classList.contains('hidden')))))return;
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

    // 死斗 clock keeps running while the player is dead / respawning
    if (!rangeOpen && VF.TdmMatch && VF.TdmMatch.active) {
      VF.TdmMatch.update(dt);
      if (VF.TdmSpawn && VF.TdmSpawn.update) VF.TdmSpawn.update(dt);
    }

    // 爆破: field driver runs first (player intent → bomb transition), then the
    // match ticks the bomb + round clocks. Clock runs through死亡 (single-life).
    // On a PVP guest the host is authoritative: run only the field renderer /
    // intent forwarder and let the mirror drive the round/match state.
    if (!rangeOpen && VF.SdMatch && VF.SdMatch.active) {
      const sdGuest = !!(VF.SdNet && VF.SdNet.isGuest && VF.SdNet.isGuest());
      if (VF.SdField && VF.SdField.update) VF.SdField.update(dt);
      if (!sdGuest) {
        VF.SdMatch.update(dt);
        if (VF.SdSpawn && VF.SdSpawn.update) VF.SdSpawn.update(dt);
      }
    }

    // 自由混战 clock + personal scoring + respawns run through the player's own
    // death (2.5s instant respawn), same as 死斗.
    if (!rangeOpen && VF.FfaMatch && VF.FfaMatch.active) {
      VF.FfaMatch.update(dt);
      if (VF.FfaSpawn && VF.FfaSpawn.update) VF.FfaSpawn.update(dt);
    }

    // 枪械模式: same teamless clock/respawn plumbing; GgMatch additionally keeps
    // everyone's weapon aligned with their ladder level every frame.
    if (!rangeOpen && VF.GgMatch && VF.GgMatch.active) {
      VF.GgMatch.update(dt);
      if (VF.FfaSpawn && VF.FfaSpawn.update) VF.FfaSpawn.update(dt);
    }

    if (!rangeOpen && VF.Throwables && VF.Throwables.update) VF.Throwables.update(dt);

    // Deferred voxel mesh rebuilds — prefer chunks around the player so the road loads first
    if (!rangeOpen && game.world && game.world.flushRebuilds) {
      const backlog = game.world._dirtyChunks ? game.world._dirtyChunks.size : 0;
      const budget = backlog > 50 ? 14 : backlog > 15 ? 8 : 4;
      const pref =
        game.player && game.player.object
          ? game.player.object.position
          : null;
      game.world.flushRebuilds(budget, pref ? pref.x : null, pref ? pref.z : null);
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
        classId: game.player.classId || game.playerClass || 'vanguard',
        team: game.player.team || game.world._playerTeam,
        stealth: !!game.player.stealthed,
      });
      VF.Pvp.updateRemoteAvatar(game.scene, dt);
      VF.Pvp.tickMatch(dt, game);
      if (game.player.dead && !VF.UI.isMenuOpen()) {
        if (game.bases) game.bases.update(dt);
        if (game.ai) game.ai.update(dt);
        if (game.battlefieldEvents && game.battlefieldEvents.update) {
          game.battlefieldEvents.update(dt, game);
        }
      }
    }

    // 死斗: respawn is only 3s, so the battle must not freeze while dead
    if (
      game.mode !== 'pvp' &&
      VF.TdmMatch &&
      VF.TdmMatch.isRunning() &&
      game.player &&
      game.player.dead &&
      !VF.UI.isMenuOpen()
    ) {
      if (game.ai) game.ai.update(dt);
      if (game.battlefieldEvents && game.battlefieldEvents.update) {
        game.battlefieldEvents.update(dt, game);
      }
    }

    // 爆破: single-life — a dead player spectates the rest of the round, so the
    // AI must keep fighting (and the objective resolving) until the round ends.
    if (
      game.mode !== 'pvp' &&
      VF.SdMatch &&
      VF.SdMatch.isRunning() &&
      game.player &&
      game.player.dead &&
      !VF.UI.isMenuOpen()
    ) {
      if (game.ai) game.ai.update(dt);
      if (game.battlefieldEvents && game.battlefieldEvents.update) {
        game.battlefieldEvents.update(dt, game);
      }
    }

    // 自由混战 / 枪械模式: 2.5s respawn — never freeze the arena while the player is dead.
    if (
      game.mode !== 'pvp' &&
      ((VF.FfaMatch && VF.FfaMatch.isRunning()) || (VF.GgMatch && VF.GgMatch.isRunning())) &&
      game.player &&
      game.player.dead &&
      !VF.UI.isMenuOpen()
    ) {
      if (game.ai) game.ai.update(dt);
      if (game.battlefieldEvents && game.battlefieldEvents.update) {
        game.battlefieldEvents.update(dt, game);
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

    if (VF.WeaponInspect && VF.WeaponInspect.isActive && VF.WeaponInspect.isActive()) {
      try {
        VF.WeaponInspect.update(dt);
      } catch (err) {
        console.error('[VF] weapon inspect', err);
      }
    } else if (game.player && game.player.dead && !rangeOpen) {
      try {
        game.player._updateDeadCam(dt);
      } catch (err) {
        console.error('[VF] dead cam', err);
      }
    } else if (game.running && !VF.UI.isMenuOpen() && game.player && !game.player.dead) {
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
          // Cooldowns / stealth still tick while unlocked
          if (game.skills.stealthTimer > 0 || (game.player && game.player.stealthed)) {
            game.skills._updateStealth(dt);
          }
          if (game.skills.cooldown > 0) {
            game.skills.cooldown = Math.max(0, game.skills.cooldown - dt);
          }
          game.skills._syncHud();
        }
        game.ai.update(dt);
        if (VF.Audio && game.player.locked) VF.Audio.update(dt, game.player);
        if (game.bases) game.bases.update(dt);
        if (game.battlefieldEvents && game.battlefieldEvents.update) {
          game.battlefieldEvents.update(dt, game);
        }
      } else if (game.world && game.world.ensureMeshedAround && game.player.object) {
        game.world.ensureMeshedAround(
          game.player.object.position.x,
          game.player.object.position.z,
          8
        );
      }
      if (game.atmosphere && game.atmosphere.update) {
        game.atmosphere.update(dt, game.player.object.position);
      }
      if (VF.updateWorldBoundary) {
        VF.updateWorldBoundary(dt, game.player.object.position);
      }

      // Chunk LOD — hide far terrain
      if (game.world.updateChunkVisibility) {
        const p = game.player.object.position;
        game.world.updateChunkVisibility(p.x, p.z, 180);
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

      if (!game.levelEditing && game.bases && (game.bases.won || game.bases.lost)) {
        game.running = false;
        if (game.battlefieldEvents && game.battlefieldEvents.stop) game.battlefieldEvents.stop();
        if (!(VF.WeaponInspect && VF.WeaponInspect.isActive && VF.WeaponInspect.isActive())) {
          document.exitPointerLock && document.exitPointerLock();
        }
      }
      if (game.mode === 'pvp' && VF.Pvp && VF.Pvp._matchEnded) {
        game.running = false;
        if (game.battlefieldEvents && game.battlefieldEvents.stop) game.battlefieldEvents.stop();
        if (!(VF.WeaponInspect && VF.WeaponInspect.isActive && VF.WeaponInspect.isActive())) {
          document.exitPointerLock && document.exitPointerLock();
        }
      } else if (game.mode !== 'pvp' && game.player.dead) {
        game.running = false;
        if (game.battlefieldEvents && game.battlefieldEvents.stop) game.battlefieldEvents.stop();
        if (!(VF.WeaponInspect && VF.WeaponInspect.isActive && VF.WeaponInspect.isActive())) {
          document.exitPointerLock && document.exitPointerLock();
        }
      }
    } else if (
      game.player &&
      !rangeOpen &&
      !(VF.WeaponInspect && VF.WeaponInspect.isActive && VF.WeaponInspect.isActive())
    ) {
      const eye = game.player.getEyePosition();
      game.camera.position.copy(eye);
      if (!game._idleEuler) game._idleEuler = new THREE.Euler(0, 0, 0, 'YXZ');
      game._idleEuler.set(game.player.pitch, game.player.yaw, 0);
      game.camera.quaternion.setFromEuler(game._idleEuler);
    }

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
      // Sky/sun/ambient are scene objects — they must be pushed from config
      // BEFORE the scene is drawn, whichever render path we then take.
      if (game.renderScene) game.renderScene.sync();
      if (VF.RenderConfig && VF.RenderConfig.enabled && game.pipeline) {
        game.pipeline.render(game.scene, game.camera, dt);
      } else {
        game.renderer.render(game.scene, game.camera);
      }
    }
  }

  // A hidden/transitioning tab may not receive animation frames. Boot exactly once.
  let booted=false;
  function boot(){if(booted||VFEntry.navigating)return;booted=true;init();}
  window.addEventListener('vf:navigate',()=>{
    game._leaving=true;game.running=false;
    const ui=VF.UI;if(!ui)return;
    clearInterval(ui._squadIntroTimer);clearInterval(ui._classAutoTimer);
    for(const method of ['_stopClassPreviews','_stopSquadIntroPreview','_stopLoadoutCustomizePreview'])if(ui[method])ui[method]();
  });
  function scheduleBoot(){requestAnimationFrame(()=>requestAnimationFrame(boot));setTimeout(boot,100);}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',scheduleBoot,{once:true});
  else scheduleBoot();
})();
