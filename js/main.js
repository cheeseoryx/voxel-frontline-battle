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
      // 封面只有三个按钮可点。这里曾经给整个 #start-overlay 绑过一个「点任意处
      // 进大厅」的捷径，但 .cover-art 是铺满全屏的背景层，点「结束游戏」/「新手
      // 教程」稍微偏一点就会命中它、被直接扔进大厅，等于让另外两个按钮形同虚设。

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
    game.vehicles = VF.Vehicles || null;
    if (game.vehicles) {
      game.vehicles.init(scene, game.world);
      game.vehicles.reset(game.world._vehicleSpawns || []);
      if (game.vehicles.setStations) {
        game.vehicles.setStations(game.world._armorRepairStations || []);
      }
      setupVehicleCombatHooks();
    }

    // Tiny opaque dust cubes (solid, not soft fog)
    if (VF.createAtmosphere) {
      game.atmosphere = VF.createAtmosphere(scene);
    }

    // UI
    VF.UI.init();
    bindGameBackBtn();
    VF.syncGameBackBtn = syncGameBackBtn;
    VF.exitToLobby = exitToLobby;
    VF.clearPreMatchMapView = clearPreMatchMapView;
    VF.openRedeployFromDeath = openRedeployFromDeath;
    VF.requestRedeploy = requestRedeploy;
    VF.leaveMatchFromPause = leaveMatchFromPause;
    VF.startConquest32 = startConquest32;
    VF.openFrontlineHub = openFrontlineHub;
    VF.openRangeFromHub = openRangeFromHub;
    if (VF.UI.setDeathHandlers) {
      VF.UI.setDeathHandlers({
        onRedeploy: function () {
          if (VF.Revive && VF.Revive.giveUpPlayer && VF.Revive.giveUpPlayer()) return;
          openRedeployFromDeath();
        },
        onCallout: function () {
          if (VF.Revive && VF.Revive.toggleBleedSlow) VF.Revive.toggleBleedSlow();
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

  function findCombatEntity(entityId) {
    if (!entityId) return null;
    if (
      game.player &&
      (game.player.entityId === entityId || entityId === 'player-local')
    ) {
      return game.player;
    }
    const lists = game.ai ? [game.ai.blue || [], game.ai.red || []] : [];
    for (let l = 0; l < lists.length; l++) {
      for (let i = 0; i < lists[l].length; i++) {
        if (lists[l][i] && lists[l][i].entityId === entityId) return lists[l][i];
      }
    }
    return null;
  }

  function rayHitsPlayer(origin, direction, range) {
    if (!game.player || game.player.dead || !game.player.alive) return null;
    if (game.player.vehicleId != null) return null;
    const HB = VF.Hitboxes;
    if (HB && HB.raycast) {
      const hit = HB.raycast(game.player, origin, direction, range);
      if (!hit) return null;
      return {
        entity: game.player,
        point: hit.point,
        dist: hit.dist,
        part: hit.part,
      };
    }
    const center = game.player.getEyePosition();
    const to = center.clone().sub(origin);
    const projection = to.dot(direction);
    if (projection < 0 || projection > range) return null;
    const closest = origin.clone().addScaledVector(direction, projection);
    return closest.distanceTo(center) <= 0.9
      ? { entity: game.player, point: closest, dist: projection, part: 'torso' }
      : null;
  }

  function rayHitsHostileInfantry(team, origin, direction, range) {
    if (!game.ai) return null;
    const playerTeam = game.world._playerTeam || 'ally';
    const list = team === playerTeam ? game.ai.enemies : game.ai.allies;
    let hit = game.ai._raycastTeam
      ? game.ai._raycastTeam(list || [], origin, direction, range)
      : null;
    if (
      game.mode === 'pvp' &&
      team === playerTeam &&
      VF.Pvp &&
      VF.Pvp.raycastRemote
    ) {
      const remoteHit = VF.Pvp.raycastRemote(
        origin,
        direction,
        hit ? hit.dist : range
      );
      if (remoteHit) {
        hit = {
          remote: true,
          point: remoteHit.point,
          dist: remoteHit.dist,
        };
      }
    }
    if (team !== playerTeam) {
      const playerHit = rayHitsPlayer(origin, direction, hit ? hit.dist : range);
      if (playerHit) hit = playerHit;
    }
    return hit;
  }

  function damageHostileInfantry(team, target, damage, source) {
    if (!target || !(damage > 0)) return;
    const entity = target.entity || target.unit || target.enemy;
    if (target.remote) {
      if (VF.Pvp && VF.Pvp.dealDamageToRemote) {
        VF.Pvp.dealDamageToRemote(damage);
      }
      return;
    }
    if (!entity) return;
    if (target.part && VF.Hitboxes && VF.Hitboxes.partMul) {
      damage = Math.round(damage * VF.Hitboxes.partMul(target.part));
      entity._lastHitPart = target.part;
      if (source) source.hitPart = target.part;
    }
    if (entity === game.player) {
      game.player.takeDamage(damage, source && source.position, source);
    } else if (game.ai && game.ai._damageUnit) {
      game.ai._damageUnit(
        entity,
        damage,
        null,
        source === game.player,
        source || null
      );
    }
  }

  function spawnVehicleImpact(point, size) {
    if (!point || !game.weapons || !game.weapons._spawnImpact) return;
    game.weapons._spawnImpact(point, 0xffa34c, size != null ? size : 0.32);
  }

  function vehicleWeaponDef(weaponId) {
    return (VF.VEHICLE_WEAPONS && weaponId && VF.VEHICLE_WEAPONS[weaponId]) || null;
  }

  function projectileBlastRadius(projectile) {
    const def = vehicleWeaponDef(projectile && projectile.weaponId);
    if (def && def.blastRadius != null) return def.blastRadius;
    return projectile && projectile.weaponId === 'ifv_grenade_launcher' ? 4.2 : 3.2;
  }

  function projectileBreakRadius(projectile) {
    const def = vehicleWeaponDef(projectile && projectile.weaponId);
    if (def && def.breakRadius != null) return def.breakRadius;
    return projectile && projectile.weaponId === 'ifv_grenade_launcher' ? 1.1 : 1.45;
  }

  function playProjectileBlastAudio(projectile, point) {
    if (!projectile || projectile.predictOnly || !point || !VF.Audio) return;
    if (projectile.weaponId === 'tank_main_cannon') return;
    const def = vehicleWeaponDef(projectile.weaponId);
    if (!def || def.mode !== 'projectile') return;
    if (def.damageType !== 'explosive' && def.damageType !== 'antiArmor') return;
    if (VF.Audio.playExplosionAt) {
      VF.Audio.playExplosionAt(point, 'he', { gain: 1.55 });
      return;
    }
    VF.Audio.play('explosion', { position: point, maxDistance: 450, priority: 10, gain: 1.5 });
  }

  function breakVehicleImpactVoxels(point, radius, coloredDebris) {
    if (
      !point ||
      !game.world ||
      !game.world.get ||
      !game.world.breakBlock
    ) {
      return;
    }
    const r = Math.max(0, radius || 0);
    const minX = Math.floor(point.x - r);
    const maxX = Math.ceil(point.x + r);
    const minY = Math.floor(point.y - r);
    const maxY = Math.ceil(point.y + r);
    const minZ = Math.floor(point.z - r);
    const maxZ = Math.ceil(point.z + r);
    let debrisBudget = coloredDebris ? 3 : 0;
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          const dx = x + 0.5 - point.x;
          const dy = y + 0.5 - point.y;
          const dz = z + 0.5 - point.z;
          if (dx * dx + dy * dy + dz * dz > r * r) continue;
          const block = game.world.get(x, y, z);
          if (
            block === VF.BLOCK.AIR ||
            block === VF.BLOCK.WATER ||
            block === VF.BLOCK.BEDROCK
          ) {
            continue;
          }
          if (game.world.breakBlock(x, y, z, { force: true })) {
            if (game.weapons._syncWorldBreak) {
              game.weapons._syncWorldBreak('break-voxel', x, y, z);
            }
            if (debrisBudget > 0 && game.weapons._spawnDebris) {
              const color =
                (VF.BLOCK_COLORS && VF.BLOCK_COLORS[block]) || 0x8a8680;
              game.weapons._spawnDebris(
                x + 0.5,
                y + 0.5,
                z + 0.5,
                color
              );
              debrisBudget--;
            }
          }
        }
      }
    }
  }

  function damageInfantryBlast(projectile, radius) {
    const center = new THREE.Vector3(
      projectile.position.x,
      projectile.position.y,
      projectile.position.z
    );
    const playerTeam = game.world._playerTeam || 'ally';
    const actor = findCombatEntity(projectile.ownerId);
    const list =
      projectile.team === playerTeam
        ? game.ai && game.ai.enemies
        : game.ai && game.ai.allies;
    const baseDamage =
      projectile.damageType === 'antiArmor'
        ? Math.min(110, projectile.damage * 0.4)
        : projectile.damage;
    const targets = list || [];
    for (let i = 0; i < targets.length; i++) {
      const unit = targets[i];
      if (!unit || !unit.alive || !unit.mesh || unit.vehicleId) continue;
      const dist = unit.mesh.position.distanceTo(center);
      if (dist > radius) continue;
      damageHostileInfantry(
        projectile.team,
        { entity: unit },
        Math.max(12, baseDamage * (1 - dist / radius)),
        actor
      );
    }
    if (
      game.mode === 'pvp' &&
      projectile.team === playerTeam &&
      VF.Pvp &&
      VF.Pvp.remoteState &&
      VF.Pvp.remoteState.alive !== false &&
      !VF.Pvp.remoteState.vehicleId
    ) {
      const remote = VF.Pvp.remoteState;
      const dist = Math.hypot(
        remote.x - center.x,
        (remote.y || 0) - center.y,
        remote.z - center.z
      );
      if (dist <= radius && VF.Pvp.dealDamageToRemote) {
        VF.Pvp.dealDamageToRemote(
          Math.max(12, baseDamage * (1 - dist / radius))
        );
      }
    }
    if (
      projectile.team !== playerTeam &&
      game.player &&
      !game.player.dead &&
      !game.player.vehicleId
    ) {
      const dist = game.player.object.position.distanceTo(center);
      if (dist <= radius) {
        damageHostileInfantry(
          projectile.team,
          { entity: game.player },
          Math.max(12, baseDamage * (1 - dist / radius)),
          actor
        );
      }
    }
  }

  function setupVehicleCombatHooks() {
    const vehicles = game.vehicles;
    if (!vehicles || vehicles._mainHooksReady) return;
    vehicles._mainHooksReady = true;
    if (VF.VehicleEffects && VF.VehicleEffects.init) {
      VF.VehicleEffects.init(game, vehicles);
    }
    vehicles.onOccupantDestroyed = function (entity, vehicle, seat, meta) {
      const source = findCombatEntity(
        meta && (meta.sourceId || (meta.source && meta.source.entityId))
      );
      if (entity && entity.isRemote) {
        if (VF.Pvp && VF.Pvp.dealDamageToRemote) {
          VF.Pvp.dealDamageToRemote(250);
        }
        return;
      }
      if (entity === game.player) {
        entity.takeDamage(250, vehicle.position, source || vehicle);
      } else if (game.ai && game.ai._damageUnit && entity.alive) {
        game.ai._damageUnit(entity, 250, null, false, source || vehicle);
      }
    };
    vehicles.on('vehicle-weapon-fired', function (event) {
      const data = event.data || {};
      const def = VF.VEHICLE_WEAPONS && VF.VEHICLE_WEAPONS[data.weaponId];
      const shot = vehicles.lastShot;
      if (
        def &&
        def.soundId &&
        data.weaponId !== 'tank_main_cannon' &&
        data.origin &&
        VF.Audio
      ) {
        const localOccupant = !!(
          game.player &&
          game.player.vehicleId &&
          data.vehicleId &&
          game.player.vehicleId === data.vehicleId
        );
        VF.Audio.play(def.soundId, {
          position: data.origin,
          maxDistance: def.soundRange || 300,
          priority: def.damageType === 'antiArmor' ? 8 : 7,
          gain: localOccupant ? 1.75 : 1.15,
          occupant: localOccupant,
        });
      }
      if (!def || data.mode !== 'hitscan' || !shot || shot.id !== data.shotId) return;
      const origin = new THREE.Vector3(data.origin.x, data.origin.y, data.origin.z);
      const direction = new THREE.Vector3(
        data.direction.x,
        data.direction.y,
        data.direction.z
      ).normalize();
      if (shot.worldHit) {
        const point = new THREE.Vector3(
          shot.worldHit.point.x,
          shot.worldHit.point.y,
          shot.worldHit.point.z
        );
        spawnVehicleImpact(
          point,
          def.kind === 'main-cannon' ? 0.62 : 0.28
        );
        if (
          def.damageType === 'antiArmor' ||
          def.damageType === 'explosive'
        ) {
          breakVehicleImpactVoxels(
            point,
            def.kind === 'main-cannon'
              ? def.breakRadius != null
                ? def.breakRadius
                : 1.45
              : 0.7,
            def.kind === 'main-cannon'
          );
        }
      }
      const range = shot.worldHit
        ? Math.min(def.range, shot.worldHit.distance)
        : shot.hit
          ? Math.min(def.range, shot.hit.distance)
          : def.range;
      const hit = rayHitsHostileInfantry(data.team, origin, direction, range);
      const end = hit && hit.point
        ? hit.point
        : origin.clone().addScaledVector(direction, range);
      if (VF.spawnTracer) {
        VF.spawnTracer(origin, end, {
          id: data.weaponId,
          color: def.damageType === 'antiArmor' ? 0xff9a45 : 0xffd27a,
        });
      }
      if (data.predictOnly) return;
      if (hit) {
        const actor = findCombatEntity(data.ownerId);
        const infantryDamage =
          def.damageType === 'antiArmor'
            ? Math.min(125, def.damage * 0.42)
            : def.damage;
        damageHostileInfantry(data.team, hit, infantryDamage, actor);
        spawnVehicleImpact(end, def.kind === 'main-cannon' ? 0.55 : 0.14);
      }
    });
    vehicles.on('vehicle-ram-infantry', function (event) {
      const data = event.data || {};
      const p = data.position;
      if (p) {
        spawnVehicleImpact(new THREE.Vector3(p.x, p.y + 0.7, p.z), 0.55);
      }
      if (VF.Audio && VF.Audio.play) VF.Audio.play('hit_heavy');
      if (data.kind === 'remote' && VF.UI && VF.UI.pushKillFeed) {
        const driverId =
          (game.player && game.player.entityId) || 'player-local';
        VF.UI.pushKillFeed({
          killerId: driverId,
          killerName: '你',
          killerTeam: data.team || (game.player && game.player.team),
          victimId: 'remote-player',
          victimName: '敌方玩家',
          victimTeam: data.team === 'enemy' ? 'ally' : 'enemy',
          weaponId: 'vehicle-ram',
          kind: 'kill',
          x: p && p.x,
          y: p && p.y,
          z: p && p.z,
        });
      }
    });
    vehicles.on('vehicle-ram-break', function (event) {
      const data = event.data || {};
      const voxels = data.voxels || [];
      const props = data.props || [];
      const first = voxels[0] || props[0] || data.position;
      if (first) {
        const impact = new THREE.Vector3(
          first.x + (voxels[0] ? 0.5 : 0),
          first.y + (voxels[0] ? 0.5 : 0),
          first.z + (voxels[0] ? 0.5 : 0)
        );
        spawnVehicleImpact(impact, 0.72);
      }
      if (!game.weapons || !game.weapons._syncWorldBreak) return;
      for (let i = 0; i < voxels.length; i++) {
        game.weapons._syncWorldBreak('break-voxel', voxels[i].x, voxels[i].y, voxels[i].z);
      }
      for (let i = 0; i < props.length; i++) {
        game.weapons._syncWorldBreak('break-door', props[i].x, props[i].y, props[i].z);
      }
    });
    vehicles.on('vehicle-destroyed', function (event) {
      const p = event.data && event.data.position;
      if (!p) return;
      const point = new THREE.Vector3(p.x, p.y + 1.2, p.z);
      spawnVehicleImpact(point, 0.9);
      if (VF.Audio && VF.Audio.playExplosionAt) {
        VF.Audio.playExplosionAt(point, 'he', { gain: 1.45 });
      } else if (VF.Audio && VF.Audio.play) {
        VF.Audio.play('explosion', { position: point, maxDistance: 400, priority: 10, gain: 1.4 });
      }
      damageInfantryBlast(
        {
          position: p,
          damage: 150,
          damageType: 'explosive',
          team: event.data.team === 'enemy' ? 'ally' : 'enemy',
          ownerId: event.data.sourceId,
        },
        6
      );
    });
    vehicles.onProjectileUpdate = function (projectile, dt) {
      const cannonFx = !!(
        projectile.weaponId === 'tank_main_cannon' &&
        VF.VehicleEffects &&
        VF.VehicleEffects.updateProjectile
      );
      if (cannonFx) {
        VF.VehicleEffects.updateProjectile(projectile, dt);
      } else if (!projectile.mesh && game.scene) {
        projectile.mesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.12, 0.12, 0.45),
          new THREE.MeshBasicMaterial({
            color: projectile.damageType === 'antiArmor' ? 0xff7b35 : 0xffc266,
          })
        );
        game.scene.add(projectile.mesh);
      }
      if (projectile.mesh) {
        projectile.mesh.position.set(
          projectile.position.x,
          projectile.position.y,
          projectile.position.z
        );
        projectile.mesh.lookAt(
          projectile.position.x + projectile.direction.x,
          projectile.position.y + projectile.direction.y,
          projectile.position.z + projectile.direction.z
        );
      }
      if (projectile.vehicleHit) {
        const point = new THREE.Vector3(
          projectile.position.x,
          projectile.position.y,
          projectile.position.z
        );
        if (cannonFx) {
          VF.VehicleEffects.impactProjectile(projectile, 'armor', {
            point: point,
            normal: projectile.vehicleHit.normal,
            damage:
              projectile.damageApplied ||
              Math.min(
                projectile.damage,
                projectile.vehicleHit.vehicle
                  ? projectile.vehicleHit.vehicle.hp
                  : projectile.damage
              ),
            targetVehicleId: projectile.vehicleHit.vehicleId,
          });
        }
        if (!projectile.predictOnly) {
          damageInfantryBlast(projectile, projectileBlastRadius(projectile));
          if (!cannonFx) {
            spawnVehicleImpact(point, 0.62);
            playProjectileBlastAudio(projectile, point);
          }
        }
        return true;
      }
      if (projectile.worldHit) {
        const point = new THREE.Vector3(
          projectile.position.x,
          projectile.position.y,
          projectile.position.z
        );
        if (cannonFx) {
          const hit = projectile.worldHit;
          const terrainVoxel = !!(
            hit.kind === 'voxel' &&
            game.world &&
            game.world._isTerrainFill &&
            game.world._isTerrainFill(hit.x, hit.y, hit.z)
          );
          const structure =
            hit.kind === 'prop' ||
            (hit.kind === 'voxel' && !terrainVoxel);
          let color = structure ? 0x9b866d : 0x76634b;
          if (
            hit.kind === 'voxel' &&
            game.world &&
            game.world.get &&
            hit.x != null
          ) {
            const block = game.world.get(hit.x, hit.y, hit.z);
            color = (VF.BLOCK_COLORS && VF.BLOCK_COLORS[block]) || color;
          }
          VF.VehicleEffects.impactProjectile(
            projectile,
            structure ? 'structure' : 'ground',
            {
              point: point,
              normal: hit.normal || { x: 0, y: 1, z: 0 },
              color: color,
            }
          );
        }
        if (!projectile.predictOnly) {
          damageInfantryBlast(projectile, projectileBlastRadius(projectile));
          if (!cannonFx) {
            spawnVehicleImpact(point, 0.55);
            playProjectileBlastAudio(projectile, point);
          }
          breakVehicleImpactVoxels(
            projectile.position,
            projectileBreakRadius(projectile),
            cannonFx
          );
        }
        return true;
      }
      if (projectile.predictOnly) {
        const predictedGround = game.world.getTerrainTop
          ? game.world.getTerrainTop(projectile.position.x, projectile.position.z)
          : -Infinity;
        const predictedHit = projectile.position.y <= predictedGround + 0.15;
        if (predictedHit && cannonFx) {
          VF.VehicleEffects.impactProjectile(projectile, 'ground', {
            point: {
              x: projectile.position.x,
              y: predictedGround + 0.15,
              z: projectile.position.z,
            },
            normal: { x: 0, y: 1, z: 0 },
            color: 0x76634b,
          });
        }
        return predictedHit;
      }
      const from = new THREE.Vector3(
        projectile.previousPosition.x,
        projectile.previousPosition.y,
        projectile.previousPosition.z
      );
      const to = new THREE.Vector3(
        projectile.position.x,
        projectile.position.y,
        projectile.position.z
      );
      const delta = to.clone().sub(from);
      const travel = delta.length();
      if (travel > 0.001) {
        const hit = rayHitsHostileInfantry(
          projectile.team,
          from,
          delta.clone().normalize(),
          travel
        );
        if (hit) {
          projectile.position = {
            x: hit.point.x,
            y: hit.point.y,
            z: hit.point.z,
          };
          damageInfantryBlast(projectile, projectileBlastRadius(projectile));
          if (cannonFx) {
            VF.VehicleEffects.impactProjectile(projectile, 'infantry', {
              point: hit.point,
              normal: { x: 0, y: 1, z: 0 },
              color: 0x725647,
            });
          } else {
            spawnVehicleImpact(hit.point, 0.48);
            playProjectileBlastAudio(projectile, hit.point);
          }
          return true;
        }
      }
      const ground = game.world.getTerrainTop
        ? game.world.getTerrainTop(projectile.position.x, projectile.position.z)
        : -Infinity;
      if (projectile.position.y <= ground + 0.15) {
        damageInfantryBlast(projectile, projectileBlastRadius(projectile));
        const point = new THREE.Vector3(
          projectile.position.x,
          ground + 0.2,
          projectile.position.z
        );
        if (cannonFx) {
          VF.VehicleEffects.impactProjectile(projectile, 'ground', {
            point: point,
            normal: { x: 0, y: 1, z: 0 },
            color: 0x76634b,
          });
        } else {
          spawnVehicleImpact(point, 0.55);
          playProjectileBlastAudio(projectile, point);
        }
        return true;
      }
      return false;
    };
    vehicles.onProjectileRemoved = function (projectile) {
      if (!projectile || !projectile.mesh) return;
      if (
        projectile.weaponId === 'tank_main_cannon' &&
        VF.VehicleEffects &&
        VF.VehicleEffects.releaseProjectile
      ) {
        if (VF.VehicleEffects.releaseProjectile(projectile)) return;
      }
      if (projectile.mesh.parent) projectile.mesh.parent.remove(projectile.mesh);
      if (projectile.mesh.geometry) projectile.mesh.geometry.dispose();
      if (projectile.mesh.material) projectile.mesh.material.dispose();
      projectile.mesh = null;
    };
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
    game._openingTeam = null;
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
    if (VF.Audio && VF.Audio.setMusicAllowed) VF.Audio.setMusicAllowed(true);
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
    return;
  }

  function returnToHub() {
    game.teamLocked = false;
    game.lockedTeam = null;
    game._openingTeam = null;
    game.running = false;
    clearPreMatchMapView();
    if (game.player) game.player._cqTicketPending = false;
    if (VF.Conquest && VF.Conquest.stop) VF.Conquest.stop();
    if (VF.Throwables && VF.Throwables.stop) VF.Throwables.stop();
    if (document.exitPointerLock) document.exitPointerLock();
    if (VF.UI && VF.UI.hideHud) VF.UI.hideHud();
    if (VF.UI && VF.UI.hideDeath) VF.UI.hideDeath();
    if (VF.UI && VF.UI.hideVictory) VF.UI.hideVictory();
    if (VF.UI && VF.UI.closeClassSelect) VF.UI.closeClassSelect();
    if (VF.UI && VF.UI.closeSquadIntro) VF.UI.closeSquadIntro();
    if (VF.UI && VF.UI.closeLoadoutCustomize) VF.UI.closeLoadoutCustomize();
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

  function pvpSkipsPrep() {
    return !!(game.mode === 'pvp' && VF.Pvp && VF.Pvp.skipSpawnGate);
  }

  function matchModeName() {
    if (game.mode === 'pvp') return '征服 · 8 VS 8';
    const teamSize = (VF.Feel && VF.Feel.ai && VF.Feel.ai.teamSize) || 32;
    return '征服 · ' + teamSize + ' VS ' + teamSize;
  }

  function matchPlayerMax() {
    if (game.mode === 'pvp') return (VF.Pvp && VF.Pvp.HUMAN_CAP) || 16;
    const teamSize = (VF.Feel && VF.Feel.ai && VF.Feel.ai.teamSize) || 32;
    return teamSize * 2;
  }

  function matchPlayerCount() {
    if (game.mode === 'pvp' && VF.Pvp && typeof VF.Pvp.getHumanCounts === 'function') {
      const counts = VF.Pvp.getHumanCounts();
      return Math.max(1, (counts.ally || 0) + (counts.enemy || 0));
    }
    return matchPlayerMax();
  }

  function leavePvpToServerList() {
    clearPreMatchMapView();
    if (VF.UI && VF.UI.closeClassSelect) VF.UI.closeClassSelect();
    if (VF.UI && VF.UI.closeSquadIntro) VF.UI.closeSquadIntro();
    if (VF.UI && VF.UI.closeLoadoutCustomize) VF.UI.closeLoadoutCustomize();
    if (VF.UI && VF.UI.closeSpawnSelect) VF.UI.closeSpawnSelect();
    if (VF.Pvp && VF.Pvp.leaveLobby) VF.Pvp.leaveLobby();
    game.mode = 'pve';
    game.pvp = null;
    game.teamLocked = false;
    game.lockedTeam = null;
    openFrontlineHub();
  }

  function openClassSelect() {
    const overlay = document.getElementById('start-overlay');
    const tutorial = document.getElementById('tutorial-overlay');
    if (overlay) overlay.classList.add('hidden');
    if (tutorial) tutorial.classList.add('hidden');
    if (VF.TowerDesigner && VF.TowerDesigner.open) VF.TowerDesigner.close();
    if (VF.Lobby) VF.Lobby.hide();
    if (VF.Hub) VF.Hub.hide();
    if (VF.UI && VF.UI.closeSpawnSelect) VF.UI.closeSpawnSelect();
    if (VF.UI && VF.UI.closeSquadIntro) VF.UI.closeSquadIntro();
    if (VF.UI && VF.UI.closeLoadoutCustomize) VF.UI.closeLoadoutCustomize();
    prepareInitialDeploymentSpawn();
    framePreMatchMapView();
    const preferredClass =
      VF.Lobby && typeof VF.Lobby.getSelectedClassId === 'function'
        ? VF.Lobby.getSelectedClassId()
        : game.playerClass || (game.player && game.player.classId) || 'assault';
    const isPvp = game.mode === 'pvp';
    const assignedTeam =
      game.world && game.world._playerTeam === 'enemy' ? 'enemy' : 'ally';
    const mapName =
      (VF.IslandConquestMap && VF.IslandConquestMap.name) ||
      (game.world && game.world._mapName) ||
      '荒盆';
    const playerMax = matchPlayerMax();
    const playerCount = matchPlayerCount();
    VF.UI.openClassSelect(
      function (classId) {
        if (game.player && game.player.applyClass) {
          game.player.applyClass(classId);
        }
        game.playerClass = classId;
        if (VF.Lobby && VF.Lobby.setPreviewClass) VF.Lobby.setPreviewClass(classId);
        if (!prepareInitialDeploymentSpawn()) {
          if (VF.UI && VF.UI.toast) VF.UI.toast('主基地部署点尚未就绪');
          return;
        }
        framePreMatchMapView();
        VF.UI.closeClassSelect();
        if (pvpSkipsPrep()) beginMatch();
        else openSquadIntro();
      },
      function () {
        VF.UI.closeClassSelect();
        clearPreMatchMapView();
        if (game.mode === 'pvp' && VF.Pvp && VF.Pvp.roomCode) {
          leavePvpToServerList();
        } else {
          returnToHub();
        }
      },
      preferredClass,
      {
        mapName: mapName,
        modeName: matchModeName(),
        playerCount: playerCount,
        playerMax: playerMax,
        playerState: isPvp ? '对局进行中 · 可中途加入' : '作战编制已就绪',
        factionName: assignedTeam === 'enemy' ? '赤焰军团' : '和平军团',
        autoAdvanceSec: 10,
      }
    );
  }

  function pickOpeningTeam() {
    if (game.mode === 'pvp' && game.pvp && (game.pvp.team === 'ally' || game.pvp.team === 'enemy')) {
      return game.pvp.team;
    }
    if (game.teamLocked && (game.lockedTeam === 'ally' || game.lockedTeam === 'enemy')) {
      return game.lockedTeam;
    }
    if (game.world && (game.world._playerTeam === 'ally' || game.world._playerTeam === 'enemy')) {
      return game.world._playerTeam;
    }
    return Math.random() < 0.5 ? 'enemy' : 'ally';
  }

  function prepareInitialDeploymentSpawn() {
    if (!game.player || !game.world) return false;
    const mapReady =
      game.mapSeed != null &&
      game._mapReadyForSeed === (game.mapSeed >>> 0) &&
      game.world._spawnPoints &&
      game.world._spawnPoints.all &&
      game.world._spawnPoints.all.length;
    if (!mapReady) prepareMatchMap();
    const team = pickOpeningTeam();
    game.world._deployList = null;
    if (game.world.setPlayerTeam) game.world.setPlayerTeam(team);
    if (game.player) game.player.team = team;
    const points =
      (game.world._spawnPoints && game.world._spawnPoints[team]) || [];
    let hq = null;
    for (let i = 0; i < points.length; i++) {
      if (points[i].fixed || points[i].kind === 'hq') {
        hq = points[i];
        break;
      }
    }
    if (!hq) hq = points[0] || null;
    if (hq && game.world.setSelectedSpawn) game.world.setSelectedSpawn(hq.id);
    return !!(
      game.world._playerTeam &&
      game.world.getSelectedSpawn &&
      game.world.getSelectedSpawn()
    );
  }

  function framePreMatchMapView() {
    if (!game.world || !game.camera || !globalThis.THREE) return;
    clearPreMatchMapView();
    const spawn = game.world.getSelectedSpawn && game.world.getSelectedSpawn();
    if (!spawn) return;
    const team = game.world._playerTeam === 'enemy' ? 'enemy' : 'ally';
    const forward = team === 'enemy' ? -1 : 1;
    const y = (spawn.y || 5) + 1;
    const position = new THREE.Vector3(
      spawn.x - 18,
      y + 9,
      spawn.z - forward * 24
    );
    const target = new THREE.Vector3(
      spawn.x + 7,
      y + 2.5,
      spawn.z + forward * 24
    );
    const hiddenModels = [];
    const candidates = game.player
      ? [game.player._weaponViewModel, game.player.buildViewModel, game.player.viewModel]
      : [];
    for (let i = 0; i < candidates.length; i++) {
      const node = candidates[i];
      if (!node || hiddenModels.some((entry) => entry.node === node)) continue;
      hiddenModels.push({ node: node, visible: node.visible });
      node.visible = false;
    }
    const previousFov = game.camera.fov;
    game.camera.fov = 56;
    game.camera.updateProjectionMatrix();
    game._preMatchView = {
      position: position,
      target: target,
      startedAt: performance.now(),
      hiddenModels: hiddenModels,
      previousFov: previousFov,
    };
    if (game.world.ensureMeshedAround) {
      game.world.ensureMeshedAround(target.x, target.z, 12);
    }
    if (game.world.updateChunkVisibility) {
      game.world.updateChunkVisibility(target.x, target.z, 360);
    }
  }

  function clearPreMatchMapView() {
    const view = game._preMatchView;
    if (!view) return;
    const hiddenModels = view.hiddenModels || [];
    for (let i = 0; i < hiddenModels.length; i++) {
      const entry = hiddenModels[i];
      if (entry.node) entry.node.visible = entry.visible;
    }
    if (game.camera && view.previousFov != null) {
      game.camera.fov = view.previousFov;
      game.camera.updateProjectionMatrix();
    }
    game._preMatchView = null;
  }

  function buildSquadIntroRoster() {
    const classes = (VF.Soldier && VF.Soldier.CLASSES) || [];
    const selected = game.playerClass || (game.player && game.player.classId) || 'assault';
    const others = classes
      .map(function (info) {
        return info.id;
      })
      .filter(function (id) {
        return id !== selected;
      });
    while (others.length < 3) others.push('assault');
    const ids = [others[0], selected, others[1], others[2]];
    const names = ['阿尔法-01', '你', '阿尔法-03', '阿尔法-04'];
    const weapons = {
      assault: 'AKM',
      engineer: 'Remington 870',
      support: 'AKM',
      recon: 'SVD',
    };
    const currentWeaponId =
      game.weapons && game.weapons.current ? game.weapons.current : 'ar';
    const currentWeaponDef = VF.WEAPONS && VF.WEAPONS[currentWeaponId];
    return ids.map(function (id, index) {
      const info = classes.find(function (entry) {
        return entry.id === id;
      });
      const rawName = info ? info.nameZh || info.nameEn || id : id;
      return {
        name: names[index],
        classId: id,
        className: /兵$/.test(rawName) ? rawName : rawName + '兵',
        weapon:
          index === 1 && currentWeaponDef
            ? currentWeaponDef.nameZh || currentWeaponDef.name
            : weapons[id] || '制式步枪',
        isPlayer: index === 1,
      };
    });
  }

  function openSquadIntro(durationSec) {
    const isPvp = game.mode === 'pvp';
    const team = game.world && game.world._playerTeam === 'enemy' ? 'enemy' : 'ally';
    const teamSize = (VF.Feel && VF.Feel.ai && VF.Feel.ai.teamSize) || 32;
    const mapName =
      (VF.IslandConquestMap && VF.IslandConquestMap.name) ||
      (game.world && game.world._mapName) ||
      '荒盆';
    const enterMatch = function () {
      if (pvpSkipsPrep()) beginMatch();
      else if (game.mode === 'pvp' && VF.Pvp && VF.Pvp.roomCode) {
        openPvpSpawnGate(true);
      } else {
        beginMatch();
      }
    };
    if (!VF.UI || !VF.UI.openSquadIntro) {
      enterMatch();
      return;
    }
    VF.UI.openSquadIntro(buildSquadIntroRoster(), enterMatch, {
      mapName: mapName,
      modeName: matchModeName(),
      factionName: team === 'enemy' ? '赤焰军团' : '和平军团',
      durationSec: durationSec != null ? durationSec : 5,
      onBack: function () {
        openClassSelect();
      },
      onCustomize: function (remainingSec) {
        openLoadoutCustomizer(remainingSec);
      },
    });
  }

  function openLoadoutCustomizer(remainingSec) {
    if (!VF.UI || !VF.UI.openLoadoutCustomize) {
      openSquadIntro(remainingSec);
      return;
    }
    const isPvp = game.mode === 'pvp';
    const team = game.world && game.world._playerTeam === 'enemy' ? 'enemy' : 'ally';
    const teamSize = (VF.Feel && VF.Feel.ai && VF.Feel.ai.teamSize) || 32;
    const mapName =
      (VF.IslandConquestMap && VF.IslandConquestMap.name) ||
      (game.world && game.world._mapName) ||
      '荒盆';
    VF.UI.openLoadoutCustomize({
      classId: game.playerClass || (game.player && game.player.classId) || 'assault',
      weaponId:
        game.preferredWeaponId ||
        (game.weapons && game.weapons.current) ||
        'ar',
      mapName: mapName,
      modeName: matchModeName(),
      factionName: team === 'enemy' ? '赤焰军团' : '和平军团',
      onApply: function (selection) {
        const classId = selection.classId || 'assault';
        game.preferredWeaponId = selection.weaponId || 'ar';
        if (!game.loadout) game.loadout = {};
        game.loadout.primary = game.preferredWeaponId;
        game.playerClass = classId;
        if (game.player && game.player.applyClass) game.player.applyClass(classId);
        if (VF.UI) VF.UI.selectedClassId = classId;
        if (VF.Lobby && VF.Lobby.setPreviewClass) VF.Lobby.setPreviewClass(classId);
        applyPreferredWeapon();
        framePreMatchMapView();
        openSquadIntro(remainingSec);
      },
      onCancel: function () {
        openSquadIntro(remainingSec);
      },
    });
  }

  function applyPreferredWeapon() {
    if (!game.weapons) return;
    const requested =
      game.preferredWeaponId || game.weapons.current || 'ar';
    if (game.weapons.equip) game.weapons.equip(requested);
    if (game.weapons.syncOwnedLoadout) game.weapons.syncOwnedLoadout();
    game.preferredWeaponId = game.weapons.current || 'ar';
    if (!game.loadout) game.loadout = {};
    game.loadout.primary = game.preferredWeaponId;
    const ammo =
      game.weapons.state && game.weapons.state[game.preferredWeaponId];
    if (ammo && VF.UI && VF.UI.updateAmmo) {
      VF.UI.updateAmmo(ammo.mag, ammo.reserve);
    }
  }

  function returnToPvpLobby() {
    leavePvpToServerList();
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
    if (game.world) {
      game.world._playerTeam = null;
      game.world._selectedSpawnId = null;
    }
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
    openClassSelect();
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
    if (VF.Vehicles) {
      VF.Vehicles.init(game.scene, game.world);
      VF.Vehicles.reset(game.world._vehicleSpawns || []);
      if (VF.Vehicles.setStations) {
        VF.Vehicles.setStations(game.world._armorRepairStations || []);
      }
      game.vehicles = VF.Vehicles;
      if (VF.VehicleEffects) {
        VF.VehicleEffects.init(game, VF.Vehicles);
        VF.VehicleEffects.reset();
      }
    }

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
          if (pvpSkipsPrep()) beginMatch();
          else if (game.mode === 'pvp' && VF.Pvp && VF.Pvp.roomCode) {
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

  function openPvpSpawnGate(autoReady) {
    if (!game.player || !game.world) return;
    if (game.mode === 'pvp' && game.pvp && game.pvp.team && game.world.setPlayerTeam) {
      game.world.setPlayerTeam(game.pvp.team);
    }
    if (!game.world._playerTeam || !game.world.getSelectedSpawn()) return;
    VF.UI.closeSpawnSelect();

    const spawn = game.world.getSelectedSpawn();
    const loadout = {
      classId: game.playerClass || (game.player && game.player.classId) || 'assault',
      weaponId:
        game.preferredWeaponId ||
        (game.weapons && game.weapons.current) ||
        'ar',
      spawnId: spawn && spawn.id,
      team: game.world._playerTeam,
    };

    VF.Pvp.openSpawnGate(
      loadout,
      function () {
        beginMatch();
      },
      function () {
        openClassSelect();
      },
      { autoReady: !!autoReady }
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
      'squad-intro-overlay',
      'loadout-customize-overlay',
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
      VF.UI.squadIntroOpen = false;
      VF.UI.loadoutCustomizeOpen = false;
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

  function applySelectedDeployment() {
    let selected =
      game.world && game.world.getSelectedSpawn
        ? game.world.getSelectedSpawn()
        : null;
    let vehicle = null;
    let seat = null;
    if (
      selected &&
      selected.kind === 'vehicle' &&
      game.vehicles &&
      selected.vehicleId
    ) {
      vehicle = game.vehicles.getById(selected.vehicleId);
      seat = vehicle && vehicle.seats[selected.seatIndex];
      if (!seat || seat.occupant || seat.occupantId != null) {
        seat = vehicle && game.vehicles.getOpenSeat(vehicle);
      }
      if (!vehicle || !vehicle.alive || !seat) {
        const team = game.world._playerTeam || 'ally';
        const fallback =
          game.world._spawnPoints &&
          game.world._spawnPoints[team] &&
          game.world._spawnPoints[team].find(function (point) {
            return point.fixed;
          });
        if (fallback && game.world.setSelectedSpawn) {
          game.world._deployList = null;
          game.world.setSelectedSpawn(fallback.id);
          selected = fallback;
        }
        vehicle = null;
        seat = null;
      }
    }
    game.player.applySelectedSpawn();
    if (vehicle && seat) {
      game.vehicles.mount(game.player, vehicle, seat.index);
      game.player.vehicleWeaponIndex = 0;
      game.player.yaw = vehicle.yaw || 0;
    }
    game._lastDeploymentSelection = selected || null;
    return selected || null;
  }

  function beginMatch() {
    if (!game.player || !game.renderer) return;
    clearPreMatchMapView();
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
    if (VF.Audio && VF.Audio.setMusicAllowed) VF.Audio.setMusicAllowed(false);
    try {
      clearMatchBlockers();
      VF.UI.closeSpawnSelect();
      if (VF.Pvp && VF.Pvp.els && VF.Pvp.els.matchReadyOverlay) {
        VF.Pvp.els.matchReadyOverlay.classList.add('hidden');
      }
      game.player.team = game.world._playerTeam;
      if (game.player.applyClass) {
        game.player.applyClass(game.playerClass || game.player.classId || 'assault');
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
      applySelectedDeployment();
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
      applyPreferredWeapon();
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
      if (VF.Throwables && VF.Throwables.start) VF.Throwables.start();
      if (VF.Audio) {
        VF.Audio.play('confirm');
      }
      if (game.mode === 'pvp' && VF.Pvp) {
        VF.Pvp.phase = 'play';
        VF.Pvp._battlefieldEntered = true;
        VF.Pvp.ensureRemoteAvatar(game.scene);
        if (VF.UI.toast) VF.UI.toast('已进入战场 · 8v8 征服');
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
      if (VF.Throwables && VF.Throwables.start) VF.Throwables.start();
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
          VF.UI.showDeath('你已阵亡', '选择部署点后进入战场', '主基地或已占领旗帜均可部署');
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
    if (VF.Audio && VF.Audio.setMusicAllowed) VF.Audio.setMusicAllowed(false);
    try {
      clearMatchBlockers();
      VF.UI.closeSpawnSelect();
      if (VF.UI && VF.UI.hideDeath) VF.UI.hideDeath();

      game.player.team = game.world._playerTeam;
      if (game.player.applyClass) {
        game.player.applyClass(game.playerClass || game.player.classId || 'assault');
      }
      applyPreferredWeapon();
      if (game.player.respawn) game.player.respawn();
      game.player._reviveProtection =
        (VF.Feel && VF.Feel.conquest && VF.Feel.conquest.spawnProtectionSec) || 1.5;
      const ticketPending = game.player._cqTicketPending;
      game._lastRespawnLifeId =
        ticketPending && ticketPending.lifeId
          ? ticketPending.lifeId
          : null;
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
      applySelectedDeployment();
      if (game.world) game.world._deployList = null;
      if (game.player.unstuckFromWorld) game.player.unstuckFromWorld();
      if (game.world && game.world.ensureMeshedAround && game.player.object) {
        const sp = game.player.object.position;
        game.world.ensureMeshedAround(sp.x, sp.z, 8);
      }
      if (game.skills && game.skills.reset) game.skills.reset();
      if (VF.Throwables && VF.Throwables.start) VF.Throwables.start();
      VF.UI.showHud();
      if (VF.Audio) {
        VF.Audio.play('confirm');
      }
      if (game.mode === 'pvp' && VF.Pvp) {
        VF.Pvp.phase = 'play';
        VF.Pvp._battlefieldEntered = true;
        VF.Pvp.ensureRemoteAvatar(game.scene);
        if (VF.Pvp.reportLocalRespawn) VF.Pvp.reportLocalRespawn();
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
    if (VF.UI && VF.UI.closePauseMenu) VF.UI.closePauseMenu({ resumeLock: false });
    if (VF.UI && VF.UI.hideDeath) VF.UI.hideDeath();
    if (VF.UI && VF.UI.hideVictory) VF.UI.hideVictory();
    if (VF.UI && VF.UI.closeSpawnSelect) VF.UI.closeSpawnSelect();
    if (VF.UI && VF.UI.hideHud) VF.UI.hideHud();
    game.running = false;
    game.teamLocked = false;
    game.lockedTeam = null;
    game._openingTeam = null;
    if (game.player) game.player._cqTicketPending = false;
    if (VF.Conquest && VF.Conquest.stop) VF.Conquest.stop();
    if (VF.Throwables && VF.Throwables.stop) VF.Throwables.stop();
    if (game.mode === 'pvp' && VF.Pvp && VF.Pvp.leaveLobby) {
      VF.Pvp.leaveLobby();
      game.mode = 'pve';
      game.pvp = null;
    }
    openFrontlineHub();
    syncGameBackBtn();
  }

  function requestRedeploy() {
    const player = game.player;
    if (!player) return false;
    if (matchAlreadyEnded()) return false;
    if (VF.UI && VF.UI.spawnSelectOpen) return false;
    if (player.downed || player.dead || !player.alive) return false;
    if (player._reviveProtection > 0) return false;
    if (VF.UI && VF.UI.closePauseMenu) VF.UI.closePauseMenu({ resumeLock: false });
    player.die({ skipDowned: true, reason: 'redeploy' });
    return true;
  }

  function leaveMatchFromPause() {
    if (VF.UI && VF.UI.closePauseMenu) VF.UI.closePauseMenu({ resumeLock: false });
    returnFromDeathToHub();
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
      if (game.player && game.player.downed) return;
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
      if (game.player && game.player.downed) return;
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

    // 关卡编辑器（dev）：自由相机 + ghost + 以相机为中心的区块流送
    const editorActive = !!(VF.LevelEditor && VF.LevelEditor.isActive && VF.LevelEditor.isActive());
    const editorFreeCam = !!(VF.LevelEditor && VF.LevelEditor.isFreeCam && VF.LevelEditor.isFreeCam());
    if (editorActive) VF.LevelEditor.update(dt);

    // Deferred voxel mesh rebuilds — prefer chunks around the player so the road loads first
    // (编辑器接管时由 LevelEditor.update 自己以相机位置驱动，这里跳过避免打架)
    if (!rangeOpen && !editorActive && game.world && game.world.flushRebuilds) {
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
      const mountedVehicle =
        game.vehicles && game.player.vehicleId
          ? game.vehicles.getById(game.player.vehicleId)
          : null;
      VF.Pvp.publishPlayState({
        x: pos.x,
        y: pos.y,
        z: pos.z,
        yaw: game.player.yaw,
        hp: game.player.health,
        alive: !game.player.dead,
        crouch: !!game.player.crouching,
        prone: !!game.player.prone,
        slide: !!game.player.slide,
        classId: game.player.classId || game.playerClass || 'assault',
        team: game.player.team || game.world._playerTeam,
        stealth: !!game.player.stealthed,
        vehicleId: game.player.vehicleId || null,
        vehicleSeat:
          game.player.vehicleSeat != null ? game.player.vehicleSeat : null,
        vehicleRole: game.player.vehicleRole || null,
        vehicleThrottle: mountedVehicle
          ? mountedVehicle.driverInput.throttle
          : 0,
        vehicleSteer: mountedVehicle
          ? mountedVehicle.driverInput.steer
          : 0,
        vehicleBrake: mountedVehicle
          ? mountedVehicle.driverInput.brake
          : 0,
        vehicleBoost: mountedVehicle
          ? !!mountedVehicle.driverInput.boost
          : false,
        vehicleSlow: mountedVehicle
          ? !!mountedVehicle.driverInput.slow
          : false,
        vehicleTurretLocked: !!game.player.vehicleTurretLocked,
        vehicleAimYaw: game.player.yaw,
        vehicleAimPitch: game.player.pitch,
        vehicleWeaponIndex: game.player.vehicleWeaponIndex || 0,
        vehicleFire: !!game.player.keys['Mouse0'],
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
    const pauseOnly = !!(
      VF.UI &&
      VF.UI.pauseMenuOpen &&
      !worldPaused &&
      !VF.UI.spawnSelectOpen &&
      !VF.UI.classSelectOpen &&
      !VF.UI.inventoryOpen &&
      !VF.UI.mapOpen &&
      !VF.UI.squadIntroOpen &&
      !VF.UI.loadoutCustomizeOpen &&
      !VF.UI.modeSelectOpen &&
      !VF.UI.arsenalOpen
    );
    if (
      game.running &&
      !game.levelEditing &&
      !worldPaused &&
      game.vehicles &&
      game.vehicles.update
    ) {
      game.vehicles.update(dt, game);
    }
    if (
      game.running &&
      !worldPaused &&
      VF.VehicleEffects &&
      VF.VehicleEffects.update
    ) {
      VF.VehicleEffects.update(dt);
    }
    const playerDowned = !!(game.player && game.player.downed);
    const playerCanAct =
      game.running &&
      game.player &&
      (!game.player.dead || playerDowned) &&
      (!menuOpen || pauseOnly);
    if (pauseOnly && game.player && game.player.clearHeldKeys) {
      game.player.clearHeldKeys();
    }

    if (playerCanAct) {
      try {
        game.player.update(dt);
      } catch (err) {
        console.error('[VF] player.update', err);
        if (game.player.unstuckFromWorld) game.player.unstuckFromWorld();
      }
      if (!game.levelEditing && !playerDowned) {
        if (game.player.locked && !pauseOnly) {
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
      } else if (!editorActive && game.world && game.world.ensureMeshedAround && game.player.object) {
        game.world.ensureMeshedAround(
          game.player.object.position.x,
          game.player.object.position.z,
          8
        );
      }

      VF.UI.setAiming(
        !playerDowned &&
          game.player.aiming &&
          (game.weapons.mode === 'weapon' ||
            (VF.Gadgets && VF.Gadgets.isBinoculars && VF.Gadgets.isBinoculars())),
        VF.Gadgets && VF.Gadgets.isBinoculars && VF.Gadgets.isBinoculars()
          ? 'optic'
          : game.weapons.getDef && game.weapons.getDef().scope,
        playerDowned ? 0 : game.player._adsBlend || 0
      );
      if (!game.levelEditing && !playerDowned) {
        const mountedVehicle =
          game.vehicles && game.player.vehicleId
            ? game.vehicles.getById(game.player.vehicleId)
            : null;
        const nearbyVehicle =
          game.vehicles && !mountedVehicle
            ? game.vehicles.findNearby(
                game.player,
                5,
                game.player.team || game.world._playerTeam || 'ally'
              )[0]
            : null;
        const nearCollect = game.building.getNearbyHint();
        const nearZip = game.player.findNearbyZipline && game.player.findNearbyZipline(7.5);
        let downedAllyNear = false;
        if (
          game.player.classId === 'support' &&
          VF.Revive &&
          VF.Revive.getDowned
        ) {
          const team = game.player.team || game.world._playerTeam || 'ally';
          const list = VF.Revive.getDowned(team) || [];
          const origin = game.player.object && game.player.object.position;
          for (let i = 0; origin && i < list.length; i++) {
            const state = list[i];
            const ent = state && state.entity;
            if (!ent || ent === game.player) continue;
            const pos =
              (ent.mesh && ent.mesh.position) || (ent.object && ent.object.position);
            if (!pos) continue;
            if (Math.hypot(pos.x - origin.x, pos.y - origin.y, pos.z - origin.z) <= 2.8) {
              downedAllyNear = true;
              break;
            }
          }
        }
        if (mountedVehicle) {
          VF.UI.setInteractHint(
            true,
            '按 <kbd>E</kbd> 下车 · <kbd>F1–F6</kbd> 换座'
          );
        } else if (nearbyVehicle && game.vehicles.getOpenSeat(nearbyVehicle)) {
          let msg = '按 <kbd>E</kbd> 进入' + nearbyVehicle.def.nameZh;
          if (game.player.classId === 'engineer') {
            msg += ' · 按住 <kbd>X</kbd> 维修';
          }
          VF.UI.setInteractHint(true, msg);
        } else if (nearbyVehicle && game.player.classId === 'engineer') {
          VF.UI.setInteractHint(true, '按住 <kbd>X</kbd> 维修载具');
        } else if (downedAllyNear) {
          VF.UI.setInteractHint(true, '按住 <kbd>X</kbd> 拉起队友');
        } else if (nearCollect) {
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
      } else if (game.levelEditing) {
        VF.UI.setInteractHint(false);
        // game.levelEditing 被两个编辑器共用（大厅的 VF.MapEditor 和 F8 的
        // VF.LevelEditor），所以要问清楚是谁在开着 —— 否则 F8 编辑时也会每帧
        // tick 大厅编辑器的 FPS ghost。
        if (VF.MapEditor && VF.MapEditor.update && VF.MapEditor.isFps && VF.MapEditor.isFps()) {
          VF.MapEditor.update();
        }
      } else {
        VF.UI.setInteractHint(false);
      }

      if (game.weapons.mode === 'weapon' && game.building.active) {
        game.building.exitMode();
      }
    } else if (game._preMatchView && !rangeOpen) {
      const view = game._preMatchView;
      const sway = Math.sin((performance.now() - view.startedAt) * 0.00018) * 0.7;
      game.camera.position.copy(view.position);
      game.camera.position.x += sway;
      game.camera.lookAt(view.target);
    } else if (game.player && !rangeOpen) {
      const eye = game.player.getEyePosition();
      game.camera.position.copy(eye);
      if (!game._idleEuler) game._idleEuler = new THREE.Euler(0, 0, 0, 'YXZ');
      game._idleEuler.set(game.player.pitch, game.player.yaw, 0);
      game.camera.quaternion.setFromEuler(game._idleEuler);
    }

    // 关卡编辑器自由相机覆盖玩家相机（walk 模式让 player 写相机）
    if (editorFreeCam && VF.LevelEditor.applyCamera) VF.LevelEditor.applyCamera();

    if (VF.Audio && VF.Audio.update) {
      VF.Audio.update(
        rawDt,
        playerCanAct && !worldPaused ? game.player : null,
        game.camera,
        game.vehicles
      );
    }

    if (VF.UI && VF.UI.updateVehicleHud) {
      VF.UI.updateVehicleHud(game.player, game.vehicles);
    }
    if (VF.UI && VF.UI.tickKillFeed) VF.UI.tickKillFeed();
    if (VF.UI && VF.UI.pauseMenuOpen && VF.UI.syncPauseMenu) VF.UI.syncPauseMenu();

    if (game.running && !game.levelEditing && !worldPaused) {
      if (VF.Revive && VF.Revive.update) VF.Revive.update(dt, game);
      if (VF.Squads && VF.Squads.update) VF.Squads.update(dt, game);
      if (VF.Gadgets && VF.Gadgets.update) VF.Gadgets.update(dt, game);
      if (VF.Throwables && VF.Throwables.update) VF.Throwables.update(dt);
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

  // Boot — paint LOADING before heavy sync world gen
  requestAnimationFrame(() => {
    requestAnimationFrame(() => init());
  });
})();
