/**
 * ui.js — HUD updates: vitals, ammo, hotbar, crosshair, minimap, toasts
 */
(function (global) {
  'use strict';

  const UI = {
    _toastTimer: null,

    init() {
      this.els = {
        healthFill: document.getElementById('health-fill'),
        armorFill: document.getElementById('armor-fill'),
        healthText: document.getElementById('health-text'),
        armorText: document.getElementById('armor-text'),
        hpBlocks: document.getElementById('hp-blocks'),
        hpNum: document.getElementById('hp-num'),
        armorBlocks: document.getElementById('armor-blocks'),
        armorNum: document.getElementById('armor-num'),
        staminaRow: document.getElementById('stamina-row'),
        staminaFill: document.getElementById('stamina-fill'),
        killFeed: document.getElementById('kill-feed'),
        hurtDirs: document.getElementById('hurt-dirs'),
        waveNum: document.getElementById('wave-num'),
        timer: document.getElementById('timer'),
        coreCount: document.getElementById('core-count'),
        blockCount: document.getElementById('block-count'),
        ammoPanel: document.getElementById('ammo'),
        ammoMag: document.getElementById('ammo-mag'),
        ammoReserve: document.getElementById('ammo-reserve'),
        ammoReload: document.getElementById('ammo-reload'),
        weaponSilhouette: document.getElementById('weapon-silhouette'),
        weaponHudName: document.getElementById('weapon-hud-name'),
        weaponSlotKey: document.getElementById('weapon-slot-key'),
        weaponFireMode: document.getElementById('weapon-fire-mode'),
        weaponFireModeLabel: document.getElementById('weapon-fire-mode-label'),
        stowedWeapon: document.getElementById('stowed-weapon'),
        stowedWeaponKey: document.getElementById('stowed-weapon-key'),
        stowedWeaponSilhouette: document.getElementById('stowed-weapon-silhouette'),
        stowedWeaponName: document.getElementById('stowed-weapon-name'),
        stowedWeaponAmmo: document.getElementById('stowed-weapon-ammo'),
        vehicleHud: document.getElementById('vehicle-hud'),
        vehicleHudName: document.getElementById('vehicle-hud-name'),
        vehicleHudArmor: document.getElementById('vehicle-hud-armor'),
        vehicleHudHealthFill: document.getElementById('vehicle-hud-health-fill'),
        vehicleHudHp: document.getElementById('vehicle-hud-hp'),
        vehicleHudSpeed: document.getElementById('vehicle-hud-speed'),
        vehicleHudSeat: document.getElementById('vehicle-hud-seat'),
        vehicleHudSeats: document.getElementById('vehicle-hud-seats'),
        vehicleHudWeapon: document.getElementById('vehicle-hud-weapon'),
        vehicleHudAmmo: document.getElementById('vehicle-hud-ammo'),
        vehicleHudService: document.getElementById('vehicle-hud-service'),
        vehicleHudWeaponRack: document.getElementById('vehicle-hud-weapon-rack'),
        vehicleReticle: document.getElementById('vehicle-reticle'),
        vehicleHeOptic: document.querySelector('.vr-he-optic'),
        vehicleReticleRange: document.getElementById('vehicle-reticle-range'),
        vehicleReticlePitch: document.getElementById('vehicle-reticle-pitch'),
        vehicleReticleSpeed: document.getElementById('vehicle-reticle-speed'),
        vehicleReticleReady: document.getElementById('vehicle-reticle-ready'),
        vehicleTankWeaponStatus: document.getElementById('vehicle-tank-weapon-status'),
        vehicleTankSpeed: document.getElementById('vehicle-tank-speed'),
        vehicleTankRange: document.getElementById('vehicle-tank-range'),
        vehicleReticleAmmoType: document.getElementById('vehicle-reticle-ammo-type'),
        vehicleReticleAmmoCount: document.getElementById('vehicle-reticle-ammo-count'),
        vehicleCompass: document.getElementById('vehicle-compass'),
        vehicleHullMarker: document.getElementById('vehicle-hull-marker'),
        vehicleTurretMarker: document.getElementById('vehicle-turret-marker'),
        vehicleCannonCooldown: document.getElementById('vehicle-cannon-cooldown'),
        vehicleCannonCooldownRing: document.getElementById('vehicle-cannon-cooldown-ring'),
        vehicleCannonCooldownText: document.getElementById('vehicle-cannon-cooldown-text'),
        vehicleMgHeat: document.getElementById('vehicle-mg-heat'),
        vehicleHeavyHit: document.getElementById('vehicle-heavy-hit'),
        vehicleHeavyHitDamage: document.getElementById('vehicle-heavy-hit-damage'),
        skillHud: document.getElementById('skill-hud'),
        skillActive: document.getElementById('skill-active'),
        skillPassive: document.getElementById('skill-passive'),
        skillCdOverlay: document.getElementById('skill-cd-overlay'),
        skillCdNum: document.getElementById('skill-cd-num'),
        skillBuffRing: document.getElementById('skill-buff-ring'),
        skillPassiveTime: document.getElementById('skill-passive-time'),
        skillPassiveTimeNum: document.getElementById('skill-passive-time-num'),
        dashHud: document.getElementById('dash-hud'),
        skillDash: document.getElementById('skill-dash'),
        dashCdOverlay: document.getElementById('dash-cd-overlay'),
        dashCdNum: document.getElementById('dash-cd-num'),
        crosshair: document.getElementById('crosshair'),
        scopeOverlay: document.getElementById('scope-overlay'),
        hotbarSlots: document.querySelectorAll('[data-combat-slot]'),
        interactHint: document.getElementById('interact-hint'),
        minimap: document.getElementById('minimap'),
        minimapZone: document.getElementById('minimap-zone'),
        squadRail: document.getElementById('squad-rail'),
        bigMap: document.getElementById('big-map'),
        mapOverlay: document.getElementById('map-overlay'),
        inventory: document.getElementById('inventory'),
        hud: document.getElementById('hud'),
        objective: document.getElementById('objective'),
        squadCount: document.getElementById('squad-count'),
        hostileCount: document.getElementById('hostile-count'),
        blueCount: document.getElementById('blue-count'),
        redCount: document.getElementById('red-count'),
        missionStatus: document.getElementById('mission-status'),
        missionTitle: document.getElementById('mission-title'),
        missionFill: document.getElementById('mission-bar-fill'),
        missionPercent: document.getElementById('mission-percent'),
        homeStatus: document.getElementById('home-status'),
        homeTitle: document.getElementById('home-title'),
        homeFill: document.getElementById('home-bar-fill'),
        homePercent: document.getElementById('home-percent'),
        homeSegBar: document.getElementById('home-seg-bar'),
        missionSegBar: document.getElementById('mission-seg-bar'),
        victoryOverlay: document.getElementById('victory-overlay'),
        victorySub: document.getElementById('victory-sub'),
        victoryFlavor: document.getElementById('victory-flavor'),
        deathOverlay: document.getElementById('death-overlay'),
        deathSub: document.getElementById('death-sub'),
        deathFlavor: document.getElementById('death-flavor'),
        deathBtn: document.getElementById('death-btn'),
        deathCallBtn: document.getElementById('death-call-btn'),
        deathCallLabel: document.getElementById('death-call-label'),
        deathHubBtn: document.getElementById('death-hub-btn'),
        deathEndCard: document.getElementById('death-end-card'),
        deathEndBtn: document.getElementById('death-end-btn'),
        deathEndSub: document.getElementById('death-end-sub'),
        downedStage: document.getElementById('downed-stage'),
        downedMedicList: document.getElementById('downed-medic-list'),
        downedSkipFill: document.getElementById('downed-skip-fill'),
        downedBleedRing: document.getElementById('downed-bleed-ring'),
        downedNearest: document.getElementById('downed-nearest'),
        downedKillcard: document.getElementById('downed-killcard'),
        downedKillerName: document.getElementById('downed-killer-name'),
        downedKillerRank: document.getElementById('downed-killer-rank'),
        downedKillerGun: document.getElementById('downed-killer-gun'),
        downedKillerWeapon: document.getElementById('downed-killer-weapon'),
        downedKillerWtype: document.getElementById('downed-killer-wtype'),
        downedDmgBtn: document.getElementById('downed-dmg-btn'),
        downedDmgLog: document.getElementById('downed-dmg-log'),
        spawnOverlay: document.getElementById('spawn-overlay'),
        spawnMap: document.getElementById('spawn-map'),
        spawnBtnsAlly: document.getElementById('spawn-btns-ally'),
        spawnBtnsEnemy: document.getElementById('spawn-btns-enemy'),
        spawnGroupAlly: document.getElementById('spawn-group-ally'),
        spawnGroupEnemy: document.getElementById('spawn-group-enemy'),
        teamPickAlly: document.getElementById('team-pick-ally'),
        teamPickEnemy: document.getElementById('team-pick-enemy'),
        spawnConfirm: document.getElementById('spawn-confirm-btn'),
        spawnConfirmLabel: document.getElementById('spawn-confirm-label'),
        spawnTitle: document.getElementById('spawn-title'),
        spawnLead: document.getElementById('spawn-lead'),
        ticketAlly: document.getElementById('ticket-ally'),
        ticketEnemy: document.getElementById('ticket-enemy'),
        flagStrip: document.getElementById('flag-strip'),
        cqHud: document.getElementById('cq-hud'),
        cqCompass: document.getElementById('cq-compass'),
        cqTicketAlly: document.getElementById('cq-ticket-ally'),
        cqTicketEnemy: document.getElementById('cq-ticket-enemy'),
        cqFillAlly: document.getElementById('cq-fill-ally'),
        cqFillEnemy: document.getElementById('cq-fill-enemy'),
        cqFlags: document.getElementById('cq-flags'),
        cqClock: document.getElementById('cq-clock'),
        cqSweep: document.getElementById('cq-sweep'),
        cqCapture: document.getElementById('cq-capture'),
        cqCaptureRing: document.getElementById('cq-capture-ring'),
        cqCaptureLetter: document.getElementById('cq-capture-letter'),
        cqCaptureStatus: document.getElementById('cq-capture-status'),
        cqCaptureCounts: document.getElementById('cq-capture-counts'),
        cqCaptureFillAlly: document.getElementById('cq-capture-fill-ally'),
        cqCaptureFillEnemy: document.getElementById('cq-capture-fill-enemy'),
        cqMarkers: document.getElementById('cq-markers'),
        cqCommand: document.getElementById('cq-command'),
        cqCommandText: document.getElementById('cq-command-text'),
        cqTeamSwitch: document.getElementById('cq-team-switch'),
        cqBoard: document.getElementById('cq-board'),
        cqBoardClock: document.getElementById('cq-board-clock'),
        deployServer: document.getElementById('deploy-server'),
        spawnCancel: document.getElementById('spawn-cancel-btn'),
        deployHover: document.getElementById('deploy-hover'),
        deployClassRow: document.getElementById('deploy-class-row'),
        deployRole: document.getElementById('deploy-role-btn'),
        deployMapName: document.getElementById('deploy-map-name'),
        deployMapMode: document.getElementById('deploy-map-mode'),
        deployTicketAlly: document.getElementById('deploy-ticket-ally'),
        deployTicketEnemy: document.getElementById('deploy-ticket-enemy'),
        deployFillAlly: document.getElementById('deploy-fill-ally'),
        deployFillEnemy: document.getElementById('deploy-fill-enemy'),
        deployObjectives: document.getElementById('deploy-objectives'),
        deployClock: document.getElementById('deploy-clock'),
        deployFactionName: document.getElementById('deploy-faction-name'),
        deploySquadStatus: document.getElementById('deploy-squad-status'),
        deployClassName: document.getElementById('deploy-class-name'),
        deployClassRole: document.getElementById('deploy-class-role'),
        deployLoadoutStrip: document.getElementById('deploy-loadout-strip'),
        deployZoomIn: document.getElementById('deploy-zoom-in'),
        deployZoomOut: document.getElementById('deploy-zoom-out'),
        deployMapReset: document.getElementById('deploy-map-reset'),
        deployMapZoom: document.getElementById('deploy-map-zoom'),
        pauseOverlay: document.getElementById('pause-overlay'),
        pauseResume: document.getElementById('pause-resume'),
        pauseRedeploy: document.getElementById('pause-redeploy'),
        pauseLeave: document.getElementById('pause-leave'),
        pauseLeaveLabel: document.getElementById('pause-leave-label'),
        pauseModeName: document.getElementById('pause-mode-name'),
        pauseMapLine: document.getElementById('pause-map-line'),
        pauseBriefLead: document.getElementById('pause-brief-lead'),
        pauseBriefList: document.getElementById('pause-brief-list'),
        pauseBriefFoot: document.getElementById('pause-brief-foot'),
        modeOverlay: document.getElementById('mode-overlay'),
        classOverlay: document.getElementById('class-overlay'),
        classGrid: document.getElementById('class-grid'),
        classStageCanvas: document.getElementById('class-stage-canvas'),
        classStageName: document.getElementById('class-stage-name'),
        classStageRole: document.getElementById('class-stage-role'),
        classStageRoleText: document.getElementById('class-stage-role-text'),
        classDeployMapName: document.getElementById('class-deploy-map-name'),
        classDeployModeName: document.getElementById('class-deploy-mode-name'),
        classDeployPlayerCount: document.getElementById('class-deploy-player-count'),
        classDeployPlayerState: document.getElementById('class-deploy-player-state'),
        classDeployFactionName: document.getElementById('class-deploy-faction-name'),
        classDeployBlurb: document.getElementById('class-deploy-blurb'),
        classDeployLoadout: document.getElementById('class-deploy-loadout'),
        classStageSkills: document.getElementById('class-stage-skills'),
        classSkillActive: document.getElementById('class-skill-active'),
        classSkillPassive: document.getElementById('class-skill-passive'),
        classSkillActiveName: document.getElementById('class-skill-active-name'),
        classSkillActiveDesc: document.getElementById('class-skill-active-desc'),
        classSkillPassiveName: document.getElementById('class-skill-passive-name'),
        classSkillPassiveDesc: document.getElementById('class-skill-passive-desc'),
        classSkillTip: document.getElementById('class-skill-tip'),
        classSkillTipName: document.getElementById('class-skill-tip-name'),
        classSkillTipDesc: document.getElementById('class-skill-tip-desc'),
        classStagePlaceholder: document.getElementById('class-stage-placeholder'),
        classConfirm: document.getElementById('class-confirm-btn'),
        classCancel: document.getElementById('class-cancel-btn'),
        squadIntroOverlay: document.getElementById('squad-intro-overlay'),
        squadIntroCanvas: document.getElementById('squad-intro-canvas'),
        squadIntroCards: document.getElementById('squad-intro-cards'),
        squadIntroCountdown: document.getElementById('squad-intro-countdown'),
        squadIntroMapName: document.getElementById('squad-intro-map-name'),
        squadIntroModeName: document.getElementById('squad-intro-mode-name'),
        squadIntroFactionName: document.getElementById('squad-intro-faction-name'),
        squadIntroCurrentClass: document.getElementById('squad-intro-current-class'),
        squadIntroLoadout: document.getElementById('squad-intro-loadout'),
        squadIntroCustomize: document.getElementById('squad-intro-customize'),
        squadIntroBack: document.getElementById('squad-intro-back'),
        squadIntroSkip: document.getElementById('squad-intro-skip'),
        loadoutCustomizeOverlay: document.getElementById('loadout-customize-overlay'),
        loadoutCustomizeCanvas: document.getElementById('loadout-customize-canvas'),
        loadoutCustomizeMapName: document.getElementById('loadout-customize-map-name'),
        loadoutCustomizeModeName: document.getElementById('loadout-customize-mode-name'),
        loadoutCustomizeFactionName: document.getElementById('loadout-customize-faction-name'),
        loadoutCustomizeClassName: document.getElementById('loadout-customize-class-name'),
        loadoutCustomizeClassRole: document.getElementById('loadout-customize-class-role'),
        loadoutCustomizeClassBlurb: document.getElementById('loadout-customize-class-blurb'),
        loadoutCustomizeWeaponStats: document.getElementById('loadout-customize-weapon-stats'),
        loadoutCustomizeClasses: document.getElementById('loadout-customize-classes'),
        loadoutCustomizeWeapons: document.getElementById('loadout-customize-weapons'),
        loadoutCustomizeEquipment: document.getElementById('loadout-customize-equipment'),
        loadoutCustomizeCancel: document.getElementById('loadout-customize-cancel'),
        loadoutCustomizeApply: document.getElementById('loadout-customize-apply'),
      };
      this.minimapCtx = this.els.minimap.getContext('2d');
      this.bigMapCtx = this.els.bigMap ? this.els.bigMap.getContext('2d') : null;
      this.spawnMapCtx = this.els.spawnMap ? this.els.spawnMap.getContext('2d') : null;
      this.inventoryOpen = false;
      this.mapOpen = false;
      this.spawnSelectOpen = false;
      this.classSelectOpen = false;
      this.squadIntroOpen = false;
      this.loadoutCustomizeOpen = false;
      this.modeSelectOpen = false;
      this.arsenalOpen = false;
      this.pauseMenuOpen = false;
      this.selectedClassId = null;
      this._lastHp = 100;
      this.scoreboardOpen = false;
      this._spawnMapCamera = { zoom: 1, panX: 0, panY: 0 };
      this._spawnMapDrag = null;
      this._deathHandlers = { onRedeploy: null, onCallout: null, onHub: null };
      this._skipMouseHold = false;
      this._downedDmgOpen = false;
      this._bindDeathButtons();
      this._bindTeamSwitchButton();
      this._bindPauseMenu();
      if (global.VF.Arsenal && global.VF.Arsenal.init) global.VF.Arsenal.init();
    },

    _bindTeamSwitchButton() {
      const btn = this.els.cqTeamSwitch;
      if (!btn || btn._vfBound) return;
      btn._vfBound = true;
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (global.VF && global.VF.Pvp && global.VF.Pvp.requestTeamSwitch) {
          global.VF.Pvp.requestTeamSwitch();
        }
      });
    },

    syncTeamSwitchButton() {
      const btn = this.els && this.els.cqTeamSwitch;
      if (!btn) return;
      const g = global.VF && global.VF.game;
      const pvp = !!(g && g.mode === 'pvp' && this._hudMode === 'conquest');
      btn.classList.toggle('hidden', !pvp);
    },

    setDeathHandlers(handlers) {
      this._deathHandlers = handlers || {};
    },

    _bindDeathButtons() {
      const self = this;
      const bindSkipHold = function (el) {
        if (!el || el._vfSkipBound) return;
        el._vfSkipBound = true;
        const start = function (e) {
          e.preventDefault();
          e.stopPropagation();
          self._skipMouseHold = true;
        };
        const stop = function () {
          self._skipMouseHold = false;
        };
        el.addEventListener('mousedown', start);
        el.addEventListener('mouseup', stop);
        el.addEventListener('mouseleave', stop);
        el.addEventListener('touchstart', start, { passive: false });
        el.addEventListener('touchend', stop);
        el.addEventListener('touchcancel', stop);
      };
      bindSkipHold(this.els.deathBtn);
      if (this.els.deathEndBtn && !this.els.deathEndBtn._vfBound) {
        this.els.deathEndBtn._vfBound = true;
        this.els.deathEndBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (self._deathHandlers.onRedeploy) self._deathHandlers.onRedeploy();
        });
      }
      if (this.els.deathCallBtn && !this.els.deathCallBtn._vfBound) {
        this.els.deathCallBtn._vfBound = true;
        this.els.deathCallBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (self._deathHandlers.onCallout) self._deathHandlers.onCallout();
        });
      }
      if (this.els.deathHubBtn && !this.els.deathHubBtn._vfBound) {
        this.els.deathHubBtn._vfBound = true;
        this.els.deathHubBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (self._deathHandlers.onHub) self._deathHandlers.onHub();
        });
      }
      if (this.els.downedDmgBtn && !this.els.downedDmgBtn._vfBound) {
        this.els.downedDmgBtn._vfBound = true;
        this.els.downedDmgBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          self.toggleDownedDamageLog();
        });
      }
    },

    showHud() {
      this.els.hud.classList.remove('hidden');
      // Range may have hidden match-only chrome — restore for real matches
      const mm = document.getElementById('minimap-wrap') || this.els.minimap;
      if (mm) mm.classList.remove('hidden');
      const missionRow = document.getElementById('mission-row');
      if (missionRow) missionRow.classList.remove('hidden');
      // Top-right wave/squad panel retired — timer lives in #match-clock
      const waveInfo = document.getElementById('wave-info');
      if (waveInfo) waveInfo.classList.add('hidden');
      if (global.VF && global.VF.Conquest && global.VF.Conquest.active && this.setHudMode) {
        this.setHudMode('conquest');
      }
      if (this.syncTeamSwitchButton) this.syncTeamSwitchButton();
      if (this.syncWeaponLocks) this.syncWeaponLocks();
      if (this.syncWeaponStack) this.syncWeaponStack();
      if (global.VF && global.VF.syncGameBackBtn) global.VF.syncGameBackBtn();
    },

    hideHud() {
      if (this.els.hud) this.els.hud.classList.add('hidden');
      if (this.setHudMode) this.setHudMode('core');
      if (this.setScoreboardOpen) this.setScoreboardOpen(false);
      if (this.closePauseMenu) this.closePauseMenu({ resumeLock: false });
      if (global.VF && global.VF.syncGameBackBtn) global.VF.syncGameBackBtn();
    },

    /** Segmented core bars (5 blocks). depleteFromLeft=true → outer-left empties first. */
    _setSegBar(barEl, pct, depleteFromLeft) {
      if (!barEl) return;
      const fills = barEl.querySelectorAll('.seg-fill');
      const n = fills.length || 5;
      const p = Math.max(0, Math.min(100, pct));
      const per = 100 / n;
      for (let i = 0; i < fills.length; i++) {
        const start = depleteFromLeft ? (n - 1 - i) * per : i * per;
        const fill = Math.max(0, Math.min(1, (p - start) / per));
        fills[i].style.transform = 'scaleX(' + fill + ')';
      }
    },

    updateVitals(hp, armor) {
      const maxHp =
        (global.VF.game && global.VF.game.player && global.VF.game.player.maxHealth) || 100;
      const raw = Math.max(0, Math.min(maxHp, hp == null ? 0 : hp));
      const h = raw >= maxHp - 0.0001 ? Math.round(maxHp) : Math.floor(raw);
      const a = armor != null ? Math.round(armor) : null;
      if (this.els.healthFill) {
        this.els.healthFill.style.transform = 'scaleX(' + raw / maxHp + ')';
      }
      if (h === this._cachedHp && a === this._cachedArmor) return;
      this._cachedHp = h;
      this._cachedArmor = a;

      const blocksTotal = 16;
      const filled = Math.round((h / 100) * blocksTotal);
      const bar = '█'.repeat(filled) + '░'.repeat(blocksTotal - filled);

      if (this.els.hpBlocks) {
        this.els.hpBlocks.textContent = bar;
        this.els.hpBlocks.classList.remove('hp-mid', 'hp-low');
        if (h <= 30) this.els.hpBlocks.classList.add('hp-low');
        else if (h <= 60) this.els.hpBlocks.classList.add('hp-mid');
      }
      if (this.els.hpNum) this.els.hpNum.textContent = h;

      if (a != null && this.els.armorBlocks) {
        const armorTotal = 8;
        const armorFilled = Math.round((Math.max(0, Math.min(100, a)) / 100) * armorTotal);
        this.els.armorBlocks.textContent =
          '█'.repeat(armorFilled) + '░'.repeat(armorTotal - armorFilled);
      }
      if (this.els.armorNum && a != null) this.els.armorNum.textContent = a;

      if (this.els.healthFill) {
        this.els.healthFill.style.transform = 'scaleX(' + raw / maxHp + ')';
      }
      if (this.els.armorFill && a != null) {
        this.els.armorFill.style.transform = 'scaleX(' + Math.max(0, Math.min(100, a)) / 100 + ')';
      }
      if (this.els.healthText) this.els.healthText.textContent = h;
      if (this.els.armorText && a != null) {
        this.els.armorText.textContent = a;
      }

      if (h < this._lastHp) this.damageFlash();
      this._lastHp = h;
    },

    updateStamina(value, max, draining) {
      const row = this.els.staminaRow;
      const fill = this.els.staminaFill;
      if (!row) return;
      const m = max > 0 ? max : 100;
      const v = Math.max(0, Math.min(m, value == null ? m : value));
      const show = !!draining || v < 40;
      row.classList.toggle('hidden', !show);
      if (fill) fill.style.transform = 'scaleX(' + (v / m) + ')';
    },

    updateResources(cores, blocks) {
      if (cores === this._cachedCores && blocks === this._cachedBlocks) return;
      this._cachedCores = cores;
      this._cachedBlocks = blocks;
      if (this.els.coreCount) this.els.coreCount.textContent = cores;
      if (this.els.blockCount) this.els.blockCount.textContent = blocks;
    },

    updateAmmo(mag, reserve) {
      if (mag == null) {
        this.els.ammoMag.textContent = '—';
        this.els.ammoReserve.textContent = '';
        if (this.els.ammoPanel) {
          this.els.ammoPanel.classList.remove('low-ammo', 'mode-auto', 'mode-single');
        }
        if (this.els.weaponSilhouette) {
          this.els.weaponSilhouette.className = 'weapon-silhouette knife';
        }
        if (this.els.weaponHudName) this.els.weaponHudName.textContent = '战斗刀';
        if (this.els.weaponFireModeLabel) this.els.weaponFireModeLabel.textContent = '近战';
        this.syncWeaponStack('knife');
        return;
      }
      this.els.ammoMag.textContent = String(Math.max(0, mag | 0));
      this.els.ammoReserve.textContent = String(Math.max(0, reserve | 0));
      const weaponId =
        (global.VF.game && global.VF.game.weapons && global.VF.game.weapons.current) ||
        (global.VF.DEFAULT_PRIMARY || 'ak74');
      const def = global.VF.WEAPONS && global.VF.WEAPONS[weaponId];
      if (this.els.ammoPanel) {
        const magSize = (def && def.magSize) || 0;
        this.els.ammoPanel.classList.toggle(
          'low-ammo',
          magSize > 0 && mag <= Math.max(3, Math.ceil(magSize * 0.2))
        );
      }
      if (this.setEquippedWeapon) this.setEquippedWeapon(weaponId);
    },

    _vehicleWeaponKind(kind) {
      if (kind === 'machine-gun' || kind === 'heavy-machine-gun') return 'mg';
      if (kind === 'guided-missile') return 'missile';
      if (kind === 'grenade-launcher') return 'grenade';
      return 'shell';
    },

    _renderVehicleWeaponRack(available, index, vehicle, personal) {
      const rack = this.els.vehicleHudWeaponRack;
      if (!rack) return;
      if (personal || !available || !available.length || !vehicle) {
        if (rack._html !== '') {
          rack._html = '';
          rack.innerHTML = '';
        }
        return;
      }
      const defs = global.VF.VEHICLE_WEAPONS || {};
      const ordered = [];
      if (available[index]) ordered.push(available[index]);
      for (let i = 0; i < available.length; i++) {
        if (i !== index) ordered.push(available[i]);
      }
      const progress = [];
      const regenerating = [];
      let html = '';
      for (let i = 0; i < ordered.length; i++) {
        const id = ordered[i];
        const def = defs[id] || {};
        const state = vehicle.weapons && vehicle.weapons[id];
        const view =
          global.VF.Vehicles && typeof global.VF.Vehicles.getWeaponAmmoView === 'function'
            ? global.VF.Vehicles.getWeaponAmmoView(state, def)
            : {
                infinite: def.magSize == null,
                current: state
                  ? (state.mag || 0) + (state.reserve != null ? state.reserve || 0 : 0)
                  : 0,
                loaded: state && state.mag != null ? state.mag | 0 : 0,
                cap: (def.magSize || 0) + (def.reserveMax != null ? def.reserveMax : def.reserve || 0),
                progress: 0,
                regenerating: false,
              };
        progress.push(view.regenerating ? view.progress : 0);
        regenerating.push(!!view.regenerating);
        const slot = available.indexOf(id) + 1;
        let ammoHtml = '';
        let nameHtml = '';
        if (view.infinite) {
          nameHtml =
            '<span class="vh-wep-name">' +
            (def.nameZh || def.name || '') +
            '</span>';
        } else {
          const loaded = view.loaded != null ? view.loaded : view.current;
          ammoHtml =
            '<b class="vh-wep-ammo"><em' +
            (loaded <= 0 ? ' class="empty"' : '') +
            '>' +
            loaded +
            '</em> / ' +
            view.cap +
            '</b>';
        }
        html +=
          '<div class="vh-wep' +
          (i === 0 ? ' active' : '') +
          (view.infinite ? ' no-ammo' : '') +
          '" data-kind="' +
          this._vehicleWeaponKind(def.kind) +
          '">' +
          '<i class="vh-wep-track" aria-hidden="true"><i class="vh-wep-mask"></i></i>' +
          '<i class="vh-wep-frame" aria-hidden="true"></i>' +
          '<span class="vh-wep-icon" aria-hidden="true"></span>' +
          ammoHtml +
          nameHtml +
          '<span class="vh-wep-key">' +
          slot +
          '</span></div>';
      }
      if (rack._html !== html) {
        rack._html = html;
        rack.innerHTML = html;
      }
      const nodes = rack.children;
      for (let n = 0; n < nodes.length; n++) {
        nodes[n].style.setProperty('--regen', (progress[n] || 0).toFixed(3));
        nodes[n].classList.toggle('regenerating', !!regenerating[n]);
      }
    },

    _weaponCanFire(weaponState, weaponDef) {
      if (!weaponState || !weaponDef) return false;
      if (weaponState.overheated) return false;
      if (weaponState.reloadTimer > 0) return false;
      if (weaponState.mag != null && weaponState.mag <= 0) return false;
      if (weaponState.cooldown > 0) return false;
      return true;
    },

    _renderVehicleCompass(yaw) {
      const canvas = this.els.vehicleCompass;
      if (!canvas || typeof canvas.getContext !== 'function') return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      const heading = (((-yaw * 180) / Math.PI) % 360 + 360) % 360;
      const span = 90;
      const px = w / span;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#e6a33c';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
      ctx.shadowBlur = 2;
      const base = h - 8;
      const start = Math.floor((heading - span * 0.5) / 5) * 5;
      const end = heading + span * 0.5;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.font = '600 13px "Segoe UI", "Microsoft YaHei", sans-serif';
      for (let deg = start; deg <= end; deg += 5) {
        const x = w * 0.5 + (deg - heading) * px;
        if (x < 8 || x > w - 8) continue;
        const wrapped = ((deg % 360) + 360) % 360;
        const label = wrapped % 45 === 0;
        const major = wrapped % 15 === 0;
        const tickH = label ? 18 : major ? 12 : 7;
        ctx.fillRect(x - 1, base - tickH, 2, tickH);
        if (label) {
          ctx.fillText(String(wrapped), x, base - tickH - 3);
        }
      }
    },

    _renderTankSchematic(vehicle, player) {
      if (!vehicle) return;
      const hullYaw = vehicle.yaw || 0;
      let turretYaw = hullYaw + (vehicle.turretYaw || 0);
      const role = player && player.vehicleRole;
      const aim = vehicle.aimByRole && role && vehicle.aimByRole[role];
      if (aim && aim.yaw != null) turretYaw = aim.yaw;
      const hullDeg = this._headingDeg(hullYaw);
      const turretDeg = this._headingDeg(turretYaw);
      if (this.els.vehicleHullMarker) {
        this.els.vehicleHullMarker.setAttribute(
          'transform',
          'rotate(' + hullDeg.toFixed(2) + ' 40 42)'
        );
      }
      if (this.els.vehicleTurretMarker) {
        this.els.vehicleTurretMarker.setAttribute(
          'transform',
          'rotate(' + turretDeg.toFixed(2) + ' 40 42)'
        );
      }
    },

    updateVehicleHud(player, vehicles) {
      const vehicle =
        player && player.vehicleId && vehicles
          ? vehicles.getById(player.vehicleId)
          : null;
      if (!vehicle || !vehicle.alive) {
        this._vehicleCannonCooling = Object.create(null);
        if (this.els.vehicleHud) this.els.vehicleHud.classList.add('hidden');
        if (this.els.vehicleHudService) {
          this.els.vehicleHudService.classList.add('hidden');
          this.els.vehicleHudService.setAttribute('aria-hidden', 'true');
        }
        if (this.els.vehicleReticle) {
          this.els.vehicleReticle.classList.add('hidden');
          this.els.vehicleReticle.setAttribute('aria-hidden', 'true');
          this.els.vehicleReticle.classList.remove('cannon-ready-flash');
        }
        if (this.els.vehicleCannonCooldown) {
          this.els.vehicleCannonCooldown.classList.add('hidden');
          this.els.vehicleCannonCooldown.setAttribute('aria-hidden', 'true');
        }
        if (this.els.vehicleMgHeat) {
          this.els.vehicleMgHeat.classList.add('hidden');
          this.els.vehicleMgHeat.classList.remove('overheated');
          this.els.vehicleMgHeat.setAttribute('aria-hidden', 'true');
        }
        if (this.els.hud) {
          this.els.hud.classList.remove(
            'vehicle-active',
            'vehicle-personal',
            'vehicle-fpv',
            'vehicle-tpv',
            'vehicle-optic',
            'vehicle-tank',
            'vehicle-ifv',
            'vehicle-jeep',
            'vehicle-cannon-optic',
            'vehicle-he-optic',
            'vehicle-optic-no-count',
            'vehicle-mg-optic',
            'vehicle-mg-overheat'
          );
        }
        if (this.els.vehicleHudWeaponRack) {
          this.els.vehicleHudWeaponRack._html = '';
          this.els.vehicleHudWeaponRack.innerHTML = '';
        }
        return;
      }
      if (this.els.vehicleHud) this.els.vehicleHud.classList.remove('hidden');
      if (this.els.vehicleHud) {
        this.els.vehicleHud.classList.remove(
          'vehicle-jeep',
          'vehicle-ifv',
          'vehicle-tank',
          'role-driver',
          'role-gunner',
          'role-passenger',
          'vehicle-unarmed',
          'vehicle-no-fpv'
        );
        this.els.vehicleHud.classList.add('vehicle-' + vehicle.type);
        this.els.vehicleHud.classList.add(
          'role-' + (player.vehicleRole || 'passenger')
        );
      }
      const personal = !!(
        vehicles.canUsePersonalWeapon &&
        vehicles.canUsePersonalWeapon(player)
      );
      const canVehicleFpv = !!(
        vehicles.canUseVehicleFirstPerson &&
        vehicles.canUseVehicleFirstPerson(player)
      );
      const available = vehicles.getWeaponsForRole
        ? vehicles.getWeaponsForRole(vehicle, player.vehicleRole)
        : [];
      const armed = available.length > 0;
      const index = Math.min(
        player.vehicleWeaponIndex || 0,
        Math.max(0, available.length - 1)
      );
      const weaponId = available[index];
      const weaponDef =
        weaponId && global.VF.VEHICLE_WEAPONS
          ? global.VF.VEHICLE_WEAPONS[weaponId]
          : null;
      const weaponState = weaponId && vehicle.weapons[weaponId];
      const firstPerson = !!(!personal && canVehicleFpv && player.vehicleCameraMode === 1);
      const cannonOptic = !!(
        firstPerson &&
        (
          (vehicle.type === 'tank' && weaponId !== 'tank_coax_mg') ||
          weaponId === 'ifv_at_missile'
        )
      );
      const heOptic = !!(
        firstPerson &&
        (weaponId === 'ifv_he_autocannon' || weaponId === 'tank_coax_mg')
      );
      const hideOpticAmmo = !!(heOptic && weaponDef && weaponDef.maxHeat != null);
      const mgOptic = !!(heOptic && weaponId === 'tank_coax_mg');
      const heavyShell = !!(
        weaponDef &&
        weaponState &&
        (weaponId === 'tank_main_cannon' || weaponId === 'ifv_at_missile')
      );
      if (this.els.vehicleHud) {
        this.els.vehicleHud.classList.toggle('vehicle-no-fpv', !canVehicleFpv);
        this.els.vehicleHud.classList.toggle('vehicle-unarmed', !armed);
      }
      if (this.els.hud) {
        this.els.hud.classList.add('vehicle-active');
        this.els.hud.classList.toggle('vehicle-personal', personal);
        this.els.hud.classList.toggle('vehicle-fpv', firstPerson);
        this.els.hud.classList.toggle('vehicle-tpv', !firstPerson);
        this.els.hud.classList.toggle(
          'vehicle-optic',
          firstPerson && vehicle.type !== 'jeep'
        );
        this.els.hud.classList.toggle('vehicle-cannon-optic', cannonOptic);
        this.els.hud.classList.toggle('vehicle-he-optic', heOptic);
        this.els.hud.classList.toggle('vehicle-optic-no-count', hideOpticAmmo);
        this.els.hud.classList.toggle('vehicle-mg-optic', mgOptic);
        this.els.hud.classList.toggle(
          'vehicle-mg-overheat',
          !!(mgOptic && weaponState && weaponState.overheated)
        );
        const heatValue =
          mgOptic && weaponState && weaponState.heat != null
            ? Number(weaponState.heat)
            : 0;
        const heatRatio = mgOptic
          ? Math.max(
              0,
              Math.min(
                1,
                heatValue / Math.max(1, (weaponDef && weaponDef.maxHeat) || 100)
              )
            )
          : 0;
        const armFill =
          mgOptic && weaponState && weaponState.overheated
            ? 1
            : mgOptic
              ? heatRatio
              : 0;
        const armFillText = armFill.toFixed(3);
        const fillTargets = [this.els.hud, this.els.vehicleHeOptic];
        for (let i = 0; i < fillTargets.length; i++) {
          const target = fillTargets[i];
          if (!target || !target.style) continue;
          if (typeof target.style.setProperty === 'function') {
            target.style.setProperty('--mg-arm-fill', armFillText);
          } else {
            target.style['--mg-arm-fill'] = armFillText;
          }
        }
        this.els.hud.classList.toggle('vehicle-tank', vehicle.type === 'tank');
        this.els.hud.classList.toggle('vehicle-ifv', vehicle.type === 'ifv');
        this.els.hud.classList.toggle('vehicle-jeep', vehicle.type === 'jeep');
      }
      if (this.els.vehicleReticle) {
        const showReticle =
          !personal &&
          (player.vehicleRole === 'driver' ||
            player.vehicleRole === 'gunner' ||
            armed);
        this.els.vehicleReticle.classList.toggle('hidden', !showReticle);
        this.els.vehicleReticle.setAttribute(
          'aria-hidden',
          showReticle ? 'false' : 'true'
        );
      }
      if (this.els.vehicleReticleRange) {
        const range =
          player._vehicleSightRange != null
            ? Math.max(1, Math.round(player._vehicleSightRange))
            : null;
        this.els.vehicleReticleRange.textContent =
          range != null ? range + ' M' : '-- M';
      }
      if (this.els.vehicleReticlePitch) {
        const deg = Math.round(((player.pitch || 0) * 180) / Math.PI);
        this.els.vehicleReticlePitch.textContent =
          (deg > 0 ? '+' : '') + deg + '°';
      }
      if (this.els.vehicleReticleSpeed) {
        this.els.vehicleReticleSpeed.textContent =
          Math.round(Math.abs(vehicle.speed) * 3.6) + ' KPH';
      }
      if (this.els.vehicleTankSpeed) {
        this.els.vehicleTankSpeed.textContent = String(
          Math.round(Math.abs(vehicle.speed) * 3.6)
        );
      }
      if (this.els.vehicleTankRange) {
        const range =
          player._vehicleAimDistance != null
            ? player._vehicleAimDistance
            : player._vehicleSightRange;
        this.els.vehicleTankRange.textContent =
          range != null ? String(Math.max(1, Math.round(range))) : '--';
      }
      if (this.els.vehicleHudName) {
        this.els.vehicleHudName.textContent = vehicle.def.nameZh;
      }
      if (this.els.vehicleHudArmor) {
        this.els.vehicleHudArmor.textContent =
          vehicle.def.armorClass === 'heavy' ? '重型装甲' : '轻型装甲';
      }
      if (this.els.vehicleHudService) {
        const on = !!vehicle.servicing;
        this.els.vehicleHudService.classList.toggle('hidden', !on);
        this.els.vehicleHudService.setAttribute('aria-hidden', on ? 'false' : 'true');
      }
      const hpPct = Math.max(0, Math.min(1, vehicle.hp / vehicle.maxHp));
      if (this.els.vehicleHud) {
        this.els.vehicleHud.classList.toggle('damaged', hpPct <= 0.3);
      }
      if (this.els.vehicleHudHealthFill) {
        this.els.vehicleHudHealthFill.style.transform =
          'scaleX(' + hpPct + ')';
      }
      if (this.els.vehicleHudHp) {
        this.els.vehicleHudHp.textContent =
          Math.ceil(vehicle.hp) + ' / ' + vehicle.maxHp;
      }
      if (this.els.vehicleHudSpeed) {
        this.els.vehicleHudSpeed.textContent =
          Math.round(Math.abs(vehicle.speed) * 3.6) + ' km/h';
      }
      const roleNames = {
        driver: '驾驶员',
        gunner: '炮手',
        passenger: '乘员',
      };
      if (this.els.vehicleHudSeat) {
        this.els.vehicleHudSeat.textContent =
          (roleNames[player.vehicleRole] || '乘员') +
          ' · F' +
          (Number(player.vehicleSeat) + 1) +
          (player.vehicleTurretLocked ? ' · 炮塔锁定' : '');
      }
      if (this.els.vehicleHudSeats) {
        let seats = '';
        for (let i = 0; i < vehicle.seats.length; i++) {
          const occupied = vehicle.seats[i].occupantId != null;
          const mine = i === Number(player.vehicleSeat);
          seats +=
            '<i class="' +
            (occupied ? 'occupied ' : '') +
            (mine ? 'current' : '') +
            '">' +
            (i + 1) +
            '</i>';
        }
        if (this.els.vehicleHudSeats._html !== seats) {
          this.els.vehicleHudSeats._html = seats;
          this.els.vehicleHudSeats.innerHTML = seats;
        }
      }
      if (this.els.vehicleHud) {
        const slotWrap = this.els.vehicleHud.querySelector('.vehicle-hud-weapon-slots');
        if (slotWrap) {
          const slotN = Math.max(available.length, 1);
          if (slotWrap._slotN !== slotN) {
            slotWrap._slotN = slotN;
            let slotHtml = '';
            for (let s = 0; s < slotN; s++) slotHtml += '<i>' + (s + 1) + '</i>';
            slotWrap.innerHTML = slotHtml;
          }
          slotWrap.querySelectorAll('i').forEach(function (slot, slotIndex) {
            slot.classList.toggle(
              'active',
              slotIndex === index && slotIndex < available.length
            );
            slot.classList.toggle('unused', slotIndex >= available.length);
          });
        }
      }
      if (this.els.vehicleHudWeapon) {
        this.els.vehicleHudWeapon.textContent = personal
          ? '个人武器'
          : weaponDef
            ? weaponDef.nameZh
            : '无车载武器';
      }
      if (this.els.vehicleHudAmmo) {
        if (!weaponState) {
          this.els.vehicleHudAmmo.textContent = '—';
        } else if (weaponState.mag != null && weaponState.reserve != null) {
          let ammoText = weaponState.mag + ' / ' + weaponState.reserve;
          this.els.vehicleHudAmmo.textContent = ammoText;
        } else if (weaponState.mag != null) {
          this.els.vehicleHudAmmo.textContent = String(Math.max(0, weaponState.mag | 0));
        } else if (weaponDef && weaponDef.maxHeat != null) {
          const heat = Math.round(weaponState.heat || 0);
          this.els.vehicleHudAmmo.textContent = weaponState.overheated
            ? heat + '% 过热'
            : heat + '% 热量';
        } else {
          this.els.vehicleHudAmmo.textContent = '∞';
        }
        this.els.vehicleHudAmmo.classList.toggle(
          'overheated',
          !!(weaponState && weaponState.overheated)
        );
      }
      this._renderVehicleWeaponRack(available, index, vehicle, personal);
      if (this.els.vehicleCannonCooldown) {
        const cooling = !!(
          heavyShell &&
          (weaponState.mag == null || weaponState.mag > 0) &&
          weaponState.cooldown > 0
        );
        this.els.vehicleCannonCooldown.classList.toggle('hidden', !cooling);
        this.els.vehicleCannonCooldown.setAttribute(
          'aria-hidden',
          cooling ? 'false' : 'true'
        );
        if (cooling) {
          const maxCooldown = Math.max(0.01, weaponDef.cooldown || 4.2);
          const remaining = Math.max(0, weaponState.cooldown);
          const remainingRatio = Math.max(
            0,
            Math.min(1, remaining / maxCooldown)
          );
          if (this.els.vehicleCannonCooldownRing) {
            this.els.vehicleCannonCooldownRing.style.strokeDashoffset =
              String(remainingRatio * 100);
          }
          if (this.els.vehicleCannonCooldownText) {
            this.els.vehicleCannonCooldownText.textContent =
              '装填 ' + remaining.toFixed(1) + 's';
          }
        }
      }
      if (this.els.vehicleMgHeat) {
        const showHeat = !!(
          !personal &&
          weaponDef &&
          weaponDef.maxHeat != null &&
          weaponState
        );
        const heatRatio = showHeat
          ? Math.max(
              0,
              Math.min(1, (weaponState.heat || 0) / Math.max(1, weaponDef.maxHeat))
            )
          : 0;
        this.els.vehicleMgHeat.classList.toggle('hidden', !showHeat || heatRatio <= 0.01);
        this.els.vehicleMgHeat.classList.toggle(
          'overheated',
          !!(showHeat && weaponState.overheated)
        );
        this.els.vehicleMgHeat.setAttribute(
          'aria-hidden',
          showHeat && heatRatio > 0.01 ? 'false' : 'true'
        );
        this.els.vehicleMgHeat.style.setProperty('--heat', heatRatio.toFixed(3));
      }
      if (heavyShell) {
        this._vehicleCannonCooling = this._vehicleCannonCooling || Object.create(null);
        const readyKey = vehicle.id + '|' + weaponId;
        const hasAmmo = weaponState.mag == null || weaponState.mag > 0;
        if (weaponState.cooldown > 0 && hasAmmo) {
          this._vehicleCannonCooling[readyKey] = true;
        } else if (
          hasAmmo &&
          this._vehicleCannonCooling[readyKey]
        ) {
          delete this._vehicleCannonCooling[readyKey];
          if (this.els.vehicleReticle) {
            this.els.vehicleReticle.classList.remove('cannon-ready-flash');
            void this.els.vehicleReticle.offsetWidth;
            this.els.vehicleReticle.classList.add('cannon-ready-flash');
          }
          if (
            weaponId === 'tank_main_cannon' &&
            global.VF.Audio &&
            global.VF.Audio.play
          ) {
            global.VF.Audio.play('tank_breech', { gain: 0.24 });
          }
        }
      } else {
        this._vehicleCannonCooling = Object.create(null);
      }
      if (this.els.vehicleReticleAmmoType) {
        this.els.vehicleReticleAmmoType.textContent = personal
          ? '个人武器'
          : weaponDef && weaponDef.maxHeat != null
            ? weaponDef.nameZh || weaponDef.name || '—'
            : weaponDef
              ? weaponDef.ammoTypeZh || weaponDef.nameZh
              : '—';
      }
      if (this.els.vehicleReticleAmmoCount) {
        if (hideOpticAmmo || !weaponState || personal) {
          this.els.vehicleReticleAmmoCount.textContent = hideOpticAmmo ? '' : '—';
        } else if (
          weaponState.mag != null &&
          weaponState.reserve != null &&
          weaponDef &&
          (weaponDef.magSize === 1 || weaponId === 'ifv_at_missile')
        ) {
          this.els.vehicleReticleAmmoCount.textContent = String(
            Math.max(0, (weaponState.mag | 0) + (weaponState.reserve | 0))
          );
        } else if (weaponState.mag != null) {
          this.els.vehicleReticleAmmoCount.textContent = String(
            Math.max(0, weaponState.mag | 0)
          );
        } else {
          this.els.vehicleReticleAmmoCount.textContent = '∞';
        }
      }
      if (vehicle.type === 'tank' ||
          weaponId === 'ifv_at_missile' ||
          weaponId === 'ifv_he_autocannon') {
        this._renderVehicleCompass(player.yaw || 0);
        this._renderTankSchematic(vehicle, player);
      }
      if (this.els.vehicleReticleReady) {
        if (personal) this.els.vehicleReticleReady.textContent = '个人武器';
        else if (!weaponDef) this.els.vehicleReticleReady.textContent = '—';
        else {
          this.els.vehicleReticleReady.textContent = this._weaponCanFire(
            weaponState,
            weaponDef
          )
            ? '就绪'
            : '装填';
        }
      }
      if (this.els.vehicleTankWeaponStatus) {
        const ready = !!(
          (vehicle.type === 'tank' ||
            weaponId === 'ifv_at_missile' ||
            weaponId === 'ifv_he_autocannon') &&
          !personal &&
          this._weaponCanFire(weaponState, weaponDef)
        );
        this.els.vehicleTankWeaponStatus.textContent = ready ? '就绪' : '装填';
        this.els.vehicleTankWeaponStatus.classList.toggle('loading', !ready);
      }
    },

    setReloading(on) {
      const el = this.els.ammoReload;
      const wrap = document.getElementById('ammo');
      if (el) el.classList.toggle('hidden', !on);
      if (wrap) wrap.classList.toggle('reloading', !!on);
    },

    updateSkill(info) {
      const hud = this.els.skillHud;
      if (!hud) return;
      if (!info) {
        hud.classList.add('hidden');
        return;
      }
      hud.classList.remove('hidden');
      hud.hidden = false;
      const iconId =
        info.classId === 'assault'
          ? 'medic'
          : info.classId === 'support'
            ? 'medic'
            : info.classId === 'recon'
              ? 'ghost'
              : info.classId === 'engineer'
                ? 'engineer'
                : info.classId;
      hud.querySelectorAll('[data-skill-icon]').forEach((el) => {
        if (el.closest('#skill-passive')) return;
        el.classList.toggle('hidden', el.getAttribute('data-skill-icon') !== iconId);
      });
      const bind = this.els.skillActive && this.els.skillActive.querySelector('.skill-keybind');
      if (bind) bind.textContent = info.key || 'X';
      if (this.els.skillActive) {
        this.els.skillActive.classList.toggle('ready', !!info.ready);
        this.els.skillActive.classList.toggle('cooldown', !info.ready && info.cooldown > 0);
        this.els.skillActive.classList.toggle('pending', !!info.pending);
        this.els.skillActive.classList.toggle('aiming', !!info.aiming);
        this.els.skillActive.title = (info.name || '') + (info.key ? ' · ' + info.key : '');
      }
      const overlay = this.els.skillCdOverlay;
      const num = this.els.skillCdNum;
      if (overlay && num) {
        const onCd = info.cooldown > 0 && info.maxCooldown > 0;
        overlay.classList.toggle('hidden', !onCd);
        if (onCd) num.textContent = String(Math.ceil(info.cooldown));
      }
    },

    updateRepairHud(info) {
      const el = document.getElementById('repair-hud');
      const bar = document.getElementById('repair-hp');
      const dist = document.getElementById('repair-dist');
      if (!el) return;
      if (!info) {
        el.classList.add('hidden');
        el.setAttribute('aria-hidden', 'true');
        return;
      }
      el.classList.remove('hidden');
      el.setAttribute('aria-hidden', 'false');
      const segs = 22;
      const filled = Math.round((Math.max(0, info.hp) / Math.max(1, info.maxHp)) * segs);
      if (bar && bar.childElementCount !== segs) {
        let html = '';
        for (let i = 0; i < segs; i++) html += '<i></i>';
        bar.innerHTML = html;
      }
      if (bar) {
        const nodes = bar.children;
        for (let i = 0; i < nodes.length; i++) {
          nodes[i].classList.toggle('on', i < filled);
        }
      }
      if (dist) dist.textContent = Math.max(0, Math.round(info.dist)) + '米';
    },

    updateReviveAssist(info) {
      const el = document.getElementById('revive-assist');
      const fill = document.getElementById('revive-assist-fill');
      const label = document.getElementById('revive-assist-label');
      if (!el) return;
      if (!info) {
        el.classList.add('hidden');
        return;
      }
      el.classList.remove('hidden');
      if (label) label.textContent = info.name ? '拉起 ' + info.name : '拉起队友';
      if (fill) fill.style.width = Math.round(Math.max(0, Math.min(1, info.progress)) * 100) + '%';
    },

    setStimOverlay(on, strength) {
      const el = document.getElementById('stim-overlay');
      if (!el) return;
      if (!on) {
        el.classList.add('hidden');
        el.style.opacity = '';
        return;
      }
      el.classList.remove('hidden');
      el.style.opacity = String(0.35 + Math.max(0, Math.min(1, strength != null ? strength : 1)) * 0.65);
    },

    /** Dash remains bound to V; the skill cluster is hidden from the weapon HUD. */
    updateDash(info) {
      if (this.els.dashHud) this.els.dashHud.classList.add('hidden');
    },

    updateWave(wave, seconds) {
      const sec = Math.floor(seconds);
      if (wave === this._cachedWave && sec === this._cachedWaveSec) return;
      this._cachedWave = wave;
      this._cachedWaveSec = sec;
      if (this.els.waveNum) this.els.waveNum.textContent = wave;
      if (this._hudMode === 'conquest') return;
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      if (this.els.timer) {
        this.els.timer.textContent =
          String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      }
    },

    formatClock(seconds) {
      const sec = Math.max(0, Math.floor(seconds));
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    },

    updateSquad(allies, hostiles, zoneName) {
      if (allies === this._cachedAllies && hostiles === this._cachedHostiles && zoneName === this._cachedZone) {
        return;
      }
      this._cachedAllies = allies;
      this._cachedHostiles = hostiles;
      this._cachedZone = zoneName;
      if (this.els.squadCount) this.els.squadCount.textContent = allies;
      if (this.els.hostileCount) this.els.hostileCount.textContent = hostiles;
      if (this.els.objective && zoneName) this.els.objective.textContent = zoneName;
    },

    updateArmyCounts(blue, red) {
      const pTeam = this._playerTeam();
      const you = pTeam === 'enemy' ? red : blue;
      const them = pTeam === 'enemy' ? blue : red;
      if (you === this._cachedBlue && them === this._cachedRed) return;
      this._cachedBlue = you;
      this._cachedRed = them;
      if (this.els.blueCount) this.els.blueCount.textContent = you;
      if (this.els.redCount) this.els.redCount.textContent = them;
    },

    updateZone(zone) {
      if (this.els.objective) this.els.objective.textContent = zone.name;
      if (this.els.waveNum) this.els.waveNum.textContent = zone.id + 1;
    },

    setHudMode(mode) {
      this._hudMode = mode || 'core';
      const conquest = this._hudMode === 'conquest';
      const hud = this.els.hud || document.getElementById('hud');
      if (hud) hud.classList.toggle('hud-conquest', conquest);
      if (this.els.ticketAlly) this.els.ticketAlly.classList.toggle('hidden', !conquest);
      if (this.els.ticketEnemy) this.els.ticketEnemy.classList.toggle('hidden', !conquest);
      if (this.els.flagStrip) this.els.flagStrip.classList.add('hidden');
      if (this.els.cqHud) this.els.cqHud.classList.toggle('hidden', !conquest);
      if (this.els.cqCommand) this.els.cqCommand.classList.toggle('hidden', !conquest);
      if (!conquest) {
        if (this.els.cqCapture) this.els.cqCapture.classList.add('hidden');
        if (this.els.cqSweep) this.els.cqSweep.classList.add('hidden');
        if (this.els.cqMarkers) this.els.cqMarkers.innerHTML = '';
      }
      if (conquest) {
        if (this.els.homeTitle) this.els.homeTitle.textContent = '蓝方增援';
        if (this.els.missionTitle) this.els.missionTitle.textContent = '红方增援';
        if (this.els.homeStatus) this.els.homeStatus.title = '蓝方增援';
        if (this.els.missionStatus) this.els.missionStatus.title = '红方增援';
        if (this.els.objective) this.els.objective.textContent = '占领旗帜 · 耗尽敌方增援';
      }
      this.syncTeamSwitchButton();
    },

    _playerTeam() {
      const g = global.VF && global.VF.game;
      return (g && g.world && g.world._playerTeam) || (g && g.player && g.player.team) || 'ally';
    },

    _cqFlagKind(flag, playerTeam) {
      if (flag.contested) return 'contest';
      if (flag.phase === 'neutralizing' || flag.phase === 'capturing') return 'contest';
      if (flag.owner === 'neutral') return 'neutral';
      if (flag.owner === playerTeam) return 'friend';
      return 'foe';
    },

    updateConquestHud(allyTickets, enemyTickets, max, flags, extra) {
      extra = extra || {};
      const pTeam = this._playerTeam();
      const you = pTeam === 'enemy' ? enemyTickets : allyTickets;
      const them = pTeam === 'enemy' ? allyTickets : enemyTickets;
      max = max || 1000;
      if (this.els.ticketAlly) this.els.ticketAlly.textContent = String(allyTickets);
      if (this.els.ticketEnemy) this.els.ticketEnemy.textContent = String(enemyTickets);
      if (this.els.cqTicketAlly) this.els.cqTicketAlly.textContent = String(you);
      if (this.els.cqTicketEnemy) this.els.cqTicketEnemy.textContent = String(them);
      if (this.els.homePercent) this.els.homePercent.textContent = String(allyTickets);
      if (this.els.missionPercent) this.els.missionPercent.textContent = String(enemyTickets);
      const youPct = Math.max(0, Math.min(1, you / max));
      const themPct = Math.max(0, Math.min(1, them / max));
      const total = Math.max(1, you + them);
      const youShare = you / total;
      if (this.els.cqFillAlly) {
        this.els.cqFillAlly.style.width = youShare * 100 + '%';
        this.els.cqFillAlly.style.transform = 'none';
      }
      if (this.els.cqFillEnemy) {
        this.els.cqFillEnemy.style.width = (1 - youShare) * 100 + '%';
        this.els.cqFillEnemy.style.transform = 'none';
      }
      const allyBox = this.els.cqHud && this.els.cqHud.querySelector('.cq-tickets.ally');
      const enemyBox = this.els.cqHud && this.els.cqHud.querySelector('.cq-tickets.enemy');
      const allyBleedAmt = extra.bleedAlly != null ? extra.bleedAlly : 0;
      const enemyBleedAmt = extra.bleedEnemy != null ? extra.bleedEnemy : 0;
      const youBleed = pTeam === 'enemy' ? enemyBleedAmt : allyBleedAmt;
      const themBleed = pTeam === 'enemy' ? allyBleedAmt : enemyBleedAmt;
      if (allyBox) allyBox.classList.toggle('bleeding', youBleed > themBleed);
      if (enemyBox) enemyBox.classList.toggle('bleeding', themBleed > youBleed);
      if (this.els.cqClock) {
        const left = extra.timeLeft != null ? extra.timeLeft : 0;
        this.els.cqClock.textContent = this.formatClock(left);
        this.els.cqClock.classList.toggle('low', left <= 60);
      }
      const strip = this.els.cqFlags || this.els.flagStrip;
      if (strip) {
        const bits = flags || [];
        let html = '';
        for (let i = 0; i < bits.length; i++) {
          const f = bits[i];
          const kind = this._cqFlagKind(f, pTeam);
          html +=
            '<span class="cq-flag ' +
            kind +
            '" title="' +
            f.letter +
            '"><i></i><b>' +
            f.letter +
            '</b></span>';
        }
        if (strip._flagHtml !== html) {
          strip._flagHtml = html;
          strip.innerHTML = html;
        }
      }
      this._updateCqSweep(extra, pTeam);
    },

    _updateCqSweep(extra, pTeam) {
      extra = extra || {};
      const el = this.els.cqSweep;
      if (!el) return;
      const need = extra.sweepNeed || 60;
      const youHold = pTeam === 'enemy' ? extra.sweepEnemy : extra.sweepAlly;
      const themHold = pTeam === 'enemy' ? extra.sweepAlly : extra.sweepEnemy;
      if (youHold > 0.05) {
        const left = Math.max(0, Math.ceil(need - youHold));
        el.textContent = '关键任务成功  ' + left + 's';
        el.className = 'cq-sweep win';
      } else if (themHold > 0.05) {
        const left = Math.max(0, Math.ceil(need - themHold));
        el.textContent = '关键任务失败  ' + left + 's';
        el.className = 'cq-sweep fail';
      } else {
        el.textContent = '';
        el.className = 'cq-sweep hidden';
      }
    },

    updateConquestLive(state) {
      if (this._hudMode !== 'conquest' || !state) return;
      this._drawCqCapture(state.hint, state.playerTeam || this._playerTeam());
      this._drawCqMarkers(state.flags || [], state.camera, state.player, state.playerTeam || this._playerTeam());
    },

    updateSquadOrder(order, isLeader) {
      if (!this.els.cqCommand || this._hudMode !== 'conquest') return;
      let text = 'Q 标记 · X 职业装备 · Z 趴下';
      if (order && order.status === 'active') {
        text =
          (order.kind === 'defend' ? '防守 ' : '进攻 ') +
          order.flagLetter +
          '点 · ' +
          Math.round(Math.min(1, order.progress || 0) * 100) +
          '%' +
          (isLeader ? ' · Q 可更换命令' : '');
      } else if (isLeader) {
        text = '队长 · 对准旗点按 Q 下达命令 · X 装备 · Z 趴下';
      }
      if (this.els.cqCommandText) this.els.cqCommandText.textContent = text;
      else this.els.cqCommand.textContent = text;
    },

    _drawCqCapture(flag, playerTeam) {
      const box = this.els.cqCapture;
      if (!box) return;
      if (!flag) {
        box.classList.add('hidden');
        return;
      }
      box.classList.remove('hidden');
      const friendN = playerTeam === 'enemy' ? flag.enemyN : flag.allyN;
      const foeN = playerTeam === 'enemy' ? flag.allyN : flag.enemyN;
      let status = '占领中';
      if (flag.contested) status = '争夺中';
      else if (flag.phase === 'neutralizing') {
        status = flag.attackingTeam === playerTeam ? '中立化中' : '防守中';
      } else if (flag.phase === 'capturing') {
        status = flag.attackingTeam === playerTeam ? '占领中' : '敌军占领中';
      } else if (flag.owner === playerTeam) status = '控制中';
      else if (flag.owner === 'neutral') status = '等待占领';
      else status = '夺取中';
      if (this.els.cqCaptureLetter) this.els.cqCaptureLetter.textContent = flag.letter || '';
      if (this.els.cqCaptureStatus) this.els.cqCaptureStatus.textContent = status;
      if (this.els.cqCaptureCounts) {
        this.els.cqCaptureCounts.textContent = (friendN || 0) + ' vs ' + (foeN || 0);
      }
      const t = Math.max(0, Math.min(1, Math.abs(flag.capture || 0)));
      const towardFriend =
        (flag.capture || 0) >= 0 ? playerTeam === 'ally' : playerTeam === 'enemy';
      const hasFoe = (foeN || 0) > 0;
      const col = flag.contested ? '#ffe08a' : towardFriend ? '#4aa7ff' : '#ff6a32';
      box.style.setProperty('--cq-cap-col', col);
      let friendShare = 0.5;
      if (flag.owner === playerTeam) friendShare = hasFoe ? 0.72 + t * 0.28 : 1;
      else if (flag.owner && flag.owner !== 'neutral') {
        friendShare = hasFoe ? 0.28 - t * 0.28 : towardFriend ? t : 0;
      } else {
        friendShare = towardFriend ? t : 0;
      }
      friendShare = Math.max(0, Math.min(1, friendShare));
      const enemyShare = hasFoe ? Math.max(0, 1 - friendShare) : 0;
      if (this.els.cqCaptureFillAlly) this.els.cqCaptureFillAlly.style.width = friendShare * 100 + '%';
      if (this.els.cqCaptureFillEnemy) {
        this.els.cqCaptureFillEnemy.style.width = enemyShare * 100 + '%';
      }
    },

    _drawCqMarkers(flags, camera, player, playerTeam) {
      const wrap = this.els.cqMarkers;
      if (!wrap) return;
      if (!camera || !player || !global.THREE || !flags || !flags.length) {
        if (wrap._html) {
          wrap._html = '';
          wrap.innerHTML = '';
        }
        return;
      }
      const w = wrap.clientWidth || window.innerWidth;
      const h = wrap.clientHeight || window.innerHeight;
      if (!this._cqNdc) this._cqNdc = new global.THREE.Vector3();
      const v = this._cqNdc;
      const px = player.object.position.x;
      const pz = player.object.position.z;
      const bits = [];
      for (let i = 0; i < flags.length; i++) {
        const f = flags[i];
        const fy = (f.mesh && f.mesh.position && f.mesh.position.y) || f.y || 6;
        v.set(f.x, fy + 3.4, f.z).project(camera);
        if (v.z > 1 || v.z < -1) continue;
        let x = (v.x * 0.5 + 0.5) * w;
        let y = (-v.y * 0.5 + 0.5) * h;
        const dx = f.x - px;
        const dz = f.z - pz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < 12) continue;
        const kind = this._cqFlagKind(f, playerTeam);
        const status =
          kind === 'friend'
            ? '防守'
            : kind === 'foe'
              ? '进攻'
              : kind === 'contest'
                ? '争夺'
                : '占领';
        const edge = x < 22 || y < 72 || x > w - 22 || y > h - 86;
        x = Math.max(20, Math.min(w - 20, x));
        y = Math.max(72, Math.min(h - 78, y));
        bits.push(
          '<div class="cq-marker ' +
            kind +
            (edge ? ' edge' : '') +
            '" style="transform:translate(' +
            Math.round(x / 2) * 2 +
            'px,' +
            Math.round(y / 2) * 2 +
            'px) translate(-50%,-100%)"><i></i><b>' +
            (f.letter || '') +
            '</b><em>' +
            status +
            '</em><em>' +
            Math.round(dist) +
            'm</em></div>'
        );
      }
      const html = bits.join('');
      if (wrap._html !== html) {
        wrap._html = html;
        wrap.innerHTML = html;
      }
    },

    setObjective(text) {
      if (this.els.objective && text) this.els.objective.textContent = text;
    },

    /** Top-center bars: left=蓝方, right=红方 (fixed colors) */
    setMissionTargetLabel(label) {
      this._missionTargetLabel = label || '红方核心';
    },

    setHomeCoreLabel(label) {
      this._homeCoreLabel = label || '蓝方核心';
    },

    updateMissionCore(hp, max) {
      if (this._hudMode === 'conquest') return;
      max = max || 1000;
      const label = this._missionTargetLabel || '红方核心';
      const pct = Math.max(0, Math.min(100, Math.round((hp / max) * 100)));
      if (this.els.missionFill) {
        this.els.missionFill.style.transform = 'scaleX(' + pct / 100 + ')';
      }
      this._setSegBar(this.els.missionSegBar, pct, false);
      if (hp <= 0) {
        if (this.els.missionTitle) this.els.missionTitle.textContent = label + '已摧毁';
        if (this.els.missionPercent) this.els.missionPercent.textContent = '0%';
        if (this.els.missionStatus) this.els.missionStatus.classList.add('destroyed');
      } else {
        if (this.els.missionTitle) this.els.missionTitle.textContent = label;
        if (this.els.missionPercent) this.els.missionPercent.textContent = pct + '%';
        if (this.els.missionStatus) this.els.missionStatus.classList.remove('destroyed');
      }
    },

    updateHomeCore(hp, max) {
      if (this._hudMode === 'conquest') return;
      max = max || 1000;
      const label = this._homeCoreLabel || '蓝方核心';
      const pct = Math.max(0, Math.min(100, Math.round((hp / max) * 100)));
      if (this.els.homeFill) {
        this.els.homeFill.style.transform = 'scaleX(' + pct / 100 + ')';
      }
      this._setSegBar(this.els.homeSegBar, pct, true);
      if (hp <= 0) {
        if (this.els.homeTitle) this.els.homeTitle.textContent = label + '已摧毁';
        if (this.els.homePercent) this.els.homePercent.textContent = '0%';
        if (this.els.homeStatus) this.els.homeStatus.classList.add('destroyed');
      } else {
        if (this.els.homeTitle) this.els.homeTitle.textContent = label;
        if (this.els.homePercent) this.els.homePercent.textContent = pct + '%';
        if (this.els.homeStatus) this.els.homeStatus.classList.remove('destroyed');
      }
    },

    /** Brief flash on top core HP bars when a crystal is hit */
    pulseCoreHit(which) {
      const el =
        which === 'home'
          ? this.els.homeStatus || document.getElementById('home-status')
          : this.els.missionStatus || document.getElementById('mission-status');
      if (!el) return;
      el.classList.remove('core-hit-pulse');
      void el.offsetWidth;
      el.classList.add('core-hit-pulse');
      clearTimeout(this._coreHitPulseT);
      this._coreHitPulseT = setTimeout(function () {
        el.classList.remove('core-hit-pulse');
      }, 280);
    },

    updateBaseHp(hp, max) {
      this.updateMissionCore(hp, max);
    },

    hideVictory() {
      if (this.els.victoryOverlay) this.els.victoryOverlay.classList.add('hidden');
    },

    showVictory(title, sub) {
      if (this.hideDeath) this.hideDeath();
      if (this.closeSpawnSelect) this.closeSpawnSelect();
      if (this.closePauseMenu) this.closePauseMenu({ resumeLock: false });
      const bases = global.VF.game && global.VF.game.bases;
      const lost = !!(bases && bases.lost);
      const card =
        this.els.victoryOverlay && this.els.victoryOverlay.querySelector('.end-card');
      if (card) {
        card.classList.toggle('end-card--win', !lost);
        card.classList.toggle('end-card--fail', lost);
      }
      if (this.els.victorySub) {
        this.els.victorySub.textContent = sub
          ? sub
          : lost
            ? '核心失守，任务失败'
            : '敌人已肃清，顺利通关';
      }
      if (this.els.victoryFlavor) {
        this.els.victoryFlavor.textContent = lost
          ? '再来一局吧，战士！'
          : '干得漂亮，指挥官！';
      }
      if (this.els.victoryOverlay) {
        const h1 = this.els.victoryOverlay.querySelector('h1');
        if (h1) {
          h1.textContent = title
            ? title
            : lost
              ? '任务失败'
              : '大获全胜';
        }
        this.els.victoryOverlay.classList.remove('hidden');
      }
      document.exitPointerLock && document.exitPointerLock();
      if (global.VF.Audio) {
        global.VF.Audio.play(lost ? 'defeat' : 'victory');
      }
    },

    showDeath(title, sub, flavor) {
      this._downedMode = false;
      this._skipMouseHold = false;
      this._setDownedLook(false);
      if (this.els.deathOverlay) {
        this.els.deathOverlay.classList.add('is-endcard');
        this.els.deathOverlay.classList.remove('hidden');
      }
      if (this.els.deathEndCard) this.els.deathEndCard.classList.remove('hidden');
      if (this.els.downedStage) this.els.downedStage.classList.add('hidden');
      const h1 = this.els.deathEndCard && this.els.deathEndCard.querySelector('h1');
      if (h1) h1.textContent = title || '你已阵亡';
      if (this.els.deathEndSub) {
        this.els.deathEndSub.textContent = sub || '血量耗尽 · 等待重新部署';
      }
      if (this.els.deathFlavor) {
        this.els.deathFlavor.textContent = flavor || '选个出生点再上！';
      }
      document.exitPointerLock && document.exitPointerLock();
    },

    showDowned(seconds, extra) {
      this._downedMode = true;
      this._skipMouseHold = false;
      this._downedDmgOpen = false;
      this._setDownedLook(true);
      if (this.els.deathOverlay) {
        this.els.deathOverlay.classList.remove('hidden', 'is-endcard');
      }
      if (this.els.deathEndCard) this.els.deathEndCard.classList.add('hidden');
      if (this.els.downedStage) this.els.downedStage.classList.remove('hidden');
      if (this.els.deathCallBtn) {
        this.els.deathCallBtn.disabled = false;
        this.els.deathCallBtn.classList.remove('is-called', 'is-bleed-slow');
      }
      if (this.els.deathCallLabel) this.els.deathCallLabel.textContent = '减缓失血';
      if (this.els.downedDmgLog) this.els.downedDmgLog.classList.add('hidden');
      this.updateDowned(
        extra && typeof extra === 'object'
          ? Object.assign({ remaining: seconds }, extra)
          : { remaining: seconds }
      );
    },

    updateDowned(seconds, reviveProgress, called) {
      if (!this._downedMode) return;
      const info =
        seconds && typeof seconds === 'object'
          ? seconds
          : {
              remaining: seconds,
              reviveProgress: reviveProgress,
              called: called,
            };
      const left = Math.max(
        0,
        Math.ceil((info.remaining || 0) / Math.max(0.05, info.bleedMul == null ? 1 : info.bleedMul))
      );
      const revivePct = Math.round(Math.min(1, info.reviveProgress || 0) * 100);
      const slowed = (info.bleedMul == null ? 1 : info.bleedMul) < 0.999;
      if (this.els.deathSub) {
        this.els.deathSub.textContent =
          (slowed ? '失血减缓 · ' : '') +
          '救援窗口 ' +
          left +
          ' 秒' +
          (revivePct > 0 ? ' · 复活 ' + revivePct + '%' : '');
      }
      if (this.els.deathCallBtn) {
        this.els.deathCallBtn.disabled = false;
        this.els.deathCallBtn.classList.toggle('is-bleed-slow', slowed);
        this.els.deathCallBtn.classList.toggle('is-called', false);
      }
      if (this.els.deathCallLabel) {
        this.els.deathCallLabel.textContent = slowed ? '恢复失血' : '减缓失血';
      }
      if (this.els.downedStage) {
        this.els.downedStage.classList.toggle('is-bleed-slow', slowed);
      }
      const duration = Math.max(0.01, info.duration || 28);
      const bleed = Math.max(0, Math.min(1, (info.remaining || 0) / duration));
      if (this.els.downedBleedRing) {
        this.els.downedBleedRing.style.setProperty('--downed-bleed', bleed * 100 + '%');
      }
      const skipNeed = Math.max(0.2, info.skipNeed || 1.2);
      const skip = Math.max(0, Math.min(1, (info.skipHold || 0) / skipNeed));
      if (this.els.downedSkipFill) {
        this.els.downedSkipFill.style.width = skip * 100 + '%';
      }
      this._renderDownedMedics(info.medics || []);
      if (info.killer) this._renderDownedKiller(info.killer);
      if (this._downedDmgOpen) this._renderDownedDamageLog();
    },

    hideDeath() {
      this._downedMode = false;
      this._skipMouseHold = false;
      this._downedDmgOpen = false;
      this._setDownedLook(false);
      if (this.els.deathOverlay) {
        this.els.deathOverlay.classList.add('hidden');
        this.els.deathOverlay.classList.remove('is-endcard');
      }
    },

    toggleDownedDamageLog() {
      this._downedDmgOpen = !this._downedDmgOpen;
      if (this.els.downedDmgLog) {
        this.els.downedDmgLog.classList.toggle('hidden', !this._downedDmgOpen);
      }
      if (this._downedDmgOpen) this._renderDownedDamageLog();
    },

    _setDownedLook(on) {
      const hud = this.els.hud || document.getElementById('hud');
      if (hud) hud.classList.toggle('hud-downed', !!on);
      document.body.classList.toggle('downed-view', !!on);
      const g = global.VF && global.VF.game;
      const canvas = g && g.renderer && g.renderer.domElement;
      const pipelineOn = !(global.VF.RenderConfig && global.VF.RenderConfig.enabled === false);
      if (on) {
        global.VF.RenderGameplay = {
          colorGrade: {
            enabled: true,
            saturation: 0.07,
            contrast: 1.16,
            lift: -0.05,
            gain: 0.9,
          },
          vignette: { enabled: true, intensity: 0.72, radius: 0.46, smoothness: 0.58 },
          film: { enabled: true, grain: 0.048, aberration: 0.0032 },
        };
      } else if (global.VF) {
        global.VF.RenderGameplay = null;
      }
      if (canvas) canvas.classList.toggle('downed-world', !!on && !pipelineOn);
    },

    _weaponCategoryLabel(def) {
      const cat = def && def.category;
      const map = {
        assault: '突击步枪',
        battle: '战斗步枪',
        carbine: '卡宾枪',
        smg: '冲锋枪',
        lmg: '轻机枪',
        dmr: '精确射手步枪',
        sniper: '狙击步枪',
        pistol: '手枪',
        shotgun: '霰弹枪',
      };
      if (map[cat]) return map[cat];
      if (def && def.id === 'rpg') return '火箭筒';
      return '';
    },

    _renderDownedMedics(list) {
      const root = this.els.downedMedicList;
      if (!root) return;
      if (!list || !list.length) {
        const html = '<li class="medic-empty">附近没有医护兵</li>';
        if (root._html !== html) {
          root._html = html;
          root.innerHTML = html;
        }
        if (this.els.downedNearest) this.els.downedNearest.textContent = '';
        return;
      }
      let html = '';
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        const meters = Math.max(1, Math.round(m.dist || 0));
        const pad = String(meters).padStart(3, '0');
        html +=
          '<li><span class="medic-dist">' +
          pad +
          ' 米</span><span class="medic-name">' +
          (m.name || '队友') +
          '</span><span class="medic-plus"' +
          (m.isSupport ? '' : ' style="opacity:.35"') +
          '>+</span></li>';
      }
      if (root._html !== html) {
        root._html = html;
        root.innerHTML = html;
      }
      if (this.els.downedNearest) {
        this.els.downedNearest.textContent =
          Math.max(1, Math.round(list[0].dist || 0)) + ' 米';
      }
    },

    _renderDownedKiller(killer) {
      killer = killer || {};
      if (this.els.downedKillerName) {
        this.els.downedKillerName.textContent = killer.name || '未知';
      }
      if (this.els.downedKillerRank) {
        this.els.downedKillerRank.textContent =
          killer.rank != null ? String(killer.rank) : '—';
      }
      const defs = (global.VF && global.VF.WEAPONS) || {};
      const def = killer.weaponId ? defs[killer.weaponId] : null;
      if (this.els.downedKillerWeapon) {
        this.els.downedKillerWeapon.textContent =
          (def && (def.nameZh || def.name)) || killer.weaponName || '—';
      }
      if (this.els.downedKillerWtype) {
        this.els.downedKillerWtype.textContent = this._weaponCategoryLabel(def);
      }
      if (this.els.downedKillerGun) {
        const kind = this._weaponIconKind(killer.weaponId, def);
        const svg = this._deployGearSvg(kind);
        if (this.els.downedKillerGun._html !== svg) {
          this.els.downedKillerGun._html = svg;
          this.els.downedKillerGun.innerHTML = svg;
        }
      }
    },

    _renderDownedDamageLog() {
      const root = this.els.downedDmgLog;
      if (!root) return;
      const scoring = global.VF && global.VF.Scoring;
      const game = global.VF && global.VF.game;
      const id =
        (game && game.player && (game.player.entityId || 'player-local')) || 'player-local';
      const list = (scoring && scoring.damage && scoring.damage[id]) || [];
      if (!list.length) {
        root.innerHTML = '<div>暂无伤害记录</div>';
        return;
      }
      const revive = global.VF && global.VF.Revive;
      let html = '';
      const start = Math.max(0, list.length - 6);
      for (let i = list.length - 1; i >= start; i--) {
        const entry = list[i];
        const name =
          revive && revive.entityName
            ? revive.entityName(entry.attackerId)
            : entry.attackerId || '未知';
        html +=
          '<div><span>' +
          name +
          '</span><span class="dmg-amt">' +
          Math.round(entry.amount) +
          '</span></div>';
      }
      root.innerHTML = html;
    },

    _hudWeaponSilhouette(id, def) {
      const category = (def && def.category) || '';
      if (id === 'knife' || (def && def.melee)) return 'knife';
      if (id === 'rpg' || category === 'launcher') return 'rpg';
      if (id === 'sg' || category === 'shotgun') return 'sg';
      if (id === 'sr' || category === 'dmr' || category === 'sniper') return 'sr';
      if (category === 'pistol') return 'pistol';
      return 'ar';
    },

    syncWeaponStack(equippedId) {
      const g = global.VF && global.VF.game;
      const defs = (global.VF && global.VF.WEAPONS) || {};
      const loadout = (g && g.loadout) || {};
      const primaryRaw =
        (g && g.preferredWeaponId) || loadout.primary || global.VF.DEFAULT_PRIMARY || 'ak74';
      const secondaryRaw =
        (g && g.preferredSecondaryId) ||
        loadout.secondary ||
        global.VF.DEFAULT_SECONDARY ||
        'usp';
      const primaryId = global.VF.sanitizePrimaryId
        ? global.VF.sanitizePrimaryId(primaryRaw)
        : primaryRaw;
      const secondaryId = global.VF.sanitizeSecondaryId
        ? global.VF.sanitizeSecondaryId(secondaryRaw)
        : secondaryRaw;
      const currentId =
        equippedId ||
        (g && g.weapons && g.weapons.current) ||
        primaryId;
      const currentDef = defs[currentId];
      const currentIsSecondary =
        currentId === secondaryId || !!(currentDef && currentDef.category === 'pistol');
      const currentIsPrimary =
        currentId === primaryId ||
        !!(
          currentDef &&
          currentDef.category !== 'pistol' &&
          currentId !== 'rpg' &&
          currentId !== 'knife'
        );
      const stowedId = currentIsSecondary ? primaryId : currentIsPrimary ? secondaryId : primaryId;
      const stowedDef = defs[stowedId];
      const stowedState = g && g.weapons && g.weapons.state && g.weapons.state[stowedId];
      let currentKey = currentIsSecondary ? 2 : currentIsPrimary ? 1 : '';
      if (currentId === 'knife') currentKey = 6;
      else if (
        currentId === 'rpg' &&
        global.VF.Gadgets &&
        global.VF.Gadgets.rpgHotbarSlot
      ) {
        currentKey = global.VF.Gadgets.rpgHotbarSlot();
      }
      if (this.els.weaponSlotKey) {
        this.els.weaponSlotKey.textContent = currentKey || '';
        this.els.weaponSlotKey.classList.toggle('hidden', !currentKey);
      }
      if (this.els.stowedWeaponKey) {
        this.els.stowedWeaponKey.textContent = currentIsSecondary || !currentIsPrimary ? '1' : '2';
      }
      if (this.els.stowedWeaponName) {
        this.els.stowedWeaponName.textContent =
          (stowedDef && (stowedDef.nameZh || stowedDef.name || stowedDef.model)) ||
          String(stowedId || '').toUpperCase();
      }
      if (this.els.stowedWeaponSilhouette) {
        this.els.stowedWeaponSilhouette.className =
          'weapon-silhouette ' + this._hudWeaponSilhouette(stowedId, stowedDef);
      }
      if (this.els.stowedWeaponAmmo) {
        const mag =
          stowedState && stowedState.mag != null
            ? stowedState.mag
            : stowedDef && stowedDef.magSize;
        const reserve =
          stowedState && stowedState.reserve != null
            ? stowedState.reserve
            : stowedDef && stowedDef.reserve;
        this.els.stowedWeaponAmmo.textContent =
          mag == null ? '' : Math.max(0, mag | 0) + ' / ' + Math.max(0, reserve | 0);
      }
    },

    setEquippedWeapon(id) {
      const def = global.VF.WEAPONS && global.VF.WEAPONS[id];
      const silhouette = this._hudWeaponSilhouette(id, def);

      const weaponName = (def && (def.nameZh || def.name || def.model)) || String(id || '武器').toUpperCase();
      if (this.els.weaponHudName) this.els.weaponHudName.textContent = weaponName;
      if (this.els.weaponFireModeLabel) {
        const fireMode =
          silhouette === 'knife'
            ? '近战'
            : def && def.automatic
              ? '全自动'
              : '单发';
        this.els.weaponFireModeLabel.textContent = fireMode;
      }
      if (this.els.ammoPanel) {
        this.els.ammoPanel.classList.toggle('mode-auto', !!(def && def.automatic));
        this.els.ammoPanel.classList.toggle(
          'mode-single',
          silhouette !== 'knife' && !(def && def.automatic)
        );
      }

      if (this.els.hotbarSlots) {
        const slotNum =
          silhouette === 'knife'
            ? 6
            : silhouette === 'pistol'
              ? 2
              : silhouette === 'rpg' &&
                  global.VF.Gadgets &&
                  global.VF.Gadgets.rpgHotbarSlot
                ? global.VF.Gadgets.rpgHotbarSlot()
                : 1;
        this.els.hotbarSlots.forEach((el) => {
          if (Number(el.dataset.slot) !== slotNum) return;
          const nameEl = el.querySelector('.slot-name');
          if (nameEl) nameEl.textContent = weaponName;
          const icon = el.querySelector('.slot-icon');
          if (icon) icon.className = 'slot-icon weapon-' + silhouette;
          el.title = weaponName + ' (' + slotNum + ')';
        });
      }
      if (this.els.weaponSilhouette) {
        this.els.weaponSilhouette.className = 'weapon-silhouette ' + silhouette;
      }
      this.syncWeaponStack(id);
    },

    setHotbarSlot(slotNum) {
      this.els.hotbarSlots.forEach((el) => {
        el.classList.toggle('active', Number(el.dataset.slot) === slotNum);
      });
    },

    syncWeaponLocks() {
      if (!this.els.hotbarSlots) return;
      this.els.hotbarSlots.forEach((el) => {
        const slot = Number(el.dataset.slot);
        if (slot >= 3) el.classList.remove('locked');
      });
      if (global.VF.Gadgets && global.VF.Gadgets.syncHud) {
        global.VF.Gadgets.syncHud(global.VF.game);
      }
    },

    /**
     * ADS / scope UI.
     * @param {boolean} aiming
     * @param {string} [scopeType] 'sniper' | 'optic' | 'holo' | null
     * @param {number} [blend] 0..1 ads blend
     */
    setAiming(aiming, scopeType, blend) {
      blend = blend != null ? blend : aiming ? 1 : 0;
      const showScope = aiming && scopeType && blend > 0.35;
      if (this.els.crosshair) {
        this.els.crosshair.classList.toggle('ads', !!aiming && !showScope);
        this.els.crosshair.classList.toggle('scoped', !!showScope);
      }
      const sc = this.els.scopeOverlay;
      if (!sc) return;
      sc.classList.remove('sniper', 'optic', 'holo');
      if (showScope) {
        sc.classList.remove('hidden');
        sc.classList.add('on', scopeType || 'sniper');
        sc.setAttribute('aria-hidden', 'false');
      } else {
        sc.classList.remove('on');
        sc.classList.add('hidden');
        sc.setAttribute('aria-hidden', 'true');
      }
    },

    /**
     * Crosshair shot feedback.
     * - 'fire': red solid 十 only (every shot)
     * - 'hit' / 'hostile': red 十 + open × ticks (hostile unit hit only)
     */
    /**
     * Crosshair shot feedback with bloom → spring settle.
     * - 'fire': red solid 十, spread then fall back
     * - 'hit' / 'hostile': red 十 + open × (hostile unit hit)
     * - 'armor': blue 十 + open × (small arms vs vehicle armor)
     * - 'kill': gold × overshoot + ring
     */
    flashCrosshair(kind) {
      const el = this.els.crosshair;
      if (!el) return;
      const showTicks =
        kind === 'hit' ||
        kind === 'hostile' ||
        kind === 'kill' ||
        kind === 'head' ||
        kind === 'armor';
      el.classList.remove('fire', 'hit', 'hit-kill', 'hit-head', 'hit-armor');
      void el.offsetWidth;
      if (showTicks) {
        el.classList.add('hit');
        if (kind === 'kill') el.classList.add('hit-kill');
        else if (kind === 'head') el.classList.add('hit-head');
        else if (kind === 'armor') el.classList.add('hit-armor');
      } else {
        el.classList.add('fire');
      }
      clearTimeout(this._hitTimer);
      const ch = (global.VF.Feel && global.VF.Feel.crosshair) || {};
      const dur =
        kind === 'kill'
          ? ch.killMs != null
            ? ch.killMs
            : 280
          : kind === 'head'
            ? ch.headMs != null
              ? ch.headMs
              : 200
            : kind === 'armor'
              ? ch.armorMs != null
                ? ch.armorMs
                : 180
              : showTicks
                ? ch.hitMs != null
                  ? ch.hitMs
                  : 170
                : ch.fireMs != null
                  ? ch.fireMs
                  : 160;
      this._hitTimer = setTimeout(function () {
        el.classList.remove('fire', 'hit', 'hit-kill', 'hit-head', 'hit-armor');
      }, dur);
    },

    flashVehicleHit(damage) {
      const el = this.els.vehicleHeavyHit;
      if (!el) return;
      if (this.els.vehicleHeavyHitDamage) {
        const amount = Math.max(0, Math.round(Number(damage) || 0));
        this.els.vehicleHeavyHitDamage.textContent =
          amount > 0 ? '伤害 ' + amount : '';
      }
      clearTimeout(this._vehicleHitTimer);
      el.classList.remove('show');
      void el.offsetWidth;
      el.classList.add('show');
      el.setAttribute('aria-hidden', 'false');
      this._vehicleHitTimer = setTimeout(function () {
        el.classList.remove('show');
        el.setAttribute('aria-hidden', 'true');
      }, 190);
    },

    _feedName(id, fallback) {
      if (fallback) return fallback;
      const Revive = global.VF.Revive;
      if (Revive && Revive.entityName) return Revive.entityName(id);
      if (id === 'player-local') return '你';
      if (id === 'remote-player') return '敌方玩家';
      return id || '未知';
    },

    _feedGun(weaponId) {
      const map = {
        ar: '步枪',
        sg: '霰弹',
        sr: '狙击',
        smg: '冲锋',
        lmg: '机枪',
        pistol: '手枪',
        rpg: 'RPG',
        'vehicle-ram': '撞击',
        frag: '破片',
        c4: 'C4',
        bleed: '流血',
        knife: '刀',
        sledge: '锤',
      };
      if (!weaponId) return '枪';
      if (map[weaponId]) return map[weaponId];
      const cat = global.VF.WeaponCatalog;
      if (cat && cat.byId && cat.byId[weaponId] && cat.byId[weaponId].name) {
        return cat.byId[weaponId].name;
      }
      return String(weaponId);
    },

    _localPlayerId() {
      const p = global.VF.game && global.VF.game.player;
      return (p && (p.entityId || 'player-local')) || 'player-local';
    },

    _allowKillFeed(entry) {
      if (!entry) return false;
      const local = this._localPlayerId();
      if (entry.killerId === local || entry.victimId === local) return true;
      if (entry.victimId === 'player-local' || entry.killerId === 'player-local') return true;
      const squads = global.VF.Squads;
      if (squads && squads.areSquadmates) {
        if (squads.areSquadmates(local, entry.killerId) || squads.areSquadmates(local, entry.victimId)) {
          return true;
        }
      }
      if (global.VF.Scoring && global.VF.Scoring.hitVictimRecently) {
        if (global.VF.Scoring.hitVictimRecently(entry.victimId, 10000)) return true;
      }
      const kf = (global.VF.Feel && global.VF.Feel.killfeed) || {};
      const range = kf.rangeM != null ? kf.rangeM : 28;
      const player = global.VF.game && global.VF.game.player;
      const pos = player && player.object && player.object.position;
      if (pos && entry.x != null && entry.z != null) {
        const d = Math.hypot(pos.x - entry.x, pos.z - entry.z);
        if (d < range) return true;
      }
      return false;
    },

    pushKillFeed(entry) {
      if (!this._allowKillFeed(entry)) return;
      this._killFeed = this._killFeed || [];
      const now = performance.now();
      const row = {
        killerId: entry.killerId || null,
        killerName: this._feedName(entry.killerId, entry.killerName),
        killerTeam: entry.killerTeam || null,
        victimId: entry.victimId || null,
        victimName: this._feedName(entry.victimId, entry.victimName),
        victimTeam: entry.victimTeam || null,
        weaponId: entry.weaponId || null,
        part: entry.part || null,
        kind: entry.kind || 'kill',
        lifeId: entry.lifeId || null,
        at: now,
      };
      if (row.lifeId) {
        for (let i = 0; i < this._killFeed.length; i++) {
          if (this._killFeed[i].lifeId === row.lifeId) {
            this._killFeed[i] = Object.assign({}, this._killFeed[i], row, { at: now });
            this._renderKillFeed();
            return;
          }
        }
      }
      this._killFeed.unshift(row);
      const max =
        (global.VF.Feel && global.VF.Feel.killfeed && global.VF.Feel.killfeed.maxRows) || 6;
      while (this._killFeed.length > max) this._killFeed.pop();
      this._renderKillFeed();
    },

    tickKillFeed() {
      const list = this._killFeed;
      if (!list || !list.length) return;
      const life =
        (global.VF.Feel && global.VF.Feel.killfeed && global.VF.Feel.killfeed.lifeMs) || 5200;
      const now = performance.now();
      const next = list.filter(function (row) {
        return now - row.at < life;
      });
      if (next.length === list.length) return;
      this._killFeed = next;
      this._renderKillFeed();
    },

    _renderKillFeed() {
      const box = this.els.killFeed;
      if (!box) return;
      box.textContent = '';
      const local = this._localPlayerId();
      const pTeam = this._playerTeam();
      const rows = this._killFeed || [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const el = document.createElement('div');
        el.className = 'kf-row';
        if (row.kind === 'down') el.classList.add('is-down');
        if (row.killerId === local || row.victimId === local || row.victimId === 'player-local') {
          el.classList.add('is-self');
        }
        if (row.killerTeam && row.killerTeam !== pTeam) el.classList.add('is-enemy');
        const k = document.createElement('span');
        k.className = 'kf-name';
        if (row.killerId === local || row.killerId === 'player-local') {
          k.classList.add(pTeam === 'enemy' ? 'self-enemy' : 'self-ally');
        }
        k.textContent = row.killerName || this._feedName(row.killerId);
        const gun = document.createElement('span');
        gun.className = 'kf-gun';
        gun.textContent = this._feedGun(row.weaponId);
        const v = document.createElement('span');
        v.className = 'kf-name';
        if (row.victimId === local || row.victimId === 'player-local') {
          v.classList.add(pTeam === 'enemy' ? 'self-enemy' : 'self-ally');
        }
        v.textContent = row.victimName || this._feedName(row.victimId);
        el.appendChild(k);
        el.appendChild(gun);
        if (row.part === 'head') {
          const diamond = document.createElement('span');
          diamond.className = 'kf-head';
          diamond.textContent = '◆';
          el.appendChild(diamond);
        }
        el.appendChild(v);
        const kind = document.createElement('span');
        kind.className = 'kf-kind';
        kind.textContent = row.kind === 'down' ? '击倒' : '击杀';
        el.appendChild(kind);
        box.appendChild(el);
      }
    },

    showHurtDir(fromPos, yaw) {
      const box = this.els.hurtDirs;
      if (!box || !fromPos) return;
      const player = global.VF.game && global.VF.game.player;
      if (!player || player.downed) return;
      const pos = player.object && player.object.position;
      if (!pos) return;
      const dx = (fromPos.x != null ? fromPos.x : fromPos.X) - pos.x;
      const dz = (fromPos.z != null ? fromPos.z : fromPos.Z) - pos.z;
      if (dx * dx + dz * dz < 0.01) return;
      const lookX = -Math.sin(yaw);
      const lookZ = -Math.cos(yaw);
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      const fwd = dx * lookX + dz * lookZ;
      const rt = dx * rightX + dz * rightZ;
      let ang = Math.atan2(rt, fwd);
      if (ang < 0) ang += Math.PI * 2;
      const oct = Math.round(ang / (Math.PI / 4)) % 8;
      const nodes = box.querySelectorAll('i');
      for (let i = 0; i < nodes.length; i++) nodes[i].classList.remove('on');
      if (nodes[oct]) nodes[oct].classList.add('on');
      clearTimeout(this._hurtDirTimer);
      this._hurtDirTimer = setTimeout(function () {
        for (let i = 0; i < nodes.length; i++) nodes[i].classList.remove('on');
      }, 700);
    },

    setInteractHint(show, text) {
      if (!this.els.interactHint) return;
      if (show === this._hintShow && text === this._hintText) return;
      this._hintShow = show;
      this._hintText = text;
      if (text) this.els.interactHint.innerHTML = text;
      this.els.interactHint.classList.toggle('hidden', !show);
    },

    damageFlash() {
      document.body.classList.remove('damaged');
      // Force reflow so animation retriggers on rapid hits
      void document.body.offsetWidth;
      document.body.classList.add('damaged');
      clearTimeout(this._dmgTimer);
      const ms =
        (global.VF.Feel && global.VF.Feel.hurt && global.VF.Feel.hurt.flashMs) != null
          ? global.VF.Feel.hurt.flashMs
          : 180;
      this._dmgTimer = setTimeout(() => document.body.classList.remove('damaged'), ms);
    },

    toggleInventory() {
      this.inventoryOpen = !this.inventoryOpen;
      this.els.inventory.classList.toggle('hidden', !this.inventoryOpen);
      if (this.inventoryOpen && this.mapOpen) this.setMapOpen(false);
      if (this.inventoryOpen && this.setScoreboardOpen) this.setScoreboardOpen(false);
      return this.inventoryOpen;
    },

    setScoreboardOpen(open) {
      this.scoreboardOpen = !!open;
      if (this.els.cqBoard) this.els.cqBoard.classList.toggle('hidden', !this.scoreboardOpen);
      if (this.scoreboardOpen) {
        if (this.inventoryOpen) {
          this.inventoryOpen = false;
          if (this.els.inventory) this.els.inventory.classList.add('hidden');
        }
        const C = global.VF && global.VF.Conquest;
        if (C && this.updateConquestBoard) this.updateConquestBoard(C);
      }
      return this.scoreboardOpen;
    },

    toggleScoreboard() {
      return this.setScoreboardOpen(!this.scoreboardOpen);
    },

    updateConquestBoard(C) {
      if (!C || !this.els.cqBoard) return;
      const stats = C.stats || {};
      const you = stats.player || {};
      const ally = stats.ally || {};
      const enemy = stats.enemy || {};
      const set = function (id, val) {
        const el = document.getElementById(id);
        if (el) el.textContent = String(val || 0);
      };
      if (this.els.cqBoardClock) {
        this.els.cqBoardClock.textContent = this.formatClock(C.timeLeft ? C.timeLeft() : 0);
      }
      set('cq-board-ally-tix', C.tickets && C.tickets.ally);
      set('cq-board-enemy-tix', C.tickets && C.tickets.enemy);
      const scoring = global.VF && global.VF.Scoring;
      const net = global.VF && global.VF.NetSimulation;
      const game = global.VF && global.VF.game;
      const scoreState =
        net &&
        net.isNetworkConquest &&
        net.isNetworkConquest(game) &&
        !net.isAuthority(game) &&
        net.remoteScoring
          ? net.remoteScoring
          : scoring && scoring.getSnapshot
            ? scoring.getSnapshot()
            : null;
      const tbody = this.els.cqBoard.querySelector('tbody');
      if (tbody && scoreState && scoreState.players && scoreState.players.length) {
        const escape = function (value) {
          return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        };
        const squads = global.VF && global.VF.Squads;
        let html = '';
        const Look = global.VF && global.VF.TeamLook;
        const pTeam = this._playerTeam();
        const teams = pTeam === 'enemy' ? ['enemy', 'ally'] : ['ally', 'enemy'];
        for (let t = 0; t < teams.length; t++) {
          const team = teams[t];
          const lookKind = Look && Look.kind ? Look.kind(team) : team === 'ally' ? 'friend' : 'foe';
          const sideName =
            Look && Look.sideName
              ? Look.sideName(team)
              : team === 'ally'
                ? '蓝方'
                : '红方';
          const teamPlayers = scoreState.players.filter(function (profile) {
            return profile.team === team;
          });
          const grouped = Object.create(null);
          for (let i = 0; i < teamPlayers.length; i++) {
            const key = teamPlayers[i].squadId || team + '-unassigned';
            (grouped[key] || (grouped[key] = [])).push(teamPlayers[i]);
          }
          for (const squadId in grouped) {
            const squad = squads && squads.getSquad ? squads.getSquad(squadId) : null;
            html +=
              '<tr class="cq-board-squad ' +
              lookKind +
              '"><td colspan="8">' +
              escape(sideName + ' · ' + (squad ? squad.name : '未编组')) +
              '</td></tr>';
            const list = grouped[squadId];
            for (let i = 0; i < list.length; i++) {
              const p = list[i];
              const support = (p.heals || 0) + (p.resupplies || 0) + (p.spots || 0);
              html +=
                '<tr' +
                (p.id === 'player-local' ? ' class="you"' : '') +
                '><td>' +
                escape(p.id === 'player-local' ? '你' : p.id.replace(/^ai-(ally|enemy)-/, 'AI ')) +
                '</td><td>' +
                (p.kills || 0) +
                '</td><td>' +
                (p.deaths || 0) +
                '</td><td>' +
                (p.assists || 0) +
                '</td><td>' +
                (p.captures || 0) +
                '</td><td>' +
                (p.revives || 0) +
                '</td><td>' +
                support +
                '</td><td>' +
                (p.score || 0) +
                '</td></tr>';
            }
          }
        }
        tbody.innerHTML = html;
        return;
      }
      set('cq-board-you-k', you.kills);
      set('cq-board-you-d', you.deaths);
      set('cq-board-you-c', you.captures);
      set('cq-board-you-s', you.score);
      set('cq-board-ally-k', ally.kills);
      set('cq-board-ally-d', ally.deaths);
      set('cq-board-ally-c', ally.captures);
      set('cq-board-ally-s', ally.score);
      set('cq-board-enemy-k', enemy.kills);
      set('cq-board-enemy-d', enemy.deaths);
      set('cq-board-enemy-c', enemy.captures);
      set('cq-board-enemy-s', enemy.score);
    },

    setMapOpen(open) {
      this.mapOpen = !!open;
      if (this.els.mapOverlay) {
        this.els.mapOverlay.classList.toggle('hidden', !this.mapOpen);
      }
      return this.mapOpen;
    },

    toggleMap() {
      return this.setMapOpen(!this.mapOpen);
    },

    isMenuOpen() {
      // Only real in-match pause screens. Treat .open / .isOpen as booleans —
      // a leftover function reference is always truthy and froze WASD.
      const tower = global.VF.TowerDesigner;
      const towerOpen = !!(tower && tower.open === true);
      let rangeOpen = false;
      if (global.VF.Range) {
        const ro = global.VF.Range.isOpen;
        rangeOpen = typeof ro === 'function' ? !!ro.call(global.VF.Range) : !!ro;
      }
      return !!(
        this.inventoryOpen ||
        this.mapOpen ||
        this.spawnSelectOpen ||
        this.classSelectOpen ||
        this.squadIntroOpen ||
        this.loadoutCustomizeOpen ||
        this.modeSelectOpen ||
        this.arsenalOpen ||
        this.pauseMenuOpen ||
        towerOpen ||
        rangeOpen
      );
    },

    /** Inventory / map / class pause the sim. Redeploy spawn overlay and Esc pause menu do not. */
    pausesWorld() {
      const tower = global.VF.TowerDesigner;
      const towerOpen = !!(tower && tower.open === true);
      let rangeOpen = false;
      if (global.VF.Range) {
        const ro = global.VF.Range.isOpen;
        rangeOpen = typeof ro === 'function' ? !!ro.call(global.VF.Range) : !!ro;
      }
      return !!(
        this.inventoryOpen ||
        this.mapOpen ||
        this.classSelectOpen ||
        this.squadIntroOpen ||
        this.loadoutCustomizeOpen ||
        this.modeSelectOpen ||
        towerOpen ||
        rangeOpen
      );
    },

    _pauseEscBlocked() {
      if (
        this.arsenalOpen ||
        this.classSelectOpen ||
        this.squadIntroOpen ||
        this.loadoutCustomizeOpen ||
        this.modeSelectOpen
      ) {
        return true;
      }
      const tower = global.VF.TowerDesigner;
      if (tower && tower.open === true) return true;
      if (global.VF.Range) {
        const ro = global.VF.Range.isOpen;
        if (typeof ro === 'function' ? !!ro.call(global.VF.Range) : !!ro) return true;
      }
      if (global.VF.MapEditor && global.VF.MapEditor.isOpen && global.VF.MapEditor.isOpen()) {
        return true;
      }
      if (global.VF.Hub && global.VF.Hub.isOpen) return true;
      if (global.VF.Lobby && global.VF.Lobby.isOpen && global.VF.Lobby.isOpen()) return true;
      const start = document.getElementById('start-overlay');
      if (start && !start.classList.contains('hidden') && !start.classList.contains('mode-active')) {
        const hud = this.els && this.els.hud;
        const hudOpen = !!(hud && !hud.classList.contains('hidden'));
        if (!hudOpen) return true;
      }
      const tutorial = document.getElementById('tutorial-overlay');
      if (tutorial && !tutorial.classList.contains('hidden')) return true;
      if (this.els && this.els.victoryOverlay && !this.els.victoryOverlay.classList.contains('hidden')) {
        return true;
      }
      if (global.VF.Pvp && global.VF.Pvp.phase === 'spawnWait') return true;
      return false;
    },

    _canOpenPauseMenu() {
      if (this._pauseEscBlocked()) return false;
      const g = global.VF && global.VF.game;
      if (!g) return false;
      if (this.spawnSelectOpen && !this._spawnRedeploy && !g.running) return false;
      if (g.running) return true;
      if (this.spawnSelectOpen && this._spawnRedeploy) return true;
      if (this.els && this.els.deathOverlay && !this.els.deathOverlay.classList.contains('hidden')) {
        return true;
      }
      if (
        this.els &&
        this.els.hud &&
        !this.els.hud.classList.contains('hidden') &&
        global.VF.Conquest &&
        global.VF.Conquest.active
      ) {
        return true;
      }
      return false;
    },

    _bindPauseMenu() {
      if (this._pauseBound) return;
      this._pauseBound = true;
      const self = this;
      if (this.els.pauseResume) {
        this.els.pauseResume.addEventListener('click', function (e) {
          e.preventDefault();
          self.closePauseMenu({ resumeLock: true });
        });
      }
      if (this.els.pauseRedeploy) {
        this.els.pauseRedeploy.addEventListener('click', function (e) {
          e.preventDefault();
          if (self.els.pauseRedeploy.disabled) return;
          if (global.VF && global.VF.requestRedeploy) global.VF.requestRedeploy();
        });
      }
      if (this.els.pauseLeave) {
        this.els.pauseLeave.addEventListener('click', function (e) {
          e.preventDefault();
          self._onPauseLeaveClick();
        });
      }
      global.addEventListener(
        'keydown',
        function (e) {
          if (e.code !== 'Escape' || e.repeat) return;
          const tag = e.target && e.target.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
          if (self.arsenalOpen || self.classSelectOpen || self.squadIntroOpen || self.loadoutCustomizeOpen) {
            return;
          }
          if (self.pauseMenuOpen) {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (performance.now() < (self._pauseIgnoreEscUntil || 0)) return;
            self.closePauseMenu({ resumeLock: true });
            return;
          }
          if (!self._canOpenPauseMenu()) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          self.openPauseMenu();
        },
        true
      );
    },

    _onPauseLeaveClick() {
      if (!this._pauseLeaveArmed) {
        this._armPauseLeave();
        return;
      }
      if (global.VF && global.VF.leaveMatchFromPause) global.VF.leaveMatchFromPause();
    },

    _armPauseLeave() {
      this._pauseLeaveArmed = true;
      if (this.els.pauseLeave) this.els.pauseLeave.classList.add('pause-leave-armed');
      if (this.els.pauseLeaveLabel) this.els.pauseLeaveLabel.textContent = '确认离开';
      if (this._pauseLeaveTimer) clearTimeout(this._pauseLeaveTimer);
      const self = this;
      this._pauseLeaveTimer = setTimeout(function () {
        self._clearPauseLeaveArm();
      }, 2500);
    },

    _clearPauseLeaveArm() {
      this._pauseLeaveArmed = false;
      if (this._pauseLeaveTimer) {
        clearTimeout(this._pauseLeaveTimer);
        this._pauseLeaveTimer = null;
      }
      if (this.els.pauseLeave) this.els.pauseLeave.classList.remove('pause-leave-armed');
      if (this.els.pauseLeaveLabel) this.els.pauseLeaveLabel.textContent = '离开对局';
    },

    shouldOpenPauseOnUnlock() {
      if (this.pauseMenuOpen) return false;
      if (
        this.inventoryOpen ||
        this.mapOpen ||
        this.spawnSelectOpen ||
        this.classSelectOpen ||
        this.squadIntroOpen ||
        this.loadoutCustomizeOpen ||
        this.arsenalOpen ||
        this.modeSelectOpen
      ) {
        return false;
      }
      const g = global.VF && global.VF.game;
      const player = g && g.player;
      if (!player || player.dead || player.downed) return false;
      return this._canOpenPauseMenu();
    },

    openPauseMenu() {
      if (!this.els) this.init();
      if (this.pauseMenuOpen) {
        this.syncPauseMenu();
        return;
      }
      if (!this._canOpenPauseMenu()) return;
      if (this.inventoryOpen) {
        this.inventoryOpen = false;
        if (this.els.inventory) this.els.inventory.classList.add('hidden');
      }
      if (this.mapOpen) this.setMapOpen(false);
      if (this.scoreboardOpen) this.setScoreboardOpen(false);
      this.pauseMenuOpen = true;
      this._pauseIgnoreEscUntil = performance.now() + 280;
      this._fillPauseBrief();
      this._clearPauseLeaveArm();
      this.syncPauseMenu();
      if (this.els.pauseOverlay) this.els.pauseOverlay.classList.remove('hidden');
      if (document.body) document.body.classList.add('pause-overlay-open');
      document.exitPointerLock && document.exitPointerLock();
      const g = global.VF && global.VF.game;
      const player = g && g.player;
      if (player && player.setPointerLock) player.setPointerLock(false);
      if (player && player.clearHeldKeys) player.clearHeldKeys();
      if (this.els.pauseResume) {
        try {
          this.els.pauseResume.focus();
        } catch (_) {}
      }
    },

    closePauseMenu(opts) {
      opts = opts || {};
      if (!this.pauseMenuOpen) {
        if (this.els.pauseOverlay) this.els.pauseOverlay.classList.add('hidden');
        if (document.body) document.body.classList.remove('pause-overlay-open');
        return;
      }
      this.pauseMenuOpen = false;
      this._clearPauseLeaveArm();
      if (this.els.pauseOverlay) this.els.pauseOverlay.classList.add('hidden');
      if (document.body) document.body.classList.remove('pause-overlay-open');
      if (opts.resumeLock === false) return;
      const g = global.VF && global.VF.game;
      const player = g && g.player;
      if (!g || !g.running || !player) return;
      if (this.spawnSelectOpen || player.dead || player.downed || !player.alive) return;
      const canvas = g.renderer && g.renderer.domElement;
      if (!canvas || !canvas.requestPointerLock) return;
      try {
        canvas.requestPointerLock();
      } catch (_) {}
    },

    syncPauseMenu() {
      if (!this.pauseMenuOpen || !this.els.pauseRedeploy) return;
      const g = global.VF && global.VF.game;
      const player = g && g.player;
      const ended = !!(
        (g && g.bases && (g.bases.won || g.bases.lost)) ||
        (g && g.mode === 'pvp' && global.VF.Pvp && global.VF.Pvp._matchEnded)
      );
      const downed = !!(player && player.downed);
      const dead = !!(player && (player.dead || !player.alive));
      const prot = !!(player && player._reviveProtection > 0);
      const onSpawn = !!this.spawnSelectOpen;
      const disable = !player || ended || downed || dead || prot || onSpawn;
      this.els.pauseRedeploy.disabled = disable;
      let why = '';
      if (ended) why = '对局已结束';
      else if (onSpawn) why = '已在部署界面';
      else if (downed) why = '倒地时请先放弃救援';
      else if (dead) why = '阵亡后请从部署图进入';
      else if (prot) why = '出生保护中无法重新部署';
      this.els.pauseRedeploy.title = why;
    },

    _fillPauseBrief() {
      const g = global.VF && global.VF.game;
      const world = g && g.world;
      const island = global.VF && global.VF.IslandConquestMap;
      const mapName = (world && world._mapName) || (island && island.name) || '荒盆';
      const pvp = !!(g && g.mode === 'pvp');
      const matchSize = pvp ? '8 vs 8' : '32 vs 32';
      const modeTitle = pvp ? '征服' : '单人游戏';
      const C = (global.VF && global.VF.CONQUEST) || {};
      const feel = (global.VF && global.VF.Feel && global.VF.Feel.conquest) || {};
      const tix = feel.tickets != null ? feel.tickets : C.TICKETS_START || 1000;
      const round = feel.roundSec != null ? feel.roundSec : C.ROUND_SEC || 2700;
      const mm = String(Math.floor(round / 60));
      const flags =
        (world && world._conquestFlags && world._conquestFlags.length
          ? world._conquestFlags
          : (world && world._kitFlags) || []) || [];
      const lastFlag = flags.length
        ? flags[flags.length - 1].letter || String.fromCharCode(64 + flags.length)
        : 'F';
      const live = global.VF && global.VF.Conquest && global.VF.Conquest.active ? global.VF.Conquest : null;
      const allyTix = live && live.tickets ? live.tickets.ally : tix;
      const enemyTix = live && live.tickets ? live.tickets.enemy : tix;
      if (this.els.pauseModeName) this.els.pauseModeName.textContent = modeTitle;
      if (this.els.pauseMapLine) {
        this.els.pauseMapLine.textContent = mapName + ' · ' + matchSize;
      }
      if (this.els.pauseBriefLead) {
        this.els.pauseBriefLead.textContent =
          '占领旗帜以消耗敌方增援。增援耗尽的一方战败。当前增援 蓝 ' +
          Math.round(allyTix) +
          ' / 红 ' +
          Math.round(enemyTix) +
          '。';
      }
      if (this.els.pauseBriefList) {
        const items = [
          '走进占领圈控制 A–' + lastFlag + ' 旗帜；双方同圈时进度冻结',
          '己方完全控制的旗帜越多，敌方掉票越快',
          '阵亡会扣除本方增援；被救起则不扣',
          '可从己方主基地或已占领旗帜重新部署',
          pvp ? '8 名真人，其余席位由 AI 补齐' : '1 名真人 + 31 AI 对战 32 AI',
        ];
        this.els.pauseBriefList.textContent = '';
        for (let i = 0; i < items.length; i++) {
          const li = document.createElement('li');
          li.textContent = items[i];
          this.els.pauseBriefList.appendChild(li);
        }
      }
      if (this.els.pauseBriefFoot) {
        this.els.pauseBriefFoot.textContent =
          '对局时长 ' + mm + ' 分钟 · 开局增援 ' + tix + '。菜单打开时战场不会暂停。';
      }
    },

    /* ---------- Multiplayer mode select ---------- */

    openModeSelect() {
      if (!this.els) this.init();
      const el = this.els.modeOverlay || document.getElementById('mode-overlay');
      if (!el) return;
      this.els.modeOverlay = el;
      this.modeSelectOpen = true;
      this.closeServerBrowser();
      if (global.VF.SoldierMenu && global.VF.SoldierMenu.hide) {
        global.VF.SoldierMenu.hide();
      }
      const cover = document.getElementById('start-overlay');
      if (cover) {
        cover.classList.remove('hidden');
        cover.classList.add('mode-active');
      }
      el.classList.remove('hidden');
      this._bindModeOverlayOnce();
      if (global.VF && global.VF.syncGameBackBtn) global.VF.syncGameBackBtn();
    },

    closeModeSelect() {
      this.modeSelectOpen = false;
      this.closeArsenal();
      this.closeServerBrowser();
      if (global.VF.SoldierMenu && global.VF.SoldierMenu.hide) {
        global.VF.SoldierMenu.hide();
      }
      if (this.els && this.els.modeOverlay) this.els.modeOverlay.classList.add('hidden');
      const cover = document.getElementById('start-overlay');
      if (cover) cover.classList.remove('mode-active');
      if (global.VF && global.VF.syncGameBackBtn) global.VF.syncGameBackBtn();
    },

    _bindModeOverlayOnce() {
      if (this._modeBound) return;
      this._modeBound = true;
      const root = this.els.modeOverlay;
      if (!root) return;
      const self = this;
      root.addEventListener('click', function (e) {
        const btn = e.target.closest('[data-mode-action]');
        if (!btn || !root.contains(btn)) return;
        const act = btn.getAttribute('data-mode-action');
        if (act === 'close') {
          self.closeModeSelect();
        } else if (act === 'mode-home') {
          self.closeServerBrowser();
          if (global.VF.SoldierMenu && global.VF.SoldierMenu.hide) {
            global.VF.SoldierMenu.hide();
          }
        } else if (act === 'soldier') {
          self.closeServerBrowser();
          if (global.VF.SoldierMenu && global.VF.SoldierMenu.show) {
            global.VF.SoldierMenu.show();
          }
        } else if (act === 'servers') {
          self.openServerBrowser();
        } else if (act === 'server-back') {
          self.closeServerBrowser();
        } else if (act === 'server-refresh') {
          self.refreshServerBrowser();
        } else if (act === 'server-create') {
          self.closeModeSelect();
          if (global.VF.Pvp && global.VF.Pvp.createRoom) global.VF.Pvp.createRoom();
        } else if (act === 'server-join') {
          const code = btn.getAttribute('data-server-code');
          if (code && global.VF.Pvp && global.VF.Pvp.joinRoomCode) {
            self.closeModeSelect();
            global.VF.Pvp.joinRoomCode(code);
          }
        } else if (act === 'settings') {
          if (self.toast) self.toast('设置：右上角可切换音效 · F10 打开参数调节');
        } else if (act === 'conquest32') {
          self.closeModeSelect();
          if (global.VF.Pvp && typeof global.VF.Pvp.quickMatch === 'function') {
            global.VF.Pvp.quickMatch();
          } else if (self.toast) {
            self.toast('联机模块未就绪');
          }
        } else if (act === 'solo') {
          if (typeof global.VF.startConquest32 === 'function') {
            global.VF.startConquest32();
          }
        } else if (act === 'range') {
          return;
        }
      });
      root.addEventListener('input', function (e) {
        if (
          e.target &&
          (e.target.id === 'server-search-input' ||
            e.target.hasAttribute('data-server-filter') ||
            e.target.hasAttribute('data-server-size') ||
            e.target.hasAttribute('data-server-mode'))
        ) {
          self.refreshServerBrowser();
        }
      });
    },

    openServerBrowser() {
      const root = this.els && this.els.modeOverlay;
      const browser = document.getElementById('server-browser');
      if (!root || !browser) return;
      if (global.VF.SoldierMenu && global.VF.SoldierMenu.hide) {
        global.VF.SoldierMenu.hide();
      }
      this.serverBrowserOpen = true;
      root.classList.add('server-browser-open');
      browser.classList.remove('hidden');
      this.refreshServerBrowser();
      if (this._serverRefreshTimer) clearInterval(this._serverRefreshTimer);
      this._serverRefreshTimer = setInterval(() => {
        if (this.serverBrowserOpen) this.refreshServerBrowser();
      }, 1000);
    },

    closeServerBrowser() {
      this.serverBrowserOpen = false;
      if (this._serverRefreshTimer) {
        clearInterval(this._serverRefreshTimer);
        this._serverRefreshTimer = null;
      }
      const root = this.els && this.els.modeOverlay;
      if (root) root.classList.remove('server-browser-open');
      const browser = document.getElementById('server-browser');
      if (browser) browser.classList.add('hidden');
    },

    _serverFilterChecked(selector, fallback) {
      const input = document.querySelector(selector);
      return input ? !!input.checked : fallback;
    },

    refreshServerBrowser() {
      if (!this.serverBrowserOpen) return;
      const pvp = global.VF && global.VF.Pvp;
      let servers = pvp && pvp.listServers ? pvp.listServers() : [];
      const searchEl = document.getElementById('server-search-input');
      const query = searchEl ? String(searchEl.value || '').trim().toLowerCase() : '';
      const showOfficial = this._serverFilterChecked(
        '[data-server-filter="official"]',
        true
      );
      const showCommunity = this._serverFilterChecked(
        '[data-server-filter="community"]',
        true
      );
      const showFull = this._serverFilterChecked('[data-server-filter="full"]', true);
      const showEmpty = this._serverFilterChecked('[data-server-filter="empty"]', true);
      const showProtected = this._serverFilterChecked(
        '[data-server-filter="protected"]',
        true
      );
      const enabledSizes = new Set(
        Array.from(document.querySelectorAll('[data-server-size]:checked')).map(function (el) {
          return Number(el.getAttribute('data-server-size'));
        })
      );
      const enabledModes = new Set(
        Array.from(document.querySelectorAll('[data-server-mode]:checked')).map(function (el) {
          return el.getAttribute('data-server-mode');
        })
      );
      servers = servers.filter(function (server) {
        if (server.official && !showOfficial) return false;
        if (!server.official && !showCommunity) return false;
        if (server.players >= server.capacity && !showFull) return false;
        if (server.players === 0 && !showEmpty) return false;
        if (server.password && !showProtected) return false;
        if (enabledSizes.size && !enabledSizes.has(Number(server.size))) return false;
        if (enabledModes.size && !enabledModes.has(server.mode)) return false;
        if (
          query &&
          String(server.name + ' ' + server.map + ' ' + server.code)
            .toLowerCase()
            .indexOf(query) < 0
        ) {
          return false;
        }
        return true;
      });
      this._renderServerRows(servers);
    },

    _renderServerRows(servers) {
      const body = document.getElementById('server-list-body');
      const empty = document.getElementById('server-list-empty');
      const count = document.getElementById('server-list-count');
      if (!body) return;
      body.replaceChildren();
      for (let i = 0; i < servers.length; i++) {
        const server = servers[i];
        const row = document.createElement('tr');
        row.className = 'server-row';

        const favorite = document.createElement('td');
        favorite.className = 'server-favorite';
        favorite.textContent = '☆';
        row.appendChild(favorite);

        const mapCell = document.createElement('td');
        const mapThumb = document.createElement('span');
        mapThumb.className = 'server-map-thumb';
        mapThumb.setAttribute('aria-hidden', 'true');
        mapCell.appendChild(mapThumb);
        row.appendChild(mapCell);

        const name = document.createElement('td');
        name.className = 'server-name';
        const title = document.createElement('strong');
        title.textContent = server.name;
        const meta = document.createElement('small');
        meta.textContent =
          server.code + ' · ' + (server.phase === 'lobby' ? '等待玩家' : '对局进行中');
        name.append(title, meta);
        row.appendChild(name);

        const mode = document.createElement('td');
        mode.textContent = server.modeLabel || '征服';
        row.appendChild(mode);

        const size = document.createElement('td');
        size.textContent = server.sizeLabel || server.size;
        row.appendChild(size);

        const players = document.createElement('td');
        players.textContent = server.players + '/' + server.capacity;
        row.appendChild(players);

        const ping = document.createElement('td');
        ping.className = 'server-ping';
        ping.textContent = server.ping + ' ms';
        row.appendChild(ping);

        const joinCell = document.createElement('td');
        const join = document.createElement('button');
        join.type = 'button';
        join.className = 'server-join';
        join.setAttribute('data-mode-action', 'server-join');
        join.setAttribute('data-server-code', server.code);
        const pvpApi = global.VF && global.VF.Pvp;
        const available =
          pvpApi && typeof pvpApi.isServerJoinable === 'function'
            ? pvpApi.isServerJoinable(server)
            : server.players < server.capacity && server.phase !== 'closed';
        join.disabled = !available;
        join.textContent = available
          ? '加入'
          : server.players >= server.capacity
            ? '已满员'
            : '不可加入';
        joinCell.appendChild(join);
        row.appendChild(joinCell);
        body.appendChild(row);
      }
      if (empty) empty.classList.toggle('hidden', servers.length > 0);
      if (count) count.textContent = servers.length + ' 个服务器';
    },

    /* ---------- Character class select ---------- */

    openClassSelect(onConfirm, onCancel, preferredClassId, opts) {
      if (!this.els.classOverlay) return;
      opts = opts || {};
      this.classSelectOpen = true;
      const preferred =
        preferredClassId ||
        (global.VF.game && global.VF.game.playerClass) ||
        (global.VF.game && global.VF.game.player && global.VF.game.player.classId) ||
        'assault';
      this.selectedClassId =
        global.VF.Soldier && global.VF.Soldier.normalizeClassId
          ? global.VF.Soldier.normalizeClassId(preferred)
          : preferred;
      this._classOnConfirm = onConfirm;
      this._classOnCancel = onCancel;
      this._classPlayerStateText = opts.playerState || '比赛即将开始';
      if (this.els.classDeployMapName) {
        this.els.classDeployMapName.textContent = opts.mapName || '荒盆';
      }
      if (this.els.classDeployModeName) {
        this.els.classDeployModeName.textContent = opts.modeName || '单人游戏';
      }
      if (this.els.classDeployPlayerCount) {
        const current = opts.playerCount != null ? opts.playerCount : 64;
        const max = opts.playerMax != null ? opts.playerMax : 64;
        this.els.classDeployPlayerCount.textContent = current + '/' + max + ' 玩家';
      }
      if (this.els.classDeployPlayerState) {
        this.els.classDeployPlayerState.textContent = this._classPlayerStateText;
      }
      if (this.els.classDeployFactionName) {
        this.els.classDeployFactionName.textContent = opts.factionName || '和平军团';
      }
      this.els.classOverlay.classList.remove('hidden');
      this._buildClassGrid();
      this._bindClassSelect();
      if (this.selectedClassId && this.els.classGrid) {
        this.els.classGrid.querySelectorAll('.class-card').forEach((el) => {
          el.classList.toggle('selected', el.dataset.classId === this.selectedClassId);
        });
      }
      this._updateClassStageUI();
      this._startClassPreviews();
      this._syncClassConfirm();
      this._startClassAutoAdvance(opts.autoAdvanceSec || 0);
    },

    closeClassSelect() {
      this.classSelectOpen = false;
      this.closeArsenal();
      if (this._classAutoTimer) {
        clearInterval(this._classAutoTimer);
        this._classAutoTimer = null;
      }
      this._classAutoAdvanceAt = 0;
      if (this.els.classOverlay) this.els.classOverlay.classList.add('hidden');
      // Defer preview teardown so it never runs in the same turn as beginMatch
      const self = this;
      setTimeout(function () {
        if (!self.classSelectOpen) self._stopClassPreviews();
      }, 250);
    },

    _startClassAutoAdvance(seconds) {
      if (this._classAutoTimer) clearInterval(this._classAutoTimer);
      this._classAutoTimer = null;
      this._classAutoAdvanceAt = 0;
      this._classAutoTriggered = false;
      const label =
        this.els.classConfirm && this.els.classConfirm.querySelector('span');
      if (!(seconds > 0)) {
        if (label) label.textContent = '部署';
        this._syncClassConfirm();
        return;
      }
      this._classAutoAdvanceAt = performance.now() + seconds * 1000;
      const tick = () => {
        if (!this.classSelectOpen) {
          if (this._classAutoTimer) clearInterval(this._classAutoTimer);
          this._classAutoTimer = null;
          return;
        }
        const left = Math.max(
          0,
          Math.ceil((this._classAutoAdvanceAt - performance.now()) / 1000)
        );
        if (this.els.classDeployPlayerState) {
          this.els.classDeployPlayerState.textContent =
            left > 0 ? '兵种选择 · ' + left + ' 秒' : '兵种已锁定';
        }
        if (label) label.textContent = left > 0 ? '自动部署 ' + left : '部署';
        this._syncClassConfirm();
        if (left <= 0 && !this._classAutoTriggered) {
          this._classAutoTriggered = true;
          if (this._classAutoTimer) clearInterval(this._classAutoTimer);
          this._classAutoTimer = null;
          this._classAutoAdvanceAt = 0;
          if (this.selectedClassId && typeof this._classOnConfirm === 'function') {
            this._classOnConfirm(this.selectedClassId);
          }
        }
      };
      this._classAutoTimer = setInterval(tick, 200);
      tick();
    },

    _buildClassGrid() {
      const grid = this.els.classGrid;
      if (!grid || !global.VF.Soldier || !global.VF.Soldier.CLASSES) return;
      grid.innerHTML = '';
      const classes = global.VF.Soldier.CLASSES;

      for (let i = 0; i < classes.length; i++) {
        const c = classes[i];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'class-card';
        btn.dataset.classId = c.id;

        const canvas = document.createElement('canvas');
        canvas.width = 96;
        canvas.height = 96;
        canvas.dataset.classId = c.id;
        canvas.className = 'class-avatar';

        const name = document.createElement('span');
        name.className = 'class-card-name';
        const className = c.nameZh || c.nameEn || c.id;
        name.textContent = /兵$/.test(className) ? className : className + '兵';

        const role = document.createElement('small');
        role.className = 'class-card-role';
        role.textContent = c.role || '';

        btn.appendChild(canvas);
        btn.appendChild(name);
        btn.appendChild(role);
        btn.setAttribute('aria-pressed', c.id === this.selectedClassId ? 'true' : 'false');
        btn.addEventListener('click', () => {
          this.selectedClassId = c.id;
          grid.querySelectorAll('.class-card').forEach((el) => {
            el.classList.toggle('selected', el.dataset.classId === c.id);
            el.setAttribute('aria-pressed', el.dataset.classId === c.id ? 'true' : 'false');
          });
          this._updateClassStageUI();
          this._syncClassConfirm();
        });
        grid.appendChild(btn);
      }
    },

    _updateClassStageUI() {
      const id = this.selectedClassId;
      const classes = (global.VF.Soldier && global.VF.Soldier.CLASSES) || [];
      const info = classes.find((c) => c.id === id);
      if (this.els.classStagePlaceholder) {
        this.els.classStagePlaceholder.classList.toggle('hidden', !!id);
      }
      if (this.els.classStageName) {
        if (info) {
          const className = info.nameZh || info.nameEn || info.id;
          this.els.classStageName.textContent = /兵$/.test(className)
            ? className
            : className + '兵';
        } else {
          this.els.classStageName.textContent = '';
        }
      }
      if (this.els.classStageRole) {
        this.els.classStageRole.classList.toggle('is-visible', !!(info && info.role));
        this.els.classStageRole.setAttribute('aria-hidden', info && info.role ? 'false' : 'true');
      }
      if (this.els.classStageRoleText) {
        this.els.classStageRoleText.textContent = info && info.role ? info.role : '';
      }
      if (this.els.classDeployBlurb) {
        this.els.classDeployBlurb.textContent = info && info.blurb ? info.blurb : '';
      }
      if (this.els.classSkillActiveName) {
        this.els.classSkillActiveName.textContent =
          info && info.activeSkill ? info.activeSkill.name || '主动技能' : '';
      }
      if (this.els.classSkillActiveDesc) {
        this.els.classSkillActiveDesc.textContent =
          info && info.activeSkill ? info.activeSkill.desc || '' : '';
      }
      if (this.els.classSkillPassiveName) {
        this.els.classSkillPassiveName.textContent =
          info && info.passiveSkill ? info.passiveSkill.name || '被动特性' : '';
      }
      if (this.els.classSkillPassiveDesc) {
        this.els.classSkillPassiveDesc.textContent =
          info && info.passiveSkill ? info.passiveSkill.desc || '' : '';
      }
      if (this.els.classStageSkills) {
        this.els.classStageSkills.classList.toggle('hidden', !info);
      }
      if (info && this.els.classStageSkills) {
        this.els.classStageSkills.querySelectorAll('[data-skill-icon]').forEach((el) => {
          el.classList.toggle('hidden', el.getAttribute('data-skill-icon') !== id);
        });
      }
      if (info && this._syncDeployClassDetails) {
        this._syncDeployClassDetails(info);
      }
      this._hideClassSkillTip();
      if (this.els.classStageCanvas) {
        this.els.classStageCanvas.style.visibility = id ? 'visible' : 'hidden';
      }
    },

    _showClassSkillTip(kind) {
      const id = this.selectedClassId;
      const classes = (global.VF.Soldier && global.VF.Soldier.CLASSES) || [];
      const info = classes.find((c) => c.id === id);
      const tip = this.els.classSkillTip;
      if (!info || !tip) return;
      const skill = kind === 'passive' ? info.passiveSkill : info.activeSkill;
      if (!skill) return;
      if (this.els.classSkillTipName) this.els.classSkillTipName.textContent = skill.name || '';
      if (this.els.classSkillTipDesc) this.els.classSkillTipDesc.textContent = skill.desc || '';
      tip.classList.remove('hidden');
    },

    _hideClassSkillTip() {
      if (this.els.classSkillTip) this.els.classSkillTip.classList.add('hidden');
    },

    _syncClassConfirm() {
      if (this.els.classConfirm) {
        const waiting =
          this._classAutoAdvanceAt &&
          performance.now() < this._classAutoAdvanceAt;
        this.els.classConfirm.disabled = !this.selectedClassId || !!waiting;
      }
    },

    _bindClassSelect() {
      if (this._classSelectBound) return;
      this._classSelectBound = true;
      if (this.els.classConfirm) {
        this.els.classConfirm.addEventListener('click', (e) => {
          e.preventDefault();
          if (!this.selectedClassId) return;
          if (typeof this._classOnConfirm === 'function') {
            this._classOnConfirm(this.selectedClassId);
          }
        });
      }
      if (this.els.classCancel) {
        this.els.classCancel.addEventListener('click', (e) => {
          e.preventDefault();
          if (typeof this._classOnCancel === 'function') this._classOnCancel();
        });
      }
      const bindSkillHover = (slot, kind) => {
        if (!slot) return;
        slot.addEventListener('mouseenter', () => this._showClassSkillTip(kind));
        slot.addEventListener('mouseleave', () => this._hideClassSkillTip());
        slot.addEventListener('focus', () => this._showClassSkillTip(kind));
        slot.addEventListener('blur', () => this._hideClassSkillTip());
      };
      bindSkillHover(this.els.classSkillActive, 'active');
      bindSkillHover(this.els.classSkillPassive, 'passive');
      global.addEventListener('keydown', (e) => {
        if (!this.classSelectOpen || e.repeat || this.arsenalOpen) return;
        if (e.code === 'Escape' && this.els.classCancel) {
          e.preventDefault();
          this.els.classCancel.click();
        } else if (e.code === 'Enter' && this.els.classConfirm && !this.els.classConfirm.disabled) {
          e.preventDefault();
          this.els.classConfirm.click();
        } else if (e.code === 'KeyC') {
          e.preventDefault();
          this.openArsenal({ slot: 'primary' });
        }
      });
    },

    /**
     * Fixed world framing: soldier stands at origin (feet≈0, head≈2),
     * camera looks straight at mid-body so the figure is centered and fully visible.
     */
    _frameBodyCamera(cam, aspect) {
      const midY = 1.05;
      const bodyH = 2.18;
      cam.fov = 38;
      cam.aspect = aspect;
      const vFov = THREE.MathUtils.degToRad(cam.fov);
      let dist = (bodyH * 0.5) / Math.tan(vFov * 0.5);
      dist *= 1.06;
      cam.near = 0.1;
      cam.far = 40;
      cam.position.set(0, midY, dist);
      cam.up.set(0, 1, 0);
      cam.lookAt(0, midY, 0);
      cam.updateProjectionMatrix();
    },

    _getPresentationRenderer() {
      if (this._presentationRenderer) return this._presentationRenderer;
      if (!global.THREE) return null;
      this._presentationRenderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
      });
      // Canvas dimensions are already DPR-scaled before setSize.
      this._presentationRenderer.setPixelRatio(1);
      this._presentationRenderer.setClearColor(0x000000, 0);
      return this._presentationRenderer;
    },

    _startClassPreviews() {
      this._stopClassPreviews();
      if (!global.THREE || !global.VF.Soldier) return;

      const scene = new THREE.Scene();
      scene.background = null;

      const bodyCam = new THREE.PerspectiveCamera(40, 3 / 4, 0.1, 40);
      bodyCam.position.set(0, 1.05, 6);
      bodyCam.lookAt(0, 1.05, 0);

      const headCam = new THREE.PerspectiveCamera(30, 1, 0.05, 20);
      headCam.position.set(0, 1.72, 1.55);
      headCam.lookAt(0, 1.68, 0);

      const light = new THREE.DirectionalLight(0xfff0dd, 1.3);
      light.position.set(2, 6, 4);
      scene.add(light);
      scene.add(new THREE.AmbientLight(0x99aabb, 0.8));
      const fill = new THREE.DirectionalLight(0xaaccff, 0.4);
      fill.position.set(-3, 2, 2);
      scene.add(fill);

      const renderer = this._getPresentationRenderer();
      if (!renderer) return;

      const models = {};
      const classes = global.VF.Soldier.CLASSES;
      const previewTeam = this._playerTeam() === 'enemy' ? 'enemy' : 'ally';
      for (let i = 0; i < classes.length; i++) {
        const m = global.VF.Soldier.createPreviewSoldier(classes[i].id, {
          team: previewTeam,
        });
        m.visible = false;
        m.position.set(0, 0, 0);
        if (global.VF.Soldier.initLocomotion) global.VF.Soldier.initLocomotion(m);
        scene.add(m);
        models[classes[i].id] = m;
      }

      this._classPreview = {
        scene,
        bodyCam,
        headCam,
        renderer,
        models,
        raf: 0,
        t0: performance.now(),
        lastT: performance.now(),
      };

      this._bakeClassAvatars();

      const tick = () => {
        if (!this.classSelectOpen || !this._classPreview) return;
        const prev = this._classPreview;
        const id = this.selectedClassId;
        const stage = this.els.classStageCanvas;
        const now = performance.now();
        const dt = Math.min(0.05, Math.max(0.001, (now - prev.lastT) * 0.001));
        prev.lastT = now;

        if (id && stage && prev.models[id]) {
          const t = (now - prev.t0) * 0.001;
          for (const k in prev.models) prev.models[k].visible = false;
          const model = prev.models[id];
          model.visible = true;
          model.position.set(0, 0, 0);
          model.rotation.set(0, Math.PI + Math.sin(t * 0.45) * 0.16, 0);
          if (global.VF.Soldier.updateLocomotion) {
            global.VF.Soldier.updateLocomotion(model, dt, {
              moving: false,
              speedRatio: 0,
              onGround: true,
            });
          }

          const rect = stage.getBoundingClientRect();
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const w = Math.max(280, Math.floor(rect.width * dpr) || 480);
          const h = Math.max(360, Math.floor(rect.height * dpr) || 640);
          if (stage.width !== w || stage.height !== h) {
            stage.width = w;
            stage.height = h;
          }
          prev.renderer.setSize(w, h, false);
          this._frameBodyCamera(prev.bodyCam, w / Math.max(1, h));
          prev.renderer.render(prev.scene, prev.bodyCam);

          const ctx = stage.getContext('2d');
          if (ctx) {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, w, h);
            ctx.drawImage(prev.renderer.domElement, 0, 0, w, h);
          }
        }

        prev.raf = requestAnimationFrame(tick);
      };
      this._classPreview.raf = requestAnimationFrame(tick);
    },

    _bakeClassAvatars() {
      const prev = this._classPreview;
      const grid = this.els.classGrid;
      if (!prev || !grid) return;

      const size = 96;
      prev.renderer.setSize(size, size, false);
      prev.headCam.aspect = 1;
      prev.headCam.updateProjectionMatrix();

      const canvases = grid.querySelectorAll('canvas.class-avatar');
      for (let i = 0; i < canvases.length; i++) {
        const canvas = canvases[i];
        const id = canvas.dataset.classId;
        const model = prev.models[id];
        if (!model) continue;

        for (const k in prev.models) prev.models[k].visible = false;
        model.visible = true;
        model.rotation.y = Math.PI + 0.15;
        const gun = model.getObjectByName('Weapon');
        if (gun) gun.visible = false;

        prev.renderer.render(prev.scene, prev.headCam);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(prev.renderer.domElement, 0, 0, canvas.width, canvas.height);
        }
        if (gun) gun.visible = true;
        model.visible = false;
      }
      prev.avatarsReady = true;
    },

    _stopClassPreviews() {
      const prev = this._classPreview;
      if (!prev) return;
      if (prev.raf) cancelAnimationFrame(prev.raf);
      prev.raf = 0;
      for (const k in prev.models) {
        const m = prev.models[k];
        if (m && prev.scene) prev.scene.remove(m);
      }
      this._classPreview = null;
    },

    /* ---------- Pre-match squad introduction ---------- */

    openSquadIntro(roster, onComplete, opts) {
      opts = opts || {};
      if (!this.els.squadIntroOverlay) {
        if (typeof onComplete === 'function') onComplete();
        return;
      }
      this.squadIntroOpen = true;
      this._squadIntroComplete = onComplete;
      this._squadIntroBack = opts.onBack || null;
      this._squadIntroCustomize = opts.onCustomize || null;
      this._squadIntroTriggered = false;
      this._squadIntroRoster = (roster || []).slice(0, 4);
      if (this.els.squadIntroMapName) {
        this.els.squadIntroMapName.textContent = opts.mapName || '荒盆';
      }
      if (this.els.squadIntroModeName) {
        this.els.squadIntroModeName.textContent = opts.modeName || '单人游戏';
      }
      if (this.els.squadIntroFactionName) {
        this.els.squadIntroFactionName.textContent = opts.factionName || '和平军团';
      }
      this._buildSquadIntroCards();
      const playerEntry =
        this._squadIntroRoster.find((member) => member.isPlayer) ||
        this._squadIntroRoster[0];
      const classes = (global.VF.Soldier && global.VF.Soldier.CLASSES) || [];
      const classInfo =
        classes.find((item) => playerEntry && item.id === playerEntry.classId) ||
        classes[0];
      if (this.els.squadIntroCurrentClass && classInfo) {
        const name = classInfo.nameZh || classInfo.nameEn || classInfo.id;
        this.els.squadIntroCurrentClass.textContent = /兵$/.test(name)
          ? name
          : name + '兵';
      }
      if (classInfo) this._syncDeployClassDetails(classInfo);
      this.els.squadIntroOverlay.classList.remove('hidden');
      this._bindSquadIntro();
      this._startSquadIntroPreview();
      this._startSquadIntroCountdown(opts.durationSec != null ? opts.durationSec : 5);
    },

    closeSquadIntro() {
      this.squadIntroOpen = false;
      this.closeArsenal();
      if (this._squadIntroTimer) {
        clearInterval(this._squadIntroTimer);
        this._squadIntroTimer = null;
      }
      if (this.els.squadIntroOverlay) {
        this.els.squadIntroOverlay.classList.add('hidden');
      }
      const self = this;
      setTimeout(function () {
        if (!self.squadIntroOpen) self._stopSquadIntroPreview();
      }, 250);
    },

    _buildSquadIntroCards() {
      const root = this.els.squadIntroCards;
      if (!root) return;
      root.innerHTML = '';
      for (let i = 0; i < this._squadIntroRoster.length; i++) {
        const member = this._squadIntroRoster[i];
        const card = document.createElement('article');
        card.className =
          'squad-intro-card' + (member.isPlayer ? ' is-player' : '');
        const heading = document.createElement('strong');
        heading.textContent = member.name || '小队成员 ' + (i + 1);
        const detail = document.createElement('span');
        detail.textContent =
          (member.className || member.classId || '步兵') +
          ' · ' +
          (member.weapon || '制式步枪');
        card.appendChild(heading);
        card.appendChild(detail);
        root.appendChild(card);
      }
    },

    _bindSquadIntro() {
      if (this._squadIntroBound) return;
      this._squadIntroBound = true;
      if (this.els.squadIntroSkip) {
        this.els.squadIntroSkip.addEventListener('click', (e) => {
          e.preventDefault();
          this._finishSquadIntro();
        });
      }
      if (this.els.squadIntroBack) {
        this.els.squadIntroBack.addEventListener('click', (e) => {
          e.preventDefault();
          this._backFromSquadIntro();
        });
      }
      if (this.els.squadIntroCustomize) {
        this.els.squadIntroCustomize.addEventListener('click', (e) => {
          e.preventDefault();
          this._customizeFromSquadIntro();
        });
      }
      global.addEventListener('keydown', (e) => {
        if (!this.squadIntroOpen || e.repeat || this.arsenalOpen) return;
        if (e.code === 'Escape') {
          e.preventDefault();
          this._backFromSquadIntro();
        } else if (e.code === 'KeyX') {
          e.preventDefault();
          this._customizeFromSquadIntro();
        } else if (e.code === 'Enter' || e.code === 'Space') {
          e.preventDefault();
          this._finishSquadIntro();
        }
      });
    },

    _startSquadIntroCountdown(seconds) {
      if (this._squadIntroTimer) clearInterval(this._squadIntroTimer);
      this._squadIntroEndsAt = performance.now() + Math.max(0, seconds) * 1000;
      const tick = () => {
        if (!this.squadIntroOpen) {
          if (this._squadIntroTimer) clearInterval(this._squadIntroTimer);
          this._squadIntroTimer = null;
          return;
        }
        const left = Math.max(
          0,
          Math.ceil((this._squadIntroEndsAt - performance.now()) / 1000)
        );
        if (this.els.squadIntroCountdown) {
          this.els.squadIntroCountdown.textContent = String(left);
        }
        if (left <= 0) this._finishSquadIntro();
      };
      this._squadIntroTimer = setInterval(tick, 200);
      tick();
    },

    _finishSquadIntro() {
      if (!this.squadIntroOpen || this._squadIntroTriggered) return;
      this._squadIntroTriggered = true;
      const done = this._squadIntroComplete;
      this.closeSquadIntro();
      if (typeof done === 'function') done();
    },

    _backFromSquadIntro() {
      if (!this.squadIntroOpen || this._squadIntroTriggered) return;
      this._squadIntroTriggered = true;
      const back = this._squadIntroBack;
      this.closeSquadIntro();
      if (typeof back === 'function') back();
    },

    _customizeFromSquadIntro() {
      if (!this.squadIntroOpen || this._squadIntroTriggered) return;
      this._squadIntroTriggered = true;
      const customize = this._squadIntroCustomize;
      const remainingSec = Math.max(
        0.2,
        (this._squadIntroEndsAt - performance.now()) / 1000
      );
      this.closeSquadIntro();
      if (typeof customize === 'function') customize(remainingSec);
    },

    _startSquadIntroPreview() {
      this._stopSquadIntroPreview();
      if (!global.THREE || !global.VF.Soldier || !this.els.squadIntroCanvas) return;
      const scene = new THREE.Scene();
      scene.background = null;
      const camera = new THREE.PerspectiveCamera(37, 16 / 9, 0.1, 40);
      camera.position.set(0, 1.05, 7.4);
      camera.lookAt(0, 1.02, 0);
      const key = new THREE.DirectionalLight(0xfff1dd, 1.35);
      key.position.set(-2, 6, 5);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x9bdcff, 0.68);
      rim.position.set(4, 3, -2);
      scene.add(rim);
      scene.add(new THREE.AmbientLight(0xb8c5c8, 0.68));
      const renderer = this._getPresentationRenderer();
      if (!renderer) return;
      const positions = [-2.25, -0.75, 0.75, 2.25];
      const models = [];
      const previewTeam = this._playerTeam() === 'enemy' ? 'enemy' : 'ally';
      for (let i = 0; i < this._squadIntroRoster.length; i++) {
        const member = this._squadIntroRoster[i];
        const model = global.VF.Soldier.createPreviewSoldier(
          member.classId || 'assault',
          { team: previewTeam }
        );
        model.position.set(positions[i] || 0, 0, 0);
        model.rotation.y = Math.PI;
        if (global.VF.Soldier.initLocomotion) {
          global.VF.Soldier.initLocomotion(model);
        }
        scene.add(model);
        models.push(model);
      }
      this._squadIntroPreview = {
        scene: scene,
        camera: camera,
        renderer: renderer,
        models: models,
        raf: 0,
        lastT: performance.now(),
        startedAt: performance.now(),
      };
      const tick = () => {
        const preview = this._squadIntroPreview;
        if (!this.squadIntroOpen || !preview) return;
        const now = performance.now();
        const dt = Math.min(0.05, Math.max(0.001, (now - preview.lastT) / 1000));
        preview.lastT = now;
        const elapsed = (now - preview.startedAt) / 1000;
        for (let i = 0; i < preview.models.length; i++) {
          const model = preview.models[i];
          model.rotation.y = Math.PI + Math.sin(elapsed * 0.42 + i) * 0.045;
          if (global.VF.Soldier.updateLocomotion) {
            global.VF.Soldier.updateLocomotion(model, dt, {
              moving: false,
              speedRatio: 0,
              onGround: true,
            });
          }
        }
        const canvas = this.els.squadIntroCanvas;
        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(global.devicePixelRatio || 1, 1.5);
        const w = Math.max(640, Math.round(rect.width * dpr) || 1280);
        const h = Math.max(360, Math.round(rect.height * dpr) || 720);
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        preview.camera.aspect = w / Math.max(1, h);
        preview.camera.updateProjectionMatrix();
        preview.renderer.setSize(w, h, false);
        preview.renderer.render(preview.scene, preview.camera);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(preview.renderer.domElement, 0, 0, w, h);
        }
        preview.raf = requestAnimationFrame(tick);
      };
      this._squadIntroPreview.raf = requestAnimationFrame(tick);
    },

    _stopSquadIntroPreview() {
      const preview = this._squadIntroPreview;
      if (!preview) return;
      if (preview.raf) cancelAnimationFrame(preview.raf);
      for (let i = 0; i < preview.models.length; i++) {
        if (preview.models[i] && preview.scene) preview.scene.remove(preview.models[i]);
      }
      this._squadIntroPreview = null;
    },

    /* ---------- Loadout customization ---------- */

    openArsenal(opts) {
      if (global.VF.Arsenal && global.VF.Arsenal.show) {
        global.VF.Arsenal.show(opts || {});
      }
    },

    closeArsenal() {
      if (global.VF.Arsenal && global.VF.Arsenal.hide) {
        global.VF.Arsenal.hide();
      }
    },

    openLoadoutCustomize(opts) {
      opts = opts || {};
      if (!this.els.loadoutCustomizeOverlay) {
        if (typeof opts.onCancel === 'function') opts.onCancel();
        return;
      }
      this.loadoutCustomizeOpen = true;
      this._loadoutCustomizeTriggered = false;
      this._loadoutOnApply = opts.onApply || null;
      this._loadoutOnCancel = opts.onCancel || null;
      const requestedClass = opts.classId || this.selectedClassId || 'assault';
      this._loadoutDraftClassId =
        global.VF.Soldier && global.VF.Soldier.normalizeClassId
          ? global.VF.Soldier.normalizeClassId(requestedClass)
          : requestedClass;
      const weaponDefs = (global.VF && global.VF.WEAPONS) || {};
      let weaponId = opts.weaponId || global.VF.DEFAULT_PRIMARY || 'ak74';
      if (global.VF.sanitizePrimaryId) weaponId = global.VF.sanitizePrimaryId(weaponId);
      if (!weaponDefs[weaponId]) weaponId = global.VF.DEFAULT_PRIMARY || 'ak74';
      if (
        global.VF.Economy &&
        global.VF.Economy.ownsWeapon &&
        !global.VF.Economy.ownsWeapon(weaponId)
      ) {
        weaponId = global.VF.DEFAULT_PRIMARY || 'ak74';
      }
      this._loadoutDraftWeaponId = weaponId;
      if (this.els.loadoutCustomizeMapName) {
        this.els.loadoutCustomizeMapName.textContent = opts.mapName || '荒盆';
      }
      if (this.els.loadoutCustomizeModeName) {
        this.els.loadoutCustomizeModeName.textContent =
          opts.modeName || '单人游戏';
      }
      if (this.els.loadoutCustomizeFactionName) {
        this.els.loadoutCustomizeFactionName.textContent =
          opts.factionName || '和平军团';
      }
      this._buildLoadoutCustomizeClasses();
      this._buildLoadoutCustomizeWeapons();
      this._bindLoadoutCustomize();
      this._updateLoadoutCustomizeUi();
      this.els.loadoutCustomizeOverlay.classList.remove('hidden');
      this._startLoadoutCustomizePreview();
      document.exitPointerLock && document.exitPointerLock();
    },

    closeLoadoutCustomize() {
      this.loadoutCustomizeOpen = false;
      this.closeArsenal();
      if (this.els.loadoutCustomizeOverlay) {
        this.els.loadoutCustomizeOverlay.classList.add('hidden');
      }
      const self = this;
      setTimeout(function () {
        if (!self.loadoutCustomizeOpen) self._stopLoadoutCustomizePreview();
      }, 250);
    },

    _buildLoadoutCustomizeClasses() {
      const root = this.els.loadoutCustomizeClasses;
      const classes = (global.VF.Soldier && global.VF.Soldier.CLASSES) || [];
      if (!root) return;
      root.innerHTML = '';
      for (let i = 0; i < classes.length; i++) {
        const info = classes[i];
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.classId = info.id;
        button.className = 'loadout-class-option';
        const mark = document.createElement('b');
        mark.textContent = (info.nameZh || info.nameEn || info.id).charAt(0);
        const name = document.createElement('span');
        const rawName = info.nameZh || info.nameEn || info.id;
        name.textContent = /兵$/.test(rawName) ? rawName : rawName + '兵';
        button.appendChild(mark);
        button.appendChild(name);
        button.addEventListener('click', () => {
          this._loadoutDraftClassId = info.id;
          this._updateLoadoutCustomizeUi();
        });
        root.appendChild(button);
      }
    },

    _weaponIconKind(id, def) {
      if (id === 'sg' || (def && def.category === 'shotgun')) return 'shotgun';
      if (id === 'rpg') return 'rpg';
      if (def && def.category === 'pistol') return 'pistol';
      return 'rifle';
    },

    _loadoutWeaponOrder() {
      const extra = (global.VF && global.VF.WEAPON_LOADOUT_ORDER) || ['ak74'];
      const defs = (global.VF && global.VF.WEAPONS) || {};
      const order = [];
      for (let i = 0; i < extra.length; i++) {
        const id = extra[i];
        const def = defs[id];
        if (!def || def.category === 'pistol') continue;
        order.push(id);
      }
      return order;
    },

    _buildLoadoutCustomizeWeapons() {
      const root = this.els.loadoutCustomizeWeapons;
      if (!root) return;
      root.innerHTML = '';
      const defs = (global.VF && global.VF.WEAPONS) || {};
      const order = this._loadoutWeaponOrder();
      for (let i = 0; i < order.length; i++) {
        const id = order[i];
        const def = defs[id];
        if (!def) continue;
        const owned =
          !global.VF.Economy ||
          !global.VF.Economy.ownsWeapon ||
          global.VF.Economy.ownsWeapon(id);
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.weaponId = id;
        button.className = 'loadout-weapon-option' + (owned ? '' : ' locked');
        button.disabled = !owned;
        button.title = owned ? def.nameZh || def.name : '尚未解锁';
        const icon = document.createElement('span');
        icon.className = 'loadout-weapon-icon';
        icon.innerHTML = this._deployGearSvg(this._weaponIconKind(id, def));
        const copy = document.createElement('span');
        copy.className = 'loadout-weapon-copy';
        const name = document.createElement('strong');
        name.textContent = def.nameZh || def.name || id.toUpperCase();
        const detail = document.createElement('small');
        detail.textContent = owned
          ? (def.caliber || '') + ' · 弹匣 ' + def.magSize
          : '未解锁';
        copy.appendChild(name);
        copy.appendChild(detail);
        button.appendChild(icon);
        button.appendChild(copy);
        button.addEventListener('click', () => {
          if (!owned) return;
          this._loadoutDraftWeaponId = id;
          this._updateLoadoutCustomizeUi();
        });
        root.appendChild(button);
      }
    },

    _updateLoadoutCustomizeUi() {
      const classes = (global.VF.Soldier && global.VF.Soldier.CLASSES) || [];
      const info =
        classes.find((item) => item.id === this._loadoutDraftClassId) ||
        classes[0];
      if (!info) return;
      const rawName = info.nameZh || info.nameEn || info.id;
      if (this.els.loadoutCustomizeClassName) {
        this.els.loadoutCustomizeClassName.textContent = /兵$/.test(rawName)
          ? rawName
          : rawName + '兵';
      }
      if (this.els.loadoutCustomizeClassRole) {
        this.els.loadoutCustomizeClassRole.textContent = info.role || '';
      }
      if (this.els.loadoutCustomizeClassBlurb) {
        this.els.loadoutCustomizeClassBlurb.textContent = info.blurb || '';
      }
      if (this.els.loadoutCustomizeClasses) {
        this.els.loadoutCustomizeClasses
          .querySelectorAll('.loadout-class-option')
          .forEach((button) => {
            const selected = button.dataset.classId === info.id;
            button.classList.toggle('selected', selected);
            button.setAttribute('aria-pressed', selected ? 'true' : 'false');
          });
      }
      if (this.els.loadoutCustomizeWeapons) {
        this.els.loadoutCustomizeWeapons
          .querySelectorAll('.loadout-weapon-option')
          .forEach((button) => {
            const selected = button.dataset.weaponId === this._loadoutDraftWeaponId;
            button.classList.toggle('selected', selected);
            button.setAttribute('aria-pressed', selected ? 'true' : 'false');
          });
      }
      if (this.els.loadoutCustomizeWeaponStats) {
        const def =
          ((global.VF && global.VF.WEAPONS) || {})[this._loadoutDraftWeaponId];
        if (def) {
          const rate =
            def.boltSpeed != null
              ? '栓动 ' + Number(def.boltSpeed).toFixed(2) + 's'
              : '射速 ' + Math.round(def.fireRate);
          this.els.loadoutCustomizeWeaponStats.textContent =
            def.name +
            ' · 弹匣 ' +
            def.magSize +
            ' · 伤害 ' +
            def.damage +
            ' · ' +
            rate;
        } else {
          this.els.loadoutCustomizeWeaponStats.textContent = '';
        }
      }
      this._syncDeployClassDetails(info);
    },

    _bindLoadoutCustomize() {
      if (this._loadoutCustomizeBound) return;
      this._loadoutCustomizeBound = true;
      if (this.els.loadoutCustomizeApply) {
        this.els.loadoutCustomizeApply.addEventListener('click', (e) => {
          e.preventDefault();
          this._finishLoadoutCustomize(true);
        });
      }
      if (this.els.loadoutCustomizeCancel) {
        this.els.loadoutCustomizeCancel.addEventListener('click', (e) => {
          e.preventDefault();
          this._finishLoadoutCustomize(false);
        });
      }
      global.addEventListener('keydown', (e) => {
        if (!this.loadoutCustomizeOpen || e.repeat || this.arsenalOpen) return;
        if (e.code === 'Escape') {
          e.preventDefault();
          this._finishLoadoutCustomize(false);
        } else if (e.code === 'Enter') {
          if (e.target && e.target.tagName === 'BUTTON') return;
          e.preventDefault();
          this._finishLoadoutCustomize(true);
        }
      });
    },

    _finishLoadoutCustomize(apply) {
      if (!this.loadoutCustomizeOpen || this._loadoutCustomizeTriggered) return;
      this._loadoutCustomizeTriggered = true;
      const callback = apply ? this._loadoutOnApply : this._loadoutOnCancel;
      const selection = {
        classId: this._loadoutDraftClassId || 'assault',
        weaponId: this._loadoutDraftWeaponId || global.VF.DEFAULT_PRIMARY || 'ak74',
      };
      this.closeLoadoutCustomize();
      if (typeof callback === 'function') callback(selection);
    },

    _startLoadoutCustomizePreview() {
      this._stopLoadoutCustomizePreview();
      if (!global.THREE || !global.VF.Soldier || !this.els.loadoutCustomizeCanvas) return;
      const scene = new THREE.Scene();
      scene.background = null;
      const camera = new THREE.PerspectiveCamera(38, 4 / 5, 0.1, 40);
      camera.position.set(0, 1.05, 3.5);
      camera.lookAt(0, 1.05, 0);
      const key = new THREE.DirectionalLight(0xfff1dd, 1.35);
      key.position.set(-2, 6, 5);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x9bdcff, 0.64);
      rim.position.set(4, 3, -2);
      scene.add(rim);
      scene.add(new THREE.AmbientLight(0xb8c5c8, 0.7));
      const renderer = this._getPresentationRenderer();
      if (!renderer) return;
      const models = {};
      const classes = global.VF.Soldier.CLASSES || [];
      const previewTeam = this._playerTeam() === 'enemy' ? 'enemy' : 'ally';
      for (let i = 0; i < classes.length; i++) {
        const model = global.VF.Soldier.createPreviewSoldier(classes[i].id, {
          team: previewTeam,
        });
        model.visible = false;
        if (global.VF.Soldier.initLocomotion) {
          global.VF.Soldier.initLocomotion(model);
        }
        scene.add(model);
        models[classes[i].id] = model;
      }
      this._loadoutCustomizePreview = {
        scene: scene,
        camera: camera,
        renderer: renderer,
        models: models,
        raf: 0,
        lastT: performance.now(),
        startedAt: performance.now(),
      };
      const tick = () => {
        const preview = this._loadoutCustomizePreview;
        if (!this.loadoutCustomizeOpen || !preview) return;
        const now = performance.now();
        const dt = Math.min(0.05, Math.max(0.001, (now - preview.lastT) / 1000));
        preview.lastT = now;
        for (const id in preview.models) preview.models[id].visible = false;
        const model = preview.models[this._loadoutDraftClassId];
        if (model) {
          model.visible = true;
          model.position.set(0, 0, 0);
          model.rotation.y =
            Math.PI + Math.sin((now - preview.startedAt) * 0.00042) * 0.12;
          if (global.VF.Soldier.updateLocomotion) {
            global.VF.Soldier.updateLocomotion(model, dt, {
              moving: false,
              speedRatio: 0,
              onGround: true,
            });
          }
        }
        const canvas = this.els.loadoutCustomizeCanvas;
        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(global.devicePixelRatio || 1, 1.5);
        const measuredW = Math.round(rect.width * dpr);
        const measuredH = Math.round(rect.height * dpr);
        const w = measuredW > 0 ? measuredW : 720;
        const h = measuredH > 0 ? measuredH : 760;
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        preview.camera.aspect = w / Math.max(1, h);
        this._frameBodyCamera(preview.camera, preview.camera.aspect);
        preview.renderer.setSize(w, h, false);
        preview.renderer.render(preview.scene, preview.camera);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(preview.renderer.domElement, 0, 0, w, h);
        }
        preview.raf = requestAnimationFrame(tick);
      };
      this._loadoutCustomizePreview.raf = requestAnimationFrame(tick);
    },

    _stopLoadoutCustomizePreview() {
      const preview = this._loadoutCustomizePreview;
      if (!preview) return;
      if (preview.raf) cancelAnimationFrame(preview.raf);
      for (const id in preview.models) {
        if (preview.models[id] && preview.scene) preview.scene.remove(preview.models[id]);
      }
      this._loadoutCustomizePreview = null;
    },

    /** Draw spawn pads on any map canvas context (world → pixel via toMap). */
    _getSpawnChoices(world) {
      if (world && world._deployList && world._deployList.length) return world._deployList;
      return (world && world._spawnPoints && world._spawnPoints.all) || [];
    },

    _drawSpawnMarkers(ctx, world, toMap, opts) {
      opts = opts || {};
      const points = this._getSpawnChoices(world);
      if (!points.length) return;
      const selectedId = world._selectedSpawnId;
      const teamFilter = opts.teamFilter || null;
      const friendlyTeam = opts.friendlyTeam || null;
      const r = opts.radius != null ? opts.radius : 6;
      const showLabel = opts.label !== false;
      for (let i = 0; i < points.length; i++) {
        const s = points[i];
        if (opts.skipFixed && (s.fixed || s.kind === 'hq')) continue;
        if (opts.skipFlags && s.kind === 'flag') continue;
        const lockedOut = (teamFilter && s.team !== teamFilter) || s.available === false;
        const p = toMap(s.x, s.z);
        const selected = s.id === selectedId && !lockedOut;
        ctx.globalAlpha = lockedOut ? 0.28 : 1;
        if (s.kind === 'vehicle') {
          const width = selected ? 38 : 34;
          const height = selected ? 25 : 22;
          const friendly = !friendlyTeam || s.team === friendlyTeam;
          ctx.fillStyle = friendly ? 'rgba(25,112,151,0.88)' : 'rgba(151,47,42,0.88)';
          ctx.strokeStyle = selected ? '#ffffff' : friendly ? '#83d9f3' : '#ff9a8a';
          ctx.lineWidth = selected ? 2 : 1;
          ctx.fillRect(p.x - width / 2, p.y - height / 2, width, height);
          ctx.strokeRect(p.x - width / 2, p.y - height / 2, width, height);
          ctx.fillStyle = '#fff';
          ctx.font = 'bold ' + (opts.fontSize || 9) + 'px Segoe UI, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const vehicleMark =
            s.vehicleType === 'tank' ? 'TNK' : s.vehicleType === 'ifv' ? 'IFV' : 'JEP';
          ctx.fillText(vehicleMark, p.x, p.y - 2);
          ctx.font = '7px Segoe UI, sans-serif';
          ctx.fillText(
            s.available === false
              ? s.respawnRemaining > 0
                ? Math.max(0, s.respawnRemaining) + 's'
                : '满员'
              : (s.openSeats || 0) + '/' + (s.seatCount || 0),
            p.x,
            p.y + 7
          );
          if (showLabel) {
            ctx.fillStyle = '#eef8fa';
            ctx.font = (opts.fontSize || 9) + 'px Zpix, monospace';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(s.label || '载具', p.x - width / 2, p.y - height / 2 - 4);
          }
          ctx.globalAlpha = 1;
          continue;
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, selected ? r + 2 : r, 0, Math.PI * 2);
        ctx.fillStyle =
          s.kind === 'flag'
            ? '#e8c76a'
            : friendlyTeam
              ? s.team === friendlyTeam
                ? '#4aa3ff'
                : '#ff5566'
              : s.team === 'ally'
              ? '#4aa3ff'
              : '#ff5566';
        ctx.fill();
        if (selected) {
          ctx.strokeStyle = '#ffe8d4';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        if (showLabel && !lockedOut) {
          ctx.fillStyle = '#ffe8d4';
          ctx.font = (opts.fontSize || 10) + 'px Zpix, monospace';
          ctx.fillText(s.label || s.letter || '', p.x - 8, p.y - r - 4);
        }
        ctx.globalAlpha = 1;
      }
    },

    openSpawnSelect(world, onConfirm, onCancel, opts) {
      if (!this.els.spawnOverlay) return;
      opts = opts || {};
      this.spawnSelectOpen = true;
      this._spawnRedeploy = !!opts.redeploy;
      this._spawnOnConfirm = onConfirm;
      this._spawnOnCancel = onCancel;
      this._deployUnlockAt = opts.countdown > 0 ? performance.now() + opts.countdown * 1000 : 0;
      this._deployListKey = '';
      this._deployRefreshAt = 0;
      this._deployHudAt = 0;
      this._spawnHover = null;
      this._spawnMapCamera = { zoom: 1, panX: 0, panY: 0 };
      const g = global.VF && global.VF.game;
      const island = global.VF && global.VF.IslandConquestMap;
      const mapName = (world && world._mapName) || (island && island.name) || '荒盆';
      if (this.els.deployMapName) {
        this.els.deployMapName.textContent = g && g.mode === 'pvp' ? '征服' : '单人游戏';
      }
      if (this.els.deployMapMode) {
        const modeMap = this.els.deployMapMode.querySelector('span');
        const matchSize = g && g.mode === 'pvp' ? '8 vs 8' : '32 vs 32';
        if (modeMap) modeMap.textContent = mapName + ' · ' + matchSize;
      }
      if (this.els.deployServer) {
        const C = global.VF.CONQUEST || {};
        const feel = (global.VF.Feel && global.VF.Feel.conquest) || {};
        const tix = feel.tickets != null ? feel.tickets : C.TICKETS_START || 1000;
        const round = feel.roundSec != null ? feel.roundSec : C.ROUND_SEC || 2700;
        const mm = String(Math.floor(round / 60)).padStart(2, '0');
        const ss = String(Math.floor(round % 60)).padStart(2, '0');
        const deployFlags =
          world && world._conquestFlags && world._conquestFlags.length
            ? world._conquestFlags
            : (world && world._kitFlags) || [];
        const lastFlag = deployFlags.length
          ? deployFlags[deployFlags.length - 1].letter || String.fromCharCode(64 + deployFlags.length)
          : 'F';
        this.els.deployServer.textContent =
          mapName + ' · 增援 ' + tix + ' · ' + mm + ':' + ss + ' · 占领 A–' + lastFlag;
      }
      if (this._spawnRedeploy && global.VF.Conquest && global.VF.Conquest.applyDeployList) {
        global.VF.Conquest.applyDeployList(world, world._playerTeam || 'ally');
      } else if (world) {
        world._deployList = null;
        if (!(g && (g.teamLocked || g.mode === 'pvp'))) {
          world._selectedSpawnId = null;
        }
      }
      if (this.els.spawnTitle) {
        this.els.spawnTitle.textContent = this._spawnRedeploy ? '重新部署' : '选择重生点';
      }
      if (this.els.spawnLead) {
        this.els.spawnLead.textContent = this._spawnRedeploy
          ? '只能部署到主基地或已占领的旗帜 · 短倒计时后出发'
          : '在地图上点选主基地或已占领旗帜，再按部署进入';
      }
      if (this.els.spawnCancel) {
        this.els.spawnCancel.setAttribute(
          'aria-label',
          this._spawnRedeploy ? '返回阵亡界面' : '返回大厅'
        );
      }
      const teamRow = document.getElementById('team-pick-row');
      if (teamRow) teamRow.classList.add('hidden');
      document.exitPointerLock && document.exitPointerLock();
      if (document.body) document.body.classList.add('deploy-overlay-open');
      this.els.spawnOverlay.classList.remove('hidden');
      this._buildSpawnButtons(world);
      this._buildDeployClasses();
      this._syncTeamPickUi(world);
      this._syncDeployBattleState(world);
      this.drawSpawnSelectMap(world);
      this._bindSpawnSelectOnce(world);
      this._syncSpawnConfirm();
    },

    closeSpawnSelect() {
      this.spawnSelectOpen = false;
      this.closeArsenal();
      this._spawnRedeploy = false;
      this._deployUnlockAt = 0;
      this._spawnMapDrag = null;
      this._spawnMapSuppressClick = false;
      if (this.els.spawnMap) this.els.spawnMap.classList.remove('dragging');
      if (this.els.spawnOverlay) this.els.spawnOverlay.classList.add('hidden');
      if (document.body) document.body.classList.remove('deploy-overlay-open');
    },

    _syncTeamPickUi(world) {
      const team = world._playerTeam;
      const g = global.VF.game;
      const pvpLock = !!(g && g.mode === 'pvp');
      const matchLock = !!(g && g.teamLocked && g.lockedTeam);
      const lockAlly = pvpLock || (matchLock && g.lockedTeam !== 'ally');
      const lockEnemy = pvpLock || (matchLock && g.lockedTeam !== 'enemy');
      if (this.els.teamPickAlly) {
        this.els.teamPickAlly.classList.toggle('selected', team === 'ally');
        this.els.teamPickAlly.classList.toggle('locked', lockAlly);
        this.els.teamPickAlly.disabled = lockAlly;
      }
      if (this.els.teamPickEnemy) {
        this.els.teamPickEnemy.classList.toggle('selected', team === 'enemy');
        this.els.teamPickEnemy.classList.toggle('locked', lockEnemy);
        this.els.teamPickEnemy.disabled = lockEnemy;
      }
      if (this._spawnRedeploy) {
        if (this.els.spawnGroupAlly) this.els.spawnGroupAlly.classList.remove('locked');
        if (this.els.spawnGroupEnemy) this.els.spawnGroupEnemy.classList.add('hidden');
        return;
      }
      if (this.els.spawnGroupAlly) {
        this.els.spawnGroupAlly.classList.toggle('locked', team !== 'ally');
      }
      if (this.els.spawnGroupEnemy) {
        this.els.spawnGroupEnemy.classList.remove('hidden');
        this.els.spawnGroupEnemy.classList.toggle('locked', team !== 'enemy');
      }
    },

    _syncDeployBattleState(world) {
      if (!world) return;
      const C = global.VF && global.VF.Conquest;
      const constants = (global.VF && global.VF.CONQUEST) || {};
      const feel = (global.VF && global.VF.Feel && global.VF.Feel.conquest) || {};
      const max = Math.max(
        1,
        C && C.ticketsMax
          ? C.ticketsMax
          : feel.tickets != null
            ? feel.tickets
            : constants.TICKETS_START || 1000
      );
      const allyRaw = C && C.active && C.tickets ? C.tickets.ally : max;
      const enemyRaw = C && C.active && C.tickets ? C.tickets.enemy : max;
      const pTeam = world._playerTeam === 'enemy' ? 'enemy' : 'ally';
      const you = pTeam === 'enemy' ? enemyRaw : allyRaw;
      const them = pTeam === 'enemy' ? allyRaw : enemyRaw;
      if (this.els.deployTicketAlly) this.els.deployTicketAlly.textContent = String(you);
      if (this.els.deployTicketEnemy) this.els.deployTicketEnemy.textContent = String(them);
      if (this.els.deployFillAlly) {
        this.els.deployFillAlly.style.transform =
          'scaleX(' + Math.max(0, Math.min(1, you / max)) + ')';
      }
      if (this.els.deployFillEnemy) {
        this.els.deployFillEnemy.style.transform =
          'scaleX(' + Math.max(0, Math.min(1, them / max)) + ')';
      }

      let flags =
        C && C.active && C.flags && C.flags.length
          ? C.flags
          : world._conquestFlags && world._conquestFlags.length
            ? world._conquestFlags
            : world._kitFlags && world._kitFlags.length
              ? world._kitFlags
              : [];
      if (!flags.length) {
        const island = global.VF && global.VF.IslandConquestMap;
        flags = (island && island.FLAGS) || [
          { letter: 'A', owner: 'neutral' },
          { letter: 'B', owner: 'neutral' },
          { letter: 'C', owner: 'neutral' },
          { letter: 'D', owner: 'neutral' },
          { letter: 'E', owner: 'neutral' },
          { letter: 'F', owner: 'neutral' },
        ];
      }
      if (this.els.deployObjectives) {
        let html = '';
        for (let i = 0; i < flags.length; i++) {
          const flag = flags[i];
          const normalized = {
            owner: flag.owner || 'neutral',
            phase: flag.phase || '',
            contested: !!flag.contested,
          };
          html +=
            '<span class="deploy-objective ' +
            this._cqFlagKind(normalized, pTeam) +
            '" title="' +
            (flag.letter || '') +
            '"><b>' +
            (flag.letter || '') +
            '</b></span>';
        }
        if (this.els.deployObjectives._flagHtml !== html) {
          this.els.deployObjectives._flagHtml = html;
          this.els.deployObjectives.innerHTML = html;
        }
      }

      const round =
        C && C.active && C.timeLeft
          ? C.timeLeft()
          : feel.roundSec != null
            ? feel.roundSec
            : constants.ROUND_SEC || 2700;
      if (this.els.deployClock) this.els.deployClock.textContent = this.formatClock(round);
      if (this.els.deployFactionName) {
        this.els.deployFactionName.textContent = pTeam === 'enemy' ? '赤焰军团' : '和平军团';
      }
      if (this.els.deploySquadStatus) {
        const squads = global.VF && global.VF.Squads && global.VF.Squads.squads;
        const squadCount = squads && squads[pTeam] && squads[pTeam].length ? squads[pTeam].length : 8;
        this.els.deploySquadStatus.textContent = '作战中小队: ' + squadCount;
      }
    },

    _getDeployMapTargets(world) {
      const direct = this._getSpawnChoices(world);
      return direct && direct.length ? direct : this._listMapSpawnTargets(world);
    },

    _selectDeployTarget(world, target) {
      if (!world || !target || target.available === false) return;
      const g = global.VF && global.VF.game;
      const locked = !!(
        this._spawnRedeploy ||
        (g && g.teamLocked) ||
        (g && g.mode === 'pvp')
      );
      if (locked && world._playerTeam && target.team && target.team !== world._playerTeam) {
        if (this.toast) this.toast('该部署点不属于你的阵营');
        return;
      }
      if (!locked && target.team) {
        if (world.setPlayerTeam) world.setPlayerTeam(target.team);
        else world._playerTeam = target.team;
        if (g && g.player) g.player.team = target.team;
      }
      if (
        locked &&
        global.VF.Conquest &&
        global.VF.Conquest.applyDeployList
      ) {
        global.VF.Conquest.applyDeployList(
          world,
          world._playerTeam || target.team || 'ally'
        );
      }
      world.setSelectedSpawn(target.id);
      this._refreshSpawnSelection(world);
    },

    _buildSpawnButtons(world) {
      const allyRow = this.els.spawnBtnsAlly;
      const enemyRow = this.els.spawnBtnsEnemy;
      if (!allyRow || !enemyRow) return;
      allyRow.innerHTML = '';
      enemyRow.innerHTML = '';
      const allyH3 = this.els.spawnGroupAlly && this.els.spawnGroupAlly.querySelector('h3');
      const enemyH3 = this.els.spawnGroupEnemy && this.els.spawnGroupEnemy.querySelector('h3');
      const makeBtn = (s) => {
        const btn = document.createElement('button');
        const Look = global.VF && global.VF.TeamLook;
        const lookKind = Look && Look.kind ? Look.kind(s.team) : s.team === 'enemy' ? 'foe' : 'friend';
        btn.type = 'button';
        btn.className =
          'spawn-pick ' +
          s.team +
          ' ' +
          lookKind +
          (s.id === world._selectedSpawnId ? ' selected' : '') +
          (s.available === false ? ' locked' : '');
        btn.dataset.spawnId = s.id;
        btn.dataset.team = s.team;
        btn.textContent = s.label + (s.available === false && s.reason ? ' · ' + s.reason : '');
        btn.title = s.reason || s.label || '';
        btn.disabled = s.available === false;
        btn.addEventListener('click', () => {
          if (s.available === false) return;
          if (!this._spawnRedeploy && (!world._playerTeam || world._playerTeam !== s.team)) return;
          world.setSelectedSpawn(s.id);
          this._refreshSpawnSelection(world);
        });
        return btn;
      };
      if (this._spawnRedeploy) {
        if (allyH3) allyH3.textContent = '可部署点';
        if (this.els.spawnGroupEnemy) this.els.spawnGroupEnemy.classList.add('hidden');
        if (this.els.spawnGroupAlly) this.els.spawnGroupAlly.classList.remove('locked', 'hidden');
        const pts = this._getSpawnChoices(world);
        for (let i = 0; i < pts.length; i++) allyRow.appendChild(makeBtn(pts[i]));
        return;
      }
      if (!world._spawnPoints) return;
      const Look = global.VF && global.VF.TeamLook;
      if (allyH3) {
        allyH3.textContent = ((Look && Look.sideName && Look.sideName('ally')) || '蓝方') + '出生点';
      }
      if (enemyH3) {
        enemyH3.textContent = ((Look && Look.sideName && Look.sideName('enemy')) || '红方') + '出生点';
      }
      if (this.els.spawnGroupAlly) {
        const allyLook = Look && Look.kind ? Look.kind('ally') : 'friend';
        this.els.spawnGroupAlly.classList.toggle('look-friend', allyLook === 'friend');
        this.els.spawnGroupAlly.classList.toggle('look-foe', allyLook === 'foe');
      }
      if (this.els.spawnGroupEnemy) {
        const enemyLook = Look && Look.kind ? Look.kind('enemy') : 'foe';
        this.els.spawnGroupEnemy.classList.toggle('look-friend', enemyLook === 'friend');
        this.els.spawnGroupEnemy.classList.toggle('look-foe', enemyLook === 'foe');
        this.els.spawnGroupEnemy.classList.remove('hidden');
      }
      world._spawnPoints.ally.forEach((s) => allyRow.appendChild(makeBtn(s)));
      world._spawnPoints.enemy.forEach((s) => enemyRow.appendChild(makeBtn(s)));
    },

    _deployGearSvg(kind) {
      const icons = {
        rifle:
          '<svg viewBox="0 0 96 32" aria-hidden="true"><path d="M3 13h42l8-6h8l2 5h25v5H62l-8 4H35l-7 8h-9l5-9H3z"/><rect x="42" y="19" width="8" height="9" transform="skewX(-12)"/></svg>',
        pistol:
          '<svg viewBox="0 0 64 32" aria-hidden="true"><path d="M8 8h39l7 5v6H32l-3 11H18l2-13H8z"/><rect x="45" y="11" width="10" height="3"/></svg>',
        shotgun:
          '<svg viewBox="0 0 96 32" aria-hidden="true"><path d="M3 13h59l18-5 12 3v5l-29 2H39l-8 10H20l5-11H3z"/><rect x="48" y="18" width="7" height="10" transform="skewX(-10)"/></svg>',
        rpg:
          '<svg viewBox="0 0 96 32" aria-hidden="true"><path d="M3 12h15l4-6h53l5 5 13 5-13 5-5 5H22l-4-6H3z"/><path d="M40 24l7 7h10l-5-7z"/></svg>',
        grenade:
          '<svg viewBox="0 0 48 36" aria-hidden="true"><path d="M17 8h17l4 7v13l-5 6H17l-6-6V15z"/><path d="M20 3h11v6H20zM30 2h9v3h-9z"/></svg>',
        charge:
          '<svg viewBox="0 0 52 36" aria-hidden="true"><rect x="8" y="8" width="33" height="24" rx="2"/><path d="M17 8V3h17v5M18 17h13v4H18z" fill="none"/></svg>',
        turret:
          '<svg viewBox="0 0 58 36" aria-hidden="true"><path d="M13 16h31l5 6-6 6H14L8 22z"/><rect x="25" y="8" width="10" height="9"/><path d="M34 10h20v3H34zM19 28l-6 7M39 28l6 7" fill="none"/></svg>',
        repair:
          '<svg viewBox="0 0 48 36" aria-hidden="true"><path d="M12 3l8 8-4 5-8-8c-5 8 1 16 9 15l10 10 7-7-10-10c1-8-6-14-12-13z"/></svg>',
        medkit:
          '<svg viewBox="0 0 52 36" aria-hidden="true"><rect x="7" y="9" width="38" height="24" rx="2"/><path d="M21 3h10v7H21zM23 14h7v5h5v7h-5v5h-7v-5h-5v-7h5z"/></svg>',
        ammo:
          '<svg viewBox="0 0 58 36" aria-hidden="true"><rect x="5" y="10" width="48" height="23" rx="2"/><path d="M16 10V6h26v4M17 17h5v11h-5zM27 17h5v11h-5zM37 17h5v11h-5z"/></svg>',
        binoculars:
          '<svg viewBox="0 0 58 36" aria-hidden="true"><path d="M8 11h15l4 7h4l4-7h15l5 18H34l-3-6h-4l-3 6H3z"/><circle cx="14" cy="25" r="7"/><circle cx="44" cy="25" r="7"/></svg>',
        cloak:
          '<svg viewBox="0 0 48 36" aria-hidden="true"><path d="M24 3l16 7v10c0 8-7 13-16 15C15 33 8 28 8 20V10z"/><path d="M17 20l5 5 10-12" fill="none"/></svg>',
        knife:
          '<svg viewBox="0 0 68 30" aria-hidden="true"><path d="M4 19h17l4-5 36-10-8 12-27 7-5-3H4z"/><rect x="7" y="16" width="15" height="8"/></svg>',
        sledge:
          '<svg viewBox="0 0 68 32" aria-hidden="true"><path d="M8 18h22l3-8h24v16H33l-3-6H8z"/><rect x="6" y="16" width="18" height="8"/></svg>',
        frag:
          '<svg viewBox="0 0 48 36" aria-hidden="true"><path d="M17 8h17l4 7v13l-5 6H17l-6-6V15z"/><path d="M20 3h11v6H20zM30 2h9v3h-9z"/></svg>',
        flash:
          '<svg viewBox="0 0 48 36" aria-hidden="true"><path d="M17 10h14l4 6v12l-5 6H18l-6-6V16z"/><path d="M24 2l3 7h-6zM8 18h6M34 18h6M12 8l4 4M32 8l-4 4"/></svg>',
        smoke:
          '<svg viewBox="0 0 48 36" aria-hidden="true"><path d="M18 14h14l3 5v11l-4 5H19l-5-5V19z"/><path d="M16 8c4-6 14-6 18 0M12 12c5-4 16-4 22 0"/></svg>',
        optic:
          '<svg viewBox="0 0 48 32" aria-hidden="true"><rect x="6" y="12" width="22" height="8"/><circle cx="34" cy="16" r="8" fill="none"/><circle cx="34" cy="16" r="3"/></svg>',
        muzzle:
          '<svg viewBox="0 0 64 28" aria-hidden="true"><path d="M4 12h34l8-6h14v16H46l-8-6H4z"/></svg>',
      };
      return (
        icons[kind] ||
        '<svg viewBox="0 0 48 32" aria-hidden="true"><rect x="7" y="7" width="34" height="20"/></svg>'
      );
    },

    _syncDeployClassDetails(classInfo) {
      const info = classInfo || {
        id: 'assault',
        nameZh: '突击',
        role: '进攻与突破',
      };
      if (this.els.deployClassName) {
        const name = info.nameZh || info.nameEn || info.id;
        this.els.deployClassName.textContent = /兵$/.test(name) ? name : name + '兵';
      }
      if (this.els.deployClassRole) {
        this.els.deployClassRole.textContent = info.role || info.blurb || '';
      }
      const kit =
        global.VF.Arsenal && global.VF.Arsenal.getStripItems
          ? global.VF.Arsenal.getStripItems(info)
          : [
              { kind: 'rifle', name: 'AK-74', arsenalSlot: 'primary', itemId: 'ak74' },
              { kind: 'pistol', name: 'USP', arsenalSlot: 'secondary', itemId: 'usp' },
              { kind: 'medkit', name: '急救箱', arsenalSlot: 'gadget1', itemId: 'medkit' },
              { kind: 'ammo', name: '弹药箱', arsenalSlot: 'gadget2', itemId: 'ammo' },
              { kind: 'frag', name: '破片手榴弹', arsenalSlot: 'grenade', itemId: 'frag' },
              { kind: 'knife', name: '战斗刀', arsenalSlot: 'melee', itemId: 'knife' },
            ];
      const strips = [
        this.els.deployLoadoutStrip,
        this.els.classDeployLoadout,
        this.els.squadIntroLoadout,
        this.els.loadoutCustomizeEquipment,
        document.getElementById('soldier-loadout-strip'),
      ].filter(Boolean);
      for (let s = 0; s < strips.length; s++) {
        const strip = strips[s];
        strip.innerHTML = '';
        for (let i = 0; i < kit.length; i++) {
          const item = kit[i];
          const slot = document.createElement('button');
          slot.type = 'button';
          slot.className =
            'deploy-gear-slot' + (item.arsenalSlot === 'primary' ? ' primary' : '');
          slot.title = (item.slotLabel ? item.slotLabel + ' · ' : '') + item.name;
          slot.dataset.arsenalSlot = item.arsenalSlot || 'primary';
          if (item.itemId) slot.dataset.itemId = item.itemId;
          if (item.weaponId) slot.dataset.weaponId = item.weaponId;
          slot.innerHTML = this._deployGearSvg(item.kind);
          const label = document.createElement('small');
          label.textContent = item.name;
          slot.appendChild(label);
          strip.appendChild(slot);
        }
      }
    },

    _buildDeployClasses() {
      const row = this.els.deployClassRow;
      if (!row) return;
      const classes = (global.VF.Soldier && global.VF.Soldier.CLASSES) || [];
      const g = global.VF.game;
      let current =
        (g && g.playerClass) ||
        (g && g.player && g.player.classId) ||
        this.selectedClassId ||
        'assault';
      row.innerHTML = '';
      const self = this;
      for (let i = 0; i < classes.length; i++) {
        const c = classes[i];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'deploy-class' + (c.id === current ? ' selected' : '');
        btn.dataset.classId = c.id;
        btn.dataset.mark = (c.nameZh || c.nameEn || c.id).charAt(0);
        btn.title = c.label || c.nameZh || c.id;
        btn.setAttribute('aria-pressed', c.id === current ? 'true' : 'false');
        const label = document.createElement('span');
        label.textContent = c.nameZh || c.nameEn || c.id;
        btn.appendChild(label);
        btn.addEventListener('click', function () {
          const id = btn.dataset.classId;
          self.selectedClassId = id;
          if (g) {
            g.playerClass = id;
            if (g.player && g.player.applyClass) g.player.applyClass(id);
          }
          if (global.VF.Lobby && global.VF.Lobby.setPreviewClass) {
            global.VF.Lobby.setPreviewClass(id);
          }
          row.querySelectorAll('.deploy-class').forEach(function (el) {
            el.classList.toggle('selected', el.dataset.classId === id);
            el.setAttribute('aria-pressed', el.dataset.classId === id ? 'true' : 'false');
          });
          self._syncDeployClassDetails(c);
        });
        row.appendChild(btn);
      }
      let currentInfo = classes[0] || null;
      for (let i = 0; i < classes.length; i++) {
        if (classes[i].id === current) {
          currentInfo = classes[i];
          break;
        }
      }
      this._syncDeployClassDetails(currentInfo);
      if (this.els.deployRole && !this.els.deployRole._vfBound) {
        this.els.deployRole._vfBound = true;
        this.els.deployRole.addEventListener('click', function (e) {
          e.preventDefault();
          self.switchDeployFaction();
        });
      }
      this._syncDeployFactionBtn();
    },

    _syncDeployFactionBtn() {
      const btn = this.els && this.els.deployRole;
      if (!btn) return;
      const g = global.VF && global.VF.game;
      const world = g && g.world;
      const pvp = !!(g && g.mode === 'pvp');
      const team = world && world._playerTeam === 'enemy' ? 'enemy' : 'ally';
      const nextName = team === 'enemy' ? '和平军团' : '赤焰军团';
      btn.textContent = '更改阵营';
      btn.disabled = pvp;
      btn.title = pvp
        ? '对战模式阵营由房间锁定'
        : '当前' + (team === 'enemy' ? '赤焰军团' : '和平军团') + ' · 点此加入' + nextName;
    },

    switchDeployFaction() {
      if (!this.spawnSelectOpen) return false;
      const g = global.VF && global.VF.game;
      const world = g && g.world;
      if (!g || !world) return false;
      if (g.mode === 'pvp') {
        if (this.toast) this.toast('对战模式阵营已锁定');
        return false;
      }
      const from = world._playerTeam === 'enemy' ? 'enemy' : 'ally';
      const to = from === 'ally' ? 'enemy' : 'ally';
      if (g.player) g.player.team = to;
      if (g.teamLocked) g.lockedTeam = to;
      world._selectedSpawnId = null;
      if (world.setPlayerTeam) world.setPlayerTeam(to);
      else world._playerTeam = to;
      if (global.VF.Conquest && global.VF.Conquest.applyDeployList) {
        global.VF.Conquest.applyDeployList(world, to);
      }
      if (g.ai && g.ai._bindTeamViews) g.ai._bindTeamViews();
      if (g.ai && g.ai._refreshArmyHud) g.ai._refreshArmyHud();
      if (g.ai && g.ai._armiesSpawned && global.VF.Squads && global.VF.Squads.buildRosters) {
        global.VF.Squads.buildRosters(g);
      }
      this._buildSpawnButtons(world);
      this._refreshSpawnSelection(world);
      this._syncDeployFactionBtn();
      if (this.toast) {
        this.toast(
          '已加入' + (to === 'enemy' ? '赤焰军团' : '和平军团') + ' · 可在该阵营占领点部署'
        );
      }
      return true;
    },

    _refreshSpawnSelection(world) {
      const selected = world._selectedSpawnId;
      document.querySelectorAll('.spawn-pick').forEach((btn) => {
        btn.classList.toggle('selected', btn.dataset.spawnId === selected);
      });
      this._syncTeamPickUi(world);
      this._syncDeployBattleState(world);
      this.drawSpawnSelectMap(world);
      this._syncSpawnConfirm();
      this._syncDeployFactionBtn();
    },

    _syncSpawnConfirm() {
      if (!this.els.spawnConfirm) return;
      const world = global.VF && global.VF.game && global.VF.game.world;
      const counting = this._deployUnlockAt && performance.now() < this._deployUnlockAt;
      const left = counting ? Math.max(1, Math.ceil((this._deployUnlockAt - performance.now()) / 1000)) : 0;
      if (this.els.spawnConfirmLabel) {
        this.els.spawnConfirmLabel.textContent = counting ? '部署 (' + left + ')' : '部署';
      }
      this.els.spawnConfirm.disabled = !!(counting || !(world && world.getSelectedSpawn()));
    },

    tickDeployCountdown() {
      if (!this.spawnSelectOpen) return;
      const now = performance.now();
      if (this._spawnRedeploy && global.VF.Conquest && global.VF.Conquest.applyDeployList) {
        if (!this._deployRefreshAt || now - this._deployRefreshAt > 500) {
          this._deployRefreshAt = now;
          const world = global.VF.game && global.VF.game.world;
          if (world) {
            const list = global.VF.Conquest.applyDeployList(world, world._playerTeam || 'ally');
            const key =
              (list || [])
                .map(function (s) {
                  return (
                    s.id +
                    ':' +
                    (s.available === false ? '0' : '1') +
                    ':' +
                    (s.reason || '') +
                    ':' +
                    (s.label || '')
                  );
                })
                .join(',') +
              '|' +
              (world._selectedSpawnId || '');
            if (key !== this._deployListKey) {
              this._deployListKey = key;
              this._buildSpawnButtons(world);
              this.drawSpawnSelectMap(world);
              this._syncSpawnConfirm();
            }
          }
        }
      }
      if (!this._deployHudAt || now - this._deployHudAt > 500) {
        this._deployHudAt = now;
        const world = global.VF.game && global.VF.game.world;
        if (world) {
          this._syncDeployBattleState(world);
          this.drawSpawnSelectMap(world);
        }
      }
      this._syncSpawnConfirm();
    },

    _resetSpawnMapCamera(world) {
      this._spawnMapCamera = { zoom: 1, panX: 0, panY: 0 };
      if (this.els.deployMapZoom) this.els.deployMapZoom.textContent = '100%';
      if (world) this.drawSpawnSelectMap(world);
    },

    _setSpawnMapZoom(nextZoom, anchor) {
      const world = global.VF && global.VF.game && global.VF.game.world;
      const canvas = this.els.spawnMap;
      if (!world || !canvas) return;
      const camera = this._spawnMapCamera || { zoom: 1, panX: 0, panY: 0 };
      const clamped = Math.max(0.72, Math.min(3.2, nextZoom));
      if (Math.abs(clamped - camera.zoom) < 0.001) return;
      const point = anchor || { x: canvas.width / 2, y: canvas.height / 2 };
      const beforeView = this._spawnMapView(canvas, world);
      const before = beforeView.fromMap(point.x, point.y);
      camera.zoom = clamped;
      this._spawnMapCamera = camera;
      const afterView = this._spawnMapView(canvas, world);
      const after = afterView.toMap(before.x, before.z);
      camera.panX += point.x - after.x;
      camera.panY += point.y - after.y;
      if (this.els.deployMapZoom) {
        this.els.deployMapZoom.textContent = Math.round(camera.zoom * 100) + '%';
      }
      this.drawSpawnSelectMap(world);
    },

    _bindSpawnSelectOnce(world) {
      if (this._spawnSelectBound) return;
      this._spawnSelectBound = true;

      const pickTeam = (team) => {
        const w = global.VF.game && global.VF.game.world;
        if (!w) return;
        const g = global.VF.game;
        // 1v1 PVP: faction locked by lobby role
        if (g && g.mode === 'pvp') {
          if (global.VF.UI && global.VF.UI.toast) {
            global.VF.UI.toast('对战模式阵营已锁定');
          }
          return;
        }
        // After first confirm this match: cannot switch sides (incl. redeploy)
        if (g && g.teamLocked && g.lockedTeam && team !== g.lockedTeam) {
          if (global.VF.UI && global.VF.UI.toast) {
            global.VF.UI.toast('本局阵营已锁定');
          }
          return;
        }
        w.setPlayerTeam(team);
        this._refreshSpawnSelection(w);
      };
      if (this.els.teamPickAlly) {
        this.els.teamPickAlly.addEventListener('click', (e) => {
          e.stopPropagation();
          pickTeam('ally');
        });
      }
      if (this.els.teamPickEnemy) {
        this.els.teamPickEnemy.addEventListener('click', (e) => {
          e.stopPropagation();
          pickTeam('enemy');
        });
      }

      if (this.els.deployZoomIn) {
        this.els.deployZoomIn.addEventListener('click', (e) => {
          e.stopPropagation();
          const camera = this._spawnMapCamera || { zoom: 1 };
          this._setSpawnMapZoom(camera.zoom * 1.22);
        });
      }
      if (this.els.deployZoomOut) {
        this.els.deployZoomOut.addEventListener('click', (e) => {
          e.stopPropagation();
          const camera = this._spawnMapCamera || { zoom: 1 };
          this._setSpawnMapZoom(camera.zoom / 1.22);
        });
      }
      if (this.els.deployMapReset) {
        this.els.deployMapReset.addEventListener('click', (e) => {
          e.stopPropagation();
          const w = global.VF.game && global.VF.game.world;
          this._resetSpawnMapCamera(w);
        });
      }
      const canvas = this.els.spawnMap;
      if (canvas) {
        canvas.addEventListener(
          'wheel',
          (e) => {
            if (!this.spawnSelectOpen) return;
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const anchor = {
              x: ((e.clientX - rect.left) / rect.width) * canvas.width,
              y: ((e.clientY - rect.top) / rect.height) * canvas.height,
            };
            const camera = this._spawnMapCamera || { zoom: 1 };
            this._setSpawnMapZoom(
              e.deltaY < 0 ? camera.zoom * 1.16 : camera.zoom / 1.16,
              anchor
            );
          },
          { passive: false }
        );
        canvas.addEventListener('pointerdown', (e) => {
          if (!this.spawnSelectOpen || e.button !== 0) return;
          const camera = this._spawnMapCamera || { zoom: 1, panX: 0, panY: 0 };
          this._spawnMapDrag = {
            pointerId: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            panX: camera.panX,
            panY: camera.panY,
            moved: false,
          };
          canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
        });
        canvas.addEventListener('pointermove', (e) => {
          const drag = this._spawnMapDrag;
          if (!drag || drag.pointerId !== e.pointerId || !this.spawnSelectOpen) return;
          const rect = canvas.getBoundingClientRect();
          const dx = ((e.clientX - drag.x) / rect.width) * canvas.width;
          const dy = ((e.clientY - drag.y) / rect.height) * canvas.height;
          if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
          const camera = this._spawnMapCamera || { zoom: 1, panX: 0, panY: 0 };
          camera.panX = drag.panX + dx;
          camera.panY = drag.panY + dy;
          this._spawnMapCamera = camera;
          canvas.classList.toggle('dragging', drag.moved);
          const w = global.VF.game && global.VF.game.world;
          if (w) this.drawSpawnSelectMap(w);
        });
        const endMapDrag = (e) => {
          const drag = this._spawnMapDrag;
          if (!drag || drag.pointerId !== e.pointerId) return;
          if (drag.moved) {
            this._spawnMapSuppressClick = true;
            global.setTimeout(() => {
              this._spawnMapSuppressClick = false;
            }, 0);
          }
          canvas.classList.remove('dragging');
          if (
            canvas.releasePointerCapture &&
            (!canvas.hasPointerCapture || canvas.hasPointerCapture(e.pointerId))
          ) {
            canvas.releasePointerCapture(e.pointerId);
          }
          this._spawnMapDrag = null;
        };
        canvas.addEventListener('pointerup', endMapDrag);
        canvas.addEventListener('pointercancel', endMapDrag);
        canvas.addEventListener('click', (e) => {
          if (!this.spawnSelectOpen) return;
          if (this._spawnMapSuppressClick) return;
          const w = global.VF.game && global.VF.game.world;
          if (!w) return;
          const rect = canvas.getBoundingClientRect();
          const mx = ((e.clientX - rect.left) / rect.width) * canvas.width;
          const my = ((e.clientY - rect.top) / rect.height) * canvas.height;
          const view = this._spawnMapView(canvas, w);
          const wz = view.fromMap(mx, my);
          const hit = this._nearestSpawnTarget(w, wz.x, wz.z, 24 / view.scale);
          if (!hit) return;
          this._selectDeployTarget(w, hit);
        });
        canvas.addEventListener('mousemove', (e) => {
          if (!this.spawnSelectOpen) return;
          if (this._spawnMapDrag) return;
          const w = global.VF.game && global.VF.game.world;
          if (!w) return;
          const rect = canvas.getBoundingClientRect();
          const mx = ((e.clientX - rect.left) / rect.width) * canvas.width;
          const my = ((e.clientY - rect.top) / rect.height) * canvas.height;
          const view = this._spawnMapView(canvas, w);
          const wz = view.fromMap(mx, my);
          const hit = this._nearestSpawnTarget(w, wz.x, wz.z, 21 / view.scale);
          const label = hit
            ? (hit.label || hit.letter || '') + (hit.available === false && hit.reason ? ' · ' + hit.reason : '')
            : '';
          if (label !== this._spawnHover) {
            this._spawnHover = label;
            if (this.els.deployHover) {
              this.els.deployHover.textContent = label;
              this.els.deployHover.classList.toggle('hidden', !label);
            }
          }
        });
        canvas.addEventListener('mouseleave', () => {
          if (this._spawnMapDrag) return;
          this._spawnHover = null;
          if (this.els.deployHover) this.els.deployHover.classList.add('hidden');
        });
      }
      global.addEventListener('resize', () => {
        if (!this.spawnSelectOpen) return;
        const w = global.VF.game && global.VF.game.world;
        if (w) this.drawSpawnSelectMap(w);
      });
      global.addEventListener('keydown', (e) => {
        if (!this.spawnSelectOpen || e.repeat || this.arsenalOpen) return;
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.code === 'Escape' && this.els.spawnCancel) {
          e.preventDefault();
          this.els.spawnCancel.click();
        } else if (e.code === 'KeyR') {
          e.preventDefault();
          const w = global.VF.game && global.VF.game.world;
          this._resetSpawnMapCamera(w);
        } else if (e.code === 'Equal' || e.code === 'NumpadAdd') {
          e.preventDefault();
          const camera = this._spawnMapCamera || { zoom: 1 };
          this._setSpawnMapZoom(camera.zoom * 1.22);
        } else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
          e.preventDefault();
          const camera = this._spawnMapCamera || { zoom: 1 };
          this._setSpawnMapZoom(camera.zoom / 1.22);
        }
      });
      if (this.els.spawnConfirm) {
        this.els.spawnConfirm.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this._deployUnlockAt && performance.now() < this._deployUnlockAt) return;
          const w = global.VF.game && global.VF.game.world;
          if (this._spawnRedeploy && w && global.VF.Conquest && global.VF.Conquest.applyDeployList) {
            global.VF.Conquest.applyDeployList(w, w._playerTeam || 'ally');
            if (!w.getSelectedSpawn()) return;
          }
          if (typeof this._spawnOnConfirm === 'function') this._spawnOnConfirm();
        });
      }
      if (this.els.spawnCancel) {
        this.els.spawnCancel.addEventListener('click', (e) => {
          e.stopPropagation();
          if (typeof this._spawnOnCancel === 'function') this._spawnOnCancel();
        });
      }
    },

    _spawnMapView(canvas, world) {
      const w = canvas.width;
      const h = canvas.height;
      const size = world.worldSize;
      // The battlefield runs north/south in world space; rotate it so both HQs
      // read left/right like the tactical deployment reference.
      const x0 = size * 0.14;
      const z0 = size * 0.025;
      const x1 = size * 0.86;
      const z1 = size * 0.975;
      const bw = z1 - z0;
      const bh = x1 - x0;
      const camera = this._spawnMapCamera || { zoom: 1, panX: 0, panY: 0 };
      const zoom = Math.max(0.72, Math.min(3.2, camera.zoom || 1));
      const scale = Math.min(w / bw, h / bh) * zoom;
      const centerX = (x0 + x1) / 2;
      const centerZ = (z0 + z1) / 2;
      const ox = w / 2 - centerZ * scale + (camera.panX || 0);
      const oy = h / 2 + centerX * scale + (camera.panY || 0);
      return {
        ox: ox,
        oy: oy,
        scale: scale,
        zoom: zoom,
        toMap: function (wx, wz) {
          return { x: ox + wz * scale, y: oy - wx * scale };
        },
        fromMap: function (mx, my) {
          return { x: (oy - my) / scale, z: (mx - ox) / scale };
        },
      };
    },

    _drawValleyOutline(ctx, world, toMap, size) {
      const layout = global.VF && global.VF.IslandConquestMap;
      if (!layout || !layout.isLand || world._mapLayout !== 'ridge') return;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.82)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      let started = false;
      const step = 3;
      for (let x = 4; x < size - 4; x += step) {
        let zMin = -1;
        let zMax = -1;
        for (let z = 4; z < size - 4; z += 2) {
          if (!layout.isLand(x, z, size)) continue;
          if (zMin < 0) zMin = z;
          zMax = z;
        }
        if (zMin < 0) continue;
        const a = toMap(x, zMin);
        if (!started) {
          ctx.moveTo(a.x, a.y);
          started = true;
        } else {
          ctx.lineTo(a.x, a.y);
        }
      }
      for (let x = size - 4; x > 4; x -= step) {
        let zMax = -1;
        for (let z = size - 4; z > 4; z -= 2) {
          if (!layout.isLand(x, z, size)) continue;
          zMax = z;
          break;
        }
        if (zMax < 0) continue;
        const a = toMap(x, zMax);
        ctx.lineTo(a.x, a.y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    },

    _listMapSpawnTargets(world) {
      const g = global.VF && global.VF.game;
      const locked = !!(
        this._spawnRedeploy ||
        (g && g.teamLocked) ||
        (g && g.mode === 'pvp')
      );
      if (locked) return this._getSpawnChoices(world);
      const out = [];
      const spots = world._spawnPoints;
      if (spots) {
        const sides = ['ally', 'enemy'];
        for (let t = 0; t < sides.length; t++) {
          const list = spots[sides[t]] || [];
          let hq = null;
          for (let i = 0; i < list.length; i++) {
            if (list[i].fixed) {
              hq = list[i];
              break;
            }
          }
          if (!hq) hq = list[0];
          if (hq) {
            out.push({
              id: hq.id,
              team: sides[t],
              x: hq.x,
              y: hq.y,
              z: hq.z,
              kind: 'hq',
              fixed: true,
              label:
                (global.VF.TeamLook && global.VF.TeamLook.sideName(sides[t]))
                  ? global.VF.TeamLook.sideName(sides[t]) + '基地'
                  : sides[t] === 'ally'
                    ? '蓝方基地'
                    : '红方基地',
            });
          }
        }
      }
      const flags = (world._conquestFlags && world._conquestFlags.length
        ? world._conquestFlags
        : world._kitFlags) || [];
      for (let i = 0; i < flags.length; i++) {
        const f = flags[i];
        if (f.owner !== 'ally' && f.owner !== 'enemy') continue;
        if (f.contested) continue;
        if (typeof f.capture === 'number' && Math.abs(f.capture) < 0.999) continue;
        out.push({
          id: 'flag-' + f.letter,
          team: f.owner,
          x: f.x,
          y: f.y,
          z: f.z,
          kind: 'flag',
          letter: f.letter,
          label: f.letter + '点',
        });
      }
      return out;
    },

    _nearestSpawnTarget(world, wx, wz, maxDist) {
      const pts = this._getDeployMapTargets(world);
      let best = null;
      let bestD = (maxDist || 36) * (maxDist || 36);
      for (let i = 0; i < pts.length; i++) {
        const s = pts[i];
        if (s.available === false) continue;
        const dx = s.x - wx;
        const dz = s.z - wz;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      return best;
    },

    _ensureSchematicCache(world) {
      if (this._schematicCache && this._schematicSize === world.worldSize && this._schematicSeed === world.mapSeed) {
        return this._schematicCache;
      }
      const size = world.worldSize;
      const out = 512;
      const canvas = document.createElement('canvas');
      canvas.width = out;
      canvas.height = out;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(out, out);
      const data = img.data;
      const step = size / out;
      const WATER = global.VF.BLOCK.WATER;
      const CONCRETE = global.VF.BLOCK.CONCRETE;
      const METAL = global.VF.BLOCK.METAL;
      const PLASTER = global.VF.BLOCK.PLASTER;
      const BRICK = global.VF.BLOCK.BRICK;
      const STONE = global.VF.BLOCK.STONE;
      const GRASS = global.VF.BLOCK.GRASS;
      const DIRT = global.VF.BLOCK.DIRT;
      const ROAD = global.VF.BLOCK.ROAD;
      const ASPHALT = global.VF.BLOCK.ASPHALT;
      const RUBBLE = global.VF.BLOCK.RUBBLE;
      for (let py = 0; py < out; py++) {
        const wz = Math.min(size - 1, Math.floor(py * step));
        for (let px = 0; px < out; px++) {
          const wx = Math.min(size - 1, Math.floor(px * step));
          let gy = world.groundY ? world.groundY[wz * size + wx] : 4;
          if (gy < 1) gy = 4;
          const t = world.get(wx, gy, wz);
          let r = 0;
          let g = 0;
          let b = 0;
          const layout = global.VF && global.VF.IslandConquestMap;
          if (layout && layout.isWater && layout.isWater(wx, wz, size)) {
            r = 142;
            g = 214;
            b = 236;
          } else if (t === WATER) {
            r = 10;
            g = 10;
            b = 12;
          } else if (t === ROAD || t === ASPHALT) {
            r = 52;
            g = 48;
            b = 42;
          } else if (t === GRASS) {
            r = 58 + Math.min(40, gy);
            g = 96 + Math.min(50, gy * 2);
            b = 44;
          } else if (t === DIRT) {
            r = 92;
            g = 78;
            b = 48;
          } else if (t === RUBBLE) {
            r = 110;
            g = 108;
            b = 102;
          } else if (global.VF.PropPalette && global.VF.PropPalette.isPropId(t)) {
            // Exact-colour prop voxels have no BLOCK name — read their hex.
            const h = global.VF.BLOCK_COLORS[t] || 0x9a968e;
            r = (h >> 16) & 255;
            g = (h >> 8) & 255;
            b = h & 255;
          } else {
            const k = Math.max(0, Math.min(1, (gy - 10) / 36));
            r = 86 + (k * 92) | 0;
            g = 88 + (k * 90) | 0;
            b = 92 + (k * 86) | 0;
          }
          for (let dy = 2; dy <= 10; dy++) {
            const up = world.get(wx, gy + dy, wz);
            const isProp = global.VF.PropPalette && global.VF.PropPalette.isPropId(up);
            if (up === CONCRETE || up === METAL || up === PLASTER || up === BRICK || up === STONE || isProp) {
              if (dy <= 6 && (up === CONCRETE || up === METAL || up === PLASTER || up === BRICK || isProp)) {
                r = 198;
                g = 196;
                b = 190;
              }
              break;
            }
          }
          const i = (py * out + px) * 4;
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
          data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      this._schematicCache = canvas;
      this._schematicSize = size;
      this._schematicSeed = world.mapSeed;
      return canvas;
    },

    _drawHqZone(ctx, p, team, sx, colorTeam) {
      const hw = 22 * sx;
      const hh = 26 * sx;
      const taper = 10 * sx;
      ctx.beginPath();
      if (team === 'ally') {
        ctx.moveTo(p.x - hw, p.y - hh);
        ctx.lineTo(p.x + hw * 0.2, p.y - hh + taper * 0.2);
        ctx.lineTo(p.x + hw * 0.55, p.y);
        ctx.lineTo(p.x + hw * 0.2, p.y + hh - taper * 0.2);
        ctx.lineTo(p.x - hw, p.y + hh);
      } else {
        ctx.moveTo(p.x + hw, p.y - hh);
        ctx.lineTo(p.x - hw * 0.2, p.y - hh + taper * 0.2);
        ctx.lineTo(p.x - hw * 0.55, p.y);
        ctx.lineTo(p.x - hw * 0.2, p.y + hh - taper * 0.2);
        ctx.lineTo(p.x + hw, p.y + hh);
      }
      ctx.closePath();
      ctx.fillStyle =
        (colorTeam || team) === 'ally'
          ? 'rgba(40,110,210,0.38)'
          : 'rgba(200,48,40,0.38)';
      ctx.fill();
    },

    _drawFlagIcon(ctx, p, flag, selected) {
      const g = global.VF && global.VF.game;
      const pTeam = (g && g.world && g.world._playerTeam) || 'ally';
      const kind = this._cqFlagKind(flag, pTeam);
      const col =
        kind === 'contest'
          ? '#ffe08a'
          : kind === 'friend'
            ? '#3b82e8'
            : kind === 'foe'
              ? '#e24b3c'
              : '#d8d8d8';
      const s = selected ? 10 : 8;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.fillStyle = kind === 'neutral' ? 'rgba(8,10,14,0.72)' : col;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      if (kind === 'foe') {
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-s, -s, s * 2, s * 2);
        ctx.strokeRect(-s, -s, s * 2, s * 2);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, s, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
      if (flag.contested || (Math.abs(flag.capture || 0) > 0.05 && flag.owner === 'neutral')) {
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, s + 6, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px Segoe UI, Microsoft YaHei, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(flag.letter || '', p.x, p.y + 0.5);
    },

    _resizeSpawnMapCanvas(canvas) {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const nextW = Math.max(480, Math.round(rect.width));
      const nextH = Math.max(280, Math.round(rect.height));
      if (canvas.width === nextW && canvas.height === nextH) return;
      const oldW = canvas.width || nextW;
      const oldH = canvas.height || nextH;
      const camera = this._spawnMapCamera;
      if (camera) {
        camera.panX *= nextW / oldW;
        camera.panY *= nextH / oldH;
      }
      canvas.width = nextW;
      canvas.height = nextH;
    },

    _drawDeployTerritory(ctx, world, flags, toMap, scale) {
      if (!flags || !flags.length) return;
      const pTeam = world._playerTeam === 'enemy' ? 'enemy' : 'ally';
      const radius = Math.max(42, world.worldSize * 0.12 * scale);
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < flags.length; i++) {
        const flag = flags[i];
        if (flag.owner !== 'ally' && flag.owner !== 'enemy') continue;
        const point = toMap(flag.x, flag.z);
        const friendly = flag.owner === pTeam;
        const gradient = ctx.createRadialGradient(
          point.x,
          point.y,
          0,
          point.x,
          point.y,
          radius
        );
        gradient.addColorStop(0, friendly ? 'rgba(48,158,205,0.24)' : 'rgba(211,66,57,0.22)');
        gradient.addColorStop(0.55, friendly ? 'rgba(33,116,157,0.11)' : 'rgba(161,45,42,0.1)');
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(point.x - radius, point.y - radius, radius * 2, radius * 2);
      }
      ctx.restore();
    },

    _drawDeployGrid(ctx, world, view) {
      const size = world.worldSize;
      const steps = 10;
      ctx.save();
      ctx.strokeStyle = 'rgba(175,208,218,0.105)';
      ctx.fillStyle = 'rgba(199,222,229,0.22)';
      ctx.lineWidth = 1;
      ctx.font = '8px Segoe UI, Microsoft YaHei, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (let i = 0; i <= steps; i++) {
        const value = (size / steps) * i;
        const x0 = view.toMap(value, 0);
        const x1 = view.toMap(value, size);
        ctx.beginPath();
        ctx.moveTo(x0.x, x0.y);
        ctx.lineTo(x1.x, x1.y);
        ctx.stroke();
        const y0 = view.toMap(0, value);
        const y1 = view.toMap(size, value);
        ctx.beginPath();
        ctx.moveTo(y0.x, y0.y);
        ctx.lineTo(y1.x, y1.y);
        ctx.stroke();
        if (i < steps && x0.x >= 0 && x0.x < ctx.canvas.width - 18) {
          ctx.fillText(String(i + 1).padStart(2, '0'), x0.x + 3, Math.max(3, x0.y + 3));
        }
      }
      ctx.restore();
    },

    _drawDeployRoutes(ctx, world, flags, toMap) {
      const nodes = [];
      if (world._allyBasePos) nodes.push(world._allyBasePos);
      for (let i = 0; i < flags.length; i++) nodes.push(flags[i]);
      if (world._enemyBasePos) nodes.push(world._enemyBasePos);
      if (nodes.length < 2) return;
      ctx.save();
      ctx.strokeStyle = 'rgba(218,232,236,0.13)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      for (let i = 0; i < nodes.length; i++) {
        let best = -1;
        let bestDist = Infinity;
        for (let j = 0; j < nodes.length; j++) {
          if (i === j) continue;
          const dx = nodes[i].x - nodes[j].x;
          const dz = nodes[i].z - nodes[j].z;
          const dist = dx * dx + dz * dz;
          if (dist < bestDist) {
            bestDist = dist;
            best = j;
          }
        }
        if (best < 0 || best < i) continue;
        const a = toMap(nodes[i].x, nodes[i].z);
        const b = toMap(nodes[best].x, nodes[best].z);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
    },

    drawSpawnSelectMap(world) {
      const canvas = this.els.spawnMap;
      const ctx = this.spawnMapCtx;
      if (!canvas || !ctx || !world) return;
      this._resizeSpawnMapCanvas(canvas);
      const w = canvas.width;
      const h = canvas.height;
      const view = this._spawnMapView(canvas, world);
      const toMap = view.toMap;
      const selected = !!world._selectedSpawnId;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#071117';
      ctx.fillRect(0, 0, w, h);

      const schematic = this._ensureSchematicCache(world);
      const size = world.worldSize;
      ctx.imageSmoothingEnabled = true;
      ctx.save();
      ctx.setTransform(0, -view.scale, view.scale, 0, view.ox, view.oy);
      ctx.drawImage(schematic, 0, 0, 512, 512, 0, 0, size, size);
      ctx.restore();
      ctx.fillStyle = 'rgba(5,16,22,0.5)';
      ctx.fillRect(0, 0, w, h);

      const flags =
        world._conquestFlags && world._conquestFlags.length
          ? world._conquestFlags
          : world._kitFlags || [];
      this._drawDeployTerritory(ctx, world, flags, toMap, view.scale);
      this._drawDeployGrid(ctx, world, view);
      this._drawDeployRoutes(ctx, world, flags, toMap);
      this._drawValleyOutline(ctx, world, toMap, size);

      if (selected) {
        ctx.save();
        ctx.strokeStyle = 'rgba(207,231,238,0.2)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 8]);
        ctx.strokeRect(5.5, 5.5, w - 11, h - 11);
        ctx.restore();
      }

      if (world._allyBasePos) {
        this._drawHqZone(
          ctx,
          toMap(world._allyBasePos.x, world._allyBasePos.z),
          'ally',
          view.scale,
          world._playerTeam === 'enemy' ? 'enemy' : 'ally'
        );
      }
      if (world._enemyBasePos) {
        this._drawHqZone(
          ctx,
          toMap(world._enemyBasePos.x, world._enemyBasePos.z),
          'enemy',
          view.scale,
          world._playerTeam === 'enemy' ? 'ally' : 'enemy'
        );
      }

      const drawHqBadge = function (pos, team) {
        if (!pos) return;
        const p = toMap(pos.x, pos.z);
        const friendly = team === (world._playerTeam === 'enemy' ? 'enemy' : 'ally');
        ctx.fillStyle = friendly ? '#3b82e8' : '#e24b3c';
        ctx.fillRect(p.x - 10, p.y - 10, 20, 20);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 11px Segoe UI, Microsoft YaHei, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(friendly ? '蓝' : '红', p.x, p.y + 0.5);
        if (world._selectedSpawnId && String(world._selectedSpawnId).indexOf(team) === 0) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.strokeRect(p.x - 12, p.y - 12, 24, 24);
        }
      };
      drawHqBadge(world._allyBasePos, 'ally');
      drawHqBadge(world._enemyBasePos, 'enemy');

      for (let i = 0; i < flags.length; i++) {
        const f = flags[i];
        const p = toMap(f.x, f.z);
        const isSel = world._selectedSpawnId === 'flag-' + f.letter;
        this._drawFlagIcon(ctx, p, f, isSel);
        if (isSel) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(p.x - 14, p.y);
          ctx.lineTo(p.x + 14, p.y);
          ctx.moveTo(p.x, p.y - 14);
          ctx.lineTo(p.x, p.y + 14);
          ctx.stroke();
        }
      }
      this._drawSpawnMarkers(ctx, world, toMap, {
        radius: 5,
        fontSize: 9,
        skipFixed: true,
        skipFlags: true,
        friendlyTeam: world._playerTeam === 'enemy' ? 'enemy' : 'ally',
      });

      const g = global.VF.game;
      const ai = g && g.ai;
      if (ai) {
        const lists = [ai.blue || [], ai.red || []];
        for (let L = 0; L < lists.length; L++) {
          for (let i = 0; i < lists[L].length; i++) {
            const u = lists[L][i];
            if (!u || !u.alive || !u.mesh) continue;
            const p = toMap(u.mesh.position.x, u.mesh.position.z);
            const pTeam = world._playerTeam === 'enemy' ? 'enemy' : 'ally';
            ctx.fillStyle = u.team === pTeam ? '#4aa3ff' : '#ff5566';
            ctx.beginPath();
            ctx.moveTo(p.x, p.y - 4);
            ctx.lineTo(p.x + 3, p.y + 3);
            ctx.lineTo(p.x - 3, p.y + 3);
            ctx.closePath();
            ctx.fill();
          }
        }
      }

      if (world.getSelectedSpawn && world.getSelectedSpawn()) {
        const s = world.getSelectedSpawn();
        const p = toMap(s.x, s.z);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
        ctx.stroke();
        ctx.font = '14px Segoe UI, Microsoft YaHei, sans-serif';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';
        ctx.fillText(s.label || s.letter || '', p.x + 18, p.y - 8);
      }
      if (this.els.deployMapZoom) {
        const camera = this._spawnMapCamera || { zoom: 1 };
        this.els.deployMapZoom.textContent = Math.round((camera.zoom || 1) * 100) + '%';
      }
    },

    /** Build a downsampled full-world terrain cache (once) */
    _ensureWorldMapCache(world) {
    if (this._worldMapCache && this._worldMapCacheSize === world.worldSize && this._worldMapCacheName === (world._mapName || '')) {
      return this._worldMapCache;
    }
      const size = world.worldSize;
      const out = 512;
      const canvas = document.createElement('canvas');
      canvas.width = out;
      canvas.height = out;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(out, out);
      const data = img.data;
      const AIR = global.VF.BLOCK.AIR;
      const WATER = global.VF.BLOCK.WATER;
      const step = size / out;

      const colorOf = (t) => {
        // Minimap / UI still use muted block blue
        if (t === WATER) return [26, 74, 106];
        if (t === global.VF.BLOCK.ROAD || t === global.VF.BLOCK.ASPHALT) return [34, 37, 42];
        if (t === global.VF.BLOCK.METAL) return [106, 156, 204];
        if (t === global.VF.BLOCK.BEDROCK) return [26, 28, 34];
        if (t === global.VF.BLOCK.BRICK) return [138, 58, 42];
        if (t === global.VF.BLOCK.PLASTER) return [200, 192, 176];
        if (t === global.VF.BLOCK.ROOF) return [90, 64, 48];
        if (t === global.VF.BLOCK.GRASS) return [61, 107, 46];
        if (t === global.VF.BLOCK.CONCRETE || t === global.VF.BLOCK.STONE) return [74, 78, 84];
        if (t === global.VF.BLOCK.RUST) return [106, 58, 32];
        // Exact-colour prop voxels have no BLOCK name — read their registered hex.
        const PP = global.VF.PropPalette;
        if (PP && PP.isPropId(t)) {
          const h = global.VF.BLOCK_COLORS[t] || 0x9a968e;
          return [(h >> 16) & 255, (h >> 8) & 255, h & 255];
        }
        return [58, 74, 48];
      };

      for (let py = 0; py < out; py++) {
        const wz = Math.min(size - 1, Math.floor(py * step));
        for (let px = 0; px < out; px++) {
          const wx = Math.min(size - 1, Math.floor(px * step));
          let gy = world.groundY ? world.groundY[wz * size + wx] : 4;
          if (gy < 1) gy = 4;
          let t = world.get(wx, gy, wz);
          if (t === AIR) t = world.get(wx, Math.max(0, gy - 1), wz);
          // Prefer taller structures for readability
          for (let dy = 1; dy <= 8; dy++) {
            const up = world.get(wx, gy + dy, wz);
            const PPu = global.VF.PropPalette;
            if (
              up === global.VF.BLOCK.BRICK ||
              up === global.VF.BLOCK.CONCRETE ||
              up === global.VF.BLOCK.METAL ||
              up === global.VF.BLOCK.PLASTER ||
              up === global.VF.BLOCK.ROOF ||
              (PPu && PPu.isPropId(up))
            ) {
              t = up;
              break;
            }
          }
          const layout = global.VF && global.VF.IslandConquestMap;
          let c;
          if (layout && layout.isWater && layout.isWater(wx, wz, size)) {
            c = [142, 214, 236];
          } else {
            c = colorOf(t);
          }
          const i = (py * out + px) * 4;
          data[i] = c[0];
          data[i + 1] = c[1];
          data[i + 2] = c[2];
          data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      this._worldMapCache = canvas;
      this._worldMapCacheSize = size;
      this._worldMapCacheName = world._mapName || '';
      return canvas;
    },

    /** Force rebuild of full-world tactical map terrain cache (after map edits). */
    invalidateWorldMapCache() {
      this._worldMapCache = null;
      this._worldMapCacheSize = 0;
      this._worldMapCacheName = '';
      this._schematicCache = null;
      this._schematicSize = 0;
      this._schematicSeed = null;
    },

    /**
     * Draw the same full-world overview as the M tactical map onto any canvas.
     * @param {HTMLCanvasElement} canvas
     * @param {object} world
     * @param {object} [opts]
     */
    drawWorldOverview(canvas, world, opts) {
      opts = opts || {};
      const ctx = canvas && canvas.getContext && canvas.getContext('2d');
      if (!canvas || !ctx || !world) return null;

      const w = canvas.width;
      const h = canvas.height;
      const size = world.worldSize;
      const sx = w / size;
      const sy = h / size;

      if (opts.invalidate) this.invalidateWorldMapCache();
      if (opts.skipBasemap) {
        // Keep existing canvas (caller may have painted terrain overlay)
      } else {
        const terrain = this._ensureWorldMapCache(world);
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(terrain, 0, 0, w, h);
      }

      ctx.strokeStyle = 'rgba(255, 154, 74, 0.45)';
      ctx.lineWidth = 3;
      ctx.strokeRect(1.5, 1.5, w - 3, h - 3);

      const toMap = (wx, wz) => ({
        x: wx * sx,
        y: wz * sy,
      });

      if (opts.showLandmarks !== false && world._plannedLandmarks) {
        ctx.fillStyle = 'rgba(196, 165, 116, 0.85)';
        for (let i = 0; i < world._plannedLandmarks.length; i++) {
          const m = world._plannedLandmarks[i];
          const p = toMap(m.x, m.z);
          const rw = (m.w || 40) * sx;
          const rh = (m.d || 32) * sy;
          ctx.fillRect(p.x - rw * 0.35, p.y - rh * 0.35, rw * 0.7, rh * 0.7);
        }
      }

      // Map-kit grid overlay (same idea as tower designer cells)
      const grid = opts.showGrid | 0;
      if (grid > 0) {
        ctx.strokeStyle = 'rgba(180, 200, 220, 0.14)';
        ctx.lineWidth = 1;
        for (let x = 0; x <= size; x += grid) {
          const p = toMap(x, 0);
          ctx.beginPath();
          ctx.moveTo(p.x + 0.5, 0);
          ctx.lineTo(p.x + 0.5, h);
          ctx.stroke();
        }
        for (let z = 0; z <= size; z += grid) {
          const p = toMap(0, z);
          ctx.beginPath();
          ctx.moveTo(0, p.y + 0.5);
          ctx.lineTo(w, p.y + 0.5);
          ctx.stroke();
        }
      }

      // Painted bridge cells (color by height: low / mid / high)
      if (opts.bridgeCells && opts.bridgeCells.length) {
        const cell = opts.gridCell || grid || 8;
        const heightColor = {
          low: 'rgba(74, 85, 96, 0.75)',
          mid: 'rgba(90, 130, 170, 0.75)',
          high: 'rgba(160, 180, 200, 0.78)',
        };
        ctx.lineWidth = 1;
        for (let i = 0; i < opts.bridgeCells.length; i++) {
          const c = opts.bridgeCells[i];
          if (!c) continue;
          const h = c.height || 'low';
          ctx.fillStyle = heightColor[h] || heightColor.low;
          ctx.strokeStyle = 'rgba(180, 200, 220, 0.85)';
          const p0 = toMap(c.gx * cell, c.gz * cell);
          const pw = cell * sx;
          const ph = cell * sy;
          // Slight inset per height so overlapping layers stay readable
          const inset = h === 'high' ? 2 : h === 'mid' ? 1 : 0;
          ctx.fillRect(p0.x + inset, p0.y + inset, pw - inset * 2, ph - inset * 2);
          ctx.strokeRect(p0.x + 0.5 + inset, p0.y + 0.5 + inset, pw - 1 - inset * 2, ph - 1 - inset * 2);
        }
      }

      // Kit ziplines: ground → bridge
      if (opts.ziplines && opts.ziplines.length) {
        const cell = opts.gridCell || grid || 8;
        ctx.strokeStyle = 'rgba(154, 184, 208, 0.95)';
        ctx.fillStyle = 'rgba(154, 184, 208, 0.95)';
        ctx.lineWidth = 1.5;
        for (let i = 0; i < opts.ziplines.length; i++) {
          const z = opts.ziplines[i];
          if (!z) continue;
          const bx = (z.bridgeGx + 0.5) * cell;
          const bz = (z.bridgeGz + 0.5) * cell;
          const gx = z.gx != null ? z.gx + 0.5 : bx;
          const gz = z.gz != null ? z.gz + 0.5 : bz;
          const a = toMap(gx, gz);
          const b = toMap(bx, bz);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(a.x, a.y, 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(b.x, b.y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (world._allyBasePos) {
        const p = toMap(world._allyBasePos.x, world._allyBasePos.z);
        ctx.fillStyle = '#33aaff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fill();
      }
      if (world._enemyBasePos) {
        const p = toMap(world._enemyBasePos.x, world._enemyBasePos.z);
        ctx.fillStyle = '#ff3344';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fill();
      }

      if (opts.showSpawns) {
        this._drawSpawnMarkers(ctx, world, toMap, { radius: 5, fontSize: 9 });
      }

      if (opts.placed && opts.placed.length) {
        for (let i = 0; i < opts.placed.length; i++) {
          const pl = opts.placed[i];
          const p = toMap(pl.cx, pl.cz);
          const pw = Math.max(6, (pl.w || 12) * sx * 0.85);
          const ph = Math.max(6, (pl.d || 12) * sy * 0.85);
          if (pl.kind === 'aiSpawn') {
            ctx.fillStyle =
              pl.team === 'enemy' ? 'rgba(255, 136, 68, 0.55)' : 'rgba(68, 208, 200, 0.55)';
            ctx.fillRect(p.x - pw / 2, p.y - ph / 2, pw, ph);
            ctx.strokeStyle = pl.team === 'enemy' ? '#ff8844' : '#44d0c8';
          } else if (pl.kind === 'spawn') {
            ctx.fillStyle =
              pl.team === 'enemy' ? 'rgba(255, 51, 68, 0.45)' : 'rgba(51, 170, 255, 0.45)';
            ctx.fillRect(p.x - pw / 2, p.y - ph / 2, pw, ph);
            ctx.strokeStyle = pl.team === 'enemy' ? '#ff3344' : '#33aaff';
          } else if (pl.kind === 'flag') {
            ctx.fillStyle = 'rgba(232, 199, 106, 0.55)';
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(5, pw * 0.45), 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#e8c76a';
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.fillStyle = '#fff6d8';
            ctx.font = 'bold 10px Zpix, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(pl.letter || 'A', p.x, p.y + 0.5);
            ctx.strokeStyle = opts.hoverIndex === i ? '#ffe08a' : '#e8c76a';
          } else {
            ctx.strokeStyle = opts.hoverIndex === i ? '#ffe08a' : 'rgba(126, 200, 255, 0.95)';
          }
          ctx.lineWidth = opts.hoverIndex === i ? 2.5 : 1.5;
          ctx.strokeRect(p.x - pw / 2, p.y - ph / 2, pw, ph);
        }
      }

      if (opts.ghost) {
        const g = opts.ghost;
        const p = toMap(g.cx, g.cz);
        let gw = (g.w || 12) * sx;
        let gh = (g.d || 12) * sy;
        if (!g.cell && (g.yaw === 90 || g.yaw === 270)) {
          const t = gw;
          gw = gh;
          gh = t;
        }
        ctx.fillStyle = 'rgba(126, 200, 255, 0.28)';
        ctx.strokeStyle = 'rgba(126, 200, 255, 0.9)';
        ctx.lineWidth = 2;
        if (g.gridAlign && g.cell) {
          const cell = g.cell;
          const gx = Math.floor(g.cx / cell) * cell;
          const gz = Math.floor(g.cz / cell) * cell;
          const p0 = toMap(gx, gz);
          ctx.fillRect(p0.x, p0.y, cell * sx, cell * sy);
          ctx.strokeRect(p0.x, p0.y, cell * sx, cell * sy);
        } else {
          ctx.fillRect(p.x - gw / 2, p.y - gh / 2, gw, gh);
          ctx.strokeRect(p.x - gw / 2, p.y - gh / 2, gw, gh);
        }
      }

      return { toMap: toMap, sx: sx, sy: sy, w: w, h: h, size: size };
    },

    /** Full tactical map — world overview + facing arrow */
    drawBigMap(player, world, enemies, allies) {
      const canvas = this.els.bigMap;
      const ctx = this.bigMapCtx;
      if (!canvas || !ctx || !player || !world) return;

      const map = this.drawWorldOverview(canvas, world, {
        showLandmarks: true,
        showSpawns: true,
      });
      if (!map) return;
      const toMap = map.toMap;

      // Soldiers — friend = blue, foe = spotted yellow
      if (allies) {
        for (let i = 0; i < allies.length; i++) {
          const a = allies[i];
          if (!a.alive) continue;
          const p = toMap(a.mesh.position.x, a.mesh.position.z);
          ctx.fillStyle = '#4aa3ff';
          ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
        }
      }
      if (enemies) {
        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (!e.alive) continue;
          if (!(e.spottedUntil && e.spottedUntil > performance.now())) continue;
          const p = toMap(e.mesh.position.x, e.mesh.position.z);
          ctx.fillStyle = '#ffdd55';
          ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
        }
      }

      const flags = world._conquestFlags || world._kitFlags;
      if (flags && flags.length) {
        const pTeam = this._playerTeam();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 9px "Segoe UI", "Microsoft YaHei", sans-serif';
        for (let i = 0; i < flags.length; i++) {
          const f = flags[i];
          const p = toMap(f.x, f.z);
          const kind = this._cqFlagKind(f, pTeam);
          ctx.beginPath();
          if (kind === 'foe') {
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(Math.PI / 4);
            ctx.fillStyle = '#ff5566';
            ctx.fillRect(-5, -5, 10, 10);
            ctx.restore();
          } else if (kind === 'neutral') {
            ctx.strokeStyle = '#e8e4dc';
            ctx.lineWidth = 1.6;
            ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
            ctx.stroke();
          } else {
            ctx.fillStyle = kind === 'contest' ? '#ffe08a' : '#4aa3ff';
            ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.fillStyle = kind === 'neutral' ? '#e8e4dc' : '#1a1612';
          ctx.fillText(f.letter || '', p.x, p.y + 0.5);
        }
      }

      const now = performance.now();
      const vehicles =
        global.VF && global.VF.Vehicles && global.VF.Vehicles.getAll
          ? global.VF.Vehicles.getAll()
          : [];
      const playerTeam = this._playerTeam();
      for (let i = 0; i < vehicles.length; i++) {
        const vehicle = vehicles[i];
        if (!vehicle || !vehicle.position) continue;
        const friendly = vehicle.team === playerTeam;
        const spotted = !!(vehicle.spottedUntil && vehicle.spottedUntil > now);
        if (!friendly && !spotted && vehicle.alive) continue;
        const p = toMap(vehicle.position.x, vehicle.position.z);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(-(vehicle.yaw || 0));
        ctx.fillStyle = !vehicle.alive
          ? 'rgba(150,155,158,0.42)'
          : friendly
            ? '#59c6e8'
            : '#ffdd55';
        ctx.fillRect(-5, -8, 10, 16);
        ctx.fillStyle = '#f5fafb';
        ctx.fillRect(-1.5, -8, 3, 4);
        ctx.restore();
      }

      // Player + facing (same forward as look / W: -sin/-cos in XZ)
      const me = toMap(player.object.position.x, player.object.position.z);
      const yaw = player.yaw;
      const len = 18;
      const fx = -Math.sin(yaw) * len;
      const fy = -Math.cos(yaw) * len;

      ctx.strokeStyle = '#ff9a4a';
      ctx.fillStyle = '#ffe8d4';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(me.x, me.y);
      ctx.lineTo(me.x + fx, me.y + fy);
      ctx.stroke();

      // Arrow head
      const ang = Math.atan2(fy, fx);
      ctx.beginPath();
      ctx.moveTo(me.x + fx, me.y + fy);
      ctx.lineTo(
        me.x + fx - Math.cos(ang - 0.45) * 9,
        me.y + fy - Math.sin(ang - 0.45) * 9
      );
      ctx.lineTo(
        me.x + fx - Math.cos(ang + 0.45) * 9,
        me.y + fy - Math.sin(ang + 0.45) * 9
      );
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.arc(me.x, me.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ff9a4a';
      ctx.fill();
      ctx.strokeStyle = '#ffe8d4';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Compass
      const w = canvas.width;
      const h = canvas.height;
      ctx.fillStyle = 'rgba(255, 232, 212, 0.9)';
      ctx.font = '12px Zpix, monospace';
      ctx.fillText('N', w / 2 - 4, 16);
      ctx.fillText('S', w / 2 - 4, h - 8);
      ctx.fillText('W', 8, h / 2 + 4);
      ctx.fillText('E', w - 16, h / 2 + 4);
    },

    toast(msg) {
      let el = document.getElementById('toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        el.style.cssText =
          'position:fixed;top:30%;left:50%;transform:translateX(-50%);' +
          'z-index:100120;font-family:Orbitron,sans-serif;letter-spacing:0.1em;' +
          'color:#ff8c3c;text-shadow:0 2px 12px #000;pointer-events:none;font-size:0.9rem;';
        document.body.appendChild(el);
      }
      el.textContent = msg;
      el.style.opacity = '1';
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => {
        el.style.opacity = '0';
      }, 1400);
    },

    _headingDeg(yaw) {
      return (((-yaw) * 180) / Math.PI % 360 + 360) % 360;
    },

    _drawCompass(yaw) {
      const canvas = this.els.cqCompass;
      if (!canvas) return;
      if (this.els.cqHud && this.els.cqHud.classList.contains('hidden')) return;
      const ctx = canvas.getContext('2d');
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const heading = this._headingDeg(yaw || 0);
      const span = 110;
      const pxPerDeg = w / span;
      const labels = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.fillStyle = 'rgba(244,248,251,0.92)';
      ctx.font = '700 10px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let deg = 0; deg < 360; deg += 15) {
        let delta = deg - heading;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        if (Math.abs(delta) > span / 2 + 4) continue;
        const x = w * 0.5 + delta * pxPerDeg;
        const major = deg % 90 === 0;
        ctx.beginPath();
        ctx.moveTo(x, major ? 2 : 8);
        ctx.lineTo(x, major ? 14 : 12);
        ctx.stroke();
        if (major) {
          ctx.fillText(labels[deg] || String(deg), x, 16);
        } else if (deg % 30 === 0) {
          ctx.fillStyle = 'rgba(244,248,251,0.55)';
          ctx.fillText(String(deg), x, 16);
          ctx.fillStyle = 'rgba(244,248,251,0.92)';
        }
      }
      ctx.fillStyle = '#ffe08a';
      ctx.beginPath();
      ctx.moveTo(w * 0.5, 0);
      ctx.lineTo(w * 0.5 - 4, 7);
      ctx.lineTo(w * 0.5 + 4, 7);
      ctx.closePath();
      ctx.fill();
    },

    _classGlyph(classId) {
      if (classId === 'engineer') return '机';
      if (classId === 'support') return '援';
      if (classId === 'recon') return '侦';
      return '突';
    },

    _updateSquadRail(player) {
      const rail = this.els.squadRail;
      if (!rail || !player) return;
      const game = global.VF && global.VF.game;
      const squads = global.VF && global.VF.Squads;
      const myId = player.entityId || 'player-local';
      const squad = squads && squads.getSquadFor ? squads.getSquadFor(player) : null;
      const memberIds =
        squad && squad.memberIds && squad.memberIds.length ? squad.memberIds : [myId];
      let html = '';
      for (let i = 0; i < memberIds.length; i++) {
        const id = memberIds[i];
        const ent =
          squads && squads.getEntity
            ? squads.getEntity(id, game)
            : id === myId
              ? player
              : null;
        const isSelf = id === myId || !!(ent && ent === player);
        const alive = !ent || (ent.alive !== false && !ent.dead && !ent.downed);
        const hp = ent
          ? Math.max(
              0,
              Math.min(
                1,
                (ent.health != null ? ent.health : ent.hp || 0) /
                  (ent.maxHealth || ent.maxHp || 100)
              )
            )
          : 1;
        const name = isSelf
          ? '你'
          : (ent && (ent.displayName || ent.name)) || '小队 ' + (i + 1);
        const glyph = this._classGlyph(ent && ent.classId);
        html +=
          '<div class="squad-rail-row' +
          (isSelf ? ' is-self' : '') +
          (alive ? '' : ' is-down') +
          '"><span class="squad-class">' +
          glyph +
          '</span><span class="squad-meta"><span class="squad-name">' +
          name +
          '</span><span class="squad-hp"><i style="transform:scaleX(' +
          (alive ? hp : 0) +
          ')"></i></span></span></div>';
      }
      if (rail._html !== html) {
        rail._html = html;
        rail.innerHTML = html;
      }
    },

    _updateMinimapZone(player, world) {
      const el = this.els.minimapZone;
      if (!el || !player || !world) return;
      const flags = world._conquestFlags || world._kitFlags || [];
      let best = null;
      let bestD = 48 * 48;
      const px = player.object.position.x;
      const pz = player.object.position.z;
      for (let i = 0; i < flags.length; i++) {
        const f = flags[i];
        const dx = f.x - px;
        const dz = f.z - pz;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = f;
        }
      }
      const mapName =
        (world && world._mapName) ||
        (global.VF.IslandConquestMap && global.VF.IslandConquestMap.name) ||
        '荒盆';
      el.textContent = best ? best.letter + ' · ' + mapName : mapName;
    },

    _drawMinimapDiamond(ctx, x, y, size, fill, stroke) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI / 4);
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(-size, -size, size * 2, size * 2);
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(-size, -size, size * 2, size * 2);
      }
      ctx.restore();
    },

    /** North-up square satellite minimap — no fog of war. */
    drawMinimap(player, world, enemies, resources, allies) {
      const ctx = this.minimapCtx;
      if (!ctx || !this.els.minimap || !player || !world) return;
      const w = this.els.minimap.width;
      const h = this.els.minimap.height;
      const cx = w / 2;
      const cy = h / 2;
      const extent = 42;
      const scale = cx / extent;
      const px = player.object.position.x;
      const pz = player.object.position.z;
      const now = performance.now();
      const moved =
        !this._mmLastPos ||
        Math.abs(px - this._mmLastPos.x) > 1.2 ||
        Math.abs(pz - this._mmLastPos.z) > 1.2;
      const needTerrain = !this._mmTerrain || moved || now - (this._mmTerrainAt || 0) > 420;

      if (needTerrain) {
        if (!this._mmTerrain) {
          this._mmTerrain = document.createElement('canvas');
          this._mmTerrain.width = w;
          this._mmTerrain.height = h;
        }
        const tctx = this._mmTerrain.getContext('2d');
        tctx.fillStyle = '#1a2420';
        tctx.fillRect(0, 0, w, h);
        const AIR = global.VF.BLOCK.AIR;
        const WATER = global.VF.BLOCK.WATER;
        const step = 2;
        for (let dz = -extent; dz < extent; dz += step) {
          for (let dx = -extent; dx < extent; dx += step) {
            const wx = Math.floor(px + dx);
            const wz = Math.floor(pz + dz);
            if (wx < 0 || wz < 0 || wx >= world.worldSize || wz >= world.worldSize) continue;
            let gy = world.groundY ? world.groundY[wz * world.worldSize + wx] : 0;
            if (gy < 1) gy = 4;
            let t = world.get(wx, gy, wz);
            if (t === AIR) t = world.get(wx, gy - 1, wz);
            let col = '#3d5a34';
            const layout = global.VF && global.VF.IslandConquestMap;
            const PP = global.VF.PropPalette;
            if (layout && layout.isWater && layout.isWater(wx, wz, world.worldSize)) col = '#2a6a7a';
            else if (t === WATER) col = '#1a4a6a';
            else if (t === global.VF.BLOCK.ROAD || t === global.VF.BLOCK.ASPHALT) col = '#2a2e34';
            else if (t === global.VF.BLOCK.METAL) col = '#6a9ccc';
            else if (t === global.VF.BLOCK.BRICK) col = '#8a3a2a';
            else if (t === global.VF.BLOCK.PLASTER) col = '#c8c0b0';
            else if (t === global.VF.BLOCK.ROOF) col = '#5a4030';
            else if (t === global.VF.BLOCK.GRASS) col = '#3d6b2e';
            else if (t === global.VF.BLOCK.CONCRETE || t === global.VF.BLOCK.STONE) col = '#4a4e54';
            else if (t === global.VF.BLOCK.RUST) col = '#6a3a20';
            // Exact-colour prop voxels have no BLOCK name — read their registered hex.
            else if (PP && PP.isPropId(t)) {
              col = '#' + (global.VF.BLOCK_COLORS[t] || 0x9a968e).toString(16).padStart(6, '0');
            }
            tctx.fillStyle = col;
            tctx.fillRect(cx + dx * scale, cy + dz * scale, step * scale + 0.5, step * scale + 0.5);
          }
        }
        this._mmTerrainAt = now;
        this._mmLastPos = { x: px, z: pz };
      }

      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(this._mmTerrain, 0, 0);

      const pTeam = this._playerTeam();
      const squads = global.VF && global.VF.Squads;
      const myId = player.entityId || 'player-local';

      const cFlags = world._conquestFlags || world._kitFlags;
      if (cFlags && cFlags.length) {
        for (let i = 0; i < cFlags.length; i++) {
          const f = cFlags[i];
          const mx = cx + (f.x - px) * scale;
          const my = cy + (f.z - pz) * scale;
          if (mx < 6 || my < 6 || mx > w - 6 || my > h - 6) continue;
          const kind = this._cqFlagKind(f, pTeam);
          const fill =
            kind === 'foe' ? '#ff6a32' : kind === 'friend' ? '#3b9eff' : kind === 'contest' ? '#ffe08a' : null;
          const stroke = kind === 'neutral' ? '#e8e4dc' : '#041018';
          this._drawMinimapDiamond(ctx, mx, my, 4.2, fill, stroke);
          ctx.fillStyle = kind === 'neutral' ? '#e8e4dc' : '#041018';
          ctx.font = 'bold 8px "Segoe UI", "Microsoft YaHei", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(f.letter || '', mx, my + 0.5);
        }
      }

      const stations =
        (world && world._armorRepairStations) ||
        (global.VF && global.VF.Vehicles && global.VF.Vehicles.stations) ||
        [];
      for (let i = 0; i < stations.length; i++) {
        const station = stations[i];
        if (!station) continue;
        const mx = cx + (station.x - px) * scale;
        const my = cy + (station.z - pz) * scale;
        if (mx < 5 || my < 5 || mx > w - 5 || my > h - 5) continue;
        const tint =
          station.team === 'enemy' ? '#c45a32' : station.team === 'ally' ? '#3d9ad6' : '#e0a020';
        if (global.VF && typeof global.VF.drawResupplyStationMark === 'function') {
          global.VF.drawResupplyStationMark(ctx, mx, my, 12, tint, '#1a2420');
        } else {
          ctx.strokeStyle = tint;
          ctx.strokeRect(mx - 4, my - 4, 8, 8);
        }
      }

      const vehicles =
        global.VF && global.VF.Vehicles && global.VF.Vehicles.getAll
          ? global.VF.Vehicles.getAll()
          : [];
      for (let i = 0; i < vehicles.length; i++) {
        const vehicle = vehicles[i];
        if (!vehicle || !vehicle.position) continue;
        const friendly = vehicle.team === pTeam;
        const spotted = !!(vehicle.spottedUntil && vehicle.spottedUntil > now);
        if (!friendly && !spotted && vehicle.alive) continue;
        const mx = cx + (vehicle.position.x - px) * scale;
        const my = cy + (vehicle.position.z - pz) * scale;
        if (mx < 5 || my < 5 || mx > w - 5 || my > h - 5) continue;
        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(-(vehicle.yaw || 0));
        ctx.fillStyle = !vehicle.alive
          ? 'rgba(150,155,158,0.42)'
          : friendly
            ? '#59c6e8'
            : '#ffdd55';
        ctx.fillRect(-3.5, -5, 7, 10);
        ctx.fillStyle = '#f5fafb';
        ctx.fillRect(-1, -5, 2, 3);
        ctx.restore();
      }

      const paintUnit = (unit, color, size) => {
        if (!unit || !unit.alive || !unit.mesh) return;
        const mx = cx + (unit.mesh.position.x - px) * scale;
        const my = cy + (unit.mesh.position.z - pz) * scale;
        if (mx < 3 || my < 3 || mx > w - 3 || my > h - 3) return;
        ctx.fillStyle = color;
        ctx.fillRect(mx - size, my - size, size * 2, size * 2);
      };

      if (allies) {
        for (let i = 0; i < allies.length; i++) {
          const a = allies[i];
          const squadmate = !!(squads && squads.areSquadmates && squads.areSquadmates(myId, a));
          paintUnit(a, squadmate ? '#8dff7a' : '#4aa7ff', squadmate ? 2.4 : 2);
        }
      }
      if (enemies) {
        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (!e.alive || !e.mesh) continue;
          const spotted = !!(e.spottedUntil && e.spottedUntil > now);
          if (!spotted) continue;
          const mx = cx + (e.mesh.position.x - px) * scale;
          const my = cy + (e.mesh.position.z - pz) * scale;
          if (mx < 3 || my < 3 || mx > w - 3 || my > h - 3) continue;
          this._drawMinimapDiamond(ctx, mx, my, 3.2, '#ffdd55', '#041018');
        }
      }

      const pvp = global.VF && global.VF.Pvp;
      const remote = pvp && pvp.remoteState;
      if (remote && remote.alive !== false && remote.spottedUntil && remote.spottedUntil > now) {
        const myTeam = this._playerTeam();
        const theirTeam =
          remote.team || (pvp.remoteLoadout && pvp.remoteLoadout.team) || 'enemy';
        if (theirTeam !== myTeam && remote.x != null && remote.z != null) {
          const mx = cx + (remote.x - px) * scale;
          const my = cy + (remote.z - pz) * scale;
          if (mx >= 3 && my >= 3 && mx <= w - 3 && my <= h - 3) {
            this._drawMinimapDiamond(ctx, mx, my, 3.2, '#ffdd55', '#041018');
          }
        }
      }

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-(player.yaw || 0));
      ctx.fillStyle = '#f4f8fb';
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(4.5, 5);
      ctx.lineTo(0, 2.5);
      ctx.lineTo(-4.5, 5);
      ctx.closePath();
      ctx.fillStyle = '#f4f8fb';
      ctx.fill();
      ctx.strokeStyle = '#041018';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = 'rgba(244,248,251,0.78)';
      ctx.font = '700 10px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('N', cx, 5);

      this._drawCompass(player.yaw);
      this._updateSquadRail(player);
      this._updateMinimapZone(player, world);
    },
  };

  global.VF = global.VF || {};
  global.VF.UI = UI;
})(window);
