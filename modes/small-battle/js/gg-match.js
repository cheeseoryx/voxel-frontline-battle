/**
 * gg-match.js — 枪械模式 (Gun Game) 武器进阶、排行与胜负。
 *
 * 与 自由混战 的根本区别：击杀不是为了累积分数，而是为了换下一把武器。排名按
 * 【当前武器等级】而不是击杀数，胜利条件是「用最后一把武器完成 1 次击杀」。
 *
 * 本模块同时是武器阶梯的唯一权威来源：
 *   - 序列取自 GameModes 的 weaponSequence（等级 = 数组下标，最后一项 = 最终级）
 *   - 玩家武器由 _enforceWeapons 每帧强制对齐当前等级（切枪键无效）
 *   - AI 武器等级映射到兵种数值（伤害/射程/精度/射速 → 交战距离随之改变）
 *
 * 降级（文档 3.1）：项目暂无近战武器，所以「刀杀降级」落地为「被爆头击杀降级」，
 * 同样要求精准/贴近，保留压制领先者的作用。参数见 gamemodes.js gungame。
 *
 * 参与者 id：'player' 为本地玩家，其余为 unit.id。AI 阵营字段在此无意义。
 */
(function (global) {
  'use strict';

  const VF = (global.VF = global.VF || {});

  const PHASE_PREP = 'prep';
  const PHASE_BATTLE = 'battle';
  const PHASE_RESULT = 'result';

  const FEED_MAX = 6;
  const FEED_TTL = 7.0;

  const DEFAULT_SEQUENCE = ['ar', 'sg', 'sr'];

  /** 武器 → AI 兵种：决定 AI 的交战距离与弹道表现（文档 6.3 的简化实现）。 */
  const AI_TYPE_BY_WEAPON = { ar: 'infantry', sg: 'heavy', sr: 'ranged' };

  function params() {
    return VF.GameModes ? VF.GameModes.getParams('gungame') : {};
  }

  function weaponDef(id) {
    return (VF.WEAPONS && VF.WEAPONS[id]) || null;
  }

  const Gg = {
    active: false,
    phase: PHASE_PREP,
    timeLeft: 0,
    phaseLeft: 0,
    stats: {},
    feed: [],
    ended: false,
    winner: null,
    endReason: '',
    _order: 0,
    _clock: 0,
    _shownRank: 0,
    _shownLevel: -1,

    /* ───────────────────────── 武器阶梯 ───────────────────────── */

    /** 完整序列（等级 = 下标）。新增枪种后只需改 gamemodes 里的数组。 */
    sequence: function () {
      const seq = params().weaponSequence;
      if (!Array.isArray(seq) || !seq.length) return DEFAULT_SEQUENCE;
      return seq;
    },

    levelCount: function () {
      return this.sequence().length;
    },

    /** 最终级下标：用这一级的武器完成击杀即通关。 */
    finalLevel: function () {
      return this.levelCount() - 1;
    },

    /** 该等级应持有的武器 id（越界则钳到最终级）。 */
    weaponAt: function (level) {
      const seq = this.sequence();
      const i = Math.max(0, Math.min(seq.length - 1, level | 0));
      return seq[i];
    },

    /** 武器 → AI 兵种 key（ai.js 换枪时读它）。 */
    aiTypeForWeapon: function (weaponId) {
      return AI_TYPE_BY_WEAPON[weaponId] || 'infantry';
    },

    /** 该等级对应的 AI 兵种 key。 */
    aiTypeAt: function (level) {
      return this.aiTypeForWeapon(this.weaponAt(level));
    },

    weaponLabel: function (id) {
      const def = weaponDef(id);
      return (def && (def.nameZh || def.name)) || id || '—';
    },

    labelAt: function (level) {
      return this.weaponLabel(this.weaponAt(level));
    },

    /* ─────────────────────────── lifecycle ─────────────────────────── */

    start: function () {
      const p = params();
      this.active = true;
      this.ended = false;
      this.winner = null;
      this.endReason = '';
      this.phase = PHASE_PREP;
      this.stats = {};
      this.feed = [];
      this._order = 0;
      this._clock = 0;
      this._shownRank = 0;
      this._shownLevel = -1;
      this._warnedFinisher = null;
      this._wasDead = false;
      this.timeLeft = p.timeLimit != null ? p.timeLimit : 1200;
      this.phaseLeft = p.prepTime != null ? p.prepTime : 10;

      this.ensure('player', { name: '你', isPlayer: true });
      if (VF.game && VF.game.mode === 'pvp') {
        this.ensure('remote', { name: '对手' });
      }
      // 开局所有人都在 Lv0：立刻把玩家武器压到序列第一把
      this._applyPlayerWeapon(0, true);
      return this;
    },

    stop: function () {
      this.active = false;
      this.phase = PHASE_PREP;
      this.feed = [];
      if (VF.FfaMarker && VF.FfaMarker.stop) VF.FfaMarker.stop();
    },

    isRunning: function () {
      return this.active && !this.ended;
    },

    scoringLive: function () {
      return this.active && !this.ended && this.phase === PHASE_BATTLE;
    },

    /* ──────────────────────── participant stats ─────────────────────── */

    ensure: function (id, info) {
      if (!id) return null;
      let row = this.stats[id];
      if (!row) {
        row = this.stats[id] = {
          id: id,
          name: (info && info.name) || id,
          isPlayer: !!(info && info.isPlayer),
          /** 当前武器等级 = 排名主依据。 */
          level: 0,
          kills: 0,
          deaths: 0,
          /** 爆头击杀他人（= 让别人降级）的次数，文档 7.4「降级刺客」。 */
          demotes: 0,
          /** 自己被爆头降级的次数。 */
          demoted: 0,
          /** 到达当前等级的比赛时刻——同级时先到者排前（文档 5.3）。 */
          reachedAt: 0,
          /** 通关时刻，仅冠军有值。 */
          finishedAt: 0,
          /** 各武器停留时长，用于结算的「卡关武器」趣味统计。 */
          dwell: {},
        };
      } else if (info) {
        if (info.name) row.name = info.name;
        if (info.isPlayer) row.isPlayer = true;
      }
      return row;
    },

    idOf: function (actor) {
      if (!actor) return null;
      if (actor === 'player' || actor === 'remote') return actor;
      if (actor.isPlayer || (VF.game && actor === VF.game.player)) return 'player';
      return actor.id || null;
    },

    register: function (actor) {
      const id = this.idOf(actor);
      if (!id) return null;
      if (id === 'player') return this.ensure('player', { name: '你', isPlayer: true });
      if (id === 'remote') return this.ensure('remote', { name: '对手' });
      return this.ensure(id, { name: actor.name || id });
    },

    /** 当前等级查询——ai.js 用它决定单位该拿哪把武器。 */
    levelOf: function (id) {
      const row = this.stats[id];
      return row ? row.level : 0;
    },

    /** 场上每个战斗员都要有一行，开局排行榜就是满编 8 人。 */
    _ensureRoster: function () {
      if (VF.game && VF.game.mode === 'pvp') this.ensure('remote', { name: '对手' });
      const ai = VF.game && VF.game.ai;
      if (!ai) return;
      const lists = [ai.blue, ai.red];
      for (let l = 0; l < lists.length; l++) {
        const list = lists[l];
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const u = list[i];
          if (u && u.id) this.ensure(u.id, { name: u.name || u.id });
        }
      }
    },

    /* ───────────────────────── damage tracking ──────────────────────── */

    // 枪械模式不计伤害分，仅为与 死斗/自由混战 的调用点保持同签名。
    registerDamage: function () {},

    /* ──────────────────────── 武器强制分配 ──────────────────────── */

    /**
     * 玩家武器完全由等级决定（文档 4.1「去装备化」）。每帧校准，所以手动按
     * 1/2/3 也会立刻被压回来；force 用于开局/升级时顺带补满弹药。
     */
    _applyPlayerWeapon: function (level, force) {
      const g = VF.game;
      const w = g && g.weapons;
      if (!w) return;
      const want = this.weaponAt(level);
      if (w.current === want && !force) return;
      if (w.forceEquip) w.forceEquip(want);
      if (params().ammoRefillOnSwitch !== false) this.refillAmmo(want);
    },

    /** 补满当前武器：弹匣满 + 备弹回到该枪基准，避免因缺弹卡关（文档 4.2）。 */
    refillAmmo: function (weaponId) {
      const g = VF.game;
      const w = g && g.weapons;
      if (!w || !w.state) return;
      const id = weaponId || w.current;
      const def = weaponDef(id);
      const ammo = w.state[id];
      if (!def || !ammo) return;
      ammo.mag = def.magSize;
      ammo.reserve = Math.max(ammo.reserve, def.reserve);
      if (w.current === id && VF.UI && VF.UI.updateAmmo) {
        VF.UI.updateAmmo(ammo.mag, ammo.reserve);
      }
    },

    /**
     * 把每个存活 AI 的武器对齐它自己的等级。走「每帧校准」而不是挂在生成回调上，
     * 这样复活复用 id 的单位、以及降级后的单位都会自动跟上，不会漏。
     */
    _enforceAiWeapons: function () {
      const ai = VF.game && VF.game.ai;
      if (!ai || !ai.applyGgWeapon) return;
      if (params().aiWeaponAdapt === false) return;
      const lists = [ai.blue, ai.red];
      for (let l = 0; l < lists.length; l++) {
        const list = lists[l];
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const u = list[i];
          if (!u || !u.alive || !u.id) continue;
          const want = this.weaponAt(this.levelOf(u.id));
          if (u._ggWeapon === want) continue;
          ai.applyGgWeapon(u, want);
        }
      }
    },

    /** 该单位当前武器 id——AI 开火时用它标注击杀归属。 */
    weaponOfUnit: function (unit) {
      if (!unit) return null;
      if (unit._ggWeapon) return unit._ggWeapon;
      return this.weaponAt(this.levelOf(unit.id));
    },

    /* ──────────────────────────── scoring ───────────────────────────── */

    /**
     * 每一次死亡的唯一入口。
     * @param opts { victim, killer, headshot, weaponId }
     *   weaponId = 造成这次击杀的武器；缺失（技能/环境/空袭）则不给升级，
     *   对应文档 9.1 的方案A（严格）。
     */
    registerKill: function (opts) {
      if (!this.scoringLive()) return null;
      opts = opts || {};
      const p = params();

      const victimRow = this.register(opts.victim) || this.ensure(this.idOf(opts.victim));
      if (!victimRow) return null;
      const killerRow = opts.killer ? this.register(opts.killer) : null;
      const headshot = !!opts.headshot;
      const selfKill = !killerRow || killerRow.id === victimRow.id;

      victimRow.deaths += 1;

      let kind = 'kill';
      let leveled = false;
      let demoted = false;
      let win = false;

      if (selfKill) {
        // 自杀 / 坠落 / 环境：默认不降级（文档 3.2 Suicide_Demote 默认关）
        kind = 'suicide';
        if (p.suicideDemote) demoted = this._demote(victimRow);
      } else {
        killerRow.kills += 1;

        // 文档 9.1 方案A：只有「用当前等级武器」直接击杀才推进进度
        const credited =
          p.strictWeaponCredit === false
            ? !!opts.weaponId
            : !!opts.weaponId && opts.weaponId === this.weaponAt(killerRow.level);

        if (credited) {
          if (killerRow.level >= this.finalLevel()) {
            // 已在最终级 + 用最终武器再拿一杀 = 通关
            killerRow.finishedAt = this._clock;
            win = true;
          } else {
            this._levelUp(killerRow);
            leveled = true;
          }
        }

        // 爆头 = 本模式的「羞辱击杀」：先结算击杀升级，再结算被害者降级
        if (headshot) {
          killerRow.demotes += 1;
          demoted = this._demote(victimRow);
        }
      }

      const entry = {
        order: ++this._order,
        life: FEED_TTL,
        kind: kind,
        headshot: headshot,
        leveled: leveled,
        demoted: demoted,
        killer: killerRow ? killerRow.name : null,
        killerIsPlayer: !!(killerRow && killerRow.isPlayer),
        killerLevel: killerRow ? killerRow.level : 0,
        victim: victimRow.name,
        victimIsPlayer: !!victimRow.isPlayer,
        victimLevel: victimRow.level,
      };
      this.feed.push(entry);
      while (this.feed.length > FEED_MAX) this.feed.shift();

      if (VF.GgUi && VF.GgUi.onKill) VF.GgUi.onKill(entry);
      this._notifyRank();

      if (win) {
        this.end(killerRow.id, killerRow.name + ' 打通了军械库');
      } else {
        this._warnNearFinish();
      }
      return entry;
    },

    registerSuicide: function (victim) {
      return this.registerKill({ victim: victim, killer: null });
    },

    /** 升 1 级并立刻换枪 + 补弹。 */
    _levelUp: function (row) {
      row.level += 1;
      row.reachedAt = this._clock;
      if (row.isPlayer) {
        this._applyPlayerWeapon(row.level, true);
        if (VF.UI && VF.UI.toast) {
          VF.UI.toast('Lv' + row.level + ' · ' + this.labelAt(row.level));
        }
        if (VF.Audio) VF.Audio.play('confirm');
        const left = this.finalLevel() - row.level;
        if (left > 0 && left <= 2 && VF.UI && VF.UI.toast) {
          setTimeout(function () {
            if (VF.UI && VF.UI.toast) VF.UI.toast('距离通关还差 ' + left + ' 级');
          }, 900);
        }
      }
      if (params().ammoRefillOnKill !== false && row.isPlayer) {
        this.refillAmmo(this.weaponAt(row.level));
      }
      if (VF.GgUi && VF.GgUi.onLevel) VF.GgUi.onLevel(row);
      return true;
    },

    /**
     * 被爆头降级（文档 3.1 / 3.3 边界）：
     *   - Lv0 已是下限，不再降
     *   - 最终级是否可降由 finalLevelProtection 决定（本作默认可降）
     *   - 一次死亡只降 1 级，不叠加
     */
    _demote: function (row) {
      const p = params();
      if (!p.demoteEnable) return false;
      const floor = p.demoteFloor != null ? p.demoteFloor : 0;
      if (row.level <= floor) return false;
      if (p.finalLevelProtection && row.level >= this.finalLevel()) return false;

      const step = Math.max(1, p.demoteLevels != null ? p.demoteLevels : 1);
      row.level = Math.max(floor, row.level - step);
      row.demoted += 1;
      row.reachedAt = this._clock;

      if (row.isPlayer) {
        this._applyPlayerWeapon(row.level, true);
        if (VF.UI && VF.UI.toast) {
          VF.UI.toast('被爆头 · 退回 Lv' + row.level + ' ' + this.labelAt(row.level));
        }
        if (VF.Audio) VF.Audio.play('hurt');
      }
      if (VF.GgUi && VF.GgUi.onDemote) VF.GgUi.onDemote(row);
      return true;
    },

    /** 名次变化提示（文档 5.2 领先者变化）。 */
    _notifyRank: function () {
      const rank = this.playerRank();
      if (!rank || rank === this._shownRank) return;
      const prev = this._shownRank;
      this._shownRank = rank;
      if (!prev) return;
      if (!(VF.UI && VF.UI.toast)) return;
      if (rank === 1 && prev !== 1) VF.UI.toast('你领先全场');
      else if (rank < prev) VF.UI.toast('升至第 ' + rank + ' 名');
      else VF.UI.toast('被超越 · 降至第 ' + rank + ' 名');
    },

    /** 有人即将通关时的紧张感提示（文档 5.2）。 */
    _warnNearFinish: function () {
      const lead = this.ranking()[0];
      if (!lead || lead.isPlayer) return;
      if (lead.level < this.finalLevel()) return;
      if (this._warnedFinisher === lead.id) return;
      this._warnedFinisher = lead.id;
      if (VF.UI && VF.UI.toast) VF.UI.toast(lead.name + ' 即将通关！');
    },

    /* ───────────────────────── clock & outcome ──────────────────────── */

    update: function (dt) {
      if (!this.active) return;

      if (this.ended) {
        if (VF.FfaMarker && VF.FfaMarker.hide) VF.FfaMarker.hide();
        if (VF.WeaponInspect && VF.WeaponInspect.isActive && VF.WeaponInspect.isActive()) return;
        if (this.phaseLeft > 0) {
          this.phaseLeft = Math.max(0, this.phaseLeft - dt);
          if (VF.GgUi && VF.GgUi.syncResultCountdown) {
            VF.GgUi.syncResultCountdown(this.phaseLeft);
          }
          if (this.phaseLeft <= 0) {
            this.active = false;
            if (VF.GgUi && VF.GgUi.hideResult) VF.GgUi.hideResult();
            if (VF.game && VF.game.returnFromMatch) VF.game.returnFromMatch();
          }
        }
        return;
      }

      this._ensureRoster();

      for (let i = this.feed.length - 1; i >= 0; i--) {
        this.feed[i].life -= dt;
        if (this.feed[i].life <= 0) this.feed.splice(i, 1);
      }

      if (this.phase === PHASE_PREP) {
        this.phaseLeft -= dt;
        // 准备阶段也要压住武器，玩家不能带着商城枪进场
        this._enforceWeapons();
        if (this.phaseLeft <= 0) {
          this.phase = PHASE_BATTLE;
          this.phaseLeft = 0;
          this._shownRank = this.playerRank();
          if (VF.UI && VF.UI.toast) VF.UI.toast('战斗开始');
          if (VF.Audio) VF.Audio.play('confirm');
        }
        if (VF.GgUi && VF.GgUi.sync) VF.GgUi.sync(this);
        return;
      }

      if (this.phase === PHASE_BATTLE) {
        this._clock += dt;
        this.timeLeft = Math.max(0, this.timeLeft - dt);
        this._enforceWeapons();
        this._trackDwell(dt);
        if (VF.FfaMarker && VF.FfaMarker.sync) VF.FfaMarker.sync(dt);
        if (this.timeLeft <= 0) this._onTimeExpired();
      }

      if (VF.GgUi && VF.GgUi.sync) VF.GgUi.sync(this);
    },

    _enforceWeapons: function () {
      const me = this.stats.player;
      if (me) this._applyPlayerWeapon(me.level, false);
      this._trackRespawn();
      this._enforceAiWeapons();
    },

    /** 复活即满弹：文档 4.2 要求弹药充足，绝不能因为缺弹卡在某一级。 */
    _trackRespawn: function () {
      const pl = VF.game && VF.game.player;
      if (!pl) return;
      const dead = !!pl.dead;
      if (this._wasDead && !dead) {
        const me = this.stats.player;
        if (me) this.refillAmmo(this.weaponAt(me.level));
      }
      this._wasDead = dead;
    },

    /** 累计每人在各把武器上的停留时长（结算里的「卡关武器」）。 */
    _trackDwell: function (dt) {
      for (const id in this.stats) {
        if (!Object.prototype.hasOwnProperty.call(this.stats, id)) continue;
        const row = this.stats[id];
        const w = this.weaponAt(row.level);
        row.dwell[w] = (row.dwell[w] || 0) + dt;
      }
    },

    /** 时限到：等级最高者胜，同级比先到（文档 九）。 */
    _onTimeExpired: function () {
      const leader = this.ranking()[0];
      if (leader) this.end(leader.id, '时间到 · 武器等级第一');
      else this.end(null, '时间到');
    },

    forceEnd: function (winnerId, reason) {
      this.end(winnerId || null, reason || '对局结束');
    },

    end: function (winnerId, reason) {
      if (this.ended) return;
      this.ended = true;
      this.winner = winnerId || null;
      this.endReason = reason || '';
      this.phase = PHASE_RESULT;
      this.phaseLeft = params().resultTime != null ? params().resultTime : 15;

      const won = winnerId === 'player';

      if (VF.game) VF.game.running = false;
      if (VF.Economy && VF.Economy.grantMatchReward) {
        VF.Economy.grantMatchReward(params().reward || 'tdm', won);
      }
      if (VF.GgUi && VF.GgUi.showResult) VF.GgUi.showResult(this, won);
      else if (VF.UI && VF.UI.showVictory) {
        VF.UI.showVictory(won ? '军械库大师' : '本局结束', this.endReason);
      }
    },

    /* ──────────────────────────── queries ──────────────────────────── */

    /**
     * 排名：等级降序 → 同级先到者靠前 → 再比击杀数（文档 5.3）。
     * 通关者（finishedAt > 0）恒定第一。
     */
    ranking: function () {
      const rows = [];
      for (const id in this.stats) {
        if (Object.prototype.hasOwnProperty.call(this.stats, id)) rows.push(this.stats[id]);
      }
      rows.sort(function (a, b) {
        if (!!b.finishedAt !== !!a.finishedAt) return b.finishedAt ? 1 : -1;
        if (b.level !== a.level) return b.level - a.level;
        if (a.reachedAt !== b.reachedAt) return a.reachedAt - b.reachedAt;
        return b.kills - a.kills;
      });
      return rows;
    },

    playerRank: function () {
      const rows = this.ranking();
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].id === 'player') return i + 1;
      }
      return 0;
    },

    leaderId: function () {
      const rows = this.ranking();
      return rows.length ? rows[0].id : null;
    },

    leaderMarkerOn: function () {
      return !!params().leaderMarker;
    },

    playerStats: function () {
      return this.stats.player || null;
    },

    /** 停留最久的武器名，结算趣味统计用。 */
    stuckWeaponOf: function (row) {
      let best = null;
      let bestT = 0;
      for (const id in row.dwell) {
        if (!Object.prototype.hasOwnProperty.call(row.dwell, id)) continue;
        if (row.dwell[id] > bestT) {
          bestT = row.dwell[id];
          best = id;
        }
      }
      return best ? this.weaponLabel(best) : '—';
    },
  };

  VF.GgMatch = Gg;
})(typeof window !== 'undefined' ? window : globalThis);
