/**
 * tdm-ui.js — 团队死斗 HUD: score bars, kill feed, phase banner, result panel.
 *
 * Reuses the existing top bar: its two segment bars and centre clock already
 * have exactly the shape TDM needs, so this only swaps the data source and adds
 * the pieces that had no equivalent (kill feed, respawn countdown, MVP table).
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});

  /** Fraction of the score limit at which the numerals start blinking. */
  const CRITICAL_AT = 0.8;

  const state = {
    els: null,
    bound: false,
    lastFeedOrder: 0,
    shownScore: { ally: -1, enemy: -1 },
    shownClock: -1,
    shownBanner: '',
  };

  function els() {
    if (state.els) return state.els;
    state.els = {
      row: document.getElementById('mission-row'),
      blue: document.getElementById('tdm-score-blue'),
      red: document.getElementById('tdm-score-red'),
      homeStatus: document.getElementById('home-status'),
      missionStatus: document.getElementById('mission-status'),
      homeSeg: document.getElementById('home-seg-bar'),
      missionSeg: document.getElementById('mission-seg-bar'),
      timer: document.getElementById('timer'),
      target: document.getElementById('match-target'),
      feed: document.getElementById('tdm-feed'),
      banner: document.getElementById('tdm-banner'),
      result: document.getElementById('tdm-result'),
      resultTitle: document.getElementById('tdm-result-title'),
      resultReason: document.getElementById('tdm-result-reason'),
      resultBlue: document.getElementById('tdm-result-blue'),
      resultRed: document.getElementById('tdm-result-red'),
      resultMvp: document.getElementById('tdm-result-mvp'),
      resultRows: document.getElementById('tdm-result-rows'),
      resultBack: document.getElementById('tdm-result-back'),
      resultCountdown: document.getElementById('tdm-result-countdown'),
    };
    return state.els;
  }

  /**
   * Fill a segmented score bar. `fromRight` mirrors the fill so the red (right)
   * bar grows from its own numeral inward toward the clock, matching the blue
   * (left) bar — a symmetric versus readout instead of both filling rightward.
   */
  function fillSegs(bar, pct, fromRight) {
    if (!bar) return;
    const segs = bar.querySelectorAll('.seg-fill');
    const n = segs.length || 1;
    const per = 100 / n;
    for (let i = 0; i < segs.length; i++) {
      const idx = fromRight ? n - 1 - i : i;
      const lo = idx * per;
      const f = Math.max(0, Math.min(1, (pct - lo) / per));
      segs[i].style.transform = 'scaleX(' + f + ')';
      segs[i].style.transformOrigin = fromRight ? 'right center' : 'left center';
    }
  }

  function mmss(sec) {
    const s = Math.max(0, Math.ceil(sec));
    const m = Math.floor(s / 60);
    return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  const Ui = {
    /* ────────────────────────── show / hide ────────────────────────── */

    enter: function () {
      const e = els();
      if (!e) return;
      state.lastFeedOrder = 0;
      state.shownScore = { ally: -1, enemy: -1 };
      state.shownClock = -1;
      state.shownBanner = '';
      if (e.blue) e.blue.classList.remove('hidden');
      if (e.red) e.red.classList.remove('hidden');
      if (e.feed) {
        e.feed.classList.remove('hidden');
        e.feed.innerHTML = '';
      }
      // 死斗 has no cores, so the bar titles must not claim otherwise
      if (e.homeStatus) e.homeStatus.title = '蓝方击杀数';
      if (e.missionStatus) e.missionStatus.title = '红方击杀数';
      const limit = (VF.TdmMatch && VF.TdmMatch.scoreLimit) || 50;
      if (e.target) e.target.textContent = limit;
      if (VF.UI && VF.UI.setHomeCoreLabel) VF.UI.setHomeCoreLabel('蓝方击杀数');
      if (VF.UI && VF.UI.setMissionTargetLabel) VF.UI.setMissionTargetLabel('红方击杀数');
      const objective = document.getElementById('objective');
      if (objective) objective.textContent = '击杀敌方 · 先达 ' + limit + ' 分';
      if (VF.UI && VF.UI.claimClock) VF.UI.claimClock('tdm');
      this._setBuildSlots(false);
      this.hideResult();
      this._bind();
    },

    leave: function () {
      const e = els();
      if (!e) return;
      if (VF.UI && VF.UI.releaseClock) VF.UI.releaseClock('tdm');
      if (e.blue) e.blue.classList.add('hidden');
      if (e.red) e.red.classList.add('hidden');
      if (e.feed) {
        e.feed.classList.add('hidden');
        e.feed.innerHTML = '';
      }
      if (e.banner) e.banner.classList.add('hidden');
      if (e.homeStatus) e.homeStatus.title = '蓝方核心';
      if (e.missionStatus) e.missionStatus.title = '红方核心';
      this._setBuildSlots(true);
      this.hideResult();
    },

    /** The build hotbar slots and resource counters are dead weight here. */
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
          if (VF.TdmMatch) VF.TdmMatch.stop();
          if (VF.TdmSpawn) VF.TdmSpawn.stop();
          if (VF.game && VF.game.returnFromMatch) VF.game.returnFromMatch();
        });
      }
    },

    /* ──────────────────────── per-frame sync ──────────────────────── */

    sync: function (match) {
      const e = els();
      if (!e || !match) return;
      const limit = match.scoreLimit || 50;

      if (match.score.ally !== state.shownScore.ally) {
        state.shownScore.ally = match.score.ally;
        if (e.blue) e.blue.textContent = match.score.ally;
        fillSegs(e.homeSeg, (match.score.ally / limit) * 100);
        if (e.blue) {
          e.blue.classList.toggle('critical', match.score.ally >= limit * CRITICAL_AT);
        }
      }
      if (match.score.enemy !== state.shownScore.enemy) {
        state.shownScore.enemy = match.score.enemy;
        if (e.red) e.red.textContent = match.score.enemy;
        fillSegs(e.missionSeg, (match.score.enemy / limit) * 100, true);
        if (e.red) {
          e.red.classList.toggle('critical', match.score.enemy >= limit * CRITICAL_AT);
        }
      }

      const clockSec = match.phase === 'prep' ? match.phaseLeft : match.timeLeft;
      const whole = Math.ceil(clockSec);
      if (whole !== state.shownClock) {
        state.shownClock = whole;
        if (e.timer) e.timer.textContent = mmss(clockSec);
      }

      this._syncBanner(match);
      this._ageFeed();
    },

    _syncBanner: function (match) {
      const e = els();
      if (!e || !e.banner) return;
      let text = '';
      let warn = false;

      const spawn = VF.TdmSpawn;
      if (spawn && spawn.isWaiting()) {
        const secs = Math.max(1, Math.ceil(spawn.respawnLeft()));
        text = '复活倒计时 ' + secs + 's';
        warn = true;
        // The death card covers the HUD, so the countdown has to live there too
        const flavor = document.getElementById('death-flavor');
        if (flavor) flavor.textContent = secs + ' 秒后重新投放';
      } else if (match.phase === 'prep') {
        text = '准备阶段 ' + Math.max(1, Math.ceil(match.phaseLeft)) + 's';
      } else if (match.phase === 'overtime') {
        text = '骤死加时 ' + mmss(match.timeLeft);
        warn = true;
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
      const myTeam = (VF.game && VF.game.player && VF.game.player.team) || 'ally';

      const row = document.createElement('div');
      row.className = 'tdm-feed-row';
      row.dataset.order = entry.order;
      const mine = entry.killer === '你' || entry.victim === '你';
      if (mine) row.classList.add('mine');
      if (entry.kind !== 'kill') row.classList.add('negative');

      const teamClass = (t) => (t === 'enemy' ? 'red' : 'blue');

      if (entry.kind === 'suicide') {
        row.appendChild(nameSpan(entry.victim, teamClass(entry.victimTeam)));
        row.appendChild(verbSpan('阵亡'));
      } else {
        row.appendChild(nameSpan(entry.killer, teamClass(entry.killerTeam)));
        row.appendChild(verbSpan(entry.kind === 'teamkill' ? '误杀' : '击杀'));
        row.appendChild(nameSpan(entry.victim, teamClass(entry.victimTeam)));
        if (entry.headshot) {
          const hs = document.createElement('span');
          hs.className = 'tdm-feed-hs';
          hs.textContent = '爆头';
          row.appendChild(hs);
        }
      }

      e.feed.appendChild(row);
      while (e.feed.childElementCount > 6) e.feed.removeChild(e.feed.firstElementChild);

      function nameSpan(text, cls) {
        const s = document.createElement('span');
        s.className = 'tdm-feed-name ' + cls;
        s.textContent = text || '?';
        return s;
      }
      function verbSpan(text) {
        const s = document.createElement('span');
        s.className = 'tdm-feed-verb';
        s.textContent = text;
        return s;
      }
      void myTeam;
    },

    /** Drop rows whose match-side entry has expired. */
    _ageFeed: function () {
      const e = els();
      const match = VF.TdmMatch;
      if (!e || !e.feed || !match) return;
      const live = {};
      for (let i = 0; i < match.feed.length; i++) live[match.feed[i].order] = true;
      const rows = e.feed.children;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (!live[rows[i].dataset.order]) e.feed.removeChild(rows[i]);
      }
    },

    onStreak: function (row, label) {
      if (!row || !row.isPlayer) return;
      void label;
    },

    onRespawn: function (pick, protect) {
      void pick;
      void protect;
      state.shownBanner = '';
    },

    /* ────────────────────────── result panel ──────────────────────── */

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
      const draw = !match.winner;

      if (e.resultTitle) {
        e.resultTitle.textContent = draw ? '平局' : won ? '胜利' : '失败';
        e.resultTitle.classList.toggle('lose', !draw && !won);
        e.resultTitle.classList.toggle('draw', draw);
      }
      if (e.resultReason) e.resultReason.textContent = match.endReason || '';
      if (e.resultBlue) e.resultBlue.textContent = match.score.ally;
      if (e.resultRed) e.resultRed.textContent = match.score.enemy;

      const mvp = match.mvp();
      if (e.resultMvp) {
        e.resultMvp.textContent = mvp
          ? 'MVP · ' +
            mvp.name +
            '（' +
            mvp.kills +
            ' 杀 / ' +
            mvp.deaths +
            ' 死 / ' +
            mvp.assists +
            ' 助 · ' +
            mvp.score +
            ' 分）'
          : '';
      }

      if (e.resultRows) {
        e.resultRows.innerHTML = '';
        const rows = match.ranking();
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          const tr = document.createElement('tr');
          tr.className = (r.team === 'enemy' ? 'red' : 'blue') + (r.isPlayer ? ' me' : '');
          const cells = [
            i + 1,
            r.name,
            r.kills,
            r.deaths,
            r.assists,
            r.headshots,
            r.bestStreak,
            r.score,
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

  VF.TdmUi = Ui;
})(typeof window !== 'undefined' ? window : globalThis);
