/**
 * hitboxes.js — Shared infantry hit spheres (head / torso / limb).
 */
(function (global) {
  'use strict';

  function feelHit() {
    const F = global.VF && global.VF.Feel;
    return (F && F.hitboxes) || {};
  }

  function poseOf(entity) {
    if (!entity) return { crouch: false, prone: false, scale: 1 };
    const prone = !!(entity.prone || entity.proning);
    const crouch = !!(entity.crouching || entity.crouch);
    let scale = entity.radiusScale;
    if (scale == null && entity.type === 'heavy') {
      const H = feelHit();
      scale = H.heavyScale != null ? H.heavyScale : 1.15;
    }
    if (scale == null) scale = 1;
    return { crouch: crouch && !prone, prone: prone, scale: scale };
  }

  function positionOf(entity) {
    if (!entity) return null;
    if (entity.object && entity.object.position) return entity.object.position;
    if (entity.mesh && entity.mesh.position) return entity.mesh.position;
    if (entity.position && entity.position.x != null) return entity.position;
    if (entity.x != null) return entity;
    return null;
  }

  function partHeights(pose) {
    const H = feelHit();
    if (pose && pose.prone) {
      return {
        head: H.proneHeadY != null ? H.proneHeadY : 0.22,
        torso: H.proneTorsoY != null ? H.proneTorsoY : 0.14,
        limb: H.proneLimbY != null ? H.proneLimbY : 0.1,
      };
    }
    if (pose && pose.crouch) {
      return {
        head: H.crouchHeadY != null ? H.crouchHeadY : 0.92,
        torso: H.crouchTorsoY != null ? H.crouchTorsoY : 0.62,
        limb: H.crouchLimbY != null ? H.crouchLimbY : 0.32,
      };
    }
    return {
      head: H.standHeadY != null ? H.standHeadY : 1.62,
      torso: H.standTorsoY != null ? H.standTorsoY : 1.1,
      limb: H.standLimbY != null ? H.standLimbY : 0.55,
    };
  }

  function radii(scale) {
    const H = feelHit();
    const s = scale || 1;
    return {
      head: (H.headR != null ? H.headR : 0.22) * s,
      torso: (H.torsoR != null ? H.torsoR : 0.4) * s,
      limb: (H.limbR != null ? H.limbR : 0.28) * s,
    };
  }

  function partMul(part) {
    const H = feelHit();
    if (part === 'head') return H.headMul != null ? H.headMul : 1.75;
    if (part === 'limb') return H.limbMul != null ? H.limbMul : 0.72;
    return H.torsoMul != null ? H.torsoMul : 1;
  }

  function raySphere(origin, dir, range, cx, cy, cz, radius) {
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    const dx = dir.x;
    const dy = dir.y;
    const dz = dir.z;
    const fx = ox - cx;
    const fy = oy - cy;
    const fz = oz - cz;
    const a = dx * dx + dy * dy + dz * dz;
    if (a < 1e-12) return null;
    const b = 2 * (fx * dx + fy * dy + fz * dz);
    const c = fx * fx + fy * fy + fz * fz - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    let t = (-b - s) / (2 * a);
    if (t < 0) t = (-b + s) / (2 * a);
    if (t < 0 || t > range) return null;
    return t;
  }

  function makePoint(origin, dir, t) {
    const x = origin.x + dir.x * t;
    const y = origin.y + dir.y * t;
    const z = origin.z + dir.z * t;
    if (typeof THREE !== 'undefined' && THREE.Vector3) {
      return new THREE.Vector3(x, y, z);
    }
    return { x: x, y: y, z: z };
  }

  function raycast(entity, origin, dir, range) {
    if (!entity || !origin || !dir) return null;
    if (entity.vehicleId != null) return null;
    if (entity.alive === false || entity.dead) return null;
    const pos = positionOf(entity);
    if (!pos || pos.x == null) return null;
    const maxRange = range != null ? range : 200;
    const pose = poseOf(entity);
    const ys = partHeights(pose);
    const rs = radii(pose.scale);
    const parts = [
      { part: 'head', y: ys.head, r: rs.head },
      { part: 'torso', y: ys.torso, r: rs.torso },
      { part: 'limb', y: ys.limb, r: rs.limb },
    ];
    let best = null;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const t = raySphere(origin, dir, maxRange, pos.x, pos.y + p.y, pos.z, p.r);
      if (t == null) continue;
      if (!best || t < best.dist) {
        best = {
          entity: entity,
          enemy: entity,
          unit: entity,
          part: p.part,
          dist: t,
          point: makePoint(origin, dir, t),
        };
      }
    }
    return best;
  }

  global.VF = global.VF || {};
  global.VF.Hitboxes = {
    raycast: raycast,
    partMul: partMul,
    poseOf: poseOf,
    partHeights: partHeights,
    positionOf: positionOf,
  };
})(typeof window !== 'undefined' ? window : globalThis);
