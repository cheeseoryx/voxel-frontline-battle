/**
 * gg-ui.js — 枪械模式 HUD：个人武器进度条、按等级排序的排行榜、击杀播报、结算。
 *
 * 枪械模式的 UI 核心是「进度可视化」（文档 第五部分）：玩家随时要看清自己到了
 * 第几级、下一把是什么、别人到哪了。所以比 自由混战 多一块常驻的个人进度面板。
 *
 * 复用 死斗 / 自由混战 的播报、横幅、结算样式（相同 class，独立元素），不碰任何
 * 队伍制 HUD。
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});

  const state = {
    els: null,
    bound: false,
    shownClock: -1,
    shownBanner: '',
    rankSig: '',
    progressSig: '',
  };

  function els() {
    if (state.els) return state.els;
    state.els = {
      timer: document.getElementById('timer'),
      target: document.getElementById('match-target'),
      progress: document.getElementById('gg-progress'),
      rank: document.getElementById('gg-rank'),
      feed: document.getElementById('gg-feed'),
      banner: document.getElementById('gg-banner'),
      result: document.getElementById('gg-result'),
      resultTitle: document.getElementById('gg-result-title'),
      resultReason: document.getElementById('gg-result-reason'),
      resultPlace: document.getElementById('gg-result-place'),
      resultRows: document.getElementById('gg-result-rows'),
      resultBack: document.getElementById('gg-result-back'),
      resultCountdown: document.getElementById('gg-result-countdown'),
    };
    return state.els;
  }

  function mmss(sec) {
    const s = Math.max(0, Math.ceil(sec));
    const m = Math.floor(s / 60);
    return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function ordinal(n) {
    return '第 ' + n + ' 名';
  }

  const Ui = {
    /* ────────────────────────── show / hide ────────────────────────── */

    enter: function () {
      const e = els();
      if (!e) return;
      state.shownClock = -1;
      state.shownBanner = '';
      state.rankSig = '';
      state.progressSig = '';
      const panels = [e.progress, e.rank, e.feed];
      for (let i = 0; i < panels.length; i++) {
        if (!panels[i]) continue;
        panels[i].classList.remove('hidden');
        panels[i].innerHTML = '';
      }
      const levels = (VF.GgMatch && VF.GgMatch.levelCount()) || 0;
      if (e.target) e.target.textContent = levels;
      const objective = document.getElementById('objective');
      if (objective) objective.textContent = '枪械模式 · 打通 ' + levels + ' 把武器';
      if (VF.UI && VF.UI.claimClock) VF.UI.claimClock('gungame');
      this._setBuildSlots(false);
      this.hideResult();
      this._bind();
    },

    leave: function () {
      const e = els();
      if (!e) return;
      if (VF.UI && VF.UI.releaseClock) VF.UI.releaseClock('gungame');
      const panels = [e.progress, e.rank, e.feed];
      for (let i = 0; i < panels.length; i++) {
        if (!panels[i]) continue;
        panels[i].classList.add('hidden');
        panels[i].innerHTML = '';
      }
      if (e.banner) e.banner.classList.add('hidden');
      this._setBuildSlots(true);
      this.hideResult();
    },

    _setBuildSlots: function () {
      if (VF.UI && VF.UI.syncHotbarLayout) VF.UI.syncHotbarLayout();
      if (VF.UI && VF.UI.syncBuildHud) VF.UI.syncBuildHud();
    },

    _bind: function () {
      const e = els();
      if (!e || state.bound) return;
      state.bound = true;
      if (e.resultBack) {
        e.resultBack.addEventListener('click', function (ev) {
          ev.preventDefault();
          Ui.hideResult();
          if (VF.GgMatch) VF.GgMatch.stop();
          if (VF.FfaSpawn) VF.FfaSpawn.stop();
          if (VF.game && VF.game.returnFromMatch) VF.game.returnFromMatch();
        });
      }
    },

    /* ──────────────────────── per-frame sync ──────────────────────── */

    sync: function (match) {
      const e = els();
      if (!e || !match) return;

      const clockSec = match.phase === 'prep' ? match.phaseLeft : match.timeLeft;
      const whole = Math.ceil(clockSec);
      if (whole !== state.shownClock) {
        state.shownClock = whole;
        if (e.timer) e.timer.textContent = mmss(clockSec);
      }

      this._renderProgress(match);
      this._renderRank(match);
      this._syncBanner(match);
    },

    /* ───────────────────── 个人进度（文档 5.1） ───────────────────── */

    _renderProgress: function (match) {
      const e = els();
      if (!e || !e.progress) return;
      const me = match.playerStats();
      if (!me) return;

      const total = match.levelCount();
      const final = match.finalLevel();
      const atFinal = me.level >= final;
      const sig = me.level + '/' + total + (atFinal ? 'F' : '');
      if (sig === state.progressSig) return;
      state.progressSig = sig;

      e.progress.innerHTML = '';
      e.progress.classList.toggle('final', atFinal);

      const head = document.createElement('div');
      head.className = 'gg-progress-head';
      head.textContent = 'Lv' + me.level + ' · ' + match.labelAt(me.level);
      e.progress.appendChild(head);

      const bar = document.createElement('div');
      bar.className = 'gg-progress-bar';
      for (let i = 0; i < total; i++) {
        const cell = document.createElement('span');
        cell.className = 'gg-progress-cell';
        if (i < me.level) cell.classList.add('done');
        else if (i === me.level) cell.classList.add('current');
        if (i === final) cell.classList.add('final');
        bar.appendChild(cell);
      }
      e.progress.appendChild(bar);

      const foot = document.createElement('div');
      foot.className = 'gg-progress-foot';
      if (atFinal) {
        foot.classList.add('final');
        foot.textContent = '最后一击 · ' + match.labelAt(final);
      } else {
        foot.textContent =
          me.level + '/' + final + ' · 下一把 ' + match.labelAt(me.level + 1);
      }
      e.progress.appendChild(foot);
    },

    /* ─────────────── 排行榜：按武器等级排序（文档 5.3） ─────────────── */

    _renderRank: function (match) {
      const e = els();
      if (!e || !e.rank) return;
      const rows = match.ranking();
      const leaderId = match.leaderMarkerOn() ? match.leaderId() : null;

      let sig = leaderId || '';
      for (let i = 0; i < rows.length; i++) sig += '|' + rows[i].id + ':' + rows[i].level;
      if (sig === state.rankSig) return;
      state.rankSig = sig;

      const total = match.levelCount();
      const final = match.finalLevel();
      const leadLevel = rows.length ? rows[0].level : 0;

      e.rank.innerHTML = '';
      const head = document.createElement('div');
      head.className = 'ffa-rank-head';
      const pr = match.playerRank();
      head.textContent = '武器进度 · ' + (pr ? ordinal(pr) : '—') + ' / ' + rows.length + ' 人';
      e.rank.appendChild(head);

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const row = document.createElement('div');
        row.className = 'ffa-rank-row';
        if (r.isPlayer) row.classList.add('me');
        if (leaderId && r.id === leaderId) row.classList.add('leader');

        const place = document.createElement('span');
        place.className = 'ffa-rank-place';
        place.textContent = i + 1;
        row.appendChild(place);

        const name = document.createElement('span');
        name.className = 'ffa-rank-name';
        name.textContent = (leaderId && r.id === leaderId ? '♛ ' : '') + r.name;
        row.appendChild(name);

        // 迷你进度条：一眼看出谁快通关了
        const mini = document.createElement('span');
        mini.className = 'gg-rank-bar';
        const fill = document.createElement('span');
        fill.className = 'gg-rank-fill';
        fill.style.width = Math.round((r.level / Math.max(1, final)) * 100) + '%';
        if (r.level >= final) fill.classList.add('final');
        mini.appendChild(fill);
        row.appendChild(mini);

        const lv = document.createElement('span');
        lv.className = 'ffa-rank-kills';
        lv.textContent = 'Lv' + r.level;
        if (r.level >= final) lv.classList.add('critical');
        row.appendChild(lv);

        e.rank.appendChild(row);
      }

      const gap = document.createElement('div');
      gap.className = 'ffa-rank-foot';
      const me = match.playerStats();
      if (pr > 1 && me) {
        gap.textContent = '距第一 ' + Math.max(1, leadLevel - me.level) + ' 级';
      } else if (pr === 1) {
        gap.classList.add('leading');
        gap.textContent = '你领先全场 · 小心被爆头降级';
      }
      e.rank.appendChild(gap);
      void total;
    },

    _syncBanner: function (match) {
      const e = els();
      if (!e || !e.banner) return;
      let text = '';
      let warn = false;

      const spawn = VF.FfaSpawn;
      if (spawn && spawn.isWaiting()) {
        const secs = Math.max(1, Math.ceil(spawn.respawnLeft()));
        text = '复活倒计时 ' + secs + 's';
        warn = true;
        const flavor = document.getElementById('death-flavor');
        if (flavor) flavor.textContent = secs + ' 秒后重新投放';
      } else if (match.phase === 'prep') {
        text = '准备阶段 ' + Math.max(1, Math.ceil(match.phaseLeft)) + 's';
      } else if (VF.game && VF.game.player && VF.game.player.spawnProtect > 0) {
        text = '出生保护 · 开火即取消';
      }

      if (text === state.shownBanner) return;
      state.shownBanner = text;
      e.banner.textContent = text;
      e.banner.classList.toggle('hidden', !text);
      e.banner.classList.toggle('warn', warn);
    },

    /* ─────────────────────────── kill feed ────────────────────────── */

    onKill: function (entry) {
      const e = els();
      if (!e || !e.feed || !entry) return;

      const row = document.createElement('div');
      row.className = 'tdm-feed-row';
      row.dataset.order = entry.order;
      if (entry.killerIsPlayer || entry.victimIsPlayer) row.classList.add('mine');
      if (entry.kind !== 'kill') row.classList.add('negative');

      if (entry.kind === 'suicide') {
        row.appendChild(nameSpan(entry.victim, entry.victimIsPlayer));
        row.appendChild(verbSpan('阵亡'));
      } else {
        row.appendChild(nameSpan(entry.killer, entry.killerIsPlayer));
        row.appendChild(verbSpan(entry.leveled ? '升级击杀' : '击杀'));
        row.appendChild(nameSpan(entry.victim, entry.victimIsPlayer));
        if (entry.demoted) {
          const tag = document.createElement('span');
          tag.className = 'tdm-feed-hs gg-feed-demote';
          tag.textContent = '爆头降级';
          row.appendChild(tag);
        } else if (entry.headshot) {
          const hs = document.createElement('span');
          hs.className = 'tdm-feed-hs';
          hs.textContent = '爆头';
          row.appendChild(hs);
        }
      }

      e.feed.appendChild(row);
      while (e.feed.childElementCount > 6) e.feed.removeChild(e.feed.firstElementChild);

      function nameSpan(text, isPlayer) {
        const s = document.createElement('span');
        // Self is blue, everyone else is red — the teamless identity rule.
        s.className = 'tdm-feed-name ' + (isPlayer ? 'blue' : 'red');
        s.textContent = text || '?';
        return s;
      }
      function verbSpan(text) {
        const s = document.createElement('span');
        s.className = 'tdm-feed-verb';
        s.textContent = text;
        return s;
      }
    },

    onLevel: function (row) {
      void row;
      state.progressSig = '';
    },

    onDemote: function (row) {
      void row;
      state.progressSig = '';
    },

    onRespawn: function (pick, protect) {
      void pick;
      void protect;
      state.shownBanner = '';
    },

    /* ─────────────── 结算：按武器等级排名（文档 7.2） ─────────────── */

    showResult: function (match, won) {
      const self = this;
      const reveal = function () {
        self._revealResult(match, won);
      };
      if (VF.WeaponInspect && VF.WeaponInspect.play) VF.WeaponInspect.play(reveal);
      else reveal();
    },

    _revealResult: function (match, won) {
      const e = els();
      if (!e || !e.result) return;
      const rows = match.ranking();
      const pr = match.playerRank();
      const me = match.playerStats();
      const final = match.finalLevel();

      if (e.resultTitle) {
        e.resultTitle.textContent = won ? '军械库大师' : '本局结束';
        e.resultTitle.classList.toggle('lose', !won);
      }
      if (e.resultReason) e.resultReason.textContent = match.endReason || '';
      if (e.resultPlace) {
        if (won) {
          e.resultPlace.textContent = '你打通了军械库 · 用时 ' + mmss(me ? me.finishedAt : 0);
        } else if (pr && me) {
          e.resultPlace.textContent =
            ordinal(pr) + ' / 共 ' + rows.length + ' 人 · 到达 Lv' + me.level;
        } else {
          e.resultPlace.textContent = '';
        }
      }

      if (e.resultRows) {
        e.resultRows.innerHTML = '';
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          const tr = document.createElement('tr');
          tr.className = (i === 0 ? 'champion' : '') + (r.isPlayer ? ' me' : '');
          const levelTxt = r.finishedAt
            ? '通关(' + final + ')'
            : 'Lv' + r.level + ' ' + match.labelAt(r.level);
          const cells = [
            i + 1,
            (i === 0 ? '♛ ' : '') + r.name,
            levelTxt,
            r.kills,
            r.demotes,
            r.demoted,
            match.stuckWeaponOf(r),
          ];
          for (let c = 0; c < cells.length; c++) {
            const td = document.createElement('td');
            td.textContent = cells[c];
            tr.appendChild(td);
          }
          e.resultRows.appendChild(tr);
        }
      }

      e.result.classList.remove('hidden');
      if (document.exitPointerLock) document.exitPointerLock();
      if (VF.Audio) VF.Audio.play(won ? 'victory' : 'confirm');
    },

    hideResult: function () {
      const e = els();
      if (e && e.result) e.result.classList.add('hidden');
    },

    syncResultCountdown: function (secs) {
      const e = els();
      if (e && e.resultCountdown) {
        e.resultCountdown.textContent = secs > 0 ? Math.ceil(secs) + 's 后自动返回' : '';
      }
    },
  };

  VF.GgUi = Ui;
})(typeof window !== 'undefined' ? window : globalThis);
