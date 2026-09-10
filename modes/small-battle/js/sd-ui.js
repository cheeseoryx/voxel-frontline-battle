/**
 * sd-ui.js — 爆破模式 HUD：回合比分、局钟 / 炸弹倒计时、阶段与安装/拆除提示。
 *
 * 复用顶栏既有的两个比分数字、分段条与中央时钟——它们的形状恰好符合爆破所需，
 * 因此本模块只替换数据源：左右数字改为“蓝/红已赢回合数”，分段条按 roundsToWin
 * 填充，中央时钟显示局钟或（安包后）炸弹倒计时。安装/拆除进度走中央提示条。
 *
 * 所有状态从 SdMatch.snapshot() 与 SdBomb.snapshot() 读取，UI 不持有任何规则。
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});

  const state = {
    els: null,
    bound: false,
    shownWins: { ally: -1, enemy: -1 },
    shownClock: -1,
    shownBanner: '',
    shownStatus: '',
  };

  function els() {
    if (state.els) return state.els;
    state.els = {
      blue: document.getElementById('tdm-score-blue'),
      red: document.getElementById('tdm-score-red'),
      homeStatus: document.getElementById('home-status'),
      missionStatus: document.getElementById('mission-status'),
      homeSeg: document.getElementById('home-seg-bar'),
      missionSeg: document.getElementById('mission-seg-bar'),
      timer: document.getElementById('timer'),
      target: document.getElementById('match-target'),
      banner: document.getElementById('tdm-banner'),
      objective: document.getElementById('objective'),
    };
    return state.els;
  }

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

  function repeatHtml(html, n) {
    let s = '';
    for (let i = 0; i < n; i++) s += html;
    return s;
  }

  // 存活=站立小人（队色描边填充），阵亡=骷髅（灰）。用内联 SVG + currentColor 上色，
  // 由 CSS 决定队色，像素化渲染贴合整体像素风。眼窝/鼻孔用 evenodd 挖空成骷髅。
  const SOLDIER_SVG =
    '<svg viewBox="0 0 12 16" fill="currentColor" aria-hidden="true">' +
    '<path d="M6 1.1a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6z' +
    'M3.4 7C3.4 6.2 4.5 5.9 6 5.9s2.6.3 2.6 1.1L8.2 11h-.7l-.3 4h-.7l-.3-3.8h-.4L5.2 15h-.7l-.3-4h-.7z"/></svg>';
  const SKULL_SVG =
    '<svg viewBox="0 0 14 14" fill="currentColor" fill-rule="evenodd" aria-hidden="true">' +
    '<path d="M7 1c3.4 0 5.4 2.3 5.4 5.3 0 1.7-.7 2.8-1.7 3.5v1.7c0 .6-.5 1-1.2 1H4.5c-.7 0-1.2-.4-1.2-1V9.8C2.3 9.1 1.6 8 1.6 6.3 1.6 3.3 3.6 1 7 1z' +
    'M5 5a1.4 1.4 0 1 0 0 2.8A1.4 1.4 0 0 0 5 5z' +
    'M9 5a1.4 1.4 0 1 0 0 2.8A1.4 1.4 0 0 0 9 5z' +
    'M7 8.3 6.2 9.9h1.6z"/></svg>';

  /** 一队的存活/阵亡图标条：存活=站立小人，阵亡=骷髅。deadFirst 让阵亡靠向中央。*/
  function statusIcons(alive, total, team, deadFirst) {
    const a = Math.max(0, alive | 0);
    const dead = Math.max(0, (total | 0) - a);
    const aliveHtml = repeatHtml('<i class="sd-ic alive ' + team + '">' + SOLDIER_SVG + '</i>', a);
    const deadHtml = repeatHtml('<i class="sd-ic dead">' + SKULL_SVG + '</i>', dead);
    return deadFirst ? deadHtml + aliveHtml : aliveHtml + deadHtml;
  }

  function roundsToWin() {
    return (VF.GameModes && VF.GameModes.param('roundsToWin', 7)) || 7;
  }

  function playerTeam() {
    const g = VF.game;
    return (g && g.player && g.player.team) || (g && g.world && g.world._playerTeam) || 'ally';
  }

  const Ui = {
    /* ────────────────────────── show / hide ────────────────────────── */

    enter: function () {
      const e = els();
      if (!e) return;
      state.shownWins = { ally: -1, enemy: -1 };
      state.shownClock = -1;
      state.shownBanner = '';
      const target = roundsToWin();
      if (e.blue) {
        e.blue.classList.remove('hidden');
        e.blue.textContent = '0';
      }
      if (e.red) {
        e.red.classList.remove('hidden');
        e.red.textContent = '0';
      }
      if (e.homeStatus) e.homeStatus.title = '蓝方回合数';
      if (e.missionStatus) e.missionStatus.title = '红方回合数';
      if (e.target) e.target.textContent = target;
      if (e.objective) e.objective.textContent = '爆破 · 先赢 ' + target + ' 回合';
      if (VF.UI && VF.UI.setHomeCoreLabel) VF.UI.setHomeCoreLabel('蓝方回合数');
      if (VF.UI && VF.UI.setMissionTargetLabel) VF.UI.setMissionTargetLabel('红方回合数');
      if (VF.UI && VF.UI.claimClock) VF.UI.claimClock('sd');
      this._setBuildSlots(false);
      if (VF.SdMatch) {
        VF.SdMatch.hooks.onRoundEnd = function (r) {
          Ui.onRoundEnd(r);
        };
        VF.SdMatch.hooks.onMatchEnd = function (r) {
          Ui.onMatchEnd(r);
        };
      }
    },

    leave: function () {
      const e = els();
      if (!e) return;
      if (VF.UI && VF.UI.releaseClock) VF.UI.releaseClock('sd');
      if (VF.SdResult && VF.SdResult.hide) VF.SdResult.hide();
      if (e.blue) e.blue.classList.add('hidden');
      if (e.red) e.red.classList.add('hidden');
      if (e.banner) e.banner.classList.add('hidden');
      const status = document.getElementById('sd-status');
      if (status) status.classList.add('hidden');
      state.shownStatus = '';
      if (e.homeStatus) e.homeStatus.title = '蓝方核心';
      if (e.missionStatus) e.missionStatus.title = '红方核心';
      this._setBuildSlots(true);
    },

    _setBuildSlots: function () {
      if (VF.UI && VF.UI.syncHotbarLayout) VF.UI.syncHotbarLayout();
      if (VF.UI && VF.UI.syncBuildHud) VF.UI.syncBuildHud();
    },

    /* ──────────────────────── per-frame sync ──────────────────────── */

    sync: function (match) {
      const e = els();
      if (!e || !match) return;
      const target = roundsToWin();

      if (match.wins.ally !== state.shownWins.ally) {
        state.shownWins.ally = match.wins.ally;
        if (e.blue) e.blue.textContent = match.wins.ally;
        fillSegs(e.homeSeg, (match.wins.ally / target) * 100);
      }
      if (match.wins.enemy !== state.shownWins.enemy) {
        state.shownWins.enemy = match.wins.enemy;
        if (e.red) e.red.textContent = match.wins.enemy;
        fillSegs(e.missionSeg, (match.wins.enemy / target) * 100, true);
      }

      const clockSec = match.displayClock ? match.displayClock() : match.roundClock;
      const whole = Math.ceil(clockSec);
      if (whole !== state.shownClock) {
        state.shownClock = whole;
        if (e.timer) e.timer.textContent = mmss(clockSec);
      }

      this._syncBanner(match);
      this._syncStatus(match);
    },

    /** 计时下方的双方存活/阵亡条：蓝(ally)在左、红(enemy)在右，中央显示当前包点字母。*/
    _syncStatus: function (match) {
      const el = document.getElementById('sd-status');
      if (!el) return;
      const S = VF.SdStats;
      if (!S || !S.active || match.phase === 'result') {
        el.classList.add('hidden');
        state.shownStatus = '';
        return;
      }
      const bA = S.aliveCount('ally');
      const bT = S.teamTotal('ally');
      const rA = S.aliveCount('enemy');
      const rT = S.teamTotal('enemy');
      const b = VF.SdBomb;
      const snap = b ? b.snapshot() : null;
      const site = snap && snap.site ? String(snap.site).toUpperCase() : '';

      const key = bA + '/' + bT + '|' + rA + '/' + rT + '|' + site;
      el.classList.remove('hidden');
      if (key === state.shownStatus) return;
      state.shownStatus = key;

      const blueEl = document.getElementById('sd-status-blue');
      const redEl = document.getElementById('sd-status-red');
      const siteEl = document.getElementById('sd-status-site');
      if (blueEl) blueEl.innerHTML = statusIcons(bA, bT, 'blue', false);
      if (redEl) redEl.innerHTML = statusIcons(rA, rT, 'red', true);
      if (siteEl) {
        if (site) {
          siteEl.textContent = site;
          siteEl.classList.remove('hidden');
        } else {
          siteEl.classList.add('hidden');
        }
      }
    },

    _syncBanner: function (match) {
      const e = els();
      if (!e || !e.banner) return;
      const attacking = playerTeam() === match.attackerTeam;
      let text = '';
      let warn = false;

      const b = VF.SdBomb;
      const snap = b ? b.snapshot() : null;

      if (match.phase === 'result') {
        text = (match.lastResult && match.lastResult.reason) || '本回合结束';
      } else if (match.phase === 'buy') {
        text =
          '准备阶段 ' +
          Math.max(1, Math.ceil(match.roundClock)) +
          's · 你是' +
          (attacking ? '进攻方' : '防守方');
      } else if (snap && snap.state === 'planting') {
        text = '安装炸弹中 ' + Math.round(snap.plantProgress * 100) + '%';
        warn = true;
      } else if (snap && snap.state === 'defusing') {
        text =
          '拆除中 ' +
          Math.round(snap.defuseProgress * 100) +
          '% · 引爆 ' +
          Math.max(0, Math.ceil(snap.remaining)) +
          's';
        warn = true;
      } else if (snap && snap.state === 'planted') {
        text =
          '炸弹已安装 · 引爆 ' +
          Math.max(0, Math.ceil(snap.remaining)) +
          's' +
          (attacking ? '' : ' · 按住 E 拆除');
        warn = true;
      } else if (snap && snap.state === 'carried') {
        const iCarry = snap.carrierId === 'player';
        if (iCarry) text = '你携带炸弹 · 前往 A/B 包点安装';
        else if (attacking) text = '消灭守军 · 掩护安装炸弹';
        else text = '守住 A/B 包点 · 阻止安装';
      } else if (snap && snap.state === 'dropped') {
        text = attacking ? '炸弹已掉落 · 靠近拾取' : '炸弹已掉落 · 阻止敌方拾取';
        warn = true;
      }

      if (text === state.shownBanner) return;
      state.shownBanner = text;
      e.banner.textContent = text;
      e.banner.classList.toggle('hidden', !text);
      e.banner.classList.toggle('warn', warn);
    },

    /* ───────────────────────── round / match end ────────────────────── */

    onRoundEnd: function (result) {
      if (VF.SdResult && VF.SdResult.showRound) {
        VF.SdResult.showRound(result, VF.SdMatch);
        return;
      }
      if (VF.UI && VF.UI.toast && result) {
        const who = result.winner === 'ally' ? '蓝方' : '红方';
        VF.UI.toast(who + '拿下本回合 · ' + (result.reason || ''));
      }
    },

    onMatchEnd: function (result) {
      if (!result) return;
      if (VF.SdResult && VF.SdResult.showMatch) {
        VF.SdResult.showMatch(result, VF.SdMatch);
        return;
      }
      if (VF.UI && VF.UI.toast) {
        VF.UI.toast(result.won ? '整局胜利' : '整局失败');
      }
    },
  };

  VF.SdUi = Ui;
})(typeof window !== 'undefined' ? window : globalThis);