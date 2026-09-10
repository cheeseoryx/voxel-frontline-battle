/**
 * feel-tuner.js — Dev-only feel parameter panel (F10).
 *
 * PRODUCTION STRIP (delete these 3):
 *   1. This file: js/feel-tuner.js
 *   2. <script src="js/feel-tuner.js"> in index.html
 *   3. Confirm game does NOT load feel from localStorage without this script
 *
 * KEEP: js/feel-config.js (exported numbers stay in the game)
 *
 * Export → download feel-config.js → replace repo file → commit when ready.
 * Draft in localStorage is ONLY read when this tuner is loaded.
 */
(function (global) {
  'use strict';

  global.VF = global.VF || {};
  if (global.VF._feelTunerMounted) return;
  global.VF._feelTunerMounted = true;

  const DRAFT_KEY = 'vf_small_feel_draft_v2';

  const SCHEMA = [
    {
      id: 'view',
      title: '枪械手感 · 视角后坐 / 准星回落',
      fields: [
        { key: 'pitchMul', label: '视角抬升系数', min: 0, max: 2, step: 0.01 },
        { key: 'velMul', label: '视角速度冲量', min: 0, max: 80, step: 1 },
        { key: 'yawMul', label: '水平抖动', min: 0, max: 1.5, step: 0.01 },
        { key: 'adsRecoilMul', label: 'ADS 后坐倍率', min: 0.1, max: 1, step: 0.01 },
        {
          key: 'settleRemain',
          label: '回落后保留比例(0全回/0.25留¼/0.5一半)',
          min: 0,
          max: 0.8,
          step: 0.05,
        },
        { key: 'idleDelay', label: '停火后开始回落(秒)', min: 0.05, max: 0.5, step: 0.01 },
        { key: 'fireSpring', label: '射击中弹簧', min: 0, max: 80, step: 1 },
        { key: 'fireDamp', label: '射击中阻尼', min: 1, max: 20, step: 0.5 },
        { key: 'recoverSpring', label: '回落弹簧', min: 20, max: 200, step: 5 },
        { key: 'recoverDamp', label: '回落阻尼', min: 2, max: 20, step: 0.5 },
        { key: 'pitchCap', label: '视角抬升硬顶', min: 0.04, max: 0.4, step: 0.01 },
        { key: 'pitchFloor', label: '视角下冲下限', min: -0.1, max: 0, step: 0.01 },
        { key: 'yawCap', label: '水平硬顶', min: 0.02, max: 0.2, step: 0.01 },
      ],
    },
    {
      id: 'gun',
      title: '枪械手感 · 枪模 Kick',
      fields: [
        { key: 'kickMul', label: 'Kick 冲量', min: 0, max: 8, step: 0.1 },
        { key: 'kickMax', label: 'Kick 种子上限', min: 0.1, max: 1.5, step: 0.05 },
        { key: 'velMul', label: 'Kick 速度冲量', min: 0, max: 80, step: 1 },
        { key: 'spring', label: '弹簧强度', min: 20, max: 400, step: 5 },
        { key: 'damp', label: '弹簧阻尼', min: 1, max: 30, step: 0.5 },
        { key: 'kickFloor', label: 'Kick 下限', min: -0.2, max: 0, step: 0.01 },
        { key: 'kickCeil', label: 'Kick 上限', min: 0.1, max: 1.2, step: 0.05 },
        { key: 'posePitch', label: '枪口抬角倍率', min: 0, max: 3, step: 0.05 },
        { key: 'poseRoll', label: '枪口横滚倍率', min: 0, max: 0.5, step: 0.01 },
        { key: 'poseY', label: '枪身上抬', min: 0, max: 0.2, step: 0.005 },
        { key: 'poseZ', label: '枪身后坐', min: 0, max: 0.2, step: 0.005 },
        { key: 'equipRate', label: '切枪抬起速度', min: 1, max: 8, step: 0.1 },
        { key: 'equipDip', label: '切枪下沉', min: 0, max: 0.6, step: 0.01 },
        { key: 'equipPitch', label: '切枪俯角', min: 0, max: 1.5, step: 0.05 },
      ],
    },
    {
      id: 'shake',
      title: '屏幕震动',
      fields: [
        { key: 'max', label: '震动上限', min: 0.05, max: 1, step: 0.01 },
        { key: 'decay', label: '衰减速度', min: 2, max: 40, step: 1 },
        { key: 'fireBase', label: '开火震动基础', min: 0, max: 0.1, step: 0.005 },
        { key: 'fireRecoilMul', label: '开火×后坐倍率', min: 0, max: 0.5, step: 0.01 },
        { key: 'axisY', label: 'Y 轴权重', min: 0, max: 1.5, step: 0.05 },
        { key: 'axisZ', label: 'Z 轴权重', min: 0, max: 1.5, step: 0.05 },
      ],
    },
    {
      id: 'hit',
      title: '命中反馈',
      fields: [
        { key: 'shake', label: '命中震动', min: 0, max: 0.3, step: 0.005 },
        { key: 'shakeDmg', label: '震动随伤害', min: 0, max: 0.01, step: 0.0001 },
        { key: 'shakeDmgCap', label: '伤害震动上限', min: 0, max: 0.2, step: 0.005 },
        { key: 'heavyExtra', label: '重击额外震动', min: 0, max: 0.15, step: 0.005 },
        { key: 'pitch', label: '命中视角踢', min: 0, max: 0.05, step: 0.001 },
        { key: 'heavyPitch', label: '重击视角踢', min: 0, max: 0.05, step: 0.001 },
        { key: 'fov', label: '命中 FOV', min: -10, max: 0, step: 0.5 },
        { key: 'heavyFov', label: '重击 FOV', min: -10, max: 0, step: 0.5 },
      ],
    },
    {
      id: 'kill',
      title: '击杀反馈',
      fields: [
        { key: 'shake', label: '击杀震动', min: 0, max: 0.4, step: 0.01 },
        { key: 'pitch', label: '击杀视角踢', min: 0, max: 0.06, step: 0.001 },
        { key: 'fov', label: '击杀 FOV', min: -12, max: 0, step: 0.5 },
      ],
    },
    {
      id: 'hurt',
      title: '受击反馈',
      fields: [
        { key: 'shakeBase', label: '震动基础', min: 0, max: 0.4, step: 0.01 },
        { key: 'shakeDmg', label: '震动随伤害', min: 0, max: 0.02, step: 0.001 },
        { key: 'shakeMax', label: '震动上限', min: 0.05, max: 0.6, step: 0.01 },
        { key: 'fovBase', label: 'FOV 基础', min: 0, max: 10, step: 0.5 },
        { key: 'fovDmg', label: 'FOV 随伤害', min: 0, max: 0.3, step: 0.01 },
        { key: 'fovMax', label: 'FOV 上限', min: 1, max: 16, step: 0.5 },
        { key: 'pitchBase', label: '抬头基础', min: 0, max: 0.08, step: 0.001 },
        { key: 'pitchDmg', label: '抬头随伤害', min: 0, max: 0.01, step: 0.0005 },
        { key: 'pitchDmgCap', label: '抬头伤害上限', min: 0, max: 0.08, step: 0.001 },
        { key: 'yawBase', label: '甩头基础', min: 0, max: 0.1, step: 0.005 },
        { key: 'yawDmg', label: '甩头随伤害', min: 0, max: 0.01, step: 0.0005 },
        { key: 'yawDmgCap', label: '甩头伤害上限', min: 0, max: 0.1, step: 0.005 },
        { key: 'yawRandom', label: '随机甩头', min: 0, max: 0.15, step: 0.005 },
        { key: 'flashMs', label: '红闪时长 ms', min: 50, max: 500, step: 10 },
      ],
    },
    {
      id: 'camera',
      title: '相机',
      fields: [
        { key: 'hipFov', label: '腰射 FOV', min: 50, max: 100, step: 1 },
        { key: 'adsFov', label: '默认 ADS FOV', min: 20, max: 70, step: 1 },
        { key: 'adsFovIn', label: '开镜 FOV 速率', min: 4, max: 28, step: 0.5 },
        { key: 'adsFovOut', label: '关镜 FOV 速率', min: 3, max: 20, step: 0.5 },
        { key: 'adsBlendIn', label: '开镜枪模速率', min: 4, max: 24, step: 0.5 },
        { key: 'adsBlendOut', label: '关镜枪模速率', min: 3, max: 20, step: 0.5 },
        { key: 'camRoll', label: '平移滚转', min: 0, max: 0.08, step: 0.002 },
        { key: 'stairSmooth', label: '楼梯镜头平滑', min: 8, max: 32, step: 0.5 },
        { key: 'mouseSens', label: '鼠标灵敏度', min: 0.0005, max: 0.008, step: 0.0001 },
        { key: 'adsSens', label: 'ADS 灵敏度', min: 0.0003, max: 0.004, step: 0.0001 },
      ],
    },
    {
      id: 'crosshair',
      title: '准星反馈时长',
      fields: [
        { key: 'fireMs', label: '开火 ms', min: 50, max: 400, step: 10 },
        { key: 'hitMs', label: '命中 ms', min: 50, max: 400, step: 10 },
        { key: 'killMs', label: '击杀 ms', min: 80, max: 600, step: 10 },
      ],
    },
    {
      id: 'ai',
      title: '局内 AI',
      fields: [
        { key: 'teamSize', label: '每方人数(重开局)', min: 5, max: 40, step: 1 },
        { key: 'speedMul', label: '移速倍率(即时)', min: 0.2, max: 3, step: 0.05 },
        { key: 'hpMul', label: '生命倍率(重开局)', min: 0.2, max: 4, step: 0.05 },
        { key: 'damageMul', label: '伤害倍率(即时)', min: 0.2, max: 4, step: 0.05 },
        { key: 'fireRateMul', label: '射击间隔倍率(即时·越小越快)', min: 0.2, max: 2, step: 0.05 },
        { key: 'accuracyMul', label: '命中倍率(即时)', min: 0.2, max: 3, step: 0.05 },
      ],
    },
    {
      id: 'playerMove',
      title: '玩家移速',
      fields: [
        { key: 'moveSpeed', label: '基础移速', min: 3, max: 16, step: 0.1 },
        { key: 'sprintMul', label: '冲刺倍率', min: 1, max: 2.5, step: 0.01 },
        { key: 'crouchMul', label: '蹲走倍率', min: 0.2, max: 1, step: 0.01 },
        { key: 'adsMul', label: 'ADS 移速倍率', min: 0.2, max: 1, step: 0.01 },
        { key: 'slideMul', label: '滑铲倍率', min: 0.8, max: 2, step: 0.01 },
        { key: 'slideDur', label: '滑铲时长(秒)', min: 0.2, max: 1, step: 0.01 },
      ],
    },
    {
      id: 'airStrike',
      title: '空袭导弹爆炸(即时)',
      fields: [
        { key: 'size', label: '整体大小', min: 0.3, max: 4, step: 0.05 },
        { key: 'sizeVar', label: '大小随机幅度', min: 0, max: 1.5, step: 0.05 },
        { key: 'stemH', label: '火柱高度', min: 2, max: 60, step: 0.5 },
        { key: 'capR', label: '蘑菇帽半径', min: 0.4, max: 12, step: 0.1 },
        { key: 'ringR', label: '冲击环半径', min: 0.8, max: 20, step: 0.1 },
        { key: 'life', label: '特效时长(秒)', min: 0.8, max: 8, step: 0.1 },
        { key: 'dust', label: '灰尘量(0关)', min: 0, max: 2.5, step: 0.1 },
        { key: 'dustSize', label: '灰尘大小', min: 0.3, max: 3, step: 0.05 },
        { key: 'smoke', label: '烟团量(0关)', min: 0, max: 2.5, step: 0.1 },
        { key: 'carveR', label: '破块半径', min: 1, max: 16, step: 0.25 },
        { key: 'breakMax', label: '最多破块数', min: 0, max: 40, step: 1 },
        { key: 'damageR', label: '伤害半径', min: 2, max: 24, step: 0.25 },
        { key: 'shake', label: '近距震动', min: 0, max: 0.25, step: 0.005 },
        { key: 'shakeReach', label: '震动距离', min: 10, max: 120, step: 2 },
      ],
    },
  ];

  const WEAPON_IDS = ['ar', 'sg', 'sr'];
  const WEAPON_FIELDS = [
    { key: 'recoil', label: '后坐力', min: 0, max: 0.4, step: 0.005 },
    { key: 'spread', label: '腰射散布', min: 0, max: 0.25, step: 0.001 },
    { key: 'adsSpread', label: 'ADS 散布', min: 0, max: 0.15, step: 0.001 },
    { key: 'fireRate', label: '射速(秒/发)', min: 0.05, max: 2, step: 0.01 },
  ];

  function ensureFeel() {
    if (!global.VF.Feel) global.VF.Feel = {};
    if (!global.VF.FeelDefaults) {
      global.VF.FeelDefaults = JSON.parse(JSON.stringify(global.VF.Feel));
    }
  }

  function deepAssign(target, src) {
    if (!src || typeof src !== 'object') return target;
    Object.keys(src).forEach(function (k) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
        if (!target[k] || typeof target[k] !== 'object') target[k] = {};
        deepAssign(target[k], src[k]);
      } else {
        target[k] = src[k];
      }
    });
    return target;
  }

  function getPath(obj, group, key) {
    return obj && obj[group] ? obj[group][key] : undefined;
  }

  function setPath(group, key, value) {
    ensureFeel();
    if (!global.VF.Feel[group]) global.VF.Feel[group] = {};
    global.VF.Feel[group][key] = value;
    saveDraft();
  }

  function setWeapon(id, key, value) {
    ensureFeel();
    if (!global.VF.Feel.weapons) global.VF.Feel.weapons = {};
    if (!global.VF.Feel.weapons[id]) global.VF.Feel.weapons[id] = {};
    global.VF.Feel.weapons[id][key] = value;
    saveDraft();
  }

  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(global.VF.Feel));
    } catch (e) {
      /* ignore */
    }
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      deepAssign(global.VF.Feel, parsed);
    } catch (e) {
      /* ignore */
    }
  }

  function restoreGroup(groupId) {
    ensureFeel();
    const def = global.VF.FeelDefaults && global.VF.FeelDefaults[groupId];
    if (!def) return;
    global.VF.Feel[groupId] = JSON.parse(JSON.stringify(def));
    saveDraft();
    rebuildBody();
  }

  function restoreAll() {
    ensureFeel();
    if (!global.VF.FeelDefaults) return;
    global.VF.Feel = JSON.parse(JSON.stringify(global.VF.FeelDefaults));
    saveDraft();
    rebuildBody();
  }

  function exportConfig() {
    ensureFeel();
    const json = JSON.stringify(global.VF.Feel, null, 2);
    const body =
      '/**\n' +
      ' * feel-config.js — Baked feel defaults (KEEP on production).\n' +
      ' * Generated by feel-tuner Export. Replace this file, then delete feel-tuner.js for ship.\n' +
      ' */\n' +
      '(function (global) {\n' +
      "  'use strict';\n" +
      '  global.VF = global.VF || {};\n\n' +
      '  global.VF.Feel = ' +
      json +
      ';\n\n' +
      '  global.VF.FeelDefaults = JSON.parse(JSON.stringify(global.VF.Feel));\n' +
      "})(typeof window !== 'undefined' ? window : globalThis);\n";

    const blob = new Blob([body], { type: 'application/javascript;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'feel-config.js';
    a.click();
    URL.revokeObjectURL(a.href);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(body);
      }
    } catch (e) {
      /* ignore */
    }
  }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function makeRow(label, value, min, max, step, onChange) {
    const row = el('div', 'feel-tuner-row');
    row.appendChild(el('label', 'feel-tuner-label', label));
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(value);
    range.className = 'feel-tuner-range';
    const num = document.createElement('input');
    num.type = 'number';
    num.min = String(min);
    num.max = String(max);
    num.step = String(step);
    num.value = String(value);
    num.className = 'feel-tuner-num';
    function sync(v) {
      const n = Number(v);
      if (!isFinite(n)) return;
      range.value = String(n);
      num.value = String(n);
      onChange(n);
    }
    range.addEventListener('input', function () {
      sync(range.value);
    });
    num.addEventListener('change', function () {
      sync(num.value);
    });
    row.appendChild(range);
    row.appendChild(num);
    return row;
  }

  let panel = null;
  let bodyEl = null;
  let tabFeel = null;
  let tabMap = null;
  let mapTabHandler = null;
  let activeTab = 'feel';

  function rebuildBody() {
    if (!bodyEl) return;
    bodyEl.innerHTML = '';
    ensureFeel();

    SCHEMA.forEach(function (section) {
      const sec = el('section', 'feel-tuner-section');
      const head = el('div', 'feel-tuner-section-head');
      head.appendChild(el('h3', null, section.title));
      const btn = el('button', 'feel-tuner-btn-sm', '还原');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        restoreGroup(section.id);
      });
      head.appendChild(btn);
      sec.appendChild(head);

      section.fields.forEach(function (f) {
        let val = getPath(global.VF.Feel, section.id, f.key);
        if (val == null) val = getPath(global.VF.FeelDefaults, section.id, f.key);
        if (val == null) val = f.min;
        sec.appendChild(
          makeRow(f.label, val, f.min, f.max, f.step, function (n) {
            setPath(section.id, f.key, n);
          })
        );
      });
      bodyEl.appendChild(sec);
    });

    WEAPON_IDS.forEach(function (id) {
      const sec = el('section', 'feel-tuner-section');
      const head = el('div', 'feel-tuner-section-head');
      head.appendChild(el('h3', null, '武器 · ' + id.toUpperCase()));
      const btn = el('button', 'feel-tuner-btn-sm', '还原');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        ensureFeel();
        const def =
          global.VF.FeelDefaults &&
          global.VF.FeelDefaults.weapons &&
          global.VF.FeelDefaults.weapons[id];
        if (!def) return;
        if (!global.VF.Feel.weapons) global.VF.Feel.weapons = {};
        global.VF.Feel.weapons[id] = JSON.parse(JSON.stringify(def));
        saveDraft();
        rebuildBody();
      });
      head.appendChild(btn);
      sec.appendChild(head);
      WEAPON_FIELDS.forEach(function (f) {
        let val =
          global.VF.Feel.weapons &&
          global.VF.Feel.weapons[id] &&
          global.VF.Feel.weapons[id][f.key];
        if (val == null) {
          val =
            global.VF.FeelDefaults &&
            global.VF.FeelDefaults.weapons &&
            global.VF.FeelDefaults.weapons[id] &&
            global.VF.FeelDefaults.weapons[id][f.key];
        }
        if (val == null) val = f.min;
        sec.appendChild(
          makeRow(f.label, val, f.min, f.max, f.step, function (n) {
            setWeapon(id, f.key, n);
          })
        );
      });
      bodyEl.appendChild(sec);
    });
  }

  function ensureDevToolbar() {
    let bar = document.getElementById('vf-dev-toolbar');
    if (bar) return bar;
    injectStyles();
    bar = document.createElement('div');
    bar.id = 'vf-dev-toolbar';
    bar.className = 'vf-dev-toolbar';
    document.body.appendChild(bar);
    return bar;
  }

  function injectStyles() {
    if (document.getElementById('feel-tuner-css')) return;
    const s = document.createElement('style');
    s.id = 'feel-tuner-css';
    s.textContent =
      '.vf-dev-toolbar{position:fixed;top:10px;right:10px;z-index:100000;display:flex;gap:6px;' +
      'padding:6px;background:rgba(18,20,24,.92);border:1px solid #3a3d42;border-radius:8px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.45);font:12px/1.2 system-ui,sans-serif}' +
      '.vf-dev-toolbar button{background:#2a2e33;color:#f0c060;border:1px solid #4a4540;border-radius:6px;' +
      'padding:6px 10px;cursor:pointer;font-size:12px}' +
      '.vf-dev-toolbar button:hover,.vf-dev-toolbar button.active{background:#3a3530;filter:brightness(1.08)}' +
      '.feel-tuner-panel{position:fixed;top:52px;right:12px;z-index:99999;width:min(380px,92vw);' +
      'max-height:min(88vh,900px);display:flex;flex-direction:column;background:#1a1c1f;color:#e8e6e1;' +
      'border:1px solid #3a3d42;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.55);' +
      'font:13px/1.35 system-ui,sans-serif}' +
      '.feel-tuner-panel.hidden{display:none!important}' +
      '.feel-tab-row{display:flex;gap:6px;padding:8px 12px 0;background:#121417;flex-shrink:0}' +
      '.feel-tab{flex:1;background:#1c2026;color:#b0b8c0;border:1px solid #333;border-radius:6px 6px 0 0;' +
      'padding:7px 8px;cursor:pointer;font-size:12px}' +
      '.feel-tab.active{background:#1a1c1f;color:#f0c060;border-bottom-color:#1a1c1f}' +
      '.feel-tuner-top{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #333;' +
      'background:#121417;flex-shrink:0}' +
      '.feel-tuner-top h2{flex:1;margin:0;font-size:14px;font-weight:700;letter-spacing:.04em}' +
      '.feel-tuner-btn,.feel-tuner-btn-sm{background:#2a2e33;color:#f0c060;border:1px solid #4a4540;' +
      'border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px}' +
      '.feel-tuner-btn:hover,.feel-tuner-btn-sm:hover{background:#3a3530}' +
      '.feel-tuner-btn-sm{padding:3px 8px;font-size:11px}' +
      '.feel-tuner-body{overflow:auto;padding:8px 10px 14px;flex:1}' +
      '.feel-tuner-section{margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #2a2d32}' +
      '.feel-tuner-section-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}' +
      '.feel-tuner-section-head h3{flex:1;margin:0;font-size:12px;color:#c8b080;font-weight:600}' +
      '.feel-tuner-row{display:grid;grid-template-columns:1fr 1.1fr 58px;gap:6px;align-items:center;margin:5px 0}' +
      '.feel-tuner-label{font-size:11px;color:#b0aea8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.feel-tuner-range{width:100%;accent-color:#e8a030}' +
      '.feel-tuner-num{width:100%;background:#0e1012;border:1px solid #333;color:#eee;border-radius:4px;' +
      'padding:3px 4px;font-size:11px}' +
      '.feel-tuner-hint{padding:6px 12px 10px;font-size:10px;color:#888;border-top:1px solid #2a2d32}' +
      '.feel-map-pane{padding:14px 12px;display:none;flex-direction:column;gap:10px}' +
      '.feel-map-pane.active{display:flex}' +
      '.feel-map-pane p{margin:0;font-size:12px;color:#b0b8c0;line-height:1.5}';
    document.head.appendChild(s);
  }

  function setFeelOpen(open) {
    if (!panel) return;
    if (open) {
      panel.classList.remove('hidden');
      if (activeTab === 'feel') rebuildBody();
    } else {
      panel.classList.add('hidden');
    }
    const btn = document.getElementById('vf-dev-btn-feel');
    if (btn) btn.classList.toggle('active', open);
  }

  function toggleFeel() {
    if (!panel) return;
    const opening = panel.classList.contains('hidden');
    if (opening && global.VF.MapEditor && global.VF.MapEditor.isOpen && global.VF.MapEditor.isOpen()) {
      global.VF.MapEditor.close({ skipLobby: true });
    }
    setFeelOpen(opening);
  }

  function setTab(tab) {
    activeTab = 'feel';
    if (tabFeel) tabFeel.classList.add('active');
    if (bodyEl) bodyEl.style.display = '';
    const feelTop = document.getElementById('feel-tuner-top-actions');
    if (feelTop) feelTop.style.display = '';
    rebuildBody();
  }

  function openMapKit() {
    setFeelOpen(false);
    if (global.VF.MapEditor && global.VF.MapEditor.open) {
      global.VF.MapEditor.open({ fromLobby: true });
    }
  }

  function mount() {
    ensureFeel();
    loadDraft();
    injectStyles();

    const bar = ensureDevToolbar();
    // Remove legacy map buttons — map lives in lobby dock now
    const oldMap = document.getElementById('vf-dev-btn-map');
    if (oldMap && oldMap.parentNode) oldMap.parentNode.removeChild(oldMap);

    let feelBtn = document.getElementById('vf-dev-btn-feel');
    if (!feelBtn) {
      feelBtn = el('button', null, '开发 F10');
      feelBtn.id = 'vf-dev-btn-feel';
      feelBtn.type = 'button';
      feelBtn.title = '参数调节';
      feelBtn.addEventListener('click', function (e) {
        e.preventDefault();
        toggleFeel();
      });
      bar.appendChild(feelBtn);
    } else {
      feelBtn.textContent = '开发 F10';
      feelBtn.title = '参数调节';
    }

    panel = el('div', 'feel-tuner-panel hidden');
    panel.id = 'feel-tuner-panel';

    const top = el('div', 'feel-tuner-top');
    top.id = 'feel-tuner-top-actions';
    top.appendChild(el('h2', null, '参数调节'));
    const exportBtn = el('button', 'feel-tuner-btn', '导出');
    exportBtn.type = 'button';
    exportBtn.title = '下载 feel-config.js（并尝试复制到剪贴板）';
    exportBtn.addEventListener('click', exportConfig);
    const resetBtn = el('button', 'feel-tuner-btn', '全部还原');
    resetBtn.type = 'button';
    resetBtn.addEventListener('click', restoreAll);
    const closeBtn = el('button', 'feel-tuner-btn', '×');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', function () {
      setFeelOpen(false);
    });
    top.appendChild(exportBtn);
    top.appendChild(resetBtn);
    top.appendChild(closeBtn);
    panel.appendChild(top);

    bodyEl = el('div', 'feel-tuner-body');
    panel.appendChild(bodyEl);

    panel.appendChild(
      el(
        'div',
        'feel-tuner-hint',
        'F10 开关 · 导出 feel-config.js · 地图搭建请用大厅底部「地图」'
      )
    );
    document.body.appendChild(panel);
    rebuildBody();

    global.VF.DevTools = global.VF.DevTools || {};
    global.VF.DevTools.ensureToolbar = ensureDevToolbar;
    global.VF.DevTools.toggleFeel = toggleFeel;
    global.VF.DevTools.setFeelOpen = setFeelOpen;
    global.VF.DevTools.registerMapTab = function () {
      /* map moved to lobby */
    };
    global.VF.DevTools.openMapKit = openMapKit;

    document.addEventListener('keydown', function (e) {
      if (e.code !== 'F10') return;
      e.preventDefault();
      toggleFeel();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})(typeof window !== 'undefined' ? window : globalThis);
