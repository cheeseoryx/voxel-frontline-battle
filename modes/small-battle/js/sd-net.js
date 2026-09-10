/**
 * sd-net.js — 爆破模式的 PVP 联机同步胶水层（Search & Destroy netcode glue）
 *
 * 单一职责：把「主机权威的炸弹/回合状态」与 VF.Pvp 传输层对接，让访客镜像主机、
 * 并把访客本地的安装/拆除/拾取/丢弃意图转发回主机执行。它不拥有任何规则——规则在
 * sd-bomb / sd-match 里；也不直接碰传输实现——只调用 VF.Pvp 既有的收发通道。
 *
 * 身份约定（沿用 tdm 的 remoteState 语义）：
 *   主机 sim 的参与者 id 命名空间 = { 'player'（主机玩家）, 'remote'（访客玩家）, 'ai-*' }。
 *   从各端「本地人类」的视角看：主机的本地 id 是 'player'，访客的本地 id 是 'remote'。
 * 因此主机在快照里附带 carrierPos（已解析的携带者世界坐标），访客据此渲染，无需在本地
 * 复原携带者身份（AI 名单在两端各自漂移，不能用于定位共享炸弹）。
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});

  function pvp() {
    return VF.Pvp;
  }
  function inPvpPlay() {
    const p = pvp();
    return !!(p && p.phase === 'play' && !p._matchEnded);
  }
  function sdActive() {
    return !!(VF.SdMatch && VF.SdMatch.active);
  }
  function vec(v) {
    return v ? { x: v.x, y: v.y, z: v.z } : null;
  }

  const Net = {
    /* ─────────────────────────── role queries ──────────────────────── */

    active: function () {
      return inPvpPlay() && sdActive();
    },
    isHost: function () {
      const p = pvp();
      return this.active() && !!p && p.mode === 'host';
    },
    isGuest: function () {
      const p = pvp();
      return this.active() && !!p && p.mode === 'guest';
    },

    /* ─────────────────── host → guest: serialize state ─────────────── */

    /** Compact SD payload for the host to piggyback on its HUD broadcast. */
    hostPayload: function () {
      if (!VF.SdBomb || !VF.SdMatch) return null;
      const b = VF.SdBomb.snapshot();
      const cid = VF.SdBomb.carrierId || VF.SdBomb.planterId;
      b.carrierPos = cid ? this._resolvePos(cid) : null;
      return { b: b, m: VF.SdMatch.snapshot() };
    },

    /* ─────────────────── guest: apply host mirror ──────────────────── */

    applyPayload: function (p) {
      if (!p) return;
      if (p.b && VF.SdBomb && VF.SdBomb.mirror) VF.SdBomb.mirror(p.b);
      if (p.m && VF.SdMatch && VF.SdMatch.applyMirror) VF.SdMatch.applyMirror(p.m);
    },

    /* ──────────────── guest → host: forward local intent ───────────── */

    /** Guest asks the host to run a bomb action on the guest's behalf. */
    sendAct: function (act) {
      const p = pvp();
      if (p && typeof p._send === 'function') p._send({ type: 'sdAct', act: act });
    },

    /** Host: run a guest-originated intent against the authoritative bomb. */
    applyAct: function (act) {
      if (!act || !VF.SdBomb) return;
      const b = VF.SdBomb;
      const who = 'remote';
      switch (act.act) {
        case 'plant':
          if (b.is(b.S.CARRIED) && b.carrierId === who && act.site) {
            b.beginPlant(who, act.site, { pos: act.pos });
          }
          break;
        case 'plantCancel':
          if (b.is(b.S.PLANTING) && b.planterId === who) b.cancelPlant('release');
          break;
        case 'defuse':
          if (b.is(b.S.PLANTED)) b.beginDefuse(who, !!act.kit);
          break;
        case 'defuseCancel':
          if (b.is(b.S.DEFUSING) && b.defuserId === who) b.cancelDefuse('release');
          break;
        case 'pickup':
          if (b.is(b.S.DROPPED) && b.canPickup()) b.pickup(who);
          break;
        case 'drop':
          if (
            (b.is(b.S.CARRIED) || b.is(b.S.PLANTING)) &&
            (b.carrierId === who || b.planterId === who)
          ) {
            b.drop(act.pos || this.remotePos() || b.dropPos);
          }
          break;
        default:
          break;
      }
    },

    /* ─────────────── resolve the guest human as a bomb agent ────────── */

    remotePos: function () {
      const p = pvp();
      const s = p && p.remoteState;
      return s ? { x: s.x, y: s.y, z: s.z } : null;
    },
    remoteAgent: function () {
      const p = pvp();
      const s = p && p.remoteState;
      if (!s) return null;
      return { alive: s.alive !== false, pos: { x: s.x, y: s.y, z: s.z }, team: s.team || null };
    },

    /* ─────────────────── host-side agent → world pos ───────────────── */

    _resolvePos: function (id) {
      const g = VF.game;
      if (!id || !g) return null;
      if (id === 'player') {
        const p = g.player;
        return p && p.object ? vec(p.object.position) : null;
      }
      if (id === 'remote') return this.remotePos();
      const ai = g.ai;
      const lists = ai ? [ai.blue, ai.red] : [];
      for (let l = 0; l < lists.length; l++) {
        const list = lists[l];
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          if (list[i] && list[i].id === id) return list[i].mesh ? vec(list[i].mesh.position) : null;
        }
      }
      return null;
    },
  };

  VF.SdNet = Net;
})(typeof window !== 'undefined' ? window : globalThis);