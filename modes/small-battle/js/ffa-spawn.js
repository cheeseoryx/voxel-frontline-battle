/**
 * ffa-spawn.js — 自由混战 respawn: instant timer + safety-scored spawn choice.
 *
 * The 死斗 picker avoids the enemy TEAM; FFA has none, so this variant avoids
 * EVERY other combatant. For each candidate zone it scores how far the nearest
 * of everyone is, penalises zones anyone can currently see, excludes zones near
 * a fresh corpse (anti death-loop) or within the safe radius of any player, then
 * picks randomly from the top few so the choice cannot be predicted.
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});

  const DIST_CAP = 110;
  const LOS_ENEMIES = 4;
  const LOS_PENALTY = 220;
  const LOS_STEP = 2.5;
  const NEAREST_WEIGHT = 2.4;
  const EYE_Y = 1.5;

  /**
   * 枪械模式复用这套复活选点（同为无队伍混战，出生规则一致），所以参数读的是
   * 「当前无队伍模式」的配置，而不是写死 'ffa'。
   */
  function params() {
    if (!VF.GameModes) return {};
    const gg = VF.GameModes.isGg && VF.GameModes.isGg();
    return VF.GameModes.getParams(gg ? 'gungame' : 'ffa');
  }

  /** 当前拥有这场对局的无队伍计分模块。 */
  function scorer() {
    if (VF.GgMatch && VF.GgMatch.active) return VF.GgMatch;
    return VF.FfaMatch;
  }

  /** Combatant count including humans; AI target is this minus human slots. */
  function combatants() {
    const p = params();
    return Math.max(2, p.combatants != null ? p.combatants : 8);
  }

  function humanSlots() {
    return VF.Pvp && VF.Pvp.quickSession ? 1 + VF.Pvp.remoteHumanSlots() : VF.game && VF.game.mode === 'pvp' ? 2 : 1;
  }

  function aiTarget() {
    return Math.max(0, combatants() - humanSlots());
  }

  const AI_SPAWN_PER_TICK = 2;

  const state = {
    active: false,
    respawnLeft: 0,
    waiting: false,
    deaths: [], // { x, z, t } — recent deaths anywhere, for zone exclusion
    playerDeaths: [],
    lastPlayerDeath: null,
    aiQueue: [], // { at } — pending AI reinforcements (all enemy-team)
    clock: 0,
  };

  const Spawn = {
    start: function () {
      state.active = true;
      state.respawnLeft = 0;
      state.waiting = false;
      state.deaths = [];
      state.playerDeaths = [];
      state.lastPlayerDeath = null;
      state.aiQueue = [];
      state.clock = 0;
      return this;
    },

    stop: function () {
      state.active = false;
      state.waiting = false;
      state.respawnLeft = 0;
      state.aiQueue = [];
    },

    isWaiting: function () {
      return state.waiting;
    },

    respawnLeft: function () {
      return state.respawnLeft;
    },

    /* ───────────────────────── death bookkeeping ────────────────────── */

    /** Called for every death so zones near a fresh corpse can be avoided. */
    recordDeath: function (team, x, z, isPlayer) {
      if (!state.active) return;
      state.deaths.push({ x: x, z: z, t: state.clock });
      if (isPlayer) {
        state.playerDeaths.push(state.clock);
        state.lastPlayerDeath = { x: x, z: z };
        return;
      }
      // Keep the arena at strength: every AI death schedules a replacement.
      const delay = params().respawnDelay != null ? params().respawnDelay : 2.5;
      state.aiQueue.push({ at: state.clock + delay });
    },

    onPlayerDeath: function () {
      if (!state.active) return;
      const g = VF.game;
      const p = params();
      if (g && g.player && g.player.object) {
        const pos = g.player.object.position;
        this.recordDeath(null, pos.x, pos.z, true);
      }
      state.waiting = true;
      state.respawnLeft = p.respawnDelay != null ? p.respawnDelay : 2.5;
    },

    /* ────────────────────────────── tick ───────────────────────────── */

    update: function (dt) {
      if (!state.active) return;
      state.clock += dt;

      const window = Math.max(
        params().deathPenaltyTime || 5,
        params().spawnCampWindow || 5
      );
      while (state.deaths.length && state.clock - state.deaths[0].t > window) {
        state.deaths.shift();
      }
      while (
        state.playerDeaths.length &&
        state.clock - state.playerDeaths[0] > (params().spawnCampWindow || 5)
      ) {
        state.playerDeaths.shift();
      }

      const match = scorer();
      if (match && match.scoringLive()) this._reinforceAi();

      if (!state.waiting) return;
      if (match && match.ended) {
        state.waiting = false;
        return;
      }
      if (VF.UI && VF.UI.isMenuOpen && VF.UI.isMenuOpen()) return;

      state.respawnLeft = Math.max(0, state.respawnLeft - dt);
      if (state.respawnLeft > 0) return;

      state.waiting = false;
      this.respawnPlayer();
    },

    /* ──────────────────────── AI reinforcements ────────────────────── */

    /** Refill the AI roster to (combatants − humans), reusing the safety scoring. */
    _reinforceAi: function () {
      if (!state.aiQueue.length) return;
      const g = VF.game;
      const ai = g && g.ai;
      if (!ai || !ai.spawnReinforcement) return;
      const target = aiTarget();

      let spawned = 0;
      for (let i = 0; i < state.aiQueue.length && spawned < AI_SPAWN_PER_TICK; ) {
        const job = state.aiQueue[i];
        if (job.at > state.clock) {
          i++;
          continue;
        }
        state.aiQueue.splice(i, 1);
        if (ai.aliveCount('enemy') >= target) continue;
        const pick = this.pickSpawn();
        if (!pick) continue;
        ai.spawnReinforcement('enemy', pick.zone);
        spawned++;
      }
    },

    /* ───────────────────────────── respawn ─────────────────────────── */

    respawnPlayer: function () {
      const g = VF.game;
      if (!g || !g.player || !g.world) return;
      const p = params();
      const team = g.player.team || g.lockedTeam || g.world._playerTeam || 'ally';

      const pick = this.pickSpawn();
      if (!pick) return;

      if (pick.zone.team === team && pick.zone.id && g.world.setSelectedSpawn) {
        g.world.setTdmSpawnOverride(null);
        g.world.setSelectedSpawn(pick.zone.id);
      } else {
        // Any zone not in the player's own list (neutral or the far home) is
        // forced directly — FFA freely spawns the player anywhere on the map.
        g.world.setTdmSpawnOverride(pick.zone);
      }

      if (g.resumeAfterRedeploy) g.resumeAfterRedeploy();

      const protect = pick.fallback
        ? p.spawnBlockedProtection != null
          ? p.spawnBlockedProtection
          : 3.0
        : p.spawnProtection != null
          ? p.spawnProtection
          : 1.5;
      g.player.spawnProtect = protect;

      const ui = VF.GgMatch && VF.GgMatch.active ? VF.GgUi : VF.FfaUi;
      if (ui && ui.onRespawn) ui.onRespawn(pick, protect);
      return pick;
    },

    /* ───────────────────────── spawn selection ─────────────────────── */

    /**
     * @returns { zone, score, fallback } — fallback means every clean zone was
     *          excluded (all near a corpse or inside someone's safe radius) and
     *          we had to reuse the least-bad one.
     */
    pickSpawn: function () {
      const g = VF.game;
      const world = g && g.world;
      if (!world || !world.getTdmSpawnZones) return null;
      const all = world.getTdmSpawnZones();
      if (!all.length) return null;
      const p = params();

      const threats = this._threatPositions();
      const camped = this._isBeingSpawnCamped();
      const safeR = p.spawnSafeRadius != null ? p.spawnSafeRadius : 15;

      const scored = [];
      const denied = [];
      for (let i = 0; i < all.length; i++) {
        const zone = all[i];
        const entry = { zone: zone, score: this._score(zone, threats, camped) };
        if (this._recentDeathNear(zone) || this._nearestThreatDist(zone, threats) < safeR) {
          denied.push(entry);
        } else {
          scored.push(entry);
        }
      }

      let pool = scored;
      let fallback = false;
      if (!pool.length) {
        pool = denied;
        fallback = true;
      }
      if (!pool.length) return null;

      pool.sort(function (a, b) {
        return b.score - a.score;
      });

      const top = Math.max(1, Math.min(p.spawnPickTop || 3, pool.length));
      const chosen = pool[Math.floor(Math.random() * top)];
      chosen.fallback = fallback;
      return chosen;
    },

    _score: function (zone, threats, camped) {
      let score = 0;
      let nearest = DIST_CAP;

      for (let i = 0; i < threats.length; i++) {
        const dx = zone.x - threats[i].x;
        const dz = zone.z - threats[i].z;
        const d = Math.sqrt(dx * dx + dz * dz);
        score += Math.min(d, DIST_CAP);
        if (d < nearest) nearest = d;
      }
      if (threats.length) score /= threats.length;
      score += nearest * NEAREST_WEIGHT;

      const sorted = threats.slice(0, LOS_ENEMIES);
      for (let i = 0; i < sorted.length; i++) {
        if (this._hasLineOfSight(zone, sorted[i])) score -= LOS_PENALTY;
      }

      if (camped && camped.x != null) {
        const dx = zone.x - camped.x;
        const dz = zone.z - camped.z;
        score += Math.min(Math.sqrt(dx * dx + dz * dz), DIST_CAP) * 3;
      }
      return score;
    },

    _nearestThreatDist: function (zone, threats) {
      let nearest = Infinity;
      for (let i = 0; i < threats.length; i++) {
        const dx = zone.x - threats[i].x;
        const dz = zone.z - threats[i].z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < nearest) nearest = d;
      }
      return nearest;
    },

    /** Everyone else on the field is a threat — both AI lists plus the player. */
    _threatPositions: function () {
      const g = VF.game;
      const out = [];
      const ai = g && g.ai;
      if (ai) {
        const lists = [ai.blue, ai.red];
        for (let l = 0; l < lists.length; l++) {
          const list = lists[l];
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const u = list[i];
            if (!u || !u.alive || !u.mesh) continue;
            out.push({ x: u.mesh.position.x, y: u.mesh.position.y, z: u.mesh.position.z });
          }
        }
      }

      const self = g && g.player;
      if (self && self.object && !self.dead) {
        const sp = self.object.position;
        out.push({ x: sp.x, y: sp.y, z: sp.z });
      }

      const cx = (g && g.world && g.world.worldSize * 0.5) || 0;
      out.sort(function (a, b) {
        return (
          Math.abs(a.x - cx) + Math.abs(a.z - cx) - (Math.abs(b.x - cx) + Math.abs(b.z - cx))
        );
      });
      return out;
    },

    _hasLineOfSight: function (zone, enemy) {
      const world = VF.game && VF.game.world;
      if (!world || !world._isSolid) return false;
      const ax = zone.x;
      const ay = (zone.y || 10) + EYE_Y;
      const az = zone.z;
      const bx = enemy.x;
      const by = (enemy.y || 10) + EYE_Y;
      const bz = enemy.z;
      const dist = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
      if (dist > DIST_CAP) return false;

      const steps = Math.ceil(dist / LOS_STEP);
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const x = Math.floor(ax + (bx - ax) * t);
        const y = Math.floor(ay + (by - ay) * t);
        const z = Math.floor(az + (bz - az) * t);
        if (world._isSolid(x, y, z)) return false;
      }
      return true;
    },

    _recentDeathNear: function (zone) {
      const win = params().deathPenaltyTime != null ? params().deathPenaltyTime : 5;
      const r = 14;
      for (let i = 0; i < state.deaths.length; i++) {
        const d = state.deaths[i];
        if (state.clock - d.t > win) continue;
        const dx = zone.x - d.x;
        const dz = zone.z - d.z;
        if (dx * dx + dz * dz < r * r) return true;
      }
      return false;
    },

    _isBeingSpawnCamped: function () {
      const p = params();
      const need = p.spawnCampDeaths != null ? p.spawnCampDeaths : 2;
      if (state.playerDeaths.length < need) return null;
      return state.lastPlayerDeath || null;
    },
  };

  VF.FfaSpawn = Spawn;
})(typeof window !== 'undefined' ? window : globalThis);
