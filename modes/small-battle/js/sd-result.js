/**
 * sd-result.js — 爆破模式结算界面（回合结算横幅 + 对局结算计分板）
 *
 * 单一职责：只做“展示”。所有数据从 SdMatch.snapshot 语义（result/match）与 SdStats 读取，
 * 自身不持有规则、不改状态。两层结算（对应文档第一部分）：
 *   Layer 1 回合结算 showRound(result)   —— 结果横幅 + 胜利原因 + 双方比分 + 回合MVP，持续 resultTime。
 *   Layer 2 对局结算 showMatch(result)   —— 最终比分 + 双队计分板 + 全局MVP，常驻至手动/倒计时返回。
 *
 * DOM 自建（ensureDom）：避免污染 index.html 结构，只需在页面引入本脚本即可。
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});

  const TEAM = {
    ally: { banner: '同盟', squad: '特别小组', cls: 'ally' },
    enemy: { banner: '联军', squad: '战术核心', cls: 'enemy' },
  };

  const COLS = [
    { key: 'score', label: '得分' },
    { key: 'kills', label: '击杀' },
    { key: 'deaths', label: '死亡' },
    { key: 'plants', label: '安放' },
    { key: 'defuses', label: '拆除' },
  ];

  function param(k, d) {
    return VF.GameModes && VF.GameModes.param ? VF.GameModes.param(k, d) : d;
  }
  function playerTeam() {
    const g = VF.game;
    return (g && g.player && g.player.team) || (g && g.world && g.world._playerTeam) || 'ally';
  }
  function otherTeam(t) { return t === 'ally' ? 'enemy' : 'ally'; }

  // ── 胜利原因 → 文案 + 图标（文档 2.3）──────────────────────────────
  const ICON = {
    boom:
      '<svg viewBox="0 0 24 24"><path d="M12 2l2.2 4.6L19 5l-1.7 4.7L22 12l-4.7 1.6L19 19l-4.8-1.6L12 22l-2.2-4.6L5 19l1.7-4.7L2 12l4.7-1.6L5 5l4.8 1.6z"/></svg>',
    defuse:
      '<svg viewBox="0 0 24 24"><path d="M14.5 3.5l-3 3 1.8 1.8-6.3 6.3-1.2-.4-3 3 3.2 3.2 3-3-.4-1.2 6.3-6.3 1.8 1.8 3-3-5-5zM6.4 19.3l-1.7-1.7 1.4-1.4 1.7 1.7-1.4 1.4z"/></svg>',
    skull:
      '<svg viewBox="0 0 24 24"><path d="M12 2C7.6 2 4 5.3 4 9.5c0 2.5 1.3 4.2 2.7 5.3V18h2v-2h1.3v2h1.9v-2h1.3v2h2v-3.2C16.7 13.7 18 12 18 9.5 18 5.3 14.4 2 12 2zM9 11a1.6 1.6 0 110-3.2A1.6 1.6 0 019 11zm6 0a1.6 1.6 0 110-3.2A1.6 1.6 0 0115 11z"/></svg>',
    clock:
      '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 10.4l4 2.3-1 1.7-5-2.9V6h2z"/></svg>',
  };

  function reasonInfo(reason) {
    reason = reason || '';
    if (reason.indexOf('引爆') >= 0) return { text: '炸弹已引爆', icon: ICON.boom };
    if (reason.indexOf('拆除') >= 0) return { text: '炸弹已被拆除', icon: ICON.defuse };
    if (reason.indexOf('全灭') >= 0 || reason.indexOf('消灭') >= 0) return { text: '敌方已被消灭', icon: ICON.skull };
    if (reason.indexOf('时间') >= 0) return { text: '时间耗尽 · 防守成功', icon: ICON.clock };
    return { text: reason || '回合结束', icon: '' };
  }

  // ── 徽章（heraldic crest）：内联 SVG，避免 emoji 渲染不一致 ─────────────
  const CREST = {
    ally:
      '<svg viewBox="0 0 120 120"><g fill="currentColor">' +
      '<polygon points="60,6 63,15 72,15 65,20 68,29 60,23 52,29 55,20 48,15 57,15"/>' +
      '<circle cx="60" cy="40" r="7"/>' +
      '<path d="M60 45 l-4 8 l8 0 z"/>' +
      '<path d="M58 47 C40 41 22 45 10 59 C26 57 30 61 40 67 C30 67 26 73 20 83 C36 75 44 75 56 71 Z"/>' +
      '<path d="M62 47 C80 41 98 45 110 59 C94 57 90 61 80 67 C90 67 94 73 100 83 C84 75 76 75 64 71 Z"/>' +
      '<path d="M54 69 l6 28 l6 -28 z"/>' +
      '</g></svg>',
    enemy:
      '<svg viewBox="0 0 120 120">' +
      '<g fill="currentColor">' +
      '<rect x="16" y="80" width="88" height="9" rx="4" transform="rotate(30 60 84)"/>' +
      '<rect x="16" y="80" width="88" height="9" rx="4" transform="rotate(-30 60 84)"/>' +
      '<path d="M60 18 C38 18 26 34 26 52 C26 64 32 70 38 74 L38 86 L82 86 L82 74 C88 70 94 64 94 52 C94 34 82 18 60 18 Z"/>' +
      '</g>' +
      '<g fill="#2a0a0a">' +
      '<ellipse cx="46" cy="50" rx="9" ry="11"/>' +
      '<ellipse cx="74" cy="50" rx="9" ry="11"/>' +
      '<path d="M60 58 l-5 12 l10 0 z"/>' +
      '<rect x="45" y="80" width="4" height="7"/><rect x="58" y="80" width="4" height="7"/><rect x="71" y="80" width="4" height="7"/>' +
      '</g></svg>',
  };

  const BLAST_HOLD = 1500;
  const state = {
    built: false,
    els: null,
    roundTimer: 0,
    matchTimer: 0,
    revealTimer: 0,
    matchRevealTimer: 0,
    returning: false,
  };

  function el(tag, cls, html) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (html != null) d.innerHTML = html;
    return d;
  }

  function ensureDom() {
    if (state.built) return state.els;

    // Layer 1 — 回合结算
    const re = el('div', 'sd-roundend hidden');
    re.innerHTML =
      '<div class="sd-crest ally" id="sd-re-crest-ally">' + CREST.ally + '</div>' +
      '<div class="sd-crest enemy" id="sd-re-crest-enemy">' + CREST.enemy + '</div>' +
      '<div class="sd-re-center">' +
      '  <h2 id="sd-re-title" class="sd-re-title">回合胜利</h2>' +
      '  <p id="sd-re-reason" class="sd-re-reason"></p>' +
      '  <div class="sd-re-scoreline">' +
      '    <span class="sd-re-label ally">同盟</span>' +
      '    <span id="sd-re-ally" class="sd-re-score ally">0</span>' +
      '    <span class="sd-re-colon">:</span>' +
      '    <span id="sd-re-enemy" class="sd-re-score enemy">0</span>' +
      '    <span class="sd-re-label enemy">联军</span>' +
      '  </div>' +
      '  <p id="sd-re-mvp" class="sd-re-mvp"></p>' +
      '</div>';

    // Layer 2 — 对局结算
    const sb = el('div', 'sd-scoreboard hidden');
    sb.innerHTML =
      '<div class="sd-sb-head">' +
      '  <div class="sd-sb-mode">搜索摧毁 <span class="sd-sb-sep">|</span> <span id="sd-sb-map">巴尔德拉斯博物馆</span></div>' +
      '  <div class="sd-sb-sub">保护炸弹</div>' +
      '</div>' +
      '<div class="sd-sb-bigscore">' +
      '  <span id="sd-sb-win" class="sd-sb-big win">0</span>' +
      '  <span id="sd-sb-lose" class="sd-sb-big lose">0</span>' +
      '</div>' +
      '<div class="sd-sb-tables">' +
      '  <div class="sd-sb-team" id="sd-sb-team-top"></div>' +
      '  <div class="sd-sb-team" id="sd-sb-team-bot"></div>' +
      '</div>' +
      '<div class="sd-sb-foot">' +
      '  <span id="sd-sb-mvp" class="sd-sb-mvp"></span>' +
      '  <span class="sd-sb-spacer"></span>' +
      '  <span id="sd-sb-countdown" class="sd-sb-countdown"></span>' +
      '  <button type="button" id="sd-sb-back" class="cover-btn cover-btn-start">返回大厅</button>' +
      '</div>';

    document.body.appendChild(re);
    document.body.appendChild(sb);

    const els = {
      re: re,
      reTitle: re.querySelector('#sd-re-title'),
      reReason: re.querySelector('#sd-re-reason'),
      reAlly: re.querySelector('#sd-re-ally'),
      reEnemy: re.querySelector('#sd-re-enemy'),
      reMvp: re.querySelector('#sd-re-mvp'),
      sb: sb,
      sbWin: sb.querySelector('#sd-sb-win'),
      sbLose: sb.querySelector('#sd-sb-lose'),
      sbTop: sb.querySelector('#sd-sb-team-top'),
      sbBot: sb.querySelector('#sd-sb-team-bot'),
      sbMvp: sb.querySelector('#sd-sb-mvp'),
      sbCountdown: sb.querySelector('#sd-sb-countdown'),
      sbBack: sb.querySelector('#sd-sb-back'),
    };
    els.sbBack.addEventListener('click', function () { Result._return(); });

    state.built = true;
    state.els = els;
    return els;
  }

  const Result = {
    /* ───────────────────────── Layer 1: 回合结算 ────────────────────── */

    showRound: function (result, match) {
      if (!result) return;
      const e = ensureDom();
      if (VF.UI && VF.UI.hideDeath) VF.UI.hideDeath();

      const won = result.winner === playerTeam();
      const info = reasonInfo(result.reason);
      const wins = (match && match.wins) || (VF.SdMatch && VF.SdMatch.wins) || { ally: 0, enemy: 0 };

      e.reTitle.textContent = won ? '回合胜利' : '回合失败';
      e.reTitle.classList.toggle('win', won);
      e.reTitle.classList.toggle('lose', !won);
      e.reReason.innerHTML = (info.icon || '') + '<span>' + info.text + '</span>';
      e.reAlly.textContent = wins.ally;
      e.reEnemy.textContent = wins.enemy;

      const mvp = result.mvp || (VF.SdStats && VF.SdStats.lastRoundMvp) || null;
      if (mvp) {
        e.reMvp.innerHTML = '本回合 MVP · <b class="' + (mvp.team || 'ally') + '">' + esc(mvp.name) + '</b>';
        e.reMvp.classList.remove('hidden');
      } else {
        e.reMvp.textContent = '';
        e.reMvp.classList.add('hidden');
      }

      // 若本回合由引爆终结，先让爆炸表现放完再拉起横幅，避免遮住爆炸。
      const boom = /引爆/.test(result.reason || '');
      const reveal = function () {
        e.re.classList.remove('hidden');
        e.re.classList.add('show');
        Result._bump(result.winner === 'ally' ? e.reAlly : e.reEnemy);
        clearTimeout(state.roundTimer);
        const holdMs = Math.max(1600, param('resultTime', 5) * 1000 - (boom ? BLAST_HOLD : 0));
        state.roundTimer = setTimeout(function () { Result.hideRound(); }, holdMs);
      };
      clearTimeout(state.revealTimer);
      if (boom) state.revealTimer = setTimeout(reveal, BLAST_HOLD);
      else reveal();
    },

    hideRound: function () {
      if (!state.els) return;
      state.els.re.classList.add('hidden');
      state.els.re.classList.remove('show');
      clearTimeout(state.roundTimer);
      clearTimeout(state.revealTimer);
    },

    /* ───────────────────────── Layer 2: 对局结算 ────────────────────── */

    showMatch: function (result, match) {
      const e = ensureDom();
      this.hideRound();
      if (VF.UI && VF.UI.hideDeath) VF.UI.hideDeath();
      state.returning = false;

      const wins = (result && result.wins) || (match && match.wins) || { ally: 0, enemy: 0 };
      const winner = (result && result.winner) || (wins.ally >= wins.enemy ? 'ally' : 'enemy');
      const pt = playerTeam();
      const rt = otherTeam(pt);

      // 大比分与下方双队面板保持同序：左分=上方队伍(玩家队)，右分=下方队伍，
      // 胜负仅用队色高亮/暗淡区分，避免“上蓝下红，却把红方比分排在左侧”的错位。
      e.sbWin.textContent = wins[pt];
      e.sbWin.className = 'sd-sb-big ' + (pt === winner ? 'win' : 'lose') + ' ' + pt;
      e.sbLose.textContent = wins[rt];
      e.sbLose.className = 'sd-sb-big ' + (rt === winner ? 'win' : 'lose') + ' ' + rt;

      const mvp = VF.SdStats && VF.SdStats.matchMvp ? VF.SdStats.matchMvp() : null;
      this._renderTeam(e.sbTop, pt, mvp);
      this._renderTeam(e.sbBot, rt, mvp);

      if (mvp) {
        e.sbMvp.innerHTML = '全局 MVP · <b class="' + (mvp.team || 'ally') + '">' + esc(mvp.name) + '</b>';
      } else {
        e.sbMvp.textContent = '';
      }

      const reveal = function () {
        e.sb.classList.remove('hidden');
        // 常驻：倒计时或手动返回（文档 3.1）。
        let left = Math.max(5, param('matchEndHold', 20) | 0);
        const tick = function () {
          e.sbCountdown.textContent = '自动返回 ' + left + 's';
          if (left <= 0) { Result._return(); return; }
          left -= 1;
        };
        clearInterval(state.matchTimer);
        tick();
        state.matchTimer = setInterval(tick, 1000);
      };

      const boom = /引爆/.test(
        (VF.SdMatch && VF.SdMatch.lastResult && VF.SdMatch.lastResult.reason) || ''
      );
      const revealAfterInspect = function () {
        const spent = (VF.WeaponInspect && VF.WeaponInspect.lastDurationMs) || 0;
        const extra = boom ? Math.max(0, BLAST_HOLD - spent) : 0;
        clearInterval(state.matchTimer);
        clearTimeout(state.matchRevealTimer);
        if (extra > 0) state.matchRevealTimer = setTimeout(reveal, extra);
        else reveal();
      };
      clearInterval(state.matchTimer);
      clearTimeout(state.matchRevealTimer);
      if (VF.WeaponInspect && VF.WeaponInspect.play) VF.WeaponInspect.play(revealAfterInspect);
      else revealAfterInspect();
    },

    _renderTeam: function (host, team, mvp) {
      if (!host) return;
      const meta = TEAM[team] || TEAM.ally;
      host.className = 'sd-sb-team ' + meta.cls;
      const stats = VF.SdStats;
      const rows = stats && stats.teamRows ? stats.teamRows(team) : [];
      const alive = stats && stats.aliveCount ? stats.aliveCount(team) : rows.length;
      const total = stats && stats.teamTotal ? stats.teamTotal(team) : rows.length;

      let html =
        '<div class="sd-sb-team-head ' + meta.cls + '">' +
        '<span class="sd-sb-team-name">' + meta.squad + '</span>' +
        '<span class="sd-sb-team-count">[' + alive + '/' + total + ']</span>' +
        '</div>' +
        '<table class="sd-sb-table"><thead><tr>' +
        '<th class="rank"></th><th class="name"></th>';
      for (let c = 0; c < COLS.length; c++) html += '<th>' + COLS[c].label + '</th>';
      html += '</tr></thead><tbody>';

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const isMe = !!r.isPlayer;
        const isMvp = mvp && mvp.id === r.id;
        html +=
          '<tr class="' + (isMe ? 'me ' : '') + meta.cls + '">' +
          '<td class="rank"><span class="chev">▾</span><span class="lvl">' + (r.level || 1) + '</span></td>' +
          '<td class="name">' + esc(r.name) + (isMvp ? '<span class="sd-mvp-chip">MVP</span>' : '') + '</td>';
        for (let c = 0; c < COLS.length; c++) {
          const v = r[COLS[c].key];
          html += '<td>' + (v != null ? v : 0) + '</td>';
        }
        html += '</tr>';
      }
      html += '</tbody></table>';
      host.innerHTML = html;
    },

    /* ─────────────────────────── shared ────────────────────────────── */

    _bump: function (node) {
      if (!node) return;
      node.classList.remove('bump');
      void node.offsetWidth;
      node.classList.add('bump');
    },

    _return: function () {
      if (state.returning) return;
      state.returning = true;
      clearInterval(state.matchTimer);
      clearTimeout(state.roundTimer);
      clearTimeout(state.revealTimer);
      clearTimeout(state.matchRevealTimer);
      this.hide();
      if (VF.SdMatch && VF.SdMatch.stop) VF.SdMatch.stop();
      if (VF.game && VF.game.returnFromMatch) VF.game.returnFromMatch();
    },

    hide: function () {
      if (!state.built) return;
      state.els.re.classList.add('hidden');
      state.els.re.classList.remove('show');
      state.els.sb.classList.add('hidden');
      clearInterval(state.matchTimer);
      clearTimeout(state.roundTimer);
      clearTimeout(state.revealTimer);
      clearTimeout(state.matchRevealTimer);
    },
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  VF.SdResult = Result;
})(typeof window !== 'undefined' ? window : globalThis);