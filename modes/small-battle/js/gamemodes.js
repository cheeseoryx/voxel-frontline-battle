/**
 * gamemodes.js — Match rule modes (玩法模式)
 *
 * Two orthogonal axes decide a match:
 *   game.mode      'pve' | 'pvp'   — 对战形式 / 网络拓扑（已有，勿混用）
 *   game.matchMode 'core' | 'tdm'  — 玩法规则（本模块）
 *
 * Every rule difference between modes reads from getParams() so the rest of the
 * codebase never needs to branch on the mode id itself.
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});
  const STORE_KEY = 'vf_small_match_mode_v1';
  const DEFAULT_MODE = 'core';

  /**
   * Locked entries are intentional placeholders: the mode roster is not final,
   * so the rail keeps their slot visible instead of reflowing later.
   */
  const MODES = [
    {
      id: 'core',
      name: '核心攻防',
      sub: '多人对战',
      kicker: 'VOXEL FRONTLINE',
      tags: ['队伍人数 25', '玩家上限 2', '大地图'],
      desc: '摧毁敌方核心。双方核心各 1000 点结构值，率先拆毁对方核心的队伍获胜。',
      accent: '#e8a050',
      art: 'assets/mode-core.png',
      params: {
        teamSize: 25,
        cores: true,
        spawnCapture: true,
        building: true,
        randomMap: false,
        instantRespawn: false,
        friendlyFire: false,
        timeLimit: 0,
        scoreLimit: 0,
        coreHp: 1000,
        reward: 'core',
      },
    },
    {
      id: 'tdm',
      name: '团队死斗',
      sub: '多人对战',
      kicker: 'VOXEL FRONTLINE',
      tags: ['队伍人数 12', '玩家上限 2', '随机地图'],
      desc: '击杀敌对队伍中的玩家。率先达到得分上限的队伍获胜。',
      accent: '#d8524a',
      art: 'assets/mode-tdm.png',
      params: {
        // ⑦ 配置参数表
        scoreLimit: 50,
        timeLimit: 600,
        respawnDelay: 3.0,
        spawnProtection: 1.0,
        friendlyFire: false,
        overtime: false,
        overtimeDuration: 60,
        killstreak: true,

        // ③ 局时结构
        prepTime: 10,
        resultTime: 15,

        // 模式差异开关
        teamSize: 12,
        cores: false,
        spawnCapture: false,
        building: false,
        randomMap: true,
        instantRespawn: true,
        reward: 'tdm',

        // ⑥ 计分规则
        teamScore: { kill: 1, headshot: 1, assist: 0, suicide: -1, teamkill: -1 },
        personalScore: {
          kill: 100,
          headshot: 150,
          assist: 50,
          suicide: -50,
          teamkill: -100,
        },
        assistThreshold: 0.4,
        killstreakTiers: [3, 5, 7],

        // ⑤ 出生点算法 · ⑧ 边界处理
        spawnPickTop: 3,
        spawnDenyWindow: 5.0,
        spawnCampWindow: 5.0,
        spawnCampDeaths: 2,
        spawnBlockedProtection: 3.0,

        // ② 随机地图约束 — low skyline keeps sightlines short and fights dense
        mapHeightCap: 26,
      },
    },
    {
      id: 'demo',
      name: '爆破模式',
      sub: '多人对战',
      kicker: 'VOXEL FRONTLINE',
      tags: ['队伍人数 5', '单命制', 'A/B 包点'],
      desc: '攻方安装并引爆炸弹，守方阻止或拆除。单命制回合对抗，先赢 7 回合获胜（BO13）。',
      accent: '#c9a24b',
      art: 'assets/mode-demo.png',
      params: {
        // 阵营与人数
        teamSize: 5,
        singleLife: true,
        instantRespawn: false,
        friendlyFire: false,
        cores: false,
        spawnCapture: false,
        building: false,
        randomMap: false,
        reward: 'tdm',

        // 回合结构（1.3 / 1.5）
        roundsToWin: 7,
        halfSwapAfter: 6,
        maxRounds: 13,
        overtime: false,

        // 局时（1.5，单位秒）
        buyTime: 15,
        roundTime: 110,
        bombTimer: 45,
        resultTime: 5,
        // 对局结算计分板常驻时长（文档 3.1）：玩家可提前手动返回。
        matchEndHold: 20,

        // 安装（第五部分）
        plantTime: 4.0,
        siteCount: 2,
        plantKey: 'KeyE',
        progressRetain: false,
        retainDuration: 5.0,

        // 拆除（第六部分）
        defuseTime: 7.0,
        defuseTimeWithKit: 3.5,
        defuseRange: 1.5,
        defuseKey: 'KeyE',
        defuseRetain: false,
        defuseKitEnable: true,

        // 携带 / 掉落（第三部分）
        carrierSelectRule: 'player',
        carrySpeedMult: 1.0,
        allowDrop: true,
        dropKey: 'KeyZ',
        pickupRange: 1.0,
        pickupDelay: 0.3,
        pickupMode: 'auto',
        // 0 = 关闭掉落超时的自动搬运。掉在地上的炸弹保持原地，不再自动挪到包点。
        dropTimeout: 0,

        // 全歼分支（1.4）· 边界（6.6）
        attackerElimAutoWin: false,
        defuseTieWinsDefender: true,

        // 随机地图约束（沿用死斗的低天际线，若启用随机图）
        mapHeightCap: 26,
      },
    },
    {
      id: 'ffa',
      name: '自由混战',
      sub: '多人对战',
      kicker: 'VOXEL FRONTLINE',
      tags: ['玩家数 8', '无队伍', '个人排名'],
      desc: '所有人打所有人，没有队友。率先达到 30 杀，或时限内击杀最多者获胜。',
      accent: '#5ad2a0',
      art: 'assets/mode-ffa.png',
      params: {
        // 基础规则（文档第十部分）
        combatants: 8,
        teamSize: 8,
        scoreLimit: 30,
        timeLimit: 600,
        suicidePenalty: -1,

        // 模式差异开关
        ffa: true,
        cores: false,
        spawnCapture: false,
        building: false,
        randomMap: true,
        instantRespawn: true,
        friendlyFire: false,
        reward: 'tdm',

        // 局时结构（复用死斗）
        prepTime: 10,
        resultTime: 15,
        matchEndHold: 20,

        // 复活（文档 4.3 / 十）
        respawnDelay: 2.5,
        spawnProtection: 1.5,
        spawnSafeRadius: 15,
        deathPenaltyTime: 5.0,
        spawnPickTop: 3,

        // 个人计分（文档 2.2）
        personalScore: { kill: 100, headshot: 150, suicide: -50 },

        // 连杀（文档 6 / 十）
        killstreak: true,
        killstreakReset: true,
        killstreakTiers: [3, 5, 7],
        ffaKillstreakNerf: true,

        // 排名（文档 7 / 十）
        showLiveRank: true,
        leaderMarker: true,

        // AI（文档 8.4 / 十）
        aiFleeThreshold: 0.25,
        aiOpportunityKill: true,
        aiThirdParty: true,
        aiTeamCoord: false,
        aiRevengeTendency: 'low',

        // 随机地图约束（沿用死斗低天际线）
        mapHeightCap: 26,
      },
    },
    {
      id: 'gungame',
      name: '枪械模式',
      sub: '多人对战',
      kicker: 'VOXEL FRONTLINE',
      tags: ['玩家数 8', '无队伍', '武器进阶'],
      desc: '所有人从同一把武器开始，每击杀 1 人升一级武器。最先用最后一把武器完成击杀者获胜。',
      accent: '#8f7bd8',
      art: 'assets/mode-gun.png',
      params: {
        // 基础规则（文档 2.1 / 八）
        combatants: 8,
        teamSize: 8,
        // 无硬时限，1200s 兜底：时限到则等级最高者胜
        timeLimit: 1200,

        // 模式差异开关
        gungame: true,
        cores: false,
        spawnCapture: false,
        building: false,
        randomMap: true,
        instantRespawn: true,
        friendlyFire: false,
        reward: 'tdm',

        /**
         * 武器序列（文档 2.3）——等级 = 数组下标，最后一项即最终级。
         * 目前项目只有 AKM(ar) / 870(sg) / SVD(sr) 三把枪，所以先在这三把里
         * 轮动凑出 9 级；新增枪种后只改这一个数组即可加长阶梯。
         */
        weaponSequence: ['ar', 'sg', 'sr', 'ar', 'sg', 'sr', 'ar', 'sg', 'sr'],
        ammoRefillOnSwitch: true,
        ammoRefillOnKill: true,
        // 方案A（文档 9.1 严格）：只有用当前等级武器直接击杀才升级
        strictWeaponCredit: true,

        /**
         * 降级（文档 3.1）——项目没有近战武器，所以「刀杀降级」落地为
         * 「被爆头击杀降级」：爆头同样要求贴近/精准，保留了压制领先者的作用。
         */
        demoteEnable: true,
        demoteLevels: 1,
        demoteFloor: 0,
        finalLevelProtection: false,
        suicideDemote: false,

        // 复活（文档 八）
        respawnDelay: 2.5,
        spawnProtection: 1.5,
        spawnSafeRadius: 15,
        deathPenaltyTime: 5.0,
        spawnPickTop: 3,
        spawnCampWindow: 5.0,
        spawnCampDeaths: 2,
        spawnBlockedProtection: 3.0,

        // 局时结构（复用死斗 / 自由混战）
        prepTime: 10,
        resultTime: 15,
        matchEndHold: 20,

        // 系统（文档 4.3 / 八）：连杀奖励关闭，聚焦武器进阶本身
        killstreak: false,
        weaponCustomization: false,

        // 进度可视化（文档 五）
        showLiveRank: true,
        leaderMarker: true,

        // AI（文档 6 / 八）
        aiWeaponAdapt: true,
        aiFleeThreshold: 0.25,
        aiTeamCoord: false,
        /** AI 命中玩家时的爆头概率——没有它，降级只能玩家单向触发。 */
        aiHeadshotChance: 0.18,

        // 随机地图：复用自由混战的随机图
        mapHeightCap: 26,
      },
    },
  ];

  const byId = {};
  for (let i = 0; i < MODES.length; i++) byId[MODES[i].id] = MODES[i];

  const state = {
    open: false,
    entry: 'pve',
    focused: DEFAULT_MODE,
    onConfirm: null,
    onCancel: null,
    els: null,
    bound: false,
  };

  function readStored() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(STORE_KEY);
      if (raw && byId[raw] && !byId[raw].locked) return raw;
    } catch (e) {
      /* private mode */
    }
    return DEFAULT_MODE;
  }

  function writeStored(id) {
    try {
      if (global.localStorage) global.localStorage.setItem(STORE_KEY, id);
    } catch (e) {
      /* private mode */
    }
  }

  function currentId() {
    const g = VF.game;
    const id = g && g.matchMode;
    return id && byId[id] ? id : DEFAULT_MODE;
  }

  function get(id) {
    return byId[id] || byId[DEFAULT_MODE];
  }

  function current() {
    return get(currentId());
  }

  function getParams(id) {
    const mode = get(id || currentId());
    return mode.params || {};
  }

  /** Single read point for every mode-dependent rule value. */
  function param(key, fallback) {
    const p = getParams();
    return p[key] != null ? p[key] : fallback;
  }

  function setMode(id) {
    if (!byId[id] || byId[id].locked) return currentId();
    if (VF.game) VF.game.matchMode = id;
    writeStored(id);
    return id;
  }

  function isTdm() {
    return currentId() === 'tdm';
  }

  /** 爆破（Search & Destroy）— single-life round mode. */
  function isSd() {
    return currentId() === 'demo';
  }

  /** 自由混战（Free-For-All）— teamless individual deathmatch. */
  function isFfa() {
    return currentId() === 'ffa';
  }

  /** 枪械模式（Gun Game）— teamless, win by finishing the weapon ladder. */
  function isGg() {
    return currentId() === 'gungame';
  }

  /**
   * No teams at all: 自由混战 and 枪械模式 both put the player alone against
   * everyone. Callers that only care about "is this a teamless arena" (AI
   * rostering, spawn plumbing, start-spawn assignment) use this instead of
   * testing each mode id.
   */
  function isTeamless() {
    return isFfa() || isGg();
  }

  /**
   * Countdown before combat: player may look around but cannot move or attack.
   * Covers TDM/FFA/GG prep and demolition buy.
   */
  function prepFrozen() {
    const tdm = VF.TdmMatch;
    if (tdm && tdm.active && !tdm.ended && tdm.phase === 'prep') return true;
    const ffa = VF.FfaMatch;
    if (ffa && ffa.active && !ffa.ended && ffa.phase === 'prep') return true;
    const gg = VF.GgMatch;
    if (gg && gg.active && !gg.ended && gg.phase === 'prep') return true;
    const sd = VF.SdMatch;
    if (sd && sd.active && !sd.matchOver && sd.phase === 'buy') return true;
    return false;
  }

  /* ───────────────────────── 模式选择界面 ───────────────────────── */

  function els() {
    if (state.els) return state.els;
    const root = document.getElementById('mode-select-overlay');
    if (!root) return null;
    state.els = {
      root: root,
      hero: document.getElementById('mode-hero'),
      kicker: document.getElementById('mode-hero-kicker'),
      name: document.getElementById('mode-hero-name'),
      tags: document.getElementById('mode-hero-tags'),
      desc: document.getElementById('mode-hero-desc'),
      entry: document.getElementById('mode-hero-entry'),
      cards: document.getElementById('mode-rail-cards'),
      start: document.getElementById('mode-start-btn'),
      note: document.getElementById('mode-hero-note'),
    };
    return state.els;
  }

  function bind() {
    const e = els();
    if (!e || state.bound) return;
    state.bound = true;

    e.root.addEventListener('click', function (ev) {
      const action = ev.target.closest('[data-mode-action]');
      if (action && e.root.contains(action)) {
        ev.preventDefault();
        const kind = action.getAttribute('data-mode-action');
        if (kind === 'close') close(true);
        else if (kind === 'start') confirm();
        return;
      }
      const card = ev.target.closest('[data-mode-id]');
      if (card && e.root.contains(card)) {
        ev.preventDefault();
        const id = card.getAttribute('data-mode-id');
        if (byId[id] && byId[id].locked) return;
        if (id === state.focused) confirm();
        else focus(id);
      }
    });

    document.addEventListener('keydown', function (ev) {
      if (!state.open) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        close(true);
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        confirm();
      }
    });
  }

  function renderCards() {
    const e = els();
    if (!e || !e.cards) return;
    e.cards.innerHTML = '';
    for (let i = 0; i < MODES.length; i++) {
      const m = MODES[i];
      const card = document.createElement('button');
      card.type = 'button';
      card.className =
        'mode-card' +
        (m.locked ? ' locked' : '') +
        (m.id === state.focused ? ' active' : '');
      card.setAttribute('data-mode-id', m.id);
      card.disabled = !!m.locked;

      const art = document.createElement('span');
      art.className = 'mode-card-art';
      art.setAttribute('aria-hidden', 'true');
      if (m.accent) art.style.borderBottomColor = m.accent;
      if (m.art) {
        art.style.backgroundImage = "url('" + m.art + "')";
        art.style.backgroundSize = 'cover';
        art.style.backgroundPosition = 'center';
      }
      card.appendChild(art);

      const title = document.createElement('span');
      title.className = 'mode-card-title';
      title.textContent = m.name;
      card.appendChild(title);

      const sub = document.createElement('span');
      sub.className = 'mode-card-sub';
      sub.textContent = m.sub || '';
      card.appendChild(sub);

      if (m.locked) {
        const lock = document.createElement('span');
        lock.className = 'mode-card-lock';
        lock.textContent = '未解锁';
        card.appendChild(lock);
      }
      e.cards.appendChild(card);
    }
  }

  function renderHero() {
    const e = els();
    if (!e) return;
    const m = get(state.focused);
    if (e.kicker) e.kicker.textContent = m.kicker || '';
    if (e.name) e.name.textContent = m.name;
    if (e.desc) e.desc.textContent = m.desc || '';
    if (e.hero && m.accent) e.hero.style.setProperty('--mode-accent', m.accent);
    if (e.hero) {
      e.hero.style.setProperty('--mode-art', m.art ? "url('" + m.art + "')" : 'none');
    }
    if (e.entry) {
      e.entry.textContent = state.entry === 'pvp' ? 'PVP · 玩家对战' : 'PVE · 人机对战';
    }
    if (e.tags) {
      e.tags.innerHTML = '';
      const tags = m.tags || [];
      for (let i = 0; i < tags.length; i++) {
        const t = document.createElement('span');
        t.className = 'mode-hero-tag';
        t.textContent = tags[i];
        e.tags.appendChild(t);
      }
    }
    if (e.start) {
      e.start.disabled = !!m.locked;
      e.start.textContent = m.locked ? '未解锁' : '进入战斗';
    }
    if (e.note) {
      e.note.textContent = m.locked ? '该模式尚未开放。' : '';
      e.note.classList.toggle('hidden', !m.locked);
    }
  }

  function focus(id) {
    if (!byId[id]) return;
    state.focused = id;
    renderCards();
    renderHero();
  }

  function open(entry, onConfirm, onCancel) {
    const e = els();
    if (!e) {
      // No overlay in the DOM — fall through so the entry still works
      if (onConfirm) onConfirm(currentId());
      return;
    }
    bind();
    state.open = true;
    state.entry = entry === 'pvp' ? 'pvp' : 'pve';
    state.onConfirm = onConfirm || null;
    state.onCancel = onCancel || null;
    state.focused = readStored();
    renderCards();
    renderHero();
    e.root.classList.remove('hidden');
  }

  function close(cancelled) {
    const e = els();
    if (!state.open) return null;
    state.open = false;
    if (e) e.root.classList.add('hidden');
    const confirmCb = state.onConfirm;
    const cancelCb = state.onCancel;
    state.onConfirm = null;
    state.onCancel = null;
    if (cancelled) {
      if (cancelCb) cancelCb();
      return null;
    }
    return confirmCb;
  }

  function confirm() {
    const m = get(state.focused);
    if (m.locked) return;
    setMode(m.id);
    const cb = close(false);
    if (cb) cb(m.id);
  }

  VF.GameModes = {
    MODES: MODES,
    list: function () {
      return MODES.slice();
    },
    get: get,
    current: current,
    currentId: currentId,
    getParams: getParams,
    param: param,
    setMode: setMode,
    isTdm: isTdm,
    isSd: isSd,
    isFfa: isFfa,
    isGg: isGg,
    isTeamless: isTeamless,
    prepFrozen: prepFrozen,
    restore: function () {
      return setMode(readStored());
    },
    open: open,
    close: close,
    isOpen: function () {
      return state.open;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
