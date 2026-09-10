/**
 * ffa-match.js — 自由混战 (Free-For-All) match state: clock, per-player scoring,
 * live ranking and win conditions.
 *
 * Unlike 死斗, there are no teams: every combatant keeps an independent kill
 * tally and the whole outcome is a personal ranking. The match ends the instant
 * anyone reaches the kill limit, or on time-up with the highest kill count. Ties
 * break by fewest deaths, then by who reached the score first.
 *
 * Participant ids: 'player' for the local player, unit.id for AI. Every AI is
 * an enemy of every other AI, so the internal 'ally'/'enemy' team fields carry
 * no meaning here — scoring never reads them.
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});

  const PHASE_PREP = 'prep';
  const PHASE_BATTLE = 'battle';
  const PHASE_RESULT = 'result';

  const FEED_MAX = 6;
  const FEED_TTL = 7.0;
  const STREAK_LABEL = { 3: '三连杀', 5: '五连杀', 7: '七连杀' };

  function params() {
    return VF.GameModes ? VF.GameModes.getParams('ffa') : {};
  }

  const Ffa = {
    active: false,
    phase: PHASE_PREP,
    timeLeft: 0,
    phaseLeft: 0,
    stats: {},
    feed: [],
    ended: false,
    winner: null,
    endReason: '',
    _order: 0,
    _clock: 0,
    _shownRank: 0,

    /* ─────────────────────────── lifecycle ─────────────────────────── */

    start: function () {
      const p = params();
      this.active = true;
      this.ended = false;
      this.winner = null;
      this.endReason = '';
      this.phase = PHASE_PREP;
      this.stats = {};
      this.feed = [];
      this._order = 0;
      this._clock = 0;
      this._shownRank = 0;
      this.timeLeft = p.timeLimit != null ? p.timeLimit : 600;
      this.phaseLeft = p.prepTime != null ? p.prepTime : 10;
      this.scoreLimit = p.scoreLimit != null ? p.scoreLimit : 30;

      this.ensure('player', { name: '你', isPlayer: true });
      if (VF.game && VF.game.mode === 'pvp') {
        this.ensure('remote', { name: '对手' });
      }
      return this;
    },

    stop: function () {
      this.active = false;
      this.phase = PHASE_PREP;
      this.feed = [];
      if (VF.FfaMarker && VF.FfaMarker.stop) VF.FfaMarker.stop();
    },

    isRunning: function () {
      return this.active && !this.ended;
    },

    /** Combat only counts once the prep countdown has elapsed. */
    scoringLive: function () {
      return this.active && !this.ended && this.phase === PHASE_BATTLE;
    },

    /* ──────────────────────── participant stats ─────────────────────── */

    ensure: function (id, info) {
      if (!id) return null;
      let row = this.stats[id];
      if (!row) {
        row = this.stats[id] = {
          id: id,
          name: (info && info.name) || id,
          isPlayer: !!(info && info.isPlayer),
          kills: 0,
          deaths: 0,
          headshots: 0,
          score: 0,
          streak: 0,
          bestStreak: 0,
          // Match clock at which `kills` last changed — the tie-breaker for
          // two players who finish on the same kill count.
          reachedAt: 0,
        };
      } else if (info) {
        if (info.name) row.name = info.name;
        if (info.isPlayer) row.isPlayer = true;
      }
      return row;
    },

    idOf: function (actor) {
      if (!actor) return null;
      if (actor === 'player' || actor === 'remote') return actor;
      if (actor.isPlayer || (VF.game && actor === VF.game.player)) return 'player';
      return actor.id || null;
    },

    register: function (actor) {
      const id = this.idOf(actor);
      if (!id) return null;
      if (id === 'player') return this.ensure('player', { name: '你', isPlayer: true });
      if (id === 'remote') return this.ensure('remote', { name: '对手' });
      return this.ensure(id, { name: actor.name || id });
    },

    /**
     * Keep a row for every combatant currently on the field so the leaderboard
     * shows all 8 from the opening whistle, not only those who have scored.
     * Recycled ids mean a respawn reuses its slot instead of adding a row.
     */
    _ensureRoster: function () {
      if (VF.game && VF.game.mode === 'pvp') this.ensure('remote', { name: '对手' });
      const ai = VF.game && VF.game.ai;
      if (!ai) return;
      const lists = [ai.blue, ai.red];
      for (let l = 0; l < lists.length; l++) {
        const list = lists[l];
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const u = list[i];
          if (u && u.id) this.ensure(u.id, { name: u.name || u.id });
        }
      }
    },

    /* ───────────────────────── damage tracking ──────────────────────── */

    // FFA has no assists — damage is tracked only so the API matches 死斗's
    // call sites in ai.js / player.js. Nothing is scored from it.
    registerDamage: function () {},

    /* ──────────────────────────── scoring ───────────────────────────── */

    /**
     * Single entry point for every death in a 自由混战 match.
     * victim/killer may be an AI unit, the player object, or an id string.
     */
    registerKill: function (opts) {
      if (!this.scoringLive()) return null;
      opts = opts || {};
      const p = params();
      const ps = p.personalScore || {};

      const victimRow = this.register(opts.victim) || this.ensure(this.idOf(opts.victim));
      if (!victimRow) return null;
      const killerRow = opts.killer ? this.register(opts.killer) : null;
      const headshot = !!opts.headshot;

      victimRow.deaths += 1;
      victimRow.streak = 0;

      let kind = 'kill';
      if (!killerRow || killerRow.id === victimRow.id) {
        // Suicide / fall / environment: -1 kill (floored at 0) so it can never
        // be farmed for score, and a personal-score penalty on top.
        kind = 'suicide';
        const penalty = p.suicidePenalty != null ? p.suicidePenalty : -1;
        victimRow.kills = Math.max(0, victimRow.kills + penalty);
        victimRow.score += ps.suicide != null ? ps.suicide : -50;
        victimRow.reachedAt = this._clock;
      } else {
        killerRow.kills += 1;
        killerRow.streak += 1;
        killerRow.reachedAt = this._clock;
        if (killerRow.streak > killerRow.bestStreak) killerRow.bestStreak = killerRow.streak;
        if (headshot) killerRow.headshots += 1;
        killerRow.score += headshot
          ? ps.headshot != null
            ? ps.headshot
            : 150
          : ps.kill != null
            ? ps.kill
            : 100;
        this._announceStreak(killerRow);
      }

      const entry = {
        order: ++this._order,
        life: FEED_TTL,
        kind: kind,
        headshot: headshot,
        killer: killerRow ? killerRow.name : null,
        killerIsPlayer: !!(killerRow && killerRow.isPlayer),
        victim: victimRow.name,
        victimIsPlayer: !!victimRow.isPlayer,
      };
      this.feed.push(entry);
      while (this.feed.length > FEED_MAX) this.feed.shift();

      if (VF.FfaUi && VF.FfaUi.onKill) VF.FfaUi.onKill(entry);
      this._notifyRank();
      this._checkScoreLimit();
      return entry;
    },

    registerSuicide: function (victim) {
      return this.registerKill({ victim: victim, killer: null });
    },

    /**
     * Multi-kill toast + kill-voice ladder for the player. Per the design's
     * "克制版" killstreak, FFA gives NO reward item (no UAV / airstrike) — the
     * streak is acknowledgement only, so a snowballing leader gets no extra
     * firepower on top of their lead.
     */
    _announceStreak: function (row) {
      const p = params();
      if (!p.killstreak) return;
      const tiers = p.killstreakTiers || [3, 5, 7];
      if (tiers.indexOf(row.streak) < 0) return;
      const label = STREAK_LABEL[row.streak] || row.streak + '连杀';
      if (row.isPlayer) {
        if (VF.UI && VF.UI.toast) VF.UI.toast(label);
        const pitch = 1 + row.streak * 0.05;
        if (VF.Audio && VF.Audio.later) {
          VF.Audio.later(160, function () {
            VF.Audio.play('kill', { pitch: pitch, streak: row.streak });
          });
        }
      }
      if (VF.FfaUi && VF.FfaUi.onStreak) VF.FfaUi.onStreak(row, label);
    },

    /** Toast the player when their placement moves, per the design's rank-change feedback. */
    _notifyRank: function () {
      const rank = this.playerRank();
      if (!rank || rank === this._shownRank) return;
      const prev = this._shownRank;
      this._shownRank = rank;
      if (!prev) return; // first placement — nothing to compare against yet
      if (!(VF.UI && VF.UI.toast)) return;
      if (rank === 1 && prev !== 1 && this.leaderMarkerOn()) {
        // 枪打出头鸟:登顶即成为全场追杀目标（头顶皇冠对所有人可见）
        VF.UI.toast('登顶第一 · 你已成为众矢之的');
      } else if (rank < prev) {
        VF.UI.toast('升至第 ' + rank + ' 名');
      } else {
        VF.UI.toast('被超越 · 降至第 ' + rank + ' 名');
      }
    },

    /* ───────────────────────── clock & outcome ──────────────────────── */

    update: function (dt) {
      if (!this.active) return;

      if (this.ended) {
        if (VF.FfaMarker && VF.FfaMarker.hide) VF.FfaMarker.hide();
        if (VF.WeaponInspect && VF.WeaponInspect.isActive && VF.WeaponInspect.isActive()) return;
        if (this.phaseLeft > 0) {
          this.phaseLeft = Math.max(0, this.phaseLeft - dt);
          if (VF.FfaUi && VF.FfaUi.syncResultCountdown) {
            VF.FfaUi.syncResultCountdown(this.phaseLeft);
          }
          if (this.phaseLeft <= 0) {
            this.active = false;
            if (VF.FfaUi && VF.FfaUi.hideResult) VF.FfaUi.hideResult();
            if (VF.game && VF.game.returnFromMatch) VF.game.returnFromMatch();
          }
        }
        return;
      }

      this._ensureRoster();

      for (let i = this.feed.length - 1; i >= 0; i--) {
        this.feed[i].life -= dt;
        if (this.feed[i].life <= 0) this.feed.splice(i, 1);
      }

      if (this.phase === PHASE_PREP) {
        this.phaseLeft -= dt;
        if (this.phaseLeft <= 0) {
          this.phase = PHASE_BATTLE;
          this.phaseLeft = 0;
          this._shownRank = this.playerRank();
          if (VF.UI && VF.UI.toast) VF.UI.toast('战斗开始');
          if (VF.Audio) VF.Audio.play('confirm');
        }
        if (VF.FfaUi && VF.FfaUi.sync) VF.FfaUi.sync(this);
        return;
      }

      if (this.phase === PHASE_BATTLE) {
        this._clock += dt;
        this.timeLeft = Math.max(0, this.timeLeft - dt);
        if (VF.FfaMarker && VF.FfaMarker.sync) VF.FfaMarker.sync(dt);
        if (this.timeLeft <= 0) this._onTimeExpired();
      }

      if (VF.FfaUi && VF.FfaUi.sync) VF.FfaUi.sync(this);
    },

    _checkScoreLimit: function () {
      if (this.ended) return;
      const limit = this.scoreLimit || 30;
      const leader = this.ranking()[0];
      // registerKill applies score sequentially, so the first to cross the
      // limit is by definition the first to reach it.
      if (leader && leader.kills >= limit) {
        this.end(leader.id, leader.name + ' 达到击杀上限');
      }
    },

    _onTimeExpired: function () {
      const leader = this.ranking()[0];
      if (leader) this.end(leader.id, '时间到 · 击杀数第一');
      else this.end(null, '时间到');
    },

    forceEnd: function (winnerId, reason) {
      this.end(winnerId || null, reason || '对局结束');
    },

    end: function (winnerId, reason) {
      if (this.ended) return;
      this.ended = true;
      this.winner = winnerId || null;
      this.endReason = reason || '';
      this.phase = PHASE_RESULT;
      this.phaseLeft = params().resultTime != null ? params().resultTime : 15;

      const won = winnerId === 'player';

      if (VF.game) VF.game.running = false;
      if (VF.Economy && VF.Economy.grantMatchReward) {
        VF.Economy.grantMatchReward(params().reward || 'tdm', won);
      }
      if (VF.FfaUi && VF.FfaUi.showResult) VF.FfaUi.showResult(this, won);
      else if (VF.UI && VF.UI.showVictory) {
        VF.UI.showVictory(won ? '冠军' : '本局结束', this.endReason);
      }
    },

    /* ──────────────────────────── queries ──────────────────────────── */

    /**
     * Personal ranking: kills desc, then deaths asc, then earliest to reach the
     * score (reachedAt asc) — the design's tie-break ladder.
     */
    ranking: function () {
      const rows = [];
      for (const id in this.stats) {
        if (Object.prototype.hasOwnProperty.call(this.stats, id)) rows.push(this.stats[id]);
      }
      rows.sort(function (a, b) {
        if (b.kills !== a.kills) return b.kills - a.kills;
        if (a.deaths !== b.deaths) return a.deaths - b.deaths;
        return a.reachedAt - b.reachedAt;
      });
      return rows;
    },

    /** 1-based placement of the local player, or 0 if not registered yet. */
    playerRank: function () {
      const rows = this.ranking();
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].id === 'player') return i + 1;
      }
      return 0;
    },

    /** Current leader's id — drives the optional 领先者标记 (crown). */
    leaderId: function () {
      const rows = this.ranking();
      return rows.length ? rows[0].id : null;
    },

    leaderMarkerOn: function () {
      return !!params().leaderMarker;
    },

    playerStats: function () {
      return this.stats.player || null;
    },
  };

  VF.FfaMatch = Ffa;
})(typeof window !== 'undefined' ? window : globalThis);