/**
 * net-protocol.js — Versioned conquest messages and deterministic checksums.
 */
(function (global) {
  'use strict';

  const VERSION = 1;

  function finite(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
  }

  function hashString(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function canonicalSnapshot(snapshot) {
    const flags = (snapshot.flags || []).map(function (flag) {
      return [
        flag.letter,
        flag.owner,
        flag.phase,
        flag.attackingTeam || '',
        Math.round(finite(flag.progress, 0) * 1000),
        flag.contested ? 1 : 0,
      ];
    });
    return JSON.stringify([
      snapshot.matchId || '',
      snapshot.phase || '',
      snapshot.ended ? 1 : 0,
      snapshot.winner || '',
      snapshot.endReason || '',
      Math.round(finite(snapshot.elapsed, 0) * 20),
      snapshot.tickets ? snapshot.tickets.ally | 0 : 0,
      snapshot.tickets ? snapshot.tickets.enemy | 0 : 0,
      Math.round(finite(snapshot.sweep && snapshot.sweep.ally, 0) * 10),
      Math.round(finite(snapshot.sweep && snapshot.sweep.enemy, 0) * 10),
      flags,
    ]);
  }

  function checksum(snapshot) {
    return hashString(canonicalSnapshot(snapshot || {}));
  }

  function envelope(type, payload, opts) {
    opts = opts || {};
    return {
      type: type,
      protocol: VERSION,
      matchId: opts.matchId || (payload && payload.matchId) || '',
      seq: opts.seq | 0,
      ack: opts.ack | 0,
      sentAt: Date.now(),
      payload: payload || {},
    };
  }

  function validateEnvelope(message) {
    if (!message || typeof message !== 'object') return { ok: false, reason: 'not-object' };
    if (message.protocol !== VERSION) return { ok: false, reason: 'protocol-version' };
    if (typeof message.type !== 'string' || !message.type) return { ok: false, reason: 'missing-type' };
    if (!Number.isInteger(message.seq) || message.seq < 0) return { ok: false, reason: 'bad-seq' };
    if (!message.payload || typeof message.payload !== 'object') return { ok: false, reason: 'bad-payload' };
    return { ok: true };
  }

  function validateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return { ok: false, reason: 'not-object' };
    if (!snapshot.matchId || typeof snapshot.matchId !== 'string') return { ok: false, reason: 'match-id' };
    if (!snapshot.tickets || !Array.isArray(snapshot.flags)) return { ok: false, reason: 'shape' };
    const ally = snapshot.tickets.ally;
    const enemy = snapshot.tickets.enemy;
    if (!Number.isInteger(ally) || !Number.isInteger(enemy) || ally < 0 || enemy < 0) {
      return { ok: false, reason: 'tickets' };
    }
    for (let i = 0; i < snapshot.flags.length; i++) {
      const flag = snapshot.flags[i];
      if (!flag || typeof flag.letter !== 'string') return { ok: false, reason: 'flag' };
      if (['ally', 'enemy', 'neutral'].indexOf(flag.owner) < 0) {
        return { ok: false, reason: 'flag-owner' };
      }
    }
    return { ok: true };
  }

  global.VF = global.VF || {};
  global.VF.NetProtocol = {
    VERSION: VERSION,
    envelope: envelope,
    validateEnvelope: validateEnvelope,
    validateSnapshot: validateSnapshot,
    checksum: checksum,
    canonicalSnapshot: canonicalSnapshot,
  };
})(typeof window !== 'undefined' ? window : this);
