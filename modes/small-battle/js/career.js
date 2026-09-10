/**
 * career.js — Persistent soldier stats and achievements.
 *
 * The large-battlefield build kept a live Scoring snapshot (kills / score /
 * ribbons) and painted it in soldier-menu. That snapshot died with the match
 * and the achievement ids never matched the ribbon ids. Here the same numbers
 * are stored across matches, and the checklist is rewritten for the modes we
 * actually ship: 核心攻防 / 团队死斗 / 爆破 / 自由混战 / 枪械模式.
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});
  const STORE_KEY = 'vf_small_career_v1';
  const LONG_KILL_M = 40;
  const HEAL_UNIT = 10;

  const MODE_LABEL = {
    core: '核心攻防',
    tdm: '团队死斗',
    demo: '爆破模式',
    ffa: '自由混战',
    gungame: '枪械模式',
  };

  const CLASS_LABEL = {
    vanguard: '先锋',
    medic: '医护',
    ghost: '幽灵',
    juggernaut: '重装',
    raider: '掠夺者',
    engineer: '工程',
  };

  const ACHIEVEMENTS = [
    { id: 'first-match', name: '首战告捷', desc: '完成第一场对局' },
    { id: 'first-win', name: '旗开得胜', desc: '赢得第一场对局' },
    { id: 'combat', name: '战场火力', desc: '单局击杀 5 人' },
    { id: 'kills-50', name: '百步之内', desc: '生涯累计击杀 50 人' },
    { id: 'marksman', name: '百步穿杨', desc: '累计完成 10 次 40 米外击杀' },
    { id: 'headshots-10', name: '爆头专精', desc: '累计爆头 10 次' },
    { id: 'support-20', name: '全面支援', desc: '累计为友军恢复 200 点生命' },
    { id: 'objective-5', name: '目标专家', desc: '累计完成 5 次拆核 / 安装 / 拆除' },
    { id: 'core-win', name: '核心突破', desc: '赢得一场核心攻防' },
    { id: 'tdm-win', name: '死斗赢家', desc: '赢得一场团队死斗' },
    { id: 'ffa-win', name: '独行猎手', desc: '赢得一场自由混战' },
    { id: 'demo-win', name: '爆破专家', desc: '赢得一场爆破模式' },
    { id: 'gg-win', name: '军械库大师', desc: '赢得一场枪械模式' },
    { id: 'nade-10', name: '投掷手', desc: '累计用投掷物击杀 10 人' },
    { id: 'knife-10', name: '冷兵器', desc: '累计近战击杀 10 人' },
  ];

  const session = {
    active: false,
    committed: false,
    startedAt: 0,
    mode: 'core',
    classId: 'vanguard',
    kills: 0,
    deaths: 0,
    headshots: 0,
    shots: 0,
    hits: 0,
    longKills: 0,
    nadeKills: 0,
    knifeKills: 0,
    healHp: 0,
    plants: 0,
    defuses: 0,
    cores: 0,
    score: 0,
    longestKill: 0,
    weapons: {},
  };

  function finite(n) {
    const v = Number(n);
    return isFinite(v) ? v : 0;
  }

  function blankMode() {
    return { matches: 0, wins: 0, losses: 0, draws: 0, kills: 0, deaths: 0 };
  }

  function defaultCareer() {
    return {
      playtimeSec: 0,
      score: 0,
      kills: 0,
      deaths: 0,
      headshots: 0,
      shots: 0,
      hits: 0,
      longKills: 0,
      nadeKills: 0,
      knifeKills: 0,
      healHp: 0,
      plants: 0,
      defuses: 0,
      cores: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      matches: 0,
      longestKill: 0,
      ribbons: [],
      modes: {},
      weapons: {},
      classes: {},
    };
  }

  function normalize(raw) {
    const d = defaultCareer();
    if (!raw || typeof raw !== 'object') return d;
    Object.keys(d).forEach(function (k) {
      if (k === 'ribbons' || k === 'modes' || k === 'weapons' || k === 'classes') return;
      if (raw[k] != null) d[k] = Math.max(0, finite(raw[k]));
    });
    d.ribbons = Array.isArray(raw.ribbons)
      ? raw.ribbons.filter(function (id, i, arr) {
          return id && arr.indexOf(id) === i;
        })
      : [];
    d.modes = raw.modes && typeof raw.modes === 'object' ? raw.modes : {};
    d.weapons = raw.weapons && typeof raw.weapons === 'object' ? raw.weapons : {};
    d.classes = raw.classes && typeof raw.classes === 'object' ? raw.classes : {};
    return d;
  }

  function load() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(STORE_KEY);
      if (!raw) return defaultCareer();
      return normalize(JSON.parse(raw));
    } catch (e) {
      return defaultCareer();
    }
  }

  function save(data) {
    try {
      if (global.localStorage) global.localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch (e) {
      /* private mode */
    }
    return data;
  }

  function inRange() {
    return !!(VF.Range && VF.Range.isOpen);
  }

  function currentMode() {
    const GM = VF.GameModes;
    return (GM && GM.currentId && GM.currentId()) || 'core';
  }

  function currentClass() {
    const g = VF.game;
    return (g && g.player && g.player.classId) || (g && g.playerClass) || 'vanguard';
  }

  function weaponBucket(id) {
    if (!id) return null;
    if (id === 'knife') return 'knife';
    const nades = VF.THROWABLE_CATALOG || {};
    if (nades[id]) return id;
    return id;
  }

  function isNade(id) {
    return !!(VF.THROWABLE_CATALOG && VF.THROWABLE_CATALOG[id]);
  }

  function bumpWeapon(map, id, field, n) {
    if (!id) return;
    const row = map[id] || (map[id] = { kills: 0, shots: 0, hits: 0, headshots: 0 });
    row[field] = (row[field] || 0) + (n || 1);
  }

  function resetSession() {
    session.active = false;
    session.committed = false;
    session.startedAt = 0;
    session.kills = 0;
    session.deaths = 0;
    session.headshots = 0;
    session.shots = 0;
    session.hits = 0;
    session.longKills = 0;
    session.nadeKills = 0;
    session.knifeKills = 0;
    session.healHp = 0;
    session.plants = 0;
    session.defuses = 0;
    session.cores = 0;
    session.score = 0;
    session.longestKill = 0;
    session.weapons = {};
  }

  function start() {
    if (inRange()) return;
    resetSession();
    session.active = true;
    session.startedAt = performance.now();
    session.mode = currentMode();
    session.classId = currentClass();
  }

  function pullSdExtras() {
    const S = VF.SdStats;
    if (!S || !S.byId || !S.byId.player) return;
    const p = S.byId.player;
    session.plants = Math.max(session.plants, p.plants || 0);
    session.defuses = Math.max(session.defuses, p.defuses || 0);
  }

  function unlock(career, id) {
    if (!id || career.ribbons.indexOf(id) >= 0) return false;
    career.ribbons.push(id);
    return true;
  }

  function evaluate(career, sess) {
    const fresh = [];
    const mark = function (id, ok) {
      if (ok && unlock(career, id)) fresh.push(id);
    };
    mark('first-match', career.matches >= 1);
    mark('first-win', career.wins >= 1);
    mark('combat', (sess && sess.kills >= 5) || career.ribbons.indexOf('combat') >= 0);
    mark('kills-50', career.kills >= 50);
    mark('marksman', career.longKills >= 10);
    mark('headshots-10', career.headshots >= 10);
    mark('support-20', career.healHp >= 200);
    mark('objective-5', career.cores + career.plants + career.defuses >= 5);
    mark('core-win', (career.modes.core && career.modes.core.wins) >= 1);
    mark('tdm-win', (career.modes.tdm && career.modes.tdm.wins) >= 1);
    mark('ffa-win', (career.modes.ffa && career.modes.ffa.wins) >= 1);
    mark('demo-win', (career.modes.demo && career.modes.demo.wins) >= 1);
    mark('gg-win', (career.modes.gungame && career.modes.gungame.wins) >= 1);
    mark('nade-10', career.nadeKills >= 10);
    mark('knife-10', career.knifeKills >= 10);
    return fresh;
  }

  function toastUnlocks(ids) {
    if (!ids || !ids.length || !VF.UI || !VF.UI.toast) return;
    const byId = {};
    for (let i = 0; i < ACHIEVEMENTS.length; i++) byId[ACHIEVEMENTS[i].id] = ACHIEVEMENTS[i];
    for (let i = 0; i < ids.length; i++) {
      const a = byId[ids[i]];
      VF.UI.toast('成就解锁 · ' + (a ? a.name : ids[i]));
    }
  }

  /**
   * @param {boolean|null} won  true win, false loss, null abandon/unknown
   */
  function finish(won) {
    if (!session.active || session.committed) return null;
    session.committed = true;
    pullSdExtras();
    const elapsed = Math.max(0, (performance.now() - session.startedAt) / 1000);
    const career = load();
    const mode = session.mode || 'core';
    const cls = session.classId || 'vanguard';
    const modeRow = career.modes[mode] || (career.modes[mode] = blankMode());
    const classRow =
      career.classes[cls] || (career.classes[cls] = { kills: 0, score: 0, playtimeSec: 0, matches: 0 });

    career.playtimeSec += elapsed;
    career.score += session.score;
    career.kills += session.kills;
    career.deaths += session.deaths;
    career.headshots += session.headshots;
    career.shots += session.shots;
    career.hits += session.hits;
    career.longKills += session.longKills;
    career.nadeKills += session.nadeKills;
    career.knifeKills += session.knifeKills;
    career.healHp += session.healHp;
    career.plants += session.plants;
    career.defuses += session.defuses;
    if (won === true && mode === 'core') career.cores += 1;
    career.cores += session.cores;
    career.matches += 1;
    if (won === true) career.wins += 1;
    else if (won === false) career.losses += 1;
    else career.draws += 1;
    if (session.longestKill > career.longestKill) career.longestKill = session.longestKill;

    modeRow.matches += 1;
    modeRow.kills += session.kills;
    modeRow.deaths += session.deaths;
    if (won === true) modeRow.wins += 1;
    else if (won === false) modeRow.losses += 1;
    else modeRow.draws += 1;

    classRow.kills += session.kills;
    classRow.score += session.score;
    classRow.playtimeSec += elapsed;
    classRow.matches += 1;

    Object.keys(session.weapons).forEach(function (id) {
      const src = session.weapons[id];
      const dst = career.weapons[id] || (career.weapons[id] = { kills: 0, shots: 0, hits: 0, headshots: 0 });
      dst.kills += src.kills || 0;
      dst.shots += src.shots || 0;
      dst.hits += src.hits || 0;
      dst.headshots += src.headshots || 0;
    });

    const fresh = evaluate(career, session);
    save(career);
    session.active = false;
    toastUnlocks(fresh);
    return { career: career, unlocked: fresh };
  }

  function live() {
    return session.active && !session.committed && !inRange();
  }

  function noteKill(opts) {
    if (!live()) return;
    opts = opts || {};
    session.kills += 1;
    session.score += opts.headshot ? 150 : 100;
    const id = weaponBucket(opts.weaponId) || weaponBucket(VF.game && VF.game.weapons && VF.game.weapons.current);
    if (id) bumpWeapon(session.weapons, id, 'kills', 1);
    if (opts.headshot) {
      session.headshots += 1;
      if (id) bumpWeapon(session.weapons, id, 'headshots', 1);
    }
    if (id === 'knife') session.knifeKills += 1;
    else if (isNade(id)) session.nadeKills += 1;
    let dist = finite(opts.distance);
    if (!dist && opts.x != null) {
      const p = VF.game && VF.game.player && VF.game.player.object;
      if (p) {
        const dx = opts.x - p.position.x;
        const dy = (opts.y != null ? opts.y : p.position.y) - p.position.y;
        const dz = opts.z - p.position.z;
        dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
    }
    if (dist > session.longestKill) session.longestKill = dist;
    if (dist >= LONG_KILL_M) session.longKills += 1;
  }

  function noteDeath() {
    if (!live()) return;
    session.deaths += 1;
  }

  function noteShot(weaponId) {
    if (!live()) return;
    session.shots += 1;
    const id = weaponBucket(weaponId);
    if (id) bumpWeapon(session.weapons, id, 'shots', 1);
  }

  function noteHit(weaponId) {
    if (!live()) return;
    session.hits += 1;
    const id = weaponBucket(weaponId);
    if (id) bumpWeapon(session.weapons, id, 'hits', 1);
  }

  function noteHeal(amount) {
    if (!live()) return;
    const n = finite(amount);
    if (n <= 0) return;
    session.healHp += n;
    session.score += Math.floor(n / HEAL_UNIT) * 10;
  }

  function favoriteWeapon(career) {
    let best = null;
    let bestK = 0;
    const guns = career.weapons || {};
    Object.keys(guns).forEach(function (id) {
      const k = guns[id] && guns[id].kills;
      if (k > bestK) {
        bestK = k;
        best = id;
      }
    });
    return best;
  }

  function favoriteClass(career) {
    let best = null;
    let bestT = 0;
    const rows = career.classes || {};
    Object.keys(rows).forEach(function (id) {
      const t = rows[id] && rows[id].playtimeSec;
      if (t > bestT) {
        bestT = t;
        best = id;
      }
    });
    return best;
  }

  function weaponName(id) {
    if (!id) return '—';
    if (id === 'knife') return '战术匕首';
    const nade = VF.THROWABLE_CATALOG && VF.THROWABLE_CATALOG[id];
    if (nade) return nade.nameZh || nade.name || id;
    const def = VF.WEAPONS && VF.WEAPONS[id];
    return (def && (def.nameZh || def.name)) || id;
  }

  function formatHours(sec) {
    return (finite(sec) / 3600).toFixed(3) + ' 小时';
  }

  function pct(value, cap) {
    return Math.max(0, Math.min(100, (finite(value) / cap) * 100));
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function number(n) {
    return Math.round(finite(n)).toLocaleString('zh-CN');
  }

  function derived(career) {
    const kd = career.deaths > 0 ? career.kills / career.deaths : career.kills;
    const wl = career.losses > 0 ? career.wins / career.losses : career.wins;
    const acc = career.shots > 0 ? (career.hits / career.shots) * 100 : 0;
    const hours = career.playtimeSec / 3600;
    const ready = career.playtimeSec >= 60;
    const spm = ready ? career.score / (career.playtimeSec / 60) : 0;
    const kpm = ready ? career.kills / (career.playtimeSec / 60) : 0;
    return { kd: kd, wl: wl, acc: acc, spm: spm, kpm: kpm, rank: Math.max(1, Math.floor(career.score / 1000) + 1), ready: ready };
  }

  function ring(value, label, progress, hasData) {
    return (
      '<div class="career-ring' +
      (hasData ? '' : ' empty') +
      '" style="--career-progress:' +
      progress.toFixed(1) +
      '%"><b>' +
      escapeHtml(value) +
      '</b><span>' +
      escapeHtml(label) +
      '</span></div>'
    );
  }

  function tile(label, value) {
    return (
      '<article class="career-tile"><small>' +
      escapeHtml(label) +
      '</small><strong>' +
      escapeHtml(value) +
      '</strong></article>'
    );
  }

  function renderHome(career) {
    const d = derived(career);
    const favW = favoriteWeapon(career);
    const favC = favoriteClass(career);
    const wRow = favW && career.weapons[favW];
    const cRow = favC && career.classes[favC];
    return (
      '<div class="career-rings">' +
      ring(number(career.kills), '击杀', career.kills > 0 ? pct(career.kills, 50) : 0, career.kills > 0) +
      ring(number(career.deaths), '死亡', career.deaths > 0 ? pct(career.deaths, 20) : 0, career.kills + career.deaths > 0) +
      ring((career.shots > 0 ? Math.round(d.acc) : 0) + '%', '准确度', career.shots > 0 ? d.acc : 0, career.shots > 0) +
      ring(d.ready ? d.spm.toFixed(0) : '0', '积分/分钟', d.ready ? pct(d.spm, 1000) : 0, d.ready) +
      ring(d.ready ? d.kpm.toFixed(1) : '0.0', '击杀/分钟', d.ready ? pct(d.kpm, 3) : 0, d.ready && career.kills > 0) +
      '</div>' +
      '<div class="career-favs">' +
      '<article><h3>最爱武器</h3><strong>' +
      escapeHtml(wRow && wRow.kills ? weaponName(favW) : '—') +
      '</strong><small>' +
      (wRow && wRow.kills ? number(wRow.kills) + ' 次击杀' : '尚无击杀数据') +
      '</small></article>' +
      '<article><h3>最常游玩兵种</h3><strong>' +
      escapeHtml(cRow ? CLASS_LABEL[favC] || favC : '—') +
      '</strong><small>' +
      (cRow ? formatHours(cRow.playtimeSec) : '打完一局后在此汇总') +
      '</small></article>' +
      '</div>' +
      '<p class="career-rank">军衔等级 <b>' +
      d.rank +
      '</b> · K/D ' +
      (career.kills + career.deaths > 0 ? d.kd.toFixed(2) : '0.00') +
      ' · 生涯 ' +
      number(career.matches) +
      ' 场 · ' +
      number(career.wins) +
      ' 胜</p>'
    );
  }

  function renderStats(career) {
    const d = derived(career);
    const modes = ['core', 'tdm', 'demo', 'ffa', 'gungame']
      .map(function (id) {
        const m = career.modes[id] || blankMode();
        return (
          '<article class="career-mode-row"><strong>' +
          escapeHtml(MODE_LABEL[id] || id) +
          '</strong><span>' +
          number(m.matches) +
          ' 场</span><span>' +
          number(m.wins) +
          ' 胜</span><span>' +
          number(m.kills) +
          ' 杀</span></article>'
        );
      })
      .join('');
    const classes = Object.keys(CLASS_LABEL)
      .map(function (id) {
        const row = career.classes[id] || { kills: 0, score: 0, playtimeSec: 0 };
        return (
          '<article class="career-class-row"><strong>' +
          escapeHtml(CLASS_LABEL[id]) +
          '</strong><span>' +
          number(row.kills) +
          ' 杀</span><span>' +
          number(row.score) +
          ' 分</span><span>' +
          formatHours(row.playtimeSec) +
          '</span></article>'
        );
      })
      .join('');
    return (
      '<section class="career-section"><h3>一般</h3><div class="career-tiles">' +
      tile('击杀', number(career.kills)) +
      tile('死亡', number(career.deaths)) +
      tile('已游玩', formatHours(career.playtimeSec)) +
      tile('总得分', number(career.score)) +
      '</div></section>' +
      '<section class="career-section"><h3>回合</h3><div class="career-tiles cols-3">' +
      tile('获胜', number(career.wins)) +
      tile('平局 / 中离', number(career.draws)) +
      tile('失败', number(career.losses)) +
      '</div></section>' +
      '<section class="career-section"><h3>枪械</h3><div class="career-tiles">' +
      tile('命中率', career.shots > 0 ? Math.round(d.acc) + '%' : '—') +
      tile('爆头', number(career.headshots)) +
      tile('最远击杀', career.longestKill > 0 ? career.longestKill.toFixed(1) + ' m' : '—') +
      tile('投掷击杀', number(career.nadeKills)) +
      '</div></section>' +
      '<section class="career-section"><h3>目标</h3><div class="career-tiles cols-3">' +
      tile('摧毁核心', number(career.cores)) +
      tile('安装炸弹', number(career.plants)) +
      tile('拆除炸弹', number(career.defuses)) +
      '</div></section>' +
      '<section class="career-section"><h3>模式</h3><div class="career-table">' +
      modes +
      '</div></section>' +
      '<section class="career-section"><h3>兵种</h3><div class="career-table">' +
      classes +
      '</div></section>'
    );
  }

  function renderAchievements(career) {
    const unlocked = career.ribbons || [];
    return (
      '<div class="career-ach-grid">' +
      ACHIEVEMENTS.map(function (a) {
        const on = unlocked.indexOf(a.id) >= 0;
        return (
          '<article class="' +
          (on ? 'unlocked' : 'locked') +
          '"><strong>' +
          escapeHtml(a.name) +
          '</strong><small>' +
          escapeHtml(a.desc) +
          '</small><em>' +
          (on ? '已解锁' : '未解锁') +
          '</em></article>'
        );
      }).join('') +
      '</div>'
    );
  }

  function renderHtml(page) {
    page = page || 'home';
    const career = load();
    const body =
      page === 'stats' ? renderStats(career) : page === 'achievements' ? renderAchievements(career) : renderHome(career);
    return (
      '<div class="career-root" data-career-page="' +
      page +
      '">' +
      '<nav class="career-tabs">' +
      '<button type="button" data-career-tab="home"' +
      (page === 'home' ? ' class="active"' : '') +
      '>主页</button>' +
      '<button type="button" data-career-tab="stats"' +
      (page === 'stats' ? ' class="active"' : '') +
      '>数据</button>' +
      '<button type="button" data-career-tab="achievements"' +
      (page === 'achievements' ? ' class="active"' : '') +
      '>成就</button>' +
      '</nav>' +
      '<div class="career-body">' +
      body +
      '</div></div>'
    );
  }

  function bind(root) {
    if (!root || root._careerBound) return;
    root._careerBound = true;
    root.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-career-tab]');
      if (!btn || !root.contains(btn)) return;
      const page = btn.getAttribute('data-career-tab');
      root.innerHTML = renderHtml(page);
      root._careerBound = false;
      bind(root);
    });
  }

  VF.Career = {
    start: start,
    finish: finish,
    noteKill: noteKill,
    noteDeath: noteDeath,
    noteShot: noteShot,
    noteHit: noteHit,
    noteHeal: noteHeal,
    get: load,
    renderHtml: renderHtml,
    bind: bind,
    ACHIEVEMENTS: ACHIEVEMENTS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
