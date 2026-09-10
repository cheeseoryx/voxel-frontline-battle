/**
 * sd-match.js — 爆破模式回合/对局管理器（Search & Destroy round & match state）
 *
 * 职责边界：本模块只管“回合与对局的规则时间轴”——购买/交战/结算阶段、回合钟、
 * 单命制胜负判定（含文档 1.4 的全歼分支）、半场攻守交换、先赢 N 回合的整局胜负。
 * 炸弹本身的状态由 sd-bomb.js 拥有；名单/出生/AI/UI 通过可注入 hooks 解耦，本模块
 * 不直接生成单位，也不直接操作场景，从而保持可单测、职责单一。
 *
 * 阶段（对应文档 1.5 时间轴）：
 *   BUY(购买/准备) → LIVE(交战；安包后由炸弹倒计时接管) → RESULT(结算)
 *   整局在某方达到 roundsToWin 时结束。
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});

  const PHASE = { BUY: 'buy', LIVE: 'live', RESULT: 'result' };

  function paramsOf() {
    return VF.GameModes ? VF.GameModes.getParams('demo') : {};
  }

  const Match = {
    PHASE: PHASE,

    active: false,
    ended: false,
    matchOver: false,
    winner: null,

    phase: PHASE.BUY,
    round: 1,
    roundsPlayed: 0,
    wins: { ally: 0, enemy: 0 },

    attackerTeam: 'ally',
    defenderTeam: 'enemy',

    roundClock: 0,
    resultClock: 0,
    lastResult: null,

    _bombBound: false,

    /**
     * Injection points (glue layers set these; all have safe fallbacks):
     *   aliveCount(team) -> number
     *   setupRound(ctx)          — spawn both single-life rosters, lock spawns
     *   pickCarrier(team) -> id  — choose the bomb carrier (3.1)
     *   onPhase(phase, ctx)
     *   onRoundEnd(result)
     *   onMatchEnd(result)
     */
    hooks: {},

    /* ─────────────────────── param read helpers ────────────────────── */

    _p: function (key, fallback) {
      const p = paramsOf();
      return p[key] != null ? p[key] : fallback;
    },

    /* ─────────────────────────── lifecycle ─────────────────────────── */

    start: function () {
      this.active = true;
      this.ended = false;
      this.matchOver = false;
      this.winner = null;
      this.wins = { ally: 0, enemy: 0 };
      this.round = 1;
      this.roundsPlayed = 0;
      this.lastResult = null;
      this._mirrorRound = this.round;
      this._mirrorEnded = false;
      this._mirrorLast = null;

      const firstAtk = this._p('firstHalfAttacker', 'ally');
      this.attackerTeam = firstAtk === 'enemy' ? 'enemy' : 'ally';
      this.defenderTeam = this.attackerTeam === 'ally' ? 'enemy' : 'ally';

      this._bindBomb();
      this._beginRound();
      return this;
    },

    stop: function () {
      this.active = false;
      this.phase = PHASE.BUY;
      this.matchOver = false;
    },

    isRunning: function () {
      return this.active && !this.matchOver;
    },

    /** Combat/scoring is only live during the交战 phase before resolution. */
    scoringLive: function () {
      return this.active && !this.matchOver && this.phase === PHASE.LIVE;
    },

    /** Currently in a planted-countdown (round timer superseded by bomb). */
    bombActive: function () {
      const b = VF.SdBomb;
      return !!(b && (b.is(b.S.PLANTED) || b.is(b.S.DEFUSING)));
    },

    /* ───────────────────────── bomb event wiring ───────────────────── */

    _bindBomb: function () {
      if (this._bombBound || !VF.SdBomb) return;
      this._bombBound = true;
      const self = this;
      VF.SdBomb.on('planted', function (d) {
        self._onPlanted(d);
      });
      VF.SdBomb.on('defused', function () {
        self._endRound(self.defenderTeam, '炸弹已拆除');
      });
      VF.SdBomb.on('detonated', function () {
        self._endRound(self.attackerTeam, '炸弹已引爆');
      });
    },

    _onPlanted: function (d) {
      if (VF.UI && VF.UI.toast) {
        VF.UI.toast('炸弹已安装于 ' + ((d && d.site) || '') + ' 点');
      }
      if (VF.Audio) VF.Audio.play('confirm');
      // The round timer stops mattering now — update() defers to the bomb clock.
    },

    /* ────────────────────────── round flow ─────────────────────────── */

    _ctx: function () {
      return {
        round: this.round,
        attackerTeam: this.attackerTeam,
        defenderTeam: this.defenderTeam,
      };
    },

    _beginRound: function () {
      this.phase = PHASE.BUY;
      this.roundClock = this._p('buyTime', 15);
      if (VF.SdBomb) VF.SdBomb.reset();

      const ctx = this._ctx();
      if (typeof this.hooks.setupRound === 'function') this.hooks.setupRound(ctx);
      this._assignCarrier();
      if (VF.SdStats && VF.SdStats.beginRound) VF.SdStats.beginRound(ctx);
      if (typeof this.hooks.onPhase === 'function') this.hooks.onPhase(PHASE.BUY, ctx);
      this._sync();
    },

    _assignCarrier: function () {
      if (!VF.SdBomb) return;
      let carrierId = null;
      if (typeof this.hooks.pickCarrier === 'function') {
        carrierId = this.hooks.pickCarrier(this.attackerTeam);
      }
      if (!carrierId) carrierId = this._defaultCarrier();
      if (carrierId) VF.SdBomb.assign(carrierId);
    },

    /** Fallback carrier: the player if they are attacking, else left to glue. */
    _defaultCarrier: function () {
      const g = VF.game;
      const p = g && g.player;
      if (p && (p.team || 'ally') === this.attackerTeam) return 'player';
      return null;
    },

    _startLive: function () {
      this.phase = PHASE.LIVE;
      this.roundClock = this._p('roundTime', 110);
      if (typeof this.hooks.onPhase === 'function') this.hooks.onPhase(PHASE.LIVE, this._ctx());
      if (VF.UI && VF.UI.toast) VF.UI.toast('回合开始');
      if (VF.Audio) VF.Audio.play('confirm');
    },

    _nextRound: function () {
      if (this.matchOver) return;
      // Half-time side swap fires exactly once, after halfSwapAfter rounds.
      if (this.roundsPlayed === this._p('halfSwapAfter', 6)) this._swapSides();
      this.round += 1;
      this._beginRound();
    },

    _swapSides: function () {
      const atk = this.attackerTeam;
      this.attackerTeam = this.defenderTeam;
      this.defenderTeam = atk;
      if (VF.UI && VF.UI.toast) VF.UI.toast('半场交换 · 攻守易位');
    },

    /* ─────────────────────── win-condition engine ──────────────────── */

    _alive: function (team) {
      if (typeof this.hooks.aliveCount === 'function') return this.hooks.aliveCount(team);
      const g = VF.game;
      const ai = g && g.ai;
      let n = ai && ai.aliveCount ? ai.aliveCount(team) : 0;
      const p = g && g.player;
      if (p && p.alive && (p.team || 'ally') === team) n += 1;
      return n;
    },

    /**
     * Evaluate single-round outcomes each frame while交战 (文档 1.3 / 1.4).
     * Bomb-resolved outcomes (defused/detonated) are handled by event, so this
     * only decides the human-attrition and time-expiry paths.
     */
    _evaluate: function () {
      if (this.phase !== PHASE.LIVE) return;
      const b = VF.SdBomb;
      if (!b || b.isResolved()) return;

      const planted = b.is(b.S.PLANTED) || b.is(b.S.DEFUSING);
      if (planted) {
        // 情况2：即便攻方全灭，炸弹仍在倒计时 → 交由 detonate/defuse 事件裁决。
        return;
      }

      const atkAlive = this._alive(this.attackerTeam);
      const defAlive = this._alive(this.defenderTeam);

      if (atkAlive <= 0) {
        // 情况3 / D3：无人能安装 → 守方胜。
        this._endRound(this.defenderTeam, '攻方全灭 · 炸弹未安装');
        return;
      }
      if (defAlive <= 0 && this._p('attackerElimAutoWin', false)) {
        // 情况1（加速配置）：全歼守方即回合胜。
        this._endRound(this.attackerTeam, '守方全灭');
        return;
      }
      if (this.roundClock <= 0) {
        // D2：时限到且炸弹未安装 → 守方胜（含情况1严格版：攻方没在时限内安装）。
        this._endRound(this.defenderTeam, '时间到 · 炸弹未安装');
        return;
      }
    },

    _endRound: function (winnerTeam, reason) {
      if (this.phase === PHASE.RESULT || this.matchOver) return;
      this.phase = PHASE.RESULT;
      this.resultClock = this._p('resultTime', 5);
      this.lastResult = { winner: winnerTeam, reason: reason || '', round: this.round };
      if (winnerTeam === 'ally' || winnerTeam === 'enemy') this.wins[winnerTeam] += 1;
      this.roundsPlayed += 1;

      // 结算个人战绩并评选回合 MVP，附到 lastResult 供 UI / 联机镜像一次性读取。
      if (VF.SdStats && VF.SdStats.endRound) {
        const mvp = VF.SdStats.endRound(this.lastResult);
        if (mvp) this.lastResult.mvp = mvp;
      }

      if (typeof this.hooks.onRoundEnd === 'function') this.hooks.onRoundEnd(this.lastResult);
      if (VF.UI && VF.UI.toast) {
        VF.UI.toast('本回合结束 · ' + (reason || ''));
      }

      const target = this._p('roundsToWin', 7);
      if (this.wins.ally >= target || this.wins.enemy >= target) this._endMatch();
      this._sync();
    },

    _endMatch: function () {
      this.matchOver = true;
      this.ended = true;
      this.winner = this.wins.ally > this.wins.enemy ? 'ally' : 'enemy';
      // 对局计分板常驻更久（文档 3.1）——玩家可手动返回，或到时自动回大厅。
      this.resultClock = this._p('matchEndHold', 20);

      const g = VF.game;
      const myTeam = (g && g.player && g.player.team) || 'ally';
      const won = this.winner === myTeam;

      if (g) g.running = false;
      if (VF.Economy && VF.Economy.grantMatchReward) {
        VF.Economy.grantMatchReward(this._p('reward', 'tdm'), won);
      }
      if (typeof this.hooks.onMatchEnd === 'function') {
        this.hooks.onMatchEnd({ winner: this.winner, wins: this.wins, won: won });
      }
    },

    /* ────────────────────────── per-frame tick ─────────────────────── */

    update: function (dt) {
      if (!this.active || !(dt > 0)) return;

      if (this.matchOver) {
        if (VF.WeaponInspect && VF.WeaponInspect.isActive && VF.WeaponInspect.isActive()) {
          this._sync();
          return;
        }
        // Hold the final summary, then hand back to the lobby (as死斗 does).
        this.resultClock = Math.max(0, this.resultClock - dt);
        this._sync();
        if (this.resultClock <= 0) {
          this.active = false;
          if (VF.game && VF.game.returnFromMatch) VF.game.returnFromMatch();
        }
        return;
      }

      if (this.phase === PHASE.RESULT) {
        this.resultClock = Math.max(0, this.resultClock - dt);
        this._sync();
        if (this.resultClock <= 0) this._nextRound();
        return;
      }

      if (this.phase === PHASE.BUY) {
        this.roundClock = Math.max(0, this.roundClock - dt);
        if (this.roundClock <= 0) this._startLive();
        this._sync();
        return;
      }

      if (this.phase === PHASE.LIVE) {
        // The bomb owns plant progress, the detonation clock and defuse progress.
        if (VF.SdBomb) VF.SdBomb.update(dt);
        // Round timer runs only until the bomb is planted (then it's superseded).
        if (!this.bombActive() && !(VF.SdBomb && VF.SdBomb.isResolved())) {
          this.roundClock = Math.max(0, this.roundClock - dt);
        }
        this._evaluate();
        this._sync();
        return;
      }
    },

    _sync: function () {
      if (VF.SdUi && VF.SdUi.sync) VF.SdUi.sync(this);
    },

    /* ──────────────────────────── queries ──────────────────────────── */

    /** The clock the HUD should show: round timer, or bomb countdown if planted. */
    displayClock: function () {
      if (this.bombActive() && VF.SdBomb) return VF.SdBomb.remaining;
      return this.roundClock;
    },

    snapshot: function () {
      return {
        phase: this.phase,
        round: this.round,
        wins: { ally: this.wins.ally, enemy: this.wins.enemy },
        attackerTeam: this.attackerTeam,
        defenderTeam: this.defenderTeam,
        roundClock: this.roundClock,
        resultClock: this.resultClock,
        clock: this.displayClock(),
        matchOver: this.matchOver,
        winner: this.winner,
        lastResult: this.lastResult,
        // 仅在结算时刻附带个人战绩，避免交战期每帧广播浪费带宽。
        stats:
          (this.phase === PHASE.RESULT || this.matchOver) && VF.SdStats && VF.SdStats.snapshot
            ? VF.SdStats.snapshot()
            : null,
      };
    },

    /**
     * Guest-side: overwrite the round/match timeline from a host snapshot.
     * Runs no rules — it only reflects the authoritative state, re-spawns the
     * local rosters when the host opens a new round (visual parity), and relays
     * the round-end / match-end callbacks so the shared UI reacts once each.
     */
    applyMirror: function (snap) {
      if (!snap) return;
      const newRound = snap.round !== this.round;

      this.active = true;
      this.phase = snap.phase;
      this.round = snap.round;
      this.wins = { ally: snap.wins.ally, enemy: snap.wins.enemy };
      this.attackerTeam = snap.attackerTeam;
      this.defenderTeam = snap.defenderTeam;
      this.roundClock = snap.roundClock;
      this.resultClock = snap.resultClock;
      this.matchOver = snap.matchOver;
      this.winner = snap.winner;
      this.lastResult = snap.lastResult;
      if (snap.stats && VF.SdStats && VF.SdStats.applyMirror) VF.SdStats.applyMirror(snap.stats);

      // Host opened a fresh round → redeploy the guest's local roster so both
      // ends see the same units. The bomb was already mirrored just before this.
      if (newRound && typeof this.hooks.setupRound === 'function') {
        this._mirrorRound = snap.round;
        this.hooks.setupRound(this._ctx());
      }

      // Relay a new round result exactly once (banner / toast on the guest).
      if (
        snap.lastResult &&
        (!this._mirrorLast || this._mirrorLast.round !== snap.lastResult.round) &&
        typeof this.hooks.onRoundEnd === 'function'
      ) {
        this._mirrorLast = snap.lastResult;
        this.hooks.onRoundEnd(snap.lastResult);
      }

      // Relay the final outcome once.
      if (snap.matchOver && !this._mirrorEnded) {
        this._mirrorEnded = true;
        const myTeam = (VF.game && VF.game.player && VF.game.player.team) || 'ally';
        if (typeof this.hooks.onMatchEnd === 'function') {
          this.hooks.onMatchEnd({ winner: this.winner, wins: this.wins, won: this.winner === myTeam });
        }
      }

      this._sync();
    },
  };

  VF.SdMatch = Match;
})(typeof window !== 'undefined' ? window : globalThis);