/**
 * sd-bomb.js — 爆破模式炸弹全生命周期状态机（Search & Destroy / C4）
 *
 * 这是爆破模式的核心对象：一个纯粹、由配置驱动、发事件的状态机。它只管理炸弹
 * 自身的状态与计时（携带 / 掉落 / 安装 / 引爆 / 拆除），不直接操作场景、玩家或
 * 胜负——那些交给回合管理器（sd-match.js）通过订阅事件来完成。
 *
 * 参与者以 id 字符串表示（'player' / 'ai-*' / 'remote'），与 tdm-match.js 一致，
 * 因此状态机对“谁在携带/安装/拆除”保持无关性，可被玩家与 AI 复用。
 *
 * 状态（对应文档 2.1）：
 *   UNASSIGNED → CARRIED ⇄ DROPPED
 *   CARRIED → PLANTING → PLANTED → DEFUSING → DEFUSED
 *                          PLANTED → DETONATED
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});

  const S = {
    UNASSIGNED: 'unassigned',
    CARRIED: 'carried',
    DROPPED: 'dropped',
    PLANTING: 'planting',
    PLANTED: 'planted',
    DEFUSING: 'defusing',
    DEFUSED: 'defused',
    DETONATED: 'detonated',
  };

  /** Single read point for every bomb-rule value (mirrors GameModes.param). */
  function cfg() {
    const p = VF.GameModes ? VF.GameModes.getParams('demo') : {};
    const num = function (k, d) {
      return p[k] != null ? p[k] : d;
    };
    return {
      plantTime: num('plantTime', 4.0),
      bombTimer: num('bombTimer', 45),
      defuseTime: num('defuseTime', 7.0),
      defuseTimeWithKit: num('defuseTimeWithKit', 3.5),
      progressRetain: !!p.progressRetain,
      defuseRetain: !!p.defuseRetain,
      retainDuration: num('retainDuration', 5.0),
      pickupDelay: num('pickupDelay', 0.3),
      dropTimeout: num('dropTimeout', 15.0),
      defuseTieWinsDefender: p.defuseTieWinsDefender !== false,
    };
  }

  /** Clone a THREE.Vector3-like position without assuming THREE is loaded. */
  function clonePos(pos) {
    if (!pos) return null;
    if (typeof pos.clone === 'function') return pos.clone();
    return { x: pos.x, y: pos.y, z: pos.z };
  }

  const Bomb = {
    S: S,
    config: cfg,

    /* ─────────────────────────── live state ─────────────────────────── */
    state: S.UNASSIGNED,
    carrierId: null,
    dropPos: null,
    dropTime: 0,
    planterId: null,
    site: null,
    plantPos: null,
    hidden: false,
    plantProgress: 0,
    defuserId: null,
    defuseWithKit: false,
    defuseProgress: 0,
    remaining: 0,
    clock: 0,
    netCarrierPos: null,

    _retainLeft: 0,
    _defuseRetainLeft: 0,
    _listeners: null,

    /* ───────────────────────────── events ──────────────────────────── */

    /**
     * Subscribe to a lifecycle event. Events (payload):
     *   assigned{carrierId} dropped{pos} pickedup{carrierId}
     *   plantstart{planterId,site} plantprogress{progress} plantcancel{reason}
     *   planted{site,pos,hidden}
     *   defusestart{defuserId} defuseprogress{progress,remaining} defusecancel{reason}
     *   tick{remaining} defused{} detonated{}
     */
    on: function (evt, fn) {
      if (!this._listeners) this._listeners = {};
      (this._listeners[evt] || (this._listeners[evt] = [])).push(fn);
      return this;
    },

    clearListeners: function () {
      this._listeners = {};
    },

    _emit: function (evt, data) {
      const list = this._listeners && this._listeners[evt];
      if (!list) return;
      for (let i = 0; i < list.length; i++) {
        try {
          list[i](data || {});
        } catch (e) {
          /* a listener must never break the state machine */
        }
      }
    },

    /* ─────────────────────────── lifecycle ─────────────────────────── */

    /** Fresh bomb at round start; keeps listeners so subscribers persist. */
    reset: function () {
      this.state = S.UNASSIGNED;
      this.carrierId = null;
      this.dropPos = null;
      this.dropTime = 0;
      this.planterId = null;
      this.site = null;
      this.plantPos = null;
      this.hidden = false;
      this.plantProgress = 0;
      this.defuserId = null;
      this.defuseWithKit = false;
      this.defuseProgress = 0;
      this.remaining = 0;
      this.clock = 0;
      this._retainLeft = 0;
      this._defuseRetainLeft = 0;
      return this;
    },

    is: function (s) {
      return this.state === s;
    },

    /** True once the round is decided by the bomb (planted resolved). */
    isResolved: function () {
      return this.state === S.DEFUSED || this.state === S.DETONATED;
    },

    /* ──────────────────── carry / drop / pickup (Part 3) ────────────── */

    /** Round start: hand the bomb to the chosen carrier. */
    assign: function (carrierId) {
      if (this.state !== S.UNASSIGNED) return false;
      this.state = S.CARRIED;
      this.carrierId = carrierId;
      this.dropPos = null;
      this._emit('assigned', { carrierId: carrierId });
      return true;
    },

    /**
     * Carrier died (or planting was interrupted by death): bomb hits the ground.
     * If a plant was in progress it is interrupted (progress reset — a death is
     * never "retained"). See 5.4.
     */
    drop: function (pos) {
      if (this.state !== S.CARRIED && this.state !== S.PLANTING) return false;
      if (this.state === S.PLANTING) {
        this.plantProgress = 0;
        this._retainLeft = 0;
      }
      this.state = S.DROPPED;
      this.carrierId = null;
      this.planterId = null;
      this.dropPos = clonePos(pos);
      this.dropTime = this.clock;
      this._emit('dropped', { pos: this.dropPos });
      return true;
    },

    /** pickup_delay gate (3.4): blocks same-instant re-grab after a death. */
    canPickup: function () {
      return this.state === S.DROPPED && this.clock - this.dropTime >= cfg().pickupDelay;
    },

    pickup: function (carrierId) {
      if (!this.canPickup()) return false;
      this.state = S.CARRIED;
      this.carrierId = carrierId;
      this.dropPos = null;
      this._emit('pickedup', { carrierId: carrierId });
      return true;
    },

    /** Force the dropped bomb to a reachable point (3.3 卡点兜底). */
    relocate: function (pos) {
      if (this.state !== S.DROPPED) return false;
      this.dropPos = clonePos(pos);
      this.dropTime = this.clock;
      this._emit('dropped', { pos: this.dropPos, relocated: true });
      return true;
    },

    /* ───────────────────────── plant (Part 5) ──────────────────────── */

    /**
     * Begin planting. `opts.hidden` selects the hidden anchor (4.4 暗装);
     * `opts.pos` is the final anchor world position.
     */
    beginPlant: function (planterId, site, opts) {
      if (this.state !== S.CARRIED || this.carrierId !== planterId) return false;
      const c = cfg();
      this.state = S.PLANTING;
      this.planterId = planterId;
      this.site = site;
      this.hidden = !!(opts && opts.hidden);
      this.plantPos = opts && opts.pos ? clonePos(opts.pos) : null;
      if (!(c.progressRetain && this._retainLeft > 0)) this.plantProgress = 0;
      this._retainLeft = 0;
      this._emit('plantstart', { planterId: planterId, site: site });
      return true;
    },

    /** Interrupt planting (release / forced move / left zone). Death → drop(). */
    cancelPlant: function (reason) {
      if (this.state !== S.PLANTING) return false;
      const c = cfg();
      this.state = S.CARRIED;
      if (c.progressRetain) this._retainLeft = c.retainDuration;
      else this.plantProgress = 0;
      this._emit('plantcancel', { reason: reason || 'release' });
      return true;
    },

    /* ──────────────────────── defuse (Part 6) ───────────────────────── */

    beginDefuse: function (defuserId, withKit) {
      if (this.state !== S.PLANTED) return false;
      const c = cfg();
      this.state = S.DEFUSING;
      this.defuserId = defuserId;
      this.defuseWithKit = !!withKit;
      if (!(c.defuseRetain && this._defuseRetainLeft > 0)) this.defuseProgress = 0;
      this._defuseRetainLeft = 0;
      this._emit('defusestart', { defuserId: defuserId });
      return true;
    },

    /** Interrupt defusing — note the detonation clock does NOT stop (6.5). */
    cancelDefuse: function (reason) {
      if (this.state !== S.DEFUSING) return false;
      const c = cfg();
      this.state = S.PLANTED;
      if (c.defuseRetain) this._defuseRetainLeft = c.retainDuration;
      else this.defuseProgress = 0;
      this._emit('defusecancel', { reason: reason || 'release' });
      return true;
    },

    /* ────────────────────────── per-frame tick ─────────────────────── */

    update: function (dt) {
      if (!(dt > 0)) return;
      this.clock += dt;
      const c = cfg();

      // Retained-progress decay while idle (5.4 / 6.5 休闲模式续接窗口)
      if (this.state === S.CARRIED && this._retainLeft > 0) {
        this._retainLeft = Math.max(0, this._retainLeft - dt);
        if (this._retainLeft <= 0) this.plantProgress = 0;
      }
      if (this.state === S.PLANTED && this._defuseRetainLeft > 0) {
        this._defuseRetainLeft = Math.max(0, this._defuseRetainLeft - dt);
        if (this._defuseRetainLeft <= 0) this.defuseProgress = 0;
      }

      if (this.state === S.PLANTING) {
        this.plantProgress += dt / Math.max(0.01, c.plantTime);
        this._emit('plantprogress', { progress: Math.min(1, this.plantProgress) });
        if (this.plantProgress >= 1) this._completePlant();
        return;
      }

      if (this.state === S.PLANTED) {
        this.remaining = Math.max(0, this.remaining - dt);
        this._emit('tick', { remaining: this.remaining });
        if (this.remaining <= 0) this._detonate();
        return;
      }

      if (this.state === S.DEFUSING) {
        // The countdown keeps ticking through a defuse — this is the 6.3 race.
        this.remaining = Math.max(0, this.remaining - dt);
        const dtime = this.defuseWithKit ? c.defuseTimeWithKit : c.defuseTime;
        this.defuseProgress += dt / Math.max(0.01, dtime);
        const defuseDone = this.defuseProgress >= 1;
        const boomDone = this.remaining <= 0;
        this._emit('defuseprogress', {
          progress: Math.min(1, this.defuseProgress),
          remaining: this.remaining,
        });
        if (defuseDone && boomDone) {
          // 6.6 tie rule: defuse-completes-same-frame favours the defender.
          if (c.defuseTieWinsDefender) this._completeDefuse();
          else this._detonate();
        } else if (defuseDone) {
          this._completeDefuse();
        } else if (boomDone) {
          this._detonate();
        }
        return;
      }

      if (this.state === S.DROPPED) {
        const to = c.dropTimeout;
        if (to > 0 && this.clock - this.dropTime >= to) {
          // 防卡局：掉落太久无人拾取 → 通知外层把炸弹移到可达点（3.3 卡点兜底）。
          this._emit('droptimeout', { pos: this.dropPos });
          this.dropTime = this.clock;
        }
        return;
      }
    },

    /* ───────────────────────── terminal transitions ─────────────────── */

    _completePlant: function () {
      this.state = S.PLANTED;
      this.plantProgress = 1;
      this.remaining = cfg().bombTimer;
      // Planting is done: the carrier no longer "holds" the bomb.
      this.planterId = null;
      this.carrierId = null;
      this._emit('planted', { site: this.site, pos: this.plantPos, hidden: this.hidden });
    },

    _detonate: function () {
      if (this.isResolved()) return;
      this.state = S.DETONATED;
      this.remaining = 0;
      this._emit('detonated', {});
    },

    _completeDefuse: function () {
      if (this.isResolved()) return;
      this.state = S.DEFUSED;
      this.defuseProgress = 1;
      this._emit('defused', {});
    },

    /* ──────────────────────────── queries ──────────────────────────── */

    /** Read-only view for UI / networking. */
    snapshot: function () {
      return {
        state: this.state,
        carrierId: this.carrierId,
        dropPos: this.dropPos,
        planterId: this.planterId,
        site: this.site,
        plantPos: this.plantPos,
        hidden: this.hidden,
        plantProgress: Math.min(1, this.plantProgress),
        defuserId: this.defuserId,
        defuseWithKit: this.defuseWithKit,
        defuseProgress: Math.min(1, this.defuseProgress),
        remaining: this.remaining,
      };
    },

    /**
     * Guest-side: overwrite live state from a host snapshot (no transitions).
     * carrierPos is the host-resolved world position of the carrier so the guest
     * can render a carried/planting bomb without owning the carrier's identity.
     */
    mirror: function (snap) {
      if (!snap) return;
      this.state = snap.state;
      this.carrierId = snap.carrierId;
      this.dropPos = snap.dropPos;
      this.planterId = snap.planterId;
      this.site = snap.site;
      this.plantPos = snap.plantPos;
      this.hidden = !!snap.hidden;
      this.plantProgress = snap.plantProgress || 0;
      this.defuserId = snap.defuserId;
      this.defuseWithKit = !!snap.defuseWithKit;
      this.defuseProgress = snap.defuseProgress || 0;
      this.remaining = snap.remaining || 0;
      this.netCarrierPos = snap.carrierPos || null;
    },

    /** Is there still enough time on the clock to finish a defuse? (6.3) */
    canFinishDefuse: function (withKit) {
      if (this.state !== S.PLANTED && this.state !== S.DEFUSING) return false;
      const c = cfg();
      const need = (withKit ? c.defuseTimeWithKit : c.defuseTime) *
        (this.state === S.DEFUSING ? 1 - Math.min(1, this.defuseProgress) : 1);
      return this.remaining >= need;
    },
  };

  VF.SdBomb = Bomb;
})(typeof window !== 'undefined' ? window : globalThis);