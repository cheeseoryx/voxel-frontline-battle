/**
 * melee.js — Combat knife (hotbar 6). Ported from voxel-frontline.
 *
 * Swing: windup → active hit window → recovery.
 * Hit: range + forward cone + voxel/smoke LOS. No core damage.
 * Backstab (behind 120°) = instant kill. Frontal = two-hit vs full player HP.
 * Short lunge if a target sits just outside swing range.
 */
(function (global) {
  'use strict';

  const CHEST_LIFT = 1.2;
  const ATTACKER_LIFT = 1.0;
  const BACKSTAB_DOT = -0.5; // cos(120°)
  const LUNGE_SPEED = 10;
  const _losFrom = new THREE.Vector3();
  const _losTo = new THREE.Vector3();
  const _losDir = new THREE.Vector3();
  const _hitPt = new THREE.Vector3();

  function available() {
    return true;
  }

  function friendlyFireOn() {
    const GM = global.VF && global.VF.GameModes;
    return !!(GM && GM.param && GM.param('friendlyFire', false));
  }

  function knifeDef() {
    const W = global.VF && global.VF.WEAPONS;
    return (W && W.knife) || null;
  }

  function isKnife(weapons) {
    return !!(weapons && weapons.current === 'knife');
  }

  function _state(weapons) {
    if (!weapons._melee) {
      weapons._melee = {
        phase: 'idle',
        t: 0,
        hit: false,
        lunge: null,
        lungeLeft: 0,
        lungeCd: 0,
      };
    }
    return weapons._melee;
  }

  function cancel(weapons) {
    if (!weapons) return;
    const s = _state(weapons);
    s.phase = 'idle';
    s.t = 0;
    s.hit = false;
    s.lunge = null;
    s.lungeLeft = 0;
  }

  function voxelBlocked(world, from, to) {
    if (!world || !from || !to) return false;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(dist > 0.08)) return false;
    const dirx = dx / dist;
    const diry = dy / dist;
    const dirz = dz / dist;
    let x = Math.floor(from.x);
    let y = Math.floor(from.y);
    let z = Math.floor(from.z);
    const stepX = dirx > 0 ? 1 : dirx < 0 ? -1 : 0;
    const stepY = diry > 0 ? 1 : diry < 0 ? -1 : 0;
    const stepZ = dirz > 0 ? 1 : dirz < 0 ? -1 : 0;
    const tDeltaX = stepX !== 0 ? Math.abs(1 / dirx) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / diry) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dirz) : Infinity;
    let tMaxX =
      stepX > 0 ? (x + 1 - from.x) * tDeltaX : stepX < 0 ? (from.x - x) * tDeltaX : Infinity;
    let tMaxY =
      stepY > 0 ? (y + 1 - from.y) * tDeltaY : stepY < 0 ? (from.y - y) * tDeltaY : Infinity;
    let tMaxZ =
      stepZ > 0 ? (z + 1 - from.z) * tDeltaZ : stepZ < 0 ? (from.z - z) * tDeltaZ : Infinity;
    const limit = dist - 0.12;
    let t = 0;
    for (let i = 0; i < 48 && t < limit; i++) {
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        t = tMaxX;
        tMaxX += tDeltaX;
        x += stepX;
      } else if (tMaxY < tMaxZ) {
        t = tMaxY;
        tMaxY += tDeltaY;
        y += stepY;
      } else {
        t = tMaxZ;
        tMaxZ += tDeltaZ;
        z += stepZ;
      }
      if (t >= limit) break;
      if (world._isSolid && world._isSolid(x, y, z)) return true;
    }
    return false;
  }

  function losBlocked(weapons, from, to) {
    if (voxelBlocked(weapons.world, from, to)) return true;
    const dist = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    if (dist > 0.05 && weapons.world && weapons.world.raycastDoors) {
      _losFrom.set(from.x, from.y, from.z);
      _losTo.set(to.x, to.y, to.z);
      _losDir.subVectors(_losTo, _losFrom).normalize();
      const hit = weapons.world.raycastDoors(_losFrom, _losDir, dist);
      if (hit && hit.dist != null && hit.dist < dist - 0.1) return true;
    }
    if (global.VF.Throwables && global.VF.Throwables.occludesRay) {
      if (global.VF.Throwables.occludesRay(from, to)) return true;
    }
    return false;
  }

  function isBackstab(attackerPos, targetPos, targetYaw) {
    const dx = attackerPos.x - targetPos.x;
    const dz = attackerPos.z - targetPos.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.05) return false;
    const fx = -Math.sin(targetYaw);
    const fz = -Math.cos(targetYaw);
    return (fx * dx + fz * dz) / len <= BACKSTAB_DOT;
  }

  function collectTargets(player) {
    const out = [];
    const ai = global.VF.AI;
    function addUnit(u, kind) {
      if (!u || !u.alive || !u.mesh) return;
      out.push({
        kind: kind,
        unit: u,
        pos: u.mesh.position,
        yaw: u.mesh.rotation.y,
      });
    }
    if (ai) {
      const enemies = ai.enemies || [];
      for (let i = 0; i < enemies.length; i++) addUnit(enemies[i], 'enemy');
      if (friendlyFireOn()) {
        const allies = ai.allies || [];
        for (let i = 0; i < allies.length; i++) addUnit(allies[i], 'ally');
      }
    }
    const pvp = global.VF.Pvp;
    if (pvp && pvp.phase === 'play' && pvp.remoteState && pvp.remoteState.alive !== false) {
      const st = pvp.remoteState;
      const mesh = pvp.remoteAvatar && pvp.remoteAvatar.mesh;
      const pos = mesh && mesh.position ? mesh.position : st;
      if (pos && pos.x != null) {
        out.push({
          kind: 'remote',
          unit: null,
          pos: pos,
          yaw: mesh && mesh.rotation ? mesh.rotation.y : st.yaw || 0,
        });
      }
    }
    return out;
  }

  function pickTarget(weapons, player, maxRange, needLos) {
    const def = knifeDef();
    const halfAng = (def && def.attackAngle) || Math.PI / 3;
    const minDot = Math.cos(halfAng);
    const origin = player.getEyePosition();
    const look = player.getLookDirection();
    const feet = player.object.position;
    const ax = feet.x;
    const ay = feet.y + ATTACKER_LIFT;
    const az = feet.z;
    const list = collectTargets(player);
    let best = null;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const tx = c.pos.x;
      const ty = c.pos.y + CHEST_LIFT;
      const tz = c.pos.z;
      const dx = tx - ax;
      const dy = ty - ay;
      const dz = tz - az;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > maxRange || dist < 0.12) continue;
      const lx = tx - origin.x;
      const ly = ty - origin.y;
      const lz = tz - origin.z;
      const llen = Math.sqrt(lx * lx + ly * ly + lz * lz);
      if (llen < 0.08) continue;
      const lookDot = (look.x * lx + look.y * ly + look.z * lz) / llen;
      if (lookDot < minDot) continue;
      if (needLos && losBlocked(weapons, origin, { x: tx, y: ty, z: tz })) continue;
      if (
        !best ||
        dist < best.dist - 0.08 ||
        (Math.abs(dist - best.dist) <= 0.08 && lookDot > best.lookDot)
      ) {
        best = { cand: c, dist: dist, lookDot: lookDot };
      }
    }
    return best;
  }

  function ensureKnifeVm(player) {
    if (!player || !player.viewModel) return null;
    const classId = player.classId || (player.viewModel.userData && player.viewModel.userData.classId);
    if (
      player._knifeNode &&
      player._knifeNode.parent === player.viewModel &&
      player._knifeNode.userData.classId === classId
    ) {
      return player._knifeNode;
    }
    if (player._knifeNode && player._knifeNode.parent) {
      player._knifeNode.parent.remove(player._knifeNode);
    }
    let root = null;
    if (global.VF.Soldier && global.VF.Soldier.createKnifeViewModel) {
      root = global.VF.Soldier.createKnifeViewModel(classId);
    }
    if (!root) return null;
    player.viewModel.add(root);
    player._knifeNode = root;
    return root;
  }

  function restyle(player, id) {
    if (!player) return;
    if (global.VF.Throwables && global.VF.Throwables.busy && global.VF.Throwables.busy()) return;
    const knife = ensureKnifeVm(player);
    const on = id === 'knife';
    if (player.gunNode) player.gunNode.visible = !on;
    if (player.rightArm) player.rightArm.visible = !on;
    if (player.leftArm) player.leftArm.visible = !on;
    if (player._weaponViewModel && player._weaponViewModel !== player.viewModel) {
      player._weaponViewModel.visible = !on && player._heldMode !== 'build';
    }
    if (knife) knife.visible = !!on;
    if (player.muzzleFlash) player.muzzleFlash.visible = !on;
  }

  function _smooth(t) {
    t = Math.max(0, Math.min(1, t));
    return t * t * (3 - 2 * t);
  }

  function applySlashPose(player, s, def) {
    const knife = player && player._knifeNode;
    if (!knife || !knife.visible) return;
    const slashNode = knife.userData.slash || knife;
    const rest = knife.userData.rest;
    if (!rest) return;
    let cock = 0;
    let thrust = 0;
    if (s.phase === 'windup') {
      cock = _smooth(s.t / Math.max(0.001, def.windupTime));
    } else if (s.phase === 'active') {
      thrust = _smooth(s.t / 0.055);
    } else if (s.phase === 'recovery') {
      thrust = 1 - _smooth(s.t / Math.max(0.001, def.recoveryTime));
    }
    slashNode.position.x = rest.x + cock * 0.06 - thrust * 0.2;
    slashNode.position.y = rest.y - cock * 0.05 + thrust * 0.14;
    slashNode.position.z = rest.z + cock * 0.18 - thrust * 0.52;
    slashNode.rotation.x = rest.rx + cock * 0.22 - thrust * 0.28;
    slashNode.rotation.y = rest.ry - cock * 0.08 - thrust * 0.32;
    slashNode.rotation.z = rest.rz + cock * 0.1 - thrust * 0.45;
  }

  function applyLunge(weapons, player, dt) {
    const s = _state(weapons);
    if (s.lungeCd > 0) s.lungeCd -= dt;
    if (!(s.lungeLeft > 0) || !s.lunge) return;
    if (!player.onGround) {
      s.lunge = null;
      s.lungeLeft = 0;
      return;
    }
    const target = s.lunge;
    if (target.kind === 'enemy' || target.kind === 'ally') {
      if (!target.unit || !target.unit.alive) {
        s.lunge = null;
        s.lungeLeft = 0;
        return;
      }
    }
    if (target.kind === 'remote') {
      const st = global.VF.Pvp && global.VF.Pvp.remoteState;
      if (!st || st.alive === false) {
        s.lunge = null;
        s.lungeLeft = 0;
        return;
      }
    }
    const pos = player.object.position;
    const tx = target.pos.x - pos.x;
    const tz = target.pos.z - pos.z;
    const len = Math.hypot(tx, tz);
    const def = knifeDef();
    const stopAt = (def && def.attackRange) || 2;
    if (len <= stopAt * 0.92) {
      s.lunge = null;
      s.lungeLeft = 0;
      return;
    }
    const step = Math.min(s.lungeLeft, LUNGE_SPEED * dt);
    const inv = 1 / len;
    if (player._moveAxisWithStep) {
      player._moveAxisWithStep('x', tx * inv * step);
      player._moveAxisWithStep('z', tz * inv * step);
    } else {
      pos.x += tx * inv * step;
      pos.z += tz * inv * step;
    }
    s.lungeLeft -= step;
    if (s.lungeLeft <= 0.001) {
      s.lunge = null;
      s.lungeLeft = 0;
    }
  }

  function resolveHit(weapons, player, picked) {
    const def = knifeDef();
    const cand = picked.cand;
    const attackerPos = player.object.position;
    const backstab = isBackstab(attackerPos, cand.pos, cand.yaw);
    const dmg = backstab ? def.backstabDamage : def.damage;
    const dir = player.getLookDirection();
    let killed = false;

    if (cand.kind === 'enemy' || cand.kind === 'ally') {
      if (global.VF.AI && global.VF.AI.damageEnemy) {
        const result = global.VF.AI.damageEnemy(cand.unit, dmg, dir, {
          headshot: false,
          weaponId: 'knife',
          melee: true,
          backstab: backstab,
        });
        killed = !!(result && result.killed);
        if (weapons._spawnImpact && cand.pos) {
          _hitPt.set(cand.pos.x, cand.pos.y + CHEST_LIFT, cand.pos.z);
          weapons._spawnImpact(_hitPt, backstab ? 0xffdd66 : 0xff6622, backstab ? 0.28 : 0.18);
        }
      }
    } else if (cand.kind === 'remote') {
      if (global.VF.Pvp && global.VF.Pvp.dealDamageToRemote) {
        global.VF.Pvp.dealDamageToRemote(dmg);
      }
      if (weapons._spawnImpact && cand.pos) {
        _hitPt.set(cand.pos.x, cand.pos.y + CHEST_LIFT, cand.pos.z);
        weapons._spawnImpact(_hitPt, backstab ? 0xffdd66 : 0xff4422, 0.2);
      }
    }

    if (global.VF.Audio) {
      global.VF.Audio.play(backstab ? 'melee_backstab' : 'melee_hit');
    }
    if (global.VF.UI && global.VF.UI.flashCrosshair) {
      global.VF.UI.flashCrosshair(killed || backstab ? 'kill' : 'hit');
    }
    if (backstab && global.VF.UI && global.VF.UI.toast) {
      global.VF.UI.toast('背刺处决');
    }
    if (player.addShake) player.addShake(backstab ? 0.045 : 0.028);
    if (player.applyRecoil) player.applyRecoil(backstab ? 0.08 : 0.05);
  }

  function tryHit(weapons, player) {
    const def = knifeDef();
    const range = (def && def.attackRange) || 2;
    const picked = pickTarget(weapons, player, range, true);
    if (!picked) return false;
    resolveHit(weapons, player, picked);
    return true;
  }

  function trySwing(weapons) {
    if (global.VF.Throwables && global.VF.Throwables.busy && global.VF.Throwables.busy()) return false;
    if (!weapons || !available()) return false;
    const player = weapons.player;
    if (!player || player.dead) return false;
    if (weapons.mode !== 'weapon') return false;
    if (!isKnife(weapons)) return false;
    const s = _state(weapons);
    if (s.phase !== 'idle') return false;
    const def = knifeDef();
    if (!def) return false;

    if (player.spawnProtect > 0) player.spawnProtect = 0;
    if (global.VF.Skills && global.VF.Skills.isPlayerStealthed(player)) {
      if (global.VF.game && global.VF.game.skills && global.VF.game.skills.breakStealth) {
        global.VF.game.skills.breakStealth(false);
      } else {
        player.stealthed = false;
        player.ghostAmbushShot = true;
      }
    }

    s.phase = 'windup';
    s.t = 0;
    s.hit = false;
    s.lunge = null;
    s.lungeLeft = 0;
    weapons.cooldown = def.fireRate;

    const lungeRange = def.lungeRange || 2.6;
    if (player.onGround && s.lungeCd <= 0) {
      const picked = pickTarget(weapons, player, lungeRange, true);
      if (picked && picked.dist > (def.attackRange || 2) + 0.05) {
        s.lunge = picked.cand;
        s.lungeLeft = Math.min(lungeRange - (def.attackRange || 2), picked.dist - (def.attackRange || 2));
        s.lungeCd = def.lungeCooldown || 0.3;
      }
    }

    if (global.VF.Audio) global.VF.Audio.play('melee_swing');
    if (player.applyRecoil) player.applyRecoil(0.07);
    if (global.VF.UI && global.VF.UI.flashCrosshair) global.VF.UI.flashCrosshair('fire');
    return true;
  }

  function update(weapons, dt) {
    if (!weapons) return;
    const s = _state(weapons);
    const player = weapons.player;
    const def = knifeDef();
    if (!def) return;

    applyLunge(weapons, player, dt);

    if (s.phase === 'idle') {
      applySlashPose(player, s, def);
      return;
    }
    if (!isKnife(weapons) || !player || player.dead) {
      cancel(weapons);
      applySlashPose(player, s, def);
      return;
    }

    s.t += dt;
    if (s.phase === 'windup') {
      if (s.t >= def.windupTime) {
        s.phase = 'active';
        s.t = 0;
      }
    }
    if (s.phase === 'active') {
      if (!s.hit) s.hit = tryHit(weapons, player);
      if (s.t >= def.activeTime) {
        s.phase = 'recovery';
        s.t = 0;
        s.lunge = null;
        s.lungeLeft = 0;
      }
    } else if (s.phase === 'recovery') {
      if (s.t >= def.recoveryTime) {
        s.phase = 'idle';
        s.t = 0;
      }
    }
    applySlashPose(player, s, def);
  }

  global.VF = global.VF || {};
  global.VF.Melee = {
    available: available,
    isKnife: isKnife,
    trySwing: trySwing,
    update: update,
    cancel: cancel,
    restyle: restyle,
    isBackstab: isBackstab,
  };
})(window);
