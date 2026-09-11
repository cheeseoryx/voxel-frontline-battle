/**
 * ui.js — HUD updates: vitals, ammo, hotbar, crosshair, minimap, toasts
 */
(function (global) {
  'use strict';

  const UI = {
    _toastTimer: null,

    init() {
      this.els = {
        healthFill: document.getElementById('hp-fill'),
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
        ammoPips: document.getElementById('ammo-pips'),
        ammoMags: document.getElementById('ammo-mags'),
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
        spawnCancel: document.getElementById('spawn-cancel-btn'),
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
      this.selectedClassId = null;
      this._lastHp = 100;
      this._deathHandlers = { onRedeploy: null, onHub: null };
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
      if (this.syncBuildHud) this.syncBuildHud();
      if (this.syncHotbarLayout) this.syncHotbarLayout();
      if (this.syncWeaponLocks) this.syncWeaponLocks();
      if (global.VF && global.VF.syncGameBackBtn) global.VF.syncGameBackBtn();
    },

    /**
     * 部署核 / 掩体建材 only exist where building does, i.e. 核心攻防. Every other
     * mode already refuses to build, so the counters were dead chrome there.
     */
    syncBuildHud() {
      const GM = global.VF.GameModes;
      const building = !GM || !GM.param || GM.param('building', true) !== false;
      const res = document.getElementById('resources');
      if (res) res.classList.toggle('hidden', !building);
    },

    hideHud() {
      if (this.els.hud) this.els.hud.classList.add('hidden');
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
        // Reclaim the anchor: 死斗's mirrored score bar leaves some fills at
        // 'right center', which would flip a core HP bar reusing these nodes.
        fills[i].style.transformOrigin = 'left center';
      }
    },

    updateVitals(hp, armor) {
      const p = global.VF.game && global.VF.game.player;
      const maxHp = Math.max(1, (p && p.maxHealth) || 100);
      const maxAr = Math.max(1, (p && p.maxArmor) || 100);
      const h = Math.max(0, Math.round(hp));
      const a = armor != null ? Math.round(armor) : null;
      if (h === this._cachedHp && a === this._cachedArmor &&
          maxHp === this._cachedMaxHp && maxAr === this._cachedMaxAr) return;
      this._cachedHp = h;
      this._cachedArmor = a;
      this._cachedMaxHp = maxHp;
      this._cachedMaxAr = maxAr;

      if (this.els.hpNum) this.els.hpNum.textContent = h;
      if (this.els.healthFill) {
        this.els.healthFill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, h / maxHp)) + ')';
      }
      const hpTrack = this.els.healthFill && this.els.healthFill.parentElement;
      if (hpTrack) {
        const pct = h / maxHp;
        hpTrack.classList.toggle('hp-mid', pct > 0.3 && pct <= 0.6);
        hpTrack.classList.toggle('hp-low', pct <= 0.3);
      }

      if (a != null && this.els.armorNum) this.els.armorNum.textContent = a;
      if (this.els.armorFill && a != null) {
        this.els.armorFill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, a / maxAr)) + ')';
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

    updateAmmo(mag, reserve, magSize) {
      const wrap = document.getElementById('ammo');
      const melee = mag == null;
      if (mag != null && (magSize == null || magSize <= 0)) {
        const wpn = global.VF.game && global.VF.game.weapons;
        const def = wpn && wpn.getDef && wpn.getDef();
        if (def && !def.melee && def.magSize) magSize = def.magSize;
      }
      if (wrap) {
        wrap.classList.toggle('melee', melee);
        wrap.classList.toggle('throw', arguments[3] === 'throw');
      }
      if (melee) {
        if (this.els.ammoMag) this.els.ammoMag.textContent = '近战';
        if (this.els.ammoReserve) this.els.ammoReserve.textContent = '0';
        this._fillAmmoPips(0, 0, 0);
        this._fillAmmoMags(0, 0);
        this.syncLoadoutAmmo();
        return;
      }
      if (arguments[3] === 'throw') {
        if (this.els.ammoMag) this.els.ammoMag.textContent = mag;
        if (this.els.ammoReserve) this.els.ammoReserve.textContent = '0';
        this._fillAmmoPips(0, 0, 0);
        this._fillAmmoMags(0, 0);
        this.syncLoadoutAmmo();
        return;
      }
      if (this.els.ammoMag) this.els.ammoMag.textContent = mag;
      if (this.els.ammoReserve) this.els.ammoReserve.textContent = Math.max(0, reserve | 0);
      this._fillAmmoPips(mag, reserve, magSize || mag);
      this._fillAmmoMags(reserve, magSize || mag);
      this.syncLoadoutAmmo();
    },

    _fillAmmoPips(mag, reserve, magSize) {
      const magEl = this.els.ammoPips;
      if (!magEl) return;
      mag = Math.max(0, mag | 0);
      magSize = Math.max(0, magSize | 0);
      const tallyMax = 50;
      let ticks = mag;
      if (magSize > tallyMax) {
        ticks = Math.round((mag / magSize) * tallyMax);
      } else if (ticks > tallyMax) {
        ticks = tallyMax;
      }
      if (magEl.childNodes.length !== ticks) {
        magEl.innerHTML = '';
        for (let i = 0; i < ticks; i++) magEl.appendChild(document.createElement('span'));
      }
    },

    _fillAmmoMags(reserve, magSize) {
      const el = this.els.ammoMags;
      if (!el) return;
      const slots = 6;
      if (el.childNodes.length !== slots) {
        el.innerHTML = '';
        for (let i = 0; i < slots; i++) el.appendChild(document.createElement('i'));
      }
      reserve = Math.max(0, reserve | 0);
      magSize = Math.max(0, magSize | 0);
      const extra = magSize > 0 ? Math.ceil(reserve / magSize) : 0;
      const shown = Math.min(slots, extra);
      for (let i = 0; i < slots; i++) {
        el.childNodes[i].className = i < shown ? 'on' : 'off';
      }
    },

    syncLoadoutAmmo() {
      const w = global.VF.game && global.VF.game.weapons;
      const defs = global.VF.WEAPONS || {};
      const E = global.VF.Economy;
      const T = global.VF.Throwables;
      const slots = this.els.hotbarSlots;
      if (!slots) return;
      slots.forEach(function (el) {
        const ammoEl = el.querySelector('.slot-ammo');
        if (!ammoEl) return;
        const slot = el.dataset.slot;
        if (slot === '3') {
          ammoEl.textContent = '—';
          return;
        }
        if (slot === 'throw') {
          const left = T && T.remaining ? T.remaining() : 0;
          ammoEl.textContent = String(left);
          return;
        }
        if (slot === '4' || slot === '5') {
          ammoEl.textContent = '';
          return;
        }
        const n = Number(slot);
        if (n < 1 || n > 2 || !w) return;
        const id = (E && E.weaponForSlot ? E.weaponForSlot(n) : null) || (n === 1 ? 'ar' : 'sg');
        const st = w.state && w.state[id];
        if (!st) {
          ammoEl.textContent = '';
          return;
        }
        ammoEl.textContent = st.mag + '/' + st.reserve;
      });
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
      const classId = info.classId || 'vanguard';
      hud.classList.toggle('skill-vanguard', classId === 'vanguard');
      hud.classList.toggle('skill-medic', classId === 'medic');
      hud.classList.toggle('skill-ghost', classId === 'ghost');
      hud.classList.toggle('skill-juggernaut', classId === 'juggernaut');
      hud.classList.toggle('skill-raider', classId === 'raider');
      hud.classList.toggle('skill-engineer', classId === 'engineer');

      // Swap icons
      hud.querySelectorAll('[data-skill-icon]').forEach(function (el) {
        el.classList.toggle('hidden', el.getAttribute('data-skill-icon') !== classId);
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
          classId === 'medic'
            ? '修复装置 — 按住 G 选择地面位置，松手部署（CD 15s）'
            : classId === 'ghost'
              ? '隐身 — 按 G 进入隐形 6s，移速+30%（CD 28s）；破隐后首枪+40'
              : classId === 'juggernaut'
                ? '防暴盾 — 按 G 展开能量盾（280耐久·8s·移速-35%·CD24s）'
                : classId === 'raider'
                  ? '电磁脉冲 — 按 G 向前方60°圆锥发射（28m·核心12×12×6·CD30s）'
                  : classId === 'engineer'
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
          classId === 'medic'
            ? '被动：开局获得 50 护盾'
            : classId === 'ghost'
              ? '被动：从背后攻击敌人时伤害 +30%'
              : classId === 'juggernaut'
                ? '被动：受到的子弹伤害 -6%'
                : classId === 'raider'
                  ? '被动：击杀敌人或破坏防御建筑时额外掉落 30% 备弹与物料'
                  : classId === 'engineer'
                    ? '被动：放置的建筑耐久 +50% · 开局 20 物料'
                    : '被动：切枪/换弹+15% · C4起爆移速+20%·3s';
        passive.classList.toggle('buffed', !!info.speedBuff || !!info.ambushReady);
        passive.classList.toggle('has-shield', !!info.passiveShield && classId === 'medic');
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
        } else if (info.speedBuff && info.buffTime > 0 && classId !== 'juggernaut') {
          pTime.classList.remove('hidden');
          pNum.textContent = info.buffTime.toFixed(1);
        } else if (info.ambushReady) {
          pTime.classList.remove('hidden');
          pNum.textContent = '+40';
        } else if (info.passiveShield && info.shieldAmount && classId === 'medic') {
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

    /**
     * Center match clock arbitration: whoever owns the clock (死斗 / 爆破 via
     * their own HUD sync) claims it here so generic wave / PVP match-time writers
     * yield. This makes the round/bomb countdown the single source of truth and
     * removes the count-up vs. countdown flicker on #timer regardless of mode-id
     * sync timing or which client (host/guest) is writing.
     */
    claimClock(owner) {
      this._clockOwner = owner;
    },

    releaseClock(owner) {
      if (this._clockOwner === owner) this._clockOwner = null;
    },

    updateWave(wave, seconds) {
      if (this._clockOwner) return;
      const sec = Math.floor(seconds);
      if (wave === this._cachedWave && sec === this._cachedWaveSec) return;
      this._cachedWave = wave;
      this._cachedWaveSec = sec;
      if (this.els.waveNum) this.els.waveNum.textContent = wave;
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      if (this.els.timer) {
        this.els.timer.textContent =
          String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      }
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

    /** Top-center bars: left=蓝方, right=红方 (fixed colors) */
    setMissionTargetLabel(label) {
      this._missionTargetLabel = label || '红方核心';
    },

    setHomeCoreLabel(label) {
      this._homeCoreLabel = label || '蓝方核心';
    },

    updateMissionCore(hp, max) {
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
      const self = this;
      const reveal = function () {
        self._revealVictory(title, sub);
      };
      if (global.VF.WeaponInspect && global.VF.WeaponInspect.play) {
        global.VF.WeaponInspect.play(reveal);
      } else {
        reveal();
      }
    },

    _revealVictory(title, sub) {
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

    /** Gray-white fallen-camera look. Does not touch HUD chrome. */
    _setDeathWorldLook(on) {
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
          fog: { enabled: true, near: 8, far: 110, color: '#c8c8cc' },
          volumetricFog: {
            density: 0.018,
            color: '#c4c6c8',
            maxDistance: 140,
            sunStrength: 0.8,
          },
          lighting: {
            sunIntensity: 0.42,
            ambientIntensity: 0.4,
            fillIntensity: 0.1,
          },
          sky: {
            zenithColor: '#b4b6b8',
            horizonColor: '#d0d2d4',
            groundColor: '#3a3a3a',
            sunIntensity: 0.25,
            hdriIntensity: 0.28,
          },
        };
      } else if (global.VF) {
        global.VF.RenderGameplay = null;
      }
      if (canvas) canvas.classList.toggle('downed-world', !!on && !pipelineOn);
    },

    /** @param {{autoRespawn?: boolean}} [opts] hides 重新部署 for timed respawns */
    showDeath(title, sub, flavor, opts) {
      if (this.els.deathSub) {
        this.els.deathSub.textContent = sub || '血量耗尽 · 等待重新部署';
      }
      if (this.els.deathFlavor) {
        this.els.deathFlavor.textContent = flavor || '选个出生点再上！';
      }
      const redeployBtn = document.getElementById('death-btn');
      if (redeployBtn) {
        redeployBtn.classList.toggle('hidden', !!(opts && opts.autoRespawn));
      }
      if (this.els.deathOverlay) {
        const h1 = this.els.deathOverlay.querySelector('h1');
        if (h1) h1.textContent = title || '你已阵亡';
        this.els.deathOverlay.classList.remove('hidden');
      }
      this._setDeathWorldLook(true);
      document.exitPointerLock && document.exitPointerLock();
    },

    hideDeath() {
      if (this.els.deathOverlay) this.els.deathOverlay.classList.add('hidden');
      this._setDeathWorldLook(false);
    },

    setHotbarSlot(slotNum) {
      const key = String(slotNum);
      this.els.hotbarSlots.forEach((el) => {
        el.classList.toggle('active', String(el.dataset.slot) === key);
      });
    },

    /**
     * Which hotbar slots a mode actually has. The knife only exists where
     * building is off (死斗 / 混战 / 爆破), the build pair only in 核心攻防, and
     * 枪械模式 hands out guns by progression so it has neither.
     */
    syncHotbarLayout() {
      const GM = global.VF.GameModes;
      const building = !GM || !GM.param || GM.param('building', true) !== false;
      const M = global.VF.Melee;
      const knife = !!(M && M.available && M.available());
      const show = function (sel, on) {
        const el = document.querySelector('#hotbar .slot[data-slot="' + sel + '"]');
        if (el) el.classList.toggle('hidden', !on);
      };
      show('3', knife);
      show('4', building);
      show('5', building);
      this.syncThrowSlot();
    },

    /**
     * Q slot mirrors the throwable the arsenal picked, plus what is left. Owns
     * its own visibility because Throwables activates after the mode UI has
     * already laid the bar out.
     */
    syncThrowSlot() {
      const el = document.querySelector('#hotbar .slot[data-slot="throw"]');
      if (!el) return;
      const T = global.VF.Throwables;
      const id = T && T.equipped ? T.equipped() : null;
      el.classList.toggle('hidden', !id);
      if (!id) return;
      const def = global.VF.THROWABLE_CATALOG ? global.VF.THROWABLE_CATALOG[id] : null;
      const label = def ? def.nameZh || def.name || id : id;
      const name = el.querySelector('.slot-name');
      if (name) name.textContent = label;
      el.title = label + ' (Q)';
      const left = T.remaining ? T.remaining() : 0;
      el.classList.toggle('locked', left <= 0);
      const ammoEl = el.querySelector('.slot-ammo');
      if (ammoEl) ammoEl.textContent = String(left);
    },

    syncWeaponLocks() {
      if (!this.els.hotbarSlots) return;
      // 枪械模式的枪是按进度发的，不是商城买的——别把序列里的枪显示成未解锁
      const GM = global.VF.GameModes;
      const gg = !!(GM && GM.isGg && GM.isGg());
      const owns = function (id) {
        if (gg) return true;
        if (!global.VF.Economy || !global.VF.Economy.ownsWeapon) return true;
        return global.VF.Economy.ownsWeapon(id);
      };
      // Slots 1–2 show whatever the arsenal assigned, so the label has to follow.
      const E = global.VF.Economy;
      const defs = global.VF.WEAPONS || {};
      const legacy = { 1: 'ar', 2: 'sg' };
      this.els.hotbarSlots.forEach((el) => {
        const slot = Number(el.dataset.slot);
        if (slot !== 1 && slot !== 2) return;
        const id = (E && E.weaponForSlot ? E.weaponForSlot(slot) : null) || legacy[slot];
        const def = defs[id];
        if (slot > 1) el.classList.toggle('locked', !owns(id));
        if (!def) return;
        const label = el.querySelector('.slot-name');
        if (label) label.textContent = def.ammoLabel || def.nameZh || def.name;
        el.title = (def.nameZh || def.name) + ' (' + slot + ')';
      });
      this.syncLoadoutAmmo();
    },

    /**
     * ADS / scope UI.
     * @param {boolean} aiming
     * @param {string} [scopeType] 'sniper' | 'optic' | 'holo' | null
     * @param {number} [blend] 0..1 ads blend
     */
    setAiming(aiming, scopeType, blend) {
      blend = blend != null ? blend : aiming ? 1 : 0;
      const showScope = aiming && scopeType === 'sniper' && blend > 0.62;
      if (this.els.crosshair) {
        this.els.crosshair.classList.toggle('ads', blend > 0.18 && !showScope);
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
     * Crosshair shot feedback with bloom → spring settle.
     * - 'fire': default 十 scales (miss — no color change)
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
      return this.inventoryOpen;
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
        towerOpen ||
        rangeOpen
      );
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
      const bodyH = 2.18; // Shared presentation framing.
      cam.fov = 40;
      cam.aspect = aspect;
      const vFov = THREE.MathUtils.degToRad(cam.fov);
      let dist = (bodyH * 0.5) / Math.tan(vFov * 0.5);
      // Keep full height when panel is wide; when tall, still fit height
      dist *= 1.06;
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
          model.rotation.set(0, Math.PI + (this._menuRotation || 0.12) + Math.sin(t * 0.45) * 0.025, 0);
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
    _drawSpawnMarkers(ctx, world, toMap, opts) {
      opts = opts || {};
      const points = world._spawnPoints && world._spawnPoints.all;
      if (!points) return;
      const selectedId = world._selectedSpawnId;
      const teamFilter = opts.teamFilter || null;
      const r = opts.radius != null ? opts.radius : 6;
      const showLabel = opts.label !== false;
      for (let i = 0; i < points.length; i++) {
        const s = points[i];
        const lockedOut = teamFilter && s.team !== teamFilter;
        const p = toMap(s.x, s.z);
        const selected = s.id === selectedId && !lockedOut;
        ctx.globalAlpha = lockedOut ? 0.28 : 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, selected ? r + 2 : r, 0, Math.PI * 2);
        ctx.fillStyle = s.team === 'ally' ? '#4aa3ff' : '#ff5566';
        ctx.fill();
        if (selected) {
          ctx.strokeStyle = '#ffe8d4';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        if (showLabel && !lockedOut) {
          ctx.fillStyle = '#ffe8d4';
          ctx.font = (opts.fontSize || 10) + 'px Zpix, monospace';
          ctx.fillText(s.label, p.x - 8, p.y - r - 4);
        }
        ctx.globalAlpha = 1;
      }
    },

    openSpawnSelect(world, onConfirm, onCancel) {
      if (!this.els.spawnOverlay) return;
      this.spawnSelectOpen = true;
      this._spawnOnConfirm = onConfirm;
      this._spawnOnCancel = onCancel;
      this.els.spawnOverlay.classList.remove('hidden');
      this._buildSpawnButtons(world);
      this._syncTeamPickUi(world);
      this.drawSpawnSelectMap(world);
      this._bindSpawnSelectOnce(world);
      this._syncSpawnConfirm();
    },

    closeSpawnSelect() {
      this.spawnSelectOpen = false;
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
      if (this.els.spawnGroupAlly) {
        this.els.spawnGroupAlly.classList.toggle('locked', team !== 'ally');
      }
      if (this.els.spawnGroupEnemy) {
        this.els.spawnGroupEnemy.classList.toggle('locked', team !== 'enemy');
      }
    },

    _buildSpawnButtons(world) {
      const allyRow = this.els.spawnBtnsAlly;
      const enemyRow = this.els.spawnBtnsEnemy;
      if (!allyRow || !enemyRow || !world._spawnPoints) return;
      allyRow.innerHTML = '';
      enemyRow.innerHTML = '';
      const makeBtn = (s) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'spawn-pick ' + s.team + (s.id === world._selectedSpawnId ? ' selected' : '');
        btn.dataset.spawnId = s.id;
        btn.dataset.team = s.team;
        btn.textContent = s.label;
        btn.addEventListener('click', () => {
          if (!world._playerTeam || world._playerTeam !== s.team) return;
          world.setSelectedSpawn(s.id);
          this._refreshSpawnSelection(world);
        });
        return btn;
      };
      world._spawnPoints.ally.forEach((s) => allyRow.appendChild(makeBtn(s)));
      world._spawnPoints.enemy.forEach((s) => enemyRow.appendChild(makeBtn(s)));
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
      this.els.spawnConfirm.disabled = !(
        world &&
        world._playerTeam &&
        world.getSelectedSpawn()
      );
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
          if (!w || !w._spawnPoints || !w._playerTeam) return;
          const rect = canvas.getBoundingClientRect();
          const mx = ((e.clientX - rect.left) / rect.width) * canvas.width;
          const my = ((e.clientY - rect.top) / rect.height) * canvas.height;
          const size = w.worldSize;
          const wx = (mx / canvas.width) * size;
          const wz = (my / canvas.height) * size;
          let best = null;
          let bestD = Infinity;
          for (let i = 0; i < w._spawnPoints.all.length; i++) {
            const s = w._spawnPoints.all[i];
            if (s.team !== w._playerTeam) continue;
            const dx = s.x - wx;
            const dz = s.z - wz;
            const d = dx * dx + dz * dz;
            if (d < bestD) {
              bestD = d;
              best = s;
            }
          }
          if (best && bestD < 22 * 22) {
            w.setSelectedSpawn(best.id);
            this._refreshSpawnSelection(w);
          }
        });
      }
      if (this.els.spawnConfirm) {
        this.els.spawnConfirm.addEventListener('click', (e) => {
          e.stopPropagation();
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

    drawSpawnSelectMap(world) {
      const canvas = this.els.spawnMap;
      const ctx = this.spawnMapCtx;
      if (!canvas || !ctx || !world) return;
      const w = canvas.width;
      const h = canvas.height;
      const size = world.worldSize;
      const sx = w / size;
      const sy = h / size;
      const terrain = this._ensureWorldMapCache(world);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(terrain, 0, 0, w, h);
      ctx.strokeStyle = 'rgba(255, 154, 74, 0.45)';
      ctx.lineWidth = 3;
      ctx.strokeRect(1.5, 1.5, w - 3, h - 3);

      const toMap = (wx, wz) => ({ x: wx * sx, y: wz * sy });

      if (world._allyBasePos) {
        const p = toMap(world._allyBasePos.x, world._allyBasePos.z);
        ctx.fillStyle = '#33aaff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (world._enemyBasePos) {
        const p = toMap(world._enemyBasePos.x, world._enemyBasePos.z);
        ctx.fillStyle = '#ff3344';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill();
      }

      this._drawSpawnMarkers(ctx, world, toMap, {
        radius: 7,
        fontSize: 11,
        teamFilter: world._playerTeam || null,
      });
    },

    /** Build a downsampled full-world terrain cache (once) */
    _ensureWorldMapCache(world) {
      if (this._worldMapCache && this._worldMapCacheSize === world.worldSize) {
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
          const c = colorOf(t);
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
      return canvas;
    },

    /** Force rebuild of full-world tactical map terrain cache (after map edits). */
    invalidateWorldMapCache() {
      this._worldMapCache = null;
      this._worldMapCacheSize = 0;
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
            if (t === WATER) col = '#1a4a6a';
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
            cx + (a.mesh.position.x - px) * scale - 1.5,
            cy + (a.mesh.position.z - pz) * scale - 1.5,
            3,
            3
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
