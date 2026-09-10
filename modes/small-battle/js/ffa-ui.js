/**
 * ffa-ui.js — 自由混战 HUD: live leaderboard, kill feed, respawn banner, result.
 *
 * FFA's soul is the live ranking, so this owns a dedicated leaderboard panel
 * (#ffa-rank) that lists every combatant by kills, highlighting the player and
 * crowning the current leader. It reuses the 死斗 feed / banner / result styling
 * (same CSS classes, separate elements) so it adds no team-based UI and never
 * touches the 死斗 HUD.
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
  };

  function els() {
    if (state.els) return state.els;
    state.els = {
      timer: document.getElementById('timer'),
      target: document.getElementById('match-target'),
      rank: document.getElementById('ffa-rank'),
      feed: document.getElementById('ffa-feed'),
      banner: document.getElementById('ffa-banner'),
      result: document.getElementById('ffa-result'),
      resultTitle: document.getElementById('ffa-result-title'),
      resultReason: document.getElementById('ffa-result-reason'),
      resultPlace: document.getElementById('ffa-result-place'),
      resultRows: document.getElementById('ffa-result-rows'),
      resultBack: document.getElementById('ffa-result-back'),
      resultCountdown: document.getElementById('ffa-result-countdown'),
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
      if (e.rank) {
        e.rank.classList.remove('hidden');
        e.rank.innerHTML = '';
      }
      if (e.feed) {
        e.feed.classList.remove('hidden');
        e.feed.innerHTML = '';
      }
      const limit = (VF.FfaMatch && VF.FfaMatch.scoreLimit) || 30;
      if (e.target) e.target.textContent = limit;
      const objective = document.getElementById('objective');
      if (objective) objective.textContent = '自由混战 · 先达 ' + limit + ' 杀';
      if (VF.UI && VF.UI.claimClock) VF.UI.claimClock('ffa');
      this._setBuildSlots(false);
      this.hideResult();
      this._bind();
    },

    leave: function () {
      const e = els();
      if (!e) return;
      if (VF.UI && VF.UI.releaseClock) VF.UI.releaseClock('ffa');
      if (e.rank) {
        e.rank.classList.add('hidden');
        e.rank.innerHTML = '';
      }
      if (e.feed) {
        e.feed.classList.add('hidden');
        e.feed.innerHTML = '';
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
          if (VF.FfaMatch) VF.FfaMatch.stop();
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

      this._renderRank(match);
      this._syncBanner(match);
    },

    /* ─────────────────────── live leaderboard ─────────────────────── */

    _renderRank: function (match) {
      const e = els();
      if (!e || !e.rank) return;
      const rows = match.ranking();
      const leaderId = match.leaderMarkerOn() ? match.leaderId() : null;

      // Cheap change-detection so the panel is not rebuilt every frame
      let sig = leaderId || '';
      for (let i = 0; i < rows.length; i++) sig += '|' + rows[i].id + ':' + rows[i].kills;
      if (sig === state.rankSig) return;
      state.rankSig = sig;

      const limit = match.scoreLimit || 30;
      const leaderKills = rows.length ? rows[0].kills : 0;

      e.rank.innerHTML = '';
      const head = document.createElement('div');
      head.className = 'ffa-rank-head';
      const pr = match.playerRank();
      head.textContent = '排行榜 · ' + (pr ? ordinal(pr) : '—') + ' / ' + rows.length + ' 人';
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

        const kills = document.createElement('span');
        kills.className = 'ffa-rank-kills';
        kills.textContent = r.kills;
        if (r.kills >= limit * 0.8) kills.classList.add('critical');
        row.appendChild(kills);

        e.rank.appendChild(row);
      }

      const gap = document.createElement('div');
      gap.className = 'ffa-rank-foot';
      if (pr > 1) {
        const me = match.playerStats();
        const need = me ? Math.max(1, leaderKills - me.kills) : leaderKills;
        gap.textContent = '距第一 ' + need + ' 杀';
      } else if (pr === 1) {
        gap.textContent = '你处于领先 · 众矢之的';
        gap.classList.add('leading');
      }
      e.rank.appendChild(gap);
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
        row.appendChild(verbSpan('击杀'));
        row.appendChild(nameSpan(entry.victim, entry.victimIsPlayer));
        if (entry.headshot) {
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
        // Self is blue, everyone else is red — the FFA identity rule.
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

    onStreak: function (row, label) {
      void row;
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
      const rows = match.ranking();
      const pr = match.playerRank();

      if (e.resultTitle) {
        e.resultTitle.textContent = won ? '冠军' : '本局结束';
        e.resultTitle.classList.toggle('lose', !won);
      }
      if (e.resultReason) e.resultReason.textContent = match.endReason || '';
      if (e.resultPlace) {
        e.resultPlace.textContent = pr
          ? ordinal(pr) + ' / 共 ' + rows.length + ' 人'
          : '';
      }

      if (e.resultRows) {
        e.resultRows.innerHTML = '';
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          const tr = document.createElement('tr');
          tr.className = (i === 0 ? 'champion' : '') + (r.isPlayer ? ' me' : '');
          const kd = r.deaths > 0 ? (r.kills / r.deaths).toFixed(2) : r.kills.toFixed(2);
          const cells = [
            i + 1,
            (i === 0 ? '♛ ' : '') + r.name,
            r.kills,
            r.deaths,
            kd,
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

  VF.FfaUi = Ui;
})(typeof window !== 'undefined' ? window : globalThis);