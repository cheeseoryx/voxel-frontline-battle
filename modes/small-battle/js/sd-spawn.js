/**
 * sd-spawn.js — 爆破模式单命制出生管理（Search & Destroy round spawns）
 *
 * 与死斗的即时复活不同，爆破是单命制：一个回合内阵亡不复活，只有在回合开始时
 * 整队重新投放。本模块因此只做三件事，全部集中在回合开始的一瞬间：
 *   1. 重新规划 A/B 包点（地图固定，但缓存需在整局开始时刷新一次）
 *   2. 满编重生双方 AI 名单（复用 AI.applyPlayerTeam，含玩家名额预留）
 *   3. 把玩家重置回己方出生点、回满血、解除死亡态（复用 game.resumeAfterRedeploy）
 * 并为攻方随机选出携带炸弹的单位（3.1 随机携带者）。
 *
 * 它把这些能力以 hooks 的形式交给 SdMatch（setupRound / pickCarrier），从而让
 * 回合规则与出生实现彻底解耦——SdMatch 不需要认识 AI / 玩家 / 地图。
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});

  function params() {
    return VF.GameModes ? VF.GameModes.getParams('demo') : {};
  }

  function attackerOf() {
    return VF.SdMatch ? VF.SdMatch.attackerTeam : 'ally';
  }

  const state = {
    active: false,
    firstRoundDone: false,
  };

  const Spawn = {
    /* ─────────────────────────── lifecycle ─────────────────────────── */

    start: function () {
      state.active = true;
      state.firstRoundDone = false;
      this._bindHooks();
      return this;
    },

    stop: function () {
      state.active = false;
    },

    /** Wire our capabilities into SdMatch without SdMatch importing us. */
    _bindHooks: function () {
      const m = VF.SdMatch;
      if (!m) return;
      const self = this;
      m.hooks.setupRound = function (ctx) {
        self.setupRound(ctx);
      };
      m.hooks.pickCarrier = function (team) {
        return self.pickCarrier(team);
      };
    },

    /* ──────────────────────── round preparation ────────────────────── */

    /**
     * Called by SdMatch at the start of every round's BUY phase. Order matters:
     * plan sites → respawn rosters → reset player, so that pickCarrier (called
     * right after by SdMatch) always sees a fully populated attacker team.
     */
    setupRound: function (ctx) {
      const g = VF.game;
      if (!g) return;

      this._regenRoundMap(ctx);

      if (g.world && g.world.planSdPlantSites) g.world.planSdPlantSites();

      this._respawnAi();
      this._respawnPlayer(ctx);
      this._grantDefuseKits(ctx);
    },

    /**
     * 每一小回合重新随机地图（「每一小回合重新随机地图」）。
     *
     * 首回合沿用开局时已生成的竞技场，避免玩家刚落地就被换图；第 2 回合起用
     * 「基础种子 + 回合×黄金比常数」派生的确定性种子重生 SD 竞技场——确定性保证
     * PVP 主客机得到同一张图，而逐回合不同的种子让每一小回合都换一张新图。
     *
     * 世界重建后必须刷新：出生点（applyTdmSpawnPoints 依新地形解算）、A/B 包点缓存
     * （generateSdMap 内部已置空，稍后由 setupRound 的 planSdPlantSites 重算）、以及
     * SdField 的世界 A/B 标记（否则仍停在旧坐标）。之后由 setupRound 续跑的重生流程
     * 把 AI/玩家放到新地图上。
     */
    _regenRoundMap: function (ctx) {
      const g = VF.game;
      const w = g && g.world;
      const round = (ctx && ctx.round) || (VF.SdMatch && VF.SdMatch.round) || 1;
      if (!w || !w.generateSdMap || round <= 1) return;

      const base = (g.mapSeed != null ? g.mapSeed : 1) >>> 0;
      const seed = (base + round * 0x9e3779b1) >>> 0;

      if (g.bases && g.bases.detach) g.bases.detach();
      const cap = VF.GameModes ? VF.GameModes.param('mapHeightCap', 26) : 26;
      w.generateSdMap(seed, { heightCap: cap });
      if (w.applyTdmSpawnPoints) w.applyTdmSpawnPoints();

      if (VF.SdField && VF.SdField._removeSiteMarkers) VF.SdField._removeSiteMarkers();
    },

    /** Fresh single-life rosters for both teams (player slot reserved inside). */
    _respawnAi: function () {
      const ai = VF.game && VF.game.ai;
      if (!ai) return;
      if (ai.applyPlayerTeam) ai.applyPlayerTeam();
    },

    /** Put the player back on their home spawn at full health for the round. */
    _respawnPlayer: function (ctx) {
      const g = VF.game;
      const w = g && g.world;
      const p = g && g.player;
      if (!w || !p) return;

      const team = p.team || g.lockedTeam || w._playerTeam || 'ally';
      if (w.setTdmSpawnOverride) w.setTdmSpawnOverride(null);
      const list = (w._spawnPoints && w._spawnPoints[team]) || [];
      const home = list.length ? list[0] : null;
      if (home && w.setSelectedSpawn) w.setSelectedSpawn(home.id);

      if (g.resumeAfterRedeploy) g.resumeAfterRedeploy();

      // 逐回合换图后，新地形可能尚未在出生点下方建好网格；补建一小圈网格，
      // 避免玩家落进未构建的区块里。
      if (w.ensureMeshedAround && p.object) {
        w.ensureMeshedAround(p.object.position.x, p.object.position.z, 8);
      }

      const prot = params().spawnProtection != null ? params().spawnProtection : 0;
      if (prot > 0) p.spawnProtect = prot;
      void ctx;
    },

    /** Defenders may carry a defuse kit (6.2 快速拆除). Player-only flag here. */
    _grantDefuseKits: function (ctx) {
      const g = VF.game;
      const p = g && g.player;
      if (!p) return;
      const defenderTeam = (ctx && ctx.defenderTeam) || (VF.SdMatch && VF.SdMatch.defenderTeam);
      const enabled = params().defuseKitEnable !== false;
      p._sdDefuseKit = !!(enabled && (p.team || 'ally') === defenderTeam);
    },

    /* ─────────────────────────── carrier pick ──────────────────────── */

    /**
     * 3.1 随机携带者：从攻方存活单位（含玩家）中等概率选一个作为炸弹携带者。
     * @returns {string|null} carrier id ('player' | 'ai-*')
     */
    pickCarrier: function (team) {
      const atk = team || attackerOf();
      const candidates = this._attackerIds(atk);
      if (!candidates.length) return null;
      const rule = params().carrierSelectRule || 'random';
      if (rule === 'player' && candidates.indexOf('player') !== -1) return 'player';
      return candidates[Math.floor(Math.random() * candidates.length)];
    },

    _attackerIds: function (team) {
      const g = VF.game;
      const out = [];
      const ai = g && g.ai;
      if (ai) {
        const list = team === 'enemy' ? ai.red : ai.blue;
        if (list) {
          for (let i = 0; i < list.length; i++) {
            if (list[i] && list[i].alive) out.push(list[i].id);
          }
        }
      }
      const p = g && g.player;
      if (p && p.alive && (p.team || 'ally') === team) out.push('player');
      return out;
    },

    update: function () {
      /* single-life: no respawn timer to run */
    },
  };

  VF.SdSpawn = Spawn;
})(typeof window !== 'undefined' ? window : globalThis);