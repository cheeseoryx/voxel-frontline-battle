/**
 * weapon-catalog.js — Inspect-panel guns transcribed from battleweapon screenshots.
 * Stats follow the 16 base fields; bolt snipers also store heavyArmorDamage + boltSpeed.
 */
(function (global) {
  'use strict';

  function gun(id, name, category, style, mag, row, extra) {
    extra = extra || {};
    const automatic = extra.automatic != null ? extra.automatic : true;
    const fireRate = extra.boltSpeed != null ? 60 / Math.max(0.2, extra.boltSpeed) : row[8];
    const falloffStart = extra.falloffStart != null ? extra.falloffStart : 120;
    const falloffEnd = extra.falloffEnd != null ? extra.falloffEnd : 300;
    const minDamage =
      extra.minDamage != null ? extra.minDamage : Math.max(1, +(row[0] * 0.35).toFixed(1));
    const def = {
      id: id,
      model: name,
      name: name,
      nameZh: name,
      category: category,
      modelStyle: style,
      caliber: extra.caliber || '',
      slot: extra.slot != null ? extra.slot : 1,
      magSize: mag,
      reserve: extra.reserve != null ? extra.reserve : mag * 5,
      damage: row[0],
      playerArmorDamage: row[1],
      lightArmorDamage: row[2],
      verticalRecoil: row[3],
      horizontalRecoil: row[4],
      firstShotRecoil: row[5],
      muzzleVelocity: row[6],
      accuracy: row[7],
      fireRate: fireRate,
      soundRange: row[9],
      muzzleFlash: row[10],
      control: row[11],
      adsTime: row[12],
      runSpeed: row[13],
      reloadTime: row[14],
      switchSpeed: row[15],
      damageType: extra.damageType || 'bullet',
      automatic: automatic,
      pellets: extra.pellets != null ? extra.pellets : 1,
      adsRecoilMul: extra.adsRecoilMul != null ? extra.adsRecoilMul : 0.4,
      adsFov: extra.adsFov != null ? extra.adsFov : 42,
      adsSens: extra.adsSens != null ? extra.adsSens : 0.75,
      scope: extra.scope || 'holo',
      range: extra.range != null ? extra.range : Math.max(falloffEnd, Math.round(row[6] * 0.2)),
      falloffStart: falloffStart,
      falloffEnd: falloffEnd,
      minDamage: minDamage,
      ammoColor: extra.ammoColor != null ? extra.ammoColor : 0xffaa44,
      ammoLabel: extra.ammoLabel || name,
      soundProfile: extra.soundProfile || id,
      screenshot: true,
      unlockFree: extra.unlockFree !== false,
    };
    if (extra.heavyArmorDamage != null) def.heavyArmorDamage = extra.heavyArmorDamage;
    if (extra.boltSpeed != null) {
      def.boltSpeed = extra.boltSpeed;
      def.automatic = false;
    }
    return def;
  }

  const CATALOG = {
    acr: gun('acr', 'ACR', 'assault', 'rifle-modern', 30, [28, 0, 4, 1.3, 0.7, 1, 650, 72.5, 700, 600, 0.4, 0.87, 0.18, 1.05, 3.39, 1], { caliber: '5.56×45mm', falloffStart: 200, falloffEnd: 300, minDamage: 9.8, scope: 'optic' }),
    ak74: gun('ak74', 'AK-74', 'assault', 'ak', 30, [32, 0, 6, 1.4, 0.8, 1, 720, 76.25, 670, 600, 0.5, 0.79, 0.23, 1, 3.64, 1], { caliber: '5.45×39mm', scope: 'optic' }),
    auga3: gun('auga3', 'AUG A3', 'assault', 'bullpup', 30, [31, 0, 6, 1.2, 0.8, 1, 900, 90, 600, 600, 0.6, 0.86, 0.15, 1, 2.83, 1], { caliber: '5.56×45mm', scope: 'optic' }),
    famas: gun('famas', 'FAMAS', 'assault', 'bullpup', 25, [26, 0, 4, 1.4, 0.9, 1, 640, 71.25, 900, 600, 0.5, 0.9, 0.2, 1, 3.07, 1], { caliber: '5.56×45mm' }),
    sg550: gun('sg550', 'SG550', 'assault', 'rifle-long', 30, [29, 0, 5, 0.9, 1.1, 1, 680, 83.75, 670, 600, 0.6, 0.86, 0.15, 1, 3.3, 1], { caliber: '5.56×45mm', scope: 'optic' }),
    f2000: gun('f2000', 'F2000', 'assault', 'bullpup', 35, [24, 0, 6, 1, 0.6, 1, 710, 76.25, 850, 600, 0.5, 1, 0.15, 1, 3.51, 1], { caliber: '5.56×45mm' }),
    ak15: gun('ak15', 'AK15', 'battle', 'ak', 24, [40, 0, 6, 1.6, 2.1, 1, 750, 75, 540, 600, 0.6, 0.71, 0.3, 0.95, 3.93, 1], { caliber: '7.62×39mm', scope: 'optic' }),
    scarh: gun('scarh', 'SCAR-H', 'assault', 'scar', 20, [42, 0, 6, 1.6, 2.1, 1, 750, 75, 500, 600, 0.6, 0.71, 0.2, 0.95, 4, 1], { caliber: '7.62×51mm', falloffStart: 200, falloffEnd: 300, minDamage: 14.7, scope: 'optic' }),
    fal: gun('fal', 'FAL', 'battle', 'fal', 20, [40, 0, 4, 1.5, 2.2, 1, 600, 75, 650, 600, 0.5, 0.71, 0.22, 1, 3.37, 1], { caliber: '7.62×51mm' }),
    g3: gun('g3', 'G3', 'battle', 'g3', 20, [37, 0, 8, 1.5, 1.2, 1, 800, 83.75, 500, 600, 0.5, 0.71, 0.3, 0.95, 4.2, 1], { caliber: '7.62×51mm' }),
    g36c: gun('g36c', 'G36C', 'carbine', 'carbine', 30, [31, 0, 5, 1.45, 0.8, 1, 660, 72.5, 750, 600, 0.5, 0.86, 0.23, 1, 3.73, 1], { caliber: '5.56×45mm' }),
    m4a1: gun('m4a1', 'M4A1', 'carbine', 'carbine', 30, [30, 0, 5, 1.4, 0.7, 1, 700, 76.25, 700, 600, 0.5, 0.86, 0.24, 1, 3.79, 1], { caliber: '5.56×45mm', falloffStart: 100, falloffEnd: 300, minDamage: 10.5, scope: 'optic' }),
    asval: gun('asval', 'AS VAL', 'carbine', 'suppressed', 20, [32, 0, 2, 1.5, 1.2, 1, 440, 75, 800, 200, 0.1, 0.8, 0.2, 1.05, 3.33, 1], { caliber: '9×39mm', ammoColor: 0x88ccaa }),
    groza: gun('groza', 'GROZA', 'carbine', 'bullpup', 30, [34, 0, 10, 1.2, 0.6, 3, 390, 74.75, 650, 500, 1, 0.81, 0.22, 1.05, 4.3, 1.25], { caliber: '7.62×39mm' }),
    hk419: gun('hk419', 'HK419', 'carbine', 'rifle-modern', 30, [30, 0, 5, 1.3, 1.3, 1, 600, 77.5, 825, 600, 0.5, 0.86, 0.23, 1, 3.9, 1], { caliber: '5.56×45mm' }),
    ak5c: gun('ak5c', 'AK5C', 'carbine', 'carbine', 30, [34, 0, 6, 1.5, 1.3, 1, 700, 76.25, 600, 600, 0.5, 0.86, 0.23, 1, 3.92, 1], { caliber: '5.56×45mm' }),
    honeybadger: gun('honeybadger', 'HONEY BADGER', 'smg', 'suppressed', 25, [28, 0, 2, 1.25, 1.1, 1, 400, 72.25, 880, 200, 0.1, 0.86, 0.2, 1.05, 3.76, 1], { caliber: '.300 BLK', ammoColor: 0x88ccaa }),
    mp7: gun('mp7', 'MP7', 'smg', 'smg-compact', 30, [25, 0, 0, 1, 1, 1, 250, 72.5, 850, 600, 0.24, 1, 0.18, 1.1, 4, 1], { caliber: '4.6×30mm' }),
    pp2000: gun('pp2000', 'PP2000', 'smg', 'smg-compact', 40, [24, 0, 0, 1.1, 0.7, 1, 350, 67.5, 1000, 600, 0.1, 1, 0.15, 1.1, 3.33, 1], { caliber: '9×19mm', falloffStart: 50, falloffEnd: 150, minDamage: 6 }),
    p90: gun('p90', 'P90', 'smg', 'p90', 50, [28, 0, 8, 0.8, 1.4, 1, 390, 74.75, 800, 500, 0.84, 0.94, 0.2, 1.05, 3.83, 1], { caliber: '5.7×28mm' }),
    vector: gun('vector', 'KRISS VECTOR', 'smg', 'vector', 36, [22, 0, 1, 1, 1.1, 1, 400, 68.75, 1200, 600, 0.3, 0.93, 0.25, 1.1, 3.4, 1], { caliber: '.45 ACP', falloffStart: 10, falloffEnd: 100, minDamage: 5.5 }),
    ump45: gun('ump45', 'UMP-45', 'smg', 'smg', 25, [35, 0, 0, 1.3, 0.9, 1, 375, 72.25, 600, 600, 0.3, 0.93, 0.2, 1.1, 3.1, 1], { caliber: '.45 ACP', falloffStart: 30, falloffEnd: 120, minDamage: 8 }),
    mp5: gun('mp5', 'MP5', 'smg', 'smg', 30, [29, 0, 0, 0.9, 0.7, 1, 400, 72.25, 800, 600, 0.29, 1, 0.2, 1.05, 4.17, 1], { caliber: '9×19mm', falloffStart: 20, falloffEnd: 100, minDamage: 7.3 }),
    pp19: gun('pp19', 'PP-19', 'smg', 'smg', 30, [25, 0, 0, 0.9, 0.7, 1, 400, 72.25, 750, 600, 0.29, 1, 0.2, 1.05, 3.1, 1], { caliber: '9×19mm', falloffStart: 20, falloffEnd: 100, minDamage: 8 }),
    scorpionevo: gun('scorpionevo', 'SCORPION EVO', 'smg', 'smg-modern', 35, [26, 0, 2, 2.7, 0.8, 1, 440, 68.75, 1200, 600, 0.1, 0.86, 0.2, 1, 3.43, 1], { caliber: '9×19mm', falloffStart: 20, falloffEnd: 100, minDamage: 16.5 }),
    l86a1: gun('l86a1', 'L86A1', 'lmg', 'lmg-bullpup', 30, [32, 0, 6, 1.2, 1, 1, 700, 75, 775, 600, 0.5, 0.86, 0.24, 0.98, 3.84, 1], { caliber: '5.56×45mm', reserve: 180 }),
    mg36: gun('mg36', 'MG36', 'lmg', 'lmg', 40, [24, 0, 7, 1, 1.2, 1, 800, 75, 800, 600, 0.5, 0.8, 0.24, 0.88, 4.12, 1], { caliber: '5.56×45mm', reserve: 200 }),
    rpk16: gun('rpk16', 'RPK16', 'lmg', 'lmg-rifle', 45, [32, 0, 6, 1.4, 0.85, 1, 600, 70, 680, 600, 0.5, 0.8, 0.24, 0.98, 4, 1], { caliber: '5.45×39mm', reserve: 180 }),
    m249: gun('m249', 'M249', 'lmg', 'lmg-belt', 100, [31, 0, 6, 1.1, 1.3, 1, 600, 70, 700, 600, 0.71, 0.29, 0.3, 0.93, 6.67, 1], { caliber: '5.56×45mm', reserve: 200, falloffStart: 100, falloffEnd: 300, minDamage: 9.2 }),
    ultimax100: gun('ultimax100', 'ULTIMAX 100', 'lmg', 'lmg-drum', 100, [29, 0, 5, 1.1, 0.6, 1.5, 700, 70, 600, 600, 0.86, 0.29, 0.3, 0.98, 5.27, 1.2], { caliber: '5.56×45mm', reserve: 200 }),
    mk20: gun('mk20', 'MK20', 'dmr', 'dmr', 16, [47, 0, 15, 1.2, 1.5, 1, 1100, 82.5, 250, 600, 0.7, 0.54, 0.22, 0.85, 2.7, 0.85], { caliber: '7.62×51mm', automatic: false, adsFov: 28, adsSens: 0.5, scope: 'optic', falloffStart: 200, falloffEnd: 700, minDamage: 40 }),
    m110: gun('m110', 'M110', 'dmr', 'dmr', 12, [51, 0, 20, 1.5, 2.5, 1.4, 1000, 92.5, 200, 600, 0.7, 0.51, 0.37, 0.94, 3.92, 0.95], { caliber: '7.62×51mm', automatic: false, adsFov: 24, adsSens: 0.48, scope: 'optic', falloffStart: 250, falloffEnd: 800, minDamage: 44 }),
    mk14ebr: gun('mk14ebr', 'MK14 EBR', 'dmr', 'dmr-long', 14, [40, 0, 10, 1.3, 1.2, 1.5, 800, 85, 400, 600, 0.7, 0.8, 0.28, 0.87, 2.8, 0.85], { caliber: '7.62×51mm', adsFov: 30, adsSens: 0.55, scope: 'optic' }),
    sr: gun('sr', 'SVD', 'dmr', 'svd', 14, [41, 0, 12, 1.4, 1.1, 1.2, 950, 92.5, 440, 600, 0.7, 0.63, 0.29, 0.97, 4.21, 0.95], { caliber: '7.62×54R', slot: 3, automatic: false, adsFov: 18, adsSens: 0.45, scope: 'sniper', ammoColor: 0x66aaff, ammoLabel: 'SVD', falloffStart: 100, falloffEnd: 900, minDamage: 38.1, range: 160 }),
    ssg69: gun('ssg69', 'SSG 69', 'sniper', 'sniper', 10, [60, 0, 10, 1.1, 0.8, 1, 900, 100, 60, 2000, 1, 0.51, 0.33, 0.99, 4, 0.9], { caliber: '7.62×51mm', automatic: false, heavyArmorDamage: 1, boltSpeed: 1, adsFov: 16, adsSens: 0.4, scope: 'sniper', falloffStart: 800, falloffEnd: 900, minDamage: 60, range: 220 }),
    sv98: gun('sv98', 'SV-98', 'sniper', 'sniper', 10, [63, 0, 10, 1.1, 0.8, 1, 1000, 100, 60, 2000, 1, 0.51, 0.28, 0.94, 3.6, 0.9], { caliber: '7.62×54R', automatic: false, heavyArmorDamage: 1, boltSpeed: 1, adsFov: 16, adsSens: 0.4, scope: 'sniper', falloffStart: 800, falloffEnd: 900, minDamage: 63, range: 230 }),
    l96: gun('l96', 'L96', 'sniper', 'sniper', 10, [65, 0, 10, 1.1, 0.8, 1, 1100, 100, 60, 2000, 1, 0.51, 0.28, 0.94, 3.67, 0.9], { caliber: '7.62×51mm', automatic: false, heavyArmorDamage: 1, boltSpeed: 1, adsFov: 15, adsSens: 0.38, scope: 'sniper', falloffStart: 800, falloffEnd: 1000, minDamage: 65, range: 240 }),
    rem700: gun('rem700', 'REM 700', 'sniper', 'sniper', 5, [65, 0, 20, 1.5, 0.8, 1, 1050.01, 100, 92, 2000, 1, 0.51, 0.28, 0.94, 3.47, 0.9], { caliber: '.308 Win', automatic: false, heavyArmorDamage: 1, boltSpeed: 0.65, adsFov: 15, adsSens: 0.38, scope: 'sniper', falloffStart: 500, falloffEnd: 900, minDamage: 65, range: 240 }),
    m200: gun('m200', 'M200', 'sniper', 'sniper-heavy', 7, [70, 0, 15, 2, 0.8, 1, 1400, 100, 75, 2000, 1, 0, 0.34, 0.81, 3.73, 0.9], { caliber: '.408 CheyTac', automatic: false, heavyArmorDamage: 5, boltSpeed: 0.8, adsFov: 14, adsSens: 0.35, scope: 'sniper', falloffStart: 700, falloffEnd: 900, minDamage: 70, range: 280 }),
    msr: gun('msr', 'MSR', 'sniper', 'sniper-modern', 6, [64, 0, 15, 2, 1.4, 1, 1100, 100, 75, 2000, 1, 0, 0.29, 0.83, 4.17, 0.9], { caliber: '.338 Lapua', automatic: false, heavyArmorDamage: 6, boltSpeed: 0.8, adsFov: 14, adsSens: 0.35, scope: 'sniper', falloffStart: 700, falloffEnd: 900, minDamage: 64, range: 260 }),
    m9: gun('m9', 'M9', 'pistol', 'pistol', 13, [22, 0, 0, 0.8, 0.8, 1, 200, 72.5, 800, 400, 0.2, 1, 0.07, 1.1, 2.9, 2], { caliber: '9×19mm', automatic: false, adsFov: 55, adsSens: 0.9, reserve: 52, falloffStart: 20, falloffEnd: 80, minDamage: 6 }),
    mp443: gun('mp443', 'MP 443', 'pistol', 'pistol', 17, [27, 0, 0, 0.8, 0.3, 1, 250, 77, 750, 400, 0.2, 1, 0.08, 1.1, 2.7, 2], { caliber: '9×19mm', automatic: false, adsFov: 55, adsSens: 0.9, reserve: 68, falloffStart: 20, falloffEnd: 80, minDamage: 7 }),
    usp: gun('usp', 'USP', 'pistol', 'pistol', 15, [30, 0, 0, 0.7, 0.5, 1, 320, 73.75, 650, 450, 0.25, 1, 0.07, 1.1, 3.23, 2], { caliber: '.45 ACP', automatic: false, adsFov: 55, adsSens: 0.9, reserve: 60, falloffStart: 25, falloffEnd: 90, minDamage: 8 }),
    glock18: gun('glock18', 'GLOCK 18', 'pistol', 'machine-pistol', 19, [19, 0, 0, 1, 0.5, 1, 330, 73.75, 1100, 450, 0.18, 1, 0.08, 1.1, 3.03, 1.75], { caliber: '9×19mm', adsFov: 52, adsSens: 0.88, reserve: 76, falloffStart: 10, falloffEnd: 100, minDamage: 4.8 }),
    unica: gun('unica', 'UNICA', 'pistol', 'revolver', 6, [60, 0, 10, 5, 3.5, 1.1, 350, 73.75, 200, 600, 0.5, 0.86, 0.1, 1.1, 4.17, 1.5], { caliber: '.357 Mag', automatic: false, adsFov: 50, adsSens: 0.85, reserve: 24, falloffStart: 100, falloffEnd: 250, minDamage: 15 }),
    deserteagle: gun('deserteagle', 'DESERT EAGLE', 'pistol', 'pistol-heavy', 7, [72, 0, 30, 6, 4, 1.1, 500, 78.75, 150, 600, 1, 0.86, 0.1, 1.06, 2.77, 1.3], { caliber: '.50 AE', automatic: false, adsFov: 48, adsSens: 0.82, reserve: 28, falloffStart: 40, falloffEnd: 150, minDamage: 18 }),
    rsh12: gun('rsh12', 'RSH-12', 'pistol', 'revolver-heavy', 5, [70, 0, 30, 5, 5, 1.1, 550, 78.75, 160, 600, 0.5, 0.86, 0.1, 1.06, 4.11, 1.3], { caliber: '12.7×55mm', automatic: false, adsFov: 48, adsSens: 0.8, reserve: 20, falloffStart: 20, falloffEnd: 100, minDamage: 12.5 }),
  };

  CATALOG.svd = CATALOG.sr;

  const LOADOUT_ORDER = [
    'ak74',
    'acr',
    'scarh',
    'm4a1',
    'hk419',
    'mp7',
    'p90',
    'mp5',
    'm249',
    'mk14ebr',
    'm200',
    'usp',
  ];

  function isLoadoutGun(id) {
    return LOADOUT_ORDER.indexOf(id) >= 0;
  }

  function defaultPrimaryId() {
    return 'ak74';
  }

  function defaultSecondaryId() {
    return 'usp';
  }

  function sanitizePrimaryId(id) {
    if (!id || id === 'rpg' || id === 'knife' || id === 'usp') return defaultPrimaryId();
    const def = CATALOG[id];
    if (isLoadoutGun(id) && def && def.category !== 'pistol') return id;
    return defaultPrimaryId();
  }

  function sanitizeSecondaryId(id) {
    return id === 'usp' ? 'usp' : defaultSecondaryId();
  }

  global.VF = global.VF || {};
  global.VF.WEAPON_CATALOG = CATALOG;
  global.VF.WEAPON_LOADOUT_ORDER = LOADOUT_ORDER;
  global.VF.DEFAULT_PRIMARY = 'ak74';
  global.VF.DEFAULT_SECONDARY = 'usp';
  global.VF.isLoadoutGun = isLoadoutGun;
  global.VF.defaultPrimaryId = defaultPrimaryId;
  global.VF.defaultSecondaryId = defaultSecondaryId;
  global.VF.sanitizePrimaryId = sanitizePrimaryId;
  global.VF.sanitizeSecondaryId = sanitizeSecondaryId;
})(window);
