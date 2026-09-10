/**
 * arsenal.js — Loadout inspect screen, ported from the large-battlefield build.
 *
 * Picks which gun fills each hotbar slot, with category tabs, a rotating 3D
 * preview and the 16-stat inspect panel compared against what is currently
 * equipped. The choice persists through VF.Economy's loadout meta.
 *
 * Our hotbar has three gun slots rather than the battlefield's primary/secondary
 * pair, so categories are grouped per slot instead of per weapon class.
 */
(function (global) {
  'use strict';

  /** Shared with weapon-catalog.js so derived stats agree everywhere. */
  const RECOIL_KICK_SCALE = 0.048;
  const ACCURACY_SPREAD_MAX = 0.12;

  /** Matches VF.Economy.THROW_SLOT; the loadout key for the Q throwable. */
  const THROW_SLOT = 4;

  const SLOTS = [
    { id: 1, label: '主武器', hint: '热键 1' },
    { id: 2, label: '副武器', hint: '热键 2' },
    { id: THROW_SLOT, label: '投掷物', hint: '热键 Q' },
  ];

  /** 精确射手 is a 主武器 pick, not a slot of its own. */
  const SLOT_CATEGORIES = {
    1: ['assault', 'carbine', 'smg', 'lmg', 'dmr', 'sniper'],
    2: ['shotgun', 'pistol'],
    4: ['lethal', 'tactical'],
  };

  const CATEGORY_LABEL = {
    assault: '突击步枪',
    carbine: '卡宾枪',
    smg: '冲锋枪',
    lmg: '轻机枪',
    dmr: '精确射手',
    sniper: '狙击枪',
    shotgun: '霰弹枪',
    pistol: '手枪',
    lethal: '致命',
    tactical: '战术',
  };

  const CATEGORY_FLAVOR = {
    assault: '中距离主力，射速与后坐力平衡',
    carbine: '短枪管突击枪，机动性优先',
    smg: '近距离高射速，射程换机动',
    lmg: '大弹匣压制，牺牲机动与换弹',
    dmr: '半自动精确射击，两枪或一枪爆头',
    sniper: '栓动远距离，一击致命',
    shotgun: '贴脸一发带走，射程极短',
    pistol: '副武器，掏枪快、换弹快',
    lethal: '直接造成伤害，拆核心也算这份伤害',
    tactical: '不杀人，用致盲、压制和遮蔽换位置',
  };

  const HEADLINE = [
    { key: 'damage', label: '伤害', better: 'higher' },
    { key: 'rpm', label: '射速', better: 'higher' },
    { key: 'magSize', label: '弹匣', better: 'higher' },
  ];

  /** How far the preview swings either side of the side-on profile, radians. */
  const ROCK = 0.62;

  const BARS = [
    { key: 'hipfire', label: '腰射', better: 'higher' },
    { key: 'accuracy', label: '精准度', better: 'higher' },
    { key: 'controlScore', label: '控制', better: 'higher' },
    { key: 'mobility', label: '机动性', better: 'higher' },
  ];

  const DETAIL_KEYS = [
    { key: 'damage', label: '伤害', better: 'higher', max: 120 },
    { key: 'verticalRecoil', label: '垂直后坐力', better: 'lower', max: 4 },
    { key: 'horizontalRecoil', label: '横向后坐力', better: 'lower', max: 3 },
    { key: 'muzzleVelocity', label: '枪口初速', better: 'higher', max: 1400 },
    { key: 'accuracy', label: '准确度', better: 'higher', max: 100 },
    { key: 'rpm', label: '射速', better: 'higher', max: 900 },
    { key: 'adsTime', label: '瞄准耗时', better: 'lower', max: 0.5 },
    { key: 'runSpeed', label: '奔跑速度', better: 'higher', max: 1.2 },
    { key: 'reloadTime', label: '换弹时间', better: 'lower', max: 4 },
    { key: 'switchSpeed', label: '切换速度', better: 'higher', max: 2 },
  ];

  const THROW_BARS = [
    { key: 'power', label: '强度', better: 'higher' },
    { key: 'reach', label: '范围', better: 'higher' },
    { key: 'speed', label: '起效', better: 'higher' },
    { key: 'lasting', label: '持续', better: 'higher' },
  ];

  const THROW_DETAIL = [
    { key: 'radius', label: '作用半径', better: 'higher', max: 8, unit: 'm' },
    { key: 'innerRadius', label: '满伤半径', better: 'higher', max: 4, unit: 'm' },
    { key: 'fuseTime', label: '引信时间', better: 'lower', max: 3, unit: 's' },
    { key: 'duration', label: '持续时间', better: 'higher', max: 12, unit: 's' },
    { key: 'edgeDamage', label: '边缘伤害', better: 'higher', max: 40, unit: '' },
    { key: 'coreDamage', label: '核心伤害', better: 'higher', max: 80, unit: '' },
  ];

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

  function throwables() {
    return (global.VF && global.VF.THROWABLE_CATALOG) || {};
  }

  function ownsWeapon(id) {
    const E = global.VF && global.VF.Economy;
    if (!E || !E.ownsWeapon) return true;
    return !!E.ownsWeapon(id);
  }

  function ownsThrowable(id) {
    const E = global.VF && global.VF.Economy;
    if (!E || !E.ownsThrowable) return true;
    return !!E.ownsThrowable(id);
  }

  function coinBalance() {
    const E = global.VF && global.VF.Economy;
    return E && E.getCoins ? E.getCoins() : 0;
  }

  /** Bars for the throwables, rated within their own kind. */
  function throwStats(def) {
    if (!def) return null;
    const clamp = function (n) {
      return Math.max(0, Math.min(100, n));
    };
    return {
      potency: def.potency,
      radius: def.radius,
      innerRadius: def.innerRadius,
      fuseTime: def.fuseTime,
      duration: def.duration,
      edgeDamage: def.edgeDamage,
      coreDamage: def.coreDamage,
      // A lethal is measured against the frag, a tactical against the longest effect.
      power: clamp((def.potency / (def.kind === 'lethal' ? 130 : 12)) * 100),
      reach: clamp((def.radius / 8) * 100),
      speed: clamp(((3 - def.fuseTime) / 3) * 100),
      lasting: clamp((def.duration / 12) * 100),
    };
  }

  /** Damage for a lethal, effect seconds for a tactical, at a given distance. */
  function throwEffectAt(def, dist) {
    if (!def) return 0;
    const r = def.radius || 0;
    if (!r || dist >= r) return 0;
    // A fire pool burns at one rate anywhere inside it.
    if (def.dps) return def.potency;
    if (def.kind === 'lethal') {
      const inner = def.innerRadius || 0;
      if (dist <= inner) return def.potency;
      const t = (dist - inner) / Math.max(0.01, r - inner);
      return def.potency + (def.edgeDamage - def.potency) * t;
    }
    return def.potency * (1 - dist / r);
  }

  function formatThrow(key, value) {
    if (value == null || !isFinite(value)) return '—';
    if (!value) return '—';
    if (key === 'power' || key === 'reach' || key === 'speed' || key === 'lasting') {
      return String(Math.round(value)).padStart(3, '0');
    }
    if (key === 'radius' || key === 'innerRadius' || key === 'fuseTime' || key === 'duration') {
      return Number(value).toFixed(1);
    }
    return String(Math.round(value));
  }

  function priceOf(id) {
    const E = global.VF && global.VF.Economy;
    const item = E && E.CATALOG && E.CATALOG[id];
    return item ? item.price : 0;
  }

  /**
   * The original three guns predate the catalog and carry only gameplay fields.
   * Fill in the inspect stats using the same formulas weapon-catalog.js applies,
   * so the panel can never show numbers the gun does not actually have.
   */
  function inspectDef(def) {
    if (!def) return null;
    const out = Object.assign({}, def);
    // A shotgun's "damage" is the whole pellet spread, which is what a player feels.
    out.damage = def.damage * (def.pellets || 1);
    if (out.rpm == null) out.rpm = Math.round(60 / out.fireRate);
    if (out.accuracy == null) {
      out.accuracy = +((1 - out.spread / ACCURACY_SPREAD_MAX) * 100).toFixed(2);
    }
    if (out.verticalRecoil == null) {
      out.verticalRecoil = +(out.recoil / RECOIL_KICK_SCALE).toFixed(2);
    }
    if (out.horizontalRecoil == null) {
      out.horizontalRecoil = +(out.verticalRecoil * 0.55).toFixed(2);
    }
    if (out.muzzleVelocity == null) out.muzzleVelocity = 700;
    if (out.adsTime == null) out.adsTime = 0.25;
    if (out.runSpeed == null) out.runSpeed = 1;
    if (out.switchSpeed == null) out.switchSpeed = 1;
    if (out.control == null) out.control = 0.85;
    return out;
  }

  /** Roll the raw stats into the four feel bars the battlefield panel shows. */
  function derivedStats(raw) {
    const def = inspectDef(raw);
    if (!def) return null;
    const clamp = function (n) {
      return Math.max(0, Math.min(100, n));
    };
    const hipfire = clamp(
      def.accuracy * 0.42 +
        (1.2 - def.adsTime) * 38 +
        (def.category === 'smg' || def.category === 'pistol' ? 14 : 0) -
        (def.magSize > 40 ? 8 : 0)
    );
    const controlScore = clamp(def.control * 62 + (4.2 - def.verticalRecoil) * 9);
    const mobility = clamp(def.runSpeed * 52 + (1.15 - def.adsTime) * 22 + def.switchSpeed * 12);
    return {
      damage: def.damage,
      rpm: def.rpm,
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

  function damageAtRange(raw, dist) {
    const def = inspectDef(raw);
    if (!def) return 0;
    const start = def.falloffStart != null ? def.falloffStart : 20;
    const end =
      def.falloffEnd != null ? def.falloffEnd : Math.max(start + 1, (def.range || 80) * 0.85);
    const minDmg = def.damage * (def.minDamageScale != null ? def.minDamageScale : 0.25);
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
    return (better === 'lower' ? a < b : a > b) ? 'up' : 'down';
  }

  function formatStat(key, value) {
    if (value == null || !isFinite(value)) return '—';
    if (key === 'adsTime' || key === 'reloadTime' || key === 'runSpeed' || key === 'switchSpeed') {
      return Number(value).toFixed(2);
    }
    if (key === 'verticalRecoil' || key === 'horizontalRecoil') return Number(value).toFixed(2);
    if (key === 'hipfire' || key === 'controlScore' || key === 'mobility' || key === 'accuracy') {
      return String(Math.round(value)).padStart(3, '0');
    }
    return String(Math.round(value));
  }

  function barPct(key, value) {
    const maxes = { damage: 120, rpm: 900, magSize: 100 };
    return Math.max(0, Math.min(100, (Number(value) / (maxes[key] || 100)) * 100));
  }

  const Arsenal = {
    isOpen: false,
    slot: 1,
    category: 'all',
    selectedId: null,
    _preview: null,
    _built: false,
    _onClose: null,

    /** Build the overlay lazily so index.html stays a static shell. */
    _ensureDom() {
      if (this._built) return;
      this._built = true;
      const root = document.createElement('div');
      root.id = 'arsenal-overlay';
      root.className = 'arsenal-overlay hidden';
      root.innerHTML =
        '<div class="arsenal-panel px-panel">' +
        '<header class="arsenal-head">' +
        '<h2 id="arsenal-title">装备</h2>' +
        '<div class="arsenal-slots" id="arsenal-slots"></div>' +
        '<span class="arsenal-coins" id="arsenal-coins"></span>' +
        '<button type="button" class="cover-btn" id="arsenal-back">返回</button>' +
        '</header>' +
        '<div class="arsenal-body">' +
        '<div class="arsenal-left">' +
        '<div class="arsenal-cats" id="arsenal-cats"></div>' +
        '<div class="arsenal-list" id="arsenal-list"></div>' +
        '</div>' +
        '<div class="arsenal-mid">' +
        '<div class="arsenal-stage"><canvas id="arsenal-canvas"></canvas></div>' +
        '<p class="arsenal-name" id="arsenal-name"></p>' +
        '<p class="arsenal-flavor" id="arsenal-flavor"></p>' +
        '<div class="arsenal-headline" id="arsenal-headline"></div>' +
        '<div class="arsenal-bars" id="arsenal-bars"></div>' +
        '<button type="button" class="cover-btn cover-btn-start" id="arsenal-equip">' +
        '<span id="arsenal-equip-label">装备</span></button>' +
        '</div>' +
        '<div class="arsenal-right">' +
        '<p class="arsenal-sec">基础数值</p>' +
        '<div class="arsenal-detail" id="arsenal-detail"></div>' +
        '<p class="arsenal-sec" id="arsenal-falloff-sec">伤害衰减</p>' +
        '<svg class="arsenal-falloff" id="arsenal-falloff" viewBox="0 0 320 100"></svg>' +
        '<p class="arsenal-legend"><i class="sel"></i>所选<i class="eq"></i>已装备</p>' +
        '</div>' +
        '</div>' +
        '</div>';
      document.body.appendChild(root);
      this._bind();
    },

    _bind() {
      const root = document.getElementById('arsenal-overlay');
      if (!root) return;
      const self = this;
      root.addEventListener('click', function (e) {
        const slotBtn = e.target.closest('[data-arsenal-slot]');
        if (slotBtn) {
          self.setSlot(Number(slotBtn.dataset.arsenalSlot));
          return;
        }
        const catBtn = e.target.closest('[data-arsenal-cat]');
        if (catBtn) {
          self.category = catBtn.dataset.arsenalCat;
          self.render();
          return;
        }
        const item = e.target.closest('[data-arsenal-id]');
        if (item) {
          self.selectedId = item.dataset.arsenalId;
          self.render();
          self._rebuildPreview();
          return;
        }
        if (e.target.closest('#arsenal-equip')) {
          self._onPrimary();
          return;
        }
        if (e.target.closest('#arsenal-back')) self.hide();
      });
      global.addEventListener('resize', function () {
        if (self.isOpen) self._resizePreview();
      });
      document.addEventListener('keydown', function (e) {
        if (self.isOpen && e.code === 'Escape') self.hide();
      });
    },

    /** The throwable slot swaps the whole panel over to grenade stats. */
    isThrowSlot(slot) {
      return (slot == null ? this.slot : slot) === THROW_SLOT;
    },

    /** Items that can fill the given slot, ordered by category then price. */
    itemsForSlot(slot) {
      const cats = SLOT_CATEGORIES[slot] || [];
      const out = [];
      if (this.isThrowSlot(slot)) {
        const cat = throwables();
        const T = global.VF && global.VF.Throwables;
        const order = T && T.order ? T.order() : Object.keys(cat);
        order.forEach(function (id) {
          const def = cat[id];
          if (!def) return;
          out.push({
            id: id,
            def: def,
            name: def.nameZh || def.name,
            category: def.kind,
            owned: ownsThrowable(id),
            price: priceOf(id),
          });
        });
      } else {
        const defs = weapons();
        Object.keys(defs).forEach(function (id) {
          const def = defs[id];
          if (!def || def.melee) return;
          if (cats.indexOf(def.category) < 0) return;
          out.push({
            id: id,
            def: def,
            name: def.nameZh || def.name,
            category: def.category,
            owned: ownsWeapon(id),
            price: priceOf(id),
          });
        });
      }
      out.sort(function (a, b) {
        const ci = cats.indexOf(a.category) - cats.indexOf(b.category);
        return ci !== 0 ? ci : a.price - b.price;
      });
      return out;
    },

    equippedId(slot) {
      const E = global.VF && global.VF.Economy;
      if (this.isThrowSlot(slot)) {
        return E && E.throwableForSlot ? E.throwableForSlot() : 'frag';
      }
      if (E && E.weaponForSlot) return E.weaponForSlot(slot);
      return { 1: 'ar', 2: 'sg', 3: 'sr' }[slot];
    },

    show(opts) {
      this._ensureDom();
      opts = opts || {};
      this._onClose = opts.onClose || null;
      this.isOpen = true;
      this.setSlot(opts.slot || 1, true);
      const root = document.getElementById('arsenal-overlay');
      if (root) root.classList.remove('hidden');
      this.render();
      this._startPreview();
    },

    hide() {
      if (!this.isOpen) return;
      this.isOpen = false;
      this._stopPreview();
      const root = document.getElementById('arsenal-overlay');
      if (root) root.classList.add('hidden');
      const cb = this._onClose;
      this._onClose = null;
      if (cb) cb();
    },

    setSlot(slot, quiet) {
      this.slot = SLOT_CATEGORIES[slot] ? slot : 1;
      this.category = 'all';
      this.selectedId = this.equippedId(this.slot);
      if (quiet) return;
      this.render();
      this._rebuildPreview();
    },

    /** The one button does both jobs, so route on whether it is owned yet. */
    _onPrimary() {
      const id = this.selectedId;
      if (!id) return;
      const owned = this.isThrowSlot() ? ownsThrowable(id) : ownsWeapon(id);
      if (owned) this.equipSelected();
      else this.buySelected();
    },

    /** Buying is only ever a step towards using it, so equip on success. */
    buySelected() {
      const E = global.VF && global.VF.Economy;
      const id = this.selectedId;
      const toast = global.VF.UI && global.VF.UI.toast;
      if (!E || !E.buy || !id) return;
      const res = E.buy(id);
      if (!res || !res.ok) {
        if (toast) global.VF.UI.toast((res && res.reason) || '无法购买');
        this.render();
        return;
      }
      if (toast) global.VF.UI.toast('已购买 ' + ((res.item && res.item.name) || id));
      this.equipSelected();
    },

    equipSelected() {
      const E = global.VF && global.VF.Economy;
      const id = this.selectedId;
      const toast = global.VF.UI && global.VF.UI.toast;
      if (!id) return;

      if (this.isThrowSlot()) {
        const cat = throwables();
        if (!cat[id] || !ownsThrowable(id)) return;
        if (E && E.setThrowableSlot) E.setThrowableSlot(id);
        // Swap it live if a match is already running.
        const T = global.VF.Throwables;
        if (T && T._equip) T._equip(id);
        if (toast) global.VF.UI.toast('已装备 ' + (cat[id].nameZh || cat[id].name));
        this.render();
        return;
      }

      const defs = weapons();
      if (!defs[id] || !ownsWeapon(id)) return;
      if (E && E.setLoadoutSlot) E.setLoadoutSlot(id, this.slot);
      // Reflect it immediately if a match is already running.
      const wpn = global.VF.game && global.VF.game.weapons;
      if (wpn && wpn.current && defs[wpn.current] && defs[wpn.current].slot === this.slot) {
        if (wpn.forceEquip) wpn.forceEquip(id);
      }
      if (global.VF.UI && global.VF.UI.syncWeaponLocks) global.VF.UI.syncWeaponLocks();
      if (toast) global.VF.UI.toast('已装备 ' + (defs[id].nameZh || defs[id].name));
      this.render();
    },

    render() {
      if (!this.isOpen) return;
      const list = this.itemsForSlot(this.slot);
      const equippedId = this.equippedId(this.slot);
      const pool = this.isThrowSlot() ? throwables() : weapons();
      if (!this.selectedId || !pool[this.selectedId]) this.selectedId = equippedId;
      const selected = list.filter(
        function (it) {
          return it.id === this.selectedId;
        }.bind(this)
      )[0];
      const equipped = list.filter(function (it) {
        return it.id === equippedId;
      })[0];
      this._renderSlots();
      this._renderCoins();
      this._renderCats(list);
      this._renderList(list, equippedId);
      this._renderInfo(selected, equippedId);
      this._renderStats(selected, equipped);
    },

    _renderCoins() {
      const node = document.getElementById('arsenal-coins');
      if (node) node.textContent = coinBalance() + ' 币';
      const sec = document.getElementById('arsenal-falloff-sec');
      if (sec) sec.textContent = this.isThrowSlot() ? '效果衰减' : '伤害衰减';
    },

    _renderSlots() {
      const node = document.getElementById('arsenal-slots');
      if (!node) return;
      const self = this;
      const defs = weapons();
      const nades = throwables();
      node.innerHTML = SLOTS.map(function (s) {
        const id = self.equippedId(s.id);
        const def = self.isThrowSlot(s.id) ? nades[id] : defs[id];
        return (
          '<button type="button" data-arsenal-slot="' +
          s.id +
          '" class="arsenal-slot' +
          (self.slot === s.id ? ' active' : '') +
          '"><span>' +
          escapeHtml(s.label) +
          '</span><b>' +
          escapeHtml(def ? def.nameZh || def.name : '—') +
          '</b><em>' +
          escapeHtml(s.hint) +
          '</em></button>'
        );
      }).join('');
    },

    _renderCats(list) {
      const node = document.getElementById('arsenal-cats');
      if (!node) return;
      const present = [];
      list.forEach(function (it) {
        if (present.indexOf(it.category) < 0) present.push(it.category);
      });
      const self = this;
      const tabs = [{ id: 'all', label: '全部' }].concat(
        present.map(function (c) {
          return { id: c, label: CATEGORY_LABEL[c] || c };
        })
      );
      node.innerHTML = tabs
        .map(function (t) {
          return (
            '<button type="button" data-arsenal-cat="' +
            t.id +
            '" class="arsenal-cat' +
            (self.category === t.id ? ' active' : '') +
            '">' +
            escapeHtml(t.label) +
            '</button>'
          );
        })
        .join('');
    },

    _renderList(list, equippedId) {
      const node = document.getElementById('arsenal-list');
      if (!node) return;
      const self = this;
      const shown = list.filter(function (it) {
        return self.category === 'all' || it.category === self.category;
      });
      if (!shown.length) {
        node.innerHTML = '<p class="arsenal-empty">该分类暂无装备。</p>';
        return;
      }
      const isThrow = this.isThrowSlot();
      node.innerHTML = shown
        .map(function (it) {
          const tag = it.id === equippedId ? '<i class="arsenal-eqtag">已装备</i>' : '';
          const lock = it.owned ? '' : '<i class="arsenal-lock">' + it.price + ' 币</i>';
          let sub;
          let line;
          if (isThrow) {
            const st = throwStats(it.def);
            sub = (CATEGORY_LABEL[it.category] || it.category) + ' · ' + it.def.fuseFromLabel;
            line =
              it.def.potencyLabel +
              ' ' +
              formatThrow('potency', st.potency) +
              it.def.potencyUnit +
              ' · 半径 ' +
              formatThrow('radius', st.radius) +
              'm · ' +
              (st.fuseTime ? '引信 ' + formatThrow('fuseTime', st.fuseTime) + 's' : '无引信');
          } else {
            const stats = derivedStats(it.def);
            sub = (CATEGORY_LABEL[it.category] || it.category) + ' · ' + (it.def.caliber || '');
            line =
              '伤害 ' +
              formatStat('damage', stats.damage) +
              ' · 射速 ' +
              stats.rpm +
              ' · 弹匣 ' +
              it.def.magSize;
          }
          return (
            '<button type="button" data-arsenal-id="' +
            it.id +
            '" class="arsenal-item' +
            (self.selectedId === it.id ? ' selected' : '') +
            (it.owned ? '' : ' locked') +
            '"><strong>' +
            escapeHtml(it.name) +
            '</strong><span>' +
            escapeHtml(sub) +
            '</span><em>' +
            escapeHtml(line) +
            '</em>' +
            tag +
            lock +
            '</button>'
          );
        })
        .join('');
    },

    _renderInfo(selected, equippedId) {
      const name = document.getElementById('arsenal-name');
      const flavor = document.getElementById('arsenal-flavor');
      const equip = document.getElementById('arsenal-equip');
      const label = document.getElementById('arsenal-equip-label');
      if (!selected) {
        if (name) name.textContent = '—';
        if (flavor) flavor.textContent = '';
        return;
      }
      if (name) name.textContent = selected.name;
      if (flavor) {
        flavor.textContent = this.isThrowSlot()
          ? selected.def.flavor || ''
          : (CATEGORY_FLAVOR[selected.category] || '') + ' · ' + (selected.def.caliber || '');
      }
      if (equip && label) {
        const isEquipped = selected.id === equippedId;
        const afford = coinBalance() >= selected.price;
        if (isEquipped) {
          equip.disabled = true;
          label.textContent = '已装备';
        } else if (selected.owned) {
          equip.disabled = false;
          label.textContent = '装备';
        } else {
          // Buying happens right here now; the lobby has no weapon shop.
          equip.disabled = !afford;
          label.textContent = (afford ? '购买 · ' : '币不足 · ') + selected.price + ' 币';
        }
      }
    },

    _renderStats(selected, equipped) {
      if (this.isThrowSlot()) {
        this._renderThrowStats(selected, equipped);
        return;
      }
      const headline = document.getElementById('arsenal-headline');
      const bars = document.getElementById('arsenal-bars');
      const detail = document.getElementById('arsenal-detail');
      const sel = selected && selected.def ? derivedStats(selected.def) : null;
      const eq = equipped && equipped.def ? derivedStats(equipped.def) : null;
      if (!sel) {
        if (headline) headline.innerHTML = '';
        if (bars) bars.innerHTML = '';
        if (detail) detail.innerHTML = '';
        return;
      }
      if (headline) {
        headline.innerHTML = HEADLINE.map(function (row) {
          const cls = eq ? cmpClass(sel[row.key], eq[row.key], row.better) : 'same';
          return (
            '<div class="arsenal-hi ' +
            cls +
            '"><b>' +
            escapeHtml(formatStat(row.key, sel[row.key])) +
            '</b><span>' +
            escapeHtml(row.label) +
            '</span></div>'
          );
        }).join('');
      }
      if (bars) {
        bars.innerHTML = BARS.map(function (row) {
          const cls = eq ? cmpClass(sel[row.key], eq[row.key], row.better) : 'same';
          return (
            '<div class="arsenal-bar ' +
            cls +
            '"><span>' +
            escapeHtml(row.label) +
            '</span><i><em style="width:' +
            barPct(row.key, sel[row.key]).toFixed(1) +
            '%"></em></i><b>' +
            escapeHtml(formatStat(row.key, sel[row.key])) +
            '</b></div>'
          );
        }).join('');
      }
      if (detail) {
        detail.innerHTML = DETAIL_KEYS.map(function (row) {
          const cls = eq ? cmpClass(sel[row.key], eq[row.key], row.better) : 'same';
          const pct = Math.max(0, Math.min(100, (Number(sel[row.key]) / row.max) * 100));
          return (
            '<div class="arsenal-kv ' +
            cls +
            '"><span>' +
            escapeHtml(row.label) +
            '</span><i><em style="width:' +
            pct.toFixed(1) +
            '%"></em></i><b>' +
            escapeHtml(formatStat(row.key, sel[row.key])) +
            '</b></div>'
          );
        }).join('');
      }
      this._renderFalloff(selected && selected.def, equipped && equipped.def);
    },

    /**
     * Grenades share the panel with the guns, so the same three regions are
     * reused: potency headline, four feel bars, then the raw radii and timings.
     */
    _renderThrowStats(selected, equipped) {
      const headline = document.getElementById('arsenal-headline');
      const bars = document.getElementById('arsenal-bars');
      const detail = document.getElementById('arsenal-detail');
      const def = selected && selected.def;
      const sel = def ? throwStats(def) : null;
      const eqDef = equipped && equipped.def;
      const eq = eqDef ? throwStats(eqDef) : null;
      if (!sel) {
        if (headline) headline.innerHTML = '';
        if (bars) bars.innerHTML = '';
        if (detail) detail.innerHTML = '';
        return;
      }
      if (headline) {
        // Only compare potency when both are the same kind; seconds of blind do
        // not out-rank points of damage.
        const sameKind = eqDef && eqDef.kind === def.kind;
        const rows = [
          {
            label: def.potencyLabel,
            text: formatThrow('potency', sel.potency) + def.potencyUnit,
            cls: sameKind ? cmpClass(sel.potency, eq.potency, 'higher') : 'same',
          },
          {
            label: '半径',
            text: formatThrow('radius', sel.radius) + 'm',
            cls: eq ? cmpClass(sel.radius, eq.radius, 'higher') : 'same',
          },
          {
            label: '引信',
            text: sel.fuseTime ? formatThrow('fuseTime', sel.fuseTime) + 's' : '触地',
            cls: eq ? cmpClass(sel.fuseTime, eq.fuseTime, 'lower') : 'same',
          },
        ];
        headline.innerHTML = rows
          .map(function (r) {
            return (
              '<div class="arsenal-hi ' +
              r.cls +
              '"><b>' +
              escapeHtml(r.text) +
              '</b><span>' +
              escapeHtml(r.label) +
              '</span></div>'
            );
          })
          .join('');
      }
      if (bars) {
        bars.innerHTML = THROW_BARS.map(function (row) {
          const cls = eq ? cmpClass(sel[row.key], eq[row.key], row.better) : 'same';
          return (
            '<div class="arsenal-bar ' +
            cls +
            '"><span>' +
            escapeHtml(row.label) +
            '</span><i><em style="width:' +
            Math.max(0, Math.min(100, sel[row.key])).toFixed(1) +
            '%"></em></i><b>' +
            escapeHtml(formatThrow(row.key, sel[row.key])) +
            '</b></div>'
          );
        }).join('');
      }
      if (detail) {
        detail.innerHTML = THROW_DETAIL.map(function (row) {
          const cls = eq ? cmpClass(sel[row.key], eq[row.key], row.better) : 'same';
          const pct = Math.max(0, Math.min(100, (Number(sel[row.key]) / row.max) * 100));
          const text = formatThrow(row.key, sel[row.key]);
          return (
            '<div class="arsenal-kv ' +
            cls +
            '"><span>' +
            escapeHtml(row.label) +
            '</span><i><em style="width:' +
            pct.toFixed(1) +
            '%"></em></i><b>' +
            escapeHtml(text === '—' ? text : text + row.unit) +
            '</b></div>'
          );
        }).join('');
      }
      this._renderThrowFalloff(def, eqDef);
    },

    /** Same axes as the gun falloff, but effect against distance from the blast. */
    _renderThrowFalloff(def, equippedDef) {
      const node = document.getElementById('arsenal-falloff');
      if (!node || !def) return;
      const maxX = Math.max(4, Math.ceil((def.radius || 6) + 1));
      const maxY = Math.max(def.potency * 1.15, 4);
      function pathFor(src) {
        const pts = [];
        for (let i = 0; i <= 48; i++) {
          const x = (i / 48) * maxX;
          const sx = (26 + (x / maxX) * 280).toFixed(1);
          const sy = (82 - (throwEffectAt(src, x) / maxY) * 68).toFixed(1);
          pts.push(sx + ',' + sy);
        }
        return pts.join(' ');
      }
      let svg = '<line x1="26" y1="82" x2="306" y2="82" /><line x1="26" y1="14" x2="26" y2="82" />';
      [0, 0.5, 1].forEach(function (t) {
        svg += '<text x="' + (26 + t * 280) + '" y="95">' + (maxX * t).toFixed(0) + 'm</text>';
      });
      svg += '<text x="4" y="18">' + maxY.toFixed(0) + '</text>';
      if (equippedDef && equippedDef.id !== def.id) {
        svg += '<polyline class="equipped" fill="none" points="' + pathFor(equippedDef) + '" />';
      }
      svg += '<polyline class="selected" fill="none" points="' + pathFor(def) + '" />';
      node.innerHTML = svg;
    },

    _renderFalloff(def, equippedDef) {
      const node = document.getElementById('arsenal-falloff');
      if (!node || !def) return;
      const maxX = Math.max(60, Math.ceil((def.falloffEnd || 100) / 25) * 25);
      const peak = def.damage * (def.pellets || 1);
      const maxY = Math.max(peak * 1.15, 12);
      function pathFor(src) {
        const pts = [];
        for (let i = 0; i <= 48; i++) {
          const x = (i / 48) * maxX;
          const sx = (26 + (x / maxX) * 280).toFixed(1);
          const sy = (82 - (damageAtRange(src, x) / maxY) * 68).toFixed(1);
          pts.push(sx + ',' + sy);
        }
        return pts.join(' ');
      }
      let svg = '<line x1="26" y1="82" x2="306" y2="82" /><line x1="26" y1="14" x2="26" y2="82" />';
      [0, 0.5, 1].forEach(function (t) {
        svg +=
          '<text x="' + (26 + t * 280) + '" y="95">' + Math.round(maxX * t) + 'm</text>';
      });
      svg += '<text x="4" y="18">' + Math.round(maxY) + '</text>';
      if (equippedDef && equippedDef.id !== def.id) {
        svg += '<polyline class="equipped" fill="none" points="' + pathFor(equippedDef) + '" />';
      }
      svg += '<polyline class="selected" fill="none" points="' + pathFor(def) + '" />';
      node.innerHTML = svg;
    },

    _startPreview() {
      this._stopPreview();
      const canvas = document.getElementById('arsenal-canvas');
      if (!canvas || !global.THREE) return;
      const scene = new THREE.Scene();
      scene.background = null;
      const camera = new THREE.PerspectiveCamera(32, 16 / 9, 0.05, 20);
      const key = new THREE.DirectionalLight(0xfff1dd, 1.45);
      key.position.set(-2.2, 3.4, 4.2);
      scene.add(key);
      // Warm-neutral fill: a blue rim tinted the charcoal receivers navy.
      const rim = new THREE.DirectionalLight(0xffd9a8, 0.5);
      rim.position.set(3.4, 1.6, -2.4);
      scene.add(rim);
      scene.add(new THREE.AmbientLight(0xd8d2c8, 0.72));
      const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
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
      const self = this;
      const tick = function () {
        const p = self._preview;
        if (!self.isOpen || !p) return;
        const now = performance.now();
        const dt = Math.min(0.05, (now - p.lastT) / 1000);
        p.lastT = now;
        if (p.pivot) {
          p.spin += dt;
          p.pivot.rotation.y =
            p.rock > 0 ? p.baseYaw + Math.sin(p.spin * 0.65) * p.rock : p.baseYaw + p.spin * 0.7;
        }
        p.renderer.render(p.scene, p.camera);
        p.raf = requestAnimationFrame(tick);
      };
      this._preview.raf = requestAnimationFrame(tick);
    },

    _rebuildPreview() {
      const p = this._preview;
      if (!p) return;
      if (p.pivot) {
        p.scene.remove(p.pivot);
        p.pivot.traverse(function (child) {
          if (child.geometry) child.geometry.dispose();
          const m = child.material;
          if (Array.isArray(m)) m.forEach(function (x) { if (x && x.dispose) x.dispose(); });
          else if (m && m.dispose) m.dispose();
        });
        p.pivot = null;
      }
      const isThrow = this.isThrowSlot();
      let obj = null;
      if (isThrow) {
        const T = global.VF.Throwables;
        if (!throwables()[this.selectedId] || !T || !T.makeMesh) return;
        obj = T.makeMesh(this.selectedId);
      } else {
        const def = weapons()[this.selectedId];
        const VM = global.VF.WeaponViewModels;
        if (!def || !VM || !VM.buildGun) return;
        const built = VM.buildGun(def);
        obj = built && built.gun;
      }
      if (!obj) return;
      obj.position.set(0, 0, 0);
      obj.rotation.set(0, 0, 0);
      const pivot = new THREE.Group();
      pivot.add(obj);
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      obj.position.sub(center);
      // A gun sits on its profile and only rocks around it — a full turn spends
      // half its time head-on, where it reads as a vertical blob. A grenade has
      // no profile to hold, so it just turns.
      p.baseYaw = isThrow ? 0 : -Math.PI / 2;
      p.rock = isThrow ? 0 : ROCK;
      // A rifle can fill the stage, but a grenade filling it the same way loses
      // any sense of how small it is, so it gets much more air around it.
      p.fitMargin = isThrow ? 1.75 : 1.1;
      p.spin = 0;
      pivot.rotation.y = p.baseYaw;
      p.size = size;
      p.scene.add(pivot);
      p.pivot = pivot;
      this._frameCamera();
    },

    /** Pull back far enough that the rocking profile never clips the barrel. */
    _frameCamera() {
      const p = this._preview;
      if (!p || !p.size) return;
      const vHalf = (p.camera.fov * Math.PI) / 360;
      const hHalf = Math.atan(Math.tan(vHalf) * p.camera.aspect);
      // Worst-case footprint: for a rocking gun that is its full length plus the
      // slice of depth swinging in; for a freely turning grenade it is the
      // diagonal of its footprint.
      const half =
        p.rock > 0
          ? p.size.z * 0.5 + p.size.x * 0.5 * Math.sin(p.rock)
          : Math.hypot(p.size.x, p.size.z) * 0.5;
      const dist =
        Math.max(half / Math.tan(hHalf), (p.size.y * 0.5) / Math.tan(vHalf), 0.3) *
        (p.fitMargin || 1.1);
      const dir = new THREE.Vector3(0.16, 0.3, 1).normalize();
      p.camera.position.copy(dir.multiplyScalar(dist));
      p.camera.lookAt(0, 0, 0);
      p.camera.far = dist * 3;
      p.camera.updateProjectionMatrix();
    },

    _resizePreview() {
      const p = this._preview;
      const canvas = document.getElementById('arsenal-canvas');
      if (!p || !canvas) return;
      const wrap = canvas.parentElement;
      const w = Math.max(160, wrap ? wrap.clientWidth : canvas.clientWidth);
      const h = Math.max(120, wrap ? wrap.clientHeight : canvas.clientHeight);
      p.camera.aspect = w / Math.max(1, h);
      p.camera.updateProjectionMatrix();
      p.renderer.setSize(w, h, false);
      // The stage is nearly square, so the distance has to follow the aspect or
      // the barrel runs off the sides.
      this._frameCamera();
    },

    _stopPreview() {
      const p = this._preview;
      if (!p) return;
      if (p.raf) cancelAnimationFrame(p.raf);
      if (p.pivot && p.scene) p.scene.remove(p.pivot);
      if (p.renderer && p.renderer.dispose) p.renderer.dispose();
      this._preview = null;
    },
  };

  global.VF = global.VF || {};
  global.VF.Arsenal = Arsenal;
})(window);
