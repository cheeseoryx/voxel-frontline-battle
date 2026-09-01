/**
 * net-protocol.js — Versioned conquest messages and deterministic checksums.
 */
(function (global) {
  'use strict';

  const VERSION = 3;

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

  function canonicalVehicles(snapshot) {
    const vehicles =
      snapshot && Array.isArray(snapshot.vehicles)
        ? snapshot.vehicles.slice()
        : [];
    vehicles.sort(function (a, b) {
      return String(a.id).localeCompare(String(b.id));
    });
    const vehicleData = vehicles.map(function (vehicle) {
        const p = vehicle.position || {};
        return [
          vehicle.id || '',
          vehicle.type || '',
          vehicle.team || '',
          Math.round(finite(p.x, 0) * 100),
          Math.round(finite(p.y, 0) * 100),
          Math.round(finite(p.z, 0) * 100),
          Math.round(finite(vehicle.yaw, 0) * 1000),
          Math.round(finite(vehicle.pitch, 0) * 1000),
          Math.round(finite(vehicle.roll, 0) * 1000),
          Math.round(finite(vehicle.speed, 0) * 100),
          Math.round(finite(vehicle.turretYaw, 0) * 1000),
          Math.round(finite(vehicle.turretPitch, 0) * 1000),
          Math.round(
            finite(
              vehicle.aimByRole &&
                vehicle.aimByRole.gunner &&
                vehicle.aimByRole.gunner.yaw,
              0
            ) * 1000
          ),
          Math.round(
            finite(
              vehicle.aimByRole &&
                vehicle.aimByRole.gunner &&
                vehicle.aimByRole.gunner.pitch,
              0
            ) * 1000
          ),
          Math.round(finite(vehicle.hp, 0)),
          vehicle.alive === false ? 0 : 1,
          Math.round(finite(vehicle.respawnTimer, 0) * 10),
          (vehicle.seats || []).map(function (seat) {
            return [seat.index | 0, seat.occupantId || ''];
          }),
          Object.keys(vehicle.weapons || {})
            .sort()
            .map(function (id) {
              const weapon = vehicle.weapons[id] || {};
              return [
                id,
                Math.round(finite(weapon.cooldown, 0) * 100),
                weapon.mag == null ? -1 : weapon.mag | 0,
                weapon.reserve == null ? -1 : weapon.reserve | 0,
                Math.round(finite(weapon.reloadTimer, 0) * 100),
                Math.round(finite(weapon.reserveRegenTimer, 0) * 10),
                Math.round(finite(weapon.heat, 0) * 10),
                weapon.overheated ? 1 : 0,
              ];
            }),
        ];
      });
    const projectiles =
      snapshot && Array.isArray(snapshot.projectiles)
        ? snapshot.projectiles.slice()
        : [];
    projectiles.sort(function (a, b) {
      return String(a.id).localeCompare(String(b.id));
    });
    const projectileData = projectiles.map(function (projectile) {
      const p = projectile.position || {};
      const d = projectile.direction || {};
      return [
        projectile.id || '',
        projectile.vehicleId || '',
        projectile.ownerId || '',
        projectile.team || '',
        projectile.weaponId || '',
        Math.round(finite(projectile.damage, 0) * 10),
        projectile.damageType || '',
        Math.round(finite(p.x, 0) * 100),
        Math.round(finite(p.y, 0) * 100),
        Math.round(finite(p.z, 0) * 100),
        Math.round(finite(d.x, 0) * 1000),
        Math.round(finite(d.y, 0) * 1000),
        Math.round(finite(d.z, 0) * 1000),
        Math.round(finite(projectile.speed, 0) * 100),
        Math.round(finite(projectile.gravity, 0) * 100),
        projectile.guidance || '',
        Math.round(finite(projectile.guidanceRate, 0) * 100),
        projectile.targetVehicleId || '',
        Math.round(
          finite(projectile.targetPoint && projectile.targetPoint.x, 0) * 100
        ),
        Math.round(
          finite(projectile.targetPoint && projectile.targetPoint.y, 0) * 100
        ),
        Math.round(
          finite(projectile.targetPoint && projectile.targetPoint.z, 0) * 100
        ),
        Math.round(finite(projectile.life, 0) * 100),
      ];
    });
    return JSON.stringify([vehicleData, projectileData]);
  }

  function vehicleChecksum(snapshot) {
    return hashString(canonicalVehicles(snapshot || {}));
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
    vehicleChecksum: vehicleChecksum,
    canonicalVehicles: canonicalVehicles,
  };
})(typeof window !== 'undefined' ? window : this);
