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
        waveNum: document.getElementById('wave-num'),
        timer: document.getElementById('timer'),
        coreCount: document.getElementById('core-count'),
        blockCount: document.getElementById('block-count'),
        ammoMag: document.getElementById('ammo-mag'),
        ammoReserve: document.getElementById('ammo-reserve'),
        ammoReload: document.getElementById('ammo-reload'),
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
        hotbarSlots: document.querySelectorAll('#hotbar .slot'),
        interactHint: document.getElementById('interact-hint'),
        minimap: document.getElementById('minimap'),
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
        deathHubBtn: document.getElementById('death-hub-btn'),
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
        cqMarkers: document.getElementById('cq-markers'),
        cqCommand: document.getElementById('cq-command'),
        cqBoard: document.getElementById('cq-board'),
        cqBoardClock: document.getElementById('cq-board-clock'),
        deployServer: document.getElementById('deploy-server'),
        spawnCancel: document.getElementById('spawn-cancel-btn'),
        deployHover: document.getElementById('deploy-hover'),
        deployClassRow: document.getElementById('deploy-class-row'),
        deployLoadout: document.getElementById('deploy-loadout-btn'),
        deployRole: document.getElementById('deploy-role-btn'),
        deployMapName: document.getElementById('deploy-map-name'),
        modeOverlay: document.getElementById('mode-overlay'),
        classOverlay: document.getElementById('class-overlay'),
        classGrid: document.getElementById('class-grid'),
        classStageCanvas: document.getElementById('class-stage-canvas'),
        classStageName: document.getElementById('class-stage-name'),
        classStageRole: document.getElementById('class-stage-role'),
        classStageRoleText: document.getElementById('class-stage-role-text'),
        classStageSkills: document.getElementById('class-stage-skills'),
        classSkillActive: document.getElementById('class-skill-active'),
        classSkillPassive: document.getElementById('class-skill-passive'),
        classSkillTip: document.getElementById('class-skill-tip'),
        classSkillTipName: document.getElementById('class-skill-tip-name'),
        classSkillTipDesc: document.getElementById('class-skill-tip-desc'),
        classStagePlaceholder: document.getElementById('class-stage-placeholder'),
        classConfirm: document.getElementById('class-confirm-btn'),
        classCancel: document.getElementById('class-cancel-btn'),
      };
      this.minimapCtx = this.els.minimap.getContext('2d');
      this.bigMapCtx = this.els.bigMap ? this.els.bigMap.getContext('2d') : null;
      this.spawnMapCtx = this.els.spawnMap ? this.els.spawnMap.getContext('2d') : null;
      this.inventoryOpen = false;
      this.mapOpen = false;
      this.spawnSelectOpen = false;
      this.classSelectOpen = false;
      this.modeSelectOpen = false;
      this.selectedClassId = null;
      this._lastHp = 100;
      this.scoreboardOpen = false;
      this._deathHandlers = { onRedeploy: null, onCallout: null, onHub: null };
      this._bindDeathButtons();
    },

    setDeathHandlers(handlers) {
      this._deathHandlers = handlers || {};
    },

    _bindDeathButtons() {
      const self = this;
      if (this.els.deathBtn && !this.els.deathBtn._vfBound) {
        this.els.deathBtn._vfBound = true;
        this.els.deathBtn.addEventListener('click', function (e) {
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
      if (this.syncWeaponLocks) this.syncWeaponLocks();
      if (global.VF && global.VF.syncGameBackBtn) global.VF.syncGameBackBtn();
    },

    hideHud() {
      if (this.els.hud) this.els.hud.classList.add('hidden');
      if (this.setHudMode) this.setHudMode('core');
      if (this.setScoreboardOpen) this.setScoreboardOpen(false);
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
      const h = Math.max(0, Math.min(100, Math.round(hp)));
      const a = armor != null ? Math.round(armor) : null;
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
        this.els.healthFill.style.transform = 'scaleX(' + h / 100 + ')';
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

    updateResources(cores, blocks) {
      if (cores === this._cachedCores && blocks === this._cachedBlocks) return;
      this._cachedCores = cores;
      this._cachedBlocks = blocks;
      if (this.els.coreCount) this.els.coreCount.textContent = cores;
      if (this.els.blockCount) this.els.blockCount.textContent = blocks;
    },

    updateAmmo(mag, reserve) {
      this.els.ammoMag.textContent = mag;
      this.els.ammoReserve.textContent = reserve;
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
      const classId = info.classId || 'assault';
      const skillId =
        classId === 'assault'
          ? 'vanguard'
          : classId === 'support'
            ? 'medic'
            : classId === 'recon'
              ? 'ghost'
              : classId;
      hud.classList.toggle('skill-vanguard', skillId === 'vanguard');
      hud.classList.toggle('skill-medic', skillId === 'medic');
      hud.classList.toggle('skill-ghost', skillId === 'ghost');
      hud.classList.toggle('skill-juggernaut', skillId === 'juggernaut');
      hud.classList.toggle('skill-raider', skillId === 'raider');
      hud.classList.toggle('skill-engineer', skillId === 'engineer');

      // Swap icons
      hud.querySelectorAll('[data-skill-icon]').forEach(function (el) {
        el.classList.toggle('hidden', el.getAttribute('data-skill-icon') !== skillId);
      });

      const active = this.els.skillActive;
      const passive = this.els.skillPassive;
      const overlay = this.els.skillCdOverlay;
      const num = this.els.skillCdNum;
      const buff = this.els.skillBuffRing;
      const pTime = this.els.skillPassiveTime;
      const pNum = this.els.skillPassiveTimeNum;

      if (active) {
        active.title =
          skillId === 'medic'
            ? '修复装置 — 按住 G 选择地面位置，松手部署（CD 15s）'
            : skillId === 'ghost'
              ? '隐身 — 按 G 进入隐形 6s，移速+30%（CD 28s）；破隐后首枪+40'
              : skillId === 'juggernaut'
                ? '防暴盾 — 按 G 展开能量盾（280耐久·8s·移速-35%·CD24s）'
                : skillId === 'raider'
                  ? '电磁脉冲 — 按 G 向前方60°圆锥发射（28m·核心12×12×6·CD30s）'
                  : skillId === 'engineer'
                    ? '加特林炮塔 — 按住 G 部署 / 炮塔在场时点 G 收回（12物料·120HP·CD40s）'
                    : 'C4 炸药 — 按住 G 瞄准抛物线，松手投掷';
        active.classList.toggle('ready', !!info.ready && !info.pending && !info.aiming && !info.flying);
        active.classList.toggle('pending', !!info.pending || !!info.flying);
        active.classList.toggle('aiming', !!info.aiming);
        active.classList.toggle(
          'cooldown',
          !info.ready && !info.pending && !info.aiming && !info.flying && info.cooldown > 0
        );
      }
      if (passive) {
        passive.title =
          skillId === 'medic'
            ? '被动：开局获得 50 护盾'
            : skillId === 'ghost'
              ? '被动：从背后攻击敌人时伤害 +30%'
              : skillId === 'juggernaut'
                ? '被动：受到的子弹伤害 -6%'
                : skillId === 'raider'
                  ? '被动：击杀敌人或破坏防御建筑时额外掉落 30% 备弹与物料'
                  : skillId === 'engineer'
                    ? '被动：放置的建筑耐久 +50% · 开局 20 物料'
                    : '被动：切枪/换弹+15% · C4起爆移速+20%·3s';
        passive.classList.toggle('buffed', !!info.speedBuff || !!info.ambushReady);
        passive.classList.toggle('has-shield', !!info.passiveShield && skillId === 'medic');
        passive.classList.toggle('ambush-ready', !!info.ambushReady);
        passive.classList.toggle('riot-active', !!info.riotHp);
        passive.classList.toggle('loot-bonus', !!info.lootBonus);
        passive.classList.toggle('build-durability', !!info.buildDurability);
      }
      if (buff) buff.classList.toggle('hidden', !info.speedBuff && !info.ambushReady);

      if (pTime && pNum) {
        if (info.riotHp > 0) {
          pTime.classList.remove('hidden');
          pNum.textContent = String(info.riotHp);
        } else if (info.speedBuff && info.buffTime > 0 && skillId !== 'juggernaut') {
          pTime.classList.remove('hidden');
          pNum.textContent = info.buffTime.toFixed(1);
        } else if (info.ambushReady) {
          pTime.classList.remove('hidden');
          pNum.textContent = '+40';
        } else if (info.passiveShield && info.shieldAmount && skillId === 'medic') {
          pTime.classList.remove('hidden');
          pNum.textContent = String(info.shieldAmount);
        } else if (info.bulletResist) {
          pTime.classList.remove('hidden');
          pNum.textContent = '-6%';
        } else if (info.lootBonus) {
          pTime.classList.remove('hidden');
          pNum.textContent = '+30%';
        } else if (info.buildDurability) {
          pTime.classList.remove('hidden');
          pNum.textContent = '+50%';
        } else {
          pTime.classList.add('hidden');
          pNum.textContent = '';
        }
      }

      if (overlay && num) {
        if (info.aiming) {
          overlay.classList.add('hidden');
          overlay.classList.remove('fuse');
          num.textContent = '';
        } else if (info.flying) {
          overlay.classList.remove('hidden');
          overlay.classList.add('fuse');
          num.textContent = '…';
        } else if (info.turretAmmo > 0) {
          overlay.classList.remove('hidden');
          overlay.classList.add('fuse');
          num.textContent = String(info.turretAmmo);
        } else if (info.pending && info.fuse > 0) {
          overlay.classList.remove('hidden');
          overlay.classList.add('fuse');
          num.textContent = info.fuse.toFixed(1);
        } else if (info.cooldown > 0) {
          overlay.classList.remove('hidden');
          overlay.classList.remove('fuse');
          num.textContent = String(Math.ceil(info.cooldown));
        } else {
          overlay.classList.add('hidden');
          overlay.classList.remove('fuse');
          num.textContent = '';
        }
      }
    },

    /** Universal dash skill (all classes) */
    updateDash(info) {
      const slot = this.els.skillDash;
      const overlay = this.els.dashCdOverlay;
      const num = this.els.dashCdNum;
      const hud = this.els.dashHud;
      if (!slot) return;
      if (hud) hud.classList.remove('hidden');
      if (!info) {
        slot.classList.remove('ready', 'cooldown', 'dashing');
        if (overlay) overlay.classList.add('hidden');
        return;
      }
      slot.classList.toggle('ready', !!info.ready && !info.dashing);
      slot.classList.toggle('cooldown', !info.ready && !info.dashing);
      slot.classList.toggle('dashing', !!info.dashing);
      if (overlay && num) {
        if (info.dashing) {
          overlay.classList.remove('hidden');
          overlay.classList.add('fuse');
          num.textContent = '»';
        } else if (info.cooldown > 0) {
          overlay.classList.remove('hidden');
          overlay.classList.remove('fuse');
          num.textContent = String(Math.ceil(info.cooldown));
        } else {
          overlay.classList.add('hidden');
          overlay.classList.remove('fuse');
          num.textContent = '';
        }
      }
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
      if (blue === this._cachedBlue && red === this._cachedRed) return;
      this._cachedBlue = blue;
      this._cachedRed = red;
      if (this.els.blueCount) this.els.blueCount.textContent = blue;
      if (this.els.redCount) this.els.redCount.textContent = red;
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
      if (this.els.cqFillAlly) this.els.cqFillAlly.style.transform = 'scaleX(' + youPct + ')';
      if (this.els.cqFillEnemy) this.els.cqFillEnemy.style.transform = 'scaleX(' + themPct + ')';
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
      let text = 'Q 标记 · X 职业装备 · Z 烟雾';
      if (order && order.status === 'active') {
        text =
          (order.kind === 'defend' ? '防守 ' : '进攻 ') +
          order.flagLetter +
          '点 · ' +
          Math.round(Math.min(1, order.progress || 0) * 100) +
          '%' +
          (isLeader ? ' · Q 可更换命令' : '');
      } else if (isLeader) {
        text = '队长 · 对准旗点按 Q 下达命令 · X 装备 · Z 烟雾';
      }
      this.els.cqCommand.textContent = text;
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
        this.els.cqCaptureCounts.textContent = '友 ' + (friendN || 0) + ' · 敌 ' + (foeN || 0);
      }
      const canvas = this.els.cqCaptureRing;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const w = canvas.width;
      const h = canvas.height;
      const cx = w * 0.5;
      const cy = h * 0.5;
      const r = 68;
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 12;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 4;
      ctx.stroke();
      const t = Math.max(0, Math.min(1, Math.abs(flag.capture || 0)));
      const towardFriend =
        (flag.capture || 0) >= 0 ? playerTeam === 'ally' : playerTeam === 'enemy';
      const col = flag.contested ? '#ffe08a' : towardFriend ? '#4aa3ff' : '#e24b3c';
      if (t > 0.001) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t);
        ctx.strokeStyle = col;
        ctx.lineWidth = 8;
        ctx.lineCap = 'butt';
        ctx.stroke();
      }
      box.style.setProperty('--cq-cap-col', col);
    },

    _drawCqMarkers(flags, camera, player, playerTeam) {
      const wrap = this.els.cqMarkers;
      if (!wrap) return;
      // World-space flag sprites already show the letter; hide the duplicate HUD pins.
      while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
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
      if (this.els.deathSub) {
        this.els.deathSub.textContent = sub || '血量耗尽 · 等待重新部署';
      }
      if (this.els.deathFlavor) {
        this.els.deathFlavor.textContent = flavor || '选个出生点再上！';
      }
      if (this.els.deathOverlay) {
        const h1 = this.els.deathOverlay.querySelector('h1');
        if (h1) h1.textContent = title || '你已阵亡';
        this.els.deathOverlay.classList.remove('hidden');
      }
      if (this.els.deathBtn) {
        this.els.deathBtn.disabled = false;
        this.els.deathBtn.innerHTML =
          '重新部署<span class="end-card-btn-arrow" aria-hidden="true">›</span>';
      }
      if (this.els.deathCallBtn) this.els.deathCallBtn.classList.add('hidden');
      document.exitPointerLock && document.exitPointerLock();
    },

    showDowned(seconds) {
      this._downedMode = true;
      if (this.els.deathOverlay) {
        const h1 = this.els.deathOverlay.querySelector('h1');
        if (h1) h1.textContent = '你已倒地';
        this.els.deathOverlay.classList.remove('hidden');
      }
      if (this.els.deathSub) {
        this.els.deathSub.textContent = '救援窗口 ' + Math.max(0, Math.ceil(seconds || 0)) + ' 秒';
      }
      if (this.els.deathFlavor) {
        this.els.deathFlavor.textContent = '等待队友救援，或放弃并重新部署';
      }
      if (this.els.deathBtn) {
        this.els.deathBtn.disabled = false;
        this.els.deathBtn.innerHTML =
          '放弃<span class="end-card-btn-arrow" aria-hidden="true">›</span>';
      }
      if (this.els.deathCallBtn) {
        this.els.deathCallBtn.textContent = '呼叫救援';
        this.els.deathCallBtn.classList.remove('hidden');
      }
      document.exitPointerLock && document.exitPointerLock();
    },

    updateDowned(seconds, reviveProgress, called) {
      if (!this._downedMode) return;
      if (this.els.deathSub) {
        const left = Math.max(0, Math.ceil(seconds || 0));
        const revive =
          reviveProgress > 0 ? ' · 复活 ' + Math.round(Math.min(1, reviveProgress) * 100) + '%' : '';
        this.els.deathSub.textContent = '救援窗口 ' + left + ' 秒' + revive;
      }
      if (this.els.deathCallBtn) {
        this.els.deathCallBtn.textContent = called ? '已呼叫救援' : '呼叫救援';
        this.els.deathCallBtn.disabled = !!called;
      }
    },

    hideDeath() {
      this._downedMode = false;
      if (this.els.deathOverlay) this.els.deathOverlay.classList.add('hidden');
    },

    setHotbarSlot(slotNum) {
      this.els.hotbarSlots.forEach((el) => {
        el.classList.toggle('active', Number(el.dataset.slot) === slotNum);
      });
    },

    syncWeaponLocks() {
      if (!this.els.hotbarSlots) return;
      const owns = function (id) {
        if (!global.VF.Economy || !global.VF.Economy.ownsWeapon) return true;
        return global.VF.Economy.ownsWeapon(id);
      };
      this.els.hotbarSlots.forEach((el) => {
        const slot = Number(el.dataset.slot);
        if (slot === 2) el.classList.toggle('locked', !owns('sg'));
        else if (slot === 3) el.classList.toggle('locked', !owns('sr'));
      });
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
     * - 'kill': gold × overshoot + ring
     */
    flashCrosshair(kind) {
      const el = this.els.crosshair;
      if (!el) return;
      const showTicks = kind === 'hit' || kind === 'hostile' || kind === 'kill';
      el.classList.remove('fire', 'hit', 'hit-kill');
      void el.offsetWidth;
      if (showTicks) {
        el.classList.add('hit');
        if (kind === 'kill') el.classList.add('hit-kill');
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
          : showTicks
            ? ch.hitMs != null
              ? ch.hitMs
              : 170
            : ch.fireMs != null
              ? ch.fireMs
              : 160;
      this._hitTimer = setTimeout(function () {
        el.classList.remove('fire', 'hit', 'hit-kill');
      }, dur);
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
        const teams = ['ally', 'enemy'];
        for (let t = 0; t < teams.length; t++) {
          const team = teams[t];
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
              team +
              '"><td colspan="8">' +
              escape((team === 'ally' ? '蓝方 · ' : '红方 · ') + (squad ? squad.name : '未编组')) +
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
        this.modeSelectOpen ||
        towerOpen ||
        rangeOpen
      );
    },

    /** Inventory / map / class pause the sim. Redeploy spawn overlay does not. */
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
        this.modeSelectOpen ||
        towerOpen ||
        rangeOpen
      );
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
          if (typeof global.VF.startConquest32 === 'function') {
            global.VF.startConquest32();
          }
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
        const available =
          server.players < server.capacity && server.phase === 'lobby';
        join.disabled = !available;
        join.textContent = available ? '加入' : '不可加入';
        joinCell.appendChild(join);
        row.appendChild(joinCell);
        body.appendChild(row);
      }
      if (empty) empty.classList.toggle('hidden', servers.length > 0);
      if (count) count.textContent = servers.length + ' 个服务器';
    },

    /* ---------- Character class select ---------- */

    openClassSelect(onConfirm, onCancel, preferredClassId) {
      if (!this.els.classOverlay) return;
      this.classSelectOpen = true;
      this.selectedClassId = preferredClassId || null;
      this._classOnConfirm = onConfirm;
      this._classOnCancel = onCancel;
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
    },

    closeClassSelect() {
      this.classSelectOpen = false;
      if (this.els.classOverlay) this.els.classOverlay.classList.add('hidden');
      // Defer preview teardown so it never runs in the same turn as beginMatch
      const self = this;
      setTimeout(function () {
        if (!self.classSelectOpen) self._stopClassPreviews();
      }, 250);
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
        name.textContent = c.label;

        btn.appendChild(canvas);
        btn.appendChild(name);
        btn.addEventListener('click', () => {
          this.selectedClassId = c.id;
          grid.querySelectorAll('.class-card').forEach((el) => {
            el.classList.toggle('selected', el.dataset.classId === c.id);
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
        this.els.classStageName.textContent = info ? info.label : '';
      }
      if (this.els.classStageRole) {
        this.els.classStageRole.classList.toggle('is-visible', !!(info && info.role));
        this.els.classStageRole.setAttribute('aria-hidden', info && info.role ? 'false' : 'true');
      }
      if (this.els.classStageRoleText) {
        this.els.classStageRoleText.textContent = info && info.role ? info.role : '';
      }
      if (this.els.classStageSkills) {
        this.els.classStageSkills.classList.toggle('hidden', !info);
      }
      if (info && this.els.classStageSkills) {
        this.els.classStageSkills.querySelectorAll('[data-skill-icon]').forEach((el) => {
          el.classList.toggle('hidden', el.getAttribute('data-skill-icon') !== id);
        });
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
        this.els.classConfirm.disabled = !this.selectedClassId;
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
    },

    /**
     * Fixed world framing: soldier stands at origin (feet≈0, head≈2),
     * camera looks straight at mid-body so the figure is centered and fully visible.
     */
    _frameBodyCamera(cam, aspect) {
      const midY = 1.05;
      const bodyH = 2.35; // head-to-toe + margin (covers heavy scale)
      cam.fov = 40;
      cam.aspect = aspect;
      const vFov = THREE.MathUtils.degToRad(cam.fov);
      let dist = (bodyH * 0.5) / Math.tan(vFov * 0.5);
      // Keep full height when panel is wide; when tall, still fit height
      dist *= 1.22;
      cam.near = 0.1;
      cam.far = 40;
      cam.position.set(0, midY, dist);
      cam.up.set(0, 1, 0);
      cam.lookAt(0, midY, 0);
      cam.updateProjectionMatrix();
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

      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor(0x000000, 0);

      const models = {};
      const classes = global.VF.Soldier.CLASSES;
      for (let i = 0; i < classes.length; i++) {
        const m = global.VF.Soldier.createPreviewSoldier(classes[i].id);
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
          model.rotation.set(0, Math.PI + t * 0.75, 0);
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
      if (prev.renderer) {
        try {
          prev.renderer.dispose();
        } catch (_) {}
        // Never forceContextLoss — on Intel/Lenovo that can kill the match WebGL context
      }
      for (const k in prev.models) {
        const m = prev.models[k];
        if (m && prev.scene) prev.scene.remove(m);
      }
      this._classPreview = null;
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
      const r = opts.radius != null ? opts.radius : 6;
      const showLabel = opts.label !== false;
      for (let i = 0; i < points.length; i++) {
        const s = points[i];
        const lockedOut = (teamFilter && s.team !== teamFilter) || s.available === false;
        const p = toMap(s.x, s.z);
        const selected = s.id === selectedId && !lockedOut;
        ctx.globalAlpha = lockedOut ? 0.28 : 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, selected ? r + 2 : r, 0, Math.PI * 2);
        ctx.fillStyle =
          s.kind === 'flag'
            ? '#e8c76a'
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
      this._spawnHover = null;
      const g = global.VF && global.VF.game;
      const island = global.VF && global.VF.IslandConquestMap;
      if (this.els.deployMapName) {
        this.els.deployMapName.textContent =
          ((world && world._mapName) || (island && island.name) || '荒盆') + ' [32 vs 32]';
      }
      if (this.els.deployServer) {
        const C = global.VF.CONQUEST || {};
        const feel = (global.VF.Feel && global.VF.Feel.conquest) || {};
        const tix = feel.tickets != null ? feel.tickets : C.TICKETS_START || 1000;
        const round = feel.roundSec != null ? feel.roundSec : C.ROUND_SEC || 2700;
        const mm = String(Math.floor(round / 60)).padStart(2, '0');
        const ss = String(Math.floor(round % 60)).padStart(2, '0');
        const mapName = (world && world._mapName) || (island && island.name) || '荒盆';
        this.els.deployServer.textContent =
          mapName + ' · 增援 ' + tix + ' · ' + mm + ':' + ss + ' · 占领 A–F';
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
      const teamRow = document.getElementById('team-pick-row');
      if (teamRow) teamRow.classList.add('hidden');
      document.exitPointerLock && document.exitPointerLock();
      this.els.spawnOverlay.classList.remove('hidden');
      this._buildSpawnButtons(world);
      this._buildDeployClasses();
      this._syncTeamPickUi(world);
      this.drawSpawnSelectMap(world);
      this._bindSpawnSelectOnce(world);
      this._syncSpawnConfirm();
    },

    closeSpawnSelect() {
      this.spawnSelectOpen = false;
      this._spawnRedeploy = false;
      this._deployUnlockAt = 0;
      if (this.els.spawnOverlay) this.els.spawnOverlay.classList.add('hidden');
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
        btn.type = 'button';
        btn.className =
          'spawn-pick ' +
          s.team +
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
      if (allyH3) allyH3.textContent = '蓝方出生点';
      if (enemyH3) enemyH3.textContent = '红方出生点';
      if (this.els.spawnGroupEnemy) this.els.spawnGroupEnemy.classList.remove('hidden');
      world._spawnPoints.ally.forEach((s) => allyRow.appendChild(makeBtn(s)));
      world._spawnPoints.enemy.forEach((s) => enemyRow.appendChild(makeBtn(s)));
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
        btn.textContent = c.nameZh || c.nameEn || c.id;
        btn.title = c.label || c.nameZh || c.id;
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
          });
        });
        row.appendChild(btn);
      }
      if (this.els.deployLoadout && !this.els.deployLoadout._vfBound) {
        this.els.deployLoadout._vfBound = true;
        this.els.deployLoadout.addEventListener('click', function () {
          if (self.toast) self.toast('局内用 1 / 2 / 3 切换武器');
        });
      }
      if (this.els.deployRole && !this.els.deployRole._vfBound) {
        this.els.deployRole._vfBound = true;
        this.els.deployRole.addEventListener('click', function () {
          if (self.toast) self.toast('在底部选择兵种后部署');
        });
      }
    },

    _refreshSpawnSelection(world) {
      const selected = world._selectedSpawnId;
      document.querySelectorAll('.spawn-pick').forEach((btn) => {
        btn.classList.toggle('selected', btn.dataset.spawnId === selected);
      });
      this._syncTeamPickUi(world);
      this.drawSpawnSelectMap(world);
      this._syncSpawnConfirm();
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
                  return s.id;
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
      this._syncSpawnConfirm();
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

      const canvas = this.els.spawnMap;
      if (canvas) {
        canvas.addEventListener('click', (e) => {
          if (!this.spawnSelectOpen) return;
          const w = global.VF.game && global.VF.game.world;
          if (!w) return;
          const rect = canvas.getBoundingClientRect();
          const mx = ((e.clientX - rect.left) / rect.width) * canvas.width;
          const my = ((e.clientY - rect.top) / rect.height) * canvas.height;
          const view = this._spawnMapView(canvas, w);
          const wz = view.fromMap(mx, my);
          const hit = this._nearestSpawnTarget(w, wz.x, wz.z, 39);
          if (!hit) return;
          const g = global.VF.game;
          const locked = !!(
            this._spawnRedeploy ||
            (g && g.teamLocked) ||
            (g && g.mode === 'pvp')
          );
          if (locked && w._playerTeam && hit.team && hit.team !== w._playerTeam) return;
          if (!locked && hit.team) w._playerTeam = hit.team;
          if (global.VF.Conquest && global.VF.Conquest.applyDeployList) {
            global.VF.Conquest.applyDeployList(w, w._playerTeam || hit.team || 'ally');
          }
          w.setSelectedSpawn(hit.id);
          this._refreshSpawnSelection(w);
        });
        canvas.addEventListener('mousemove', (e) => {
          if (!this.spawnSelectOpen) return;
          const w = global.VF.game && global.VF.game.world;
          if (!w) return;
          const rect = canvas.getBoundingClientRect();
          const mx = ((e.clientX - rect.left) / rect.width) * canvas.width;
          const my = ((e.clientY - rect.top) / rect.height) * canvas.height;
          const view = this._spawnMapView(canvas, w);
          const wz = view.fromMap(mx, my);
          const hit = this._nearestSpawnTarget(w, wz.x, wz.z, 33);
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
      }
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
      const x0 = size * 0.02;
      const z0 = size * 0.1;
      const x1 = size * 0.98;
      const z1 = size * 0.9;
      const bw = x1 - x0;
      const bh = z1 - z0;
      const scale = Math.min(w / bw, h / bh);
      const ox = (w - bw * scale) / 2 - x0 * scale;
      const oy = (h - bh * scale) / 2 - z0 * scale;
      return {
        ox: ox,
        oy: oy,
        scale: scale,
        toMap: function (wx, wz) {
          return { x: ox + wx * scale, y: oy + wz * scale };
        },
        fromMap: function (mx, my) {
          return { x: (mx - ox) / scale, z: (my - oy) / scale };
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
              label: sides[t] === 'ally' ? '蓝方基地' : '红方基地',
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
      const pts = this._listMapSpawnTargets(world);
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
          } else {
            const k = Math.max(0, Math.min(1, (gy - 10) / 36));
            r = 86 + (k * 92) | 0;
            g = 88 + (k * 90) | 0;
            b = 92 + (k * 86) | 0;
          }
          for (let dy = 2; dy <= 10; dy++) {
            const up = world.get(wx, gy + dy, wz);
            if (up === CONCRETE || up === METAL || up === PLASTER || up === BRICK || up === STONE) {
              if (dy <= 6 && (up === CONCRETE || up === METAL || up === PLASTER || up === BRICK)) {
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

    _drawHqZone(ctx, p, team, sx) {
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
      ctx.fillStyle = team === 'ally' ? 'rgba(40,110,210,0.38)' : 'rgba(200,48,40,0.38)';
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

    drawSpawnSelectMap(world) {
      const canvas = this.els.spawnMap;
      const ctx = this.spawnMapCtx;
      if (!canvas || !ctx || !world) return;
      const w = canvas.width;
      const h = canvas.height;
      const view = this._spawnMapView(canvas, world);
      const toMap = view.toMap;
      const selected = !!world._selectedSpawnId;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);

      const schematic = this._ensureSchematicCache(world);
      const size = world.worldSize;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(schematic, 0, 0, 512, 512, view.ox, view.oy, size * view.scale, size * view.scale);
      this._drawValleyOutline(ctx, world, toMap, size);

      if (selected) {
        ctx.save();
        ctx.strokeStyle = '#e8922a';
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.moveTo(w / 2, 8);
        ctx.lineTo(w / 2, h - 8);
        ctx.moveTo(8, h / 2);
        ctx.lineTo(w - 8, h / 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
        ctx.strokeStyle = '#e8922a';
        ctx.lineWidth = 4;
        const pad = 10;
        ctx.strokeRect(view.ox + pad, view.oy + pad, size * view.scale - pad * 2, size * view.scale - pad * 2);
      }

      if (world._allyBasePos) {
        this._drawHqZone(ctx, toMap(world._allyBasePos.x, world._allyBasePos.z), 'ally', view.scale);
      }
      if (world._enemyBasePos) {
        this._drawHqZone(ctx, toMap(world._enemyBasePos.x, world._enemyBasePos.z), 'enemy', view.scale);
      }

      const drawHqBadge = function (pos, team) {
        if (!pos) return;
        const p = toMap(pos.x, pos.z);
        ctx.fillStyle = team === 'ally' ? '#3b82e8' : '#e24b3c';
        ctx.fillRect(p.x - 10, p.y - 10, 20, 20);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 11px Segoe UI, Microsoft YaHei, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(team === 'ally' ? '蓝' : '红', p.x, p.y + 0.5);
        if (world._selectedSpawnId && String(world._selectedSpawnId).indexOf(team) === 0) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.strokeRect(p.x - 12, p.y - 12, 24, 24);
        }
      };
      drawHqBadge(world._allyBasePos, 'ally');
      drawHqBadge(world._enemyBasePos, 'enemy');

      const flags = world._conquestFlags || world._kitFlags || [];
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

      const g = global.VF.game;
      const ai = g && g.ai;
      if (ai) {
        const lists = [ai.blue || [], ai.red || []];
        for (let L = 0; L < lists.length; L++) {
          for (let i = 0; i < lists[L].length; i++) {
            const u = lists[L][i];
            if (!u || !u.alive || !u.mesh) continue;
            const p = toMap(u.mesh.position.x, u.mesh.position.z);
            ctx.fillStyle = u.team === 'enemy' ? '#ff5566' : '#4aa3ff';
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
            if (
              up === global.VF.BLOCK.BRICK ||
              up === global.VF.BLOCK.CONCRETE ||
              up === global.VF.BLOCK.METAL ||
              up === global.VF.BLOCK.PLASTER ||
              up === global.VF.BLOCK.ROOF
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

      // Soldiers — blue / red by faction
      if (allies) {
        for (let i = 0; i < allies.length; i++) {
          const a = allies[i];
          if (!a.alive) continue;
          const p = toMap(a.mesh.position.x, a.mesh.position.z);
          ctx.fillStyle = a.team === 'ally' ? '#4aa3ff' : '#ff5566';
          ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
        }
      }
      if (enemies) {
        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (!e.alive) continue;
          const p = toMap(e.mesh.position.x, e.mesh.position.z);
          ctx.fillStyle = e.team === 'ally' ? '#4aa3ff' : '#ff5566';
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
          'z-index:150;font-family:Orbitron,sans-serif;letter-spacing:0.1em;' +
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

    /** Circular tactical minimap — terrain throttled, entities every frame */
    drawMinimap(player, world, enemies, resources, allies) {
      const ctx = this.minimapCtx;
      const w = this.els.minimap.width;
      const h = this.els.minimap.height;
      const cx = w / 2;
      const cy = h / 2;
      const scale = 1.1;
      const px = player.object.position.x;
      const pz = player.object.position.z;
      const now = performance.now();
      const moved =
        !this._mmLastPos ||
        Math.abs(px - this._mmLastPos.x) > 1.5 ||
        Math.abs(pz - this._mmLastPos.z) > 1.5;
      const needTerrain = !this._mmTerrain || moved || now - (this._mmTerrainAt || 0) > 500;

      if (needTerrain) {
        if (!this._mmTerrain) {
          this._mmTerrain = document.createElement('canvas');
          this._mmTerrain.width = w;
          this._mmTerrain.height = h;
        }
        const tctx = this._mmTerrain.getContext('2d');
        tctx.clearRect(0, 0, w, h);
        tctx.fillStyle = '#0c1018';
        tctx.fillRect(0, 0, w, h);
        tctx.save();
        tctx.beginPath();
        tctx.arc(cx, cy, w / 2 - 1, 0, Math.PI * 2);
        tctx.clip();

        const radius = 28;
        const AIR = global.VF.BLOCK.AIR;
        const WATER = global.VF.BLOCK.WATER;
        for (let dz = -radius; dz < radius; dz += 3) {
          for (let dx = -radius; dx < radius; dx += 3) {
            if (dx * dx + dz * dz > radius * radius) continue;
            const wx = Math.floor(px + dx);
            const wz = Math.floor(pz + dz);
            if (wx < 0 || wz < 0 || wx >= world.worldSize || wz >= world.worldSize) continue;
            let gy = world.groundY ? world.groundY[wz * world.worldSize + wx] : 0;
            if (gy < 1) gy = 4;
            let t = world.get(wx, gy, wz);
            if (t === AIR) t = world.get(wx, gy - 1, wz);
            let col = '#3a4a30';
            const layout = global.VF && global.VF.IslandConquestMap;
            if (layout && layout.isWater && layout.isWater(wx, wz, world.worldSize)) col = '#8ed6ec';
            else if (t === WATER) col = '#1a4a6a';
            else if (t === global.VF.BLOCK.ROAD || t === global.VF.BLOCK.ASPHALT) col = '#22252a';
            else if (t === global.VF.BLOCK.METAL) col = '#6a9ccc';
            else if (t === global.VF.BLOCK.BRICK) col = '#8a3a2a';
            else if (t === global.VF.BLOCK.PLASTER) col = '#c8c0b0';
            else if (t === global.VF.BLOCK.ROOF) col = '#5a4030';
            else if (t === global.VF.BLOCK.GRASS) col = '#3d6b2e';
            else if (t === global.VF.BLOCK.CONCRETE || t === global.VF.BLOCK.STONE) col = '#4a4e54';
            else if (t === global.VF.BLOCK.RUST) col = '#6a3a20';
            tctx.fillStyle = col;
            tctx.fillRect(cx + dx * scale, cy + dz * scale, 3, 3);
          }
        }
        tctx.restore();
        this._mmTerrainAt = now;
        this._mmLastPos = { x: px, z: pz };
      }

      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(this._mmTerrain, 0, 0);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, w / 2 - 1, 0, Math.PI * 2);
      ctx.clip();

      if (world._allyBasePos) {
        const ab = world._allyBasePos;
        ctx.fillStyle = '#33aaff';
        ctx.beginPath();
        ctx.arc(cx + (ab.x - px) * scale, cy + (ab.z - pz) * scale, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (world._enemyBasePos) {
        const eb = world._enemyBasePos;
        ctx.fillStyle = '#ff3344';
        ctx.beginPath();
        ctx.arc(cx + (eb.x - px) * scale, cy + (eb.z - pz) * scale, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }

      if (world._spawnPoints && world._spawnPoints.all) {
        for (let i = 0; i < world._spawnPoints.all.length; i++) {
          const s = world._spawnPoints.all[i];
          const mx = cx + (s.x - px) * scale;
          const my = cy + (s.z - pz) * scale;
          if (mx < 4 || my < 4 || mx > w - 4 || my > h - 4) continue;
          ctx.fillStyle = s.team === 'ally' ? '#4aa3ff' : '#ff5566';
          ctx.beginPath();
          ctx.arc(mx, my, s.id === world._selectedSpawnId ? 3.5 : 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      const cFlags = world._conquestFlags || world._kitFlags;
      if (cFlags && cFlags.length) {
        const pTeam = this._playerTeam();
        for (let i = 0; i < cFlags.length; i++) {
          const f = cFlags[i];
          const mx = cx + (f.x - px) * scale;
          const my = cy + (f.z - pz) * scale;
          if (mx < 4 || my < 4 || mx > w - 4 || my > h - 4) continue;
          const kind = this._cqFlagKind(f, pTeam);
          ctx.beginPath();
          if (kind === 'foe') {
            ctx.save();
            ctx.translate(mx, my);
            ctx.rotate(Math.PI / 4);
            ctx.fillStyle = '#ff5566';
            ctx.fillRect(-3, -3, 6, 6);
            ctx.restore();
          } else if (kind === 'neutral') {
            ctx.strokeStyle = '#e8e4dc';
            ctx.lineWidth = 1.4;
            ctx.arc(mx, my, 4.2, 0, Math.PI * 2);
            ctx.stroke();
          } else {
            ctx.fillStyle = kind === 'contest' ? '#ffe08a' : '#4aa3ff';
            ctx.arc(mx, my, 4.2, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.fillStyle = kind === 'neutral' ? '#e8e4dc' : '#1a1612';
          ctx.font = 'bold 8px "Segoe UI", "Microsoft YaHei", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(f.letter || '', mx, my + 0.5);
        }
      }

      if (resources) {
        for (let i = 0; i < resources.length; i++) {
          const r = resources[i];
          ctx.fillStyle = r.type === 'core' ? '#7dffc8' : '#c4a574';
          ctx.fillRect(
            cx + (r.mesh.position.x - px) * scale - 1,
            cy + (r.mesh.position.z - pz) * scale - 1,
            3,
            3
          );
        }
      }

      if (allies) {
        for (let i = 0; i < allies.length; i++) {
          const a = allies[i];
          if (!a.alive) continue;
          ctx.fillStyle = a.team === 'ally' ? '#4aa3ff' : '#ff5566';
          ctx.fillRect(
            cx + (a.mesh.position.x - px) * scale - 2,
            cy + (a.mesh.position.z - pz) * scale - 2,
            4,
            4
          );
        }
      }

      if (enemies) {
        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (!e.alive) continue;
          ctx.fillStyle = e.team === 'ally' ? '#4aa3ff' : '#ff5566';
          ctx.fillRect(
            cx + (e.mesh.position.x - px) * scale - 1.5,
            cy + (e.mesh.position.z - pz) * scale - 1.5,
            3,
            3
          );
        }
      }

      // Player — tip matches look / W forward (-sin yaw, -cos yaw)
      ctx.fillStyle = '#ffe8d4';
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fill();
      const yaw = player.yaw;
      const tipX = -Math.sin(yaw) * 8;
      const tipY = -Math.cos(yaw) * 8;
      ctx.strokeStyle = '#ff9a4a';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + tipX, cy + tipY);
      ctx.stroke();

      ctx.restore();
    },
  };

  global.VF = global.VF || {};
  global.VF.UI = UI;
})(window);
