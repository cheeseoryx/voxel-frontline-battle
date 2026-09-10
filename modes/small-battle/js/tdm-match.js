/**
 * tdm-match.js — 团队死斗 match state: clock, scoring, win conditions.
 *
 * This module owns the one thing the codebase never had: a kill event with
 * attribution. Team score, personal score, assists, killstreaks, the kill feed
 * and the MVP table are all derived from registerKill(), so nothing else needs
 * to keep its own tally.
 *
 * Participant ids: 'player' for the local player, unit.id for AI, 'remote' for
 * the PVP opponent.
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});

  const PHASE_PREP = 'prep';
  const PHASE_BATTLE = 'battle';
  const PHASE_OVERTIME = 'overtime';
  const PHASE_RESULT = 'result';

  const FEED_MAX = 6;
  const FEED_TTL = 7.0;
  /** Multi-kill labels reuse the existing kill-voice ladder in ai.js. */
  const STREAK_LABEL = { 3: '三连杀', 5: '五连杀', 7: '七连杀' };

  function params() {
    return VF.GameModes ? VF.GameModes.getParams('tdm') : {};
  }

  const Tdm = {
    active: false,
    phase: PHASE_PREP,
    score: { ally: 0, enemy: 0 },
    timeLeft: 0,
    phaseLeft: 0,
    stats: {},
    feed: [],
    ended: false,
    winner: null,
    endReason: '',
    _order: 0,

    /* ─────────────────────────── lifecycle ─────────────────────────── */

    start: function () {
      const p = params();
      this.active = true;
      this.ended = false;
      this.winner = null;
      this.endReason = '';
      this.phase = PHASE_PREP;
      this.score = { ally: 0, enemy: 0 };
      this.stats = {};
      this.feed = [];
      this._order = 0;
      this.timeLeft = p.timeLimit != null ? p.timeLimit : 600;
      this.phaseLeft = p.prepTime != null ? p.prepTime : 10;
      this.scoreLimit = p.scoreLimit != null ? p.scoreLimit : 50;

      const myTeam = (VF.game && VF.game.player && VF.game.player.team) || 'ally';
      this.ensure('player', {
        name: '你',
        team: myTeam,
        isPlayer: true,
      });
      // PVP: the networked opponent is a fixed 'remote' id (see idOf) — register
      // it up front with the correct opposing team so registerKill/registerDamage
      // never fall back to the ensure() default team.
      if (VF.game && VF.game.mode === 'pvp') {
        this.ensure('remote', {
          name: '对手',
          team: myTeam === 'ally' ? 'enemy' : 'ally',
        });
      }
      return this;
    },

    stop: function () {
      this.active = false;
      this.phase = PHASE_PREP;
      this.feed = [];
    },

    isRunning: function () {
      return this.active && !this.ended;
    },

    /** Guest never decides the outcome — it only mirrors the host's score/end. */
    _isPvpGuest: function () {
      return !!(VF.game && VF.game.mode === 'pvp' && VF.Pvp && VF.Pvp.mode === 'guest');
    },

    /** Host → guest score correction (AI kills are simulated locally on each
     * side and will drift; the host's tally is the one that decides winners). */
    syncScore: function (ally, enemy) {
      if (this.ended) return;
      if (ally != null) this.score.ally = Math.max(0, ally);
      if (enemy != null) this.score.enemy = Math.max(0, enemy);
    },

    /** Combat only counts once the prep countdown has elapsed. */
    scoringLive: function () {
      return (
        this.active &&
        !this.ended &&
        (this.phase === PHASE_BATTLE || this.phase === PHASE_OVERTIME)
      );
    },

    /* ──────────────────────── participant stats ─────────────────────── */

    ensure: function (id, info) {
      if (!id) return null;
      let row = this.stats[id];
      if (!row) {
        row = this.stats[id] = {
          id: id,
          name: (info && info.name) || id,
          team: (info && info.team) || 'ally',
          isPlayer: !!(info && info.isPlayer),
          kills: 0,
          deaths: 0,
          assists: 0,
          headshots: 0,
          score: 0,
          streak: 0,
          bestStreak: 0,
        };
      } else if (info) {
        if (info.name) row.name = info.name;
        if (info.team) row.team = info.team;
        if (info.isPlayer) row.isPlayer = true;
      }
      return row;
    },

    /** Stable id + display name for an AI unit or the player. */
    idOf: function (actor) {
      if (!actor) return null;
      if (actor === 'player' || actor === 'remote') return actor;
      if (actor.isPlayer || (VF.game && actor === VF.game.player)) return 'player';
      return actor.id || null;
    },

    register: function (actor) {
      const id = this.idOf(actor);
      if (!id) return null;
      if (id === 'player') {
        return this.ensure('player', {
          name: '你',
          team: (VF.game && VF.game.player && VF.game.player.team) || 'ally',
          isPlayer: true,
        });
      }
      return this.ensure(id, { name: actor.name || id, team: actor.team });
    },

    /* ───────────────────────── damage tracking ──────────────────────── */

    /**
     * Accumulate damage so assists can be resolved on death. Stored on the
     * victim so it dies with them and never needs cleanup.
     */
    registerDamage: function (victim, amount, attacker) {
      if (!this.scoringLive() || !victim || !(amount > 0)) return;
      const attackerId = this.idOf(attacker);
      if (!attackerId) return;
      if (!victim._tdmDmg) victim._tdmDmg = {};
      victim._tdmDmg[attackerId] = (victim._tdmDmg[attackerId] || 0) + amount;
    },

    _resolveAssists: function (victim, killerId, maxHp) {
      const p = params();
      const threshold = (p.assistThreshold != null ? p.assistThreshold : 0.4) * (maxHp || 100);
      const dmg = victim && victim._tdmDmg;
      const out = [];
      if (!dmg) return out;
      for (const id in dmg) {
        if (!Object.prototype.hasOwnProperty.call(dmg, id)) continue;
        if (id === killerId) continue;
        if (dmg[id] < threshold) continue;
        out.push(id);
      }
      return out;
    },

    /* ──────────────────────────── scoring ───────────────────────────── */

    _addTeam: function (team, delta) {
      if (!delta) return;
      if (team !== 'ally' && team !== 'enemy') return;
      this.score[team] = Math.max(0, this.score[team] + delta);
    },

    /**
     * Single entry point for every death in a 死斗 match.
     *
     * victim/killer may be an AI unit, the player object, or an id string.
     * Returns the feed entry so callers can react without re-deriving anything.
     */
    registerKill: function (opts) {
      if (!this.scoringLive()) return null;
      opts = opts || {};
      const p = params();
      const ts = p.teamScore || {};
      const ps = p.personalScore || {};

      const victimRow = this.register(opts.victim) || this.ensure(this.idOf(opts.victim));
      if (!victimRow) return null;
      const killerRow = opts.killer ? this.register(opts.killer) : null;
      const headshot = !!opts.headshot;

      victimRow.deaths += 1;
      victimRow.streak = 0;

      let kind = 'kill';
      if (!killerRow || killerRow.id === victimRow.id) {
        // Suicide / environment: the victim's own side loses ground
        kind = 'suicide';
        this._addTeam(victimRow.team, ts.suicide != null ? ts.suicide : -1);
        victimRow.score += ps.suicide != null ? ps.suicide : -50;
      } else if (killerRow.team === victimRow.team) {
        kind = 'teamkill';
        this._addTeam(killerRow.team, ts.teamkill != null ? ts.teamkill : -1);
        killerRow.score += ps.teamkill != null ? ps.teamkill : -100;
      } else {
        killerRow.kills += 1;
        killerRow.streak += 1;
        if (killerRow.streak > killerRow.bestStreak) killerRow.bestStreak = killerRow.streak;
        if (headshot) killerRow.headshots += 1;
        this._addTeam(
          killerRow.team,
          headshot ? (ts.headshot != null ? ts.headshot : 1) : ts.kill != null ? ts.kill : 1
        );
        killerRow.score += headshot
          ? ps.headshot != null
            ? ps.headshot
            : 150
          : ps.kill != null
            ? ps.kill
            : 100;

        const assists = this._resolveAssists(opts.victim, killerRow.id, opts.maxHp);
        for (let i = 0; i < assists.length; i++) {
          const row = this.stats[assists[i]];
          if (!row) continue;
          if (row.team === victimRow.team) continue;
          row.assists += 1;
          row.score += ps.assist != null ? ps.assist : 50;
          this._addTeam(row.team, ts.assist != null ? ts.assist : 0);
        }
        this._announceStreak(killerRow);
      }

      if (opts.victim && typeof opts.victim === 'object') opts.victim._tdmDmg = null;

      const entry = {
        order: ++this._order,
        life: FEED_TTL,
        kind: kind,
        headshot: headshot,
        killer: killerRow ? killerRow.name : null,
        killerTeam: killerRow ? killerRow.team : null,
        victim: victimRow.name,
        victimTeam: victimRow.team,
      };
      this.feed.push(entry);
      while (this.feed.length > FEED_MAX) this.feed.shift();

      if (VF.TdmUi && VF.TdmUi.onKill) VF.TdmUi.onKill(entry);
      this._checkScoreLimit();
      return entry;
    },

    registerSuicide: function (victim) {
      return this.registerKill({ victim: victim, killer: null });
    },

    _announceStreak: function (row) {
      const p = params();
      if (!p.killstreak) return;
      // Airstrike reward fires on EVERY 5th kill of the streak (5, 10, 15…),
      // decoupled from the toast tiers below — otherwise a long streak only
      // ever earned the one strike at exactly 5 and later milestones silently
      // dropped it, which read as "sometimes the airstrike doesn't trigger".
      if (row.streak > 0 && row.streak % 5 === 0) this._callAirstrike(row);
      const tiers = p.killstreakTiers || [3, 5, 7];
      if (tiers.indexOf(row.streak) < 0) return;
      const label = STREAK_LABEL[row.streak] || row.streak + '连杀';
      if (row.isPlayer) {
        if (VF.UI && VF.UI.toast) VF.UI.toast(label);
        // Delayed so the milestone reads as a flourish after the kill sting,
        // not as a thicker version of it
        const pitch = 1 + row.streak * 0.05;
        if (VF.Audio && VF.Audio.later) {
          VF.Audio.later(160, function () {
            VF.Audio.play('kill', { pitch: pitch, streak: row.streak });
          });
        }
      }
      if (VF.TdmUi && VF.TdmUi.onStreak) VF.TdmUi.onStreak(row, label);
    },

    /**
     * Reward a killstreak milestone with a single airstrike for the streaking
     * side. Environment actors (e.g. the airstrike itself) never call one back,
     * so a lucky bombing run can't cascade into more bombing runs.
     */
    _callAirstrike: function (row) {
      if (!row || (row.team !== 'ally' && row.team !== 'enemy')) return;
      if (row.id && String(row.id).indexOf('env:') === 0) return;
      const g = VF.game;
      const ev = g && g.battlefieldEvents;
      if (ev && ev.callStrike) ev.callStrike(row.team, g);
    },

    /* ───────────────────────── clock & outcome ──────────────────────── */

    update: function (dt) {
      if (!this.active) return;

      // Result phase: hold the summary, then bail out to the lobby
      if (this.ended) {
        if (VF.WeaponInspect && VF.WeaponInspect.isActive && VF.WeaponInspect.isActive()) return;
        if (this.phaseLeft > 0) {
          this.phaseLeft = Math.max(0, this.phaseLeft - dt);
          if (VF.TdmUi && VF.TdmUi.syncResultCountdown) {
            VF.TdmUi.syncResultCountdown(this.phaseLeft);
          }
          if (this.phaseLeft <= 0) {
            this.active = false;
            if (VF.TdmUi && VF.TdmUi.hideResult) VF.TdmUi.hideResult();
            if (VF.game && VF.game.returnFromMatch) VF.game.returnFromMatch();
          }
        }
        return;
      }

      for (let i = this.feed.length - 1; i >= 0; i--) {
        this.feed[i].life -= dt;
        if (this.feed[i].life <= 0) this.feed.splice(i, 1);
      }

      if (this.phase === PHASE_PREP) {
        this.phaseLeft -= dt;
        if (this.phaseLeft <= 0) {
          this.phase = PHASE_BATTLE;
          this.phaseLeft = 0;
          if (VF.UI && VF.UI.toast) VF.UI.toast('战斗开始');
          if (VF.Audio) VF.Audio.play('confirm');
        }
        if (VF.TdmUi && VF.TdmUi.sync) VF.TdmUi.sync(this);
        return;
      }

      if (this.phase === PHASE_BATTLE || this.phase === PHASE_OVERTIME) {
        this.timeLeft = Math.max(0, this.timeLeft - dt);
        if (this.timeLeft <= 0) this._onTimeExpired();
      }

      if (VF.TdmUi && VF.TdmUi.sync) VF.TdmUi.sync(this);
    },

    _checkScoreLimit: function () {
      if (this.ended || this._isPvpGuest()) return;
      const limit = this.scoreLimit || 50;
      // registerKill applies score sequentially, so the first side to cross
      // the limit here is by definition the first to reach it
      if (this.score.ally >= limit) this.end('ally', '达到击杀上限');
      else if (this.score.enemy >= limit) this.end('enemy', '达到击杀上限');
    },

    _onTimeExpired: function () {
      // Host broadcasts the real outcome via 'tdmEnd'; a guest that self-ends
      // here could declare a different winner than the one everyone gets paid on.
      if (this._isPvpGuest()) return;
      const p = params();
      if (this.score.ally > this.score.enemy) {
        this.end('ally', '时间到 · 击杀数领先');
      } else if (this.score.enemy > this.score.ally) {
        this.end('enemy', '时间到 · 击杀数领先');
      } else if (p.overtime && this.phase !== PHASE_OVERTIME) {
        this.phase = PHASE_OVERTIME;
        this.timeLeft = p.overtimeDuration != null ? p.overtimeDuration : 60;
        if (VF.UI && VF.UI.toast) VF.UI.toast('平分 · 进入骤死加时');
      } else {
        this.end(null, '双方击杀数相同');
      }
    },

    /** Forfeit paths: opponent left, everyone offline, host ended the match. */
    forceEnd: function (winnerTeam, reason) {
      this.end(winnerTeam || null, reason || '对局结束');
    },

    end: function (winnerTeam, reason) {
      if (this.ended) return;
      this.ended = true;
      this.winner = winnerTeam || null;
      this.endReason = reason || '';
      this.phase = PHASE_RESULT;
      this.phaseLeft = params().resultTime != null ? params().resultTime : 15;

      const g = VF.game;
      const myTeam = (g && g.player && g.player.team) || 'ally';
      const won = !!winnerTeam && winnerTeam === myTeam;

      if (g) g.running = false;
      if (VF.Economy && VF.Economy.grantMatchReward) {
        VF.Economy.grantMatchReward(params().reward || 'tdm', won);
      }
      if (VF.TdmUi && VF.TdmUi.showResult) VF.TdmUi.showResult(this, won);
      else if (VF.UI && VF.UI.showVictory) {
        VF.UI.showVictory(
          winnerTeam ? (won ? '胜利' : '失败') : '平局',
          this.endReason
        );
      }
    },

    /* ──────────────────────────── queries ──────────────────────────── */

    /** Personal-score ranking used for the MVP panel. */
    ranking: function () {
      const rows = [];
      for (const id in this.stats) {
        if (Object.prototype.hasOwnProperty.call(this.stats, id)) rows.push(this.stats[id]);
      }
      rows.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        if (b.kills !== a.kills) return b.kills - a.kills;
        return a.deaths - b.deaths;
      });
      return rows;
    },

    mvp: function () {
      const rows = this.ranking();
      return rows.length ? rows[0] : null;
    },

    playerStats: function () {
      return this.stats.player || null;
    },
  };

  VF.TdmMatch = Tdm;
})(typeof window !== 'undefined' ? window : globalThis);
