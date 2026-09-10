/**
 * sd-stats.js — 爆破模式个人战绩与积分（Search & Destroy per-player stats）
 *
 * 单一职责：只负责“统计与评分”，不碰任何 DOM、不拥有回合规则。渲染由 sd-result.js 读取，
 * 回合/对局时间轴由 sd-match.js 驱动，本模块通过它暴露的 beginRound/endRound 与四个战斗
 * 埋点（registerKill/registerDamage + 炸弹 plant/defuse 事件）累计数据。
 *
 * 席位（seat）设计——核心难点：AI 名单每回合由 ai.applyPlayerTeam() 重建，unit.id/name 会
 * 漂移，无法用作跨回合的稳定身份。于是本模块在开局构建一组“固定席位”（每队 teamSize 个，
 * 玩家占其一），每回合把当轮新生成的 unit.id 映射到席位，从而把整局战绩稳定累计到席位上。
 *
 * 评分（对应文档 2.4 回合MVP / 3.4 全局MVP / 3.3 计分板得分列）：权重集中在 W 常量，便于调参。
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});

  // 固定席位昵称池（AI 用）。玩家席位用真实/占位名。取自类似对局的观感，纯展示。
  const NAME_POOL = [
    '包围', 'Gummy Bear', 'TaTa4NoW92', 'REZonging', 'AmmmA',
    'benbenxiong', 'chenxinzheng', '小轩', '喜欢今天吃火锅', 'Seven',
    'Vortex', 'Nova', '雷霆', '疾风', '老兵', '夜枭', 'Kilo', 'Echo', '影岚', '断线',
  ];

  const W = {
    // 计分板“得分”列（综合积分）
    kill: 100, assist: 25, plant: 50, defuse: 50, firstKill: 25, clutch: 100, roundMvp: 50, dmg: 0.3,
    // 回合 MVP（文档 2.4）
    rKill: 2, rPlant: 2, rDefuse: 2, rClutch: 5, rFirst: 1, rDmg: 0.01,
    // 全局 MVP（文档 3.4）
    mKill: 2, mKda: 1, mAdr: 0.05, mRoundMvp: 6, mClutch: 5, mObj: 3,
  };

  function gm() { return VF.GameModes; }
  function param(k, d) { return gm() && gm().param ? gm().param(k, d) : d; }
  function teamSize() { return Math.max(1, param('teamSize', 5) | 0); }
  function otherTeam(t) { return t === 'ally' ? 'enemy' : 'ally'; }

  function playerTeam() {
    const g = VF.game;
    return (g && g.player && g.player.team) || (g && g.world && g.world._playerTeam) || 'ally';
  }
  function playerName() {
    const g = VF.game;
    return (g && g.player && g.player.name) || '你';
  }
  function pvpActive() {
    return !!(VF.SdNet && VF.SdNet.active && VF.SdNet.active());
  }

  function newSeat(id, name, team, isPlayer) {
    return {
      id: id, name: name, team: team, isPlayer: !!isPlayer,
      level: 1 + (Math.abs(hash(id)) % 30),
      // 整局累计
      kills: 0, deaths: 0, assists: 0, plants: 0, defuses: 0, damage: 0,
      firstKills: 0, clutches: 0, roundMvps: 0, score: 0,
      // 当回合累计（每回合 beginRound 清零）
      rk: 0, rp: 0, rdef: 0, rdmg: 0, rfirst: 0, rclutch: 0,
      alive: true,
    };
  }

  function hash(s) {
    let h = 0;
    s = String(s || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  const Stats = {
    active: false,
    seats: { ally: [], enemy: [] },
    byId: {},
    _map: {}, // 本回合 unitId/'player'/'remote' -> seatId
    _aliveSet: { ally: null, enemy: null },
    _lastStand: { ally: null, enemy: null },
    _firstBlood: false,
    _pendPlanter: null,
    _pendDefuser: null,
    lastRoundMvp: null,
    _bombBound: false,

    /** 只有交战阶段才计分（沿用 TDM 语义，避免购买/结算阶段误记）。*/
    live: function () {
      return !!(this.active && VF.SdMatch && VF.SdMatch.scoringLive && VF.SdMatch.scoringLive());
    },

    /* ─────────────────────────── lifecycle ─────────────────────────── */

    start: function () {
      this.active = true;
      this.byId = {};
      this.lastRoundMvp = null;
      this._firstBlood = false;
      this._pendPlanter = null;
      this._pendDefuser = null;

      const pt = playerTeam();
      const n = teamSize();
      const pool = shuffle(NAME_POOL);
      let pi = 0;
      const buildTeam = (team) => {
        const arr = [];
        for (let i = 0; i < n; i++) {
          let seat;
          if (i === 0 && team === pt) {
            seat = newSeat('player', playerName(), team, true);
          } else {
            const name = pi < pool.length ? pool[pi++] : (team === 'ally' ? '蓝' : '红') + i;
            seat = newSeat(team + '-' + i, name, team, false);
          }
          arr.push(seat);
          this.byId[seat.id] = seat;
        }
        return arr;
      };
      this.seats = { ally: buildTeam('ally'), enemy: buildTeam('enemy') };
      this._bindBomb();
      return this;
    },

    stop: function () {
      this.active = false;
    },

    /** 每回合开始：清空当回合累计，并把当轮新生成的单位映射到稳定席位。*/
    beginRound: function () {
      if (!this.active) return;
      const clear = (arr) => {
        for (let i = 0; i < arr.length; i++) {
          const s = arr[i];
          s.rk = s.rp = s.rdef = s.rdmg = s.rfirst = s.rclutch = 0;
          s.alive = true;
        }
      };
      clear(this.seats.ally);
      clear(this.seats.enemy);
      this._firstBlood = false;
      this._lastStand = { ally: null, enemy: null };
      this._map = {};
      this._aliveSet = { ally: new Set(), enemy: new Set() };

      const g = VF.game;
      const ai = g && g.ai;
      const pt = playerTeam();
      const remoteTeam = pvpActive() ? otherTeam(pt) : null;

      const mapTeam = (team, list) => {
        const seats = this.seats[team];
        let si = 0;
        if (team === pt && seats[0] && seats[0].isPlayer) {
          this._map['player'] = 'player';
          this._aliveSet[team].add('player');
          si = 1;
        } else if (team === remoteTeam && seats[0]) {
          // PVP：对面席位 0 代表访客人类（best-effort，AI 顺延占据其余席位）。
          this._map['remote'] = seats[0].id;
          this._aliveSet[team].add(seats[0].id);
          si = 1;
        }
        const units = list || [];
        for (let i = 0; i < units.length && si < seats.length; i++) {
          const u = units[i];
          if (!u || !u.id) continue;
          this._map[u.id] = seats[si].id;
          this._aliveSet[team].add(seats[si].id);
          si++;
        }
      };
      mapTeam('ally', ai && ai.blue);
      mapTeam('enemy', ai && ai.red);
    },

    /** 回合结束：结算残局英雄、评选回合 MVP，返回 MVP 描述给上层展示/同步。*/
    endRound: function (result) {
      if (!this.active) return null;
      const winner = result && result.winner;

      // 残局（1vN）：胜方最后一名幸存者且成为“最后一人”时敌方≥2 → 记残局。
      if (winner && this._lastStand[winner]) {
        const ls = this._lastStand[winner];
        const set = this._aliveSet[winner];
        if (set && set.has(ls.seatId)) {
          const s = this.byId[ls.seatId];
          if (s) {
            s.clutches += 1;
            s.rclutch = ls.enemyAlive;
            this._recompute(s);
          }
        }
      }

      const all = this.seats.ally.concat(this.seats.enemy);
      let best = null;
      let bestScore = -1;
      for (let i = 0; i < all.length; i++) {
        const s = all[i];
        const rs =
          s.rk * W.rKill + s.rp * W.rPlant + s.rdef * W.rDefuse +
          (s.rclutch > 0 ? W.rClutch * s.rclutch : 0) + s.rfirst * W.rFirst + s.rdmg * W.rDmg +
          (winner && s.team === winner ? 0.5 : 0);
        const contributed = s.rk || s.rp || s.rdef || s.rdmg || s.rclutch || s.rfirst;
        if (contributed && rs > bestScore) {
          bestScore = rs;
          best = s;
        }
      }
      if (best) {
        best.roundMvps += 1;
        this._recompute(best);
        this.lastRoundMvp = { id: best.id, name: best.name, team: best.team, score: Math.round(bestScore) };
      } else {
        this.lastRoundMvp = null;
      }
      return this.lastRoundMvp;
    },

    /* ───────────────────────── combat hooks ────────────────────────── */

    registerKill: function (o) {
      if (!this.active || !o) return;
      const vSeat = this._seatOf(o.victim);
      const kSeat = this._seatOf(o.killer);

      if (vSeat) {
        vSeat.deaths += 1;
        vSeat.alive = false;
        const set = this._aliveSet[vSeat.team];
        if (set) set.delete(vSeat.id);
        this._checkLastStand(vSeat.team);
      }
      if (kSeat && vSeat && kSeat !== vSeat && kSeat.team !== vSeat.team) {
        kSeat.kills += 1;
        kSeat.rk += 1;
        if (!this._firstBlood) {
          this._firstBlood = true;
          kSeat.firstKills += 1;
          kSeat.rfirst = 1;
        }
        this._awardAssists(o.victim, kSeat, o.maxHp || 100);
        this._recompute(kSeat);
      }
      this._recompute(vSeat);
      if (o.victim && typeof o.victim === 'object') o.victim._sdDmg = null;
    },

    registerDamage: function (victim, amount, attacker) {
      if (!this.active || !victim || !(amount > 0)) return;
      const aSeat = this._seatOf(attacker);
      if (!aSeat) return;
      const vSeat = this._seatOf(victim);
      if (vSeat && vSeat.team === aSeat.team) return; // 友伤不计入伤害统计
      aSeat.damage += amount;
      aSeat.rdmg += amount;
      if (typeof victim === 'object') {
        if (!victim._sdDmg) victim._sdDmg = {};
        victim._sdDmg[aSeat.id] = (victim._sdDmg[aSeat.id] || 0) + amount;
      }
      this._recompute(aSeat);
    },

    _awardAssists: function (victim, killerSeat, maxHp) {
      if (!victim || typeof victim !== 'object' || !victim._sdDmg) return;
      const thr = param('assistThreshold', 0.4) * (maxHp || 100);
      const led = victim._sdDmg;
      for (const sid in led) {
        if (sid === killerSeat.id) continue;
        if (led[sid] < thr) continue;
        const s = this.byId[sid];
        if (s && s.team === killerSeat.team) {
          s.assists += 1;
          this._recompute(s);
        }
      }
    },

    _checkLastStand: function (team) {
      const set = this._aliveSet[team];
      if (!set || this._lastStand[team]) return;
      if (set.size === 1) {
        const foe = this._aliveSet[otherTeam(team)];
        const enemyAlive = foe ? foe.size : 0;
        if (enemyAlive >= 2) {
          const seatId = set.values().next().value;
          this._lastStand[team] = { seatId: seatId, enemyAlive: enemyAlive };
        }
      }
    },

    /* ───────────────────────── bomb objectives ─────────────────────── */

    _bindBomb: function () {
      if (this._bombBound || !VF.SdBomb) return;
      this._bombBound = true;
      const self = this;
      // planted/defused 事件不再带执行者 id（emit 前已清空），故在 start 时记住执行者。
      VF.SdBomb.on('plantstart', function (d) { self._pendPlanter = d && d.planterId; });
      VF.SdBomb.on('planted', function () {
        const s = self._seatOf(self._pendPlanter);
        if (s) { s.plants += 1; s.rp += 1; self._recompute(s); }
        self._pendPlanter = null;
      });
      VF.SdBomb.on('defusestart', function (d) { self._pendDefuser = d && d.defuserId; });
      VF.SdBomb.on('defused', function () {
        const s = self._seatOf(self._pendDefuser);
        if (s) { s.defuses += 1; s.rdef += 1; self._recompute(s); }
        self._pendDefuser = null;
      });
    },

    /* ────────────────────────── seat resolve ───────────────────────── */

    _seatOf: function (actor) {
      if (!actor) return null;
      if (actor === 'player') return this.byId['player'] || null;
      if (actor === 'remote') {
        const sid = this._map['remote'];
        return sid ? this.byId[sid] || null : null;
      }
      if (typeof actor === 'string') {
        const sid = this._map[actor];
        return sid ? this.byId[sid] || null : null;
      }
      const g = VF.game;
      if (actor.isPlayer || (g && actor === g.player)) return this.byId['player'] || null;
      if (actor.id) {
        const sid = this._map[actor.id];
        return sid ? this.byId[sid] || null : null;
      }
      return null;
    },

    _recompute: function (s) {
      if (!s) return;
      s.score = Math.round(
        s.kills * W.kill + s.assists * W.assist + s.plants * W.plant + s.defuses * W.defuse +
        s.firstKills * W.firstKill + s.clutches * W.clutch + s.roundMvps * W.roundMvp +
        s.damage * W.dmg
      );
    },

    /* ──────────────────────────── queries ──────────────────────────── */

    /** 某队按“得分→击杀→死亡”排序的行（用于计分板）。*/
    teamRows: function (team) {
      const arr = (this.seats[team] || []).slice();
      arr.sort(function (a, b) {
        return b.score - a.score || b.kills - a.kills || a.deaths - b.deaths;
      });
      return arr;
    },

    aliveCount: function (team) {
      const set = this._aliveSet[team];
      return set ? set.size : (this.seats[team] || []).length;
    },

    teamTotal: function (team) {
      return (this.seats[team] || []).length;
    },

    /** 全局 MVP（文档 3.4）：综合表现最佳者。*/
    matchMvp: function () {
      const all = this.seats.ally.concat(this.seats.enemy);
      const rounds = Math.max(1, (VF.SdMatch && VF.SdMatch.roundsPlayed) || 1);
      let best = null;
      let bs = -1;
      for (let i = 0; i < all.length; i++) {
        const s = all[i];
        const kda = (s.kills + s.assists * 0.5) / Math.max(1, s.deaths);
        const adr = s.damage / rounds;
        const m =
          s.kills * W.mKill + kda * W.mKda + adr * W.mAdr +
          s.roundMvps * W.mRoundMvp + s.clutches * W.mClutch +
          (s.plants + s.defuses) * W.mObj;
        if (m > bs) { bs = m; best = s; }
      }
      return best;
    },

    /* ─────────────────────── net mirror (PVP) ──────────────────────── */

    /** 精简快照（仅结算需要的展示字段），由主机在回合/对局结束时下发给访客。*/
    snapshot: function () {
      const pack = (arr) => arr.map(function (s) {
        return {
          id: s.id, name: s.name, team: s.team, isPlayer: s.isPlayer, level: s.level,
          kills: s.kills, deaths: s.deaths, assists: s.assists,
          plants: s.plants, defuses: s.defuses, score: s.score,
        };
      });
      return {
        ally: pack(this.seats.ally),
        enemy: pack(this.seats.enemy),
        roundMvp: this.lastRoundMvp,
      };
    },

    applyMirror: function (snap) {
      if (!snap) return;
      this.active = true;
      this.byId = {};
      const unpack = (rows) => (rows || []).map((r) => {
        const s = newSeat(r.id, r.name, r.team, r.isPlayer);
        s.level = r.level || s.level;
        s.kills = r.kills; s.deaths = r.deaths; s.assists = r.assists;
        s.plants = r.plants; s.defuses = r.defuses; s.score = r.score;
        this.byId[s.id] = s;
        return s;
      });
      this.seats = { ally: unpack(snap.ally), enemy: unpack(snap.enemy) };
      this.lastRoundMvp = snap.roundMvp || null;
    },
  };

  VF.SdStats = Stats;
})(typeof window !== 'undefined' ? window : globalThis);