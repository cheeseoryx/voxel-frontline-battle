/**
 * tdm-spawn.js — 团队死斗 respawn: instant timer + safety-scored spawn choice.
 *
 * The spawn picker is the heart of the mode. For each candidate zone it scores
 * how far away the enemy team is, penalises zones an enemy can currently see,
 * excludes zones where a teammate just died, then picks randomly from the top
 * few so the choice cannot be predicted.
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});

  /** Distance past which extra separation stops mattering. */
  const DIST_CAP = 110;
  /** Only the closest few enemies get a line-of-sight test (it is the costly part). */
  const LOS_ENEMIES = 4;
  const LOS_PENALTY = 220;
  const LOS_STEP = 2.5;
  const NEAREST_WEIGHT = 2.4;
  const EYE_Y = 1.5;

  function params() {
    return VF.GameModes ? VF.GameModes.getParams('tdm') : {};
  }

  /** Reinforcements per tick, so a wipe does not spawn 12 soldiers in one frame. */
  const AI_SPAWN_PER_TICK = 2;

  const state = {
    active: false,
    respawnLeft: 0,
    waiting: false,
    deaths: [], // { x, z, team, t } — recent deaths, for zone exclusion
    playerDeaths: [], // timestamps, for the spawn-camp rule
    lastPlayerDeath: null,
    aiQueue: [], // { team, at } — pending AI reinforcements
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

    /** Called for every death so zones near fresh corpses can be avoided. */
    recordDeath: function (team, x, z, isPlayer) {
      if (!state.active) return;
      state.deaths.push({ x: x, z: z, team: team, t: state.clock });
      if (isPlayer) {
        state.playerDeaths.push(state.clock);
        state.lastPlayerDeath = { x: x, z: z };
        return;
      }
      // A 50-kill race needs the squads kept at strength
      const delay = params().respawnDelay != null ? params().respawnDelay : 3.0;
      state.aiQueue.push({ team: team, at: state.clock + delay });
    },

    onPlayerDeath: function () {
      if (!state.active) return;
      const g = VF.game;
      const p = params();
      if (g && g.player && g.player.object) {
        const pos = g.player.object.position;
        this.recordDeath(g.player.team || 'ally', pos.x, pos.z, true);
      }
      state.waiting = true;
      state.respawnLeft = p.respawnDelay != null ? p.respawnDelay : 3.0;
    },

    /* ────────────────────────────── tick ───────────────────────────── */

    update: function (dt) {
      if (!state.active) return;
      state.clock += dt;

      // Age out death records (only the recent window matters)
      const window = Math.max(
        params().spawnDenyWindow || 5,
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

      const match = VF.TdmMatch;
      if (match && match.scoringLive()) this._reinforceAi();

      if (!state.waiting) return;
      if (match && match.ended) {
        state.waiting = false;
        return;
      }
      // Menus pause the countdown so a paused player is not thrown back in
      if (VF.UI && VF.UI.isMenuOpen && VF.UI.isMenuOpen()) return;

      state.respawnLeft = Math.max(0, state.respawnLeft - dt);
      if (state.respawnLeft > 0) return;

      state.waiting = false;
      this.respawnPlayer();
    },

    /* ──────────────────────── AI reinforcements ────────────────────── */

    /** Refill both squads to the mode's team size, reusing the safety scoring. */
    _reinforceAi: function () {
      if (!state.aiQueue.length) return;
      const g = VF.game;
      const ai = g && g.ai;
      if (!ai || !ai.spawnReinforcement) return;
      const target = ai.teamTarget ? ai.teamTarget() : 12;

      let spawned = 0;
      for (let i = 0; i < state.aiQueue.length && spawned < AI_SPAWN_PER_TICK; ) {
        const job = state.aiQueue[i];
        if (job.at > state.clock) {
          i++;
          continue;
        }
        state.aiQueue.splice(i, 1);
        // The player counts toward their own side's headcount
        const playerOn = (g.player && g.player.team === job.team ? 1 : 0) + (VF.Pvp && VF.Pvp.remoteHumanSlots ? VF.Pvp.remoteHumanSlots(job.team) : 0);
        if (ai.aliveCount(job.team) + playerOn >= target) continue;
        const pick = this.pickSpawn(job.team);
        if (!pick) continue;
        ai.spawnReinforcement(job.team, pick.zone);
        spawned++;
      }
    },

    /* ───────────────────────────── respawn ─────────────────────────── */

    respawnPlayer: function () {
      const g = VF.game;
      if (!g || !g.player || !g.world) return;
      const p = params();
      const team = g.player.team || g.lockedTeam || g.world._playerTeam || 'ally';

      const pick = this.pickSpawn(team);
      if (!pick) return;

      if (pick.zone.team === team && pick.zone.id && g.world.setSelectedSpawn) {
        g.world.setTdmSpawnOverride(null);
        g.world.setSelectedSpawn(pick.zone.id);
      } else {
        // Neutral zone: not in either team's list, so force it directly
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

      if (VF.TdmUi && VF.TdmUi.onRespawn) VF.TdmUi.onRespawn(pick, protect);
      return pick;
    },

    /* ───────────────────────── spawn selection ─────────────────────── */

    /**
     * @returns { zone, score, fallback } — fallback means every safe zone was
     *          excluded and we had to reuse a denied one (⑧ 出生点全被封锁).
     */
    pickSpawn: function (team) {
      const g = VF.game;
      const world = g && g.world;
      if (!world || !world.getTdmSpawnZones) return null;
      const all = world.getTdmSpawnZones();
      if (!all.length) return null;
      const p = params();

      const usable = [];
      for (let i = 0; i < all.length; i++) {
        const z = all[i];
        // Own-team home clusters and neutral ground only — never spawn in the
        // enemy's home cluster
        if (z.team && z.team !== team) continue;
        usable.push(z);
      }
      if (!usable.length) return null;

      const enemies = this._enemyPositions(team);
      const camped = this._isBeingSpawnCamped();

      const scored = [];
      const denied = [];
      for (let i = 0; i < usable.length; i++) {
        const zone = usable[i];
        if (this._recentFriendlyDeathNear(zone, team)) {
          denied.push({ zone: zone, score: this._score(zone, enemies, camped) });
          continue;
        }
        scored.push({ zone: zone, score: this._score(zone, enemies, camped) });
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

      // Randomise within the top few so the spawn cannot be pre-aimed
      const top = Math.max(1, Math.min(p.spawnPickTop || 3, pool.length));
      const chosen = pool[Math.floor(Math.random() * top)];
      chosen.fallback = fallback;
      return chosen;
    },

    _score: function (zone, enemies, camped) {
      let score = 0;
      let nearest = DIST_CAP;

      for (let i = 0; i < enemies.length; i++) {
        const dx = zone.x - enemies[i].x;
        const dz = zone.z - enemies[i].z;
        const d = Math.sqrt(dx * dx + dz * dz);
        score += Math.min(d, DIST_CAP);
        if (d < nearest) nearest = d;
      }
      if (enemies.length) score /= enemies.length;
      score += nearest * NEAREST_WEIGHT;

      // Line-of-sight penalty from the closest handful of enemies
      const sorted = enemies.slice(0, LOS_ENEMIES);
      for (let i = 0; i < sorted.length; i++) {
        if (this._hasLineOfSight(zone, sorted[i])) score -= LOS_PENALTY;
      }

      // ⑧ 连续被出生杀 → push toward the far side of the map
      if (camped && camped.x != null) {
        const dx = zone.x - camped.x;
        const dz = zone.z - camped.z;
        score += Math.min(Math.sqrt(dx * dx + dz * dz), DIST_CAP) * 3;
      }
      return score;
    },

    _enemyPositions: function (team) {
      const g = VF.game;
      const out = [];
      const ai = g && g.ai;
      if (ai) {
        const lists = [ai.enemies, ai.allies];
        for (let l = 0; l < lists.length; l++) {
          const list = lists[l];
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const u = list[i];
            if (!u || !u.alive || !u.mesh || u.team === team) continue;
            out.push({ x: u.mesh.position.x, y: u.mesh.position.y, z: u.mesh.position.z });
          }
        }
      }
      // PVP opponent counts as an enemy for spawn safety
      if (VF.Pvp && VF.Pvp.remoteAvatar && VF.Pvp.remoteAvatar.visible) {
        const rp = VF.Pvp.remoteAvatar.position;
        out.push({ x: rp.x, y: rp.y, z: rp.z });
      }

      const self = g && g.player;
      if (self && self.object && self.team && self.team !== team && !self.dead) {
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

    /** Coarse sampled ray — exact visibility is not worth the cost here. */
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

    _recentFriendlyDeathNear: function (zone, team) {
      const win = params().spawnDenyWindow != null ? params().spawnDenyWindow : 5;
      const r = 14;
      for (let i = 0; i < state.deaths.length; i++) {
        const d = state.deaths[i];
        if (d.team !== team) continue;
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

  VF.TdmSpawn = Spawn;
})(typeof window !== 'undefined' ? window : globalThis);
