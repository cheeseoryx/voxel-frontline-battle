/**
 * economy.js — Shared lobby currency (前线币) + shop / match loadout
 * Persists in localStorage vf_meta_v1. Match cores/blocks stay separate.
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'vf_meta_v1';
  const DAILY_FIRST_WIN = 50;

  const MATCH_REWARD = {
    pve: { win: 80, lose: 25 },
    pvp: { win: 100, lose: 25 },
  };

  const BLOCK_PACK = 10;
  const BULK_QTY = [10, 50, 100];
  /** First this many coins of tower value are free; excess charges unit prices. */
  const FREE_TOWER_VALUE = 120;
  const CABLE_UNIT = 10;

  /** Placeable tower blocks: id, name, voxel type, color, hits, unit coin price */
  const TOWER_BLOCKS = [
    { id: 'grass', name: '草地', block: 1, color: 0x3d6b2e, hits: 1, unit: 2 },
    { id: 'dirt', name: '泥土', block: 2, color: 0x6b4a2e, hits: 1, unit: 2 },
    { id: 'rubble', name: '废墟', block: 9, color: 0x5a5048, hits: 1, unit: 2 },
    { id: 'stone', name: '石块', block: 3, color: 0x6e7278, hits: 2, unit: 3 },
    { id: 'road', name: '路面', block: 7, color: 0x2a2c30, hits: 2, unit: 3 },
    { id: 'asphalt', name: '沥青', block: 14, color: 0x222428, hits: 2, unit: 3 },
    { id: 'wood', name: '木板', block: 12, color: 0x5a4030, hits: 1, unit: 3 },
    { id: 'plaster', name: '灰泥', block: 11, color: 0xd8d2c4, hits: 1, unit: 3 },
    { id: 'brick', name: '砖块', block: 10, color: 0x8a3a2a, hits: 2, unit: 4 },
    { id: 'rust', name: '锈铁', block: 5, color: 0x8b4518, hits: 2, unit: 4 },
    { id: 'glass', name: '玻璃', block: 13, color: 0x6a9aaa, hits: 1, unit: 4 },
    { id: 'concrete', name: '混凝土', block: 4, color: 0x9a968e, hits: 3, unit: 5 },
    { id: 'metal', name: '金属', block: 6, color: 0x4a5560, hits: 5, unit: 8 },
  ];

  /** Catalog: id → shop item */
  const CATALOG = {
    ak74: {
      id: 'ak74',
      kind: 'weapon',
      name: 'AK-74',
      price: 0,
      weaponId: 'ak74',
      free: true,
      desc: '默认配备 · 5.45×39mm · 热键 1',
    },
    cable: {
      id: 'cable',
      kind: 'cable',
      name: '滑索钢缆',
      price: CABLE_UNIT * BLOCK_PACK,
      unit: CABLE_UNIT,
      pack: BLOCK_PACK,
      stockKey: 'cable',
      desc: '1 条滑索 / 根 · 对局部署时消耗 · 10 币/根',
    },
    core_shard: {
      id: 'core_shard',
      kind: 'material',
      name: '核心碎片',
      price: 55,
      stockKey: 'core_shard',
      desc: '开局消耗：每片 +1 局内部署核（按 5 放塔用，最多 3）',
    },
    pack_blocks: {
      id: 'pack_blocks',
      kind: 'pack',
      name: '建材补给包',
      price: 90,
      stockKey: 'pack_blocks',
      desc: '开局消耗 1：+20 局内掩体格（热键 4，不是仓库方块）',
    },
    pack_cores: {
      id: 'pack_cores',
      kind: 'pack',
      name: '核心补给包',
      price: 120,
      stockKey: 'pack_cores',
      desc: '开局消耗 1：+3 局内部署核（热键 5 放塔）',
    },
    pack_ammo: {
      id: 'pack_ammo',
      kind: 'pack',
      name: '弹药补给包',
      price: 70,
      stockKey: 'pack_ammo',
      desc: '开局消耗 1：已拥有枪备用弹补满',
    },
  };

  TOWER_BLOCKS.forEach(function (b) {
    const hitTxt = b.hits <= 0 ? '打不碎' : b.hits + ' 刀碎';
    CATALOG['blk_' + b.id] = {
      id: 'blk_' + b.id,
      kind: 'block',
      name: b.name,
      price: b.unit * BLOCK_PACK,
      stockKey: b.id,
      pack: BLOCK_PACK,
      unit: b.unit,
      hits: b.hits,
      block: b.block,
      desc: hitTxt + ' · ' + b.unit + ' 币/格 · 可买 10 / 50 / 100 格',
    };
  });

  const MATERIAL_APPLY = {
    core_shard: { cores: 1 },
  };

  const PACK_APPLY = {
    pack_blocks: { blocks: 20 },
    pack_cores: { cores: 3 },
    pack_ammo: { ammo: true },
  };

  const MATERIAL_CAP_PER_MATCH = 3;

  const TOWER_RULES = {
    freeValue: FREE_TOWER_VALUE,
    zipCap: 8,
    cablePerZip: 1,
  };

  function defaultMeta() {
    const stock = {
      cable: 0,
      core_shard: 0,
      pack_blocks: 0,
      pack_cores: 0,
      pack_ammo: 0,
    };
    TOWER_BLOCKS.forEach(function (b) {
      stock[b.id] = 0;
    });
    return {
      coins: 120,
      ownedWeapons: ['ak74'],
      ownedModules: [],
      stock: stock,
      dailyFirstWinDate: '',
      towerTax: 0,
    };
  }

  function normalizeMeta(raw) {
    const d = defaultMeta();
    if (!raw || typeof raw !== 'object') return d;
    const coins = Math.max(0, Math.floor(Number(raw.coins)));
    d.coins = isFinite(coins) ? coins : 120;
    const owned = Array.isArray(raw.ownedWeapons) ? raw.ownedWeapons.slice() : ['ak74'];
    if (owned.indexOf('ak74') < 0) owned.unshift('ak74');
    d.ownedWeapons = owned.filter(function (id, i, arr) {
      return id && arr.indexOf(id) === i;
    });
    const mods = Array.isArray(raw.ownedModules) ? raw.ownedModules.slice() : [];
    d.ownedModules = mods.filter(function (id, i, arr) {
      return id && arr.indexOf(id) === i;
    });
    const st = raw.stock && typeof raw.stock === 'object' ? raw.stock : {};
    Object.keys(d.stock).forEach(function (k) {
      const n = Math.max(0, Math.floor(Number(st[k]) || 0));
      d.stock[k] = isFinite(n) ? n : 0;
    });
    d.dailyFirstWinDate = typeof raw.dailyFirstWinDate === 'string' ? raw.dailyFirstWinDate : '';
    const tax = Math.max(0, Math.floor(Number(raw.towerTax) || 0));
    d.towerTax = isFinite(tax) ? tax : 0;
    return d;
  }

  function getMeta() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultMeta();
      return normalizeMeta(JSON.parse(raw));
    } catch (_) {
      return defaultMeta();
    }
  }

  function saveMeta(meta) {
    const m = normalizeMeta(meta);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(m));
    } catch (_) {}
    return m;
  }

  function getCoins() {
    return getMeta().coins;
  }

  function setCoins(n) {
    const m = getMeta();
    m.coins = Math.max(0, Math.floor(Number(n) || 0));
    saveMeta(m);
    refreshLobbyCoins();
    return m.coins;
  }

  function addCoins(amount) {
    const add = Math.floor(Number(amount) || 0);
    if (!add) return getCoins();
    const m = getMeta();
    m.coins = Math.max(0, m.coins + add);
    saveMeta(m);
    refreshLobbyCoins();
    return m.coins;
  }

  function trySpend(amount) {
    const cost = Math.max(0, Math.floor(Number(amount) || 0));
    const m = getMeta();
    if (m.coins < cost) return false;
    m.coins -= cost;
    saveMeta(m);
    refreshLobbyCoins();
    return true;
  }

  function ownsWeapon(id) {
    return !!id;
  }

  function ownsModule(id) {
    if (!id) return false;
    const m = getMeta();
    return m.ownedModules.indexOf(id) >= 0;
  }

  function zipCap() {
    return TOWER_RULES.zipCap;
  }

  function _blockByVoxel() {
    const B = global.VF && global.VF.BLOCK;
    const map = {};
    TOWER_BLOCKS.forEach(function (b) {
      let id = b.block;
      if (B) {
        if (b.id === 'wood' && B.ROOF != null) id = B.ROOF;
        else {
          const key = b.id.toUpperCase();
          if (B[key] != null) id = B[key];
        }
      }
      map[id] = b;
    });
    return map;
  }

  function listBlockItems() {
    return TOWER_BLOCKS.map(function (b) {
      return CATALOG['blk_' + b.id];
    });
  }

  /**
   * First FREE_TOWER_VALUE coins of placed blocks (stable order) are free.
   * Anything past that is billed at that cell's unit price.
   */
  function _pricedSplit(design) {
    const byVoxel = _blockByVoxel();
    const counts = {};
    const paid = {};
    const paidCoins = {};
    TOWER_BLOCKS.forEach(function (b) {
      counts[b.id] = 0;
      paid[b.id] = 0;
      paidCoins[b.id] = 0;
    });
    let total = 0;
    let value = 0;
    let coinCost = 0;
    let freeLeft = FREE_TOWER_VALUE;
    if (design && design.cells) {
      const have = design.cells;
      let keys = Array.isArray(design.order) ? design.order.slice() : [];
      keys = keys.filter(function (k) {
        return Object.prototype.hasOwnProperty.call(have, k);
      });
      Object.keys(have).forEach(function (k) {
        if (keys.indexOf(k) < 0) keys.push(k);
      });
      design.order = keys;
      for (let i = 0; i < keys.length; i++) {
        const spec = byVoxel[have[keys[i]]];
        if (!spec) continue;
        const price = Math.max(1, spec.unit | 0);
        counts[spec.id] += 1;
        total += 1;
        value += price;
        if (freeLeft >= price) {
          freeLeft -= price;
        } else {
          const charge = price - freeLeft;
          freeLeft = 0;
          coinCost += charge;
          paid[spec.id] += 1;
          paidCoins[spec.id] += charge;
        }
      }
    }
    return {
      counts: counts,
      paid: paid,
      paidCoins: paidCoins,
      total: total,
      value: value,
      coinCost: coinCost,
      freeUsed: FREE_TOWER_VALUE - freeLeft,
      freeCap: FREE_TOWER_VALUE,
      freeLeft: freeLeft,
    };
  }

  /** Old saves deducted stock on 「完成建造」. Give that reservation back once. */
  function releaseDesignReservation(design) {
    if (!design || !design.spent || typeof design.spent !== 'object') return;
    const prev = design.spent;
    const keys = Object.keys(prev);
    if (!keys.length) {
      delete design.spent;
      return;
    }
    const m = getMeta();
    let any = false;
    keys.forEach(function (k) {
      const n = Math.max(0, Math.floor(Number(prev[k]) || 0));
      if (n > 0 && m.stock[k] != null) {
        m.stock[k] += n;
        any = true;
      }
    });
    delete design.spent;
    if (any) {
      saveMeta(m);
      refreshLobbyCoins();
    }
    try {
      localStorage.setItem('vf_custom_tower_v2', JSON.stringify(design));
    } catch (_) {}
  }

  function previewTowerCost(design) {
    const split = _pricedSplit(design);
    const zips = design && design.ziplines ? design.ziplines.length : 0;
    const cap = zipCap();
    const m = getMeta();
    const coins = m.coins || 0;
    const stock = {};
    const avail = {};
    let ok = true;
    let reason = '';
    if (zips > cap) {
      ok = false;
      reason = '滑索超过上限（最多 ' + cap + ' 条）';
    }
    const cableNeed = zips * TOWER_RULES.cablePerZip;
    const cableHave = m.stock.cable || 0;
    stock.cable = cableHave;
    avail.cable = cableHave;
    if (ok && cableNeed > cableHave) {
      ok = false;
      reason = '钢缆不足（需要 ' + cableNeed + '，库存 ' + cableHave + '）· 请先购买滑索';
    }
    TOWER_BLOCKS.forEach(function (b) {
      stock[b.id] = m.stock[b.id] || 0;
      avail[b.id] = m.stock[b.id] || 0;
    });
    const game = global.VF && global.VF.game;
    const alreadyPaid = !!(game && game._towerCoinsCharged && !game._towerUnpaid);
    if (ok && split.coinCost > coins && !alreadyPaid) {
      ok = false;
      reason = '余额不足';
    }
    return {
      ok: ok,
      reason: reason,
      paid: split.paid,
      paidCoins: split.paidCoins,
      counts: split.counts,
      total: split.total,
      value: split.value,
      coinCost: split.coinCost,
      coins: coins,
      freeUsed: split.freeUsed,
      freeCap: split.freeCap,
      stock: stock,
      avail: avail,
      zips: zips,
      zipCap: cap,
      cable: cableNeed,
      availCable: cableHave,
    };
  }

  /** Save blueprint only — stock is consumed when the tower is deployed in a match. */
  function commitTowerDesign(design) {
    if (!design) return { ok: false, reason: '没有蓝图' };
    releaseDesignReservation(design);
    const cost = previewTowerCost(design);
    if (!cost.ok) return { ok: false, reason: cost.reason, cost: cost };
    return { ok: true, design: design, cost: cost };
  }

  function readTowerDesign() {
    const td = global.VF && global.VF.TowerDesigner;
    if (td && td.design && td.design.cells && Object.keys(td.design.cells).length) {
      return td.design;
    }
    try {
      const raw =
        localStorage.getItem('vf_custom_tower_v2') || localStorage.getItem('vf_custom_tower_v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.cells && Object.keys(parsed.cells).length) return parsed;
      }
    } catch (_) {}
    if (global.VF && global.VF.customTower && global.VF.customTower.cells) {
      return global.VF.customTower;
    }
    return null;
  }

  function towerTaxOf(design) {
    if (!design) return 0;
    const split = _pricedSplit(design);
    return split.coinCost || 0;
  }

  /** Stamp current excess onto the blueprint + meta so match start can bill it. */
  function syncTowerTax(design) {
    design = design || readTowerDesign();
    const tax = towerTaxOf(design);
    if (design) design.coinCost = tax;
    const m = getMeta();
    m.towerTax = tax;
    saveMeta(m);
    refreshLobbyCoins();
    return tax;
  }

  /** Charge excess tower coins once when the match starts (not only if they press 5). */
  function chargeTowerForMatch(design) {
    const game = global.VF && global.VF.game;
    if (game && game._towerCoinsCharged) return { ok: true, skipped: true };
    design = design || readTowerDesign();
    let need = towerTaxOf(design);
    if (!need) {
      const stored = getMeta().towerTax || 0;
      if (stored > 0) need = stored;
    }
    if (design && (design.coinCost | 0) > need) need = design.coinCost | 0;
    if (need > 0) {
      if (!trySpend(need)) {
        if (game) {
          game._towerCoinsCharged = true;
          game._towerUnpaid = true;
        }
        if (global.VF.UI && global.VF.UI.toast) {
          global.VF.UI.toast('余额不足（本局防御塔需 ' + need + ' 前线币）');
        }
        return { ok: false, reason: '余额不足' };
      }
      if (global.VF.UI && global.VF.UI.toast) {
        global.VF.UI.toast('本局防御塔超出 · 已扣 ' + need + ' 前线币');
      }
      if (game) {
        game._towerCoinsCharged = true;
        game._towerUnpaid = false;
      }
      return { ok: true, coinCost: need };
    }
    // Only lock the bill if we actually saw a blueprint (under quota = 0 is fine)
    if (game && design) {
      game._towerCoinsCharged = true;
      game._towerUnpaid = false;
    }
    return { ok: true, coinCost: 0 };
  }

  /** Deduct cables on deploy. Coins were already taken at match start. */
  function consumeTowerDeploy(design) {
    const game = global.VF && global.VF.game;
    if (game && game._towerUnpaid) {
      return { ok: false, reason: '余额不足' };
    }
    if (!game || !game._towerCoinsCharged) {
      const billed = chargeTowerForMatch(design);
      if (!billed.ok) {
        return { ok: false, reason: billed.reason || '余额不足', cost: billed.cost };
      }
    }
    const cost = previewTowerCost(design);
    if (cost.zips > cost.zipCap) {
      return { ok: false, reason: cost.reason || '滑索超过上限', cost: cost };
    }
    if (cost.cable > (cost.availCable || 0)) {
      return { ok: false, reason: cost.reason || '钢缆不足', cost: cost };
    }
    if (cost.cable) {
      const m = getMeta();
      m.stock.cable = Math.max(0, (m.stock.cable || 0) - cost.cable);
      saveMeta(m);
      refreshLobbyCoins();
    }
    return { ok: true, cost: cost };
  }

  function todayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + mo + '-' + day;
  }

  /**
   * Grant end-of-match coins once per game.
   * @returns {{ total: number, base: number, daily: number, won: boolean }|null}
   */
  function grantMatchReward(mode, won) {
    const game = global.VF && global.VF.game;
    if (game && game._coinGranted) return null;
    if (game) game._coinGranted = true;

    const table = MATCH_REWARD[mode] || MATCH_REWARD.pve;
    const base = won ? table.win : table.lose;
    let daily = 0;
    if (won) {
      const m = getMeta();
      const today = todayStr();
      if (m.dailyFirstWinDate !== today) {
        daily = DAILY_FIRST_WIN;
        m.dailyFirstWinDate = today;
        saveMeta(m);
      }
    }
    const total = base + daily;
    if (total > 0) addCoins(total);
    else refreshLobbyCoins();

    return { total: total, base: base, daily: daily, won: !!won };
  }

  function buy(itemId, qty) {
    const item = CATALOG[itemId];
    if (!item) {
      return { ok: false, reason: '未知商品' };
    }
    if (item.kind === 'weapon') {
      if (item.free || ownsWeapon(item.weaponId)) {
        return { ok: false, reason: '已拥有 ' + item.name };
      }
      if (!trySpend(item.price)) {
        return { ok: false, reason: '前线币不足（需要 ' + item.price + '）' };
      }
      const m = getMeta();
      if (m.ownedWeapons.indexOf(item.weaponId) < 0) m.ownedWeapons.push(item.weaponId);
      saveMeta(m);
      refreshLobbyCoins();
      return { ok: true, item: item };
    }
    if (item.kind === 'module') {
      if (ownsModule(item.moduleId)) {
        return { ok: false, reason: '已拥有 ' + item.name };
      }
      if (!trySpend(item.price)) {
        return { ok: false, reason: '前线币不足（需要 ' + item.price + '）' };
      }
      const m = getMeta();
      if (m.ownedModules.indexOf(item.moduleId) < 0) m.ownedModules.push(item.moduleId);
      saveMeta(m);
      refreshLobbyCoins();
      return { ok: true, item: item };
    }
    if (item.kind === 'block' || item.kind === 'cable') {
      const add = Math.max(1, Math.floor(Number(qty) || item.pack || BLOCK_PACK));
      const cost = (item.unit || 0) * add;
      if (!trySpend(cost)) {
        return { ok: false, reason: '前线币不足（需要 ' + cost + '）' };
      }
      const m = getMeta();
      m.stock[item.stockKey] = (m.stock[item.stockKey] || 0) + add;
      saveMeta(m);
      refreshLobbyCoins();
      return { ok: true, item: item, stock: m.stock[item.stockKey], qty: add, spent: cost };
    }
    if (item.kind === 'material' || item.kind === 'pack') {
      if (!trySpend(item.price)) {
        return { ok: false, reason: '前线币不足（需要 ' + item.price + '）' };
      }
      const m = getMeta();
      m.stock[item.stockKey] = (m.stock[item.stockKey] || 0) + 1;
      saveMeta(m);
      refreshLobbyCoins();
      return { ok: true, item: item, stock: m.stock[item.stockKey] };
    }
    return { ok: false, reason: '无法购买' };
  }

  /** Consume leftover supply packs / shards at match start. */
  function applyMatchLoadout(player, weapons) {
    if (!player) return;
    const m = getMeta();
    let changed = false;
    let blocksGain = 0;
    let coresGain = 0;
    const game = global.VF && global.VF.game;
    if (game) game._towerGunArmed = false;
    if (ownsModule('mod_gun') && (m.stock.core_shard || 0) > 0) {
      m.stock.core_shard -= 1;
      changed = true;
      if (game) game._towerGunArmed = true;
    }

    Object.keys(MATERIAL_APPLY).forEach(function (key) {
      const have = m.stock[key] || 0;
      const use = Math.min(MATERIAL_CAP_PER_MATCH, have);
      if (use <= 0) return;
      m.stock[key] = have - use;
      changed = true;
      const fx = MATERIAL_APPLY[key];
      if (fx.blocks) blocksGain += fx.blocks * use;
      if (fx.cores) coresGain += fx.cores * use;
    });

    Object.keys(PACK_APPLY).forEach(function (key) {
      const have = m.stock[key] || 0;
      if (have <= 0) return;
      m.stock[key] = have - 1;
      changed = true;
      const fx = PACK_APPLY[key];
      if (fx.blocks) blocksGain += fx.blocks;
      if (fx.cores) coresGain += fx.cores;
      if (fx.ammo && weapons && weapons.state) {
        const defs = global.VF && global.VF.WEAPONS;
        const ids = (global.VF && global.VF.WEAPON_LOADOUT_ORDER) || ['ak74'];
        ids.forEach(function (wid) {
          if (!ownsWeapon(wid)) return;
          const st = weapons.state[wid];
          if (!st) return;
          if (typeof weapons.addReserve === 'function') {
            weapons.addReserve(wid, 999);
          }
          if (defs && defs[wid] && defs[wid].reserve != null) {
            st.reserve = Math.max(st.reserve || 0, defs[wid].reserve);
          }
        });
      }
    });

    if (blocksGain) player.blocks = (player.blocks || 0) + blocksGain;
    if (coresGain) player.cores = (player.cores || 0) + coresGain;
    if (changed) saveMeta(m);
    // After stock write — never reuse stale `m.coins` or a later save would undo the bill
    chargeTowerForMatch();

    if (global.VF.UI && global.VF.UI.updateResources) {
      global.VF.UI.updateResources(player.cores, player.blocks);
    }
    if (changed && global.VF.UI && global.VF.UI.toast) {
      const bits = [];
      if (coresGain) bits.push('+' + coresGain + ' 部署核');
      if (blocksGain) bits.push('+' + blocksGain + ' 掩体格');
      if (bits.length) global.VF.UI.toast('本局补给：' + bits.join(' · '));
    }
  }

  function refreshLobbyCoins() {
    const el = document.getElementById('lobby-coin-num');
    if (el) el.textContent = String(getCoins());
  }

  function formatRewardLine(result) {
    if (!result) return '';
    const parts = [];
    if (result.base > 0) parts.push('+' + result.base + ' 前线币');
    if (result.daily > 0) parts.push('每日首胜 +' + result.daily);
    if (!parts.length) return result.won ? '' : '失败无前线币奖励';
    return parts.join(' · ');
  }

  function renderShopHtml() {
    const m = getMeta();
    function row(item) {
      let status = '';
      let disabled = false;
      if (item.kind === 'weapon') {
        if (item.free || ownsWeapon(item.weaponId)) {
          status = '已拥有';
          disabled = true;
        } else {
          status = item.price + ' 前线币';
        }
      } else if (item.kind === 'module') {
        if (ownsModule(item.moduleId)) {
          status = '已拥有';
          disabled = true;
        } else {
          status = item.price + ' 前线币';
        }
      } else if (item.kind === 'block' || item.kind === 'cable') {
        const n = m.stock[item.stockKey] || 0;
        const unit = item.unit || 0;
        const unitName = item.kind === 'cable' ? '根' : '格';
        const bulk = BULK_QTY.map(function (q) {
          return (
            '<button type="button" class="econ-bulk-btn" data-econ-buy="' +
            item.id +
            '" data-econ-qty="' +
            q +
            '">买 ' +
            q +
            unitName +
            ' · ' +
            unit * q +
            ' 币</button>'
          );
        }).join('');
        return (
          '<div class="econ-shop-item econ-shop-bulk">' +
          '<strong>' +
          item.name +
          '</strong>' +
          '<span>库存 ' +
          n +
          ' · ' +
          unit +
          ' 币/' +
          unitName +
          '</span>' +
          '<em>' +
          item.desc +
          '</em>' +
          '<div class="econ-bulk-row">' +
          bulk +
          '</div></div>'
        );
      } else {
        const n = m.stock[item.stockKey] || 0;
        status = item.price + ' 币 · 库存 ' + n;
      }
      return (
        '<button type="button" class="econ-shop-item' +
        (disabled ? ' is-owned' : '') +
        '" data-econ-buy="' +
        item.id +
        '"' +
        (disabled ? ' disabled' : '') +
        '>' +
        '<strong>' +
        item.name +
        '</strong>' +
        '<span>' +
        status +
        '</span>' +
        '<em>' +
        item.desc +
        '</em>' +
        '</button>'
      );
    }
    const weapons = [CATALOG.ak74].map(row).join('');
    const mats = listBlockItems().concat([CATALOG.cable]).map(row).join('');
    const packs = [CATALOG.core_shard, CATALOG.pack_blocks, CATALOG.pack_cores, CATALOG.pack_ammo]
      .map(row)
      .join('');
    return (
      '<p class="econ-shop-bal">余额 <b id="econ-shop-bal">' +
      m.coins +
      '</b> 前线币 · PVE/PVP 胜利可获得</p>' +
      '<p class="econ-shop-sec">武器</p><div class="econ-shop-list">' +
      weapons +
      '</div>' +
      '<p class="econ-shop-sec">方块建材</p><div class="econ-shop-list">' +
      mats +
      '</div>' +
      '<p class="econ-shop-sec">补给</p><div class="econ-shop-list">' +
      packs +
      '</div>' +
      '<p class="econ-shop-note">防御塔前 ' +
      FREE_TOWER_VALUE +
      ' 前线币造价免费，超出在进入对局时按方块单价从余额扣；钢缆进仓库，放下滑索时消耗。补给包开局变成局内部署核 / 掩体格 / 弹药。</p>'
    );
  }

  function bindShopClicks(root) {
    if (!root || root._econBound) return;
    root._econBound = true;
    root.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-econ-buy]');
      if (!btn || !root.contains(btn)) return;
      const id = btn.getAttribute('data-econ-buy');
      const qtyAttr = btn.getAttribute('data-econ-qty');
      const res = buy(id, qtyAttr ? Number(qtyAttr) : undefined);
      if (!res.ok) {
        if (global.VF.UI && global.VF.UI.toast) global.VF.UI.toast(res.reason || '购买失败');
        return;
      }
      if (global.VF.UI && global.VF.UI.toast) {
        const qtxt = res.qty ? res.qty + (res.item && res.item.kind === 'cable' ? ' 根' : ' 格') : '';
        global.VF.UI.toast(
          '已购买 ' + (res.item && res.item.name ? res.item.name : id) + (qtxt ? ' ×' + qtxt : '')
        );
      }
      if (global.VF.Lobby && typeof global.VF.Lobby.refreshShopSheet === 'function') {
        global.VF.Lobby.refreshShopSheet();
      } else {
        const body = document.getElementById('lobby-sheet-body');
        if (body && body.querySelector('[data-econ-buy]')) {
          body.innerHTML = renderShopHtml();
          const bal = document.getElementById('econ-shop-bal');
          if (bal) bal.textContent = String(getCoins());
        }
      }
      if (global.VF.Hub && typeof global.VF.Hub.refreshCraftLists === 'function') {
        global.VF.Hub.refreshCraftLists();
      }
    });
  }

  global.VF = global.VF || {};
  global.VF.Economy = {
    CATALOG: CATALOG,
    MATCH_REWARD: MATCH_REWARD,
    getMeta: getMeta,
    saveMeta: saveMeta,
    getCoins: getCoins,
    setCoins: setCoins,
    addCoins: addCoins,
    trySpend: trySpend,
    ownsWeapon: ownsWeapon,
    ownsModule: ownsModule,
    zipCap: zipCap,
    previewTowerCost: previewTowerCost,
    commitTowerDesign: commitTowerDesign,
    consumeTowerDeploy: consumeTowerDeploy,
    chargeTowerForMatch: chargeTowerForMatch,
    syncTowerTax: syncTowerTax,
    readTowerDesign: readTowerDesign,
    releaseDesignReservation: releaseDesignReservation,
    listBlockItems: listBlockItems,
    BULK_QTY: BULK_QTY,
    TOWER_BLOCKS: TOWER_BLOCKS,
    TOWER_RULES: TOWER_RULES,
    buy: buy,
    grantMatchReward: grantMatchReward,
    applyMatchLoadout: applyMatchLoadout,
    refreshLobbyCoins: refreshLobbyCoins,
    formatRewardLine: formatRewardLine,
    renderShopHtml: renderShopHtml,
    bindShopClicks: bindShopClicks,
  };

  // Show persisted 前线币 as soon as the lobby DOM is ready
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', refreshLobbyCoins);
    } else {
      refreshLobbyCoins();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
