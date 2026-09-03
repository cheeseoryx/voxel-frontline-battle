/**
 * arsenal.js — Battlefield / Battlebit-inspired loadout inspect screen.
 * Opened from deploy, class select, soldier menu, and loadout customize strips.
 */
(function (global) {
  'use strict';

  const DEFAULT_LOADOUT = {
    primary: 'ar',
    secondary: 'm9',
    attachment1: 'holo',
    attachment2: 'stock',
    grenade: 'smoke',
    melee: 'knife',
  };

  const SLOTS = [
    { id: 'primary', title: '选择主要武器', label: '主要武器' },
    { id: 'secondary', title: '选择副武器', label: '副武器' },
    { id: 'attachment1', title: '选择配件 1', label: '配件 1' },
    { id: 'attachment2', title: '选择配件 2', label: '配件 2' },
    { id: 'grenade', title: '选择手雷', label: '手雷' },
    { id: 'melee', title: '选择近战', label: '近战' },
  ];

  const CATEGORY_TABS = [
    { id: 'all', label: '全部' },
    { id: 'assault', label: '突击步枪' },
    { id: 'carbine', label: '卡宾枪' },
    { id: 'smg', label: '冲锋枪' },
    { id: 'battle', label: '战斗步枪' },
    { id: 'lmg', label: '轻机枪' },
    { id: 'dmr', label: '精确射手' },
    { id: 'sniper', label: '狙击步枪' },
    { id: 'shotgun', label: '霰弹枪' },
    { id: 'launcher', label: '发射器' },
  ];

  const CATEGORY_META = {
    assault: {
      label: '突击步枪',
      tags: ['多用途', '中距离', '稳定射速'],
      flavor: '优雅弹道',
      blurb: '平衡伤害、射速与后坐，适合绝大多数步兵交火。',
    },
    battle: {
      label: '战斗步枪',
      tags: ['高伤害', '中距离', '穿透'],
      flavor: '重口径',
      blurb: '更大口径换取单发杀伤，连发时需要更克制的点射。',
    },
    carbine: {
      label: '卡宾枪',
      tags: ['机动', '中近距离', '全自动'],
      flavor: '灵活推进',
      blurb: '比步枪更短、更轻，适合巷战与快速转火。',
    },
    smg: {
      label: '冲锋枪',
      tags: ['高射速', '近距离', '腰射'],
      flavor: '近战压制',
      blurb: '极高射速与出色腰射，离开近距离后伤害迅速衰减。',
    },
    lmg: {
      label: '轻机枪',
      tags: ['弹容量', '火力压制', '持续射击'],
      flavor: '火力覆盖',
      blurb: '大容量弹匣用于封锁通道，机动性与起枪速度较差。',
    },
    dmr: {
      label: '精确射手步枪',
      tags: ['精确', '中远距离', '半自动'],
      flavor: '点名射手',
      blurb: '中远距离精确点射，换取更低的容错与近战机动。',
    },
    sniper: {
      label: '狙击步枪',
      tags: ['高伤害', '远距离', '栓动'],
      flavor: '一击决胜',
      blurb: '远距离高伤害，换弹与拉栓间隔长，需要预判与站位。',
    },
    shotgun: {
      label: '霰弹枪',
      tags: ['近距离', '多弹丸', '爆发'],
      flavor: '近距清算',
      blurb: '近距离毁灭性弹丸，距离稍远即迅速失能。',
    },
    pistol: {
      label: '手枪',
      tags: ['副武器', '应急', '轻便'],
      flavor: '最后手段',
      blurb: '主武器空仓时的应急火力，拔枪快、杀伤有限。',
    },
    launcher: {
      label: '发射器',
      tags: ['反装甲', '高爆', '工程兵'],
      flavor: '破甲一击',
      blurb: '反载具与工事破坏，对步兵容错低且备弹极少。',
    },
  };

  const ATTACHMENTS_1 = [
    {
      id: 'iron',
      name: '机械瞄具',
      kind: 'optic',
      flavor: '最快获取',
      desc: '无额外倍率，瞄准最快，适合近距离与高机动交火。',
    },
    {
      id: 'holo',
      name: '全息瞄具',
      kind: 'optic',
      flavor: '清晰窗景',
      desc: '中近距离快速获取目标，视野开阔、遮挡少。',
    },
    {
      id: 'optic',
      name: '光学瞄具',
      kind: 'optic',
      flavor: '中距锁定',
      desc: '中距离精确射击，适合点射与点名射手角色。',
    },
    {
      id: 'sniper',
      name: '狙击镜',
      kind: 'optic',
      flavor: '远距观察',
      desc: '高倍率远距离观察与精确瞄准，近战视野受限。',
    },
  ];

  const ATTACHMENTS_2 = [
    {
      id: 'stock',
      name: '原厂枪口',
      kind: 'muzzle',
      flavor: '出厂配置',
      desc: '保持出厂后坐、焰口与枪声，无额外惩罚。',
    },
    {
      id: 'compensator',
      name: '制退器',
      kind: 'muzzle',
      flavor: '压后坐',
      desc: '抑制垂直后坐，连发更稳，枪声与焰口保持明显。',
    },
    {
      id: 'suppressor',
      name: '消音器',
      kind: 'muzzle',
      flavor: '隐蔽射击',
      desc: '降低枪声传播距离，便于侧翼渗透，略增枪管长度。',
    },
  ];

  const GRENADES = [
    {
      id: 'frag',
      name: '破片手榴弹',
      kind: 'grenade',
      flavor: '范围杀伤',
      desc: '延时爆炸并造成范围破片伤害，适合清房与抛投死角。',
    },
    {
      id: 'impact',
      name: '冲击手榴弹',
      kind: 'grenade',
      flavor: '碰炸',
      desc: '碰撞后立即引爆，适合点杀掩体后的目标。',
    },
    {
      id: 'smoke',
      name: '白色烟雾弹',
      kind: 'grenade',
      flavor: '遮断视线',
      desc: '遮断视线并掩护小队推进或复活倒地队友。',
      gameId: 'smoke',
    },
    {
      id: 'flash',
      name: '闪光弹',
      kind: 'grenade',
      flavor: '致盲干扰',
      desc: '短暂致盲并干扰附近敌军，为突入创造窗口。',
    },
  ];

  const MELEE = [
    {
      id: 'knife',
      name: '战斗刀',
      kind: 'knife',
      flavor: '标准近战',
      desc: '步兵标准近战武器，无声、快速，用于最后近身。',
    },
    {
      id: 'bayonet',
      name: '刺刀',
      kind: 'knife',
      flavor: '枪下加刃',
      desc: '加装于步枪的近战刃，突刺距离略长。',
    },
  ];

  const HEADLINE = [
    { key: 'damage', label: '伤害', better: 'higher' },
    { key: 'fireRate', label: '射速', better: 'higher' },
    { key: 'magSize', label: '弹匣', better: 'higher' },
  ];

  const BARS = [
    { key: 'hipfire', label: '腰射', better: 'higher' },
    { key: 'accuracy', label: '精准度', better: 'higher' },
    { key: 'controlScore', label: '控制', better: 'higher' },
    { key: 'mobility', label: '机动性', better: 'higher' },
  ];

  const DETAIL_KEYS = [
    { key: 'damage', label: '伤害', better: 'higher', max: 80 },
    { key: 'verticalRecoil', label: '垂直后坐力', better: 'lower', max: 6 },
    { key: 'horizontalRecoil', label: '横向后坐力', better: 'lower', max: 5 },
    { key: 'muzzleVelocity', label: '枪口初速', better: 'higher', max: 1400 },
    { key: 'accuracy', label: '准确度', better: 'higher', max: 100 },
    { key: 'fireRate', label: '射速', better: 'higher', max: 1200 },
    { key: 'adsTime', label: '瞄准耗时', better: 'lower', max: 0.5 },
    { key: 'runSpeed', label: '奔跑速度', better: 'higher', max: 1.2 },
    { key: 'reloadTime', label: '换弹时间', better: 'lower', max: 7 },
    { key: 'switchSpeed', label: '切换速度', better: 'higher', max: 2 },
  ];

  function els() {
    return {
      overlay: document.getElementById('arsenal-overlay'),
      back: document.getElementById('arsenal-back'),
      title: document.getElementById('arsenal-title'),
      slots: document.getElementById('arsenal-slots'),
      tags: document.getElementById('arsenal-tags'),
      name: document.getElementById('arsenal-name'),
      flavor: document.getElementById('arsenal-flavor'),
      desc: document.getElementById('arsenal-desc'),
      equip: document.getElementById('arsenal-equip'),
      equipLabel: document.getElementById('arsenal-equip-label'),
      canvas: document.getElementById('arsenal-canvas'),
      fallback: document.getElementById('arsenal-stage-fallback'),
      cats: document.getElementById('arsenal-cats'),
      list: document.getElementById('arsenal-list'),
      headline: document.getElementById('arsenal-headline'),
      bars: document.getElementById('arsenal-bars'),
      detail: document.getElementById('arsenal-detail'),
      falloff: document.getElementById('arsenal-falloff'),
    };
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function weapons() {
    return (global.VF && global.VF.WEAPONS) || {};
  }

  function classId() {
    const g = global.VF && global.VF.game;
    const ui = global.VF && global.VF.UI;
    return (
      (g && g.player && g.player.classId) ||
      (g && g.playerClass) ||
      (ui && ui._loadoutDraftClassId) ||
      (ui && ui.selectedClassId) ||
      'assault'
    );
  }

  function getState() {
    const g = global.VF && global.VF.game;
    const store = g || global.VF;
    if (!store.loadout) {
      store.loadout = Object.assign({}, DEFAULT_LOADOUT);
      if (g && g.preferredWeaponId) store.loadout.primary = g.preferredWeaponId;
      if (g && g.preferredSecondaryId) store.loadout.secondary = g.preferredSecondaryId;
    }
    if (g && g.preferredWeaponId) store.loadout.primary = g.preferredWeaponId;
    if (g && g.preferredSecondaryId) store.loadout.secondary = g.preferredSecondaryId;
    return store.loadout;
  }

  function slotDef(id) {
    for (let i = 0; i < SLOTS.length; i++) {
      if (SLOTS[i].id === id) return SLOTS[i];
    }
    return null;
  }

  function weaponIconKind(id, def) {
    if (global.VF.UI && global.VF.UI._weaponIconKind) {
      return global.VF.UI._weaponIconKind(id, def);
    }
    if (id === 'sg' || (def && def.category === 'shotgun')) return 'shotgun';
    if (id === 'rpg') return 'rpg';
    if (def && def.category === 'pistol') return 'pistol';
    return 'rifle';
  }

  function gearSvg(kind) {
    if (global.VF.UI && global.VF.UI._deployGearSvg) {
      return global.VF.UI._deployGearSvg(kind);
    }
    return '';
  }

  function isOwned(item) {
    if (!item) return false;
    if (item.owned === false) return false;
    if (item.id === 'rpg') return classId() === 'engineer';
    if (item.weapon && global.VF.Economy && global.VF.Economy.ownsWeapon) {
      return !!global.VF.Economy.ownsWeapon(item.id);
    }
    return true;
  }

  function catalogItem(slot, raw) {
    const def = raw.weapon ? weapons()[raw.id] : null;
    const cat = raw.category || (def && def.category) || slot;
    const meta = CATEGORY_META[cat] || {};
    return {
      id: raw.id,
      slot: slot,
      name: raw.name || (def && (def.nameZh || def.name)) || raw.id,
      kind: raw.kind || (def ? weaponIconKind(raw.id, def) : 'rifle'),
      category: cat,
      flavor: raw.flavor || meta.flavor || '',
      desc: raw.desc || meta.blurb || '',
      tags: raw.tags || meta.tags || [],
      weapon: !!raw.weapon || !!def,
      def: def,
      gameId: raw.gameId,
    };
  }

  function staticList(slot) {
    if (slot === 'attachment1') return ATTACHMENTS_1.map(function (row) {
      return catalogItem(slot, row);
    });
    if (slot === 'attachment2') return ATTACHMENTS_2.map(function (row) {
      return catalogItem(slot, row);
    });
    if (slot === 'grenade') return GRENADES.map(function (row) {
      return catalogItem(slot, row);
    });
    if (slot === 'melee') return MELEE.map(function (row) {
      return catalogItem(slot, row);
    });
    return [];
  }

  function weaponList(slot) {
    const defs = weapons();
    const order = (global.VF && global.VF.WEAPON_LOADOUT_ORDER) || [];
    const ids = [];
    const seen = {};
    function push(id) {
      if (!id || seen[id] || !defs[id]) return;
      const def = defs[id];
      const cat = def.category || (id === 'rpg' ? 'launcher' : 'assault');
      const isPistol = cat === 'pistol';
      if (slot === 'primary' && isPistol) return;
      if (slot === 'secondary' && !isPistol) return;
      seen[id] = true;
      ids.push(id);
    }
    if (slot === 'primary') push('ar');
    for (let i = 0; i < order.length; i++) push(order[i]);
    if (slot === 'primary') {
      push('sg');
      push('rpg');
    }
    if (slot === 'secondary') {
      push('m9');
      Object.keys(defs).forEach(function (id) {
        if (defs[id] && defs[id].category === 'pistol') push(id);
      });
    }
    return ids.map(function (id) {
      const def = defs[id];
      const cat = def.category || (id === 'rpg' ? 'launcher' : 'assault');
      const meta = CATEGORY_META[cat] || {};
      return catalogItem(slot, {
        id: id,
        name: def.nameZh || def.name,
        kind: weaponIconKind(id, def),
        category: cat,
        flavor: meta.flavor,
        desc: meta.blurb,
        tags: meta.tags,
        weapon: true,
      });
    });
  }

  function itemsForSlot(slot) {
    if (slot === 'primary' || slot === 'secondary') return weaponList(slot);
    return staticList(slot);
  }

  function findItem(slot, id) {
    const list = itemsForSlot(slot);
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return list[0] || null;
  }

  function derivedStats(def) {
    if (!def) return null;
    const hipfire = Math.max(
      0,
      Math.min(
        100,
        (def.accuracy != null ? def.accuracy : 70) * 0.42 +
          (1.2 - (def.adsTime != null ? def.adsTime : 0.25)) * 38 +
          (def.category === 'smg' || def.category === 'pistol' ? 14 : 0) -
          (def.magSize > 40 ? 8 : 0)
      )
    );
    const controlScore = Math.max(
      0,
      Math.min(
        100,
        (def.control != null ? def.control : 0.8) * 62 +
          (4.2 - (def.verticalRecoil != null ? def.verticalRecoil : 1.4)) * 9
      )
    );
    const mobility = Math.max(
      0,
      Math.min(
        100,
        (def.runSpeed != null ? def.runSpeed : 1) * 52 +
          (1.15 - (def.adsTime != null ? def.adsTime : 0.25)) * 22 +
          (def.switchSpeed != null ? def.switchSpeed : 1) * 12
      )
    );
    return {
      damage: def.damage,
      fireRate: def.fireRate,
      magSize: def.magSize,
      accuracy: def.accuracy,
      hipfire: hipfire,
      controlScore: controlScore,
      mobility: mobility,
      verticalRecoil: def.verticalRecoil,
      horizontalRecoil: def.horizontalRecoil,
      muzzleVelocity: def.muzzleVelocity,
      adsTime: def.adsTime,
      runSpeed: def.runSpeed,
      reloadTime: def.reloadTime,
      switchSpeed: def.switchSpeed,
    };
  }

  function damageAtRange(def, dist) {
    if (!def) return 0;
    const start = def.falloffStart != null ? def.falloffStart : 20;
    const end =
      def.falloffEnd != null
        ? def.falloffEnd
        : Math.max(start + 1, (def.range || 80) * 0.85);
    const minDmg =
      def.minDamage != null
        ? def.minDamage
        : def.damage * (def.minDamageScale != null ? def.minDamageScale : 0.25);
    if (dist <= start) return def.damage;
    if (dist >= end) return minDmg;
    const t = (dist - start) / Math.max(0.01, end - start);
    return def.damage + (minDmg - def.damage) * t;
  }

  function cmpClass(selected, equipped, better) {
    if (selected == null || equipped == null) return 'same';
    const a = Number(selected);
    const b = Number(equipped);
    if (!isFinite(a) || !isFinite(b) || Math.abs(a - b) < 0.005) return 'same';
    const selectedBetter = better === 'lower' ? a < b : a > b;
    return selectedBetter ? 'up' : 'down';
  }

  function formatStat(key, value) {
    if (value == null || !isFinite(value)) return '—';
    if (key === 'adsTime' || key === 'reloadTime' || key === 'runSpeed' || key === 'switchSpeed') {
      return Number(value).toFixed(2);
    }
    if (key === 'verticalRecoil' || key === 'horizontalRecoil') {
      return Number(value).toFixed(2);
    }
    if (key === 'hipfire' || key === 'controlScore' || key === 'mobility' || key === 'accuracy') {
      return String(Math.round(value)).padStart(3, '0');
    }
    return String(Math.round(value));
  }

  function barPct(key, value) {
    const maxes = {
      damage: 80,
      fireRate: 1200,
      magSize: 100,
      hipfire: 100,
      accuracy: 100,
      controlScore: 100,
      mobility: 100,
    };
    const max = maxes[key] || 100;
    return Math.max(0, Math.min(100, (Number(value) / max) * 100));
  }

  const Arsenal = {
    isOpen: false,
    slot: 'primary',
    category: 'all',
    selectedId: null,
    _bound: false,
    _preview: null,

    init() {
      if (this._bound) return;
      const node = els();
      if (!node.overlay) return;
      this._bound = true;
      const self = this;
      if (node.back) {
        node.back.addEventListener('click', function (e) {
          e.preventDefault();
          self.hide();
        });
      }
      if (node.equip) {
        node.equip.addEventListener('click', function (e) {
          e.preventDefault();
          self.equipSelected();
        });
      }
      node.overlay.addEventListener('click', function (e) {
        const tab = e.target.closest('[data-arsenal-tab]');
        if (tab && node.slots && node.slots.contains(tab)) {
          e.preventDefault();
          self.setSlot(tab.getAttribute('data-arsenal-tab'));
          return;
        }
        const cat = e.target.closest('[data-arsenal-cat]');
        if (cat && node.cats && node.cats.contains(cat)) {
          e.preventDefault();
          self.category = cat.getAttribute('data-arsenal-cat') || 'all';
          self.render();
          return;
        }
        const card = e.target.closest('[data-arsenal-item]');
        if (card && node.list && node.list.contains(card)) {
          e.preventDefault();
          self.selectedId = card.getAttribute('data-arsenal-item');
          self.render();
        }
      });
      document.addEventListener(
        'keydown',
        function (e) {
          if (!self.isOpen) return;
          if (e.code === 'Escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            self.hide();
            return;
          }
          if (e.code === 'Space') {
            if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
              return;
            }
            e.preventDefault();
            e.stopImmediatePropagation();
            self.equipSelected();
            return;
          }
          if (e.code === 'KeyQ' || e.code === 'KeyE') {
            const tabs = self._visibleCategories();
            if (tabs.length < 2) return;
            e.preventDefault();
            let idx = 0;
            for (let i = 0; i < tabs.length; i++) {
              if (tabs[i].id === self.category) idx = i;
            }
            idx = e.code === 'KeyE' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
            self.category = tabs[idx].id;
            self.render();
          }
        },
        true
      );
      document.addEventListener('click', function (e) {
        if (self.isOpen) return;
        const slot = e.target.closest('.deploy-gear-slot[data-arsenal-slot]');
        if (!slot) return;
        if (e.target.closest('#arsenal-overlay')) return;
        e.preventDefault();
        e.stopPropagation();
        const ui = global.VF && global.VF.UI;
        if (ui && ui.openArsenal) {
          ui.openArsenal({
            slot: slot.getAttribute('data-arsenal-slot') || 'primary',
            itemId: slot.getAttribute('data-item-id') || '',
          });
        } else {
          self.show({
            slot: slot.getAttribute('data-arsenal-slot') || 'primary',
            itemId: slot.getAttribute('data-item-id') || '',
          });
        }
      });
      global.addEventListener('resize', function () {
        if (self.isOpen) self._resizePreview();
      });
    },

    show(opts) {
      this.init();
      const node = els();
      if (!node.overlay) return;
      opts = opts || {};
      this.isOpen = true;
      if (global.VF.UI) global.VF.UI.arsenalOpen = true;
      const requested = slotDef(opts.slot) ? opts.slot : 'primary';
      this.slot = requested;
      const state = getState();
      const fallback = state[this.slot] || DEFAULT_LOADOUT[this.slot];
      this.selectedId = opts.itemId || fallback;
      const item = findItem(this.slot, this.selectedId);
      if (item) {
        this.selectedId = item.id;
        this.category = this.slot === 'primary' ? item.category || 'all' : 'all';
      } else {
        this.category = 'all';
      }
      node.overlay.classList.remove('hidden');
      this.render();
      if (this._preview && this._preview.raf) {
        cancelAnimationFrame(this._preview.raf);
        this._preview.raf = 0;
      }
      if (this._preview) {
        this._resizePreview();
        this._rebuildPreview();
        const preview = this._preview;
        preview.lastT = performance.now();
        const tick = () => {
          if (!this.isOpen || !this._preview) return;
          const now = performance.now();
          const dt = Math.min(0.05, (now - preview.lastT) / 1000);
          preview.lastT = now;
          if (preview.pivot) preview.pivot.rotation.y += dt * 0.55;
          preview.renderer.render(preview.scene, preview.camera);
          preview.raf = requestAnimationFrame(tick);
        };
        preview.raf = requestAnimationFrame(tick);
      } else {
        this._startPreview();
      }
      document.exitPointerLock && document.exitPointerLock();
    },

    hide() {
      if (!this.isOpen) return;
      this.isOpen = false;
      if (global.VF.UI) global.VF.UI.arsenalOpen = false;
      const node = els();
      if (node.overlay) node.overlay.classList.add('hidden');
      if (this._preview && this._preview.raf) {
        cancelAnimationFrame(this._preview.raf);
        this._preview.raf = 0;
      }
    },

    setSlot(id) {
      const def = slotDef(id);
      if (!def) return;
      this.slot = def.id;
      const state = getState();
      this.selectedId = state[this.slot] || DEFAULT_LOADOUT[this.slot];
      const item = findItem(this.slot, this.selectedId);
      this.category = this.slot === 'primary' && item ? item.category || 'all' : 'all';
      this.render();
      this._rebuildPreview();
    },

    _visibleCategories() {
      if (this.slot !== 'primary') return [];
      const used = { all: true };
      const list = weaponList('primary');
      for (let i = 0; i < list.length; i++) used[list[i].category] = true;
      return CATEGORY_TABS.filter(function (tab) {
        return used[tab.id];
      });
    },

    getStripItems() {
      const state = Object.assign({}, getState());
      const ui = global.VF && global.VF.UI;
      if (ui && ui.loadoutCustomizeOpen && ui._loadoutDraftWeaponId) {
        state.primary = ui._loadoutDraftWeaponId;
      }
      return SLOTS.map(function (slot) {
        const item = findItem(slot.id, state[slot.id] || DEFAULT_LOADOUT[slot.id]);
        return {
          arsenalSlot: slot.id,
          itemId: item ? item.id : state[slot.id],
          name: item ? item.name : slot.label,
          kind: item ? item.kind : 'rifle',
          slotLabel: slot.label,
        };
      });
    },

    applyItem(slot, id) {
      const item = findItem(slot, id);
      if (!item || !isOwned(item)) return false;
      const state = getState();
      state[slot] = item.id;
      const g = global.VF && global.VF.game;
      const ui = global.VF && global.VF.UI;
      if (slot === 'primary') {
        if (g) g.preferredWeaponId = item.id;
        if (ui && ui.loadoutCustomizeOpen) {
          ui._loadoutDraftWeaponId = item.id;
        }
        if (g && g.weapons && g.weapons.equip) {
          g.weapons.equip(item.id);
          if (g.weapons.syncOwnedLoadout) g.weapons.syncOwnedLoadout();
          g.preferredWeaponId = g.weapons.current || item.id;
          state.primary = g.preferredWeaponId;
          const ammo = g.weapons.state && g.weapons.state[g.preferredWeaponId];
          if (ammo && ui && ui.updateAmmo) ui.updateAmmo(ammo.mag, ammo.reserve);
        }
      } else if (slot === 'secondary') {
        if (g) g.preferredSecondaryId = item.id;
        const cur = g && g.weapons && g.weapons.current;
        const curDef = cur ? weapons()[cur] : null;
        if (g && g.weapons && g.weapons.equip && curDef && curDef.category === 'pistol') {
          g.weapons.equip(item.id);
        }
      }
      if (ui && ui._syncDeployClassDetails) {
        const classes = (global.VF.Soldier && global.VF.Soldier.CLASSES) || [];
        let info = null;
        const cid = classId();
        for (let i = 0; i < classes.length; i++) {
          if (classes[i].id === cid) info = classes[i];
        }
        ui._syncDeployClassDetails(info || { id: cid, nameZh: '突击', role: '' });
        if (ui.loadoutCustomizeOpen && ui._updateLoadoutCustomizeUi) {
          ui._updateLoadoutCustomizeUi();
        }
      }
      return true;
    },

    equipSelected() {
      const item = findItem(this.slot, this.selectedId);
      if (!item || !isOwned(item)) return;
      this.applyItem(this.slot, item.id);
      this.hide();
    },

    render() {
      const node = els();
      if (!node.overlay || !this.isOpen) return;
      const slot = slotDef(this.slot) || SLOTS[0];
      const state = getState();
      const equippedId = state[this.slot] || DEFAULT_LOADOUT[this.slot];
      let list = itemsForSlot(this.slot);
      if (this.slot === 'primary' && this.category && this.category !== 'all') {
        list = list.filter((item) => item.category === this.category);
      }
      let selected = null;
      for (let i = 0; i < list.length; i++) {
        if (list[i].id === this.selectedId) selected = list[i];
      }
      if (!selected && list[0]) {
        this.selectedId = list[0].id;
        selected = list[0];
      }
      const equipped = findItem(this.slot, equippedId);
      if (node.title) node.title.textContent = slot.title;
      this._renderSlots(node, state);
      this._renderCats(node);
      this._renderList(node, list, equippedId);
      this._renderInfo(node, selected, equippedId);
      this._renderStats(node, selected, equipped);
      this._rebuildPreview();
    },

    _renderSlots(node, state) {
      if (!node.slots) return;
      let html = '';
      for (let i = 0; i < SLOTS.length; i++) {
        const slot = SLOTS[i];
        const item = findItem(slot.id, state[slot.id] || DEFAULT_LOADOUT[slot.id]);
        const active = slot.id === this.slot;
        html +=
          '<button type="button" class="arsenal-slot' +
          (active ? ' active' : '') +
          '" data-arsenal-tab="' +
          slot.id +
          '" role="tab" aria-selected="' +
          (active ? 'true' : 'false') +
          '"><small>' +
          escapeHtml(slot.label) +
          '</small>' +
          (item ? gearSvg(item.kind) : '') +
          '<span>' +
          escapeHtml(item ? item.name : '—') +
          '</span></button>';
      }
      node.slots.innerHTML = html;
    },

    _renderCats(node) {
      if (!node.cats) return;
      const tabs = this._visibleCategories();
      if (!tabs.length) {
        node.cats.innerHTML = '';
        node.cats.hidden = true;
        return;
      }
      node.cats.hidden = false;
      node.cats.innerHTML = tabs
        .map(function (tab) {
          const active = tab.id === this.category;
          return (
            '<button type="button" class="arsenal-cat' +
            (active ? ' active' : '') +
            '" data-arsenal-cat="' +
            tab.id +
            '">' +
            escapeHtml(tab.label) +
            '</button>'
          );
        }, this)
        .join('');
    },

    _renderList(node, list, equippedId) {
      if (!node.list) return;
      if (!list.length) {
        node.list.innerHTML = '<p class="arsenal-empty">该栏位暂无可选项目</p>';
        return;
      }
      let html = '';
      let lastCat = '';
      const showGroups = this.slot === 'primary' && this.category === 'all';
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (showGroups && item.category && item.category !== lastCat) {
          lastCat = item.category;
          const meta = CATEGORY_META[item.category];
          html +=
            '<h3 class="arsenal-group">' +
            escapeHtml((meta && meta.label) || item.category) +
            '</h3>';
        }
        const owned = isOwned(item);
        const selected = item.id === this.selectedId;
        const equipped = item.id === equippedId;
        html +=
          '<button type="button" class="arsenal-card' +
          (selected ? ' selected' : '') +
          (equipped ? ' equipped' : '') +
          (owned ? '' : ' locked') +
          '" data-arsenal-item="' +
          escapeHtml(item.id) +
          '" role="option" aria-selected="' +
          (selected ? 'true' : 'false') +
          '"' +
          '>' +
          '<span class="arsenal-card-icon">' +
          gearSvg(item.kind) +
          '</span>' +
          '<span class="arsenal-card-copy"><strong>' +
          escapeHtml(item.name) +
          '</strong><small>' +
          escapeHtml(
            item.def && item.def.caliber
              ? item.def.caliber
              : (CATEGORY_META[item.category] && CATEGORY_META[item.category].label) ||
                  (slotDef(this.slot) || SLOTS[0]).label
          ) +
          '</small></span>' +
          (equipped ? '<i class="arsenal-check" aria-hidden="true"></i>' : '') +
          (owned ? '' : '<i class="arsenal-lock" aria-hidden="true"></i>') +
          '</button>';
      }
      node.list.innerHTML = html;
      const active = node.list.querySelector('.arsenal-card.selected');
      if (active && typeof active.scrollIntoView === 'function') {
        active.scrollIntoView({ block: 'nearest' });
      }
    },

    _renderInfo(node, selected, equippedId) {
      if (!selected) return;
      const owned = isOwned(selected);
      const equipped = selected.id === equippedId;
      const tags = (selected.tags || []).map(function (tag) {
        return '<span>' + escapeHtml(tag) + '</span>';
      });
      if (node.tags) node.tags.innerHTML = tags.join('');
      if (node.name) node.name.textContent = selected.name;
      if (node.flavor) node.flavor.textContent = selected.flavor || '';
      if (node.desc) {
        const extra =
          selected.def && selected.def.caliber
            ? selected.def.caliber +
              ' · 弹匣 ' +
              selected.def.magSize +
              (selected.def.automatic ? ' · 全自动' : ' · 单发')
            : '';
        node.desc.textContent = (selected.desc || '') + (extra ? '\n' + extra : '');
      }
      if (node.equip) {
        node.equip.disabled = !owned;
        node.equip.classList.toggle('is-equipped', equipped && owned);
      }
      if (node.equipLabel) {
        node.equipLabel.textContent = !owned ? '未解锁' : equipped ? '已装备' : '装备';
      }
    },

    _renderStats(node, selected, equipped) {
      const selStats = selected && selected.def ? derivedStats(selected.def) : null;
      const eqStats = equipped && equipped.def ? derivedStats(equipped.def) : null;
      if (!selStats) {
        if (node.headline) node.headline.innerHTML = '';
        if (node.bars) node.bars.innerHTML = '';
        if (node.detail) {
          node.detail.innerHTML =
            '<p class="arsenal-stats-empty">该栏位没有射击数值。装备后仅改变当前套件展示。</p>';
        }
        if (node.falloff) node.falloff.innerHTML = '';
        return;
      }
      if (node.headline) {
        node.headline.innerHTML = HEADLINE.map(function (row) {
          const cls = eqStats ? cmpClass(selStats[row.key], eqStats[row.key], row.better) : 'same';
          return (
            '<div class="arsenal-hi ' +
            cls +
            '"><b>' +
            escapeHtml(formatStat(row.key, selStats[row.key])) +
            '</b><span>' +
            escapeHtml(row.label) +
            '</span></div>'
          );
        }).join('');
      }
      if (node.bars) {
        node.bars.innerHTML = BARS.map(function (row) {
          const cls = eqStats ? cmpClass(selStats[row.key], eqStats[row.key], row.better) : 'same';
          return (
            '<div class="arsenal-bar ' +
            cls +
            '"><span>' +
            escapeHtml(row.label) +
            '</span><i><em style="width:' +
            barPct(row.key, selStats[row.key]).toFixed(1) +
            '%"></em></i><b>' +
            escapeHtml(formatStat(row.key, selStats[row.key])) +
            '</b></div>'
          );
        }).join('');
      }
      if (node.detail) {
        node.detail.innerHTML = DETAIL_KEYS.map(function (row) {
          const cls = eqStats ? cmpClass(selStats[row.key], eqStats[row.key], row.better) : 'same';
          const pct = Math.max(
            0,
            Math.min(100, (Number(selStats[row.key]) / row.max) * 100)
          );
          return (
            '<div class="arsenal-kv ' +
            cls +
            '"><span>' +
            escapeHtml(row.label) +
            '</span><i><em style="width:' +
            pct.toFixed(1) +
            '%"></em></i><b>' +
            escapeHtml(formatStat(row.key, selStats[row.key])) +
            '</b></div>'
          );
        }).join('');
      }
      this._renderFalloff(node, selected.def, equipped && equipped.def);
    },

    _renderFalloff(node, def, equippedDef) {
      if (!node.falloff || !def) return;
      const maxX = Math.max(120, Math.ceil((def.falloffEnd || 200) / 50) * 50);
      const maxY = Math.max(def.damage * 1.15, 12);
      function pathFor(src) {
        const pts = [];
        for (let i = 0; i <= 48; i++) {
          const x = (i / 48) * maxX;
          const dmg = damageAtRange(src, x);
          const sx = (24 + (x / maxX) * 280).toFixed(1);
          const sy = (82 - (dmg / maxY) * 68).toFixed(1);
          pts.push(sx + ',' + sy);
        }
        return pts.join(' ');
      }
      let svg =
        '<line x1="24" y1="82" x2="304" y2="82" /><line x1="24" y1="14" x2="24" y2="82" />';
      [0, 0.5, 1].forEach(function (t) {
        const x = 24 + t * 280;
        const label = Math.round(maxX * t);
        svg +=
          '<text x="' +
          x +
          '" y="94">' +
          label +
          'm</text>';
      });
      svg += '<text x="8" y="18">' + Math.round(maxY) + '</text>';
      if (equippedDef && equippedDef.id !== def.id) {
        svg +=
          '<polyline class="equipped" fill="none" points="' + pathFor(equippedDef) + '" />';
      }
      svg += '<polyline class="selected" fill="none" points="' + pathFor(def) + '" />';
      node.falloff.innerHTML = svg;
    },

    _startPreview() {
      this._stopPreview();
      const node = els();
      if (!node.canvas || !global.THREE) return;
      const scene = new THREE.Scene();
      scene.background = null;
      const camera = new THREE.PerspectiveCamera(32, 16 / 9, 0.05, 20);
      camera.position.set(1.15, 0.42, 1.55);
      camera.lookAt(0, 0.04, 0);
      const key = new THREE.DirectionalLight(0xfff1dd, 1.45);
      key.position.set(-2.2, 3.4, 4.2);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x9bdcff, 0.7);
      rim.position.set(3.4, 1.6, -2.4);
      scene.add(rim);
      scene.add(new THREE.AmbientLight(0xb8c5c8, 0.78));
      const renderer = new THREE.WebGLRenderer({
        canvas: node.canvas,
        antialias: true,
        alpha: true,
      });
      renderer.setPixelRatio(Math.min(2, global.devicePixelRatio || 1));
      renderer.setClearColor(0x000000, 0);
      this._preview = {
        scene: scene,
        camera: camera,
        renderer: renderer,
        pivot: null,
        raf: 0,
        lastT: performance.now(),
      };
      this._resizePreview();
      this._rebuildPreview();
      const tick = () => {
        const preview = this._preview;
        if (!this.isOpen || !preview) return;
        const now = performance.now();
        const dt = Math.min(0.05, (now - preview.lastT) / 1000);
        preview.lastT = now;
        if (preview.pivot) preview.pivot.rotation.y += dt * 0.55;
        preview.renderer.render(preview.scene, preview.camera);
        preview.raf = requestAnimationFrame(tick);
      };
      this._preview.raf = requestAnimationFrame(tick);
    },

    _rebuildPreview() {
      const preview = this._preview;
      const node = els();
      if (!preview || !node.canvas) return;
      if (preview.pivot) {
        preview.scene.remove(preview.pivot);
        preview.pivot.traverse(function (child) {
          if (child.geometry) child.geometry.dispose();
          if (child.material) {
            if (Array.isArray(child.material)) {
              child.material.forEach(function (mat) {
                if (mat && mat.dispose) mat.dispose();
              });
            } else if (child.material.dispose) child.material.dispose();
          }
        });
        preview.pivot = null;
      }
      const item = findItem(this.slot, this.selectedId);
      const canBuild =
        item &&
        item.def &&
        global.VF.WeaponViewModels &&
        global.VF.WeaponViewModels.buildGun;
      if (node.fallback) {
        node.fallback.hidden = !!canBuild;
        if (!canBuild) {
          node.fallback.innerHTML = item ? gearSvg(item.kind) + '<span>' + escapeHtml(item.name) + '</span>' : '';
        }
      }
      if (!canBuild) return;
      const built = global.VF.WeaponViewModels.buildGun(item.def);
      const gun = built && built.gun;
      if (!gun) return;
      gun.position.set(0, 0, 0);
      gun.rotation.set(0, 0, 0);
      const pivot = new THREE.Group();
      pivot.add(gun);
      const box = new THREE.Box3().setFromObject(gun);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      gun.position.sub(center);
      const maxDim = Math.max(size.x, size.y, size.z, 0.35);
      const dist = maxDim * 2.35;
      preview.camera.position.set(dist * 0.72, maxDim * 0.38, dist * 0.95);
      preview.camera.lookAt(0, 0, 0);
      preview.scene.add(pivot);
      preview.pivot = pivot;
    },

    _resizePreview() {
      const preview = this._preview;
      const node = els();
      if (!preview || !node.canvas) return;
      const wrap = node.canvas.parentElement;
      const w = Math.max(160, wrap ? wrap.clientWidth : node.canvas.clientWidth);
      const h = Math.max(120, wrap ? wrap.clientHeight : node.canvas.clientHeight);
      preview.camera.aspect = w / Math.max(1, h);
      preview.camera.updateProjectionMatrix();
      preview.renderer.setSize(w, h, false);
    },

    _stopPreview() {
      const preview = this._preview;
      if (!preview) return;
      if (preview.raf) cancelAnimationFrame(preview.raf);
      if (preview.pivot && preview.scene) preview.scene.remove(preview.pivot);
      if (preview.renderer && preview.renderer.dispose) preview.renderer.dispose();
      this._preview = null;
    },
  };

  global.VF = global.VF || {};
  global.VF.Arsenal = Arsenal;
  global.VF.getLoadout = getState;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      Arsenal.init();
    });
  } else {
    Arsenal.init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
