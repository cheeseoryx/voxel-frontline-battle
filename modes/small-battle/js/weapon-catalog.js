/**
 * weapon-catalog.js — Guns ported from the large-battlefield build.
 *
 * The battlefield catalog was authored on its own scale (25–42 damage, 300m
 * falloff, 3.4–6.7s reloads). Those numbers fight with our AKM/870/SVD anchors,
 * so every gun here is re-tuned onto our scale while keeping the battlefield
 * strength ordering: SCAR-H still hits hardest, HK419 is still the fastest AR,
 * P90 still carries the biggest magazine.
 *
 * Gameplay fields (damage / fireRate-in-seconds / spread / recoil / range) are
 * the source of truth. The 16 inspect-panel stats are derived from them at the
 * bottom of gun(), so the loadout screen can never disagree with what the gun
 * actually does.
 *
 * Slots follow our existing hotbar rather than the battlefield's arsenal:
 *   1 主武器 (assault / carbine / smg / lmg / dmr / sniper)
 *   2 副武器 (shotgun / pistol)
 *   3 近战
 */
(function (global) {
  'use strict';

  /** Same constants the battlefield build uses, so ported feel carries over. */
  const RECOIL_KICK_SCALE = 0.048;
  const ACCURACY_SPREAD_MAX = 0.12;

  /**
   * Build a full weapon def from the gameplay-facing spec, deriving the
   * inspect-panel stats that the arsenal screen shows.
   */
  function gun(spec) {
    const def = Object.assign(
      {
        slot: 1,
        pellets: 1,
        automatic: true,
        adsRecoilMul: 0.4,
        reserve: spec.magSize * 5,
        ammoColor: 0xffaa44,
        ammoLabel: spec.name,
        minDamageScale: 0.5,
        ported: true,
      },
      spec
    );

    // --- 16 inspect-panel stats, derived so the panel matches real behaviour ---
    def.rpm = Math.round(60 / def.fireRate);
    def.accuracy = +((1 - def.spread / ACCURACY_SPREAD_MAX) * 100).toFixed(2);
    def.verticalRecoil = +(def.recoil / RECOIL_KICK_SCALE).toFixed(2);
    def.horizontalRecoil = +(def.verticalRecoil * (spec.horizFactor || 0.55)).toFixed(2);
    def.firstShotRecoil = spec.firstShotRecoil != null ? spec.firstShotRecoil : 1;
    def.playerArmorDamage = spec.playerArmorDamage != null ? spec.playerArmorDamage : 0;
    def.lightArmorDamage = spec.lightArmorDamage != null ? spec.lightArmorDamage : 4;
    def.soundRange = spec.soundRange != null ? spec.soundRange : 600;
    def.muzzleFlash = spec.muzzleFlash != null ? spec.muzzleFlash : 0.4;
    def.control = spec.control != null ? spec.control : 0.85;
    def.adsTime = spec.adsTime != null ? spec.adsTime : 0.25;
    def.runSpeed = spec.runSpeed != null ? spec.runSpeed : 1;
    def.switchSpeed = spec.switchSpeed != null ? spec.switchSpeed : 1;
    delete def.horizFactor;
    return def;
  }

  const CATALOG = {
    // ==================== 突击步枪 ====================
    ak74: gun({
      id: 'ak74',
      model: 'AK-74',
      name: 'AK-74',
      nameZh: 'AK-74',
      caliber: '5.45×39mm',
      category: 'assault',
      modelStyle: 'ak',
      slot: 1,
      // Lighter round than the AKM: a point less per bullet, but faster and calmer.
      damage: 20,
      fireRate: 0.09, // 670 rpm
      magSize: 30,
      reserve: 150,
      spread: 0.0285,
      adsSpread: 0.009,
      range: 95,
      recoil: 0.058,
      reloadTime: 2.1,
      falloffStart: 38,
      falloffEnd: 92,
      minDamageScale: 0.55,
      breakChance: 0.5,
      coreFalloffStart: 18,
      coreFalloffEnd: 48,
      coreMinDamageScale: 0.12,
      coreMaxRange: 60,
      adsFov: 40,
      scope: 'optic',
      adsSens: 0.7,
      muzzleVelocity: 900,
      control: 0.88,
      adsTime: 0.23,
      ammoLabel: 'AK-74',
    }),

    acr: gun({
      id: 'acr',
      model: 'ACR',
      name: 'ACR',
      nameZh: 'ACR',
      caliber: '5.56×45mm',
      category: 'assault',
      modelStyle: 'rifle-modern',
      slot: 1,
      // The control pick: lowest recoil of the assault rifles, least damage.
      damage: 19,
      fireRate: 0.086, // 700 rpm
      magSize: 30,
      reserve: 150,
      spread: 0.03,
      adsSpread: 0.0085,
      range: 98,
      recoil: 0.052,
      reloadTime: 2.0,
      falloffStart: 42,
      falloffEnd: 95,
      minDamageScale: 0.55,
      breakChance: 0.5,
      coreFalloffStart: 18,
      coreFalloffEnd: 48,
      coreMinDamageScale: 0.12,
      coreMaxRange: 60,
      adsFov: 40,
      scope: 'optic',
      adsSens: 0.7,
      muzzleVelocity: 850,
      control: 0.92,
      adsTime: 0.22,
      horizFactor: 0.5,
    }),

    scarh: gun({
      id: 'scarh',
      model: 'SCAR-H',
      name: 'SCAR-H',
      nameZh: 'SCAR-H',
      caliber: '7.62×51mm',
      category: 'assault',
      modelStyle: 'scar',
      slot: 1,
      // Four-shot kill and the longest reach of the ARs, paid for with recoil,
      // a 20-round magazine and the slowest cyclic rate.
      damage: 30,
      fireRate: 0.12, // 500 rpm
      magSize: 20,
      reserve: 120,
      spread: 0.03,
      adsSpread: 0.0095,
      range: 110,
      recoil: 0.082,
      reloadTime: 2.35,
      falloffStart: 50,
      falloffEnd: 105,
      minDamageScale: 0.6,
      breakChance: 0.65,
      coreFalloffStart: 20,
      coreFalloffEnd: 52,
      coreMinDamageScale: 0.12,
      coreMaxRange: 65,
      adsFov: 38,
      scope: 'optic',
      adsSens: 0.66,
      muzzleVelocity: 750,
      control: 0.71,
      adsTime: 0.3,
      runSpeed: 0.95,
      lightArmorDamage: 6,
      horizFactor: 0.7,
    }),

    // ==================== 卡宾枪 ====================
    m4a1: gun({
      id: 'm4a1',
      model: 'M4A1',
      name: 'M4A1',
      nameZh: 'M4A1',
      caliber: '5.56×45mm',
      category: 'carbine',
      modelStyle: 'carbine',
      slot: 1,
      // The all-rounder: nothing outstanding, nothing bad.
      damage: 19,
      fireRate: 0.086, // 700 rpm
      magSize: 30,
      reserve: 150,
      spread: 0.0285,
      adsSpread: 0.0088,
      range: 92,
      recoil: 0.056,
      reloadTime: 1.95,
      falloffStart: 34,
      falloffEnd: 88,
      minDamageScale: 0.5,
      breakChance: 0.5,
      coreFalloffStart: 16,
      coreFalloffEnd: 46,
      coreMinDamageScale: 0.12,
      coreMaxRange: 58,
      adsFov: 42,
      scope: 'optic',
      adsSens: 0.72,
      muzzleVelocity: 880,
      control: 0.86,
      adsTime: 0.24,
    }),

    hk419: gun({
      id: 'hk419',
      model: 'HK419',
      name: 'HK419',
      nameZh: 'HK419',
      caliber: '5.56×45mm',
      category: 'carbine',
      modelStyle: 'rifle-modern',
      slot: 1,
      // Fastest cyclic rate on offer; pays with per-bullet damage and a holo
      // sight instead of glass, so it stays a close-to-mid pick.
      damage: 18,
      fireRate: 0.073, // 825 rpm
      magSize: 30,
      reserve: 150,
      spread: 0.027,
      adsSpread: 0.014,
      range: 88,
      recoil: 0.058,
      reloadTime: 2.05,
      falloffStart: 32,
      falloffEnd: 85,
      minDamageScale: 0.5,
      breakChance: 0.5,
      coreFalloffStart: 16,
      coreFalloffEnd: 44,
      coreMinDamageScale: 0.12,
      coreMaxRange: 56,
      adsFov: 44,
      scope: 'holo',
      adsSens: 0.75,
      muzzleVelocity: 800,
      control: 0.86,
      adsTime: 0.24,
      horizFactor: 0.65,
    }),

    // ==================== 冲锋枪 ====================
    mp7: gun({
      id: 'mp7',
      model: 'MP7',
      name: 'MP7',
      nameZh: 'MP7',
      caliber: '4.6×30mm',
      category: 'smg',
      modelStyle: 'smg-compact',
      slot: 1,
      damage: 15,
      fireRate: 0.071, // 850 rpm
      magSize: 30,
      reserve: 180,
      spread: 0.033,
      adsSpread: 0.016,
      range: 55,
      recoil: 0.042,
      reloadTime: 1.8,
      falloffStart: 18,
      falloffEnd: 48,
      minDamageScale: 0.4,
      breakChance: 0.35,
      coreFalloffStart: 10,
      coreFalloffEnd: 30,
      coreMinDamageScale: 0.1,
      coreMaxRange: 40,
      adsFov: 48,
      scope: 'holo',
      adsSens: 0.82,
      muzzleVelocity: 720,
      control: 0.95,
      adsTime: 0.17,
      runSpeed: 1.1,
      lightArmorDamage: 0,
      ammoColor: 0xffcc66,
    }),

    p90: gun({
      id: 'p90',
      model: 'P90',
      name: 'P90',
      nameZh: 'P90',
      caliber: '5.7×28mm',
      category: 'smg',
      modelStyle: 'p90',
      slot: 1,
      // 50 rounds and almost no recoil; the trade is per-bullet damage.
      damage: 16,
      fireRate: 0.075, // 800 rpm
      magSize: 50,
      reserve: 200,
      spread: 0.03,
      adsSpread: 0.015,
      range: 60,
      recoil: 0.038,
      reloadTime: 2.4,
      falloffStart: 20,
      falloffEnd: 52,
      minDamageScale: 0.42,
      breakChance: 0.35,
      coreFalloffStart: 10,
      coreFalloffEnd: 32,
      coreMinDamageScale: 0.1,
      coreMaxRange: 42,
      adsFov: 48,
      scope: 'holo',
      adsSens: 0.8,
      muzzleVelocity: 715,
      control: 0.94,
      adsTime: 0.2,
      runSpeed: 1.05,
      lightArmorDamage: 8,
      ammoColor: 0xffcc66,
      horizFactor: 0.7,
    }),

    mp5: gun({
      id: 'mp5',
      model: 'MP5',
      name: 'MP5',
      nameZh: 'MP5',
      caliber: '9×19mm',
      category: 'smg',
      modelStyle: 'smg',
      slot: 1,
      // Best SMG time-to-kill, standard magazine, quickest reload of the three.
      damage: 17,
      fireRate: 0.075, // 800 rpm
      magSize: 30,
      reserve: 180,
      spread: 0.032,
      adsSpread: 0.014,
      range: 58,
      recoil: 0.04,
      reloadTime: 1.9,
      falloffStart: 20,
      falloffEnd: 50,
      minDamageScale: 0.4,
      breakChance: 0.35,
      coreFalloffStart: 10,
      coreFalloffEnd: 30,
      coreMinDamageScale: 0.1,
      coreMaxRange: 40,
      adsFov: 48,
      scope: 'holo',
      adsSens: 0.82,
      muzzleVelocity: 700,
      control: 1,
      adsTime: 0.2,
      runSpeed: 1.05,
      lightArmorDamage: 0,
      ammoColor: 0xffcc66,
    }),

    // ==================== 轻机枪 ====================
    m249: gun({
      id: 'm249',
      model: 'M249',
      name: 'M249',
      nameZh: 'M249',
      caliber: '5.56×45mm',
      category: 'lmg',
      modelStyle: 'lmg-belt',
      slot: 1,
      // 100-round belt and real suppression, walled off by awful hipfire, the
      // slowest ADS in the game and a reload you have to plan around.
      damage: 20,
      fireRate: 0.086, // 700 rpm
      magSize: 100,
      reserve: 200,
      spread: 0.042,
      adsSpread: 0.013,
      range: 100,
      recoil: 0.055,
      reloadTime: 3.6,
      falloffStart: 40,
      falloffEnd: 95,
      minDamageScale: 0.55,
      breakChance: 0.6,
      coreFalloffStart: 18,
      coreFalloffEnd: 50,
      coreMinDamageScale: 0.12,
      coreMaxRange: 62,
      adsFov: 42,
      scope: 'holo',
      adsSens: 0.68,
      muzzleVelocity: 900,
      control: 0.29,
      adsTime: 0.42,
      runSpeed: 0.88,
      switchSpeed: 0.75,
      lightArmorDamage: 6,
      horizFactor: 0.85,
    }),

    // ==================== 精确射手步枪 ====================
    mk14ebr: gun({
      id: 'mk14ebr',
      model: 'MK14 EBR',
      name: 'MK14 EBR',
      nameZh: 'MK14 EBR',
      caliber: '7.62×51mm',
      category: 'dmr',
      modelStyle: 'dmr-long',
      slot: 1,
      // Two body shots or one headshot (56 × 1.8 = 100.8). Deliberately kept
      // to ~190 rpm and 120m: any faster or longer and it simply replaces the
      // SVD, which also two-taps bodies and one-taps heads.
      damage: 56,
      fireRate: 0.3,
      magSize: 14,
      reserve: 84,
      spread: 0.018,
      adsSpread: 0.004,
      range: 120,
      recoil: 0.075,
      reloadTime: 2.3,
      automatic: false,
      falloffStart: 45,
      falloffEnd: 110,
      minDamageScale: 0.6,
      breakChance: 0.8,
      coreFalloffStart: 20,
      coreFalloffEnd: 50,
      coreMinDamageScale: 0.1,
      coreMaxRange: 65,
      adsFov: 30,
      scope: 'optic',
      adsSens: 0.55,
      adsRecoilMul: 0.35,
      muzzleVelocity: 850,
      control: 0.8,
      adsTime: 0.28,
      runSpeed: 0.94,
      switchSpeed: 0.9,
      lightArmorDamage: 10,
      ammoColor: 0x66aaff,
      horizFactor: 0.6,
    }),

    // ==================== 狙击枪 ====================
    m200: gun({
      id: 'm200',
      model: 'M200',
      name: 'M200',
      nameZh: 'M200 拦截者',
      caliber: '.408 CheyTac',
      category: 'sniper',
      modelStyle: 'sniper-heavy',
      slot: 1,
      // The only guaranteed one-shot body kill, gated behind a 1.35s bolt
      // cycle, 7 rounds and the slowest ADS of any scoped gun.
      damage: 110,
      fireRate: 1.35,
      magSize: 7,
      reserve: 35,
      // Never let accuracy hit 100 — a zero-spread hipfire laser is not a sniper.
      spread: 0.03,
      adsSpread: 0.0008,
      range: 220,
      recoil: 0.096,
      reloadTime: 3.0,
      automatic: false,
      falloffStart: 90,
      falloffEnd: 200,
      minDamageScale: 0.8,
      breakChance: 1,
      coreFalloffStart: 22,
      coreFalloffEnd: 55,
      coreMinDamageScale: 0.1,
      coreMaxRange: 70,
      adsFov: 14,
      scope: 'sniper',
      adsSens: 0.35,
      adsRecoilMul: 0.3,
      muzzleVelocity: 1400,
      control: 0.4,
      adsTime: 0.45,
      runSpeed: 0.85,
      switchSpeed: 0.8,
      lightArmorDamage: 15,
      heavyArmorDamage: 5,
      soundRange: 2000,
      muzzleFlash: 1,
      ammoColor: 0x66aaff,
      ammoLabel: 'M200',
      horizFactor: 0.45,
    }),

    // ==================== 手枪 ====================
    usp: gun({
      id: 'usp',
      model: 'USP',
      name: 'USP',
      nameZh: 'USP',
      caliber: '.45 ACP',
      category: 'pistol',
      modelStyle: 'pistol',
      slot: 2,
      damage: 26,
      // ~440 rpm: a semi-auto's real ceiling is the trigger finger, and 545
      // rpm only inflated the paper DPS.
      fireRate: 0.135,
      magSize: 15,
      reserve: 60,
      spread: 0.0315,
      adsSpread: 0.019,
      range: 45,
      recoil: 0.034,
      reloadTime: 1.5,
      automatic: false,
      falloffStart: 15,
      falloffEnd: 40,
      minDamageScale: 0.35,
      breakChance: 0.4,
      coreFalloffStart: 10,
      coreFalloffEnd: 30,
      coreMinDamageScale: 0.1,
      coreMaxRange: 40,
      adsFov: 55,
      scope: 'holo',
      adsSens: 0.9,
      muzzleVelocity: 320,
      control: 1,
      adsTime: 0.12,
      runSpeed: 1.12,
      switchSpeed: 2,
      lightArmorDamage: 0,
      ammoColor: 0xffdd88,
      horizFactor: 0.6,
    }),
  };

  /** Arsenal tab order. Category → the guns shown under it, in listing order. */
  const CATEGORY_ORDER = ['assault', 'carbine', 'smg', 'lmg', 'dmr', 'sniper', 'shotgun', 'pistol'];

  const CATEGORY_LABEL = {
    assault: '突击步枪',
    carbine: '卡宾枪',
    smg: '冲锋枪',
    lmg: '轻机枪',
    dmr: '精确射手',
    sniper: '狙击枪',
    shotgun: '霰弹枪',
    pistol: '手枪',
  };

  /** Which hotbar slot each category feeds. Mirrors the `slot` field above. */
  const CATEGORY_SLOT = {
    assault: 1,
    carbine: 1,
    smg: 1,
    lmg: 1,
    dmr: 3,
    sniper: 3,
    shotgun: 2,
    pistol: 2,
  };

  const LOADOUT_ORDER = [
    'ak74', 'acr', 'scarh',
    'm4a1', 'hk419',
    'mp7', 'p90', 'mp5',
    'm249',
    'mk14ebr',
    'm200',
    'usp',
  ];

  global.VF = global.VF || {};
  global.VF.WEAPON_CATALOG = CATALOG;
  global.VF.WEAPON_LOADOUT_ORDER = LOADOUT_ORDER;
  global.VF.WEAPON_CATEGORY_ORDER = CATEGORY_ORDER;
  global.VF.WEAPON_CATEGORY_LABEL = CATEGORY_LABEL;
  global.VF.WEAPON_CATEGORY_SLOT = CATEGORY_SLOT;
})(window);
